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
// THE RULE, stated once: **rendering the STAMP OBJECT into prose requires the
// helper; rendering a narrowly-extracted fact off it does not. Reading
// `recovery` by any route always requires the helper.**
//
//   ${t.verifyHold.step} in prose            FLAG — the historical defect
//   hold = ticket.verifyHold; ${hold.step}   FLAG — whole-object alias
//   heldAt = ...verifyHold.step; ${heldAt}   PASS — a narrowed fact
//   held = ...holdRecoveryText(...)          PASS — carries the recovery
//   any read of `recovery`, however bound    FLAG unless the helper is called
//
// Rule A (the `recovery` half) alone would have been GREEN on the original
// defect: the old sweep sentence read `verifyHold.step` and wrote its own
// advice without ever touching `.recovery`. Rule B is what makes a new prose
// reader red.
//
// WHY A BINDING PRE-PASS. Both rules were once line-local on the literal token
// `verifyHold`, which made them blind to every reader that binds the stamp to a
// local first — an idiom already in this file (`heldAt`, :4449, rendered at
// :4605 on a line carrying no `verifyHold` at all). That blindness composed
// badly: the DIRECT form of that same reply would trip rule B, so the author's
// natural escape from the false positive was to alias — silencing the scan
// permanently. A ratchet that teaches how to defeat it is worse than none.
//
// So the pre-pass CLASSIFIES each binding rather than merely collecting it.
// Collecting alone would flag `${held}` — the correct reader — and `reentry`,
// a boolean. Three kinds, and only one is a violation when rendered:
//   PRESENCE  (`!!ticket.verifyHold`)         — a boolean, prescribes nothing
//   FACT      (`...verifyHold.step`)          — narrowed, carries no recovery
//   HELPER    (`...holdRecoveryText(...)`)    — the recovery, already rendered
//   OBJECT    (`= ticket.verifyHold`)         — the whole stamp: FLAG on render
//
// The escape from a false positive here is to NARROW THE BINDING to the fact
// field, which is the habit worth teaching, and it cannot reach `recovery`
// without tripping rule A. There is no evasion that is not also the fix.
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

  // PRE-PASS. Every identifier bound off the stamp, classified. Runs over the
  // whole file first because a binding may be rendered further down than it is
  // declared — the `heldAt` case spans 150 lines.
  const objectAliases = new Set();   // whole stamp: rendering it is a violation
  const recoveryAliases = new Set(); // `recovery` pulled out: always a violation
  {
    let block = false;
    lines.forEach((raw) => {
      const t = raw.trim();
      const isCmt = block || t.startsWith('//') || t.startsWith('*');
      if (t.startsWith('/*')) block = true;
      if (t.includes('*/')) block = false;
      if (isCmt || !raw.includes('verifyHold')) return;

      // Destructuring: `const { step, recovery } = ticket.verifyHold`. Each name
      // is classified on its own — `recovery` is rule A's business wherever it
      // came from, while `step` is a narrowed fact.
      const destructured = raw.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[^;]*verifyHold/);
      if (destructured) {
        destructured[1].split(',').forEach((part) => {
          const name = part.split(':').pop().trim();
          if (!name) return;
          if (/^recovery$/.test(part.trim().split(':')[0].trim())) recoveryAliases.add(name);
        });
        return;
      }

      const bound = raw.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*verifyHold.*)$/);
      if (!bound) return;
      const [, name, rhs] = bound;
      // HELPER and PRESENCE bindings prescribe nothing on render; FACT bindings
      // narrow to a field that carries no advice. Only a bare whole-stamp
      // binding stays dangerous, because everything on it is reachable later.
      if (/holdRecoveryText\s*\(/.test(rhs)) return;
      if (/!!|===|!==/.test(rhs)) return;
      if (/\.recovery\b/.test(rhs)) { recoveryAliases.add(name); return; }
      if (/verifyHold\s*\.\s*[A-Za-z_$]/.test(rhs) && !/verifyHold\s*[;,)]|verifyHold\s*$/.test(rhs)) return;
      objectAliases.add(name);
    });
  }

  const aliasRendered = (raw, names) => [...names].some(
    (n) => new RegExp(`\\$\\{[^}]*\\b${n}\\b`).test(raw));

  lines.forEach((raw, i) => {
    const comment = isCommentLine(raw);
    if (comment) return;
    const stmt = statementText(i);
    const helper = /holdRecoveryText\s*\(/.test(stmt);

    // Rule A, alias arm — `recovery` pulled off the stamp under any name.
    if (recoveryAliases.size && !helper
      && [...recoveryAliases].some((n) => new RegExp(`\\b${n}\\b`).test(raw))
      && !/(?:const|let|var)\s/.test(raw)) {
      violations.push({ line: i + 1, rule: 'A', text: raw.trim() });
      return;
    }
    // Rule B, alias arm — the whole stamp rendered into prose under a local.
    if (!helper && aliasRendered(raw, objectAliases)) {
      violations.push({ line: i + 1, rule: 'B', text: raw.trim() });
      return;
    }
    if (!raw.includes('verifyHold')) return;

    // Rule A — a `.recovery` read must feed the renderer.
    //
    // Skipped on a line the pre-pass already classified as a `recovery` binding:
    // that read is reported at its RENDER instead, which is the line that has to
    // change. Reporting both doubles every such violation and points the reader
    // first at an assignment that is harmless until something prescribes off it.
    const isClassifiedBinding = /(?:const|let|var)\s/.test(raw)
      && [...recoveryAliases].some((n) => new RegExp(`\\b${n}\\b`).test(raw));
    if (!isClassifiedBinding
      && /verifyHold(\s*&&\s*[A-Za-z_.\s]*)?\.recovery/.test(raw) && !helper) {
      violations.push({ line: i + 1, rule: 'A', text: raw.trim() });
      return;
    }

    // Rule B — rendering the field into prose must go through the renderer.
    // Anchored on `${…verifyHold`, so plain reads (`if (t.verifyHold)`,
    // `delete ticket.verifyHold`, the re-entry predicate) are untouched: they
    // read the field's PRESENCE and prescribe nothing.
    if (/\$\{[^}]*verifyHold/.test(raw) && !helper) {
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

// ── the ALIASED idioms (r1 must-fix) ───────────────────────────────────────
//
// Both of these PASSED the first version of this scan, which was line-local on
// the literal token `verifyHold`. The idiom is not hypothetical: `heldAt`
// (team-tickets.js:4449) is rendered at :4605 on a line carrying no
// `verifyHold` at all, so the scan never reached it.
//
// What made it urgent is the composition. The DIRECT form of a step-only render
// tripped rule B, so the author's natural escape from that false positive was to
// bind a local — which silenced the scan for good. These subjects pin that the
// escape no longer works.

test('RED: a reader that aliases the whole stamp is caught (rule B was blind)', () => {
  const mutant = [
    'const hold = ticket.verifyHold;',
    'reply(`held at "${hold.step}" — close the ticket again`);',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: the aliased render produced a violation');
  assert.strictEqual(v[0].rule, 'B', 'caught by rule B, through the binding pre-pass');
  assert.strictEqual(v[0].line, 2, 'reported at the RENDER, which is the line to fix');
});

test('RED: a reader that destructures `recovery` is caught (rule A was blind)', () => {
  // `recovery` precedes `verifyHold` on the line, so the old `.recovery`
  // pattern — which required the token first — could not match it.
  const mutant = [
    'const { step, recovery } = ticket.verifyHold;',
    'reply(`held at "${step}"; ${recovery === "spec" ? "reject and refile" : "close it again"}`);',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: the destructured read produced a violation');
  assert.strictEqual(v[0].rule, 'A', 'caught by rule A — the class was read and rendered by hand');
  assert.strictEqual(v[0].line, 2, 'at the render, not the destructuring');
});

test('RED: renaming on destructure does not evade rule A', () => {
  const mutant = [
    'const { recovery: cls } = ticket.verifyHold;',
    'reply(`do this: ${cls === "spec" ? "edit the spec" : "close it again"}`);',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: caught under its new name');
  assert.strictEqual(v[0].rule, 'A', 'the class is the class whatever it is called');
});

test('GREEN: a NARROWED fact binding is not a violation — this is the intended escape', () => {
  // `heldAt` is the real instance. A binding that keeps only `.step` carries no
  // recovery and prescribes nothing, so rendering it later is a statement of
  // fact. This is deliberately the cheap way out of a rule B false positive:
  // the fix and the evasion are the same edit, which is the property the
  // whole-object flag is chosen to produce.
  const ok = [
    'const heldAt = (ticket.verifyHold && ticket.verifyHold.step) || null;',
    'reply(`re-verifying (was held at "${heldAt}")`);',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [], 'a narrowed fact is not the stamp');
});

test('GREEN: a narrowed fact cannot smuggle the recovery out', () => {
  // The escape must not be a hole: narrowing to `.recovery` instead of `.step`
  // is rule A's business, and binding it does not launder it.
  const mutant = [
    'const cls = ticket.verifyHold.recovery;',
    'reply(`do this: ${cls === "spec" ? "edit the spec" : "close it again"}`);',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: narrowing to the class is still a class read');
  assert.strictEqual(v[0].rule, 'A', 'rule A, wherever the class came from');
});

test('GREEN: a presence boolean and a helper binding are both renderable', () => {
  // The two bindings that would false-positive under a pre-pass that merely
  // COLLECTED names instead of classifying them — `held` is the CORRECT reader.
  const ok = [
    'const reentry = ticket.state === "done" && !!ticket.verifyHold;',
    'const held = ticket.verifyHold ? ` — ${holdRecoveryText(ticket.verifyHold.recovery, id)}` : "";',
    'reply(`${reentry ? "re-verifying" : "done"}${held}`);',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [],
    'a boolean prescribes nothing and the helper has already rendered the advice');
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

test('the stamp is read in team-tickets.js ALONE, which is what makes the scan sufficient', () => {
  // The scan reads one file. That is only enough while the field is read in one
  // file — and `holdRecoveryText` is NOT exported (module.exports carries
  // ticketCloseLine, ticketCloseVerb, ticketTaskDirLine), so a reader added
  // anywhere else literally cannot call it and would be invisible here.
  //
  // The obvious candidate is a viewer or plugin rendering a held row. This
  // subject goes red the moment one lands, which forces the export decision to
  // be made deliberately at that point instead of a second sentence quietly
  // appearing in a file this scan never opens.
  const root = path.join(__dirname, '..');
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'tasks']);
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.name.endsWith('.js')) continue;
      if (fs.readFileSync(full, 'utf8').includes('verifyHold')) found.push(path.relative(root, full));
    }
  };
  walk(root);
  // ENTER: the walk actually reached source. A walk that found nothing would
  // satisfy the containment claim below while proving the opposite.
  assert.ok(found.includes('team-tickets.js'),
    `ENTER: the walk reached the producer (found: ${found.join(', ') || 'nothing'})`);
  assert.deepStrictEqual(found.sort(), [
    'team-tickets.js',
    'test/hold-recovery-single-source.test.js',
    'test/ticket-loop-verify.test.js',
  ], 'a new reader outside team-tickets.js cannot reach holdRecoveryText — export it deliberately, then widen this scan');
});

test('the helper is the only place HOLD_RECOVERY is read', () => {
  // The table itself is the other way to bypass the renderer: indexing it
  // directly re-implements the fallback that `holdRecoveryText` owns, and a
  // class the table lacks would then print "undefined" instead of the hand text.
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  // Matched on USE syntax (`HOLD_RECOVERY[`, `.`, ` =`) rather than on the bare
  // name, so prose mentioning the table in a comment does not fail this — the
  // mention is not the hazard, indexing it is.
  const uses = src.split('\n')
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter(({ text }) => /HOLD_RECOVERY\s*[[.=]/.test(text) && !text.trim().startsWith('//'));
  assert.strictEqual(uses.length, 2,
    `ENTER: the table's definition and its single reader (got ${uses.length}: ${uses.map((u) => u.line).join(', ')})`);
  assert.match(uses[0].text, /^const HOLD_RECOVERY = \{/, 'the definition');
  assert.match(uses[1].text, /^const holdRecoveryText = /, 'and the renderer, which is the only reader');
});
