const test = require('node:test');
const assert = require('node:assert');

const { classifyNotification } = require('../attention');

test('classifyNotification: permission dialogs', () => {
  assert.strictEqual(classifyNotification({ message: 'Claude needs your permission to use Bash' }), 'permission');
  assert.strictEqual(classifyNotification({ message: 'Claude requesting permission for WebFetch' }), 'permission');
  assert.strictEqual(classifyNotification({ message: 'Approval required to run this command' }), 'permission');
  // title carries the signal, message is generic
  assert.strictEqual(classifyNotification({ title: 'Permission to use Edit', message: 'src/main.js' }), 'permission');
});

test('classifyNotification: idle "waiting for input" chatter is ignored class', () => {
  assert.strictEqual(classifyNotification({ message: 'Claude is waiting for your input' }), 'idle');
  assert.strictEqual(classifyNotification({ message: 'Waiting for input' }), 'idle');
});

test('classifyNotification: unknown/malformed classifies as other (badge, no dm gate)', () => {
  assert.strictEqual(classifyNotification({ message: 'Auth token expired, please run /login' }), 'other');
  assert.strictEqual(classifyNotification({}), 'other');
  assert.strictEqual(classifyNotification(null), 'other');
  assert.strictEqual(classifyNotification({ message: 42 }), 'other');
});
