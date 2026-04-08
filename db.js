// db.js — PostgreSQL (Railway / Render / Supabase)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'personnel',
      display_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS column_defs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      data_type TEXT NOT NULL DEFAULT 'text',
      display_order INT DEFAULT 0,
      min_stock INT DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      values JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS machines (
      id SERIAL PRIMARY KEY,
      machine_name TEXT NOT NULL,
      firm_id INT REFERENCES firms(id) ON DELETE SET NULL,
      notes TEXT DEFAULT '',
      items JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE machines ADD COLUMN IF NOT EXISTS firm_id INT REFERENCES firms(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL,
      product_id INT NOT NULL,
      company TEXT NOT NULL,
      quantity NUMERIC NOT NULL,
      notes TEXT DEFAULT '',
      tx_type TEXT NOT NULL DEFAULT 'out',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS firms (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

module.exports = { query, init };
