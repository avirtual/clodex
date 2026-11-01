'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteFileSync: coreWrite } = require('../fs-util');
const { _internals: { atomicWriteFileSync: viewerWrite } } = require('../plugins/tickets-viewer/engine');
const { mkTmpRoot, mkTmpDirIn } = require('./lib/tmp-roots');

function tmpDir(tag) { return mkTmpDirIn(mkTmpRoot('clodex-short-write-'), `${tag}-`); }

function withWriteStub(stub, fn) {
  const orig = fs.writeSync;
  const state = { calls: 0 };
  fs.writeSync = function (fd, buf, off, len, ...rest) {
    state.calls += 1;
    const cap = stub(state.calls, len);
    return orig.call(this, fd, buf, off, Math.min(len, cap), ...rest);
  };
  try { fn(state); } finally { fs.writeSync = orig; }
  return state;
}

const DATA = JSON.stringify({ tickets: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, title: 'ü-multibyte' })) });

for (const [name, write] of [['fs-util', coreWrite], ['tickets-viewer', viewerWrite]]) {
  test(`${name}: short writes are looped until every byte lands`, () => {
    const dir = tmpDir(`${name}-loop`);
    const file = path.join(dir, 'tickets.json');
    fs.writeFileSync(file, 'OLD');
    const state = withWriteStub(() => 7, () => write(file, DATA));
    assert.ok(state.calls > 1, `ENTER: stub shortened writes (calls=${state.calls})`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), DATA);
  });

  test(`${name}: a write that makes no progress throws and leaves the live file intact`, () => {
    const dir = tmpDir(`${name}-enospc`);
    const file = path.join(dir, 'tickets.json');
    fs.writeFileSync(file, 'GOOD-BOARD');
    let thrown;
    const state = withWriteStub((n) => (n === 1 ? 7 : 0), () => {
      try { write(file, DATA); } catch (e) { thrown = e; }
    });
    assert.ok(state.calls >= 2, `ENTER: stub reached its zero-progress call (calls=${state.calls})`);
    assert.ok(thrown, 'atomicWriteFileSync must throw on a short write');
    assert.match(thrown.message, /short write/);
    assert.strictEqual(thrown.code, 'ENOSPC');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'GOOD-BOARD');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp.')), []);
  });
}
