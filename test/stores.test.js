// Run: node --test
// Covers the stores factory: each of the eight stores exercised against a temp
// userData dir + a temp registry dir — missing-file defaults, round-trip
// persistence, the sanitize/validation paths, and the one-shot prompts.json
// migration that runs during construction.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initStores } = require('../stores');
const { shellCapGranted } = require('../peer-shell');

// Fresh temp userData + registry dirs, and a stores bundle over them. Seeding is
// disabled here (resourcesDir → a path that doesn't exist) so the shipped library
// defaults don't pollute the per-store assertions below; the seed step has its
// own dedicated tests that exercise it explicitly.
function freshStores() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  const stores = initStores(userData, { log: console, registryDir, resourcesDir: path.join(registryDir, '__no_seed__') });
  return { userData, registryDir, stores,
    cleanup() {
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    } };
}

test('persistence: missing file -> [], upsert/list/remove round-trip', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.deepStrictEqual(stores.persistence.list(), []);
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    stores.persistence.upsert({ name: 'b', type: 'codex', workspaceId: 'other' });
    assert.deepStrictEqual(stores.persistence.list().map(e => e.name), ['a', 'b']);
    assert.deepStrictEqual(stores.persistence.listForWorkspace('other').map(e => e.name), ['b']);
    stores.persistence.remove('a');
    assert.deepStrictEqual(stores.persistence.list().map(e => e.name), ['b']);
  } finally { cleanup(); }
});

test('persistence: setSessionId accumulates a dedup move-to-end history', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', workspaceId: 'default' });
    stores.persistence.setSessionId('a', 's1');
    stores.persistence.setSessionId('a', 's2');
    stores.persistence.setSessionId('a', 's1'); // re-resume old id -> moves to end
    const e = stores.persistence.get('a');
    assert.strictEqual(e.sessionId, 's1');
    assert.deepStrictEqual(e.sessionIds, ['s2', 's1']);
  } finally { cleanup(); }
});

// get() hands its result to callers that edit it in place, so a default returned
// by reference outlives the caller that mutated it: the corruption lands on a
// LATER read, in code that never touched settings, with nothing linking the two.
test('uiSettings: get() never hands out the module default by reference', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    const a = uiSettings.get();
    // ENTER: a fresh install must actually be reading defaults here — against a
    // settings file with these keys stored, the mutations below prove nothing.
    assert.deepStrictEqual(a.recentCwds, [], 'ENTER: fresh install reads the default recentCwds');
    assert.deepStrictEqual(a.plugins, {}, 'ENTER: fresh install reads the default plugins');
    assert.ok(Array.isArray(a.statusline.claude) && a.statusline.claude.length > 0,
      'ENTER: fresh install reads the default claude statusline');
    const claudeLen = a.statusline.claude.length;
    a.recentCwds.push('/tmp/poison');
    a.plugins.poison = true;
    a.statusline.claude.push('poison');
    a.boxes.push({ id: 'poison' });
    const b = uiSettings.get();
    assert.deepStrictEqual(b.recentCwds, [], 'a later read is unaffected by an earlier caller mutation');
    assert.deepStrictEqual(b.plugins, {}, 'nested plugins object is not shared');
    assert.strictEqual(b.statusline.claude.length, claudeLen, 'nested statusline array is not shared');
    assert.ok(!b.boxes.some((x) => x && x.id === 'poison'), 'nested boxes array is not shared');
  } finally { cleanup(); }
});

test('uiSettings: a corrupt settings file yields a fresh default object each read', () => {
  const { stores, cleanup, userData } = freshStores();
  try {
    // The catch path — the one that used to `return DEFAULT_UI_SETTINGS` outright.
    fs.writeFileSync(path.join(userData, 'ui-settings.json'), '{ not json');
    const a = stores.uiSettings.get();
    assert.deepStrictEqual(a.recentCwds, [], 'ENTER: the corrupt file must fall through to defaults');
    a.recentCwds.push('/tmp/poison');
    a.theme = 'poison';
    const b = stores.uiSettings.get();
    assert.deepStrictEqual(b.recentCwds, [], 'catch path does not hand out the shared default');
    assert.notStrictEqual(b.theme, 'poison');
  } finally { cleanup(); }
});

test('uiSettings: reboot rate-limit stamp ships at 0 and round-trips (Task 27)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    // Fresh install: never rebooted. (Auth is the per-session intents gate, NOT a
    // settings key — nothing else to seed here.)
    assert.strictEqual(uiSettings.get().lastRebootAt, 0);
    // The handler stamps a reboot; it persists and survives an unrelated save.
    uiSettings.set({ lastRebootAt: 1234567890 });
    assert.strictEqual(uiSettings.get().lastRebootAt, 1234567890);
    uiSettings.set({ theme: uiSettings.get().theme }); // unrelated write
    assert.strictEqual(uiSettings.get().lastRebootAt, 1234567890);
  } finally { cleanup(); }
});

test('uiSettings: pendingRebootNotice ships null, round-trips, sanitizes, and clears (Task 28)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    // Fresh install: no notice armed.
    assert.strictEqual(uiSettings.get().pendingRebootNotice, null);
    // Arming persists the full shape and survives an unrelated save.
    // `attempts` (t229) is part of the persisted shape: it is the only durable
    // bound on how many times a notice may be re-offered, so a round-trip that
    // dropped it would silently make the retry unbounded.
    uiSettings.set({ pendingRebootNotice: { name: 'clodex', at: 1234567890, reason: 'nightly', attempts: 2 } });
    assert.deepStrictEqual(uiSettings.get().pendingRebootNotice, { name: 'clodex', at: 1234567890, reason: 'nightly', attempts: 2 });
    uiSettings.set({ theme: uiSettings.get().theme }); // unrelated write
    assert.deepStrictEqual(uiSettings.get().pendingRebootNotice, { name: 'clodex', at: 1234567890, reason: 'nightly', attempts: 2 });
    // A malformed at/reason is coerced (finite ms | 0, string | ''); a nameless
    // value is rejected to null.
    // A malformed/absent attempts coerces to 0 — never NaN, which would compare
    // false against the ceiling forever and re-announce on every launch.
    uiSettings.set({ pendingRebootNotice: { name: 'x', at: 'soon', reason: 42, attempts: 'lots' } });
    assert.deepStrictEqual(uiSettings.get().pendingRebootNotice, { name: 'x', at: 0, reason: '', attempts: 0 });
    uiSettings.set({ pendingRebootNotice: { at: 5 } }); // no name
    assert.strictEqual(uiSettings.get().pendingRebootNotice, null);
    // Explicit null is a real clear (one-shot), not "keep".
    uiSettings.set({ pendingRebootNotice: { name: 'y', at: 1, reason: '' } });
    assert.ok(uiSettings.get().pendingRebootNotice);
    uiSettings.set({ pendingRebootNotice: null });
    assert.strictEqual(uiSettings.get().pendingRebootNotice, null);
  } finally { cleanup(); }
});

// The peer-terminal grant used to live as `shellAllowed` on each outbound peer
// record; t239 moved it to the top-level `peerShellEnabled` because a
// serving-only box has no record to carry it. These four pin the UPGRADE, which
// is the part that can go wrong silently: a version bump must never grant a
// capability the operator did not enable, nor revoke one they did.
//
// Written as a RAW settings FILE rather than through set(): the migration reads
// `raw.peers`, and only a file that predates the change can contain the old
// flag at all — set() strips it, which is exactly the trap the ordering hazard
// describes.
function writeRawSettings(userData, obj) {
  fs.writeFileSync(path.join(userData, 'ui-settings.json'), JSON.stringify(obj));
}

test('uiSettings: an upgrading box that granted the peer terminal KEEPS serving', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    writeRawSettings(userData, {
      theme: 'midnight',
      peers: [
        { id: 'a', label: 'A', url: 'http://a' },
        { id: 'b', label: 'B', url: 'http://b', shellAllowed: true },
      ],
    });
    const s = stores.uiSettings.get();
    assert.strictEqual(s.theme, 'midnight', 'ENTER: the settings file really was read');
    assert.strictEqual(s.peers.length, 2, 'ENTER: both peer records survived the sanitizer');
    assert.strictEqual('shellAllowed' in s.peers[1], false,
      'ENTER: the sanitized array has ALREADY lost the flag — so the migration cannot be reading it there');
    assert.strictEqual(s.peerShellEnabled, true,
      'the grant carried over; reading the sanitized peers instead silently revokes every upgrading box');
    assert.strictEqual(shellCapGranted(s), true, 'and the box still advertises the cap');
  } finally { cleanup(); }
});

test('uiSettings: an upgrading box that never granted it does NOT start serving', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    writeRawSettings(userData, { peers: [{ id: 'a', label: 'A', url: 'http://a' }] });
    const s = stores.uiSettings.get();
    assert.strictEqual(s.peers.length, 1, 'ENTER: the peer record was read');
    assert.strictEqual(s.peerShellEnabled, false, 'a version bump does not open a shell endpoint');
    assert.strictEqual(shellCapGranted(s), false);
  } finally { cleanup(); }
});

// A file that has BOTH keys is the state right after an upgrade-then-revoke:
// the top-level key is written, and the stale per-record flag is still in the
// file until the next peers write re-sanitizes it away. The explicit setting has
// to win, or the revocation is undone on every launch.
test('uiSettings: an explicit peerShellEnabled beats a leftover per-record flag', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    writeRawSettings(userData, {
      peerShellEnabled: false,
      peers: [{ id: 'a', label: 'A', url: 'http://a', shellAllowed: true }],
    });
    assert.strictEqual(stores.uiSettings.get().peerShellEnabled, false,
      'the operator revoked it; a stale record must not resurrect the grant');
    writeRawSettings(userData, { peerShellEnabled: true, peers: [] });
    assert.strictEqual(stores.uiSettings.get().peerShellEnabled, true,
      'and a serving-only box with no peers at all is served by the same key');
    // A junk value resolves to `false` on the key's PRESENCE, and must NOT fall
    // through to the legacy per-record source. "Malformed, so consult the old
    // storage" is a rule that would start meaning something the day a reader
    // relaxes shellCapGranted's `=== true`.
    writeRawSettings(userData, {
      peerShellEnabled: 'yes',
      peers: [{ id: 'a', label: 'A', url: 'http://a', shellAllowed: true }],
    });
    assert.strictEqual(stores.uiSettings.get().peerShellEnabled, false,
      'junk is off, not a re-read of the flag this key replaced');
  } finally { cleanup(); }
});

test('uiSettings: the grant round-trips, and is never written back onto a peer record', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    assert.strictEqual(uiSettings.get().peerShellEnabled, false, 'ENTER: a fresh install does not serve');
    uiSettings.set({ peerShellEnabled: true, peers: [{ id: 'a', label: 'A', url: 'http://a', shellAllowed: true }] });
    const s = uiSettings.get();
    assert.strictEqual(s.peerShellEnabled, true);
    assert.strictEqual(s.peers.length, 1, 'ENTER: the peer was persisted');
    assert.strictEqual('shellAllowed' in s.peers[0], false,
      'the old per-record flag is not in the whitelist — one home for the grant, not two that disagree');
    // The clobber path: an unrelated write must not disturb it.
    uiSettings.set({ theme: uiSettings.get().theme });
    assert.strictEqual(uiSettings.get().peerShellEnabled, true, 'and survives a later unrelated set()');
    // Only a boolean can move it; junk keeps the current value rather than
    // landing a truthy string that every reader then interprets for itself.
    uiSettings.set({ peerShellEnabled: 'no' });
    assert.strictEqual(uiSettings.get().peerShellEnabled, true, 'a non-boolean is not a revocation');
    uiSettings.set({ peerShellEnabled: false });
    assert.strictEqual(uiSettings.get().peerShellEnabled, false);
  } finally { cleanup(); }
});

test('uiSettings: peer relayAllowed + disabled survive the sanitize round-trip (presence-encoded)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    // A peer with both flags set, plus a plain one.
    uiSettings.set({ peers: [
      { id: 'a', label: 'A', url: 'http://a', relayAllowed: true, disabled: true },
      { id: 'b', label: 'B', sshHost: 'b-host' },
    ] });
    let peers = uiSettings.get().peers;
    const a = peers.find((p) => p.id === 'a');
    const b = peers.find((p) => p.id === 'b');
    // Both flags must survive the sanitizer (the bug: relayAllowed was stripped).
    assert.strictEqual(a.relayAllowed, true, 'relayAllowed persists through sanitizePeers');
    assert.strictEqual(a.disabled, true, 'disabled persists through sanitizePeers');
    // Default-deny / absence invariant on a peer that never set them.
    assert.strictEqual('relayAllowed' in b, false, 'absent relayAllowed stays absent (gate default-deny)');
    assert.strictEqual('disabled' in b, false, 'absent disabled stays absent');
    // Survives an unrelated settings write (the clobber path that broke it live).
    uiSettings.set({ theme: uiSettings.get().theme });
    peers = uiSettings.get().peers;
    assert.strictEqual(peers.find((p) => p.id === 'a').relayAllowed, true,
      'relayAllowed survives a later unrelated set() (no clobber)');
    // Clearing to falsy deletes the key rather than writing relayAllowed:false.
    uiSettings.set({ peers: peers.map((p) => p.id === 'a' ? (({ relayAllowed, ...rest }) => rest)(p) : p) });
    assert.strictEqual('relayAllowed' in uiSettings.get().peers.find((p) => p.id === 'a'), false,
      'deleting the key persists as ABSENT, not relayAllowed:false');
  } finally { cleanup(); }
});

