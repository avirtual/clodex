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
const { mkTmpRoot } = require('./lib/tmp-roots');

// Fresh temp userData + registry dirs, and a stores bundle over them. BOTH seed
// sources are pointed at paths that don't exist, so neither the shipped library
// defaults nor the shipped skills pollute the per-store assertions below; the
// seed step has its own dedicated tests that exercise it explicitly.
function freshStores() {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  const stores = initStores(userData, { log: console, registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__'),
    skillsResourcesDir: path.join(registryDir, '__no_seed_skills__') });
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

test('uiSettings: clearing the submit phrase restores the default, absence keeps it', () => {
  const { stores, cleanup } = freshStores();
  try {
    const DEFAULT = 'over and out';
    assert.strictEqual(stores.uiSettings.get().voiceSubmitPhrase, DEFAULT);

    stores.uiSettings.set({ voiceSubmitPhrase: 'wrap it up' });
    assert.strictEqual(stores.uiSettings.get().voiceSubmitPhrase, 'wrap it up');

    // KEY ABSENT is "no opinion" — an unrelated save must not reset the phrase.
    stores.uiSettings.set({ voiceSubmit: true });
    assert.strictEqual(stores.uiSettings.get().voiceSubmitPhrase, 'wrap it up');
    assert.strictEqual(stores.uiSettings.get().voiceSubmit, true);

    // KEY PRESENT AND BLANK is the operator clearing the field, which the
    // Preferences hint offers as the way back to the default. Collapsing the two
    // cases makes that promise false: the custom phrase survives the clear and
    // reappears in the field on the next open.
    stores.uiSettings.set({ voiceSubmitPhrase: '' });
    assert.strictEqual(stores.uiSettings.get().voiceSubmitPhrase, DEFAULT);

    stores.uiSettings.set({ voiceSubmitPhrase: '  Roger That.  ' });
    assert.strictEqual(stores.uiSettings.get().voiceSubmitPhrase, 'Roger That.');
    stores.uiSettings.set({ voiceSubmitPhrase: '   ' });
    assert.strictEqual(stores.uiSettings.get().voiceSubmitPhrase, DEFAULT, 'whitespace is blank');
  } finally { cleanup(); }
});

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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  const resourcesDir = mkTmpRoot('stores-res-');
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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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
const readSeedReport = (registryDir) => JSON.parse(fs.readFileSync(path.join(registryDir, 'library', '.seed-report.json'), 'utf-8'));

function withSeedDirs(fn) {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  const resourcesDir = mkTmpRoot('stores-res-');
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

// --- t455: a STRANDED file (matches neither its stamp nor the ship) ----------
// The guard that preserves operator edits also silently freezes a stale shipped
// copy: both look like "diverged". Bytes cannot tell them apart, so the shipped
// behaviour is report-never-repair, with one content-free exception (stamp
// convergence). A log seam that records the channel keeps the report assertable.
function captureLog() {
  const calls = [];
  const rec = (level) => (chan, msg) => { calls.push({ level, chan, msg: String(msg) }); };
  return { calls, info: rec('info'), warn: rec('warn'), error: rec('error'),
    seedWarnings() { return this.calls.filter((c) => c.level === 'warn' && c.chan === 'seed'); } };
}

test('seed reconcile: a live file matching NO shipped revision is never overwritten', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    // The measured reviewer-template shape: dest holds real operator config that
    // equals neither the stamp (V1) nor any shipped bytes. Overwriting it would
    // destroy the config, so this is the file the repair must refuse to touch.
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');

    initStores(userData, { registryDir, resourcesDir });

    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'OPERATOR_CONFIG',
      'operator config preserved: never overwrite bytes matching no shipped revision');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('SHIPPED_V1')),
      'stamp left alone too -- restamping here would silently adopt the edit as shipped');
  });
});

test('seed reconcile: a stranded file is REPORTED, naming the file', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    const log = captureLog();

    initStores(userData, { log, registryDir, resourcesDir });

    // ENTER: the seed warning must exist at all -- every assertion below is
    // about its text, and an empty filter would satisfy all of them vacuously.
    const warns = log.seedWarnings();
    assert.strictEqual(warns.length, 1, 'exactly one seed warning for the stranded file');
    assert.match(warns[0].msg, /reviewer\.json/, 'the report names the stranded file');
    assert.match(warns[0].msg, /never receive shipped updates/,
      'the report says WHAT is wrong (updates withheld), not just that bytes differ');
  });
});

test('seed reconcile: an operator edit is NOT reported while the ship has not moved', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V1');
    // Edited, but the stamp IS the shipped bytes: no update is being withheld
    // yet, so warning here would fire on every edited file on every launch.
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    const log = captureLog();

    initStores(userData, { log, registryDir, resourcesDir });

    // Reaching the guarded state is the precondition -- assert it before the
    // absence, or an unseeded/absent file would pass the absence for free.
    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'OPERATOR_CONFIG', 'edit still on disk');
    assert.deepStrictEqual(log.seedWarnings(), [], 'no report: nothing is being withheld');
  });
});

test('seed reconcile: live == shipped with a lagging stamp converges, back onto the upgrade path', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'V2');
    // Hand-repaired (copied shipped bytes over) but never re-stamped: diverged
    // from the stamp, yet identical to the ship. Converging the stamp writes no
    // content, so it is the one repair that cannot destroy an edit.
    stageDest(registryDir, rel, 'V2', 'V1');
    const log = captureLog();

    initStores(userData, { log, registryDir, resourcesDir });

    const dest = path.join(registryDir, 'library', rel);
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'V2', 'content untouched by the stamp convergence');
    assert.strictEqual(readSeedState(registryDir)[rel], sha256(Buffer.from('V2')), 'stamp converged to the shipped hash');
    assert.deepStrictEqual(log.seedWarnings(), [], 'converged, so nothing is stranded to report');

    // The convergence is only worth anything if the NEXT ship now lands.
    fs.writeFileSync(path.join(resourcesDir, rel), 'V3');
    initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'V3', 'next ship upgrades it -- no longer stranded');
  });
});

// --- t456: the stranded report's CADENCE and CHANNEL ------------------------
// The measured real-world stranded file is genuine operator config that should
// NOT be touched, so an unconditional per-launch report is a permanent nag with
// no action that silences it. Dedupe is keyed on the SHIPPED hash: a newly
// WITHHELD update is announced once, in the operator inbox; the steady state is
// inbox-silent while the log keeps recording every run.
const seedReportPath = (registryDir) => path.join(registryDir, 'library', '.seed-report.json');
const inboxNotes = (stores) => stores.notifications.list().filter((n) => n.from === 'Clodex library');

test('seed report: a newly stranded file reaches the operator inbox, naming the file', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    const log = captureLog();

    const stores = initStores(userData, { log, registryDir, resourcesDir });

    // ENTER: the file must actually be stranded, or every assertion below is
    // about an empty set and passes for free.
    assert.strictEqual(log.seedWarnings().length, 1, 'the file is stranded (log warned)');
    const notes = inboxNotes(stores);
    assert.strictEqual(notes.length, 1, 'exactly one inbox note for the new withholding');
    assert.match(notes[0].body, /reviewer\.json/, 'the note names the stranded file');
    assert.strictEqual(notes[0].readAt, null, 'unread, so it badges the inbox');
    assert.strictEqual(notes[0].workspaceId, null, 'not scoped to a workspace: this is box-wide');
  });
});

test('seed report: the steady state is inbox-silent, while the log still records every run', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');

    initStores(userData, { registryDir, resourcesDir });
    const log = captureLog();
    const stores = initStores(userData, { log, registryDir, resourcesDir }); // relaunch, nothing changed

    assert.strictEqual(log.seedWarnings().length, 1,
      'the log is the forensic record and restates the stranded set every run');
    assert.strictEqual(inboxNotes(stores).length, 1,
      'still ONE note total: the second launch must not re-nag an unchanged withholding');
  });
});

test('seed report: a MOVED shipped hash announces again -- a new update is being withheld', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');

    initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(readSeedReport(registryDir)[rel], sha256(Buffer.from('SHIPPED_V2')),
      'the reported shipped hash is recorded');

    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V3'); // the ship moves on
    const stores = initStores(userData, { registryDir, resourcesDir });

    assert.strictEqual(inboxNotes(stores).length, 2,
      'a SECOND update is now being withheld, which is a new fact and must announce');
    assert.strictEqual(readSeedReport(registryDir)[rel], sha256(Buffer.from('SHIPPED_V3')),
      'report state advances to the newly withheld shipped hash');
  });
});

