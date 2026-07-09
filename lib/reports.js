// lib/reports.js — customer summary + monthly billing report generation and sending
const db = require('../db');
const nodemailer = require('nodemailer');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}

function transporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null; // preview mode
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: (process.env.SMTP_PORT || '465') === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Pacific-time "today" boundaries expressed as UTC ISO strings for SQLite comparison.
function pacificDayBounds(daysBack = 0) {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  pt.setDate(pt.getDate() - daysBack);
  const y = pt.getFullYear(), m = pt.getMonth(), d = pt.getDate();
  const offsetMs = now - new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const startUtc = new Date(new Date(y, m, d, 0, 0, 0).getTime() + offsetMs);
  const endUtc = new Date(new Date(y, m, d, 23, 59, 59, 999).getTime() + offsetMs);
  const iso = (dt) => dt.toISOString().replace('T', ' ').slice(0, 19);
  return { start: iso(startUtc), end: iso(endUtc), label: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

function returnsForCustomer(customerId, start, end) {
  return db.prepare(`
    SELECT r.*, rs.label AS reason_label, u.name AS operator
    FROM returns r
    JOIN reasons rs ON rs.id = r.reason_id
    JOIN users u ON u.id = r.user_id
    WHERE r.customer_id = ? AND r.received_at BETWEEN ? AND ?
    ORDER BY r.received_at`).all(customerId, start, end);
}

function summaryTable(rows) {
  const tr = rows.map(r => `
    <tr>
      <td>${r.return_tracking}</td><td>${r.outbound_tracking}</td>
      <td>${r.reason_label}</td><td>${r.serial}</td><td>${r.received_at} UTC</td>
    </tr>`).join('');
  return `
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
      <tr style="background:#f0f0f0">
        <th>Return Tracking</th><th>Outbound Tracking</th><th>Reason</th><th>Serial Number</th><th>Received</th>
      </tr>${tr}
    </table>`;
}

function csvAttachment(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Return Tracking,Outbound Tracking,Reason,Serial Number,Received (UTC)'];
  for (const r of rows) {
    lines.push([r.return_tracking, r.outbound_tracking, r.reason_label, r.serial, r.received_at].map(esc).join(','));
  }
  return lines.join('\n');
}

// Send (or preview) the per-customer summary for a period. Returns array of results.
async function sendCustomerSummaries({ periodStart, periodEnd, periodLabel, dryRun = false }) {
  const tx = transporter();
  const from = `"${getSetting('email_from_name') || 'Returns'}" <${process.env.SMTP_USER || 'preview@localhost'}>`;
  const customers = db.prepare('SELECT * FROM customers WHERE active=1').all();
  const results = [];

  for (const c of customers) {
    const recipients = (c.emails || '').split(',').map(s => s.trim()).filter(Boolean);
    const rows = returnsForCustomer(c.id, periodStart, periodEnd);
    const count = rows.length;

    const subject = count === 0
      ? `${c.name} — No kit returns processed (${periodLabel})`
      : `${c.name} — ${count} kit return${count === 1 ? '' : 's'} processed (${periodLabel})`;
    const html = count === 0
      ? `<p style="font-family:sans-serif">Hello,</p>
         <p style="font-family:sans-serif">No returns were processed for <b>${c.name}</b> during this period (${periodLabel}).</p>`
      : `<p style="font-family:sans-serif">Hello,</p>
         <p style="font-family:sans-serif">You have <b>${count}</b> return${count === 1 ? '' : 's'} processed for <b>${c.name}</b> (${periodLabel}). All returned kits are destroyed per policy. Details below and attached as CSV.</p>
         ${summaryTable(rows)}`;

    let status = 'preview', error = null;
    if (!dryRun && tx && recipients.length) {
      try {
        await tx.sendMail({
          from, to: recipients.join(', '), subject, html,
          attachments: count ? [{ filename: `returns_${c.code}_${periodLabel}.csv`, content: csvAttachment(rows) }] : [],
        });
        status = 'sent';
      } catch (e) { status = 'error'; error = String(e.message || e); }
    } else if (!recipients.length) {
      status = 'preview'; error = 'no recipients configured';
    }

    db.prepare(`INSERT INTO report_log (type, customer_id, period_start, period_end, recipients, return_count, status, error)
                VALUES ('customer_summary', ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, periodStart, periodEnd, recipients.join(','), count, status, error);
    if (status === 'sent' && count) {
      const ids = rows.map(r => r.id);
      db.prepare(`UPDATE returns SET reported_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    results.push({ customer: c.name, recipients, count, status, error, subject, html });
  }
  return results;
}

// Monthly billing rollup to accounting: count of returns per customer for a calendar month.
async function sendMonthlyBilling({ year, month, dryRun = false }) {
  const start = `${year}-${String(month).padStart(2, '0')}-01 00:00:00`;
  const endDate = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${endDate} 23:59:59`;
  const label = `${year}-${String(month).padStart(2, '0')}`;

  const rows = db.prepare(`
    SELECT c.name, c.code, COUNT(r.id) AS cnt
    FROM customers c LEFT JOIN returns r
      ON r.customer_id = c.id AND r.received_at BETWEEN ? AND ?
    WHERE c.active = 1
    GROUP BY c.id ORDER BY c.name`).all(start, end);
  const total = rows.reduce((a, r) => a + r.cnt, 0);

  const html = `
    <p style="font-family:sans-serif">Monthly returns billing summary for <b>${label}</b>:</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
      <tr style="background:#f0f0f0"><th>Customer</th><th>Code</th><th>Returns Processed</th></tr>
      ${rows.map(r => `<tr><td>${r.name}</td><td>${r.code}</td><td align="right">${r.cnt}</td></tr>`).join('')}
      <tr style="background:#f9f9f9"><td colspan="2"><b>Total</b></td><td align="right"><b>${total}</b></td></tr>
    </table>`;
  const recipient = getSetting('billing_email') || '';
  const tx = transporter();
  let status = 'preview', error = null;
  if (!dryRun && tx && recipient) {
    try {
      await tx.sendMail({
        from: `"${getSetting('email_from_name') || 'Returns'}" <${process.env.SMTP_USER}>`,
        to: recipient, subject: `Returns billing summary — ${label} (${total} total)`, html,
      });
      status = 'sent';
    } catch (e) { status = 'error'; error = String(e.message || e); }
  }
  db.prepare(`INSERT INTO report_log (type, period_start, period_end, recipients, return_count, status, error)
              VALUES ('monthly_billing', ?, ?, ?, ?, ?, ?)`)
    .run(start, end, recipient, total, status, error);
  return { label, rows, total, status, error, html };
}

module.exports = { getSetting, pacificDayBounds, sendCustomerSummaries, sendMonthlyBilling, returnsForCustomer };
