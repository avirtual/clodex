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
const { DEFAULT_BUILTIN_DENY_FLOOR, DEFAULT_SKILL_DENY_FLOOR } = require('../catalogs');
const { expandSkillsOff } = require('../skills-off');
const { shellCapGranted } = require('../peer-shell');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { migrateSeatLayout } = require('../seat-layout');
const { voiceModeOf } = require('../voice-settings');

const filesHolding = (dir, needle) => fs.readdirSync(dir)
  .filter((n) => { try { return fs.readFileSync(path.join(dir, n), 'utf-8').includes(needle); } catch { return false; } });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// Fresh temp userData + registry dirs, and a stores bundle over them. BOTH seed
// sources are pointed at paths that don't exist, so neither the shipped library
// defaults nor the shipped skills pollute the per-store assertions below; the
// seed step has its own dedicated tests that exercise it explicitly.
function freshStores() {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  const stores = initStores(userData, { log: console, registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__'),
    skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
    // The env-scope cases below assert an EMPTY global scope. Left at the real
    // resources/env-defaults.json every one of them would read back the shipped
    // keys instead; test/env-defaults-seed.test.js is where the seeding is
    // exercised, against its own fixture file.
    envDefaultsFile: path.join(registryDir, '__no_env_defaults__.json') });
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

test('persistence: an unreadable sessions.json is not replaced by an upsert', { skip: isRoot && 'root reads a 000 file' }, () => {
  const { stores, cleanup, userData, registryDir } = freshStores();
  const file = path.join(userData, 'sessions.json');
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    stores.persistence.upsert({ name: 'b', type: 'claude', workspaceId: 'default' });
    const again = initStores(userData, { log: console, registryDir,
      resourcesDir: path.join(registryDir, '__no_seed__'),
      skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
      envDefaultsFile: path.join(registryDir, '__no_env_defaults__.json') });
    fs.copyFileSync(file, file + '.bak');
    fs.chmodSync(file, 0o000);
    fs.chmodSync(file + '.bak', 0o000);
    assert.throws(() => fs.readFileSync(file), /EACCES/, 'ENTER: the file is unreadable');
    try { again.persistence.upsert({ name: 'c', type: 'claude', workspaceId: 'default' }); } catch {}
    fs.chmodSync(file, 0o600);
    fs.chmodSync(file + '.bak', 0o600);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf-8')).map((e) => e.name).includes('a'));
  } finally {
    try { fs.chmodSync(file, 0o600); } catch {}
    try { fs.chmodSync(file + '.bak', 0o600); } catch {}
    cleanup();
  }
});

function captureConsoleError(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try { fn(); } finally { console.error = orig; }
  return lines;
}

test('persistence: an unreadable sessions.json makes upsert/remove SKIP, not throw, and warns once', { skip: isRoot && 'root reads a 000 file' }, () => {
  const { stores, cleanup, userData } = freshStores();
  const file = path.join(userData, 'sessions.json');
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    const before = fs.readFileSync(file);
    fs.chmodSync(file, 0o000);
    assert.throws(() => fs.readFileSync(file), /EACCES|EPERM/, 'ENTER: the file is unreadable');
    const lines = captureConsoleError(() => {
      for (let i = 0; i < 2; i++) {
        assert.doesNotThrow(() => stores.persistence.upsert({ name: 'c', type: 'claude', workspaceId: 'default' }));
        assert.doesNotThrow(() => stores.persistence.remove('a'));
        assert.doesNotThrow(() => stores.persistence.setHoldUntil('a', Date.now() + 1000));
      }
    });
    assert.strictEqual(lines.filter((l) => l.includes('not persisted')).length, 1);
    fs.chmodSync(file, 0o600);
    assert.deepStrictEqual(fs.readFileSync(file), before, 'the unreadable file was left byte-for-byte');
  } finally {
    try { fs.chmodSync(file, 0o600); } catch {}
    cleanup();
  }
});

test('persistence: after the file becomes readable again, the warn re-arms', { skip: isRoot && 'root reads a 000 file' }, () => {
  const { stores, cleanup, userData } = freshStores();
  const file = path.join(userData, 'sessions.json');
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    fs.chmodSync(file, 0o000);
    assert.throws(() => fs.readFileSync(file), /EACCES|EPERM/, 'ENTER: the file is unreadable');
    const lines = captureConsoleError(() => {
      stores.persistence.upsert({ name: 'b', type: 'claude', workspaceId: 'default' });
      fs.chmodSync(file, 0o600);
      stores.persistence._load();
      fs.chmodSync(file, 0o000);
      stores.persistence.upsert({ name: 'c', type: 'claude', workspaceId: 'default' });
    });
    assert.strictEqual(lines.filter((l) => l.includes('not persisted')).length, 2);
  } finally {
    try { fs.chmodSync(file, 0o600); } catch {}
    cleanup();
  }
});

test('persistence: an absent primary with an unreadable .bak warns once per launch', { skip: isRoot && 'root reads a 000 file' }, () => {
  const { stores, cleanup, userData } = freshStores();
  const file = path.join(userData, 'sessions.json');
  const bak = file + '.bak';
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    fs.copyFileSync(file, bak);
    fs.unlinkSync(file);
    fs.chmodSync(bak, 0o000);
    assert.throws(() => fs.readFileSync(bak), /EACCES|EPERM/, 'ENTER: the .bak is unreadable');
    const lines = captureConsoleError(() => {
      for (let i = 0; i < 3; i++) {
        stores.persistence.upsert({ name: 'b' + i, type: 'claude', workspaceId: 'default' });
      }
    });
    assert.strictEqual(lines.filter((l) => l.includes('not persisted')).length, 1);
  } finally {
    try { fs.chmodSync(bak, 0o600); } catch {}
    cleanup();
  }
});

test('persistence: _save reports false when the write itself fails, true once it lands', { skip: isRoot && 'root writes a read-only dir' }, () => {
  const { stores, cleanup, userData } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    fs.chmodSync(userData, 0o555);
    let r;
    const lines = captureConsoleError(() => { r = stores.persistence._save([{ name: 'b', type: 'claude', workspaceId: 'default' }]); });
    assert.ok(lines.some((l) => l.includes('persistence save failed')), 'ENTER: the write threw and was swallowed');
    assert.strictEqual(r, false);
    fs.chmodSync(userData, 0o755);
    assert.strictEqual(stores.persistence._save([{ name: 'b', type: 'claude', workspaceId: 'default' }]), true);
  } finally {
    try { fs.chmodSync(userData, 0o755); } catch {}
    cleanup();
  }
});

test('persistence: an ABSENT sessions.json re-arms the not-persisted warn too', { skip: isRoot && 'root reads a 000 file' }, () => {
  const { stores, cleanup, userData } = freshStores();
  const file = path.join(userData, 'sessions.json');
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    fs.chmodSync(file, 0o000);
    const lines = captureConsoleError(() => {
      stores.persistence.upsert({ name: 'b', type: 'claude', workspaceId: 'default' });
      fs.chmodSync(file, 0o600);
      fs.unlinkSync(file);
      stores.persistence._load();
      fs.writeFileSync(file, '[]', { mode: 0o000 });
      fs.chmodSync(file, 0o000);
      stores.persistence.upsert({ name: 'c', type: 'claude', workspaceId: 'default' });
    });
    assert.strictEqual(lines.filter((l) => l.includes('not persisted')).length, 2);
  } finally {
    try { fs.chmodSync(file, 0o600); } catch {}
    cleanup();
  }
});

test('persistence: seat.json mirrors the record beside the seat, and only when the home exists', () => {
  const why = 'the snapshot is what a move-to-peer tars next to the seat dir and what an operator '
    + 'inspecting ~/.clodex/sessions/<name>/ reads. Nothing in v1 reads it back, so the only thing '
    + 'that can keep it honest is this deep-equal against get()';
  const { stores, registryDir, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    const seatFile = path.join(registryDir, 'sessions', 'a', 'seat.json');
    assert.strictEqual(fs.existsSync(seatFile), false,
      'no marker, no seat dir: the store never mkdirs — it is a persistence leaf, not a layout owner');

    migrateSeatLayout({ root: registryDir, names: ['a'], fs });
    assert.ok(fs.existsSync(path.join(registryDir, 'sessions', 'a')),
      'ENTER: migration must have made the home, or the skip below proves nothing');

    stores.persistence.upsert({ name: 'a', sessionId: 's1' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(seatFile, 'utf8')), stores.persistence.get('a'), why);
    assert.ok(fs.readFileSync(seatFile, 'utf8').endsWith('}\n'), '2-space JSON with a trailing newline');

    stores.persistence.upsert({ name: 'b', type: 'codex', workspaceId: 'default' });
    assert.strictEqual(fs.existsSync(path.join(registryDir, 'sessions', 'b', 'seat.json')), false,
      'a seat with no home dir is simply skipped — the store must never create one');
  } finally { cleanup(); }
});

