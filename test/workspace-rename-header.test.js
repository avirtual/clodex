'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function sliceFn(name) {
  const start = rendererSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `ENTER: ${name} was not found in the shipped renderer`);
  const end = rendererSrc.indexOf('\n}\n', start);
  assert.ok(end > start, `ENTER: the end of ${name} was not found`);
  return rendererSrc.slice(start, end + 2);
}

function el(tag) {
  const handlers = {};
  const node = {
    tag, dataset: {}, textContent: '', value: '', id: '', className: '',
    handlers,
    addEventListener(type, fn) { handlers[type] = fn; },
    focus() {}, select() {},
    replaceWith(next) { world.header = next; },
  };
  return node;
}

let world = null;

function load(setWorkspaceName) {
  const span = el('span');
  span.textContent = 'Old';
  world = { header: span, toasts: [], title: 'Old' };
  const document = {
    getElementById: (id) => (id === 'workspace-name' ? world.header : null),
    createElement: (tag) => el(tag),
    get title() { return world.title; },
    set title(v) { world.title = v; },
  };
  const env = {
    document,
    window: { api: { setWorkspaceName } },
    showToast: (msg, opts) => world.toasts.push({ msg, opts }),
  };
  const names = Object.keys(env);
  const body = sliceFn('startWorkspaceRename');
  const api = new Function(...names,
    `let currentWorkspaceName = 'Old'; ${body}; return { start: startWorkspaceRename, current: () => currentWorkspaceName };`)(
    ...names.map((n) => env[n]));
  return api;
}

function rename(api, value) {
  api.start();
  const input = world.header;
  assert.strictEqual(input.tag, 'input', 'ENTER: the header became an input');
  input.value = value;
  input.handlers.keydown({ key: 'Enter', stopPropagation() {} });
}

const flush = () => new Promise((r) => setImmediate(r));

test('the header keeps the old name until setWorkspaceName resolves, then shows the new one', async () => {
  let resolve;
  const api = load(() => new Promise((r) => { resolve = r; }));
  rename(api, 'New');
  await flush();
  assert.strictEqual(world.header.textContent, 'Old', 'nothing is shown as saved while the IPC is in flight');
  assert.strictEqual(api.current(), 'Old');
  resolve(true);
  await flush();
  assert.strictEqual(world.header.textContent, 'New');
  assert.strictEqual(api.current(), 'New');
  assert.strictEqual(world.title, 'New');
  assert.deepStrictEqual(world.toasts, []);
});

test('a refused rename keeps the old name and surfaces the refusal as a toast', async () => {
  const api = load(() => Promise.reject(new Error('workspace name may not contain control characters')));
  rename(api, 'tab\there');
  await flush();
  await flush();
  assert.strictEqual(world.header.textContent, 'Old', 'the header does not show an unsaved name');
  assert.strictEqual(api.current(), 'Old');
  assert.strictEqual(world.title, 'Old');
  assert.strictEqual(world.toasts.length, 1);
  assert.match(world.toasts[0].msg, /^Rename failed: .*control characters/);
  assert.strictEqual(world.toasts[0].opts.kind, 'error');
});

test('the refusal toast drops Electron\'s IPC wrapper and shows only the reason', async () => {
  const api = load(() => Promise.reject(new Error("Error invoking remote method 'set-workspace-name': Error: workspace name may not contain a line break")));
  rename(api, 'a');
  await flush();
  await flush();
  assert.strictEqual(world.toasts.length, 1);
  assert.strictEqual(world.toasts[0].msg, 'Rename failed: workspace name may not contain a line break');
});

test('a rename that resolves after its header span was replaced does not write into the stale span', async () => {
  let resolve;
  const api = load(() => new Promise((r) => { resolve = r; }));
  rename(api, 'New');
  const first = world.header;
  assert.strictEqual(first.tag, 'span', 'ENTER: the first rename put a span back');
  api.start();
  assert.notStrictEqual(world.header, first, 'ENTER: a second rename replaced the first span');
  resolve(true);
  await flush();
  assert.strictEqual(first.textContent, 'Old', 'the detached span was written after the await');
  assert.strictEqual(api.current(), 'New');
});

test('escaping a rename opened while an earlier one was in flight shows the name that was saved', async () => {
  let resolve;
  const api = load(() => new Promise((r) => { resolve = r; }));
  rename(api, 'New');
  api.start();
  const second = world.header;
  assert.strictEqual(second.tag, 'input', 'ENTER: the second rename is open');
  resolve(true);
  await flush();
  second.handlers.keydown({ key: 'Escape', stopPropagation() {} });
  assert.strictEqual(world.header.textContent, 'New');
});

test('an earlier rename that resolves after an overlapping one was escaped writes its name into the live header', async () => {
  let resolve;
  const api = load(() => new Promise((r) => { resolve = r; }));
  rename(api, 'New');
  api.start();
  world.header.handlers.keydown({ key: 'Escape', stopPropagation() {} });
  assert.strictEqual(world.header.textContent, 'Old', 'ENTER: the escaped rename put back the not-yet-saved name');
  resolve(true);
  await flush();
  assert.strictEqual(world.header.textContent, 'New');
  assert.strictEqual(world.title, 'New');
});
