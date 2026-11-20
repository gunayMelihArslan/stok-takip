// accounting-phase5.js — Faz 5: Proje (Vinç) Kârlılığı, Kur Farkı, Mali Müşavir Paketleri & PDF Mutabakat
const { query } = require('./db');
const { requireRoles } = require('./accounting');

function round4(val) {
  return Math.round((parseFloat(val) || 0) * 10000) / 10000;
}

function escCsv(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function registerAccountingPhase5(app, { auth }) {

  // ── 1. VİNÇ (PROJE) BAZLI NET KÂRLILIK RAPORU ───────────────────────────
  app.get('/api/accounting/reports/project-profitability', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { machine_id } = req.query;
      const params = [];
      let where = 'WHERE 1=1';
      if (machine_id) {
        params.push(machine_id);
        where += ` AND m.id = $${params.length}`;
      }

      const eurRow = (await query("SELECT selling FROM exchange_rates WHERE currency='EUR' ORDER BY rate_date DESC LIMIT 1")).rows[0];
      const eurRate = eurRow ? parseFloat(eurRow.selling) : 38;

      const machines = (await query(`
        SELECT m.id, m.machine_name, m.capacity, m.passport_code, m.items, m.created_at, f.name AS firm_name
        FROM machines m
        LEFT JOIN firms f ON f.id = m.firm_id
        ${where}
        ORDER BY m.created_at DESC
        LIMIT 100
      `, params)).rows;

      const report = await Promise.all(machines.map(async (m) => {
        // 1. BOM Malzeme Maliyeti (Depodan çıkan veya reçetedeki ürünlerin ağırlıklı ortalama maliyeti)
        let bomCostTry = 0;
        let bomCostEur = 0;
        const bomItems = m.items || [];
        if (bomItems.length) {
          const pids = bomItems.map(it => Number(it.product_id)).filter(Boolean);
          if (pids.length) {
            const pRows = (await query(
              'SELECT id, COALESCE(avg_cost_try,0) AS avg_cost_try, COALESCE(avg_cost_eur,0) AS avg_cost_eur FROM products WHERE id = ANY($1)',
              [pids]
            )).rows;
            const pMap = {};
            pRows.forEach(p => { pMap[p.id] = p; });
            bomItems.forEach(it => {
              const p = pMap[Number(it.product_id)];
              const qty = parseFloat(it.quantity || 0);
              if (p && qty > 0) {
                bomCostTry = round4(bomCostTry + qty * parseFloat(p.avg_cost_try || 0));
                bomCostEur = round4(bomCostEur + qty * parseFloat(p.avg_cost_eur || 0));
              }
            });
          }
        }

        // 2. Doğrudan Projeye İşlenen Maliyetler (Alış Faturaları + Şantiye/Nakliye Masrafları)
        const pcRes = await query(`
          SELECT COALESCE(SUM(amount_try), 0) AS extra_try,
                 COALESCE(SUM(amount_eur), 0) AS extra_eur
          FROM project_costs
          WHERE machine_id = $1
        `, [m.id]);
        const extraCostTry = round4(pcRes.rows[0].extra_try);
        const extraCostEur = round4(pcRes.rows[0].extra_eur);

        // 3. Projeye Kesilen Satış Faturaları (KDV Hariç Net Gelir)
        const revRes = await query(`
          SELECT COALESCE(SUM(subtotal * fx_rate), 0) AS revenue_try
          FROM invoices
          WHERE machine_id = $1 AND direction = 'sales' AND is_voided = FALSE
        `, [m.id]);
        const revenueTry = round4(revRes.rows[0].revenue_try);
        const revenueEur = round4(revenueTry / eurRate);

        const totalCostTry = round4(bomCostTry + extraCostTry);
        const totalCostEur = round4(bomCostEur + extraCostEur);
        const netProfitTry = round4(revenueTry - totalCostTry);
        const netProfitEur = round4(revenueEur - totalCostEur);
        const marginPct = revenueTry > 0 ? round4((netProfitTry / revenueTry) * 100) : 0;

        return {
          machine_id: m.id,
          machine_name: m.machine_name,
          firm_name: m.firm_name || '—',
          capacity: m.capacity || '',
          passport_code: m.passport_code || '',
          bom_cost_try: bomCostTry,
          extra_cost_try: extraCostTry,
          total_cost_try: totalCostTry,
          total_cost_eur: totalCostEur,
          revenue_try: revenueTry,
          revenue_eur: revenueEur,
          net_profit_try: netProfitTry,
          net_profit_eur: netProfitEur,
          margin_pct: marginPct
        };
      }));

      res.json({ eur_rate_used: eurRate, projects: report });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 2. KUR FARKI HESAPLAYICI (DÖVİZLİ FATURA VS ÖDEME GÜNÜ KURU) ─────────
  app.post('/api/accounting/reports/fx-diff-calculate', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { invoice_id, payment_fx_rate, payment_amount } = req.body;
      const inv = (await query('SELECT * FROM invoices WHERE id=$1', [invoice_id])).rows[0];
      if (!inv) return res.status(404).json({ error: 'Fatura bulunamadı' });
      if (inv.currency === 'TRY') return res.status(400).json({ error: 'TL faturalarda kur farkı hesaplanmaz' });

      const invRate = parseFloat(inv.fx_rate || 1);
      const payRate = parseFloat(payment_fx_rate);
      if (!payRate || payRate <= 0) return res.status(400).json({ error: 'Geçerli ödeme kuru girin' });

      const amt = parseFloat(payment_amount || inv.grand_total);
      const invTry = round4(amt * invRate);
      const payTry = round4(amt * payRate);
      const diffTry = round4(payTry - invTry); // Pozitif: Kur artışı, Negatif: Kur düşüşü

      // KDV dahil kur farkı ayrıştırma (%20 varsayılan)
      const vatRate = 20;
      const netDiffTry = round4(Math.abs(diffTry) / (1 + vatRate / 100));
      const vatDiffTry = round4(Math.abs(diffTry) - netDiffTry);

      res.json({
        invoice_no: inv.invoice_no,
        currency: inv.currency,
        amount: amt,
        invoice_fx_rate: invRate,
        payment_fx_rate: payRate,
        invoice_try: invTry,
        payment_try: payTry,
        fx_diff_try: diffTry,
        recommended_action: diffTry > 0
          ? (inv.direction === 'sales' ? 'Müşteriye Kur Farkı Satış Faturası Kesilmeli' : 'Tedarikçiden Kur Farkı Alış Faturası Alınmalı')
          : diffTry < 0
            ? (inv.direction === 'sales' ? 'Müşteriden Kur Farkı Faturası Alınmalı' : 'Tedarikçiye Kur Farkı Faturası Kesilmeli')
            : 'Kur farkı yok',
        draft_net_try: netDiffTry,
        draft_vat_try: vatDiffTry,
        draft_grand_try: Math.abs(diffTry)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 3. MALİ MÜŞAVİR KDV ÖZET RAPORU (İNDİRİLECEK VS HESAPLANAN KDV) ─────
  app.get('/api/accounting/reports/vat-summary', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const year = parseInt(req.query.year) || new Date().getFullYear();
      const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

      const rows = (await query(`
        SELECT direction,
               COUNT(*) AS invoice_count,
               COALESCE(SUM(subtotal * fx_rate), 0) AS net_try,
               COALESCE(SUM(vat_total * fx_rate), 0) AS vat_try,
               COALESCE(SUM(withholding_total * fx_rate), 0) AS withholding_try,
               COALESCE(SUM(grand_total * fx_rate), 0) AS grand_try
        FROM invoices
        WHERE is_voided = FALSE
          AND EXTRACT(YEAR FROM invoice_date) = $1
          AND EXTRACT(MONTH FROM invoice_date) = $2
        GROUP BY direction
      `, [year, month])).rows;

      const byDir = {};
      rows.forEach(r => { byDir[r.direction] = r; });

      const calculatedVat = round4(parseFloat(byDir.sales?.vat_try || 0) - parseFloat(byDir.sales_return?.vat_try || 0));
      const deductibleVat = round4(parseFloat(byDir.purchase?.vat_try || 0) - parseFloat(byDir.purchase_return?.vat_try || 0));
      const netPayableVat = round4(calculatedVat - deductibleVat);

      res.json({
        period: `${year}-${String(month).padStart(2, '0')}`,
        calculated_vat_try: calculatedVat,   // Hesaplanan KDV (Satış)
        deductible_vat_try: deductibleVat,   // İndirilecek KDV (Alış)
        net_vat_try: netPayableVat,          // Pozitif: Ödenecek KDV | Negatif: Devreden KDV
        breakdown: rows
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 4. MALİ MÜŞAVİR EXCEL/CSV DIŞA AKTARIMLARI ──────────────────────────
  // 4A. Aylık Alış/Satış Fatura Listesi CSV
  app.get('/api/accounting/export/invoices-csv', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const { from, to } = req.query;
      const params = [];
      let where = 'WHERE i.is_voided = FALSE';
      if (from) { params.push(from); where += ` AND i.invoice_date >= $${params.length}`; }
      if (to) { params.push(to); where += ` AND i.invoice_date <= $${params.length}`; }

      const rows = (await query(`
        SELECT i.*, a.name AS account_name, a.tax_office, a.tax_no
        FROM invoices i
        JOIN accounts a ON a.id = i.account_id
        ${where}
        ORDER BY i.invoice_date ASC, i.id ASC
      `, params)).rows;

      const header = ['Tarih', 'Vade', 'Fatura No', 'ETTN', 'Tür', 'Cari Ünvan', 'Vergi Dairesi', 'VKN/TCKN', 'Döviz', 'Kur', 'Matrah', 'KDV', 'Tevkifat', 'Genel Toplam', 'TL Karşılığı'];
      const lines = rows.map(r => [
        String(r.invoice_date).slice(0, 10),
        r.due_date ? String(r.due_date).slice(0, 10) : '',
        r.invoice_no,
        r.ettn_uuid || '',
        r.direction,
        r.account_name,
        r.tax_office || '',
        r.tax_no || '',
        r.currency,
        r.fx_rate,
        r.subtotal,
        r.vat_total,
        r.withholding_total,
        r.grand_total,
        round4(parseFloat(r.grand_total) * parseFloat(r.fx_rate || 1))
      ].map(escCsv).join(','));

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="mali-musavir-faturalar-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('\uFEFF' + [header.join(','), ...lines].join('\n'));
    } catch (e) { res.status(500).send('CSV Hatası: ' + e.message); }
  });

  // 4B. Cari Mizan CSV
  app.get('/api/accounting/export/trial-balance-csv', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const rows = (await query(`
        SELECT a.code, a.name, a.tax_no, a.currency, a.opening_balance,
               COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.debit ELSE 0 END), 0) AS total_debit,
               COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.credit ELSE 0 END), 0) AS total_credit,
               (a.opening_balance + COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.debit - l.credit ELSE 0 END), 0)) AS balance
        FROM accounts a
        LEFT JOIN ledger_entries l ON l.account_id = a.id
        GROUP BY a.id
        ORDER BY a.code ASC
      `)).rows;

      const header = ['Cari Kodu', 'Cari Ünvan', 'VKN/TCKN', 'Döviz', 'Açılış Bakiyesi', 'Toplam Borç', 'Toplam Alacak', 'Net Bakiye', 'Durum'];
      const lines = rows.map(r => {
        const b = parseFloat(r.balance || 0);
        return [
          r.code, r.name, r.tax_no || '', r.currency, r.opening_balance,
          r.total_debit, r.total_credit, Math.abs(b).toFixed(2),
          b > 0 ? 'BORÇLU (ALACAĞIMIZ)' : b < 0 ? 'ALACAKLI (BORCUMUZ)' : 'KAPALI'
        ].map(escCsv).join(',');
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cari-mizan-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('\uFEFF' + [header.join(','), ...lines].join('\n'));
    } catch (e) { res.status(500).send('CSV Hatası: ' + e.message); }
  });

  // ── 5. YAZDIRILABİLİR / PDF CARİ MUTABAKAT MEKTUBU ──────────────────────
  app.get('/accounting/accounts/:id/reconciliation', auth, requireRoles('admin', 'accounting'), async (req, res) => {
    try {
      const acc = (await query('SELECT * FROM accounts WHERE id=$1', [req.params.id])).rows[0];
      if (!acc) return res.status(404).send('Cari hesap bulunamadı');

      const balRes = await query(`
        SELECT (a.opening_balance + COALESCE(SUM(CASE WHEN l.is_voided = FALSE THEN l.debit - l.credit ELSE 0 END), 0)) AS balance
        FROM accounts a
        LEFT JOIN ledger_entries l ON l.account_id = a.id
        WHERE a.id = $1
        GROUP BY a.id
      `, [acc.id]);

      const bal = parseFloat(balRes.rows[0]?.balance || 0);
      const today = new Date().toLocaleDateString('tr-TR');
      const statusText = bal > 0 ? 'BORÇLU' : bal < 0 ? 'ALACAKLI' : 'SIFIR BAKİYELİ';

      res.send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><title>Mutabakat Mektubu — ${escHtml(acc.name)}</title>
<style>
  @page { size: A4 portrait; margin: 18mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #111827; font-size: 13px; line-height: 1.6; margin: 0; }
  .bar { background: #1a6b56; color: #fff; padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; }
  .bar button { background: #fff; color: #1a6b56; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 700; cursor: pointer; }
  .page { max-width: 760px; margin: 24px auto; padding: 0 18px; }
  .head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2.5px solid #1a6b56; padding-bottom: 12px; margin-bottom: 24px; }
  .card { background: #f8fafc; border: 1.5px solid #1a6b56; border-radius: 10px; padding: 16px 20px; margin: 20px 0; text-align: center; }
  .amt { font-family: monospace; font-size: 24px; font-weight: 900; color: #1a6b56; margin: 6px 0; }
  .sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 40px; }
  .sig { border: 1px solid #d1d5db; border-radius: 8px; padding: 14px; min-height: 110px; }
  @media print { .bar { display: none; } .page { margin: 0; padding: 0; } }
</style></head><body>
  <div class="bar">
    <span>📑 Cari Hesap Mutabakat Mektubu</span>
    <button onclick="window.print()">🖨️ Yazdır / PDF Kaydet</button>
  </div>
  <div class="page">
    <div class="head">
      <div>
        <img src="/logo.png" style="height:40px" onerror="this.style.display='none'">
        <div style="font-weight:800;font-size:15px">SEKİZLİ MAKİNA &amp; VİNÇ SAN. TİC. A.Ş.</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:800;color:#1a6b56">CARİ MUTABAKAT FORMU</div>
        <div>Tarih: ${today}</div>
      </div>
    </div>
    <p><strong>Sayın ${escHtml(acc.name)}</strong><br>
    Vergi Dairesi / No: ${escHtml(acc.tax_office || '—')} / ${escHtml(acc.tax_no || '—')}</p>
    <p>Şirketimiz nezdindeki <strong>${escHtml(acc.code)}</strong> kodlu cari hesabınız <strong>${today}</strong> tarihi itibarıyla aşağıdaki bakiyeyi vermektedir:</p>
    <div class="card">
      <div style="font-size:12px;text-transform:uppercase;color:#64748b;font-weight:700">Cari Hesap Bakiyesi</div>
      <div class="amt">${Math.abs(bal).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escHtml(acc.currency)}</div>
      <div style="font-weight:800">Tarafınız: ${statusText}</div>
    </div>
    <p>Mutabık olup olmadığınızı kaşeli ve imzalı olarak tarafımıza bildirmenizi rica eder, iyi çalışmalar dileriz.</p>
    <div class="sigs">
      <div class="sig">
        <strong>SEKİZLİ MAKİNA &amp; VİNÇ A.Ş.</strong><br><br>
        <span style="color:#64748b;font-size:11px">Kaşe / İmza</span>
      </div>
      <div class="sig">
        <strong>${escHtml(acc.name)}</strong><br>
        <span style="font-size:11px">[ &nbsp; ] Mutabıkız &nbsp;&nbsp; [ &nbsp; ] Mutabık Değiliz</span><br><br>
        <span style="color:#64748b;font-size:11px">Kaşe / İmza</span>
      </div>
    </div>
  </div>
</body></html>`);
    } catch (e) { res.status(500).send('Mutabakat Hatası: ' + e.message); }
  });
}

module.exports = { registerAccountingPhase5 };
