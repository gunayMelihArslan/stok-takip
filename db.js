const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Veritabanı tablolarını ve varsayılan kullanıcıları otomatik oluşturma
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL CHECK(role IN ('admin', 'personnel')),
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
        is_deleted INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stock_logs (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action_type VARCHAR(20) NOT NULL CHECK(action_type IN ('IN', 'OUT', 'ADJUSTMENT')),
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        previous_stock INTEGER NOT NULL,
        new_stock INTEGER NOT NULL,
        note TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Varsayılan yönetici ve personel hesaplarını denetle
    const adminCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['admin']);
    if (adminCheck.rows.length === 0) {
      const adminHash = bcrypt.hashSync('admin123', 10);
      await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', ['admin', adminHash, 'admin']);
      console.log('[DB] Varsayılan yönetici oluşturuldu -> admin / admin123');
    }

    const persCheck = await pool.query('SELECT id FROM users WHERE username = $1', ['personel']);
    if (persCheck.rows.length === 0) {
      const persHash = bcrypt.hashSync('personel123', 10);
      await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', ['personel', persHash, 'personnel']);
      console.log('[DB] Varsayılan personel oluşturuldu -> personel / personel123');
    }

    console.log('[DB] Neon PostgreSQL bağlantısı ve şemaları hazır.');
  } catch (err) {
    console.error('[DB Başlatma Hatası]:', err.message);
  }
};

initDB();

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