test('uiSettings: peer auth token — set, trim, cap 256, and absence stays absent', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [
      { id: 'a', label: 'A', url: 'http://a', token: '  sekret  ' },
      { id: 'b', label: 'B', url: 'http://b' },
      { id: 'c', label: 'C', url: 'http://c', token: 'x'.repeat(400) },
    ] });
    const peers = uiSettings.get().peers;
    assert.strictEqual(peers.find((p) => p.id === 'a').token, 'sekret', 'trimmed and stored');
    assert.strictEqual('token' in peers.find((p) => p.id === 'b'), false, 'no token stays absent (presence-encoded)');
    assert.strictEqual(peers.find((p) => p.id === 'c').token.length, 256, 'capped at 256');
  } finally { cleanup(); }
});

// The exact clobber clodex asked pinned by name: the Peers dialog knows only
// hasToken, so a label-edit save OMITS token — the stored value must survive.
test('uiSettings: a label-edit save with token-omitting entries preserves prior tokens (no clobber)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [
      { id: 'a', label: 'A', url: 'http://a', token: 'tok-a' },
      { id: 'b', label: 'B', url: 'http://b', token: 'tok-b' },
    ] });
    // Simulate the dialog's collectPeers output: NO token key (it only had hasToken),
    // with one label edited.
    uiSettings.set({ peers: [
      { id: 'a', label: 'A-renamed', url: 'http://a' },
      { id: 'b', label: 'B', url: 'http://b' },
    ] });
    const peers = uiSettings.get().peers;
    assert.strictEqual(peers.find((p) => p.id === 'a').label, 'A-renamed', 'label edit applied');
    assert.strictEqual(peers.find((p) => p.id === 'a').token, 'tok-a', 'omitted token carried forward (not wiped)');
    assert.strictEqual(peers.find((p) => p.id === 'b').token, 'tok-b', 'sibling token untouched');
  } finally { cleanup(); }
});

test('uiSettings: an explicit empty token clears it; a dropped row drops its token', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [
      { id: 'a', label: 'A', url: 'http://a', token: 'tok-a' },
      { id: 'b', label: 'B', url: 'http://b', token: 'tok-b' },
    ] });
    // '' clears a; b is dropped from the array entirely.
    uiSettings.set({ peers: [
      { id: 'a', label: 'A', url: 'http://a', token: '' },
    ] });
    const peers = uiSettings.get().peers;
    assert.strictEqual('token' in peers.find((p) => p.id === 'a'), false, 'explicit empty token clears it');
    assert.strictEqual(peers.find((p) => p.id === 'b'), undefined, 'dropped row is gone (token with it)');
  } finally { cleanup(); }
});

test('persistence: setHoldUntil round-trips and clears to an ABSENT key', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', workspaceId: 'default' });
    // No hold on a fresh entry.
    assert.strictEqual('holdUntil' in stores.persistence.get('a'), false);
    // Arm: the epoch-ms deadline persists.
    stores.persistence.setHoldUntil('a', 1_700_000_000_000);
    assert.strictEqual(stores.persistence.get('a').holdUntil, 1_700_000_000_000);
    // survives an unrelated upsert (spread-merge keeps the field)
    stores.persistence.upsert({ name: 'a', label: 'x' });
    assert.strictEqual(stores.persistence.get('a').holdUntil, 1_700_000_000_000);
    // Disarm / lapse: falsy clears to an ABSENT key, no stale field left behind.
    stores.persistence.setHoldUntil('a', null);
    assert.strictEqual('holdUntil' in stores.persistence.get('a'), false);
    // 0 is treated as clear too (never persists a non-positive deadline).
    stores.persistence.setHoldUntil('a', 0);
    assert.strictEqual('holdUntil' in stores.persistence.get('a'), false);
    // No-op on an unknown name (never creates an entry).
    stores.persistence.setHoldUntil('ghost', 123);
    assert.strictEqual(stores.persistence.get('ghost'), null);
  } finally { cleanup(); }
});

test('persistence: setKeepWarmAlways is a seat flag independent of holdUntil', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', workspaceId: 'default' });
    assert.strictEqual('keepWarmAlways' in stores.persistence.get('a'), false);
    // Arm perpetually: a boolean, never a sentinel deadline — rearmPlan and the
    // renderer both read holdUntil as a real timestamp.
    stores.persistence.setKeepWarmAlways('a', true);
    assert.strictEqual(stores.persistence.get('a').keepWarmAlways, true);
    assert.strictEqual('holdUntil' in stores.persistence.get('a'), false);
    // Survives an unrelated upsert — this is what makes it a SEAT property and
    // not a per-run arming.
    stores.persistence.upsert({ name: 'a', label: 'x' });
    assert.strictEqual(stores.persistence.get('a').keepWarmAlways, true);
    // The two fields are independent; setting a deadline does not clear the flag
    // (the ipc handler owns that mutual exclusion, not the store).
    stores.persistence.setHoldUntil('a', 1_700_000_000_000);
    assert.strictEqual(stores.persistence.get('a').keepWarmAlways, true);
    assert.strictEqual(stores.persistence.get('a').holdUntil, 1_700_000_000_000);
    // Clearing leaves an ABSENT key, no stale `false` to be re-read as intent.
    stores.persistence.setKeepWarmAlways('a', false);
    assert.strictEqual('keepWarmAlways' in stores.persistence.get('a'), false);
    assert.strictEqual(stores.persistence.get('a').holdUntil, 1_700_000_000_000);
    // No-op on an unknown name (never creates an entry).
    stores.persistence.setKeepWarmAlways('ghost', true);
    assert.strictEqual(stores.persistence.get('ghost'), null);
  } finally { cleanup(); }
});

test('persistence: setRosterSent stamps a one-time marker that survives upserts', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', workspaceId: 'default' });
    // Absent on a fresh entry → create() treats it as a genuine first spawn.
    assert.strictEqual('rosterSentAt' in stores.persistence.get('a'), false);
    // Stamp at delivery: an epoch-ms marker lands.
    stores.persistence.setRosterSent('a');
    const ts = stores.persistence.get('a').rosterSentAt;
    assert.ok(typeof ts === 'number' && ts > 0, 'stamped with an epoch-ms timestamp');
    // Survives an unrelated upsert (spread-merge keeps the field) — this is what
    // makes a restart's create()-upsert NOT wipe the "already delivered" signal.
    stores.persistence.upsert({ name: 'a', label: 'x' });
    assert.strictEqual(stores.persistence.get('a').rosterSentAt, ts);
    // No-op on an unknown name (never creates an entry).
    stores.persistence.setRosterSent('ghost');
    assert.strictEqual(stores.persistence.get('ghost'), null);
    // Delete drops the whole record → a re-created 'a' is a genuine first spawn.
    stores.persistence.remove('a');
    stores.persistence.upsert({ name: 'a', workspaceId: 'default' });
    assert.strictEqual('rosterSentAt' in stores.persistence.get('a'), false);
  } finally { cleanup(); }
});

test('persistence: ephemeral + reviewFor survive upsert spread-merge (Task 24)', () => {
  const { stores, cleanup } = freshStores();
  try {
    // The team-review handler seeds these post-create; they must survive
    // create()'s own full-record upsert on a restart (spread-merge, like
    // rosterSentAt) so review-done's guard + restore keep working.
    stores.persistence.upsert({ name: 'team-review-1', workspaceId: 'default', type: 'claude' });
    stores.persistence.upsert({ name: 'team-review-1', ephemeral: true, reviewFor: 'lead' });
    let e = stores.persistence.get('team-review-1');
    assert.strictEqual(e.ephemeral, true, 'ephemeral flag persisted');
    assert.strictEqual(e.reviewFor, 'lead', 'reviewFor persisted');
    // An unrelated later upsert (mimicking a restart create()) keeps both.
    stores.persistence.upsert({ name: 'team-review-1', label: 'x', type: 'claude' });
    e = stores.persistence.get('team-review-1');
    assert.strictEqual(e.ephemeral, true, 'ephemeral survives a later spread-merge');
    assert.strictEqual(e.reviewFor, 'lead', 'reviewFor survives a later spread-merge');
  } finally { cleanup(); }
});

test('persistence: setIntents persists an array, removes the key on null', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', workspaceId: 'default' });
    // Absent by default (living all-enabled).
    assert.strictEqual('intents' in stores.persistence.get('a'), false);
    // A restricted allowlist persists, stringified.
    stores.persistence.setIntents('a', ['dm', 'who']);
    assert.deepStrictEqual(stores.persistence.get('a').intents, ['dm', 'who']);
    // [] is a REAL value — "everything gated" — distinct from absent.
    stores.persistence.setIntents('a', []);
    assert.deepStrictEqual(stores.persistence.get('a').intents, []);
    assert.strictEqual('intents' in stores.persistence.get('a'), true);
    // survives an unrelated upsert (spread-merge keeps the field)
    stores.persistence.upsert({ name: 'a', label: 'x' });
    assert.deepStrictEqual(stores.persistence.get('a').intents, []);
    // null → back to the all-enabled default: the key is REMOVED, never frozen.
    stores.persistence.setIntents('a', null);
    assert.strictEqual('intents' in stores.persistence.get('a'), false);
    // No-op on an unknown name (never creates an entry).
    stores.persistence.setIntents('ghost', ['dm']);
    assert.strictEqual(stores.persistence.get('ghost'), null);
  } finally { cleanup(); }
});

test('persistence: setEnv persists a non-empty map, removes the key when empty (T46b)', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', workspaceId: 'default' });
    // Absent by default (no session env).
    assert.strictEqual('env' in stores.persistence.get('a'), false);
    // A non-empty map persists (stored as a copy, not by reference).
    stores.persistence.setEnv('a', { AWS_PROFILE: 'acct' });
    assert.deepStrictEqual(stores.persistence.get('a').env, { AWS_PROFILE: 'acct' });
    // survives an unrelated upsert (spread-merge keeps the field)
    stores.persistence.upsert({ name: 'a', label: 'x' });
    assert.deepStrictEqual(stores.persistence.get('a').env, { AWS_PROFILE: 'acct' });
    // {} REMOVES the key — "no env" is stored as ABSENCE (matches create()).
    stores.persistence.setEnv('a', {});
    assert.strictEqual('env' in stores.persistence.get('a'), false);
    // null likewise removes.
    stores.persistence.setEnv('a', { X: '1' });
    stores.persistence.setEnv('a', null);
    assert.strictEqual('env' in stores.persistence.get('a'), false);
    // No-op on an unknown name (never creates an entry).
    stores.persistence.setEnv('ghost', { X: '1' });
    assert.strictEqual(stores.persistence.get('ghost'), null);
  } finally { cleanup(); }
});

test('persistence: entries missing workspaceId migrate to the default id', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    fs.writeFileSync(path.join(userData, 'sessions.json'),
      JSON.stringify([{ name: 'legacy' }]));
    assert.strictEqual(stores.persistence.list()[0].workspaceId, 'default');
  } finally { cleanup(); }
});

// Templates are per-file (library/templates/<name>.json); the FILENAME is the
// identity, so list() re-injects id = name = filename stem and the stored file
// carries no synthetic id. These cases exercise that fs shape.
const tplFile = (registryDir, name) =>
  path.join(registryDir, 'library', 'templates', `${name}.json`);

test('templates: save/list/remove over per-file storage', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    assert.deepStrictEqual(stores.templates.list(), []); // dir absent → empty
    stores.templates.saveByName({ name: 'T', type: 'claude', cwd: '/x' });
    // One file on disk, keyed by name; id aliases the filename stem on read.
    assert.ok(fs.existsSync(tplFile(registryDir, 'T')));
    const list = stores.templates.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'T');
    assert.strictEqual(list[0].name, 'T');
    stores.templates.remove('T'); // remove by id (= name = filename)
    assert.deepStrictEqual(stores.templates.list(), []);
    assert.strictEqual(fs.existsSync(tplFile(registryDir, 'T')), false);
  } finally { cleanup(); }
});

