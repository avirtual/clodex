'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');
const { createPluginHostEngine } = require(path.join(ROOT, 'plugin-host-engine'));
const { HOST_API_VERSION } = require(path.join(ROOT, 'plugin-api'));
const { childSpawnSpec } = require(path.join(ROOT, 'electron-child'));
const { parseWithRegistry, pluginRowFor } = require(path.join(ROOT, 'intent-registry'));

const PLUGIN_DIR = path.join(ROOT, 'plugins', 'browser-pane');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

const navLink = (m, i) => `<div><a href="/chrome-a?m=${i}&t=${Date.now()}">${m}</a></div>`;
const chromePage = (title, mid) => `<title>${title}</title><main>
${['Acasa', 'Avizier', 'Plati online', 'Index contoare', 'Mesaje', 'Contul meu'].map(navLink).join('')}
${mid}<p>${title} al asociatiei de proprietari: cheltuieli comune, consumuri individuale, fond de rulment si fond de reparatii, defalcate pe apartament.</p>
${['Termeni si conditii', 'Confidentialitate', 'Ajutor', '© 2026 Asociatia'].map((m, i) => navLink(m, 10 + i)).join('')}</main>`;

const PAGES = {
  '/dl': () => `<title>Downloads</title><main><a href="/att">Attachment</a> <a href="/inline.pdf">Inline PDF</a>
<a href="/named-src" download="named-by-page.pdf">Named</a> <a href="/gated.pdf">Gated</a>
<form method="post" action="/post-att"><button>Post for PDF</button></form>
<button onclick="window.open('/inline.pdf', '_blank')">Popup PDF</button></main>`,
  '/pay': () => '<title>Pay</title><main><a href="/interstitial">Pay now</a></main>',
  '/interstitial': () => `<title>Processing payment</title><main><p>Processing…</p><form method="post" action="/slow-post"></form>
<script>setTimeout(() => document.forms[0].submit(), 300)</script></main>`,
  '/links': () => {
    const rows = [];
    for (let i = 1; i <= 700; i++) {
      const href = i % 7 === 0 ? `/files/report-${i}.pdf` : `/page/${i}`;
      rows.push(`<li><a href="${href}">Release table ${i} — monthly statistical series and notes</a></li>`);
    }
    return `<title>Links fixture</title><main><h1>Seven hundred links</h1><ul>${rows.join('')}</ul></main>`;
  },
  '/shadow': () => `<title>Shadow fixture</title><main><h1>Shadow</h1><pay-widget></pay-widget></main>
<script>customElements.define('pay-widget', class extends HTMLElement { connectedCallback() {
  const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<button>Shadow Pay</button>'; } });</script>`,
  '/login': () => `<title>Sign in</title><main><form><label>Email <input type="email" name="email"></label>
<label>Password <input type="password" name="pw"></label><button>Sign in</button></form></main>`,
  '/form': () => `<title>Form</title><main><label>Find <input id=q></label><button onclick="document.title='clicked'">Go</button>
<select id=m><option>July 2026</option><option>August 2026</option></select><a href="/shadow">Shadow page</a></main>`,
  '/clickables': () => {
    const months = [];
    for (let i = 1; i <= 80; i++) months.push(`<option>Luna ${i} din arhivă</option>`);
    return `<title>Avizier</title><main><h1>Avizier</h1><select id=luna>${months.join('')}</select>
<table><tr><th>Contor</th><th>Valoare</th><th>Total</th></tr><tr><td>Index precedent</td><td></td><td>19,486</td></tr></table>
<div onclick="document.title='div clicked'">Lista de plată 08/2026</div>
<p><a onclick="window.open('/inline.pdf')">Lista de plată 07/2026 PDF</a></p>
<table><tr id=prow style="cursor:pointer"><td>Factura iulie</td><td><b>120 lei</b></td></tr></table>
<p><span>Duplicat</span> <span>Duplicat</span></p></main>
<script>document.getElementById('prow').addEventListener('click', () => { document.title = 'row clicked'; });</script>`;
  },
  '/effects': () => {
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    return `<title>Effects</title><main><h1>Efecte</h1>
<p>${'Avizierul asociației de proprietari arată consumul lunar, soldul și listele de plată ale fiecărui apartament. '.repeat(3)}</p>
<button onclick="document.getElementById('out').textContent='Sold nou: 120 lei'">Recalculează</button><div id=out>Sold: 0 lei</div>
<select id=luna onchange="document.getElementById('tb').innerHTML = this.value === 'aug' ? '<tr><td>August</td><td>Apă rece 11</td></tr>' : '<tr><td>Iulie</td><td>Apă rece 10</td></tr>'">
<option value=iul>Iulie</option><option value=aug>August</option></select>
<table id=tb><tr><td>Iulie</td><td>Apă rece 10</td></tr></table>
<span onclick="document.title='locked'" style="display:inline-block"><img alt="padlock" src="${gif}" width=16 height=16></span>
<table><tr><td><img src="${gif}" width=16 height=16></td><td><img src="${gif}" width=16 height=16></td><td>Lista de plată 08/2026 11:09:38</td></tr></table>
<a href="/att">Factura PDF</a>
<div id=ondiv onclick="document.title='div'">Lista onclick</div></main>`;
  },
  '/chrome-a': () => chromePage('Avizier aprilie', '<p>Factura aprilie: 98 lei</p><p>Restanta: 0 lei</p>'),
  '/chrome-b': () => chromePage('Avizier mai', '<p>Factura mai: 120 lei</p><p>Index apa: 19,486</p><p>Scadenta: 25 mai</p><p><a href="/chrome-a?pdf=5">Factura mai PDF</a></p>'),
  '/offscreen': () => `<title>Offscreen</title><main><h1>Ascunse</h1>
<p>${'Indexurile contoarelor de apa se trimit lunar, pana la data de 25, din pagina asociatiei de proprietari. '.repeat(3)}</p>
<a href="/x" class="highslide-loading" style="position:absolute; top:-9999px; opacity:0.75">INCARCA...</a>
<div class="loading" style="position:absolute; left:-9999px">Se incarca</div>
<button style="opacity:0">Invizibil</button>
<span onclick="document.title='clip'" style="position:absolute; clip:rect(0,0,0,0)">Taiat</span>
<span onclick="document.title='mic'" style="display:inline-block; width:1px; height:1px; overflow:hidden">Minuscul</span>
<a href="/form">Pagina vizibila</a>
<p><a onclick="document.title='lock'"><img src="/img/lock.png?v=3" width=16 height=16></a></p>
<table><tr><th>Data</th><th>Suma</th><th>Platit</th></tr><tr><td>01.08</td><td>120 lei</td><td><img src="/img/tick.png" width=16 height=16></td></tr></table>
<table id=idx><tr><th>Nume</th><th>Index precedent</th><th>Index curent</th></tr><tr><td>APA</td><td>0,000</td><td id=cur>0,000</td></tr><tr><td>GAZ</td><td>1,000</td><td>2,000</td></tr></table>
<button onclick="document.getElementById('cur').textContent='6,834'">Salveaza index</button></main>`,
  '/busy': () => `<title>Busy</title><main><div class="loading">INCARCA...</div><p id=st>Asteptam datele</p></main>
<script>setTimeout(() => fetch('/delay4').then(r => r.text()).then(t => {
  document.querySelector('.loading').style.display = 'none'; document.getElementById('st').textContent = t;
}), 2000);</script>`,
  '/slowlink': () => '<title>Slow link</title><main><a href="/slow">Slow page</a></main>',
  '/echo': (req) => `<title>Echo</title><main><p>cookie header: ${String(req.headers.cookie || '(none)').replace(/[<>&]/g, '')}</p></main>`,
};

