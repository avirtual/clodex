'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createScheduler } = require('../plugins/browser-pane/scheduler');
const { parseLine, toCommand } = require('../plugins/browser-pane/grammar');

process.env.TMPDIR = mkTmpRoot('clodex-bp-sched-');

const PAGE = { url: 'https://portal.example.com/bills', title: 'My Bills', doc: 1 };

const DEFAULTS = {
  open: (a) => ({ status: 200, url: a.url, title: 'Bills', doc: 1, idle: { ok: true, ms: 1000 }, login: {} }),
  read: () => ({ ...PAGE, contentType: 'text/html', text: 'My Bills', elements: ['[1] button View'], truncated: false, frames: [], login: {} }),
  click: () => ({ kind: 'button', label: 'View', navigated: false, idle: { ok: true, ms: 1200 }, ...PAGE }),
  type: () => ({ kind: 'input:text', label: 'Find', navigated: false, idle: { ok: true, ms: 900 }, ...PAGE }),
  select: () => ({ value: '2026-08', text: 'August 2026', navigated: false, idle: { ok: true, ms: 1000 }, ...PAGE }),
  key: () => ({ navigated: false, idle: { ok: true, ms: 400 }, ...PAGE }),
  idle: () => ({ ok: true, ms: 2300, inflight: [] }),
};

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function harness(script = {}, extra = {}) {
  let t = 1000000;
  let seq = 0;
  const pending = [];
  const timers = {
    setTimeout(fn, ms) { const h = { at: t + ms, fn, id: seq++ }; pending.push(h); return h; },
    clearTimeout(h) { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
  };
  const calls = [];
  const client = {
    request(op, args, meta) {
      calls.push([meta.seat, op, args]);
      const fn = script[op] || DEFAULTS[op];
      return Promise.resolve().then(() => fn(args, meta));
    },
  };
  let stored = null;
  const storage = { get: () => stored, set: (v) => { stored = JSON.parse(JSON.stringify(v)); } };
  const sched = createScheduler({ client, storage, mirror: new Map(), now: () => t, timers, ...extra });
  const out = [];
  const handles = new Map();
  const seat = (name) => {
    if (!handles.has(name)) handles.set(name, { name, type: 'claude', inject: (text) => out.push([name, text.replace(/ → @\S+ $/, ' → @FILE')]) });
    return handles.get(name);
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  const run = async (rows) => {
    for (const [who, line] of rows) {
      try { sched.submit(seat(who), toCommand(parseLine(line))); } catch (e) { out.push([who, `THROW ${e.message}`]); }
    }
    await settle();
    return out.splice(0);
  };
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      pending.sort((a, b) => (a.at - b.at) || (a.id - b.id));
      const h = pending[0];
      if (!h || h.at > end) break;
      pending.shift();
      t = h.at;
      h.fn();
    }
    t = end;
  };
  return { sched, run, advance, calls, out, seat, settle, storage };
}

const OPENED = '[agent:browser] opened utility · 200 · "Bills" · https://portal.example.com/bills · login: none · idle 1.0s · next: read';
const READ_REPLY = '[agent:browser] read utility · page 1/1 · 1 elements · ≈87 tok → @FILE';
const LEASE_40 = '[agent:browser] error: utility is in use by hand-a (last command 40s ago). It frees after 5 min without commands, when they emit [agent:browser release utility], or when their session ends.';
const HELD = '[agent:browser] error: the operator has control of utility (sign-in). Emit [agent:browser wait utility] and end your turn.';
const HELD_STATE = { event: 'state', service: 'utility', state: 'held', reason: 'login', seat: 'hand-a', login: { password: true } };

test('scheduler lease: acquire, then a second seat is refused with the holder named', async () => {
  const h = harness();
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]), [['hand-a', OPENED]]);
  h.advance(40000);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', LEASE_40]]);
  assert.deepStrictEqual(h.calls.map((c) => [c[0], c[1]]), [['hand-a', 'open']]);
});

