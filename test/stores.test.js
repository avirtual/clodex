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

// Fresh temp userData + registry dirs, and a stores bundle over them.
function freshStores() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-reg-'));
  const stores = initStores(userData, { log: console, registryDir });
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

test('persistence: entries missing workspaceId migrate to the default id', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    fs.writeFileSync(path.join(userData, 'sessions.json'),
      JSON.stringify([{ name: 'legacy' }]));
    assert.strictEqual(stores.persistence.list()[0].workspaceId, 'default');
  } finally { cleanup(); }
});

test('templates: save/list/remove', () => {
  const { stores, cleanup } = freshStores();
  try {
    assert.deepStrictEqual(stores.templates.list(), []);
    stores.templates.save({ id: 't1', name: 'T', type: 'claude', cwd: '/x' });
    stores.templates.save({ id: 't1', name: 'T2' }); // upsert by id
    assert.strictEqual(stores.templates.list().length, 1);
    assert.strictEqual(stores.templates.list()[0].name, 'T2');
    stores.templates.remove('t1');
    assert.deepStrictEqual(stores.templates.list(), []);
  } finally { cleanup(); }
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
