'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { peekFile, RAW_CHUNK_MAX } = require('../file-peek');
const { fetchWhole, FETCH_MAX } = require('../renderer/lib/file-fetch');
const { createFileTab } = require('../renderer/file-tab');
const { registerIpcHandlers } = require('../ipc-handlers');

const PNG_HEAD = Buffer.from('89504E470D0A1A0A0000000D49484452', 'hex');

function tmp(t) {
  const dir = mkTmpRoot('clx-rfs-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('peekFile raw: a chunk of the asked range as base64, clamped to RAW_CHUNK_MAX, truncated until the end, image type named', (t) => {
  assert.strictEqual(RAW_CHUNK_MAX, 1024 * 1024);
  const dir = tmp(t);
  const bytes = Buffer.concat([PNG_HEAD, Buffer.alloc(RAW_CHUNK_MAX + 100, 0x42)]);
  const p = path.join(dir, 'big.png');
  fs.writeFileSync(p, bytes);
  const mtime = Math.trunc(fs.statSync(p).mtimeMs);
  const size = bytes.length;
  assert.deepStrictEqual(peekFile(p, { raw: true, offset: 0, length: 16 }), {
    ok: true, path: p, size, mtime, offset: 0, length: 16, truncated: true, binary: true,
    image: 'image/png', content: PNG_HEAD.toString('base64'),
  });
  const clamped = peekFile(p, { raw: true, offset: 0, length: 5 * RAW_CHUNK_MAX });
  assert.deepStrictEqual([clamped.length, Buffer.from(clamped.content, 'base64').length, clamped.truncated], [RAW_CHUNK_MAX, RAW_CHUNK_MAX, true]);
  const tail = peekFile(p, { raw: true, offset: RAW_CHUNK_MAX, length: RAW_CHUNK_MAX });
  assert.deepStrictEqual([tail.offset, tail.length, tail.truncated], [RAW_CHUNK_MAX, 116, false]);
  assert.ok(Buffer.from(tail.content, 'base64').equals(bytes.subarray(RAW_CHUNK_MAX)));
  const bin = path.join(dir, 'blob.bin');
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3, 0, 5]));
  assert.deepStrictEqual(peekFile(bin, { raw: true, offset: 2, length: 3 }), {
    ok: true, path: bin, size: 6, mtime: Math.trunc(fs.statSync(bin).mtimeMs), offset: 2, length: 3, truncated: true, binary: true,
    image: null, content: Buffer.from([2, 3, 0]).toString('base64'),
  });
  assert.strictEqual(peekFile(bin).content, null, 'without raw a binary still refuses');
});

test('fetchWhole concatenates raw chunks in order and refuses past FETCH_MAX', async () => {
  const bytes = Buffer.concat([PNG_HEAD, Buffer.from('abcdefghij')]);
  const calls = [];
  const peek = (p, opts) => {
    calls.push([p, opts]);
    const end = Math.min(bytes.length, opts.offset + 10);
    return Promise.resolve({ ok: true, size: bytes.length, image: opts.offset === 0 ? 'image/png' : null,
      truncated: end < bytes.length, content: bytes.subarray(opts.offset, end).toString('base64') });
  };
  const got = await fetchWhole(peek, '/x/a.png', bytes.length);
  assert.deepStrictEqual([got.ok, got.image, Buffer.from(got.bytes).equals(bytes)], [true, 'image/png', true]);
  assert.deepStrictEqual(calls.map(([p, o]) => [p, o.raw, o.offset]), [['/x/a.png', true, 0], ['/x/a.png', true, 10], ['/x/a.png', true, 20]]);
  let asked = 0;
  const refused = await fetchWhole(() => { asked += 1; return {}; }, '/x/huge.bin', FETCH_MAX + 1);
  assert.deepStrictEqual([refused.ok, asked, /64 MB fetch limit/.test(refused.error)], [false, 0, true]);
  const grown = await fetchWhole(() => ({ ok: true, size: FETCH_MAX + 1, truncated: true, content: 'AA==' }), '/x/g.bin', 10);
  assert.strictEqual(grown.ok, false, 'the reply size is checked too');
  const failed = await fetchWhole(() => Promise.reject(new Error('peer gone')), '/x/a', 3);
  assert.deepStrictEqual(failed, { ok: false, error: 'peer gone' });
});

function fakeDoc() {
  const mk = (tag) => {
    const classes = new Set();
    const listeners = {};
    const n = {
      tag, children: [], style: {}, dataset: {}, textContent: '', title: '', hidden: false, disabled: false,
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      classList: {
        toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
        contains: (c) => classes.has(c),
      },
      append: (...xs) => { n.children.push(...xs); },
      appendChild: (x) => { n.children.push(x); return x; },
      replaceChildren: (...xs) => { n.children = xs; },
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      querySelector: () => null,
      querySelectorAll: () => [],
      fire: (ev) => listeners[ev] && listeners[ev]({}),
    };
    return n;
  };
  return { createElement: mk, createTextNode: (s) => ({ textContent: s }) };
}

function tabFor(showOpen) {
  const calls = [];
  const on = new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) });
  const v = createFileTab({ doc: fakeDoc(), filePath: '/r/big.png', editable: false, showOpen, on });
  const controls = v.el.children[0].children[2];
  const byText = (txt) => controls.children.filter((b) => b.textContent === txt);
  return { v, calls, byText, body: v.el.children[2] };
}

