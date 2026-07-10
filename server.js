// server.js — Kit Returns Receiving
try { require('dotenv').config(); } catch { /* dotenv optional; env may be set by host */ }

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const { classifyScan, checkSerial, checkTracking } = require('./lib/validate');
const reports = require('./lib/reports');

// Crash hardening: log the cause instead of dying silently. Unhandled promise
// rejections (Node 22 kills the process on these by default) are logged and
// survived; truly unknown exceptions are logged with a stack then exit so the
// host restarts us cleanly — either way the cause lands in the deploy logs.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
  process.exit(1);
});

const app = express();
app.use(express.json());

// Wrapper so an error in an async route returns a 500 instead of killing the process.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  console.error('[route error]', req.method, req.path, e && e.stack || e);
  if (!res.headersSent) res.status(500).json({ error: String(e && e.message || e) });
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/jsbarcode.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jsbarcode/dist/JsBarcode.all.min.js')));

// ---------- sessions (in-memory, sliding inactivity timeout) ----------
const sessions = new Map(); // token -> { userId, isAdmin, lastSeen }
function timeoutMs(isAdmin) {
  const key = isAdmin ? 'admin_session_timeout_seconds' : 'session_timeout_seconds';
  return parseInt(reports.getSetting(key) || (isAdmin ? '3600' : '180'), 10) * 1000;
}
function auth(req, res, next) {
  const token = req.headers['x-session-token'];
  const s = token && sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Not logged in.' });
  if (Date.now() - s.lastSeen > timeoutMs(s.isAdmin)) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired due to inactivity. Please log in again.' });
  }
  s.lastSeen = Date.now();
  req.user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(s.userId);
  if (!req.user) return res.status(401).json({ error: 'User no longer active.' });
  next();
}
function adminOnly(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  let { code, pin } = req.body || {};
  code = (code || '').trim();
  const c = classifyScan(code);
  if (c.type === 'user') code = c.value; // allow scanning a USR- badge barcode
  const user = db.prepare('SELECT * FROM users WHERE code=? AND active=1').get(code);
  if (!user) return res.status(401).json({ error: 'Unknown user code.' });
  if (user.pin && user.pin !== String(pin || '')) return res.status(401).json({ error: 'Incorrect PIN.' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId: user.id, isAdmin: !!user.is_admin, lastSeen: Date.now() });
  res.json({
    token,
    user: { id: user.id, name: user.name, code: user.code, is_admin: !!user.is_admin },
    timeout_seconds: timeoutMs(!!user.is_admin) / 1000,
  });
});
app.post('/api/logout', auth, (req, res) => {
  sessions.delete(req.headers['x-session-token']);
  res.json({ ok: true });
});
app.get('/api/session', auth, (req, res) => {
  res.json({ user: { id: req.user.id, name: req.user.name, is_admin: !!req.user.is_admin } });
});

// Public data for the printable barcode sheets (no login required).
app.get('/api/barcode-data', (req, res) => {
  res.json({
    customers: db.prepare('SELECT code, name FROM customers WHERE active=1 ORDER BY name').all(),
    reasons: db.prepare('SELECT code, label FROM reasons WHERE active=1 ORDER BY id').all(),
  });
});

// ---------- bootstrap data for the operator screen ----------
app.get('/api/bootstrap', auth, (req, res) => {
  res.json({
    customers: db.prepare('SELECT id, code, name, serial_hint FROM customers WHERE active=1 ORDER BY name').all(),
    reasons: db.prepare('SELECT id, code, label FROM reasons WHERE active=1 ORDER BY id').all(),
    timeout_seconds: timeoutMs() / 1000,
  });
});

// ---------- scan validation ----------
app.post('/api/validate/tracking', auth, (req, res) => {
  const { scan, customer_id } = req.body || {};
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id);
  if (!customer) return res.status(400).json({ ok: false, message: 'Select a customer first.' });
  res.json(checkTracking(scan, customer));
});
app.post('/api/validate/serial', auth, (req, res) => {
  const { scan, customer_id } = req.body || {};
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(customer_id);
  if (!customer) return res.status(400).json({ ok: false, message: 'Select a customer first.' });
  const result = checkSerial(scan, customer);
  if (result.ok) {
    // Duplicate check: this serial was already received (kits are destroyed, so
    // the same serial should never legitimately arrive twice).
    const dup = db.prepare(`
      SELECT r.received_at, u.name AS operator FROM returns r
      JOIN users u ON u.id = r.user_id
      WHERE r.serial = ? AND r.customer_id = ? ORDER BY r.id DESC LIMIT 1`)
      .get(String(scan).trim(), customer.id);
    if (dup) result.duplicate = dup;
  }
  res.json(result);
});

