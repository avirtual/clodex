'use strict';
// Run: node --test test/hold-recovery-single-source.test.js
//
// t465 — the four-reader agreement on `verifyHold.recovery` is CONVENTION.
//
// t345 fixed a defect whose shape was several readers of one record field each
// formatting their own sentence about it, and drifting: the sweep alarm told the
// lead to close a ticket again where re-closing could not terminate, while the
// arm's own evidence two lines above said the opposite. The fix routes every
// reader through `HOLD_RECOVERY`/`holdRecoveryText`.
//
// They agree because six call sites each CHOSE to call one helper. Nothing
// prevented a seventh formatting its own sentence — which is how the original
// defect arose. This file is that prevention, and it is a RATCHET, chosen
// deliberately after the alternatives were weighed and found worse:
//
//   - Stamping the RENDERED TEXT instead of the class would kill drift at the
//     source, but `_taskRespec` branches on `recovery !== 'spec'` to pick a
//     ROUTE, not just wording. Rendered prose cannot be branched on, so that
//     construction breaks an accepted arm — decisive before the tickets.json
//     bloat argument is even reached.
//   - Making the field unreadable means wrapping every `ticketsStore.load`
//     site; the blast radius is the whole board, not this field.
//
// So the honest answer is that the test IS the right tool here. What makes it
// more than a compliance count: it scans SOURCE for the shape of the next wrong
// reader, so it is red on a reader that does not exist yet. A test that only
// checked today's readers still agree would be green today AND green on the day
// the seventh is added wrong — the false-green this codebase keeps hitting.
//
// The scanner runs against synthetic fixtures FIRST (below), because a scanner
// exercised only against the real file proves nothing about what it would catch:
// a regex that matches nothing is green on a clean file forever.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ── the scanner ────────────────────────────────────────────────────────────
//
// TWO rules, and the second is the one that catches the historical defect.
//
// Rule A: every read of `.recovery` is an argument to `holdRecoveryText`.
// Rule B: every line interpolating `verifyHold` INSIDE a template literal
//         belongs to a statement that calls `holdRecoveryText`.
//
// Rule A alone would have been GREEN on the original defect: the old sweep
// sentence read `verifyHold.step` and wrote its own advice without ever
// touching `.recovery`. Rule B is what makes a new prose reader red.
//
// A "statement" is approximated by walking back from the line to the start of
// its expression — recovery text is built with `+` concatenation across lines
// (the sweep body spans four), so a line-local check would false-positive on
// every continuation line of a correct reader.
function scanHoldRecovery(src) {
  const lines = src.split('\n');
  const violations = [];
  let inBlockComment = false;

  const isCommentLine = (raw) => {
    const t = raw.trim();
    let comment = inBlockComment || t.startsWith('//') || t.startsWith('*');
    if (t.startsWith('/*')) inBlockComment = true;
    if (t.includes('*/')) inBlockComment = false;
    return comment;
  };

  // The statement a line belongs to: walk back while the previous non-comment
  // line ends in an operator that continues an expression, and forward while
  // this one does. Deliberately crude — it only has to span `+`-concatenated
  // template literals and ternaries, which is how every reader here is written.
  const statementText = (idx) => {
    // Two directions, two different questions. Backwards: does the line ABOVE
    // hand this one an unfinished expression. Forwards: does the line BELOW
    // continue this one — which is a leading `+`/`?`/`:`, not a trailing one.
    // Conflating them was a real false positive: the sweep alarm's first line
    // ends in a backtick, so a trailing-operator test stops there and never
    // reaches the `holdRecoveryText` call two lines down.
    const endsOpen = (s) => /[+?:(,=]\s*$/.test(s);
    const startsCont = (s) => /^\s*[+?:]/.test(s);
    let lo = idx;
    while (lo > 0) {
      const prev = lines[lo - 1];
      if (prev.trim().startsWith('//')) { lo--; continue; }
      if (!endsOpen(prev) && !startsCont(lines[lo])) break;
      lo--;
    }
    let hi = idx;
    while (hi < lines.length - 1) {
      const next = lines[hi + 1];
      if (next.trim().startsWith('//')) { hi++; continue; }
      if (!endsOpen(lines[hi]) && !startsCont(next)) break;
      hi++;
    }
    return lines.slice(lo, hi + 1).join('\n');
  };

  lines.forEach((raw, i) => {
    const comment = isCommentLine(raw);
    if (comment || !raw.includes('verifyHold')) return;
    const stmt = statementText(i);

    // Rule A — a `.recovery` read must feed the renderer.
    if (/verifyHold(\s*&&\s*[A-Za-z_.\s]*)?\.recovery/.test(raw)
      && !/holdRecoveryText\s*\(/.test(stmt)) {
      violations.push({ line: i + 1, rule: 'A', text: raw.trim() });
      return;
    }

    // Rule B — rendering the field into prose must go through the renderer.
    // Anchored on `${…verifyHold`, so plain reads (`if (t.verifyHold)`,
    // `delete ticket.verifyHold`, the re-entry predicate) are untouched: they
    // read the field's PRESENCE and prescribe nothing.
    if (/\$\{[^}]*verifyHold/.test(raw) && !/holdRecoveryText\s*\(/.test(stmt)) {
      violations.push({ line: i + 1, rule: 'B', text: raw.trim() });
    }
  });
  return violations;
}

// ── the scanner catches the next wrong reader (synthetic) ──────────────────
//
// The RED CASE the ticket names: a NEW reader that formats its own sentence.
// These are the proof the scan has teeth; the real-file subject below is the
// one that stays green.

test('RED: a new reader formatting its own recovery sentence is caught', () => {
  const mutant = [
    'const body = `the loop stopped at "${t.verifyHold.step}" — close the ticket again`;',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: the mutant produced exactly one violation');
  assert.strictEqual(v[0].rule, 'B', 'caught by rule B — it renders prose without the helper');
});

test('RED: this is the ORIGINAL defect, which never reads .recovery at all', () => {
  // Verbatim shape of the sweep sentence t345 removed: one sentence for all
  // eleven arms, reading only `.step`. Rule A cannot see it — no `.recovery`
  // is read — so this subject is what proves rule B is load-bearing rather
  // than decorative.
  const mutant = 'body = `${head}the loop ESCALATED at "${t.verifyHold.step}". Close the ticket again.`;';
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: caught');
  assert.strictEqual(v[0].rule, 'B', 'by rule B specifically — rule A is blind to it');
  assert.ok(!/recovery/.test(mutant), 'and the mutant really does never read .recovery');
});

test('RED: a reader that reads .recovery but renders it itself is caught', () => {
  const mutant = 'reply(`held: ${ticket.verifyHold.recovery === "spec" ? "reject it" : "close again"}`);';
  const v = scanHoldRecovery(mutant);
  assert.ok(v.length >= 1, 'ENTER: caught');
  assert.strictEqual(v[0].rule, 'A', 'by rule A — it reads the class and prescribes off it');
});

test('GREEN: a correct reader calling the helper passes', () => {
  const ok = 'reply(` — held at "${t.verifyHold.step}". ${holdRecoveryText(t.verifyHold.recovery, id)}`);';
  assert.deepStrictEqual(scanHoldRecovery(ok), [], 'a reader that routes through the helper is not a violation');
});

test('GREEN: multi-line `+` concatenation is one statement, not a violation per line', () => {
  // The sweep alarm's real shape. A line-local check would flag the `.step` and
  // `.evidence` lines even though the helper is called two lines down — which
  // would make the scan unusable and get it deleted rather than obeyed.
  const ok = [
    'body = `${head}the loop ESCALATED at "${t.verifyHold.step}" and is waiting`',
    '  + `\\n\\nEVIDENCE: ${t.verifyHold.evidence}`',
    '  + `\\n\\nRECOVERY: ${holdRecoveryText(t.verifyHold.recovery, tid)}`;',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [], 'the whole concatenated statement counts as the reader');
});

test('GREEN: presence reads and deletes prescribe nothing and are not readers', () => {
  const ok = [
    'const reentry = ticket.state === "done" && !!ticket.verifyHold;',
    'delete ticket.verifyHold;',
    'if (t.verifyHold) {',
    '  .filter((t) => t && t.loopStep === "verify" && !t.verifyHold)',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [], 'reading whether a hold exists is not rendering advice about it');
});

test('GREEN: a commented-out reader is not a violation', () => {
  const ok = '// body = `held at ${t.verifyHold.step}, close it again`;';
  assert.deepStrictEqual(scanHoldRecovery(ok), [], 'comments prescribe nothing');
});

test('the scanner is anchored to real syntax, not to the word "verifyHold"', () => {
  // A scanner that matched the bare identifier would flag prose in this file's
  // own header and every comment in team-tickets.js — which is how a source
  // scan gets silenced with an exclusion list until it means nothing.
  assert.deepStrictEqual(scanHoldRecovery('// verifyHold is the stamp the loop writes'), []);
});

// ── the real file agrees ───────────────────────────────────────────────────

test('every verifyHold recovery reader in team-tickets.js routes through holdRecoveryText', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  // ENTER: the scan reached the readers. Asserted because every claim below is
  // an ABSENCE — a scan that matched nothing (a rename, a moved field) would
  // satisfy `deepStrictEqual(v, [])` while proving nothing at all.
  const readers = src.split('\n').filter((l) => /\$\{[^}]*verifyHold/.test(l) && !l.trim().startsWith('//'));
  assert.ok(readers.length >= 5,
    `ENTER: the real readers were found (got ${readers.length}) — a zero here means the scan went blind`);
  assert.deepStrictEqual(scanHoldRecovery(src), [],
    'a reader formats its own recovery sentence instead of calling holdRecoveryText');
});

test('the helper is the only place HOLD_RECOVERY is read', () => {
  // The table itself is the other way to bypass the renderer: indexing it
  // directly re-implements the fallback that `holdRecoveryText` owns, and a
  // class the table lacks would then print "undefined" instead of the hand text.
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  const uses = src.split('\n')
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter(({ text }) => /HOLD_RECOVERY/.test(text) && !text.trim().startsWith('//'));
  assert.strictEqual(uses.length, 2,
    `ENTER: the table's definition and its single reader (got ${uses.length}: ${uses.map((u) => u.line).join(', ')})`);
  assert.match(uses[0].text, /^const HOLD_RECOVERY = \{/, 'the definition');
  assert.match(uses[1].text, /^const holdRecoveryText = /, 'and the renderer, which is the only reader');
});
