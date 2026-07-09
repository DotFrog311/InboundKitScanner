// lib/validate.js — scan qualification, tracking normalization, serial checks
const db = require('../db');

// Prefixes for pre-printed control barcodes (see /barcodes sheet)
const PREFIX = {
  USER: 'USR-',
  CUSTOMER: 'CUST-',
  REASON: 'RSN-',
  COMMAND: 'CMD-',
};

function classifyScan(raw) {
  const s = (raw || '').trim();
  if (s.startsWith(PREFIX.COMMAND)) return { type: 'command', value: s.slice(PREFIX.COMMAND.length) };
  if (s.startsWith(PREFIX.CUSTOMER)) return { type: 'customer', value: s.slice(PREFIX.CUSTOMER.length) };
  if (s.startsWith(PREFIX.REASON)) return { type: 'reason', value: s.slice(PREFIX.REASON.length) };
  if (s.startsWith(PREFIX.USER)) return { type: 'user', value: s.slice(PREFIX.USER.length) };
  return { type: 'data', value: s };
}

// Apply tracking normalization rules (priority order, first match wins).
// Returns { normalized, ruleApplied } — normalized === raw when no rule matches.
function normalizeTracking(raw) {
  const s = (raw || '').trim().replace(/\s+/g, '');
  const rules = db.prepare(
    'SELECT * FROM tracking_rules WHERE active=1 ORDER BY priority ASC').all();
  for (const r of rules) {
    let re;
    try { re = new RegExp(r.match_regex); } catch { continue; }
    const m = s.match(re);
    if (!m) continue;
    let out = s;
    if (r.action === 'keep_last') out = s.slice(-parseInt(r.param, 10));
    else if (r.action === 'strip_first') out = s.slice(parseInt(r.param, 10));
    else if (r.action === 'regex_capture') out = m[1] || s;
    return { normalized: out, ruleApplied: r.description };
  }
  return { normalized: s, ruleApplied: null };
}

// Does this scan plausibly look like a tracking barcode?
function looksLikeTracking(s) {
  if (!s) return false;
  const t = s.trim().replace(/\s+/g, '');
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return true;            // UPS
  if (/^[0-9]{12,34}$/.test(t) && t.length >= 12) return true; // FedEx / USPS numerics
  return false;
}

// Validate a serial against a customer's expected format.
// Returns { ok, flagged, message }
function checkSerial(serial, customer) {
  const s = (serial || '').trim();
  if (!s) return { ok: false, flagged: false, message: 'Empty scan.' };

  // Qualification: reject scans that are clearly not serials.
  if (looksLikeTracking(s) && !(customer.serial_regex && new RegExp(customer.serial_regex).test(s))) {
    return {
      ok: false, flagged: false,
      message: 'That looks like a tracking barcode, not a serial number. Find the SERIAL barcode on the kit.',
    };
  }
  const c = classifyScan(s);
  if (c.type !== 'data') {
    return { ok: false, flagged: false, message: 'That is a control barcode, not a serial number.' };
  }

  if (customer.serial_regex) {
    let re;
    try { re = new RegExp(customer.serial_regex); } catch {
      return { ok: true, flagged: false, message: null }; // bad regex config: accept, don't block ops
    }
    if (!re.test(s)) {
      return {
        ok: false, flagged: true,
        message: `Serial "${s}" does not match the expected ${customer.name} format` +
          (customer.serial_hint ? ` (${customer.serial_hint})` : '') +
          '. Re-scan the correct barcode, or scan OVERRIDE to accept as-is.',
      };
    }
  }
  return { ok: true, flagged: false, message: null };
}

// Validate a tracking scan for a given field. Returns { ok, normalized, ruleApplied, message }
function checkTracking(raw, customer) {
  const s = (raw || '').trim();
  if (!s) return { ok: false, message: 'Empty scan.' };
  const c = classifyScan(s);
  if (c.type !== 'data') return { ok: false, message: 'That is a control barcode, not a tracking number.' };

  // Qualification: reject scans that match the customer's serial format.
  if (customer && customer.serial_regex) {
    try {
      if (new RegExp(customer.serial_regex).test(s) && !looksLikeTracking(s)) {
        return { ok: false, message: 'That looks like a kit serial number, not a tracking barcode.' };
      }
    } catch { /* ignore bad regex */ }
  }
  if (!looksLikeTracking(s)) {
    return {
      ok: false,
      message: `"${s}" does not look like a tracking number (expecting 12–34 digits or a UPS 1Z code).`,
    };
  }
  const { normalized, ruleApplied } = normalizeTracking(s);
  return { ok: true, normalized, ruleApplied, message: null };
}

module.exports = { PREFIX, classifyScan, normalizeTracking, looksLikeTracking, checkSerial, checkTracking };
