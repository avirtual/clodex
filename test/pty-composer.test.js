'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ptyComposerWrites, pasteKind, imageChip, expandImageChips, ptyImagePasteHandler, removeImageChip, chippedImages, renderImageStrip } = require('../renderer/lib/pty-composer');
const { clipboardImages } = require('../renderer/lib/clipboard-images');
const { PASTE_OPEN, PASTE_CLOSE, bracketPaste } = require('../renderer/lib/composer-voice');

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
  assert.strictEqual(ptyComposerWrites('a\x1b[20\x1b[201~1~b\nc')[0], `${PASTE_OPEN}ab\nc${PASTE_CLOSE}`, 'a marker nested inside another cannot reassemble itself');
  assert.strictEqual(ptyComposerWrites('a\x1b\x1b[201~b')[0], `${PASTE_OPEN}a\x1bb${PASTE_CLOSE}`);
});

test('a marker that only forms once an inner marker is removed is removed too', () => {
  assert.strictEqual(bracketPaste('\x1b[20\x1b[200~0~'), `${PASTE_OPEN}${PASTE_CLOSE}`);
});

function fastestMs(fn) {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

test('20,000 nested marker fragments are scrubbed in linear time', () => {
  const nested = '\x1b[20'.repeat(20000) + '0~'.repeat(20000);
  assert.strictEqual(bracketPaste(nested), `${PASTE_OPEN}${PASTE_CLOSE}`);
  const ms = fastestMs(() => bracketPaste(nested));
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
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

function pasteRig({ web, reply, upload = null, readImages = null }) {
  const log = { uploads: [], toasts: [], writes: [], draft: '', paths: {}, prevented: 0, order: [], added: [] };
  let n = 0;
  const handler = ptyImagePasteHandler({
    isWeb: () => web,
    readImages: readImages || ((items) => clipboardImages(items, FakeReader)),
    upload: upload || (async (images) => { log.uploads.push(images); return reply; }),
    toast: (m) => log.toasts.push(m),
    nextImage: () => { n += 1; return n; },
    append: (added) => { log.order.push('append'); log.added.push(...added); for (const a of added) { log.draft += a.chip; log.paths[a.n] = a.path || null; } },
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
  assert.match(src, /pastedImagePaths = \{\};\n\s*pastedThumbs = \[\];\n\s*syncImageStrip\(\);/u, 'sending clears the thumbnail strip');
  assert.match(m[1], /if \(image\) pastedThumbs\.push\(\{ n, image, path \}\);/u);
});

test('on the desktop the pasted image reaches append for its thumb and Ctrl-V still fires once', async () => {
  const { log, paste } = pasteRig({ web: false });
  await paste();
  assert.deepStrictEqual(log.added, [{ n: 1, chip: '[Image #1] ', path: null, image: { mediaType: 'image/png', data: 'QUJD' } }]);
  assert.deepStrictEqual(log.writes, ['\x16']);
  assert.deepStrictEqual(log.order, ['append', 'write']);
});

test('on the web the pasted image reaches append beside its uploaded path', async () => {
  const { log, paste } = pasteRig({ web: true, reply: { ok: true, paths: ['/h/img-1.png'] } });
  await paste();
  assert.deepStrictEqual(log.added, [{ n: 1, chip: '[Image #1] ', path: '/h/img-1.png', image: { mediaType: 'image/png', data: 'QUJD' } }]);
});

for (const [label, readImages] of [
  ['rejects', async () => { throw new Error('reader broke'); }],
  ['finds nothing', async () => []],
]) {
  test(`on the desktop a clipboard read that ${label} still appends the chip with no image and writes Ctrl-V`, async () => {
    const { log, paste } = pasteRig({ web: false, readImages });
    await paste();
    assert.deepStrictEqual(log.added, [{ n: 1, chip: '[Image #1] ', path: null, image: null }]);
    assert.deepStrictEqual(log.writes, ['\x16']);
    assert.deepStrictEqual(log.toasts, []);
  });
}

test('removeImageChip drops that chip only and leaves its neighbours', () => {
  assert.strictEqual(removeImageChip('a [Image #1] b [Image #2] c', 1), 'a b [Image #2] c');
  assert.strictEqual(removeImageChip('[Image #12] x', 1), '[Image #12] x');
});

test('chippedImages keeps only thumbs whose chip is still in the draft', () => {
  const img = { mediaType: 'image/png', data: 'QUJD' };
  const items = [{ n: 1, image: img }, { n: 2, image: img }, { n: 3, image: null }];
  assert.deepStrictEqual(chippedImages(items, '[Image #2] [Image #3] hi'), [{ n: 2, image: img }]);
  assert.deepStrictEqual(chippedImages(items, ''), []);
});

function fakeNode(tag) {
  const node = { tagName: tag, children: [], listeners: {}, hidden: false, className: '', title: '', textContent: '' };
  node.appendChild = (c) => node.children.push(c);
  node.append = (...cs) => node.children.push(...cs);
  node.replaceChildren = () => { node.children = []; };
  node.addEventListener = (type, fn) => { node.listeners[type] = fn; };
  return node;
}

test('renderImageStrip draws one removable thumb per image, titled by where the image lives, and hides when empty', () => {
  const el = fakeNode('div');
  el.ownerDocument = { createElement: fakeNode };
  const removed = [];
  const items = [{ n: 1, image: { mediaType: 'image/png', data: 'QUJD' }, path: null }, { n: 3, image: { mediaType: 'image/jpeg', data: 'REVG' }, path: '/h/img-3.jpg' }];
  renderImageStrip(el, items, (n) => removed.push(n));
  assert.strictEqual(el.hidden, false);
  assert.deepStrictEqual(el.children.map((t) => [t.className, t.title, t.children[0].src]), [
    ['seat-attachment', 'Removes the mark; the CLI keeps the pasted image', 'data:image/png;base64,QUJD'],
    ['seat-attachment', 'Remove image', 'data:image/jpeg;base64,REVG'],
  ]);
  const rm = el.children[1].children[1];
  assert.strictEqual(rm.className, 'seat-attachment-remove');
  rm.listeners.click();
  assert.deepStrictEqual(removed, [3]);
  renderImageStrip(el, [], () => {});
  assert.strictEqual(el.hidden, true);
  assert.deepStrictEqual(el.children, []);
});
