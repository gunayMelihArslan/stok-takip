const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function init() {
  // ── 1. Şema ve Sütun Uyumlaması ──
  await query(`
    DO $$
    BEGIN
      -- users tablosunda 'password' kalmışsa 'password_hash' olarak adlandır
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='password'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='password_hash'
      ) THEN
        ALTER TABLE users RENAME COLUMN password TO password_hash;
      END IF;

      -- display_name yoksa ekle
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='display_name'
      ) THEN
        ALTER TABLE users ADD COLUMN display_name TEXT;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='task_transfers' AND column_name='task_id'
      ) THEN
        DROP TABLE IF EXISTS task_transfers CASCADE;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='tasks' AND column_name='assigned_to'
      ) THEN
        DROP TABLE IF EXISTS task_stages CASCADE;
        DROP TABLE IF EXISTS tasks CASCADE;
      END IF;
    END $$;
  `);

  // ── 2. Orijinal Tablo Tanımları ──
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'personnel', display_name TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS column_defs (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, data_type TEXT NOT NULL DEFAULT 'text',
      display_order INT DEFAULT 0, min_stock INT DEFAULT 5, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY, values JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS firms (
      id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, notes TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS machines (
      id SERIAL PRIMARY KEY, machine_name TEXT NOT NULL,
      firm_id INT REFERENCES firms(id) ON DELETE SET NULL,
      notes TEXT DEFAULT '', items JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE machines ADD COLUMN IF NOT EXISTS firm_id INT REFERENCES firms(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY, user_id INT NOT NULL, product_id INT NOT NULL,
      company TEXT NOT NULL, quantity NUMERIC NOT NULL, notes TEXT DEFAULT '',
      tx_type TEXT NOT NULL DEFAULT 'out', created_at TIMESTAMPTZ DEFAULT NOW(),
      machine_id INT REFERENCES machines(id) ON DELETE SET NULL
    );
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS machine_id INT REFERENCES machines(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      firm_id INT REFERENCES firms(id) ON DELETE SET NULL,
      machine_id INT REFERENCES machines(id) ON DELETE CASCADE,
      created_by INT REFERENCES users(id),
      is_auto BOOLEAN DEFAULT FALSE,
      priority TEXT NOT NULL DEFAULT 'normal',
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS task_stages (
      id SERIAL PRIMARY KEY,
      task_id INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stage_order INT NOT NULL DEFAULT 1,
      stage_name TEXT NOT NULL DEFAULT 'Aşama',
      assigned_to INT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open',
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS task_transfers (
      id SERIAL PRIMARY KEY,
      stage_id INT NOT NULL REFERENCES task_stages(id) ON DELETE CASCADE,
      from_user_id INT NOT NULL REFERENCES users(id),
      to_user_id INT NOT NULL REFERENCES users(id),
      message TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
  `);
  
  await query("CREATE TABLE IF NOT EXISTS product_lots (id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE, production_year INT NOT NULL, quantity NUMERIC NOT NULL DEFAULT 0, notes TEXT DEFAULT '', UNIQUE(product_id, production_year))");

  await query(`CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, body TEXT DEFAULT '', type TEXT DEFAULT 'info',
    is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  
  await query(`CREATE TABLE IF NOT EXISTS stage_comments (
    id SERIAL PRIMARY KEY,
    stage_id INT NOT NULL REFERENCES task_stages(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  
  await query(`CREATE TABLE IF NOT EXISTS purchase_requests (
    id SERIAL PRIMARY KEY,
    requested_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_name TEXT NOT NULL, quantity NUMERIC NOT NULL DEFAULT 1,
    unit TEXT DEFAULT 'adet', reason TEXT DEFAULT '',
    task_id INT REFERENCES tasks(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending', admin_note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  
  await query(`CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INT,
    details JSONB DEFAULT '{}',
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  
  await query(`CREATE TABLE IF NOT EXISTS bom_columns (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    display_order INT DEFAULT 0,
    is_default BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  
  await query(`CREATE TABLE IF NOT EXISTS bom_categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  
  await query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bom_category TEXT DEFAULT NULL");

  // Varsayılan BOM sütunları
  const bomCheck = (await query("SELECT COUNT(*) as c FROM bom_columns")).rows[0];
  if (parseInt(bomCheck.c) === 0) {
    await query("INSERT INTO bom_columns(name, display_order, is_default) VALUES('Sıra No', 1, true),('Malzeme Adı', 2, true),('Miktar', 3, true),('Birim', 4, true),('Açıklama', 5, true)");
  }

  // Varsayılan admin kullanıcısı (Çakışma durumunda hata fırlatmadan geçer)
  const defaultPassHash = bcrypt.hashSync('admin123', 10);
  await query(`
    INSERT INTO users (username, password_hash, role, display_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (username) DO NOTHING
  `, ['admin', defaultPassHash, 'admin', 'Yönetici']);
}

module.exports = { query, init, pool };
