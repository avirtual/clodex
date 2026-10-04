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
  '/slowlink': () => '<title>Slow link</title><main><a href="/slow">Slow page</a></main>',
  '/echo': (req) => `<title>Echo</title><main><p>cookie header: ${String(req.headers.cookie || '(none)').replace(/[<>&]/g, '')}</p></main>`,
};

function server() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (url.pathname === '/hang') return;
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
  if (process.env.CXB_ONLY === 'pay') {
    await payStep(emit, base);
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

  engine.deactivate('browser-pane');
  await sleep(3000);
  srv.closeAllConnections();
  srv.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(`reply files kept under ${tmp}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
