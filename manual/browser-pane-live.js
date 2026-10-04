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

const PAGES = {
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
  '/echo': (req) => `<title>Echo</title><main><p>cookie header: ${String(req.headers.cookie || '(none)').replace(/[<>&]/g, '')}</p></main>`,
};

function server() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const headers = { 'content-type': 'text/html; charset=utf-8' };
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
      _injectText(_s, text) { if (waiter) { const w = waiter; waiter = null; w(text); } },
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
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
  const emit = (line) => {
    const p = new Promise((r) => { waiter = r; });
    pluginRowFor('browser').handler(handle, parseWithRegistry(line));
    return p.then((reply) => { console.log(`> ${line}\n< ${reply}`); return reply; });
  };
  return { engine, emit };
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
  let { engine, emit } = bootEngine(userData, tmp);

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

  console.log('== 4. persistence across a restart');
  await emit(`[agent:browser open jar] ${base}/set`);
  engine.deactivate('browser-pane');
  await sleep(4000);
  ({ engine, emit } = bootEngine(userData, tmp));
  await emit(`[agent:browser open jar] ${base}/echo`);
  show(fileOf(await emit('[agent:browser read jar --text]')), (l) => /cookie header/.test(l));
  await emit('[agent:browser services]');

  engine.deactivate('browser-pane');
  await sleep(3000);
  srv.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(`reply files kept under ${tmp}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