test('scheduler lease: expires at 5 min without commands, not before', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.advance(5 * 60 * 1000 - 1);
  assert.match((await h.run([['hand-b', '[agent:browser read utility]']]))[0][1], /in use by hand-a \(last command 5m ago\)/);
  h.advance(1);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', READ_REPLY]]);
  h.advance(1000);
  assert.match((await h.run([['hand-a', '[agent:browser read utility]']]))[0][1], /^\[agent:browser\] error: utility is in use by hand-b \(last command 1s ago\)/);
});

test('scheduler lease: paused while held and while the holder has a held-wait pending', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.sched.onState(HELD_STATE);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser wait utility --ms=1800000]']]), []);
  h.advance(10 * 60 * 1000);
  assert.match((await h.run([['hand-b', '[agent:browser read utility]']]))[0][1], /in use by hand-a \(last command 10m ago\)/);
  h.sched.onState({ event: 'state', service: 'utility', state: 'idle', handback: true, url: 'https://portal.example.com/account', title: 'Account', login: {} });
  await h.settle();
  assert.deepStrictEqual(h.out.splice(0), [['hand-a',
    '[agent:browser] the operator handed utility back · now https://portal.example.com/account ("Account") · signed in · read to continue']]);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', READ_REPLY]]);
});

test('scheduler lease: release frees it, and session exit frees it', async () => {
  const h = harness();
  assert.deepStrictEqual(await h.run([
    ['hand-a', '[agent:browser open utility] https://portal.example.com/bills'],
    ['hand-a', '[agent:browser release utility]'],
    ['hand-b', '[agent:browser read utility]'],
  ]), [['hand-a', '[agent:browser] released utility'], ['hand-a', OPENED], ['hand-b', READ_REPLY]]);
  h.sched.onSessionExit({ name: 'hand-b' });
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser read utility]']]), [['hand-a', READ_REPLY]]);
});

test('scheduler: commands from the holder run one at a time in arrival order', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([
    ['hand-a', '[agent:browser click 1]'],
    ['hand-a', '[agent:browser type 2 --enter] 1040'],
    ['hand-a', '[agent:browser select 3] August 2026'],
    ['hand-a', '[agent:browser key] Tab'],
  ]), [
    ['hand-a', '[agent:browser] clicked utility [1] button "View" · same page · idle 1.2s'],
    ['hand-a', '[agent:browser] typed utility [2] (4 chars) + Enter · same page · idle 0.9s'],
    ['hand-a', '[agent:browser] selected utility [3] = "August 2026" · same page · idle 1.0s'],
    ['hand-a', '[agent:browser] pressed Tab on utility · same page · idle 0.4s'],
  ]);
  assert.deepStrictEqual(h.calls, [
    ['hand-a', 'click', { expectDoc: 1, n: 1 }],
    ['hand-a', 'type', { expectDoc: 1, n: 2, text: '1040', enter: true }],
    ['hand-a', 'select', { expectDoc: 1, n: 3, option: 'August 2026' }],
    ['hand-a', 'key', { key: 'Tab' }],
  ]);
});

test('scheduler: a failure drops the same seat\'s queued commands and names them', async () => {
  const h = harness({ select: () => { throw coded('NO_OPTION', 'no option "Sep" in [3] — options: "August 2026"'); } });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([
    ['hand-a', '[agent:browser select 3] Sep'],
    ['hand-a', '[agent:browser click 4]'],
    ['hand-a', '[agent:browser key] Enter'],
  ]), [['hand-a',
    '[agent:browser] error: no option "Sep" in [3] — options: "August 2026" — dropped 2 queued commands after it: click 4, key Enter']]);
  assert.deepStrictEqual(h.calls.map((c) => c[1]), ['select']);
});

test('scheduler: STALE_DOC from the child drops one queued command, singular', async () => {
  const msg = 'utility navigated since your last read (now https://portal.example.com/x) — numbers from that read are void; read again.';
  const h = harness({ click: () => { throw coded('STALE_DOC', msg); } });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click 4]'], ['hand-a', '[agent:browser click 5]']]),
    [['hand-a', `[agent:browser] error: ${msg} — dropped 1 queued command after it: click 5`]]);
});

