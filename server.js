const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { query, init, pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET && !process.env.SESSION_SECRET) {
  console.warn('⚠️  JWT_SECRET ortam değişkeni ayarlanmadı! Üretim ortamında mutlaka ayarlayın.');
}
const DEFAULT_STAGES = ['Pano', 'Yerleştirme', 'Kedi Tesisat'];

process.on('unhandledRejection', (err) => { console.error('Unhandled Rejection:', err); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); });

app.set('trust proxy', 1);
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Authorization,Content-Type');
  res.header('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  if(req.method==='OPTIONS')return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

// ── AKTİVİTE LOG HELPER (AUDIT TRAIL) ────────────────────────────────────
async function logActivity(userId, action, entityType, entityId = null, details = {}, req = null) {
  try {
    const ip = req ? (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '') : null;
    await query(
      'INSERT INTO activity_log(user_id, action, entity_type, entity_id, details, ip_address) VALUES($1, $2, $3, $4, $5, $6)',
      [userId || null, action, entityType, entityId || null, JSON.stringify(details || {}), ip]
    );
    broadcast('activity_new', {});
  } catch(e) {
    console.error('logActivity error:', e.message);
  }
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Giriş yapın' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Oturum süresi doldu' }); }
}
function admin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  next();
}
function adminOrPurchase(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'purchase') return res.status(403).json({ error: 'Yetki gerekli' });
  next();
}

async function getNumCol() {
  try { return (await query("SELECT * FROM column_defs WHERE data_type='number' ORDER BY display_order LIMIT 1")).rows[0] || null; }
  catch(e) { return null; }
}
async function getFirstCol() {
  try { return (await query("SELECT * FROM column_defs ORDER BY display_order LIMIT 1")).rows[0] || null; }
  catch(e) { return null; }
}
async function deductStock(product_id, qty, numCol) {
  if (!numCol) return;
  const r = await query('SELECT "values" FROM products WHERE id=$1', [product_id]);
  if (!r.rows[0]) return;
  const vals = r.rows[0].values || {};
  vals[numCol.id] = String(Math.max(0, parseFloat(vals[numCol.id] || 0) - qty));
  await query('UPDATE products SET "values"=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(vals), product_id]);
}
async function restoreStock(product_id, qty, numCol) {
  if (!numCol) return;
  const r = await query('SELECT "values" FROM products WHERE id=$1', [product_id]);
  if (!r.rows[0]) return;
  const vals = r.rows[0].values || {};
  vals[numCol.id] = String(parseFloat(vals[numCol.id] || 0) + qty);
  await query('UPDATE products SET "values"=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(vals), product_id]);
}
async function enrichTx(rows) {
  const firstCol = await getFirstCol();
  return Promise.all(rows.map(async t => {
    const u = (await query('SELECT username,display_name FROM users WHERE id=$1', [t.user_id])).rows[0];
    const p = (await query('SELECT "values" FROM products WHERE id=$1', [t.product_id])).rows[0];
    return { ...t, user_name: u?.display_name || u?.username || '?', username: u?.username || '?', product_name: firstCol ? (p?.values?.[firstCol.id] || '—') : '—' };
  }));
}

async function enrichTask(t) {
  const firm = t.firm_id ? (await query('SELECT id,name FROM firms WHERE id=$1', [t.firm_id])).rows[0] : null;
  const machine = t.machine_id ? (await query('SELECT id,machine_name FROM machines WHERE id=$1', [t.machine_id])).rows[0] : null;
  const creator = t.created_by ? (await query('SELECT id,username,display_name FROM users WHERE id=$1', [t.created_by])).rows[0] : null;
  const stagesRaw = (await query('SELECT * FROM task_stages WHERE task_id=$1 ORDER BY stage_order', [t.id])).rows;
  const stages = await Promise.all(stagesRaw.map(async s => {
    const assignee = s.assigned_to ? (await query('SELECT id,username,display_name FROM users WHERE id=$1', [s.assigned_to])).rows[0] : null;
    const pending_transfer = (await query("SELECT tt.*,u.display_name as from_name FROM task_transfers tt JOIN users u ON u.id=tt.from_user_id WHERE tt.stage_id=$1 AND tt.status='pending' LIMIT 1", [s.id])).rows[0] || null;
    return { ...s, assignee_name: assignee?.display_name || assignee?.username || null, pending_transfer };
  }));
  const allDone = stages.every(s => s.status === 'completed');
  const anyActive = stages.some(s => s.status === 'in_progress' || s.status === 'pending_transfer');
  const derivedStatus = allDone ? 'completed' : anyActive ? 'in_progress' : 'open';
  if (derivedStatus !== t.status) {
    await query('UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2', [derivedStatus, t.id]);
  }
  return { ...t, status: derivedStatus, firm_name: firm?.name || null, machine_name: machine?.machine_name || null, creator_name: creator?.display_name || creator?.username || null, stages };
}

async function autoCreateTask(machine_id, firm_id, machine_name) {
  const existing = (await query('SELECT id FROM tasks WHERE machine_id=$1 AND is_auto=TRUE', [machine_id])).rows[0];
  if (existing) return existing;
  const t = (await query('INSERT INTO tasks(title,firm_id,machine_id,is_auto,status,priority) VALUES($1,$2,$3,TRUE,\'open\',\'normal\') RETURNING *',
    [`${machine_name}`, firm_id || null, machine_id])).rows[0];
  for (let i = 0; i < DEFAULT_STAGES.length; i++) {
    await query('INSERT INTO task_stages(task_id,stage_order,stage_name) VALUES($1,$2,$3)', [t.id, i + 1, DEFAULT_STAGES[i]]);
  }
  return t;
}

let goldCache = null, goldLastFetch = 0;
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
    goldCache = { price: ((usdGold * usdtry) / 31.1035).toFixed(2), usd_oz: usdGold.toFixed(2), usdtry: usdtry.toFixed(4), updated: new Date().toISOString() };
    goldLastFetch = Date.now();
    return goldCache;
  } catch { return goldCache || { error: 'Veri alınamadı', updated: null }; }
}
setInterval(async () => { broadcast('gold_update', await fetchGold()); }, 5 * 60 * 1000);

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < 15 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Çok fazla deneme. 15 dakika bekleyin.' });
  recent.push(now);
  loginAttempts.set(ip, recent);
  next();
}
setInterval(() => { loginAttempts.forEach((v, k) => { if (!v.length || Date.now() - v[v.length-1] > 15*60*1000) loginAttempts.delete(k); }); }, 30*60*1000);

app.post('/api/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gereklidir' });
    
    const cleanUsername = String(username).trim();
    const user = (await query('SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER($1)', [cleanUsername])).rows[0];
    
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
      
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, display_name: user.display_name }, JWT_SECRET, { expiresIn: '8h' });
    await logActivity(user.id, 'Giriş Yapıldı', 'auth', user.id, { username: user.username, role: user.role }, req);
    res.json({ role: user.role, display_name: user.display_name, token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/logout', (req, res) => res.json({ ok: true }));
app.get('/api/me', auth, (req, res) => res.json(req.user));

// ── SSE ───────────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).end();
  try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 15000);
  req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
});

app.get('/api/gold', auth, async (req, res) => res.json(await fetchGold()));

