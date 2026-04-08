const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { query, init } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SSE ───────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'stok-gizli-2024-xK9m',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static(path.join(__dirname, 'public')));

const auth  = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Giriş yapın' });
const admin = (req, res, next) => req.session.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Yönetici yetkisi gerekli' });

// ── Helpers ────────────────────────────────────────────────────────────────
async function getNumCol() {
  const r = await query("SELECT * FROM column_defs WHERE data_type='number' ORDER BY display_order LIMIT 1");
  return r.rows[0] || null;
}
async function getFirstCol() {
  const r = await query("SELECT * FROM column_defs ORDER BY display_order LIMIT 1");
  return r.rows[0] || null;
}
async function deductStock(product_id, qty, numCol) {
  if (!numCol) return;
  const r = await query('SELECT values FROM products WHERE id=$1', [product_id]);
  if (!r.rows[0]) return;
  const vals = r.rows[0].values || {};
  const cur = parseFloat(vals[numCol.id] || 0);
  vals[numCol.id] = String(Math.max(0, cur - qty));
  await query('UPDATE products SET values=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(vals), product_id]);
}
async function restoreStock(product_id, qty, numCol) {
  if (!numCol) return;
  const r = await query('SELECT values FROM products WHERE id=$1', [product_id]);
  if (!r.rows[0]) return;
  const vals = r.rows[0].values || {};
  const cur = parseFloat(vals[numCol.id] || 0);
  vals[numCol.id] = String(cur + qty);
  await query('UPDATE products SET values=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(vals), product_id]);
}
async function enrichTx(rows) {
  const firstCol = await getFirstCol();
  return Promise.all(rows.map(async t => {
    const u = await query('SELECT username, display_name FROM users WHERE id=$1', [t.user_id]);
    const p = await query('SELECT values FROM products WHERE id=$1', [t.product_id]);
    return {
      ...t,
      user_name: u.rows[0]?.display_name || u.rows[0]?.username || '?',
      username: u.rows[0]?.username || '?',
      product_name: firstCol ? (p.rows[0]?.values?.[firstCol.id] || '—') : '—'
    };
  }));
}

// ── AUTH ──────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const r = await query('SELECT * FROM users WHERE username=$1', [username]);
  const user = r.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  req.session.user = { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
  res.json({ role: user.role, display_name: user.display_name });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json(req.session.user));

// ── SSE ───────────────────────────────────────────────────────────────────
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 20000);
  req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
});