function server() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (url.pathname === '/hang') return;
      if (url.pathname.startsWith('/img/')) {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
        return;
      }
      const pdf = (extra = {}) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length, ...extra }); res.end(PDF); };
      if (url.pathname === '/att' || url.pathname === '/post-att') return pdf({ 'content-disposition': 'attachment; filename="statement-att.pdf"' });
      if (url.pathname === '/inline.pdf') return pdf({ 'content-disposition': 'inline' });
      if (url.pathname === '/named-src') return pdf();
      if (url.pathname === '/gated.pdf') {
        if (!/sid=live-check-123/.test(String(req.headers.cookie || ''))) { res.writeHead(403, headers); res.end('forbidden'); return; }
        return pdf();
      }
      if (url.pathname === '/slow-post') {
        req.resume();
        setTimeout(() => { res.writeHead(200, headers); res.end('<title>Payment done</title><main><p>Payment done</p></main>'); }, 17000);
        return;
      }
      if (url.pathname === '/delay4') {
        setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Gata: 3 facturi'); }, 4000);
        return;
      }
      if (url.pathname === '/stall') {
        res.writeHead(200, headers);
        res.end('<title>Stall</title><main><p>waiting</p><img src="/hang"></main>');
        return;
      }
      if (url.pathname === '/slow') {
        setTimeout(() => { res.writeHead(200, headers); res.end('<title>Slow done</title><main><p>Slow done</p></main>'); }, 17000);
        return;
      }
      if (url.pathname === '/stall-login') {
        res.writeHead(200, headers);
        res.end('<title>Stalled sign-in</title><main><form><input type="password"></form><img src="/hang"></main>');
        return;
      }
      if (url.pathname === '/set') {
        headers['set-cookie'] = 'sid=live-check-123; Path=/; HttpOnly';
        res.writeHead(200, headers);
        res.end('<title>Set</title><main><p>cookie set</p></main>');
        return;
      }
      const page = PAGES[url.pathname];
      res.writeHead(page ? 200 : 404, headers);
      res.end(page ? `<!doctype html><html><body>${page(req)}</body></html>` : 'nope');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let pendingWait = null;
