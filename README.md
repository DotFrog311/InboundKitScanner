# Kit Returns Receiving

Scan-driven web app for receiving returned wellness test kits: document what arrived, why it came back, and which kit it was — then destroy per policy. Sends per-customer email summaries on a schedule and a monthly billing rollup to accounting.

## The operator flow (keyboard-free after login)

1. **Log in** — scan a `USR-` badge barcode (or type user code + optional PIN). Auto-logout after inactivity (default 3 minutes, configurable) so the next operator can't act as someone else.
2. **Who is the customer?** — scan a `CUST-` barcode from the printed sheet (or tap a button).
3. **Scan the RETURN tracking barcode** — the label the carrier used to send it back.
4. **Scan the ORIGINAL outbound barcode** — or scan `CMD-SAME` if it's the same label.
5. **Scan the reason** — `RSN-` barcode (Refused, Return to sender, Address unknown, …).
6. **Scan the kit serial number** — validated against the customer's expected format (e.g. Junction serials start with `J`). On mismatch, the operator re-scans or scans `CMD-OVERRIDE` to accept (override is flagged in the record).
7. Record saved with operator + timestamp → loops back to step 3 for the next kit. `CMD-CUSTOMER` switches customers, `CMD-CANCEL` restarts the current kit, `CMD-LOGOUT` logs out.

Print the barcode sheets (customers, reasons, commands, badges) from **/barcodes.html**.

### Scan qualification

Boxes carry many barcodes (part number, lot number, routing codes). The app rejects scans that don't fit the field:

- **Tracking fields** expect 12–34 digits or a UPS `1Z` code; carrier routing prefixes are normalized by configurable **tracking rules** (e.g. FedEx 34-digit barcode → last 12; a 25-digit scan → strip first 10). Both raw and normalized values are stored.
- **Serial field** rejects anything that looks like a tracking number or control barcode, then checks the customer's `serial_regex`.

## Email reports

- **Customer summaries** — daily at 8pm Pacific (hour and daily/weekly cadence configurable in Admin → Settings). Each customer gets only their own data: return tracking, outbound tracking, reason, serial — in the body and as a CSV attachment. Customers with zero returns get a "no returns processed" notice. Recipients are a comma-separated list per customer.
- **Monthly billing** — 1st of each month, previous month's per-customer counts, sent to accounting for invoicing.
- Sending works via **Resend** (HTTPS API — set `RESEND_API_KEY` + `EMAIL_FROM`; required on Railway trial/hobby, which block SMTP ports) or **Gmail SMTP** (`SMTP_USER`/`SMTP_PASS`; needs Railway Pro or a host with open SMTP). With neither configured the app runs in **preview mode**: reports are generated and logged (Admin → Reports) but not sent.

## Setup

```bash
npm install
cp .env.example .env    # fill in Gmail app password to enable sending
npm start               # http://localhost:3000
```

First run seeds the database (`data/returns.db`) with:

- Admin login: code `ADMIN`, PIN `0000` — **change this immediately**
- Sample operator: code `1001` (no PIN)
- Sample customers `JUNCTION` and `LABCORP` with example serial rules
- Default reasons and tracking normalization rules

## Deploying to Railway

1. Sign up at railway.com (log in with GitHub).
2. New Project → **Deploy from GitHub repo** → select `DotFrog311/InboundKitScanner`. Railway auto-detects Node and runs `npm start`.
3. In the service: right-click (or Settings) → **Attach Volume**, mount path `/data` (1 GB is plenty).
4. Under **Variables**, add:
   - `DATA_DIR=/data` (so the SQLite database lives on the volume and survives deploys)
   - `SMTP_USER` / `SMTP_PASS` (Gmail app password) when ready to send real emails — until then reports run in preview mode
5. Settings → **Networking → Generate Domain** — that's the URL your team uses (https included).
6. Every `git push` to `main` auto-deploys.

**Important:** once the app is on a public URL, immediately change the ADMIN PIN (Admin → Users) and give operators PINs — the seeded ADMIN/0000 is public knowledge.

## Admin (`/admin.html`)

Customers (codes, serial format regex + hint, report emails), Users (badge codes, PINs, admin flag), Reasons, Tracking Rules, Records (filter/export CSV), Reports (preview/dry-run or send now, send log), Settings (cadence, send hour, idle timeout, billing email).

## Tech

Node.js (>= 22.5) + Express + SQLite via Node's built-in `node:sqlite` (no native compile), no client framework. Sessions are in-memory with a sliding inactivity timeout. Nodemailer over Gmail SMTP (app password). node-cron scheduling in `America/Los_Angeles`.

```
server.js        Express app, API, session auth, cron scheduling
db.js            Schema + seed data (SQLite, WAL mode)
lib/validate.js  Scan classification, tracking normalization, serial checks
lib/reports.js   Customer summary + monthly billing emails
public/          index.html (operator), admin.html, barcodes.html
test/smoke.js    End-to-end API smoke test (npm test)
```

## Notes / decisions to revisit

- Report cadence is settable daily/weekly (`report_cadence`); weekly sends the trailing 7 days on the configured weekday.
- Times are stored UTC in SQLite; report windows are computed in Pacific time.
- Google SSO was skipped in favor of badge-code login for a fully scan-driven flow; it can be added later.
