'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ptyComposerWrites, pasteKind, imageChip, fileChip, expandAttachChips, ptyImagePasteHandler, attachImages, attachFiles, STRIPPED_PASTE_NOTICE, removeChip, chippedAttachments, renderAttachStrip } = require('../renderer/lib/pty-composer');
const { clipboardImages, readImageFile, readAttachFile } = require('../renderer/lib/clipboard-images');
const { splitAttachable, rejectedNotice } = require('../renderer/lib/attach-files');
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
const pdf = { kind: 'file', type: 'application/pdf' };
const plain = { kind: 'string', type: 'text/plain' };
const html = { kind: 'string', type: 'text/html' };

for (const [label, items, want] of [
  ['ENTER: an image alone is an image paste', [png], 'image'],
  ['an image with a text copy is a text paste', [html, plain, png], 'text'],
  ['a browser Copy Image (html plus png) is an image paste', [html, png], 'image'],
  ['plain text is a text paste', [plain], 'text'],
  ['a non-image file is a file paste', [pdf], 'file'],
  ['a file with a text copy is a text paste', [plain, pdf], 'text'],
  ['an image beside a file is an image paste', [png, pdf], 'image'],
  ['a file of unknown type is a file paste', [{ kind: 'file', type: '' }], 'file'],
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
  ['a mapped chip becomes the path line', '[Image #1] hi', { 1: '/a/img.png' }, 'Image: /a/img.png hi'],
  ['an inserted pathless chip is stripped', '[Image #1] hi', { 1: null }, 'hi'],
  ['two chips, one mapped', '[Image #1] [Image #2] hi', { 1: null, 2: '/a/two.png' }, 'Image: /a/two.png hi'],
  ['a chip-free text is unchanged with paths given', 'plain words', { 1: '/a/img.png' }, 'plain words'],
  ['a leading chip is dropped with its space', `${imageChip(1)}describe this`, { 1: null }, 'describe this'],
  ['chips after text are dropped', `look ${imageChip(1)}${imageChip(2)}`, { 1: null, 2: null }, 'look '],
  ['a draft of only chips becomes empty', `${imageChip(1)}${imageChip(2)}`, { 1: null, 2: null }, ''],
  ['newlines around a chip survive', `a\n${imageChip(3)}b`, { 3: null }, 'a\nb'],
  ['a chip-shaped token without a number stays', '[Image #x] ok', {}, '[Image #x] ok'],
  ['no path map keeps every chip-shaped token', `${imageChip(1)}x`, undefined, '[Image #1] x'],
  ['a typed chip no paste inserted is kept', 'see [Image #1] above', {}, 'see [Image #1] above'],
  ['a typed chip beside an inserted one is kept', '[Image #1] see [Image #2] above', { 1: null }, 'see [Image #2] above'],
  ['a chip sent while its web upload is still pending is dropped', 'look [Image #1] [Image #2] ', { 1: '/h/img-1.png', 2: null }, 'look Image: /h/img-1.png '],
]) {
  test(`expandAttachChips: ${label}`, () => {
    assert.strictEqual(expandAttachChips(text, { images: paths }), want);
  });
}

