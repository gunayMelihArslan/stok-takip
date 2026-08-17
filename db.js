const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const initDB = async () => {
  try {
    // 1. Tabloları Oluştur
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK(role IN ('admin', 'personnel')),
        full_name VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(150) NOT NULL,
        category VARCHAR(50) DEFAULT 'Genel',
        stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
        min_stock INTEGER NOT NULL DEFAULT 5 CHECK(min_stock >= 0),
        unit VARCHAR(20) DEFAULT 'Adet',
        shelf_location VARCHAR(50),
        is_deleted INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS job_orders (
        id SERIAL PRIMARY KEY,
        job_no VARCHAR(50) UNIQUE NOT NULL,
        title VARCHAR(150) NOT NULL,
        description TEXT,
        customer_or_project VARCHAR(150),
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(30) DEFAULT 'Devam Ediyor' CHECK(status IN ('Beklemede', 'Devam Ediyor', 'Tamamlandı', 'İptal')),
        priority VARCHAR(20) DEFAULT 'Normal' CHECK(priority IN ('Düşük', 'Normal', 'Acil')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stock_logs (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_order_id INTEGER REFERENCES job_orders(id) ON DELETE SET NULL,
        action_type VARCHAR(20) NOT NULL CHECK(action_type IN ('IN', 'OUT', 'ADJUSTMENT')),
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        previous_stock INTEGER NOT NULL,
        new_stock INTEGER NOT NULL,
        note TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Varsayılan Kullanıcılar (admin: admin123 | personel: personel123)
    const adminCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
    if (adminCheck.rows.length === 0) {
      const adminHash = bcrypt.hashSync('admin123', 10);
      await pool.query('INSERT INTO users (username, password, role, full_name) VALUES ($1, $2, $3, $4)', 
        ['admin', adminHash, 'admin', 'Sistem Yöneticisi']);
      console.log('[DB] Yönetici hesabı hazır: admin / admin123');
    }

    const persCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['personel']);
    if (persCheck.rows.length === 0) {
      const persHash = bcrypt.hashSync('personel123', 10);
      await pool.query('INSERT INTO users (username, password, role, full_name) VALUES ($1, $2, $3, $4)', 
        ['personel', persHash, 'personnel', 'Saha Personeli']);
      console.log('[DB] Personel hesabı hazır: personel / personel123');
    }

    console.log('[DB] Veritabanı tabloları ve şemaları başarıyla yüklendi.');
  } catch (err) {
    console.error('[DB Başlatma Hatası]:', err.message);
  }
};

initDB();

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
