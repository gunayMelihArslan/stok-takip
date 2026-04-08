const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { query, init, pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'stok-gizli-jwt-2024-xK9m';

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SSE ───────────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

// ── Auth middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Giriş yapın' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapın' }); }
}
function admin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  next();
}

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
  vals[numCol.id] = String(Math.max(0, parseFloat(vals[numCol.id] || 0) - qty));
  await query('UPDATE products SET values=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(vals), product_id]);
}
async function restoreStock(product_id, qty, numCol) {
  if (!numCol) return;
  const r = await query('SELECT values FROM products WHERE id=$1', [product_id]);
  if (!r.rows[0]) return;
  const vals = r.rows[0].values || {};
  vals[numCol.id] = String(parseFloat(vals[numCol.id] || 0) + qty);
  await query('UPDATE products SET values=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(vals), product_id]);
}
async function enrichTx(rows) {
  const firstCol = await getFirstCol();
  return Promise.all(rows.map(async t => {
    const u = await query('SELECT username, display_name FROM users WHERE id=$1', [t.user_id]);
    const p = await query('SELECT values FROM products WHERE id=$1', [t.product_id]);
    return { ...t, user_name: u.rows[0]?.display_name || u.rows[0]?.username || '?', username: u.rows[0]?.username || '?', product_name: firstCol ? (p.rows[0]?.values?.[firstCol.id] || '—') : '—' };
  }));
}

// ── AUTH ──────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const r = await query('SELECT * FROM users WHERE username=$1', [username]);
  const user = r.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, display_name: user.display_name }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ role: user.role, display_name: user.display_name, token });
});
app.post('/api/logout', (req, res) => res.json({ ok: true }));
app.get('/api/me', auth, (req, res) => res.json(req.user));

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
app.get('/api/columns', auth, async (req, res) => { res.json((await query('SELECT * FROM column_defs ORDER BY display_order')).rows); });
app.post('/api/columns', auth, admin, async (req, res) => {
  const { name, data_type, min_stock } = req.body;
  if (!name) return res.status(400).json({ error: 'Sütun adı gerekli' });
  const mo = await query('SELECT COALESCE(MAX(display_order),0) as m FROM column_defs');
  res.json((await query('INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES($1,$2,$3,$4) RETURNING *', [name, data_type || 'text', mo.rows[0].m + 1, min_stock || 5])).rows[0]);
});
app.put('/api/columns/:id', auth, admin, async (req, res) => {
  const { name, data_type, display_order, min_stock } = req.body;
  await query('UPDATE column_defs SET name=$1,data_type=$2,display_order=$3,min_stock=$4 WHERE id=$5', [name, data_type, display_order, min_stock || 0, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/columns/:id', auth, admin, async (req, res) => {
  const cid = req.params.id;
  for (const p of (await query('SELECT id, values FROM products')).rows) {
    if (p.values?.[cid] !== undefined) { delete p.values[cid]; await query('UPDATE products SET values=$1 WHERE id=$2', [JSON.stringify(p.values), p.id]); }
  }
  await query('DELETE FROM column_defs WHERE id=$1', [cid]);
  res.json({ ok: true });
});

// ── PRODUCTS ─────────────────────────────────────────────────────────────
app.get('/api/products', auth, async (req, res) => { res.json((await query('SELECT * FROM products ORDER BY created_at DESC')).rows); });
app.post('/api/products', auth, admin, async (req, res) => {
  const r = await query('INSERT INTO products(values) VALUES($1) RETURNING *', [JSON.stringify(req.body.values || {})]);
  broadcast('stock_update', {}); res.json(r.rows[0]);
});
app.put('/api/products/:id', auth, admin, async (req, res) => {
  const cur = await query('SELECT values FROM products WHERE id=$1', [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'Ürün bulunamadı' });
  await query('UPDATE products SET values=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify({ ...cur.rows[0].values, ...req.body.values }), req.params.id]);
  broadcast('stock_update', {}); res.json({ ok: true });
});
app.delete('/api/products/:id', auth, admin, async (req, res) => {
  await query('DELETE FROM products WHERE id=$1', [req.params.id]);
  broadcast('stock_update', {}); res.json({ ok: true });
});

// ── MACHINES ─────────────────────────────────────────────────────────────
app.get('/api/machines', auth, async (req, res) => {
  const firstCol = await getFirstCol();
  const machines = await Promise.all((await query('SELECT * FROM machines ORDER BY created_at DESC')).rows.map(async m => ({
    ...m, items: await Promise.all((m.items || []).map(async it => {
      const p = await query('SELECT values FROM products WHERE id=$1', [it.product_id]);
      return { ...it, product_name: firstCol ? (p.rows[0]?.values?.[firstCol.id] || '—') : '—' };
    }))
  })));
  res.json(machines);
});
app.post('/api/machines', auth, admin, async (req, res) => {
  const { machine_name, notes, items } = req.body;
  if (!machine_name) return res.status(400).json({ error: 'Makine adı gerekli' });
  res.json((await query('INSERT INTO machines(machine_name,notes,items) VALUES($1,$2,$3) RETURNING *', [machine_name, notes || '', JSON.stringify(items || [])])).rows[0]);
});
app.put('/api/machines/:id', auth, admin, async (req, res) => {
  await query('UPDATE machines SET machine_name=$1,notes=$2,items=$3 WHERE id=$4', [req.body.machine_name, req.body.notes || '', JSON.stringify(req.body.items || []), req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/machines/:id', auth, admin, async (req, res) => { await query('DELETE FROM machines WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

// ── TRANSACTIONS ─────────────────────────────────────────────────────────
app.get('/api/transactions', auth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 300;
  const pid = req.query.product_id;
  const params = pid ? [pid, limit] : [limit];
  const sql = pid ? 'SELECT * FROM transactions WHERE product_id=$1 ORDER BY created_at DESC LIMIT $2' : 'SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1';
  res.json(await enrichTx((await query(sql, params)).rows));
});
app.post('/api/transactions', auth, async (req, res) => {
  const { product_id, company, quantity, notes, tx_type } = req.body;
  if (!product_id || !company || !quantity) return res.status(400).json({ error: 'Ürün, firma ve miktar zorunlu' });
  const type = tx_type || 'out';
  const r = await query('INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.user.id, Number(product_id), company, Number(quantity), notes || '', type]);
  const numCol = await getNumCol();
  if (type === 'out') await deductStock(product_id, Number(quantity), numCol);
  else if (type === 'return') await restoreStock(product_id, Number(quantity), numCol);
  broadcast('tx_new', { user: req.user.display_name }); broadcast('stock_update', {});
  res.json({ id: r.rows[0].id });
});
app.post('/api/transactions/bulk', auth, async (req, res) => {
  const { machine_id, company, notes } = req.body;
  if (!machine_id || !company) return res.status(400).json({ error: 'Makine ve firma zorunlu' });
  const machine = (await query('SELECT * FROM machines WHERE id=$1', [machine_id])).rows[0];
  if (!machine) return res.status(404).json({ error: 'Makine bulunamadı' });
  const numCol = await getNumCol();
  const ids = [];
  for (const item of (machine.items || [])) {
    const r = await query('INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, Number(item.product_id), company, Number(item.quantity), `${machine.machine_name} için toplu alım${notes ? ' — ' + notes : ''}`, 'out']);
    await deductStock(item.product_id, Number(item.quantity), numCol);
    ids.push(r.rows[0].id);
  }
  broadcast('tx_new', { user: req.user.display_name }); broadcast('stock_update', {});
  res.json({ ids, count: ids.length });
});
app.delete('/api/transactions/:id', auth, admin, async (req, res) => {
  const tx = (await query('SELECT * FROM transactions WHERE id=$1', [req.params.id])).rows[0];
  if (!tx) return res.status(404).json({ error: 'İşlem bulunamadı' });
  const numCol = await getNumCol();
  if (tx.tx_type !== 'return') await restoreStock(tx.product_id, parseFloat(tx.quantity), numCol);
  else await deductStock(tx.product_id, parseFloat(tx.quantity), numCol);
  await query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
  broadcast('stock_update', {}); res.json({ ok: true });
});

// ── FIRMS ─────────────────────────────────────────────────────────────────
app.get('/api/firms', auth, async (req, res) => { res.json((await query('SELECT * FROM firms ORDER BY name')).rows); });
app.post('/api/firms', auth, admin, async (req, res) => {
  const { name, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Firma adı gerekli' });
  try { res.json((await query('INSERT INTO firms(name,notes) VALUES($1,$2) RETURNING *', [name, notes || ''])).rows[0]); }
  catch { res.status(409).json({ error: 'Bu firma zaten mevcut' }); }
});
app.put('/api/firms/:id', auth, admin, async (req, res) => { await query('UPDATE firms SET name=$1,notes=$2 WHERE id=$3', [req.body.name, req.body.notes || '', req.params.id]); res.json({ ok: true }); });
app.delete('/api/firms/:id', auth, admin, async (req, res) => { await query('DELETE FROM firms WHERE id=$1', [req.params.id]); res.json({ ok: true }); });

// ── USERS ─────────────────────────────────────────────────────────────────
app.get('/api/users', auth, admin, async (req, res) => { res.json((await query('SELECT id,username,role,display_name,created_at FROM users ORDER BY created_at')).rows); });
app.post('/api/users', auth, admin, async (req, res) => {
  const { username, password, role, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  try { res.json({ id: (await query('INSERT INTO users(username,password_hash,role,display_name) VALUES($1,$2,$3,$4) RETURNING id', [username, bcrypt.hashSync(password, 10), role || 'personnel', display_name || username])).rows[0].id }); }
  catch { res.status(409).json({ error: 'Bu kullanıcı adı zaten mevcut' }); }
});
app.put('/api/users/:id', auth, admin, async (req, res) => {
  const { display_name, role, password } = req.body;
  if (password) await query('UPDATE users SET display_name=$1,role=$2,password_hash=$3 WHERE id=$4', [display_name, role, bcrypt.hashSync(password, 10), req.params.id]);
  else await query('UPDATE users SET display_name=$1,role=$2 WHERE id=$3', [display_name, role, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/users/:id', auth, admin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
  await query('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ── CSV ───────────────────────────────────────────────────────────────────
app.get('/api/export/stock', auth, async (req, res) => {
  const cols = (await query('SELECT * FROM column_defs ORDER BY display_order')).rows;
  const prods = (await query('SELECT * FROM products ORDER BY created_at DESC')).rows;
  const e = v => { const s = String(v||''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="stok-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + [cols.map(c=>c.name).join(','), ...prods.map(p=>cols.map(c=>e(p.values?.[c.id]||'')).join(','))].join('\n'));
});
app.get('/api/export/transactions', auth, async (req, res) => {
  const txs = await enrichTx((await query('SELECT * FROM transactions ORDER BY created_at DESC')).rows);
  const e = v => { const s = String(v||''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="islemler-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + [['Tarih','Personel','Ürün','Firma','Miktar','Tür','Not'].join(','), ...txs.map(t=>[t.created_at?.toString().slice(0,19),t.user_name,t.product_name,t.company,t.quantity,t.tx_type==='return'?'İade':'Çıkış',t.notes||''].map(e).join(','))].join('\n'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────
async function start() {
  await init();
  const uc = await query('SELECT COUNT(*) as c FROM users');
  if (parseInt(uc.rows[0].c) === 0) {
    await query('INSERT INTO users(username,password_hash,role,display_name) VALUES($1,$2,$3,$4)', ['admin', bcrypt.hashSync('admin123', 10), 'admin', 'Yönetici']);
    await Promise.all([
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Ürün Adı','text',1,0)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Stok Kodu','text',2,0)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Miktar','number',3,5)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Birim','text',4,0)"),
      query("INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES('Tedarikçi','text',5,0)"),
    ]);
    console.log('✓ Varsayılan veriler oluşturuldu — admin / admin123');
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`🏭 Stok Takip → http://localhost:${PORT}`));
}
start().catch(err => { console.error('Başlatma hatası:', err); process.exit(1); });
