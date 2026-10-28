'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerIpcHandlers } = require('../ipc-handlers');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-file-open-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map();
  const opened = [];
  const revealed = [];
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    openPath: async (p) => { opened.push(p); return ''; },
    showItemInFolder: (p) => { revealed.push(p); },
    fs, path,
    workspaceOfSender: () => 'ws-1',
    log: { info() {}, error() {} },
  });
  const write = (name, mode = 0o644) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    fs.chmodSync(p, mode);
    return p;
  };
  const open = (p) => handlers.get('file:open')(null, p);
  return { dir, write, open, opened, revealed };
}

test('file:open reveals a .command launcher instead of opening it', async (t) => {
  const f = fixture(t);
  const p = f.write('run.command');
  const res = await f.open(p);
  assert.deepStrictEqual(res, { ok: false, revealed: true, reason: 'a .command launcher' });
  assert.deepStrictEqual(f.opened, []);
  assert.deepStrictEqual(f.revealed, [p]);
});

test('file:open reveals a directory', async (t) => {
  const f = fixture(t);
  const p = path.join(f.dir, 'Thing.app');
  fs.mkdirSync(p);
  const res = await f.open(p);
  assert.deepStrictEqual(res, { ok: false, revealed: true, reason: 'a directory' });
  assert.deepStrictEqual(f.opened, []);
  assert.deepStrictEqual(f.revealed, [p]);
});

test('file:open reveals an executable whose extension looks harmless', async (t) => {
  const f = fixture(t);
  const p = f.write('notes.txt', 0o755);
  const res = await f.open(p);
  assert.deepStrictEqual(res, { ok: false, revealed: true, reason: 'an executable' });
  assert.deepStrictEqual(f.opened, []);
});

test('file:open reveals a symlink rather than following it', async (t) => {
  const f = fixture(t);
  const target = f.write('real.md');
  const link = path.join(f.dir, 'link.md');
  fs.symlinkSync(target, link);
  const res = await f.open(link);
  assert.deepStrictEqual(res, { ok: false, revealed: true, reason: 'a symlink' });
  assert.deepStrictEqual(f.opened, []);
});

test('file:open opens a plain markdown file', async (t) => {
  const f = fixture(t);
  const p = f.write('README.md');
  const res = await f.open(p);
  assert.strictEqual(res, '');
  assert.deepStrictEqual(f.opened, [p]);
  assert.deepStrictEqual(f.revealed, []);
});

test('file:open neither opens nor reveals a path that does not exist', async (t) => {
  const f = fixture(t);
  const res = await f.open(path.join(f.dir, 'gone.md'));
  assert.deepStrictEqual(res, { ok: false, revealed: false, reason: 'cannot open: ENOENT' });
  assert.deepStrictEqual([f.opened, f.revealed], [[], []]);
});