for (const [label, text, maps, want] of [
  ['a file chip becomes its File: line', `see ${fileChip(1)}`, { files: { 1: '/h/f.pdf' } }, 'see File: /h/f.pdf '],
  ['a file chip whose upload failed is dropped', `${fileChip(2)}x`, { files: { 2: null } }, 'x'],
  ['image and file chips of the same number expand from their own maps', '[Image #1] [File #1] ', { images: { 1: '/h/i.png' }, files: { 1: '/h/f.pdf' } }, 'Image: /h/i.png File: /h/f.pdf '],
  ['a file chip with only an image map stays', '[File #1] ok', { images: { 1: '/h/i.png' } }, '[File #1] ok'],
]) {
  test(`expandAttachChips: ${label}`, () => {
    assert.strictEqual(expandAttachChips(text, maps), want);
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
  const log = { uploads: [], toasts: [], writes: [], draft: '', paths: {}, prevented: 0, order: [], added: [], attached: [], dropped: [], files: 0 };
  let n = 0;
  const handler = ptyImagePasteHandler({
    isWeb: () => web,
    readImages: readImages || ((items) => clipboardImages(items, FakeReader)),
    upload: upload || (async (images) => { log.uploads.push(images); return reply; }),
    toast: (m) => log.toasts.push(m),
    nextImage: () => { n += 1; return n; },
    append: (added) => { log.order.push('append'); log.added.push(...added); for (const a of added) { log.draft += a.chip; log.paths[a.n] = a.path || null; } },
    attached: (done) => { log.order.push('attached'); log.attached.push(...done); for (const a of done) log.paths[a.n] = a.path; },
    drop: (items) => { log.order.push('drop'); log.dropped.push(...items); for (const { n } of items) { log.draft = removeChip(log.draft, 'image', n); delete log.paths[n]; } },
    writePty: (d) => { log.order.push('write'); log.writes.push(d); },
    pickFiles: async (files) => { log.order.push('pick'); log.picked = files; },
  });
  const event = {
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => { log.files += 1; return { url: 'data:image/png;base64,QUJD' }; } }] },
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

test('on the web an { ok:false } upload toasts the error and drops the chip', async () => {
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
  const p = src.match(/composerEl\.addEventListener\('paste', ptyImagePasteHandler\(\{([\s\S]*?)\n {4}\}\)\);/u);
  assert.ok(p, 'renderer.js registers the shared paste handler on composerEl');
  assert.match(p[1], /\.\.\.ptyImageSink,/u);
  assert.match(p[1], /isWeb: \(\) => Boolean\(window\.__CLODEX_WEB__ \|\| !window\.require\)/u);
  assert.match(p[1], /readImages: \(items\) => clipboardImages\(items, FileReader\)/u);
  assert.match(p[1], /pickFiles: attachPtyFiles,/u);
  const m = src.match(/const ptyImageSink = composerEl \? \{([\s\S]*?)\n {2}\} : null;/u);
  assert.ok(m, 'renderer.js builds the image sink the paste handler and the paperclip share');
  assert.match(m[1], /upload: \(images\) => window\.api\.seatImageUpload\(name, images\)/u);
  assert.match(m[1], /uploadFiles: \(files\) => window\.api\.seatFileUpload\(name, files\)/u);
  assert.match(m[1], /if \(menuMirror\.on\(\)\) syncMenuMirror\(\);/u);
  assert.match(m[1], /attachPathsOf\(kind\)\[n\] = path \|\| null;/u);
  assert.match(src, /ptyComposerWrites\(expandAttachChips\(text, \{ images: imagePaths, files: filePaths \}\)\)/u);
  assert.match(src, /pastedImagePaths = \{\};\n\s*pastedFilePaths = \{\};\n\s*pastedThumbs = \[\];\n\s*syncImageStrip\(\);/u, 'sending clears the thumbnail strip');
  assert.match(m[1], /if \(image \|\| file\) pastedThumbs\.push\(\{ n, chip, kind, image, file, path, pending \}\);/u);
  assert.match(m[1], /attached: \(done\) => \{[\s\S]*?t\.chip === chip && t\.image === image && t\.file === file[\s\S]*?attachPathsOf\(thumb\.kind\)\[thumb\.n\] = path;/u, 'attached binds only the tile it appended');
  assert.match(m[1], /drop: \(items\) => \{[\s\S]*?t\.chip === chip && t\.image === image && t\.file === file[\s\S]*?if \(!thumb\) continue;\n\s*composerEl\.value = removeChip\(composerEl\.value, thumb\.kind, thumb\.n\);\n\s*delete attachPathsOf\(thumb\.kind\)\[thumb\.n\];[\s\S]*?syncImageStrip\(\);/u, 'drop removes only the chip whose tile it appended');
  assert.match(src, /composerEl\.addEventListener\('input', pruneImageStrip\);/u, 'typing over a chip prunes its thumb');
});

test('on the desktop the pasted image reaches append for its thumb and Ctrl-V still fires once', async () => {
  const { log, paste } = pasteRig({ web: false });
  await paste();
  assert.deepStrictEqual(log.added, [{ n: 1, chip: '[Image #1] ', path: null, image: { mediaType: 'image/png', data: 'QUJD' } }]);
  assert.deepStrictEqual(log.writes, ['\x16']);
  assert.deepStrictEqual(log.order, ['append', 'write']);
});

test('on the web the pasted image reaches append pending, then attached beside its uploaded path', async () => {
  const { log, paste } = pasteRig({ web: true, reply: { ok: true, paths: ['/h/img-1.png'] } });
  await paste();
  const image = { mediaType: 'image/png', data: 'QUJD' };
  assert.deepStrictEqual(log.added, [{ n: 1, chip: '[Image #1] ', path: null, image, pending: true }]);
  assert.deepStrictEqual(log.attached, [{ n: 1, chip: '[Image #1] ', path: '/h/img-1.png', image, pending: false }]);
  assert.strictEqual(log.attached[0].image, log.added[0].image);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('on the web the pasted image is appended pending before the upload resolves', async () => {
  const d = deferred();
  const { log, paste } = pasteRig({ web: true, upload: (images) => { log.order.push('upload'); log.uploads.push(images); return d.promise; } });
  const done = paste();
  await new Promise(setImmediate);
  assert.deepStrictEqual(log.order, ['append', 'upload']);
  assert.deepStrictEqual(log.added.map((a) => [a.n, a.path, a.pending]), [[1, null, true]]);
  assert.strictEqual(log.draft, '[Image #1] ');
  assert.deepStrictEqual(log.attached, []);
  d.resolve({ ok: true, paths: ['/h/img-1.png'] });
  await done;
  assert.deepStrictEqual(log.order, ['append', 'upload', 'attached']);
  assert.deepStrictEqual(log.paths, { 1: '/h/img-1.png' });
});

test('on the web a failed upload drops the pending items it appended and toasts, never attaching', async () => {
  const d = deferred();
  const { log, paste } = pasteRig({ web: true, upload: () => d.promise });
  const done = paste();
  await new Promise(setImmediate);
  assert.strictEqual(log.draft, '[Image #1] ');
  d.resolve({ ok: false, error: 'image larger than 5 MB' });
  await done;
  assert.deepStrictEqual(log.dropped.map(({ n, image }) => ({ n, image })), [{ n: 1, image: { mediaType: 'image/png', data: 'QUJD' } }]);
  assert.strictEqual(log.dropped[0].image, log.added[0].image);
  assert.deepStrictEqual(log.toasts, ['image larger than 5 MB']);
  assert.deepStrictEqual(log.attached, []);
  assert.deepStrictEqual(log.order, ['append', 'drop']);
  assert.strictEqual(log.draft, '');
});

test('on the web a clipboard with no readable image toasts and appends nothing', async () => {
  const { log, paste } = pasteRig({ web: true, readImages: async () => [] });
  await paste();
  assert.deepStrictEqual(log.toasts, ['No readable image on the clipboard.']);
  assert.deepStrictEqual(log.order, []);
  assert.deepStrictEqual(log.uploads, []);
});

test('the clipboard items are read inside the paste dispatch, before its first await', async () => {
  const { log, paste } = pasteRig({ web: true, reply: { ok: true, paths: ['/h/img-1.png'] } });
  const done = paste();
  assert.strictEqual(log.files, 1);
  await done;
});

test('on the web a clipboard read that throws synchronously toasts and appends nothing', async () => {
  const { log, paste } = pasteRig({ web: true, readImages: () => { throw new Error('reader broke'); } });
  await paste();
  assert.deepStrictEqual(log.toasts, ['No readable image on the clipboard.']);
  assert.deepStrictEqual(log.order, []);
  assert.deepStrictEqual(log.uploads, []);
});

for (const [label, readImages] of [
  ['rejects', async () => { throw new Error('reader broke'); }],
  ['throws synchronously', () => { throw new Error('reader broke'); }],
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

test('removeChip drops that chip of that kind only and leaves its neighbours', () => {
  assert.strictEqual(removeChip('a [Image #1] b [Image #2] c', 'image', 1), 'a b [Image #2] c');
  assert.strictEqual(removeChip('[Image #12] x', 'image', 1), '[Image #12] x');
  assert.strictEqual(removeChip('[Image #1] [File #1] x', 'file', 1), '[Image #1] x');
});

test('chippedAttachments keeps only tiles whose chip is still in the draft', () => {
  const img = { mediaType: 'image/png', data: 'QUJD' };
  const file = { name: 'r.pdf', size: 3, mediaType: 'application/pdf', data: 'QUJD' };
  const items = [{ n: 1, chip: '[Image #1] ', image: img }, { n: 2, chip: '[Image #2] ', image: img }, { n: 3, chip: '[Image #3] ', image: null }, { n: 1, chip: '[File #1] ', file }];
  assert.deepStrictEqual(chippedAttachments(items, '[Image #2] [Image #3] [File #1] hi'), [items[1], items[3]]);
  assert.deepStrictEqual(chippedAttachments(items, ''), []);
});

function fakeNode(tag) {
  const node = { tagName: tag, children: [], listeners: {}, hidden: true, className: '', title: '', textContent: '' };
  node.appendChild = (c) => node.children.push(c);
  node.append = (...cs) => node.children.push(...cs);
  node.replaceChildren = () => { node.children = []; };
  node.addEventListener = (type, fn) => { node.listeners[type] = fn; };
  return node;
}

test('renderAttachStrip draws one removable thumb per image, titled by where the image lives, and hides when empty', () => {
  const el = fakeNode('div');
  el.ownerDocument = { createElement: fakeNode };
  const removed = [];
  const items = [{ n: 1, image: { mediaType: 'image/png', data: 'QUJD' }, path: null }, { n: 3, image: { mediaType: 'image/jpeg', data: 'REVG' }, path: '/h/img-3.jpg' }, { n: 4, image: { mediaType: 'image/png', data: 'R0hJ' }, path: null, pending: true }];
  renderAttachStrip(el, items, (it) => removed.push(it.n));
  assert.strictEqual(el.hidden, false);
  assert.deepStrictEqual(el.children.map((t) => [t.className, t.title, t.children[0].src]), [
    ['seat-attachment', 'Removes the mark; the CLI keeps the pasted image', 'data:image/png;base64,QUJD'],
    ['seat-attachment', 'Remove image', 'data:image/jpeg;base64,REVG'],
    ['seat-attachment seat-attachment-pending', 'Uploading…', 'data:image/png;base64,R0hJ'],
  ]);
  el.children[2].children[1].listeners.click();
  assert.deepStrictEqual(removed, [4]);
  removed.length = 0;
  const rm = el.children[1].children[1];
  assert.strictEqual(rm.className, 'seat-attachment-remove');
  rm.listeners.click();
  assert.deepStrictEqual(removed, [3]);
  renderAttachStrip(el, [], () => {});
  assert.strictEqual(el.hidden, true);
  assert.deepStrictEqual(el.children, []);
});

test('renderAttachStrip draws a file tile with its name, mid-truncated, and its size, dimmed while uploading', () => {
  const el = fakeNode('div');
  el.ownerDocument = { createElement: fakeNode };
  const removed = [];
  const done = { n: 1, chip: '[File #1] ', file: { name: 'report.pdf', size: 12288 }, path: '/h/f.pdf' };
  const pending = { n: 2, chip: '[File #2] ', file: { name: 'a-very-long-quarterly-report-name.pdf', size: 900 }, path: null, pending: true };
  renderAttachStrip(el, [done, pending], (it) => removed.push(it));
  assert.deepStrictEqual(el.children.map((t) => [t.className, t.title]), [
    ['seat-attachment seat-attachment-file', 'Remove file'],
    ['seat-attachment seat-attachment-file seat-attachment-pending', 'Uploading…'],
  ]);
  assert.deepStrictEqual(el.children.map((t) => t.children.map((c) => [c.className, c.textContent, c.title])), [
    [['seat-attachment-name', '📄 report.pdf', 'report.pdf'], ['seat-attachment-size', '12.0 KB', ''], ['seat-attachment-remove', '×', '']],
    [['seat-attachment-name', '📄 a-very-long-…rt-name.pdf', 'a-very-long-quarterly-report-name.pdf'], ['seat-attachment-size', '900 B', ''], ['seat-attachment-remove', '×', '']],
  ]);
  el.children[0].children[2].listeners.click();
  assert.deepStrictEqual(removed, [done]);
});

test('a pending thumb is drawn dimmed', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.seat-attachment-pending \{\n {2}opacity: 0\.5;\n\}/u);
});

function composerHarness(opts = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const slice = (from, to) => {
    const i = src.indexOf(from);
    const j = src.indexOf(to, i);
    assert.ok(i >= 0 && j > i, `renderer.js carries ${from}`);
    assert.strictEqual(src.indexOf(from, i + 1), -1, `renderer.js carries ${from} once`);
    assert.strictEqual(src.indexOf(to, j + 1), -1, `renderer.js carries ${to} once`);
    return src.slice(i, j);
  };
  const start = src.indexOf('ptyImagePasteHandler({', src.indexOf("composerEl.addEventListener('paste', "));
  const web = opts.web !== false;
  const handlerSrc = src.slice(start, src.indexOf('\n    }));', start) + '\n    })'.length);
  const document = { createElement: (tag) => {
    const node = fakeNode(tag);
    node.style = {};
    node.ownerDocument = document;
    Object.defineProperty(node, 'childElementCount', { get: () => node.children.length });
    return node;
  } };
  const uploads = [];
  const writes = [];
  const toasts = [];
  const env = {
    composerEl: { value: '', offsetHeight: 40, setSelectionRange() {} },
    document,
    menuMirror: { on: () => false },
    composerKit: { fit() {} },
    composerTrigger: { resetSpan() {} },
    liveSplit: null,
    writePty: (d) => writes.push(d),
    window: { __CLODEX_WEB__: web, require: web ? undefined : () => ({}), api: {
      seatImageUpload: (_name, images) => { const d = deferred(); d.images = images; d.kind = 'image'; uploads.push(d); return d.promise; },
      seatFileUpload: (_name, files) => { const d = deferred(); d.files = files; d.kind = 'file'; uploads.push(d); return d.promise; },
    } },
    clipboardImages,
    readImageFile,
    attachImages,
    FileReader: FakeReader,
    showToast: (m) => toasts.push(m),
    SEAT_IMAGE_MAX: 5,
    name: 'seat',
    ptyImagePasteHandler, chippedAttachments, renderAttachStrip, removeChip, ptyComposerWrites, expandAttachChips,
    splitAttachable, rejectedNotice, readAttachFile, attachFiles,
  };
  const names = Object.keys(env);
  const body = [
    slice('let pastedImages = 0;', '  const onMenuKey'),
    `const handler = ${handlerSrc};`,
    'return { handler, attachFiles: attachPtyFiles, send: sendPtyComposer, prune: pruneImageStrip, paths: () => pastedImagePaths, filePaths: () => pastedFilePaths, strip: imageStripEl };',
  ].join('\n');
  const out = new Function(...names, body)(...names.map((n) => env[n]));
  const event = {
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ url: 'data:image/png;base64,QUJD' }) }] },
    preventDefault() {},
  };
  const paste = () => out.handler(event);
  return { ...out, el: env.composerEl, uploads, writes, toasts, paste, pasteItems: (items) => out.handler({ clipboardData: { items }, preventDefault() {} }) };
}

