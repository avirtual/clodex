'use strict';

// ctx-reminder: the pure high-context self-compact decision. Verifies the
// absolute-token thresholds and the nudge/escalate wording split. The file
// lifecycle (main.js writing/removing {name}-ctxwarn off the ctx side-channel)
// is not exercised here — it lives in the electron-only SessionManager, which
// isn't requireable under plain node.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  ctxReminderFor,
  CTX_REMINDER_NUDGE_TOKENS,
  CTX_REMINDER_ESCALATE_TOKENS,
} = require('../ctx-reminder');

test('below the nudge threshold returns null', () => {
  assert.strictEqual(ctxReminderFor(0), null);
  assert.strictEqual(ctxReminderFor(100_000), null);
  assert.strictEqual(ctxReminderFor(CTX_REMINDER_NUDGE_TOKENS - 1), null);
});

test('at/above the nudge threshold returns the nudge reminder', () => {
  const r = ctxReminderFor(CTX_REMINDER_NUDGE_TOKENS);
  assert.ok(r && r.includes('<system-reminder>') && r.includes('</system-reminder>'));
  assert.ok(r.includes('getting heavy'), 'nudge wording');
  assert.ok(!r.includes('well past'), 'not the escalation wording yet');
  assert.ok(r.includes('[agent:context compact]'), 'points at the self-compact action');
});

test('at/above the escalate threshold returns the sterner reminder', () => {
  const r = ctxReminderFor(CTX_REMINDER_ESCALATE_TOKENS);
  assert.ok(r && r.includes('<system-reminder>'));
  assert.ok(r.includes('well past'), 'escalation wording');
  assert.ok(r.includes('very heavy'));
  assert.ok(r.includes('[agent:context compact]'));
});

test('the boundary just under escalate is still the nudge', () => {
  const r = ctxReminderFor(CTX_REMINDER_ESCALATE_TOKENS - 1);
  assert.ok(r.includes('getting heavy') && !r.includes('well past'));
});

test('the token count is rendered in ~Nk form', () => {
  assert.ok(ctxReminderFor(150_000).includes('~150k'));
  assert.ok(ctxReminderFor(260_400).includes('~260k'));
});

test('malformed / unknown token counts return null (no false nag)', () => {
  assert.strictEqual(ctxReminderFor(null), null);
  assert.strictEqual(ctxReminderFor(undefined), null);
  assert.strictEqual(ctxReminderFor(NaN), null);
  assert.strictEqual(ctxReminderFor('not a number'), null);
});

test('a numeric string over threshold is honored', () => {
  const r = ctxReminderFor(String(CTX_REMINDER_ESCALATE_TOKENS + 5000));
  assert.ok(r && r.includes('well past'));
});
