'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ptyComposerWrites, pasteKind, imageChip, expandImageChips, ptyImagePasteHandler } = require('../renderer/lib/pty-composer');
const { clipboardImages } = require('../renderer/lib/clipboard-images');
const { PASTE_OPEN, PASTE_CLOSE } = require('../renderer/lib/composer-voice');

test('a draft is written as a bracketed paste then a carriage return', () => {
  assert.deepStrictEqual(ptyComposerWrites('hello'), [`${PASTE_OPEN}hello${PASTE_CLOSE}`, '\r']);
});

test('carriage return is its own write', () => {
  const writes = ptyComposerWrites('hello');
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[1], '\r');
  assert.ok(!writes[0].includes('\r'));
});

test('newlines in a draft are carried literally inside the paste', () => {
  assert.strictEqual(ptyComposerWrites('a\nb')[0], `${PASTE_OPEN}a\nb${PASTE_CLOSE}`);
});

test('a draft carrying a paste-close marker cannot end the bracketed paste early', () => {
  const [body] = ptyComposerWrites('a\x1b[201~b\nc\x1b[200~d');
  assert.ok(body.startsWith(PASTE_OPEN));
  assert.strictEqual(body.indexOf(PASTE_CLOSE), body.length - PASTE_CLOSE.length);
  assert.strictEqual(body.lastIndexOf(PASTE_OPEN), 0);
  assert.strictEqual(body, `${PASTE_OPEN}ab\ncd${PASTE_CLOSE}`);
});

test('an empty draft still yields the two writes', () => {
  assert.deepStrictEqual(ptyComposerWrites(''), [`${PASTE_OPEN}${PASTE_CLOSE}`, '\r']);
});

const png = { kind: 'file', type: 'image/png' };
const plain = { kind: 'string', type: 'text/plain' };
const html = { kind: 'string', type: 'text/html' };

for (const [label, items, want] of [
  ['ENTER: an image alone is an image paste', [png], 'image'],
  ['an image with a text copy is a text paste', [html, plain, png], 'text'],
  ['a browser Copy Image (html plus png) is an image paste', [html, png], 'image'],
  ['plain text is a text paste', [plain], 'text'],
  ['a non-image file is nothing', [{ kind: 'file', type: 'application/pdf' }], 'none'],
  ['html without plain text is nothing', [html], 'none'],
  ['an empty clipboard is nothing', [], 'none'],
  ['a missing item list is nothing', undefined, 'none'],
]) {
  test(`pasteKind: ${label}`, () => {
    assert.strictEqual(pasteKind(items), want);
  });
}

test('pasteKind reads an array-like item list', () => {
  assert.strictEqual(pasteKind({ length: 1, 0: png }), 'image');
});

for (const [label, text, paths, want] of [
  ['ENTER: text with no chip is untouched', 'describe this', {}, 'describe this'],
  ['a mapped chip becomes the path line', '[Image #1] hi', { 1: '/a/img.png' }, 'Image #1: /a/img.png hi'],
  ['an inserted pathless chip is stripped', '[Image #1] hi', { 1: null }, 'hi'],
  ['two chips, one mapped', '[Image #1] [Image #2] hi', { 1: null, 2: '/a/two.png' }, 'Image #2: /a/two.png hi'],
  ['a chip-free text is unchanged with paths given', 'plain words', { 1: '/a/img.png' }, 'plain words'],
  ['a leading chip is dropped with its space', `${imageChip(1)}describe this`, { 1: null }, 'describe this'],
  ['chips after text are dropped', `look ${imageChip(1)}${imageChip(2)}`, { 1: null, 2: null }, 'look '],
  ['a draft of only chips becomes empty', `${imageChip(1)}${imageChip(2)}`, { 1: null, 2: null }, ''],
  ['newlines around a chip survive', `a\n${imageChip(3)}b`, { 3: null }, 'a\nb'],
  ['a chip-shaped token without a number stays', '[Image #x] ok', {}, '[Image #x] ok'],
  ['no path map keeps every chip-shaped token', `${imageChip(1)}x`, undefined, '[Image #1] x'],
  ['a typed chip no paste inserted is kept', 'see [Image #1] above', {}, 'see [Image #1] above'],
  ['a typed chip beside an inserted one is kept', '[Image #1] see [Image #2] above', { 1: null }, 'see [Image #2] above'],
]) {
  test(`expandImageChips: ${label}`, () => {
    assert.strictEqual(expandImageChips(text, paths), want);
  });
}

test('the chip is what the CLI shows, numbered from one', () => {
  assert.strictEqual(imageChip(1), '[Image #1] ');
});

class FakeReader {
  readAsDataURL(file) {
    this.result = file.url;
    queueMicrotask(() => (file.url ? this.onload() : this.onerror()));
  }
}

