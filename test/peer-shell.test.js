'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  SHELL_CAP, shellCapGranted, peerHasShellCap, wireSeatFor, peerShellRefusal,
  vetWireResize, WIRE_COLS_MIN, WIRE_COLS_MAX, WIRE_ROWS_MIN, WIRE_ROWS_MAX,
} = require('../peer-shell');
const { termBackendFor, termAvailableFor } = require('../drawer-avail');

// --- the grant ------------------------------------------------------------
// shellCapGranted decides whether the SERVING callbacks get registered, which
// is what puts `shell` in hello. So a wrong answer here is not a UI bug: false
// when it should be true hides the feature, true when it should be false opens
// a shell endpoint on a box whose operator never agreed.

test('no setting, no grant', () => {
  assert.strictEqual(shellCapGranted({}), false);
  assert.strictEqual(shellCapGranted(null), false);
  assert.strictEqual(shellCapGranted(undefined), false);
});

test('the setting turned off is not a grant', () => {
  assert.strictEqual(shellCapGranted({ peerShellEnabled: false }), false);
});

test('the box-wide setting registers the handlers for every caller', () => {
  // Not a bug being pinned, a documented limit: the serving handler cannot tell
  // which peer is calling (no cryptographic caller identity on this wire), so
  // one switch is what decides registration. A future reader who "fixes" this
  // to be per-call needs a caller identity first, and there isn't one.
  assert.strictEqual(shellCapGranted({ peerShellEnabled: true }), true);
});

// The flag NEVER comes back from an outbound peer record. It used to live there
// and a serving-only box therefore could not grant it at all (no record to
// carry it) — the whole point of t239. A reader restoring the old read would
// re-break exactly the box the fix was for.
test('a peer record carrying the OLD per-peer flag grants nothing', () => {
  assert.strictEqual(shellCapGranted({ peers: [{ id: 'a', shellAllowed: true }] }), false,
    'the grant is a top-level serving setting, not something an outbound record can turn on');
  assert.strictEqual(shellCapGranted([{ id: 'a', shellAllowed: true }]), false,
    'and handing it the peers ARRAY — the old call shape — is not a grant either');
});

// Only a hard `=== true`. The store writes booleans, but a hand-edited settings
// file is the input here, and a truthy string on this key would open a shell
// endpoint on the strength of a typo.
test('truthy is not a grant', () => {
  assert.strictEqual(shellCapGranted({ peerShellEnabled: 'yes' }), false);
  assert.strictEqual(shellCapGranted({ peerShellEnabled: 1 }), false);
});

test('junk settings cannot crash the grant check', () => {
  assert.strictEqual(shellCapGranted(0), false);
  assert.strictEqual(shellCapGranted('x'), false);
});

test('the capability is read from what the box ADVERTISED, never assumed', () => {
  assert.strictEqual(peerHasShellCap(['attach', 'control', SHELL_CAP]), true);
  assert.strictEqual(peerHasShellCap(['attach', 'control', 'create']), false);
  assert.strictEqual(peerHasShellCap(undefined), false);
});

// --- the seat translation -------------------------------------------------
// clodex asked for this one explicitly: the assertion a future refactor needs.

test('the @ NEVER crosses the wire — the bare name is what goes in the URL', () => {
  assert.deepStrictEqual(wireSeatFor('bob@peer-1'), { name: 'bob', peerId: 'peer-1' });
  const out = wireSeatFor('bob@peer-1');
  assert.ok(!out.name.includes('@'), 'ENTER: the wire half is the seat, and it carries no @');
});

test('a peer id containing @ or a URL still yields a clean seat', () => {
  // Split at the FIRST @: a local name cannot contain one, so everything after
  // belongs to the id however ugly it is.
  assert.deepStrictEqual(
    wireSeatFor('bob@https://host@example/x'),
    { name: 'bob', peerId: 'https://host@example/x' },
  );
});

test('a composite whose NAME half fails the serving grammar is refused here, not sent', () => {
  // The far side would reject it — and a rejected seat there becomes null, which
  // is the SEATLESS WORKSPACE SHELL's key. That is the exact defect this whole
  // ticket exists downstream of, so the consumer refuses to send it at all.
  assert.strictEqual(wireSeatFor('bo b@peer-1'), null);
  assert.strictEqual(wireSeatFor('bob/../etc@peer-1'), null);
  assert.strictEqual(wireSeatFor('.@peer-1'), null, 'the dot-only guard travels too');
  assert.strictEqual(wireSeatFor('..@peer-1'), null);
  assert.strictEqual(wireSeatFor(`${'a'.repeat(65)}@peer-1`), null, '64-char cap');
});

