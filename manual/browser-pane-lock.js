'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const driver = require('../plugins/browser-pane/driver');
const lock = require('../plugins/browser-pane/lock');
const scripts = require('../plugins/browser-pane/page-scripts');

const PAGES = {
  '/act': () => `<title>Act</title><input id=a style="position:absolute;left:20px;top:20px;width:200px">
<button id=b style="position:absolute;left:20px;top:80px;width:120px;height:40px" onclick="window.clicks=(window.clicks||0)+1">Press</button>`,
  '/irs': () => `<title>Find forms</title><label>Find <input id=q></label><div id=out></div>
<script>document.getElementById('q').addEventListener('keydown', e => { if (e.key !== 'Enter') return;
  fetch('/api/search?q=' + encodeURIComponent(e.target.value)).then(r => r.text()).then(t => { document.getElementById('out').textContent = t; }); });</script>`,
  '/select': () => `<title>Select</title><label>Month <select id=m><option value="2026-07">July 2026</option>
<option value="2026-08">August 2026</option><option value="2025-08">August 2025</option></select></label>
<script>
  const el = document.getElementById('m');
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  let tracked = el.value;
  Object.defineProperty(el, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { tracked = String(v); proto.set.call(this, v); } });
  window.onChangeFired = 0;
  document.addEventListener('change', e => { if (e.target === el && el.value !== tracked) { tracked = el.value; window.onChangeFired++; } }, true);
</script>`,
  '/ajax': () => `<title>Ajax</title><div id=list></div>
<script>let gen = 0; function render() { gen++; document.getElementById('list').innerHTML =
  '<button onclick="setTimeout(render, 50)">Reload ' + gen + '</button><button>Item A' + gen + '</button>'; } render();</script>`,
};

