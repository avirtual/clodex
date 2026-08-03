'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { IPC_PROMPT, buildIpcPrompt } = require('../ipc-prompt');
const { GATEABLE_INTENTS, PRIVILEGED_INTENTS } = require('../intent-catalog');

// PRIVILEGED intents (reboot) are EXCLUDED here on purpose: under the `null`
// allowlist intentEnabled('reboot', null) is false, so IPC_PROMPT is
// privileged-free by construction (its reboot line renders for NO default seat).
// The "no fork-drift" pin therefore compares against the null-EQUIVALENT explicit
// list — every NON-privileged gateable type — not a list that would (wrongly)
// enable reboot and render a line the literal doesn't have. Do NOT "helpfully"
// re-add reboot: it would render the privileged grammar line and break the pin.
// (A forgotten reboot grammar line is instead guarded by the dedicated
// explicit-['reboot'] render case below, since this pin no longer covers it.)
const ALL_GATEABLE = GATEABLE_INTENTS
  .filter((i) => !PRIVILEGED_INTENTS.has(i.type))
  .map((i) => i.type);

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

// Observed live 2026-08-03: a seat answered a personal question from a one-shot
// hint, could not source it the next turn, and RETRACTED the correct answer as
// confabulation. Retracting a right answer is worse than the original
// uncertainty, and "claim I cannot source = I invented it" is a good rule the
// rest of the time — only an explicit exemption beats it. It lives HERE rather
// than in the hint preamble because it governs the turn AFTER the hint, and this
// prompt is cached per session while a hint is billed per request.
test('MEMORY carries the hint retraction guard', () => {
  const p = buildIpcPrompt(ALL_GATEABLE);
  assert.ok(/system-reminder/.test(p), 'the guard must name where the attached memory shows up');
  assert.ok(/NOT a reason to retract it as confabulation/.test(p),
    'without the exemption a seat retracts correct hint-fed answers it cannot source');
});

