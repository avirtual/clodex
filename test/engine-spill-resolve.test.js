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

test('the spill stub\'s absolute path resolves through the ordinary displayed-path resolver, with no spill branch in front of it', () => {
  const { engine, registryDir } = mkEngine();
  const id = writeSpill(registryDir, SEAT, 'x'.repeat(900));
  assert.ok(id, 'ENTER: the spill file was written, or the resolve below proves nothing');
  const file = spillPathFor(registryDir, SEAT, id);

  const res = engine.resolveFilePath(SEAT, file, null);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.path, file, 'the peek reads this path verbatim, so it must be the body the seat spilled');
  assert.strictEqual(res.via, 'absolute', 'the stub carries an absolute path, which file-resolve opens as a plain file');
  assert.strictEqual(fs.readFileSync(res.path, 'utf8'), 'x'.repeat(900));

  const other = engine.resolveFilePath(OTHER, file, null);
  assert.strictEqual(other.ok, true, 'reading is not confined to the clicked seat: any absolute path that exists opens, as file-resolve.js documents');
});

test('the old @spill: token is an ordinary path miss now: the resolver has no pointer grammar', () => {
  const { engine, registryDir, cwd } = mkEngine();
  const id = writeSpill(registryDir, SEAT, 'x'.repeat(900));
  fs.writeFileSync(path.join(cwd, 'real.js'), '1\n');

  for (const raw of [`@spill:${id}`, `S-E intent-spill: shout joins @spill:${id}`, '@spill:0123456789abcdef', '@spill:nothex']) {
    const res = engine.resolveFilePath(SEAT, raw, null);
    assert.strictEqual(res.ok, false, raw);
    assert.match(res.error, /Can't find/, raw);
  }
  const ordinary = engine.resolveFilePath(SEAT, 'real.js', null);
  assert.strictEqual(ordinary.ok, true, ordinary.error);
  assert.strictEqual(ordinary.path, path.join(cwd, 'real.js'));
});

test('a peer session is refused before any path is consulted', () => {
  const { engine, registryDir } = mkEngine();
  const id = writeSpill(registryDir, SEAT, 'z'.repeat(900));
  engine.manager.sessions.set(SEAT, { name: SEAT, peer: 'box-b', cwd: '/x', fileTouches: [] });

  const res = engine.resolveFilePath(SEAT, spillPathFor(registryDir, SEAT, id), null);
  assert.strictEqual(res.error, 'remote',
    'a peer row names no local file; the spill dir here belongs to a different machine\'s seat');
});

after(() => { setImmediate(() => process.exit(0)); });
