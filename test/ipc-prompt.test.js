'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { IPC_PROMPT, buildIpcPrompt } = require('../ipc-prompt');
const { GATEABLE_INTENTS, PRIVILEGED_INTENTS } = require('../intent-catalog');
const { parseIntent } = require('../intent-scanner');
const { bodyModeFor } = require('../intent-registry');
const fs = require('node:fs');
const path = require('node:path');

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

// ── task: an UNGATEABLE verb, so it must be in BOTH copies ───────────────────
// The defect these pin (t355): ipc-prompt.js shipped a grammar section for every
// verb EXCEPT task, while intent-registry's CORE_VALID_INTENT_NAMES lists it — so
// the near-miss bounce advertised a verb whose grammar reached seats only through
// a SEEDED role brief, and a seeded file can silently freeze (this one did, for
// three days). The grammar for a core verb must not depend on a file outside the
// prompt.

// The byte-pins above already fail if the two copies diverge in any way that
// changes the assembled string. This subject fails for the REASON: it reads the
// two sides separately — the literal directly, and GRAMMAR_LINES through the
// empty-allowlist build, which contains no piece of IPC_PROMPT's authored text —
// so "present in one, absent or reworded in the other" is named here rather than
// arriving as an unreadable multi-kilobyte string diff.
test('task grammar lives in BOTH the literal and GRAMMAR_LINES, byte-identical', () => {
  const lines = IPC_PROMPT.split('\n').filter((l) => /^ {2}\[agent:task /.test(l));
  assert.ok(lines.length > 0, 'ENTER: the literal carries the task grammar at all (it shipped with none)');
  // buildIpcPrompt([]) renders GRAMMAR_LINES for a seat with EVERY gateable verb
  // denied. task is not gateable, so its row survives that — and nothing authored
  // into the literal alone can reach this string.
  const fullyGated = buildIpcPrompt([]);
  for (const line of lines) {
    assert.ok(fullyGated.includes(line),
      'the literal task line is missing or reworded in GRAMMAR_LINES:\n' + line);
  }
  const fromRows = fullyGated.split('\n').filter((l) => /^ {2}\[agent:task /.test(l));
  assert.deepStrictEqual(fromRows, lines, 'the two copies must be the same lines in the same order');
});

// task is NOT in GATEABLE_INTENTS, and intentEnabled opens with
// `if (!GATEABLE_TYPES.has(type)) return true`. So there is no allowlist that
// removes this line — including `[]`, which denies everything gateable. A future
// edit that "tidies" task into the catalog would silently make a seat's only
// documented way to close its ticket revocable, and this is where that shows up.
test('task grammar is ungateable: it renders for a seat with every gateable verb denied', () => {
  const empty = buildIpcPrompt([]);
  assert.ok(/\n {2}\[agent:task done <id>\]/.test(empty), 'task done line present for a fully-gated seat');
  assert.ok(!/\n {2}\[agent:dm /.test(empty), 'ENTER: the seat really is gated — dm is gone');
});

// A grammar line that disagrees with the parse teaches an emission that does
// nothing; the term row's comment records exactly that failure. The generic
// "every rendered grammar line parses" test covers the FORMS at the head of each
// line. These pin the claims the task lines make in PROSE, which no form check
// reaches: the greedy body, its terminator, and the sub-verb shapes.
test('task line: the body modes it claims match bodyModeFor', () => {
  const taskLines = IPC_PROMPT.split('\n').filter((l) => /^ {2}\[agent:task /.test(l)).join('\n');
  assert.ok(/greedy/.test(taskLines), 'ENTER: the task lines are the ones making a greedy claim');
  for (const sub of ['add', 'done', 'reject', 'respec', 'cancel', 'accept']) {
    assert.strictEqual(bodyModeFor(parseIntent('[agent:task ' + sub + ' t1] body text')), 'greedy',
      sub + ' is documented as body-carrying');
  }
  for (const form of ['[agent:task assign t1 hand]', '[agent:task list]', '[agent:task list all]',
    '[agent:task park t1]', '[agent:task start t1]']) {
    assert.strictEqual(bodyModeFor(parseIntent(form)), 'none',
      form + ' is documented as taking no body');
  }
});

// The line tells a seat that `add` takes an optional assignee token and a
// position-free `park` modifier. parseTask filters `park` out of the positionals
// precisely so `add park hand` is not read as a ticket for a seat named "park",
// and a line that got this backwards would teach the misfile the parser avoids.
test('task line: add reads park as a modifier, not as the assignee', () => {
  const line = IPC_PROMPT.split('\n').find((l) => / {2}\[agent:task /.test(l) && /park/.test(l));
  assert.ok(line, 'ENTER: the literal documents park at all — the claim below is what it makes');
  assert.ok(/modifier/.test(line), 'and it calls park a modifier, not an assignee');
  const a = parseIntent('[agent:task add park hand] the spec');
  assert.deepStrictEqual([a.who, a.park], ['hand', true]);
  const b = parseIntent('[agent:task add hand park] the spec');
  assert.deepStrictEqual([b.who, b.park], ['hand', true], 'position-free, as the line says');
  const c = parseIntent('[agent:task add hand] the spec');
  assert.deepStrictEqual([c.who, c.park], ['hand', false]);
});

// The grammar line publishes the filter vocabulary to every seat forever, which
// makes it a THIRD copy of a list that was already duplicated twice on purpose:
// team-tickets.js TICKET_FILTERS and scripts/clodex-team.js:134, whose comment
// says in terms that they must be changed together and are deliberately not
// shared (that script is materialized as a flat basename copy and may require
// node builtins only). The prompt is the copy nobody will think to update, so
// the suite is the only thing holding it to the others.
//
// Asserting `parseIntent('[agent:task list X]').filter === 'X'` would test
// NOTHING here: parseTask is `filter: argToks[0] || null`, so it echoes any
// token — `xyzzy` included. Acceptance lives in TICKET_FILTERS, checked in
// _taskList. It is not exported, so it is read at source (the precedent is
// test/hold-recovery-single-source.test.js).
//
// BOTH directions, because one-directional is exactly how a single-source guard
// stays green while a copy rots: line→list catches a filter the prompt invents,
// list→line catches an ADDED filter the prompt never learned.
test('task line: the filter tokens it publishes ARE TICKET_FILTERS, both directions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  const m = src.match(/^const TICKET_FILTERS = \[([^\]]*)\];/m);
  assert.ok(m, 'ENTER: TICKET_FILTERS was found at source — a failed scan must not pass as agreement');
  const filters = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.ok(filters.length >= 2, `ENTER: the vocabulary parsed (got ${JSON.stringify(filters)})`);

  const line = IPC_PROMPT.split('\n').find((l) => /^ {2}\[agent:task list\]/.test(l));
  assert.ok(line, 'ENTER: the list line is in the literal');
  // Scan the FILTER CLAUSE, never the whole line. The line's second half is the
  // lead's dispatch protocol, and it already contains the words `add`, `assign`,
  // `start`, `park` and `cancel` for unrelated reasons — so a whole-line scan
  // reports any of those as "named as a filter" when TICKET_FILTERS grows one.
  // Measured: adding each of those five to TICKET_FILTERS left this subject
  // green, while `stalled` (absent from the line) failed it. Same silent-pass
  // class as the substring case below, in the direction that actually drifts.
  // Bounded at the worked example: `as in [agent:task list all]` is an
  // illustration, not the vocabulary, and its `[agent:task list …]` words are
  // not filters being offered.
  const clause = (line.match(/A filter token narrows it:(.*?), as in /) || [])[1];
  assert.ok(clause, 'ENTER: the filter clause was found on the line — a failed extract must not pass as agreement');
  // Words, not substrings: a substring test would let `done` hide inside
  // `[agent:task done <id>]`.
  const named = filters.filter((f) => new RegExp(`\\b${f}\\b`).test(clause));

  assert.deepStrictEqual(named, filters,
    'every accepted filter must be named in the clause — an added one the prompt never learned');
  // And nothing the clause offers may be a token the verb bounces. Reading real
  // words out of the clause rather than probing a fixed candidate list: a
  // hardcoded set can only catch an invented filter it happened to anticipate.
  const offered = (clause.match(/\b[a-z]+\b/g) || []).filter((w) => !['is', 'the', 'default', 'then', 'as', 'in'].includes(w));
  const bogus = [...new Set(offered)].filter((t) => !filters.includes(t));
  assert.deepStrictEqual(bogus, [],
    'the line offers a filter _taskList rejects — a seat copying it gets a bounce');

  assert.strictEqual(parseIntent('[agent:task list]').filter, null,
    'bare list carries no filter (the verb defaults it to open)');
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

// ── term: the rendered form must be a form the parser accepts ────────────────
// t232. The line documented `[agent:term exec <command>]` for its whole life,
// which parseTerm cannot match: its `(\S+)` admits ONE whitespace-free token
// before the `]`, so `exec <command>` never reaches the bracket. A seat that
// read the line literally emitted a line that did not fire. The bug is not that
// angle-bracket notation is wrong in general — remind/task/team genuinely take
// arguments inside the brackets — it is that term's argument is the BODY, and
// the identical notation for two grammars is what made it plausible.

test('term grammar line: the documented form parses as a term intent', () => {
  const p = buildIpcPrompt(['term', ...ALL_GATEABLE]);
  const line = p.split('\n').find((l) => l.trim().startsWith('[agent:term'));
  assert.ok(line, 'ENTER: a granted seat renders a term grammar line at all');
  const parsed = parseIntent(line);
  // Whole object: `sub` alone would pass on a line whose BODY silently became
  // the help prose, which is the shape a bracket-argumented form produces.
  assert.deepStrictEqual(
    parseIntent('[agent:term exec] pwd'),
    { type: 'term', sub: 'exec', body: 'pwd' },
    'ENTER: the form the line now teaches is the form the parser takes',
  );
  assert.ok(parsed, `the rendered term line must parse, got null for: ${line.trim().slice(0, 60)}`);
  assert.strictEqual(parsed.type, 'term');
  assert.strictEqual(parsed.sub, 'exec');
});

test('term grammar line: the old bracket-argumented spelling is gone from the prompt', () => {
  const p = buildIpcPrompt(['term', ...ALL_GATEABLE]);
  assert.ok(!p.includes('[agent:term exec <command>]'),
    'the spelling that does not parse must not be taught');
  assert.ok(p.includes('[agent:term exec] <command>'), 'the parsing form is what renders');
  // The prose half was already correct and disagreed with its own syntax line;
  // the two must not drift apart again.
  assert.ok(p.includes('The command is the rest of the line, AFTER the closing bracket'),
    'prose states where the command goes, agreeing with the syntax line above it');
});

// t233: the prose above says "the rest of the line", which was a claim the
// PARSER did not honour — the row captured greedily, so following prose joined
// the command. The row is line-scoped now, and this pins the doc against the
// behaviour rather than against itself: a revert to greedy leaves this text
// lying again.
test('term grammar line: the documented line scope matches what the row actually captures', () => {
  const p = buildIpcPrompt(['term', ...ALL_GATEABLE]);
  assert.ok(p.includes('It ends where the line ends'),
    'the line scope is stated, not left to be inferred from "rest of the line"');
  assert.strictEqual(bodyModeFor(parseIntent('[agent:term exec] pwd')), 'none',
    'and the parser agrees — this is the assertion the prose above is worth nothing without');
  // The neighbour that DOES take a multi-line body, so the claim above is
  // specific to term rather than true of the whole grammar block by accident.
  assert.strictEqual(bodyModeFor(parseIntent('[agent:memory remember] x')), 'greedy');
});

// The generalisation of the bug, and the reason this is a test rather than a
// one-line fix: EVERY rendered grammar line is a form some seat will copy
// literally. A line that cannot parse teaches an emission that does nothing.
// Placeholders are substituted with realistic literals — an unsubstituted
// `<command>` is itself a legal body, so leaving them in would let the very bug
// this pins slip through.
test('every rendered grammar line parses, with its placeholders filled in', () => {
  const p = buildIpcPrompt(['term', 'reboot', ...ALL_GATEABLE]);
  const fill = (l) => l
    .replace('<command>', 'pwd')
    .replace('<text>', 'a fact')
    .replace('<id|query>', 'mem-1')
    .replace('<id>', 'mem-1')
    .replace('<interval>', '30m')
    .replace('TARGET', 'bob')
    .replace('PATH', '/tmp/a.md')
    .replace('name:X', 'name:x')
    .replace('cwd:Y', 'cwd:/tmp')
    .replace('template:Y', 'template:tpl')
    .replace('[reason]', 'why');
  // The grammar block is `  [agent:…]` at two-space indent; prose paragraphs
  // that MENTION an intent are not indented that way and are not forms.
  // A run of 2+ spaces ends the FORM and starts its aligned description — which
  // a seat does not copy, and which is trailing junk to the bare-only verbs
  // (who/name/file/spawn are `\s*$`-anchored and would fail on it).
  const forms = p.split('\n').filter((l) => /^ {2}\[agent:/.test(l))
    .map((l) => l.trim().split(/\s{2,}/)[0]);
  assert.ok(forms.length >= 15, `ENTER: the grammar block was found (got ${forms.length} lines)`);
  assert.ok(forms.includes('[agent:term exec] <command>'),
    'ENTER: the term form survived the split — this test exists for that row');
  const bad = forms.filter((f) => !parseIntent(fill(f)));
  assert.deepStrictEqual(bad, [],
    'each of these renders a form the parser rejects — a seat copying it emits nothing');
});

// ── exec: a synthesized section keyed on the granted command-id allowlist ─────

// A listed command that never says WHEN to use it is dead weight: it renders as
// a capability the seat notices and then routes around, because its shell tool
// is always right there and needs no payload. Observed on a live lead, which
// ran `npm test` by hand with clodex-run-tests granted the whole time — paying
// for the full unbounded output the command exists to avoid.
test('exec section states that a granted command BEATS the equivalent shell line', () => {
  const p = buildIpcPrompt(null, ['clodex-run-tests']);
  assert.match(p, /PREFERRED route/, 'the section must rank exec above an ad-hoc shell equivalent');
  assert.match(p, /INSTEAD of assembling the same thing with your shell tool/,
    'and say so as an instruction, not as a note about why it was registered');
  // The rule is worthless if it only reaches seats that already read the whole
  // section, so it must sit ABOVE the command list, not below it.
  assert.ok(p.indexOf('PREFERRED route') < p.indexOf('[agent:exec clodex-run-tests]'),
    'the rule must precede the listing it governs');
});

// Placement, not wording. The EXEC section is read ONCE at session start; the
// decision to run something happens many turns later, with attention on SHELL
// COMMANDS. A rule that lives only in the section being skipped is not a rule.
test('a seat with exec grants is pointed back at them from SHELL COMMANDS', () => {
  const granted = buildIpcPrompt(null, ['clodex-run-tests']);
  const shellAt = granted.indexOf('SHELL COMMANDS:');
  assert.ok(shellAt > 0, 'the shell section exists');
  assert.match(granted.slice(shellAt), /check your EXEC COMMANDS list above/,
    'the pointer must sit in the shell section, where the decision is actually made');
  assert.ok(granted.indexOf('EXEC COMMANDS:') < shellAt, 'and point BACKWARD, at text already read');
  // A seat with no grants must not be told to consult a list it does not have —
  // and this is also what keeps both byte-pins equal to IPC_PROMPT.
  assert.ok(!buildIpcPrompt(null, []).includes('check your EXEC COMMANDS list'),
    'no grants, no pointer');
});

// The harness ships tools whose names collide with granted commands (a Monitor
// tool vs clodex-monitor); they are unrelated and do not touch this registry.
// A seat matching on NAME reaches the wrong one and never learns why.
test('exec section says to match a command by what it DOES, not by its name', () => {
  const p = buildIpcPrompt(null, ['clodex-monitor']);
  assert.match(p, /similar NAME is a different thing that does not use this registry/);
  assert.match(p, /Never sit blocking on slow work a granted command would run for you/,
    'the blocking-wait default is the specific behaviour a monitor grant exists to replace');
  assert.match(p, /BEFORE you plan a job/, 'consulted at plan time, not as a fallback after a bad result');
});

// The specific defect: a seat whose granted command timed out reached for the
// raw `npm test` as a fallback. The registered version takes the suite mutex
// and the raw one does not, so that "fallback" ran CONCURRENTLY with a locked
// run and deadlocked both — measured, two runs wedged on a port-binding test,
// the older for 13h47m. Routing around a refusal is the failure mode to name.
test('exec section forbids the raw form as a fallback when a command refuses', () => {
  const p = buildIpcPrompt(null, ['clodex-run-tests']);
  assert.match(p, /UNSAFE to run twice at once/, 'the concurrency hazard is named, not just the preference');
  assert.match(p, /The registered version takes the lock; the raw command you would have typed does not/,
    'and WHY the raw form is not equivalent — without this the rule reads as mere style');
  assert.match(p, /a refusal is information/,
    'a refusing command must not read as an invitation to bypass it');
});

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
  // Degraded, but still CALLABLE: the id alone bounces with "payload: empty"
  // and reads to the seat as a broken grant. It must also stay distinguishable
  // from the healthy no-field form on the next line, or "fields unknown" and
  // "no fields" look identical in the prompt.
  assert.ok(p.includes('  [agent:exec clodex-run-tests] {}\n'), 'string entry degrades to a callable line');
  assert.match(p, /clodex-run-tests\] \{\}\n {6}\(definition unreadable/);
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