test('scheduler: an act before any read is refused with read first', async () => {
  const h = harness();
  assert.deepStrictEqual(await h.run([
    ['hand-a', '[agent:browser open utility] https://portal.example.com/bills'],
    ['hand-a', '[agent:browser click utility 4]'],
    ['hand-a', '[agent:browser type 2] x'],
    ['hand-a', '[agent:browser select 3] x'],
  ]), [
    ['hand-a', '[agent:browser] error: read utility first — numbers come from your read'],
    ['hand-a', '[agent:browser] error: read utility first — numbers come from your read'],
    ['hand-a', '[agent:browser] error: read utility first — numbers come from your read'],
    ['hand-a', OPENED],
  ]);
});

test('scheduler: a held service refuses everything but wait, services and release', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.sched.onState(HELD_STATE);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([
    ['hand-a', '[agent:browser read utility]'],
    ['hand-a', '[agent:browser click 3]'],
    ['hand-a', '[agent:browser open utility] https://portal.example.com/x'],
    ['hand-a', '[agent:browser wait]'],
    ['hand-a', '[agent:browser services]'],
  ]), [
    ['hand-a', HELD], ['hand-a', HELD], ['hand-a', HELD],
    ['hand-a', '[agent:browser] services: utility — sign-in page · window open · held'],
  ]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser release utility]']]), [['hand-a', '[agent:browser] released utility']]);
  assert.deepStrictEqual(h.calls, []);
});

test('scheduler: a held wait times out at --ms, and a closed window answers the rest', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.sched.onState(HELD_STATE);
  await h.run([['hand-a', '[agent:browser wait utility --ms=60000]']]);
  h.advance(59999);
  assert.deepStrictEqual(h.out.splice(0), []);
  h.advance(1);
  assert.deepStrictEqual(h.out.splice(0), [['hand-a',
    '[agent:browser] the operator still has control of utility after 1m — emit [agent:browser wait utility] again, or end your turn']]);
  await h.run([['hand-a', '[agent:browser wait utility]']]);
  h.sched.onClosed('utility');
  assert.deepStrictEqual(h.out.splice(0), [['hand-a', '[agent:browser] error: the utility window was closed — open it again']]);
});

test('scheduler: a non-held wait asks the child for idle, clamped to 120 s', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser wait --ms=999999]']]), [['hand-a', '[agent:browser] utility idle after 2.3s']]);
  assert.deepStrictEqual(h.calls, [['hand-a', 'idle', { ms: 120000, forText: null }]]);
});

test('scheduler: a sign-in result replies with the handoff text and drops what was queued', async () => {
  const h = harness({
    click: () => ({ ...PAGE, held: { reason: 'login', login: { password: true }, url: 'https://portal.example.com/login' } }),
  });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click 2]'], ['hand-a', '[agent:browser click 3]']]), [['hand-a',
    '[agent:browser] sign-in needed on utility (password field at https://portal.example.com/login). The operator has been notified and signs in themselves in the browser window. Do not ask anyone for a password or code and do not type one. Emit [agent:browser wait utility] and end your turn; the reply comes when the operator hands the window back. — dropped 1 queued command after it: click 3']]);
});

test('scheduler: a takeover during the command adds the suffix', async () => {
  const h = harness({ click: () => ({ kind: 'button', label: 'View', navigated: false, idle: { ok: true, ms: 300 }, takeover: true, held: { reason: 'takeover' } }) });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click 1]']]), [['hand-a',
    '[agent:browser] clicked utility [1] button "View" · same page · idle 0.3s · the operator took over during this command']]);
});