// ---------- record a completed return ----------
app.post('/api/returns', auth, (req, res) => {
  const b = req.body || {};
  const required = ['customer_id', 'return_tracking', 'return_tracking_raw',
    'outbound_tracking', 'outbound_tracking_raw', 'reason_id', 'serial'];
  for (const f of required) {
    if (b[f] === undefined || b[f] === null || String(b[f]).trim() === '') {
      return res.status(400).json({ error: `Missing field: ${f}` });
    }
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id=? AND active=1').get(b.customer_id);
  const reason = db.prepare('SELECT * FROM reasons WHERE id=? AND active=1').get(b.reason_id);
  if (!customer) return res.status(400).json({ error: 'Invalid customer.' });
  if (!reason) return res.status(400).json({ error: 'Invalid reason.' });

  const info = db.prepare(`
    INSERT INTO returns (customer_id, user_id, return_tracking, return_tracking_raw,
      outbound_tracking, outbound_tracking_raw, reason_id, serial, serial_flagged)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(customer.id, req.user.id, String(b.return_tracking).trim(), String(b.return_tracking_raw).trim(),
      String(b.outbound_tracking).trim(), String(b.outbound_tracking_raw).trim(),
      reason.id, String(b.serial).trim(), b.serial_flagged ? 1 : 0);
  const row = db.prepare(`
    SELECT r.*, c.name AS customer_name, rs.label AS reason_label
    FROM returns r JOIN customers c ON c.id=r.customer_id JOIN reasons rs ON rs.id=r.reason_id
    WHERE r.id=?`).get(info.lastInsertRowid);
  res.json({ ok: true, record: row });
});

// Recent activity for the logged-in operator (confirmation strip)
app.get('/api/returns/recent', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.serial, r.return_tracking, r.received_at, c.name AS customer_name, rs.label AS reason_label
    FROM returns r JOIN customers c ON c.id=r.customer_id JOIN reasons rs ON rs.id=r.reason_id
    WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 10`).all(req.user.id));
});

// Everything received today (Pacific), all operators — sidebar "already scanned" list.
app.get('/api/returns/today', auth, (req, res) => {
  const { start, end } = reports.pacificDayBounds(0);
  res.json(db.prepare(`
    SELECT r.id, r.serial, r.received_at, c.name AS customer_name, u.name AS operator, u.id AS user_id
    FROM returns r JOIN customers c ON c.id=r.customer_id JOIN users u ON u.id=r.user_id
    WHERE r.received_at BETWEEN ? AND ? ORDER BY r.id DESC`).all(start, end));
});

// ---------- admin: CRUD ----------
function crud(table, fields) {
  app.get(`/api/admin/${table}`, auth, adminOnly, (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  });
  app.post(`/api/admin/${table}`, auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const cols = fields.filter(f => b[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No fields.' });
    try {
      const info = db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map(f => b[f]));
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(info.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: String(e.message) }); }
  });
  app.put(`/api/admin/${table}/:id`, auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const cols = fields.filter(f => b[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No fields.' });
    try {
      db.prepare(`UPDATE ${table} SET ${cols.map(f => `${f}=?`).join(',')} WHERE id=?`)
        .run(...cols.map(f => b[f]), req.params.id);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id));
    } catch (e) { res.status(400).json({ error: String(e.message) }); }
  });
}
crud('users', ['code', 'pin', 'name', 'is_admin', 'active']);
crud('customers', ['code', 'name', 'serial_regex', 'serial_hint', 'emails', 'active']);
crud('reasons', ['code', 'label', 'active']);
crud('tracking_rules', ['priority', 'description', 'match_regex', 'action', 'param', 'active']);

// ---------- admin: settings ----------
app.get('/api/admin/settings', auth, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});
app.put('/api/admin/settings', auth, adminOnly, (req, res) => {
  const up = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(req.body || {})) up.run(k, String(v));
  res.json({ ok: true });
});