// ── AKTİVİTE LOGLARI API ──────────────────────────────────────────────────
app.get('/api/activity-logs', auth, admin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 300;
    const rows = (await query(`
      SELECT a.*, u.username, u.display_name, u.role
      FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT $1
    `, [limit])).rows;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/export/activity-logs', auth, admin, async (req, res) => {
  try {
    const rows = (await query(`
      SELECT a.*, u.username, u.display_name
      FROM activity_log a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT 1000
    `)).rows;
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="aktivite-gunlugu-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [['Tarih', 'Kullanıcı', 'İşlem', 'Varlık Türü', 'Varlık ID', 'Detaylar', 'IP Adresi'].join(','),
      ...rows.map(r => [
        r.created_at?.toISOString().slice(0, 19),
        r.display_name || r.username || 'Sistem',
        r.action,
        r.entity_type,
        r.entity_id || '',
        JSON.stringify(r.details || {}),
        r.ip_address || ''
      ].map(e).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});

// ── COLUMNS ───────────────────────────────────────────────────────────────
app.get('/api/columns', auth, async (req, res) => {
  try { res.json((await query('SELECT * FROM column_defs ORDER BY display_order ASC, id ASC')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/columns', auth, admin, async (req, res) => {
  try {
    const { name, data_type, min_stock, display_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Sütun adı gerekli' });
    const mo = (await query('SELECT COALESCE(MAX(display_order),0) as m FROM column_defs')).rows[0].m;
    const ord = display_order !== undefined ? parseInt(display_order) : parseInt(mo) + 1;
    const r = (await query('INSERT INTO column_defs(name,data_type,display_order,min_stock) VALUES($1,$2,$3,$4) RETURNING *', [name, data_type || 'text', ord, min_stock || 5])).rows[0];
    await logActivity(req.user.id, 'Sütun Eklendi', 'column', r.id, { name, data_type, min_stock }, req);
    broadcast('column_update', {});
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/columns/:id', auth, admin, async (req, res) => {
  try {
    const { name, data_type, display_order, min_stock } = req.body;
    await query('UPDATE column_defs SET name=$1,data_type=$2,display_order=$3,min_stock=$4 WHERE id=$5', [name, data_type, parseInt(display_order) || 0, min_stock || 0, req.params.id]);
    await logActivity(req.user.id, 'Sütun Güncellendi', 'column', parseInt(req.params.id), { name, data_type, min_stock, display_order }, req);
    broadcast('column_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/columns/:id', auth, admin, async (req, res) => {
  try {
    const cid = req.params.id;
    for (const p of (await query('SELECT id, "values" FROM products')).rows) {
      if (p.values?.[cid] !== undefined) { delete p.values[cid]; await query('UPDATE products SET "values"=$1 WHERE id=$2', [JSON.stringify(p.values), p.id]); }
    }
    await query('DELETE FROM column_defs WHERE id=$1', [cid]);
    await logActivity(req.user.id, 'Sütun Silindi', 'column', parseInt(cid), {}, req);
    broadcast('column_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRODUCTS ─────────────────────────────────────────────────────────────
app.get('/api/products', auth, async (req, res) => {
  try { res.json((await query('SELECT id, "values", display_order, created_at, updated_at FROM products ORDER BY display_order ASC, created_at DESC')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/products', auth, admin, async (req, res) => {
  try {
    const mo = (await query('SELECT COALESCE(MAX(display_order),0) as m FROM products')).rows[0].m;
    const ord = req.body.display_order !== undefined ? parseInt(req.body.display_order) : parseInt(mo) + 1;
    const r = await query('INSERT INTO products("values", display_order) VALUES($1, $2) RETURNING *', [JSON.stringify(req.body.values || {}), ord]);
    await logActivity(req.user.id, 'Ürün Eklendi', 'product', r.rows[0].id, { values: req.body.values }, req);
    broadcast('stock_update', {}); res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/products/:id', auth, admin, async (req, res) => {
  try {
    const cur = (await query('SELECT "values", display_order FROM products WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Ürün bulunamadı' });
    const ord = req.body.display_order !== undefined ? parseInt(req.body.display_order) : cur.display_order;
    const updatedValues = { ...cur.values, ...(req.body.values || {}) };
    await query('UPDATE products SET "values"=$1, display_order=$2, updated_at=NOW() WHERE id=$3', [JSON.stringify(updatedValues), ord, req.params.id]);
    await logActivity(req.user.id, 'Ürün Güncellendi', 'product', parseInt(req.params.id), { values: req.body.values }, req);
    broadcast('stock_update', {}); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/products/:id', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM products WHERE id=$1', [req.params.id]);
    await logActivity(req.user.id, 'Ürün Silindi', 'product', parseInt(req.params.id), {}, req);
    broadcast('stock_update', {}); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FIRMS ─────────────────────────────────────────────────────────────────
app.get('/api/firms', auth, async (req, res) => {
  try { res.json((await query('SELECT * FROM firms ORDER BY display_order ASC, name ASC')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/firms', auth, admin, async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Firma adı gerekli' });
  try { 
    const mo = (await query('SELECT COALESCE(MAX(display_order),0) as m FROM firms')).rows[0].m;
    const ord = req.body.display_order !== undefined ? parseInt(req.body.display_order) : parseInt(mo) + 1;
    const r = (await query('INSERT INTO firms(name,notes,display_order) VALUES($1,$2,$3) RETURNING *', [req.body.name, req.body.notes || '', ord])).rows[0];
    await logActivity(req.user.id, 'Firma Eklendi', 'firm', r.id, { name: req.body.name }, req);
    broadcast('firm_update', {});
    res.json(r); 
  }
  catch { res.status(409).json({ error: 'Bu firma zaten mevcut' }); }
});
app.put('/api/firms/:id', auth, admin, async (req, res) => {
  try {
    const { name, notes, display_order } = req.body;
    await query('UPDATE firms SET name=$1, notes=$2, display_order=$3 WHERE id=$4', [name, notes || '', parseInt(display_order) || 0, req.params.id]); 
    await logActivity(req.user.id, 'Firma Güncellendi', 'firm', parseInt(req.params.id), { name, notes, display_order }, req);
    broadcast('firm_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/firms/:id', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM firms WHERE id=$1', [req.params.id]); 
    await logActivity(req.user.id, 'Firma Silindi', 'firm', parseInt(req.params.id), {}, req);
    broadcast('firm_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MACHINES ─────────────────────────────────────────────────────────────
async function enrichMachines(rows) {
  const firstCol = await getFirstCol();
  return Promise.all(rows.map(async m => {
    const firm = m.firm_id ? (await query('SELECT * FROM firms WHERE id=$1', [m.firm_id])).rows[0] : null;
    return {
      ...m, firm_name: firm?.name || null,
      items: await Promise.all((m.items || []).map(async it => {
        const p = (await query('SELECT "values" FROM products WHERE id=$1', [it.product_id])).rows[0];
        return { ...it, product_name: firstCol ? (p?.values?.[firstCol.id] || '—') : '—' };
      }))
    };
  }));
}
app.get('/api/machines', auth, async (req, res) => {
  try {
    const firm_id = req.query.firm_id;
    const rows = firm_id
      ? (await query('SELECT * FROM machines WHERE firm_id=$1 ORDER BY display_order ASC, created_at DESC', [firm_id])).rows
      : (await query('SELECT * FROM machines ORDER BY display_order ASC, firm_id NULLS LAST, created_at DESC')).rows;
    res.json(await enrichMachines(rows));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/machines', auth, admin, async (req, res) => {
  try {
    const { machine_name, notes, items, firm_id, display_order, capacity } = req.body;
    if (!machine_name) return res.status(400).json({ error: 'Vinç adı gerekli' });
    const mo = (await query('SELECT COALESCE(MAX(display_order),0) as m FROM machines')).rows[0].m;
    const ord = display_order !== undefined ? parseInt(display_order) : parseInt(mo) + 1;
    const r = (await query('INSERT INTO machines(machine_name,firm_id,notes,items,display_order,capacity) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [machine_name, firm_id || null, notes || '', JSON.stringify(items || []), ord, capacity || ''])).rows[0];
    await autoCreateTask(r.id, firm_id || null, machine_name);
    await logActivity(req.user.id, 'Vinç / Reçete Oluşturuldu', 'machine', r.id, { machine_name, firm_id, capacity, itemCount: (items || []).length }, req);
    broadcast('task_update', { action: 'auto_created', machine: machine_name });
    broadcast('machine_update', {});
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/machines/:id', auth, admin, async (req, res) => {
  try {
    const { machine_name, notes, items, firm_id, display_order, capacity } = req.body;
    await query('UPDATE machines SET machine_name=$1,firm_id=$2,notes=$3,items=$4,display_order=$5,capacity=$6 WHERE id=$7',
      [machine_name, firm_id || null, notes || '', JSON.stringify(items || []), parseInt(display_order) || 0, capacity || '', req.params.id]);
    await query('UPDATE tasks SET title=$1,firm_id=$2,updated_at=NOW() WHERE machine_id=$3 AND is_auto=TRUE',
      [machine_name, firm_id || null, req.params.id]);
    await logActivity(req.user.id, 'Vinç / Reçete Güncellendi', 'machine', parseInt(req.params.id), { machine_name, firm_id, capacity, itemCount: (items || []).length }, req);
    broadcast('machine_update', {});
    broadcast('task_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/machines/:id', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM machines WHERE id=$1', [req.params.id]); 
    await logActivity(req.user.id, 'Vinç Silindi', 'machine', parseInt(req.params.id), {}, req);
    broadcast('machine_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TRANSACTIONS ─────────────────────────────────────────────────────────
app.get('/api/transactions', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 300;
    const pid = req.query.product_id;
    const sql = pid ? 'SELECT * FROM transactions WHERE product_id=$1 ORDER BY created_at DESC LIMIT $2' : 'SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1';
    res.json(await enrichTx((await query(sql, pid ? [pid, limit] : [limit])).rows));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/transactions', auth, async (req, res) => {
  try {
    const { product_id, company, quantity, notes, tx_type } = req.body;
    if (!product_id || !company || !quantity) return res.status(400).json({ error: 'Ürün, firma ve miktar zorunlu' });
    const type = tx_type || 'out';
    const r = await query('INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, Number(product_id), company, Number(quantity), notes || '', type]);
    const numCol = await getNumCol();
    let hasLots = false;
    try {
      const lc = (await query('SELECT COUNT(*) as c FROM product_lots WHERE product_id=$1', [product_id])).rows[0];
      hasLots = parseInt(lc.c) > 0;
    } catch(e) { hasLots = false; }
    if (type === 'out') {
      if (hasLots) await deductFromLots(product_id, Number(quantity));
      else await deductStock(product_id, Number(quantity), numCol);
    } else if (type === 'return') {
      if (hasLots) await restoreToLots(product_id, Number(quantity));
      else await restoreStock(product_id, Number(quantity), numCol);
    }
    await logActivity(req.user.id, type === 'return' ? 'Ürün İade Edildi' : 'Stok Çıkışı Yapıldı', 'transaction', r.rows[0].id, { product_id, company, quantity, tx_type: type }, req);
    broadcast('tx_new', { user: req.user.display_name }); broadcast('stock_update', {});
    res.json({ id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/machines/:id/taken', auth, async (req, res) => {
  try {
    const rows = (await query(
      "SELECT product_id, COALESCE(bom_category,'') as bom_category, SUM(CASE WHEN tx_type='out' THEN quantity WHEN tx_type='return' THEN -quantity ELSE 0 END) as taken FROM transactions WHERE machine_id=$1 GROUP BY product_id, COALESCE(bom_category,'')",
      [req.params.id]
    )).rows;
    const m = {};
    rows.forEach(r => {
      const cat = r.bom_category || '';
      const key = cat ? r.product_id + '::' + cat : String(r.product_id);
      m[key] = (m[key] || 0) + parseFloat(r.taken || 0);
      m[r.product_id] = (m[r.product_id] || 0) + parseFloat(r.taken || 0);
    });
    res.json(m);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transactions/bulk', auth, async (req, res) => {
  try {
    const { machine_id, company, notes, items_to_take } = req.body;
    if (!machine_id || !company) return res.status(400).json({ error: 'Vinç ve firma zorunlu' });
    const machine = (await query('SELECT * FROM machines WHERE id=$1', [machine_id])).rows[0];
    if (!machine) return res.status(404).json({ error: 'Vinç bulunamadı' });
    
    const items = items_to_take && items_to_take.length > 0 ? items_to_take : (machine.items || []);
    const numCol = await getNumCol(); const ids = [];
    for (const item of items) {
      const qty = Number(item.quantity);
      if (!qty || qty <= 0) continue;
      
      let hasLots = false;
      try {
        const lc = (await query('SELECT COUNT(*) as c FROM product_lots WHERE product_id=$1', [item.product_id])).rows[0];
        hasLots = parseInt(lc.c) > 0;
      } catch(e) { hasLots = false; }
      
      const bomCat = item.bom_category || null;
      const r = await query('INSERT INTO transactions(user_id,product_id,company,quantity,notes,tx_type,machine_id,bom_category) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [req.user.id, Number(item.product_id), company, qty, `${machine.machine_name}${notes ? ' — ' + notes : ''}`, 'out', Number(machine_id), bomCat]);
      
      if (hasLots) await deductFromLots(item.product_id, qty);
      else await deductStock(item.product_id, qty, numCol);
      
      ids.push(r.rows[0].id);
    }
    await logActivity(req.user.id, 'Vinç İçin Toplu Malzeme Alındı', 'transaction_bulk', parseInt(machine_id), { machine_name: machine.machine_name, company, itemCount: ids.length }, req);
    broadcast('tx_new', {}); broadcast('stock_update', {});
    res.json({ ids, count: ids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/transactions/:id', auth, admin, async (req, res) => {
  try {
    const tx = (await query('SELECT * FROM transactions WHERE id=$1', [req.params.id])).rows[0];
    if (!tx) return res.status(404).json({ error: 'Bulunamadı' });
    const numCol = await getNumCol();
    if (tx.tx_type !== 'return') await restoreStock(tx.product_id, parseFloat(tx.quantity), numCol);
    else await deductStock(tx.product_id, parseFloat(tx.quantity), numCol);
    await query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
    await logActivity(req.user.id, 'İşlem İptal Edildi (Stok Geri Yüklendi)', 'transaction', parseInt(req.params.id), { product_id: tx.product_id, quantity: tx.quantity, type: tx.tx_type }, req);
    broadcast('stock_update', {}); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TASKS ─────────────────────────────────────────────────────────────────
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const { firm_id, status } = req.query;
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const params = [];
    if (firm_id) { params.push(firm_id); sql += ` AND firm_id=$${params.length}`; }
    if (status) { params.push(status); sql += ` AND status=$${params.length}`; }
    sql += ' ORDER BY created_at DESC';
    const rows = (await query(sql, params)).rows;
    res.json(await Promise.all(rows.map(enrichTask)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks', auth, async (req, res) => {
  try {
    const { title, firm_id, machine_id, priority, notes, stage_names } = req.body;
    if (!title) return res.status(400).json({ error: 'Başlık gerekli' });
    const t = (await query('INSERT INTO tasks(title,firm_id,machine_id,created_by,is_auto,priority,notes) VALUES($1,$2,$3,$4,FALSE,$5,$6) RETURNING *',
      [title, firm_id || null, machine_id || null, req.user.id, priority || 'normal', notes || ''])).rows[0];
    const stages = stage_names?.length ? stage_names : DEFAULT_STAGES;
    for (let i = 0; i < stages.length; i++) {
      await query('INSERT INTO task_stages(task_id,stage_order,stage_name) VALUES($1,$2,$3)', [t.id, i + 1, stages[i]]);
    }
    await logActivity(req.user.id, 'Manuel İş Oluşturuldu', 'task', t.id, { title, priority, stages: stages.length }, req);
    broadcast('task_update', { action: 'created' });
    res.json(await enrichTask(t));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tasks/:id', auth, admin, async (req, res) => {
  try {
    const { title, firm_id, machine_id, priority, notes } = req.body;
    await query('UPDATE tasks SET title=$1,firm_id=$2,machine_id=$3,priority=$4,notes=$5,updated_at=NOW() WHERE id=$6',
      [title, firm_id || null, machine_id || null, priority || 'normal', notes || '', req.params.id]);
    await logActivity(req.user.id, 'İş Bilgileri Güncellendi', 'task', parseInt(req.params.id), { title, priority }, req);
    broadcast('task_update', {}); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tasks/:id', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM task_stages WHERE task_id=$1', [req.params.id]);
    await query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
    await logActivity(req.user.id, 'İş Silindi', 'task', parseInt(req.params.id), {}, req);
    broadcast('task_update', {}); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/task-stages/:id/assign', auth, admin, async (req, res) => {
  try {
    const { user_id } = req.body;
    const stage = (await query('SELECT * FROM task_stages WHERE id=$1', [req.params.id])).rows[0];
    if (!stage) return res.status(404).json({ error: 'Aşama bulunamadı' });
    if (user_id) {
      await query("UPDATE task_stages SET assigned_to=$1,status='in_progress',started_at=COALESCE(started_at,NOW()) WHERE id=$2", [user_id, req.params.id]);
      try{const _s=(await query("SELECT ts.stage_name,t.title FROM task_stages ts JOIN tasks t ON t.id=ts.task_id WHERE ts.id=$1",[req.params.id])).rows[0];if(_s)await createNotif(user_id,'⚡ Aşama Atandı: '+_s.stage_name,_s.title,'task');}catch(e){}
      await logActivity(req.user.id, 'Aşama Atandı', 'task_stage', parseInt(req.params.id), { stage_name: stage.stage_name, assigned_to: user_id }, req);
    } else {
      await query("UPDATE task_stages SET assigned_to=NULL,status='open',started_at=NULL WHERE id=$1", [req.params.id]);
      await logActivity(req.user.id, 'Aşama Ataması Kaldırıldı', 'task_stage', parseInt(req.params.id), { stage_name: stage.stage_name }, req);
    }
    const t = (await query('SELECT * FROM tasks WHERE id=$1', [stage.task_id])).rows[0];
    broadcast('task_update', { action: 'assigned' });
    res.json(await enrichTask(t));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/task-stages/:id/take', auth, async (req, res) => {
  try {
    const stage = (await query('SELECT * FROM task_stages WHERE id=$1', [req.params.id])).rows[0];
    if (!stage) return res.status(404).json({ error: 'Aşama bulunamadı' });
    if (stage.status !== 'open') return res.status(400).json({ error: 'Bu aşama zaten alınmış' });
    await query("UPDATE task_stages SET assigned_to=$1,status='in_progress',started_at=NOW() WHERE id=$2", [req.user.id, req.params.id]);
    await logActivity(req.user.id, 'Aşama Üstlenildi', 'task_stage', parseInt(req.params.id), { stage_name: stage.stage_name }, req);
    broadcast('task_update', { action: 'taken', user: req.user.display_name });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/task-stages/:id/complete', auth, async (req, res) => {
  try {
    const stage = (await query('SELECT * FROM task_stages WHERE id=$1', [req.params.id])).rows[0];
    if (!stage) return res.status(404).json({ error: 'Aşama bulunamadı' });
    if (stage.assigned_to !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Bu aşama size ait değil' });
    await query("UPDATE task_stages SET status='completed',completed_at=NOW() WHERE id=$1", [req.params.id]);
    await logActivity(req.user.id, 'Aşama Tamamlandı', 'task_stage', parseInt(req.params.id), { stage_name: stage.stage_name }, req);
    broadcast('task_update', { action: 'stage_completed', user: req.user.display_name });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/task-stages/:id/transfer', auth, async (req, res) => {
  try {
    const { to_user_id, message } = req.body;
    if (!to_user_id) return res.status(400).json({ error: 'Hedef personel gerekli' });
    const stage = (await query('SELECT * FROM task_stages WHERE id=$1', [req.params.id])).rows[0];
    if (!stage) return res.status(404).json({ error: 'Aşama bulunamadı' });
    if (stage.assigned_to !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Bu aşama size ait değil' });
    await query("UPDATE task_transfers SET status='rejected',resolved_at=NOW() WHERE stage_id=$1 AND status='pending'", [req.params.id]);
    if (req.user.role === 'admin') {
      await query('INSERT INTO task_transfers(stage_id,from_user_id,to_user_id,message,status,resolved_at) VALUES($1,$2,$3,$4,\'accepted\',NOW())',
        [req.params.id, req.user.id, to_user_id, message || 'Yönetici tarafından devredildi']);
      await query("UPDATE task_stages SET assigned_to=$1,status='in_progress',started_at=COALESCE(started_at,NOW()) WHERE id=$2", [to_user_id, req.params.id]);
      await logActivity(req.user.id, 'Aşama Doğrudan Devredildi', 'task_stage', parseInt(req.params.id), { to_user_id, message }, req);
    } else {
      await query('INSERT INTO task_transfers(stage_id,from_user_id,to_user_id,message) VALUES($1,$2,$3,$4)',
        [req.params.id, req.user.id, to_user_id, message || '']);
      await query("UPDATE task_stages SET status='pending_transfer' WHERE id=$1", [req.params.id]);
      await logActivity(req.user.id, 'Aşama Devir Talebi Açıldı', 'task_stage', parseInt(req.params.id), { to_user_id, message }, req);
    }
    broadcast('task_update', { action: 'transfer_requested', user: req.user.display_name });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/task-transfers/:id/respond', auth, async (req, res) => {
  try {
    const { accept } = req.body;
    const tr = (await query('SELECT * FROM task_transfers WHERE id=$1', [req.params.id])).rows[0];
    if (!tr) return res.status(404).json({ error: 'Devir bulunamadı' });
    if (tr.to_user_id !== req.user.id) return res.status(403).json({ error: 'Bu devir size ait değil' });
    await query("UPDATE task_transfers SET status=$1,resolved_at=NOW() WHERE id=$2", [accept ? 'accepted' : 'rejected', req.params.id]);
    if (accept) {
      await query("UPDATE task_stages SET assigned_to=$1,status='in_progress',started_at=COALESCE(started_at,NOW()) WHERE id=$2", [req.user.id, tr.stage_id]);
    } else {
      await query("UPDATE task_stages SET status='in_progress' WHERE id=$1", [tr.stage_id]);
    }
    await logActivity(req.user.id, accept ? 'Devir Kabul Edildi' : 'Devir Reddedildi', 'task_transfer', parseInt(req.params.id), { accept, stage_id: tr.stage_id }, req);
    broadcast('task_update', { action: accept ? 'transfer_accepted' : 'transfer_rejected', user: req.user.display_name });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/task-transfers/pending', auth, async (req, res) => {
  try {
    const rows = (await query(`
      SELECT tt.*, ts.stage_name, t.title as task_title, u.display_name as from_name
      FROM task_transfers tt
      JOIN task_stages ts ON ts.id = tt.stage_id
      JOIN tasks t ON t.id = ts.task_id
      JOIN users u ON u.id = tt.from_user_id
      WHERE tt.to_user_id=$1 AND tt.status='pending'
      ORDER BY tt.created_at DESC`, [req.user.id])).rows;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PERFORMANCE ───────────────────────────────────────────────────────────
app.get('/api/performance', auth, async (req, res) => {
  try {
    const users = (await query("SELECT id,username,display_name FROM users WHERE role='personnel' ORDER BY display_name")).rows;
    const results = await Promise.all(users.map(async u => {
      const completed = parseInt((await query("SELECT COUNT(*) as c FROM task_stages WHERE assigned_to=$1 AND status='completed'", [u.id])).rows[0].c);
      const inProgress = parseInt((await query("SELECT COUNT(*) as c FROM task_stages WHERE assigned_to=$1 AND status IN ('in_progress','pending_transfer')", [u.id])).rows[0].c);
      const txCount = parseInt((await query("SELECT COUNT(*) as c FROM transactions WHERE user_id=$1", [u.id])).rows[0].c);
      const avgRow = (await query("SELECT AVG(EXTRACT(EPOCH FROM (completed_at-started_at))/3600) as avg FROM task_stages WHERE assigned_to=$1 AND status='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL", [u.id])).rows[0];
      const avgHours = avgRow.avg ? parseFloat(avgRow.avg).toFixed(1) : null;
      const score = completed * 10 + txCount * 2 + (avgHours && avgHours < 4 ? 5 : 0);
      return { ...u, completed_stages: completed, in_progress: inProgress, tx_count: txCount, avg_hours: avgHours, score };
    }));
    results.sort((a, b) => b.score - a.score);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/active-sessions', auth, admin, (req, res) => {
  res.json({ connected_clients: sseClients.size });
});

// ── USERS ─────────────────────────────────────────────────────────────────
app.get('/api/users', auth, async (req, res) => {
  try { res.json((await query('SELECT id,username,role,display_name,created_at FROM users ORDER BY created_at ASC')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/users', auth, admin, async (req, res) => {
  const { username, password, role, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  try { 
    const cleanUsername = String(username).trim();
    const cleanDisplayName = display_name ? String(display_name).trim() : cleanUsername;
    const cleanRole = role ? String(role).trim() : 'personnel';
    
    const r = (await query(
      'INSERT INTO users(username, password_hash, role, display_name) VALUES($1, $2, $3, $4) RETURNING id',
      [cleanUsername, bcrypt.hashSync(password, 10), cleanRole, cleanDisplayName]
    )).rows[0];

    await logActivity(req.user.id, 'Kullanıcı Oluşturuldu', 'user', r.id, { username: cleanUsername, role: cleanRole, display_name: cleanDisplayName }, req);
    broadcast('user_update', {});
    res.json({ id: r.id }); 
  }
  catch (err) {
    console.error('Kullanıcı ekleme hatası:', err.message);
    if (err.code === '23505') { // Benzersizlik (Unique) hatası
      return res.status(409).json({ error: 'Bu kullanıcı adı zaten mevcut' });
    }
    res.status(500).json({ error: 'Kullanıcı oluşturulamadı: ' + err.message });
  }
});
app.put('/api/users/:id', auth, admin, async (req, res) => {
  try {
    const { display_name, role, password } = req.body;
    const cleanDisplayName = display_name ? String(display_name).trim() : '';
    const cleanRole = role ? String(role).trim() : 'personnel';
    if (password) await query('UPDATE users SET display_name=$1,role=$2,password_hash=$3 WHERE id=$4', [cleanDisplayName, cleanRole, bcrypt.hashSync(password, 10), req.params.id]);
    else await query('UPDATE users SET display_name=$1,role=$2 WHERE id=$3', [cleanDisplayName, cleanRole, req.params.id]);
    await logActivity(req.user.id, 'Kullanıcı Güncellendi', 'user', parseInt(req.params.id), { display_name: cleanDisplayName, role: cleanRole, passwordChanged: !!password }, req);
    broadcast('user_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/users/:id', auth, admin, async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
    await query('DELETE FROM users WHERE id=$1', [req.params.id]); 
    await logActivity(req.user.id, 'Kullanıcı Silindi', 'user', parseInt(req.params.id), {}, req);
    broadcast('user_update', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSV EXPORTS ───────────────────────────────────────────────────────────
app.get('/api/export/stock', auth, async (req, res) => {
  try {
    const cols = (await query('SELECT * FROM column_defs ORDER BY display_order ASC, id ASC')).rows;
    const prods = (await query('SELECT id, "values" FROM products ORDER BY display_order ASC, created_at DESC')).rows;
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="stok-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [cols.map(c => c.name).join(','), ...prods.map(p => cols.map(c => e(p.values?.[c.id] || '')).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});
app.get('/api/export/transactions', auth, async (req, res) => {
  try {
    const txs = await enrichTx((await query('SELECT * FROM transactions ORDER BY created_at DESC')).rows);
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="islemler-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [['Tarih', 'Personel', 'Ürün', 'Firma', 'Miktar', 'Tür', 'Not'].join(','),
      ...txs.map(t => [t.created_at?.toISOString().slice(0, 19), t.user_name, t.product_name, t.company, t.quantity, t.tx_type === 'return' ? 'İade' : 'Çıkış', t.notes || ''].map(e).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});
app.get('/api/export/firms', auth, async (req, res) => {
  try {
    const fms = (await query('SELECT * FROM firms ORDER BY display_order ASC, name ASC')).rows;
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="firmalar-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [['Firma Adı', 'Notlar'].join(','), ...fms.map(f => [f.name, f.notes].map(e).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});
app.get('/api/export/machines', auth, async (req, res) => {
  try {
    const mcs = (await query('SELECT m.*, f.name as firm_name FROM machines m LEFT JOIN firms f ON m.firm_id = f.id ORDER BY m.display_order ASC, m.machine_name ASC')).rows;
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vincler-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [['Vinç Adı', 'Firma', 'Kapasite/Tonaj', 'Notlar'].join(','), ...mcs.map(m => [m.machine_name, m.firm_name, m.capacity || '', m.notes].map(e).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});
app.get('/api/export/users', auth, admin, async (req, res) => {
  try {
    const usrs = (await query('SELECT * FROM users ORDER BY created_at')).rows;
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kullanicilar-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [['Ad', 'Kullanıcı Adı', 'Rol', 'Oluşturulma'].join(','), ...usrs.map(u => [u.display_name||u.username, u.username, u.role, u.created_at?.toISOString().slice(0, 19)].map(e).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});
async function getTasksEnriched() {
  const rows = (await query('SELECT * FROM tasks ORDER BY created_at DESC')).rows;
  return Promise.all(rows.map(enrichTask));
}
app.get('/api/export/tasks', auth, async (req, res) => {
  try {
    const tsks = await getTasksEnriched();
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="isler-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [['Başlık', 'Firma', 'Durum', 'Aşama Sayısı'].join(','), ...tsks.map(t => [t.title, t.firm_name||'-', t.status, t.stages?.length||0].map(e).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});
app.get('/api/export/purchases', auth, async (req, res) => {
  try {
    const prs = (await query('SELECT p.*, u.display_name as requester_name, t.title as task_title FROM purchase_requests p LEFT JOIN users u ON p.requested_by = u.id LEFT JOIN tasks t ON p.task_id = t.id ORDER BY p.created_at DESC')).rows;
    const e = v => { const s = String(v || ''); return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="satinalmalar-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [['Tarih', 'Personel', 'Ürün', 'Miktar', 'Neden', 'İş', 'Durum', 'Not'].join(','), ...prs.map(p => [p.created_at?.toISOString().slice(0, 19), p.requester_name, p.product_name, p.quantity + ' ' + (p.unit||''), p.reason, p.task_title, p.status, p.admin_note].map(e).join(','))].join('\n'));
  } catch(err) { res.status(500).send('CSV export error'); }
});

// ── BOM KATEGORİLERİ ──────────────────────────────────────────────────────
app.get('/api/bom-categories', auth, async (req, res) => {
  try { res.json((await query('SELECT * FROM bom_categories ORDER BY display_order ASC, id ASC')).rows); }
  catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/bom-categories', auth, admin, async (req, res) => {
  try {
    const { name, display_order } = req.body;
    if (!name || !name.trim()) return res.status(400).json({error: 'Kategori adı zorunlu'});
    const mo = (await query('SELECT COALESCE(MAX(display_order),0) as m FROM bom_categories')).rows[0].m;
    const ord = display_order !== undefined ? parseInt(display_order) : parseInt(mo) + 1;
    const r = (await query('INSERT INTO bom_categories(name, display_order) VALUES($1,$2) RETURNING *',
      [name.trim(), ord])).rows[0];
    await logActivity(req.user.id, 'BOM Kategorisi Eklendi', 'bom_category', r.id, { name: name.trim() }, req);
    broadcast('bom_category_update', {});
    res.json(r);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.put('/api/bom-categories/:id', auth, admin, async (req, res) => {
  try {
    const { name, display_order } = req.body;
    await query('UPDATE bom_categories SET name=$1, display_order=$2 WHERE id=$3', [name, parseInt(display_order) || 0, req.params.id]);
    await logActivity(req.user.id, 'BOM Kategorisi Güncellendi', 'bom_category', parseInt(req.params.id), { name, display_order }, req);
    broadcast('bom_category_update', {});
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/bom-categories/:id', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM bom_categories WHERE id=$1', [req.params.id]);
    await logActivity(req.user.id, 'BOM Kategorisi Silindi', 'bom_category', parseInt(req.params.id), {}, req);
    broadcast('bom_category_update', {});
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ── BOM SÜTUNLARI ─────────────────────────────────────────────────────────
app.get('/api/bom-columns', auth, async (req, res) => {
  try { res.json((await query('SELECT * FROM bom_columns ORDER BY display_order ASC, id ASC')).rows); }
  catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/bom-columns', auth, admin, async (req, res) => {
  try {
    const { name, mapped_field, display_order } = req.body;
    if (!name || !name.trim()) return res.status(400).json({error: 'Sütun adı zorunlu'});
    const mo = (await query('SELECT COALESCE(MAX(display_order),0) as m FROM bom_columns')).rows[0].m;
    const ord = display_order !== undefined ? parseInt(display_order) : parseInt(mo) + 1;
    const r = (await query('INSERT INTO bom_columns(name, display_order, is_default, mapped_field) VALUES($1,$2,false,$3) RETURNING *',
      [name.trim(), ord, mapped_field || null])).rows[0];
    await logActivity(req.user.id, 'BOM Sütunu Eklendi', 'bom_column', r.id, { name: name.trim(), mapped_field }, req);
    res.json(r);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.put('/api/bom-columns/:id', auth, admin, async (req, res) => {
  try {
    const { name, display_order, mapped_field } = req.body;
    await query('UPDATE bom_columns SET name=$1, display_order=$2, mapped_field=$3 WHERE id=$4', [name, parseInt(display_order) || 0, mapped_field || null, req.params.id]);
    await logActivity(req.user.id, 'BOM Sütunu Güncellendi', 'bom_column', parseInt(req.params.id), { name, mapped_field }, req);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/bom-columns/:id', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM bom_columns WHERE id=$1', [req.params.id]);
    await logActivity(req.user.id, 'BOM Sütunu Silindi', 'bom_column', parseInt(req.params.id), {}, req);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ── BOM DÜZENLEME TALEBİ (Personelden Yöneticiye) ──────────────────────────
app.post('/api/bom-edit-request', auth, async (req, res) => {
  try {
    const { machine_id, message } = req.body;
    if (!machine_id) return res.status(400).json({ error: 'Vinç seçimi zorunlu' });
    const m = (await query('SELECT * FROM machines WHERE id=$1', [machine_id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Vinç bulunamadı' });
    const admins = (await query("SELECT id FROM users WHERE role='admin'")).rows;
    const reqUser = req.user.display_name || req.user.username;
    for (const a of admins) {
      await createNotif(
        a.id,
        '📝 Malzeme Listesi Düzenleme Talebi: ' + m.machine_name,
        reqUser + ': ' + (message ? message.trim() : 'Düzenleme talep edildi.'),
        'warning'
      );
    }
    await logActivity(req.user.id, 'Malzeme Listesi Düzenleme Talebi Gönderildi', 'machine', parseInt(machine_id), { message: message?.trim() }, req);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BOM ÇIKTISI (Anlık Düzenleme, Excel, İmzalar, Kompakt Mod & Toplam Özeti) ──
app.get('/bom/:machine_id', auth, async (req, res) => {
  try {
    const machine = (await query('SELECT * FROM machines WHERE id=$1', [req.params.id || req.params.machine_id])).rows[0];
    if (!machine) return res.status(404).send('Vinç bulunamadı');
    const firm = machine.firm_id ? (await query('SELECT * FROM firms WHERE id=$1', [machine.firm_id])).rows[0] : null;
    const cols = (await query('SELECT * FROM column_defs ORDER BY display_order ASC, id ASC')).rows;
    const bomCols = (await query('SELECT * FROM bom_columns ORDER BY display_order ASC, id ASC')).rows;
    const prods = (await query('SELECT id, "values" FROM products')).rows;
    const firstCol = cols[0];
    const numCol = cols.find(c => c.data_type === 'number');
    const unitCol = cols.find(c => c.name.toLowerCase().includes('birim'));
    const catCol = cols.find(c => c.name.toLowerCase().includes('kategori'));
    const extraColCount = parseInt(req.query.extra_cols) || 0;
    const extraRowCount = parseInt(req.query.extra_rows) || 0;
    const orientation = req.query.orientation === 'portrait' ? 'portrait' : 'landscape';
    
    const categoryMap = {};
    (machine.items || []).forEach(it => {
      const prod = prods.find(p => p.id === Number(it.product_id));
      const prodCat = catCol && prod?.values ? prod.values[catCol.id] : (prod?.values?.category || prod?.values?._category);
      const cat = it.category_name || prodCat || 'Genel';
      if (!categoryMap[cat]) categoryMap[cat] = [];
      categoryMap[cat].push({ item: it, prod: prod, cat: cat });
    });
    
    let globalNo = 0;
    let totalQuantityCount = 0;
    const items = [];
    Object.entries(categoryMap).forEach(([catName, catItems]) => {
      items.push({ isCategory: true, categoryName: catName });
      catItems.forEach(({ item: it, prod, cat }) => {
        globalNo++;
        const qVal = parseFloat(it.quantity) || 0;
        totalQuantityCount += qVal;
        items.push({
          isCategory: false,
          no: globalNo,
          name: prod && firstCol ? (prod.values?.[firstCol.id] || '—') : (it.product_name || '—'),
          qty: it.quantity,
          unit: prod && unitCol ? (prod.values?.[unitCol.id] || 'adet') : 'adet',
          desc: it.machine_year ? 'Model: ' + it.machine_year : '',
          category: cat,
          prodValues: prod?.values || {},
          rawItem: it
        });
      });
    });
    
    const firmName = firm?.name || '';
    const title = firmName ? firmName + ' — ' + machine.machine_name : machine.machine_name;
    const capacityStr = machine.capacity ? ` [Kapasite: ${machine.capacity}]` : '';
    const dateStr = new Date().toLocaleDateString('tr-TR', {day:'2-digit',month:'2-digit',year:'numeric'});
    
    const defaultHeaders = bomCols.map(c => c.name);
    const extraHeaders = [];
    for (let i = 0; i < extraColCount; i++) extraHeaders.push('Ek ' + (i + 1));
    const allHeaders = [...defaultHeaders, ...extraHeaders];
    const totalColCount = allHeaders.length;
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    
    const rowsHtml = items.map(it => {
      if (it.isCategory) {
        return '<tr class="cat-row-tr"><td colspan="' + totalColCount + '" class="category-header-cell" contenteditable="true">' + esc(it.categoryName) + '</td></tr>';
      }
      const cells = bomCols.map(c => {
        const cn = c.name.toLowerCase();
        const mf = c.mapped_field || '';
        
        if (mf) {
          if (mf.startsWith('col_')) {
            const colId = mf.replace('col_', '');
            return '<td contenteditable="true">' + esc(it.prodValues[colId] || '—') + '</td>';
          }
          if (mf === 'auto_no' || mf === 'no') return '<td class="no-col" contenteditable="true">' + it.no + '</td>';
          if (mf === 'auto_name' || mf === 'name') return '<td contenteditable="true">' + esc(it.name) + '</td>';
          if (mf === 'auto_qty' || mf === 'qty') return '<td class="qty-col" contenteditable="true">' + it.qty + '</td>';
          if (mf === 'auto_unit' || mf === 'unit') return '<td contenteditable="true">' + esc(it.unit) + '</td>';
          if (mf === 'auto_desc' || mf === 'notes') return '<td class="desc-cell" contenteditable="true">' + esc(it.desc) + '</td>';
          if (mf === 'machine_year') return '<td class="year-cell" contenteditable="true">' + esc(it.rawItem?.machine_year || '—') + '</td>';
          if (mf === 'category') return '<td class="cat-name-cell" contenteditable="true">' + esc(it.category || '—') + '</td>';
        }

        if (cn.includes('sıra') || cn === 'no') return '<td class="no-col" contenteditable="true">' + it.no + '</td>';
        if (cn.includes('kategori')) return '<td class="cat-name-cell" contenteditable="true">' + esc(it.category || '—') + '</td>';
        if (cn.includes('malzeme') || cn.includes('ürün') || cn.includes('ad')) return '<td contenteditable="true">' + esc(it.name) + '</td>';
        if (cn.includes('miktar') || cn.includes('adet')) return '<td class="qty-col" contenteditable="true">' + it.qty + '</td>';
        if (cn.includes('birim')) return '<td contenteditable="true">' + esc(it.unit) + '</td>';
        if (cn.includes('açıklama') || cn.includes('not')) return '<td class="desc-cell" contenteditable="true">' + esc(it.desc) + '</td>';
        if (cn.includes('yıl') || cn.includes('model')) return '<td class="year-cell" contenteditable="true">' + esc(it.rawItem?.machine_year || '—') + '</td>';
        
        const matchedCol = cols.find(col => col.name.toLowerCase() === cn);
        if (matchedCol && it.prodValues[matchedCol.id] !== undefined && it.prodValues[matchedCol.id] !== '') {
          return '<td contenteditable="true">' + esc(it.prodValues[matchedCol.id]) + '</td>';
        }

        return '<td contenteditable="true">—</td>';
      }).join('');

      const extraCells = extraHeaders.map(() => '<td contenteditable="true">&nbsp;</td>').join('');
      return '<tr class="item-row-tr">' + cells + extraCells + '</tr>';
    }).join('\n      ');
    const itemCount = items.filter(it => !it.isCategory).length;
    const extraRowsHtml = Array.from({length: extraRowCount}, (_, i) => {
      const cells = allHeaders.map((h, j) => j === 0 ? '<td class="no-col" contenteditable="true">' + (itemCount + i + 1) + '</td>' : '<td contenteditable="true">&nbsp;</td>').join('');
      return '<tr class="item-row-tr">' + cells + '</tr>';
    }).join('\n      ');

    res.send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8">
<title>BOM — ${esc(title)}</title>
<style>
@page{size:A4 ${orientation};margin:8mm 10mm}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#1a1a1a;background:#fff}
.page{max-width:1100px;margin:0 auto;padding:10mm 0}
.header{display:flex;align-items:center;gap:16px;margin-bottom:12px;padding-bottom:8px;border-bottom:2.5px solid #1a6b56}
.logo{height:42px;width:auto}.header-info{flex:1}
.header-title{font-size:16px;font-weight:800;color:#1a1a1a;letter-spacing:-.02em;outline:none}
.header-sub{font-size:10px;color:#666;margin-top:2px;outline:none}
.header-date{font-size:10px;color:#888;text-align:right;white-space:nowrap}
table{width:100%;border-collapse:collapse;margin-top:6px;font-size:10.5px}
th{background:#1a6b56;color:#fff;padding:6px 8px;text-align:left;font-weight:700;font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;border:1px solid #157a5e}
td{padding:5px 8px;border:1px solid #d0d0d0;vertical-align:middle;outline:none}
td:focus{background:#fff8dc;box-shadow:inset 0 0 0 1px #1a6b56}
tr:nth-child(even){background:#f7f9f8}tr:hover{background:#e8f5f0}
.category-header-cell{background:#e8f5f0!important;font-weight:800;font-size:11px;padding:6px 10px;border:1px solid #1a6b56;color:#1a6b56}
.no-col{width:36px;text-align:center;font-weight:700;color:#888}
.qty-col{text-align:center;font-weight:700}
.summary-bar{display:flex;justify-content:space-between;align-items:center;background:#f0f5f3;border:1px solid #c2ded6;padding:6px 12px;border-radius:4px;margin-top:8px;font-weight:700;font-size:10px;color:#1a6b56}
.notes{margin-top:10px;font-size:9.5px;color:#555}.notes-title{font-weight:700;margin-bottom:3px}
.notes-content{min-height:36px;border:1px solid #ddd;border-radius:4px;padding:6px;outline:none}
.notes-content:focus{background:#fff8dc}
.signature-section{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px;page-break-inside:avoid}
.sig-box{border:1px solid #c8c8c8;border-radius:6px;padding:8px 10px;background:#fafafa}
.sig-title{font-weight:800;font-size:9.5px;color:#1a6b56;text-transform:uppercase;margin-bottom:6px;border-bottom:1px solid #e0e0e0;padding-bottom:3px}
.sig-line{font-size:9px;color:#444;margin-top:4px}
.footer{margin-top:14px;display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid #ddd;font-size:9px;color:#999}
/* Kompakt Mod Stilleri */
.compact-mode table{font-size:9px}
.compact-mode th{padding:3px 5px;font-size:8.5px}
.compact-mode td{padding:2.5px 5px}
.compact-mode .header{margin-bottom:6px;padding-bottom:4px}
.compact-mode .signature-section{margin-top:8px;gap:8px}
.compact-mode .sig-box{padding:4px 6px}
/* Gizleme Sınıfları */
.hide-categories .cat-row-tr{display:none!important}
.hide-years .year-cell{display:none!important}
.hide-desc .desc-cell{display:none!important}
@media print{
  body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .no-print{display:none!important}
  .page{padding:0;max-width:100%}
  td:focus{background:transparent!important;box-shadow:none!important}
}
.print-bar{background:#1a6b56;color:#fff;padding:8px 16px;display:flex;align-items:center;gap:10px;font-size:12px;position:sticky;top:0;z-index:100;flex-wrap:wrap}
.print-bar button{background:#fff;color:#1a6b56;border:none;padding:5px 12px;border-radius:6px;font-weight:700;cursor:pointer;font-size:11.5px}
.print-bar button:hover{background:#e8f5f0}
.print-bar label{font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer}
.print-bar input[type="number"]{padding:3px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.15);color:#fff;font-size:11px;width:45px}
</style></head><body>
<div class="print-bar no-print">
  <span>📄 BOM Çıktı & Önizleme</span>
  <button onclick="window.print()">🖨️ Yazdır / PDF</button>
  <button onclick="exportToExcel('${esc(title)}')">📊 Excel İndir</button>
  <button onclick="toggleOrient()">${orientation === 'portrait' ? '↔️ Yatay' : '↕️ Dikey'}</button>
  <button onclick="toggleCompact()">🔍 Kompakt Mod</button>
  <button onclick="recalcNumbers()">🔢 Sıra No Yenile</button>
  <label><input type="checkbox" onchange="toggleVis('hide-categories', this.checked)"> Kat. Gizle</label>
  <label><input type="checkbox" onchange="toggleVis('hide-years', this.checked)"> Yıl Gizle</label>
  <label><input type="checkbox" onchange="toggleVis('hide-desc', this.checked)"> Not Gizle</label>
  <label>Ekstra Satır: <input type="number" id="erInput" value="${extraRowCount}" min="0" max="50" onchange="reloadBOM()"></label>
  <label>Ekstra Sütun: <input type="number" id="ecInput" value="${extraColCount}" min="0" max="10" onchange="reloadBOM()"></label>
  <button onclick="window.close()" style="margin-left:auto;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3)">✕ Kapat</button>
</div>
<div class="page" id="bomPageArea">
  <div class="header">
    <img src="/logo.png" class="logo" alt="Logo" onerror="this.style.display='none'">
    <div class="header-info">
      <div class="header-title" contenteditable="true">${esc(title)}${esc(capacityStr)}</div>
      <div class="header-sub" contenteditable="true">Malzeme Listesi (BOM)${machine.notes ? ' — ' + esc(machine.notes) : ''}</div>
    </div>
    <div class="header-date">
      <div style="font-weight:700">${dateStr}</div>
      <div id="topHeaderStats">Toplam: ${itemCount} Kalem</div>
    </div>
  </div>
  <table id="bomMainTable">
    <thead><tr>${allHeaders.map(h => '<th>' + esc(h) + '</th>').join('')}</tr></thead>
    <tbody>${rowsHtml}${extraRowsHtml}</tbody>
  </table>
  <div class="summary-bar">
    <span>📊 Reçete Özeti</span>
    <span id="summaryText">Toplam: ${itemCount} Kalem Malzeme | Toplam Adet: ${totalQuantityCount}</span>
  </div>
  <div class="notes">
    <div class="notes-title">Notlar:</div>
    <div class="notes-content" contenteditable="true"></div>
  </div>
  <div class="signature-section">
    <div class="sig-box">
      <div class="sig-title">HAZIRLAYAN (ELEKTRİK / PROJE)</div>
      <div class="sig-line" contenteditable="true">Ad Soyad: </div>
      <div class="sig-line" contenteditable="true">İmza: </div>
      <div class="sig-line">Tarih: ${dateStr}</div>
    </div>
    <div class="sig-box">
      <div class="sig-title">KONTROL EDEN (ATÖLYE ŞEFİ)</div>
      <div class="sig-line" contenteditable="true">Ad Soyad: </div>
      <div class="sig-line" contenteditable="true">İmza: </div>
      <div class="sig-line">Tarih: </div>
    </div>
    <div class="sig-box">
      <div class="sig-title">ONAY / TESLİM ALAN (YETKİLİ)</div>
      <div class="sig-line" contenteditable="true">Ad Soyad: </div>
      <div class="sig-line" contenteditable="true">İmza: </div>
      <div class="sig-line">Tarih: </div>
    </div>
  </div>
  <div class="footer"><span>⚡ Elektrikhane Stok Takip Sistemi</span><span>Oluşturulma: ${dateStr}</span></div>
</div>
<script>
function reloadBOM(){
  var er=document.getElementById('erInput').value||0;
  var ec=document.getElementById('ecInput').value||0;
  var u=new URL(window.location);
  u.searchParams.set('extra_rows',er);
  u.searchParams.set('extra_cols',ec);
  window.location.href=u.toString();
}
function toggleOrient(){
  var u=new URL(window.location);
  var cur = u.searchParams.get('orientation') || '${orientation}';
  u.searchParams.set('orientation', cur === 'portrait' ? 'landscape' : 'portrait');
  window.location.href=u.toString();
}
function toggleCompact(){
  document.body.classList.toggle('compact-mode');
}
function toggleVis(className, isHidden){
  if(isHidden) document.body.classList.add(className);
  else document.body.classList.remove(className);
}
function recalcNumbers(){
  var rows = document.querySelectorAll('#bomMainTable tbody tr.item-row-tr');
  var idx = 1;
  var totalQty = 0;
  rows.forEach(function(r){
    var noCell = r.querySelector('.no-col');
    if(noCell) { noCell.textContent = idx++; }
    var qtyCell = r.querySelector('.qty-col');
    if(qtyCell) {
      var q = parseFloat(qtyCell.textContent.trim()) || 0;
      totalQty += q;
    }
  });
  document.getElementById('summaryText').textContent = 'Toplam: ' + (idx - 1) + ' Kalem Malzeme | Toplam Adet: ' + totalQty;
  document.getElementById('topHeaderStats').textContent = 'Toplam: ' + (idx - 1) + ' Kalem';
}
function exportToExcel(filename){
  var title = document.querySelector('.header-title').innerText;
  var sub = document.querySelector('.header-sub').innerText;
  var dateStr = document.querySelector('.header-date').innerText.replace(/\\n/g, ' - ');
  var table = document.getElementById('bomMainTable').cloneNode(true);
  var summary = document.getElementById('summaryText').innerText;
  var notes = document.querySelector('.notes-content').innerText;
  var thCount = table.querySelectorAll('th').length || 5;

  var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
  html += '<head><meta charset="utf-8">';
  html += '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>BOM Reçetesi</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->';
  html += '<style>';
  html += 'body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11pt; }';
  html += 'table { border-collapse: collapse; width: 100%; }';
  html += 'th { background-color: #1a6b56; color: #ffffff; font-weight: bold; border: 1pt solid #157a5e; padding: 8px; text-align: left; font-size: 11pt; }';
  html += 'td { border: 1pt solid #d0d0d0; padding: 6px 8px; vertical-align: middle; }';
  html += '.category-header-cell { background-color: #e8f5f0; color: #1a6b56; font-weight: bold; font-size: 12pt; border: 1.5pt solid #1a6b56; padding: 8px; }';
  html += '.no-col { text-align: center; font-weight: bold; color: #555555; }';
  html += '.qty-col { text-align: center; font-weight: bold; }';
  html += '.title-cell { font-size: 16pt; font-weight: bold; color: #1a6b56; }';
  html += '.sub-cell { font-size: 11pt; color: #555555; }';
  html += '.summary-cell { background-color: #f0f5f3; color: #1a6b56; font-weight: bold; font-size: 11pt; border: 1pt solid #c2ded6; padding: 8px; }';
  html += '.notes-header { font-weight: bold; color: #333333; }';
  html += '.notes-box { border: 1pt solid #cccccc; padding: 8px; background-color: #ffffff; }';
  html += '.sig-header { background-color: #e8f5f0; color: #1a6b56; font-weight: bold; border: 1pt solid #1a6b56; text-align: center; padding: 6px; font-size: 10pt; }';
  html += '.sig-content { border: 1pt solid #cccccc; padding: 10px; height: 60pt; vertical-align: top; font-size: 9pt; }';
  html += '</style></head><body>';
  
  html += '<table style="margin-bottom: 12px;">';
  html += '<tr><td colspan="' + thCount + '" class="title-cell" style="border:none;">' + title + '</td></tr>';
  html += '<tr><td colspan="' + thCount + '" class="sub-cell" style="border:none;">' + sub + ' | ' + dateStr + '</td></tr>';
  html += '<tr><td colspan="' + thCount + '" style="border:none;">&nbsp;</td></tr>';
  html += '</table>';
  
  html += table.outerHTML;
  
  html += '<br><table><tr><td colspan="' + thCount + '" class="summary-cell">' + summary + '</td></tr></table>';
  
  if(notes && notes.trim()){
    html += '<br><table>';
    html += '<tr><td class="notes-header" style="border:none;">NOTLAR:</td></tr>';
    html += '<tr><td colspan="' + thCount + '" class="notes-box">' + notes + '</td></tr>';
    html += '</table>';
  }
  
  html += '<br><table style="margin-top: 15px;">';
  html += '<tr>';
  html += '<td style="width:33%; border:none; padding:4px;"><table style="width:100%"><tr><td class="sig-header">HAZIRLAYAN (ELEKTRİK/PROJE)</td></tr><tr><td class="sig-content">Ad Soyad:<br><br>İmza:<br><br>Tarih: ' + (new Date().toLocaleDateString("tr-TR")) + '</td></tr></table></td>';
  html += '<td style="width:33%; border:none; padding:4px;"><table style="width:100%"><tr><td class="sig-header">KONTROL EDEN (ATÖLYE ŞEFİ)</td></tr><tr><td class="sig-content">Ad Soyad:<br><br>İmza:<br><br>Tarih:</td></tr></table></td>';
  html += '<td style="width:33%; border:none; padding:4px;"><table style="width:100%"><tr><td class="sig-header">ONAY / TESLİM ALAN (YETKİLİ)</td></tr><tr><td class="sig-content">Ad Soyad:<br><br>İmza:<br><br>Tarih:</td></tr></table></td>';
  html += '</tr></table>';
  
  html += '</body></html>';
  
  var blob = new Blob(['\\uFEFF' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = (filename || 'BOM-Listesi').replace(/[/\\\\?%*:|"<>]/g, '-') + '.xls';
  link.click();
}
</script>
</body></html>`);
  } catch(e) { console.error('BOM error:', e.message); res.status(500).send('BOM hatası: ' + e.message); }
});

// ── LOT YÖNETİMİ ─────────────────────────────────────────────────────────
app.get('/api/products/:id/lots', auth, async (req, res) => {
  try {
    const rows = (await query('SELECT * FROM product_lots WHERE product_id=$1 ORDER BY production_year ASC', [req.params.id])).rows;
    res.json(rows);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/lots/counts', auth, async (req, res) => {
  try {
    const rows = (await query('SELECT product_id, COUNT(*) as cnt FROM product_lots WHERE quantity>0 GROUP BY product_id')).rows;
    const m = {};
    rows.forEach(r => { m[r.product_id] = parseInt(r.cnt); });
    res.json(m);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/products/:id/lots', auth, admin, async (req, res) => {
  try {
    const { production_year, quantity, notes } = req.body;
    if (!production_year) return res.status(400).json({error: 'Yıl zorunlu'});
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty < 0) return res.status(400).json({error: 'Geçersiz adet'});

    const existing = (await query(
      'SELECT id FROM product_lots WHERE product_id=$1 AND production_year=$2',
      [req.params.id, parseInt(production_year)]
    )).rows[0];
    if (existing) {
      await query('UPDATE product_lots SET quantity=$1, notes=$2 WHERE id=$3',
        [qty, notes || '', existing.id]);
    } else {
      await query('INSERT INTO product_lots(product_id, production_year, quantity, notes) VALUES($1,$2,$3,$4)',
        [req.params.id, parseInt(production_year), qty, notes || '']);
    }

    await syncLotTotal(req.params.id);
    await logActivity(req.user.id, 'Model Yılı (Lot) Güncellendi', 'product_lot', parseInt(req.params.id), { production_year, quantity: qty, notes }, req);
    broadcast('stock_update', {});
    res.json({ok: true});
  } catch(e) {
    console.error('lot POST error:', e.message);
    res.status(500).json({error: e.message});
  }
});

app.delete('/api/lots/:id', auth, admin, async (req, res) => {
  try {
    const lot = (await query('SELECT product_id FROM product_lots WHERE id=$1', [req.params.id])).rows[0];
    if (!lot) return res.status(404).json({error: 'Bulunamadı'});
    await query('DELETE FROM product_lots WHERE id=$1', [req.params.id]);
    await syncLotTotal(lot.product_id);
    await logActivity(req.user.id, 'Model Yılı (Lot) Silindi', 'product_lot', parseInt(req.params.id), { product_id: lot.product_id }, req);
    broadcast('stock_update', {});
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

async function syncLotTotal(pid) {
  try {
    const numCol = await getNumCol();
    if (!numCol) return;
    const total = parseFloat(
      (await query('SELECT COALESCE(SUM(quantity), 0) as t FROM product_lots WHERE product_id=$1', [pid])).rows[0].t
    );
    const prod = (await query('SELECT "values" FROM products WHERE id=$1', [pid])).rows[0];
    if (!prod) return;
    const vals = { ...(prod.values || {}), [numCol.id]: String(total) };
    await query('UPDATE products SET "values"=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(vals), pid]);
  } catch(e) {
    console.error('syncLotTotal error:', e.message);
  }
}

async function deductFromLots(pid, qty) {
  const lots = (await query(
    'SELECT * FROM product_lots WHERE product_id=$1 AND quantity>0 ORDER BY production_year ASC', [pid]
  )).rows;
  let rem = qty;
  for (const l of lots) {
    if (rem <= 0) break;
    const take = Math.min(parseFloat(l.quantity), rem);
    await query('UPDATE product_lots SET quantity = quantity - $1 WHERE id=$2', [take, l.id]);
    rem -= take;
  }
  await syncLotTotal(pid);
}

async function restoreToLots(pid, qty) {
  const l = (await query(
    'SELECT * FROM product_lots WHERE product_id=$1 ORDER BY production_year DESC LIMIT 1', [pid]
  )).rows[0];
  if (l) {
    await query('UPDATE product_lots SET quantity = quantity + $1 WHERE id=$2', [qty, l.id]);
    await syncLotTotal(pid);
  }
}

// ── Bildirim helper ───────────────────────────────────────────
async function createNotif(uid,title,body,type){
  try{await query("INSERT INTO notifications(user_id,title,body,type)VALUES($1,$2,$3,$4)",[uid,title,body||'',type||'info']);broadcast('notif_new',{user_id:uid});}catch(e){}
}
app.get('/api/notifications',auth,async(req,res)=>{
  try{res.json((await query("SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",[req.user.id])).rows);}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/notifications/:id/read',auth,async(req,res)=>{
  try{await query("UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/notifications/read-all',auth,async(req,res)=>{
  try{await query("UPDATE notifications SET is_read=TRUE WHERE user_id=$1",[req.user.id]);broadcast('notif_read',{user_id:req.user.id});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});

// ── Yorumlar ──────────────────────────────────────────────────
app.get('/api/task-stages/:id/comments',auth,async(req,res)=>{
  try{res.json((await query(`SELECT sc.*,u.display_name,u.username,u.role FROM stage_comments sc JOIN users u ON u.id=sc.user_id WHERE sc.stage_id=$1 ORDER BY sc.created_at ASC`,[req.params.id])).rows);}catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/task-stages/:id/comments',auth,async(req,res)=>{
  try{
    const{body}=req.body;
    if(!body||!body.trim())return res.status(400).json({error:'Not boş olamaz'});
    const r=(await query("INSERT INTO stage_comments(stage_id,user_id,body)VALUES($1,$2,$3)RETURNING *",[req.params.id,req.user.id,body.trim()])).rows[0];
    const stg=(await query(`SELECT ts.stage_name,ts.assigned_to,t.title FROM task_stages ts JOIN tasks t ON t.id=ts.task_id WHERE ts.id=$1`,[req.params.id])).rows[0];
    if(stg&&stg.assigned_to&&stg.assigned_to!==req.user.id)
      await createNotif(stg.assigned_to,'💬 Yeni not: '+(stg.title||''),(req.user.display_name||req.user.username)+': '+body.trim().slice(0,80),'comment');
    broadcast('comment_new',{stage_id:req.params.id});res.json(r);
  }catch(e){res.status(500).json({error:e.message});}
});

// ── Satın Alma (Rol Bazlı Akış: Admin & Purchase) ─────────────
app.get('/api/purchase-requests', auth, async (req, res) => {
  try {
    const isManager = req.user.role === 'admin' || req.user.role === 'purchase';
    res.json((await query(
      isManager
        ? `SELECT pr.*, u.display_name as requester_name, t.title as task_title FROM purchase_requests pr JOIN users u ON u.id=pr.requested_by LEFT JOIN tasks t ON t.id=pr.task_id ORDER BY CASE pr.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 WHEN 'ordered' THEN 3 WHEN 'shipping' THEN 4 ELSE 5 END, pr.created_at DESC`
        : `SELECT pr.*, u.display_name as requester_name, t.title as task_title FROM purchase_requests pr JOIN users u ON u.id=pr.requested_by LEFT JOIN tasks t ON t.id=pr.task_id WHERE pr.requested_by=$1 ORDER BY pr.created_at DESC`,
      isManager ? [] : [req.user.id]
    )).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/purchase-requests', auth, async (req, res) => {
  try {
    const { product_name, quantity, unit, reason, task_id, product_values, status } = req.body;
    if (!product_name || !product_name.trim()) return res.status(400).json({ error: 'Ürün adı zorunlu' });
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'Geçerli miktar girin' });

    // Yönetici doğrudan onaylı (approved) olarak açabilir, personel için pending başlar
    const initialStatus = (req.user.role === 'admin' && status) ? status : (req.user.role === 'admin' ? 'approved' : 'pending');

    const r = (await query(
      `INSERT INTO purchase_requests(requested_by, product_name, quantity, unit, reason, task_id, product_values, status)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.id, product_name.trim(), qty, unit || 'adet', reason || '', task_id || null, JSON.stringify(product_values || {}), initialStatus]
    )).rows[0];

    const admins = (await query("SELECT id FROM users WHERE role='admin'")).rows;
    for (const a of admins) {
      if (a.id !== req.user.id) {
        await createNotif(a.id, '📦 Satın Alma: ' + product_name.trim(), (req.user.display_name || req.user.username) + ' talep etti', 'purchase');
      }
    }
    await logActivity(req.user.id, 'Satın Alma Talebi Açıldı', 'purchase_request', r.id, { product_name: product_name.trim(), quantity: qty, unit, status: initialStatus }, req);
    broadcast('purchase_new', {});
    res.json(r);
  } catch(e) {
    console.error('purchase POST:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Yönetici Talebi Düzenleme Endpoint'i (Ürün adı, miktar, birim, iş, stok detayları)
app.put('/api/purchase-requests/:id', auth, admin, async (req, res) => {
  try {
    const { product_name, quantity, unit, reason, task_id, product_values, status, admin_note } = req.body;
    const pr = (await query("SELECT * FROM purchase_requests WHERE id=$1", [req.params.id])).rows[0];
    if (!pr) return res.status(404).json({ error: 'Talep bulunamadı' });

    await query(
      `UPDATE purchase_requests 
       SET product_name=$1, quantity=$2, unit=$3, reason=$4, task_id=$5, product_values=$6, status=$7, admin_note=$8, updated_at=NOW() 
       WHERE id=$9`,
      [
        product_name ? product_name.trim() : pr.product_name,
        quantity !== undefined ? parseFloat(quantity) : pr.quantity,
        unit || pr.unit,
        reason !== undefined ? reason : pr.reason,
        task_id !== undefined ? (task_id || null) : pr.task_id,
        product_values ? JSON.stringify(product_values) : (pr.product_values || '{}'),
        status || pr.status,
        admin_note !== undefined ? admin_note : pr.admin_note,
        req.params.id
      ]
    );

    await logActivity(req.user.id, 'Satın Alma Talebi Düzenlendi', 'purchase_request', parseInt(req.params.id), { product_name, quantity }, req);
    broadcast('purchase_new', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/purchase-requests/:id/status', auth, async (req, res) => {
  try {
    const { status, admin_note } = req.body;
    const pr = (await query("SELECT * FROM purchase_requests WHERE id=$1", [req.params.id])).rows[0];
    if (!pr) return res.status(404).json({ error: 'Bulunamadı' });

    if ((status === 'approved' || status === 'rejected') && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Bu durum değişikliği için yönetici yetkisi gerekli' });
    }
    if ((status === 'ordered' || status === 'shipping') && req.user.role !== 'admin' && req.user.role !== 'purchase') {
      return res.status(403).json({ error: 'Tedarik yetkisi gerekli' });
    }

    await query("UPDATE purchase_requests SET status=$1, admin_note=$2, updated_at=NOW() WHERE id=$3", [status, admin_note || '', req.params.id]);
    const labels = { approved: '✅ Onaylandı', rejected: '❌ Reddedildi', ordered: '🚚 Sipariş Verildi', shipping: '🚢 Sevkiyatta (Yolda)', received: '📦 Teslim Alındı' };
    if (labels[status]) await createNotif(pr.requested_by, 'Satın Alma: ' + labels[status], pr.product_name + (admin_note ? ' — ' + admin_note : ''), 'purchase');
    await logActivity(req.user.id, 'Satın Alma Durumu Güncellendi: ' + status, 'purchase_request', parseInt(req.params.id), { status, admin_note }, req);
    broadcast('purchase_new', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/purchase-requests/:id', auth, admin, async (req, res) => {
  try {
    await query("DELETE FROM purchase_requests WHERE id=$1", [req.params.id]);
    await logActivity(req.user.id, 'Satın Alma Talebi Silindi', 'purchase_request', parseInt(req.params.id), {}, req);
    broadcast('purchase_new', {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/users/change-password',auth,async(req,res)=>{
  try{
    const{current_password,new_password}=req.body;
    if(!current_password||!new_password)return res.status(400).json({error:'Şifreler zorunlu'});
    if(new_password.length<4)return res.status(400).json({error:'En az 4 karakter'});
    const user=(await query("SELECT * FROM users WHERE id=$1",[req.user.id])).rows[0];
    if(!user||!bcrypt.compareSync(current_password,user.password_hash))return res.status(401).json({error:'Mevcut şifre yanlış'});
    await query("UPDATE users SET password_hash=$1 WHERE id=$2",[bcrypt.hashSync(new_password,10),req.user.id]);
    await logActivity(req.user.id, 'Şifre Değiştirildi', 'user', req.user.id, {}, req);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
    console.log('✓ Varsayılan veriler — admin / admin123');
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`🏭 Stok Takip → http://localhost:${PORT}`));
}
start().catch(err => { console.error('Hata:', err); process.exit(1); });
