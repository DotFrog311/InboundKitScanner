# Project Notes — Kit Returns Receiving

Orientation document for future work sessions (human or AI). Read this plus README.md
before changing anything. Last updated: 2026-07-09.

## What this is

Scan-driven web app for the warehouse team to receive returned wellness test kits
(document arrival, reason, and serial; kits are then destroyed). Sends per-customer
email summaries at 8pm Pacific and a monthly billing rollup to accounting.
Full feature and architecture description: README.md.

## Where everything lives

| Thing | Location |
|---|---|
| Source of truth | GitHub: `DotFrog311/InboundKitScanner`, branch `main` |
| Hosting | Railway — project "passionate-dream", service "InboundKitScanner". Every push to `main` auto-deploys. |
| App URL | Generated Railway domain (Railway → service → Settings → Networking) |
| Database | SQLite on a Railway volume mounted at `/data` (`DATA_DIR=/data`). NOT in git. Deleting the volume deletes all records/users/customers. |
| Email sender | Gmail API via Google Cloud project **"Kit Returns"** (kit-returns), org dotprinter.com. OAuth client type: Web application, redirect URI = OAuth Playground. |
| Local working copy | `returns-app/` in Jeff's "Karla" Claude workspace folder |

## Accounts & credentials (values not stored here!)

- GitHub account: DotFrog311. Pushes from a Claude session need a fresh fine-grained
  PAT (Contents: read/write on this repo). Old tokens were revoked.
- Railway login: Jeff's GitHub account.
- App admin login: user code `ADMIN` (PIN changed from default 0000 — Jeff knows it).
  Operators are managed in Admin → Users.
- Railway environment variables (Service → Variables):
  - `DATA_DIR=/data`
  - `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` — from Google
    Cloud "Kit Returns" project + OAuth Playground (recipe in .env.example)
  - `EMAIL_FROM=jeff@dotprinter.com`
  - (legacy `SMTP_*` vars may exist; unused — Gmail API takes priority.
    Railway trial/hobby BLOCKS SMTP ports, which is why Gmail API over HTTPS is used.)

## Key design decisions (and why)

- **Badge-code login, not Google SSO** — keeps the flow 100% scannable; 3-min idle
  auto-logout so operators can't act as each other. Admins get 60 min.
- **Everything is a barcode**: `CUST-*` customers, `RSN-*` reasons, `CMD-*` commands
  (SAME / CANCEL / CUSTOMER / OVERRIDE / LOGOUT), printable at `/barcodes.html`
  (public page, no login; link shown only after login). Reasons also selectable
  by number-pad key.
- **Tracking normalization is data-driven** (Admin → Tracking Rules): USPS 420+ZIP
  → trailing 22 digits (rule must outrank the generic FedEx length rules);
  FedEx 34/32-digit → last 12; 25-digit → strip first 10. Raw scan always stored
  alongside normalized.
- **Serial validation** per customer regex (Junction `^J[A-Za-z0-9]+$`, LabCorp
  On-Demand `^[0-9]{12}$`). Mismatch or duplicate serial ⇒ operator must rescan or
  scan OVERRIDE (flagged in the record).
- **Emails**: customer summaries daily 8pm PT (cadence + hour in Admin → Settings,
  can switch to weekly); monthly billing to `billing_email` setting on the 1st.
  No credentials ⇒ "preview" mode, visible in Admin → Reports → Send log.

## Current state / to-do when resuming

- [ ] Confirm Railway volume is truly mounted at `/data` (Railway agent once
      reported /data missing — if DATA_DIR and mount path mismatch, data is
      ephemeral and dies on redeploy)
- [ ] Verify Gmail API send works end-to-end (Send log should show "sent")
- [ ] Testing recipients: both customers email jshattuck@gmail.com; billing goes
      to jeff@dotprinter.com. Replace with real customer emails before go-live.
- [ ] Only 2 of ~10 customers configured; add the rest with serial rules
      (Admin → Customers)
- [ ] Add real operator user codes; consider per-operator PINs
- [ ] Decide daily vs weekly cadence per rollout feedback
- [ ] Railway trial ends → move to Hobby plan (~$5/mo) so the app stays up

## How to resume work with Claude

1. Open a Cowork session with the Karla folder connected (this file is in
   `returns-app/`), and say what you want to change.
2. Tell Claude to read `PROJECT_NOTES.md` and `README.md` first.
3. For Claude to push: create a new fine-grained GitHub PAT (this repo only,
   Contents read/write, short expiry) and paste it in chat; revoke after.
4. Railway redeploys automatically on push — hard-refresh the browser
   (Ctrl/Cmd+Shift+R) to see UI changes.