test('seed report: state is rebuilt from the current set, so a re-strand announces again', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');

    const first = initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(inboxNotes(first).length, 1, 'announced once');

    // The operator deletes their version: the file re-seeds and is no longer
    // stranded, so its report entry must be DROPPED rather than carried.
    fs.rmSync(path.join(registryDir, 'library', rel));
    const healed = initStores(userData, { registryDir, resourcesDir });
    assert.deepStrictEqual(readSeedReport(registryDir), {},
      'no longer stranded -> the entry is gone, not carried forward');
    assert.strictEqual(inboxNotes(healed).length, 1, 'healing itself is not news');

    // It strands AGAIN at the very same shipped hash. A merged (never-pruned)
    // map would still hold SHIPPED_V2 here and swallow this second, real event.
    stageDest(registryDir, rel, 'OPERATOR_CONFIG_AGAIN', 'SHIPPED_V1');
    const restranded = initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(inboxNotes(restranded).length, 2,
      're-stranding at the same shipped hash is a new withholding and announces');
  });
});

test('seed report: nothing stranded writes no report file at all', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'V1');

    const stores = initStores(userData, { registryDir, resourcesDir });

    assert.strictEqual(fs.readFileSync(path.join(registryDir, 'library', rel), 'utf-8'), 'V1',
      'ENTER: the seed ran at all');
    assert.strictEqual(fs.existsSync(seedReportPath(registryDir)), false,
      'the healthy case leaves no report state behind');
    assert.deepStrictEqual(inboxNotes(stores), [], 'and does not touch the inbox');
  });
});

test('seed report: the advice leads with "nothing to do", never a bare delete', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    const log = captureLog();

    const stores = initStores(userData, { log, registryDir, resourcesDir });

    const warns = log.seedWarnings();
    assert.strictEqual(warns.length, 1, 'ENTER: the report fired');
    const notes = inboxNotes(stores);
    assert.strictEqual(notes.length, 1, 'ENTER: the note fired');
    // The measured instance is real operator config that must NOT be deleted, so
    // both channels must state the no-action case, and must state it BEFORE the
    // destructive one.
    for (const [what, text] of [['log', warns[0].msg], ['note', notes[0].body]]) {
      assert.match(text, /nothing needs doing/, `${what}: the no-action case is stated`);
      assert.match(text, /copy yours aside first/, `${what}: keeping the edit is the precondition to deleting`);
      // Both anchors are located BEFORE they are compared. An absent end anchor
      // yields -1, and `i < -1` is false so the comparison would still fail --
      // but it would fail claiming the order is wrong when the sentence is
      // simply missing, which is a different defect. Asserting the find makes
      // the two legible apart. The pronoun tracks the file count, so it is
      // matched either way rather than pinned to the singular.
      const noAction = text.search(/nothing needs doing/);
      const destructive = text.search(/delete (it|them) under/);
      assert.ok(destructive >= 0, `${what}: the delete instruction is present at all`);
      assert.ok(noAction >= 0 && noAction < destructive,
        `${what}: the no-action case comes BEFORE the delete, or a skimmer deletes real config`);
    }
  });
});

test('seed report: a corrupt report file announces rather than swallowing', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    fs.writeFileSync(seedReportPath(registryDir), '{ not json ]]]');

    const stores = initStores(userData, { registryDir, resourcesDir });

    assert.strictEqual(inboxNotes(stores).length, 1,
      'unreadable dedupe state degrades to announcing, never to silence');
    assert.deepStrictEqual(readSeedReport(registryDir), { [rel]: sha256(Buffer.from('SHIPPED_V2')) },
      'and the corrupt file is replaced with usable state');
  });
});

// --- t456 r2: an announcement is banked only if the note reached disk --------
// notifications._save swallows a write failure and add() returns the record
// regardless, so the return value cannot witness delivery. If the hash were
// banked anyway, an unwritable inbox would lose the note AND go quiet until the
// ship next moves -- a new silent path inside the mechanism built to end a
// silence.

test('seed report: an undelivered note is NOT banked, and the next launch retries', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');

    // The inbox cannot be written: a DIRECTORY where notifications.json goes,
    // which makes the real write throw exactly where a full disk or a bad mode
    // would, rather than stubbing the store and testing the stub.
    fs.mkdirSync(path.join(userData, 'notifications.json'), { recursive: true });

    const first = initStores(userData, { registryDir, resourcesDir });
    // ENTER: the write really did fail -- if a note somehow landed, the whole
    // premise of this test is gone and the assertions below prove nothing.
    assert.deepStrictEqual(first.notifications.list(), [], 'ENTER: the note could not be stored');
    assert.strictEqual(fs.existsSync(seedReportPath(registryDir)), false,
      'nothing announced, so nothing is banked -- no report state is written at all');

    // Inbox works again on the next launch; the announcement must still happen.
    fs.rmdirSync(path.join(userData, 'notifications.json'));
    const second = initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(inboxNotes(second).length, 1,
      'the retry delivers the note that the failed launch never banked');
    assert.strictEqual(readSeedReport(registryDir)[rel], sha256(Buffer.from('SHIPPED_V2')),
      'and only now is the hash recorded as announced');
  });
});

test('seed report: a failed note does not discard the PREVIOUS token', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');

    initStores(userData, { registryDir, resourcesDir }); // announces V2, banks it
    assert.strictEqual(readSeedReport(registryDir)[rel], sha256(Buffer.from('SHIPPED_V2')),
      'ENTER: V2 is banked before the ship moves');

    // The ship moves AND the inbox breaks: the V3 note fails, so V3 must not be
    // banked -- but the V2 token must survive, or a recovered launch re-announces
    // V2, which the operator already saw.
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V3');
    const userDataFile = path.join(userData, 'notifications.json');
    fs.rmSync(userDataFile, { force: true });
    fs.mkdirSync(userDataFile, { recursive: true });

    initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(readSeedReport(registryDir)[rel], sha256(Buffer.from('SHIPPED_V2')),
      'the undelivered V3 is not banked, and the delivered V2 is not lost');
  });
});

test('seed report: a failed note is itself logged, never silent', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('templates', 'reviewer.json');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED_V2');
    stageDest(registryDir, rel, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    fs.mkdirSync(path.join(userData, 'notifications.json'), { recursive: true });
    const log = captureLog();

    initStores(userData, { log, registryDir, resourcesDir });

    const warns = log.seedWarnings();
    assert.strictEqual(warns.length, 2, 'the stranded report AND the delivery failure both warn');
    assert.ok(warns.some((w) => /not written/.test(w.msg)),
      'the lost note leaves a trace: the log is the only channel left when the inbox is the thing that broke');
  });
});

test('seed report: with SEVERAL stranded files the advice is plural throughout', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    // Every other row here strands ONE file, where the singular pronoun is
    // correct either way -- so a half-applied plural ("edited them ... delete
    // it") reads fine in all of them. Two files is the smallest case that can
    // tell the two apart.
    const relA = path.join('templates', 'reviewer.json');
    const relB = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, relA), 'SHIPPED_V2');
    fs.writeFileSync(path.join(resourcesDir, relB), 'SHIPPED_V2');
    stageDest(registryDir, relA, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    stageDest(registryDir, relB, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    const log = captureLog();

    const stores = initStores(userData, { log, registryDir, resourcesDir });

    const warns = log.seedWarnings();
    assert.strictEqual(warns.length, 1, 'ENTER: one report covering both files');
    const notes = inboxNotes(stores);
    assert.strictEqual(notes.length, 1, 'ENTER: ONE note listing both, not one note each');
    for (const [what, text] of [['log', warns[0].msg], ['note', notes[0].body]]) {
      assert.match(text, /edited them deliberately/, `${what}: plural subject`);
      assert.match(text, /delete them under/, `${what}: plural object too -- the switch must be applied at BOTH sites`);
      assert.doesNotMatch(text, /delete it under/, `${what}: no singular left behind`);
    }
  });
});

// The two channels carry different SETS -- the log restates every stranded file,
// the note lists only the fresh ones -- so a single advice string built from the
// whole set over-pluralises the note. The all-fresh cases above cannot see it,
// because there the two counts are equal.
test('seed report: a MIXED run pluralises each channel by its own count', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const relA = path.join('templates', 'reviewer.json');
    const relB = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, relA), 'SHIPPED_V2');
    fs.writeFileSync(path.join(resourcesDir, relB), 'SHIPPED_V2');
    stageDest(registryDir, relA, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    stageDest(registryDir, relB, 'OPERATOR_CONFIG', 'SHIPPED_V1');
    // A is already announced at the CURRENT shipped hash, so only B is fresh.
    fs.writeFileSync(seedReportPath(registryDir),
      JSON.stringify({ [relA]: sha256(Buffer.from('SHIPPED_V2')) }));
    const log = captureLog();

    const stores = initStores(userData, { log, registryDir, resourcesDir });

    const notes = inboxNotes(stores);
    assert.strictEqual(notes.length, 1, 'ENTER: one note');
    assert.match(notes[0].body, /\bb?lead\.md/, 'ENTER: the note lists ONLY the fresh file');
    assert.doesNotMatch(notes[0].body, /reviewer\.json/,
      'ENTER: the already-announced file is absent, or this is not a mixed run');
    assert.match(notes[0].body, /edited it deliberately/,
      'the note lists one file, so it says "it" -- not "them" from the whole stranded set');
    assert.match(notes[0].body, /delete it under/, 'both sites follow the note\'s own count');

    const warns = log.seedWarnings();
    assert.strictEqual(warns.length, 1, 'ENTER: one report line');
    assert.match(warns[0].msg, /edited them deliberately/,
      'the log restates BOTH stranded files, so it stays plural -- the two channels differ');
  });
});