test('templates: the stored file is a portable object with NO synthetic id', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'trader-seat', type: 'claude', cwd: '/proj/desk' });
    const onDisk = JSON.parse(fs.readFileSync(tplFile(registryDir, 'trader-seat'), 'utf-8'));
    assert.strictEqual('id' in onDisk, false);   // id is never persisted
    assert.strictEqual(onDisk.name, 'trader-seat'); // portability hint written
    assert.strictEqual(onDisk.type, 'claude');
  } finally { cleanup(); }
});

test('templates: the full config subset round-trips (schemaless), id/name = filename', () => {
  const { stores, cleanup } = freshStores();
  try {
    // A rich template (as "Export as Template…" snapshots it) survives a
    // write → read round-trip. id/name are the filename stem on read; every
    // config field is preserved verbatim.
    const rich = {
      name: 'trader-seat', type: 'claude', cwd: '/proj/desk',
      extraArgs: ['--model', 'opus', '--dangerously-skip-permissions'],
      proxy: false,
      agents: ['reviewer'],
      denyBuiltins: ['WebSearch'],
      disabledTools: ['Edit', 'NotebookEdit'],
      disabledSkills: ['some-skill'],
      injectSkills: ['trader-notes'],
      systemPromptFile: 'trader-seat',
      appendPromptFiles: ['00-house-rules', '50-wake'],
      stripLevel: 2,
      autoCompact: false,
      intents: ['dm', 'exec', 'remind'], // a restricted seat: only these three
    };
    stores.templates.saveByName(rich);
    const loaded = stores.templates.list()[0];
    assert.deepStrictEqual(loaded, { ...rich, id: 'trader-seat' });
  } finally { cleanup(); }
});

test('templates: an old template lacking prompt fields loads as-is (back-compat)', () => {
  const { stores, cleanup } = freshStores();
  try {
    // Pre-config / pre-prompt-refs templates carry none of the new fields; they
    // must load with no field invented (missing config = clodex defaults at
    // spawn; absent prompt refs → null/[] there, so the seat still spawns).
    stores.templates.saveByName({ name: 'Legacy', type: 'codex', cwd: '/x', extraArgs: ['-a'] });
    const loaded = stores.templates.list()[0];
    assert.strictEqual(loaded.type, 'codex');
    assert.deepStrictEqual(loaded.extraArgs, ['-a']);
    assert.strictEqual('agents' in loaded, false);
    assert.strictEqual('stripLevel' in loaded, false);
    assert.strictEqual('systemPromptFile' in loaded, false);
    assert.strictEqual('appendPromptFiles' in loaded, false);
  } finally { cleanup(); }
});

test('templates: saveByName writes then overwrites the same name in place', () => {
  const { stores, cleanup } = freshStores();
  try {
    const first = stores.templates.saveByName({ name: 'seat', type: 'claude', cwd: '/a' });
    assert.strictEqual(first.id, 'seat'); // id = filename stem, no synthetic mint
    assert.strictEqual(stores.templates.list().length, 1);
    const second = stores.templates.saveByName({ name: 'seat', type: 'codex', cwd: '/b' });
    assert.strictEqual(second.id, 'seat');
    assert.strictEqual(stores.templates.list().length, 1); // overwrote, no dup
    assert.strictEqual(stores.templates.list()[0].type, 'codex');
    assert.strictEqual(stores.templates.list()[0].cwd, '/b');
  } finally { cleanup(); }
});

test('templates: saveByName overwrites the existing exact filename case-insensitively (no Foo+foo)', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'Trader-Seat', type: 'claude', cwd: '/a' });
    const b = stores.templates.saveByName({ name: 'trader-seat', type: 'claude', cwd: '/b' });
    // The original filename casing is preserved — no second near-dup file.
    // (Asserted via readdir, not existsSync: macOS APFS is case-insensitive, so
    // existsSync('trader-seat') would resolve to Trader-Seat.json there; a
    // directory listing is the FS-agnostic check.)
    assert.strictEqual(b.id, 'Trader-Seat');
    assert.strictEqual(stores.templates.list().length, 1);
    assert.strictEqual(stores.templates.list()[0].cwd, '/b');
    const files = fs.readdirSync(path.join(registryDir, 'library', 'templates'));
    assert.deepStrictEqual(files, ['Trader-Seat.json']); // exactly one, original casing
  } finally { cleanup(); }
});

test('templates: save() renames in place, unlinking the old file (no orphan)', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'old-name', type: 'claude', cwd: '/a' });
    // Drawer Edit / dialog template-mode passes the OLD name as id + the NEW name.
    stores.templates.save({ id: 'old-name', name: 'new-name', type: 'claude', cwd: '/a' });
    assert.strictEqual(fs.existsSync(tplFile(registryDir, 'old-name')), false); // old unlinked
    assert.ok(fs.existsSync(tplFile(registryDir, 'new-name')));
    const list = stores.templates.list();
    assert.strictEqual(list.length, 1); // renamed, not duplicated
    assert.strictEqual(list[0].id, 'new-name');
  } finally { cleanup(); }
});

test('templates: save() with matching id/name is a plain overwrite (no unlink)', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'seat', type: 'claude', cwd: '/a' });
    stores.templates.save({ id: 'seat', name: 'seat', type: 'claude', cwd: '/b' }); // edit-in-place
    assert.ok(fs.existsSync(tplFile(registryDir, 'seat')));
    assert.strictEqual(stores.templates.list().length, 1);
    assert.strictEqual(stores.templates.list()[0].cwd, '/b');
  } finally { cleanup(); }
});

// --- U9 merge-preserve on the by-id edit path (save()). collectFormConfig owns a
// fixed key set (EDITOR_OWNED); editing must NOT wipe non-owned keys (export-only
// fields, unknown future keys), but an OMITTED owned key IS a clear, not a
// preserve. These four pin the exact interaction. ---

test('templates: save() keeps an exported autoCompact:false when the box stays unchecked', () => {
  const { stores, cleanup } = freshStores();
  try {
    // Export writes the opt-out; the editor prefills the box unchecked and, left
    // untouched, collectFormConfig re-emits autoCompact:false in the save payload.
    stores.templates.saveByName({ name: 'exp', type: 'claude', cwd: '/a', autoCompact: false });
    stores.templates.save({ id: 'exp', name: 'exp', type: 'claude', cwd: '/a', autoCompact: false });
    assert.strictEqual(stores.templates.list()[0].autoCompact, false);
  } finally { cleanup(); }
});

test('templates: save() REMOVES autoCompact when the box is re-checked (owned key omitted = clear)', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'exp', type: 'claude', cwd: '/a', autoCompact: false });
    // Box re-checked → collectFormConfig omits autoCompact → merge must NOT
    // resurrect the stored false (autoCompact is EDITOR_OWNED).
    stores.templates.save({ id: 'exp', name: 'exp', type: 'claude', cwd: '/a' });
    assert.strictEqual('autoCompact' in stores.templates.list()[0], false);
  } finally { cleanup(); }
});

test('templates: save() carries an unknown future key through an edit round-trip', () => {
  const { stores, cleanup } = freshStores();
  try {
    // Schemaless store: seed a key the dialog does not own.
    stores.templates.saveByName({ name: 'fut', type: 'claude', cwd: '/a', futureThing: { deep: 1 } });
    stores.templates.save({ id: 'fut', name: 'fut', type: 'claude', cwd: '/b' });
    const loaded = stores.templates.list()[0];
    assert.deepStrictEqual(loaded.futureThing, { deep: 1 }); // non-owned → preserved
    assert.strictEqual(loaded.cwd, '/b'); // owned → updated by the incoming cfg
  } finally { cleanup(); }
});

test('templates: save() REMOVES intents when all boxes re-checked (EDITOR_OWNED isn\'t autoCompact-shaped)', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'gate', type: 'claude', cwd: '/a', intents: ['dm'] });
    // All intents re-checked → collectFormConfig omits intents → same clear
    // semantics as autoCompact, proving the owned-set covers every gated key.
    stores.templates.save({ id: 'gate', name: 'gate', type: 'claude', cwd: '/a' });
    assert.strictEqual('intents' in stores.templates.list()[0], false);
  } finally { cleanup(); }
});

test('templates: list() skips a malformed file', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'good', type: 'claude', cwd: '/a' });
    fs.writeFileSync(tplFile(registryDir, 'bad'), '{ not json ');
    const list = stores.templates.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'good');
  } finally { cleanup(); }
});

test('templates: migration explodes templates.json → per-file, renames the blob once', () => {
  const { userData, registryDir } = freshStores();
  try {
    // Seed a legacy blob (pre-validation names incl. illegal chars + a dup + an
    // empty-slug entry) BEFORE init runs the one-shot migration.
    const blob = [
      { id: 'tpl-1', name: 'Trader Seat', type: 'claude', cwd: '/a' }, // space → slug
      { id: 'tpl-2', name: 'trader seat', type: 'codex', cwd: '/b' },  // dup slug → first-wins skip
      { id: 'tpl-3', name: '!!!', type: 'claude', cwd: '/c' },         // empty slug → dropped
      { id: 'tpl-4', name: 'plain', type: 'claude', cwd: '/d' },
    ];
    const blobPath = path.join(userData, 'templates.json');
    fs.writeFileSync(blobPath, JSON.stringify(blob));
    // Re-init over the SAME dirs so migrateTemplatesJson runs against the blob.
    // No-seed resourcesDir (like freshStores): this test isolates MIGRATION, so the
    // shipped default templates (e.g. clodex-team-reviewer.json, T52) must not seed
    // in and pollute the migrated-name assertion below.
    const stores = initStores(userData, { registryDir, resourcesDir: path.join(registryDir, '__no_seed__') });
    const list = stores.templates.list();
    const names = list.map(t => t.name).sort();
    assert.deepStrictEqual(names, ['plain', 'trader-seat']); // slugified, dup + empty dropped
    // The exploded file strips the synthetic id and is a portable object.
    const onDisk = JSON.parse(fs.readFileSync(tplFile(registryDir, 'trader-seat'), 'utf-8'));
    assert.strictEqual('id' in onDisk, false);
    assert.strictEqual(onDisk.cwd, '/a'); // first-wins: tpl-1, not tpl-2
    // Blob renamed to .migrated (never deleted — dropped entries recoverable).
    assert.strictEqual(fs.existsSync(blobPath), false);
    assert.ok(fs.existsSync(`${blobPath}.migrated`));
    // Second init is a no-op (blob already renamed) — no re-run, no dup. No-seed
    // again so a shipped default template (T52) doesn't inflate the migration count.
    const stores2 = initStores(userData, { registryDir, resourcesDir: path.join(registryDir, '__no_seed__') });
    assert.strictEqual(stores2.templates.list().length, 2);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

// --- seedLibraryDefaults: ship library defaults into ~/.clodex/library --------
// The clodex-team-lead system prompt (and any future shipped default) is copied out of
// the repo `resources/library/` tree into registryDir/library on construction,
// SEED-IF-ABSENT: a file the operator already has is never overwritten. The
// source defaults to __dirname/resources/library (rides app.asar packaged); the
// resourcesDir DI seam lets these tests supply a hermetic source tree.

const REPO_TEAMLEAD = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system', 'clodex-team-lead.md');

test('seed: ships the clodex-team-lead system prompt into a fresh registry (byte-exact)', () => {
  // The DEFAULT source (__dirname/resources/library) is exercised here — no
  // resourcesDir override — so this pins the real shipped tree, not a fixture.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    const stores = initStores(userData, { registryDir });
    const dest = path.join(registryDir, 'library', 'prompts', 'system', 'clodex-team-lead.md');
    assert.ok(fs.existsSync(dest), 'clodex-team-lead.md seeded on construction');
    // Byte-for-byte the shipped copy (the reviewed draft is the source of truth).
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), fs.readFileSync(REPO_TEAMLEAD, 'utf-8'));
    // And it surfaces through the prompt library as a system prompt.
    const seeded = stores.promptLibrary.list().find((p) => p.name === 'clodex-team-lead' && p.kind === 'system');
    assert.ok(seeded, 'seeded prompt is listed as a system prompt');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('seed: never clobbers an operator-edited copy already on disk', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    // Operator has already edited their clodex-team-lead prompt BEFORE this launch.
    const dest = path.join(registryDir, 'library', 'prompts', 'system', 'clodex-team-lead.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'MY EDITED PROMPT');
    initStores(userData, { registryDir }); // runs the seed step
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'MY EDITED PROMPT',
      'operator edit wins over the shipped default (seed-if-absent)');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('seed: walks a nested source tree, seeding absent files and skipping present ones', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-res-'));
  try {
    // A shipped tree with nesting across two library kinds.
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.mkdirSync(path.join(resourcesDir, 'exec'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, 'prompts', 'system', 'lead.md'), 'LEAD');
    fs.writeFileSync(path.join(resourcesDir, 'prompts', 'system', 'worker.md'), 'WORKER');
    fs.writeFileSync(path.join(resourcesDir, 'exec', 'tool.json'), '{"argv":["x"]}');
    // The operator already has one of them, edited.
    const kept = path.join(registryDir, 'library', 'prompts', 'system', 'worker.md');
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    fs.writeFileSync(kept, 'EDITED WORKER');

    initStores(userData, { registryDir, resourcesDir });

    const libRoot = path.join(registryDir, 'library');
    assert.strictEqual(fs.readFileSync(path.join(libRoot, 'prompts', 'system', 'lead.md'), 'utf-8'), 'LEAD', 'absent file seeded');
    assert.strictEqual(fs.readFileSync(path.join(libRoot, 'exec', 'tool.json'), 'utf-8'), '{"argv":["x"]}', 'nested absent file seeded');
    assert.strictEqual(fs.readFileSync(kept, 'utf-8'), 'EDITED WORKER', 'present file left untouched');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test('seed: a missing source tree is a no-op, not a throw', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    // Point at a source that does not exist — construction must still succeed.
    const stores = initStores(userData, { registryDir, resourcesDir: path.join(registryDir, 'no-such-seed') });
    assert.strictEqual(typeof stores.promptLibrary, 'object');
    assert.strictEqual(fs.existsSync(path.join(registryDir, 'library', 'prompts', 'system', 'clodex-team-lead.md')), false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

// --- seedLibraryDefaults: version-stamped reconciliation (v2 GAP) -------------
// A per-file provenance manifest (library/.seed-state.json = { relPath: sha256 of
// the shipped bytes we last wrote }) lets an upgrade overwrite an UNEDITED shipped
// copy, while never clobbering an operator edit. These use a hermetic resourcesDir
// like the seed harness above, plus a helper that stages a pre-existing manifest.
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const seedStatePath = (registryDir) => path.join(registryDir, 'library', '.seed-state.json');
const readSeedState = (registryDir) => JSON.parse(fs.readFileSync(seedStatePath(registryDir), 'utf-8'));

function withSeedDirs(fn) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-res-'));
  try { fn({ userData, registryDir, resourcesDir }); }
  finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
}

// Stage a dest file + a manifest entry claiming we last wrote `stampBytes` for it.
function stageDest(registryDir, rel, destBytes, stampBytes) {
  const dest = path.join(registryDir, 'library', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, destBytes);
  if (stampBytes !== undefined) {
    const statePath = seedStatePath(registryDir);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch {}
    state[rel] = sha256(Buffer.from(stampBytes));
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
}

test('seed reconcile: absent file is seeded and its shipped hash is stamped', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    fs.mkdirSync(path.join(resourcesDir, 'exec'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, 'exec', 'tool.json'), 'SHIPPED');

    initStores(userData, { registryDir, resourcesDir });

    const rel = path.join('exec', 'tool.json');
    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'SHIPPED', 'absent file seeded');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('SHIPPED')), 'shipped hash stamped');
  });
});

test('seed reconcile: present + unedited + newer ship -> overwrites and re-stamps', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'V2');
    // Dest holds V1 and the manifest says we last wrote V1 (unedited since).
    stageDest(registryDir, rel, 'V1', 'V1');

    initStores(userData, { registryDir, resourcesDir });

    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'V2', 'unedited copy upgraded to newer ship');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('V2')), 're-stamped to new hash');
  });
});

