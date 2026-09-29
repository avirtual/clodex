'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { initFilesPopover } = require('../renderer/popovers/files-popover');

function fakeEl(classes = []) {
  const set = new Set(classes);
  return {
    dataset: {},
    style: {},
    textContent: '',
    innerHTML: '',
    offsetWidth: 320,
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
    getBoundingClientRect: () => ({ left: 100, top: 400, width: 40, height: 16 }),
    addEventListener() {},
    contains: () => false,
  };
}

function harness(files) {
  const prev = { document: global.document, window: global.window };
  const ids = ['files-popover', 'files-popover-name', 'files-popover-body', 'files-popover-close'];
  const els = new Map(ids.map((id) => [id, fakeEl(id === 'files-popover' ? ['hidden'] : [])]));
  let push = null;
  global.document = {
    getElementById: (id) => {
      if (!els.has(id)) throw new Error(`fakeDocument: unhandled id ${id}`);
      return els.get(id);
    },
    createElement: () => {
      let text = '';
      return {
        set textContent(v) { text = String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
    },
    querySelector: () => null,
    addEventListener() {},
  };
  global.window = {
    innerWidth: 1400,
    innerHeight: 900,
    api: { onSessionFiles: (cb) => { push = cb; }, onSessionFileView() {} },
  };
  const api = initFilesPopover({
    popoverApi: () => ({ files }),
    filesState: new Map(),
    filesUnseen: new Set(),
    peerFilesCount: new Map(),
    renderProxyBar() {},
    getActiveSession: () => 'a',
    sidePane: { noteFiles() {}, open() {} },
  });
  return {
    api,
    push: (...a) => push(...a),
    body: () => els.get('files-popover-body').innerHTML,
    restore() { global.document = prev.document; global.window = prev.window; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const row = (p) => ({ path: p, count: 1, tool: 'Edit', ts: Date.now() });

test('a live files push after a failed open does not dim rows inside the session\'s known cwd', async () => {
  const answers = [
    { ok: true, cwd: '/w', files: [row('/w/src/a.js')] },
    { ok: false, error: 'x' },
  ];
  const h = harness(async () => answers.shift());
  try {
    await h.api.openFilesPopover('a', fakeEl());
    assert.doesNotMatch(h.body(), /file-row-out/, 'ENTER: the first open knew the cwd');
    await h.api.openFilesPopover('a', fakeEl());
    await h.api.openFilesPopover('a', fakeEl());
    assert.match(h.body(), /cost-note">x</, 'ENTER: the second open failed');
    h.push('a', [row('/w/src/a.js'), row('/elsewhere/b.js')]);
    assert.match(h.body(), /data-path="\/w\/src\/a\.js"/, 'ENTER: the push reached the rows');
    assert.match(h.body(), /<div class="file-row" data-path="\/w\/src\/a\.js"/);
    assert.match(h.body(), /file-row file-row-out" data-path="\/elsewhere\/b\.js"/);
  } finally { h.restore(); }
});

test('a live files push during a first open whose cwd is not known yet dims nothing', async () => {
  const d = deferred();
  const h = harness(() => d.promise);
  try {
    const opening = h.api.openFilesPopover('a', fakeEl());
    h.push('a', [row('/w/src/a.js')]);
    assert.match(h.body(), /data-path="\/w\/src\/a\.js"/, 'ENTER: the push reached the rows');
    assert.doesNotMatch(h.body(), /file-row-out|Dimmed rows/);
    d.resolve({ ok: false, error: 'x' });
    await opening;
    h.push('a', [row('/w/src/a.js')]);
    assert.doesNotMatch(h.body(), /file-row-out|Dimmed rows/);
  } finally { h.restore(); }
});

test('a forgotten session\'s cwd is unknown again, so a later push dims nothing', async () => {
  const h = harness(async () => ({ ok: true, cwd: '/w', files: [row('/w/src/a.js')] }));
  try {
    await h.api.openFilesPopover('a', fakeEl());
    h.push('a', [row('/w/src/a.js'), row('/elsewhere/b.js')]);
    assert.match(h.body(), /file-row file-row-out" data-path="\/elsewhere\/b\.js"/, 'ENTER: the known cwd dimmed the outside row');
    h.api.forget('a');
    h.push('a', [row('/w/src/a.js'), row('/elsewhere/b.js')]);
    assert.match(h.body(), /data-path="\/elsewhere\/b\.js"/, 'ENTER: the push reached the rows');
    assert.doesNotMatch(h.body(), /file-row-out|Dimmed rows/);
  } finally { h.restore(); }
});