test('scheduler: a wait queued behind a command becomes a held waiter when the service is held meanwhile', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  const read = h.run([['hand-a', '[agent:browser read utility]'], ['hand-a', '[agent:browser wait utility]']]);
  h.sched.onState({ ...HELD_STATE, reason: 'takeover' });
  assert.deepStrictEqual(await read, [['hand-a', READ_REPLY]]);
  h.sched.onState({ event: 'state', service: 'utility', state: 'idle', handback: true, url: 'u', title: 't', login: {} });
  assert.deepStrictEqual(h.out.splice(0), [['hand-a', '[agent:browser] the operator handed utility back · now u ("t") · signed in · read to continue']]);
});

test('scheduler: a sign-in failure keeps the seat\'s queued wait and drops the rest', async () => {
  const h = harness({ read: () => ({ ...PAGE, held: { reason: 'login', login: { password: true }, url: 'https://portal.example.com/login' } }) });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  const replies = h.run([['hand-a', '[agent:browser read utility]'], ['hand-a', '[agent:browser key] Tab'], ['hand-a', '[agent:browser wait utility]']]);
  h.sched.onState(HELD_STATE);
  const got = await replies;
  assert.strictEqual(got.length, 1);
  assert.match(got[0][1], /^\[agent:browser\] sign-in needed on utility .* — dropped 1 queued command after it: key Tab$/);
  h.sched.onState({ event: 'state', service: 'utility', state: 'idle', handback: true, url: 'u', title: 't', login: {} });
  assert.deepStrictEqual(h.out.splice(0), [['hand-a', '[agent:browser] the operator handed utility back · now u ("t") · signed in · read to continue']]);
});

test('scheduler: a closed window forgets the seats\' numbers for it', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  h.sched.onClosed('utility');
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click 1]']]),
    [['hand-a', '[agent:browser] error: read utility first — numbers come from your read']]);
});

test('scheduler: a takeover during open adds the suffix', async () => {
  const h = harness({ open: (a) => ({ status: 200, url: a.url, title: 'Bills', doc: 1, idle: { ok: true, ms: 1000 }, login: {}, takeover: true, held: { reason: 'takeover' } }) });
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]),
    [['hand-a', `${OPENED} · the operator took over during this command`]]);
});

test('scheduler: handback records the login as logged-in via handback', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.sched.onState(HELD_STATE);
  assert.strictEqual(h.storage.get().services.utility.login.state, 'login-page');
  h.sched.onState({ event: 'state', service: 'utility', state: 'idle', handback: true, url: 'u', title: 't', login: {} });
  const { state, via } = h.storage.get().services.utility.login;
  assert.deepStrictEqual({ state, via }, { state: 'logged-in', via: 'handback' });
});

test('scheduler: click --text needs a read like a numbered click, passes the text and no doc for the stale-doc check', async () => {
  const h = harness({ click: () => ({ n: 31, kind: 'clickable', label: 'Lista de plată', navigated: false, idle: { ok: true, ms: 500 }, ...PAGE }) });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click --text="Lista de plată"]']]),
    [['hand-a', '[agent:browser] error: read utility first — numbers come from your read']]);
  await h.run([['hand-a', '[agent:browser read]']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click --text="Lista de plată"]'], ['hand-a', '[agent:browser click --text=Lista]']]), [
    ['hand-a', '[agent:browser] clicked utility [31] clickable "Lista de plată" · same page · idle 0.5s'],
    ['hand-a', '[agent:browser] clicked utility [31] clickable "Lista de plată" · same page · idle 0.5s'],
  ]);
  assert.deepStrictEqual(h.calls.filter((c) => c[1] === 'click'), [
    ['hand-a', 'click', { byText: 'Lista de plată' }],
    ['hand-a', 'click', { byText: 'Lista' }],
  ]);
});

