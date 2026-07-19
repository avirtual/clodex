'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { IPC_PROMPT, buildIpcPrompt } = require('../ipc-prompt');
const { GATEABLE_INTENTS } = require('../intent-catalog');

const ALL_GATEABLE = GATEABLE_INTENTS.map((i) => i.type);

// ── Byte-pins ────────────────────────────────────────────────────────────────
// IPC_PROMPT is the hand-maintained canonical literal (an all-enabled seat's
// blob). buildIpcPrompt reassembles it from independently-authored pieces
// (PREAMBLE + GRAMMAR_LINES + gated MEMORY + TRAILER), so these two pins are what
// make DRIFT between the pieces and the literal impossible: any edit to one side
// alone fails here. The `all gateable` pin specifically guards the two-list fork's
// one real risk — a grammar line added to the literal but forgotten in
// GRAMMAR_LINES (or vice-versa) — since prompt-line order lives in ipc-prompt.js
// while catalog order lives in intent-catalog.js, two independent owners.

test('byte-pin: buildIpcPrompt(null) === IPC_PROMPT (absent list = all enabled)', () => {
  assert.strictEqual(buildIpcPrompt(null), IPC_PROMPT);
});

test('byte-pin: buildIpcPrompt(<all gateable>) === IPC_PROMPT (no fork-drift)', () => {
  assert.strictEqual(buildIpcPrompt(ALL_GATEABLE), IPC_PROMPT);
  // undefined behaves like absent too.
  assert.strictEqual(buildIpcPrompt(undefined), IPC_PROMPT);
});

// ── Gating: grammar lines drop for disabled intents ──────────────────────────

test('memory off → MEMORY section AND memory grammar lines both vanish', () => {
  const list = ALL_GATEABLE.filter((t) => t !== 'memory');
  const p = buildIpcPrompt(list);
  assert.ok(!/\nMEMORY:\n/.test(p), 'MEMORY: section should be gone');
  assert.ok(!p.includes('[agent:memory list]'), 'memory grammar line should be gone');
  assert.ok(!p.includes('[agent:memory remember]'), 'memory grammar line should be gone');
  // Everything else still present.
  assert.ok(p.includes('[agent:dm TARGET] message body'));
  assert.ok(p.includes('SHELL COMMANDS:'));
});

test('dm off → both dm grammar lines (incl the urgent park paragraph) vanish', () => {
  const list = ALL_GATEABLE.filter((t) => t !== 'dm');
  const p = buildIpcPrompt(list);
  assert.ok(!p.includes('[agent:dm TARGET] message body'), 'dm line gone');
  assert.ok(!p.includes('[agent:dm TARGET urgent]'), 'dm-urgent park line gone');
  // A sibling intent is untouched.
  assert.ok(p.includes('[agent:who]'));
});

test('name is not gateable: always present, even for a fully-gated seat ([])', () => {
  const empty = buildIpcPrompt([]);
  assert.ok(empty.includes('[agent:name]'), 'name line must survive');
  // Everything gateable is gone.
  assert.ok(!empty.includes('[agent:dm TARGET]'), 'dm gone');
  assert.ok(!empty.includes('[agent:who]'), 'who gone');
  assert.ok(!/\nMEMORY:\n/.test(empty), 'MEMORY gone');
  // Static frame (preamble + trailer) stays.
  assert.ok(empty.includes('HOW TO COMMUNICATE:'));
  assert.ok(empty.includes('RULES:'));
  assert.ok(empty.includes('SHELL COMMANDS:'));
});

// ── resend + exec are gateable but carry NO grammar line ──────────────────────

test('resend and exec never appear as grammar lines, even when enabled', () => {
  const all = buildIpcPrompt(ALL_GATEABLE);
  assert.ok(!all.includes('[agent:resend'), 'resend has no manual line (rides park-bounce)');
  assert.ok(!all.includes('[agent:exec'), 'exec has no IPC grammar line');
  // And their absence from GRAMMAR_LINES means toggling them changes nothing:
  // dropping resend/exec from an otherwise-all list is byte-identical to all-on.
  const withoutResendExec = buildIpcPrompt(ALL_GATEABLE.filter((t) => t !== 'resend' && t !== 'exec'));
  assert.strictEqual(withoutResendExec, all);
});

// ── A representative narrow seat omits exactly the right groups ───────────────

test('a narrow seat (dm+who+name only) documents exactly those intents', () => {
  const p = buildIpcPrompt(['dm', 'who']); // name rides along ungateable
  // Present:
  assert.ok(p.includes('[agent:dm TARGET] message body'));
  assert.ok(p.includes('[agent:dm TARGET urgent]'));
  assert.ok(p.includes('[agent:who]'));
  assert.ok(p.includes('[agent:name]'));
  // Absent (gated off):
  for (const line of [
    // `[agent:file view PATH]` now appears in the always-present HOW TO
    // COMMUNICATE example, so probe the file GRAMMAR block's absence via its
    // `open` line, which lives only in GRAMMAR_LINES.
    '[agent:context compact]', '[agent:memory list]', '[agent:spawn name:X',
    '[agent:file open PATH]', '[agent:remind every', '[agent:notify-user]',
  ]) {
    assert.ok(!p.includes(line), `${line} should be gated out`);
  }
  assert.ok(!/\nMEMORY:\n/.test(p), 'MEMORY section gated with memory');
});
