// Generates HANDOFF.docx — one-page tester/admin handoff document.
const fs = require('fs');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat,
        AlignmentType, BorderStyle } = require('docx');

const B = (t) => new TextRun({ text: t, bold: true });
const T = (t) => new TextRun(t);
const P = (children, opts = {}) => new Paragraph({ children, spacing: { after: 60 }, ...opts });
const H = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 140, after: 60 },
  children: [new TextRun(t)],
});
const num = (ref, children) => new Paragraph({
  numbering: { reference: ref, level: 0 }, spacing: { after: 40 }, children,
});
const bul = (children) => new Paragraph({
  numbering: { reference: 'bullets', level: 0 }, spacing: { after: 40 }, children,
});

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 20 } } }, // 10pt for one-page fit
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal',
        run: { size: 30, bold: true, font: 'Arial' },
        paragraph: { spacing: { before: 0, after: 60 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal',
        run: { size: 23, bold: true, font: 'Arial', color: '1F4E79' },
        paragraph: { spacing: { before: 140, after: 60 }, outlineLevel: 1 } },
    ],
  },
  numbering: {
    config: [
      { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.',
        alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 240 } } } }] },
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•',
        alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 240 } } } }] },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1000, right: 1080, bottom: 1000, left: 1080 },
      },
    },
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1,
        children: [new TextRun('Kit Returns Receiving — Handoff Guide')] }),
      new Paragraph({
        spacing: { after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1F4E79', space: 1 } },
        children: [new TextRun({ size: 18, color: '666666',
          text: 'App URL: __________________________________________    Your admin login: code + PIN (from Jeff)' })],
      }),

      H('What this app does'),
      P([T('When returned wellness test kits arrive (refused, undeliverable, etc.), we record each one — customer, both tracking numbers, reason, and kit serial — before destroying it. Every night at 8pm Pacific, each customer automatically gets an email listing their returns (or a “no returns today” notice), and on the 1st of each month accounting gets a per-customer count for invoicing.')]),

      H('Receiving a return (the whole flow is scanner-driven — no mouse or keyboard needed)'),
      num('steps', [T('Log in with your user code (+ PIN if you have one). You are logged out automatically after 3 idle minutes so nobody records under your name.')]),
      num('steps', [T('Scan the customer barcode from the printed sheet (or tap the button on screen).')]),
      num('steps', [T('Scan the RETURN tracking barcode — the label the carrier used to send it back.')]),
      num('steps', [T('Scan the ORIGINAL outbound label, or scan/tap SAME if it is the same label.')]),
      num('steps', [T('Pick the return reason: press its number key, scan its barcode, or tap it.')]),
      num('steps', [T('Scan the kit SERIAL NUMBER. The app checks it matches that customer’s format and flags duplicates — if warned, re-scan the right barcode or scan OVERRIDE to accept.')]),
      P([T('The record saves with your name and a timestamp, and the screen loops to the next kit for the same customer. The sidebar on the right lists every serial scanned today, so you can see at a glance what’s already done.')]),

      H('The barcode sheet'),
      P([T('Everything scannable lives on one printable page: customer codes, return reasons, and command codes (SAME, CANCEL, CHANGE CUSTOMER, OVERRIDE, LOGOUT). Print it and post it at the receiving station — it’s what makes the flow hands-free. Find it via the '), B('Barcode sheets'), T(' link in the top bar after logging in (or add /barcodes.html to the app URL). Reprint it whenever customers or reasons change.')]),

      H('Operators vs. admins'),
      P([T('An '), B('operator'), T(' can only log in and record returns. An '), B('admin'), T(' can also open the Admin console (link on the login screen, or /admin.html) — and gets a 60-minute session instead of 3. Admin actions live in seven tabs:')]),
      bul([B('Customers'), T(' — add/edit customers, their serial-format rule, and the report email recipients (comma-separated). Set active=0 to retire.')]),
      bul([B('Users'), T(' — add operators (code + optional PIN), grant admin (is_admin=1), deactivate departures. Change your own PIN here.')]),
      bul([B('Reasons / Tracking Rules'), T(' — edit return reasons and the rules that clean carrier barcodes. Leave Tracking Rules alone unless a tracking number records wrong.')]),
      bul([B('Records'), T(' — search every return by date/customer; export all to CSV.')]),
      bul([B('Reports'), T(' — preview exactly what tonight’s emails will look like, send manually, and check the Send log (every attempt, with errors).')]),
      bul([B('Settings'), T(' — email send hour, daily vs. weekly cadence, idle-logout time, accounting email.')]),

      H('If something looks wrong'),
      P([T('Emails not arriving? Check Reports → Send log — the Status column says sent, preview (not configured), or the exact error. Screen looks stale after an update? Hard-refresh: Ctrl+Shift+R (Cmd+Shift+R on Mac). Deeper technical detail lives in the project repo: README.md and PROJECT_NOTES.md.')]),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(process.argv[2] || 'HANDOFF.docx', buf);
  console.log('written', (process.argv[2] || 'HANDOFF.docx'), buf.length, 'bytes');
});
