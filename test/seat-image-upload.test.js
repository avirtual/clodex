'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpcHandlers } = require('../ipc-handlers');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');

function fixture({ surface = 'web', workspace = 'ws-1' } = {}) {
  const MSG_DIR = path.join(mkTmpRoot('clx-img-upload-'), 'messages');
  const manager = mk({ MSG_DIR, path });
  manager.sessions.set('st', { name: 'st', workspaceId: 'ws-1', agentType: 'claude', io: 'pty' });
  manager.sessions.set('sh', { name: 'sh', workspaceId: 'ws-1', agentType: null });
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager,
    surfaceOfSender: () => surface,
    workspaceOfSender: () => workspace,
    log: { info() {}, error() {}, warn() {} },
  });
  return { MSG_DIR, upload: (name, images) => handlers.get('seat:image-upload')({}, name, images) };
}

const BYTES = Buffer.from('PNG-FIXTURE-BYTES');
const png = (data = BYTES.toString('base64')) => ({ mediaType: 'image/png', data });

test('seat:image-upload from the web surface writes img-<stamp>-1.png under MSG_DIR/<seat>/ and returns its absolute path', () => {
  const f = fixture();
  const r = f.upload('st', [png()]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.paths.length, 1);
  const [p] = r.paths;
  assert.ok(path.isAbsolute(p), `absolute: ${p}`);
  assert.strictEqual(path.dirname(p), path.join(f.MSG_DIR, 'st'));
  assert.match(path.basename(p), /^img-\d+-1\.png$/);
  assert.ok(fs.existsSync(p));
  assert.strictEqual(fs.statSync(p).size, BYTES.length, 'ENTER: the upload really wrote the decoded bytes');
  assert.deepStrictEqual(fs.readFileSync(p), BYTES);
});

test('seat:image-upload refuses a foreign workspace, a missing seat, a non-agent seat and a bad image, writing nothing', () => {
  const foreign = fixture({ workspace: 'ws-2' });
  assert.deepStrictEqual(foreign.upload('st', [png()]), { ok: false, error: 'no such session in this workspace' });
  const f = fixture();
  const big = 'A'.repeat(Math.ceil((5 * 1024 * 1024 + 1) * 4 / 3) + 4);
  for (const [name, images, error] of [
    ['nope', [png()], 'no such session in this workspace'],
    ['sh', [png()], 'not an agent session'],
    ['st', [], 'no image to upload'],
    ['st', undefined, 'no image to upload'],
    ['st', [png(big)], 'image larger than 5 MB'],
    ['st', [{ mediaType: 'image/svg+xml', data: 'AAAA' }], 'unsupported image type: image/svg+xml'],
  ]) assert.deepStrictEqual(f.upload(name, images), { ok: false, error });
  assert.strictEqual(fs.existsSync(path.join(f.MSG_DIR, 'st')), false);
  assert.strictEqual(fs.existsSync(path.join(foreign.MSG_DIR, 'st')), false);
});
