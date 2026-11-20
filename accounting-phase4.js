// accounting-phase4.js — Faz 4: Faturalar (KDV/Tevkifat + 3-Way Matching), Çek/Senet, Masraf/Avans & Vade Takvimi
const crypto = require('crypto');
const { query, withTransaction } = require('./db');
const { requireRoles, assertPeriodOpen } = require('./accounting');

function round4(val) {
  return Math.round((parseFloat(val) || 0) * 10000) / 10000;
}

// Tevkifat oranı çözücü (örn: '5/10' -> 0.5, '7/10' -> 0.7)
function parseWithholdingRatio(ratioStr) {
  if (!ratioStr || typeof ratioStr !== 'string') return 0;
  const parts = ratioStr.split('/');
  if (parts.length !== 2) return 0;
  const num = parseFloat(parts[0]);
  const den = parseFloat(parts[1]);
  if (!num || !den || den <= 0) return 0;
  return num / den;
}

function registerAccountingPhase4(app, { auth, logActivity, broadcast }) {

  // ── 1. FATURALAR (LİSTELEME + OLUŞTURMA + 3-WAY MATCHING + STORNO) ──────
  app.get('/api/accounting/invoices', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const { direction, account_id, payment_status, from, to } = req.query;
      const params = [];
      let where = 'WHERE 1=1';

      if (direction) { params.push(direction); where += ` AND i.direction = $${params.length}`; }
      if (account_id) { params.push(account_id); where += ` AND i.account_id = $${params.length}`; }
      if (payment_status) { params.push(payment_status); where += ` AND i.payment_status = $${params.length}`; }
      if (from) { params.push(from); where += ` AND i.invoice_date >= $${params.length}`; }
      if (to) { params.push(to); where += ` AND i.invoice_date <= $${params.length}`; }

      const rows = (await query(`
        SELECT i.*, a.name AS account_name, a.code AS account_code,
               po.po_no, w.waybill_no, m.machine_name
        FROM invoices i
        JOIN accounts a ON a.id = i.account_id
        LEFT JOIN purchase_orders po ON po.id = i.po_id
        LEFT JOIN waybills w ON w.id = i.waybill_id
        LEFT JOIN machines m ON m.id = i.machine_id
        ${where}
        ORDER BY i.invoice_date DESC, i.id DESC
        LIMIT 300
      `, params)).rows;

      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/accounting/invoices/:id', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const inv = (await query(`
        SELECT i.*, a.name AS account_name, a.tax_office, a.tax_no
        FROM invoices i
        JOIN accounts a ON a.id = i.account_id
        WHERE i.id = $1
      `, [req.params.id])).rows[0];
      if (!inv) return res.status(404).json({ error: 'Fatura bulunamadı' });
      const items = (await query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id ASC', [inv.id])).rows;
      res.json({ ...inv, items });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/accounting/invoices', auth, requireRoles('admin', 'accounting', 'purchasing'), async (req, res) => {
    try {
      const {
        invoice_no, ettn_uuid, gib_scenario, direction, account_id, waybill_id, po_id,
        machine_id, invoice_date, due_date, currency, fx_rate, attachment_url, notes, items
      } = req.body;

      if (!invoice_no || !direction || !account_id || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'Fatura no, yön, cari ve en az bir kalem zorunludur' });
      }
      if (!['purchase', 'sales', 'purchase_return', 'sales_return'].includes(direction)) {
        return res.status(400).json({ error: 'Geçersiz fatura yönü' });
      }

      const dateStr = invoice_date || new Date().toISOString().slice(0, 10);
      const cur = currency || 'TRY';
      const rate = parseFloat(fx_rate) || 1;
      const finalEttn = ettn_uuid || crypto.randomUUID();

      const result = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        // Vade tarihi verilmediyse cari kartın varsayılan vade gününü ekle
        let finalDue = due_date;
        if (!finalDue) {
          const acc = (await client.query('SELECT payment_term_days FROM accounts WHERE id=$1', [account_id])).rows[0];
          const d = new Date(dateStr);
          d.setDate(d.getDate() + (parseInt(acc?.payment_term_days) || 0));
          finalDue = d.toISOString().slice(0, 10);
        }

        // 3-Way Matching: Bağlı PO varsa birim fiyat sapması kontrolü
        let poItemsMap = {};
        if (po_id) {
          const piRows = (await client.query('SELECT product_id, unit_price FROM po_items WHERE po_id=$1', [po_id])).rows;
          piRows.forEach(p => { if (p.product_id) poItemsMap[p.product_id] = parseFloat(p.unit_price); });
        }

        let subtotal = 0, discountTotal = 0, vatTotal = 0, withholdingTotal = 0;
        let hasPriceVariance = false;
        const varianceDetails = [];

        const calcItems = items.map(it => {
          const qty = round4(it.quantity);
          const price = round4(it.unit_price);
          const d1 = parseFloat(it.discount1) || 0;
          const d2 = parseFloat(it.discount2) || 0;
          const vatRate = parseFloat(it.vat_rate ?? 20);
          const whRatio = parseWithholdingRatio(it.withholding_ratio);

          // 3-Way Matching fiyat farkı kontrolü (%0.5 tolerans üstü alarm)
          if (it.product_id && poItemsMap[it.product_id] !== undefined) {
            const poPrice = poItemsMap[it.product_id];
            if (Math.abs(price - poPrice) > Math.max(0.01, poPrice * 0.005)) {
              hasPriceVariance = true;
              varianceDetails.push({ product_id: it.product_id, po_price: poPrice, invoice_price: price });
            }
          }

          const gross = round4(qty * price);
          const afterD1 = round4(gross * (1 - d1 / 100));
          const net = round4(afterD1 * (1 - d2 / 100));
          const disc = round4(gross - net);
          const vat = round4(net * (vatRate / 100));
          const wh = round4(vat * whRatio);
          const lineTotal = round4(net + vat - wh);

          subtotal = round4(subtotal + net);
          discountTotal = round4(discountTotal + disc);
          vatTotal = round4(vatTotal + vat);
          withholdingTotal = round4(withholdingTotal + wh);

          return { ...it, qty, price, d1, d2, vatRate, lineTotal };
        });

        const grandTotal = round4(subtotal + vatTotal - withholdingTotal);
        const baseTry = round4(grandTotal * rate);

        const inv = (await client.query(`
          INSERT INTO invoices(
            invoice_no, ettn_uuid, gib_scenario, direction, account_id, waybill_id, po_id,
            machine_id, invoice_date, due_date, currency, fx_rate,
            subtotal, discount_total, vat_total, withholding_total, grand_total,
            has_price_variance, attachment_url, notes, created_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
          RETURNING *
        `, [
          invoice_no.trim(), finalEttn, gib_scenario || 'TICARIFATURA', direction, account_id,
          waybill_id || null, po_id || null, machine_id || null, dateStr, finalDue, cur, rate,
          subtotal, discountTotal, vatTotal, withholdingTotal, grandTotal,
          hasPriceVariance, attachment_url || null, notes || '', req.user.id
        ])).rows[0];

        for (const it of calcItems) {
          await client.query(`
            INSERT INTO invoice_items(
              invoice_id, product_id, description, quantity, unit, gib_unit_code,
              unit_price, discount1, discount2, vat_rate, withholding_ratio, line_total
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          `, [
            inv.id, it.product_id || null, it.description || 'Malzeme/Hizmet', it.qty,
            it.unit || 'adet', it.gib_unit_code || 'C62', it.price,
            it.d1, it.d2, it.vatRate, it.withholding_ratio || null, it.lineTotal
          ]);
        }

        // Bağlı irsaliyeyi faturalandı olarak işaretle
        if (waybill_id) {
          await client.query('UPDATE waybills SET is_invoiced=TRUE WHERE id=$1', [waybill_id]);
        }

        // Merkezi Deftere (ledger_entries) Cari Borç/Alacak yaz
        // Satış & Alış İade => Cari Borçlanır (debit) | Alış & Satış İade => Cari Alacaklanır (credit)
        const isDebit = direction === 'sales' || direction === 'purchase_return';
        await client.query(`
          INSERT INTO ledger_entries(
            entry_date, account_id, ref_type, ref_id, description,
            debit, credit, currency, fx_rate, base_try_amount, created_by
          ) VALUES($1,$2,'invoice',$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
          dateStr, account_id, inv.id,
          `${direction === 'sales' ? 'Satış' : direction === 'purchase' ? 'Alış' : 'İade'} Faturası: ${inv.invoice_no}`,
          isDebit ? grandTotal : 0,
          isDebit ? 0 : grandTotal,
          cur, rate, baseTry, req.user.id
        ]);

        // Eğer alış faturası bir vinç projesine (machine_id) bağlıysa proje maliyetine işle
        if (machine_id && direction === 'purchase') {
          const eurRow = (await client.query("SELECT selling FROM exchange_rates WHERE currency='EUR' ORDER BY rate_date DESC LIMIT 1")).rows[0];
          const eurRate = eurRow ? parseFloat(eurRow.selling) : 38;
          const netTry = round4(subtotal * rate);
          const netEur = cur === 'EUR' ? subtotal : round4(netTry / eurRate);
          await client.query(`
            INSERT INTO project_costs(machine_id, cost_type, ref_id, description, amount_try, amount_eur, cost_date)
            VALUES($1, 'invoice', $2, $3, $4, $5, $6)
          `, [machine_id, inv.id, `Alış Faturası: ${inv.invoice_no}`, netTry, netEur, dateStr]);
        }

        await logActivity(req.user.id, `Fatura Kaydedildi (${inv.invoice_no})`, 'invoice', inv.id, { direction, grandTotal, currency: cur, hasPriceVariance }, req, client);
        return { invoice: inv, price_variance_details: varianceDetails };
      });

      broadcast('accounting_update', { type: 'invoice_new', id: result.invoice.id, has_variance: result.invoice.has_price_variance });
      res.json(result);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Fatura İptali (Storno)
  app.post('/api/accounting/invoices/:id/void', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      await withTransaction(async (client) => {
        const inv = (await client.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
        if (!inv) { const err = new Error('Fatura bulunamadı'); err.statusCode = 404; throw err; }
        if (inv.is_voided) return;
        await assertPeriodOpen(inv.invoice_date, client);

        await client.query('UPDATE invoices SET is_voided=TRUE WHERE id=$1', [inv.id]);
        await client.query("UPDATE ledger_entries SET is_voided=TRUE, voided_by=$1 WHERE ref_type='invoice' AND ref_id=$2", [req.user.id, inv.id]);
        if (inv.waybill_id) {
          await client.query('UPDATE waybills SET is_invoiced=FALSE WHERE id=$1', [inv.waybill_id]);
        }
        await logActivity(req.user.id, `Fatura İptal Edildi (Storno: ${inv.invoice_no})`, 'invoice', inv.id, {}, req, client);
      });
      broadcast('accounting_update', { type: 'invoice_void', id: parseInt(req.params.id) });
      res.json({ ok: true });
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── 2. ÇEK & SENET PORTFÖYÜ + YAŞAM DÖNGÜSÜ ──────────────────────────────
  app.get('/api/accounting/cheques', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { status, direction } = req.query;
      const params = [];
      let where = 'WHERE 1=1';
      if (status) { params.push(status); where += ` AND c.status = $${params.length}`; }
      if (direction) { params.push(direction); where += ` AND c.direction = $${params.length}`; }

      const rows = (await query(`
        SELECT c.*, a.name AS account_name, ea.name AS endorsed_to_name, t.name AS treasury_name
        FROM cheques c
        JOIN accounts a ON a.id = c.account_id
        LEFT JOIN accounts ea ON ea.id = c.endorsed_to_account_id
        LEFT JOIN treasury_accounts t ON t.id = c.treasury_account_id
        ${where}
        ORDER BY c.due_date ASC, c.id DESC
      `, params)).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/accounting/cheques', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { doc_type, direction, doc_no, account_id, bank_name, branch_name, drawer_name, issue_date, due_date, amount, currency, fx_rate, notes } = req.body;
      const amt = round4(amount);
      if (!doc_no || !account_id || !due_date || !direction || amt <= 0) {
        return res.status(400).json({ error: 'Evrak no, yön, cari, vade tarihi ve tutar zorunludur' });
      }
      const dateStr = issue_date || new Date().toISOString().slice(0, 10);
      const cur = currency || 'TRY';
      const rate = parseFloat(fx_rate) || 1;
      const baseTry = round4(amt * rate);

      const cheque = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        const c = (await client.query(`
          INSERT INTO cheques(
            doc_type, direction, doc_no, account_id, bank_name, branch_name, drawer_name,
            issue_date, due_date, amount, currency, fx_rate, status, notes, created_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'portfolio',$13,$14) RETURNING *
        `, [
          doc_type || 'cheque', direction, doc_no.trim(), account_id, bank_name || '',
          branch_name || '', drawer_name || '', dateStr, due_date, amt, cur, rate, notes || '', req.user.id
        ])).rows[0];

        await client.query(
          'INSERT INTO cheque_history(cheque_id, old_status, new_status, note, created_by) VALUES($1, NULL, $2, $3, $4)',
          [c.id, 'portfolio', 'Portföye giriş', req.user.id]
        );

        // Müşteriden çek alındıysa cari alacaklanır; kendi çekimiz verildiyse tedarikçi borçlanır
        const isIssued = direction === 'issued';
        await client.query(`
          INSERT INTO ledger_entries(entry_date, account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
          VALUES($1,$2,'cheque',$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
          dateStr, account_id, c.id,
          `${doc_type === 'note' ? 'Senet' : 'Çek'} (${isIssued ? 'Verilen' : 'Alınan'}): ${c.doc_no} / Vade: ${due_date}`,
          isIssued ? amt : 0, isIssued ? 0 : amt, cur, rate, baseTry, req.user.id
        ]);

        await logActivity(req.user.id, `Çek/Senet Kaydedildi (${c.doc_no})`, 'cheque', c.id, { direction, amount: amt, due_date }, req, client);
        return c;
      });

      broadcast('accounting_update', { type: 'cheque_new', id: cheque.id });
      res.json(cheque);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Çek Durum Değişikliği: Ciro Etme (endorsed), Bankaya Tahsile (bank_collection), Tahsil/Ödendi (paid), Karşılıksız (bounced)
  app.post('/api/accounting/cheques/:id/status', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { new_status, target_account_id, treasury_account_id, entry_date, note } = req.body;
      if (!['endorsed', 'bank_collection', 'bank_collateral', 'paid', 'bounced', 'returned'].includes(new_status)) {
        return res.status(400).json({ error: 'Geçersiz çek durumu' });
      }
      const dateStr = entry_date || new Date().toISOString().slice(0, 10);

      const updated = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        const c = (await client.query('SELECT * FROM cheques WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
        if (!c) { const err = new Error('Çek/Senet bulunamadı'); err.statusCode = 404; throw err; }

        const amt = parseFloat(c.amount);
        const rate = parseFloat(c.fx_rate || 1);
        const baseTry = round4(amt * rate);

        // 1. Ciro Edildi -> Hedef tedarikçi borçlanır (borcumuz düşer)
        if (new_status === 'endorsed') {
          if (!target_account_id) throw new Error('Ciro edilecek tedarikçi cari seçilmelidir');
          await client.query(`
            INSERT INTO ledger_entries(entry_date, account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
            VALUES($1,$2,'cheque',$3,$4,$5,0,$6,$7,$8,$9)
          `, [dateStr, target_account_id, c.id, `Çek Cirosu: ${c.doc_no}`, amt, c.currency, rate, baseTry, req.user.id]);
        }

        // 2. Tahsil Edildi / Ödendi -> İlgili Banka/Kasa hareketi
        if (new_status === 'paid' && treasury_account_id) {
          const isIssued = c.direction === 'issued';
          await client.query(`
            INSERT INTO ledger_entries(entry_date, treasury_account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
            VALUES($1,$2,'cheque',$3,$4,$5,$6,$7,$8,$9,$10)
          `, [
            dateStr, treasury_account_id, c.id,
            `Çek ${isIssued ? 'Ödemesi' : 'Tahsili'}: ${c.doc_no}`,
            isIssued ? 0 : amt, isIssued ? amt : 0, c.currency, rate, baseTry, req.user.id
          ]);
        }

        // 3. Karşılıksız -> Müşteriyi tekrar borçlandır
        if (new_status === 'bounced' && c.direction === 'received') {
          await client.query(`
            INSERT INTO ledger_entries(entry_date, account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
            VALUES($1,$2,'cheque',$3,$4,$5,0,$6,$7,$8,$9)
          `, [dateStr, c.account_id, c.id, `Karşılıksız Çek İadesi: ${c.doc_no}`, amt, c.currency, rate, baseTry, req.user.id]);
        }

        const r = (await client.query(`
          UPDATE cheques
          SET status=$1,
              endorsed_to_account_id=COALESCE($2, endorsed_to_account_id),
              treasury_account_id=COALESCE($3, treasury_account_id)
          WHERE id=$4 RETURNING *
        `, [new_status, target_account_id || null, treasury_account_id || null, c.id])).rows[0];

        await client.query(
          'INSERT INTO cheque_history(cheque_id, old_status, new_status, target_account_id, treasury_account_id, note, created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [c.id, c.status, new_status, target_account_id || null, treasury_account_id || null, note || '', req.user.id]
        );

        await logActivity(req.user.id, `Çek Durumu Güncellendi (${c.doc_no}: ${new_status})`, 'cheque', c.id, { old: c.status, new_status }, req, client);
        return r;
      });

      broadcast('accounting_update', { type: 'cheque_status', id: updated.id, status: new_status });
      res.json(updated);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── 3. MASRAFLAR, ŞANTİYE HARCIRAHI & PERSONEL AVANS ────────────────────
  app.get('/api/accounting/expenses', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const rows = (await query(`
        SELECT e.*, m.machine_name, u.display_name AS staff_name, t.name AS treasury_name
        FROM expenses e
        LEFT JOIN machines m ON m.id = e.machine_id
        LEFT JOIN users u ON u.id = e.user_id
        LEFT JOIN treasury_accounts t ON t.id = e.treasury_account_id
        ORDER BY e.expense_date DESC, e.id DESC
        LIMIT 300
      `)).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/accounting/expenses', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { expense_date, category, cost_center, machine_id, user_id, treasury_account_id, amount, currency, fx_rate, description, attachment_url } = req.body;
      const amt = round4(amount);
      if (!category || amt <= 0) return res.status(400).json({ error: 'Masraf kategorisi ve geçerli tutar zorunludur' });

      const dateStr = expense_date || new Date().toISOString().slice(0, 10);
      const cur = currency || 'TRY';
      const rate = parseFloat(fx_rate) || 1;
      const baseTry = round4(amt * rate);

      const exp = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        const r = (await client.query(`
          INSERT INTO expenses(
            expense_date, category, cost_center, machine_id, user_id, treasury_account_id,
            amount, currency, fx_rate, description, attachment_url, created_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
        `, [
          dateStr, category, cost_center || 'Atölye', machine_id || null, user_id || null,
          treasury_account_id || null, amt, cur, rate, description || '', attachment_url || null, req.user.id
        ])).rows[0];

        // Kasa/Bankadan ödendiyse deftere çıkış yaz
        if (treasury_account_id) {
          await client.query(`
            INSERT INTO ledger_entries(entry_date, treasury_account_id, ref_type, ref_id, description, debit, credit, currency, fx_rate, base_try_amount, created_by)
            VALUES($1,$2,'expense',$3,$4,0,$5,$6,$7,$8,$9)
          `, [dateStr, treasury_account_id, r.id, `Masraf (${category}): ${description || ''}`, amt, cur, rate, baseTry, req.user.id]);
        }

        // Vinç projesine bağlıysa proje maliyetine işle
        if (machine_id) {
          const eurRow = (await client.query("SELECT selling FROM exchange_rates WHERE currency='EUR' ORDER BY rate_date DESC LIMIT 1")).rows[0];
          const eurRate = eurRow ? parseFloat(eurRow.selling) : 38;
          const amtEur = cur === 'EUR' ? amt : round4(baseTry / eurRate);
          await client.query(`
            INSERT INTO project_costs(machine_id, cost_type, ref_id, description, amount_try, amount_eur, cost_date)
            VALUES($1, 'expense', $2, $3, $4, $5, $6)
          `, [machine_id, r.id, `${category}: ${description || ''}`, baseTry, amtEur, dateStr]);
        }

        await logActivity(req.user.id, `Masraf Kaydedildi (${category})`, 'expense', r.id, { amount: amt, currency: cur, machine_id }, req, client);
        return r;
      });

      broadcast('accounting_update', { type: 'expense_new', id: exp.id });
      res.json(exp);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // ── 4. VADE & NAKİT AKIŞI TAKVİMİ (GELECEK TAHSİLAT / ÖDEME PROJEKSİYONU) ─
  app.get('/api/accounting/cashflow-calendar', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 45;

      // Ödenmemiş faturalar
      const invs = (await query(`
        SELECT i.id, i.invoice_no AS ref_no, i.direction, i.due_date,
               (i.grand_total - i.paid_amount) AS remaining, i.currency, a.name AS account_name
        FROM invoices i
        JOIN accounts a ON a.id = i.account_id
        WHERE i.is_voided = FALSE AND i.payment_status != 'paid'
          AND i.due_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
        ORDER BY i.due_date ASC
      `, [days])).rows;

      // Portföyde / Tahsilde bekleyen çek & senetler
      const chqs = (await query(`
        SELECT c.id, c.doc_no AS ref_no, c.direction, c.due_date, c.amount AS remaining,
               c.currency, c.status, a.name AS account_name
        FROM cheques c
        JOIN accounts a ON a.id = c.account_id
        WHERE c.status IN ('portfolio', 'bank_collection', 'bank_collateral')
          AND c.due_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL
        ORDER BY c.due_date ASC
      `, [days])).rows;

      const timeline = [
        ...invs.map(i => ({
          type: 'invoice',
          flow: i.direction === 'sales' ? 'inflow' : 'outflow',
          due_date: i.due_date,
          ref_no: i.ref_no,
          account_name: i.account_name,
          amount: parseFloat(i.remaining),
          currency: i.currency
        })),
        ...chqs.map(c => ({
          type: 'cheque',
          flow: c.direction === 'received' ? 'inflow' : 'outflow',
          due_date: c.due_date,
          ref_no: c.ref_no,
          account_name: c.account_name,
          amount: parseFloat(c.remaining),
          currency: c.currency,
          status: c.status
        }))
      ].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

      res.json({ days, count: timeline.length, timeline });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { registerAccountingPhase4 };
