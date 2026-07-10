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