test('persistence: seat.json is refreshed by the name-keyed SETTERS, not upsert alone', () => {
  const why = 'sessionId is the conversation pointer and the field a move-to-peer needs most, and '
    + 'setSessionId never goes through upsert. A snapshot wired into upsert only goes stale on '
    + 'exactly that field while still LOOKING current';
  const { stores, registryDir, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    migrateSeatLayout({ root: registryDir, names: ['a'], fs });
    stores.persistence.upsert({ name: 'a', type: 'claude' });
    const seatFile = path.join(registryDir, 'sessions', 'a', 'seat.json');
    assert.ok(!JSON.parse(fs.readFileSync(seatFile, 'utf8')).sessionId,
      'ENTER: no conversation id in the snapshot yet');

    stores.persistence.setSessionId('a', 's-99');
    assert.strictEqual(JSON.parse(fs.readFileSync(seatFile, 'utf8')).sessionId, 's-99', why);

    stores.persistence.setCwd('a', '/somewhere');
    stores.persistence.setStripLevel('a', 2);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(seatFile, 'utf8')), stores.persistence.get('a'),
      'and the whole record stays in step — a spot check on one setter would read around the other 24');
  } finally { cleanup(); }
});

test('persistence: a failed sessions.json write does not advance seat.json past the record', { skip: isRoot && 'root writes a read-only dir' }, () => {
  const { stores, registryDir, userData, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default' });
    migrateSeatLayout({ root: registryDir, names: ['a'], fs });
    stores.persistence.upsert({ name: 'a', sessionId: 's1' });
    const seatFile = path.join(registryDir, 'sessions', 'a', 'seat.json');
    fs.chmodSync(userData, 0o555);
    const lines = captureConsoleError(() => stores.persistence.setSessionId('a', 's2'));
    assert.ok(lines.some((l) => l.includes('persistence save failed')), 'ENTER: the sessions.json write failed');
    fs.chmodSync(userData, 0o755);
    const seat = JSON.parse(fs.readFileSync(seatFile, 'utf8'));
    assert.strictEqual(seat.sessionId, 's1');
    assert.deepStrictEqual(seat, stores.persistence.get('a'));
  } finally {
    try { fs.chmodSync(userData, 0o755); } catch {}
    cleanup();
  }
});

test('persistence: snapshotSeat rewrites under the NEW name after a rename', () => {
  const { stores, registryDir, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default', sessionId: 's1' });
    migrateSeatLayout({ root: registryDir, names: ['a'], fs });
    stores.persistence.upsert({ name: 'a', sessionId: 's1' });

    assert.strictEqual(stores.persistence.rename('a', 'c'), true);
    fs.renameSync(path.join(registryDir, 'sessions', 'a'), path.join(registryDir, 'sessions', 'c'));
    assert.strictEqual(stores.persistence.snapshotSeat('c'), true);

    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(registryDir, 'sessions', 'c', 'seat.json'), 'utf8')),
      stores.persistence.get('c'),
      'the snapshot names the seat it sits beside — a stale one would tell a move-to-peer the wrong name');
    assert.strictEqual(stores.persistence.snapshotSeat('gone'), false, 'an unknown seat writes nothing');
  } finally { cleanup(); }
});

test('persistence: rename rewrites the entry in place, drops the label, refuses a taken name', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default', sessionId: 's1' });
    stores.persistence.upsert({ name: 'b', type: 'codex', workspaceId: 'default' });
    stores.persistence.setLabel('a', 'My Seat');

    assert.strictEqual(stores.persistence.rename('a', 'b'), false, 'refuses a name already taken');
    assert.strictEqual(stores.persistence.get('a').label, 'My Seat', 'and changes nothing');
    assert.strictEqual(stores.persistence.rename('gone', 'c'), false, 'refuses an unknown seat');

    assert.strictEqual(stores.persistence.rename('a', 'c'), true);
    assert.strictEqual(stores.persistence.get('a'), null);
    // The whole record minus the one field allowed to change: a spot check would
    // read around a rename that dropped sessionId (the conversation).
    assert.deepStrictEqual(stores.persistence.get('c'),
      { name: 'c', type: 'claude', workspaceId: 'default', sessionId: 's1' },
      'same record under the new name, and the label is gone with the old one');
    assert.deepStrictEqual(stores.persistence.list().map(e => e.name), ['c', 'b'],
      'ENTER: rewritten in place — its position in the file did not move');
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

test('uiSettings: a write after a corrupt read neither persists defaults over the stored peers nor grants terminal reports', () => {
  const { stores, cleanup, userData } = freshStores();
  try {
    const { uiSettings } = stores;
    fs.writeFileSync(path.join(userData, 'ui-settings.json'),
      JSON.stringify({ terminalReports: 'off', peerShellEnabled: true, peers: [{ id: 'p1', sshHost: 'h', token: 'SECRET' }] }) + ',');
    assert.strictEqual(uiSettings.get().peers.length, 0, 'ENTER: the corrupt path is taken');
    uiSettings.set({ sidebarFolded: true });
    assert.ok(filesHolding(userData, 'SECRET').length > 0, 'the peer token survives on disk');
    assert.notStrictEqual(uiSettings.get().terminalReports, 'asked');
  } finally { cleanup(); }
});

test('uiSettings: a corrupt ui-settings.json is quarantined once, byte-exact, beside the store', () => {
  const { stores, cleanup, userData } = freshStores();
  try {
    const original = '{"theme":"dark",,}';
    fs.writeFileSync(path.join(userData, 'ui-settings.json'), original);
    stores.uiSettings.get();
    assert.strictEqual(stores.uiSettings.get().terminalReports, 'off', 'a quarantined install is not a new one');
    stores.uiSettings.set({ sidebarFolded: true });
    stores.uiSettings.get();
    const moved = fs.readdirSync(userData).filter((n) => n.startsWith('ui-settings.json.corrupt-'));
    assert.strictEqual(moved.length, 1, `exactly one quarantine file: ${moved}`);
    assert.strictEqual(fs.readFileSync(path.join(userData, moved[0]), 'utf-8'), original);
  } finally { cleanup(); }
});

test('uiSettings: intentSpill ships on, round-trips, and refuses a junk value', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    assert.strictEqual(uiSettings.get().intentSpill, 'on',
      'default ON: the spill is a plain optimization, so it is opt-OUT');
    uiSettings.set({ intentSpill: 'off' });
    assert.strictEqual(uiSettings.get().intentSpill, 'off');
    uiSettings.set({ theme: uiSettings.get().theme });
    assert.strictEqual(uiSettings.get().intentSpill, 'off', 'survives an unrelated write');
    uiSettings.set({ intentSpill: 'maybe' });
    assert.strictEqual(uiSettings.get().intentSpill, 'off',
      'an unknown value keeps the current one rather than silently re-arming a disabled setting');
    uiSettings.set({ intentSpill: 'on' });
    assert.strictEqual(uiSettings.get().intentSpill, 'on');
  } finally { cleanup(); }
});

test('uiSettings: a settings file predating intentSpill reads back ON', () => {
  const { stores, userData, cleanup } = freshStores();
  try {
    const p = path.join(userData, 'ui-settings.json');
    fs.writeFileSync(p, JSON.stringify({ theme: 'midnight' }));
    assert.strictEqual(stores.uiSettings.get().intentSpill, 'on',
      'an absent key is the same answer as on, so an upgrade gets the optimization');
    fs.writeFileSync(p, JSON.stringify({ intentSpill: 'yes please' }));
    assert.strictEqual(stores.uiSettings.get().intentSpill, 'on');
    fs.writeFileSync(p, JSON.stringify({ intentSpill: 'off' }));
    assert.strictEqual(stores.uiSettings.get().intentSpill, 'off',
      'an explicit off is still honoured');
  } finally { cleanup(); }
});

