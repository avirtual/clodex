'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function sliceNotifyOS() {
  const head = 'notifyOS: (opts) => {';
  const at = SRC.indexOf(head);
  assert.ok(at > 0, 'notifyOS is present in main.js');
  let i = at + head.length;
  let depth = 1;
  while (depth > 0) {
    const c = SRC[i++];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return SRC.slice(at + 'notifyOS: '.length, i);
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
  const factory = new Function('held', 'Notification', 'BrowserWindow', 'sendToFocused', 'setTimeout', 'clearTimeout',
    `return (${sliceNotifyOS()});`);
  const notifyOS = factory(held, Notification, { getFocusedWindow: () => null, getAllWindows: () => [] }, () => {},
    (...a) => setTimeout(...a), (t) => clearTimeout(t));
  return { held, made, notifyOS };
}

test('notifyOS: a notification that never emits close drains from held after the fallback', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { held, made, notifyOS } = build();
    notifyOS({ title: 'a' });
    assert.strictEqual(made.length, 1);
    assert.ok(held.has(made[0]));
    mock.timers.tick(59_999);
    assert.ok(held.has(made[0]), 'still held before the fallback');
    mock.timers.tick(1);
    assert.strictEqual(held.size, 0);
  } finally {
    mock.timers.reset();
  }
});

test('notifyOS: close drains held and clears the fallback timer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { held, made, notifyOS } = build();
    notifyOS({ title: 'a' });
    notifyOS({ title: 'b' });
    made[0].handlers.close();
    assert.ok(!held.has(made[0]));
    assert.ok(held.has(made[1]));
    held.add(made[0]);
    mock.timers.tick(60_000);
    assert.ok(held.has(made[0]), 'the closed notification\'s fallback was cleared');
    assert.ok(!held.has(made[1]));
  } finally {
    mock.timers.reset();
  }
});