test('a key with no @ is not a peer seat', () => {
  assert.strictEqual(wireSeatFor('bob'), null);
  assert.strictEqual(wireSeatFor('@peer-1'), null, 'an empty name half is not a seat');
  assert.strictEqual(wireSeatFor('bob@'), null, 'an empty peer half addresses nothing');
  assert.strictEqual(wireSeatFor(null), null);
  assert.strictEqual(wireSeatFor(42), null);
});

// THREE copies of the seat grammar exist, each duplicated deliberately (the
// comment in peer-shell says why), and the pin is that they AGREE:
//   peer-shell WIRE_SEAT_RE — the consumer, deciding what to put in a URL;
//   remote.js  NAME_RE      — the serving box, deciding what to accept;
//   ipc-handlers seatOf     — the LOCAL drawer, deciding what names a shell.
// The third is not optional cover. A wire seat becomes a local seat by being
// handed to the drawer, so all three sit on one path: if remote.js accepted
// something seatOf rejects, the accepted seat resolves to null there, and null
// is the key of the SEATLESS WORKSPACE SHELL — the same defect this ticket
// exists downstream of, arriving by a different door.
test('all three copies of the seat grammar are byte-identical', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  const remoteSrc = read('remote.js');
  const remoteM = remoteSrc.match(/^const NAME_RE = (.+);$/m);
  assert.ok(remoteM, 'ENTER: found remote.js NAME_RE');

  // Isolated to the seatOf arrow specifically, not "some regex in the file":
  // ipc-handlers is 2k lines and matching anywhere would let an unrelated
  // pattern satisfy this while seatOf itself drifted.
  const ipcSrc = read('ipc-handlers.js');
  const seatOfBlock = ipcSrc.match(/const seatOf = \(v\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(seatOfBlock, 'ENTER: isolated the ipc-handlers seatOf body');
  const ipcM = seatOfBlock[0].match(/(\/\^.+\/)\.test\(t\)/);
  assert.ok(ipcM, 'ENTER: found the regex inside seatOf');

  const consumer = String(require('../peer-shell').WIRE_SEAT_RE);
  assert.deepStrictEqual(
    { consumer, serving: remoteM[1], localDrawer: ipcM[1] },
    { consumer, serving: consumer, localDrawer: consumer },
    'the three copies agree; the day they drift is the day a seat one end calls valid becomes null at another',
  );
});

// --- vetting runs on BOTH ends --------------------------------------------
// The second pin clodex asked for by name. The consumer check is a fast local
// refusal; the serving check is the REAL one, because a peer is not obliged to
// run our code. A future reader deleting the serving check because "the client
// already validates" is the exact move these tests exist to stop.

test('the consumer refuses bad geometry without a round-trip', () => {
  assert.deepStrictEqual(vetWireResize(120, 40), { ok: true, cols: 120, rows: 40 });
  assert.strictEqual(vetWireResize(WIRE_COLS_MIN - 1, 40).ok, false);
  assert.strictEqual(vetWireResize(WIRE_COLS_MAX + 1, 40).ok, false);
  assert.strictEqual(vetWireResize(120, WIRE_ROWS_MIN - 1).ok, false);
  assert.strictEqual(vetWireResize(120, WIRE_ROWS_MAX + 1).ok, false);
  assert.strictEqual(vetWireResize('abc', 40).ok, false);
  assert.strictEqual(vetWireResize(undefined, undefined).ok, false);
});

test('the SERVING side vets geometry too, with the same bounds', () => {
  // Grepped rather than exercised because the point is that the check EXISTS in
  // the handler, on the far side of the wire, independent of any consumer.
  const src = fs.readFileSync(path.join(__dirname, '..', 'remote.js'), 'utf8');
  const handler = src.split("p.startsWith('/api/wterm-resize/')")[1];
  assert.ok(handler, 'ENTER: found the serving wterm-resize handler');
  const body = handler.slice(0, handler.indexOf("p.startsWith('/api/wterm-close/')"));
  assert.ok(body.length > 0, 'ENTER: isolated the handler body, not the whole file');
  assert.match(body, /bad dimensions/, 'the serving side refuses on its own');
  for (const n of [WIRE_COLS_MIN, WIRE_COLS_MAX, WIRE_ROWS_MIN, WIRE_ROWS_MAX]) {
    assert.match(body, new RegExp(`\\b${n}\\b`), `serving bound ${n} matches the consumer's`);
  }
});

test('the serving side vets the SEAT too — the consumer grammar is not trusted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'remote.js'), 'utf8');
  const wterm = src.split('\n').filter((l) => l.includes("p.startsWith('/api/wterm"));
  assert.strictEqual(wterm.length, 4, 'ENTER: all four wterm endpoints found');
  for (const route of ['/api/wterm/', '/api/wterm-input/', '/api/wterm-resize/', '/api/wterm-close/']) {
    const after = src.split(`p.startsWith('${route}')`)[1] || '';
    assert.match(after.slice(0, 400), /NAME_RE\.test\(seat\)/, `${route} re-checks the seat`);
  }
});