test('ENTER: a late upload failure from a sent draft leaves the next draft\'s [Image #1] chip in place', async () => {
  const h = composerHarness();
  const first = h.paste();
  await new Promise(setImmediate);
  h.el.value += 'look';
  h.send();
  assert.strictEqual(h.el.value, '');
  const second = h.paste();
  await new Promise(setImmediate);
  assert.strictEqual(h.el.value, '[Image #1] ');
  h.uploads[0].resolve({ ok: false, error: 'image larger than 5 MB' });
  await first;
  assert.strictEqual(h.el.value, '[Image #1] ');
  assert.ok(Object.hasOwn(h.paths(), 1));
  h.uploads[1].resolve({ ok: true, paths: ['/h/img-2.png'] });
  await second;
  assert.deepStrictEqual(h.paths(), { 1: '/h/img-2.png' });
});

test('ENTER: a pending chip typed over still binds its path when the upload lands, and sends once restored', async () => {
  const h = composerHarness();
  const done = h.paste();
  await new Promise(setImmediate);
  h.el.value = 'hi ';
  h.prune();
  assert.strictEqual(h.strip.children.length, 0);
  h.uploads[0].resolve({ ok: true, paths: ['/h/img-1.png'] });
  await done;
  assert.strictEqual(h.paths()[1], '/h/img-1.png');
  h.el.value = 'hi [Image #1] ';
  h.prune();
  assert.strictEqual(h.strip.children.length, 1);
  h.send();
  assert.deepStrictEqual(h.writes, ptyComposerWrites('hi Image: /h/img-1.png '));
  const again = h.paste();
  await new Promise(setImmediate);
  assert.strictEqual(h.strip.children.length, 1);
  h.strip.children[0].children[1].listeners.click();
  assert.strictEqual(h.el.value, '');
  h.el.value = '[Image #1] ';
  h.prune();
  assert.strictEqual(h.strip.children.length, 0);
  h.uploads[1].resolve({ ok: true, paths: ['/h/img-2.png'] });
  await again;
  assert.ok(!Object.hasOwn(h.paths(), 1));
  assert.strictEqual(h.strip.children.length, 0);
});