let liveHandle = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bootEngine(userData, tmp) {
  const sessions = new Map([['live-seat', { name: 'live-seat', type: 'claude', cwd: tmp, workspaceId: 'w' }]]);
  let waiter = null;
  const engine = createPluginHostEngine({
    manager: {
      sessions,
      list: () => [...sessions.values()],
      listForWorkspace: () => [...sessions.values()],
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
      _injectText(_s, text) {
        if (pendingWait) { const w = pendingWait; pendingWait = null; w(text); return; }
        if (waiter) { const w = waiter; waiter = null; w(text); }
      },
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    getNotifications: () => ({ add: (rec) => { console.log(`[notify] ${rec.body.replace(/\n+/g, ' | ')}`); return { id: 1 }; } }),
    log: { info: (s, m) => process.stderr.write(`[log] ${m}\n`), error: (s, m) => process.stderr.write(`[err] ${m}\n`) },
    userDataPath: userData,
    fs, path,
    gitWorktree: {},
    electronChild: (script, extraArgs) => childSpawnSpec({
      execPath: ELECTRON, isPackaged: false, appPath: ROOT, script, extraArgs, env: process.env,
    }),
  });
  const host = engine.register('browser-pane', require(path.join(PLUGIN_DIR, 'engine')), { hostApi: HOST_API_VERSION }, { dir: PLUGIN_DIR });
  const handle = host.sessions.get('live-seat');
  liveHandle = () => handle;
  const emit = (line) => {
    const p = new Promise((r) => { waiter = r; });
    pluginRowFor('browser').handler(handle, parseWithRegistry(line));
    return p.then((reply) => { console.log(`> ${line}\n< ${reply}`); return reply; });
  };
  return { engine, emit, host };
}

function landed(reply) {
  const m = / → "?(\/[^"]+?\.pdf)"? · /.exec(reply);
  if (!m) return '    (no file)';
  const head = fs.readFileSync(m[1]).subarray(0, 5).toString('latin1');
  return `    ${m[1]} · ${fs.statSync(m[1]).size} B · starts ${JSON.stringify(head)} · same bytes: ${fs.readFileSync(m[1]).equals(PDF)}`;
}

