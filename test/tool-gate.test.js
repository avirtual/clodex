'use strict';
// tool-gate.test.js — the New Session dialog's Create-gate decision leaf (Task 12).
// Pure: given the selected type + the tools:check payload, decide ok/disabled +
// the inline notice. bash is never gated; a null check (pre-probe) never blocks.

const test = require('node:test');
const assert = require('node:assert');
const { newSessionToolGate } = require('../renderer/lib/tool-gate');

const check = {
  byTool: {
    claude: { present: false, notice: { kind: 'error', text: 'claude CLI not found on PATH — install: …' } },
    codex: { present: true, notice: { kind: 'ok', text: 'codex found' } },
  },
};

test('bash is NEVER gated', () => {
  const g = newSessionToolGate('bash', check);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.disabled, false);
  assert.strictEqual(g.notice, null);
});

test('an unknown type is not gated (defensive)', () => {
  assert.strictEqual(newSessionToolGate('mystery', check).disabled, false);
});

test('claude missing → gated, disabled, carries the tool notice', () => {
  const g = newSessionToolGate('claude', check);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.disabled, true);
  assert.strictEqual(g.notice.kind, 'error');
  assert.match(g.notice.text, /not found on PATH/);
});

test('codex present → allowed, no notice', () => {
  const g = newSessionToolGate('codex', check);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.disabled, false);
  assert.strictEqual(g.notice, null);
});

test('null check (before the probe resolves) → not blocked, re-gates when it lands', () => {
  const g = newSessionToolGate('claude', null);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.disabled, false);
  assert.strictEqual(g.notice, null);
});

test('a report with no notice still blocks with a sensible fallback', () => {
  const g = newSessionToolGate('claude', { byTool: { claude: { present: false } } });
  assert.strictEqual(g.disabled, true);
  assert.match(g.notice.text, /claude CLI not found on PATH/);
});
