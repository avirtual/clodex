const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSeatImport, IMPORT_MAX_BYTES } = require('../seat-import');
const { claudeProjectSlug, seatPathFor, legacySeatPathFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const CWD = '/Users/x/proj.app';
const SLUG = '-Users-x-proj-app';
const SID = '11111111-2222-3333-4444-555555555555';

function mkRoots() {
  const root = mkTmpRoot('clodex-seatimp-');
  const claudeProjects = mkTmpRoot('clodex-seatimp-cp-');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', '.migrated'),
    `${JSON.stringify({ kinds: { messages: 'x', notices: 'x', promptcache: 'x', memory: 'x', spill: 'x', monitors: 'x', run: 'x' } })}\n`);
  return { root, claudeProjects };
}

function stubReminders() {
  const added = [];
  return { added, add(row) { added.push(row); return { id: `r${added.length}`, ...row }; } };
}

function mkImport(extra = {}) {
  const { root, claudeProjects } = mkRoots();
  const reminders = stubReminders();
  const imp = createSeatImport({ root, claudeProjects, reminders, fs, ...extra });
  return { root, claudeProjects, reminders, imp };
}

function record(over = {}) {
  return { type: 'claude', sessionId: SID, cwd: CWD, ...over };
}

function put(imp, id, relPath, body) {
  return imp.putFile({ id, relPath, bytes: Buffer.from(body) });
}

function listTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push(`L ${r} -> ${fs.readlinkSync(path.join(dir, e.name))}`);
      else if (e.isDirectory()) { out.push(`D ${r}`); walk(path.join(dir, e.name), r); }
      else out.push(`F ${r} ${fs.readFileSync(path.join(dir, e.name), 'utf8')}`);
    }
  };
  walk(root, '');
  return out;
}

test('begin refuses a bad name, a codex seat, a missing sessionId and a relative cwd', () => {
  const { imp } = mkImport();
  assert.match(imp.begin({ name: '..', record: record() }).error, /invalid seat name/);
  assert.match(imp.begin({ name: 'a/b', record: record() }).error, /invalid seat name/);
  assert.strictEqual(imp.begin({ name: 'ana', record: record({ type: 'codex' }) }).error,
    'codex seats cannot be moved yet');
  assert.match(imp.begin({ name: 'ana', record: record({ sessionId: undefined }) }).error,
    /sessionId is required/);
  assert.match(imp.begin({ name: 'ana', record: record({ sessionId: 'nope' }) }).error,
    /sessionId is required/);
  assert.match(imp.begin({ name: 'ana', record: record({ cwd: 'rel/path' }) }).error,
    /cwd must be an absolute path/);
  assert.match(imp.begin({ name: 'ana', record: null }).error, /record must be an object/);
});

test('begin refuses a second staging for a name already in progress', () => {
  const { imp } = mkImport();
  const first = imp.begin({ name: 'ana', record: record() });
  assert.strictEqual(first.ok, true);
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(first.dropped, []);
  assert.strictEqual(imp.begin({ name: 'ana', record: record() }).error,
    'import of ana already in progress');
  assert.strictEqual(imp.begin({ name: 'bob', record: record() }).ok, true);
});

