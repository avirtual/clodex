'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createScheduler, storedLogin } = require('../plugins/browser-pane/scheduler');
const { parseLine, toCommand } = require('../plugins/browser-pane/grammar');
const R = require('../plugins/browser-pane/replies');

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
const READ_REPLY = '[agent:browser] read utility · page 1/1 · 1 elements · ≈92 tok → @FILE';
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

test('scheduler: open --show asks the child to show the window; a plain open does not', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility --show] https://portal.example.com/bills']]);
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  assert.deepStrictEqual(h.calls.map((c) => c[2]), [
    { url: 'https://portal.example.com/bills', show: true },
    { url: 'https://portal.example.com/bills' },
  ]);
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
    ['hand-a', 'click', { n: 1 }],
    ['hand-a', 'type', { n: 2, text: '1040', enter: true }],
    ['hand-a', 'select', { n: 3, option: 'August 2026' }],
    ['hand-a', 'key', { key: 'Tab' }],
  ]);
});

test('scheduler: scroll reaches the child as op scroll with dir and pages, without a prior read', async () => {
  const h = harness({ scroll: () => ({
    dir: 'down', pages: 2, before: { y: 0, height: 4000, items: 5 }, after: { y: 1656, height: 6000, items: 9 }, vh: 868, navigated: false, idle: { ok: true, ms: 400 }, changed: 'x',
  }) });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser scroll down --pages=2]']]), [
    ['hand-a', '[agent:browser] scrolled utility down ×2 · 1656–2524 of 6000 px (28–42%) · +4 items (5 → 9) · page grew 2000 px · idle 0.4s · changed: "x"'],
  ]);
  assert.deepStrictEqual(h.calls, [['hand-a', 'scroll', { dir: 'down', pages: 2 }]]);
});

test('scheduler: back and forward reach the child as op nav with dir, without a prior read', async () => {
  const h = harness({ nav: (args) => ({
    dir: args.dir, navigated: true, url: 'https://portal.example.com/bills', title: 'Bills', idle: { ok: true, ms: 400 }, canBack: args.dir === 'forward', canForward: args.dir === 'back',
  }) });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser back]'], ['hand-a', '[agent:browser forward utility]']]), [
    ['hand-a', '[agent:browser] went back on utility · navigated → ("Bills") https://portal.example.com/bills · numbers kept where the page repeats · idle 0.4s · history: back ✗ forward ✓'],
    ['hand-a', '[agent:browser] went forward on utility · navigated → ("Bills") https://portal.example.com/bills · numbers kept where the page repeats · idle 0.4s · history: back ✓ forward ✗'],
  ]);
  assert.deepStrictEqual(h.calls, [['hand-a', 'nav', { dir: 'back' }], ['hand-a', 'nav', { dir: 'forward' }]]);
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

test('scheduler: a number absent after navigation reads no element [n] on <svc> on this page and drops one queued command, singular', async () => {
  const msg = 'no element [4] on utility on this page (hidden or gone) — read again or use --text';
  const h = harness({ click: () => { throw coded('NO_ELEMENT', msg); } });
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
    ['hand-a', '[agent:browser] services: utility — portal.example.com · sign-in page · window open · held'],
  ]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser release utility]']]), [['hand-a', '[agent:browser] released utility — the operator still has control (sign-in); [agent:browser wait utility] resumes after the hand-back']]);
  assert.strictEqual(h.sched.leaseHolder('utility'), null);
  assert.deepStrictEqual(h.calls, []);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', HELD]], 'the hold outlives the release');
});

test('scheduler close: refused under a takeover hold, closes under a sign-in hold, then drops the seat\'s lease', async () => {
  let sched = null;
  const h = harness({ close: () => { sched.onClosed('utility'); return { closed: 'utility', windows: 2 }; } });
  sched = h.sched;
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.sched.onState({ ...HELD_STATE, reason: 'takeover' });
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser close utility]']]), [
    ['hand-a', '[agent:browser] error: the operator has control of utility (takeover). Emit [agent:browser wait utility] and end your turn.'],
  ]);
  assert.deepStrictEqual(h.calls, []);
  h.sched.onState({ event: 'state', service: 'utility', state: 'idle' });
  h.sched.onState(HELD_STATE);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser close utility]']]), [
    ['hand-a', '[agent:browser] closed utility · 2 windows open'],
  ]);
  assert.deepStrictEqual(h.calls, [['hand-a', 'close', {}]]);
  assert.strictEqual(h.sched.leaseHolder('utility'), null);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser services]']]), [
    ['hand-b', '[agent:browser] services: utility — portal.example.com · sign-in was pending · closed'],
  ]);
});