test('clipboardImages reads each clipboard image item into { mediaType, data } base64', async () => {
  const items = [
    { kind: 'string', type: 'text/html', getAsFile: () => { throw new Error('not a file'); } },
    { kind: 'file', type: 'image/png', getAsFile: () => ({ url: 'data:image/png;base64,iVBORw0KGgo=' }) },
    { kind: 'file', type: 'image/png', getAsFile: () => ({ url: '' }) },
  ];
  assert.deepStrictEqual(await clipboardImages(items, FakeReader), [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
  assert.deepStrictEqual(await clipboardImages(undefined, FakeReader), []);
});

function pasteRig({ web, reply, upload = null }) {
  const log = { uploads: [], toasts: [], writes: [], draft: '', paths: {}, prevented: 0, order: [] };
  let n = 0;
  const handler = ptyImagePasteHandler({
    isWeb: () => web,
    readImages: (items) => clipboardImages(items, FakeReader),
    upload: upload || (async (images) => { log.uploads.push(images); return reply; }),
    toast: (m) => log.toasts.push(m),
    nextImage: () => { n += 1; return n; },
    append: (added) => { log.order.push('append'); for (const a of added) { log.draft += a.chip; log.paths[a.n] = a.path || null; } },
    writePty: (d) => { log.order.push('write'); log.writes.push(d); },
  });
  const event = {
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ url: 'data:image/png;base64,QUJD' }) }] },
    preventDefault: () => { log.prevented += 1; },
  };
  return { log, paste: () => handler(event) };
}

test('ENTER: on the web a pasted image uploads once and appends [Image #1] mapped to the returned path', async () => {
  const { log, paste } = pasteRig({ web: true, reply: { ok: true, paths: ['/h/messages/st/img-1-1.png'] } });
  await paste();
  assert.deepStrictEqual(log.uploads, [[{ mediaType: 'image/png', data: 'QUJD' }]]);
  assert.strictEqual(log.draft, '[Image #1] ');
  assert.deepStrictEqual(log.paths, { 1: '/h/messages/st/img-1-1.png' });
  assert.deepStrictEqual(log.writes, []);
  assert.deepStrictEqual(log.toasts, []);
  assert.strictEqual(log.prevented, 1);
});

test('on the web a rejecting upload toasts once and the paste handler does not throw', async () => {
  const { log, paste } = pasteRig({ web: true, upload: async () => { throw new Error('network down'); } });
  await assert.doesNotReject(paste());
  assert.deepStrictEqual(log.toasts, ['network down']);
  assert.strictEqual(log.draft, '');
  assert.deepStrictEqual(log.writes, []);
});

test('on the web an { ok:false } upload toasts the error and appends nothing', async () => {
  const { log, paste } = pasteRig({ web: true, reply: { ok: false, error: 'image larger than 5 MB' } });
  await paste();
  assert.strictEqual(log.uploads.length, 1);
  assert.deepStrictEqual(log.toasts, ['image larger than 5 MB']);
  assert.strictEqual(log.draft, '');
  assert.deepStrictEqual(log.writes, []);
});

test('on the desktop a pasted image writes Ctrl-V, appends the chip and never uploads', async () => {
  const { log, paste } = pasteRig({ web: false, reply: { ok: true, paths: ['/never'] } });
  await paste();
  assert.deepStrictEqual(log.uploads, []);
  assert.deepStrictEqual(log.writes, ['\x16']);
  assert.deepStrictEqual(log.order, ['append', 'write'], 'the chip and slash mirror land before the CLI takes the image');
  assert.strictEqual(log.draft, '[Image #1] ');
  assert.deepStrictEqual(log.paths, { 1: null });
});

test('the pty composer wires its paste listener through ptyImagePasteHandler and expands chips on send', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const m = src.match(/composerEl\.addEventListener\('paste', ptyImagePasteHandler\(\{([\s\S]*?)\n {4}\}\)\);/u);
  assert.ok(m, 'renderer.js registers the shared paste handler on composerEl');
  assert.match(m[1], /isWeb: \(\) => Boolean\(window\.__CLODEX_WEB__ \|\| !window\.require\)/u);
  assert.match(m[1], /upload: \(images\) => window\.api\.seatImageUpload\(name, images\)/u);
  assert.match(m[1], /readImages: \(items\) => clipboardImages\(items, FileReader\)/u);
  assert.match(m[1], /if \(menuMirror\.on\(\)\) syncMenuMirror\(\);/u);
  assert.match(m[1], /pastedImagePaths\[n\] = path \|\| null;/u);
  assert.match(src, /ptyComposerWrites\(expandImageChips\(text, imagePaths\)\)/u);
});