test('putFile confines every staged path and refuses out-of-order chunks', () => {
  const { imp } = mkImport();
  const { id } = imp.begin({ name: 'ana', record: record() });

  assert.strictEqual(put(imp, id, 'seat/../../escape', 'x').error, "path segment '..' is refused");
  assert.strictEqual(put(imp, id, 'seat/run/x', 'x').error, "seat kind 'run' is not imported");
  assert.strictEqual(put(imp, id, 'seat/bogus/x', 'x').error, "unknown seat kind 'bogus'");
  assert.strictEqual(put(imp, id, 'library/memory/x', 'x').error, "unknown top-level entry 'library'");
  assert.strictEqual(put(imp, id, 'transcript.jsonl/x', 'x').error, "'transcript.jsonl' is a file, not a directory");
  assert.strictEqual(put(imp, id, 'reminders.json/x', 'x').error, "'reminders.json' is a file, not a directory");
  assert.strictEqual(put(imp, id, 'loadlog.jsonl/x', 'x').error, "'loadlog.jsonl' is a file, not a directory");
  assert.strictEqual(put(imp, id, 'seat/memory', 'x').error, "a staged path under 'seat/' needs a kind and a file");

  assert.deepStrictEqual(put(imp, id, 'transcript.jsonl', 'abc'), { ok: true, size: 3 });
  assert.strictEqual(imp.putFile({ id, relPath: 'transcript.jsonl', bytes: Buffer.from('d'), offset: 9 }).error,
    'out-of-order chunk');
  assert.deepStrictEqual(imp.putFile({ id, relPath: 'transcript.jsonl', bytes: Buffer.from('d'), offset: 3 }),
    { ok: true, size: 4 });
  assert.strictEqual(put(imp, id, 'seat/memory/a.md', 'x').ok, true);
});

test('putFile over the byte cap marks the staging failed and commit then refuses', () => {
  const { root } = mkRoots();
  const imp = createSeatImport({
    root, claudeProjects: root, reminders: stubReminders(), fs, maxBytes: 16,
  });
  assert.strictEqual(IMPORT_MAX_BYTES, 536870912);
  assert.strictEqual(createSeatImport({ root, claudeProjects: root, reminders: null, fs }).maxBytes, 536870912);

  const { id } = imp.begin({ name: 'ana', record: record() });
  assert.deepStrictEqual(put(imp, id, 'transcript.jsonl', '0123456789'), { ok: true, size: 10 });

  const over = imp.putFile({ id, relPath: 'seat/memory/a.md', bytes: Buffer.alloc(7), offset: 0 });
  assert.strictEqual(over.error, 'import exceeds the 16 byte cap');
  assert.strictEqual(fs.existsSync(path.join(root, 'import', id, 'files', 'seat', 'memory', 'a.md')), false);
  assert.strictEqual(put(imp, id, 'seat/memory/b.md', 'x').error, 'staging is failed: import exceeds the 16 byte cap');
  assert.strictEqual(imp.commit({ id }).error, 'staging is failed: import exceeds the 16 byte cap');
});

