// accounting.js — Faz 1: Muhasebe & Satınalma Çekirdeği, RBAC, TCMB Kur Servisi, Dönem Kilitleme
const { query, withTransaction } = require('./db');

// ── 1. RBAC YETKİLENDİRME MİDDLEWARE ──────────────────────────────────────
// Mevcut roller (admin, purchase, after_sales, personnel) ile tam uyumludur.
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ error: 'Oturum geçersiz' });
    if (role === 'admin') return next();
    // 'purchase' ve 'purchasing' rollerini eşdeğer kabul et
    const normalized = role === 'purchase' ? 'purchasing' : role;
    const normalizedAllowed = allowedRoles.map(r => (r === 'purchase' ? 'purchasing' : r));
    if (!normalizedAllowed.includes(normalized)) {
      return res.status(403).json({ error: 'Bu işlem için yetkiniz bulunmuyor' });
    }
    next();
  };
}

// ── 2. DÖNEM KİLİTLEME KONTROLÜ (FISCAL PERIOD LOCK) ──────────────────────
async function assertPeriodOpen(dateInput, client = null) {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(d.getTime())) return;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const qFunc = client ? client.query.bind(client) : query;
  const r = await qFunc(
    'SELECT id, note FROM fiscal_locks WHERE year=$1 AND month=$2 LIMIT 1',
    [year, month]
  );
  if (r.rows[0]) {
    const err = new Error(`${year}/${String(month).padStart(2, '0')} muhasebe dönemi kilitlidir. Kayıt eklenemez veya değiştirilemez.`);
    err.statusCode = 423;
    throw err;
  }
}

// ── 3. TCMB OTOMATİK KUR SERVİSİ (EK PAKETSİZ XML PARSER) ─────────────────
function parseTcmbCurrency(xml, code) {
  const regex = new RegExp(`<Currency[^>]*CurrencyCode="${code}"[^>]*>([\\s\\S]*?)<\\/Currency>`, 'i');
  const match = xml.match(regex);
  if (!match) return null;
  const block = match[1];
  const getTag = (tag) => {
    const m = block.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, 'i'));
    return m && m[1].trim() ? parseFloat(m[1].trim()) : null;
  };
  return {
    buying: getTag('ForexBuying'),
    selling: getTag('ForexSelling'),
    effective_buying: getTag('BanknoteBuying'),
    effective_selling: getTag('BanknoteSelling')
  };
}

async function fetchAndSaveTcmbRates() {
  try {
    const res = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml', {
      headers: { 'User-Agent': 'Sekizli-ERP/1.0' }
    });
    if (!res.ok) throw new Error(`TCMB HTTP ${res.status}`);
    const xml = await res.text();
    const today = new Date().toISOString().slice(0, 10);

    const saved = {};
    for (const code of ['USD', 'EUR']) {
      const parsed = parseTcmbCurrency(xml, code);
      if (parsed && parsed.buying && parsed.selling) {
        await query(
          `INSERT INTO exchange_rates(rate_date, currency, buying, selling, effective_buying, effective_selling, source)
           VALUES($1, $2, $3, $4, $5, $6, 'TCMB')
           ON CONFLICT (rate_date, currency)
           DO UPDATE SET buying=EXCLUDED.buying, selling=EXCLUDED.selling,
                         effective_buying=EXCLUDED.effective_buying, effective_selling=EXCLUDED.effective_selling,
                         fetched_at=NOW()`,
          [today, code, parsed.buying, parsed.selling, parsed.effective_buying, parsed.effective_selling]
        );
        saved[code] = parsed;
      }
    }
    return { date: today, rates: saved };
  } catch (e) {
    console.warn('⚠️ TCMB kur çekme uyarısı:', e.message);
    return null;
  }
}