function attachRig(upload) {
  const log = { toasts: [], order: [], added: [], attached: [], dropped: [], draft: '' };
  let n = 0;
  const deps = {
    upload,
    toast: (m) => log.toasts.push(m),
    nextImage: () => { n += 1; return n; },
    append: (added) => { log.order.push('append'); log.added.push(...added); for (const a of added) log.draft += a.chip; },
    attached: (done) => { log.order.push('attached'); log.attached.push(...done); },
    drop: (items) => { log.order.push('drop'); log.dropped.push(...items); for (const { n: k, file } of items) log.draft = removeChip(log.draft, file ? 'file' : 'image', k); },
  };
  return { log, deps };
}

test('attachImages appends every image pending, uploads them once, then attaches each with its path', async () => {
  const uploads = [];
  const { log, deps } = attachRig(async (images) => { log.order.push('upload'); uploads.push(images); return { ok: true, paths: ['/h/img-1.png', '/h/img-2.jpg'] }; });
  const a = { mediaType: 'image/png', data: 'QUJD' };
  const b = { mediaType: 'image/jpeg', data: 'REVG' };
  await attachImages({ ...deps, images: [a, b] });
  assert.deepStrictEqual(uploads, [[a, b]]);
  assert.deepStrictEqual(log.order, ['append', 'upload', 'attached']);
  assert.deepStrictEqual(log.added.map((x) => [x.n, x.chip, x.path, x.pending]), [[1, '[Image #1] ', null, true], [2, '[Image #2] ', null, true]]);
  assert.deepStrictEqual(log.attached.map((x) => [x.n, x.path, x.pending]), [[1, '/h/img-1.png', false], [2, '/h/img-2.jpg', false]]);
  assert.strictEqual(log.draft, '[Image #1] [Image #2] ');
  assert.deepStrictEqual(log.toasts, []);
});

