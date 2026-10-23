'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { imageFilesOf, attachPicker, attachButton, ATTACH_ACCEPT } = require('../renderer/lib/attach-files');
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

test('the seat image types are png, jpeg, gif and webp, and the picker accepts exactly those', () => {
  assert.deepStrictEqual([...SEAT_IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  assert.strictEqual(ATTACH_ACCEPT, 'image/png,image/jpeg,image/gif,image/webp');
});

test('imageFilesOf splits a FileList into seat images and the rest', () => {
  const png = { name: 'a.png', type: 'image/png' };
  const svg = { name: 'b.svg', type: 'image/svg+xml' };
  const pdf = { name: 'c.pdf', type: 'application/pdf' };
  assert.deepStrictEqual(imageFilesOf([png, svg, pdf]), { images: [png], rejected: [svg, pdf] });
  assert.deepStrictEqual(imageFilesOf(null), { images: [], rejected: [] });
});

test('ENTER: attachPicker mounts one hidden input, opens it on demand, and hands over only seat images', () => {
  const doc = fakeDoc();
  const parent = fakeParent();
  const got = [];
  const toasts = [];
  const picker = attachPicker({ doc, parent, onFiles: (files) => got.push(files), toast: (m) => toasts.push(m) });
  picker.open();
  picker.open();
  assert.strictEqual(doc.made.length, 1, 'one input per composer, however often it opens');
  assert.deepStrictEqual(parent.children, [picker.input]);
  const input = picker.input;
  assert.deepStrictEqual([input.type, input.accept, input.multiple, input.hidden, input.clicks], ['file', 'image/png,image/jpeg,image/gif,image/webp', true, true, 2]);
  const png = { name: 'shot.png', type: 'image/png' };
  const webp = { name: 'cam.webp', type: 'image/webp' };
  const txt = { name: 'notes.txt', type: 'text/plain' };
  input.files = [png, txt, webp];
  input.value = 'C:\\fakepath\\shot.png';
  input.listeners.change();
  assert.deepStrictEqual(got, [[png, webp]]);
  assert.deepStrictEqual(toasts, ['Not attached: notes.txt (text/plain) — png, jpeg, gif or webp only.']);
  assert.strictEqual(input.value, '', 'the same file can be picked again');
});

test('attachPicker honours accept and multiple, and a pick of only non-images never calls onFiles', () => {
  const doc = fakeDoc();
  const got = [];
  const toasts = [];
  const picker = attachPicker({ doc, parent: fakeParent(), accept: 'image/png', multiple: false, onFiles: (f) => got.push(f), toast: (m) => toasts.push(m) });
  assert.deepStrictEqual([picker.input.accept, picker.input.multiple], ['image/png', false]);
  picker.input.files = [{ name: 'x.heic', type: 'image/heic' }, { name: '', type: '' }];
  picker.input.listeners.change();
  assert.deepStrictEqual(got, []);
  assert.deepStrictEqual(toasts, ['Not attached: x.heic (image/heic), file (unknown type) — png, jpeg, gif or webp only.']);
});

test('attachButton is a titled .seat-attach-btn that keeps composer focus and clicks through', () => {
  const doc = fakeDoc();
  let clicked = 0;
  const btn = attachButton(doc, () => { clicked += 1; });
  assert.deepStrictEqual([btn.tagName, btn.type, btn.className, btn.title, btn.attrs['aria-label']], ['button', 'button', 'seat-attach-btn', 'Attach image (png, jpeg, gif, webp; up to 5, 5 MB each)', 'Attach image']);
  let prevented = 0;
  btn.listeners.mousedown({ preventDefault: () => { prevented += 1; } });
  btn.listeners.click();
  assert.deepStrictEqual([prevented, clicked], [1, 1]);
});
