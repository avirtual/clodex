'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { validateSeatImages } = require('../seat-images');
const ipc = require('../ipc-handlers');

const png = (data = 'iVBORw0KGgo=') => ({ mediaType: 'image/png', data });

test('validateSeatImages: absent is none, valid images are copied down to { mediaType, data }', () => {
  assert.deepStrictEqual(validateSeatImages(undefined), { ok: true, images: [] });
  assert.deepStrictEqual(validateSeatImages(null), { ok: true, images: [] });
  assert.deepStrictEqual(validateSeatImages([png(), { mediaType: 'image/webp', data: 'UklGRg==', extra: 1 }]),
    { ok: true, images: [png(), { mediaType: 'image/webp', data: 'UklGRg==' }] });
  assert.deepStrictEqual(validateSeatImages([{ mediaType: 'image/gif', data: 'R0lG' }, { mediaType: 'image/jpeg', data: '/9j/' }]).ok, true);
});

test('validateSeatImages: the refusal strings', () => {
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
  for (const [images, error] of cases) assert.deepStrictEqual(validateSeatImages(images), { ok: false, error });
});

test('validateSeatImages: exactly 5 MB decoded is accepted', () => {
  assert.strictEqual(validateSeatImages([png(Buffer.alloc(5 * 1024 * 1024).toString('base64'))]).ok, true);
});

test('ipc-handlers carries no copy of the validator: the leaf is the one definition', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  assert.ok(!/function validateSeatImages/.test(src));
  assert.ok(src.includes("require('./seat-images')"));
  assert.strictEqual(typeof ipc.registerIpcHandlers, 'function');
});

test('seatImageFileName mints the names SEAT_IMAGE_FILE_PATTERN matches, one extension per media type', () => {
  const { seatImageFileName, SEAT_IMAGE_FILE_PATTERN } = require('../seat-images');
  const re = new RegExp(`^${SEAT_IMAGE_FILE_PATTERN}$`);
  const names = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].map((t, i) => seatImageFileName(1800000000000, i + 1, t));
  assert.deepStrictEqual(names, ['img-1800000000000-1.png', 'img-1800000000000-2.jpg', 'img-1800000000000-3.gif', 'img-1800000000000-4.webp']);
  for (const n of names) assert.ok(re.test(n), n);
  assert.ok(!re.test('msg-1-2.txt'));
});