test('uiSettings: sidebarFolded defaults false, reads only a literal true, and survives an unrelated write', () => {
  const { stores, userData, cleanup } = freshStores();
  try {
    const p = path.join(userData, 'ui-settings.json');
    const pair = () => {
      const s = stores.uiSettings.get();
      return { sidebarFolded: s.sidebarFolded, sidebarWidth: s.sidebarWidth };
    };
    assert.deepStrictEqual(pair(), { sidebarFolded: false, sidebarWidth: 220 });
    fs.writeFileSync(p, JSON.stringify({ sidebarFolded: true, sidebarWidth: 300 }));
    assert.deepStrictEqual(pair(), { sidebarFolded: true, sidebarWidth: 300 });
    fs.writeFileSync(p, JSON.stringify({ sidebarFolded: 'yes', sidebarWidth: 300 }));
    assert.deepStrictEqual(pair(), { sidebarFolded: false, sidebarWidth: 300 });
    stores.uiSettings.set({ sidebarFolded: true });
    assert.deepStrictEqual(pair(), { sidebarFolded: true, sidebarWidth: 300 });
    stores.uiSettings.set({});
    assert.deepStrictEqual(pair(), { sidebarFolded: true, sidebarWidth: 300 });
    stores.uiSettings.set({ sidebarFolded: 'no' });
    assert.deepStrictEqual(pair(), { sidebarFolded: true, sidebarWidth: 300 });
    stores.uiSettings.set({ sidebarFolded: false });
    assert.deepStrictEqual(pair(), { sidebarFolded: false, sidebarWidth: 300 });
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

test("uiSettings: a peer's inbox:'claim' mark survives the sanitize round-trip (presence-encoded)", () => {
  const { userData, registryDir, stores, cleanup } = freshStores();
  try {
    stores.uiSettings.set({ peers: [
      { id: 'box', label: 'B', url: 'http://b', inbox: 'claim' },
      { id: 'other', label: 'O', url: 'http://o', inbox: 'yes' },
    ] });
    const claimed = { id: 'box', label: 'B', url: 'http://b', sshHost: null,
      remotePort: 7900, deployFolder: null, inbox: 'claim' };
    const plain = { id: 'other', label: 'O', url: 'http://o', sshHost: null,
      remotePort: 7900, deployFolder: null };
    assert.deepStrictEqual(stores.uiSettings.get().peers, [claimed, plain],
      "inbox:'claim' survives sanitizePeers; any other value is dropped");
    stores.uiSettings.set({ theme: stores.uiSettings.get().theme });
    assert.deepStrictEqual(stores.uiSettings.get().peers, [claimed, plain],
      'and survives a later unrelated set() (no clobber)');
    const reopened = initStores(userData, { log: console, registryDir,
      resourcesDir: path.join(registryDir, '__no_seed__'),
      skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
      envDefaultsFile: path.join(registryDir, '__no_env_defaults__.json') });
    assert.deepStrictEqual(reopened.uiSettings.get().peers, [claimed, plain],
      'the mark is on DISK, so a fresh process still claims the box inbox');
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

test('uiSettings: duplicate peer ids collapse, so a token-less save cannot cross-wire tokens', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [
      { id: 'a', sshHost: 'h1', token: 'T1' },
      { id: 'a', sshHost: 'h2', token: 'T2' },
    ] });
    uiSettings.set({ peers: [{ id: 'a', sshHost: 'h1', label: 'x' }, { id: 'a', sshHost: 'h2' }] });
    const peers = uiSettings.get().peers;
    assert.strictEqual(peers.some((p) => p.sshHost === 'h1' && p.token === 'T2'), false);
    assert.strictEqual(peers.length, 1);
  } finally { cleanup(); }
});

test('uiSettings: a label-less az peer is named by its target, not its bastion', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ peers: [{ id: 'a', az: { bastion: 'b', resourceGroup: 'g', target: 'vm1' } }] });
    assert.strictEqual(uiSettings.get().peers[0].label, 'vm1');
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

test('templates: save refuses a template with no name, and never reads undefined.json as a prior', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    const dir = path.join(registryDir, 'library', 'templates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'undefined.json'), JSON.stringify({ carried: 'x' }));
    assert.ok(fs.existsSync(path.join(dir, 'undefined.json')), 'ENTER: the stray prior exists');
    stores.templates.save({ name: 'fresh', type: 'claude' });
    assert.strictEqual(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, 'fresh.json'), 'utf-8')), 'carried'), false);
    assert.throws(() => stores.templates.save({ type: 'claude' }), /name/);
    assert.throws(() => stores.templates.save({ name: '', type: 'claude' }), /name/);
  } finally { cleanup(); }
});

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
      tools: ['Read', 'Grep'], // the reviewer allowlist — a DIFFERENT key from disabledTools
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

test('templates: a case-only rename keeps exactly one template, under the new casing', (t) => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'Foo', type: 'claude', cwd: '/a' });
    if (!fs.existsSync(tplFile(registryDir, 'FOO'))) { t.skip('case-sensitive filesystem'); return; }
    stores.templates.save({ id: 'Foo', name: 'foo', type: 'claude', cwd: '/a' });
    assert.deepStrictEqual(stores.templates.list().map((x) => x.name), ['foo']);
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

// t674: `tools` joined EDITOR_OWNED when the editor gained a control for it, and
// the CLEAR direction is the one the membership buys. An empty control omits the
// key, and merge-preserve must read that as "the operator unticked everything",
// not as "keep the stored list" — which would make the control unable to widen a
// narrowed reviewer template back to the full cap, silently.
test('templates: save() REMOVES tools when the allowlist control is emptied', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'rv', type: 'claude', cwd: '/a', tools: ['Read'] });
    assert.deepStrictEqual(stores.templates.list()[0].tools, ['Read'], 'ENTER: the narrowed list really was stored');
    stores.templates.save({ id: 'rv', name: 'rv', type: 'claude', cwd: '/a' });
    assert.strictEqual('tools' in stores.templates.list()[0], false,
      'absent, not [] and not the stored list — absent is what accepts the full cap');
  } finally { cleanup(); }
});

test('templates: io round-trips through save/load and is REMOVED when the stream box is cleared', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.templates.saveByName({ name: 'st', type: 'claude', cwd: '/a', io: 'stream' });
    stores.templates.save({ id: 'st', name: 'st', type: 'claude', cwd: '/a', io: 'stream' });
    assert.strictEqual(stores.templates.list()[0].io, 'stream');
    stores.templates.save({ id: 'st', name: 'st', type: 'claude', cwd: '/a' });
    assert.strictEqual('io' in stores.templates.list()[0], false);
  } finally { cleanup(); }
});

test('persistence: setIo writes the entry transport and normalises anything else to pty', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'claude', workspaceId: 'default', io: 'pty' });
    stores.persistence.setIo('a', 'stream');
    assert.strictEqual(stores.persistence.get('a').io, 'stream');
    stores.persistence.setIo('a', 'bogus');
    assert.strictEqual(stores.persistence.get('a').io, 'pty');
    stores.persistence.setIo('missing', 'stream');
    assert.strictEqual(stores.persistence.get('missing'), null);
  } finally { cleanup(); }
});

test('persistence: setVoice round-trips each seat mode and refuses anything else', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.persistence.upsert({ name: 'a', type: 'codex', workspaceId: 'default' });
    stores.persistence.upsert({ name: 'b', type: 'bash', workspaceId: 'default' });
    assert.strictEqual(voiceModeOf(stores.persistence.get('a')), 'tap', 'a seat with no value reads as tap');
    for (const m of ['off', 'tap']) {
      assert.strictEqual(stores.persistence.setVoice('a', m), true);
      assert.strictEqual(stores.persistence.get('a').voice, m);
      assert.strictEqual(voiceModeOf(stores.persistence.get('a')), m);
    }
    stores.persistence.setVoice('a', 'off');
    assert.strictEqual(stores.persistence.setVoice('a', 'loud'), false);
    assert.strictEqual(stores.persistence.setVoice('a', 'hold'), false);
    assert.strictEqual(stores.persistence.get('a').voice, 'off');
    assert.strictEqual(stores.persistence.get('b').voice, undefined, 'one seat\u2019s mode is not another\u2019s');
    assert.strictEqual(stores.persistence.setVoice('missing', 'tap'), false);
    assert.strictEqual(stores.persistence.get('missing'), null);
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
    assert.strictEqual(readSeedState(registryDir)[rel], 'adopted:6e779d3634705ea2ed91ee059566ec7290b305ef850ef3664f6ad2e63a27d5e9', 'adopted current bytes into manifest');
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
    assert.strictEqual(readSeedState(registryDir)[rel], 'adopted:6e779d3634705ea2ed91ee059566ec7290b305ef850ef3664f6ad2e63a27d5e9', 'adopted current bytes despite corrupt prior manifest');
  });
});

test('seed reconcile: an unstamped file the operator owns is never overwritten, however many launches follow', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'SHIPPED');
    stageDest(registryDir, rel, 'OPERATOR');
    const dest = path.join(registryDir, 'library', rel);
    const log = captureLog();

    initStores(userData, { log, registryDir, resourcesDir });
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'OPERATOR', 'launch 1 keeps the operator file');
    assert.strictEqual(readSeedState(registryDir)[rel],
      'adopted:b4da21734593fc93dc34923a2ee7297ba2a02517e475f81c2ed95cce4aa66c18', 'launch 1 stamps it as adopted');

    initStores(userData, { log, registryDir, resourcesDir });
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'OPERATOR', 'launch 2 still keeps the operator file');

    const warns = log.seedWarnings();
    assert.strictEqual(warns.length, 2, 'one seed warning per launch for the withheld update');
    assert.match(warns[1].msg, /lead\.md/, 'the report names the adopted file');
    assert.match(warns[1].msg, /never receive shipped updates/, 'the report says the shipped update is withheld');
  });
});

