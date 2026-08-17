require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stok_takip_jwt_super_secret_key_2026';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Çok fazla giriş denemesi yapıldı. Lütfen 15 dakika sonra tekrar deneyin.' }
});

const authenticateToken = (requiredRole = null) => {
  return (req, res, next) => {
    const token = req.cookies.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);

    if (!token) {
      return res.status(401).json({ error: 'Oturum açmanız gerekiyor.' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Geçersiz veya süresi dolmuş oturum.' });
      }

      if (requiredRole && decoded.role !== requiredRole) {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz bulunmuyor.' });
      }

      req.user = decoded;
      next();
    });
  };
};

// ====================== AUTH ENDPOINTS ======================

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunludur.' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    let isMatch = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
      isMatch = bcrypt.compareSync(password, user.password);
    } else {
      isMatch = (user.password === password);
      if (isMatch) {
        const newHash = bcrypt.hashSync(password, 10);
        await db.query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id]);
      }
    }

    if (!isMatch) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
      sameSite: 'lax'
    });

    res.json({
      message: 'Giriş başarılı',
      user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name }
    });
  } catch (err) {
    res.status(500).json({ error: 'Giriş sırasında sunucu hatası oluştu.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Çıkış yapıldı.' });
});

app.get('/api/auth/me', authenticateToken(), (req, res) => {
  res.json({ user: req.user });
});

// ====================== İSTATİSTİKLER ======================

app.get('/api/stats', authenticateToken('admin'), async (req, res) => {
  try {
    const totalProd = await db.query('SELECT COUNT(*) FROM products WHERE is_deleted = 0');
    const criticalProd = await db.query('SELECT COUNT(*) FROM products WHERE is_deleted = 0 AND stock <= min_stock');
    const activeJobs = await db.query("SELECT COUNT(*) FROM job_orders WHERE status IN ('Beklemede', 'Devam Ediyor')");
    const todayLogs = await db.query("SELECT COUNT(*) FROM stock_logs WHERE created_at >= CURRENT_DATE");

    res.json({
      totalProducts: parseInt(totalProd.rows[0].count, 10),
      criticalProducts: parseInt(criticalProd.rows[0].count, 10),
      activeJobs: parseInt(activeJobs.rows[0].count, 10),
      todayLogs: parseInt(todayLogs.rows[0].count, 10)
    });
  } catch (err) {
    res.status(500).json({ error: 'İstatistikler alınamadı.' });
  }
});

// ====================== ÜRÜNLER / MALZEMELER ======================

app.get('/api/products', authenticateToken(), async (req, res) => {
  const search = req.query.search ? `%${req.query.search.trim()}%` : '%';
  const category = req.query.category || '';
  const onlyCritical = req.query.critical === 'true';

  let queryText = `
    SELECT id, code, name, category, stock, min_stock, unit, shelf_location, updated_at 
    FROM products 
    WHERE is_deleted = 0 AND (name ILIKE $1 OR code ILIKE $1 OR shelf_location ILIKE $1)
  `;
  const params = [search];

  if (category) {
    params.push(category);
    queryText += ` AND category = $${params.length}`;
  }

  if (onlyCritical) {
    queryText += ' AND stock <= min_stock';
  }

  queryText += ' ORDER BY name ASC';

  try {
    const result = await db.query(queryText, params);
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Ürün listesi yüklenemedi.' });
  }
});

app.post('/api/products', authenticateToken('admin'), async (req, res) => {
  const { code, name, category, stock, min_stock, unit, shelf_location } = req.body;
  if (!code || !name) {
    return res.status(400).json({ error: 'Ürün kodu ve ürün adı zorunludur.' });
  }

  const initialStock = parseInt(stock, 10) || 0;
  const minStockVal = parseInt(min_stock, 10) || 5;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const insertRes = await client.query(
      `INSERT INTO products (code, name, category, stock, min_stock, unit, shelf_location)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [code.trim(), name.trim(), category || 'Genel', initialStock, minStockVal, unit || 'Adet', shelf_location || '-']
    );

    const newId = insertRes.rows[0].id;

    if (initialStock > 0) {
      await client.query(
        `INSERT INTO stock_logs (product_id, user_id, action_type, quantity, previous_stock, new_stock, note)
         VALUES ($1, $2, 'IN', $3, 0, $3, 'İlk Giriş / Başlangıç Stoğu')`,
        [newId, req.user.id, initialStock]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Ürün başarıyla kaydedildi.', id: newId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'Bu ürün kodu zaten kayıtlı.' });
    res.status(500).json({ error: 'Ürün kaydedilemedi.' });
  } finally {
    client.release();
  }
});

app.put('/api/products/:id', authenticateToken('admin'), async (req, res) => {
  const { name, category, min_stock, unit, shelf_location } = req.body;
  try {
    const result = await db.query(
      `UPDATE products 
       SET name = $1, category = $2, min_stock = $3, unit = $4, shelf_location = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND is_deleted = 0`,
      [name.trim(), category.trim(), parseInt(min_stock, 10) || 5, unit.trim(), (shelf_location || '-').trim(), req.params.id]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: 'Ürün bulunamadı.' });
    res.json({ message: 'Ürün başarıyla güncellendi.' });
  } catch (err) {
    res.status(500).json({ error: 'Güncelleme işlemi başarısız.' });
  }
});

app.delete('/api/products/:id', authenticateToken('admin'), async (req, res) => {
  try {
    const result = await db.query('UPDATE products SET is_deleted = 1 WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Ürün bulunamadı.' });
    res.json({ message: 'Ürün silindi.' });
  } catch (err) {
    res.status(500).json({ error: 'Silme işlemi başarısız.' });
  }
});

// ====================== İŞ EMİRLERİ ======================

app.get('/api/jobs', authenticateToken(), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT j.*, u.full_name as assigned_name, u.username as assigned_username
      FROM job_orders j
      LEFT JOIN users u ON j.assigned_to = u.id
      ORDER BY j.created_at DESC
    `);
    res.json({ jobs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'İş emirleri yüklenemedi.' });
  }
});

