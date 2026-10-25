'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDocument } = require('./lib/fake-dom');
const { attachFiles, fileTile } = require('../renderer/lib/pty-composer');
const { readImageFile, readAttachFile } = require('../renderer/lib/clipboard-images');
const { SEAT_FILE_MAX, splitAttachable, rejectedNotice } = require('../renderer/lib/attach-files');

class FakeReader {
  readAsDataURL(file) {
    this.result = file.url;
    queueMicrotask(() => (file.url ? this.onload() : this.onerror()));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function streamHarness() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const slice = (from, to) => {
    const i = src.indexOf(from);
    const j = src.indexOf(to, i);
    assert.ok(i >= 0 && j > i, `renderer.js carries ${from}`);
    assert.strictEqual(src.indexOf(from, i + 1), -1, `renderer.js carries ${from} once`);
    return src.slice(i, j);
  };
  const base = fakeDocument();
  const document = { ...base, createElement: (tag) => {
    const node = base.createElement(tag);
    node.append = (...cs) => { for (const c of cs) node.appendChild(c); };
    return node;
  } };
  const uploads = [];
  const sends = [];
  const toasts = [];
  const composer = { value: '' };
  const attachEl = document.createElement('div');
  const env = {
    document,
    attachEl,
    composer,
    window: { api: {
      seatFileUpload: (_name, files) => { const d = deferred(); d.files = files; uploads.push(d); return d.promise; },
      seatSend: (...args) => { const d = deferred(); d.args = args; sends.push(d); return d.promise; },
    } },
    showToast: (m) => toasts.push(m),
    FileReader: FakeReader,
    SEAT_IMAGE_MAX: 5,
    SEAT_FILE_MAX,
    name: 'seat',
    disposed: false,
    draftTimer: null,
    follow: false,
    fitComposer() {},
    triggerSubmit: { resetSpan() {} },
    pull() {},
    fileTile, attachFiles, splitAttachable, rejectedNotice, readAttachFile, readImageFile,
  };
  const names = Object.keys(env);
  const body = [
    slice('let pending = [];', "composer.addEventListener('paste'"),
    slice('const sendComposer = () => {', 'let slashList = null;'),
    'return { attach: attachStreamFiles, send: sendComposer, files: () => pendingFiles, images: () => pending };',
  ].join('\n');
  const out = new Function(...names, body)(...names.map((n) => env[n]));
  return { ...out, composer, strip: attachEl, uploads, sends, toasts };
}

const settle = () => new Promise(setImmediate);
const pdfFile = (name = 'report.pdf') => ({ name, size: 12288, type: 'application/pdf', url: 'data:application/pdf;base64,QUJD' });

async function landed(h, files, paths) {
  h.attach(files);
  await settle();
  h.uploads[h.uploads.length - 1].resolve({ ok: true, paths });
  await settle();
}

test('ENTER: a picked pdf uploads once, tiles pending, binds its path and rides the sent text as a File: line', async () => {
  const h = streamHarness();
  h.attach([pdfFile()]);
  await settle();
  assert.strictEqual(h.uploads.length, 1);
  assert.deepStrictEqual(h.uploads[0].files, [{ name: 'report.pdf', data: 'QUJD' }]);
  assert.deepStrictEqual(h.strip.childNodes.map((t) => t.className), ['seat-attachment seat-attachment-file seat-attachment-pending']);
  assert.strictEqual(h.strip.hidden, false);
  h.uploads[0].resolve({ ok: true, paths: ['/m/st/file-1-1-report.pdf'] });
  await settle();
  assert.deepStrictEqual(h.strip.childNodes.map((t) => t.className), ['seat-attachment seat-attachment-file']);
  h.composer.value = 'read it';
  h.send();
  assert.strictEqual(h.sends.length, 1);
  assert.deepStrictEqual(h.sends[0].args, ['seat', 'read it\nFile: /m/st/file-1-1-report.pdf', []]);
  assert.deepStrictEqual(h.strip.childNodes, []);
  assert.strictEqual(h.strip.hidden, true);
  assert.deepStrictEqual(h.toasts, []);
});

test('two landed files ride as two File: lines in pick order; empty text with a landed file still sends', async () => {
  const h = streamHarness();
  await landed(h, [pdfFile('a.pdf'), pdfFile('b.pdf')], ['/m/st/file-1-1-a.pdf', '/m/st/file-1-2-b.pdf']);
  h.composer.value = 'both';
  h.send();
  assert.deepStrictEqual(h.sends[0].args, ['seat', 'both\nFile: /m/st/file-1-1-a.pdf\nFile: /m/st/file-1-2-b.pdf', []]);
  await landed(h, [pdfFile()], ['/m/st/file-2-1-report.pdf']);
  h.send();
  assert.deepStrictEqual(h.sends[1].args, ['seat', 'File: /m/st/file-2-1-report.pdf', []]);
});

test('a tile still uploading at send is dropped, so empty text and only that tile sends nothing', async () => {
  const h = streamHarness();
  h.attach([pdfFile()]);
  await settle();
  h.send();
  assert.strictEqual(h.sends.length, 0);
});

test('a failed send does not restore a tile that was still uploading at send', async () => {
  const h = streamHarness();
  h.attach([pdfFile()]);
  await settle();
  h.composer.value = 'go';
  h.send();
  assert.deepStrictEqual(h.sends[0].args, ['seat', 'go', []]);
  h.uploads[0].resolve({ ok: true, paths: ['/m/st/file-1-1-report.pdf'] });
  await settle();
  h.sends[0].resolve({ ok: false, error: 'busy' });
  await settle();
  assert.deepStrictEqual(h.toasts, ['Send failed: busy']);
  assert.strictEqual(h.composer.value, 'go');
  assert.deepStrictEqual(h.files(), []);
  assert.deepStrictEqual(h.strip.childNodes, []);
});

test('two picks before either is read share the five-file room', async () => {
  const h = streamHarness();
  h.attach([pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf')]);
  h.attach([pdfFile('d.pdf'), pdfFile('e.pdf'), pdfFile('f.pdf')]);
  assert.deepStrictEqual(h.toasts, ['1 file(s) not attached — at most 5 per message.']);
  await settle();
  assert.deepStrictEqual(h.uploads.map((u) => u.files.length), [3, 2]);
});

test('a failed send toasts, puts the text back and restores the same tile with its path', async () => {
  const h = streamHarness();
  await landed(h, [pdfFile()], ['/m/st/file-1-1-report.pdf']);
  const tile = h.files()[0];
  h.composer.value = 'read it';
  h.send();
  assert.deepStrictEqual(h.files(), []);
  h.sends[0].resolve({ ok: false, error: 'busy' });
  await settle();
  assert.deepStrictEqual(h.toasts, ['Send failed: busy']);
  assert.strictEqual(h.composer.value, 'read it');
  assert.strictEqual(h.files().length, 1);
  assert.strictEqual(h.files()[0], tile);
  assert.strictEqual(tile.path, '/m/st/file-1-1-report.pdf');
  assert.strictEqual(h.strip.childNodes.length, 1);
});

test('a failed upload removes the tile and toasts the error', async () => {
  const h = streamHarness();
  h.attach([pdfFile()]);
  await settle();
  h.uploads[0].resolve({ ok: false, error: 'file too large' });
  await settle();
  assert.deepStrictEqual(h.files(), []);
  assert.deepStrictEqual(h.strip.childNodes, []);
  assert.deepStrictEqual(h.toasts, ['file too large']);
});

test('a png + pdf pick reads the image as a thumb and uploads only the pdf', async () => {
  const h = streamHarness();
  h.attach([{ name: 'i.png', type: 'image/png', size: 3, url: 'data:image/png;base64,SU1H' }, pdfFile()]);
  await settle();
  assert.strictEqual(h.uploads.length, 1);
  assert.deepStrictEqual(h.uploads[0].files, [{ name: 'report.pdf', data: 'QUJD' }]);
  assert.deepStrictEqual(h.images(), [{ mediaType: 'image/png', data: 'SU1H' }]);
  assert.deepStrictEqual(h.strip.childNodes.map((t) => t.className), ['seat-attachment', 'seat-attachment seat-attachment-file seat-attachment-pending']);
  assert.deepStrictEqual(h.toasts, []);
});

test('six pdfs toast the overflow before any read and upload five', async () => {
  const h = streamHarness();
  h.attach(['1', '2', '3', '4', '5', '6'].map((n) => pdfFile(`${n}.pdf`)));
  assert.deepStrictEqual(h.toasts, ['1 file(s) not attached — at most 5 per message.']);
  assert.strictEqual(h.uploads.length, 0);
  await settle();
  assert.deepStrictEqual(h.uploads[0].files.map((f) => f.name), ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf']);
});

test('× on a file tile removes that tile only', async () => {
  const h = streamHarness();
  await landed(h, [pdfFile('a.pdf'), pdfFile('b.pdf')], ['/m/st/a.pdf', '/m/st/b.pdf']);
  const [first, second] = h.strip.childNodes;
  const rm = first.childNodes[first.childNodes.length - 1];
  assert.strictEqual(rm.className, 'seat-attachment-remove');
  rm.listeners.click();
  assert.deepStrictEqual(h.files().map((t) => t.file.name), ['b.pdf']);
  assert.strictEqual(h.strip.childNodes.length, 1);
  assert.strictEqual(h.strip.childNodes[0].className, second.className);
});
