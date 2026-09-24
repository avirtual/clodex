'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');

function fixture() {
  const handlers = new Map();
  const calls = [];
  const manager = {
    sessions: new Map([['st', { name: 'st', workspaceId: 'ws-1' }]]),
    seatSend: (...a) => { calls.push(a); return { ok: true, queued: 0 }; },
  };
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    manager,
    surfaceOfSender: () => 'desktop',
    workspaceOfSender: () => 'ws-1',
    log: { info() {}, error() {}, warn() {} },
  });
  return { calls, send: (...a) => handlers.get('seat:send')({}, 'st', ...a) };
}

const png = (data = 'iVBORw0KGgo=') => ({ mediaType: 'image/png', data });

test('seat:send passes validated images through to seatSend and defaults to none', () => {
  const f = fixture();
  assert.deepStrictEqual(f.send('hi'), { ok: true, queued: 0 });
  assert.deepStrictEqual(f.send('look', [png(), { mediaType: 'image/webp', data: 'UklGRg==', extra: 1 }]), { ok: true, queued: 0 });
  assert.deepStrictEqual(f.calls, [
    ['st', 'hi', []],
    ['st', 'look', [png(), { mediaType: 'image/webp', data: 'UklGRg==' }]],
  ]);
});

test('seat:send refuses malformed images with { ok:false, error } and never reaches seatSend', () => {
  const f = fixture();
  const five = 5 * 1024 * 1024;
  const cases = [
    ['not-an-array', 'images must be an array'],
    [[png(), png(), png(), png(), png(), png()], 'at most 5 images per message'],
    [[null], 'image must be { mediaType, data }'],
    [[{ mediaType: 'image/svg+xml', data: 'AAAA' }], 'unsupported image type: image/svg+xml'],
    [[{ mediaType: 'image/png', data: 42 }], 'image data must be base64'],
    [[{ mediaType: 'image/png', data: '' }], 'image data must be base64'],
    [[{ mediaType: 'image/png', data: 'not base64!' }], 'image data must be base64'],
    [[png('A'.repeat(Math.ceil((five + 1) * 4 / 3) + 4))], 'image larger than 5 MB'],
  ];
  for (const [images, error] of cases) assert.deepStrictEqual(f.send('x', images), { ok: false, error });
  assert.deepStrictEqual(f.calls, []);
});

test('seat:send accepts an image of exactly 5 MB decoded', () => {
  const f = fixture();
  const data = Buffer.alloc(5 * 1024 * 1024).toString('base64');
  assert.deepStrictEqual(f.send('', [png(data)]), { ok: true, queued: 0 });
  assert.strictEqual(f.calls.length, 1);
});
