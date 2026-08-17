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
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key_123';

// Güvenlik Middleware'leri
app.use(helmet({
  contentSecurityPolicy: false // Statik paneller için basitlik sağlar
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiting (Kaba kuvvet saldırılarını engelleme)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.' }
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

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunludur.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());

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
    sameSite: 'strict'
  });

  res.json({
    message: 'Giriş başarılı',
    user: { id: user.id, username: user.username, role: user.role }
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Çıkış yapıldı.' });
});

app.get('/api/auth/me', authenticateToken(), (req, res) => {
  res.json({ user: req.user });
});

// ====================== ÜRÜN & STOK API ======================

// Ürün Listesi (Sayfalama ve Arama Destekli)
app.get('/api/products', authenticateToken(), (req, res) => {
  const search = req.query.search ? `%${req.query.search.trim()}%` : '%';
  const onlyCritical = req.query.critical === 'true';

  let query = `
    SELECT id, code, name, category, stock, min_stock, unit, updated_at 
    FROM products 
    WHERE is_deleted = 0 AND (name LIKE ? OR code LIKE ? OR category LIKE ?)
  `;

  if (onlyCritical) {
    query += ' AND stock <= min_stock';
  }

  query += ' ORDER BY name ASC';

  try {
    const products = db.prepare(query).all(search, search, search);
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: 'Ürünler getirilirken hata oluştu.' });
  }
});

// Yeni Ürün Ekleme (Sadece Admin)
app.post('/api/products', authenticateToken('admin'), (req, res) => {
  const { code, name, category, stock, min_stock, unit } = req.body;

  if (!code || !name || stock === undefined || stock === null) {
    return res.status(400).json({ error: 'Ürün kodu, ürün adı ve stok miktarı zorunludur.' });
  }

  const initialStock = parseInt(stock, 10);
  const minStockVal = parseInt(min_stock, 10) || 5;

  if (isNaN(initialStock) || initialStock < 0 || isNaN(minStockVal) || minStockVal < 0) {
    return res.status(400).json({ error: 'Stok değerleri negatif olamaz.' });
  }

  const insertTx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO products (code, name, category, stock, min_stock, unit)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(code.trim(), name.trim(), category ? category.trim() : 'Genel', initialStock, minStockVal, unit || 'Adet');

    if (initialStock > 0) {
      db.prepare(`
        INSERT INTO stock_logs (product_id, user_id, action_type, quantity, previous_stock, new_stock, note)
        VALUES (?, ?, 'IN', ?, 0, ?, 'İlk Giriş / Başlangıç Stoğu')
      `).run(info.lastInsertRowid, req.user.id, initialStock, initialStock);
    }

    return info.lastInsertRowid;
  });

  try {
    const newId = insertTx();
    res.status(201).json({ message: 'Ürün başarıyla eklendi.', productId: newId });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Bu ürün kodu zaten mevcut.' });
    }
    res.status(500).json({ error: 'Ürün eklenirken veritabanı hatası oluştu.' });
  }
});

// Ürün Güncelleme (Sadece Admin)
app.put('/api/products/:id', authenticateToken('admin'), (req, res) => {
  const { name, category, min_stock, unit } = req.body;
  const productId = req.params.id;

  try {
    const stmt = db.prepare(`
      UPDATE products 
      SET name = ?, category = ?, min_stock = ?, unit = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND is_deleted = 0
    `);
    const result = stmt.run(name.trim(), category.trim(), parseInt(min_stock, 10), unit.trim(), productId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Ürün bulunamadı.' });
    }

    res.json({ message: 'Ürün başarıyla güncellendi.' });
  } catch (err) {
    res.status(500).json({ error: 'Güncelleme hatası.' });
  }
});

// Ürün Silme (Soft Delete - Sadece Admin)
app.delete('/api/products/:id', authenticateToken('admin'), (req, res) => {
  const productId = req.params.id;

  try {
    const stmt = db.prepare(`UPDATE products SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    const result = stmt.run(productId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Ürün bulunamadı.' });
    }

    res.json({ message: 'Ürün başarıyla silindi.' });
  } catch (err) {
    res.status(500).json({ error: 'Ürün silinemedi.' });
  }
});

// Atomik Stok Hareketi (Giriş / Çıkış)
app.post('/api/stock/transaction', authenticateToken(), (req, res) => {
  const { product_id, action_type, quantity, note } = req.body;
  const qty = parseInt(quantity, 10);

  if (!product_id || !action_type || isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Geçersiz ürün veya miktar.' });
  }

  if (!['IN', 'OUT'].includes(action_type)) {
    return res.status(400).json({ error: 'İşlem tipi IN veya OUT olmalıdır.' });
  }

  // Atomik Transaction: Eşzamanlı yarış durumlarını (Race Condition) önler
  const executeStockChange = db.transaction(() => {
    const product = db.prepare('SELECT id, stock FROM products WHERE id = ? AND is_deleted = 0').get(product_id);

    if (!product) {
      throw new Error('NOT_FOUND');
    }

    if (action_type === 'OUT' && product.stock < qty) {
      throw new Error('INSUFFICIENT_STOCK');
    }

    const newStock = action_type === 'IN' ? product.stock + qty : product.stock - qty;

    // Koşullu atomik update
    const updateStmt = db.prepare(`
      UPDATE products 
      SET stock = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND stock = ?
    `);

    const updateRes = updateStmt.run(newStock, product.id, product.stock);
    if (updateRes.changes === 0) {
      throw new Error('RACE_CONDITION_RETRY');
    }

    db.prepare(`
      INSERT INTO stock_logs (product_id, user_id, action_type, quantity, previous_stock, new_stock, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(product.id, req.user.id, action_type, qty, product.stock, newStock, note ? note.trim() : null);

    return { previous_stock: product.stock, new_stock: newStock };
  });

  try {
    const result = executeStockChange();
    res.json({ message: 'Stok hareketi başarıyla işlendi.', result });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Ürün bulunamadı.' });
    }
    if (err.message === 'INSUFFICIENT_STOCK') {
      return res.status(400).json({ error: 'Yetersiz stok! Mevcut stoktan fazla çıkış yapılamaz.' });
    }
    if (err.message === 'RACE_CONDITION_RETRY') {
      return res.status(409).json({ error: 'Aynı anda başka bir işlem yapıldı, lütfen tekrar deneyin.' });
    }
    res.status(500).json({ error: 'İşlem sırasında sunucu hatası oluştu.' });
  }
});

// Stok Hareket Kayıtları (Audit Logs - Sadece Admin)
app.get('/api/logs', authenticateToken('admin'), (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT l.id, p.name as product_name, p.code as product_code, u.username, 
             l.action_type, l.quantity, l.previous_stock, l.new_stock, l.note, l.created_at
      FROM stock_logs l
      JOIN products p ON l.product_id = p.id
      JOIN users u ON l.user_id = u.id
      ORDER BY l.created_at DESC
      LIMIT 100
    `).all();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Hareket geçmişi alınamadı.' });
  }
});

// Global Hata Yakalama Middleware'i
app.use((err, req, res, next) => {
  console.error('[Error]:', err.stack);
  res.status(500).json({ error: 'Beklenmeyen bir sunucu hatası oluştu.' });
});

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` Sunucu http://localhost:${PORT} üzerinde aktif`);
  console.log(`=========================================`);
});