test('seed reconcile: present + unedited + same ship -> no-op', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SAME');
    stageDest(registryDir, rel, 'SAME', 'SAME');

    initStores(userData, { registryDir, resourcesDir });

    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'SAME', 'already-current file untouched');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('SAME')), 'stamp unchanged');
  });
});

test('seed reconcile: present + USER-EDITED + newer ship -> preserves the edit', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'V2');
    // Dest was edited (now 'EDITED') but the manifest still stamps the V1 we wrote.
    stageDest(registryDir, rel, 'EDITED', 'V1');

    initStores(userData, { registryDir, resourcesDir });

    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'EDITED', 'operator edit preserved over newer ship');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('V1')), 'stamp left at last-written hash');
  });
});

test('seed reconcile: legacy present-but-unstamped file is adopted, never overwritten', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'V2');
    // Pre-marker install: dest exists, NO manifest entry (stampBytes omitted).
    stageDest(registryDir, rel, 'LEGACY');
    assert.strictEqual(fs.existsSync(seedStatePath(registryDir)), false, 'no manifest before run');

    initStores(userData, { registryDir, resourcesDir });

    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'LEGACY', 'legacy file not overwritten (unprovable pristine)');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('LEGACY')), 'adopted current bytes into manifest');
  });
});

test('seed reconcile: a corrupt .seed-state.json degrades to {} (no throw, legacy-adopt)', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'V2');
    // Dest exists; the manifest is garbage bytes -> must parse to {} -> legacy-adopt.
    const dest = path.join(registryDir, 'library', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'LEGACY');
    fs.writeFileSync(seedStatePath(registryDir), '{ not json at all ]]]');

    assert.doesNotThrow(() => initStores(userData, { registryDir, resourcesDir }));

    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'LEGACY', 'corrupt manifest -> file treated as legacy, not overwritten');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('LEGACY')), 'adopted current bytes despite corrupt prior manifest');
  });
});

test('seed reconcile: two launches self-heal a legacy stale-unedited file', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'V2');
    // Legacy install: stale-unedited V1 on disk, NO manifest entry.
    const dest = path.join(registryDir, 'library', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'V1');

    // First launch: adopt-only, no overwrite (can't prove pristine).
    initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'V1', 'first launch adopts, does not overwrite');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('V1')), 'first launch stamps current bytes');

    // Second launch: same shipped-newer bytes, dest still untouched -> now upgrades.
    initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'V2', 'second launch self-heals to newer ship');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('V2')), 'second launch re-stamps to shipped hash');
  });
});

test('seed reconcile: manifest is not rewritten when nothing changed', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SAME');
    // Present + unedited + same ship -> a full no-op run.
    stageDest(registryDir, rel, 'SAME', 'SAME');

    const statePath = seedStatePath(registryDir);
    const mtimeBefore = fs.statSync(statePath).mtimeMs;

    initStores(userData, { registryDir, resourcesDir });

    assert.strictEqual(fs.statSync(statePath).mtimeMs, mtimeBefore, 'unchanged run leaves the manifest file untouched');
  });
});

// --- T26: all three default team role prompts ship + brief the live protocols
const TEAM_ROLE_PROMPTS = ['clodex-team-lead', 'clodex-team-hand', 'clodex-team-reviewer'];
const REPO_SYSTEM_DIR = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system');

test('seed: ships all three default team role prompts into a fresh registry', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    const stores = initStores(userData, { registryDir });
    for (const name of TEAM_ROLE_PROMPTS) {
      const dest = path.join(registryDir, 'library', 'prompts', 'system', `${name}.md`);
      assert.ok(fs.existsSync(dest), `${name}.md seeded on construction`);
      const seeded = stores.promptLibrary.list().find((p) => p.name === name && p.kind === 'system');
      assert.ok(seeded, `${name} surfaces as a system prompt`);
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('seed: an operator-edited team prompt survives while the other two seed', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    // Operator has hand-installed their own hand prompt before this launch.
    const edited = path.join(registryDir, 'library', 'prompts', 'system', 'clodex-team-hand.md');
    fs.mkdirSync(path.dirname(edited), { recursive: true });
    fs.writeFileSync(edited, 'MY HAND PROMPT');
    initStores(userData, { registryDir });
    assert.strictEqual(fs.readFileSync(edited, 'utf-8'), 'MY HAND PROMPT', 'edited hand prompt preserved');
    // The other two still seed from the shipped tree.
    for (const name of ['clodex-team-lead', 'clodex-team-reviewer']) {
      const dest = path.join(registryDir, 'library', 'prompts', 'system', `${name}.md`);
      assert.ok(fs.existsSync(dest), `${name}.md seeded alongside the preserved edit`);
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('seed: shipped team prompts brief their load-bearing protocol verbs', () => {
  // Cheap content sanity — keeps the seeds honest under future edits. Greps the
  // repo source directly (no seeding needed).
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(lead, /task add/, 'lead prompt briefs the ticket protocol (task add)');
  assert.match(lead, /team-review/, 'lead prompt briefs cold review (team-review)');
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.match(hand, /task done/, 'hand prompt briefs reporting via task done');
  const reviewer = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-reviewer.md'), 'utf-8');
  assert.match(reviewer, /review-done/, 'reviewer prompt briefs the review-done closing intent');
});

// A prompt is a claim on a path no execution passes through: nothing throws when
// it goes stale, and every seat that boots obeys it anyway. These pin the two
// halves of the branch-per-ticket division of labour, which is exactly the kind
// of rule that gets reversed in one file and left contradicted in the other.
test('seed: shipped team prompts agree on who commits, who merges, who pushes', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.doesNotMatch(hand, /Never commit, push/,
    'the hand prompt must not still carry the reversed "never commit" rule');
  assert.match(hand, /Commit to YOUR OWN branch/, 'hand is told to commit to its own branch');
  assert.match(hand, /NEVER push/, 'hand is still barred from pushing');
  assert.match(hand, /Merging your branch is the lead's/, 'hand knows merging is not its job');
  assert.match(lead, /worktree:<branch>/, 'lead prompt names the spawn form that mints the worktree');
  assert.match(lead, /YOU merge, and only after the review verdict/,
    'lead prompt carries the merge-after-review step the hand defers to');
});

// t353: three hands in a row reported by dm and left the ticket open, one of
// them saying it believed closing required an exec grant it lacked. Both wrong
// beliefs are denied in the prompt now, and both denials are pinned by MEANING
// rather than by a `task done` substring — the substring was already there
// through all three incidents. This pins the wording only; whether a cold seat
// READS it is not something a unit test can answer, and the mechanical half of
// the fix (the verb on every dispatch) is pinned in session-manager.test.js.
test('seed: the hand prompt denies both false beliefs about closing a ticket', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.match(hand, /is an INTENT you emit/,
    'the hand is told plainly that task done is an intent, not a command it must be granted');
  assert.match(hand, /not an exec command, it needs no grant/,
    'and the exec-registry confusion is named, since that is the belief a seat actually held');
  assert.match(hand, /A dm carrying your report does NOT close the ticket/,
    'and that reporting by dm leaves the ticket open');
  assert.match(hand, /indistinguishable from the lead's side/,
    'and why nobody catches it: the report arrives complete either way');
});

// The base-commit check is a PAIR: the lead cites the commit, the hand acts on
// the mismatch. Either half alone is inert — a citation nobody checks, or a
// check with nothing to check against.
test('seed: shipped team prompts pair the spec base-commit check', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(hand, /merge-base --is-ancestor/, 'hand is given the check to run');
  assert.match(hand, /Stop and tell the lead/,
    'and told to stop — the failure mode is treating the mismatch as drift and working on');
  assert.match(lead, /Cite the commit your spec was written against/,
    'lead is told to supply the commit the hand checks against');
});

// T52: the reviewer seat DEFINITION now ships as a template (the DATA
// _handleTeamReview consumes), seeded like the role prompts into
// library/templates/. Pin it seeds byte-exact and surfaces through the store.
const REPO_REVIEWER_TPL = path.join(__dirname, '..', 'resources', 'library', 'templates', 'clodex-team-reviewer.json');

test('seed (T52): ships the reviewer template into a fresh registry (byte-exact) and it lists', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    const stores = initStores(userData, { registryDir });
    const dest = path.join(registryDir, 'library', 'templates', 'clodex-team-reviewer.json');
    assert.ok(fs.existsSync(dest), 'clodex-team-reviewer.json seeded on construction');
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), fs.readFileSync(REPO_REVIEWER_TPL, 'utf-8'),
      'byte-for-byte the shipped template (the reviewed default is the source of truth)');
    // Surfaces through the templates store with the lean-reviewer payload intact.
    const seeded = stores.templates.list().find((t) => t.name === 'clodex-team-reviewer');
    assert.ok(seeded, 'seeded reviewer template is listed');
    assert.strictEqual(seeded.systemPromptFile, 'clodex-team-reviewer');
    assert.deepStrictEqual(seeded.intents, []);
    assert.deepStrictEqual(seeded.tools, ['Read', 'Grep', 'Glob']);
    assert.deepStrictEqual(seeded.env, {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', FORCE_PROMPT_CACHING_5M: '1', CLODEX_DISABLE_IPC_PROMPT: '1',
      CLODEX_SPAWNER_HINT: 'off', CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
    });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('workspaces: list seeds a default, upsert/get/setName/sortedByRecent', () => {
  const { stores, cleanup } = freshStores();
  try {
    const seeded = stores.workspaces.list();
    assert.strictEqual(seeded.length, 1);
    assert.strictEqual(seeded[0].id, 'default');
    stores.workspaces.upsert({ id: 'w2', name: 'Second' });
    stores.workspaces.setName('w2', 'Renamed');
    assert.strictEqual(stores.workspaces.get('w2').name, 'Renamed');
    stores.workspaces.touch('w2');
    assert.strictEqual(stores.workspaces.sortedByRecent()[0].id, 'w2');
  } finally { cleanup(); }
});

test('workspaces: setOpen round-trips true, clears to an ABSENT key', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.workspaces.list(); // seed default
    stores.workspaces.upsert({ id: 'w2', name: 'Second' });
    stores.workspaces.setOpen('default', true);
    stores.workspaces.setOpen('w2', true);
    assert.strictEqual(stores.workspaces.get('default').open, true);
    assert.strictEqual(stores.workspaces.get('w2').open, true);
    // Explicit close clears the flag entirely (absent, not false) — the
    // startup filter is a truthiness check and the file stays clean.
    stores.workspaces.setOpen('w2', false);
    assert.ok(!('open' in stores.workspaces.get('w2')));
    assert.strictEqual(stores.workspaces.get('default').open, true);
    // Unknown id is a no-op, not a throw.
    stores.workspaces.setOpen('ghost', true);
  } finally { cleanup(); }
});

