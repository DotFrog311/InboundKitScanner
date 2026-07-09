// db.js — SQLite schema, migrations, and seed data
// Uses Node's built-in SQLite (node:sqlite, Node >= 22.5) — no native compile step.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'returns.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,            -- short badge code, scannable (e.g. "1042")
  pin TEXT,                             -- optional PIN; NULL = code-only login
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,            -- short code used on barcode sheet (e.g. "JUNCTION")
  name TEXT NOT NULL,
  serial_regex TEXT,                    -- expected serial format, e.g. "^J[0-9]{7}$"
  serial_hint TEXT,                     -- human description shown on mismatch
  emails TEXT NOT NULL DEFAULT '',      -- comma-separated recipient list
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,            -- e.g. "REFUSED"
  label TEXT NOT NULL,                  -- e.g. "Refused by consumer"
  active INTEGER NOT NULL DEFAULT 1
);

-- Tracking barcode normalization rules, applied in priority order (first match wins).
-- action: 'keep_last' (param = N chars), 'strip_first' (param = N chars),
--         'regex_capture' (param = replacement group 1 of match_regex)
CREATE TABLE IF NOT EXISTS tracking_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  priority INTEGER NOT NULL DEFAULT 100,
  description TEXT NOT NULL,
  match_regex TEXT NOT NULL,
  action TEXT NOT NULL,
  param TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  return_tracking TEXT NOT NULL,        -- normalized
  return_tracking_raw TEXT NOT NULL,    -- exactly as scanned
  outbound_tracking TEXT NOT NULL,
  outbound_tracking_raw TEXT NOT NULL,
  reason_id INTEGER NOT NULL REFERENCES reasons(id),
  serial TEXT NOT NULL,
  serial_flagged INTEGER NOT NULL DEFAULT 0,  -- 1 = operator overrode a format mismatch
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  reported_at TEXT                       -- set when included in a customer report
);
CREATE INDEX IF NOT EXISTS idx_returns_customer ON returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_returns_received ON returns(received_at);

CREATE TABLE IF NOT EXISTS report_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                   -- 'customer_summary' | 'monthly_billing'
  customer_id INTEGER REFERENCES customers(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  recipients TEXT NOT NULL,
  return_count INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- 'sent' | 'error' | 'preview'
  error TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---------- defaults / seed ----------
const setDefault = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
setDefault.run('report_cadence', 'daily');          // 'daily' | 'weekly'
setDefault.run('report_hour_pt', '20');             // 8pm Pacific
setDefault.run('weekly_report_day', '5');           // Friday (0=Sun..6=Sat), used when cadence=weekly
setDefault.run('session_timeout_seconds', '180');   // auto-logout after inactivity
setDefault.run('billing_email', 'jeff@dotprinter.com');
setDefault.run('email_from_name', 'Returns Receiving');

const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const addUser = db.prepare('INSERT INTO users (code, pin, name, is_admin) VALUES (?,?,?,?)');
  addUser.run('ADMIN', '0000', 'Administrator', 1);
  addUser.run('1001', null, 'Sample Operator', 0);
}

const custCount = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
if (custCount === 0) {
  const addCust = db.prepare(
    'INSERT INTO customers (code, name, serial_regex, serial_hint, emails) VALUES (?,?,?,?,?)');
  // Initial pilot customers (report emails point at Jeff's personal address for testing).
  addCust.run('JUNCTION', 'Junction', '^J[A-Za-z0-9]+$', 'Starts with the letter J', 'jshattuck@gmail.com');
  addCust.run('LABCORP', 'LabCorp On-Demand', '^[0-9]{12}$', '12 digits, numeric only', 'jshattuck@gmail.com');
}

const reasonCount = db.prepare('SELECT COUNT(*) c FROM reasons').get().c;
if (reasonCount === 0) {
  const addReason = db.prepare('INSERT INTO reasons (code, label) VALUES (?,?)');
  addReason.run('REFUSED', 'Refused by consumer');
  addReason.run('RTS', 'Return to sender');
  addReason.run('ADDR', 'Address unknown / undeliverable');
  addReason.run('DAMAGED', 'Damaged in transit');
  addReason.run('OTHER', 'Other');
}

const ruleCount = db.prepare('SELECT COUNT(*) c FROM tracking_rules').get().c;
if (ruleCount === 0) {
  const addRule = db.prepare(
    'INSERT INTO tracking_rules (priority, description, match_regex, action, param) VALUES (?,?,?,?,?)');
  // USPS IMpb with 420+ZIP routing prefix: capture the trailing 22-digit
  // tracking number (starts 92/93/94/95). Runs FIRST so it beats the generic
  // digit-length FedEx rules. Verified against a real return scan:
  // 42094105299400151969010882023570 -> 9400151969010882023570
  addRule.run(5, 'USPS 420+ZIP prefix -> trailing 22-digit tracking',
    '^420[0-9]{4,10}(9[2-5][0-9]{20})$', 'regex_capture', null);
  // FedEx Ground 96 barcodes are 34 digits; the tracking number is the last 12.
  addRule.run(10, 'FedEx 34-digit barcode -> last 12', '^[0-9]{34}$', 'keep_last', '12');
  // FedEx Express 32-digit -> last 12 (excluding USPS 420-prefixed scans)
  addRule.run(20, 'FedEx 32-digit barcode -> last 12', '^(?!420)[0-9]{32}$', 'keep_last', '12');
  // Spec example: 25-digit scan -> remove first 10 routing characters.
  addRule.run(30, 'FedEx 25-digit barcode -> strip first 10', '^[0-9]{25}$', 'strip_first', '10');
}

module.exports = db;