async function clickablesStep(emit, base) {
  console.log('== 7. script-only clickables, click --text, select options and table rows in the text');
  const check = (name, ok) => console.log(`    ${ok ? 'PASS' : 'FAIL'} ${name}`);
  await emit(`[agent:browser open avizier] ${base}/clickables`);
  const content = fileOf(await emit('[agent:browser read avizier]'));
  const lines = content.split('\n');
  const cut = lines.indexOf('== elements ==');
  const text = lines.slice(0, cut).join('\n');
  const els = lines.slice(cut + 1).filter((l) => /^\[\d+\]/.test(l));
  for (const l of els) console.log(`    ${l.slice(0, 120)}`);
  for (const l of lines.slice(0, cut).filter((x) => / \| /.test(x))) console.log(`    ${l}`);
  check('a div with onclick is numbered as clickable', els.some((l) => /\] clickable "Lista de plată 08\/2026"$/.test(l)));
  check('an <a> without href is numbered', els.some((l) => /\] clickable "Lista de plată 07\/2026 PDF"$/.test(l)));
  check('a pointer-cursor row is numbered once', els.filter((l) => /Factura/.test(l)).length === 1 && !els.some((l) => /"120 lei"/.test(l)));
  check('select options are absent from the text', !/Luna 1 din arhivă/.test(text));
  check('a table row with an empty cell is one line', text.split('\n').includes('Index precedent | | 19,486'));
  check('click --text unique', /clicked avizier \[\d+\] clickable "Lista de plată 08\/2026"/.test(await emit('[agent:browser click avizier --text="plată 08/2026"]')));
  check('click --text none', /no visible element with the text "Nimic aici"/.test(await emit('[agent:browser click avizier --text="Nimic aici"]')));
  check('click --text ambiguous', /"Duplicat" matches 2 visible elements on avizier: \[\d+\] "Duplicat", \[\d+\] "Duplicat"/.test(await emit('[agent:browser click avizier --text=Duplicat]')));
  await emit('[agent:browser read avizier]');
  check('a window.open PDF is saved, not rendered', /→ download \S+\.pdf · \d+ B · application\/pdf · from \S+ \(PDF popup\)/.test(await emit('[agent:browser click avizier --text="07/2026 PDF"]')));
}

async function effectsStep(emit, base, cwd) {
  console.log('== 8. act replies report their effect; icon labels, image-only cells, click downloads, inspect');
  const check = (name, ok) => console.log(`    ${ok ? 'PASS' : 'FAIL'} ${name}`);
  await emit(`[agent:browser open effects] ${base}/effects`);
  const content = fileOf(await emit('[agent:browser read effects]'));
  const lines = content.split('\n');
  const els = lines.filter((l) => /^\[\d+\]/.test(l));
  const num = (re) => { const l = els.find((x) => re.test(x)); return l ? /^\[(\d+)\]/.exec(l)[1] : '0'; };
  for (const l of els) console.log(`    ${l.slice(0, 120)}`);
  for (const l of lines.slice(0, lines.indexOf('== elements ==')).filter((x) => /\|/.test(x))) console.log(`    ${JSON.stringify(l)}`);
  check('an icon-only clickable takes the img alt as its label', els.some((l) => /\] clickable "padlock"$/.test(l)));
  check('a row with two image-only cells keeps both slots', lines.includes('| | Lista de plată 08/2026 11:09:38'));
  check('a button that rewrites a div reports the new text',
    /same page · .* · changed: "Sold nou: 120 lei"$/.test(await emit(`[agent:browser click effects ${num(/button Recalculează/)}]`)));
  check('a select that swaps a table carries the new row',
    /changed: "[^"]*August[^"]*Apă rece 11[^"]*"$/.test(await emit(`[agent:browser select effects ${num(/^\[\d+\] select/)}] August`)));
  check('a key with no effect says no visible change', / · no visible change$/.test(await emit('[agent:browser key effects] Escape')));
  const pdf = num(/link Factura PDF/);
  const first = await emit(`[agent:browser click effects ${pdf} --to=downloads]`);
  const m = / → download (\S+\.pdf) · \d+ B · application\/pdf · from http/.exec(first);
  check('a click download names the full path under the seat cwd with size, type and source',
    !!m && m[1].startsWith(fs.realpathSync(cwd) + path.sep + 'downloads') && fs.existsSync(m[1]));
  const second = await emit(`[agent:browser click effects ${pdf} --to=downloads]`);
  check('a repeat click download is reported as the same file and not saved twice',
    !!m && second.includes(`→ download same as ${m[1]} · `) && fs.readdirSync(path.dirname(m[1])).length === 1);
  const insp = await emit(`[agent:browser inspect effects --text="Lista onclick"]`);
  check('inspect on the onclick div lists its click listener', /\n {2}listeners: click(\n|,| ·)/.test(insp));
  check('inspect shows the onclick attribute and the html', /attrs: onclick=/.test(insp) && /\n {2}html: <div id="ondiv"/.test(insp));
}

