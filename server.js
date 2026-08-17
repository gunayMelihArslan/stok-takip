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
const JWT_SECRET = process.env.JWT_SECRET || 'secret_jwt_key_env_fallback';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  message: { error: 'Çok fazla giriş denemesi yapıldı. Lütfen daha sonra tekrar deneyin.' }
});

// Kimlik Doğrulama Middleware'i
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

// ====================== AUTH API ======================

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunludur.' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
      sameSite: 'lax'
    });

    res.json({
      message: 'Giriş başarılı',
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: 'Giriş yapılırken sunucu hatası oluştu.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Çıkış yapıldı.' });
});

app.get('/api/auth/me', authenticateToken(), (req, res) => {
  res.json({ user: req.user });
});

// ====================== ÜRÜN & STOK API ======================

// Ürün Listesi
app.get('/api/products', authenticateToken(), async (req, res) => {
  const search = req.query.search ? `%${req.query.search.trim()}%` : '%';
  const onlyCritical = req.query.critical === 'true';

  let queryText = `
    SELECT id, code, name, category, stock, min_stock, unit, updated_at 
    FROM products 
    WHERE is_deleted = 0 AND (name ILIKE $1 OR code ILIKE $1 OR category ILIKE $1)
  `;

  if (onlyCritical) {
    queryText += ' AND stock <= min_stock';
  }

  queryText += ' ORDER BY name ASC';

  try {
    const result = await db.query(queryText, [search]);
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Ürünler yüklenirken hata oluştu.' });
  }
});

// Yeni Ürün Ekle (Sadece Admin)
app.post('/api/products', authenticateToken('admin'), async (req, res) => {
  const { code, name, category, stock, min_stock, unit } = req.body;

  if (!code || !name || stock === undefined || stock === null) {
    return res.status(400).json({ error: 'Ürün kodu, ürün adı ve başlangıç stoğu zorunludur.' });
  }

  const initialStock = parseInt(stock, 10);
  const minStockVal = parseInt(min_stock, 10) || 5;

  if (isNaN(initialStock) || initialStock < 0 || isNaN(minStockVal) || minStockVal < 0) {
    return res.status(400).json({ error: 'Stok değerleri negatif olamaz.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const insertProductQuery = `
      INSERT INTO products (code, name, category, stock, min_stock, unit)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;
    const prodRes = await client.query(insertProductQuery, [
      code.trim(),
      name.trim(),
      category ? category.trim() : 'Genel',
      initialStock,
      minStockVal,
      unit || 'Adet'
    ]);

    const newProductId = prodRes.rows[0].id;

    if (initialStock > 0) {
      await client.query(
        `INSERT INTO stock_logs (product_id, user_id, action_type, quantity, previous_stock, new_stock, note)
         VALUES ($1, $2, 'IN', $3, 0, $3, 'İlk Giriş / Başlangıç Stoğu')`,
        [newProductId, req.user.id, initialStock]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Ürün başarıyla eklendi.', productId: newProductId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Bu ürün kodu zaten kayıtlı.' });
    }
    res.status(500).json({ error: 'Ürün eklenirken veritabanı hatası oluştu.' });
  } finally {
    client.release();
  }
});

// Ürün Sil (Soft Delete - Sadece Admin)
app.delete('/api/products/:id', authenticateToken('admin'), async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE products SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_deleted = 0',
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Ürün bulunamadı.' });
    }

    res.json({ message: 'Ürün başarıyla silindi.' });
  } catch (err) {
    res.status(500).json({ error: 'Ürün silinemedi.' });
  }
});

// Atomik Stok Giriş / Çıkış Hareketi
app.post('/api/stock/transaction', authenticateToken(), async (req, res) => {
  const { product_id, action_type, quantity, note } = req.body;
  const qty = parseInt(quantity, 10);

  if (!product_id || !action_type || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Geçersiz ürün veya miktar.' });
  }

  if (!['IN', 'OUT'].includes(action_type)) {
    return res.status(400).json({ error: 'İşlem türü IN veya OUT olmalıdır.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Satır kilitleme (Row-level Locking) ile eşzamanlı çakışmaları önleme
    const productRes = await client.query(
      'SELECT id, stock FROM products WHERE id = $1 AND is_deleted = 0 FOR UPDATE',
      [product_id]
    );

    if (productRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ürün bulunamadı.' });
    }

    const currentStock = productRes.rows[0].stock;

    if (action_type === 'OUT' && currentStock < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Yetersiz stok! Mevcut stok miktarından fazla çıkış yapılamaz.' });
    }

    const newStock = action_type === 'IN' ? currentStock + qty : currentStock - qty;

    await client.query(
      'UPDATE products SET stock = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newStock, product_id]
    );

    await client.query(
      `INSERT INTO stock_logs (product_id, user_id, action_type, quantity, previous_stock, new_stock, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [product_id, req.user.id, action_type, qty, currentStock, newStock, note ? note.trim() : null]
    );

    await client.query('COMMIT');
    res.json({ message: 'Stok hareketi başarıyla işlendi.', previous_stock: currentStock, new_stock: newStock });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'İşlem gerçekleştirilemedi.' });
  } finally {
    client.release();
  }
});

// Log Geçmişi (Sadece Admin)
app.get('/api/logs', authenticateToken('admin'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT l.id, p.name as product_name, p.code as product_code, u.username, 
             l.action_type, l.quantity, l.previous_stock, l.new_stock, l.note, l.created_at
      FROM stock_logs l
      JOIN products p ON l.product_id = p.id
      JOIN users u ON l.user_id = u.id
      ORDER BY l.created_at DESC
      LIMIT 100
    `);
    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Hareket geçmişi alınamadı.' });
  }
});

app.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} portunda aktif`);
});
