'use strict';
// path-confine.test.js — t114. Containment at the choke point.
//
// Every store here builds paths by joining a caller-supplied name onto a root
// Clodex owns, and every one of them treated a charset regex as containment.
// It isn't: `.` and `..` are spelled entirely in [a-zA-Z0-9._-].
//
// Every case asserts the REFUSAL — a thrown error or a null/empty return. A
// test that instead checks "the file outside the root still exists" also passes
// when the store is simply broken and deletes nothing at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { confine, confineOrThrow } = require('../path-confine');
const { createMemoryStore } = require('../memory-store');
const { initStores } = require('../stores');

// `..` reaches the root's parent; `../..` reaches ITS parent, which for the
// real skill-plugins dir is $HOME. A guard that special-cases `..` handles the
// first and not the second, which is why confine() is a positive check.
const ESCAPES = ['.', '..', '../..', '../../..', 'a/../..', 'a/b', '/abs', ''];

// Vectors for a store whose choke point confines `${name}.md` rather than the
// bare name. The suffix NEUTRALIZES a trailing-dots name — `'..' + '.md'` is
// `...md`, a perfectly legal filename inside the root — so `..` alone proves
// nothing there and a test using it would pass without any guard at all. These
// still traverse with a suffix attached.
const SUFFIXED_ESCAPES = ['../evil', '../../evil', '../..', 'sub/evil'];
// Dots in a legal position stay legal — a containment fix that also bans them
// is a regression no traversal case would catch.
const LEGAL = ['my.agent', 'foo.bar', '...', 'plain', '.hidden'];

test('confine: refuses every escape, admits every legal name', () => {
  const ROOT = '/lib';
  for (const n of ESCAPES) {
    assert.equal(confine(ROOT, n), null, `confine must refuse ${JSON.stringify(n)}`);
  }
  for (const n of LEGAL) {
    assert.equal(confine(ROOT, n), path.join(ROOT, n), `confine must admit ${JSON.stringify(n)}`);
  }
  // A non-string, or a missing root, is a refusal rather than a crash.
  assert.equal(confine(ROOT, null), null);
  assert.equal(confine(ROOT, 42), null);
  assert.equal(confine('', 'x'), null);
});

test('confineOrThrow: names the thing it refused', () => {
  assert.throws(() => confineOrThrow('/lib', '..', 'agent name'), /invalid agent name: \.\./);
  assert.equal(confineOrThrow('/lib', 'ok', 'agent name'), '/lib/ok');
});

// ── memory store ────────────────────────────────────────────────────────────

function tmpMem() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-confine-mem-'));
  return { store: createMemoryStore(dir), dir };
}

test('memoryStore: _dir — the choke point — refuses containment escapes DIRECTLY', () => {
  // Called on _dir rather than through a verb ON PURPOSE. Every public verb
  // tests MEMORY_AGENT_RE first, and since t115 that regex already rejects
  // every name that could traverse (no `/`, no dot-only). So a verb-level
  // traversal case passes with confine() entirely removed — it is proving the
  // REGEX, not the containment. This is the only case that reaches the guard.
  const { store } = tmpMem();
  for (const agent of ESCAPES) {
    assert.throws(() => store._dir(agent), /invalid agent name/,
      `_dir(${JSON.stringify(agent)}) must refuse`);
  }
  for (const agent of ['my.agent', 'foo.bar', '...']) {
    assert.equal(typeof store._dir(agent), 'string', `_dir admits ${agent}`);
  }
});

test('memoryStore: every verb refuses a traversing agent name', () => {
  // Defence in depth, and honestly labelled: TODAY these are refused by
  // MEMORY_AGENT_RE before _dir is reached. Both layers must refuse — the
  // regex is the one doing it here, and the case above covers the other.
  const { store } = tmpMem();
  for (const agent of ['.', '..', '../..']) {
    // list() is the one verb that returns rather than throws (its contract is
    // "no memories" for anything unreadable), so it is asserted as empty.
    assert.deepEqual(store.list(agent), [], `list(${JSON.stringify(agent)}) is empty`);
    assert.throws(() => store.remember(agent, { text: 'x' }), /invalid agent name/,
      `remember(${JSON.stringify(agent)}) refused`);
    assert.throws(() => store.forget(agent, 'mem-1-aaaaaa'), /invalid agent name/,
      `forget(${JSON.stringify(agent)}) refused`);
    assert.throws(() => store.setPinned(agent, 'mem-1-aaaaaa', true), /invalid agent name/,
      `setPinned(${JSON.stringify(agent)}) refused`);
  }
});

test('memoryStore: a dotted agent name still round-trips', () => {
  const { store } = tmpMem();
  for (const agent of ['my.agent', 'foo.bar']) {
    const u = store.remember(agent, { text: `memory for ${agent}` });
    assert.equal(store.list(agent).length, 1, `${agent} can be listed`);
    assert.equal(store.recall(agent, 'memory for').id, u.id);
    store.setPinned(agent, u.id, true);
    assert.equal(store.list(agent)[0].pinned, true);
    store.forget(agent, u.id);
    assert.equal(store.list(agent).length, 0, `${agent} can be deleted from`);
  }
});

test('memoryStore: forget cannot reach a file outside the agent dir', () => {
  const { store, dir } = tmpMem();
  // The reported vector: `forget('..', id)` resolved to <root>/<id>.md, in the
  // library root rather than any agent's directory.
  const victim = path.join(dir, 'mem-1-aaaaaa.md');
  fs.writeFileSync(victim, 'not an agent memory');
  assert.throws(() => store.forget('..', 'mem-1-aaaaaa'), /invalid agent name/);
  // The survival check is SECONDARY — the refusal above is the assertion. This
  // only rules out a delete that threw after unlinking.
  assert.ok(fs.existsSync(victim), 'and nothing was unlinked before the refusal');
});