// The peer-header fold (t276) rides workspace:setView rather than a store of
// its own, so what this pins is that setView's MERGE is what makes that safe:
// peers-ui writes only `expandedPeers` and renderer.js writes only the sidebar
// keys, and neither may erase the other. A setView that assigned instead of
// merging would lose the folds on the next sidebar filter change.
test('workspaces: setView merges expandedPeers alongside the sidebar view, absence reads as collapsed', () => {
  const { stores, cleanup } = freshStores();
  const { isPeerExpanded } = require('../renderer/lib/peer-collapse');
  try {
    stores.workspaces.list(); // seed default
    stores.workspaces.upsert({ id: 'w2', name: 'Second' });

    // A workspace nobody has folded anything in has no view at all — and every
    // peer in it must read collapsed. This is the defaulting rule the feature
    // rests on, at the persistence layer.
    const fresh = stores.workspaces.get('w2');
    assert.ok(!('view' in fresh) || !fresh.view.expandedPeers);
    assert.strictEqual(isPeerExpanded((fresh.view || {}).expandedPeers, 'peer-a'), false);

    // renderer.js writes the sidebar view; peers-ui writes only its one key.
    stores.workspaces.setView('default', { group: 'project', sort: 'recency' });
    stores.workspaces.setView('default', { expandedPeers: ['peer-a'] });
    assert.deepStrictEqual(stores.workspaces.get('default').view, {
      group: 'project', sort: 'recency', expandedPeers: ['peer-a'],
    });
    // ENTER: the expanded peer really round-tripped — the collapsed assertions
    // in this test are absences and would all hold over an empty view.
    assert.strictEqual(isPeerExpanded(stores.workspaces.get('default').view.expandedPeers, 'peer-a'), true);
    // A peer that appears for the first time in this already-configured
    // workspace is still collapsed.
    assert.strictEqual(isPeerExpanded(stores.workspaces.get('default').view.expandedPeers, 'peer-b'), false);

    // A later sidebar-filter write must not drop the folds.
    stores.workspaces.setView('default', { group: 'none', sort: 'name', status: 'all' });
    assert.deepStrictEqual(stores.workspaces.get('default').view, {
      group: 'none', sort: 'name', status: 'all', expandedPeers: ['peer-a'],
    });

    // Fold state is per-workspace: w2 is untouched by everything above.
    assert.strictEqual(isPeerExpanded(((stores.workspaces.get('w2') || {}).view || {}).expandedPeers, 'peer-a'), false);

    // Collapsing the last expanded peer persists an empty list, which reads the
    // same as never having stored one.
    stores.workspaces.setView('default', { expandedPeers: [] });
    assert.deepStrictEqual(stores.workspaces.get('default').view.expandedPeers, []);
    assert.strictEqual(isPeerExpanded(stores.workspaces.get('default').view.expandedPeers, 'peer-a'), false);

    // Unknown id is a no-op, not a throw.
    stores.workspaces.setView('ghost', { expandedPeers: ['peer-a'] });
  } finally { cleanup(); }
});

test('workspaces: setZoomFactor persists non-1 factors, 1.0 clears to an ABSENT key', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.workspaces.list(); // seed default
    stores.workspaces.setZoomFactor('default', 1.2);
    assert.strictEqual(stores.workspaces.get('default').zoomFactor, 1.2);
    // Reset (factor 1) removes the key — untouched workspaces stay clean.
    stores.workspaces.setZoomFactor('default', 1);
    assert.ok(!('zoomFactor' in stores.workspaces.get('default')));
    // Non-numeric input clears rather than persisting junk.
    stores.workspaces.setZoomFactor('default', 1.5);
    stores.workspaces.setZoomFactor('default', 'junk');
    assert.ok(!('zoomFactor' in stores.workspaces.get('default')));
    // Unknown id is a no-op, not a throw.
    stores.workspaces.setZoomFactor('ghost', 2);
  } finally { cleanup(); }
});

test('promptLibrary: save/list/raw/remove under the registry dir', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.promptLibrary.save('append', 'foo', 'BODY');
    const onDisk = path.join(registryDir, 'library', 'prompts', 'append', 'foo.md');
    assert.strictEqual(fs.readFileSync(onDisk, 'utf8'), 'BODY');
    assert.strictEqual(stores.promptLibrary.raw('append', 'foo'), 'BODY');
    assert.deepStrictEqual(stores.promptLibrary.list().map(p => p.name), ['foo']);
    assert.throws(() => stores.promptLibrary.save('bogus', 'x', 'y'), /invalid prompt kind/);
    assert.throws(() => stores.promptLibrary.save('append', 'bad name', 'y'), /invalid prompt name/);
    stores.promptLibrary.remove('append', 'foo');
    assert.deepStrictEqual(stores.promptLibrary.list(), []);
  } finally { cleanup(); }
});

test('prompts.json migration runs once during construction', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    fs.writeFileSync(path.join(userData, 'prompts.json'),
      JSON.stringify([{ id: '1', title: 'My Prompt', body: 'HELLO' }]));
    const stores = initStores(userData, { registryDir });
    const migrated = stores.promptLibrary.list().find(p => p.kind === 'append');
    assert.ok(migrated, 'legacy prompt migrated to an append file');
    assert.strictEqual(migrated.body, 'HELLO');
    // the legacy file is renamed aside so it never re-runs
    assert.ok(fs.existsSync(path.join(userData, 'prompts.json.migrated')));
    assert.ok(!fs.existsSync(path.join(userData, 'prompts.json')));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('agentDefaults: strip get/set and the deny-floor tri-state', () => {
  const { stores, cleanup } = freshStores();
  try {
    const d = stores.agentDefaults;
    assert.strictEqual(d.getStrip('x'), 0);
    d.setStrip('x', 2);
    assert.strictEqual(d.getStrip('x'), 2);
    d.setStrip('x', 0); // clears
    assert.strictEqual(d.getStrip('x'), 0);
    // absent key -> the shipped floor; explicit [] -> deny nothing (not the floor)
    assert.ok(d.getDefaultDeny().length > 0, 'floor applied when unset');
    d.setDefaultDeny([]);
    assert.deepStrictEqual(d.getDefaultDeny(), []);
    d.setDefaultDeny(['Bash', 'NotNADFakeTool', 'Read']); // unknown filtered out
    assert.deepStrictEqual(d.getDefaultDeny().sort(), ['Bash', 'Read']);
  } finally { cleanup(); }
});

test('agentLibrary: save/list/raw/remove, name regex enforced', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.agentLibrary.save('helper', '---\ndescription: A helper\nmodel: opus\n---\nbody');
    const onDisk = path.join(registryDir, 'agents', 'helper.md');
    assert.ok(fs.existsSync(onDisk));
    const list = stores.agentLibrary.list();
    assert.strictEqual(list[0].name, 'helper');
    assert.strictEqual(list[0].description, 'A helper');
    assert.ok(stores.agentLibrary.raw('helper').includes('body'));
    assert.throws(() => stores.agentLibrary.save('bad name', 'x'), /invalid agent name/);
    stores.agentLibrary.remove('helper');
    assert.deepStrictEqual(stores.agentLibrary.list(), []);
  } finally { cleanup(); }
});

test('skillLibrary: save/list/remove', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.skillLibrary.save('warm', '---\nname: warm\ndescription: Warm cache\n---\ndo it');
    const list = stores.skillLibrary.list();
    assert.strictEqual(list[0].name, 'warm');
    assert.strictEqual(list[0].description, 'Warm cache');
    stores.skillLibrary.remove('warm');
    assert.deepStrictEqual(stores.skillLibrary.list(), []);
  } finally { cleanup(); }
});

// --- scope: listFor filters offers by workspace/sessions frontmatter ---------
test('agentLibrary.listFor: scope frontmatter filters the offer list; list() unchanged', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.agentLibrary.save('global', '---\ndescription: everyone\n---\nb');
    stores.agentLibrary.save('crypto', '---\ndescription: coins\nsessions: trader, stocks\n---\nb');
    stores.agentLibrary.save('deskonly', '---\ndescription: ws\nworkspace: trading\n---\nb');
    // list() shows all three (the drawer view).
    assert.deepStrictEqual(stores.agentLibrary.list().map((a) => a.name).sort(),
      ['crypto', 'deskonly', 'global']);
    // A session named 'trader' in the 'default' workspace: global + its personal.
    assert.deepStrictEqual(
      stores.agentLibrary.listFor({ session: 'trader', workspace: 'default' }).map((a) => a.name).sort(),
      ['crypto', 'global']);
    // In the 'trading' workspace, the workspace-scoped one is offered too.
    assert.deepStrictEqual(
      stores.agentLibrary.listFor({ session: 'clodex', workspace: 'trading' }).map((a) => a.name).sort(),
      ['deskonly', 'global']);
    // An unrelated session/workspace sees only globals.
    assert.deepStrictEqual(
      stores.agentLibrary.listFor({ session: 'clodex', workspace: 'default' }).map((a) => a.name),
      ['global']);
  } finally { cleanup(); }
});

test('skillLibrary.listFor: scope parsed from content; list() shape unchanged', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.skillLibrary.save('warm', '---\nname: warm\ndescription: global\n---\ndo');
    stores.skillLibrary.save('coin', '---\nname: coin\ndescription: crypto\nsessions: stocks\n---\ndo');
    // list() carries no meta field (wire shape preserved) — just the four keys.
    assert.deepStrictEqual(Object.keys(stores.skillLibrary.list()[0]).sort(),
      ['content', 'description', 'file', 'name']);
    assert.deepStrictEqual(
      stores.skillLibrary.listFor({ session: 'stocks', workspace: 'default' }).map((s) => s.name).sort(),
      ['coin', 'warm']);
    assert.deepStrictEqual(
      stores.skillLibrary.listFor({ session: 'other', workspace: 'default' }).map((s) => s.name),
      ['warm']);
  } finally { cleanup(); }
});

// --- renameWorkspaceScope: rewrite workspace: lines across both libraries -----
test('renameWorkspaceScope: rewrites matching workspace lines, counts, preserves the rest', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.agentLibrary.save('a1', '---\ndescription: d\nworkspace: trading\ntools: Bash\n---\nagent body');
    stores.skillLibrary.save('s1', '---\nname: s1\ndescription: d\nworkspace: trading\n---\nskill body');
    stores.agentLibrary.save('a2', '---\ndescription: d\nworkspace: other\n---\nbody');   // not renamed
    stores.agentLibrary.save('a3', '---\ndescription: d\n---\nglobal body');              // no scope

    const n = stores.renameWorkspaceScope('trading', 'Markets');
    assert.strictEqual(n, 2, 'two files rewritten (a1 + s1)');

    const a1 = fs.readFileSync(path.join(registryDir, 'agents', 'a1.md'), 'utf-8');
    assert.match(a1, /workspace: Markets/);
    assert.ok(a1.includes('tools: Bash'), 'other frontmatter keys preserved');
    assert.ok(a1.includes('agent body'), 'body preserved');
    const s1 = fs.readFileSync(path.join(registryDir, 'skills', 's1.md'), 'utf-8');
    assert.match(s1, /workspace: Markets/);
    assert.ok(s1.includes('skill body'));
    // The non-matching + unscoped files are untouched.
    assert.match(fs.readFileSync(path.join(registryDir, 'agents', 'a2.md'), 'utf-8'), /workspace: other/);
    assert.ok(!fs.readFileSync(path.join(registryDir, 'agents', 'a3.md'), 'utf-8').includes('workspace:'));

    // Idempotent / no-op cases.
    assert.strictEqual(stores.renameWorkspaceScope('trading', 'Markets'), 0, 'old name already gone');
    assert.strictEqual(stores.renameWorkspaceScope('Markets', 'Markets'), 0, 'unchanged name');
    assert.strictEqual(stores.renameWorkspaceScope('', 'X'), 0, 'blank old name');
  } finally { cleanup(); }
});