test('commit installs transcript, seat kinds, links, pending, loadlog and reminders', () => {
  const { root, claudeProjects, reminders, imp } = mkImport();
  const { id } = imp.begin({ name: 'ana', record: record({ env: { CLAUDE_CONFIG_DIR: '/acct/a' } }) });

  put(imp, id, 'transcript.jsonl', '{"t":1}\n');
  put(imp, id, 'seat/memory/unit.md', 'mem-body');
  put(imp, id, 'seat/messages/m1.txt', 'msg-body');
  put(imp, id, 'pending/p1.json', '{"p":1}');
  put(imp, id, 'loadlog.jsonl', '{"l":1}\n');
  put(imp, id, 'reminders.json', JSON.stringify([
    { id: 'old1', agent: 'ana', kind: 'every', spec: '30m', body: 'ping', nextFireAt: 42 },
    { id: 'old2', agent: 'ana', kind: 'in', spec: '1h', body: 'bound', nextFireAt: 7, ticket: 't9' },
  ]));

  const res = imp.commit({ id });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.name, 'ana');
  assert.deepStrictEqual(res.record, record({ env: { CLAUDE_CONFIG_DIR: '/acct/a' } }));

  const transcript = path.join(claudeProjects, SLUG, `${SID}.jsonl`);
  assert.strictEqual(res.installed.transcript, transcript);
  assert.strictEqual(fs.readFileSync(transcript, 'utf8'), '{"t":1}\n');
  assert.strictEqual(fs.existsSync(path.join(claudeProjects, SLUG, `${SID}.jsonl.import-${id}`)), false);

  assert.strictEqual(fs.readFileSync(path.join(seatPathFor(root, 'ana', 'memory'), 'unit.md'), 'utf8'), 'mem-body');
  assert.strictEqual(fs.readFileSync(path.join(seatPathFor(root, 'ana', 'messages'), 'm1.txt'), 'utf8'), 'msg-body');

  for (const kind of ['memory', 'messages', 'notices', 'promptcache', 'spill', 'monitors']) {
    const legacy = legacySeatPathFor(root, 'ana', kind);
    assert.strictEqual(fs.lstatSync(legacy).isSymbolicLink(), true, `${kind} legacy spelling is a symlink`);
    assert.strictEqual(fs.realpathSync(legacy), fs.realpathSync(seatPathFor(root, 'ana', kind)));
  }
  assert.strictEqual(fs.existsSync(legacySeatPathFor(root, 'ana', 'run')), false);

  assert.strictEqual(res.installed.pending, path.join(root, 'pending', 'ana'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'pending', 'ana', 'p1.json'), 'utf8'), '{"p":1}');
  assert.strictEqual(res.installed.loadlog, path.join(root, 'library', 'memory-loadlog', 'ana.jsonl'));
  assert.strictEqual(fs.readFileSync(res.installed.loadlog, 'utf8'), '{"l":1}\n');

  assert.strictEqual(res.installed.reminders, 2);
  assert.deepStrictEqual(reminders.added, [
    { agent: 'ana', kind: 'every', spec: '30m', body: 'ping', nextFireAt: 42, ticket: null },
    { agent: 'ana', kind: 'in', spec: '1h', body: 'bound', nextFireAt: 7, ticket: null },
  ]);
  assert.deepStrictEqual(res.dropped, ['reminders.ticket-bound:1', 'account']);

  assert.strictEqual(fs.existsSync(path.join(root, 'sessions', 'ana', 'seat.json')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'import', id)), false);
});

test('an identical transcript is left alone and the rest still installs', () => {
  const { root, claudeProjects, imp } = mkImport();
  fs.mkdirSync(path.join(claudeProjects, SLUG), { recursive: true });
  fs.writeFileSync(path.join(claudeProjects, SLUG, `${SID}.jsonl`), '{"t":1}\n');

  const { id } = imp.begin({ name: 'ana', record: record() });
  put(imp, id, 'transcript.jsonl', '{"t":1}\n');
  put(imp, id, 'seat/memory/unit.md', 'mem-body');

  const res = imp.commit({ id });
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.installed.transcript, 'identical');
  assert.strictEqual(fs.readFileSync(path.join(seatPathFor(root, 'ana', 'memory'), 'unit.md'), 'utf8'), 'mem-body');
  assert.deepStrictEqual(res.dropped, []);
});

test('commit refuses a collision and leaves the tree untouched', () => {
  const cases = [
    ['sessions/ana', (root) => fs.mkdirSync(path.join(root, 'sessions', 'ana'), { recursive: true })],
    ['messages/ana', (root) => fs.mkdirSync(path.join(root, 'messages', 'ana'), { recursive: true })],
    ['pending/ana', (root) => fs.mkdirSync(path.join(root, 'pending', 'ana'), { recursive: true })],
    ['library/memory-loadlog/ana.jsonl', (root) => {
      fs.mkdirSync(path.join(root, 'library', 'memory-loadlog'), { recursive: true });
      fs.writeFileSync(path.join(root, 'library', 'memory-loadlog', 'ana.jsonl'), 'old\n');
    }],
    ['a different transcript', (root, cp) => {
      fs.mkdirSync(path.join(cp, SLUG), { recursive: true });
      fs.writeFileSync(path.join(cp, SLUG, `${SID}.jsonl`), 'DIFFERENT\n');
    }],
  ];

  for (const [label, seed] of cases) {
    const { root, claudeProjects, reminders, imp } = mkImport();
    const opened = imp.begin({ name: 'ana', record: record() });
    assert.strictEqual(opened.ok, true, `${label}: begin`);
    put(imp, opened.id, 'transcript.jsonl', '{"t":1}\n');
    put(imp, opened.id, 'seat/memory/unit.md', 'mem-body');
    put(imp, opened.id, 'loadlog.jsonl', 'new\n');
    put(imp, opened.id, 'reminders.json', '[{"kind":"every","spec":"30m"}]');

    seed(root, claudeProjects);
    const before = listTree(root);
    const beforeCp = listTree(claudeProjects);

    const res = imp.commit({ id: opened.id });
    assert.strictEqual(res.ok, false, `${label}: commit must refuse`);
    assert.deepStrictEqual(listTree(root), before, `${label}: registry untouched`);
    assert.deepStrictEqual(listTree(claudeProjects), beforeCp, `${label}: projects untouched`);
    assert.deepStrictEqual(reminders.added, [], `${label}: no reminder re-added`);
  }
});