test('attachImages on a failed upload drops the chips it appended and toasts the error', async () => {
  const { log, deps } = attachRig(async () => ({ ok: false, error: 'at most 5 images per message' }));
  await attachImages({ ...deps, images: [{ mediaType: 'image/png', data: 'QUJD' }] });
  assert.deepStrictEqual(log.order, ['append', 'drop']);
  assert.strictEqual(log.dropped[0], log.added[0]);
  assert.strictEqual(log.draft, '');
  assert.deepStrictEqual(log.toasts, ['at most 5 images per message']);
  assert.deepStrictEqual(log.attached, []);
});

test('attachImages with nothing readable toasts and never uploads', async () => {
  const { log, deps } = attachRig(async () => { throw new Error('never'); });
  await attachImages({ ...deps, images: [] });
  assert.deepStrictEqual(log.toasts, ['No readable image.']);
  assert.deepStrictEqual(log.order, []);
});

for (const [label, web, items, want] of [
  ['an empty web paste names the paperclip', true, [], ['Your browser did not hand over the clipboard image — use the paperclip to attach it.']],
  ['an empty desktop paste stays silent', false, [], []],
  ['a web text paste stays silent', true, [{ kind: 'string', type: 'text/plain' }], []],
]) {
  test(`paste handler: ${label}`, async () => {
    const toasts = [];
    let prevented = 0;
    const handler = ptyImagePasteHandler({
      isWeb: () => web, readImages: async () => [], upload: async () => ({ ok: true }), toast: (m) => toasts.push(m),
      nextImage: () => 1, append: () => {}, attached: () => {}, drop: () => {}, writePty: () => {},
    });
    await handler({ clipboardData: { items }, preventDefault: () => { prevented += 1; } });
    assert.deepStrictEqual(toasts, want);
    assert.strictEqual(prevented, 0);
  });
}