test('uiSettings: missing file -> defaults, set round-trips + validates', () => {
  const { stores, cleanup } = freshStores();
  try {
    const def = stores.uiSettings.get();
    assert.strictEqual(def.theme, 'midnight');
    assert.strictEqual(def.proxyEnabled, true);
    const next = stores.uiSettings.set({ theme: 'light', proxyUrl: 'http://x:1' });
    assert.strictEqual(next.theme, 'light');
    assert.strictEqual(next.proxyUrl, 'http://x:1');
    // reload from disk keeps it
    assert.strictEqual(stores.uiSettings.get().theme, 'light');
    // an invalid theme is rejected, keeping the current value
    assert.strictEqual(stores.uiSettings.set({ theme: 'neon' }).theme, 'light');
  } finally { cleanup(); }
});

test('uiSettings: lastCustomProxyUrl defaults empty, round-trips, and is decoupled from proxyUrl', () => {
  const { stores, cleanup } = freshStores();
  try {
    // Default is empty (never-set), separate from the 7800 global proxy default.
    const def = stores.uiSettings.get();
    assert.strictEqual(def.lastCustomProxyUrl, '');
    assert.strictEqual(def.proxyUrl, 'http://127.0.0.1:7800');
    // Writing the remembered custom URL must NOT touch the global proxyUrl — the
    // whole point of the decoupling (a custom New Session no longer clobbers the
    // global default that feeds ANTHROPIC_BASE_URL / gates the wirescope).
    const next = stores.uiSettings.set({ lastCustomProxyUrl: 'http://127.0.0.1:7802' });
    assert.strictEqual(next.lastCustomProxyUrl, 'http://127.0.0.1:7802');
    assert.strictEqual(next.proxyUrl, 'http://127.0.0.1:7800', 'proxyUrl untouched by a lastCustomProxyUrl write');
    // Survives an unrelated merge (spread-merge keeps the field), and reloads.
    const after = stores.uiSettings.set({ theme: 'light' });
    assert.strictEqual(after.lastCustomProxyUrl, 'http://127.0.0.1:7802', 'survives an unrelated upsert');
    assert.strictEqual(stores.uiSettings.get().lastCustomProxyUrl, 'http://127.0.0.1:7802', 'reloads from disk');
    // A non-string value is rejected by the load sanitizer (falls back to default).
    stores.uiSettings.set({ lastCustomProxyUrl: 42 });
    assert.strictEqual(stores.uiSettings.get().lastCustomProxyUrl, '', 'non-string sanitized to the empty default');
  } finally { cleanup(); }
});

test('uiSettings: peers are sanitized (junk dropped, empty-visible kept)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const next = stores.uiSettings.set({
      peers: [
        { id: 'ok', sshHost: 'user@box' },
        { id: 'nourl' },                       // no url/sshHost -> dropped
        { id: 'weburl', url: 'https://h:7900' },
      ],
      peerVisible: { ok: [] },                 // empty kept ("show none")
      peerAttached: { ok: [] },                // empty dropped
    });
    assert.deepStrictEqual(next.peers.map(p => p.id), ['ok', 'weburl']);
    assert.deepStrictEqual(next.peerVisible, { ok: [] });
    assert.deepStrictEqual(next.peerAttached, {});
  } finally { cleanup(); }
});

test('uiSettings: peer disabled flag round-trips (strict true only)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const next = stores.uiSettings.set({
      peers: [
        { id: 'paused', sshHost: 'user@box', disabled: true },   // preserved
        { id: 'live', sshHost: 'user@box2' },                    // key absent
        { id: 'truthy', sshHost: 'user@box3', disabled: 'yes' }, // dropped
        { id: 'one', sshHost: 'user@box4', disabled: 1 },        // dropped
      ],
    });
    const by = Object.fromEntries(next.peers.map(p => [p.id, p]));
    assert.strictEqual(by.paused.disabled, true);
    assert.ok(!('disabled' in by.live), 'enabled peer has no disabled key (never false)');
    assert.ok(!('disabled' in by.truthy), 'truthy-not-true disabled dropped');
    assert.ok(!('disabled' in by.one), 'numeric truthy disabled dropped');
    // The shipped bug was strip-on-write: assert the flag survives the actual
    // disk roundtrip (get() re-loads + re-sanitizes), not just set()'s return.
    const reread = Object.fromEntries(stores.uiSettings.get().peers.map(p => [p.id, p]));
    assert.strictEqual(reread.paused.disabled, true);
    assert.ok(!('disabled' in reread.live), 'absence survives the disk roundtrip');
  } finally { cleanup(); }
});

// --- peer ssm transport (t32 step 1) ---------------------------------------
//
// The whitelist pin. sanitizePeers rebuilds every entry field by field, so a
// sub-key missing from the reconstruction is dropped on EVERY write — that is
// how `mounts` vanished from the sandbox config. These assert the disk
// round-trip (get() re-loads and re-sanitizes), not just set()'s return value,
// because strip-on-write is invisible to the return.

test('uiSettings: a full peer ssm block survives the disk round-trip (whitelist pin)', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.uiSettings.set({
      peers: [{ id: 'aws', label: 'prod', ssm: { target: 'i-0abc123', region: 'eu-west-1', profile: 'prod-admin' } }],
    });
    const p = stores.uiSettings.get().peers.find((x) => x.id === 'aws');
    assert.ok(p, 'an ssm peer with no url and no sshHost is admitted');
    // Every field named individually: a deepStrictEqual alone would still pass
    // if BOTH the write and this test forgot the same key.
    assert.strictEqual(p.ssm.target, 'i-0abc123', 'target survives the write');
    assert.strictEqual(p.ssm.region, 'eu-west-1', 'region survives the write');
    assert.strictEqual(p.ssm.profile, 'prod-admin', 'profile survives the write');
    assert.deepStrictEqual(Object.keys(p.ssm).sort(), ['profile', 'region', 'target'],
      'no extra keys, and none silently dropped');
    assert.strictEqual(p.url, null);
    assert.strictEqual(p.sshHost, null);
  } finally { cleanup(); }
});

test('uiSettings: optional ssm fields stay ABSENT when unset (ssmArgv tests presence)', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.uiSettings.set({ peers: [{ id: 'bare', ssm: { target: 'i-0bare' } }] });
    const p = stores.uiSettings.get().peers.find((x) => x.id === 'bare');
    // Not `region: null` — ssmArgv emits --region only when the key is truthy,
    // and a null would read the same, but the record shape is what the CLI's
    // validator and any future import path compare against.
    assert.ok(!('region' in p.ssm), 'unset region is absent, not null');
    assert.ok(!('profile' in p.ssm), 'unset profile is absent, not null');
    assert.strictEqual(p.ssm.target, 'i-0bare');
  } finally { cleanup(); }
});

test('uiSettings: malformed / not-yet-supported ssm blocks are dropped whole', () => {
  const { stores, cleanup } = freshStores();
  try {
    const next = stores.uiSettings.set({
      peers: [
        { id: 'ecs', ssm: { ecs: 'my-cluster/my-family' } },   // step 3, not yet dialable
        { id: 'blank', ssm: { target: '   ' } },               // whitespace target
        { id: 'notobj', ssm: 'i-0abc' },                       // string, not an object
        { id: 'arr', ssm: ['aws', 'ssm'] },                    // an argv-shaped thing
        { id: 'keep', ssm: { target: 'i-0keep' } },            // the control
      ],
    });
    assert.deepStrictEqual(next.peers.map((p) => p.id), ['keep'],
      'a peer whose only transport is an unusable ssm block is not admitted');
  } finally { cleanup(); }
});

test('uiSettings: an ssm peer never persists a tunnel argv (DATA-only rule)', () => {
  const { stores, cleanup } = freshStores();
  try {
    // The ruling: the five typed cloud kinds are DATA and may be persisted; a
    // raw argv is CODE and must never become a peer-record field. This store is
    // written from the renderer, so a persisted argv would be a GUI-editable
    // command line the app later executes.
    stores.uiSettings.set({
      peers: [{ id: 'aws', ssm: { target: 'i-0abc' }, tunnel: ['aws', 'ssm', 'start-session', '--target', 'i-evil'] }],
    });
    const p = stores.uiSettings.get().peers.find((x) => x.id === 'aws');
    assert.ok(!('tunnel' in p), 'a tunnel argv is not a peer-record field');
  } finally { cleanup(); }
});

test('uiSettings: kubectl and gcloud blocks round-trip every field (whitelist pin)', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.uiSettings.set({
      peers: [
        { id: 'k', kubectl: { target: 'svc/clodex', namespace: 'prod', context: 'eks-1' } },
        { id: 'g', gcloud: { instance: 'clodex-box', zone: 'us-central1-a', project: 'proj-1' } },
      ],
    });
    const by = Object.fromEntries(stores.uiSettings.get().peers.map((p) => [p.id, p]));
    // Named field by field: a deepStrictEqual alone would still pass if BOTH
    // the write and this test forgot the same key.
    assert.strictEqual(by.k.kubectl.target, 'svc/clodex');
    assert.strictEqual(by.k.kubectl.namespace, 'prod', 'namespace survives the write');
    assert.strictEqual(by.k.kubectl.context, 'eks-1', 'context survives the write');
    assert.strictEqual(by.g.gcloud.instance, 'clodex-box');
    assert.strictEqual(by.g.gcloud.zone, 'us-central1-a', 'zone survives the write');
    assert.strictEqual(by.g.gcloud.project, 'proj-1', 'project survives the write');
  } finally { cleanup(); }
});

test('uiSettings: an az block round-trips — reachable ONLY here (no dest syntax)', () => {
  const { stores, cleanup } = freshStores();
  try {
    // az has no prefix in the Peers dialog (three required values, one a
    // slash-bearing resource id), so it arrives by import or a hand-edited
    // settings file. The store accepts it now so step 4's import is purely an
    // import mechanism — which makes this test its only reachable path today.
    const target = '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1';
    stores.uiSettings.set({ peers: [{ id: 'a', az: { bastion: 'bast-1', resourceGroup: 'rg', target } }] });
    const p = stores.uiSettings.get().peers.find((x) => x.id === 'a');
    assert.ok(p, 'an az peer with no url and no sshHost is admitted');
    assert.strictEqual(p.az.bastion, 'bast-1');
    assert.strictEqual(p.az.resourceGroup, 'rg');
    assert.strictEqual(p.az.target, target, 'the full resource id survives, slashes and all');
  } finally { cleanup(); }
});

test('uiSettings: az needs ALL THREE fields — a partial block is dropped', () => {
  const { stores, cleanup } = freshStores();
  try {
    const next = stores.uiSettings.set({
      peers: [
        { id: 'nobastion', az: { resourceGroup: 'rg', target: '/subs/x' } },
        { id: 'nogroup', az: { bastion: 'b', target: '/subs/x' } },
        { id: 'notarget', az: { bastion: 'b', resourceGroup: 'rg' } },
        { id: 'full', az: { bastion: 'b', resourceGroup: 'rg', target: '/subs/x' } },
      ],
    });
    assert.deepStrictEqual(next.peers.map((p) => p.id), ['full'],
      'a half-configured az block cannot dial, so it is not admitted');
  } finally { cleanup(); }
});

test('uiSettings: two cloud blocks on one peer drops BOTH (no independent winner)', () => {
  const { stores, cleanup } = freshStores();
  try {
    // Downstream readers — tunnel, wiring, dialog — would each pick a winner on
    // their own, which is how two halves of the app end up dialling different
    // boxes. Dropping is worse for one record and far better for the system,
    // and it matches this store's existing drop-junk stance.
    const next = stores.uiSettings.set({
      peers: [
        { id: 'both', ssm: { target: 'i-0abc' }, kubectl: { target: 'svc/x' } },
        { id: 'one', ssm: { target: 'i-0keep' } },
      ],
    });
    assert.deepStrictEqual(next.peers.map((p) => p.id), ['one']);
  } finally { cleanup(); }
});