test('scheduler click --to: resolves inside the seat cwd, passes dir to the child, and names the landed file', async () => {
  const cwd = fs.realpathSync(mkTmpRoot('clodex-bp-sched-'));
  const file = path.join(cwd, 'bills', 'lista.pdf');
  const h = harness({
    click: (a) => {
      fs.writeFileSync(path.join(a.dir, 'lista.pdf'), '%PDF-1.4');
      return { ...DEFAULTS.click(), download: { file: path.join(a.dir, 'lista.pdf'), bytes: 8, mime: 'application/pdf', url: 'https://x/l.pdf' } };
    },
  }, { fsScope: () => ({ cwd }) });
  await h.run([['hand-a', '[agent:browser read utility]']]);
  const out = await h.run([['hand-a', '[agent:browser click utility 1 --to=bills]']]);
  assert.strictEqual(h.calls[1][2].dir, path.join(cwd, 'bills'));
  assert.deepStrictEqual(out, [['hand-a',
    `[agent:browser] clicked utility [1] button "View" · same page · idle 1.2s · → download ${file} · 8 B · application/pdf · from https://x/l.pdf`]]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click utility 1 --to=../escape]']]),
    [['hand-a', `[agent:browser] error: --to must name a folder inside your working directory (${cwd})`]]);
  assert.strictEqual(h.calls.length, 2);
});

test('scheduler click --to: a download that lands outside the cwd is deleted and refused', async () => {
  const cwd = fs.realpathSync(mkTmpRoot('clodex-bp-sched-'));
  const away = path.join(fs.realpathSync(mkTmpRoot('clodex-bp-sched-')), 'x.pdf');
  fs.writeFileSync(away, '%PDF');
  const h = harness({ click: () => ({ ...DEFAULTS.click(), download: { file: away, bytes: 4, mime: 'application/pdf' } }) }, { fsScope: () => ({ cwd }) });
  await h.run([['hand-a', '[agent:browser read utility]']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click utility 1 --to=bills]']]),
    [['hand-a', `[agent:browser] error: the download left your working directory (${cwd}) and was deleted — download it again`]]);
  assert.strictEqual(fs.existsSync(away), false);
});

test('scheduler inspect: needs a read first, then asks the child by text without the read doc and replies in six lines', async () => {
  const h = harness({
    inspect: () => ({
      n: 4, tag: 'div', id: 'go', classes: ['btn'], kind: 'clickable', label: 'Go', attrs: [], listeners: null,
      cursor: 'pointer', rect: { x: 1, y: 2, w: 30, h: 10 }, visible: true, ancestors: ['body'], html: '<div id="go">Go</div>',
    }),
  });
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser inspect utility 4]']]),
    [['hand-a', '[agent:browser] error: read utility first — numbers come from your read']]);
  await h.run([['hand-a', '[agent:browser read utility]']]);
  const out = await h.run([['hand-a', '[agent:browser inspect utility --text=Go]']]);
  assert.deepStrictEqual(h.calls[1], ['hand-a', 'inspect', { byText: 'Go' }]);
  assert.strictEqual(out[0][1].split('\n').length, 6);
});

test('scheduler: a second read of the same site drops the repeated chrome; --all and another origin keep it', async () => {
  const chrome = (mid, title = 'Avizier') => [title, '', 'Acasa', 'Avizier', 'Plati', ...mid, 'Termeni', 'Ajutor', 'v1.2'].join('\n');
  let cur = { url: 'https://portal.example.com/a', title: 'Aprilie', text: chrome(['Factura aprilie'], 'Aprilie') };
  const h = harness({ read: () => ({ ...DEFAULTS.read(), url: cur.url, title: cur.title, text: cur.text }) });
  const hd = h.seat('hand-a');
  const files = [];
  const inject = hd.inject;
  hd.inject = (text) => { const m = / → @(\S+) $/.exec(text); if (m) files.push(fs.readFileSync(m[1], 'utf8')); inject(text); };
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a'], ['hand-a', '[agent:browser read]']]);
  assert.ok(!files[0].includes('stripped:'));
  cur = { url: 'https://portal.example.com/b', title: 'Mai', text: chrome(['Factura mai', '120 lei'], 'Mai') };
  const [[, second]] = await h.run([['hand-a', '[agent:browser read]']]);
  assert.match(second, / · chrome stripped → @FILE$/);
  assert.ok(files[1].includes('\nstripped: 3 lines at top, 3 at bottom (same as your last read of utility)\n'));
  assert.ok(files[1].includes('\n== text ==\nMai\n\nFactura mai\n120 lei\n== elements =='));
  assert.ok(!/Acasa|Termeni/.test(files[1]));
  const [[, again]] = await h.run([['hand-a', '[agent:browser read --page=1]']]);
  assert.match(again, / · chrome stripped /);
  assert.ok(files[2].includes('\n== text ==\nMai\n\nFactura mai\n120 lei\n'));
  const [[, all]] = await h.run([['hand-a', '[agent:browser read --all]']]);
  assert.ok(!all.includes('chrome stripped'));
  assert.ok(!files[3].includes('stripped:'));
  assert.ok(files[3].includes('Acasa') && files[3].includes('Termeni'));
  cur = { url: 'https://other.example.com/c', title: 'Mai', text: chrome(['Altceva'], 'Mai') };
  await h.run([['hand-a', '[agent:browser read]']]);
  assert.ok(!files[4].includes('stripped:'));
  assert.ok(files[4].includes('Acasa'));
});

