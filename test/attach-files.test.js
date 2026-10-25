'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { imageFilesOf, splitAttachable, rejectedNotice, attachPicker, attachButton, SEAT_FILE_MAX, SEAT_FILE_MAX_BYTES } = require('../renderer/lib/attach-files');
const seatFiles = require('../seat-files');
const { SEAT_IMAGE_TYPES } = require('../seat-images');

function fakeDoc() {
  const made = [];
  const doc = {
    made,
    createElement(tag) {
      const node = { tagName: tag, listeners: {}, attrs: {}, clicks: 0, files: [], value: '' };
      node.addEventListener = (type, fn) => { node.listeners[type] = fn; };
      node.setAttribute = (k, v) => { node.attrs[k] = v; };
      node.click = () => { node.clicks += 1; };
      made.push(node);
      return node;
    },
  };
  return doc;
}

function fakeParent() {
  const children = [];
  return { children, appendChild: (c) => children.push(c) };
}

test('the seat image types are png, jpeg, gif and webp, and the picker sets no accept filter', () => {
  assert.deepStrictEqual([...SEAT_IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const picker = attachPicker({ doc: fakeDoc(), parent: fakeParent(), onFiles: () => {} });
  assert.strictEqual(picker.input.accept, undefined);
});

test('imageFilesOf splits a FileList into seat images and the rest', () => {
  const png = { name: 'a.png', type: 'image/png' };
  const svg = { name: 'b.svg', type: 'image/svg+xml' };
  const pdf = { name: 'c.pdf', type: 'application/pdf' };
  assert.deepStrictEqual(imageFilesOf([png, svg, pdf]), { images: [png], rejected: [svg, pdf] });
  assert.deepStrictEqual(imageFilesOf(null), { images: [], rejected: [] });
});

test('ENTER: attachPicker mounts one hidden input, opens it on demand, and hands over every pick', () => {
  const doc = fakeDoc();
  const parent = fakeParent();
  const got = [];
  const picker = attachPicker({ doc, parent, onFiles: (files) => got.push(files) });
  picker.open();
  picker.open();
  assert.strictEqual(doc.made.length, 1, 'one input per composer, however often it opens');
  assert.deepStrictEqual(parent.children, [picker.input]);
  const input = picker.input;
  assert.deepStrictEqual([input.type, input.accept, input.multiple, input.hidden, input.clicks], ['file', undefined, true, true, 2]);
  const png = { name: 'shot.png', type: 'image/png', size: 10 };
  const txt = { name: 'notes.txt', type: 'text/plain', size: 0 };
  const zip = { name: 'a.zip', type: '', size: 14889779 };
  input.files = [png, txt, zip];
  input.value = 'C:\\fakepath\\shot.png';
  input.listeners.change();
  assert.deepStrictEqual(got, [[png, txt, zip]]);
  assert.strictEqual(input.value, '', 'the same file can be picked again');
});

test('attachPicker honours multiple, and an empty pick never calls onFiles', () => {
  const got = [];
  const picker = attachPicker({ doc: fakeDoc(), parent: fakeParent(), multiple: false, onFiles: (f) => got.push(f) });
  assert.strictEqual(picker.input.multiple, false);
  picker.input.files = [];
  picker.input.listeners.change();
  assert.deepStrictEqual(got, []);
});

const png = (name = 'a.png') => ({ name, type: 'image/png', size: 10 });
const pdf = (name = 'r.pdf') => ({ name, type: 'application/pdf', size: 10 });

for (const [label, pick, want] of [
  ['a png is an image', [{ name: 'a.png', type: 'image/png', size: 10 }], { images: ['a.png'], files: [], rejected: [] }],
  ['an untyped 14.2 MB zip is refused for size', [{ name: 'a.zip', type: '', size: 14889779 }], { images: [], files: [], rejected: [['a.zip', 'size']] }],
  ['an empty notes.txt is refused as empty', [{ name: 'notes.txt', size: 0 }], { images: [], files: [], rejected: [['notes.txt', 'empty']] }],
  ['a heic is a file, not an image', [{ name: 'x.heic', type: 'image/heic', size: 10 }], { images: [], files: ['x.heic'], rejected: [] }],
  ['exactly 10 MiB passes', [{ name: 'big.bin', type: '', size: 10485760 }], { images: [], files: ['big.bin'], rejected: [] }],
  ['one byte over 10 MiB is refused', [{ name: 'big.bin', type: '', size: 10485761 }], { images: [], files: [], rejected: [['big.bin', 'size']] }],
  ['6 png + 6 pdf keep five of each', [...['1', '2', '3', '4', '5', '6'].map((n) => png(`${n}.png`)), ...['1', '2', '3', '4', '5', '6'].map((n) => pdf(`${n}.pdf`))],
    { images: ['1.png', '2.png', '3.png', '4.png', '5.png'], files: ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf'], rejected: [['6.png', 'images'], ['6.pdf', 'files']] }],
]) {
  test(`splitAttachable: ${label}`, () => {
    const r = splitAttachable(pick);
    assert.deepStrictEqual({
      images: r.images.map((f) => f.name),
      files: r.files.map((f) => f.name),
      rejected: r.rejected.map(({ file, reason }) => [file.name, reason]),
    }, want);
  });
}

test('the renderer file limits match the server door', () => {
  assert.deepStrictEqual([SEAT_FILE_MAX, SEAT_FILE_MAX_BYTES], [seatFiles.SEAT_FILE_MAX, seatFiles.SEAT_FILE_MAX_BYTES]);
  assert.deepStrictEqual([SEAT_FILE_MAX, SEAT_FILE_MAX_BYTES], [5, 10485760]);
});

test('splitAttachable of nothing is three empty lists', () => {
  assert.deepStrictEqual(splitAttachable(null), { images: [], files: [], rejected: [] });
});

test('rejectedNotice words each refusal, then the overflow counts', () => {
  const r = splitAttachable([
    { name: 'a.zip', type: '', size: 14889779 },
    { name: 'notes.txt', size: 0 },
    ...['1', '2', '3', '4', '5', '6', '7'].map((n) => png(`${n}.png`)),
    ...['1', '2', '3', '4', '5', '6'].map((n) => pdf(`${n}.pdf`)),
  ]);
  assert.deepStrictEqual(rejectedNotice(r.rejected), [
    'Not attached: a.zip (14.2 MB) — files up to 10 MB.',
    'Not attached: notes.txt — empty file.',
    '2 image(s) not attached — at most 5 per message.',
    '1 file(s) not attached — at most 5 per message.',
  ]);
  assert.deepStrictEqual(rejectedNotice([]), []);
});

test('attachButton is a titled .seat-attach-btn that keeps composer focus and clicks through', () => {
  const doc = fakeDoc();
  let clicked = 0;
  const btn = attachButton(doc, () => { clicked += 1; });
  assert.deepStrictEqual([btn.tagName, btn.type, btn.className, btn.title, btn.attrs['aria-label']], ['button', 'button', 'seat-attach-btn', 'Attach image or file (up to 5 each; images 5 MB, files 10 MB)', 'Attach image or file']);
  let prevented = 0;
  btn.listeners.mousedown({ preventDefault: () => { prevented += 1; } });
  btn.listeners.click();
  assert.deepStrictEqual([prevented, clicked], [1, 1]);
});
