'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { termAvailableFor, vetTermCommand, TERM_EXEC_MAX } = require('../drawer-avail');

// Both exclusions are shipped defects, so each gets a test naming what it did
// rather than asserting a boolean twice.

test('an agent seat gets a terminal', () => {
  assert.strictEqual(termAvailableFor('claude'), true);
  assert.strictEqual(termAvailableFor('codex'), true);
});

test('a bash seat gets no terminal — the session is already a shell', () => {
  assert.strictEqual(termAvailableFor('bash'), false);
});

// The sharp one. A peer seat's key is `name@id`, `@` fails ipc-handlers' seat
// grammar, and a rejected seat becomes null — the SEATLESS workspace shell. So
// before this predicate existed, every peer row in a workspace was handed the
// same local shell, shared with each other and with the no-session drawer.
test('a peer seat gets no terminal — a local shell is not a remote box', () => {
  assert.strictEqual(termAvailableFor('remote'), false);
});

// The seatless drawer is the workspace-wide shell's legitimate home, and it is
// the ONE caller for which a null type is not a missing answer.
test('the seatless drawer keeps the workspace-wide shell', () => {
  assert.strictEqual(termAvailableFor(null), true);
});

// An unknown type must not silently lose its terminal: the exclusions are a
// DENY list on purpose, so a session type added later keeps working and its
// author decides deliberately whether to exclude it.
test('an unrecognized seat type is allowed, not denied by default', () => {
  assert.strictEqual(termAvailableFor('gemini'), true);
});

// --- vetTermCommand ------------------------------------------------------
// What a seat is allowed to type into its own terminal. The vetter owns the
// FRAMING only — one line, bounded length, nothing that turns one write into
// two. It deliberately makes no judgement about what the command DOES: quoting
// and safety belong to the operator who can see the terminal, and validating
// shell semantics here would be theatre over a login shell the agent could
// reach through its own tools anyway.

// Every control byte in this file is built from its code point. A raw one typed
// into the source is invisible, does not reliably survive reformatting or an
// editor that sanitizes on save, and its loss would silently turn each test
// below into an assertion about ordinary text that still passes.
const ch = (n) => String.fromCharCode(n);

test('an ordinary command passes, trimmed at the ends only', () => {
  // The trimmed text is what the caller is told ran, and what every later
  // message quotes back — so it is part of the contract, not a detail.
  assert.deepStrictEqual(vetTermCommand('  git log --oneline -5  '),
    { ok: true, command: 'git log --oneline -5' });
});

test('interior whitespace and shell punctuation are the command\'s own', () => {
  const cmd = `grep -rn 'a;b' . | head -3 && echo "done"`;
  assert.deepStrictEqual(vetTermCommand(cmd), { ok: true, command: cmd });
});

test('an empty command is refused with the syntax, not a bare error', () => {
  // The likeliest cause is an agent that wrote the intent line and forgot the
  // body, so the refusal has to say where the command goes.
  for (const input of ['', '   ', null, undefined, 42]) {
    const r = vetTermCommand(input);
    assert.strictEqual(r.ok, false, `ENTER: ${JSON.stringify(input)} was refused`);
    assert.match(r.error, /needs the command/);
  }
});

// The four bytes that would each turn one write into something else, and the
// one that is simply not text. Each gets its own named reason because "control
// character" tells an agent nothing it can act on.
test('a newline is refused — everything before it would execute immediately', () => {
  const r = vetTermCommand(`echo hi${ch(0x0a)}rm -rf /`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /newline \(LF\)/);
  assert.match(r.error, /position 7/, 'the position is stated: the byte is invisible in the agent\'s own output');
});

test('a carriage return is refused as its own case, not as generic ctrl', () => {
  const r = vetTermCommand(`echo hi${ch(0x0d)}rm -rf /`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /carriage return \(CR\)/);
});

test('an ESC is refused — a terminal can answer it by writing to its own stdin', () => {
  const r = vetTermCommand(`echo ${ch(0x1b)}[5n`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /escape \(ESC\)/);
});

test('a tab is refused — the shell reads it as a completion request', () => {
  const r = vetTermCommand(`ls${ch(0x09)}-la`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /tab/);
});

test('an unnamed control byte still gets a specific, actionable refusal', () => {
  // The Map has five entries; the rest of C0 and DEL must not fall through to
  // silence. The code point is spelled out because the agent cannot see it.
  const r = vetTermCommand(`ls${ch(0x01)}x`);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /U\+0001/);

  const del = vetTermCommand(`ls${ch(0x7f)}x`);
  assert.strictEqual(del.ok, false);
  assert.match(del.error, /U\+007F/);
});

test('the refusal SAYS it rejected rather than stripped', () => {
  // The distinction is the whole reason this refuses: a stripped `echo a\nrm -rf /`
  // becomes a different command that still runs, and the agent is never told its
  // command was rewritten.
  const r = vetTermCommand(`echo a${ch(0x0a)}rm -rf /`);
  assert.match(r.error, /rejected, not stripped/);
});

test('a trailing newline is trimmed, not refused', () => {
  // The common shape by far: a greedy intent body ends with the line break that
  // closed it. Refusing that would make the feature unusable for the ordinary
  // case while catching none of the dangerous ones.
  assert.deepStrictEqual(vetTermCommand(`ls -la${ch(0x0a)}`), { ok: true, command: 'ls -la' });
});

test('the length cap is on BYTES, not characters', () => {
  // The PTY is a byte stream. A multi-byte payload that passes a .length check
  // can still be several times the cap on the wire.
  const atCap = 'x'.repeat(TERM_EXEC_MAX);
  assert.strictEqual(vetTermCommand(atCap).ok, true, 'ENTER: exactly at the cap is allowed');

  const over = vetTermCommand('x'.repeat(TERM_EXEC_MAX + 1));
  assert.strictEqual(over.ok, false);
  assert.match(over.error, new RegExp(`${TERM_EXEC_MAX + 1} bytes`), 'the actual size is stated');
  assert.match(over.error, /script/, 'and the refusal says what to do instead');

  // Half as many characters as the cap, but two bytes each — refused, where a
  // character-counting cap would have let it through.
  const wide = 'é'.repeat(TERM_EXEC_MAX / 2 + 1);
  assert.ok(wide.length < TERM_EXEC_MAX, 'ENTER: this passes a naive character count');
  assert.strictEqual(vetTermCommand(wide).ok, false);
});
