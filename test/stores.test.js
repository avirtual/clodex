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
const { initStores } = require('../stores');

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
    uiSettings.set({ pendingRebootNotice: { name: 'clodex', at: 1234567890, reason: 'nightly' } });
    assert.deepStrictEqual(uiSettings.get().pendingRebootNotice, { name: 'clodex', at: 1234567890, reason: 'nightly' });
    uiSettings.set({ theme: uiSettings.get().theme }); // unrelated write
    assert.deepStrictEqual(uiSettings.get().pendingRebootNotice, { name: 'clodex', at: 1234567890, reason: 'nightly' });
    // A malformed at/reason is coerced (finite ms | 0, string | ''); a nameless
    // value is rejected to null.
    uiSettings.set({ pendingRebootNotice: { name: 'x', at: 'soon', reason: 42 } });
    assert.deepStrictEqual(uiSettings.get().pendingRebootNotice, { name: 'x', at: 0, reason: '' });
    uiSettings.set({ pendingRebootNotice: { at: 5 } }); // no name
    assert.strictEqual(uiSettings.get().pendingRebootNotice, null);
    // Explicit null is a real clear (one-shot), not "keep".
    uiSettings.set({ pendingRebootNotice: { name: 'y', at: 1, reason: '' } });
    assert.ok(uiSettings.get().pendingRebootNotice);
    uiSettings.set({ pendingRebootNotice: null });
    assert.strictEqual(uiSettings.get().pendingRebootNotice, null);
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
    const stores = initStores(userData, { registryDir });
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
    // Second init is a no-op (blob already renamed) — no re-run, no dup.
    const stores2 = initStores(userData, { registryDir });
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
    fs.writeFileSync(path.join(userData, 'ui-settings.json'), JSON.stringify({
      sandbox: { workDir: '/Users/me/w', webPort: 7999, autoStart: true, mounts: [{ host: '/m', ro: true }] },
    }));
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
