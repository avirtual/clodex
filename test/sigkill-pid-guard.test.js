'use strict';

// Run: node --test
//
// A non-positive pid must never reach process.kill().
//
// THE INCIDENT. kill() and archive() each arm a 5-second backstop SIGKILL for a
// pty that ignored `pty.kill()`. Both called `process.kill(s.pty.pid, 'SIGKILL')`
// with no guard, and `process.kill` does not read a non-positive pid as an id:
//
//   -1  signal EVERY process the user may signal — the whole desktop
//    0  signal our own process group — the whole app
//
// A test fixture whose stub pty carried `pid: -1` reached kill() and SIGKILLed
// ~277 processes — Dock, WindowServer, Terminal, Chrome, Postgres, Ollama —
// three times across three suite runs. The bare `catch {}` swallowed the call,
// so nothing reached the app log and the machine simply lost every window.
//
// Why a fixture could reach it at all: `pty` is an injected seam, so its pid is
// whatever a caller supplies, and a real pty that has already exited can leave
// the field undefined. The delay is what makes it bite mid-suite rather than at
// exit — five seconds after the session was captured, long after the test that
// created it finished.
//
// team-tickets.js's suite runner guards the identical call, and its comment
// says why ("`> 0` is load-bearing, not defensive noise"). That guard predates
// this one and never reached session-manager.js. This file is what stops the
// two drifting apart again.
//
// The subjects drive the REAL kill()/archive() and intercept process.kill,
// rather than calling the helper directly: the bug was never in the helper (it
// did not exist), it was in what the call sites passed. A test that called a
// guard function and asserted it guards would have been green all along.

const { test } = require('node:test');
const assert = require('node:assert');
const { createSessionManager } = require('../session-manager');

// Every pid shape that is NOT a request to signal one specific process.
// -1 is the one that fired; the others are the same class and cost the same.
const BROADCAST_PIDS = [-1, 0, undefined, null, NaN, -4242];

function mkManager() {
  const store = [];
  const persistence = {
    list: () => store,
    get: (n) => store.find((e) => e.name === n) || null,
    upsert: (e) => { store.push({ ...e }); },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setArchived: () => {},
  };
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    notifyOS: () => {},
    fs: require('node:fs'),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const m = new SessionManager();
  m._notifyComposition = () => {};
  return m;
}

function seat(m, name, pid) {
  const s = {
    name,
    type: 'claude',
    cwd: '/proj',
    workspaceId: 'default',
    agentType: null,
    pty: { pid, kill() {} },
  };
  m.sessions.set(name, s);
  return s;
}

// Runs `fn`, then fires every timer the code armed, capturing what reached
// process.kill. Returns the captured pids.
async function killsDuring(fn) {
  const realKill = process.kill;
  const realSetTimeout = global.setTimeout;
  const armed = [];
  const seen = [];
  // Capture rather than execute: a bug here must be REPORTED, never performed.
  // If the guard is missing and -1 slips through, this test must not be the
  // thing that kills the developer's desktop to prove it.
  process.kill = (pid, sig) => { seen.push({ pid, sig }); };
  global.setTimeout = (cb, ms) => { armed.push(cb); return { unref() {} }; };
  try {
    await fn();
    for (const cb of armed) cb(); // fire the 5s backstop now
  } finally {
    process.kill = realKill;
    global.setTimeout = realSetTimeout;
  }
  return seen;
}

test('ENTER: the backstop really is armed, and really would call process.kill', async () => {
  // Without this, every assertion below is "no bad call happened" — which is
  // equally true of a kill() that arms no timer at all. A real pid must reach
  // process.kill, or the absences the other subjects assert prove nothing.
  const m = mkManager();
  seat(m, 'a', 4242);
  const seen = await killsDuring(() => m.kill('a'));
  assert.deepStrictEqual(seen, [{ pid: 4242, sig: 'SIGKILL' }],
    'a positive pid must still be SIGKILLed after the delay — this is the backstop doing its job, and if it '
    + 'stops happening the guard has been written too wide');
});

test('ENTER: archive() arms the same backstop', async () => {
  const m = mkManager();
  seat(m, 'b', 4243);
  const seen = await killsDuring(() => m.archive('b'));
  assert.deepStrictEqual(seen, [{ pid: 4243, sig: 'SIGKILL' }],
    'archive() has its own copy of the backstop; it must be armed too, or its guard subject below is vacuous');
});

for (const pid of BROADCAST_PIDS) {
  const label = Number.isNaN(pid) ? 'NaN' : String(pid);

  test(`kill(): pid ${label} must never reach process.kill`, async () => {
    const m = mkManager();
    seat(m, 'x', pid);
    const seen = await killsDuring(() => m.kill('x'));
    assert.deepStrictEqual(seen, [],
      `process.kill was called with pid ${label}. Non-positive pids are BROADCASTS: -1 signals every process `
      + 'the user can signal (the whole desktop — this really happened, ~277 processes, three times), and 0 '
      + 'signals our own process group (the whole app). The pty seam does not guarantee a real pid, so the '
      + 'call site must check `> 0` before signalling.');
  });

  test(`archive(): pid ${label} must never reach process.kill`, async () => {
    const m = mkManager();
    seat(m, 'y', pid);
    const seen = await killsDuring(() => m.archive('y'));
    assert.deepStrictEqual(seen, [],
      `archive()'s backstop called process.kill with pid ${label} — same broadcast hazard as kill()'s. The two `
      + 'copies of this timer must not drift apart.');
  });
}

// The source-shape half. The subjects above pin the two call sites that exist;
// this one fails when a THIRD is added without a guard, which is exactly how
// these two came to differ from team-tickets.js's already-guarded copy.
test('every process.kill in session-manager.js is guarded against a broadcast pid', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'session-manager.js'), 'utf8');
  // Comments blanked: this file's own header quotes `process.kill(-1)` while
  // explaining the incident, and a scan that counted prose would report it.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const calls = [...code.matchAll(/process\.kill\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 1,
    `found ${calls.length} process.kill call sites — the scan has stopped matching and this pin is vacuous`);

  // The ONLY argument any process.kill in this file may take is the helper's
  // own already-checked `pid`. A raw `s.pty.pid` reaching process.kill directly
  // is the incident: it bypasses the refusal entirely. This is an allowlist
  // rather than a search for the known-bad spelling, because the next call site
  // will be written by someone who never read this file — and an allowlist
  // fails closed on a spelling nobody predicted.
  const unguarded = calls.filter((arg) => arg !== 'pid');
  assert.deepStrictEqual(unguarded, [],
    `these process.kill call sites do not go through the guard: ${unguarded.join(', ')}. Route them via `
    + 'sigkillPid(), which refuses a non-positive pid. A raw `s.pty.pid` here is the incident that took the '
    + 'desktop down three times — the pty seam does not guarantee a real pid.');

  assert.match(code, /function sigkillPid\(pid, name, log\)\s*\{\s*if \(!\(pid > 0\)\)/,
    'sigkillPid must open with the `pid > 0` refusal — that single check is the entire safety property, and a '
    + 'rewrite that moves or softens it puts the broadcast back');
});