test('scheduler: after a navigation --text targets go through without a doc; a numbered click is still refused as stale', async () => {
  let doc = 1;
  const stale = (a) => { if (a.expectDoc != null && a.expectDoc !== doc) throw coded('STALE_DOC', 'utility navigated since your last read — read again.'); };
  const h = harness({
    click: (a) => { stale(a); return { n: 7, kind: 'link', label: 'Avizier', navigated: false, idle: { ok: true, ms: 500 }, ...PAGE, doc }; },
    inspect: (a) => {
      stale(a);
      return { n: 7, tag: 'a', id: '', classes: [], kind: 'link', label: 'Avizier', attrs: [], listeners: null,
        cursor: 'pointer', rect: { x: 1, y: 2, w: 30, h: 10 }, visible: true, ancestors: ['body'], html: '<a>Avizier</a>' };
    },
  });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  doc = 2;
  h.calls.length = 0;
  const out = await h.run([['hand-a', '[agent:browser click --text=Avizier]'], ['hand-a', '[agent:browser inspect --text=Avizier]'], ['hand-a', '[agent:browser click 7]']]);
  assert.deepStrictEqual(h.calls.map((c) => c[2]), [{ byText: 'Avizier' }, { byText: 'Avizier' }, { expectDoc: 1, n: 7 }]);
  assert.match(out[0][1], /^\[agent:browser\] clicked utility \[7\] link "Avizier"/);
  assert.match(out[1][1], /^\[agent:browser\] inspect utility \[7\]/);
  assert.deepStrictEqual(out[2], ['hand-a', '[agent:browser] error: utility navigated since your last read — read again.']);
});

function siteHarness() {
  let cur = null;
  const h = harness({ read: () => ({ ...DEFAULTS.read(), ...cur }) });
  const files = [];
  const hd = h.seat('hand-a');
  const inject = hd.inject;
  hd.inject = (text) => { const m = / → @(\S+) $/.exec(text); if (m) files.push(fs.readFileSync(m[1], 'utf8')); inject(text); };
  const read = async (page, line = '[agent:browser read]') => {
    if (page) cur = page;
    const [[, reply]] = await h.run([['hand-a', line]]);
    return { reply, file: files[files.length - 1] };
  };
  return { h, read };
}

const NAV = ['[1] link Acasa → /', '[2] link Avizier → /avizier?t=1700000001', '[3] link Plati → /plati', '[4] link Termeni → /termeni'];