// ── stores.js libraries ─────────────────────────────────────────────────────

// Same shape as test/stores.test.js freshStores(): seeding disabled via a
// resourcesDir that does not exist, so the shipped library defaults don't
// appear in the list() assertions below.
function tmpStores() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-confine-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-confine-reg-'));
  const stores = initStores(userData, {
    log: console, registryDir, resourcesDir: path.join(registryDir, '__no_seed__'),
  });
  return { stores, dir: registryDir };
}

// name → [the store, the label its refusal carries]
const LIBS = [
  ['agentLibrary', 'agent name'],
  ['skillLibrary', 'skill name'],
  ['execLibrary', 'exec command name'],
];

test('stores: raw/save/remove all refuse a traversing library name', () => {
  const { stores } = tmpStores();
  for (const [key, label] of LIBS) {
    const lib = stores[key];
    for (const name of SUFFIXED_ESCAPES) {
      const re = new RegExp(`invalid ${label}`);
      // raw() and remove() were entirely unguarded before this change — save()
      // was the only verb with a regex, so a read and a DELETE could traverse
      // where a write could not.
      //
      // raw() answers null rather than throwing: its contract is already
      // "null if unreadable", and a refused name IS unreadable. remove() and
      // save() throw, because for those a caller acting on a silent no-op is
      // the bug this ticket is about.
      assert.equal(lib.raw(name), null, `${key}.raw(${name}) refused`);
      assert.throws(() => lib.remove(name), re, `${key}.remove(${name}) refused`);
      assert.throws(() => lib.save(name, 'x'), re, `${key}.save(${name}) refused`);
    }
  }
});

test('stores: a REFUSED remove is distinguishable from a successful one', () => {
  // The false-green this ticket exists to close: remove() swallowed everything
  // and returned this.list(), so a rejected name and a real delete returned the
  // same value. A caller could not tell them apart — and host.library.remove
  // now publishes that answer to plugins.
  const { stores } = tmpStores();
  for (const [key] of LIBS) {
    const lib = stores[key];
    const ext = key === 'execLibrary' ? '{}' : 'body';
    lib.save('real', ext);
    const after = lib.remove('real');
    assert.deepEqual(after, [], 'a real delete returns the emptied list');
    assert.throws(() => lib.remove('../evil'), /invalid/, `${key}: a refused name throws instead`);
    // ENOENT stays silent — delete is idempotent, and that must NOT have been
    // collateral damage from making refusals loud.
    assert.deepEqual(lib.remove('never-existed'), [], `${key}: deleting a missing name is quiet`);
  }
});

test('stores: dotted library names still work end to end', () => {
  const { stores } = tmpStores();
  for (const [key] of LIBS) {
    const lib = stores[key];
    const body = key === 'execLibrary' ? '{"argv":["true"]}' : 'content';
    for (const name of ['my.agent', 'foo.bar']) {
      lib.save(name, body);
      assert.ok(lib.raw(name) != null, `${key}: ${name} can be read back`);
      assert.ok(lib.list().some((x) => x.name === name), `${key}: ${name} is listed`);
      lib.remove(name);
      assert.ok(lib.raw(name) == null, `${key}: ${name} can be deleted`);
    }
  }
});

test('stores: templates refuse a traversing id on read, write and delete', () => {
  const { stores } = tmpStores();
  const t = stores.templates;
  for (const name of SUFFIXED_ESCAPES) {
    // _read() mirrors raw(): null for anything unreadable, refusals included.
    assert.equal(t._read(name), null, `_read(${name})`);
    assert.throws(() => t.remove(name), /invalid template name/, `remove(${name})`);
    assert.throws(() => t.save({ name, id: name }), /invalid template name/, `save(${name})`);
  }
  // And the legal path is untouched.
  t.save({ name: 'my.template', id: '' });
  assert.ok(t.list().some((x) => x.name === 'my.template'));
  t.remove('my.template');
  assert.equal(t.list().length, 0);
});

test('stores: promptLibrary confines BOTH segments, not just the stem', () => {
  const { stores } = tmpStores();
  const p = stores.promptLibrary;
  // `kind` is the second caller-supplied segment. save() allow-lists it
  // (PROMPT_KINDS — a closed set, stronger than a regex), but raw/remove/list
  // took it unchecked.
  // `kind` is NOT suffixed — it is joined bare as a directory — so the plain
  // dot vectors are the right ones here, unlike the stem below.
  for (const kind of ['..', '../..', '../evil']) {
    assert.equal(p.raw(kind, 'x'), null, `raw kind ${kind}`);
    assert.throws(() => p.remove(kind, 'x'), /invalid prompt kind/, `remove kind ${kind}`);
    // save() refuses on the allow-list (PROMPT_KINDS) before reaching _dir, so
    // its error names the kind rather than the containment. Either is a refusal.
    assert.throws(() => p.save(kind, 'x', 'y'), /invalid prompt kind/, `save kind ${kind}`);
  }
  for (const stem of SUFFIXED_ESCAPES) {
    assert.equal(p.raw('system', stem), null, `raw stem ${stem}`);
    assert.throws(() => p.remove('system', stem), /invalid prompt name/, `remove stem ${stem}`);
    assert.throws(() => p.save('system', stem, 'y'), /invalid prompt name/, `save stem ${stem}`);
  }
  // list() with a bad kind returns empty rather than throwing (it loops over
  // kinds and skips unreadable ones) — asserted so the asymmetry is a decision.
  assert.deepEqual(p.list('..'), []);
  p.save('append', 'my.prompt', 'body');
  assert.equal(p.raw('append', 'my.prompt'), 'body');
});