// ── 4. VERİTABANI MİGRASYONU (16 YENİ TABLO + GÜVENLİ ALTER) ──────────────
async function initAccountingDB() {
  try {
    // Mevcut products tablosuna ağırlıklı ortalama maliyet sütunlarını güvenle ekle
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS avg_cost_try NUMERIC(18,4) DEFAULT 0;`);
    await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS avg_cost_eur NUMERIC(18,4) DEFAULT 0;`);

    // 1. CARİ HESAPLAR (Müşteri / Tedarikçi / Karma)
    await query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        code VARCHAR(40) UNIQUE,
        name VARCHAR(200) NOT NULL,
        account_type VARCHAR(20) NOT NULL DEFAULT 'both', -- customer | supplier | both
        tax_office VARCHAR(120),
        tax_no VARCHAR(30),
        contact_name VARCHAR(120),
        phone VARCHAR(50),
        email VARCHAR(150),
        address TEXT,
        iban VARCHAR(60),
        currency VARCHAR(10) NOT NULL DEFAULT 'TRY', -- TRY | USD | EUR
        payment_term_days INTEGER DEFAULT 0,
        credit_limit NUMERIC(18,4) DEFAULT 0,
        opening_balance NUMERIC(18,4) DEFAULT 0,
        notes TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. KASA / BANKA / POS / KREDİ KARTI HESAPLARI
    await query(`
      CREATE TABLE IF NOT EXISTS treasury_accounts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        account_type VARCHAR(20) NOT NULL DEFAULT 'cash', -- cash | bank | pos | card
        bank_name VARCHAR(120),
        iban VARCHAR(60),
        currency VARCHAR(10) NOT NULL DEFAULT 'TRY',
        opening_balance NUMERIC(18,4) DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 3. TEKLİF KIYASLAMA (RFQ)
    await query(`
      CREATE TABLE IF NOT EXISTS rfq_quotes (
        id SERIAL PRIMARY KEY,
        purchase_request_id INTEGER REFERENCES purchase_requests(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(200),
        quantity NUMERIC(18,4) NOT NULL,
        unit_price NUMERIC(18,4) NOT NULL,
        discount_rate NUMERIC(6,2) DEFAULT 0,
        vat_rate NUMERIC(6,2) DEFAULT 20,
        currency VARCHAR(10) DEFAULT 'TRY',
        delivery_days INTEGER DEFAULT 0,
        notes TEXT,
        is_selected BOOLEAN DEFAULT FALSE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 4. SATIN ALMA SİPARİŞLERİ (PO) & KALEMLERİ
    await query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id SERIAL PRIMARY KEY,
        po_no VARCHAR(40) UNIQUE NOT NULL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        machine_id INTEGER REFERENCES machines(id) ON DELETE SET NULL,
        order_date DATE NOT NULL DEFAULT CURRENT_DATE,
        expected_date DATE,
        currency VARCHAR(10) NOT NULL DEFAULT 'TRY',
        fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
        subtotal NUMERIC(18,4) DEFAULT 0,
        discount_total NUMERIC(18,4) DEFAULT 0,
        vat_total NUMERIC(18,4) DEFAULT 0,
        grand_total NUMERIC(18,4) DEFAULT 0,
        status VARCHAR(30) NOT NULL DEFAULT 'draft', -- draft | pending_approval | approved | partial | completed | cancelled
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS po_items (
        id SERIAL PRIMARY KEY,
        po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        description VARCHAR(250) NOT NULL,
        unit VARCHAR(30) DEFAULT 'adet',
        ordered_qty NUMERIC(18,4) NOT NULL,
        received_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
        unit_price NUMERIC(18,4) NOT NULL DEFAULT 0,
        discount_rate NUMERIC(6,2) DEFAULT 0,
        vat_rate NUMERIC(6,2) DEFAULT 20,
        line_total NUMERIC(18,4) DEFAULT 0
      );
    `);

    // 5. İRSALİYE / MAL KABUL (WAYBILLS)
    await query(`
      CREATE TABLE IF NOT EXISTS waybills (
        id SERIAL PRIMARY KEY,
        waybill_no VARCHAR(60) NOT NULL,
        direction VARCHAR(10) NOT NULL DEFAULT 'in', -- in (Alış/Giriş) | out (Satış/Sevk)
        account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
        po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
        machine_id INTEGER REFERENCES machines(id) ON DELETE SET NULL,
        waybill_date DATE NOT NULL DEFAULT CURRENT_DATE,
        attachment_url TEXT,
        quality_note TEXT,
        is_invoiced BOOLEAN DEFAULT FALSE,
        received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS waybill_items (
        id SERIAL PRIMARY KEY,
        waybill_id INTEGER NOT NULL REFERENCES waybills(id) ON DELETE CASCADE,
        po_item_id INTEGER REFERENCES po_items(id) ON DELETE SET NULL,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        description VARCHAR(250),
        quantity NUMERIC(18,4) NOT NULL,
        unit VARCHAR(30) DEFAULT 'adet'
      );
    `);

    // 6. FATURALAR (UBL-TR UYUMLU) & KALEMLERİ
    await query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        invoice_no VARCHAR(60) NOT NULL,
        ettn_uuid VARCHAR(64),
        gib_scenario VARCHAR(30) DEFAULT 'TICARIFATURA', -- TEMELFATURA | TICARIFATURA | EARSIV
        direction VARCHAR(20) NOT NULL, -- purchase | sales | purchase_return | sales_return
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        waybill_id INTEGER REFERENCES waybills(id) ON DELETE SET NULL,
        po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
        machine_id INTEGER REFERENCES machines(id) ON DELETE SET NULL,
        invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date DATE,
        currency VARCHAR(10) NOT NULL DEFAULT 'TRY',
        fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
        subtotal NUMERIC(18,4) DEFAULT 0,
        discount_total NUMERIC(18,4) DEFAULT 0,
        vat_total NUMERIC(18,4) DEFAULT 0,
        withholding_total NUMERIC(18,4) DEFAULT 0, -- KDV Tevkifatı
        grand_total NUMERIC(18,4) DEFAULT 0,
        paid_amount NUMERIC(18,4) DEFAULT 0,
        payment_status VARCHAR(20) DEFAULT 'unpaid', -- unpaid | partial | paid
        has_price_variance BOOLEAN DEFAULT FALSE,
        is_voided BOOLEAN DEFAULT FALSE,
        attachment_url TEXT,
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        description VARCHAR(250) NOT NULL,
        quantity NUMERIC(18,4) NOT NULL,
        unit VARCHAR(30) DEFAULT 'adet',
        gib_unit_code VARCHAR(15) DEFAULT 'C62',
        unit_price NUMERIC(18,4) NOT NULL,
        discount1 NUMERIC(6,2) DEFAULT 0,
        discount2 NUMERIC(6,2) DEFAULT 0,
        vat_rate NUMERIC(6,2) DEFAULT 20,
        withholding_ratio VARCHAR(10), -- örn: '5/10', '7/10'
        line_total NUMERIC(18,4) DEFAULT 0
      );
    `);

    // 7. ÇEK & SENET PORTFÖYÜ + HAREKET GEÇMİŞİ
    await query(`
      CREATE TABLE IF NOT EXISTS cheques (
        id SERIAL PRIMARY KEY,
        doc_type VARCHAR(20) NOT NULL DEFAULT 'cheque', -- cheque | note
        direction VARCHAR(20) NOT NULL, -- received (Müşteri) | issued (Kendi Çekimiz)
        doc_no VARCHAR(80) NOT NULL,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
        bank_name VARCHAR(120),
        branch_name VARCHAR(120),
        drawer_name VARCHAR(180),
        issue_date DATE DEFAULT CURRENT_DATE,
        due_date DATE NOT NULL,
        amount NUMERIC(18,4) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'TRY',
        fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
        status VARCHAR(30) NOT NULL DEFAULT 'portfolio', -- portfolio | endorsed | bank_collection | bank_collateral | paid | bounced | returned
        endorsed_to_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        treasury_account_id INTEGER REFERENCES treasury_accounts(id) ON DELETE SET NULL,
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS cheque_history (
        id SERIAL PRIMARY KEY,
        cheque_id INTEGER NOT NULL REFERENCES cheques(id) ON DELETE CASCADE,
        old_status VARCHAR(30),
        new_status VARCHAR(30) NOT NULL,
        target_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        treasury_account_id INTEGER REFERENCES treasury_accounts(id) ON DELETE SET NULL,
        note TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 8. MERKEZİ DEĞİŞTİRİLEMEZ DEFTER (IMMUTABLE LEDGER)
    await query(`
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id SERIAL PRIMARY KEY,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
        treasury_account_id INTEGER REFERENCES treasury_accounts(id) ON DELETE RESTRICT,
        ref_type VARCHAR(40) NOT NULL, -- invoice | payment | receipt | cheque | transfer | expense | opening | storno
        ref_id INTEGER,
        description TEXT,
        debit NUMERIC(18,4) NOT NULL DEFAULT 0,  -- Borç
        credit NUMERIC(18,4) NOT NULL DEFAULT 0, -- Alacak
        currency VARCHAR(10) NOT NULL DEFAULT 'TRY',
        fx_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
        base_try_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
        is_voided BOOLEAN DEFAULT FALSE,
        voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 9. MASRAFLAR / PERSONEL AVANS & PROJE MALİYETLERİ
    await query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
        category VARCHAR(80) NOT NULL, -- yakit | santiye | kira | elektrik | nakliye | avans | diger
        cost_center VARCHAR(80) DEFAULT 'Atölye',
        machine_id INTEGER REFERENCES machines(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- Avans/Harcırah alan personel
        treasury_account_id INTEGER REFERENCES treasury_accounts(id) ON DELETE SET NULL,
        amount NUMERIC(18,4) NOT NULL,
        currency VARCHAR(10) DEFAULT 'TRY',
        fx_rate NUMERIC(18,6) DEFAULT 1,
        description TEXT,
        attachment_url TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS project_costs (
        id SERIAL PRIMARY KEY,
        machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
        cost_type VARCHAR(30) NOT NULL, -- material | labor | expense | invoice
        ref_id INTEGER,
        description TEXT,
        amount_try NUMERIC(18,4) NOT NULL DEFAULT 0,
        amount_eur NUMERIC(18,4) NOT NULL DEFAULT 0,
        cost_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 10. TCMB KURLARI & DÖNEM KİLİTLEME
    await query(`
      CREATE TABLE IF NOT EXISTS exchange_rates (
        id SERIAL PRIMARY KEY,
        rate_date DATE NOT NULL,
        currency VARCHAR(10) NOT NULL,
        buying NUMERIC(18,6) NOT NULL,
        selling NUMERIC(18,6) NOT NULL,
        effective_buying NUMERIC(18,6),
        effective_selling NUMERIC(18,6),
        source VARCHAR(30) DEFAULT 'TCMB',
        fetched_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(rate_date, currency)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS fiscal_locks (
        id SERIAL PRIMARY KEY,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        note TEXT,
        locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        locked_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(year, month)
      );
    `);

    // Performans İndeksleri
    await query(`CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id, entry_date);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ledger_treasury ON ledger_entries(treasury_account_id, entry_date);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices(account_id, due_date);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_cheques_due ON cheques(due_date, status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_project_costs_machine ON project_costs(machine_id);`);

    // Varsayılan Ana TL Kasa (yoksa)
    const tc = await query('SELECT COUNT(*) as c FROM treasury_accounts');
    if (parseInt(tc.rows[0].c) === 0) {
      await query(
        "INSERT INTO treasury_accounts(name, account_type, currency, opening_balance) VALUES('Ana TL Kasa', 'cash', 'TRY', 0)"
      );
    }

    console.log('✓ Muhasebe & Satınalma ERP Veritabanı (Faz 1 — 16 Tablo) Hazır');

    // Açılışta TCMB kurlarını çek + her 4 saatte bir güncelle
    fetchAndSaveTcmbRates();
    setInterval(fetchAndSaveTcmbRates, 4 * 60 * 60 * 1000);
  } catch (err) {
    console.error('❌ Muhasebe DB Migrasyon Hatası:', err.message);
  }
}

// ── 5. FAZ 1 API ROTALARI (KURLAR, DÖNEM KİLİTLEME, RBAC META) ────────────
function registerAccountingPhase1(app, { auth, logActivity, broadcast }) {
  // Güncel kurları getir
  app.get('/api/accounting/rates', auth, async (req, res) => {
    try {
      const rows = (await query(`
        SELECT DISTINCT ON (currency) *
        FROM exchange_rates
        ORDER BY currency, rate_date DESC
      `)).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manuel TCMB kur senkronizasyonu
  app.post('/api/accounting/rates/sync', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const result = await fetchAndSaveTcmbRates();
      if (!result) return res.status(502).json({ error: 'TCMB servisine ulaşılamadı' });
      await logActivity(req.user.id, 'TCMB Kurları Güncellendi', 'exchange_rate', null, result, req);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Kilitli muhasebe dönemlerini listele
  app.get('/api/accounting/fiscal-locks', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const rows = (await query(`
        SELECT f.*, u.display_name as locked_by_name
        FROM fiscal_locks f
        LEFT JOIN users u ON u.id = f.locked_by
        ORDER BY f.year DESC, f.month DESC
      `)).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Dönem kilitle (Sadece Admin)
  app.post('/api/accounting/fiscal-locks', auth, requireRoles('admin'), async (req, res) => {
    try {
      const { year, month, note } = req.body;
      if (!year || !month) return res.status(400).json({ error: 'Yıl ve ay zorunludur' });
      const r = (await query(
        'INSERT INTO fiscal_locks(year, month, note, locked_by) VALUES($1, $2, $3, $4) RETURNING *',
        [parseInt(year), parseInt(month), note || '', req.user.id]
      )).rows[0];
      await logActivity(req.user.id, `Muhasebe Dönemi Kilitlendi (${year}/${month})`, 'fiscal_lock', r.id, { year, month, note }, req);
      res.json(r);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Bu dönem zaten kilitli' });
      res.status(500).json({ error: e.message });
    }
  });

  // Dönem kilidini aç (Sadece Admin)
  app.delete('/api/accounting/fiscal-locks/:id', auth, requireRoles('admin'), async (req, res) => {
    try {
      const r = (await query('DELETE FROM fiscal_locks WHERE id=$1 RETURNING *', [req.params.id])).rows[0];
      if (!r) return res.status(404).json({ error: 'Kayıt bulunamadı' });
      await logActivity(req.user.id, `Muhasebe Dönem Kilidi Açıldı (${r.year}/${r.month})`, 'fiscal_lock', r.id, {}, req);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Sistem rolleri ve özet meta bilgisi
  app.get('/api/accounting/meta', auth, async (req, res) => {
    try {
      const rates = (await query(`
        SELECT DISTINCT ON (currency) currency, buying, selling, rate_date
        FROM exchange_rates ORDER BY currency, rate_date DESC
      `)).rows;
      res.json({
        roles: ['admin', 'accounting', 'purchasing', 'warehouse', 'after_sales', 'personnel'],
        current_role: req.user.role,
        rates
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = {
  initAccountingDB,
  registerAccountingPhase1,
  requireRoles,
  assertPeriodOpen,
  fetchAndSaveTcmbRates
};