// --- the SKILLS root seeds beside the library one ---------------------------
// Skills live at registryDir/skills, a SIBLING of library/, so the seeder walks
// two (src, dest) pairs. Each dest root owns its .seed-state.json /
// .seed-report.json, and both channels must name the root: an operator told
// "clodex-plugin.md" with no root goes looking under library/, where it is not.
// A temp registryDir is mandatory here — the seeder refuses the real ~/.clodex
// under node --test, so a fixture that forgets the seam gets a silent no-op.
const REPO_SKILL = path.join(__dirname, '..', 'resources', 'skills', 'clodex-plugin.md');
const skillsReportPath = (registryDir) => path.join(registryDir, 'skills', '.seed-report.json');

// userData + registryDir + a hermetic SKILLS source, with the library source
// pointed at nothing so the shipped library tree never lands in the assertions.
function withSkillSeedDirs(fn) {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  const skillsResourcesDir = mkTmpRoot('stores-skillres-');
  try {
    fn({ userData, registryDir, skillsResourcesDir,
      resourcesDir: path.join(registryDir, '__no_seed__') });
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
    fs.rmSync(skillsResourcesDir, { recursive: true, force: true });
  }
}

test('seed skills: the shipped clodex-plugin skill lands in a fresh registry (byte-exact, 0600)', () => {
  // The DEFAULT skills source (__dirname/resources/skills) is exercised — no
  // skillsResourcesDir override — so this pins the real shipped tree.
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  try {
    const stores = initStores(userData, { registryDir });
    const dest = path.join(registryDir, 'skills', 'clodex-plugin.md');
    assert.ok(fs.existsSync(dest), 'clodex-plugin.md seeded on construction');
    assert.deepStrictEqual(fs.readFileSync(dest), fs.readFileSync(REPO_SKILL),
      'byte-for-byte the shipped copy');
    // A skill store file holds an operator's own prose and is read back by the
    // spawn path; skillLibrary.save writes 0600 and a seeded one must match, or
    // the mode depends on which door the file came through.
    assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o600, 'seeded skill is 0600');
    const seeded = stores.skillLibrary.list().find((s) => s.name === 'clodex-plugin');
    assert.ok(seeded, 'the seeded skill surfaces through skillLibrary.list()');
    assert.match(seeded.description, /Clodex plugin/,
      'and carries the description parsed from its frontmatter');
    assert.ok(fs.existsSync(path.join(registryDir, 'skills', '.seed-state.json')),
      'ENTER: the manifest is there to be mis-listed');
    assert.deepStrictEqual(stores.skillLibrary.list().map((s) => s.name), ['clodex-plugin'],
      'the .seed-state.json sibling is not listed as a skill');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('seed skills: an operator-edited skill survives a moved ship, and the report names the skills root', () => {
  withSkillSeedDirs(({ userData, registryDir, resourcesDir, skillsResourcesDir }) => {
    const shipped = path.join(skillsResourcesDir, 'clodex-plugin.md');
    fs.writeFileSync(shipped, '---\ndescription: V1\n---\nV1 body');

    initStores(userData, { registryDir, resourcesDir, skillsResourcesDir });
    const dest = path.join(registryDir, 'skills', 'clodex-plugin.md');
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), '---\ndescription: V1\n---\nV1 body',
      'ENTER: the first run seeded, or there is nothing for the operator to edit');

    // The operator edits it, and the ship moves on underneath them.
    fs.writeFileSync(dest, '---\ndescription: MINE\n---\nmy own body');
    fs.writeFileSync(shipped, '---\ndescription: V2\n---\nV2 body');
    const log = captureLog();

    const stores = initStores(userData, { log, registryDir, resourcesDir, skillsResourcesDir });

    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), '---\ndescription: MINE\n---\nmy own body',
      'the operator edit is never clobbered');
    const warns = log.seedWarnings();
    assert.strictEqual(warns.length, 1, 'ENTER: the file is stranded (one report line)');
    assert.match(warns[0].msg, /clodex-plugin\.md/, 'the log names the stranded skill');
    assert.match(warns[0].msg, /\bskills file\(s\)/,
      'and calls it a SKILLS file, not a library one');
    const notes = inboxNotes(stores);
    assert.strictEqual(notes.length, 1, 'ENTER: one inbox note');
    assert.match(notes[0].body, /clodex-plugin\.md/, 'the note names the stranded skill');
    assert.ok(notes[0].body.includes(`under ${path.join(registryDir, 'skills')}`),
      'the note points at the skills root, or the operator looks under library/ and finds nothing');
  });
});

test('seed skills: the two roots keep independent report state', () => {
  withSkillSeedDirs(({ userData, registryDir, skillsResourcesDir }) => {
    // A real library source alongside, healthy: it seeds and strands nothing.
    const resourcesDir = mkTmpRoot('stores-res-');
    try {
      fs.mkdirSync(path.join(resourcesDir, 'templates'), { recursive: true });
      fs.writeFileSync(path.join(resourcesDir, 'templates', 'reviewer.json'), '{}');
      // The skill is stranded: dest matches neither its stamp nor the ship.
      const shipped = path.join(skillsResourcesDir, 'clodex-plugin.md');
      fs.writeFileSync(shipped, 'SHIPPED_V2');
      const dest = path.join(registryDir, 'skills', 'clodex-plugin.md');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'OPERATOR_EDIT');
      fs.writeFileSync(path.join(registryDir, 'skills', '.seed-state.json'),
        JSON.stringify({ 'clodex-plugin.md': sha256(Buffer.from('SHIPPED_V1')) }));
      const log = captureLog();

      initStores(userData, { log, registryDir, resourcesDir, skillsResourcesDir });

      assert.strictEqual(log.seedWarnings().length, 1,
        'ENTER: exactly one root stranded anything');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(skillsReportPath(registryDir), 'utf-8')),
        { 'clodex-plugin.md': sha256(Buffer.from('SHIPPED_V2')) },
        'the skills root records its own stranding');
      assert.strictEqual(fs.existsSync(seedReportPath(registryDir)), false,
        'and the library root, which stranded nothing, gets no report file');
      assert.deepStrictEqual(readSeedState(registryDir), {
        [path.join('templates', 'reviewer.json')]: sha256(Buffer.from('{}')),
      }, 'the library manifest holds only library files: the two states never merge');
    } finally {
      fs.rmSync(resourcesDir, { recursive: true, force: true });
    }
  });
});