test('scheduler: elements repeated from the previous read of the site are hidden with their numbers; form controls stay', async () => {
  const { h, read } = siteHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  const first = await read({ url: 'https://portal.example.com/a', text: 'A\nFactura aprilie', elements: [...NAV, '[5] input:text Cauta', '[6] link Factura aprilie → /f/4'] });
  assert.ok(!/elements hidden/.test(first.reply));
  const navB = NAV.map((l) => l.replace('t=1700000001', 't=1700000999'));
  const second = await read({ url: 'https://portal.example.com/b', text: 'B\nFactura mai', elements: [...navB, '[5] input:text Cauta', '[6] link Factura mai → /f/5', '[7] link Plati → /plati'] });
  assert.match(second.reply, / · 4 elements hidden → @FILE$/);
  assert.match(second.file, /\ndoc: 1 · elements: 7 \(4 repeated, hidden — still clickable by number; read --all lists them; this page: \[5\]–\[7\]; numbers can skip\)/);
  assert.ok(second.file.includes('\n== elements ==\n[5] input:text Cauta\n[6] link Factura mai → /f/5\n[7] link Plati → /plati\n'));
  const again = await read(null);
  assert.ok(!/elements hidden/.test(again.reply));
  assert.ok(again.file.includes('[1] link Acasa → /\n'));
  const all = await read({ url: 'https://portal.example.com/c', text: 'C', elements: [...NAV, '[9] link Altceva → /x'] }, '[agent:browser read --all]');
  assert.ok(!/elements hidden/.test(all.reply) && all.file.includes('[1] link Acasa'));
  const links = await read({ url: 'https://portal.example.com/d', text: 'D', elements: [...NAV, '[9] link Altceva → /x'] }, '[agent:browser read --links]');
  assert.ok(!/elements hidden/.test(links.reply) && links.file.includes('[1] link Acasa'));
});

test('scheduler: page 2 of a read hides the same repeated elements as page 1', async () => {
  const { h, read } = siteHarness();
  const many = (from, n, tag) => Array.from({ length: n }, (_, i) => `[${from + i}] link ${tag} ${i} ${'x'.repeat(150)} → /${tag}/${i}`);
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  await read({ url: 'https://portal.example.com/a', text: 'A', elements: many(1, 30, 'nav') });
  const b = { url: 'https://portal.example.com/b', text: 'B', elements: [...many(1, 30, 'nav'), ...many(31, 40, 'body')] };
  const p1 = await read(b, '[agent:browser read --max=1000]');
  assert.match(p1.reply, /page 1\/2 · 70 elements · .* · 30 elements hidden/);
  const p2 = await read(b, '[agent:browser read --max=1000 --page=2]');
  assert.match(p2.reply, /page 2\/2 · 70 elements · .* · 30 elements hidden/);
  assert.ok(!p2.file.includes('link nav '));
});

test('scheduler: a one-line in-place change on the same path is not chrome-stripped; a --links read still updates the base', async () => {
  const chrome = (menu, mid) => ['T', '', ...menu, ...mid, 'Termeni', 'Ajutor', 'v1.2'].join('\n');
  const M1 = ['Acasa', 'Avizier', 'Plati'];
  const M2 = ['Index', 'Mesaje', 'Cont'];
  const { h, read } = siteHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  await read({ url: 'https://portal.example.com/a', title: 'T', text: chrome(M1, ['Factura aprilie']) });
  const b = await read({ url: 'https://portal.example.com/b', title: 'T', text: chrome(M1, ['Factura mai', 'Sold: 0 lei']) });
  assert.match(b.reply, /chrome stripped/);
  const inPlace = await read({ url: 'https://portal.example.com/b', title: 'T', text: chrome(M1, ['Factura mai', 'Sold: 120 lei']) });
  assert.ok(!/chrome stripped/.test(inPlace.reply));
  assert.ok(!inPlace.file.includes('stripped:') && inPlace.file.includes('Acasa'));
  await read({ url: 'https://portal.example.com/x', title: 'T', text: chrome(M2, ['Mesaje noi']) }, '[agent:browser read --links]');
  const y = await read({ url: 'https://portal.example.com/y', title: 'T', text: chrome(M2, ['Contul meu', 'Email']) });
  assert.match(y.file, /\nstripped: 3 lines at top, 3 at bottom/);
});
