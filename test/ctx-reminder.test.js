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

// The thresholds are pinned as LITERALS as well as symbolically. Every other
// test here reads the constant, so all of them would follow a retune silently —
// including down to zero, which turns "at/above the threshold nudges" into a
// test that nudges on an empty context and still passes.
test('the thresholds are the tuned values', () => {
  assert.strictEqual(CTX_REMINDER_NUDGE_TOKENS, 175_000);
  assert.strictEqual(CTX_REMINDER_ESCALATE_TOKENS, 225_000);
});

test('below the nudge threshold returns null', () => {
  assert.strictEqual(ctxReminderFor(0), null);
  assert.strictEqual(ctxReminderFor(100_000), null);
  assert.strictEqual(ctxReminderFor(CTX_REMINDER_NUDGE_TOKENS - 1), null);
});

// BOTH sides of the boundary, by literal. A high-side-only check ("175k nudges")
// is true of any threshold at or below 175k, zero included; the low side is what
// makes it a boundary.
test('the 175k nudge boundary holds from both sides', () => {
  assert.strictEqual(ctxReminderFor(174_999), null, 'just under the threshold stays silent');
  assert.strictEqual(ctxReminderFor(100_000), null);
  const r = ctxReminderFor(175_000);
  assert.ok(r && r.includes('getting heavy'), 'ENTER: 175k must produce the nudge, or the null above proves nothing');
  // A ticket seat deep in this band is not nudged either, but that is the
  // `ephemeral` suppression at the call site, not this threshold.
  // Under 200k the nudge is reached but the escalate is not: the seat is asked
  // to act before the line a long-context surcharge would begin at.
  assert.ok(ctxReminderFor(199_999).includes('getting heavy'), 'nudged below the 200k line');
  assert.ok(!ctxReminderFor(199_999).includes('very heavy'), 'and not yet escalated');
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
  assert.ok(ctxReminderFor(200_000).includes('~200k'));
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