// --- refusals -------------------------------------------------------------

test('off and no-services are indistinguishable — the consumer learns no, not why', () => {
  const a = peerShellRefusal('off', 'thinkpad');
  const b = peerShellRefusal('no-services', 'thinkpad');
  assert.strictEqual(a, b);
  assert.match(a, /isn't available on 'thinkpad'/);
  assert.match(a, /operator has to enable it/);
});

test('an absent shell cap names BOTH remedies, because it cannot tell them apart', () => {
  // The DM-federation shape ("predates dm federation — update its Clodex")
  // does NOT transfer: `dm` is advertised unconditionally by every box that
  // has it, so an absent `dm` really does mean "too old". `shell` is
  // grant-gated, so an absent `shell` is equally "no grant" and "no feature".
  // Claiming either one sends the operator to fix the wrong box.
  const t = peerShellRefusal('predates', 'thinkpad');
  assert.strictEqual(t, peerShellRefusal('off', 'thinkpad'),
    'ENTER: predates is an ALIAS of off, not its own sentence');
  assert.match(t, /operator has to enable it/, 'the grant remedy');
  assert.match(t, /predates peer terminals/, 'the update remedy');
});

test('revocation does not read as a network blip', () => {
  // If a revoked stream ended like an offline dip, the consumer would sit in a
  // reconnect backoff retrying against a decision that will not change.
  const r = peerShellRefusal('revoked', 'thinkpad');
  assert.match(r, /turned off on 'thinkpad'/);
  assert.notStrictEqual(r, peerShellRefusal('offline', 'thinkpad'));
});

test("a failure quotes the box's own message when there is one", () => {
  assert.match(peerShellRefusal('failed', 'thinkpad', 'spawn EACCES'), /spawn EACCES/);
  assert.match(peerShellRefusal('failed', 'thinkpad'), /could not open a terminal\.$/);
});

test('an unknown code still produces an answer, never undefined', () => {
  // Every refusal path must ANSWER. A silent one leaves a tab that never opens
  // and never says why, which is the failure mode the term-exec work spent two
  // tickets removing locally.
  const out = peerShellRefusal('something-new', 'thinkpad');
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('a missing peer label degrades to a readable phrase', () => {
  assert.match(peerShellRefusal('off', null), /that box/);
});

// --- backend selection ----------------------------------------------------

test('termBackendFor routes a local agent seat to the local PTY', () => {
  assert.strictEqual(termBackendFor({ type: 'claude' }), 'local');
  assert.strictEqual(termBackendFor({ type: 'codex' }), 'local');
  assert.strictEqual(termBackendFor({ type: null }), 'local', 'the seatless workspace shell');
});

test('a bash seat has no backend at all — locality was never the reason', () => {
  assert.strictEqual(termBackendFor({ type: 'bash' }), null);
  assert.strictEqual(termBackendFor({ type: 'bash', peerHasShell: true }), null,
    'ENTER: a peer grant does not resurrect the bash exclusion');
});

test('a peer seat gets the peer backend ONLY when the box declared the capability', () => {
  assert.strictEqual(termBackendFor({ type: 'remote', peerHasShell: true }), 'peer');
  assert.strictEqual(termBackendFor({ type: 'remote', peerHasShell: false }), null);
  assert.strictEqual(termBackendFor({ type: 'remote' }), null,
    'absent is not permitted — the tab must not appear and then fail');
});

// The ruling this pins is clodex's ruling 4, and it is the reason these are two
// predicates rather than one with a mode argument. termAvailableFor is what the
// agent-facing term intent calls; if it ever started answering true for a peer
// seat, remote agent-driven exec would become reachable without anyone deciding
// it should be.
test('the AGENT-facing predicate still refuses a peer seat, backend or no backend', () => {
  assert.strictEqual(termAvailableFor('remote'), false);
  assert.strictEqual(termBackendFor({ type: 'remote', peerHasShell: true }), 'peer');
  assert.notStrictEqual(
    termAvailableFor('remote'),
    termBackendFor({ type: 'remote', peerHasShell: true }) !== null,
    'ENTER: the two predicates DISAGREE about a granted peer seat, and that is the point',
  );
});