// ── COLUMNS ───────────────────────────────────────────────────────────────
app.get('/api/columns', auth, async (req, res) => {
  const r = await query('SELECT * FROM column_defs ORDER BY display_order');
  res.json(r.rows);
});
app.post('/api/columns', admin, async (req, res) => {
  const { name, data_type, min_stock } = req.body;
  if (!name) return res.status(400).json({ error: 'Sütun adı gerekli' });
  const mo = await query('SELECT COALESCE(MAX(display_order),0) as m FROM column_defs');
  const r = await query('INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES($1,$2,$3,$4) RETURNING *',
    [name, data_type || 'text', mo.rows[0].m + 1, min_stock || 5]);
  res.json(r.rows[0]);
});
app.put('/api/columns/:id', admin, async (req, res) => {
  const { name, data_type, display_order, min_stock } = req.body;
  await query('UPDATE column_defs SET name=$1,data_type=$2,display_order=$3,min_stock=$4 WHERE id=$5',
    [name, data_type, display_order, min_stock || 0, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/columns/:id', admin, async (req, res) => {
  const cid = req.params.id;
  const prods = await query('SELECT id, values FROM products');
  for (const p of prods.rows) {
    if (p.values?.[cid] !== undefined) {
      delete p.values[cid];
      await query('UPDATE products SET values=$1 WHERE id=$2', [JSON.stringify(p.values), p.id]);
    }
  }
  await query('DELETE FROM column_defs WHERE id=$1', [cid]);
  res.json({ ok: true });
});

// ── PRODUCTS ─────────────────────────────────────────────────────────────
app.get('/api/products', auth, async (req, res) => {
  const r = await query('SELECT * FROM products ORDER BY created_at DESC');
  res.json(r.rows);
});
app.post('/api/products', admin, async (req, res) => {
  const { values } = req.body;
  const r = await query('INSERT INTO products(values) VALUES($1) RETURNING *', [JSON.stringify(values || {})]);
  broadcast('stock_update', {});
  res.json(r.rows[0]);
});
app.put('/api/products/:id', admin, async (req, res) => {
  const { values } = req.body;
  const cur = await query('SELECT values FROM products WHERE id=$1', [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'Ürün bulunamadı' });
  const merged = { ...cur.rows[0].values, ...values };
  await query('UPDATE products SET values=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(merged), req.params.id]);
  broadcast('stock_update', {});
  res.json({ ok: true });
});
app.delete('/api/products/:id', admin, async (req, res) => {
  await query('DELETE FROM products WHERE id=$1', [req.params.id]);
  broadcast('stock_update', {});
  res.json({ ok: true });
});

// ── MACHINES ─────────────────────────────────────────────────────────────
app.get('/api/machines', auth, async (req, res) => {
  const r = await query('SELECT * FROM machines ORDER BY created_at DESC');
  const firstCol = await getFirstCol();
  const machines = await Promise.all(r.rows.map(async m => ({
    ...m,
    items: await Promise.all((m.items || []).map(async it => {
      const p = await query('SELECT values FROM products WHERE id=$1', [it.product_id]);
      return { ...it, product_name: firstCol ? (p.rows[0]?.values?.[firstCol.id] || '—') : '—' };
    }))
  })));
  res.json(machines);
});
app.post('/api/machines', admin, async (req, res) => {
  const { machine_name, notes, items } = req.body;
  if (!machine_name) return res.status(400).json({ error: 'Makine adı gerekli' });
  const r = await query('INSERT INTO machines(machine_name,notes,items) VALUES($1,$2,$3) RETURNING *',
    [machine_name, notes || '', JSON.stringify(items || [])]);
  res.json(r.rows[0]);
});
app.put('/api/machines/:id', admin, async (req, res) => {
  const { machine_name, notes, items } = req.body;
  await query('UPDATE machines SET machine_name=$1,notes=$2,items=$3 WHERE id=$4',
    [machine_name, notes || '', JSON.stringify(items || []), req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/machines/:id', admin, async (req, res) => {
  await query('DELETE FROM machines WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── TRANSACTIONS ─────────────────────────────────────────────────────────
app.get('/api/transactions', auth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 300;
  const pid = req.query.product_id;
  let sql = 'SELECT * FROM transactions';
  const params = [];
  if (pid) { sql += ' WHERE product_id=$1'; params.push(pid); }
  sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);
  const r = await query(sql, params);
  res.json(await enrichTx(r.rows));
});

app.post('/api/transactions', auth, async (req, res) => {
  const { product_id, company, quantity, notes, tx_type } = req.body;
  if (!product_id || !company || !quantity)
    return res.status(400).json({ error: 'Ürün, firma ve miktar zorunlu' });
  const type = tx_type || 'out';
  const r = await query(
    'INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.session.user.id, Number(product_id), company, Number(quantity), notes || '', type]
  );
  const numCol = await getNumCol();
  if (type === 'out') await deductStock(product_id, Number(quantity), numCol);
  else if (type === 'return') await restoreStock(product_id, Number(quantity), numCol);
  broadcast('tx_new', { user: req.session.user.display_name });
  broadcast('stock_update', {});
  res.json({ id: r.rows[0].id });
});

app.post('/api/transactions/bulk', auth, async (req, res) => {
  const { machine_id, company, notes } = req.body;
  if (!machine_id || !company) return res.status(400).json({ error: 'Makine ve firma zorunlu' });
  const mr = await query('SELECT * FROM machines WHERE id=$1', [machine_id]);
  const machine = mr.rows[0];
  if (!machine) return res.status(404).json({ error: 'Makine bulunamadı' });
  const numCol = await getNumCol();
  const ids = [];
  for (const item of (machine.items || [])) {
    const r = await query(
      'INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.session.user.id, Number(item.product_id), company, Number(item.quantity),
       `${machine.machine_name} için toplu alım${notes ? ' — ' + notes : ''}`, 'out']
    );
    await deductStock(item.product_id, Number(item.quantity), numCol);
    ids.push(r.rows[0].id);
  }
  broadcast('tx_new', { user: req.session.user.display_name, machine: machine.machine_name });
  broadcast('stock_update', {});
  res.json({ ids, count: ids.length });
});

app.delete('/api/transactions/:id', admin, async (req, res) => {
  const r = await query('SELECT * FROM transactions WHERE id=$1', [req.params.id]);
  const tx = r.rows[0];
  if (!tx) return res.status(404).json({ error: 'İşlem bulunamadı' });
  const numCol = await getNumCol();
  if (tx.tx_type !== 'return') await restoreStock(tx.product_id, parseFloat(tx.quantity), numCol);
  else await deductStock(tx.product_id, parseFloat(tx.quantity), numCol);
  await query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
  broadcast('stock_update', {});
  res.json({ ok: true });
});

// ── FIRMS ─────────────────────────────────────────────────────────────────
app.get('/api/firms', auth, async (req, res) => {
  const r = await query("SELECT * FROM firms ORDER BY name");
  res.json(r.rows);
});
app.post('/api/firms', admin, async (req, res) => {
  const { name, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Firma adı gerekli' });
  try {
    const r = await query('INSERT INTO firms(name,notes) VALUES($1,$2) RETURNING *', [name, notes || '']);
    res.json(r.rows[0]);
  } catch { res.status(409).json({ error: 'Bu firma zaten mevcut' }); }
});
app.put('/api/firms/:id', admin, async (req, res) => {
  await query('UPDATE firms SET name=$1,notes=$2 WHERE id=$3', [req.body.name, req.body.notes || '', req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/firms/:id', admin, async (req, res) => {
  await query('DELETE FROM firms WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── USERS ─────────────────────────────────────────────────────────────────
app.get('/api/users', admin, async (req, res) => {
  const r = await query('SELECT id,username,role,display_name,created_at FROM users ORDER BY created_at');
  res.json(r.rows);
});
app.post('/api/users', admin, async (req, res) => {
  const { username, password, role, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  try {
    const r = await query('INSERT INTO users(username,password_hash,role,display_name) VALUES($1,$2,$3,$4) RETURNING id',
      [username, bcrypt.hashSync(password, 10), role || 'personnel', display_name || username]);
    res.json({ id: r.rows[0].id });
  } catch { res.status(409).json({ error: 'Bu kullanıcı adı zaten mevcut' }); }
});
app.put('/api/users/:id', admin, async (req, res) => {
  const { display_name, role, password } = req.body;
  if (password) await query('UPDATE users SET display_name=$1,role=$2,password_hash=$3 WHERE id=$4', [display_name, role, bcrypt.hashSync(password, 10), req.params.id]);
  else await query('UPDATE users SET display_name=$1,role=$2 WHERE id=$3', [display_name, role, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/users/:id', admin, async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
  await query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── CSV EXPORT ────────────────────────────────────────────────────────────
app.get('/api/export/stock', auth, async (req, res) => {
  const cols = (await query('SELECT * FROM column_defs ORDER BY display_order')).rows;
  const prods = (await query('SELECT * FROM products ORDER BY created_at DESC')).rows;
  const escape = v => { const s = String(v||''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = [cols.map(c => c.name).join(','), ...prods.map(p => cols.map(c => escape(p.values?.[c.id] || '')).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="stok-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});
app.get('/api/export/transactions', auth, async (req, res) => {
  const txs = await enrichTx((await query('SELECT * FROM transactions ORDER BY created_at DESC')).rows);
  const esc = v => { const s = String(v||''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = [['Tarih','Personel','Ürün','Firma','Miktar','Tür','Not'].join(','),
    ...txs.map(t => [t.created_at?.toString().slice(0,19), t.user_name, t.product_name, t.company, t.quantity, t.tx_type==='return'?'İade':'Çıkış', t.notes||''].map(esc).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="islemler-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────
async function start() {
  await init();
  // Seed default data
  const uc = await query('SELECT COUNT(*) as c FROM users');
  if (parseInt(uc.rows[0].c) === 0) {
    await query('INSERT INTO users(username,password_hash,role,display_name) VALUES($1,$2,$3,$4)',
      ['admin', bcrypt.hashSync('admin123', 10), 'admin', 'Yönetici']);
    await Promise.all([
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Ürün Adı','text',1,0)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Stok Kodu','text',2,0)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Miktar','number',3,5)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Birim','text',4,0)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Tedarikçi','text',5,0)"),
    ]);
    console.log('✓ Varsayılan veriler oluşturuldu — admin / admin123');
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏭 Stok Takip çalışıyor → http://localhost:${PORT}`);
  });
}

start().catch(err => { console.error('Başlatma hatası:', err); process.exit(1); });
