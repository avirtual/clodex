'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { loadWebglIfEnabled } = require('../renderer/lib/term-webgl');

function fakeAddonClass() {
  const made = [];
  class FakeAddon {
    constructor() {
      this.disposed = 0;
      this.lossCb = null;
      made.push(this);
    }
    onContextLoss(cb) { this.lossCb = cb; }
    dispose() { this.disposed += 1; }
  }
  return { FakeAddon, made };
}

function fakeTerminal({ throwOnLoad = false } = {}) {
  const loaded = [];
  return {
    loaded,
    open() {},
    loadAddon(a) {
      if (throwOnLoad) throw new Error('webgl context refused');
      loaded.push(a);
    },
  };
}

test('enabled=false loads nothing and returns null', () => {
  const { FakeAddon, made } = fakeAddonClass();
  const term = fakeTerminal();
  const r = loadWebglIfEnabled(term, false, { Addon: FakeAddon, warn: () => {} });
  assert.strictEqual(r, null);
  assert.strictEqual(made.length, 0);
  assert.strictEqual(term.loaded.length, 0);
});

test('enabled=true loads exactly one addon and returns it', () => {
  const { FakeAddon, made } = fakeAddonClass();
  const term = fakeTerminal();
  const r = loadWebglIfEnabled(term, true, { Addon: FakeAddon, warn: () => {} });
  assert.strictEqual(made.length, 1);
  assert.strictEqual(term.loaded.length, 1);
  assert.strictEqual(term.loaded[0], made[0]);
  assert.strictEqual(r, made[0]);
  assert.strictEqual(made[0].disposed, 0);
});

test('loadAddon throwing returns null, disposes the addon and warns once about WebGL', () => {
  const { FakeAddon, made } = fakeAddonClass();
  const term = fakeTerminal({ throwOnLoad: true });
  const warns = [];
  const r = loadWebglIfEnabled(term, true, { Addon: FakeAddon, warn: (msg) => warns.push(msg) });
  assert.strictEqual(r, null);
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].disposed, 1);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /WebGL/);
});

test('the onContextLoss callback disposes the addon', () => {
  const { FakeAddon, made } = fakeAddonClass();
  const term = fakeTerminal();
  loadWebglIfEnabled(term, true, { Addon: FakeAddon, warn: () => {} });
  assert.strictEqual(typeof made[0].lossCb, 'function');
  assert.strictEqual(made[0].disposed, 0);
  made[0].lossCb();
  assert.strictEqual(made[0].disposed, 1);
});

for (const rel of ['renderer/renderer.js', 'renderer/term-tab.js']) {
  test(`${rel} loads WebGL through loadWebglIfEnabled`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(src.includes('loadWebglIfEnabled(terminal, '), `${rel} must call loadWebglIfEnabled(terminal, …)`);
  });
}
