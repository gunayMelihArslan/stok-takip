const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const dbPath = process.env.DB_FILE || path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};

// 1. Foreign Key kısıtlamalarını ve WAL modunu aktif et
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// 2. Tablo Şemalarını Oluştur
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'personnel')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'Genel',
    stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
    min_stock INTEGER NOT NULL DEFAULT 5 CHECK(min_stock >= 0),
    unit TEXT DEFAULT 'Adet',
    is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stock_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('IN', 'OUT', 'ADJUSTMENT')),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    previous_stock INTEGER NOT NULL,
    new_stock INTEGER NOT NULL,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// 3. Varsayılan Kullanıcıları Oluştur (İlk kurulumda şifreleri hash'le)
const initDefaultUsers = () => {
  const checkUserStmt = db.prepare('SELECT id FROM users WHERE username = ?');
  const insertUserStmt = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');

  if (!checkUserStmt.get('admin')) {
    const adminHash = bcrypt.hashSync('admin123', 10);
    insertUserStmt.run('admin', adminHash, 'admin');
    console.log('[DB] Varsayılan yönetici oluşturuldu -> Kullanıcı: admin | Şifre: admin123');
  }

  if (!checkUserStmt.get('personel')) {
    const persHash = bcrypt.hashSync('personel123', 10);
    insertUserStmt.run('personel', persHash, 'personnel');
    console.log('[DB] Varsayılan personel oluşturuldu -> Kullanıcı: personel | Şifre: personel123');
  }
};

initDefaultUsers();

module.exports = db;