test('seed reconcile: an adopted file equal to the ship is re-stamped as shipped and takes the next update', () => {
  withSeedDirs(({ userData, registryDir, resourcesDir }) => {
    const rel = path.join('prompts', 'system', 'lead.md');
    fs.mkdirSync(path.join(resourcesDir, 'prompts', 'system'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, rel), 'MINE');
    stageDest(registryDir, rel, 'MINE');
    fs.writeFileSync(seedStatePath(registryDir),
      JSON.stringify({ [rel]: 'adopted:e5558063d447a246aed96606caeec03a22fea2829f46c7d6d9a14679e22bc5de' }));
    const dest = path.join(registryDir, 'library', rel);

    initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'MINE', 'launch 1 writes no content');
    assert.strictEqual(readSeedState(registryDir)[rel],
      'e5558063d447a246aed96606caeec03a22fea2829f46c7d6d9a14679e22bc5de', 'launch 1 re-stamps as the plain shipped hash');

    fs.writeFileSync(path.join(resourcesDir, rel), 'V2');
    initStores(userData, { registryDir, resourcesDir });
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'V2', 'launch 2 takes the newer ship');
    assert.strictEqual(readSeedState(registryDir)[rel],
      '47cfe5eb8ada0e7492d86a6b47dc93e354c32af4a3cf489e0c65067cb48277d9', 'launch 2 stamps the new shipped hash');
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
// home, .claude/CLAUDE.md, is gitignored and absent from every ticket worktree. A
// "default is NONE" that a net-zero gate backs reads as "comment, then trim to
// even", and two hands in a row spent the end of their context doing exactly that
// (operator ruling 2026-09-11). So the hand's instruction is a flat zero, and the
// whole-file category sweep — which cost more than a ticket on a large module — is
// gone; the doesNotMatch arms below are what stops a revert restoring either.
test('seed: shipped team prompts carry the comment rule, in both directions', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.match(hand, /Your diff adds zero comment lines/,
    'hand prompt states the flat zero, not a budget to spend');
  assert.match(hand, /Not net zero — zero/,
    'and rules out the net-zero reading the gate alone invites');
  assert.match(hand, /comment-ratchet\.test\.js/,
    'hand prompt names the gate that backs it');
  assert.match(hand, /docs\/notes\/<module>\.md/,
    'hand prompt gives the escape hatch for a fact the code cannot express');
  assert.match(hand, /renderer-lib-format\.md/,
    'with the worked example of the flattened name, so the hatch does not red on an orphan');
  assert.match(hand, /separators flattened to hyphens/,
    'and the note-naming convention the same gate resolves');
  assert.match(hand, /never by line number/,
    'which carries the line-number rot rule onto notes');
  assert.match(hand, /the neighbour your\s+insertion now sits between/,
    'hand prompt keeps the neighbour check: the sentence that breaks is rarely the one edited');
  assert.match(hand, /Delete what the code no longer backs/,
    'and deletion over qualification as the repair — a rewrite resets apparent freshness unverified');
  assert.match(hand, /Do not sweep the whole file/,
    'hand prompt bounds the check to its own hunks');
  assert.doesNotMatch(hand, /drive it to zero/,
    'the whole-file category sweep is gone from the hand prompt on purpose');
  assert.doesNotMatch(hand, /boundary-check\.js/,
    'and with it the post-cut lint it ran — scripts/boundary-check.js stays in the repo, unrun by hands');
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

// Every hand this week ended a ticket at 180-320k, and the audited one was 58%
// tool results — sed/grep over a 9,900-line module, with the Agent tool loaded
// and unused. The delegate bullet above was already there, so the missing half
// was a bound on what the hand reads ITSELF.
test('seed: the hand prompt bounds what a hand reads into its own context', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.match(hand, /## Tool results/,
    'the budget rule has a section of its own in the system prompt, not a line buried in a bullet');
  assert.match(hand, /never `cat` a file over 200 lines/,
    'with the read ceiling stated as a hard number a hand cannot negotiate');
  assert.match(hand, /end your turn/,
    'and the anti-polling rule names the alternative, since a hand polls when it has nothing else to do');
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
  assert.match(hand, /Commit to your own branch/, 'hand is told to commit to its own branch');
  assert.match(hand, /never push/, 'hand is still barred from pushing');
  assert.match(hand, /Merging your branch is not yours/, 'hand knows merging is not its job');
  assert.match(lead, /worktree:<branch>/, 'lead prompt names the spawn form that mints the worktree');
  // t524: both prompts told the LEAD to merge by hand, while `_landVerdictOnTicket`
  // queues `_autoMergeTicket` on an ACCEPT and runs a post-merge suite behind it.
  // Obeying the prompt hand-merges ahead of the loop, which then finds the branch
  // already in master and escalates with that suite never run (t514, live). Pinned
  // by MEANING in both directions: the doesNotMatch arms are the reversal, and
  // without them a revert restores a green suite over a contradicted pair.
  assert.match(lead, /An ACCEPT verdict triggers the merge and the loop performs it/,
    'lead prompt says the loop merges on ACCEPT');
  assert.doesNotMatch(lead, /YOU merge, and only after the review verdict/,
    'lead prompt must not still claim the lead performs the merge');
  assert.doesNotMatch(hand, /Merging your branch is the lead's/,
    'hand prompt must not still name the lead as the one who merges');
  // The two cases where a lead really does merge must survive the rewrite —
  // "never merge" is as false as "always merge".
  assert.match(lead, /no\s+ticket carries the verdict/,
    'lead prompt keeps the team-review exception where it merges itself');
  assert.match(lead, /escalated at\s+the merge step/,
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
// The carve-outs are the load-bearing half of A2 — without
// them it reads as "never reject prose", which would merge a false coverage
// claim, the one kind of prose whose reader cannot check it.
test('seed: Stage A — hands sweep their own hunks, leads let prose nits ride along', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(hand, /Before you close, and again after\s+every rework fix/,
    'A1 fires at both points the fix can falsify a neighbour, not only at close');
  assert.match(hand, /it is the neighbour your\s+insertion now sits between/,
    'A1 names the orphaning mechanism: the neighbour breaks, not the line you edited');
  assert.match(hand, /5 lines of context/,
    'A1 opens the hunk with the narrow window — 25 lines was a re-read of the file per hunk');
  assert.doesNotMatch(hand, /25 lines of context/,
    'and the wide window is gone, not merely joined by a narrower one');
  assert.match(lead, /the only rework\s+channel/,
    'reject is the one verb that carries rework back to the assignee');
  assert.match(lead, /An\s+ACCEPT whose nits are comment or CHANGELOG prose is\s+merged/,
    'A2 states the default: an ACCEPT with prose nits is merged');
  assert.match(lead, /Reject an ACCEPT only\s+for a false coverage claim/,
    'A2 keeps carve-out 1 — a false coverage claim is still a reject');
  assert.match(lead, /or a false\s+user-facing CHANGELOG line/,
    'A2 keeps carve-out 2 — a false user-facing CHANGELOG line is still a reject');
  assert.match(lead, /any other reject of an ACCEPT is a process defect\s+on your side/,
    'A2 closes the list: the carve-outs are exhaustive, not examples');
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
  assert.match(hand, /is an intent you emit/,
    'the hand is told plainly that task done is an intent, not a command it must be granted');
  assert.match(hand, /not an exec command, it needs no grant/,
    'and the exec-registry confusion is named, since that is the belief a seat actually held');
  assert.match(hand, /A dm carrying your report does not close the ticket/,
    'and that reporting by dm leaves the ticket open');
  assert.match(hand, /indistinguishable from the lead's side/,
    'and why nobody catches it: the report arrives complete either way');
});

const REPO_APPEND_DIR = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'append');
test('seed: the hand prompt compacts on REWORK past 150k, and never at done', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.strictEqual(fs.existsSync(path.join(REPO_APPEND_DIR, 'clodex-hand.md')), false,
    'the hand prompt is one file: no append copy to drift from it');
  assert.match(hand, /~150k/, 'the rework threshold is a literal');
  assert.match(hand, /don't compact mid-ticket or at `done`/,
    'the done carve-out survives — a compact there discards what rework needs');
  assert.match(hand, /JOURNAL\.md and the verdict file/,
    'the pickup note says what it points at, or the compact loses the thread');
  const j = hand.indexOf('journal the branch state');
  assert.ok(j > 0, 'ENTER: the prompt actually contains the journal step being ordered');
  assert.ok(hand.indexOf('[agent:context compact]', j) > j,
    'the compact intent comes AFTER the journal step, not before it');
  assert.doesNotMatch(hand, /^Do not compact\. /m,
    'the flat ban that made a hand work a rework at 300k is gone');
  assert.match(hand, /red-proof every test you add that guards a production change: commit; revert/i,
    'a red-proof commits before it reverts — a revert that reaches uncommitted work destroys it');
});

// The base-commit check is a PAIR: the lead cites the commit, the hand acts on
// the mismatch. Either half alone is inert — a citation nobody checks, or a
// check with nothing to check against.
test('seed: shipped team prompts pair the spec base-commit check', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  const lead = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-lead.md'), 'utf-8');
  assert.match(hand, /merge-base --is-ancestor/, 'hand is given the check to run');
  assert.match(hand, /stop and report/,
    'and told to stop — the failure mode is treating the mismatch as drift and working on');
  assert.match(lead, /Cite the commit your spec was written against/,
    'lead is told to supply the commit the hand checks against');
});

test('seed: the hand prompt delegates lookups and keeps red-proofs on the monitor', () => {
  const hand = fs.readFileSync(path.join(REPO_SYSTEM_DIR, 'clodex-team-hand.md'), 'utf-8');
  assert.match(hand, /Delegate lookups: spawn `clodex-agents:clodex-locate`/,
    'the prompt names what to hand off, and the baked agent that takes it');
  assert.match(hand, /Never delegate an edit or a commit/,
    'and what must stay on the hand itself');
  assert.match(hand, /Never\s+run or delegate a suite glob/,
    'and a suite run is never handed to a subagent either');
  assert.match(hand, /Red-proofs, and any single test-file run, go through the granted monitor/,
    'red-proofs have one route: the monitor');
  assert.match(hand, /never your own shell, never a subagent/,
    'and the two contradicted routes are ruled out by name');
  assert.doesNotMatch(hand, /spawn `clodex-agents:clodex-redproof`/,
    'the subagent red-proof route is gone, not merely joined by the monitor');
  assert.doesNotMatch(hand, /fails ~44 tests/,
    'the stale claim that a raw run always fails ~44 tests on missing deps is gone');
  assert.match(hand, /links `node_modules`\s+into every ticket tree/,
    'the prompt says why a single test file runs as-is in a ticket tree');
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

// t673: the shell reviewer ships as a SECOND template beside the default, and
// the seed is what puts it in reach of `reviewer:<name>` — a template the
// library does not hold is refused at task add.
const REPO_REVIEWER_SHELL_TPL = path.join(__dirname, '..', 'resources', 'library', 'templates', 'clodex-team-reviewer-shell.json');

test('seed (t673): ships the SHELL reviewer template too (byte-exact), with Bash in its tools', () => {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  try {
    const stores = initStores(userData, { registryDir });
    const dest = path.join(registryDir, 'library', 'templates', 'clodex-team-reviewer-shell.json');
    assert.ok(fs.existsSync(dest), 'clodex-team-reviewer-shell.json seeded on construction');
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), fs.readFileSync(REPO_REVIEWER_SHELL_TPL, 'utf-8'),
      'byte-for-byte the shipped template');
    const seeded = stores.templates.list().find((t) => t.name === 'clodex-team-reviewer-shell');
    assert.ok(seeded, 'seeded shell reviewer template is listed');
    assert.strictEqual(seeded.systemPromptFile, 'clodex-team-reviewer-shell',
      'its OWN prompt — pointing at the default prompt would tell the seat it has no shell');
    assert.deepStrictEqual(seeded.intents, []);
    // Bash is the opt-in. Without it in `tools` the resolver admits no shell and
    // this template is the default reviewer wearing a different name.
    assert.deepStrictEqual(seeded.tools, ['Read', 'Grep', 'Glob', 'Bash']);
    assert.deepStrictEqual(seeded.env, {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', FORCE_PROMPT_CACHING_5M: '1', CLODEX_DISABLE_IPC_PROMPT: '1',
      CLODEX_SPAWNER_HINT: 'off', CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
    });

    // The DEFAULT is untouched by the experiment — the whole premise is that it
    // stays available as the fallback.
    const dflt = stores.templates.list().find((t) => t.name === 'clodex-team-reviewer');
    assert.deepStrictEqual(dflt.tools, ['Read', 'Grep', 'Glob'], 'the default reviewer gains no shell');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('seed (t673): the shell reviewer PROMPT ships, and differs from the default in exactly the shell paragraph', () => {
  const dir = path.join(__dirname, '..', 'resources', 'library', 'prompts', 'system');
  const dflt = fs.readFileSync(path.join(dir, 'clodex-team-reviewer.md'), 'utf-8').split('\n');
  const shell = fs.readFileSync(path.join(dir, 'clodex-team-reviewer-shell.md'), 'utf-8').split('\n');
  assert.ok(shell.some((l) => /YOUR SHELL IS TRUSTED/.test(l)), 'the shell seat is told it has one');
  assert.ok(!shell.some((l) => /YOU HAVE NO SHELL/.test(l)), 'and is NOT also told it has none');
  assert.ok(dflt.some((l) => /YOU HAVE NO SHELL/.test(l)), 'ENTER: the default still says the opposite — the two prompts really do differ here');
  // The gap no deny rule can close. A prompt that only listed the denied verbs
  // would leave the seat believing the CLI stops every write, which for a
  // redirection it does not.
  assert.ok(shell.some((l) => /Never redirect into a file/.test(l)),
    'the shell seat OWNS redirections — `>` is shell syntax, not argv, so no deny rule matches it');

  // The verdict grammar is the reviewer's contract with the ticket loop, and it
  // must be word-for-word identical or the two arms of the A/B are not
  // comparable. Compared as the TAIL both files share rather than by grepping
  // for a phrase: a paragraph dropped from the shell copy would still pass a
  // grep for the phrases that remain.
  const tailFrom = (lines, marker) => {
    const i = lines.findIndex((l) => l.includes(marker));
    assert.ok(i > 0, `ENTER: the marker ${marker} was found — otherwise the tail compared is empty`);
    return lines.slice(i).join('\n');
  };
  assert.strictEqual(tailFrom(shell, 'ISSUE INDEPENDENT CALLS TOGETHER'), tailFrom(dflt, 'ISSUE INDEPENDENT CALLS TOGETHER'),
    'everything from the next bullet onward is byte-identical, verdict grammar included');
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

test('workspaces: an unparseable workspaces.json is not overwritten by list()', () => {
  const { stores, cleanup, userData } = freshStores();
  try {
    const { workspaces } = stores;
    workspaces.upsert({ id: 'default', name: 'Workspace', bounds: null });
    workspaces.upsert({ id: 'ws-2', name: 'Trading' });
    const file = path.join(userData, 'workspaces.json');
    const text = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, text.slice(0, text.lastIndexOf(']')) + ',]');
    assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf-8')), 'ENTER: the file is unparseable');
    workspaces.list();
    assert.ok(filesHolding(userData, 'Trading').length > 0, 'the Trading record survives on disk');
  } finally { cleanup(); }
});

test('workspaces: an unreadable workspaces.json still resolves the default through get() as list() does', { skip: isRoot && 'root reads a 000 file' }, () => {
  const { stores, cleanup, userData } = freshStores();
  const file = path.join(userData, 'workspaces.json');
  try {
    const { workspaces } = stores;
    workspaces.upsert({ id: 'ws-2', name: 'Trading' });
    fs.chmodSync(file, 0o000);
    assert.throws(() => fs.readFileSync(file), /EACCES/, 'ENTER: the file is unreadable');
    const listed = workspaces.list();
    assert.deepStrictEqual(workspaces.get('default'), listed[0]);
    assert.deepStrictEqual(workspaces.sortedByRecent().map((w) => w.id), ['default']);
    assert.throws(() => workspaces.touch('default'), /refusing to save/);
    fs.chmodSync(file, 0o600);
    assert.ok(filesHolding(userData, 'Trading').length > 0, 'the Trading record survives on disk');
  } finally {
    try { fs.chmodSync(file, 0o600); } catch {}
    cleanup();
  }
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

test('workspaces: setView keeps a stored activeSession across a later expandedPeers patch', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.workspaces.list();
    stores.workspaces.setView('default', { activeSession: 'Codex' });
    assert.strictEqual(stores.workspaces.get('default').view.activeSession, 'Codex');

    stores.workspaces.setView('default', { expandedPeers: ['peer-a'] });
    assert.deepStrictEqual(stores.workspaces.get('default').view, {
      activeSession: 'Codex', expandedPeers: ['peer-a'],
    });

    stores.workspaces.setView('default', { group: 'project', status: 'all' });
    assert.strictEqual(stores.workspaces.get('default').view.activeSession, 'Codex');

    stores.workspaces.setView('default', { activeSession: 'clodex-hand-987' });
    assert.strictEqual(stores.workspaces.get('default').view.activeSession, 'clodex-hand-987');
    assert.deepStrictEqual(stores.workspaces.get('default').view.expandedPeers, ['peer-a']);
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
    // By NAME, not "the first append row": this construction seeds too, and
    // `list()` sorts, so a shipped append prompt sorting ahead of the migrated
    // one silently became the row every assertion below read.
    const migrated = stores.promptLibrary.list().find(p => p.kind === 'append' && p.name === 'my-prompt');
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

test('agentDefaults: a seat named __proto__ cannot reach Object.prototype', () => {
  const { stores, cleanup } = freshStores();
  try {
    const d = stores.agentDefaults;
    d.setStrip('__proto__', 2);
    assert.strictEqual(({}).strip, undefined);
    assert.strictEqual(d.getStrip('other'), 0);
  } finally { delete Object.prototype.strip; cleanup(); }
});

test('agentDefaults: the skill and built-in deny tri-states, and what each one filters', () => {
  const { stores, cleanup } = freshStores();
  try {
    const d = stores.agentDefaults;

    // Skills: a non-empty floor (t913 — it WAS `[]`, which made the New Session
    // Mode selector a no-op for the whole skills category on a fresh root: both
    // modes rendered the same empty deny set), and the list is NOT
    // catalog-filtered — a project-only skill exists under one cwd and must
    // survive being stored from anywhere else.
    assert.deepStrictEqual(d.getDefaultSkillDeny(), DEFAULT_SKILL_DENY_FLOOR,
      'absent key -> the shipped floor');
    assert.ok(DEFAULT_SKILL_DENY_FLOOR.length > 0,
      'an empty floor is indistinguishable from standard mode — the defect t913 fixed');
    d.setDefaultSkillDeny(['code-review', 'a-project-only-skill', 'code-review']);
    assert.deepStrictEqual(d.getDefaultSkillDeny().sort(),
      ['a-project-only-skill', 'code-review'], 'deduped, and the unknown name is KEPT');
    d.setDefaultSkillDeny([]);
    assert.deepStrictEqual(d.getDefaultSkillDeny(), [], 'PRESENT-empty means deny nothing, not the floor');

    // Built-ins: a non-empty floor, filtered against BUILTIN_AGENTS.
    assert.deepStrictEqual(d.getDefaultBuiltinDeny(), DEFAULT_BUILTIN_DENY_FLOOR,
      'absent key -> the shipped floor');
    assert.ok(!DEFAULT_BUILTIN_DENY_FLOOR.includes('Explore')
      && !DEFAULT_BUILTIN_DENY_FLOOR.includes('general-purpose'),
      'the floor is "everything but Explore and general-purpose"');
    d.setDefaultBuiltinDeny(['Plan', 'NotAnAgent', 'Explore']);
    assert.deepStrictEqual(d.getDefaultBuiltinDeny().sort(), ['Explore', 'Plan'],
      'unknown agent filtered out');
    d.setDefaultBuiltinDeny([]);
    assert.deepStrictEqual(d.getDefaultBuiltinDeny(), [],
      'PRESENT-empty means deny nothing, not the floor');

    // All three sets live on the same "*" entry, so writing one must not clear
    // the others — the failure a per-key store would never have.
    d.setDefaultDeny(['Bash']);
    d.setDefaultSkillDeny(['code-review']);
    d.setDefaultBuiltinDeny(['Plan']);
    assert.deepStrictEqual(d.getDefaultDeny(), ['Bash']);
    assert.deepStrictEqual(d.getDefaultSkillDeny(), ['code-review']);
    assert.deepStrictEqual(d.getDefaultBuiltinDeny(), ['Plan']);
  } finally { cleanup(); }
});

function skillUpgradeStores(known) {
  const userData = mkTmpRoot('stores-ud-');
  const registryDir = mkTmpRoot('stores-reg-');
  const stores = initStores(userData, { log: console, registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__'),
    skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
    envDefaultsFile: path.join(registryDir, '__no_env_defaults__.json'),
    knownSkillNames: () => known.slice() });
  return { userData, stores, file: path.join(userData, 'agent-defaults.json'),
    cleanup() {
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    } };
}

test('t950: a stored explicit skill deny is upgraded to the deferred form, keeping exactly what it enabled', () => {
  const KNOWN = ['code-review', 'design', 'dataviz', 'review'];
  const { stores, file, cleanup } = skillUpgradeStores(KNOWN);
  try {
    const d = stores.agentDefaults;
    d.setDefaultSkillDeny(['design', 'review']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8'))['*'].denySkills,
      ['design', 'review'],
      'ENTER: the explicit pre-t918 shape really is on disk — an already-deferred store upgrades nothing');

    const got = d.getDefaultSkillDeny();
    assert.deepStrictEqual(got, ['*', '!code-review', '!dataviz'],
      'known minus denied becomes the keep list, in known order');

    const late = expandSkillsOff(got, { known: [...KNOWN, 'anthropic-skills-synced'] });
    assert.ok(late.includes('anthropic-skills-synced'),
      'a skill synced after the choice was made is denied without anyone unchecking a box');
    assert.ok(!late.includes('code-review') && !late.includes('dataviz'),
      'and the skills that list had ENABLED are still enabled — an upgrade that denies them is not the same choice');
    assert.ok(late.includes('design') && late.includes('review'),
      'the two it denied stay denied');

    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8'))['*'].denySkills, got,
      'the upgraded form is written back');
  } finally { cleanup(); }
});

for (const [mode, breakIt] of [
  ['unreadable', (f) => fs.chmodSync(f, 0o000)],
  ['quarantined', (f) => fs.writeFileSync(f, '{not json')],
]) {
  test(`t950: the skill-deny upgrade does not run against a skills-seen record it could not read (${mode})`, { skip: isRoot && mode === 'unreadable' && 'root reads a 000 file' }, () => {
    const userData = mkTmpRoot('stores-ud-');
    const registryDir = mkTmpRoot('stores-reg-');
    const seenFile = path.join(userData, 'skills-seen.json');
    let stores = null;
    stores = initStores(userData, { log: console, registryDir,
      resourcesDir: path.join(registryDir, '__no_seed__'),
      skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
      envDefaultsFile: path.join(registryDir, '__no_env_defaults__.json'),
      knownSkillNames: () => ['builtin-a', 'builtin-b', ...stores.skillsSeen.list()] });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      stores.skillsSeen.record(['synced-a', 'synced-b']);
      stores.agentDefaults.setDefaultSkillDeny(['synced-a']);
      breakIt(seenFile);
      captureConsoleError(() => assert.deepStrictEqual(stores.skillsSeen.list(), [], 'ENTER: the record is lost to this read'));
      let got;
      captureConsoleError(() => { got = stores.agentDefaults.getDefaultSkillDeny(); });
      assert.deepStrictEqual(got, ['synced-a']);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'agent-defaults.json'), 'utf-8'))['*'].denySkills, ['synced-a']);
    } finally {
      console.warn = origWarn;
      try { fs.chmodSync(seenFile, 0o600); } catch {}
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });
}

test('t950: an already-deferred store is returned verbatim and the file is never rewritten', () => {
  const { stores, file, cleanup } = skillUpgradeStores(['code-review', 'design', 'dataviz']);
  try {
    const d = stores.agentDefaults;
    const raw = '{\n    "*": {\n        "denySkills": [\n            "*",\n            "!dataviz"\n        ]\n    }\n}\n';
    fs.writeFileSync(file, raw);
    const before = fs.statSync(file).mtimeMs;

    assert.deepStrictEqual(d.getDefaultSkillDeny(), ['*', '!dataviz'], 'returned as stored');
    assert.deepStrictEqual(d.getDefaultSkillDeny(), ['*', '!dataviz'], 'and again — the read is idempotent');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), raw,
      'byte-identical: a getter that rewrites a deferred list re-freezes it against today\'s catalog');
    assert.strictEqual(fs.statSync(file).mtimeMs, before, 'and the file was not touched');

    d.setDefaultSkillDeny(['design']);
    const first = d.getDefaultSkillDeny();
    const afterUpgrade = fs.readFileSync(file, 'utf-8');
    const upgradedAt = fs.statSync(file).mtimeMs;
    assert.deepStrictEqual(d.getDefaultSkillDeny(), first, 'the second read returns the upgraded list unchanged');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), afterUpgrade, 'and rewrites nothing');
    assert.strictEqual(fs.statSync(file).mtimeMs, upgradedAt, 'idempotent on disk too');
  } finally { cleanup(); }
});

