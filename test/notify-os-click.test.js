'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function notifySeam() {
  const start = SRC.indexOf('notifyOS: (opts) => {');
  assert.ok(start >= 0, 'main.js still defines the notifyOS seam');
  const end = SRC.indexOf('setAppQuitting:', start);
  assert.ok(end > start, 'the seam is followed by setAppQuitting');
  return SRC.slice(start, end);
}

test('every operator OS notification click shows a window and opens the Requests list', () => {
  const seam = notifySeam();
  assert.match(seam, /const n = new Notification\(opts\);/);
  assert.match(seam, /held\.add\(n\);/);
  assert.match(seam, /n\.on\('close', \(\) => held\.delete\(n\)\);/);
  assert.doesNotMatch(seam, /setTimeout/);
  const click = seam.indexOf("n.on('click', () => {");
  const show = seam.search(/^\s*n\.show\(\);/m);
  assert.ok(click >= 0, 'a click handler is attached');
  assert.ok(show > click, 'the handler is attached before the notification is shown');
  const handler = seam.slice(click, show);
  assert.match(handler, /const win = BrowserWindow\.getFocusedWindow\(\) \|\| BrowserWindow\.getAllWindows\(\)\[0\];/);
  assert.match(handler, /if \(win\) \{ if \(win\.isMinimized\(\)\) win\.restore\(\); win\.show\(\); win\.focus\(\); \}/, 'no window means no show/focus call, not a throw');
  assert.match(handler, /sendToFocused\('request-open-inbox-drawer'\);/);
});

function sliceNotifyOS() {
  return notifySeam().replace(/^notifyOS: /, '').replace(/,\s*$/, '');
}

function build() {
  const held = new Set();
  const made = [];
  class Notification {
    static isSupported() { return true; }
    constructor(opts) { this.opts = opts; this.handlers = {}; made.push(this); }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() {}
  }
  const factory = new Function('held', 'Notification', 'BrowserWindow', 'sendToFocused',
    `return (${sliceNotifyOS()});`);
  const notifyOS = factory(held, Notification, { getFocusedWindow: () => null, getAllWindows: () => [] }, () => {});
  return { held, made, notifyOS };
}

test('notifyOS: held keeps the 50 most recent notifications, evicting the oldest first', () => {
  const { held, made, notifyOS } = build();
  for (let i = 0; i < 51; i++) notifyOS({ title: `n${i}` });
  assert.strictEqual(made.length, 51);
  assert.strictEqual(held.size, 50);
  assert.ok(!held.has(made[0]), 'the first notification was evicted');
  assert.ok(held.has(made[1]));
  assert.ok(held.has(made[50]), 'the 51st notification is held');
});

test('notifyOS: close drains held', () => {
  const { held, made, notifyOS } = build();
  notifyOS({ title: 'a' });
  notifyOS({ title: 'b' });
  made[0].handlers.close();
  assert.ok(!held.has(made[0]));
  assert.ok(held.has(made[1]));
});