async function chromeStep(emit, base) {
  console.log('== 9. repeated menu and footer are stripped across reads; a page still loading says so');
  const check = (name, ok) => console.log(`    ${ok ? 'PASS' : 'FAIL'} ${name}`);
  const rows = (content) => content.split('\n').filter((l) => /^(stripped|loading):/.test(l));
  await emit(`[agent:browser open chrome] ${base}/chrome-a`);
  const firstRead = await emit('[agent:browser read chrome]');
  await emit(`[agent:browser open chrome] ${base}/chrome-b`);
  const second = await emit('[agent:browser read chrome]');
  const f2 = fileOf(second);
  for (const l of f2.split('\n').slice(0, 12)) console.log(`    ${l}`);
  check('second read header says 6 lines at top, 4 at bottom', rows(f2).includes('stripped: 6 lines at top, 4 at bottom (same as your last read of chrome)'));
  check('second read reply says chrome stripped', / · chrome stripped( → | · )/.test(second));
  check('second read text keeps the middle and drops the menu', /Factura mai/.test(f2) && !/Plati online|Confidentialitate/.test(f2.split('== elements ==')[0]));
  const hid = /elements: (\d+) \((\d+) repeated, hidden — still clickable by number; read --all lists them;/.exec(f2);
  console.log(`    ${f2.split('\n').find((l) => /^doc:/.test(l))}`);
  check('second read header counts the repeated nav links as hidden', !!hid && Number(hid[2]) >= 6);
  check('second read reply says N elements hidden', !!hid && second.includes(` · ${hid[2]} elements hidden`));
  check('the hidden nav links are absent from the element list and the new link is listed',
    !/\] link Avizier/.test(f2) && /\] link Factura mai PDF/.test(f2));
  const firstEls = fileOf(firstRead).split('\n').filter((l) => /^\[\d+\] link Avizier/.test(l));
  const avizier = firstEls.length ? /^\[(\d+)\]/.exec(firstEls[0])[1] : '0';
  check(`a hidden number [${avizier}] still clicks the same link`,
    new RegExp(`clicked chrome \\[${avizier}\\] link "Avizier"`).test(await emit(`[agent:browser click chrome ${avizier}]`)));
  await emit(`[agent:browser open chrome] ${base}/chrome-b`);
  await emit('[agent:browser read chrome]');
  const all = await emit('[agent:browser read chrome --all]');
  const fa = fileOf(all);
  check('read --all has no stripped: row and keeps the menu', !rows(fa).length && /Plati online/.test(fa) && !/chrome stripped/.test(all));
  await emit(`[agent:browser open busy] ${base}/busy`);
  const t0 = Date.now();
  const r1 = await emit('[agent:browser read busy]');
  const f1 = fileOf(r1);
  console.log(`    read ${Date.now() - t0} ms after open: ${JSON.stringify(rows(f1))}`);
  check('read within 1 s shows the visible loading element', rows(f1).includes('loading: page shows "INCARCA..." (1 busy element(s))'));
  check('read within 1 s reply says still loading', / · still loading → /.test(r1));
  await sleep(2000);
  const fm = fileOf(await emit('[agent:browser read busy]'));
  console.log(`    read during the fetch: ${JSON.stringify(rows(fm))}`);
  check('read during the delayed fetch shows requests in flight', rows(fm).some((l) => /^loading: yes \(1 requests in flight\)/.test(l)));
  await emit('[agent:browser wait busy --ms=15000 --for="Gata"]');
  const r3 = await emit('[agent:browser read busy]');
  const f3 = fileOf(r3);
  console.log(`    after wait: ${JSON.stringify(rows(f3))}`);
  check('read after wait shows no loading row and no still loading', !rows(f3).some((l) => /^loading:/.test(l)) && !/still loading/.test(r3));
}