test('the CLI keeps its per-kind validators PRIVATE — validateEntry is the only door', () => {
  // stores.js validates a peer's ssm block through validateEntry so the GUI and
  // the CLI cannot drift into two ideas of a valid transport. Widening this
  // module's surface to serve a second consumer is how a leaf stops being a
  // leaf, so the export list is pinned: if someone exports validateSsm to make
  // a call site tidier, they argue with this test first.
  const contexts = require('../cli/src/contexts');
  assert.deepStrictEqual(Object.keys(contexts).sort(),
    ['cliDir', 'contextsPath', 'load', 'resolve', 'save', 'validateEntry']);
  // And the door actually enforces the rule stores.js relies on.
  assert.throws(() => contexts.validateEntry({ ssm: { target: 'i-0a', ecs: 'c/f' } }),
    /exactly one of/, 'validateEntry rejects target+ecs together');
  assert.throws(() => contexts.validateEntry({ ssm: {} }), /ssm needs one of/);
});

// --- execLibrary — the exec-command registry (string twin of agentLibrary) ---

const execFile = (registryDir, name) =>
  path.join(registryDir, 'library', 'exec', `${name}.json`);

test('execLibrary: missing dir -> [], save/raw/list/remove round-trip', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    assert.deepStrictEqual(stores.execLibrary.list(), []); // dir absent
    const body = JSON.stringify({ argv: ['python3', 'w.py', '/inbox'], cwd: '/x', schema: { type: 'object' } }, null, 2);
    stores.execLibrary.save('bridge-reply', body);
    assert.ok(fs.existsSync(execFile(registryDir, 'bridge-reply')));
    // raw() returns the exact stored string (format-agnostic I/O).
    assert.strictEqual(stores.execLibrary.raw('bridge-reply'), body);
    // list() parses a summary row (name + argv + cwd), sorted by name.
    const list = stores.execLibrary.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'bridge-reply');
    assert.deepStrictEqual(list[0].argv, ['python3', 'w.py', '/inbox']);
    assert.strictEqual(list[0].cwd, '/x');
    stores.execLibrary.remove('bridge-reply');
    assert.strictEqual(fs.existsSync(execFile(registryDir, 'bridge-reply')), false);
    assert.deepStrictEqual(stores.execLibrary.list(), []);
  } finally { cleanup(); }
});

test('execLibrary: list sorts by name and skips a malformed file', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.execLibrary.save('zebra', JSON.stringify({ argv: ['z'], schema: { type: 'object' } }));
    stores.execLibrary.save('alpha', JSON.stringify({ argv: ['a'], schema: { type: 'object' } }));
    // A hand-mangled file must not break the drawer — it's silently skipped.
    fs.writeFileSync(execFile(registryDir, 'broken'), '{ not json ');
    const names = stores.execLibrary.list().map(c => c.name);
    assert.deepStrictEqual(names, ['alpha', 'zebra']);
  } finally { cleanup(); }
});

test('execLibrary: raw() of an absent command is null; save rejects a bad name', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.strictEqual(stores.execLibrary.raw('nope'), null);
    assert.throws(() => stores.execLibrary.save('bad/name', '{}'), /invalid exec command name/);
  } finally { cleanup(); }
});

test('execLibrary: is exported as a store from initStores', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.strictEqual(typeof stores.execLibrary, 'object');
    assert.strictEqual(typeof stores.execLibrary.list, 'function');
  } finally { cleanup(); }
});

// --- reminders (ninth store) -----------------------------------------------

test('reminders: missing file -> [], add mints an id + createdAt, list round-trips', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.deepStrictEqual(stores.reminders.list(), []);
    assert.deepStrictEqual(stores.reminders.listForAgent('t1'), []);
    const rec = stores.reminders.add({ agent: 't1', kind: 'every', spec: 'every 30m', body: 'check build', nextFireAt: 1000 });
    assert.match(rec.id, /^[a-z0-9]+$/); // pure base36 so `cancel <id>` satisfies ID_RE
    assert.strictEqual(rec.agent, 't1');
    assert.strictEqual(rec.kind, 'every');
    assert.strictEqual(rec.spec, 'every 30m');
    assert.strictEqual(rec.body, 'check build');
    assert.strictEqual(rec.nextFireAt, 1000);
    assert.strictEqual(typeof rec.createdAt, 'number');
    assert.strictEqual(rec.lastFiredAt, null);
    // Persisted to disk: _load re-reads the file on every list(), so this
    // reflects the saved bytes, not in-memory state.
    assert.deepStrictEqual(stores.reminders.list().map(r => r.id), [rec.id]);
  } finally { cleanup(); }
});

test('reminders: listForAgent filters by agent', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.reminders.add({ agent: 't1', kind: 'in', spec: 'in 1h', body: 'a' });
    stores.reminders.add({ agent: 't2', kind: 'in', spec: 'in 2h', body: 'b' });
    stores.reminders.add({ agent: 't1', kind: 'oncompact', spec: 'on compact', body: 'c' });
    assert.deepStrictEqual(stores.reminders.listForAgent('t1').map(r => r.body).sort(), ['a', 'c']);
    assert.deepStrictEqual(stores.reminders.listForAgent('t2').map(r => r.body), ['b']);
    assert.deepStrictEqual(stores.reminders.listForAgent('nobody'), []);
  } finally { cleanup(); }
});

test('reminders: add defaults body="" and nextFireAt=null (oncompact/event kinds)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const rec = stores.reminders.add({ agent: 't1', kind: 'oncompact', spec: 'on compact' });
    assert.strictEqual(rec.body, '');
    assert.strictEqual(rec.nextFireAt, null);
  } finally { cleanup(); }
});

test('reminders: remove returns true when present, false for an unknown id', () => {
  const { stores, cleanup } = freshStores();
  try {
    const rec = stores.reminders.add({ agent: 't1', kind: 'in', spec: 'in 1h', body: 'x' });
    assert.strictEqual(stores.reminders.remove('nope'), false); // unknown -> loud bounce upstream
    assert.strictEqual(stores.reminders.remove(rec.id), true);  // known -> silent success upstream
    assert.deepStrictEqual(stores.reminders.list(), []);
  } finally { cleanup(); }
});

test('reminders: markFired stamps lastFiredAt + recomputed nextFireAt; no-op on a gone id', () => {
  const { stores, cleanup } = freshStores();
  try {
    const rec = stores.reminders.add({ agent: 't1', kind: 'every', spec: 'every 30m', body: 'x', nextFireAt: 1000 });
    assert.strictEqual(stores.reminders.markFired(rec.id, 5000, 6800), true);
    const after = stores.reminders.get(rec.id);
    assert.strictEqual(after.lastFiredAt, 5000);
    assert.strictEqual(after.nextFireAt, 6800);
    // A spent one-shot: nextFireAt cleared to null.
    stores.reminders.markFired(rec.id, 9000, null);
    assert.strictEqual(stores.reminders.get(rec.id).nextFireAt, null);
    // Gone id -> false, no throw.
    assert.strictEqual(stores.reminders.markFired('gone', 1, 2), false);
  } finally { cleanup(); }
});

test('reminders: ids are unique across many adds', () => {
  const { stores, cleanup } = freshStores();
  try {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(stores.reminders.add({ agent: 't1', kind: 'in', spec: 'in 1h', body: String(i) }).id);
    assert.strictEqual(ids.size, 200);
  } finally { cleanup(); }
});

test('reminders: is exported as a store from initStores', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.strictEqual(typeof stores.reminders, 'object');
    assert.strictEqual(typeof stores.reminders.add, 'function');
    assert.strictEqual(typeof stores.reminders.markFired, 'function');
  } finally { cleanup(); }
});

// --- notifications (tenth store) -------------------------------------------

test('notifications: missing file -> [], add mints id + createdAt, readAt=null, list round-trips', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.deepStrictEqual(stores.notifications.list(), []);
    assert.strictEqual(stores.notifications.unreadCount(), 0);
    const rec = stores.notifications.add({ from: 'agent-a', workspaceId: 'ws-1', body: 'blocked on a decision' });
    assert.match(rec.id, /^[a-z0-9]+$/);
    assert.strictEqual(rec.from, 'agent-a');
    assert.strictEqual(rec.workspaceId, 'ws-1');
    assert.strictEqual(rec.body, 'blocked on a decision');
    assert.strictEqual(typeof rec.createdAt, 'number');
    assert.strictEqual(rec.readAt, null);
    // _load re-reads the file, so this reflects saved bytes.
    assert.deepStrictEqual(stores.notifications.list().map(n => n.id), [rec.id]);
    assert.strictEqual(stores.notifications.unreadCount(), 1);
  } finally { cleanup(); }
});

test('notifications: list is chronological (append order = createdAt order)', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.notifications.add({ from: 'a', workspaceId: 'w', body: 'first' });
    stores.notifications.add({ from: 'b', workspaceId: 'w', body: 'second' });
    stores.notifications.add({ from: 'c', workspaceId: 'w', body: 'third' });
    assert.deepStrictEqual(stores.notifications.list().map(n => n.body), ['first', 'second', 'third']);
  } finally { cleanup(); }
});

test('notifications: add defaults workspaceId=null and body=""; coerces given ids to string', () => {
  const { stores, cleanup } = freshStores();
  try {
    const bare = stores.notifications.add({ from: 'a' });
    assert.strictEqual(bare.workspaceId, null);
    assert.strictEqual(bare.body, '');
    const coerced = stores.notifications.add({ from: 'a', workspaceId: 42, body: 'x' });
    assert.strictEqual(coerced.workspaceId, '42');
  } finally { cleanup(); }
});

test('notifications: markRead flips readAt, is idempotent, returns false for unknown id', () => {
  const { stores, cleanup } = freshStores();
  try {
    const rec = stores.notifications.add({ from: 'a', workspaceId: 'w', body: 'x' });
    assert.strictEqual(stores.notifications.markRead('nope'), false);
    assert.strictEqual(stores.notifications.markRead(rec.id), true);
    const readAt = stores.notifications.list()[0].readAt;
    assert.strictEqual(typeof readAt, 'number');
    assert.strictEqual(stores.notifications.unreadCount(), 0);
    // Idempotent: already-read still returns true, keeps the original stamp.
    assert.strictEqual(stores.notifications.markRead(rec.id), true);
    assert.strictEqual(stores.notifications.list()[0].readAt, readAt);
  } finally { cleanup(); }
});

test('notifications: markAllRead stamps every unread and returns the count flipped', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.notifications.add({ from: 'a', workspaceId: 'w', body: '1' });
    const mid = stores.notifications.add({ from: 'b', workspaceId: 'w', body: '2' });
    stores.notifications.add({ from: 'c', workspaceId: 'w', body: '3' });
    stores.notifications.markRead(mid.id); // one already read
    assert.strictEqual(stores.notifications.unreadCount(), 2);
    assert.strictEqual(stores.notifications.markAllRead(), 2); // only the two unread flip
    assert.strictEqual(stores.notifications.unreadCount(), 0);
    assert.strictEqual(stores.notifications.markAllRead(), 0); // nothing left to flip
  } finally { cleanup(); }
});

test('notifications: remove returns true when present, false for an unknown id', () => {
  const { stores, cleanup } = freshStores();
  try {
    const rec = stores.notifications.add({ from: 'a', workspaceId: 'w', body: 'x' });
    assert.strictEqual(stores.notifications.remove('nope'), false);
    assert.strictEqual(stores.notifications.remove(rec.id), true);
    assert.deepStrictEqual(stores.notifications.list(), []);
  } finally { cleanup(); }
});

test('notifications: ids are unique across many adds', () => {
  const { stores, cleanup } = freshStores();
  try {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(stores.notifications.add({ from: 'a', workspaceId: 'w', body: String(i) }).id);
    assert.strictEqual(ids.size, 200);
  } finally { cleanup(); }
});

test('notifications: is exported as a store from initStores', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.strictEqual(typeof stores.notifications, 'object');
    assert.strictEqual(typeof stores.notifications.add, 'function');
    assert.strictEqual(typeof stores.notifications.markAllRead, 'function');
    assert.strictEqual(typeof stores.notifications.unreadCount, 'function');
  } finally { cleanup(); }
});

// ── boxes registry (M6b P2: N instances, one shape, no top-level sandbox key) ─

test('uiSettings: boxes defaults to one seed box on a fresh install (no top-level sandbox key)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const s = stores.uiSettings.get();
    assert.strictEqual('sandbox' in s, false, 'no vestigial top-level sandbox key');
    assert.strictEqual(s.boxes.length, 1);
    assert.strictEqual(s.boxes[0].id, 'sandbox');
    assert.strictEqual(s.boxes[0].label, 'sandbox');
    assert.deepStrictEqual(s.boxes[0].config, {
      workDir: null, webPort: 7810, wirescopePort: 7811, wirePort: 7820,
      autoStart: false, image: null, mounts: [],
    });
  } finally { cleanup(); }
});