test('commit refuses a staging with no transcript and one with a malformed reminders.json', () => {
  const { root, imp } = mkImport();
  const a = imp.begin({ name: 'ana', record: record() });
  put(imp, a.id, 'seat/memory/unit.md', 'mem-body');
  assert.strictEqual(imp.commit({ id: a.id }).error, 'no transcript.jsonl was staged');

  const b = imp.begin({ name: 'bob', record: record() });
  put(imp, b.id, 'transcript.jsonl', '{"t":1}\n');
  put(imp, b.id, 'reminders.json', 'not json');
  const before = listTree(root);
  assert.match(imp.commit({ id: b.id }).error, /reminders.json is malformed/);
  assert.deepStrictEqual(listTree(root), before);

  const c = imp.begin({ name: 'cid', record: record() });
  put(imp, c.id, 'transcript.jsonl', '{"t":1}\n');
  put(imp, c.id, 'reminders.json', '{"not":"an array"}');
  assert.match(imp.commit({ id: c.id }).error, /must be an array of rows/);
});

test('abort removes the staging and a second abort refuses', () => {
  const { root, imp } = mkImport();
  const { id } = imp.begin({ name: 'ana', record: record() });
  put(imp, id, 'transcript.jsonl', 'x');
  assert.deepStrictEqual(imp.abort({ id }), { ok: true });
  assert.strictEqual(fs.existsSync(path.join(root, 'import', id)), false);
  assert.match(imp.abort({ id }).error, /unknown staging/);
  assert.match(imp.abort({ id: 'a/b' }).error, /unknown staging/);
});

test('sweep removes a staging older than an hour by manifest startedAt and keeps a fresh one', () => {
  const { root } = mkRoots();
  let clock = 1_000_000_000_000;
  const imp = createSeatImport({ root, claudeProjects: root, reminders: stubReminders(), fs, now: () => clock });

  const stale = imp.begin({ name: 'ana', record: record() });
  clock += 61 * 60 * 1000;
  const fresh = imp.begin({ name: 'bob', record: record() });

  assert.deepStrictEqual(imp.sweep(), [stale.id]);
  assert.strictEqual(fs.existsSync(path.join(root, 'import', stale.id)), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'import', fresh.id)), true);
  assert.deepStrictEqual(imp.sweep(), []);
});

test('claudeProjectSlug flattens both separators and engine composes through it', () => {
  assert.strictEqual(claudeProjectSlug('/Users/x/proj.app'), '-Users-x-proj-app');
  assert.strictEqual(claudeProjectSlug('/a/b-c/.hidden'), '-a-b-c--hidden');

  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  const fn = src.match(/function claudeProjectDir\(cwd\)[\s\S]*?\n}/)[0];
  assert.match(fn, /claudeProjectSlug\(cwd\)/);
  assert.doesNotMatch(fn, /\.replace\(/);
  assert.match(src, /claudeProjectSlug[^\n]*\}\s*=\s*require\('\.\/clodex-paths'\)/);
});
