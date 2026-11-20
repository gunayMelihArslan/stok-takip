// accounting-phase2.js — Faz 2: Cari Hesaplar, Kasa/Banka, Tahsilat, Tediye, Virman & Storno Motoru
const { query, withTransaction } = require('./db');
const { requireRoles, assertPeriodOpen } = require('./accounting');

// Kuruş/4 hane hassasiyeti yardımcısı
function round4(val) {
  return Math.round((parseFloat(val) || 0) * 10000) / 10000;
}

function registerAccountingPhase2(app, { auth, logActivity, broadcast }) {

  // ── 1. FİNANSAL ÖZET (DASHBOARD KPI) ────────────────────────────────────
  app.get('/api/accounting/summary', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      // Kasa & Banka toplamları (döviz bazlı)
      const treasuryRes = await query(`
        SELECT t.currency,
               COALESCE(SUM(t.opening_balance), 0) + COALESCE(SUM(l.net), 0) AS total_balance
        FROM treasury_accounts t
        LEFT JOIN (
          SELECT treasury_account_id, SUM(debit - credit) AS net
          FROM ledger_entries
          WHERE is_voided = FALSE AND treasury_account_id IS NOT NULL
          GROUP BY treasury_account_id
        ) l ON l.treasury_account_id = t.id
        WHERE t.is_active = TRUE
        GROUP BY t.currency
      `);

      // Cari Alacak / Borç toplamları (TL bazlı)
      // Pozitif bakiye (debit > credit) = Müşteriden Alacağımız
      // Negatif bakiye (credit > debit) = Tedarikçiye Borcumuz
      const cariRes = await query(`
        SELECT a.id, a.currency,
               a.opening_balance + COALESCE(SUM(l.debit - l.credit), 0) AS balance
        FROM accounts a
        LEFT JOIN ledger_entries l
          ON l.account_id = a.id AND l.is_voided = FALSE
        WHERE a.is_active = TRUE
        GROUP BY a.id, a.currency, a.opening_balance
      `);

      const receivables = {};
      const payables = {};
      cariRes.rows.forEach(r => {
        const bal = parseFloat(r.balance || 0);
        if (bal > 0) receivables[r.currency] = round4((receivables[r.currency] || 0) + bal);
        else if (bal < 0) payables[r.currency] = round4((payables[r.currency] || 0) + Math.abs(bal));
      });

      res.json({
        treasury_by_currency: treasuryRes.rows,
        receivables_by_currency: receivables,
        payables_by_currency: payables,
        total_accounts: cariRes.rows.length
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 2. CARİ HESAPLAR (CRUD + CANLI BAKİYE) ──────────────────────────────
  app.get('/api/accounting/accounts', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const { type, q, include_inactive } = req.query;
      const params = [];
      let where = include_inactive === 'true' ? 'WHERE 1=1' : 'WHERE a.is_active = TRUE';

      if (type && ['customer', 'supplier', 'both'].includes(type)) {
        params.push(type);
        where += ` AND (a.account_type = $${params.length} OR a.account_type = 'both')`;
      }
      if (q && q.trim()) {
        params.push(`%${q.trim().toLowerCase()}%`);
        where += ` AND (LOWER(a.name) LIKE $${params.length} OR LOWER(COALESCE(a.code,'')) LIKE $${params.length} OR LOWER(COALESCE(a.tax_no,'')) LIKE $${params.length})`;
      }

      const rows = (await query(`
        SELECT a.*,
               (a.opening_balance + COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.debit - l.credit ELSE 0 END), 0)) AS balance,
               COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.debit ELSE 0 END), 0) AS total_debit,
               COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.credit ELSE 0 END), 0) AS total_credit
        FROM accounts a
        LEFT JOIN ledger_entries l ON l.account_id = a.id
        ${where}
        GROUP BY a.id
        ORDER BY a.name ASC
      `, params)).rows;

      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/accounting/accounts', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const {
        code, name, account_type, tax_office, tax_no, contact_name,
        phone, email, address, iban, currency, payment_term_days,
        credit_limit, opening_balance, notes
      } = req.body;

      if (!name || !name.trim()) return res.status(400).json({ error: 'Cari ünvanı zorunludur' });

      // Kod verilmediyse otomatik üret (CR-0001)
      let finalCode = code ? code.trim().toUpperCase() : null;
      if (!finalCode) {
        const cnt = parseInt((await query('SELECT COALESCE(MAX(id),0) as m FROM accounts')).rows[0].m) + 1;
        finalCode = `CR-${String(cnt).padStart(4, '0')}`;
      }

      const r = (await query(`
        INSERT INTO accounts(
          code, name, account_type, tax_office, tax_no, contact_name,
          phone, email, address, iban, currency, payment_term_days,
          credit_limit, opening_balance, notes, created_by
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING *
      `, [
        finalCode, name.trim(), account_type || 'both', tax_office || '', tax_no || '',
        contact_name || '', phone || '', email || '', address || '', iban || '',
        currency || 'TRY', parseInt(payment_term_days) || 0,
        round4(credit_limit), round4(opening_balance), notes || '', req.user.id
      ])).rows[0];

      await logActivity(req.user.id, 'Cari Hesap Oluşturuldu', 'account', r.id, { code: finalCode, name: r.name }, req);
      broadcast('accounting_update', { type: 'account_new', id: r.id });
      res.json(r);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Bu cari kodu zaten kullanılıyor' });
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/accounting/accounts/:id', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const {
        code, name, account_type, tax_office, tax_no, contact_name,
        phone, email, address, iban, currency, payment_term_days,
        credit_limit, opening_balance, notes, is_active
      } = req.body;

      const cur = (await query('SELECT * FROM accounts WHERE id=$1', [req.params.id])).rows[0];
      if (!cur) return res.status(404).json({ error: 'Cari hesap bulunamadı' });

      const r = (await query(`
        UPDATE accounts SET
          code=$1, name=$2, account_type=$3, tax_office=$4, tax_no=$5,
          contact_name=$6, phone=$7, email=$8, address=$9, iban=$10,
          currency=$11, payment_term_days=$12, credit_limit=$13,
          opening_balance=$14, notes=$15, is_active=$16, updated_at=NOW()
        WHERE id=$17 RETURNING *
      `, [
        code ? code.trim().toUpperCase() : cur.code,
        name ? name.trim() : cur.name,
        account_type || cur.account_type,
        tax_office !== undefined ? tax_office : cur.tax_office,
        tax_no !== undefined ? tax_no : cur.tax_no,
        contact_name !== undefined ? contact_name : cur.contact_name,
        phone !== undefined ? phone : cur.phone,
        email !== undefined ? email : cur.email,
        address !== undefined ? address : cur.address,
        iban !== undefined ? iban : cur.iban,
        currency || cur.currency,
        payment_term_days !== undefined ? parseInt(payment_term_days) : cur.payment_term_days,
        credit_limit !== undefined ? round4(credit_limit) : cur.credit_limit,
        opening_balance !== undefined ? round4(opening_balance) : cur.opening_balance,
        notes !== undefined ? notes : cur.notes,
        is_active !== undefined ? !!is_active : cur.is_active,
        req.params.id
      ])).rows[0];

      await logActivity(req.user.id, 'Cari Hesap Güncellendi', 'account', r.id, { name: r.name }, req);
      broadcast('accounting_update', { type: 'account_update', id: r.id });
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Değiştirilemez Defter Kuralı: Hareketi olan cari silinmez, pasife alınır
  app.delete('/api/accounting/accounts/:id', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const cnt = parseInt((await query('SELECT COUNT(*) as c FROM ledger_entries WHERE account_id=$1', [req.params.id])).rows[0].c);
      if (cnt > 0) {
        await query('UPDATE accounts SET is_active=FALSE, updated_at=NOW() WHERE id=$1', [req.params.id]);
        await logActivity(req.user.id, 'Cari Hesap Pasife Alındı (Hareketli)', 'account', parseInt(req.params.id), {}, req);
        return res.json({ ok: true, archived: true, message: 'Hareket kaydı olduğu için silinmedi, pasife alındı.' });
      }
      await query('DELETE FROM accounts WHERE id=$1', [req.params.id]);
      await logActivity(req.user.id, 'Cari Hesap Silindi', 'account', parseInt(req.params.id), {}, req);
      res.json({ ok: true, archived: false });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 3. CARİ HESAP EKSTRESİ (YÜRÜYEN BAKİYELİ) ───────────────────────────
  app.get('/api/accounting/accounts/:id/statement', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const { from, to } = req.query;
      const account = (await query('SELECT * FROM accounts WHERE id=$1', [req.params.id])).rows[0];
      if (!account) return res.status(404).json({ error: 'Cari hesap bulunamadı' });

      const params = [req.params.id];
      let dateFilter = '';
      if (from) { params.push(from); dateFilter += ` AND l.entry_date >= $${params.length}`; }
      if (to) { params.push(to); dateFilter += ` AND l.entry_date <= $${params.length}`; }

      const entries = (await query(`
        SELECT l.*, u.display_name AS created_by_name
        FROM ledger_entries l
        LEFT JOIN users u ON u.id = l.created_by
        WHERE l.account_id = $1 ${dateFilter}
        ORDER BY l.entry_date ASC, l.id ASC
      `, params)).rows;

      let running = parseFloat(account.opening_balance || 0);
      let totalDebit = 0;
      let totalCredit = 0;

      const enriched = entries.map(e => {
        if (!e.is_voided) {
          const d = parseFloat(e.debit || 0);
          const c = parseFloat(e.credit || 0);
          totalDebit = round4(totalDebit + d);
          totalCredit = round4(totalCredit + c);
          running = round4(running + d - c);
        }
        return { ...e, running_balance: running };
      });

      res.json({
        account,
        opening_balance: parseFloat(account.opening_balance || 0),
        total_debit: totalDebit,
        total_credit: totalCredit,
        closing_balance: running,
        entries: enriched
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 4. KASA / BANKA / POS HESAPLARI (CRUD + EKSTRE) ─────────────────────
  app.get('/api/accounting/treasury', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const rows = (await query(`
        SELECT t.*,
               (t.opening_balance + COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.debit - l.credit ELSE 0 END), 0)) AS balance
        FROM treasury_accounts t
        LEFT JOIN ledger_entries l ON l.treasury_account_id = t.id
        WHERE t.is_active = TRUE
        GROUP BY t.id
        ORDER BY t.account_type ASC, t.name ASC
      `)).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/accounting/treasury', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { name, account_type, bank_name, iban, currency, opening_balance } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Hesap adı zorunludur' });
      const r = (await query(`
        INSERT INTO treasury_accounts(name, account_type, bank_name, iban, currency, opening_balance)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *
      `, [name.trim(), account_type || 'cash', bank_name || '', iban || '', currency || 'TRY', round4(opening_balance)])).rows[0];

      await logActivity(req.user.id, 'Kasa/Banka Hesabı Eklendi', 'treasury', r.id, { name: r.name, type: r.account_type }, req);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/accounting/treasury/:id/statement', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const treasury = (await query('SELECT * FROM treasury_accounts WHERE id=$1', [req.params.id])).rows[0];
      if (!treasury) return res.status(404).json({ error: 'Kasa/Banka hesabı bulunamadı' });

      const entries = (await query(`
        SELECT l.*, u.display_name AS created_by_name
        FROM ledger_entries l
        LEFT JOIN users u ON u.id = l.created_by
        WHERE l.treasury_account_id = $1
        ORDER BY l.entry_date ASC, l.id ASC
      `, [req.params.id])).rows;

      let running = parseFloat(treasury.opening_balance || 0);
      const enriched = entries.map(e => {
        if (!e.is_voided) running = round4(running + parseFloat(e.debit || 0) - parseFloat(e.credit || 0));
        return { ...e, running_balance: running };
      });

      res.json({ treasury, closing_balance: running, entries: enriched });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 5. TAHSİLAT (MÜŞTERİDEN PARA ALMA) ──────────────────────────────────
  app.post('/api/accounting/transactions/receipt', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { account_id, treasury_account_id, amount, currency, fx_rate, entry_date, description } = req.body;
      const amt = round4(amount);
      if (!account_id || !treasury_account_id || amt <= 0) {
        return res.status(400).json({ error: 'Cari, kasa/banka ve geçerli tutar zorunludur' });
      }
      const dateStr = entry_date || new Date().toISOString().slice(0, 10);
      const rate = parseFloat(fx_rate) || 1;
      const baseTry = round4(amt * rate);
      const cur = currency || 'TRY';

      const result = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        // 1. Cari Alacaklanır (Müşterinin borcu düşer)
        const accEntry = (await client.query(`
          INSERT INTO ledger_entries(entry_date, account_id, ref_type, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
          VALUES($1, $2, 'receipt', $3, 0, $4, $5, $6, $7, $8) RETURNING *
        `, [dateStr, account_id, description || 'Tahsilat', amt, cur, rate, baseTry, req.user.id])).rows[0];

        // 2. Kasa/Banka Borçlanır (Kasa/Banka bakiyesi artar) — ref_id ile eşleştirilir
        const trEntry = (await client.query(`
          INSERT INTO ledger_entries(entry_date, treasury_account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
          VALUES($1, $2, 'receipt', $3, $4, $5, 0, $6, $7, $8, $9) RETURNING *
        `, [dateStr, treasury_account_id, accEntry.id, description || 'Tahsilat', amt, cur, rate, baseTry, req.user.id])).rows[0];

        // Karşılıklı ref_id bağı
        await client.query('UPDATE ledger_entries SET ref_id=$1 WHERE id=$2', [trEntry.id, accEntry.id]);

        await logActivity(req.user.id, 'Tahsilat Kaydedildi', 'ledger', accEntry.id, { account_id, treasury_account_id, amount: amt, currency: cur }, req, client);
        return { account_entry: accEntry, treasury_entry: trEntry };
      });

      broadcast('accounting_update', { type: 'receipt', amount: amt, currency: cur });
      res.json(result);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── 6. TEDİYE / ÖDEME (TEDARİKÇİYE ÖDEME YAPMA) ─────────────────────────
  app.post('/api/accounting/transactions/payment', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { account_id, treasury_account_id, amount, currency, fx_rate, entry_date, description } = req.body;
      const amt = round4(amount);
      if (!account_id || !treasury_account_id || amt <= 0) {
        return res.status(400).json({ error: 'Cari, kasa/banka ve geçerli tutar zorunludur' });
      }
      const dateStr = entry_date || new Date().toISOString().slice(0, 10);
      const rate = parseFloat(fx_rate) || 1;
      const baseTry = round4(amt * rate);
      const cur = currency || 'TRY';

      const result = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        // 1. Cari Borçlanır (Tedarikçiye borcumuz düşer)
        const accEntry = (await client.query(`
          INSERT INTO ledger_entries(entry_date, account_id, ref_type, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
          VALUES($1, $2, 'payment', $3, $4, 0, $5, $6, $7, $8) RETURNING *
        `, [dateStr, account_id, description || 'Ödeme / Tediye', amt, cur, rate, baseTry, req.user.id])).rows[0];

        // 2. Kasa/Banka Alacaklanır (Kasa/Banka bakiyesi azalır)
        const trEntry = (await client.query(`
          INSERT INTO ledger_entries(entry_date, treasury_account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
          VALUES($1, $2, 'payment', $3, $4, 0, $5, $6, $7, $8, $9) RETURNING *
        `, [dateStr, treasury_account_id, accEntry.id, description || 'Ödeme / Tediye', amt, cur, rate, baseTry, req.user.id])).rows[0];

        await client.query('UPDATE ledger_entries SET ref_id=$1 WHERE id=$2', [trEntry.id, accEntry.id]);

        await logActivity(req.user.id, 'Ödeme (Tediye) Kaydedildi', 'ledger', accEntry.id, { account_id, treasury_account_id, amount: amt, currency: cur }, req, client);
        return { account_entry: accEntry, treasury_entry: trEntry };
      });

      broadcast('accounting_update', { type: 'payment', amount: amt, currency: cur });
      res.json(result);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── 7. VİRMAN (KASA/BANKA ARASI TRANSFER & DÖVİZ ARBİTRAJI) ─────────────
  app.post('/api/accounting/transactions/transfer', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { from_treasury_id, to_treasury_id, amount, target_amount, fx_rate, entry_date, description } = req.body;
      const amt = round4(amount);
      const targetAmt = target_amount ? round4(target_amount) : amt;
      if (!from_treasury_id || !to_treasury_id || from_treasury_id === to_treasury_id || amt <= 0) {
        return res.status(400).json({ error: 'Farklı kaynak/hedef hesap ve geçerli tutar zorunludur' });
      }
      const dateStr = entry_date || new Date().toISOString().slice(0, 10);
      const rate = parseFloat(fx_rate) || 1;

      const result = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        const fromAcc = (await client.query('SELECT * FROM treasury_accounts WHERE id=$1', [from_treasury_id])).rows[0];
        const toAcc = (await client.query('SELECT * FROM treasury_accounts WHERE id=$1', [to_treasury_id])).rows[0];
        if (!fromAcc || !toAcc) throw new Error('Kasa/Banka hesabı bulunamadı');

        const outEntry = (await client.query(`
          INSERT INTO ledger_entries(entry_date, treasury_account_id, ref_type, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
          VALUES($1, $2, 'transfer', $3, 0, $4, $5, $6, $7, $8) RETURNING *
        `, [dateStr, from_treasury_id, description || `Virman -> ${toAcc.name}`, amt, fromAcc.currency, rate, round4(amt * rate), req.user.id])).rows[0];

        const inEntry = (await client.query(`
          INSERT INTO ledger_entries(entry_date, treasury_account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
          VALUES($1, $2, 'transfer', $3, $4, $5, 0, $6, $7, $8, $9) RETURNING *
        `, [dateStr, to_treasury_id, outEntry.id, description || `Virman <- ${fromAcc.name}`, targetAmt, toAcc.currency, rate, round4(targetAmt * rate), req.user.id])).rows[0];

        await client.query('UPDATE ledger_entries SET ref_id=$1 WHERE id=$2', [inEntry.id, outEntry.id]);

        await logActivity(req.user.id, 'Hesaplar Arası Virman Yapıldı', 'ledger', outEntry.id, { from: fromAcc.name, to: toAcc.name, amount: amt, target_amount: targetAmt }, req, client);
        return { out_entry: outEntry, in_entry: inEntry };
      });

      broadcast('accounting_update', { type: 'transfer' });
      res.json(result);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── 8. STORNO / İPTAL (DEĞİŞTİRİLEMEZ DEFTER — SİLME YOKTUR) ────────────
  app.post('/api/accounting/ledger/:id/void', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { reason } = req.body;
      await withTransaction(async (client) => {
        const entry = (await client.query('SELECT * FROM ledger_entries WHERE id=$1', [req.params.id])).rows[0];
        if (!entry) {
          const err = new Error('Defter kaydı bulunamadı');
          err.statusCode = 404;
          throw err;
        }
        if (entry.is_voided) return;
        await assertPeriodOpen(entry.entry_date, client);

        // Kaydı ve varsa eşleşen karşı ayağını (ref_id) storno/iptal et
        await client.query('UPDATE ledger_entries SET is_voided=TRUE, voided_by=$1 WHERE id=$2', [req.user.id, entry.id]);
        if (entry.ref_id && ['receipt', 'payment', 'transfer'].includes(entry.ref_type)) {
          await client.query('UPDATE ledger_entries SET is_voided=TRUE, voided_by=$1 WHERE id=$2', [req.user.id, entry.ref_id]);
        }

        await logActivity(req.user.id, 'Finansal Hareket İptal Edildi (Storno)', 'ledger', entry.id, { ref_type: entry.ref_type, reason: reason || '' }, req, client);
      });

      broadcast('accounting_update', { type: 'void', id: parseInt(req.params.id) });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
}

module.exports = { registerAccountingPhase2 };