async function offscreenStep(emit, base) {
  console.log('== 10. elements parked off-screen or clipped away are not visible; icon file names; table rows in act changes');
  const check = (name, ok) => console.log(`    ${ok ? 'PASS' : 'FAIL'} ${name}`);
  await emit(`[agent:browser open offscreen] ${base}/offscreen`);
  const reply = await emit('[agent:browser read offscreen]');
  const content = fileOf(reply);
  const lines = content.split('\n');
  const els = lines.filter((l) => /^\[\d+\]/.test(l));
  for (const l of els) console.log(`    ${l}`);
  for (const l of lines.filter((x) => / \| |\|$/.test(x))) console.log(`    ${JSON.stringify(l)}`);
  check('no loading: row and no still loading', !lines.some((l) => /^loading:/.test(l)) && !/still loading/.test(reply));
  check('the off-screen link, off-screen div, transparent button, clipped span and 1×1 span are not listed',
    !els.some((l) => /INCARCA|Se incarca|Invizibil|Taiat|Minuscul/.test(l)));
  check('the ordinary link is listed', els.some((l) => /\] link Pagina vizibila → \/form$/.test(l)));
  check('an icon link without alt is labelled by its img file name', els.some((l) => /\] clickable "lock\.png"$/.test(l)));
  check('the remaining elements are the ordinary link, the icon and the save button', els.length === 3);
  check('a trailing image-only cell keeps its slot', lines.some((l) => /^01\.08 \| 120 lei \|\s?$/.test(l)));
  const save = /^\[(\d+)\] button Salveaza/.exec(els.find((l) => /Salveaza/.test(l)) || '');
  const act = await emit(`[agent:browser click offscreen ${save ? save[1] : 0}]`);
  check('a changed table cell reports the header row and the changed row',
    / · changed: "Nume \| Index precedent \| Index curent ⏎ APA \| 0,000 \| 6,834"$/.test(act));
  const ins = await emit('[agent:browser inspect offscreen --text="INCARCA"]');
  check('click/inspect --text finds no visible off-screen spinner', /no visible element with the text "INCARCA"/.test(ins));
}

async function payStep(emit, base) {
  console.log('== 6. a click that commits an interstitial which auto-POSTs to a 17 s endpoint');
  await emit(`[agent:browser open pay] ${base}/pay`);
  await emit('[agent:browser read pay]');
  await emit('[agent:browser click pay 1]');
  await emit('[agent:browser wait pay --ms=15000 --for="Payment done"]');
}

function fileOf(reply) {
  const m = / → @(\S+) $/.exec(reply);
  return m ? fs.readFileSync(m[1], 'utf8') : '';
}

function show(content, pick) {
  const lines = content.split('\n');
  for (const l of lines.slice(0, 6)) console.log(`    ${l}`);
  for (const l of lines.filter(pick).slice(0, 4)) console.log(`    ${l}`);
  console.log(`    ${lines[lines.length - 2]}`);
}