// The other half of the same failure. Retrieval is lexical and misses often, and
// an idle seat handed an unrelated memory summarized it to the operator rather
// than dropping it — the miss cost more attention than the hint was worth. Lives
// HERE and not in the hint preamble for the same reason as the guard above: the
// preamble is billed uncached on every armed request and has ~13 chars of slack.
test('MEMORY says an irrelevant hint is dropped in silence', () => {
  const p = buildIpcPrompt(ALL_GATEABLE);
  assert.ok(/drop it in silence/.test(p), 'the rule must actually be stated');
  assert.ok(/do not mention it, summarize it, or explain why you are not using it/.test(p),
    'naming the three shapes it took: a bare "ignore it" was already there and did not hold');
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

// ── reboot: privileged grammar line renders only for an explicit grant ────────
// Since reboot is excluded from ALL_GATEABLE (above), the fork-drift byte-pin no
// longer covers a forgotten reboot grammar line — THIS case is what guards it.

test('reboot line renders ONLY for a seat whose intents explicitly grant reboot', () => {
  const line = '[agent:reboot] [reason]';
  // Granted (explicit list including reboot) → present.
  const granted = buildIpcPrompt(['reboot', ...ALL_GATEABLE]);
  assert.ok(granted.includes(line), 'a reboot-granted seat sees the reboot line');
  // The two byte-pinned calls (absent list = all non-privileged) → absent, which
  // is WHY both pins still equal IPC_PROMPT.
  assert.ok(!buildIpcPrompt(null).includes(line), 'default seat: no reboot line (null pin holds)');
  assert.ok(!buildIpcPrompt(ALL_GATEABLE).includes(line), 'all-non-privileged seat: no reboot line (fork-drift pin holds)');
});

// ── exec: a synthesized section keyed on the granted command-id allowlist ─────

test('exec section renders the granted command ids, and only when granted', () => {
  const p = buildIpcPrompt(null, ['clodex-run-tests', 'clodex-team']);
  assert.ok(/\nEXEC COMMANDS:\n/.test(p), 'EXEC COMMANDS section present when granted');
  assert.ok(p.includes('[agent:exec clodex-run-tests]'), 'first granted id listed');
  assert.ok(p.includes('[agent:exec clodex-team]'), 'second granted id listed');
});

// t81: the section renders each command's payload GRAMMAR, derived from its
// schema, and states the three things the old prose got wrong.

test('t81: a resolved def renders its derived payload form and description', () => {
  const p = buildIpcPrompt(null, [{
    name: 'clodex-team',
    description: 'Your team: roster, tickets, retire.',
    schema: {
      type: 'object',
      required: ['action', 'agent'],
      properties: {
        action: { type: 'string', enum: ['roster', 'retire', 'tickets'] },
        agent: { type: 'string' },
        target: { type: 'string' },
      },
    },
  }]);
  assert.ok(p.includes('  [agent:exec clodex-team] {"action":"roster|retire|tickets","agent":"<string>"} optional: target'),
    'payload form derived from the schema, enum values quoted so it is copyable');
  assert.ok(p.includes('\n      Your team: roster, tickets, retire.'), 'description on its own line');
});

test('t81: a fieldless command renders {} — the prompt never says "no payload"', () => {
  // The false statement that cost this seat a bounce: an empty body is rejected
  // before the schema is read, so {} is mandatory even with no fields.
  const p = buildIpcPrompt(null, [{ name: 'clodex-run-tests', schema: { type: 'object', additionalProperties: false } }]);
  assert.ok(p.includes('  [agent:exec clodex-run-tests] {}'), 'fieldless command still shows a {} payload');
  assert.ok(/even a command with no fields needs a literal/.test(p), 'and the rule is stated in the prose');
});

test('t81: the three false statements are GONE from the section', () => {
  const p = buildIpcPrompt(null, ['clodex-run-tests']);
  // 1. "you supply only the name, never the command line" — read as "no arguments".
  assert.ok(!p.includes('you supply only the name, never the command line'),
    'the sentence that told agents to stop looking for a payload is gone');
  // 2. stdout does NOT come back, so the section must not promise output.
  assert.ok(!p.includes('Output returns in your input'),
    'the section no longer claims command output returns');
  // 3. and it states the truth instead: success is silent, stdout is dropped.
  assert.ok(/Success is SILENT/.test(p), 'silent-success stated');
  assert.ok(/stdout is never returned to you/.test(p), 'stdout-dropped stated');
  // The argv guarantee is the security shape and must SURVIVE the rewrite.
  assert.ok(/never write the command line itself/.test(p), 'argv guarantee kept');
});

test('t81: bare id strings still render (a def that cannot be read never blocks a spawn)', () => {
  const p = buildIpcPrompt(null, ['clodex-run-tests', { name: 'clodex-team', schema: { type: 'object' } }]);
  assert.ok(p.includes('  [agent:exec clodex-run-tests]\n'), 'string entry degrades to the id-only line');
  assert.ok(p.includes('  [agent:exec clodex-team] {}'), 'resolved entry alongside it still renders its form');
});

test('t81: argv and cwd never reach the prompt', () => {
  const p = buildIpcPrompt(null, [{
    name: 'c', schema: { type: 'object' },
    argv: ['/usr/bin/env', 'node', '/Users/someone/private/tool.js'], cwd: '/Users/someone/private',
  }]);
  assert.ok(!p.includes('/Users/someone'), 'no def filesystem path in any seat prompt');
});

test('exec section adds ZERO bytes for an empty/absent grant (both byte-pins keep this true)', () => {
  // Empty array and absent arg both reproduce IPC_PROMPT — the exec block is
  // additive-only, so the two byte-pins above already ride on this.
  assert.strictEqual(buildIpcPrompt(null, []), IPC_PROMPT);
  assert.strictEqual(buildIpcPrompt(null), IPC_PROMPT);
  assert.ok(!buildIpcPrompt(null, []).includes('EXEC COMMANDS:'), 'no exec section for []');
});

// --- P3: plugin grammar lines (plugin-plan.md [internal design doc, not in this repo] §2.3) --------------------

const intentRegistry = require('../intent-registry');

test('P3: the third argument is absent-equivalent — BOTH byte-pins hold through it', () => {
  // The pins above call buildIpcPrompt with no third arg. These are the same
  // pins with every no-op shape of the new argument, so a future default that
  // quietly added bytes cannot pass.
  for (const extra of [undefined, null, [], [''].filter(Boolean), 'not an array', 0]) {
    assert.strictEqual(buildIpcPrompt(null, undefined, extra), IPC_PROMPT, `extra=${JSON.stringify(extra)}`);
    assert.strictEqual(buildIpcPrompt(null, [], extra), IPC_PROMPT, `extra=${JSON.stringify(extra)}`);
  }
});

test('P3: a granted plugin line is appended AFTER the core grammar block', () => {
  const line = '  [agent:branch]                   Report your repo’s current branch to the operator.';
  const out = buildIpcPrompt(null, undefined, [line]);
  assert.notStrictEqual(out, IPC_PROMPT);
  assert.ok(out.includes(line), 'the line is present');
  // Appended, not interleaved: it sits after the last core grammar line (reboot's
  // is privileged and absent here, so the last core line is the `file open` one)
  // and before the REPLIES line that closes the block.
  const fileIdx = out.indexOf('[agent:file open PATH]');
  const replies = out.indexOf('Replies arrive later');
  assert.ok(fileIdx < out.indexOf(line) && out.indexOf(line) < replies, 'ordering: core lines, plugin lines, replies');
  // And nothing else moved: removing the added line restores the pinned bytes.
  assert.strictEqual(out.replace(`\n${line}`, ''), IPC_PROMPT);
});

test('P3: two plugin lines keep registration order', () => {
  const out = buildIpcPrompt(null, undefined, ['  [agent:aaa] one', '  [agent:bbb] two']);
  assert.ok(out.indexOf('[agent:aaa] one') < out.indexOf('[agent:bbb] two'));
});

test('P3: pluginGrammarLines renders a line ONLY for a granted seat', () => {
  try {
    intentRegistry.registerIntent({
      verb: 'branch', parse: () => null, promptLines: '  [agent:branch] Report the branch.',
    }, 'demo');
    // Absent list = the living all-enabled default for ORDINARY verbs, but a
    // plugin verb is privileged, so this seat gets nothing and its prompt is
    // byte-identical to the pin — the reboot precedent, reproduced.
    assert.deepStrictEqual(intentRegistry.pluginGrammarLines(null), []);
    assert.strictEqual(buildIpcPrompt(null, undefined, intentRegistry.pluginGrammarLines(null)), IPC_PROMPT);
    // An explicitly granted seat gets the line.
    const granted = buildIpcPrompt(['dm', 'branch'], undefined, intentRegistry.pluginGrammarLines(['dm', 'branch']));
    assert.ok(granted.includes('[agent:branch] Report the branch.'));
  } finally { intentRegistry._resetPluginRows(); }
});

test('P3: a registered verb with NO promptLines adds nothing (the resend precedent)', () => {
  try {
    intentRegistry.registerIntent({ verb: 'quiet', parse: () => null }, 'demo');
    assert.deepStrictEqual(intentRegistry.pluginGrammarLines(['quiet']), []);
    assert.strictEqual(
      buildIpcPrompt(null, undefined, intentRegistry.pluginGrammarLines(['quiet'])),
      IPC_PROMPT,
    );
  } finally { intentRegistry._resetPluginRows(); }
});