test('uiSettings: a pre-M6b file (sandbox key, no boxes) is ignored — no migration, just the seed', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  try {
    // 0600 like a real settings file: this fixture is written by the test rather
    // than by atomicWriteFileSync, and a 0644 one would (correctly) trip the
    // token-mode warning and print noise unrelated to what this test checks.
    fs.writeFileSync(path.join(userData, 'ui-settings.json'), JSON.stringify({
      sandbox: { workDir: '/Users/me/w', webPort: 7999, autoStart: true, mounts: [{ host: '/m', ro: true }] },
    }), { mode: 0o600 });
    const stores = initStores(userData, { log: console, registryDir });
    const s = stores.uiSettings.get();
    assert.strictEqual('sandbox' in s, false, 'legacy key is not carried forward');
    // Missing boxes key → the fresh default seed, NOT the legacy sandbox config.
    assert.strictEqual(s.boxes.length, 1);
    assert.strictEqual(s.boxes[0].id, 'sandbox');
    assert.strictEqual(s.boxes[0].config.workDir, null);
    assert.strictEqual(s.boxes[0].config.webPort, 7810);
    assert.strictEqual(s.boxes[0].config.autoStart, false);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('uiSettings: a multi-box registry round-trips each box config verbatim', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ boxes: [
      { id: 'sandbox', label: 'sandbox', config: {} },
      { id: 'proj', label: 'My Project', config: {
        workDir: '/Users/me/work', webPort: 7830, wirescopePort: 7831,
        wirePort: 7840, autoStart: true, image: 'my/img:tag',
        mounts: [{ host: '/Users/me/ref', ro: true, container: '/home/clodex/ref' }],
      } },
    ] });
    const boxes = Object.fromEntries(uiSettings.get().boxes.map((b) => [b.id, b]));
    assert.strictEqual(boxes.proj.label, 'My Project');
    assert.deepStrictEqual(boxes.proj.config, {
      workDir: '/Users/me/work', webPort: 7830, wirescopePort: 7831,
      wirePort: 7840, autoStart: true, image: 'my/img:tag',
      mounts: [{ host: '/Users/me/ref', ro: true, container: '/home/clodex/ref' }],
    });
    // The shared box's blank config fills to DEFAULT_SANDBOX_CONFIG.
    assert.deepStrictEqual(boxes.sandbox.config, {
      workDir: null, webPort: 7810, wirescopePort: 7811, wirePort: 7820,
      autoStart: false, image: null, mounts: [],
    });
  } finally { cleanup(); }
});

test('uiSettings: deleting every box persists an empty list (never re-seeded)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ boxes: [] });
    // A present-but-empty boxes array is preserved across a fresh load — the seed
    // only fills a MISSING key, not a deliberately emptied one.
    assert.deepStrictEqual(uiSettings.get().boxes, []);
  } finally { cleanup(); }
});

// M6b P2: the box-id charset is enforced UNIFORMLY (no loose-id admittance) — a
// row whose id has dots/uppercase/spaces is DROPPED, so it can never collide two
// boxes onto one docker-compose project.
test('uiSettings: boxes sanitizer drops bad-charset ids, non-objects, and dedups', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ boxes: [
      { id: 'sandbox', label: 'sandbox', config: {} },
      { id: 'Bad.Id', label: 'x', config: {} },     // uppercase + dot → dropped
      { id: 'has space', label: 'y', config: {} },   // space → dropped
      { id: 'proj', label: 'first', config: {} },
      { id: 'proj', label: 'second', config: {} },   // duplicate id → dropped
      { id: 'host', label: 'z', config: {} },         // reserved (placement) → dropped (M6b P3)
      'not an object',
    ] });
    const ids = uiSettings.get().boxes.map((b) => b.id);
    assert.deepStrictEqual(ids, ['sandbox', 'proj']);
    assert.strictEqual(uiSettings.get().boxes.find((b) => b.id === 'proj').label, 'first');
  } finally { cleanup(); }
});

// M6a regression, re-homed onto box config: mounts is a whitelist-store key — it
// shipped without a sanitizeSandbox line and vanished on every round-trip. Prove
// it survives through the REAL sanitizer path (freshStores → set → get) as a box
// config, plus the shape-guarding drops the store still owns.
test('uiSettings: a box config\'s mounts survive the sanitizer round-trip (M6a whitelist regression)', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ boxes: [{ id: 'sandbox', label: 'sandbox', config: { mounts: [
      { host: '/Users/me/proj', ro: false },
      { host: '/Users/me/ref', ro: true, container: '/home/clodex/ref' },
    ] } }] });
    assert.deepStrictEqual(uiSettings.get().boxes[0].config.mounts, [
      { host: '/Users/me/proj', ro: false },
      { host: '/Users/me/ref', ro: true, container: '/home/clodex/ref' },
    ]);
  } finally { cleanup(); }
});

test('uiSettings: a box config sanitizer bounds junk fields + coerces mount rows', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ boxes: [{ id: 'sandbox', label: 'sandbox', config: {
      workDir: '   ',            // blank → null
      webPort: 70000,           // out of range → default
      wirescopePort: 'nope',    // non-int → default
      autoStart: 'yes',         // truthy-but-not-true → false
      image: '',                // empty → null
      bogus: 'dropped',         // unknown key → gone
      mounts: [
        { host: '  ' },                         // blank host → dropped
        { ro: true },                           // no host → dropped
        'not-an-object',                        // non-object → dropped
        { host: '/a', ro: 'yes' },              // truthy-not-true ro → false
        { host: '  /b  ', container: '  ' },    // host trimmed; blank container omitted
        { host: '/c', container: '  /home/clodex/c  ', ro: true }, // container trimmed
      ],
    } }] });
    assert.deepStrictEqual(uiSettings.get().boxes[0].config, {
      workDir: null, webPort: 7810, wirescopePort: 7811, wirePort: 7820,
      autoStart: false, image: null,
      mounts: [
        { host: '/a', ro: false },
        { host: '/b', ro: false },
        { host: '/c', ro: true, container: '/home/clodex/c' },
      ],
    });
  } finally { cleanup(); }
});

test('uiSettings: a boxes write leaves the other settings intact', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [{ id: 'p', label: 'P', url: 'http://p' }] });
    uiSettings.set({ boxes: [{ id: 'sandbox', label: 'sandbox', config: { autoStart: true } }] });
    const s = uiSettings.get();
    assert.strictEqual(s.boxes[0].config.autoStart, true);
    assert.strictEqual(s.peers.length, 1);
    assert.strictEqual(s.peers[0].id, 'p');
  } finally { cleanup(); }
});

// ui-settings.json holds peer auth tokens, so a group/world-readable one is
// worth a word — the same stance cli/src/contexts.js takes for its own token
// file. Warn, never fail: a settings read must keep working regardless.
test('uiSettings: a group/world-readable settings file warns once, and still loads', () => {
  const { stores, userData, cleanup } = freshStores();
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [{ id: 'p', label: 'P', url: 'http://p', token: 'sekrit' }] });
    fs.chmodSync(path.join(userData, 'ui-settings.json'), 0o644);
    const s = uiSettings.get();
    assert.strictEqual(s.peers.length, 1, 'a loose mode must warn, never block the read');
    const hit = warnings.filter((w) => /ui-settings\.json is mode/.test(w));
    assert.strictEqual(hit.length, 1, `expected exactly one mode warning, got ${warnings.length} warnings`);
    assert.match(hit[0], /chmod 600/);
    // Checked once per process: a statSync on every _load would be a syscall per
    // settings read for a file that is 0600 in every normal case.
    uiSettings.get();
    uiSettings.get();
    assert.strictEqual(warnings.filter((w) => /ui-settings\.json is mode/.test(w)).length, 1,
      'the mode check must run once per process, not once per read');
  } finally { console.warn = realWarn; cleanup(); }
});

test('uiSettings: a 0600 settings file warns about nothing', () => {
  const { stores, userData, cleanup } = freshStores();
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [{ id: 'p', label: 'P', url: 'http://p' }] });
    assert.strictEqual((fs.statSync(path.join(userData, 'ui-settings.json')).mode & 0o777), 0o600,
      'atomicWriteFileSync must land 0600 by construction');
    uiSettings.get();
    assert.deepStrictEqual(warnings.filter((w) => /ui-settings\.json is mode/.test(w)), []);
  } finally { console.warn = realWarn; cleanup(); }
});

// --- envScopes store (T46) --------------------------------------------------

test('envScopes: set/getScope round-trips global + workspace, remove prunes', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { envScopes } = stores;
    envScopes.set('global', 'AWS_PROFILE', 'acct', false);
    envScopes.set('global', 'TOK', 'sekret', true);
    envScopes.set('ws-1', 'WK', 'wv', false);
    assert.deepStrictEqual(envScopes.getScope('global'), {
      AWS_PROFILE: { value: 'acct', secret: false },
      TOK: { value: 'sekret', secret: true },
    });
    assert.deepStrictEqual(envScopes.getScope('ws-1'), { WK: { value: 'wv', secret: false } });
    // all() feeds the merge: global + the workspaces map.
    const all = envScopes.all();
    assert.deepStrictEqual(Object.keys(all.workspaces), ['ws-1']);
    envScopes.remove('ws-1', 'WK');
    assert.deepStrictEqual(envScopes.getScope('ws-1'), {}, 'emptied workspace read back as {}');
    assert.deepStrictEqual(Object.keys(envScopes.all().workspaces), [], 'emptied workspace map pruned');
  } finally { cleanup(); }
});

test('envScopes: set throws on an invalid key, the deny key, and a newline value', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { envScopes } = stores;
    assert.throws(() => envScopes.set('global', '2bad', 'x', false), /invalid env key/);
    assert.throws(() => envScopes.set('global', 'CLODEX_REMOTE_TOKEN', 'leak', false), /reserved/);
    assert.throws(() => envScopes.set('global', 'OK', 'a\nb', false), /newline/);
    assert.deepStrictEqual(envScopes.getScope('global'), {}, 'nothing landed');
  } finally { cleanup(); }
});

test('envScopes: prototype-pollution guard — __proto__/constructor/prototype scopes are refused', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { envScopes } = stores;
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => envScopes.set(bad, 'K', 'v', false), /invalid scope/, `set(${bad}) refused`);
      assert.deepStrictEqual(envScopes.getScope(bad), {}, `getScope(${bad}) is inert`);
      assert.doesNotThrow(() => envScopes.remove(bad, 'K'));
      assert.doesNotThrow(() => envScopes.removeWorkspace(bad));
    }
    // Object.prototype was never touched.
    assert.strictEqual(({}).K, undefined, 'no key leaked onto Object.prototype');
    assert.strictEqual(({}).polluted, undefined);
  } finally { cleanup(); }
});

test('envScopes: the store file is written 0600 (secret store)', () => {
  const { stores, userData, cleanup } = freshStores();
  try {
    stores.envScopes.set('global', 'K', 'v', false);
    const st = fs.statSync(path.join(userData, 'env-scopes.json'));
    assert.strictEqual(st.mode & 0o777, 0o600, 'env-scopes.json is 0600');
  } finally { cleanup(); }
});

test('uiSettings: the hint toggles default off and round-trip independently', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    // Both OFF by default. semanticHints in particular reaches a local Ollama
    // that users do not have installed, so shipping it on would mean every
    // submit attempting a connection that cannot succeed.
    assert.strictEqual(uiSettings.get().contextHints, false);
    assert.strictEqual(uiSettings.get().semanticHints, false);

    // Independent, not one checkbox: semantic ranking only reorders what the
    // lexical gate admitted, so enabling it alone must not start arming.
    uiSettings.set({ semanticHints: true });
    assert.strictEqual(uiSettings.get().semanticHints, true);
    assert.strictEqual(uiSettings.get().contextHints, false,
      'the semantic toggle must not imply the arming toggle');

    uiSettings.set({ contextHints: true });
    assert.strictEqual(uiSettings.get().contextHints, true);
    assert.strictEqual(uiSettings.get().semanticHints, true, 'and the other survives an unrelated write');

    uiSettings.set({ theme: uiSettings.get().theme });
    assert.strictEqual(uiSettings.get().semanticHints, true,
      'a partial write must not reset a flag it did not mention');
  } finally { cleanup(); }
});

test('uiSettings: a non-boolean hint flag falls back to the default', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    stores.uiSettings.set({ semanticHints: true });
    // Hand-corrupt the file the way a bad merge or an older build would.
    const f = path.join(userData, 'ui-settings.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    raw.semanticHints = 'yes';
    fs.writeFileSync(f, JSON.stringify(raw));
    const again = initStores(userData, { log: console,
      registryDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-')),
      resourcesDir: path.join(userData, '__no_seed__') });
    assert.strictEqual(again.uiSettings.get().semanticHints, false,
      'a truthy non-boolean must not read as enabled');
  } finally { cleanup(); }
});
