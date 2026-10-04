'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const { createPluginHostEngine } = require(path.join(ROOT, 'plugin-host-engine'));
const { HOST_API_VERSION } = require(path.join(ROOT, 'plugin-api'));
const { childSpawnSpec } = require(path.join(ROOT, 'electron-child'));
const { parseWithRegistry, pluginRowFor, unregisterSource } = require(path.join(ROOT, 'intent-registry'));
const portal = require(path.join(__dirname, 'fixtures', 'browser-pane-portal', 'server'));

const PLUGIN_DIR = path.join(ROOT, 'plugins', 'browser-pane');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const VERBOSE = !!process.env.CXB_VERBOSE;
const REPLY_MS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Expectation extends Error {}

function expect(cond, message) {
  if (!cond) throw new Expectation(message);
}

function boot(userData, seats) {
  unregisterSource('browser-pane');
  const sessions = new Map(seats.map((s) => [s.name, { ...s, workspaceId: 'w' }]));
  const queues = new Map(seats.map((s) => [s.name, { replies: [], waiters: [] }]));
  const notes = [];
  const logFile = path.join(userData, 'host.log');
  const engine = createPluginHostEngine({
    manager: {
      sessions,
      list: () => [...sessions.values()],
      listForWorkspace: () => [...sessions.values()],
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
      _injectText(s, text) {
        if (VERBOSE) process.stderr.write(`< ${s.name}: ${text}\n`);
        const q = queues.get(s.name);
        if (q.waiters.length) q.waiters.shift()(text);
        else q.replies.push(text);
      },
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    getNotifications: () => ({ add: (rec) => { notes.push(rec.body); return { id: notes.length }; } }),
    log: {
      info: (_s, m) => fs.appendFileSync(logFile, `[log] ${m}\n`),
      error: (_s, m) => fs.appendFileSync(logFile, `[err] ${m}\n`),
    },
    userDataPath: userData,
    fs, path,
    gitWorktree: {},
    electronChild: (script, extraArgs) => childSpawnSpec({
      execPath: ELECTRON, isPackaged: false, appPath: ROOT, script, extraArgs, env: process.env,
    }),
  });
  const host = engine.register('browser-pane', require(path.join(PLUGIN_DIR, 'engine')), { hostApi: HOST_API_VERSION }, { dir: PLUGIN_DIR });
  const next = (seat) => {
    const q = queues.get(seat);
    if (q.replies.length) return Promise.resolve(q.replies.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Expectation(`no reply to ${seat} within ${REPLY_MS / 1000}s`)), REPLY_MS);
      q.waiters.push((text) => { clearTimeout(t); resolve(text); });
    });
  };
  const send = (seat, line) => {
    if (VERBOSE) process.stderr.write(`> ${seat}: ${line}\n`);
    const intent = parseWithRegistry(line);
    expect(intent && intent.type === 'browser', `does not parse: ${line}`);
    try {
      pluginRowFor('browser').handler(host.sessions.get(seat), intent);
    } catch (e) {
      return Promise.resolve(`[agent:browser] error: ${e.message}`);
    }
    return next(seat);
  };
  const invoke = (method, ...args) => engine.dispatch('browser-pane', method, args, 'desktop');
  return { engine, host, send, invoke, notes, dataDir: host.paths.dataDir };
}

function fileOf(reply) {
  const m = / → @(\S+) $/.exec(reply);
  expect(m, `no read file in: ${reply}`);
  return fs.readFileSync(m[1], 'utf8');
}

function elementLine(content, re) {
  return content.split('\n').find((l) => /^\[\d+\] /.test(l) && re.test(l)) || null;
}

function numberOf(line) {
  return Number(/^\[(\d+)\]/.exec(line)[1]);
}

function landedFile(reply) {
  const m = / → "?(\/[^"]+?)"? · /.exec(reply);
  expect(m, `no file in: ${reply}`);
  return m[1];
}

