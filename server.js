const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { query, init, pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'stok-jwt-2024';

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

// ── Auth ──────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Giriş yapın' });
  try { req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Oturum süresi doldu' }); }
}
function admin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  next();
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function getNumCol() {
  return (await query("SELECT * FROM column_defs WHERE data_type='number' ORDER BY display_order LIMIT 1")).rows[0] || null;
}
async function getFirstCol() {
  return (await query("SELECT * FROM column_defs ORDER BY display_order LIMIT 1")).rows[0] || null;
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
    const u = (await query('SELECT username,display_name FROM users WHERE id=$1', [t.user_id])).rows[0];
    const p = (await query('SELECT values FROM products WHERE id=$1', [t.product_id])).rows[0];
    return { ...t, user_name: u?.display_name || u?.username || '?', username: u?.username || '?', product_name: firstCol ? (p?.values?.[firstCol.id] || '—') : '—' };
  }));
}
async function enrichTask(t) {
  const assignee = t.assigned_to ? (await query('SELECT id,username,display_name FROM users WHERE id=$1', [t.assigned_to])).rows[0] : null;
  const creator = (await query('SELECT id,username,display_name FROM users WHERE id=$1', [t.created_by])).rows[0];
  const firm = t.firm_id ? (await query('SELECT id,name FROM firms WHERE id=$1', [t.firm_id])).rows[0] : null;
  const machine = t.machine_id ? (await query('SELECT id,machine_name FROM machines WHERE id=$1', [t.machine_id])).rows[0] : null;
  const transfers = (await query('SELECT tt.*, u1.display_name as from_name, u2.display_name as to_name FROM task_transfers tt JOIN users u1 ON u1.id=tt.from_user_id JOIN users u2 ON u2.id=tt.to_user_id WHERE tt.task_id=$1 ORDER BY tt.created_at DESC', [t.id])).rows;
  return { ...t, assignee_name: assignee?.display_name || assignee?.username || null, creator_name: creator?.display_name || creator?.username || '?', firm_name: firm?.name || null, machine_name: machine?.machine_name || null, transfers };
}

// ── Gold price cache ──────────────────────────────────────────────────────
let goldCache = null;
let goldLastFetch = 0;
async function fetchGold() {
  if (Date.now() - goldLastFetch < 5 * 60 * 1000 && goldCache) return goldCache;
  try {
    const [gcRes, fxRes] = await Promise.all([
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDTRY=X?interval=1m&range=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } })
    ]);
    const [gcData, fxData] = await Promise.all([gcRes.json(), fxRes.json()]);
    const usdGold = gcData?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const usdtry = fxData?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!usdGold || !usdtry) throw new Error('No data');
    const gramTRY = (usdGold * usdtry) / 31.1035;
    goldCache = { price: gramTRY.toFixed(2), usd_oz: usdGold.toFixed(2), usdtry: usdtry.toFixed(4), updated: new Date().toISOString() };
    goldLastFetch = Date.now();
    return goldCache;
  } catch(e) {
    return goldCache || { error: 'Veri alınamadı', updated: null };
  }
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
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 15000);
  req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
});

// ── GOLD ──────────────────────────────────────────────────────────────────
app.get('/api/gold', auth, async (req, res) => {
  res.json(await fetchGold());
});
// Auto-push gold every 5 min
setInterval(async () => {
  const g = await fetchGold();
  broadcast('gold_update', g);
}, 5 * 60 * 1000);