test('scheduler close: a signed-in service says the sign-in stays and how to resume it', async () => {
  const h = harness({
    open: (a) => ({ status: 200, url: a.url, title: 'Bills', doc: 1, idle: { ok: true, ms: 1000 }, login: { logoutLink: true } }),
    close: () => ({ closed: 'utility', windows: 0 }),
  });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser close]']]), [
    ['hand-a', '[agent:browser] closed utility · signed in stays (open utility https://portal.example.com/bills resumes it) · 0 windows open'],
  ]);
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
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser wait --idle --ms=999999]']]), [['hand-a', '[agent:browser] utility idle after 2.3s']]);
  assert.deepStrictEqual(h.calls, [['hand-a', 'idle', { ms: 120000, forText: null }]]);
});

test('scheduler: a bare wait --ms without --for is a fixed pause capped at 120 s, never an idle wait', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser wait --ms=2500]']]), []);
  h.advance(2499);
  await h.settle();
  assert.deepStrictEqual(h.out.splice(0), []);
  h.advance(1);
  await h.settle();
  assert.deepStrictEqual(h.out.splice(0), [['hand-a', '[agent:browser] utility waited 2.5s']]);
  await h.run([['hand-a', '[agent:browser wait --ms=999999]']]);
  h.advance(120000);
  await h.settle();
  assert.deepStrictEqual(h.out.splice(0), [['hand-a', '[agent:browser] utility waited 120s']]);
  assert.deepStrictEqual(h.calls, []);
});

test('scheduler: a number act carries the seat\'s read gen; after the child restarts it is refused until a read brings the new gen', async () => {
  let gen = 111;
  const h = harness({
    read: () => ({ ...PAGE, contentType: 'text/html', text: 'My Bills', elements: ['[1] button View'], truncated: false, frames: [], login: {}, gen }),
    inspect: () => ({ n: 1, tag: 'button', attrs: {}, kind: 'button' }),
    click: (a) => { if (a.n != null && a.gen !== gen) throw coded('RESTARTED', R.TEXT.restarted('utility')); return { kind: 'button', label: 'View', navigated: false, idle: { ok: true, ms: 1200 }, ...PAGE, gen }; },
  });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills'], ['hand-a', '[agent:browser read]']]);
  h.calls.length = 0;
  await h.run([['hand-a', '[agent:browser click 1]']]);
  assert.deepStrictEqual(h.calls, [['hand-a', 'click', { n: 1, gen: 111 }]]);
  gen = 222;
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click 1]']]),
    [['hand-a', '[agent:browser] error: numbers from before the browser restarted are void on utility — read again']]);
  await h.run([['hand-a', '[agent:browser inspect 1]']]);
  await h.run([['hand-a', '[agent:browser click --text="View"]']]);
  assert.deepStrictEqual(h.calls.map((c) => c[2]), [{ n: 1, gen: 111 }, { n: 1, gen: 111 }, { byText: 'View' }]);
  await h.run([['hand-a', '[agent:browser read]']]);
  h.calls.length = 0;
  assert.match((await h.run([['hand-a', '[agent:browser click 1]']]))[0][1], /^\[agent:browser\] clicked utility \[1\]/);
  assert.deepStrictEqual(h.calls, [['hand-a', 'click', { n: 1, gen: 222 }]]);
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

test('scheduler: click --text works before any read; a numbered click still needs one; it passes the text and no doc for the stale-doc check', async () => {
  const h = harness({ click: () => ({ n: 31, kind: 'clickable', label: 'Lista de plată', navigated: false, idle: { ok: true, ms: 500 }, ...PAGE }) });
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.calls.length = 0;
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click --text="Lista de plată"]']]),
    [['hand-a', '[agent:browser] clicked utility [31] clickable "Lista de plată" · same page · idle 0.5s']]);
  assert.deepStrictEqual(h.calls, [['hand-a', 'click', { byText: 'Lista de plată' }]]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click utility 4]']]),
    [['hand-a', '[agent:browser] error: read utility first — numbers come from your read']]);
  h.calls.length = 0;
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
  const early = await h.run([['hand-a', '[agent:browser inspect utility --text=Go]']]);
  assert.deepStrictEqual(h.calls.filter((c) => c[1] === 'inspect'), [['hand-a', 'inspect', { byText: 'Go' }]]);
  assert.strictEqual(early[0][1].split('\n').length, 6);
  h.calls.length = 0;
  await h.run([['hand-a', '[agent:browser read utility]']]);
  const out = await h.run([['hand-a', '[agent:browser inspect utility --text=Go]']]);
  assert.deepStrictEqual(h.calls[1], ['hand-a', 'inspect', { byText: 'Go' }]);
  assert.strictEqual(out[0][1].split('\n').length, 6);
});