async function main() {
  const srv = await server();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-live-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-live-tmp-'));
  process.env.TMPDIR = tmp;
  let { engine, emit, host } = bootEngine(userData, tmp);
  if (['pay', 'clickables', 'effects', 'chrome', 'offscreen'].includes(process.env.CXB_ONLY)) {
    if (process.env.CXB_ONLY === 'offscreen') await offscreenStep(emit, base);
    else if (process.env.CXB_ONLY === 'chrome') await chromeStep(emit, base);
    else if (process.env.CXB_ONLY === 'effects') await effectsStep(emit, base, tmp);
    else await (process.env.CXB_ONLY === 'pay' ? payStep : clickablesStep)(emit, base);
    engine.deactivate('browser-pane');
    await sleep(3000);
    srv.closeAllConnections();
    srv.close();
    return;
  }

  console.log('== 1. 700 links');
  await emit(`[agent:browser open fixture] ${base}/links`);
  show(fileOf(await emit('[agent:browser read fixture --links]')), () => false);
  show(fileOf(await emit('[agent:browser read fixture --links --filter=.pdf]')), (l) => /^\[\d+\]/.test(l));

  console.log('== 2. open shadow root');
  await emit(`[agent:browser open fixture] ${base}/shadow`);
  show(fileOf(await emit('[agent:browser read fixture]')), (l) => /Shadow Pay/.test(l));

  console.log('== 3. login page');
  await emit(`[agent:browser open signin] ${base}/login`);
  show(fileOf(await emit('[agent:browser read signin]')), (l) => /input:password/.test(l));

  console.log('== 3b. unroutable URL on a fresh service');
  await emit('[agent:browser open dead] http://127.0.0.1:59321/');

  console.log('== 3c. a subresource that never finishes');
  await emit(`[agent:browser open stall] ${base}/stall`);
  await emit('[agent:browser read stall]');

  console.log('== 3d. a sign-in page with a subresource that never finishes');
  await emit(`[agent:browser open stallin] ${base}/stall-login`);
  await emit('[agent:browser read stallin]');

  console.log('== 3e. acts through the child');
  await emit(`[agent:browser open fixture] ${base}/form`);
  show(fileOf(await emit('[agent:browser read fixture]')), (l) => /^\[\d+\]/.test(l));
  await emit('[agent:browser type fixture 1 --enter] Form 1040');
  await emit('[agent:browser click fixture 2]');
  await emit('[agent:browser select fixture 3] august');
  await emit('[agent:browser key fixture] Tab');
  await emit('[agent:browser click fixture 4]');
  await emit('[agent:browser click fixture 2]');
  const back = new Promise((r) => { pendingWait = r; });
  pluginRowFor('browser').handler(liveHandle(), parseWithRegistry('[agent:browser wait signin]'));
  console.log(`handback → ${JSON.stringify(await engine.dispatch('browser-pane', 'handback', ['signin'], 'desktop'))}`);
  console.log(`< ${await back}`);
  show(fileOf(await emit('[agent:browser read signin]')), (l) => /input:password/.test(l));
  await emit('[agent:browser type signin 2] hunter2');

  console.log('== 3f. a click whose navigation answers after 17 s is not cancelled');
  await emit(`[agent:browser open slow] ${base}/slowlink`);
  await emit('[agent:browser read slow]');
  await emit('[agent:browser click slow 1]');
  await emit('[agent:browser wait slow --ms=10000 --for="Slow done"]');

  console.log('== 4. persistence across a restart');
  await emit(`[agent:browser open jar] ${base}/set`);
  engine.deactivate('browser-pane');
  await sleep(4000);
  ({ engine, emit, host } = bootEngine(userData, tmp));
  await emit(`[agent:browser open jar] ${base}/echo`);
  show(fileOf(await emit('[agent:browser read jar --text]')), (l) => /cookie header/.test(l));
  await emit('[agent:browser services]');

  console.log('== 5. downloads');
  await emit(`[agent:browser open docs] ${base}/set`);
  await emit(`[agent:browser open docs] ${base}/dl`);
  show(fileOf(await emit('[agent:browser read docs]')), (l) => /^\[\d+\]/.test(l));
  console.log(landed(await emit('[agent:browser download docs 1 --to=bills]')));
  console.log(landed(await emit('[agent:browser download docs 2 --to=bills]')));
  console.log(landed(await emit('[agent:browser download docs 3 --to=bills]')));
  console.log(landed(await emit('[agent:browser download docs 4 --to=bills --as=gated]')));
  console.log(`    gated without the session: ${(await fetch(`${base}/gated.pdf`)).status}`);
  console.log(landed(await emit('[agent:browser download docs 5 --to=bills --as=posted.pdf]')));
  console.log(landed(await emit('[agent:browser download docs 6 --to=bills --as=popup.pdf]')));
  await emit('[agent:browser download docs --to=../escape]');
  const part = path.join(host.paths.dataDir, 'chromium', 'Partitions', 'docs');
  console.log(`    ${part} exists: ${fs.existsSync(part)}`);

  console.log('== 5b. screenshots');
  await emit('[agent:browser screenshot docs]');
  const pid = host && engine && require('node:child_process').execSync('pgrep -f "cxb-data=' + path.join(host.paths.dataDir, 'chromium') + '" | head -1').toString().trim();
  try {
    require('node:child_process').execSync(`osascript -e 'tell application "System Events" to set value of attribute "AXMinimized" of (first window whose name starts with "docs") of (first process whose unix id is ${pid}) to true'`, { stdio: 'pipe' });
    console.log('    minimized the docs window');
  } catch (e) { console.log(`    could not minimize: ${String(e.stderr || e.message).trim().slice(0, 200)}`); }
  await sleep(1500);
  const shot = await emit('[agent:browser screenshot docs]');
  const sm = / → @(\S+) $/.exec(shot);
  if (sm) console.log(`    ${sm[1]} · ${fs.statSync(sm[1]).size} B`);

  await payStep(emit, base);
  await clickablesStep(emit, base);
  await effectsStep(emit, base, tmp);
  await chromeStep(emit, base);
  await offscreenStep(emit, base);

  engine.deactivate('browser-pane');
  await sleep(3000);
  srv.closeAllConnections();
  srv.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(`reply files kept under ${tmp}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
