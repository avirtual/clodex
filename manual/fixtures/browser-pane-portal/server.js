'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function months() {
  const out = [];
  let y = 2026;
  let m = 10;
  for (let i = 0; i < 30; i++) {
    out.push({ value: `${y}-${String(m).padStart(2, '0')}`, text: `${MONTH_NAMES[m - 1]} ${y}` });
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

function buildPdf() {
  const text = 'BT /F1 18 Tf 72 720 Td (Example Portal statement) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  body += `%${'x'.repeat(2000)}\n`;
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const PDF = buildPdf();
const MONTHS = months();

function page(title, main) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${main}</main></body></html>`;
}

const LOGIN_PAGE = page('Sign in — Example Portal', `<h1>Sign in</h1>
<form method="post" action="/login">
<label>Username <input type="text" name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form>`);

const BILLS_PAGE = page('My Bills — Example Portal', `<h1>My Bills</h1>
<p>Account ending 5678</p>
<label>Statement month <select name="month" id="month">${MONTHS.map((m) => `<option value="${m.value}">${m.text}</option>`).join('')}</select></label>
<button type="button" id="view">View</button>
<div id="row"></div>
<a href="/logout">Sign out</a>
<script>
document.getElementById('view').addEventListener('click', async () => {
  const m = document.getElementById('month').value;
  const r = await fetch('/bills/row?m=' + encodeURIComponent(m));
  document.getElementById('row').innerHTML = await r.text();
});
</script>`);

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function start() {
  const sessions = new Set();
  const log = [];
  let operatorFlag = false;
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const entry = { method: req.method, path: url.pathname, status: 0, sid: false, setSid: false };
    log.push(entry);
    const send = (status, headers, body) => {
      entry.status = status;
      res.writeHead(status, headers);
      res.end(body);
    };
    const html = (status, body, extra = {}) => send(status, { 'content-type': 'text/html; charset=utf-8', ...extra }, body);
    const issue = () => {
      const sid = crypto.randomBytes(12).toString('hex');
      sessions.add(sid);
      entry.setSid = true;
      return { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` };
    };
    let authed = sessions.has(cookies(req).sid);
    entry.sid = authed;
    let extra = {};
    if (req.method === 'POST' && url.pathname === '/__operator-login') {
      req.resume();
      operatorFlag = true;
      return send(204, {}, '');
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      req.resume();
      return send(302, { location: '/bills', ...issue() }, '');
    }
    if (req.method !== 'GET') { req.resume(); return send(405, {}, ''); }
    if (url.pathname === '/favicon.ico') return send(404, {}, '');
    if (!authed && operatorFlag) {
      operatorFlag = false;
      extra = issue();
      authed = true;
    }
    if (url.pathname === '/login') return html(200, LOGIN_PAGE, extra);
    if (url.pathname === '/' || url.pathname === '/bills') {
      if (!authed) return send(302, { location: '/login' }, '');
      return html(200, BILLS_PAGE, extra);
    }
    if (url.pathname === '/bills/row') {
      if (!authed) return send(403, { 'content-type': 'text/plain' }, 'forbidden');
      const m = MONTHS.find((x) => x.value === url.searchParams.get('m'));
      if (!m) return html(404, 'no such month', extra);
      return html(200, `<p>Statement ${m.text} · due 28 · $84.12</p><a href="/bills/${m.value}.pdf">Download PDF</a>`, extra);
    }
    const pdf = /^\/bills\/(\d{4})-(\d{2})\.pdf$/.exec(url.pathname);
    if (pdf) {
      if (!authed) return send(403, { 'content-type': 'text/plain' }, 'forbidden');
      const even = Number(pdf[2]) % 2 === 0;
      const name = `${pdf[1]}-${pdf[2]}.pdf`;
      return send(200, {
        'content-type': 'application/pdf',
        'content-length': PDF.length,
        'content-disposition': even ? `attachment; filename="${name}"` : `inline; filename="${name}"`,
        ...extra,
      }, PDF);
    }
    if (url.pathname === '/logout') return html(200, page('Signed out', '<p>Signed out</p>'), extra);
    return html(404, page('Not found', '<p>nope</p>'), extra);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      resolve({
        base,
        log,
        pdf: PDF,
        months: MONTHS,
        close() { srv.closeAllConnections(); return new Promise((r) => srv.close(() => r())); },
      });
    });
  });
}

module.exports = { start, PDF, MONTHS };

if (require.main === module) {
  start().then((s) => console.log(`portal fixture at ${s.base}/bills`));
}