const MARK = (l) => `\u0001${l}`;

test('scheduler: a second read of the same site drops the repeated chrome; --all and another origin keep it', async () => {
  const chrome = (mid, title = 'Avizier') => [title, '', ...['Acasa', 'Avizier', 'Plati'].map(MARK), ...mid, ...['Termeni', 'Ajutor', 'v1.2'].map(MARK)].join('\n');
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
  assert.ok(files[1].includes('\nstripped: 3 lines at top, 3 at bottom (repeated from your last read of utility)\n'));
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

test('scheduler: after a navigation --text and numbered acts carry no doc; a number absent from the new page reads no element', async () => {
  let doc = 1;
  const stale = (a) => { if (a.n === 7 && doc !== 1 && a.byText == null) throw coded('NO_ELEMENT', 'no element [7] on utility on this page (hidden or gone) — read again or use --text'); };
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
  assert.deepStrictEqual(h.calls.map((c) => c[2]), [{ byText: 'Avizier' }, { byText: 'Avizier' }, { n: 7 }]);
  assert.match(out[0][1], /^\[agent:browser\] clicked utility \[7\] link "Avizier"/);
  assert.match(out[1][1], /^\[agent:browser\] inspect utility \[7\]/);
  assert.deepStrictEqual(out[2], ['hand-a', '[agent:browser] error: no element [7] on utility on this page (hidden or gone) — read again or use --text']);
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

const NAV_N = ['1', '2', '3', '4'];
const NAV = ['[1] link Acasa → /', '[2] link Avizier → /avizier?t=1700000001', '[3] link Plati → /plati', '[4] link Termeni → /termeni'];

test('scheduler: elements repeated from the previous read of the site are hidden with their numbers; form controls stay', async () => {
  const { h, read } = siteHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  const first = await read({ url: 'https://portal.example.com/a', text: 'A\nFactura aprilie', elements: [...NAV, '[5] input:text Cauta', '[6] link Factura aprilie → /f/4'] });
  assert.ok(!/elements hidden/.test(first.reply));
  const navB = NAV.map((l) => l.replace('t=1700000001', 't=1700000999'));
  const second = await read({ url: 'https://portal.example.com/b', text: 'B\nFactura mai', elements: [...navB, '[5] input:text Cauta', '[6] link Factura mai → /f/5', '[7] link Plati → /plati'], chrome: NAV_N });
  assert.match(second.reply, / · 4 elements hidden → @FILE$/);
  assert.match(second.file, /\ndoc: 1 · elements: 7 \(4 repeated, hidden — still clickable by number; read --all lists them; numbers: stable per site; new since your last read: none\)/);
  assert.ok(second.file.includes('\n== elements ==\n[5] input:text Cauta\n[6] link Factura mai → /f/5\n[7] link Plati → /plati\n'));
  const again = await read(null);
  assert.ok(!/elements hidden/.test(again.reply));
  assert.ok(again.file.includes('[1] link Acasa → /\n'));
  const all = await read({ url: 'https://portal.example.com/c', text: 'C', elements: [...NAV, '[9] link Altceva → /x'] }, '[agent:browser read --all]');
  assert.ok(!/elements hidden/.test(all.reply) && all.file.includes('[1] link Acasa'));
  const links = await read({ url: 'https://portal.example.com/d', text: 'D', elements: [...NAV, '[9] link Altceva → /x'] }, '[agent:browser read --links]');
  assert.ok(!/elements hidden/.test(links.reply) && links.file.includes('[1] link Acasa'));
});

test('scheduler: controls under a dialog\'s backdrop are hidden from a first default read and counted as under the dialog; --all lists them', async () => {
  const { h, read } = siteHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  const page = { url: 'https://portal.example.com/a', text: 'A\nSettings', elements: ['[1] link Portfolio app → /', '[2] link Accounts → /accounts', '[3] button Close'], covered: [1, 2] };
  const first = await read(page);
  assert.ok(first.file.includes('\n== elements ==\n[3] button Close\n'));
  assert.ok(!first.file.includes('Portfolio app'));
  assert.ok(first.file.includes('(2 hidden (2 under the dialog, 0 repeated) — read --all lists them; numbers: stable per site;'));
  const all = await read(page, '[agent:browser read --all]');
  assert.ok(all.file.includes('\n== elements ==\n[1] link Portfolio app → /\n[2] link Accounts → /accounts\n[3] button Close\n'));
  assert.ok(!/hidden/.test(all.file));
});

test('scheduler: page 2 of a read hides the same repeated elements as page 1', async () => {
  const { h, read } = siteHarness();
  const many = (from, n, tag) => Array.from({ length: n }, (_, i) => `[${from + i}] link ${tag} ${i} ${'x'.repeat(150)} → /${tag}/${i}`);
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  await read({ url: 'https://portal.example.com/a', text: 'A', elements: many(1, 30, 'nav') });
  const b = { url: 'https://portal.example.com/b', text: 'B', elements: [...many(1, 30, 'nav'), ...many(31, 40, 'body')], chrome: Array.from({ length: 30 }, (_, i) => i + 1) };
  const p1 = await read(b, '[agent:browser read --max=1000]');
  assert.match(p1.reply, /page 1\/2 · 70 elements · .* · 30 elements hidden/);
  const p2 = await read(b, '[agent:browser read --max=1000 --page=2]');
  assert.match(p2.reply, /page 2\/2 · 70 elements · .* · 30 elements hidden/);
  assert.ok(!p2.file.includes('link nav '));
});

test('scheduler: a one-line in-place change on the same path is not chrome-stripped; a --links read still updates the base', async () => {
  const chrome = (menu, mid) => ['T', '', ...menu.map(MARK), ...mid, ...['Termeni', 'Ajutor', 'v1.2'].map(MARK)].join('\n');
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

test('scheduler: a --text read hides no elements, and a closed window forgets the previous read', async () => {
  const { h, read } = siteHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  await read({ url: 'https://portal.example.com/a', text: 'A', elements: [...NAV, '[5] link A → /a'] });
  const t = await read({ url: 'https://portal.example.com/b', text: 'B', elements: [...NAV, '[5] link B → /b'] }, '[agent:browser read --text]');
  assert.ok(!/elements hidden/.test(t.reply) && !t.file.includes('repeated'));
  h.sched.onClosed('utility');
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/a']]);
  const fresh = await read({ url: 'https://portal.example.com/c', text: 'C', elements: [...NAV, '[5] link C → /c'] });
  assert.ok(!/elements hidden/.test(fresh.reply) && fresh.file.includes('[1] link Acasa'));
});

test('scheduler grant: a free service is granted, the lease runs from the grant, and the first read needs no read', async () => {
  const h = harness();
  assert.deepStrictEqual((({ prev, prevCurrent, ...g }) => g)(h.sched.grant('utility', 'hand-a')), { service: 'utility', seat: 'hand-a' });
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', LEASE_40.replace('40s', '0s')]]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser read]']]), [['hand-a', READ_REPLY]]);
  h.advance(5 * 60 * 1000);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', READ_REPLY]]);
});

test('scheduler grant: an operator-held service with an idle leaseholder is granted to the new seat', async () => {
  const h = harness();
  await h.run([['hand-b', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.sched.onState({ event: 'state', service: 'utility', state: 'held', reason: 'takeover' });
  assert.deepStrictEqual((({ prev, prevCurrent, ...g }) => g)(h.sched.grant('utility', 'hand-a')), { service: 'utility', seat: 'hand-a' });
  h.sched.onState({ event: 'state', service: 'utility', state: 'idle', handback: true, url: 'u', title: 't', login: {} });
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser read utility]']]), [['hand-a', READ_REPLY]]);
});

test('scheduler grant: a seat busy on the service refuses the grant, naming it', async () => {
  const h = harness();
  await h.run([['hand-b', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.sched.onState(HELD_STATE);
  await h.run([['hand-b', '[agent:browser wait utility]']]);
  assert.throws(() => h.sched.grant('utility', 'hand-a'), { message: 'agent hand-b is waiting on utility — wait or ask it to release' });
  assert.strictEqual(h.sched.activeSeat('utility'), 'hand-b');
});

test('scheduler restoreLease: a failed handover gives the lease back to the previous holder, only while the new seat holds it', async () => {
  const h = harness();
  await h.run([['hand-b', '[agent:browser open utility] https://portal.example.com/bills']]);
  const g = h.sched.grant('utility', 'hand-a');
  assert.strictEqual(g.prev.seat, 'hand-b');
  h.sched.restoreLease('utility', 'hand-a', g.prev);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', READ_REPLY]]);
  h.sched.restoreLease('utility', 'hand-a', null);
  assert.deepStrictEqual(await h.run([['hand-b', '[agent:browser read utility]']]), [['hand-b', READ_REPLY]]);
});

test('scheduler restoreLease: a failed handover restores the granted seat\'s previous current service', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open other] https://other.example.com/']]);
  assert.strictEqual(h.sched.seatState('hand-a').current, 'other');
  const g = h.sched.grant('utility', 'hand-a');
  assert.strictEqual(g.prevCurrent, 'other');
  assert.strictEqual(h.sched.seatState('hand-a').current, 'utility');
  h.sched.restoreLease('utility', 'hand-a', g.prev, g.prevCurrent);
  assert.strictEqual(h.sched.seatState('hand-a').current, 'other');
});

test('storedLogin: each account-UI hint reads as logged in via account-ui; a password field or nothing does not', () => {
  for (const hint of ['logout', 'profile', 'composer']) {
    assert.deepStrictEqual(storedLogin({ loggedInHint: hint }, 5), { state: 'logged-in', at: 5, via: 'account-ui' }, hint);
  }
  assert.deepStrictEqual(storedLogin({ logoutLink: true, loggedInHint: 'logout' }, 5), { state: 'logged-in', at: 5, via: 'logout-link' });
  assert.deepStrictEqual(storedLogin({ password: true, loggedInHint: 'profile' }, 5), { state: 'login-page', at: 5, via: 'password-field' });
  assert.deepStrictEqual(storedLogin({ loggedInHint: null }, 5), { state: 'unknown', at: 5 });
});

test('storedLogin: a Google sign-in page is a sign-in page; only a Google rejection is idp-refused', () => {
  assert.deepStrictEqual(storedLogin({ idp: 'google' }, 5), { state: 'login-page', at: 5, via: 'password-field' });
  assert.deepStrictEqual(storedLogin({ idp: 'google', googleRejected: true }, 5), { state: 'idp-refused', at: 5, via: 'google' });
});

test('scheduler: services and the read header name the site a window moved to, against the host it was opened as', async () => {
  const h = harness({
    read: () => ({ ...PAGE, url: 'https://my.smartthings.com/devices', contentType: 'text/html', text: 'Devices', elements: [], truncated: false, frames: [], login: {} }),
  });
  await h.run([['hand-a', '[agent:browser open ebloc] https://e-bloc.ro/']]);
  assert.strictEqual(h.storage.get().services.ebloc.openedHost, 'e-bloc.ro');
  h.sched.onState({ service: 'ebloc', state: 'idle', url: 'https://e-bloc.ro/' });
  await h.run([['hand-a', '[agent:browser release ebloc]']]);
  const seat = `hand-site-${process.pid}`;
  await h.run([[seat, '[agent:browser read ebloc]']]);
  const dir = R.replyDir(seat);
  const newest = fs.readdirSync(dir).filter((f) => f.startsWith('r-')).sort().at(-1);
  assert.strictEqual(fs.readFileSync(path.join(dir, newest), 'utf8').split('\n')[1],
    'url: https://my.smartthings.com/devices · site: my.smartthings.com (opened as e-bloc.ro)');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match((await h.run([['hand-a', '[agent:browser services]']]))[0][1], /services: ebloc — my\.smartthings\.com \(was e-bloc\.ro\) · unknown · window open · idle/);
  h.sched.noteUrl('ebloc', 'https://www.e-bloc.ro/index.php');
  assert.match((await h.run([['hand-a', '[agent:browser services]']]))[0][1], /services: ebloc — e-bloc\.ro · unknown/);
});

test('scheduler replies through the handle each submit was given, even two of one seat', async () => {
  const h = harness();
  const got = { first: [], second: [] };
  const first = { name: 'hand-a', type: 'claude', inject: (text) => got.first.push(text) };
  const second = { name: 'hand-a', type: 'claude', inject: (text) => got.second.push(text.replace(/ → @\S+ $/, ' → @FILE')) };
  h.sched.submit(first, toCommand(parseLine('[agent:browser open utility] https://portal.example.com/bills')));
  h.sched.submit(second, toCommand(parseLine('[agent:browser read utility]')));
  await h.settle();
  assert.deepStrictEqual(got.first, [OPENED]);
  assert.deepStrictEqual(got.second, [READ_REPLY]);
  assert.deepStrictEqual(h.out, [], 'nothing reached a handle obtained by name');
});

const { formatRead } = require('../plugins/browser-pane/read-format');

function sizedRead(target) {
  const raw = (k) => ({ ...PAGE, contentType: 'text/html', text: 'My Bills', elements: Array.from({ length: k }, (_v, i) => `[${i + 1}] link Bill number ${i + 1}`), truncated: false, frames: [], login: {} });
  let k = 1;
  while (formatRead(raw(k + 1), { service: 'utility' }).tokens <= target) k += 1;
  const r = raw(k);
  return { read: () => r, tokens: formatRead(r, { service: 'utility' }).tokens };
}

test('scheduler: under the 1k budget a read attaches, over it the reply is a plain path plus digest; --attach and --path-only override', async () => {
  const small = sizedRead(900);
  const big = sizedRead(1100);
  assert.ok(small.tokens > 850 && small.tokens <= 1000 && big.tokens > 1000 && big.tokens <= 1100, `${small.tokens} ${big.tokens}`);
  const attached = (r) => / → @FILE$/.test(r) && !r.includes('\n');
  const plain = (r) => /^\[agent:browser\] read utility .* → \S+\/r-\d+\.txt \(not attached: /.test(r) && r.split('\n').length > 2 && !r.includes('@');
  const s1 = harness({ read: small.read });
  let [[, r]] = await s1.run([['hand-a', '[agent:browser read utility]']]);
  assert.ok(attached(r), r);
  [[, r]] = await s1.run([['hand-a', '[agent:browser read utility --path-only]']]);
  assert.ok(plain(r) && r.includes('(not attached: --path-only;'), r);
  const s2 = harness({ read: big.read });
  [[, r]] = await s2.run([['hand-a', '[agent:browser read utility]']]);
  assert.ok(plain(r) && r.includes('(not attached: over ≈1.0k tok;'), r);
  [[, r]] = await s2.run([['hand-a', '[agent:browser read utility --attach]']]);
  assert.ok(attached(r), r);
});

test('scheduler: a seat override in storage wins over the global attach budget; an out-of-range stored value falls back', async () => {
  const big = sizedRead(1100);
  const h = harness({ read: big.read });
  h.storage.set({ v: 1, services: {}, attach: { global: 500, seats: { 'hand-a': 2000, 'hand-c': 50 } } });
  const first = (rows) => h.run(rows).then((o) => o.map(([who, text]) => [who, text.split('\n')[0].endsWith(' → @FILE')]));
  assert.deepStrictEqual(await first([['hand-a', '[agent:browser read utility]']]), [['hand-a', true]]);
  await h.run([['hand-a', '[agent:browser release utility]']]);
  assert.deepStrictEqual(await first([['hand-b', '[agent:browser read utility]']]), [['hand-b', false]]);
  await h.run([['hand-b', '[agent:browser release utility]']]);
  h.storage.set({ v: 1, services: {}, attach: { global: 5000, seats: { 'hand-c': 50 } } });
  assert.deepStrictEqual(await first([['hand-c', '[agent:browser read utility]']]), [['hand-c', true]]);
});

test('scheduler: read --compact asks the child for the feed; a plain read does not', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open utility] https://portal.example.com/bills']]);
  h.calls.length = 0;
  await h.run([['hand-a', '[agent:browser read --compact]'], ['hand-a', '[agent:browser read]']]);
  assert.deepStrictEqual(h.calls.map((c) => c.slice(1)), [['read', { scope: 'all', compact: true }], ['read', { scope: 'all' }]]);
});

function feedHarness() {
  const post = (i, flags = {}, text = 'hi') => ({ n: i, path: i == null ? null : `/a/status/${i}`, handle: 'a', name: null, verified: false, time: { rel: '9h', iso: null }, text, more: null, counts: [], media: {}, flags, quote: null });
  const cur = { url: 'https://x.example.com/home', doc: 1, posts: [] };
  const h = harness({ read: () => ({ ...DEFAULTS.read(), url: cur.url, doc: cur.doc, feed: { count: cur.posts.length, posts: cur.posts, numbers: [], folded: {} } }) });
  const hd = h.seat('hand-a');
  const inject = hd.inject;
  const feeds = [];
  hd.inject = (text) => {
    const m = / → @?(\S+\.txt)/.exec(text);
    if (m) feeds.push(fs.readFileSync(m[1], 'utf8').split('\n').filter((l) => /^(==|--) |^\[|^\(no new/.test(l) && !/^\[1\] button/.test(l)).slice(0, -1));
    inject(text);
  };
  const read = async (posts, line = '[agent:browser read --compact]') => { cur.posts = posts; await h.run([['hand-a', line]]); return feeds.pop(); };
  return { h, cur, post, read };
}

const lineOf = (i) => `[${i}] @a · 9h · "hi" · → /a/status/${i}`;

test('scheduler: read --compact after a scroll prints only new posts and counts the seen and the dropped; a path-less post is never seen', async () => {
  const { h, post, read } = feedHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const first = await read([post(null), ...[1, 2, 3, 4, 5, 6, 7].map((i) => post(i))]);
  assert.strictEqual(first[0], '== feed (8 posts) ==');
  const second = await read([post(null), ...[3, 4, 5, 6, 7, 8, 9].map((i) => post(i))]);
  assert.deepStrictEqual(second, [
    '== feed (3 new · 5 already seen · 2 gone since your last read) ==', '[?] @a · 9h · "hi"', lineOf(8), lineOf(9), '== elements (outside the feed) ==',
  ]);
  const all = await read([post(null), ...[3, 4, 5, 6, 7, 8, 9].map((i) => post(i))], '[agent:browser read --compact --all]');
  assert.deepStrictEqual(all.slice(0, 1).concat(all.slice(9, 12)), [
    '== feed (8 on the page · 2 seen earlier, off the page now) ==', '-- seen earlier, off the page now (2) --', lineOf(1), lineOf(2),
  ]);
  const again = await read([post(null), ...[3, 4, 5, 6, 7, 8, 9].map((i) => post(i))]);
  assert.strictEqual(again[0], '== feed (1 new · 7 already seen) ==');
});

test('scheduler: the feed memory starts over on a new document or another page; a repost of a seen status is new', async () => {
  const { h, cur, post, read } = feedHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => post(i));
  await read(eight);
  assert.strictEqual((await read(eight))[0], '== feed (0 new · 8 already seen) ==');
  cur.doc = 2;
  assert.strictEqual((await read(eight))[0], '== feed (8 posts) ==');
  cur.url = 'https://x.example.com/a/status/1';
  assert.strictEqual((await read(eight))[0], '== feed (8 posts) ==');
  assert.deepStrictEqual((await read([...eight, post(1, { repostedBy: 'Ana' })])).slice(0, 2),
    ['== feed (1 new · 8 already seen) ==', '[1] @a · 9h · reposted by Ana · "hi" · → /a/status/1']);
});

test('scheduler: a --filter read marks only the post it printed as seen; the next read prints the rest as new', async () => {
  const { h, post, read } = feedHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const six = [1, 2, 3, 4, 5, 6].map((i) => post(i));
  const nine = [...six, post(7), post(8), post(9)];
  await read(six);
  assert.deepStrictEqual((await read(nine, '[agent:browser read --compact --filter=status/8]')).slice(0, 2),
    ['== feed (1 of 3 new · 6 already seen) ==', lineOf(8)]);
  assert.deepStrictEqual((await read(nine)).slice(0, 3), ['== feed (2 new · 7 already seen) ==', lineOf(7), lineOf(9)]);
});

test('scheduler: a paged read marks only its page seen; --page=2 marks the rest', async () => {
  const { h, post, read } = feedHarness();
  const long = 'x'.repeat(190);
  const twelve = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => post(i, {}, long));
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const first = await read(twelve, '[agent:browser read --compact --max=500]');
  assert.deepStrictEqual(first.map((l) => l.slice(0, 4)), ['== f', '[1] ', '[2] ', '[3] ', '[4] ', '[5] ', '[6] ', '[7] ', '[8] ']);
  assert.strictEqual((await read(twelve))[0], '== feed (4 new · 8 already seen) ==');
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  await read(twelve, '[agent:browser read --compact --max=500]');
  await read(twelve, '[agent:browser read --compact --max=500 --page=2]');
  assert.strictEqual((await read(twelve))[0], '== feed (0 new · 12 already seen) ==');
});

test('scheduler: the feed memory survives an in-page trip to a post and back; an open starts over', async () => {
  const { h, cur, post, read } = feedHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => post(i));
  await read(eight);
  cur.url = 'https://x.example.com/u/status/1';
  assert.strictEqual((await read([post(1)]))[0], '== feed (1 post) ==');
  cur.url = 'https://x.example.com/home';
  assert.strictEqual((await read(eight))[0], '== feed (0 new · 8 already seen) ==');
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  assert.strictEqual((await read(eight))[0], '== feed (8 posts) ==');
});

test('scheduler: the feed memory keeps 8 pages per service; a ninth drops the least recently read', async () => {
  const { h, cur, post, read } = feedHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => post(i));
  await read(eight);
  for (let p = 1; p <= 7; p++) { cur.url = `https://x.example.com/p${p}`; await read(eight); }
  cur.url = 'https://x.example.com/home';
  assert.strictEqual((await read(eight))[0], '== feed (0 new · 8 already seen) ==');
  for (let p = 1; p <= 8; p++) { cur.url = `https://x.example.com/q${p}`; await read(eight); }
  cur.url = 'https://x.example.com/home';
  assert.strictEqual((await read(eight))[0], '== feed (8 posts) ==');
});

test('scheduler: gone since your last read counts seen posts that were on the page at the last read, printed or not', async () => {
  const { h, post, read } = feedHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => post(i));
  await read(eight);
  await read(eight);
  assert.strictEqual((await read([3, 4, 5, 6, 7, 8, 9, 10].map((i) => post(i))))[0], '== feed (2 new · 6 already seen · 2 gone since your last read) ==');
});

test('scheduler: a closed window drops the feed memory, so reopening the same URL at the same doc starts over', async () => {
  const { h, post, read } = feedHarness();
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => post(i));
  await read(eight);
  h.sched.onClosed('utility');
  await h.run([['hand-a', '[agent:browser open utility] https://x.example.com/home']]);
  assert.strictEqual((await read(eight))[0], '== feed (8 posts) ==');
});