test('STRIPPED_PASTE_NOTICE is the exported toast text', () => {
  assert.strictEqual(STRIPPED_PASTE_NOTICE, 'Your browser did not hand over the clipboard image — use the paperclip to attach it.');
});

test('ENTER: on the desktop a picked file uploads through seatImageUpload, never Ctrl-V, and its chip binds the uploaded path', async () => {
  const h = composerHarness({ web: false });
  const done = h.attachFiles([{ type: 'image/png', size: 3, url: 'data:image/png;base64,QUJD' }]);
  await new Promise(setImmediate);
  assert.strictEqual(h.el.value, '[Image #1] ');
  assert.strictEqual(h.uploads.length, 1);
  assert.deepStrictEqual(h.uploads[0].images, [{ mediaType: 'image/png', data: 'QUJD' }]);
  h.uploads[0].resolve({ ok: true, paths: ['/h/img-1.png'] });
  await done;
  assert.deepStrictEqual(h.paths(), { 1: '/h/img-1.png' });
  assert.deepStrictEqual(h.writes, []);
});

test('both composers mount the paperclip and the web drop on terminalContainer attaches images through the seat entry', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const stream = src.slice(src.indexOf('function createStreamSeatPane('), src.indexOf('function createTerminal('));
  assert.match(stream, /attachPicker\(\{ doc: document, parent: wrapperEl, onFiles: \(files\) => attachStreamFiles\(files\) \}\);/u);
  assert.match(stream, /wrapperEl\.appendChild\(attachButton\(document, \(\) => streamPicker\.open\(\)\)\);/u);
  assert.match(stream, /attachPickedFiles: attachStreamFiles,/u);
  assert.match(src, /ptyPicker = attachPicker\(\{ doc: document, parent: wrapperEl, onFiles: attachPtyFiles \}\);/u);
  assert.match(src, /wrapperEl\.appendChild\(attachButton\(document, \(\) => ptyPicker\.open\(\)\)\);/u);
  assert.doesNotMatch(src, /attachBtn\.hidden = /u, 'the pty paperclip is never hidden at build time, when the sidebar row does not exist yet');
  assert.doesNotMatch(src.slice(src.indexOf('function createTerminal('), src.indexOf("terminalContainer.addEventListener('drop'")), /\.seat-attach-btn|attachButton\([^)]*\)\.hidden/u);
  assert.match(src, /attachImages\(\{ \.\.\.ptyImageSink, images: read\.filter\(Boolean\) \}\)/u);
  assert.match(src, /attachFiles\(\{ \.\.\.ptyImageSink, upload: ptyImageSink\.uploadFiles, files: read\.filter\(Boolean\) \}\)/u);
  assert.match(src, /syncMenuMirror, attachPickedFiles: composerEl \? attachPtyFiles : null \}/u);
  assert.match(src, /stream, liveSplit: null, attachPickedFiles: stream\.attachPickedFiles \}/u);
  const drop = src.slice(src.indexOf("terminalContainer.addEventListener('drop'"), src.indexOf("const { webUtils } = window.require('electron');"));
  assert.match(drop, /if \(window\.__CLODEX_WEB__ \|\| !window\.require\) \{\n\s*const sink = /u);
  assert.match(drop, /if \(sink\) sink\(files\);/u);
  assert.match(drop, /const sink = entry && entry\.attachPickedFiles && \(entry\.stream \|\| ptyComposerShown\(entry\)\) \? entry\.attachPickedFiles : null;/u);
  assert.match(drop, /else if \(entry && entry\.attachPickedFiles\) showToast\('Switch to the composer view to attach files\.'/u);
  assert.match(drop, /else showToast\('Dropping files needs the desktop app/u);
  assert.match(drop, /if \(!entry\) return;\n {2}if \(entry\.stream\) \{ entry\.attachPickedFiles\(files\); return; \}/u);
  assert.match(stream, /items\.filter\(\(it\) => it\.kind === 'file'\)/u);
  assert.doesNotMatch(stream, /addEventListener\('drop'/u);
  assert.doesNotMatch(src, /imageFilesOf/u);
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.seat-composer\.seat-composer-attach \{\n {2}padding-right: 32px;\n {2}scrollbar-gutter: stable;\n\}/u);
  assert.match(css, /\.seat-composer\[hidden\] ~ \.seat-attach-btn \{\n {2}display: none;\n\}/u);
});

test('a pick of more than five images uploads the first five and toasts the overflow up front', async () => {
  const h = composerHarness({ web: false });
  const files = ['QUFB', 'QkJC', 'Q0ND', 'RERE', 'RUVF', 'RkZG', 'R0dH'].map((d) => ({ type: 'image/png', size: 3, url: `data:image/png;base64,${d}` }));
  const done = h.attachFiles(files);
  assert.deepStrictEqual(h.toasts, ['2 image(s) not attached — at most 5 per message.']);
  await new Promise(setImmediate);
  assert.strictEqual(h.uploads.length, 1);
  assert.deepStrictEqual(h.uploads[0].images.map((i) => i.data), ['QUFB', 'QkJC', 'Q0ND', 'RERE', 'RUVF']);
  h.uploads[0].resolve({ ok: true, paths: ['/1', '/2', '/3', '/4', '/5'] });
  await done;
  assert.strictEqual(h.el.value, '[Image #1] [Image #2] [Image #3] [Image #4] [Image #5] ');
});

const pdfFile = (name = 'report.pdf', url = 'data:application/pdf;base64,JVBERg==') => ({ name, size: 12288, type: 'application/pdf', url });

test('ENTER: a picked pdf uploads once through seatFileUpload as { name, data }, chips [File #1], binds its path, and sends beside an image', async () => {
  const h = composerHarness({ web: false });
  const done = h.attachFiles([{ name: 'i.png', type: 'image/png', size: 3, url: 'data:image/png;base64,QUJD' }, pdfFile()]);
  await new Promise(setImmediate);
  assert.deepStrictEqual(h.uploads.map((u) => u.kind), ['image', 'file']);
  assert.deepStrictEqual(h.uploads[1].files, [{ name: 'report.pdf', data: 'JVBERg==' }]);
  assert.strictEqual(h.el.value, '[Image #1] [File #1] ');
  assert.deepStrictEqual(h.strip.children.map((t) => t.className), ['seat-attachment seat-attachment-pending', 'seat-attachment seat-attachment-file seat-attachment-pending']);
  h.uploads[0].resolve({ ok: true, paths: ['/h/i.png'] });
  h.uploads[1].resolve({ ok: true, paths: ['/h/f.pdf'] });
  await done;
  assert.deepStrictEqual([h.paths(), h.filePaths()], [{ 1: '/h/i.png' }, { 1: '/h/f.pdf' }]);
  h.el.value = `hi ${h.el.value}`;
  h.send();
  assert.deepStrictEqual(h.writes, ptyComposerWrites('hi Image: /h/i.png File: /h/f.pdf '));
  assert.deepStrictEqual(h.toasts, []);
});

for (const web of [true, false]) {
  test(`${web ? 'ENTER: on the web' : 'on the desktop'} a pasted pdf uploads through seatFileUpload, chips [File #1] and binds its path`, async () => {
    const h = composerHarness({ web });
    const done = h.pasteItems([{ kind: 'file', type: 'application/pdf', getAsFile: () => pdfFile() }]);
    await new Promise(setImmediate);
    assert.deepStrictEqual(h.uploads.map((u) => u.kind), ['file']);
    assert.deepStrictEqual(h.uploads[0].files, [{ name: 'report.pdf', data: 'JVBERg==' }]);
    assert.strictEqual(h.el.value, '[File #1] ');
    h.uploads[0].resolve({ ok: true, paths: ['/h/f.pdf'] });
    await done;
    assert.deepStrictEqual(h.filePaths(), { 1: '/h/f.pdf' });
    assert.deepStrictEqual(h.writes, []);
  });
}

test('a failed file upload drops its chip and toasts the error', async () => {
  const h = composerHarness({ web: false });
  const done = h.attachFiles([pdfFile()]);
  await new Promise(setImmediate);
  assert.strictEqual(h.el.value, '[File #1] ');
  h.uploads[0].resolve({ ok: false, error: 'file larger than 10 MB: report.pdf' });
  await done;
  assert.strictEqual(h.el.value, '');
  assert.deepStrictEqual(h.filePaths(), {});
  assert.deepStrictEqual(h.toasts, ['file larger than 10 MB: report.pdf']);
  assert.strictEqual(h.strip.children.length, 0);
});

test('2 png + 1 pdf reach both uploads, counters start at 1 each', async () => {
  const h = composerHarness({ web: false });
  const done = h.attachFiles([
    { name: 'a.png', type: 'image/png', size: 3, url: 'data:image/png;base64,QUFB' },
    { name: 'b.png', type: 'image/png', size: 3, url: 'data:image/png;base64,QkJC' },
    pdfFile(),
  ]);
  await new Promise(setImmediate);
  assert.deepStrictEqual(h.uploads.map((u) => [u.kind, (u.images || u.files).length]), [['image', 2], ['file', 1]]);
  assert.strictEqual(h.el.value, '[Image #1] [Image #2] [File #1] ');
  h.uploads[0].resolve({ ok: true, paths: ['/h/a.png', '/h/b.png'] });
  h.uploads[1].resolve({ ok: true, paths: ['/h/f.pdf'] });
  await done;
});

test('a pick of seven pdfs toasts the overflow before any read and uploads five', async () => {
  const h = composerHarness({ web: false });
  const files = ['1', '2', '3', '4', '5', '6', '7'].map((n) => pdfFile(`${n}.pdf`));
  const done = h.attachFiles(files);
  assert.deepStrictEqual(h.toasts, ['2 file(s) not attached — at most 5 per message.']);
  assert.strictEqual(h.uploads.length, 0);
  await new Promise(setImmediate);
  assert.deepStrictEqual(h.uploads[0].files.map((f) => f.name), ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf']);
  h.uploads[0].resolve({ ok: true, paths: ['/1', '/2', '/3', '/4', '/5'] });
  await done;
  assert.strictEqual(h.el.value, '[File #1] [File #2] [File #3] [File #4] [File #5] ');
});

test('× on a file tile clears its chip and its path', async () => {
  const h = composerHarness({ web: false });
  const done = h.attachFiles([pdfFile()]);
  await new Promise(setImmediate);
  h.uploads[0].resolve({ ok: true, paths: ['/h/f.pdf'] });
  await done;
  assert.deepStrictEqual(h.filePaths(), { 1: '/h/f.pdf' });
  const tile = h.strip.children[0];
  assert.strictEqual(tile.className, 'seat-attachment seat-attachment-file');
  tile.children[2].listeners.click();
  assert.strictEqual(h.el.value, '');
  assert.deepStrictEqual(h.filePaths(), {});
  assert.strictEqual(h.strip.children.length, 0);
});

test('attachFiles with nothing readable toasts and never uploads', async () => {
  const { log, deps } = attachRig(async () => { throw new Error('never'); });
  await attachFiles({ ...deps, nextFile: () => 1, files: [] });
  assert.deepStrictEqual(log.toasts, ['No readable file.']);
  assert.deepStrictEqual(log.order, []);
});

test('attachFiles with a falsy reply drops and toasts the default', async () => {
  const { log, deps } = attachRig(async () => null);
  await attachFiles({ ...deps, nextFile: () => 1, files: [{ name: 'r.pdf', size: 3, mediaType: 'application/pdf', data: 'QUJD' }] });
  assert.deepStrictEqual(log.order, ['append', 'drop']);
  assert.deepStrictEqual(log.added.map((a) => [a.n, a.chip, a.path, a.pending]), [[1, '[File #1] ', null, true]]);
  assert.deepStrictEqual(log.toasts, ['File upload failed.']);
});

test('readAttachFile reads { name, size, mediaType, data }, and an unreadable file is null', async () => {
  assert.deepStrictEqual(await readAttachFile(pdfFile(), FakeReader), { name: 'report.pdf', size: 12288, mediaType: 'application/pdf', data: 'JVBERg==' });
  assert.strictEqual(await readAttachFile({ name: 'x', size: 1 }, FakeReader), null);
});