// ── COLUMNS ───────────────────────────────────────────────────────────────
app.get('/api/columns', auth, async (req, res) => res.json((await query('SELECT * FROM column_defs ORDER BY display_order')).rows));
app.post('/api/columns', auth, admin, async (req, res) => {
  const { name, data_type, min_stock } = req.body;
  if (!name) return res.status(400).json({ error: 'Sütun adı gerekli' });
  const mo = (await query('SELECT COALESCE(MAX(display_order),0) as m FROM column_defs')).rows[0].m;
  res.json((await query('INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES($1,$2,$3,$4) RETURNING *', [name, data_type||'text', mo+1, min_stock||5])).rows[0]);
});
app.put('/api/columns/:id', auth, admin, async (req, res) => {
  const { name, data_type, display_order, min_stock } = req.body;
  await query('UPDATE column_defs SET name=$1,data_type=$2,display_order=$3,min_stock=$4 WHERE id=$5', [name, data_type, display_order, min_stock||0, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/columns/:id', auth, admin, async (req, res) => {
  const cid = req.params.id;
  for (const p of (await query('SELECT id,values FROM products')).rows) {
    if (p.values?.[cid] !== undefined) { delete p.values[cid]; await query('UPDATE products SET values=$1 WHERE id=$2', [JSON.stringify(p.values), p.id]); }
  }
  await query('DELETE FROM column_defs WHERE id=$1', [cid]); res.json({ ok: true });
});

// ── PRODUCTS ─────────────────────────────────────────────────────────────
app.get('/api/products', auth, async (req, res) => res.json((await query('SELECT * FROM products ORDER BY created_at DESC')).rows));
app.post('/api/products', auth, admin, async (req, res) => {
  const r = await query('INSERT INTO products(values) VALUES($1) RETURNING *', [JSON.stringify(req.body.values||{})]);
  broadcast('stock_update', {}); res.json(r.rows[0]);
});
app.put('/api/products/:id', auth, admin, async (req, res) => {
  const cur = (await query('SELECT values FROM products WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Ürün bulunamadı' });
  await query('UPDATE products SET values=$1,updated_at=NOW() WHERE id=$2', [JSON.stringify({...cur.values,...req.body.values}), req.params.id]);
  broadcast('stock_update', {}); res.json({ ok: true });
});
app.delete('/api/products/:id', auth, admin, async (req, res) => {
  await query('DELETE FROM products WHERE id=$1', [req.params.id]); broadcast('stock_update', {}); res.json({ ok: true });
});

// ── FIRMS ─────────────────────────────────────────────────────────────────
app.get('/api/firms', auth, async (req, res) => res.json((await query('SELECT * FROM firms ORDER BY name')).rows));
app.post('/api/firms', auth, admin, async (req, res) => {
  const { name, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Firma adı gerekli' });
  try { res.json((await query('INSERT INTO firms(name,notes) VALUES($1,$2) RETURNING *', [name, notes||''])).rows[0]); }
  catch { res.status(409).json({ error: 'Bu firma zaten mevcut' }); }
});
app.put('/api/firms/:id', auth, admin, async (req, res) => {
  await query('UPDATE firms SET name=$1,notes=$2 WHERE id=$3', [req.body.name, req.body.notes||'', req.params.id]); res.json({ ok: true });
});
app.delete('/api/firms/:id', auth, admin, async (req, res) => {
  await query('DELETE FROM firms WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ── MACHINES ─────────────────────────────────────────────────────────────
async function enrichMachines(rows) {
  const firstCol = await getFirstCol();
  return Promise.all(rows.map(async m => {
    const firm = m.firm_id ? (await query('SELECT * FROM firms WHERE id=$1', [m.firm_id])).rows[0] : null;
    return { ...m, firm_name: firm?.name||null,
      items: await Promise.all((m.items||[]).map(async it => {
        const p = (await query('SELECT values FROM products WHERE id=$1', [it.product_id])).rows[0];
        return { ...it, product_name: firstCol?(p?.values?.[firstCol.id]||'—'):'—' };
      }))
    };
  }));
}
app.get('/api/machines', auth, async (req, res) => {
  const firm_id = req.query.firm_id;
  const rows = firm_id
    ? (await query('SELECT * FROM machines WHERE firm_id=$1 ORDER BY created_at DESC', [firm_id])).rows
    : (await query('SELECT * FROM machines ORDER BY firm_id NULLS LAST, created_at DESC')).rows;
  res.json(await enrichMachines(rows));
});
app.post('/api/machines', auth, admin, async (req, res) => {
  const { machine_name, notes, items, firm_id } = req.body;
  if (!machine_name) return res.status(400).json({ error: 'Vinç adı gerekli' });
  res.json((await query('INSERT INTO machines(machine_name,firm_id,notes,items) VALUES($1,$2,$3,$4) RETURNING *', [machine_name, firm_id||null, notes||'', JSON.stringify(items||[])])).rows[0]);
});
app.put('/api/machines/:id', auth, admin, async (req, res) => {
  const { machine_name, notes, items, firm_id } = req.body;
  await query('UPDATE machines SET machine_name=$1,firm_id=$2,notes=$3,items=$4 WHERE id=$5', [machine_name, firm_id||null, notes||'', JSON.stringify(items||[]), req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/machines/:id', auth, admin, async (req, res) => {
  await query('DELETE FROM machines WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ── TRANSACTIONS ─────────────────────────────────────────────────────────
app.get('/api/transactions', auth, async (req, res) => {
  const limit = parseInt(req.query.limit)||300;
  const pid = req.query.product_id;
  const sql = pid ? 'SELECT * FROM transactions WHERE product_id=$1 ORDER BY created_at DESC LIMIT $2' : 'SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1';
  const params = pid ? [pid, limit] : [limit];
  res.json(await enrichTx((await query(sql, params)).rows));
});
app.post('/api/transactions', auth, async (req, res) => {
  const { product_id, company, quantity, notes, tx_type } = req.body;
  if (!product_id||!company||!quantity) return res.status(400).json({ error: 'Ürün, firma ve miktar zorunlu' });
  const type = tx_type||'out';
  const r = await query('INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.user.id, Number(product_id), company, Number(quantity), notes||'', type]);
  const numCol = await getNumCol();
  if (type==='out') await deductStock(product_id, Number(quantity), numCol);
  else if (type==='return') await restoreStock(product_id, Number(quantity), numCol);
  broadcast('tx_new', { user: req.user.display_name }); broadcast('stock_update', {});
  res.json({ id: r.rows[0].id });
});
app.post('/api/transactions/bulk', auth, async (req, res) => {
  const { machine_id, company, notes } = req.body;
  if (!machine_id||!company) return res.status(400).json({ error: 'Vinç ve firma zorunlu' });
  const machine = (await query('SELECT * FROM machines WHERE id=$1', [machine_id])).rows[0];
  if (!machine) return res.status(404).json({ error: 'Vinç bulunamadı' });
  const numCol = await getNumCol(); const ids = [];
  for (const item of (machine.items||[])) {
    const r = await query('INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, Number(item.product_id), company, Number(item.quantity), `${machine.machine_name} için toplu alım${notes?' — '+notes:''}`, 'out']);
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
  if (tx.tx_type!=='return') await restoreStock(tx.product_id, parseFloat(tx.quantity), numCol);
  else await deductStock(tx.product_id, parseFloat(tx.quantity), numCol);
  await query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
  broadcast('stock_update', {}); res.json({ ok: true });
});

// ── TASKS ─────────────────────────────────────────────────────────────────
app.get('/api/tasks', auth, async (req, res) => {
  const { status, assigned_to, firm_id } = req.query;
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params = [];
  if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
  if (assigned_to) { params.push(assigned_to); sql += ` AND assigned_to=$${params.length}`; }
  if (firm_id) { params.push(firm_id); sql += ` AND firm_id=$${params.length}`; }
  sql += ' ORDER BY CASE priority WHEN \'urgent\' THEN 1 WHEN \'high\' THEN 2 WHEN \'normal\' THEN 3 ELSE 4 END, created_at DESC';
  const rows = (await query(sql, params)).rows;
  res.json(await Promise.all(rows.map(enrichTask)));
});

app.post('/api/tasks', auth, async (req, res) => {
  const { title, task_type, firm_id, machine_id, assigned_to, priority, notes, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'İş başlığı gerekli' });
  const status = assigned_to ? 'in_progress' : 'open';
  const started_at = assigned_to ? 'NOW()' : null;
  const r = await query(
    `INSERT INTO tasks(title,task_type,firm_id,machine_id,assigned_to,created_by,status,priority,notes,due_date${assigned_to?',started_at':''})
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10${assigned_to?',NOW()':''}) RETURNING *`,
    [title, task_type||'Genel', firm_id||null, machine_id||null, assigned_to||null, req.user.id, status, priority||'normal', notes||'', due_date||null]
  );
  broadcast('task_update', { action: 'created', user: req.user.display_name });
  res.json(await enrichTask(r.rows[0]));
});

app.put('/api/tasks/:id', auth, async (req, res) => {
  const { title, task_type, firm_id, machine_id, priority, notes, due_date } = req.body;
  await query('UPDATE tasks SET title=$1,task_type=$2,firm_id=$3,machine_id=$4,priority=$5,notes=$6,due_date=$7,updated_at=NOW() WHERE id=$8',
    [title, task_type, firm_id||null, machine_id||null, priority, notes||'', due_date||null, req.params.id]);
  broadcast('task_update', { action: 'updated' });
  res.json({ ok: true });
});

// Personel işi üstlenir
app.post('/api/tasks/:id/take', auth, async (req, res) => {
  const task = (await query('SELECT * FROM tasks WHERE id=$1', [req.params.id])).rows[0];
  if (!task) return res.status(404).json({ error: 'İş bulunamadı' });
  if (task.status !== 'open') return res.status(400).json({ error: 'Bu iş zaten alınmış' });
  await query("UPDATE tasks SET assigned_to=$1,status='in_progress',started_at=NOW(),updated_at=NOW() WHERE id=$2", [req.user.id, req.params.id]);
  broadcast('task_update', { action: 'taken', user: req.user.display_name });
  res.json({ ok: true });
});

// İşi tamamla
app.post('/api/tasks/:id/complete', auth, async (req, res) => {
  const task = (await query('SELECT * FROM tasks WHERE id=$1', [req.params.id])).rows[0];
  if (!task) return res.status(404).json({ error: 'İş bulunamadı' });
  if (task.assigned_to !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Bu iş size ait değil' });
  await query("UPDATE tasks SET status='completed',completed_at=NOW(),updated_at=NOW() WHERE id=$1", [req.params.id]);
  broadcast('task_update', { action: 'completed', user: req.user.display_name });
  res.json({ ok: true });
});

// Devir talebi gönder
app.post('/api/tasks/:id/transfer', auth, async (req, res) => {
  const { to_user_id, message } = req.body;
  if (!to_user_id) return res.status(400).json({ error: 'Hedef personel gerekli' });
  const task = (await query('SELECT * FROM tasks WHERE id=$1', [req.params.id])).rows[0];
  if (!task) return res.status(404).json({ error: 'İş bulunamadı' });
  if (task.assigned_to !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Bu iş size ait değil' });
  // Admin direkt devreder
  if (req.user.role === 'admin') {
    await query('INSERT INTO task_transfers(task_id,from_user_id,to_user_id,message,status,resolved_at) VALUES($1,$2,$3,$4,\'accepted\',NOW())',
      [req.params.id, req.user.id, to_user_id, message||'Yönetici tarafından devredildi']);
    await query("UPDATE tasks SET assigned_to=$1,status='in_progress',updated_at=NOW() WHERE id=$2", [to_user_id, req.params.id]);
  } else {
    await query("DELETE FROM task_transfers WHERE task_id=$1 AND status='pending'", [req.params.id]);
    await query('INSERT INTO task_transfers(task_id,from_user_id,to_user_id,message) VALUES($1,$2,$3,$4)',
      [req.params.id, req.user.id, to_user_id, message||'']);
    await query("UPDATE tasks SET status='pending_transfer',updated_at=NOW() WHERE id=$1", [req.params.id]);
  }
  broadcast('task_update', { action: 'transfer', user: req.user.display_name });
  res.json({ ok: true });
});

// Devir kabul/red
app.post('/api/task-transfers/:id/respond', auth, async (req, res) => {
  const { accept } = req.body;
  const tr = (await query('SELECT * FROM task_transfers WHERE id=$1', [req.params.id])).rows[0];
  if (!tr) return res.status(404).json({ error: 'Devir bulunamadı' });
  if (tr.to_user_id !== req.user.id) return res.status(403).json({ error: 'Bu devir size ait değil' });
  await query("UPDATE task_transfers SET status=$1,resolved_at=NOW() WHERE id=$2", [accept?'accepted':'rejected', req.params.id]);
  if (accept) {
    await query("UPDATE tasks SET assigned_to=$1,status='in_progress',updated_at=NOW() WHERE id=$2", [req.user.id, tr.task_id]);
  } else {
    await query("UPDATE tasks SET status='in_progress',updated_at=NOW() WHERE id=$1", [tr.task_id]);
  }
  broadcast('task_update', { action: accept?'transfer_accepted':'transfer_rejected', user: req.user.display_name });
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', auth, admin, async (req, res) => {
  await query('DELETE FROM task_transfers WHERE task_id=$1', [req.params.id]);
  await query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
  broadcast('task_update', { action: 'deleted' });
  res.json({ ok: true });
});

// Bekleyen devir talepleri
app.get('/api/task-transfers/pending', auth, async (req, res) => {
  const rows = (await query(
    'SELECT tt.*,t.title,u1.display_name as from_name FROM task_transfers tt JOIN tasks t ON t.id=tt.task_id JOIN users u1 ON u1.id=tt.from_user_id WHERE tt.to_user_id=$1 AND tt.status=\'pending\'',
    [req.user.id]
  )).rows;
  res.json(rows);
});

// ── PERFORMANCE ───────────────────────────────────────────────────────────
app.get('/api/performance', auth, async (req, res) => {
  const users = (await query("SELECT id,username,display_name FROM users WHERE role='personnel' ORDER BY display_name")).rows;
  const results = await Promise.all(users.map(async u => {
    const completed = parseInt((await query("SELECT COUNT(*) as c FROM tasks WHERE assigned_to=$1 AND status='completed'", [u.id])).rows[0].c);
    const inProgress = parseInt((await query("SELECT COUNT(*) as c FROM tasks WHERE assigned_to=$1 AND status IN ('in_progress','pending_transfer')", [u.id])).rows[0].c);
    const txCount = parseInt((await query("SELECT COUNT(*) as c FROM transactions WHERE user_id=$1", [u.id])).rows[0].c);
    const avgHoursRow = (await query("SELECT AVG(EXTRACT(EPOCH FROM (completed_at-started_at))/3600) as avg FROM tasks WHERE assigned_to=$1 AND status='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL", [u.id])).rows[0];
    const avgHours = avgHoursRow.avg ? parseFloat(avgHoursRow.avg).toFixed(1) : null;
    const score = completed * 10 + txCount * 2 + (avgHours && avgHours < 4 ? 5 : 0);
    return { ...u, completed_tasks: completed, in_progress: inProgress, tx_count: txCount, avg_hours: avgHours, score };
  }));
  results.sort((a, b) => b.score - a.score);
  res.json(results);
});

// ── USERS ─────────────────────────────────────────────────────────────────
app.get('/api/users', auth, admin, async (req, res) => res.json((await query('SELECT id,username,role,display_name,created_at FROM users ORDER BY created_at')).rows));
app.post('/api/users', auth, admin, async (req, res) => {
  const { username, password, role, display_name } = req.body;
  if (!username||!password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  try { res.json({ id: (await query('INSERT INTO users(username,password_hash,role,display_name) VALUES($1,$2,$3,$4) RETURNING id', [username, bcrypt.hashSync(password,10), role||'personnel', display_name||username])).rows[0].id }); }
  catch { res.status(409).json({ error: 'Bu kullanıcı adı zaten mevcut' }); }
});
app.put('/api/users/:id', auth, admin, async (req, res) => {
  const { display_name, role, password } = req.body;
  if (password) await query('UPDATE users SET display_name=$1,role=$2,password_hash=$3 WHERE id=$4', [display_name, role, bcrypt.hashSync(password,10), req.params.id]);
  else await query('UPDATE users SET display_name=$1,role=$2 WHERE id=$3', [display_name, role, req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/users/:id', auth, admin, async (req, res) => {
  if (Number(req.params.id)===req.user.id) return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
  await query('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ ok: true });
});

// ── CSV ───────────────────────────────────────────────────────────────────
app.get('/api/export/stock', auth, async (req, res) => {
  const cols = (await query('SELECT * FROM column_defs ORDER BY display_order')).rows;
  const prods = (await query('SELECT * FROM products ORDER BY created_at DESC')).rows;
  const e = v => { const s=String(v||''); return s.includes(',')||s.includes('"')?`"${s.replace(/"/g,'""')}"`:`${s}`; };
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="stok-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF'+[cols.map(c=>c.name).join(','),...prods.map(p=>cols.map(c=>e(p.values?.[c.id]||'')).join(','))].join('\n'));
});
app.get('/api/export/transactions', auth, async (req, res) => {
  const txs = await enrichTx((await query('SELECT * FROM transactions ORDER BY created_at DESC')).rows);
  const e = v => { const s=String(v||''); return s.includes(',')||s.includes('"')?`"${s.replace(/"/g,'""')}"`:`${s}`; };
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="islemler-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF'+[['Tarih','Personel','Ürün','Firma','Miktar','Tür','Not'].join(','),...txs.map(t=>[t.created_at?.toString().slice(0,19),t.user_name,t.product_name,t.company,t.quantity,t.tx_type==='return'?'İade':'Çıkış',t.notes||''].map(e).join(','))].join('\n'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  await init();
  const uc = await query('SELECT COUNT(*) as c FROM users');
  if (parseInt(uc.rows[0].c) === 0) {
    await query('INSERT INTO users(username,password_hash,role,display_name) VALUES($1,$2,$3,$4)', ['admin', bcrypt.hashSync('admin123',10), 'admin', 'Yönetici']);
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
start().catch(err => { console.error('Hata:', err); process.exit(1); });