test('scheduler tabs: open x:riot records profile x; two tabs share one storage record and keep two leases', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open x:riot] https://x.com/a']]);
  assert.deepStrictEqual(Object.keys(h.storage.get().services), ['x']);
  assert.strictEqual(h.storage.get().services.x.lastUrl, 'https://x.com/a');
  await h.run([['hand-a', '[agent:browser open x] https://x.com/b'], ['hand-b', '[agent:browser open x:two] https://x.com/c']]);
  assert.deepStrictEqual(Object.keys(h.storage.get().services), ['x']);
  assert.strictEqual(h.storage.get().services.x.lastSeat, 'hand-b');
  assert.deepStrictEqual([h.sched.leaseHolder('x'), h.sched.leaseHolder('x:riot'), h.sched.leaseHolder('x:two')], ['hand-a', 'hand-a', 'hand-b']);
  await h.run([['hand-a', '[agent:browser release x:riot]']]);
  assert.deepStrictEqual([h.sched.leaseHolder('x'), h.sched.leaseHolder('x:riot')], ['hand-a', null]);
});

test('scheduler tabs: read state is per tab — read x then click x:riot 3 is refused read x:riot first', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open x] https://x.com/a'], ['hand-a', '[agent:browser open x:riot] https://x.com/b'], ['hand-a', '[agent:browser read x]']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser click x:riot 3]']]), [
    ['hand-a', '[agent:browser] error: read x:riot first — numbers come from your read'],
  ]);
});

test('scheduler tabs: close x sends close for x and the reply lists the also tabs', async () => {
  let meta = null;
  const h = harness({ close: (_a, m) => { meta = m; return { closed: 'x', windows: 0, also: ['x:riot'] }; } });
  await h.run([['hand-a', '[agent:browser open x] https://x.com/a']]);
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser close x]']]), [['hand-a', '[agent:browser] closed x (also x:riot) · 0 windows open']]);
  assert.strictEqual(meta.service, 'x');
});

test('scheduler tabs: services lists a profile\'s open named tabs', async () => {
  const h = harness();
  await h.run([['hand-a', '[agent:browser open x] https://x.com/a'], ['hand-a', '[agent:browser open x:riot] https://x.com/b']]);
  h.sched.onState({ event: 'state', service: 'x', state: 'idle' });
  h.sched.onState({ event: 'state', service: 'x:riot', state: 'idle' });
  assert.deepStrictEqual(await h.run([['hand-a', '[agent:browser services]']]), [
    ['hand-a', '[agent:browser] services: x — x.com · unknown · window open · idle · tabs: riot (idle)'],
  ]);
});