app.post('/api/jobs', authenticateToken('admin'), async (req, res) => {
  const { job_no, title, description, customer_or_project, assigned_to, priority } = req.body;
  if (!job_no || !title) {
    return res.status(400).json({ error: 'İş emri numarası ve başlığı zorunludur.' });
  }

  try {
    const result = await db.query(
      `INSERT INTO job_orders (job_no, title, description, customer_or_project, assigned_to, priority)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [job_no.trim(), title.trim(), description || '', customer_or_project || '', assigned_to || null, priority || 'Normal']
    );
    res.status(201).json({ message: 'İş emri oluşturuldu.', job: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu iş emri numarası zaten mevcut.' });
    res.status(500).json({ error: 'İş emri kaydedilemedi.' });
  }
});

app.patch('/api/jobs/:id/status', authenticateToken(), async (req, res) => {
  const { status } = req.body;
  if (!['Beklemede', 'Devam Ediyor', 'Tamamlandı', 'İptal'].includes(status)) {
    return res.status(400).json({ error: 'Geçersiz durum değeri.' });
  }

  try {
    await db.query('UPDATE job_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, req.params.id]);
    res.json({ message: 'İş emri durumu güncellendi.' });
  } catch (err) {
    res.status(500).json({ error: 'Durum güncellenemedi.' });
  }
});

// ====================== STOK HAREKETLERİ ======================

app.post('/api/stock/transaction', authenticateToken(), async (req, res) => {
  const { product_id, action_type, quantity, job_order_id, note } = req.body;
  const qty = parseInt(quantity, 10);

  if (!product_id || !action_type || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Geçerli bir ürün ve miktar giriniz.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query(
      'SELECT id, stock, name FROM products WHERE id = $1 AND is_deleted = 0 FOR UPDATE',
      [product_id]
    );

    if (prodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ürün bulunamadı.' });
    }

    const currentStock = prodRes.rows[0].stock;

    if (action_type === 'OUT' && currentStock < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Yetersiz stok! Mevcut stok: ${currentStock}` });
    }

    const newStock = action_type === 'IN' ? currentStock + qty : currentStock - qty;

    await client.query(
      'UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newStock, product_id]
    );

    await client.query(
      `INSERT INTO stock_logs (product_id, user_id, job_order_id, action_type, quantity, previous_stock, new_stock, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [product_id, req.user.id, job_order_id || null, action_type, qty, currentStock, newStock, note || null]
    );

    await client.query('COMMIT');
    res.json({ message: 'Stok hareketi başarıyla işlendi.', previous_stock: currentStock, new_stock: newStock });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Stok hareketi işlenirken hata oluştu.' });
  } finally {
    client.release();
  }
});

app.get('/api/logs', authenticateToken('admin'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT l.*, p.name as product_name, p.code as product_code, p.unit,
             u.username, u.full_name, j.job_no, j.title as job_title
      FROM stock_logs l
      JOIN products p ON l.product_id = p.id
      JOIN users u ON l.user_id = u.id
      LEFT JOIN job_orders j ON l.job_order_id = j.id
      ORDER BY l.created_at DESC
      LIMIT 250
    `);
    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Log kayıtları alınamadı.' });
  }
});

// ====================== KULLANICILAR ======================

app.get('/api/users', authenticateToken('admin'), async (req, res) => {
  try {
    const result = await db.query('SELECT id, username, role, full_name, created_at FROM users ORDER BY id ASC');
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Kullanıcılar listelenemedi.' });
  }
});

app.post('/api/users', authenticateToken('admin'), async (req, res) => {
  const { username, password, role, full_name } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Kullanıcı adı, şifre ve rol zorunludur.' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    await db.query(
      'INSERT INTO users (username, password, role, full_name) VALUES ($1, $2, $3, $4)',
      [username.trim(), hash, role, full_name || '']
    );
    res.status(201).json({ message: 'Kullanıcı başarıyla oluşturuldu.' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu kullanıcı adı zaten kullanılıyor.' });
    res.status(500).json({ error: 'Kullanıcı eklenemedi.' });
  }
});

app.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} portunda aktif`);
});