// ---------- admin: records browse/export ----------
app.get('/api/admin/returns', auth, adminOnly, (req, res) => {
  const { from, to, customer_id } = req.query;
  let sql = `
    SELECT r.*, c.name AS customer_name, rs.label AS reason_label, u.name AS operator
    FROM returns r JOIN customers c ON c.id=r.customer_id
    JOIN reasons rs ON rs.id=r.reason_id JOIN users u ON u.id=r.user_id WHERE 1=1`;
  const args = [];
  if (from) { sql += ' AND r.received_at >= ?'; args.push(from + ' 00:00:00'); }
  if (to) { sql += ' AND r.received_at <= ?'; args.push(to + ' 23:59:59'); }
  if (customer_id) { sql += ' AND r.customer_id = ?'; args.push(customer_id); }
  sql += ' ORDER BY r.received_at DESC LIMIT 2000';
  res.json(db.prepare(sql).all(...args));
});
app.get('/api/admin/returns.csv', auth, adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT r.received_at, c.name AS customer, r.return_tracking, r.return_tracking_raw,
      r.outbound_tracking, r.outbound_tracking_raw, rs.label AS reason, r.serial,
      r.serial_flagged, u.name AS operator
    FROM returns r JOIN customers c ON c.id=r.customer_id
    JOIN reasons rs ON rs.id=r.reason_id JOIN users u ON u.id=r.user_id
    ORDER BY r.received_at DESC`).all();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = Object.keys(rows[0] || { none: '' }).join(',');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=returns_export.csv');
  res.send([head, ...rows.map(r => Object.values(r).map(esc).join(','))].join('\n'));
});

// ---------- admin: reports ----------
app.post('/api/admin/reports/customer-summary', auth, adminOnly, ah(async (req, res) => {
  const { dry_run = true, days_back = 0 } = req.body || {};
  const { start, end, label } = reports.pacificDayBounds(days_back);
  const results = await reports.sendCustomerSummaries({
    periodStart: start, periodEnd: end, periodLabel: label, dryRun: !!dry_run,
  });
  res.json({ period: { start, end, label }, results });
}));
app.post('/api/admin/reports/monthly-billing', auth, adminOnly, ah(async (req, res) => {
  const now = new Date();
  const { year = now.getFullYear(), month = now.getMonth() + 1, dry_run = true } = req.body || {};
  res.json(await reports.sendMonthlyBilling({ year, month, dryRun: !!dry_run }));
}));
app.get('/api/admin/report-log', auth, adminOnly, (req, res) => {
  res.json(db.prepare(`
    SELECT rl.*, c.name AS customer_name FROM report_log rl
    LEFT JOIN customers c ON c.id = rl.customer_id
    ORDER BY rl.id DESC LIMIT 200`).all());
});

// ---------- scheduler ----------
// Customer summaries: daily at report_hour_pt Pacific; if cadence=weekly, only on weekly_report_day.
cron.schedule('0 * * * *', async () => {
  try {
    const nowPt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const hour = parseInt(reports.getSetting('report_hour_pt') || '20', 10);
    if (nowPt.getHours() !== hour) return;
    const cadence = reports.getSetting('report_cadence') || 'daily';
    if (cadence === 'weekly' && nowPt.getDay() !== parseInt(reports.getSetting('weekly_report_day') || '5', 10)) return;
    let daysBack = 0, start, end, label;
    if (cadence === 'weekly') {
      const s = reports.pacificDayBounds(6), e = reports.pacificDayBounds(0);
      start = s.start; end = e.end; label = `${s.label} to ${e.label}`;
    } else {
      ({ start, end, label } = reports.pacificDayBounds(daysBack));
    }
    await reports.sendCustomerSummaries({ periodStart: start, periodEnd: end, periodLabel: label, dryRun: false });
    console.log(`[reports] customer summaries run for ${label}`);
  } catch (e) { console.error('[reports] summary error', e); }
}, { timezone: 'America/Los_Angeles' });

// Monthly billing: 1st of the month, 6am PT, for the previous month.
cron.schedule('0 6 1 * *', async () => {
  try {
    const nowPt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    let y = nowPt.getFullYear(), m = nowPt.getMonth(); // previous month (getMonth is 0-based → m = prev month 1-based)
    if (m === 0) { m = 12; y -= 1; }
    await reports.sendMonthlyBilling({ year: y, month: m, dryRun: false });
    console.log(`[reports] monthly billing run for ${y}-${m}`);
  } catch (e) { console.error('[reports] billing error', e); }
}, { timezone: 'America/Los_Angeles' });

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Kit Returns Receiving listening on http://localhost:${PORT}`));
}
module.exports = app;
