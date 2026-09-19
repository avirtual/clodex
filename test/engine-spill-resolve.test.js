'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine } = require('../engine');
const { writeSpill, spillPathFor } = require('../intent-spill');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SEAT = 'hand-one';
const OTHER = 'hand-two';

function mkEngine() {
  const tmp = mkTmpRoot('clodex-spill-');
  const registryDir = path.join(tmp, 'clodex-home');
  const cwd = path.join(tmp, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const engine = createEngine({
    userDataPath: tmp,
    seams: { registryDir },
    log: { info() {}, warn() {}, error() {} },
  });
  for (const name of [SEAT, OTHER]) {
    engine.manager.sessions.set(name, { name, cwd, fileTouches: [] });
  }
  return { engine, registryDir, cwd };
}

test('a pointer the clicked seat owns resolves to that seat\'s spill file', () => {
  const { engine, registryDir } = mkEngine();
  const id = writeSpill(registryDir, SEAT, 'x'.repeat(900));
  assert.ok(id, 'ENTER: the spill file was written, or the resolve below proves nothing');

  const res = engine.resolveFilePath(SEAT, `@spill:${id}`, null);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.path, spillPathFor(registryDir, SEAT, id));
  assert.strictEqual(fs.readFileSync(res.path, 'utf8'), 'x'.repeat(900),
    'the peek reads this path verbatim, so it must be the body the seat spilled');
});

test('another seat\'s pointer is not found, even though the id exists on disk', () => {
  const { engine, registryDir } = mkEngine();
  const id = writeSpill(registryDir, OTHER, 'a spec only hand-two spilled '.repeat(40));
  assert.ok(id && fs.existsSync(spillPathFor(registryDir, OTHER, id)),
    'ENTER: the other seat\'s file is on disk, or "not found" holds for the wrong reason');

  const res = engine.resolveFilePath(SEAT, `@spill:${id}`, null);
  assert.strictEqual(res.ok, false,
    'a pane may only peek the spill dir of the seat it belongs to');
  assert.strictEqual(res.error, 'spill file not found');
});

test('the pointer contributes only its id — no path is taken from the text', () => {
  const { engine, registryDir, cwd } = mkEngine();
  const outside = path.join(cwd, 'secret.md');
  fs.writeFileSync(outside, 'not a spill body');
  const id = writeSpill(registryDir, SEAT, 'y'.repeat(900));

  for (const raw of [`@spill:${id}/../../../${path.basename(outside)}`, `@spill:${outside}`]) {
    const res = engine.resolveFilePath(SEAT, raw, null);
    assert.notStrictEqual(res.path, outside,
      `"${raw}" must never resolve to a path spelled inside the pointer`);
  }
});

test('a malformed pointer falls through to the ordinary displayed-path resolver', () => {
  const { engine, cwd } = mkEngine();
  fs.writeFileSync(path.join(cwd, 'real.js'), '1\n');

  const bad = engine.resolveFilePath(SEAT, '@spill:nothex', null);
  assert.strictEqual(bad.ok, false);
  assert.notStrictEqual(bad.error, 'spill file not found',
    'a token that is not a pointer must be reported by the path resolver, not by the spill branch');
  assert.match(bad.error, /Can't find/);

  const ordinary = engine.resolveFilePath(SEAT, 'real.js', null);
  assert.strictEqual(ordinary.ok, true, ordinary.error);
  assert.strictEqual(ordinary.path, path.join(cwd, 'real.js'),
    'adding the spill branch must not shadow the resolver it sits in front of');
});

test('a pointer at the END of a titled line still resolves, so the terminal link survives the title', () => {
  const { engine, registryDir } = mkEngine();
  const id = writeSpill(registryDir, SEAT, 'x'.repeat(900));

  const res = engine.resolveFilePath(SEAT, `S-E intent-spill: shout joins @spill:${id}`, null);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.path, spillPathFor(registryDir, SEAT, id),
    'the renderer hands main the pointer token, but a peek of the whole row must land on the same file');
});

test('a title over 80 chars is not a pointer line, so the row falls through to the path resolver', () => {
  const { engine, registryDir } = mkEngine();
  const id = writeSpill(registryDir, SEAT, 'x'.repeat(900));

  const res = engine.resolveFilePath(SEAT, `${'t'.repeat(81)} @spill:${id}`, null);
  assert.strictEqual(res.ok, false);
  assert.notStrictEqual(res.error, 'spill file not found',
    'the widening stops exactly where the tee stops emitting, so no ordinary prose row is claimed');
});

test('a well-formed pointer with nothing behind it reports the spill miss, not a path miss', () => {
  const { engine } = mkEngine();
  const res = engine.resolveFilePath(SEAT, '@spill:0123456789abcdef', null);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'spill file not found');
});

test('a peer session is refused before the spill dir is consulted', () => {
  const { engine, registryDir } = mkEngine();
  const id = writeSpill(registryDir, SEAT, 'z'.repeat(900));
  engine.manager.sessions.set(SEAT, { name: SEAT, peer: 'box-b', cwd: '/x', fileTouches: [] });

  const res = engine.resolveFilePath(SEAT, `@spill:${id}`, null);
  assert.strictEqual(res.error, 'remote',
    'a peer row names no local file; the spill dir here belongs to a different machine\'s seat');
});

after(() => { setImmediate(() => process.exit(0)); });