test('t950: an explicit EMPTY list stays empty — "deny nothing" is not "keep everything known"', () => {
  const { stores, file, cleanup } = skillUpgradeStores(['code-review', 'design']);
  try {
    const d = stores.agentDefaults;
    d.setDefaultSkillDeny([]);
    assert.deepStrictEqual(d.getDefaultSkillDeny(), [],
      'an explicit [] means deny nothing, upgrade or no upgrade');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8'))['*'].denySkills, [],
      'and nothing was written over it');
    assert.deepStrictEqual(expandSkillsOff(d.getDefaultSkillDeny(), { known: ['code-review', 'later'] }), [],
      'so a skill synced later is still enabled — that is what "deny nothing" has to mean');
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

test('renameWorkspaceScope: a new name with quotes or a newline is refused, leaving the frontmatter intact', () => {
  const { registryDir, stores, cleanup } = freshStores();
  try {
    const src = '---\ndescription: d\nworkspace: old\n---\nb';
    stores.agentLibrary.save('a1', src);
    const file = path.join(registryDir, 'agents', 'a1.md');
    const before = fs.readFileSync(file, 'utf-8');
    assert.match(before, /workspace: old/, 'ENTER: the scoped file is on disk');
    for (const to of ['"quoted"', "'single'", '"', "'", 'new\nsessions: victim', 'new\rsessions: victim', 'new\u2028sessions: victim', 'new\u2029sessions: victim']) {
      assert.strictEqual(stores.renameWorkspaceScope('old', to), 0, JSON.stringify(to));
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, JSON.stringify(to));
    }
    assert.strictEqual(stores.renameWorkspaceScope('old', 'a: b'), 1, 'a plain name still rescopes');
    stores.workspaces.list();
    assert.throws(() => stores.workspaces.setName('default', 'new\nsessions: victim'), /control/);
    assert.throws(() => stores.workspaces.setName('default', 'tab\there'), /control/);
    assert.throws(() => stores.workspaces.setName('default', 'new\u2028sessions: victim'), /control/);
    assert.throws(() => stores.workspaces.setName('default', 'new\u2029sessions: victim'), /control/);
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

test('uiSettings: sanitizeBoxRef rows through a box config ref', () => {
  const rows = [
    ['a b', null],
    ['$(x)', null],
    ['x'.repeat(129), null],
    ['feature/x', 'feature/x'],
    [' master ', 'master'],
  ];
  for (const [ref, want] of rows) {
    const { stores, cleanup } = freshStores();
    try {
      stores.uiSettings.set({ boxes: [{ id: 'sandbox', label: 'sandbox', config: { ref } }] });
      assert.strictEqual(stores.uiSettings.get().boxes[0].config.ref, want, JSON.stringify(ref));
    } finally { cleanup(); }
  }
});

test('uiSettings: sanitizeSidePaneWidth rows', () => {
  const rows = [[319, null], [10001, null], [480.5, null], [320, 320], [10000, 10000]];
  for (const [px, want] of rows) {
    const { stores, cleanup } = freshStores();
    try {
      stores.uiSettings.set({ sidePaneWidth: px });
      assert.strictEqual(stores.uiSettings.get().sidePaneWidth, want, String(px));
    } finally { cleanup(); }
  }
});

test('uiSettings: sanitizeRecentCwdsByWorkspace caps at 12 strings, drops non-array lists, and a top-level array loads as {}', () => {
  const { stores, cleanup, userData } = freshStores();
  try {
    const cwds = Array.from({ length: 13 }, (_, i) => `/c${i}`);
    stores.uiSettings.set({ recentCwdsByWorkspace: { ws: [...cwds.slice(0, 5), 7, ...cwds.slice(5)], other: 'nope' } });
    assert.deepStrictEqual(stores.uiSettings.get().recentCwdsByWorkspace, {
      ws: ['/c0', '/c1', '/c2', '/c3', '/c4', '/c5', '/c6', '/c7', '/c8', '/c9', '/c10', '/c11'],
    });
    stores.uiSettings.set({ recentCwdsByWorkspace: ['/c0'] });
    assert.deepStrictEqual(Object.keys(stores.uiSettings.get().recentCwdsByWorkspace), ['ws']);
    const file = path.join(userData, 'ui-settings.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), recentCwdsByWorkspace: ['/c0'] }));
    assert.deepStrictEqual(stores.uiSettings.get().recentCwdsByWorkspace, {});
  } finally { cleanup(); }
});

test('uiSettings: sanitizePeerNameMap drops bad names; an emptied list is dropped for peerAttached, kept for peerVisible', () => {
  const rows = [
    ['peerAttached', { p: ['ok', '..', 'a/b', 'x'.repeat(65)] }, { p: ['ok'] }],
    ['peerAttached', { p: ['..'] }, {}],
    ['peerVisible', { p: ['..'] }, { p: [] }],
  ];
  for (const [key, input, want] of rows) {
    const { stores, cleanup } = freshStores();
    try {
      stores.uiSettings.set({ [key]: input });
      assert.deepStrictEqual(stores.uiSettings.get()[key], want, `${key} ${JSON.stringify(input)}`);
    } finally { cleanup(); }
  }
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
    ['cliDir', 'contextsPath', 'load', 'loadOrEmpty', 'resolve', 'save', 'validateEntry']);
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

test('reminders: add throws when the write itself fails, so the remind intent can bounce', { skip: isRoot && 'root writes a read-only dir' }, () => {
  const { stores, userData, cleanup } = freshStores();
  try {
    stores.reminders.add({ agent: 't1', kind: 'in', spec: 'in 5m', nextFireAt: Date.now() + 3e5 });
    fs.chmodSync(userData, 0o555);
    const lines = captureConsoleError(() => {
      assert.throws(() => stores.reminders.add({ agent: 't1', kind: 'in', spec: 'in 5m', nextFireAt: Date.now() + 3e5 }));
    });
    assert.ok(lines.some((l) => l.includes('reminders save failed')), 'ENTER: the write failed');
    assert.strictEqual(stores.reminders.listForAgent('t1').length, 1);
    const id = stores.reminders.list()[0].id;
    captureConsoleError(() => {
      assert.doesNotThrow(() => stores.reminders.markFired(id, Date.now(), null));
      assert.doesNotThrow(() => stores.reminders.remove(id));
    });
  } finally {
    try { fs.chmodSync(userData, 0o755); } catch {}
    cleanup();
  }
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

test('reminders: renameAgent re-points one agent\'s rows and leaves the rest', () => {
  const { stores, cleanup } = freshStores();
  try {
    const a = stores.reminders.add({ agent: 't1', kind: 'in', spec: 'in 1h', body: 'a', nextFireAt: 500 });
    stores.reminders.add({ agent: 't2', kind: 'in', spec: 'in 2h', body: 'b' });
    assert.strictEqual(stores.reminders.renameAgent('t1', 't3'), 1, 'one row moved');
    assert.deepStrictEqual(stores.reminders.listForAgent('t1'), [], 'nothing answers to the old name');
    // The WHOLE row, not just its agent: a rename that rebuilt the record would
    // drop nextFireAt and the reminder would never fire again.
    assert.deepStrictEqual(stores.reminders.listForAgent('t3'), [{ ...a, agent: 't3' }]);
    assert.deepStrictEqual(stores.reminders.listForAgent('t2').map(r => r.body), ['b']);
    assert.strictEqual(stores.reminders.renameAgent('nobody', 't4'), 0, 'an agent with no rows moves nothing');
    assert.deepStrictEqual(stores.reminders.listForAgent('t4'), []);
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

test('notifications: add throws, and emits nothing, when the write itself fails', { skip: isRoot && 'root writes a read-only dir' }, () => {
  const { stores, userData, cleanup } = freshStores();
  try {
    stores.notifications.add({ from: 'a', body: 'first' });
    const kinds = [];
    stores.notifications.onChange((p) => kinds.push(p.kind));
    fs.chmodSync(userData, 0o555);
    const lines = captureConsoleError(() => {
      assert.throws(() => stores.notifications.add({ from: 'b', body: 'x' }));
    });
    assert.ok(lines.some((l) => l.includes('notifications save failed')), 'ENTER: the write failed');
    assert.deepStrictEqual(kinds, []);
    assert.strictEqual(stores.notifications.list().length, 1);
  } finally {
    try { fs.chmodSync(userData, 0o755); } catch {}
    cleanup();
  }
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
      autoStart: false, image: null, ref: null, mounts: [],
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
        wirePort: 7840, autoStart: true, image: 'my/img:tag', ref: 'feature/x',
        mounts: [{ host: '/Users/me/ref', ro: true, container: '/home/clodex/ref' }],
      } },
    ] });
    const boxes = Object.fromEntries(uiSettings.get().boxes.map((b) => [b.id, b]));
    assert.strictEqual(boxes.proj.label, 'My Project');
    assert.deepStrictEqual(boxes.proj.config, {
      workDir: '/Users/me/work', webPort: 7830, wirescopePort: 7831,
      wirePort: 7840, autoStart: true, image: 'my/img:tag', ref: 'feature/x',
      mounts: [{ host: '/Users/me/ref', ro: true, container: '/home/clodex/ref' }],
    });
    // The shared box's blank config fills to DEFAULT_SANDBOX_CONFIG.
    assert.deepStrictEqual(boxes.sandbox.config, {
      workDir: null, webPort: 7810, wirescopePort: 7811, wirePort: 7820,
      autoStart: false, image: null, ref: null, mounts: [],
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

test('uiSettings: a fallback box config never shares its mounts array with the module default', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { uiSettings } = stores;
    uiSettings.set({ boxes: [{ id: 'a', label: 'a' }] }).boxes[0].config.mounts.push({ host: '/poison', ro: false });
    uiSettings.set({ boxes: [{ id: 'b', label: 'b' }] });
    assert.deepStrictEqual(uiSettings.get().boxes[0].config.mounts, []);
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
      ref: '../escape',         // traversal → null (never reaches `git worktree add`)
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
      autoStart: false, image: null, ref: null,
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

for (const key of ['__proto__', 'constructor', 'prototype']) {
  test(`envScopes: an env KEY named ${key} is refused as reserved`, () => {
    const { stores, cleanup } = freshStores();
    try {
      const { envScopes } = stores;
      envScopes.set('global', 'KEEP', 'v', false);
      const prior = envScopes.getScope('global');
      assert.throws(() => envScopes.set('global', key, 'x', false), new RegExp(`^Error: env key "${key}" is not allowed \\(reserved name\\)$`));
      const scopeAfter = envScopes.getScope('global');
      assert.deepStrictEqual(Object.getPrototypeOf(scopeAfter), Object.prototype, 'ENTER: the scope object kept its prototype');
      assert.deepStrictEqual(scopeAfter, { KEEP: { value: 'v', secret: false } });
      assert.deepStrictEqual(scopeAfter, prior);
    } finally { cleanup(); }
  });
}

test('envScopes: __PROTO (no trailing underscores) is still an ordinary key', () => {
  const { stores, cleanup } = freshStores();
  try {
    stores.envScopes.set('global', '__PROTO', 'x', false);
    assert.deepStrictEqual(stores.envScopes.getScope('global'), { __PROTO: { value: 'x', secret: false } });
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

test('envScopes: a scope stored as null heals on set and is skipped by remove', () => {
  const { stores, cleanup, userData } = freshStores();
  const file = path.join(userData, 'env-scopes.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ global: {}, workspaces: { ws1: null } }));
    assert.doesNotThrow(() => stores.envScopes.remove('ws1', 'K'));
    fs.writeFileSync(file, JSON.stringify({ global: {}, workspaces: { ws1: null } }));
    stores.envScopes.set('ws1', 'K', 'v', false);
    assert.deepStrictEqual(stores.envScopes.getScope('ws1'), { K: { value: 'v', secret: false } });
  } finally { cleanup(); }
});

test('envScopes: an inherited member name as scope neither pollutes a built-in nor reports a phantom save', () => {
  const { stores, cleanup } = freshStores();
  try {
    const { envScopes } = stores;
    try { envScopes.set('toString', 'K', 'v', false); } catch {}
    assert.strictEqual(Object.prototype.toString.K, undefined);
    assert.strictEqual(typeof envScopes.getScope('valueOf'), 'object');
    assert.deepStrictEqual(envScopes.getScope('toString'), { K: { value: 'v', secret: false } });
  } finally {
    delete Object.prototype.toString.K;
    cleanup();
  }
});

test('envScopes: the store file is written 0600 (secret store)', () => {
  const { stores, userData, cleanup } = freshStores();
  try {
    stores.envScopes.set('global', 'K', 'v', false);
    const st = fs.statSync(path.join(userData, 'env-scopes.json'));
    assert.strictEqual(st.mode & 0o777, 0o600, 'env-scopes.json is 0600');
  } finally { cleanup(); }
});

test('envScopes: set() throws when the save fails, so the settings pane cannot report ok', { skip: isRoot && 'root writes a 0500 dir' }, () => {
  const { stores, cleanup, userData } = freshStores();
  try {
    fs.chmodSync(userData, 0o500);
    assert.throws(() => stores.envScopes.set('global', 'K', 'v', false), /EACCES|EPERM/);
    assert.deepStrictEqual(stores.envScopes.getScope('global'), {}, 'ENTER: nothing was written');
  } finally {
    fs.chmodSync(userData, 0o700);
    cleanup();
  }
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


const LOADED_STORES = [
  { name: 'agentDefaults', file: 'agent-defaults.json', seed: { a: { strip: 1 } },
    read: (s) => s.agentDefaults._load(), empty: {}, write: (s) => s.agentDefaults.setStrip('b', 2) },
  { name: 'reminders', file: 'reminders.json', seed: [{ id: 'r1', agent: 'a', kind: 'in', spec: '1m', body: 'x' }],
    read: (s) => s.reminders._load(), empty: [], write: (s) => s.reminders.add({ agent: 'b', kind: 'in', spec: '1m' }) },
  { name: 'notifications', file: 'notifications.json', seed: [{ id: 'n1', from: 'a', body: 'x', createdAt: 1 }],
    read: (s) => s.notifications._load(), empty: [], write: (s) => s.notifications.add({ from: 'b', body: 'y' }) },
  { name: 'skillsSeen', file: 'skills-seen.json', seed: ['alpha'],
    read: (s) => s.skillsSeen.list(), empty: [], write: (s) => s.skillsSeen.record(['beta']) },
];

for (const st of LOADED_STORES) {
  test(`${st.name}: a corrupt ${st.file} is quarantined once, byte-exact, and reads as empty`, () => {
    const { stores, cleanup, userData } = freshStores();
    try {
      const original = JSON.stringify(st.seed) + ',,';
      fs.writeFileSync(path.join(userData, st.file), original);
      assert.deepStrictEqual(st.read(stores), st.empty);
      st.write(stores);
      st.read(stores);
      const moved = fs.readdirSync(userData).filter((n) => n.startsWith(`${st.file}.corrupt-`));
      assert.strictEqual(moved.length, 1, `exactly one quarantine file: ${moved}`);
      assert.strictEqual(fs.readFileSync(path.join(userData, moved[0]), 'utf-8'), original);
    } finally { cleanup(); }
  });

  test(`${st.name}: an unreadable ${st.file} refuses saves until it is readable again`, { skip: isRoot && 'root reads a 000 file' }, () => {
    const { stores, cleanup, userData } = freshStores();
    const file = path.join(userData, st.file);
    try {
      fs.writeFileSync(file, JSON.stringify(st.seed));
      const before = fs.readFileSync(file);
      fs.chmodSync(file, 0o000);
      assert.throws(() => fs.readFileSync(file), /EACCES|EPERM/, 'ENTER: the file is unreadable');
      captureConsoleError(() => {
        assert.deepStrictEqual(st.read(stores), st.empty);
        assert.throws(() => st.write(stores), /could not be read; refusing to save over it/);
      });
      fs.chmodSync(file, 0o600);
      assert.deepStrictEqual(fs.readFileSync(file), before, 'the unreadable file was left byte-for-byte');
      st.read(stores);
      st.write(stores);
      assert.notDeepStrictEqual(fs.readFileSync(file), before, 'a readable file re-arms saves');
    } finally {
      try { fs.chmodSync(file, 0o600); } catch {}
      cleanup();
    }
  });
}

for (const st of LOADED_STORES) {
  test(`${st.name}: a corrupt ${st.file} whose quarantine rename fails reads empty, is left in place, and refuses saves`, { skip: isRoot && 'chmod does not bind root' }, () => {
    const { stores, cleanup, userData } = freshStores();
    const file = path.join(userData, st.file);
    try {
      fs.writeFileSync(file, '{bad');
      fs.chmodSync(userData, 0o500);
      let got;
      const errs = captureConsoleError(() => { got = st.read(stores); });
      assert.deepStrictEqual(got, st.empty);
      assert.ok(errs.some((l) => l.includes('could not be parsed nor moved aside')), errs.join('\n'));
      assert.deepStrictEqual(fs.readdirSync(userData).filter((n) => n.startsWith(`${st.file}.corrupt-`)), []);
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), '{bad');
      captureConsoleError(() => {
        assert.throws(() => st.write(stores), /refusing to save/);
      });
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), '{bad');
    } finally {
      try { fs.chmodSync(userData, 0o700); } catch {}
      cleanup();
    }
  });
}

test('agentDefaults: getDefaultSkillDeny on an unreadable agent-defaults.json returns the floor without writing', { skip: isRoot && 'root reads a 000 file' }, () => {
  const { stores, cleanup, userData } = freshStores();
  const file = path.join(userData, 'agent-defaults.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ '*': { denySkills: ['alpha'] } }));
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    fs.chmodSync(file, 0o000);
    let got;
    captureConsoleError(() => { got = stores.agentDefaults.getDefaultSkillDeny(); });
    assert.deepStrictEqual(got, DEFAULT_SKILL_DENY_FLOOR.slice());
    fs.chmodSync(file, 0o600);
    assert.deepStrictEqual(fs.readFileSync(file), before);
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  } finally {
    try { fs.chmodSync(file, 0o600); } catch {}
    cleanup();
  }
});
