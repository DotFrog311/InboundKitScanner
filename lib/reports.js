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
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS.replace(/\s+/g, '') },
  });
}

// True if any send mechanism is configured.
function canSend() {
  return !!(gmailConfigured() || process.env.RESEND_API_KEY ||
    (process.env.SMTP_USER && process.env.SMTP_PASS));
}

// ---- Gmail API (HTTPS — works on hosts that block SMTP ports) ----
function gmailConfigured() {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
}
async function gmailAccessToken() {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`Gmail token ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).access_token;
}
async function sendViaGmailApi({ from, to, subject, html, attachments }) {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const mime = await new Promise((resolve, reject) =>
    new MailComposer({ from, to: to.join(', '), subject, html, attachments })
      .compile().build((err, buf) => err ? reject(err) : resolve(buf)));
  const accessToken = await gmailAccessToken();
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: mime.toString('base64url') }),
  });
  if (!resp.ok) throw new Error(`Gmail send ${resp.status}: ${await resp.text()}`);
}

// Send an email via Resend's HTTPS API (works on hosts that block SMTP ports,
// e.g. Railway trial/hobby plans) or fall back to SMTP.
// attachments: [{ filename, content }] where content is a utf-8 string.
async function sendMail({ to, subject, html, attachments = [] }) {
  const fromName = getSetting('email_from_name') || 'Returns';
  if (gmailConfigured()) {
    const fromAddr = process.env.EMAIL_FROM || process.env.GMAIL_USER || 'me';
    return sendViaGmailApi({ from: `"${fromName}" <${fromAddr}>`, to, subject, html, attachments });
  }
  if (process.env.RESEND_API_KEY) {
    const fromAddr = process.env.EMAIL_FROM || 'onboarding@resend.dev';
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromAddr}>`,
        to,
        subject,
        html,
        attachments: attachments.map(a => ({
          filename: a.filename,
          content: Buffer.from(a.content, 'utf8').toString('base64'),
        })),
      }),
    });
    if (!resp.ok) throw new Error(`Resend ${resp.status}: ${await resp.text()}`);
    return;
  }
  const tx = transporter();
  if (!tx) throw new Error('No email transport configured');
  await tx.sendMail({
    from: `"${fromName}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to: to.join(', '), subject, html, attachments,
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
    if (!dryRun && canSend() && recipients.length) {
      try {
        await sendMail({
          to: recipients, subject, html,
          attachments: count ? [{ filename: `returns_${c.code}_${periodLabel}.csv`, content: csvAttachment(rows) }] : [],
        });
        status = 'sent';
      } catch (e) { status = 'error'; error = String(e.message || e); }
    } else if (!dryRun && !canSend()) {
      error = 'no email transport configured (set GMAIL_*, RESEND_API_KEY, or SMTP_USER/SMTP_PASS)';
    } else if (!recipients.length) {
      error = 'no recipients configured';
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
  let status = 'preview', error = null;
  if (!dryRun && canSend() && recipient) {
    try {
      await sendMail({
        to: recipient.split(',').map(s => s.trim()).filter(Boolean),
        subject: `Returns billing summary — ${label} (${total} total)`, html,
      });
      status = 'sent';
    } catch (e) { status = 'error'; error = String(e.message || e); }
  } else if (!dryRun && !canSend()) {
    error = 'no email transport configured (set GMAIL_*, RESEND_API_KEY, or SMTP_USER/SMTP_PASS)';
  }
  db.prepare(`INSERT INTO report_log (type, period_start, period_end, recipients, return_count, status, error)
              VALUES ('monthly_billing', ?, ?, ?, ?, ?, ?)`)
    .run(start, end, recipient, total, status, error);
  return { label, rows, total, status, error, html };
}

module.exports = { getSetting, pacificDayBounds, sendCustomerSummaries, sendMonthlyBilling, returnsForCustomer };
