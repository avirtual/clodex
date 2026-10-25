'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpcHandlers } = require('../ipc-handlers');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');

function fixture({ workspace = 'ws-1' } = {}) {
  const MSG_DIR = path.join(mkTmpRoot('clx-file-upload-'), 'messages');
  const manager = mk({ MSG_DIR, path });
  manager.sessions.set('st', { name: 'st', workspaceId: 'ws-1', agentType: 'claude', io: 'pty' });
  manager.sessions.set('sh', { name: 'sh', workspaceId: 'ws-1', agentType: null });
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager,
    surfaceOfSender: () => 'web',
    workspaceOfSender: () => workspace,
    log: { info() {}, error() {}, warn() {} },
  });
  return { MSG_DIR, manager, upload: (name, files) => handlers.get('seat:file-upload')({}, name, files) };
}

const BYTES = Buffer.from('%PDF-1.7 fixture \x00\xff bytes', 'latin1');
const pdf = (name = 'report.pdf', data = BYTES.toString('base64')) => ({ name, data });
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);

test('seat:file-upload writes file-<stamp>-<n>-<safe name> 0600 under MSG_DIR/<seat>/ and returns absolute paths', () => {
  const f = fixture();
  const r = f.upload('st', [pdf(), pdf('../../etc/passwd')]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.paths.length, 2);
  const [p, q] = r.paths;
  for (const x of r.paths) {
    assert.ok(path.isAbsolute(x), `absolute: ${x}`);
    assert.strictEqual(path.dirname(x), path.join(f.MSG_DIR, 'st'));
    assert.strictEqual(fs.statSync(x).mode & 0o777, 0o600);
  }
  assert.match(path.basename(p), /^file-\d+-1-report\.pdf$/);
  assert.match(path.basename(q), /^file-\d+-2-passwd$/);
  assert.strictEqual(fs.statSync(p).size, BYTES.length, 'ENTER: the upload really wrote the decoded bytes');
  assert.deepStrictEqual(fs.readFileSync(p), BYTES);
});

test('seat:file-upload refuses a foreign workspace, a missing seat, a non-agent seat, an empty list and an oversize file, writing nothing', () => {
  const foreign = fixture({ workspace: 'ws-2' });
  assert.deepStrictEqual(foreign.upload('st', [pdf()]), { ok: false, error: 'no such session in this workspace' });
  const f = fixture();
  const dir = path.join(f.MSG_DIR, 'st');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'msg-1-1.txt'), 'keep');
  const before = listing(dir);
  assert.deepStrictEqual(before, ['msg-1-1.txt'], 'ENTER: the listing compared is non-empty');
  const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
  for (const [name, files, error] of [
    ['nope', [pdf()], 'no such session in this workspace'],
    ['sh', [pdf()], 'not an agent session'],
    ['st', [], 'no file to upload'],
    ['st', undefined, 'no file to upload'],
    ['st', [pdf('big.bin', big)], 'file larger than 10 MB: big.bin'],
    ['st', [pdf('a.txt'), pdf('empty.txt', '')], 'empty file: empty.txt'],
  ]) assert.deepStrictEqual(f.upload(name, files), { ok: false, error });
  assert.deepStrictEqual(listing(dir), before);
  assert.strictEqual(listing(path.join(foreign.MSG_DIR, 'st')), null);
});

test('seat:file-upload over a planted file at the minted name is { ok:false } with EEXIST and leaves the planted bytes', () => {
  const f = fixture();
  f.manager._imgStamp = 9000000000000;
  const dir = path.join(f.MSG_DIR, 'st');
  fs.mkdirSync(dir, { recursive: true });
  const planted = path.join(dir, 'file-9000000000001-1-report.pdf');
  fs.writeFileSync(planted, 'PLANTED');
  const r = f.upload('st', [pdf()]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /EEXIST/);
  assert.strictEqual(fs.readFileSync(planted, 'utf8'), 'PLANTED');
  assert.deepStrictEqual(listing(dir), ['file-9000000000001-1-report.pdf']);
});
