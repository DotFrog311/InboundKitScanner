// test/smoke.js — end-to-end API smoke test against a temp database
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/returns-test-');
const app = require('../server');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
let token = null, failures = 0;

async function req(path, body, method) {
  const r = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
function check(name, cond, extra) {
  if (cond) console.log(`  ✔ ${name}`);
  else { console.error(`  ✘ ${name}`, extra ?? ''); failures++; }
}

(async () => {
  const server = app.listen(PORT);
  try {
    console.log('auth');
    let r = await req('/api/login', { code: 'NOPE' });
    check('rejects unknown user', r.status === 401);
    r = await req('/api/login', { code: 'ADMIN', pin: '9999' });
    check('rejects wrong PIN', r.status === 401);
    r = await req('/api/login', { code: 'USR-1001' });
    check('accepts badge scan (USR- prefix)', r.status === 200 && r.json.token);
    r = await req('/api/login', { code: 'ADMIN', pin: '0000' });
    check('admin login', r.status === 200 && r.json.user.is_admin);
    token = r.json.token;

    console.log('bootstrap');
    r = await req('/api/bootstrap');
    check('customers + reasons load', r.json.customers.length >= 2 && r.json.reasons.length >= 3);
    const junction = r.json.customers.find(c => c.code === 'JUNCTION');
    const labcorp = r.json.customers.find(c => c.code === 'LABCORP');
    const reason = r.json.reasons[0];

    console.log('tracking validation + normalization');
    r = await req('/api/validate/tracking', { scan: '961102098765'.padEnd(34, '4'), customer_id: junction.id });
    check('FedEx 34-digit normalized to last 12', r.json.ok && r.json.normalized.length === 12, r.json);
    r = await req('/api/validate/tracking', { scan: '1234567890123456789012345', customer_id: junction.id });
    check('25-digit strips first 10', r.json.ok && r.json.normalized === '123456789012345', r.json);
    r = await req('/api/validate/tracking', { scan: '42094105299400151969010882023570', customer_id: junction.id });
    check('real USPS return scan -> 22-digit tracking',
      r.json.ok && r.json.normalized === '9400151969010882023570', r.json);
    r = await req('/api/validate/tracking', { scan: '1Z999AA10123456784', customer_id: junction.id });
    check('UPS 1Z accepted verbatim', r.json.ok && r.json.normalized === '1Z999AA10123456784', r.json);
    r = await req('/api/validate/tracking', { scan: 'J1234567', customer_id: junction.id });
    check('serial scanned into tracking field rejected', !r.json.ok, r.json);
    r = await req('/api/validate/tracking', { scan: 'RSN-REFUSED', customer_id: junction.id });
    check('control barcode rejected in tracking field', !r.json.ok, r.json);

    console.log('serial validation');
    r = await req('/api/validate/serial', { scan: 'J1234567', customer_id: junction.id });
    check('valid Junction serial accepted', r.json.ok, r.json);
    r = await req('/api/validate/serial', { scan: 'J1234567', customer_id: labcorp.id });
    check('Junction serial under LabCorp flags mismatch', !r.json.ok && r.json.flagged, r.json);
    r = await req('/api/validate/serial', { scan: '123456789012', customer_id: labcorp.id });
    check('12-digit numeric LabCorp serial accepted', r.json.ok, r.json);
    r = await req('/api/validate/serial', { scan: '12345678901', customer_id: labcorp.id });
    check('11-digit serial under LabCorp flags mismatch', !r.json.ok && r.json.flagged, r.json);
    r = await req('/api/validate/serial', { scan: '9611020987654321043321987654321012', customer_id: junction.id });
    check('tracking barcode rejected in serial field', !r.json.ok && !r.json.flagged, r.json);

    console.log('record a return');
    r = await req('/api/returns', {
      customer_id: junction.id,
      return_tracking: '123456789012', return_tracking_raw: '123456789012'.padStart(34, '9'),
      outbound_tracking: '123456789012', outbound_tracking_raw: '123456789012',
      reason_id: reason.id, serial: 'J1234567', serial_flagged: 0,
    });
    check('return saved', r.json.ok && r.json.record.id, r.json);
    r = await req('/api/returns/recent');
    check('recent list shows record', r.json.length === 1 && r.json[0].serial === 'J1234567');

    console.log('reports (dry run)');
    r = await req('/api/admin/reports/customer-summary', { dry_run: true });
    const jr = r.json.results.find(x => x.customer === 'Junction');
    const lr = r.json.results.find(x => x.customer === 'LabCorp On-Demand');
    check('Junction summary has 1 return', jr && jr.count === 1, jr);
    check('LabCorp gets zero-return notice', lr && lr.count === 0 && /No kit returns/.test(lr.subject), lr);
    check('summary email contains serial', jr && /J1234567/.test(jr.html));
    const now = new Date();
    r = await req('/api/admin/reports/monthly-billing', { year: now.getFullYear(), month: now.getMonth() + 1, dry_run: true });
    check('monthly billing totals 1', r.json.total === 1, r.json);

    console.log('admin CRUD + auth guards');
    r = await req('/api/admin/customers', { code: 'ACME', name: 'Acme Labs', serial_regex: '^A[0-9]{6}$', serial_hint: 'A + 6 digits', emails: 'ops@acme.test' });
    check('create customer', r.json.id, r.json);
    const opLogin = await req('/api/login', { code: '1001' });
    const opToken = opLogin.json.token, admToken = token;
    token = opToken;
    r = await req('/api/admin/customers');
    check('non-admin blocked from admin API', r.status === 403);
    token = admToken;
    r = await req('/api/session');
    check('session still valid', r.status === 200);
  } finally {
    server.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