test('seed skills: a missing skills source is a no-op, not a throw', () => {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  try {
    const stores = initStores(userData, {
      registryDir,
      resourcesDir: path.join(registryDir, '__no_seed__'),
      skillsResourcesDir: path.join(registryDir, 'no-such-skills'),
    });
    assert.deepStrictEqual(stores.skillLibrary.list(), [],
      'construction succeeds and seeds nothing');
    assert.strictEqual(fs.existsSync(path.join(registryDir, 'skills', '.seed-state.json')), false,
      'no manifest is written for a source that is not there');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

// The two routing facts a first-time plugin author needs BEFORE they read the
// 2,000-line contract, asserted on the seeded copy so the shipped prose and the
// file an agent actually opens are pinned in one go. Phrases, not lines: the
// wording around them is free to change.
test('seed skills: the seeded skill routes a viewer, and states the realpath rule', () => {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  try {
    initStores(userData, { registryDir });
    const text = fs.readFileSync(path.join(registryDir, 'skills', 'clodex-plugin.md'), 'utf-8');

    const rows = text.split('\n').filter((l) => l.startsWith('|'));
    const viewer = rows.findIndex((l) => /§6\.3/.test(l) && /§6\.7/.test(l));
    const anyUi = rows.findIndex((l) => /Any UI at all/.test(l));
    assert.ok(anyUi >= 0, 'ENTER: the generic UI row is in the table, so the order below compares two real rows');
    assert.ok(viewer >= 0,
      'the routing table carries a row sending the button+overlay+read shape at §6.3 and §6.7');
    assert.ok(viewer < anyUi,
      'and the specific viewer row sits ABOVE the generic "Any UI at all" row, or nobody reaches it');

    const step3 = text.slice(text.indexOf('## Step 3'), text.indexOf('## Step 4'));
    assert.ok(step3.length > 0, 'ENTER: Step 3 is a real slice, not an empty one from two missing headings');
    assert.match(step3, /realpath/i,
      'Step 3 states the realpath rule for a path a user or an agent named');
    assert.match(step3, /every read/i,
      'and says it applies on EVERY read, which is the half a lexical join gets wrong');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

// --- T26: all three default team role prompts ship + brief the live protocols
const TEAM_ROLE_PROMPTS = ['clodex-team-lead', 'clodex-team-hand', 'clodex-team-reviewer'];
const REPO_SYSTEM_DIR = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system');

test('seed: ships all three default team role prompts into a fresh registry', () => {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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

// The prompts are still the only comment guidance a hand receives: the rule's other
// home, .claude/CLAUDE.md, is gitignored and absent from every ticket worktree. What
// changed is the division of labour. `test/comment-ratchet.test.js` now carries the
// QUANTITY half mechanically, so the prompts keep only what a line count cannot see:
// the criterion a surviving comment must meet, the escape hatch that stops a hand
// reading the zero budget and a real need as a contradiction, and — the load-bearing
// half — deletion rather than qualification as the repair, on both sides. A reviewer
// asking for qualifiers is what grew the files while the code stood still.
test('seed: shipped team prompts carry the comment rule, in both directions', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.match(hand, /A comment earns\s+its place only by naming a WRONG CHANGE it prevents/,
    'hand prompt states the earns-its-place bar');
  assert.match(hand, /comment-ratchet\.test\.js/,
    'hand prompt names the gate that now enforces the quantity half');
  assert.match(hand, /a file new on\s+your branch ships with zero/,
    'and the budget a new file gets, which is the arm a hand hits first');
  assert.match(hand, /docs\/notes\/<module>\.md/,
    'hand prompt gives the escape hatch for a fact the code cannot express');
  assert.match(hand, /separators flattened to hyphens/,
    'and the note-naming convention the same gate resolves, so the hatch does not red on an orphan');
  assert.match(hand, /never by line number/,
    'which carries the line-number rot rule onto notes, where the sweep patterns do not reach');
  assert.match(hand, /Prefer DELETING a stale or over-wide comment to rewriting it/,
    'hand prompt keeps deletion over rewriting — an equal-length rewrite moves no line count');
  const reviewer = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-reviewer.md'), 'utf-8');
  assert.match(reviewer, /DELETING IS THE DEFAULT REPAIR/,
    'reviewer prompt makes deletion the default repair for an over-wide comment');
  assert.match(reviewer, /Qualifying is the exception/,
    'reviewer prompt marks qualifying as the exception, not the reflex');
  assert.match(reviewer, /A comment ADDED\s+in a touched source hunk, or one KEPT there that the changed code no longer\s+backs, is a finding/,
    'reviewer prompt makes an added or falsified comment in a touched SOURCE hunk a finding — test/ prose is out of ratchet scope by design');
  assert.match(reviewer, /counts lines and cannot read\s+them/,
    'and says why it reaches only the reviewer: an equal-length swap passes the ratchet');
});

// Both halves reach defects a code-identity check and a cold review cannot: the
// reviewer reads the diff, so a comment nobody opened is invisible to it, and a
// cut that severs a sentence head leaves a tail that compiles, passes identity
// and reads inverted. The greppable patterns are pinned as LITERALS because a
// hand pastes them — a "grep the always-cut categories" instruction with the
// patterns dropped is the version that gets found incidentally again. The
// caveat is pinned in its author's words: softening it into a gate recreates,
// one level up, the coverage claim this whole section exists to remove.
test('seed: the hand prompt carries the decomment sweep and the post-cut boundary check', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.match(hand, /a comment you never opened appears nowhere\s+and cannot be reviewed/,
    'hand prompt gives the structural reason a sweep is needed: the diff cannot show an omission');
  assert.match(hand, /Grep\s+each always-cut category across the WHOLE file and drive it to zero/,
    'and the instruction to sweep the whole file rather than the blocks the pass happens to open');
  for (const pattern of ['test/.*\\.test\\.js|pinned by|covered by',
    '\\bt[0-9]{2,3}\\b|Task [0-9]+|GH#',
    '[A-Z]{2,}\\.md|§',
    ':[0-9]{3,}']) {
    assert.ok(hand.includes(pattern), `hand prompt ships the greppable pattern: ${pattern}`);
  }
  assert.match(hand, /The list is a floor/,
    'the category list is a floor, so a category found mid-pass is swept too');
  assert.match(hand, /TRUE and CHECKABLE earns its place/,
    'and a true coverage claim survives the sweep — it finds them, it does not delete them unread');
  assert.match(hand, /check what SURVIVES each cut, not only what it removed/,
    'hand prompt states the post-cut half: the residue is the defect, not the deletion');
  assert.match(hand, /semantically\s+INVERTED/,
    'and names the failure: a severed head leaves a valid sentence meaning the opposite');
  assert.match(hand, /boundary-check\.js/, 'and points at the implementation');
  assert.doesNotMatch(hand, /const CONNECTOR|require\('fs'\)/,
    'by POINTER, not by pasting the code into a prompt every hand reads on every ticket');
  assert.match(hand, /the check is a\s+lint that needs a human ruling per flag, not a gate/,
    "the author's precision caveat, unsoftened: a lint, not a gate");
  assert.match(hand, /It cannot distinguish a\s+severed head from a lowercase-but-complete sentence; it only narrows where to\s+look/,
    'including the half that says what it cannot do — each flag still needs a human ruling');
  // The pointer is the one claim in this section that rots on its own: the tool
  // can move or go away and the prose stays confident. Resolving the path OUT of
  // the prompt (not repeating it here) is what makes this a check rather than a
  // second copy of the same claim — the earlier version cited an untracked
  // ~/.clodex path that existed only on its author's box, which is the exact
  // "documents not in this repo" category the section three paragraphs up tells
  // hands to grep for and verify with git ls-files.
  const cited = hand.match(/Implementation, do not inline it:\s+`([^`]+)`/);
  assert.ok(cited, 'the prompt names its implementation in a form a test can resolve');
  assert.ok(!cited[1].startsWith('~') && !path.isAbsolute(cited[1]),
    `cited tool path must be repo-relative so it resolves for every reader, got: ${cited[1]}`);
  assert.ok(fs.existsSync(path.join(__dirname, '..', cited[1])),
    `the prompt cites a tool that is not in the repo: ${cited[1]}`);
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
  assert.match(hand, /Merging your branch is not yours/, 'hand knows merging is not its job');
  assert.match(lead, /worktree:<branch>/, 'lead prompt names the spawn form that mints the worktree');
  // t524: both prompts told the LEAD to merge by hand, while `_landVerdictOnTicket`
  // queues `_autoMergeTicket` on an ACCEPT and runs a post-merge suite behind it.
  // Obeying the prompt hand-merges ahead of the loop, which then finds the branch
  // already in master and escalates with that suite never run (t514, live). Pinned
  // by MEANING in both directions: the doesNotMatch arms are the reversal, and
  // without them a revert restores a green suite over a contradicted pair.
  assert.match(lead, /An ACCEPT verdict TRIGGERS the merge, and the loop performs it/,
    'lead prompt says the loop merges on ACCEPT');
  assert.doesNotMatch(lead, /YOU merge, and only after the review verdict/,
    'lead prompt must not still claim the lead performs the merge');
  assert.doesNotMatch(hand, /Merging your branch is the lead's/,
    'hand prompt must not still name the lead as the one who merges');
  // The two cases where a lead really does merge must survive the rewrite —
  // "never merge" is as false as "always merge".
  assert.match(lead, /no ticket carries the verdict/,
    'lead prompt keeps the team-review exception where it merges itself');
  assert.match(lead, /escalated AT the merge step/,
    'lead prompt keeps the escalated-at-merge exception where it merges itself');
  // t524, defect 2: this bullet told the lead to remove the worktree by hand
  // while the file's own `task accept` paragraph said accept does it.
  assert.match(lead, /`task accept` is the cleanup/,
    'lead prompt points worktree cleanup at accept, not at the lead');
});

// Stage A of the reviewer-efficiency design, and the two halves are a PAIR that
// only works closed: the hand is told to catch its own orphaned prose before the
// review, and the lead is told not to buy a second cold review over the prose
// that survives. Landing one without the other is worse than neither — A1 alone
// leaves the lead still rejecting ACCEPTs, A2 alone merges prose nothing swept.
// Measured baselines are IN the prompts on purpose (39% of later rounds followed
// an ACCEPT; 15 of 27 later-round findings were a fix falsifying its neighbour):
// a bare instruction reads as taste and is the first thing an agent trades away
// under time pressure. The carve-outs are the load-bearing half of A2 — without
// them it reads as "never reject prose", which would merge a false coverage
// claim, the one kind of prose whose reader cannot check it.
test('seed: Stage A — hands sweep their own hunks, leads let prose nits ride along', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(hand, /Before you close, and again after every rework fix/,
    'A1 fires at both points the fix can falsify a neighbour, not only at close');
  assert.match(hand, /what it now sits BETWEEN/,
    'A1 names the orphaning mechanism: the neighbour breaks, not the line you edited');
  assert.match(lead, /An ACCEPT whose nits are comment or CHANGELOG sentences is an ACCEPT/,
    'A2 states the default: an ACCEPT with prose nits is merged');
  assert.match(lead, /asserting COVERAGE/,
    'A2 keeps carve-out 1 — a false coverage claim is still a reject');
  assert.match(lead, /false USER-FACING claim/,
    'A2 keeps carve-out 2 — a false user-facing CHANGELOG line is still a reject');
  assert.match(lead, /A reject outside those two carve-outs is a process defect on your side/,
    'A2 closes the list: the carve-outs are exhaustive, not examples');
});

// t454: the accept paragraph described a two-outcome verb (merged → cleanup,
// not merged → nothing removed), while `_taskAccept` distinguishes FOUR and the
// two that matter to a lead are indistinguishable by count alone. A lead that
// reads the undecidable reply as "the branch was empty" records a real merge as
// nothing — the exact false report t314 removed from the reply, reintroduced by
// the reader instead of the code. Pinned by MEANING: the substring "accept" was
// present throughout, so only the four-outcome and UNKNOWN-is-not-empty claims
// are evidence the paragraph still briefs the distinction.
test('seed: the lead prompt briefs accept as a four-outcome verb, not a two-outcome one', () => {
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(lead, /four outcomes/,
    'lead prompt says the accept reply distinguishes four outcomes');
  assert.match(lead, /recorded fork point/,
    'lead prompt names the fork point as what makes a count evidence');
  assert.match(lead, /UNKNOWN/,
    'lead prompt names the undecidable outcome by the word the reply uses');
  assert.doesNotMatch(lead, /accept confirms the work merged/,
    'lead prompt must not claim acceptance confirms a merge');
});

// t525: two of the accept paragraph's claims were true only of the easy case,
// and both send the lead somewhere the code does not go. "Merge first, then
// accept again" is right for the two cases where the lead owns the merge and
// wrong in the window right after an ACCEPT, where `_queueAutoMerge` has
// SCHEDULED the merge (its suite-lock arm re-enters through `_scheduleMergeRetry`,
// so the window is minutes) — hand-merging there is the t514 defect t524 removed
// from the other half of this file. And accept's teardown is gated on a clean,
// readable tree: `isDirty` returning dirty OR `ok:false` archives the seat and
// keeps the tree instead. Pinned by MEANING in both directions; the `doesNotMatch`
// arms are the exact prior sentences, so a revert cannot restore a green suite.
//
// The `\s+`s below were written AT wrap points, some still at one. They tolerate
// any run of whitespace — a space, a newline, or a blank line — but nothing
// else, so the words and their order still have to hold. That is deliberate, not
// laxity: the failure they admit is a false RED on a reflow, never a false green
// on a reversal, and a regex loose enough to survive any reflow would stop
// pinning the sentence. Re-wrap the prompt and these move with it.
test('seed: the lead prompt qualifies accept — merge window and the dirty/unreadable downgrade', () => {
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(lead, /UNLESS\s+the ACCEPT verdict is\s+fresh/,
    'lead prompt exempts the fresh-ACCEPT window from "merge first, then accept again"');
  assert.match(lead, /wait for the merge notice instead of merging/,
    'and says what to do in that window instead of merging by hand');
  assert.doesNotMatch(lead, /accept again\.\s+It is separate/,
    'lead prompt must not still tell the lead to merge unconditionally before accepting');
  // t532 moved BOTH teardown-gate pins out of the prose and onto the table that
  // replaced it. The claims are unchanged — teardown needs a clean, readable
  // tree, and the two failing shapes downgrade to an archive that keeps it —
  // but a table states them per ROW, so each is now pinned as a row rather than
  // as a clause. The `doesNotMatch` arms are the exact prose they replaced, so
  // reverting the table goes red here instead of quietly green.
  // t532 r4: the r1 wording had this INVERTED for the common case. `kill()` calls
  // getPersistence().remove() unconditionally BEFORE the tree is touched, and
  // destroy()'s dropRecord closure returns early on `wasLive` precisely because
  // of that — so the keep-on-failure invariant protects only a seat that had
  // ALREADY EXITED. A live seat's record is gone whether or not the removal
  // succeeds, which is the case accept usually hits. The cell said the opposite,
  // and said it in the direction a lead acts on: that the failure documents
  // itself. Pinned in both places it is now stated, cell and bullet.
  assert.match(lead, /\| loop-minted seat, tree clean \(or no tree recorded\) \| RETIRED, record dropped \(kept ONLY if the seat had already exited and the removal then failed\) \| REMOVED \| deleted — refused if that removal failed \|/,
    'lead prompt gates accept\'s full teardown on a loop-minted seat and a clean, readable tree, and scopes the record keep to the dead-seat path');
  assert.doesNotMatch(lead, /record dropped \(kept if the removal fails, so the tree stays named\)/,
    'lead prompt must not still promise the tree stays named after a failed removal');
  assert.doesNotMatch(lead, /\| RETIRED, record dropped \| REMOVED \|/,
    'lead prompt must not still claim the record drop is unconditional');
  // t532 r5: "unconditionally" was itself an absolute of the class this ticket
  // keeps killing — `kill()` returns at `if (!s)` before the remove, so it drops
  // nothing for a seat that already exited. The quantifier is the claim, so it is
  // inside the match and the old wording carries a doesNotMatch.
  assert.match(lead, /`kill\(\)` drops the record for any\s+seat still running, before the tree is touched/,
    'and gives the mechanism, so the live-seat case is not read as an edge case');
  assert.doesNotMatch(lead, /drops the record\s+unconditionally/,
    'lead prompt must not claim kill() drops a record for a seat that already exited');
  // `destroy()` REJECTING (rather than returning ok:false) is caught in
  // _taskAccept with no path, and the reply degrades to "remove it by hand".
  assert.match(lead, /The reply names the path where it has one/,
    'and does not promise a path the rejected-destroy arm cannot supply');
  assert.doesNotMatch(lead, /Either way the\s+reply names the path/,
    'lead prompt must not still promise the path unconditionally');
  assert.match(lead, /copy it out of the reply rather than expecting to find it\s+later/,
    'and tells the lead what to DO about it, which is the only actionable half');
  assert.doesNotMatch(lead, /only where the tree is clean\s+and readable/,
    'lead prompt must not still state the gate as a prose clause');
  assert.match(lead, /\| loop-minted seat, tree DIRTY \| archived, only if still running \| KEPT \| KEPT \|/,
    'and gives the dirty tree its own row: archive conditional, tree and branch kept');
  // t532 r1: `deleteBranch` shells `git branch -d`, which REFUSES while any
  // worktree has the branch checked out — merged or not, and equally when the
  // directory was removed by hand and only the stale registration remains (this
  // path never prunes). Rows 3 and 4 keep the tree, so their delete ordinarily
  // FAILS. Measured, not reasoned. The rows state an attempt; the old cells
  // stated an outcome, and both `doesNotMatch` arms are those exact cells.
  assert.match(lead, /\| loop-minted seat, tree UNREADABLE \| archived, only if still running \| KEPT \| delete ATTEMPTED — usually refused \|/,
    'and the unreadable tree its own, whose delete is an attempt rather than an outcome');
  assert.doesNotMatch(lead, /tree UNREADABLE \| archived, only if still running \| KEPT \| deleted \|/,
    'lead prompt must not still claim the unreadable row deletes the branch outright');
  assert.match(lead, /`git branch -d` refuses to delete a branch that any worktree still has\s+checked out/,
    'and says WHY those deletes fail, so a surviving ref is not read as a bug');
  assert.match(lead, /only `git worktree prune` releases it — which this path never\s+runs/,
    'and covers the removed-by-hand case, where a stale registration blocks it just the same');
  // t532 r2: the branch sentence follows the TREE, not the row, so routing
  // `could NOT be deleted` to "rows 3 and 4" mis-sent row 1's failure sub-case —
  // where the removal failed, the tree is still checked out and the delete is
  // refused identically. Both halves pinned: the rule, and the row-1 cell.
  // t532 r3: the bold rule said "fails" while its own body said "ordinarily
  // fails" — the counter-cases are named above `const del = …` in team-tickets.js
  // (the kept tree may have a different branch checked out, or its registration
  // may have been pruned). The qualifier is pinned INSIDE the match, since the
  // unqualified sentence is the one a hurried lead reads.
  assert.match(lead, /it ordinarily fails wherever the TREE\s+SURVIVED/,
    'lead prompt gives one rule for the attempted branch cells, and does not overstate it');
  assert.doesNotMatch(lead, /and it fails wherever the TREE SURVIVED/,
    'lead prompt must not state that rule without its qualifier');
  // Row 2's KEPT is `del.skipped`, set only for `downgrade.kind === 'dirty'` — a
  // deliberate skip, not a failed attempt, so the rule covers three cells.
  // Named by ROW, not by cell text: only two cells literally read "delete
  // ATTEMPTED" (row 1's reads "deleted — refused if that removal failed"), so
  // "all three ATTEMPTED cells" sent a lead counting the table's words.
  assert.match(lead, /the one rule behind all three cells where a delete is\s+ATTEMPTED — rows 1, 3 and 4/,
    'and scopes it to the attempted rows by number, excluding row 2\'s deliberate skip');
  assert.doesNotMatch(lead, /all three ATTEMPTED cells/,
    'lead prompt must not name those cells by a phrase only two of them carry');
  assert.doesNotMatch(lead, /the one rule behind every branch cell/,
    'lead prompt must not claim that rule covers row 2 as well');
  assert.match(lead, /\| REMOVED \| deleted — refused if that removal failed \|/,
    'and row 1\'s branch cell carries its own failure sub-case');
  assert.doesNotMatch(lead, /\| REMOVED \| deleted \|/,
    'lead prompt must not still claim row 1 always deletes the branch');
  assert.doesNotMatch(lead, /`branch X could NOT be deleted \(…\)` — the ordinary result on rows 3\s+and 4/,
    'and must not still route that sentence to rows 3 and 4 alone');
  // The bare `retired` arm (nothing removed, no tree recorded) is a sentence a
  // lead can receive and the key had no row for it.
  assert.match(lead, /plain `retired` \(the no-tree-recorded half of row 1\)/,
    'the reply key covers the bare retired sentence too');
  assert.doesNotMatch(lead, /ARCHIVES the seat[\s\S]{0,32}and\s+keeps the tree instead/,
    'lead prompt must not still fold the two downgrades into one sentence');
  assert.doesNotMatch(lead, /deletes the branch for you\.\s+Retiring a seat/,
    'lead prompt must not still state accept\'s teardown as unconditional');
  // `archiveIfEphemeral()` runs on BOTH not-merged arms, so "nothing is removed"
  // alone would leave a lead unable to place an archive it can plainly see.
  // t532 r2: `archiveIfEphemeral` gates on `this.sessions.has(seatName)`, so a
  // loop-minted hand that exited after `task done` is NOT archived — it gets
  // "is not running, so nothing was archived". Kept EXACT rather than widened to
  // `[^)]*`: the condition IS the claim being pinned, and a pin that matches the
  // sentence with or without it cannot fail when it goes missing again.
  assert.match(lead, /nothing is removed on any row \(a\s+loop-minted seat is archived, if it is still running\)/,
    'lead prompt notes the archive that still happens when the branch did not merge, and conditions it');
  assert.doesNotMatch(lead, /loop-minted seat is archived\)/,
    'lead prompt must not still state that archive unconditionally');
});

// t529: a THIRD gate sits above the two t525 pinned, and it is the one an
// ordinary lead move reaches. `_taskAccept` wraps the whole destroy in
// `if (seatName && ephemeralSeat)`, where `ephemeralSeat` is `!!(rec &&
// rec.ephemeral)` off the RECORD — so a merged, clean ticket assigned to a
// STANDING seat removes nothing and the reply says LEFT RUNNING. Reachable
// because `_ticketAssigneeSeat` refuses to degrade a worktree pin, so
// reassigning a worktree ticket to a standing role carries the branch across.
//
// The branch is pinned OUT of that gate deliberately: `deleteBranch` runs on the
// standing-seat path too — the skip is only for `dirty` — so a prompt that swept
// the branch in with the seat and the tree would be wrong in the other direction.
//
// Appended as its own test rather than folded into t525's, so both t524's and
// t525's pins keep matching the sentences they were written against. Each
// assertion carries a `doesNotMatch` arm on the EXACT prior text, so reverting
// this commit goes red instead of quietly green.
test('seed: the lead prompt states accept\'s third gate — a standing seat is never torn down', () => {
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  // t532: the gate is now a ROW rather than a trailing clause — the standing
  // row is the one that inspects no tree at all, which is what "only for a seat
  // the loop minted" was asserting.
  assert.match(lead, /\| STANDING assignee, or no record — tree never inspected \| untouched \| KEPT \| delete ATTEMPTED — usually refused \|/,
    'lead prompt gates accept\'s teardown on the seat being one the loop minted');
  assert.doesNotMatch(lead, /tree never inspected \| untouched \| KEPT \| deleted \|/,
    'lead prompt must not still claim the standing row deletes the branch outright');
  // t532 r1: the round-1 wording blamed a missing ref for the absent recovery.
  // The ref usually SURVIVES; what is actually missing is the gate, which no
  // repeat accept can open. Wrong reason, right conclusion — pinned by the reason.
  assert.match(lead, /the teardown gate never opens on a second accept either/,
    'lead prompt gives the structural reason a standing row cannot be cleaned up by accept');
  assert.doesNotMatch(lead, /the ref is gone, so a second accept fails the merge check instead/,
    'lead prompt must not still blame a deleted ref for the missing recovery');
  // The same over-claim lived in the earlier `task accept` bullet; correcting one
  // and not the other would ship a file that contradicts itself.
  assert.match(lead, /only the branch is even\s+attempted/,
    'the earlier accept bullet states the branch delete as an attempt too');
  assert.doesNotMatch(lead, /keeps its seat and its checkout, and only the branch goes/,
    'and must not still claim the branch simply goes');
  assert.doesNotMatch(lead, /only for a seat the loop minted for this ticket/,
    'lead prompt must not still state that gate as a prose clause');
  assert.match(lead, /STANDING assignee keeps its seat and its checkout/,
    'and says what a standing assignee gets instead of a teardown');
  assert.match(lead, /a worktree pin is never degraded/,
    'and names the ordinary lead move that puts a branch on a standing seat');
  assert.doesNotMatch(lead, /but only where the tree is clean\s+and readable\.\s+A DIRTY tree/,
    'lead prompt must not still state the clean+readable pair as the only gates');
});

// t529, item 2: t525's own new sentence over-claimed on two counts, both verified
// at source. The archive is inside `if (this.sessions.has(seatName))`, so a seat
// that already exited gets NO archive — the reply drops to "was NOT retired and
// its worktree was KEPT" off `downgrade.archived`. And "keeps the tree" invites
// the reader to hear "keeps everything", which is false for the BRANCH on the
// unreadable path: the delete is skipped only for `dirty`, precisely so the
// second accept that finishes a dirty tree can still find the ref.
//
// Pinned as two separate claims because the fix is two separate clauses. Merging
// them into one sentence vague enough to cover both is how this defect recurred.
test('seed: the lead prompt qualifies the downgrade — the archive is conditional, the branch is not the tree', () => {
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  // t532 moved both onto the table. The archive's condition now rides in the
  // seat column of the two downgrade rows ("only if still running"), asserted in
  // the t525 test above; what is pinned HERE is the prose that reads the
  // condition back out — which reply sentence a seat that already exited gets.
  assert.match(lead, /archived by nothing: rows 2 and 3 then say `was NOT\s+retired`/,
    'lead prompt conditions the archive on the seat still running');
  assert.doesNotMatch(lead, /ARCHIVES the seat and keeps the tree instead/,
    'lead prompt must not still claim the downgrade always archives');
  assert.doesNotMatch(lead, /ARCHIVES the seat \(if it is still running\)/,
    'lead prompt must not still state the archive condition as a parenthetical');
  assert.match(lead, /"keeps the tree" is never "keeps everything"/,
    'lead prompt warns that keeping the tree is not keeping the branch');
  // t532 r5: r4 gave row 1's record fate a dependence on liveness, which turned
  // the unscoped "never the teardown" into a contradiction of the bullet seven
  // lines above it — a lead reading the absolute concludes the tree stays
  // findable, the exact belief that bullet exists to destroy. Pinned because
  // nothing pinned the headline before, which is why r4 could falsify it.
  assert.match(lead, /Below row 1, liveness changes the SENTENCE, not the teardown/,
    'lead prompt scopes the liveness rule below row 1');
  assert.doesNotMatch(lead, /never the teardown/,
    'lead prompt must not state the liveness rule as an unscoped absolute');
  assert.match(lead, /Row 1's record,\s+above, is the one place liveness decides an OUTCOME/,
    'and names row 1 as the exception rather than leaving the reader to spot it');
  // t532 r1: only row 2 SKIPS the delete. Row 3 attempts one and usually fails,
  // so a ref surviving there is git refusing, not a recovery held open — the
  // round-1 wording ("the unreadable one deletes it") asserted the outcome.
  assert.match(lead, /A ref surviving row 3 is an accident of git's\s+refusal, not a recovery/,
    'and does not present row 3\'s surviving ref as a deliberate keep');
  assert.doesNotMatch(lead, /the dirty one keeps it so that\s+second accept can still find it, the unreadable one deletes it/,
    'lead prompt must not still carry that split as the old prose clause');
});

// t525, item 3: the dispatch self-reminder and the loop's stall nudge overlap,
// and the prompt said nothing about which covers what — so a lead could not tell
// whether its reminder was the only net. Deliberately pinned WITHOUT a duration:
// `TICKET_STALL_MS` is 30m while `TICKET_SUITE_TIMEOUT_MS` derives to 35m, and a
// prompt quoting either number goes stale the moment one moves.
test('seed: the lead prompt splits the stall nudge from the dispatch reminder', () => {
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(lead, /two nets, and neither\s+replaces the other/,
    'lead prompt says the loop nudge and the self-reminder are both live');
  assert.match(lead, /refreshes that clock/,
    'and names what the loop nudge misses: a seat still turning keeps its activity fresh');
});

// t546: t545 corrected this paragraph and landed no pin, so the sentence it
// removed could be reinstated with a green suite — the one correction in this
// neighbourhood without the `match` + exact-prior-text `doesNotMatch` pair the
// t524/t525/t529/t532 tests above all carry.
//
// What the prefix tracks is CLOSING THE TICKET OUT, verified arm by arm against
// the `finish(...)` calls in team-tickets.js: the two `accepted, but` arms are
// the merge check that could not run and the branch that is not merged in; the
// three `accepted —` arms are no-branch-recorded, the MERGE FAILED veto, and
// merged. It is NOT whether another accept is invited (the veto and the dirty
// downgrade invite one and close out anyway) and NOT whether anything was
// removed.
//
// t546 r1: that last point had been written as "the merged arm removes nothing
// when its tree is dirty", which the code falsifies. The dirty skip at
// `team-tickets.js:7328` is reachable only through the `if (seatName &&
// ephemeralSeat)` gate at :7291, so on a STANDING assignee the tree is never
// inspected, `downgrade` stays null, and the delete is attempted whatever the
// tree holds. The prompt already says so at its own "The tree is only inspected
// on the loop-minted rows" bullet, so the clause contradicted the file two
// screens down. The replacement states the rule and routes to the rows instead
// of enumerating: naming the predicate beats extending the list, and a
// three-item list reads as exhaustive at three exactly as a two-item one reads
// as exhaustive at two. The false sentence carries a `doesNotMatch` of its own.
//
// The `doesNotMatch` patterns below take `\s+` at EVERY inter-word gap, not just
// at today's wrap points. A `match` can key to the current wrap because the text
// is there to read; absent text has no wrap, so a revert that reflows across a
// line break would slip a literal-space pattern silently. That narrows the
// escape rather than widening the pin. Same reason the old-clause pattern stops
// before its sentence-final period: a revert that reinstates the list and
// continues the sentence must not pass.
//
// Either way: a reflow is a false red to be fixed in the whitespace, a changed
// claim is a re-pin to be made deliberately.
// t548: the forbid inside the test below used to be a file-wide
// `doesNotMatch(/merged\s+arm\s+removes\s+nothing/)`. It stopped t546 r1's false
// clause, but it forbade the phrase outright, and the phrase has a TRUE scoped
// form: "on row 2 the merged arm removes nothing" is correct, row 2 being the
// loop-minted-plus-dirty row where tree and branch are both KEPT. An author
// writing that got a red suite that named no scope, and would either delete the
// pin (losing the guard) or reword around it (never learning why). So what is
// forbidden here is the phrase UNSCOPED, not the phrase.
//
// A unit is one sentence, cut at table-cell walls and list-item markers as well,
// so scope words in a neighbouring sentence, cell or bullet cannot be read as
// scoping this one. All three carry the same reason: each is edited independently
// of the ones beside it, so scope read across the boundary goes stale silently.
// The bullet cut is not decoration — unpunctuated list items do not end in `.`,
// so without it a true bullet and a false one flatten into ONE unit and the true
// one's `row 2` launders the false one. Whitespace is flattened inside a unit
// before matching — that is this pin's form of the `\s+`-at-every-gap rule above,
// and it covers every gap rather than the gaps someone remembered to write.
//
// `total` counts the phrase across the whole file with whitespace flattened and
// `seen` counts it across the units, so the caller can pin that every occurrence
// reached a unit. A phrase the splitter loses would otherwise vanish into an
// empty `unscoped` and read as a pass. Both are OCCURRENCE counts on purpose:
// comparing a count of units carrying the phrase against `total` reds correct
// text the moment one unit carries two occurrences.
//
// The residual hole is a sentence that names both scope words and then negates
// one ("not only when the seat is loop-minted and the tree dirty"). No phrase
// scan can catch that; the defect actually observed — scope OMITTED — it can.
//
// Every cut errs toward SMALLER units on purpose. A unit that is too small can
// only lose scope it should have kept, which reds a true sentence its author can
// fix by naming the scope where the claim is; a unit that is too large launders a
// false claim green, and nobody is told. When the two trade off, take the red.
function unscopedRemovesNothingClaims(text) {
  const PHRASE = /merged arm removes nothing/i;
  // `i` here and in `scoped` below must agree: a case-sensitive phrase against a
  // case-insensitive scope test makes a sentence-initial "Merged arm removes
  // nothing" invisible to the forbid while its scope words still register.
  const count = (s) => (s.match(new RegExp(PHRASE.source, 'gi')) || []).length;
  const units = text
    .split(/\n[ \t]*\n/)                                  // paragraphs, table blocks
    .flatMap((block) => block.split('|'))                 // one cell never scopes another
    // ...nor does a neighbouring LIST ITEM, for the same reason: an item is edited
    // independently of the items around it. This cut must precede the flatten
    // below, which destroys the newline the marker is anchored to.
    .flatMap((chunk) => chunk.split(/\n[ \t]*(?:[-*+]|\d+[.)])[ \t]+/))
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .flatMap((chunk) => chunk.split(/(?<=[.!?]) /))
    .map((u) => u.trim())
    .filter(Boolean);
  const scoped = (u) => /\brow 2\b/i.test(u) || (/loop-minted/i.test(u) && /dirty/i.test(u));
  return {
    units,
    // `seen` counts OCCURRENCES inside units, never units-carrying-the-phrase. The
    // two differ on correct text — one unit can carry two occurrences — and
    // comparing a unit count to `total` reds a fully scoped, true passage, which
    // is the exact defect this pin exists to remove. Do not reintroduce a
    // units-carrying-the-phrase field for the caller to reach for.
    seen: units.reduce((n, u) => n + count(u), 0),
    total: count(text.replace(/\s+/g, ' ')),
    unscoped: units.filter((u) => PHRASE.test(u) && !scoped(u)),
  };
}
test('seed: the lead prompt splits accept\'s two reply prefixes by whether the ticket closes out', () => {
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(lead, /the arms that do NOT close the ticket out \(the\s+merge check could not run, the branch is not merged in\) open `accepted, but`;/,
    'lead prompt opens the two non-closing arms with `accepted, but`');
  assert.match(lead, /the ones that do \(no branch recorded, the MERGE FAILED veto, merged\) open\s+`accepted —`/,
    'and the three closing-out arms with `accepted —`');
  assert.doesNotMatch(lead, /two\s+arms\s+that\s+invite\s+another\s+accept/,
    'lead prompt must not label the `accepted, but` group by an invitation the veto and the dirty downgrade also carry');
  assert.doesNotMatch(lead, /three\s+terminal\s+ones/,
    'and must not count the other half instead of naming it');
  // Nit 1 (t545 r1): `!m.ok` / `!m.merged` were the only code identifiers in any
  // shipped prompt, and named the half the reader could not resolve without the
  // source while the other half used the row-table's own words. Pinned as an
  // absence so the identifiers cannot come back.
  assert.doesNotMatch(lead, /`!m\.ok`,\s+`!m\.merged`/,
    'lead prompt must not name one half of the split by source identifiers the other half does not use');
  // Nit 2 (t545 r1): the closing clause listed two arms that remove nothing with
  // no quantifier, and a reader arriving from the counted wording could take it
  // as the complete set. The merged arm's dirty downgrade is a third
  // (team-tickets.js: `del.skipped`, tree kept, seat archived), so it is named.
  assert.match(lead, /closing out is not a claim that anything was removed\./,
    'lead prompt states the removal point as a rule rather than an enumeration of arms');
  assert.match(lead, /What a merged arm removes depends on the seat and the tree/,
    'and makes the merged arm\'s teardown depend on the SEAT as well as the tree, since the dirty skip sits behind the loop-minted gate');
  const removesNothing = unscopedRemovesNothingClaims(lead);
  assert.deepStrictEqual(removesNothing.unscoped, [],
    'lead prompt must not claim the merged arm removes nothing without naming the loop-minted scope, and the scope must be named INSIDE the same sentence or table cell — `row 2`, or both `loop-minted` and `dirty`. Unscoped the claim is false: on a standing assignee the tree is never inspected and the delete is attempted whatever the tree holds');
  assert.strictEqual(removesNothing.seen, removesNothing.total,
    'every occurrence of the phrase must land in a sentence unit — one the splitter drops is one the forbid above cannot judge, and it reads as a pass');
  assert.ok(removesNothing.units.some((u) => u.startsWith('What a merged arm removes depends on the seat and the tree')),
    'ENTER: the splitter cuts the live merged-arm sentence out as a unit of its own — the forbid above is an absence, so a splitter that never reached this paragraph would satisfy it silently. Matched by PREFIX: a tail edit to that sentence is the content pin above\'s red to report, not this one\'s. If this fires alone, either the splitter stopped reaching the paragraph or the sentence before it stopped ending in a period');
  assert.doesNotMatch(lead, /no-branch\s+arm\s+has\s+nothing\s+to\s+remove\s+and\s+the\s+veto\s+refuses\s+to\s+remove\s+anything/,
    'lead prompt must not close that clause on the two-item list again');
});

// The forbid above is an ABSENCE over the shipped file, so on the shipped file it
// is green whether the predicate discriminates or not. These fixtures are where it
// is seen to fail: the false clause reddens, the true scoped ones pass, and both
// happen in the same run. Each row carries its own expectation as a literal — the
// predicate must not be re-applied here to compute what it should say.
test('t548: the unscoped `removes nothing` predicate separates the false claim from the true scoped ones', () => {
  const cases = [
    // t546 r1's clause, verbatim and rewrapped — the claim the pin exists to stop.
    ['the merged arm removes nothing either when its tree is dirty.', true],
    ['the merged arm removes\n  nothing either when its tree is dirty.', true],
    ['closing out does not mean anything was removed — the no-branch arm has\n  nothing to remove, the veto refuses to remove anything, and the merged arm\n  removes nothing either when its tree is dirty.', true],
    // Unscoped in every other dress.
    ['A merged arm removes nothing.', true],
    ['The merged arm removes nothing when the tree is dirty.', true],
    // TRUE and scoped — must pass.
    ['On row 2 the merged arm removes nothing.', false],
    ['On a loop-minted seat with a dirty tree the merged arm removes nothing.', false],
    ['| tree DIRTY | on row 2 the merged arm removes nothing — tree and branch are both KEPT |', false],
    // A cell scoped only by its ROW LABEL is flagged, even though a human reads the
    // row as scoping it. Deliberate and conservative: a label is edited independently
    // of the cell beside it, so scope read across a cell wall is scope that can go
    // stale silently — and the author's fix is one word inside the cell that makes
    // the claim. This row is the cost of that choice, stated so it is a decision and
    // not a gap.
    ['| loop-minted seat, tree DIRTY | the merged arm removes nothing |', true],
    // Scope in a NEIGHBOURING unit does not launder the claim.
    ['Row 2 is the loop-minted, dirty one. The merged arm removes nothing.', true],
    ['| loop-minted seat, tree DIRTY | KEPT |\n| the merged arm removes nothing | KEPT |', true],
    // The live sentence, which does not carry the phrase at all.
    ['What a merged arm removes depends on the seat and the tree — read the rows.', false],
    // r1 nit 1: two scoped bullets in one paragraph with no terminal punctuation are
    // ONE unit carrying TWO occurrences. Correct prose, and the version of this pin
    // that counted units rather than occurrences reddened it. Each bullet is scoped
    // on its own, so the list-item cut must NOT change this verdict.
    ['  - on row 2 the merged arm removes nothing\n  - on a loop-minted seat with a dirty tree the merged arm removes nothing\n', false],
    // r2 nit: the same shape with the second bullet FALSE. Unpunctuated items do not
    // end in `.`, so before the list-item cut both flattened into one unit and the
    // first bullet's `row 2` laundered the second — green on a false claim, which is
    // the one outcome this pin may never produce.
    ['  - on row 2 the merged arm removes nothing\n  - the merged arm removes nothing whatever the tree\n', true],
    // Ordered markers cut too, and the laundering direction is what is pinned.
    ['1. on row 2 the merged arm removes nothing\n2. the merged arm removes nothing whatever the tree\n', true],
    // Case: the forbid must see a sentence-initial occurrence, since `scoped` is
    // case-insensitive and a case-sensitive phrase would skip the unit entirely.
    ['Merged arm removes nothing.', true],
  ];
  for (const [text, shouldFlag] of cases) {
    const got = unscopedRemovesNothingClaims(text);
    assert.strictEqual(got.unscoped.length > 0, shouldFlag,
      `${shouldFlag ? 'must be flagged' : 'must pass'}: ${JSON.stringify(text)}`);
    assert.strictEqual(got.seen, got.total,
      `every phrase occurrence must reach a unit: ${JSON.stringify(text)}`);
  }

  // r1 nit 1: every row above expects `seen === total` to HOLD, so the invariant
  // was pinned but never seen to fail — the thing this file's own header warns
  // about for the forbid, one level in. This case is deliberately OUTSIDE the loop
  // and carries its own literal pair: routed through the loop it would assert
  // exactly the equality it exists to falsify.
  const lost = unscopedRemovesNothingClaims('the merged arm removes\n\nnothing.');
  assert.strictEqual(lost.total, 1, 'the phrase is there when the text is flattened whole');
  assert.strictEqual(lost.seen, 0, 'and the splitter loses it across the blank line, so the caller\'s seen === total fires');
  assert.deepStrictEqual(lost.unscoped, [],
    'and it is invisible to the forbid — which is why the count guard, not the forbid, is what catches it');
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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
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
      registryDir: mkTmpRoot('stores-reg-'),
      resourcesDir: path.join(userData, '__no_seed__') });
    assert.strictEqual(again.uiSettings.get().semanticHints, false,
      'a truthy non-boolean must not read as enabled');
  } finally { cleanup(); }
});

// sessions.json's `.bak` is a LAUNCH SNAPSHOT: one write per initStores, taken
// from the on-disk content before that process's first _save mutates it, and
// never refreshed. Real files throughout: the whole mechanism is an fs call
// sequence, and a mocked fs would let a wrong one pass.
function storesOver(userData) {
  const registryDir = mkTmpRoot('stores-reg-');
  return initStores(userData, { log: console, registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__') });
}

test('persistence .bak: snapshotted once from pre-launch content, never refreshed', () => {
  const userData = mkTmpRoot('stores-ud-');
  const bak = path.join(userData, 'sessions.json.bak');
  const PRE_LAUNCH = JSON.stringify([{ name: 'pre', type: 'claude', workspaceId: 'default' }], null, 2);
  fs.writeFileSync(path.join(userData, 'sessions.json'), PRE_LAUNCH);

  const { persistence } = storesOver(userData);
  persistence.upsert({ name: 'first', type: 'claude', workspaceId: 'default' });
  assert.strictEqual(fs.readFileSync(bak, 'utf-8'), PRE_LAUNCH,
    'the first save snapshots the state the process started from');

  persistence.upsert({ name: 'second', type: 'claude', workspaceId: 'default' });
  persistence.setSessionId('first', 's1');
  persistence.remove('pre');
  // Content, not a call count: a mirror that refreshed would leave a .bak that
  // still parses and still looks like a backup, which is exactly the old design.
  assert.strictEqual(fs.readFileSync(bak, 'utf-8'), PRE_LAUNCH,
    'later saves must not advance the snapshot toward the live file');
  assert.deepStrictEqual(persistence.list().map(e => e.name), ['first', 'second'],
    'ENTER: the live file did move, so the assertion above is about a stale .bak and not a dead store');
});

test('persistence .bak: an unparseable sessions.json leaves the existing .bak alone', () => {
  const userData = mkTmpRoot('stores-ud-');
  const bak = path.join(userData, 'sessions.json.bak');
  const GOOD_BAK = JSON.stringify([{ name: 'rescue', type: 'claude', workspaceId: 'default' }], null, 2);
  fs.writeFileSync(bak, GOOD_BAK);
  fs.writeFileSync(path.join(userData, 'sessions.json'), '{ truncated mid-writ');

  const { persistence } = storesOver(userData);
  persistence.upsert({ name: 'added', type: 'claude', workspaceId: 'default' });
  persistence.upsert({ name: 'more', type: 'claude', workspaceId: 'default' });
  assert.strictEqual(fs.readFileSync(bak, 'utf-8'), GOOD_BAK,
    'snapshotting unparseable bytes would destroy the only good copy left');
});

test('persistence .bak: a missing sessions.json makes no snapshot, then or later', () => {
  const userData = mkTmpRoot('stores-ud-');
  const bak = path.join(userData, 'sessions.json.bak');

  const { persistence } = storesOver(userData);
  persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
  assert.strictEqual(fs.existsSync(bak), false, 'first ever launch has nothing to snapshot');

  persistence.upsert({ name: 'b', type: 'claude', workspaceId: 'default' });
  // The flag is set even when the snapshot is skipped: a retry here would catch
  // the file mid-session and back up state this process wrote, not pre-launch state.
  assert.strictEqual(fs.existsSync(bak), false,
    'a skipped snapshot must not be retried once the live file exists');
});

test('persistence: _load still recovers entries from .bak when sessions.json will not parse', () => {
  const userData = mkTmpRoot('stores-ud-');
  fs.writeFileSync(path.join(userData, 'sessions.json.bak'),
    JSON.stringify([{ name: 'rescued', type: 'codex', workspaceId: 'default' }], null, 2));
  fs.writeFileSync(path.join(userData, 'sessions.json'), 'not json at all');

  const { persistence } = storesOver(userData);
  assert.deepStrictEqual(persistence.list().map(e => e.name), ['rescued'],
    'the recovery half of the mechanism is what the snapshot exists to feed');
});