test('file-tab: a remote/web viewer shows Save… and Open wired to saveAs/openLocal, and the >4 MB note names them', () => {
  const { v, calls, byText, body } = tabFor(false);
  const [save] = byText('Save…');
  const opens = byText('Open');
  assert.deepStrictEqual([save.style.display, opens.map((b) => b.style.display)], [undefined, ['none', undefined]]);
  v.setData({ ok: true, path: '/r/big.png', size: 5 * 1024 * 1024, image: 'image/png', binary: true, content: null }, { ok: false });
  v.render({ view: 'file' });
  assert.strictEqual(body.children[0].textContent, 'Image larger than 4 MB — use Save… or Open.');
  save.fire('click');
  opens[1].fire('click');
  assert.deepStrictEqual(calls, [['saveAs', 5 * 1024 * 1024], ['openLocal', 5 * 1024 * 1024]]);
  v.setData({ ok: true, path: '/r/big.png', size: 9, binary: true, content: null }, { ok: false });
  v.render({ view: 'file' });
  assert.strictEqual(body.children[0].textContent, 'Binary file (9 bytes) — use Save… or Open.');
});

test('file-tab: a local viewer keeps its single Open and the "use Open." note', () => {
  const { v, byText, body } = tabFor(true);
  assert.deepStrictEqual(byText('Save…').map((b) => b.style.display), ['none']);
  assert.deepStrictEqual(byText('Open').map((b) => b.style.display), [undefined, 'none']);
  v.setData({ ok: true, path: '/r/big.png', size: 9, binary: true, content: null }, { ok: false });
  v.render({ view: 'file' });
  assert.strictEqual(body.children[0].textContent, 'Binary file (9 bytes) — use Open.');
});

function ipcFixture(t, { externalRejects = false, saveTo = null } = {}) {
  const dir = tmp(t);
  const handlers = new Map();
  const opened = [];
  const external = [];
  const revealed = [];
  const peeks = [];
  const dialogs = [];
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    openPath: async (p) => { opened.push(p); return ''; },
    openExternal: async (u) => { external.push(u); if (externalRejects) throw new Error('no browser'); },
    showItemInFolder: (p) => { revealed.push(p); },
    showSaveDialog: async (o) => { dialogs.push(o); return { canceled: !saveTo, filePath: saveTo }; },
    getDesktopPath: () => '/Desktop',
    fetchFilePeek: (p, o) => { peeks.push([p, o]); return { ok: true }; },
    os: { tmpdir: () => dir },
    fs, path,
    workspaceOfSender: () => 'ws-1',
    log: { info() {}, error() {} },
  });
  const call = (ch, ...a) => handlers.get(ch)(null, ...a);
  return { dir, call, opened, external, revealed, peeks, dialogs };
}

test('file:openBytes writes 0600 in a 0700 clodex-view dir; an image goes to openExternal as file://, text to openPath', async (t) => {
  const f = ipcFixture(t);
  const img = await f.call('file:openBytes', '../../evil/shot.png', new Uint8Array(PNG_HEAD));
  const viewDir = path.join(f.dir, 'clodex-view');
  assert.strictEqual(path.dirname(img.path), viewDir);
  assert.match(path.basename(img.path), /^[0-9a-f]{12}-shot\.png$/);
  assert.strictEqual(fs.statSync(viewDir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(img.path).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(img.path).equals(PNG_HEAD));
  assert.deepStrictEqual(f.external, [pathToFileURL(img.path).href]);
  assert.ok(f.external[0].startsWith('file://'));
  const txt = await f.call('file:openBytes', 'notes.txt', new Uint8Array(Buffer.from('hello')));
  assert.deepStrictEqual([txt.ok, f.opened, f.external.length], [true, [txt.path], 1]);
});

test('file:openBytes falls back to openPath when openExternal rejects', async (t) => {
  const f = ipcFixture(t, { externalRejects: true });
  const img = await f.call('file:openBytes', 'shot.png', new Uint8Array(PNG_HEAD));
  assert.deepStrictEqual([img.ok, f.external.length, f.opened], [true, 1, [img.path]]);
});

test('file:openBytes reveals a .command launcher instead of opening it', async (t) => {
  const f = ipcFixture(t);
  const res = await f.call('file:openBytes', 'run.command', new Uint8Array(Buffer.from('#!/bin/sh\n')));
  assert.deepStrictEqual(res, { ok: false, revealed: true, reason: 'a .command launcher' });
  assert.deepStrictEqual([f.opened, f.external], [[], []]);
  assert.strictEqual(f.revealed.length, 1);
  assert.match(path.basename(f.revealed[0]), /-run\.command$/);
});

test('file:saveBytes asks with the basename on the desktop and writes the bytes; a cancel writes nothing', async (t) => {
  const dir = tmp(t);
  const dest = path.join(dir, 'out.png');
  const f = ipcFixture(t, { saveTo: dest });
  assert.deepStrictEqual(await f.call('file:saveBytes', '/remote/x/shot.png', new Uint8Array(PNG_HEAD)), { ok: true, path: dest });
  assert.ok(fs.readFileSync(dest).equals(PNG_HEAD));
  assert.deepStrictEqual(f.dialogs, [{ defaultPath: path.join('/Desktop', 'shot.png') }]);
  const c = ipcFixture(t);
  assert.deepStrictEqual(await c.call('file:saveBytes', 'a.png', new Uint8Array(PNG_HEAD)), { ok: false, error: 'cancelled' });
});

test('local file:peek forwards a raw range and drops a non-raw opts', async (t) => {
  const f = ipcFixture(t);
  await f.call('file:peek', '/a', { raw: true, offset: 3, length: 9, extra: 1 });
  await f.call('file:peek', '/b');
  await f.call('file:peek', '/c', { offset: 5 });
  assert.deepStrictEqual(f.peeks, [['/a', { raw: true, offset: 3, length: 9 }], ['/b', {}], ['/c', {}]]);
});
