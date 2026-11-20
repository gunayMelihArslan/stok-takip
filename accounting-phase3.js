// accounting-phase3.js — Faz 3: BOM İhtiyaç Patlatma, RFQ Teklif, PO Sipariş + PDF, Fiyatsız Mal Kabul & Ağırlıklı Ortalama Maliyet
const { query, withTransaction } = require('./db');
const { requireRoles, assertPeriodOpen } = require('./accounting');

const PO_APPROVAL_LIMIT_TRY = parseFloat(process.env.PO_APPROVAL_LIMIT_TRY || '25000');

function round4(val) {
  return Math.round((parseFloat(val) || 0) * 10000) / 10000;
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getStockCols(client = null) {
  const qFunc = client ? client.query.bind(client) : query;
  const cols = (await qFunc('SELECT * FROM column_defs ORDER BY display_order ASC, id ASC')).rows;
  const firstCol = cols[0] || null;
  const numCol = cols.find(c => c.data_type === 'number') || null;
  const unitCol = cols.find(c => (c.name || '').toLowerCase().includes('birim')) || null;
  return { firstCol, numCol, unitCol };
}

// Ağırlıklı ortalama maliyet (TL & EUR) + stok artışı
async function applyReceiptToStockAndCost(productId, receivedQty, unitPriceTry, unitPriceEur, client) {
  const { numCol } = await getStockCols(client);
  if (!numCol || !productId || receivedQty <= 0) return;

  const prodRes = await client.query(
    'SELECT "values", COALESCE(avg_cost_try, 0) AS avg_cost_try, COALESCE(avg_cost_eur, 0) AS avg_cost_eur FROM products WHERE id=$1 FOR UPDATE',
    [productId]
  );
  if (!prodRes.rows[0]) return;

  const vals = prodRes.rows[0].values || {};
  const oldQty = Math.max(0, parseFloat(vals[numCol.id] || 0));
  const oldAvgTry = parseFloat(prodRes.rows[0].avg_cost_try || 0);
  const oldAvgEur = parseFloat(prodRes.rows[0].avg_cost_eur || 0);
  const newQty = round4(oldQty + receivedQty);

  let newAvgTry = oldAvgTry;
  let newAvgEur = oldAvgEur;
  if (newQty > 0 && unitPriceTry > 0) {
    newAvgTry = round4(((oldQty * oldAvgTry) + (receivedQty * unitPriceTry)) / newQty);
  }
  if (newQty > 0 && unitPriceEur > 0) {
    newAvgEur = round4(((oldQty * oldAvgEur) + (receivedQty * unitPriceEur)) / newQty);
  }

  vals[numCol.id] = String(newQty);
  await client.query(
    'UPDATE products SET "values"=$1, avg_cost_try=$2, avg_cost_eur=$3, updated_at=NOW() WHERE id=$4',
    [JSON.stringify(vals), newAvgTry, newAvgEur, productId]
  );
}

function registerAccountingPhase3(app, { auth, logActivity, broadcast }) {

  // ── 1. BOM'DAN OTOMATİK İHTİYAÇ PATLATMA (EKSİK MALZEME ANALİZİ) ────────
  app.get('/api/purchasing/bom-shortage/:machine_id', auth, requireRoles('admin', 'purchasing', 'warehouse', 'accounting'), async (req, res) => {
    try {
      const m = (await query('SELECT * FROM machines WHERE id=$1', [req.params.machine_id])).rows[0];
      if (!m) return res.status(404).json({ error: 'Vinç reçetesi bulunamadı' });

      const { firstCol, numCol, unitCol } = await getStockCols();
      const items = m.items || [];
      const results = [];

      for (const it of items) {
        const pid = Number(it.product_id);
        const reqQty = parseFloat(it.quantity || 0);
        if (!pid || reqQty <= 0) continue;

        const p = (await query('SELECT id, "values", avg_cost_try, avg_cost_eur FROM products WHERE id=$1', [pid])).rows[0];
        const stockQty = (p && numCol) ? parseFloat(p.values?.[numCol.id] || 0) : 0;

        // Açık siparişlerde (onaylı/kısmi) bekleyen miktar
        const openPoRes = await query(`
          SELECT COALESCE(SUM(pi.ordered_qty - pi.received_qty), 0) AS pending_qty
          FROM po_items pi
          JOIN purchase_orders po ON po.id = pi.po_id
          WHERE pi.product_id = $1 AND po.status IN ('approved', 'partial')
        `, [pid]);
        const openPoQty = parseFloat(openPoRes.rows[0].pending_qty || 0);

        const shortage = Math.max(0, round4(reqQty - stockQty - openPoQty));
        results.push({
          product_id: pid,
          product_name: (p && firstCol) ? (p.values?.[firstCol.id] || `Ürün #${pid}`) : (it.product_name || `Ürün #${pid}`),
          unit: (p && unitCol) ? (p.values?.[unitCol.id] || 'adet') : 'adet',
          required_qty: reqQty,
          stock_qty: stockQty,
          open_po_qty: openPoQty,
          shortage_qty: shortage
        });
      }

      res.json({
        machine_id: m.id,
        machine_name: m.machine_name,
        items: results,
        shortage_count: results.filter(r => r.shortage_qty > 0).length
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Eksik malzemeleri tek tıkla purchase_requests tablosuna talep olarak patlat
  app.post('/api/purchasing/bom-shortage/:machine_id/create-requests', auth, requireRoles('admin', 'purchasing', 'warehouse'), async (req, res) => {
    try {
      const m = (await query('SELECT * FROM machines WHERE id=$1', [req.params.machine_id])).rows[0];
      if (!m) return res.status(404).json({ error: 'Vinç bulunamadı' });

      const { items } = req.body; // [{ product_id, product_name, shortage_qty, unit }]
      if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Talep edilecek eksik kalem yok' });

      const taskRow = (await query('SELECT id FROM tasks WHERE machine_id=$1 ORDER BY created_at DESC LIMIT 1', [m.id])).rows[0];
      const created = [];

      await withTransaction(async (client) => {
        for (const it of items) {
          const qty = parseFloat(it.shortage_qty || it.quantity || 0);
          if (qty <= 0) continue;
          const r = (await client.query(`
            INSERT INTO purchase_requests(requested_by, product_name, quantity, unit, reason, task_id, product_values, status)
            VALUES($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING *
          `, [
            req.user.id,
            it.product_name,
            qty,
            it.unit || 'adet',
            `BOM Eksik Patlatma: ${m.machine_name}`,
            taskRow?.id || null,
            JSON.stringify({ product_id: it.product_id, machine_id: m.id })
          ])).rows[0];
          created.push(r);
        }
        await logActivity(req.user.id, 'BOM Eksiklerinden Toplu Satınalma Talebi Açıldı', 'machine', m.id, { count: created.length }, req, client);
      });

      broadcast('purchase_new', { count: created.length });
      res.json({ created_count: created.length, requests: created });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 2. TEKLİF KIYASLAMA (RFQ) & FİYAT SAPMA ANALİZİ ─────────────────────
  app.get('/api/purchasing/rfq', auth, requireRoles('admin', 'purchasing', 'accounting'), async (req, res) => {
    try {
      const { purchase_request_id } = req.query;
      const params = [];
      let where = 'WHERE 1=1';
      if (purchase_request_id) {
        params.push(purchase_request_id);
        where += ` AND q.purchase_request_id = $${params.length}`;
      }
      const rows = (await query(`
        SELECT q.*, a.name AS supplier_name, a.code AS supplier_code
        FROM rfq_quotes q
        JOIN accounts a ON a.id = q.account_id
        ${where}
        ORDER BY q.created_at DESC
      `, params)).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/purchasing/rfq', auth, requireRoles('admin', 'purchasing'), async (req, res) => {
    try {
      const { purchase_request_id, account_id, product_id, product_name, quantity, unit_price, discount_rate, vat_rate, currency, delivery_days, notes } = req.body;
      if (!account_id || !quantity || unit_price === undefined) {
        return res.status(400).json({ error: 'Tedarikçi, miktar ve birim fiyat zorunludur' });
      }

      // Geçmiş son alış fiyatıyla sapma kontrolü
      let lastPrice = null;
      let variancePct = null;
      if (product_id) {
        const prev = (await query(`
          SELECT pi.unit_price, po.currency
          FROM po_items pi
          JOIN purchase_orders po ON po.id = pi.po_id
          WHERE pi.product_id = $1 AND po.status IN ('approved', 'partial', 'completed') AND po.currency = $2
          ORDER BY po.order_date DESC, po.id DESC LIMIT 1
        `, [product_id, currency || 'TRY'])).rows[0];
        if (prev && parseFloat(prev.unit_price) > 0) {
          lastPrice = parseFloat(prev.unit_price);
          variancePct = round4(((parseFloat(unit_price) - lastPrice) / lastPrice) * 100);
        }
      }

      const r = (await query(`
        INSERT INTO rfq_quotes(
          purchase_request_id, account_id, product_id, product_name, quantity,
          unit_price, discount_rate, vat_rate, currency, delivery_days, notes, created_by
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
      `, [
        purchase_request_id || null, account_id, product_id || null, product_name || '',
        round4(quantity), round4(unit_price), parseFloat(discount_rate) || 0,
        parseFloat(vat_rate ?? 20), currency || 'TRY', parseInt(delivery_days) || 0,
        notes || '', req.user.id
      ])).rows[0];

      res.json({ quote: r, last_price: lastPrice, variance_pct: variancePct });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 3. SATIN ALMA SİPARİŞLERİ (PO) + BÜTÇE ONAY LİMİTİ ──────────────────
  app.get('/api/purchasing/orders', auth, requireRoles('admin', 'purchasing', 'accounting', 'warehouse'), async (req, res) => {
    try {
      const { status, account_id } = req.query;
      const isWarehouse = req.user.role === 'warehouse';
      const params = [];
      let where = 'WHERE 1=1';
      if (status) { params.push(status); where += ` AND po.status = $${params.length}`; }
      if (account_id) { params.push(account_id); where += ` AND po.account_id = $${params.length}`; }

      const orders = (await query(`
        SELECT po.*, a.name AS supplier_name, a.code AS supplier_code,
               m.machine_name, u.display_name AS created_by_name
        FROM purchase_orders po
        JOIN accounts a ON a.id = po.account_id
        LEFT JOIN machines m ON m.id = po.machine_id
        LEFT JOIN users u ON u.id = po.created_by
        ${where}
        ORDER BY po.created_at DESC
      `, params)).rows;

      const enriched = await Promise.all(orders.map(async (po) => {
        const items = (await query('SELECT * FROM po_items WHERE po_id=$1 ORDER BY id ASC', [po.id])).rows;
        // Depocu fiyat ve tutar bilgilerini göremez
        if (isWarehouse) {
          return {
            id: po.id, po_no: po.po_no, supplier_name: po.supplier_name, machine_name: po.machine_name,
            order_date: po.order_date, expected_date: po.expected_date, status: po.status, notes: po.notes,
            items: items.map(it => ({
              id: it.id, product_id: it.product_id, description: it.description,
              unit: it.unit, ordered_qty: it.ordered_qty, received_qty: it.received_qty
            }))
          };
        }
        return { ...po, items };
      }));

      res.json(enriched);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/purchasing/orders', auth, requireRoles('admin', 'purchasing'), async (req, res) => {
    try {
      const { account_id, machine_id, order_date, expected_date, currency, fx_rate, notes, items, purchase_request_ids } = req.body;
      if (!account_id || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'Tedarikçi ve en az bir sipariş kalemi zorunludur' });
      }
      const dateStr = order_date || new Date().toISOString().slice(0, 10);
      const cur = currency || 'TRY';
      const rate = parseFloat(fx_rate) || 1;

      const createdPo = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        const year = new Date(dateStr).getFullYear();
        const seq = parseInt((await client.query('SELECT COALESCE(MAX(id),0) as m FROM purchase_orders')).rows[0].m) + 1;
        const poNo = `PO-${year}-${String(seq).padStart(4, '0')}`;

        let subtotal = 0, discountTotal = 0, vatTotal = 0;
        const calcItems = items.map(it => {
          const qty = round4(it.ordered_qty || it.quantity);
          const price = round4(it.unit_price);
          const discRate = parseFloat(it.discount_rate) || 0;
          const vatRate = parseFloat(it.vat_rate ?? 20);
          const gross = round4(qty * price);
          const disc = round4(gross * (discRate / 100));
          const net = round4(gross - disc);
          const vat = round4(net * (vatRate / 100));
          subtotal = round4(subtotal + net);
          discountTotal = round4(discountTotal + disc);
          vatTotal = round4(vatTotal + vat);
          return { ...it, qty, price, discRate, vatRate, lineTotal: round4(net + vat) };
        });

        const grandTotal = round4(subtotal + vatTotal);
        const grandTotalTry = round4(grandTotal * rate);

        // Bütçe onay limiti: Admin doğrudan onaylar; Satınalma limit üstündeyse yönetici onayına düşer
        const isAutoApproved = req.user.role === 'admin' || grandTotalTry <= PO_APPROVAL_LIMIT_TRY;
        const status = isAutoApproved ? 'approved' : 'pending_approval';

        const po = (await client.query(`
          INSERT INTO purchase_orders(
            po_no, account_id, machine_id, order_date, expected_date, currency, fx_rate,
            subtotal, discount_total, vat_total, grand_total, status, notes,
            created_by, approved_by, approved_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
        `, [
          poNo, account_id, machine_id || null, dateStr, expected_date || null, cur, rate,
          subtotal, discountTotal, vatTotal, grandTotal, status, notes || '',
          req.user.id, isAutoApproved ? req.user.id : null, isAutoApproved ? new Date() : null
        ])).rows[0];

        for (const it of calcItems) {
          await client.query(`
            INSERT INTO po_items(po_id, product_id, description, unit, ordered_qty, unit_price, discount_rate, vat_rate, line_total)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `, [po.id, it.product_id || null, it.description || 'Malzeme', it.unit || 'adet', it.qty, it.price, it.discRate, it.vatRate, it.lineTotal]);
        }

        if (Array.isArray(purchase_request_ids) && purchase_request_ids.length) {
          for (const reqId of purchase_request_ids) {
            await client.query(`
              UPDATE purchase_requests
              SET status = 'ordered',
                  admin_note = CASE
                    WHEN COALESCE(admin_note, '') = '' THEN $1
                    ELSE admin_note || ' | ' || $1
                  END,
                  product_values = COALESCE(product_values, '{}'::jsonb) || jsonb_build_object('po_id', $2::int, 'po_no', $3::text),
                  updated_at = NOW()
              WHERE id = $4
            `, [`Resmi PO: ${poNo}`, po.id, poNo, Number(reqId)]);
          }
        }

        await logActivity(req.user.id, `Satınalma Siparişi Oluşturuldu (${poNo})`, 'purchase_order', po.id, { grandTotal, currency: cur, status }, req, client);
        return po;
      });

      broadcast('purchase_new', { po_no: createdPo.po_no, status: createdPo.status });
      res.json(createdPo);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // Yönetici PO Onayı / İptali
  app.post('/api/purchasing/orders/:id/approve', auth, requireRoles('admin'), async (req, res) => {
    try {
      const { approve } = req.body;
      const newStatus = approve === false ? 'cancelled' : 'approved';
      const r = (await query(
        'UPDATE purchase_orders SET status=$1, approved_by=$2, approved_at=NOW(), updated_at=NOW() WHERE id=$3 RETURNING *',
        [newStatus, req.user.id, req.params.id]
      )).rows[0];
      if (!r) return res.status(404).json({ error: 'Sipariş bulunamadı' });
      await logActivity(req.user.id, `Sipariş ${newStatus === 'approved' ? 'Onaylandı' : 'İptal Edildi'} (${r.po_no})`, 'purchase_order', r.id, {}, req);
      broadcast('purchase_new', { po_no: r.po_no, status: newStatus });
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 4. LOGOLU YAZDIRILABİLİR / PDF SİPARİŞ FORMU (PO PRINT) ─────────────
  app.get('/po/:id/print', auth, requireRoles('admin', 'purchasing', 'accounting'), async (req, res) => {
    try {
      const po = (await query(`
        SELECT po.*, a.name AS supplier_name, a.tax_office, a.tax_no, a.address AS supplier_address,
               a.phone AS supplier_phone, a.email AS supplier_email, a.contact_name
        FROM purchase_orders po
        JOIN accounts a ON a.id = po.account_id
        WHERE po.id = $1
      `, [req.params.id])).rows[0];
      if (!po) return res.status(404).send('Sipariş bulunamadı');

      const items = (await query('SELECT * FROM po_items WHERE po_id=$1 ORDER BY id ASC', [po.id])).rows;
      const rowsHtml = items.map((it, i) => `
        <tr>
          <td style="text-align:center">${i + 1}</td>
          <td>${escHtml(it.description)}</td>
          <td style="text-align:center">${parseFloat(it.ordered_qty)} ${escHtml(it.unit)}</td>
          <td style="text-align:right">${parseFloat(it.unit_price).toFixed(2)} ${escHtml(po.currency)}</td>
          <td style="text-align:center">%${parseFloat(it.discount_rate || 0)}</td>
          <td style="text-align:center">%${parseFloat(it.vat_rate || 0)}</td>
          <td style="text-align:right;font-weight:700">${parseFloat(it.line_total).toFixed(2)} ${escHtml(po.currency)}</td>
        </tr>
      `).join('');

      res.send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><title>Sipariş Formu — ${escHtml(po.po_no)}</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; font-size: 12px; margin: 0; }
  .bar { background: #1a6b56; color: #fff; padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; }
  .bar button { background: #fff; color: #1a6b56; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 700; cursor: pointer; }
  .page { max-width: 820px; margin: 20px auto; padding: 0 16px; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2.5px solid #1a6b56; padding-bottom: 12px; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .box { border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 12px; background: #f9fafb; }
  .box h4 { margin: 0 0 6px; color: #1a6b56; font-size: 11px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #1a6b56; color: #fff; padding: 8px; font-size: 11px; text-align: left; }
  td { border: 1px solid #d1d5db; padding: 7px 8px; }
  .totals { width: 280px; margin-left: auto; margin-top: 14px; }
  .totals td { border: none; border-bottom: 1px solid #e5e7eb; padding: 5px 4px; }
  @media print { .bar { display: none; } .page { margin: 0; padding: 0; } }
</style></head><body>
  <div class="bar">
    <span>📄 Resmi Satınalma Sipariş Formu — ${escHtml(po.po_no)}</span>
    <button onclick="window.print()">🖨️ Yazdır / PDF Kaydet</button>
  </div>
  <div class="page">
    <div class="head">
      <div>
        <img src="/logo.png" style="height:42px" onerror="this.style.display='none'">
        <div style="font-weight:800;font-size:15px;margin-top:4px">SEKİZLİ MAKİNA &amp; VİNÇ SAN. TİC. A.Ş.</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:18px;font-weight:900;color:#1a6b56">SİPARİŞ FORMU</div>
        <div style="font-family:monospace;font-size:13px;font-weight:700">${escHtml(po.po_no)}</div>
        <div style="font-size:11px;color:#555">Tarih: ${String(po.order_date).slice(0,10)}</div>
      </div>
    </div>
    <div class="grid">
      <div class="box">
        <h4>Tedarikçi Bilgileri</h4>
        <div><strong>${escHtml(po.supplier_name)}</strong></div>
        <div>Vergi: ${escHtml(po.tax_office)} / ${escHtml(po.tax_no)}</div>
        <div>Yetkili: ${escHtml(po.contact_name)} · ${escHtml(po.supplier_phone)}</div>
        <div>${escHtml(po.supplier_address)}</div>
      </div>
      <div class="box">
        <h4>Sipariş Koşulları</h4>
        <div>Para Birimi: <strong>${escHtml(po.currency)}</strong> (Kur: ${parseFloat(po.fx_rate).toFixed(4)})</div>
        <div>Beklenen Termin: <strong>${po.expected_date ? String(po.expected_date).slice(0,10) : 'En Kısa Sürede'}</strong></div>
        <div>Durum: <strong>${escHtml(po.status.toUpperCase())}</strong></div>
        <div>Not: ${escHtml(po.notes || '—')}</div>
      </div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Malzeme / Açıklama</th><th>Miktar</th><th>Birim Fiyat</th><th>İsk.</th><th>KDV</th><th>Tutar</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <table class="totals">
      <tr><td>Ara Toplam:</td><td style="text-align:right">${parseFloat(po.subtotal).toFixed(2)} ${escHtml(po.currency)}</td></tr>
      <tr><td>KDV Toplam:</td><td style="text-align:right">${parseFloat(po.vat_total).toFixed(2)} ${escHtml(po.currency)}</td></tr>
      <tr style="font-size:14px;font-weight:900;color:#1a6b56"><td>GENEL TOPLAM:</td><td style="text-align:right">${parseFloat(po.grand_total).toFixed(2)} ${escHtml(po.currency)}</td></tr>
    </table>
  </div>
</body></html>`);
    } catch (e) { res.status(500).send('PO Print Hatası: ' + e.message); }
  });

  // ── 5. DEPO MAL KABUL & İRSALİYE (KISMİ TESLİMAT + STOK & MALİYET ARTIŞI) ─
  app.get('/api/warehouse/waybills', auth, requireRoles('admin', 'warehouse', 'purchasing', 'accounting'), async (req, res) => {
    try {
      const rows = (await query(`
        SELECT w.*, a.name AS account_name, po.po_no, u.display_name AS received_by_name
        FROM waybills w
        LEFT JOIN accounts a ON a.id = w.account_id
        LEFT JOIN purchase_orders po ON po.id = w.po_id
        LEFT JOIN users u ON u.id = w.received_by
        ORDER BY w.waybill_date DESC, w.id DESC
        LIMIT 200
      `)).rows;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/warehouse/waybills/receive', auth, requireRoles('admin', 'warehouse', 'purchasing'), async (req, res) => {
    try {
      const { waybill_no, po_id, account_id, waybill_date, attachment_url, quality_note, items } = req.body;
      if (!waybill_no || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'İrsaliye numarası ve teslim alınan kalemler zorunludur' });
      }
      const dateStr = waybill_date || new Date().toISOString().slice(0, 10);

      const result = await withTransaction(async (client) => {
        await assertPeriodOpen(dateStr, client);

        let po = null;
        if (po_id) {
          po = (await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [po_id])).rows[0];
          if (!po) throw new Error('Bağlı sipariş (PO) bulunamadı');
        }

        // Güncel EUR kuru (TL -> EUR maliyet çevrimi için)
        const eurRow = (await client.query("SELECT selling FROM exchange_rates WHERE currency='EUR' ORDER BY rate_date DESC LIMIT 1")).rows[0];
        const eurRate = eurRow ? parseFloat(eurRow.selling) : 38;

        const wb = (await client.query(`
          INSERT INTO waybills(waybill_no, direction, account_id, po_id, machine_id, waybill_date, attachment_url, quality_note, received_by)
          VALUES($1, 'in', $2, $3, $4, $5, $6, $7, $8) RETURNING *
        `, [
          waybill_no.trim(),
          account_id || po?.account_id || null,
          po?.id || null,
          po?.machine_id || null,
          dateStr,
          attachment_url || null,
          quality_note || '',
          req.user.id
        ])).rows[0];

        for (const it of items) {
          const qty = round4(it.quantity);
          if (qty <= 0) continue;

          let unitPriceTry = 0;
          let unitPriceEur = 0;
          let pid = it.product_id || null;

          if (it.po_item_id && po) {
            const pi = (await client.query('SELECT * FROM po_items WHERE id=$1 FOR UPDATE', [it.po_item_id])).rows[0];
            if (pi) {
              pid = pid || pi.product_id;
              await client.query('UPDATE po_items SET received_qty = received_qty + $1 WHERE id=$2', [qty, pi.id]);
              const netUnit = parseFloat(pi.unit_price) * (1 - (parseFloat(pi.discount_rate || 0) / 100));
              const fx = parseFloat(po.fx_rate || 1);
              unitPriceTry = po.currency === 'TRY' ? netUnit : round4(netUnit * fx);
              unitPriceEur = po.currency === 'EUR' ? netUnit : round4(unitPriceTry / eurRate);
            }
          }

          await client.query(`
            INSERT INTO waybill_items(waybill_id, po_item_id, product_id, description, quantity, unit)
            VALUES($1, $2, $3, $4, $5, $6)
          `, [wb.id, it.po_item_id || null, pid, it.description || '', qty, it.unit || 'adet']);

          // Stok + Ağırlıklı Ortalama Maliyet güncelle
          if (pid) {
            await applyReceiptToStockAndCost(pid, qty, unitPriceTry, unitPriceEur, client);
          }
        }

        // PO durumunu kısmi (partial) veya tamamlandı (completed) yap
        if (po) {
          const rem = (await client.query('SELECT COUNT(*) as c FROM po_items WHERE po_id=$1 AND received_qty < ordered_qty', [po.id])).rows[0];
          const newPoStatus = parseInt(rem.c) === 0 ? 'completed' : 'partial';
          await client.query('UPDATE purchase_orders SET status=$1, updated_at=NOW() WHERE id=$2', [newPoStatus, po.id]);
          // PO tamamlandıysa bağlı satınalma taleplerini otomatik 'received' yap
          if (newPoStatus === 'completed') {
            await client.query(`
              UPDATE purchase_requests
              SET status = 'received', updated_at = NOW()
              WHERE product_values->>'po_id' = $1::text AND status != 'received'
            `, [String(po.id)]);
          }
        }

        await logActivity(req.user.id, `İrsaliye ile Mal Kabul Yapıldı (${waybill_no})`, 'waybill', wb.id, { po_id: po?.id || null, itemCount: items.length }, req, client);
        return wb;
      });

      broadcast('stock_update', {});
      broadcast('purchase_new', { waybill_no: result.waybill_no });
      res.json(result);
    } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });
}

module.exports = { registerAccountingPhase3 };
