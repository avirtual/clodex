'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { mkTmpRoot } = require('./lib/tmp-roots');
const {
  SPILL_MAX_BYTES, spillIdOf, spillDirFor, spillPathFor,
  writeSpill, resolveSpill, pointerOf, pointerText, isSpillVerb, verbKeyOf, validAgent,
} = require('../intent-spill');

function root() {
  return mkTmpRoot('clodex-spill-');
}

test('id is sha256(body)[:16], lowercase hex', () => {
  const body = 'line one\n\n  indented  \n' + 'z'.repeat(900) + '\nlast';
  const want = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16);
  assert.equal(spillIdOf(body), want);
  assert.match(spillIdOf(body), /^[0-9a-f]{16}$/);
});

test('writeSpill: the file is the body EXACTLY — no header, no trailing newline', () => {
  const r = root();
  const body = 'spec line\n\ntrailing spaces   \nlast';
  const id = writeSpill(r, 'lead', body);
  assert.equal(id, spillIdOf(body));
  const p = path.join(r, 'spill', 'lead', `${id}.md`);
  assert.equal(fs.readFileSync(p, 'utf8'), body);
});

test('writeSpill: an existing file is left alone, not rewritten', () => {
  const r = root();
  const body = 'x'.repeat(1000);
  const id = writeSpill(r, 'lead', body);
  const p = spillPathFor(r, 'lead', id);
  const before = fs.statSync(p);
  fs.writeFileSync(p, 'SENTINEL');
  assert.equal(writeSpill(r, 'lead', body), id);
  assert.equal(fs.readFileSync(p, 'utf8'), 'SENTINEL');
  assert.equal(fs.statSync(p).ino, before.ino);
});

test('writeSpill: the dir is 0700 and the file 0600', () => {
  const r = root();
  const id = writeSpill(r, 'lead', 'y'.repeat(900));
  assert.equal(fs.statSync(path.join(r, 'spill', 'lead')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(spillPathFor(r, 'lead', id)).mode & 0o777, 0o600);
});

test('writeSpill: an invalid agent name is refused and writes nothing', () => {
  const r = root();
  for (const bad of ['..', '...', '.', '', 'a/b', 'x'.repeat(65), 'ok\n', '../x']) {
    assert.equal(writeSpill(r, bad, 'z'.repeat(900)), null, `agent ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.existsSync(path.join(r, 'spill')), false);
});

test('writeSpill: every name clodex can actually mint is accepted', () => {
  const r = root();
  for (const good of ['t42.fix', '.hidden', 'a..b', '-rf', 'x'.repeat(64)]) {
    assert.match(String(writeSpill(r, good, 'z'.repeat(900))), /^[0-9a-f]{16}$/, `agent ${good}`);
  }
});

test('writeSpill: an unwritable root yields null rather than throwing', () => {
  const r = root();
  fs.writeFileSync(path.join(r, 'spill'), 'not a directory');
  assert.equal(writeSpill(r, 'lead', 'z'.repeat(900)), null);
});

test('writeSpill: a body over the cap is refused', () => {
  const r = root();
  assert.equal(writeSpill(r, 'lead', 'z'.repeat(SPILL_MAX_BYTES + 1)), null);
});

test('resolveSpill: a written body round-trips', () => {
  const r = root();
  const body = 'spec\nwith lines';
  const id = writeSpill(r, 'lead', body);
  const got = resolveSpill(r, 'lead', id);
  assert.equal(got.ok, true);
  assert.equal(got.body, body);
  assert.equal(got.path, spillPathFor(r, 'lead', id));
});

test('resolveSpill: every refusal names its reason and never hands back a body', () => {
  const r = root();
  const id = writeSpill(r, 'lead', 'z'.repeat(900));
  const dir = path.join(r, 'spill', 'lead');

  assert.equal(resolveSpill(r, 'lead', 'a'.repeat(16)).reason, 'missing');
  assert.equal(resolveSpill(r, 'lead', 'NOTHEX0123456789').reason, 'invalid');
  assert.equal(resolveSpill(r, 'lead', id.slice(0, 15)).reason, 'invalid');
  assert.equal(resolveSpill(r, 'lead', id.toUpperCase()).reason, 'invalid');
  assert.equal(resolveSpill(r, '..', id).reason, 'invalid');
  assert.equal(resolveSpill(r, '../x', id).reason, 'invalid');
  assert.equal(resolveSpill(r, 'lead', '../../x').reason, 'invalid');

  const symId = 'b'.repeat(16);
  fs.symlinkSync('/etc/hosts', path.join(dir, `${symId}.md`));
  const sym = resolveSpill(r, 'lead', symId);
  assert.equal(sym.ok, false);
  assert.equal(sym.reason, 'not-a-file');
  assert.equal(sym.body, undefined);

  const dirId = 'c'.repeat(16);
  fs.mkdirSync(path.join(dir, `${dirId}.md`));
  assert.equal(resolveSpill(r, 'lead', dirId).reason, 'not-a-file');

  const emptyId = 'd'.repeat(16);
  fs.writeFileSync(path.join(dir, `${emptyId}.md`), '');
  assert.equal(resolveSpill(r, 'lead', emptyId).reason, 'empty');

  const bigId = 'e'.repeat(16);
  fs.writeFileSync(path.join(dir, `${bigId}.md`), 'z'.repeat(SPILL_MAX_BYTES + 1));
  assert.equal(resolveSpill(r, 'lead', bigId).reason, 'too-large');
});

test('spillDirFor confines: a traversal name resolves to no directory at all', () => {
  const r = root();
  assert.equal(spillDirFor(r, '..'), null);
  assert.equal(spillDirFor(r, '../x'), null);
  assert.equal(spillDirFor(r, 'lead'), path.join(r, 'spill', 'lead'));
  assert.equal(spillPathFor(r, '..', 'a'.repeat(16)), null);
});

test('pointerOf: the WHOLE body is the pointer, or it is prose', () => {
  const id = 'a'.repeat(16);
  assert.equal(pointerOf(pointerText(id)), id);
  assert.equal(pointerOf(` @spill:${id}\n`), id);
  assert.equal(pointerOf(`@spill:${id} plus`), null);
  assert.equal(pointerOf(`x @spill:${id}`), null);
  assert.equal(pointerOf(`@spill:${'a'.repeat(15)}`), null);
  assert.equal(pointerOf(`@spill:${'A'.repeat(16)}`), null);
  assert.equal(pointerOf(null), null);
});

test('the verb set is the dotted key, and only the six listed verbs', () => {
  assert.equal(verbKeyOf({ type: 'task', sub: 'add' }), 'task.add');
  assert.equal(verbKeyOf({ type: 'notify-user' }), 'notify-user');
  for (const v of [{ type: 'task', sub: 'add' }, { type: 'context', sub: 'reload' }]) {
    assert.equal(isSpillVerb(v), true, JSON.stringify(v));
  }
  for (const v of [{ type: 'dm', target: 'bob' }, { type: 'memory', sub: 'remember' },
    { type: 'task', sub: 'done' }, { type: 'notify-user' }]) {
    assert.equal(isSpillVerb(v), false, JSON.stringify(v));
  }
  assert.equal(validAgent('t42.fix'), true);
  assert.equal(validAgent('..'), false);
});