function server() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/search') {
        setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`Showing 1 - 50 of 83 for ${url.searchParams.get('q')}`); }, 600);
        return;
      }
      const page = PAGES[url.pathname];
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page ? `<!doctype html><html><body>${page()}</body></html>` : 'nope');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function run(electron) {
  const { app, BrowserWindow, WebContentsView } = electron;
  app.setPath('userData', path.join(os.tmpdir(), 'cxb-lock-check-ud'));
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
  };
  app.whenReady().then(async () => {
    const srv = await server();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const win = new BrowserWindow({ width: 900, height: 700, show: false });
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 40, width: 900, height: 660 });
    win.showInactive();
    const wc = view.webContents;
    let state = lock.reduce(lock.initial(), { type: 'open' });
    let lastInput = 0;
    driver.installFilters(wc, { driving: () => state.state === 'driving', onOperator: () => { lastInput = Date.now(); } });
    const drive = (what) => { state = lock.reduce(lock.reduce(state, { type: 'gate', seat: 'live-check', what }), { type: 'quiet' }); };
    const done = () => { state = lock.reduce(state, { type: 'done' }); };
    const js = (code) => wc.executeJavaScript(code);
    const iso = (code) => wc.executeJavaScriptInIsolatedWorld(scripts.ISOLATED_WORLD, [{ code }]);
    const load = async (p) => { await wc.loadURL(base + p); await driver.waitIdle(wc, { timeoutMs: 5000 }); await driver.emulateFocus(wc); };
    const numbers = async () => (await iso(scripts.READ_INTERACTIVE(false))).lines;
    const nOf = (lines, re) => Number(/^\[(\d+)\]/.exec(lines.find((l) => re.test(l)))[1]);
    const dbg = driver.attachCdp(wc);
    const cdpClick = async (x, y) => {
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };

    await load('/act');
    wc.setZoomFactor(1.25);
    await driver.sleep(300);
    let lines = await numbers();
    const btn = await iso(scripts.FIND(nOf(lines, /Press/)));
    const input = await iso(scripts.FIND(nOf(lines, /input:text/)));
    drive('click [b]');
    driver.click(wc, btn);
    driver.click(wc, input);
    await driver.typeText(wc, 'hi there');
    await driver.sleep(300);
    done();
    check('1. synthesised click and type land while driving (zoom 1.25)', await js('(window.clicks||0) === 1 && document.getElementById("a").value === "hi there"'),
      { clicks: await js('window.clicks||0'), value: await js('document.getElementById("a").value') });

    const bx = btn.x;
    const by = btn.y;
    drive('click [b]');
    await cdpClick(bx, by);
    await driver.sleep(300);
    const whileDriving = await js('window.clicks||0');
    done();
    lastInput = 0;
    await cdpClick(bx, by);
    await driver.sleep(300);
    const whileIdle = await js('window.clicks||0');
    check('2. CDP "operator" click dropped while driving, lands while idle', whileDriving === 1 && whileIdle === 2 && lastInput > 0,
      { whileDriving, whileIdle, operatorInputNoted: lastInput > 0 });

    const t0 = Date.now();
    state = lock.reduce(state, { type: 'gate', seat: 'live-check', what: 'click [b]' });
    const gate = await driver.quietGate({ lastInputAt: () => lastInput, quietMs: 3000, maxMs: 60000, shouldStop: () => state.state !== 'gating' });
    const waited = Date.now() - t0;
    state = lock.reduce(state, { type: 'busy' });
    lastInput = Date.now();
    const busy = await driver.quietGate({ lastInputAt: () => lastInput, quietMs: 3000, maxMs: 1000 });
    check('3. the quiet gate defers an act after a CDP click', gate === 'quiet' && waited >= 2500 && busy === 'busy', { gate, waitedMs: waited, shortGate: busy });
    wc.setZoomFactor(1);

    await load('/irs');
    lines = await numbers();
    const q = await iso(scripts.FIND(nOf(lines, /Find/)));
    drive('type [q]');
    const { idle } = await driver.act(wc, async () => {
      driver.click(wc, q);
      await driver.typeText(wc, 'Form 1040');
      driver.pressKey(wc, 'Enter');
    }, { timeoutMs: 15000 });
    done();
    const out = await js('document.getElementById("out").textContent');
    check('4. IRS-shaped type + Enter yields the AJAX result at idle', idle.ok && out === 'Showing 1 - 50 of 83 for Form 1040', { idle: idle.ok, ms: idle.ms, out });

    await load('/select');
    lines = await numbers();
    const picked = await iso(scripts.SELECT(nOf(lines, /^\[\d+\] select/), 'august 2026'));
    const ambiguous = await iso(scripts.SELECT(nOf(lines, /^\[\d+\] select/), 'august'));
    const fired = await js('window.onChangeFired');
    check('5. native select with a value-tracker shim fires onChange from the isolated world',
      fired === 1 && picked.value === '2026-08' && ambiguous.err === 'NO_OPTION' && ambiguous.ambiguous, { picked, fired, ambiguous });

    await load('/ajax');
    lines = await numbers();
    const oldItem = nOf(lines, /Item A1/);
    const reload = await iso(scripts.FIND(nOf(lines, /Reload 1/)));
    drive('click [reload]');
    await driver.act(wc, () => driver.click(wc, reload), { timeoutMs: 5000 });
    done();
    lines = await numbers();
    const newItem = nOf(lines, /Item A2/);
    const stale = await iso(scripts.FIND(oldItem));
    check('6. AJAX re-render: new nodes get new numbers; the old number resolves to nothing (NO_ELEMENT)',
      newItem > oldItem && stale === null, { oldItem, newItem, lines, oldResolves: stale });

    console.log('7. not run: needs a human at the keyboard');
    srv.close();
    const ok = results.every(Boolean);
    console.log(ok ? 'ALL PASS' : 'SOME FAILED');
    app.exit(ok ? 0 : 1);
  }).catch((e) => { console.error(e); app.exit(1); });
}

run(require('electron'));