function childPids(dataDir) {
  try {
    return execSync(`pgrep -f -- ${JSON.stringify('--cxb-data=' + path.join(dataDir, 'chromium'))}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean);
  } catch { return []; }
}

async function main() {
  const srv = await portal.start();
  const base = srv.base;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-e2e-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-e2e-tmp-'));
  const alphaCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-e2e-alpha-')));
  const betaCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-e2e-beta-')));
  process.env.TMPDIR = tmp;
  const seats = [
    { name: 'alpha', type: 'claude', cwd: alphaCwd },
    { name: 'beta', type: 'codex', cwd: betaCwd },
  ];
  let b = boot(userData, seats);
  const ctx = {};
  let failed = false;
  let n = 0;

  const step = async (title, fn) => {
    n += 1;
    try {
      const detail = await fn();
      console.log(`ok   ${String(n).padStart(2)} ${title}${detail ? ` — ${detail}` : ''}`);
    } catch (e) {
      failed = true;
      console.log(`FAIL ${String(n).padStart(2)} ${title} — ${e instanceof Expectation ? e.message : (e && e.stack) || e}`);
      throw e;
    }
  };

  const SIGNIN = `[agent:browser] sign-in needed on portal (password field at ${base}/login). The operator has been notified and signs in themselves in the browser window. Do not ask anyone for a password or code and do not type one. Emit [agent:browser wait portal] and end your turn; the reply comes when the operator hands the window back.`;
  const NOTICE_TITLE = 'Browser: sign in to portal';
  const posts = (p) => srv.log.filter((e) => e.method === 'POST' && e.path === p).length;
  const storedLogin = () => ((b.host.storage.get().services || {}).portal || {}).login || {};
  const stateOf = async () => {
    const st = await b.invoke('status', 'w');
    const s = ((st && st.services) || []).find((x) => x.name === 'portal');
    return s ? s.state : 'none';
  };

  try {
    await step('alpha: services → no services yet', async () => {
      const r = await b.send('alpha', '[agent:browser services]');
      expect(r === '[agent:browser] no services yet — [agent:browser open <service>] <url>', `got: ${r}`);
    });

    await step('alpha: open portal /bills → lands on /login, sign-in text, one notification', async () => {
      const r = await b.send('alpha', `[agent:browser open portal] ${base}/bills`);
      expect(r === SIGNIN, `got: ${r}`);
      expect(srv.log.some((e) => e.path === '/bills' && e.status === 302) && srv.log.some((e) => e.path === '/login' && e.method === 'GET'),
        'the server did not see /bills → 302 → GET /login');
      expect(b.notes.length === 1, `notify.user called ${b.notes.length} times`);
      expect(b.notes[0].startsWith(`${NOTICE_TITLE}\n\n`), `notification: ${b.notes[0]}`);
      return `notified "${NOTICE_TITLE}"`;
    });

    await step('alpha: read → refused HELD', async () => {
      const r = await b.send('alpha', '[agent:browser read portal]');
      expect(r === '[agent:browser] error: the operator has control of portal (sign-in). Emit [agent:browser wait portal] and end your turn.', `got: ${r}`);
    });

    await step('operator hands back without signing in → login stays login-page', async () => {
      await b.invoke('handback', 'portal');
      await sleep(300);
      expect(storedLogin().state === 'login-page', `stored login: ${JSON.stringify(storedLogin())}`);
      expect(await stateOf() !== 'held', 'still held after handback');
      return 'login: login-page';
    });

    await step('alpha: read → no re-hold; the file lists the password field (operator only)', async () => {
      const r = await b.send('alpha', '[agent:browser read portal]');
      expect(/^\[agent:browser\] read portal · page 1\/1 · \d+ elements · ≈[\d.,k]+ tok → @\S+ $/.test(r), `got: ${r}`);
      const pw = elementLine(fileOf(r), /^\[\d+\] input:password .*\(operator only\)$/);
      expect(pw, 'no input:password … (operator only) line');
      expect(await stateOf() !== 'held', 're-held on read');
      ctx.pw = numberOf(pw);
      return pw;
    });

    await step('alpha: type into the password field → PASSWORD_FIELD, held again, second notification, no POST /login', async () => {
      const r = await b.send('alpha', `[agent:browser type portal ${ctx.pw}] hunter2`);
      expect(r === `[agent:browser] error: [${ctx.pw}] is a password field — credentials never pass through agents. The operator has been asked to sign in; emit [agent:browser wait portal] and end your turn. Do not ask anyone for the password.`, `got: ${r}`);
      await sleep(300);
      expect(await stateOf() === 'held', `state: ${await stateOf()}`);
      expect(b.notes.length === 2 && b.notes[1].startsWith(`${NOTICE_TITLE}\n\n`), `notify.user called ${b.notes.length} times`);
      expect(posts('/login') === 0, `server saw ${posts('/login')} POST /login`);
    });

    await step('alpha: wait portal; operator signs in and hands back → wait resolves', async () => {
      const waiting = b.send('alpha', '[agent:browser wait portal]');
      await sleep(500);
      const res = await fetch(`${base}/__operator-login`, { method: 'POST' });
      expect(res.status === 204, `operator login: ${res.status}`);
      await b.invoke('handback', 'portal');
      const r = await waiting;
      expect(r.startsWith('[agent:browser] the operator handed portal back · now '), `got: ${r}`);
      expect(posts('/login') === 0, `server saw ${posts('/login')} POST /login`);
    });

    await step('alpha: open /bills → login: none; read --links has the 30-month select and View', async () => {
      const r = await b.send('alpha', `[agent:browser open portal] ${base}/bills`);
      const re = new RegExp(`^\\[agent:browser\\] opened portal · 200 · "My Bills — Example Portal" · ${base.replace(/\./g, '\\.')}/bills · login: none · idle \\d+\\.\\ds · next: read$`);
      expect(re.test(r), `got: ${r}`);
      const file = fileOf(await b.send('alpha', '[agent:browser read portal --links]'));
      const sel = elementLine(file, /^\[\d+\] select /);
      expect(sel, 'no select line');
      const opts = /\{(.*)\}$/.exec(sel);
      expect(opts && opts[1].split('|').length === 30 && !opts[1].includes('…'), `select options: ${sel}`);
      const view = elementLine(file, /^\[\d+\] button View$/);
      expect(view, 'no button View line');
      ctx.sel = numberOf(sel);
      ctx.view = numberOf(view);
      return `[${ctx.sel}] select (30 options), [${ctx.view}] button View`;
    });

    const pick = async (month, value) => {
      const s = await b.send('alpha', `[agent:browser select portal ${ctx.sel}] ${month}`);
      expect(new RegExp(`^\\[agent:browser\\] selected portal \\[${ctx.sel}\\] = "${month}" · same page · idle \\d+\\.\\ds$`).test(s), `select: ${s}`);
      const c = await b.send('alpha', `[agent:browser click portal ${ctx.view}]`);
      expect(new RegExp(`^\\[agent:browser\\] clicked portal \\[${ctx.view}\\] button "View" · same page · idle \\d+\\.\\ds$`).test(c), `click: ${c}`);
      const file = fileOf(await b.send('alpha', '[agent:browser read portal --links --filter=pdf]'));
      const link = elementLine(file, new RegExp(`Download PDF → /bills/${value}\\.pdf`));
      expect(link, `no Download PDF → /bills/${value}.pdf line`);
      return numberOf(link);
    };

    await step('alpha: select August 2026, click View, read --filter=pdf → Download PDF link', async () => {
      ctx.aug = await pick('August 2026', '2026-08');
      return `[${ctx.aug}] Download PDF → /bills/2026-08.pdf`;
    });

    const checkPdf = (file) => {
      expect(fs.existsSync(file), `missing ${file}`);
      const bytes = fs.readFileSync(file);
      expect(bytes.length === srv.pdf.length, `size ${bytes.length} ≠ ${srv.pdf.length}`);
      expect(bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'does not start with %PDF-');
      return `${bytes.length} B, %PDF-`;
    };

    await step('alpha: download August (attachment) --as=2026-08.pdf → <dataDir>/downloads/portal/', async () => {
      const r = await b.send('alpha', `[agent:browser download portal ${ctx.aug} --as=2026-08.pdf]`);
      const want = path.join(b.dataDir, 'downloads', 'portal', '2026-08.pdf');
      expect(landedFile(r) === want, `got: ${r}`);
      expect(/ · application\/pdf · %PDF ok · \d+\.\ds$/.test(r), `got: ${r}`);
      const gate = await fetch(`${base}/bills/2026-08.pdf`);
      expect(gate.status === 403, `PDF without the session: ${gate.status}`);
      return `${want} · ${checkPdf(want)}`;
    });

    await step('alpha: download September (inline) --to=bills → <cwd>/bills/', async () => {
      const sep = await pick('September 2026', '2026-09');
      const r = await b.send('alpha', `[agent:browser download portal ${sep} --to=bills --as=2026-09.pdf]`);
      const want = path.join(alphaCwd, 'bills', '2026-09.pdf');
      expect(landedFile(r) === want, `got: ${r}`);
      return `${want} · ${checkPdf(want)}`;
    });

    await step('beta: read portal → lease refusal naming alpha', async () => {
      const r = await b.send('beta', '[agent:browser read portal]');
      expect(/^\[agent:browser\] error: portal is in use by alpha \(last command .+ ago\)\. It frees after 5 min without commands, when they emit \[agent:browser release portal\], or when their session ends\.$/.test(r), `got: ${r}`);
    });

    await step('child shut down, engine re-activated → open /bills lands with login: none, no 302', async () => {
      const dataDir = b.dataDir;
      expect(childPids(dataDir).length > 0, 'no child process before shutdown');
      b.engine.deactivate('browser-pane');
      for (let i = 0; i < 60 && childPids(dataDir).length; i++) await sleep(250);
      expect(childPids(dataDir).length === 0, 'the child did not exit');
      b = boot(userData, seats);
      const mark = srv.log.length;
      const r = await b.send('alpha', `[agent:browser open portal] ${base}/bills`);
      const re = new RegExp(`^\\[agent:browser\\] opened portal · 200 · "My Bills — Example Portal" · ${base.replace(/\./g, '\\.')}/bills · login: none · `);
      expect(re.test(r), `got: ${r}`);
      const since = srv.log.slice(mark);
      expect(!since.some((e) => e.status === 302), `302 after restart: ${JSON.stringify(since)}`);
      const bills = since.find((e) => e.path === '/bills');
      expect(bills && bills.sid && !bills.setSid, `GET /bills after restart: ${JSON.stringify(bills)}`);
      return 'sid cookie survived the restart';
    });
  } catch {
    failed = true;
  }

  try { b.engine.deactivate('browser-pane'); } catch {}
  for (let i = 0; i < 40 && childPids(b.dataDir).length; i++) await sleep(250);
  await srv.close();
  if (failed) console.log(`FAILED at step ${n} — host log and files kept under ${userData}, ${tmp}`);
  else {
    for (const d of [userData, tmp, alphaCwd, betaCwd]) fs.rmSync(d, { recursive: true, force: true });
    console.log(`all ${n} steps ok`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL setup — ${(e && e.stack) || e}`); process.exit(1); });
