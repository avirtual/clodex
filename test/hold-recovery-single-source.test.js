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
// THE RULE, stated once: **rendering ANYTHING off the stamp into prose requires
// the helper — the whole object or a single field, directly or through a local.
// The only ways out are calling the helper or an audited exemption marker.**
//
//   ${t.verifyHold.step} in prose            FLAG — the historical defect
//   hold = ticket.verifyHold; ${hold.step}   FLAG — whole-object alias
//   heldAt = ...verifyHold.step; ${heldAt}   FLAG — narrowed, still a render
//   held = ...holdRecoveryText(...)          PASS — carries the recovery
//   a RENDER of `recovery`, however bound    FLAG unless the helper is called
//   a ROUTE read of `recovery` — one that
//     reaches control flow ONLY               PASS — the class exists for this
//   a class-derived value that SELECTS
//     between advice literals                 FLAG — boolean or string alike
//   a render marked `prescribes-nothing`     PASS — written claim, and counted
//
// DISCRIMINATE BY USE, NEVER BY TYPE. An r3 carve-out exempted a derived
// BOOLEAN ("comparing is routing, a boolean has no wording to drift") — true of
// the value, false of the statement, and `reply(isSpec ? 'reject and refile' :
// 'close the ticket again')` is three lines from the class to two hand-written
// sentences that do not move when HOLD_RECOVERY does. The carve-out was deleted
// rather than narrowed: every local derived from the class is tracked, and what
// separates a route from a render is where the value GOES.
//
// ONE PREMISE, two extraction depths. Rule A and rule B differ only in how far
// the value was carried before it reached prose; both fire on the RENDER, never
// on the read. An earlier rule A flagged every read of the class, which was
// wrong for the reason Q1 gives above: `_taskRespec` branches on
// `recovery !== 'spec'` to pick a ROUTE, so the class exists precisely to be
// branched on. That false positive was not cosmetic — the quietest way to
// silence it was to bind the class to a local, which is the one shape the rule
// could not see. A rule that punishes correct usage pumps authors into its own
// blind spot, so the premise, not the arm, was the defect.
//
// AN EARLIER VERSION EXEMPTED THE NARROWED FACT and that was the same defect
// this file exists to prevent, one level up. The reasoning was that `.step`
// "carries no advice" — true of the FIELD, false of the STATEMENT, because the
// advice is the prose an author writes around it. The t345 sweep sentence is
// exactly that shape, so it walked through in narrowed form; and the header
// taught narrowing as the escape from a rule B false positive, pointing authors
// at the one shape the scan could not see. A rule that directs its user to its
// own blind spot is worse than no rule.
//
// So a genuine false positive is resolved by WRITING DOWN why, not by narrowing
// until the scan goes quiet. One exemption exists (`:4605`, a receipt to the
// seat that just cleared the hold) and a subject counts them, so a second
// cannot appear in a diff nobody reads.
//
// Rule A (the `recovery` half) alone would have been GREEN on the original
// defect: the old sweep sentence read `verifyHold.step` and wrote its own
// advice without ever touching `.recovery`. Rule B is what makes a new prose
// reader red.
//
// THE COMPOSITION THIS FILE KEEPS REPRODUCING, recorded because it recurred
// three times under three different rules: r1, an alias defeated line-local
// matching; r2, narrowing to a field defeated an object-only rule; r3, binding
// defeated a token-based rule. Each patch closed its instance and the shape
// reappeared one level up. What broke the cycle was fixing a PREMISE rather
// than adding an arm — so when this rule next misses something, check whether
// the premise is wrong before widening a pattern.
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
// a boolean. Three kinds, and only one is safe to render freely:
//   PRESENCE  (`!!ticket.verifyHold`)         — a boolean, carries no text
//   HELPER    (`...holdRecoveryText(...)`)    — the recovery, already rendered
//   STAMP     (`= ticket.verifyHold`, or any
//              field narrowed off it)         — FLAG on render
//
// WHAT THE RULE DELIBERATELY PASSES, enumerated because the last two holes in
// this file were both exemptions rather than blind spots — the shapes a rule
// lets through are where its next defect lives, so they are written down:
//
//   1. A PRESENCE boolean plus hand-written advice (`if (!!hold) reply('close
//      it again')`). Passes, and correctly: the stamp contributes no TEXT, so
//      there is no field whose wording can drift from the record — which is the
//      property this file defends. The advice is unconditioned prose, wrong in
//      the same way anywhere in the codebase, and not this rule's business.
//   2. A HELPER render with extra prose appended. Passes: the helper's sentence
//      is present and correct, and policing what an author adds after it is the
//      prose-matching rule rejected above as brittle.
//
// Both are genuinely narrower than the historical defect, which read a FIELD and
// wrote a sentence that contradicted it. Neither can do that.
//
// ADVERSARIAL PROBE OF THE r4 PREMISE, run BEFORE shipping it — because the r3
// carve-out was written in the same commit that fixed r2's, and stating the
// lesson did not stop me repeating it. Two shapes select prose on the class and
// still pass:
//
//   1. `switch (cls) { case 'spec': reply('reject'); … }` — no binding, no
//      literal in an initialiser; the selection is the control structure.
//   2. `const M = { spec: 'reject', hand: 'close again' }; reply(M[cls]);`
//
// The SECOND is the more likely of the two, and worth saying plainly: it is
// exactly `HOLD_RECOVERY`'s own shape. The correct construct here IS an object
// literal keyed by class, so an author copying the pattern into a local table
// writes the defect while imitating the fix. If a violation ever lands, look
// for a second table before looking for a stray sentence.
//
// Neither occurs today (both `switch` statements in team-tickets.js key on
// `intent.sub`; the only class-keyed table is HOLD_RECOVERY itself). Left
// uncovered for the depth reason below, and named so it is a known edge rather
// than a discovery.
//
// WHERE THE COMPOSITION WOULD REAPPEAR NEXT, probed against the premise added
// in r3 rather than waiting for a fourth rejection to find it. The prose hop is
// ONE deep, so three shapes pass: advice assigned through a second local
// (`b = a`), advice built in an if/else rather than an initialiser, and advice
// returned from a function call (`pick(cls)`).
//
// Measured, not assumed: none occurs in team-tickets.js — all five real advice
// sites call `holdRecoveryText` inline, and the file contains no local whose
// wording is chosen off a recovery class at all. So one hop is the depth the
// codebase's own idiom reaches, which is the same standard the rest of this
// scanner is built to.
//
// Named here rather than chased because the honest boundary is the point: an
// arbitrary-depth prose taint needs dataflow, not text, and each extra hop
// bought by a regex costs false-positive surface on a rule whose whole value is
// that authors trust it. If a reader ever DOES build advice through two hops,
// this comment is the record that it was a known edge, not an oversight.
//
// WHAT THIS STILL DOES NOT SEE, measured rather than assumed. The pre-pass is
// one level deep and text-based, so three shapes get through: an alias of an
// alias (`h2 = h`), a nested destructure (`const { verifyHold: { recovery } }
// = ticket`), and the stamp passed as a function ARGUMENT — the last of which
// is a live idiom here, `_stampVerifyHold(team, ticketId, hold)`, though that
// one is a writer and so not a reader this rule governs. None of the three
// appears as a READER in the file today (checked: zero whole-stamp bindings
// beyond the three classified, zero nested destructures of the field).
//
// Left uncovered deliberately. Closing them properly means parsing rather than
// scanning, and each regex added to chase one costs a false-positive surface
// on a rule whose whole value is that authors trust it. The honest boundary:
// this catches the shapes the file's own idiom teaches, which is where the next
// reader will actually come from. It is not a proof of absence.
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
  const stampAliases = new Set();    // stamp OR a fact off it: flag on render
  const recoveryAliases = new Set(); // `recovery` pulled out: always a violation
  {
    let block = false;
    lines.forEach((raw, i) => {
      const t = raw.trim();
      const isCmt = block || t.startsWith('//') || t.startsWith('*');
      if (t.startsWith('/*')) block = true;
      if (t.includes('*/')) block = false;
      if (isCmt || !raw.includes('verifyHold')) return;

      // Destructuring: `const { step, recovery } = ticket.verifyHold`. Each name
      // is classified on its own — `recovery` is rule A's business wherever it
      // came from, while `step` is a fact, which rule B still governs.
      const destructured = raw.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*[^;]*verifyHold/);
      if (destructured) {
        destructured[1].split(',').forEach((part) => {
          const name = part.split(':').pop().trim();
          if (!name) return;
          if (/^recovery$/.test(part.trim().split(':')[0].trim())) recoveryAliases.add(name);
          else stampAliases.add(name);
        });
        return;
      }

      const bound = raw.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*verifyHold.*)$/);
      if (!bound) return;
      const [, name, rhs] = bound;
      // Classified against the whole STATEMENT, not the line: the correct reader
      // binds across three lines and calls the helper on the second, so a
      // line-local test reads its first line as a bare fact and flags the one
      // reader that is right.
      if (/holdRecoveryText\s*\(/.test(statementText(i))) return;
      // PRESENCE alone prescribes nothing and cannot carry a step into prose.
      if (/!!|===|!==/.test(rhs)) return;
      if (/\.recovery\b/.test(rhs)) { recoveryAliases.add(name); return; }
      // A NARROWED FACT is treated exactly like the whole stamp. The r1 version
      // exempted it, reasoning that `.step` "carries no advice" — true of the
      // FIELD and false of the STATEMENT, since the advice is the prose an
      // author writes around it. That exemption reopened the t345 defect in
      // narrowed form (`const step = t.verifyHold.step` then a hand-written
      // "close the ticket again"), and worse, the header taught narrowing as the
      // way out of a rule B false positive — pointing authors at the one shape
      // the scan could not see. Renders that genuinely prescribe nothing carry
      // an explicit marker instead, which is auditable and counted.
      stampAliases.add(name);
    });
  }

  // SECOND PRE-PASS: locals that derive PROSE from a recovery class. The class
  // itself may never reach a template — `cls` picks a sentence, the sentence is
  // rendered — so following only the class misses the render by one hop. A
  // local initialised from an expression that both mentions a recovery alias
  // and contains a string literal is choosing wording off the class, which is
  // precisely what the helper exists to own.
  //
  // NOT gated on the derived value's TYPE. An earlier version required a string
  // literal in the initialiser, reasoning that "a boolean has no wording to
  // drift" — true of the VALUE and false of the STATEMENT, the identical error
  // as `.step` carrying no advice while the prose around it does. It let this
  // through in three lines:
  //
  //   const { recovery } = ticket.verifyHold;
  //   const isSpec = recovery === 'spec';
  //   reply(isSpec ? 'reject and refile' : 'close the ticket again');
  //
  // Those two literals are hand-written advice selected on the class, and they
  // do not move when HOLD_RECOVERY's wording does — the exact drift this file
  // exists to prevent. So the carve-out is DELETED rather than narrowed: every
  // local derived from the class is tracked, and the discrimination happens at
  // the USE, which is this rule's whole premise. Control flow passes, renders
  // flag, boolean or not.
  const classDerived = new Set();
  const derivedBindingLines = new Set();
  if (recoveryAliases.size) {
    let block = false;
    lines.forEach((raw, i) => {
      const t = raw.trim();
      const isCmt = block || t.startsWith('//') || t.startsWith('*');
      if (t.startsWith('/*')) block = true;
      if (t.includes('*/')) block = false;
      if (isCmt) return;
      const bound = raw.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/);
      if (!bound) return;
      const [, name, rhs] = bound;
      const stmt = statementText(i);
      if (/holdRecoveryText\s*\(/.test(stmt)) return;
      if (![...recoveryAliases].some((n) => new RegExp(`\\b${n}\\b`).test(rhs))) return;
      // What the local CARRIES decides whether it is tracked, and the test is
      // the same one applied everywhere else here: does it hold PROSE.
      //
      //   const advice = cls === 'spec' ? 'reject' : 'close again'   → tracked
      //   const isSpec = cls === 'spec'                              → tracked
      //   const id     = recovery ? ticket.id : null                 → NOT
      //
      // The third is the one that matters. Tracking any local that merely
      // mentions the class made every later render of a common name like `id` a
      // violation — 45 on the real file, a scanner nobody can use. So a local
      // carrying DATA off another object is not advice; a comparison against
      // the class is, because the boolean it yields exists to pick a sentence,
      // and where it actually goes is judged at the USE.
      const comparesClass = [...recoveryAliases].some(
        (n) => new RegExp(`\\b${n}\\b\\s*[=!]==?`).test(rhs));
      const carriesLiteral = /[`'"]/.test(rhs) && !/\b[A-Za-z_$][\w$]*\.[A-Za-z_$]/.test(rhs);
      if (!comparesClass && !carriesLiteral) return;
      classDerived.add(name);
      // Reported at the RENDER, never here: a binding is harmless until
      // something prescribes off it, and flagging both points the reader at the
      // assignment first. Same reason the recovery binding itself is skipped.
      derivedBindingLines.add(i);
    });
  }

  // TWO render shapes, and missing the second is how the narrowed defect first
  // slipped past this rule: `${name}` inside a literal, and `\`…\` + name`
  // concatenated onto one. The historical sweep sentence is written the second
  // way, so an interpolation-only test reads the exact defect as clean.
  //
  // THIRD shape: the value SELECTS between prose literals (`x ? 'a' : 'b'`).
  // The name never enters a template, so interpolation and concatenation both
  // miss it — yet the sentence the reader receives is chosen right there. This
  // is what a boolean derived from the class actually does, and why type is the
  // wrong thing to discriminate on.
  const aliasRendered = (raw, names) => [...names].some((n) => {
    const interpolated = new RegExp(`\\$\\{[^}]*\\b${n}\\b`).test(raw);
    const concatenated = new RegExp('[`\'"][^`\'"]*[`\'"]\\s*\\+[^;]*\\b' + n + '\\b').test(raw)
      || new RegExp(`\\b${n}\\b\\s*\\+\\s*[\`'"]`).test(raw);
    const selectsProse = new RegExp(`\\b${n}\\b[^;?]*\\?\\s*[\`'"]`).test(raw);
    return interpolated || concatenated || selectsProse;
  });

  // The exemption must sit in the contiguous comment run IMMEDIATELY above the
  // render it excuses — not merely somewhere in the statement. Matched against
  // the whole statement, one marker covered every branch of the ternary it sat
  // in, so a sibling branch could render the field unflagged under a
  // justification written about its neighbour. An exemption that silently grows
  // to cover lines nobody wrote it for is the audit trail failing open.
  const markedAbove = (idx) => {
    for (let k = idx - 1; k >= 0; k--) {
      const t = lines[k].trim();
      if (!t) return false;
      if (!t.startsWith('//') && !t.startsWith('*')) return false;
      if (t.includes('prescribes-nothing')) return true;
    }
    return false;
  };

  lines.forEach((raw, i) => {
    const comment = isCommentLine(raw);
    if (comment) return;
    const stmt = statementText(i);
    const helper = /holdRecoveryText\s*\(/.test(stmt);
    const exempt = markedAbove(i);

    // Rule A, alias arm — a bound `recovery` class RENDERED into prose, under
    // any name and at any binding depth. Not merely mentioned: a bound class
    // that only routes is legitimate, for the reason the whole design rests on.
    //
    // A line that BINDS a derived local is skipped here too: selecting prose in
    // an initialiser is reported once, at the render that delivers it. Both
    // lines are the same violation, and naming the assignment first sends the
    // reader to the harmless half.
    if (!helper && !exempt && !derivedBindingLines.has(i)
      && aliasRendered(raw, recoveryAliases)) {
      violations.push({ line: i + 1, rule: 'A', text: raw.trim() });
      return;
    }
    // A class read INDIRECTLY rendered: bound, turned into a sentence on another
    // local, and that local rendered. One hop is what the reviewer's case does
    // (`cls` → `advice` → reply), and it is the shape three rounds of patches
    // kept reappearing as. Tracked by following any local whose initialiser
    // branches on a recovery alias — the prose is chosen THERE, so that local
    // carries the advice even though the class never reaches the template.
    if (!helper && !exempt
      && !derivedBindingLines.has(i) && aliasRendered(raw, classDerived)) {
      violations.push({ line: i + 1, rule: 'A', text: raw.trim() });
      return;
    }
    // Rule B, alias arm — the stamp, or a fact off it, rendered under a local.
    //
    // The marker is the ONLY way out, and it is deliberately not a regex the
    // rule can be widened into: an author must write the words on the line and
    // say why, and the subject below pins how many exist, so one appearing
    // silently fails. That is the difference between an audited exception and a
    // rule quietly relaxed until it means nothing.
    // Matched on the STATEMENT so the justification can sit in a comment above
    // the render rather than crammed onto it — the exemptions worth granting are
    // the ones that need a paragraph of why.
    if (!helper && !exempt && aliasRendered(raw, stampAliases)) {
      violations.push({ line: i + 1, rule: 'B', text: raw.trim() });
      return;
    }
    if (!raw.includes('verifyHold')) return;

    // Rule A, direct arm — the class read and RENDERED in one statement.
    //
    // NOT every read. An earlier premise said "any read of `recovery`, however
    // bound, unless the helper is called", and that was wrong in a way rule B
    // already had right. Rule B flags RENDERS, not reads; rule A must too,
    // because the class exists precisely to be branched on — `_taskRespec`
    // picks a ROUTE off `recovery !== 'spec'`, and that usage is the reason the
    // stamp carries a class rather than rendered prose at all.
    //
    // The false positive was not cosmetic: it fired on the legitimate route read
    // and the quietest way out was to bind the class to a local, which is
    // exactly the blind spot the alias arm above had to be built to catch. A
    // rule that punishes the correct usage pumps authors into its own hole, so
    // fixing the premise closes the hole and the pump together.
    if (/verifyHold(\s*&&\s*[A-Za-z_.\s]*)?\.recovery/.test(raw) && !helper
      && !exempt
      && (/\$\{[^}]*verifyHold(\s*&&\s*[A-Za-z_.\s]*)?\.recovery/.test(raw)
        || /[`'"][^`'"]*[`'"]\s*\+[^;]*\.recovery\b/.test(raw)
        || /\.recovery\b[^;]*\?\s*[`'"]/.test(raw))) {
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

test('RED: `let` and `var` bindings are caught too, not just `const`', () => {
  // Cheap to get wrong: the pre-pass matches a declaration keyword, and a
  // pattern written for `const` alone would leave two spellings of the same
  // evasion open.
  ['let', 'var'].forEach((kw) => {
    const mutant = [
      `${kw} hold = ticket.verifyHold;`,
      'reply(`held at "${hold.step}" — close the ticket again`);',
    ].join('\n');
    const v = scanHoldRecovery(mutant);
    assert.strictEqual(v.length, 1, `ENTER: the ${kw} binding produced a violation`);
    assert.strictEqual(v[0].rule, 'B', `${kw} is caught by rule B like const`);
  });
});

test('RED: THE NARROWED HISTORICAL DEFECT — a fact binding plus hand-written advice', () => {
  // The r1 hole, and the reason this file was rejected a second time. r1 exempted
  // a binding narrowed to `.step`, reasoning that the field "carries no advice".
  // True of the FIELD, false of the STATEMENT: the advice is the prose an author
  // writes around it. So the t345 defect walked straight through in narrowed
  // form — and the header TAUGHT narrowing as the way out of a rule B false
  // positive, pointing authors at the one shape the scan could not see.
  //
  // This is the sweep sentence t345 removed, one `const` away from the direct
  // form the subject above catches. It must never pass again.
  const mutant = [
    'const step = t.verifyHold.step;',
    'body += `\\n\\nRECOVERY: fix what the check named, then close the ticket again.` + step;',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: the narrowed defect is caught');
  assert.strictEqual(v[0].rule, 'B', 'by rule B — a fact render is governed exactly like the stamp');
  assert.strictEqual(v[0].line, 2, 'at the render, which is where the advice is written');
});

test('RED: narrowing to a fact does not launder a close instruction', () => {
  // The second shape the lead measured, and the one an author reaches for first:
  // bind the step, then write the sentence rule B would have caught inline.
  const mutant = [
    'const heldAt = ticket.verifyHold.step;',
    'reply(`held at "${heldAt}" — close the ticket again to re-run the checks`);',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: caught');
  assert.strictEqual(v[0].rule, 'B', 'the narrowed form is not a way out');
});

test('GREEN: a fact render that prescribes nothing takes an AUDITED exemption', () => {
  // The genuine false positive (`:4605`): it names the check that HAD held the
  // ticket, to the seat that just cleared it, after the stamp is gone. A receipt,
  // not advice — and its step-naming is pinned by an accepted t345 subject, so it
  // cannot be dropped, while routing it through the helper would tell a seat to
  // perform the action it has this moment performed.
  //
  // The marker is a WRITTEN CLAIM, not a pattern the rule can be widened into,
  // and the count of them is asserted below — so one appearing silently fails.
  const ok = [
    'const heldAt = (ticket.verifyHold && ticket.verifyHold.step) || null;',
    '// prescribes-nothing: a receipt to the seat that just cleared the hold.',
    'reply(`re-verifying (was held at "${heldAt}")`);',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [], 'an audited exemption is honoured');
});

test('RED: one marker does not excuse a SIBLING branch of the same statement', () => {
  // The exemption was matched against the whole statement, so the marker on the
  // re-entry branch also covered the ordinary-close branch beside it — where
  // `heldAt` is null and would render "null" unflagged, under a justification
  // written about its neighbour. An exemption that grows to cover lines nobody
  // wrote it for is the audit trail failing open.
  const mutant = [
    'const heldAt = (ticket.verifyHold && ticket.verifyHold.step) || null;',
    'reply((reentry',
    '  // prescribes-nothing: a receipt to the seat that just cleared the hold.',
    '  ? `re-verifying (was held at "${heldAt}")`',
    '  : `closed (done) — was held at "${heldAt}"`) + suffix);',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: exactly the unexcused branch is caught');
  assert.strictEqual(v[0].line, 5, 'the SIBLING branch, not the one the marker was written for');
  assert.match(v[0].text, /closed \(done\)/, 'and it is the ordinary-close render');
});

test('the exemption cannot be spent silently — every marker in the source is counted', () => {
  // An escape hatch nobody counts is a rule that decays one honest-looking
  // comment at a time. ONE exemption exists today; a second must be argued for
  // in review rather than appear in a diff nobody reads.
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
  const marked = src.split('\n')
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter(({ text }) => text.includes('prescribes-nothing'));
  assert.strictEqual(marked.length, 1,
    `exactly one audited exemption is expected (found ${marked.length}: ${marked.map((m) => m.line).join(', ')})`);
  assert.match(marked[0].text, /^\/\//, 'and it is a written justification, not code');
});

// ── the RULE A PREMISE (r3 must-fix) ───────────────────────────────────────
//
// r3 was rejected for a hole with a deeper cause than the hole itself. Rule A's
// premise was "any read of `recovery`, however bound, unless the helper is
// called" — but the class exists TO BE BRANCHED ON, which is the reason Q1
// ruled out stamping rendered prose. So rule A fired on the legitimate route
// read, and the quietest way to silence it was to bind the class to a local,
// landing the author in the arm that could not see bound reads.
//
// Third instance of one composition in this file: r1 alias defeats a line-local
// rule, r2 narrowing defeats an object-only rule, r3 binding defeats a
// token-based rule. Patching the arm leaves the pump running. The premise is
// the fix: rule A flags RENDERS, exactly as rule B does.

test('RED: a bound class turned into a sentence, then rendered, is caught', () => {
  // The reviewer's case, and the shape the composition kept producing: the class
  // never reaches the template — it picks the wording one hop earlier.
  const mutant = [
    'const cls = ticket.verifyHold.recovery;',
    "const advice = cls === 'spec' ? 'reject and refile' : 'close the ticket again';",
    'reply(`held — ${advice}`);',
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: the indirect render is caught');
  assert.strictEqual(v[0].rule, 'A', 'rule A — the class chose the prose');
  assert.strictEqual(v[0].line, 3, 'reported at the render');
});

test('RED: a bound class rendered directly is caught at any binding depth', () => {
  const mutant = [
    'const cls = ticket.verifyHold.recovery;',
    "reply(`do this: ${cls === 'spec' ? 'edit the spec' : 'close it again'}`);",
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: caught');
  assert.strictEqual(v[0].rule, 'A', 'binding is not a way out');
});

test('GREEN: a pure ROUTE read passes — direct, and this is what stops the pump', () => {
  // The false positive that CAUSED the hole. `_taskRespec` reads the class to
  // pick a route and renders nothing; flagging it taught authors to bind, which
  // is the blind spot. This direction matters as much as the RED ones.
  const ok = [
    "if (ticket.verifyHold.recovery !== 'spec') { this._deliverSpec(team, ticket); return; }",
    "const needsRespec = ticket.verifyHold.recovery === 'spec';",
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [],
    'the class exists to be branched on — reading it to choose a ROUTE is the design, not a violation');
});

test('GREEN: a pure ROUTE read passes when bound to a local too', () => {
  const ok = [
    'const rec = ticket.verifyHold.recovery;',
    "if (rec !== 'spec') { this._deliverSpec(team, ticket); return; }",
    "const isSpec = rec === 'spec';",
    'if (isSpec) return;',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [],
    'comparing is routing: these reads reach control flow only, and a value that never '
    + 'meets prose cannot disagree with HOLD_RECOVERY. NOT because it is a boolean — a '
    + 'boolean that SELECTS between advice literals is a render, and flags.');
});

test('RED: a boolean derived from the class, SELECTING advice literals, is caught', () => {
  // The r3 carve-out, and the fourth instance of this file's recurring shape —
  // this time inside an exemption written in the same commit that fixed the
  // previous one. The scanner required a string literal in the initialiser,
  // reasoning that a boolean "has no wording to drift": true of the VALUE,
  // false of the STATEMENT, identical to `.step` carrying no advice while the
  // prose around it does.
  //
  // These two literals are hand-written advice chosen on the class, and they do
  // not move when HOLD_RECOVERY's wording does. Three lines to the drift this
  // whole file exists to prevent.
  const mutant = [
    'const { recovery } = ticket.verifyHold;',
    "const isSpec = recovery === 'spec';",
    "reply(isSpec ? 'reject and refile' : 'close the ticket again');",
  ].join('\n');
  const v = scanHoldRecovery(mutant);
  assert.strictEqual(v.length, 1, 'ENTER: caught exactly once');
  assert.strictEqual(v[0].rule, 'A', 'rule A — the class selected the prose');
  assert.strictEqual(v[0].line, 3, 'at the render, not the comparison');
});

test('GREEN: a local carrying DATA off the class does not become advice', () => {
  // Found by mutating the real file rather than by reasoning. The first fix for
  // the boolean hole tracked every local whose statement mentioned the class,
  // which swept up `const id = recovery ? ticket.id : null` — and from then on
  // EVERY later render of a common name like `id` was a violation: 45 of them
  // on team-tickets.js, a scanner nobody could use and everybody would delete.
  //
  // The discriminator is what the local CARRIES. A comparison against the class
  // yields a value that exists to pick a sentence; a field off another object
  // is data, and rendering the ticket id prescribes nothing.
  const ok = [
    'const { recovery } = ticket.verifyHold;',
    'const id = recovery ? ticket.id : null;',
    'reply(`close with ${ticketCloseVerb(id)}`);',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [],
    'a data-carrying local is not advice — tracking it makes the rule unusable');
});

test('GREEN: the same boolean used only for CONTROL FLOW still passes', () => {
  // The other half, and the reason the fix DELETES a special case rather than
  // adding one: discrimination happens at the USE, which is rule A's premise.
  // A class-derived value that reaches only `if`/`return` prescribes nothing.
  const ok = [
    'const { recovery } = ticket.verifyHold;',
    "const isSpec = recovery === 'spec';",
    'if (isSpec) return this._respecRoute(ticket);',
  ].join('\n');
  assert.deepStrictEqual(scanHoldRecovery(ok), [],
    'routing on the class is the design — it is why a class is stamped rather than prose');
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
  const readers = src.split('\n').filter((l) => /\$\{[^}]*verifyHold/.test(l) && !COMMENT_LINE.test(l));
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
  //
  // SCOPED TO NON-TEST SOURCE. Pinning an exact list that included test files
  // meant any unrelated test merely MENTIONING the field failed here, with a
  // message about exporting `holdRecoveryText` — the wrong diagnosis, and the
  // kind of false alarm that gets a subject deleted rather than fixed. Tests
  // are not readers: they cannot mislead a seat.
  const root = path.join(__dirname, '..');
  const skip = new Set(['node_modules', '.git', 'dist', 'out', 'tasks', 'test']);
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
  assert.deepStrictEqual(found.sort(), ['team-tickets.js'],
    'a new reader outside team-tickets.js cannot reach holdRecoveryText — export it deliberately, then widen this scan');
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

// ── the phrase scan — a SECOND scanner, on the opposite axis ────────────────
//
// Everything above asks "did a class-derived value reach prose?", which means
// following values through JS with regex. Five rework rounds produced five
// levels of one composition, each fix correct and the shape reappearing one
// level up; its blind spot grows with every JS idiom (§4 of the journal lists
// the shapes it still passes — dotted boolean, switch arm, object map, two-hop,
// function-returned advice).
//
// This scanner asks the inverted question — "does a canonical advice phrase
// appear OUTSIDE the table?" — and never tracks a value at all, so all five of
// those levels collapse to one shape it sees.
//
// BOTH SCANNERS STAY. They fail on DISJOINT cases, which is the whole reason
// this is an addition and not a replacement:
//   - the phrase scan catches the five taint-scan holes (pinned below);
//   - the taint scan catches the one thing the phrase scan cannot — the table
//     REWORDED WHOLESALE while a stale copy survives elsewhere, where the copy
//     shares no n-gram with the new text (pinned below, both directions).
// Deleting either one silently gives up a class of defect the other never saw.
//
// DELIBERATE BOUNDARY, on the record rather than as an oversight: a fresh
// PARAPHRASE of the advice is NOT caught. That is the lesser failure and it is
// accepted. The t345 defect was COPIED wording that later went stale — a copy
// matches the table today, so this scan catches exactly the drift the ticket
// exists to prevent. A paraphrase written from scratch is wrong immediately and
// visibly to its reader, not silently divergent from a table it never quoted.
// The blind spot is also CONSTANT, where the taint scan's grows with each idiom.
//
// SECOND DELIBERATE BOUNDARY, same standing: the scan is LINE-LOCAL. A copied
// arm wrapped so that no single line carries PHRASE_N consecutive advice words
// is invisible to it. Joining the file into one string instead would bridge
// unrelated statements and manufacture false positives on a rule whose entire
// value is that authors trust it. Recorded here so the next reader finds it as
// a known boundary rather than rediscovering it as a hole.

const PHRASE_N = 5;

// ONE definition each, used by every reader below. This file's whole subject is
// two readers of one fact drifting apart; two byte-identical copies of a regex
// agree only until someone edits one. Divergence is made impossible, not merely
// absent.
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
// Honours \` : the spec arm contains an escaped backtick (\`tasks/…\` line
// first), and a naive /`[^`]*`/ terminates there, yielding NO grams for that
// sentence — a copy of it would be invisible. Pinned by its own ENTER below.
// NOTE: "…" literals are deliberately NOT matched, and the ENTER asserts no arm
// uses them, so the limitation is enforced rather than advisory.
const TABLE_LITERAL = /`(?:[^`\\]|\\.)*`|'[^'\\]*(?:\\.[^'\\]*)*'/g;

// The one place grams are built. Shared so the advice set and the comment set
// below are produced by identical code — a comparison between two sets built by
// two copies of a builder would prove nothing about the builder.
function gramsFromText(text, N = PHRASE_N) {
  const grams = new Set();
  for (const lit of text.match(TABLE_LITERAL) || []) {
    for (const seg of lit.slice(1, -1).split(/\$\{[^}]*\}/)) {
      const w = adviceWords(seg);
      for (let i = 0; i + N <= w.length; i++) grams.add(w.slice(i, i + N).join(' '));
    }
  }
  return grams;
}

// The table's own text is the source of truth. Hardcoding phrases would go
// stale the moment an arm is edited — which is precisely the drift this file
// exists to prevent, reintroduced in the enforcement mechanism itself.
function holdRecoveryTableRange(lines) {
  const start = lines.findIndex((l) => l.includes('const HOLD_RECOVERY = {'));
  if (start < 0) return null;
  for (let i = start; i < lines.length; i++) if (lines[i] === '};') return { start, end: i };
  return null;
}

const adviceWords = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

// ASYMMETRIC, and this is the subtle part — pinned by its own subject below.
// DERIVATION blanks `${…}` interiors AND SPLITS there: the arms embed
// `${ticketCloseVerb(id)}`, so a gram bridging a hole would encode one caller's
// substitution as if it were fixed wording.
function deriveAdviceGrams(src, N = PHRASE_N) {
  const lines = src.split('\n');
  const range = holdRecoveryTableRange(lines);
  const grams = new Set();
  if (!range) return grams;
  // COMMENT LINES ARE STRIPPED, mirroring the scan side. Measured: keeping them
  // yielded 180 grams of which only 68 came from the arms — 62% was comment
  // prose, because the single-quote alternative runs across newlines from any
  // apostrophe in a comment. Appending one `doesn't` to the comment above the
  // hand arm took the set 180 -> 129 and DELETED THE WHOLE INFRA ARM, while a
  // `grams.size > 100` guard stayed green — a guard surviving the loss of what
  // it guards, which is this file's own defect class rebuilt in its enforcement.
  const table = lines.slice(range.start, range.end + 1)
    .filter((l) => !COMMENT_LINE.test(l)).join('\n');
  for (const g of gramsFromText(table, N)) grams.add(g);
  return grams;
}

// The comment lines of the same span, built by the SAME builder. Not advice —
// this set exists only to be asserted ABSENT from the advice set.
function deriveTableCommentGrams(src, N = PHRASE_N) {
  const lines = src.split('\n');
  const range = holdRecoveryTableRange(lines);
  if (!range) return new Set();
  return gramsFromText(lines.slice(range.start, range.end + 1)
    .filter((l) => COMMENT_LINE.test(l)).join('\n'), N);
}

// SCANNING does NOT blank `${…}` — advice can be written inside a template
// hole, and blanking both sides makes a direct render falsely PASS.
function scanAdvicePhrases(src, N = PHRASE_N) {
  const lines = src.split('\n');
  const range = holdRecoveryTableRange(lines);
  const grams = deriveAdviceGrams(src, N);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (range && i >= range.start && i <= range.end) continue;  // the table is the original, not a copy
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;  // comments quote the advice deliberately, at length
    const w = adviceWords(line);
    for (let j = 0; j + N <= w.length; j++) {
      const g = w.slice(j, j + N).join(' ');
      if (grams.has(g)) { hits.push({ line: i + 1, gram: g, text: line.trim() }); break; }
    }
  }
  return hits;
}

const realSource = () => fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf8');
// Fixtures carry the REAL table, so a "copied arm" below is genuinely the
// shipping wording rather than a phrase invented to match a scanner.
const withRealTable = (bodyLines) => {
  const lines = realSource().split('\n');
  const { start, end } = holdRecoveryTableRange(lines);
  return lines.slice(start, end + 1).concat(bodyLines).join('\n');
};
const COPIED_HAND = 'Fix what the check named, then close the ticket again.';
const COPIED_SPEC = 'Re-closing alone will NOT help: the check re-reads the same spec and fails identically.';

test('ENTER: the phrase scan derives real grams from the real table', () => {
  // A scanner with an empty gram set is green on every file forever — the
  // false-green this whole file was written against. Assert the derivation
  // reached the table before any subject below trusts a zero from it.
  const grams = deriveAdviceGrams(realSource());
  // PER-ARM, not a threshold. A count cannot detect a PARTIALLY derived set:
  // losing one arm entirely left 129 grams, which any round-number threshold
  // happily passes. Each arm is asserted by its own gram, so losing any one of
  // the three goes red naming which.
  assert.ok(grams.has('fix what the check named'), 'ENTER: the hand arm');
  assert.ok(grams.has('re closing alone will not'), 'ENTER: the spec arm');
  assert.ok(grams.has('this is not something the'), 'ENTER: the infra arm');
  // MUST-FIX: the escaped-backtick sentence. Reverting the \` handling takes the
  // set 73 -> 68 as a STRICT SUBSET, so every other guard here — all three arms,
  // the band, all four N=4 grams — still passes and the revert is silent. This
  // recovered sentence IS that entire 68 -> 73, and it is the one thing that
  // goes red on it. It is also what a trailing apostrophe-bearing comment on the
  // spec arm's line would swallow, leaving the first-sentence grams intact.
  assert.ok(grams.has('correct the spec s tasks'),
    "ENTER: the spec arm's ESCAPED-BACKTICK sentence — the whole reason TABLE_LITERAL honours \\`");
  // THE INVARIANT ITSELF: no comment prose is in the advice set. The band below
  // is a proxy for this and drifts with arm count; this states it directly and
  // also catches a residual from a trailing comment on an arm line.
  const commentGrams = deriveTableCommentGrams(realSource());
  assert.ok(commentGrams.size > 0,
    `ENTER: the table's comments really were gram-bearing (got ${commentGrams.size})`);
  const leaked = [...commentGrams].filter((g) => grams.has(g));
  // Two causes, and the next reader must not be sent after only the first: a
  // table comment that quotes an arm verbatim (>= PHRASE_N words) intersects
  // legitimately and is not the r5 defect.
  assert.deepStrictEqual(leaked, [],
    'either comment prose leaked into the derivation, or a table comment now quotes an arm verbatim; check which');
  // Loose sanity only, no longer the guard.
  assert.ok(grams.size > 40 && grams.size < 120,
    `ENTER: advice-only gram count (${grams.size})`);
  // NIT 4: the span must be the table, not the rest of the file. `};` is matched
  // exactly, so a reformat of the closing brace would silently widen or narrow
  // this; fail loudly instead.
  const lines = realSource().split('\n');
  const range = holdRecoveryTableRange(lines);
  assert.ok(range && range.end - range.start < 40,
    `ENTER: the span is the table itself (got ${range ? range.end - range.start : 'none'} lines)`);
  // The "…" limitation, enforced rather than advisory. Matching only the HEAD
  // literal (`: (id) => "`) was too narrow: the arms are multi-line
  // concatenations, so a rewritten CONTINUATION (`+ "That re-runs…"`) yields zero
  // grams and passes the head check, the per-arm ENTERs (all keyed on
  // first-line grams) and the band (73 minus one continuation is still inside
  // it). Assert over the whole non-comment span instead.
  //
  // Comment lines are filtered because two of them legitimately carry a double
  // quote (`team-tickets.js` "correcting the record of a closed ticket…"), and
  // a comment contributes no grams either way.
  assert.ok(!/"/.test(lines.slice(range.start, range.end + 1)
    .filter((l) => !COMMENT_LINE.test(l)).join('\n')),
  'an arm uses a "…" literal, which TABLE_LITERAL does not match — add the alternative');
  // No gram may bridge an interpolation: `${ticketCloseVerb(id)}` renders to a
  // per-caller string, so a gram spanning it would pin one caller's output.
  assert.ok(![...grams].some((g) => g.includes('ticketclosverb') || g.includes('ticketcloseverb')),
    'no gram carries an interpolation interior');
});

for (const [shape, body] of [
  // The five shapes §4 of the journal measured the taint scan PASSING. Each
  // renders a copied arm; the phrase scan sees all five as one shape.
  ['the dotted boolean one-liner', [
    "const isSpec = ticket.verifyHold.recovery === 'spec';",
    `reply(isSpec ? '${COPIED_SPEC}' : '${COPIED_HAND}');`,
  ]],
  ['a switch arm', [
    'switch (cls) {',
    `  case 'spec': reply('${COPIED_SPEC}'); break;`,
    `  default: reply('${COPIED_HAND}');`,
    '}',
  ]],
  ['an object map — HOLD_RECOVERY\'s own shape, copied into a local', [
    `const ADVICE = { spec: '${COPIED_SPEC}', hand: '${COPIED_HAND}' };`,
    'reply(ADVICE[cls]);',
  ]],
  ['two-hop prose', [
    `const first = '${COPIED_HAND}';`,
    'const second = first;',
    'reply(second);',
  ]],
  ['advice returned from a function', [
    `function adviceFor(cls) { return '${COPIED_HAND}'; }`,
    'reply(adviceFor(cls));',
  ]],
]) {
  test(`RED: the phrase scan catches ${shape}`, () => {
    const hits = scanAdvicePhrases(withRealTable(body));
    assert.ok(hits.length >= 1,
      `a copied arm rendered as ${shape} must be caught (got ${hits.length})`);
    // `scanAdvicePhrases` derives its grams from the SAME string in the same
    // tick, so re-deriving from that string and asking `has` is `grams.has(g)`
    // asked twice — true by construction for any non-empty hits. These two bite
    // in different directions: the gram must come from the REAL table (not a
    // fixture whose range drifted), and the hit must land on the copied render
    // (not on scaffolding).
    // Not a tautology (different input strings), but narrower than it reads:
    // `withRealTable` slices with the same `holdRecoveryTableRange`, so fixture
    // and real table are byte-identical and drift together. It bites on exactly
    // one class — a fixture builder that stops carrying the real wording.
    assert.ok(deriveAdviceGrams(realSource()).has(hits[0].gram),
      'ENTER: the gram comes from the REAL table, not a fixture whose range drifted'
      + " — this guards the FIXTURE's provenance, not the scanner");
    // The fixture is table + body only and the scan already skips the table
    // range and comment lines, so "it is a body line" is true of every possible
    // hit — it could not discriminate the render from the sibling
    // `const isSpec = …`. Assert the copied SENTENCE itself.
    assert.ok(hits[0].text.includes(COPIED_HAND) || hits[0].text.includes(COPIED_SPEC),
      'the hit is on the copied sentence itself');
  });
}

test('RED: advice written INSIDE a template hole is caught — the derivation/scan asymmetry', () => {
  // The harness bug this pins: blanking `${…}` on BOTH sides is the natural
  // symmetric implementation and it makes this render falsely PASS, because the
  // whole sentence lives inside the hole. Derivation blanks; scanning must not.
  const body = [
    'reply(`the ticket is held ${cls === \'spec\' ? \'' + COPIED_SPEC + '\' : \'\'}`);',
  ];
  const hits = scanAdvicePhrases(withRealTable(body));
  assert.strictEqual(hits.length, 1, 'advice inside an interpolation is still a render');
});

for (const [shape, body] of [
  ['a route read that reaches control flow only', [
    "if (ticket.verifyHold.recovery !== 'spec') { return this._routeToHand(ticket); }",
  ]],
  ['an inline helper render', [
    'reply(`it is held at "${ticket.verifyHold.step}". ${holdRecoveryText(ticket.verifyHold.recovery, id)}`);',
  ]],
  ['a presence read with unconditioned advice', [
    'const held = !!ticket.verifyHold;',
    "reply(held ? 'it is held' : 'it is open');",
  ]],
]) {
  test(`GREEN: the phrase scan passes ${shape}`, () => {
    assert.deepStrictEqual(scanAdvicePhrases(withRealTable(body)), [],
      'legitimate usage must not be flagged — a rule that punishes correct code pumps authors into its blind spot');
  });
}

test('GREEN: the real file has zero advice phrases outside HOLD_RECOVERY', () => {
  const src = realSource();
  // ENTER: the scan reached a real body, not an empty one after the exclusions.
  const scanned = src.split('\n').filter((l) => !COMMENT_LINE.test(l));
  assert.ok(scanned.length > 3000, `ENTER: a real body was scanned (got ${scanned.length} lines)`);
  assert.deepStrictEqual(scanAdvicePhrases(src), [],
    'an advice phrase appears outside the table — a copied arm that will go stale when the table moves');
});

test('N=5 is the measured floor: at N=4 the real file yields four false positives', () => {
  // Anyone lowering N sees the cost here rather than discovering it as four
  // failures on an unrelated file. All four are ordinary ticket prose that
  // legitimately shares four words with an arm; none is a copied sentence.
  //
  // Identified by GRAM rather than line number — line numbers drift, and these
  // four moved by 26 lines between master and this branch while the statements
  // did not change at all:
  //   "re reads the same"      — the in-verify refusal
  //   "close the ticket again" — the failed-checks close instruction
  //   "and no rework round"    — the not-rejected notice
  //   "check could not run"    — the merge-check failure
  const src = realSource();
  const at4 = scanAdvicePhrases(src, 4);
  assert.strictEqual(at4.length, 4, `ENTER: the measured N=4 cost (got ${at4.length})`);
  assert.deepStrictEqual(at4.map((h) => h.gram).sort(), [
    'and no rework round', 'check could not run', 'close the ticket again', 're reads the same',
  ], 'the four N=4 false positives are ordinary prose sharing four words with an arm');
  assert.deepStrictEqual(scanAdvicePhrases(src, PHRASE_N), [], 'and N=5 clears them');
});

test('the two scanners are DISJOINT: the taint scan catches a wholesale reword the phrase scan cannot', () => {
  // The measured reason both survive. Reword every arm so the new table shares
  // no 5-gram with the old, and leave a stale copy of the OLD wording rendered
  // off the class. The phrase scan derives from the NEW table and sees nothing;
  // the taint scan sees a class-derived value selecting advice literals.
  //
  // This is the case that makes the phrase scan insufficient ALONE, and it is
  // not hypothetical — rewording an arm is the ordinary way this table changes.
  const reworded = [
    'const HOLD_RECOVERY = {',
    "  hand: (id) => `Amend the branch where it was faulted, then resubmit via ${ticketCloseVerb(id)}.`,",
    "  spec: (id) => `Editing the written brief is mandatory first; resubmission by itself repeats the outcome.`,",
    "  infra: (id) => `No branch action applies here; the machinery itself refused to execute.`,",
    '};',
    "const cls = ticket.verifyHold.recovery;",
    `reply(cls === 'spec' ? '${COPIED_SPEC}' : '${COPIED_HAND}');`,
  ].join('\n');
  // The blindness must come from the REWORD, not from an empty gram set — an
  // empty set makes the scan vacuously blind to everything and the claim
  // meaningless.
  assert.ok(deriveAdviceGrams(reworded).size > 0,
    'ENTER: the reworded table still yields grams, so the blindness is real');
  assert.deepStrictEqual(scanAdvicePhrases(reworded), [],
    'ENTER: the phrase scan is blind here — the stale copy shares no gram with the reworded table');
  const caught = scanHoldRecovery(reworded);
  assert.strictEqual(caught.length, 1, `the taint scan catches it (got ${caught.length})`);
  assert.strictEqual(caught[0].line, 7, 'on the render line, not the read');
  assert.match(caught[0].rule, /^[AB]$/, 'under a named rule, which is why deleting it gives up a real class');
});

test('the two scanners are DISJOINT the other way: the phrase scan catches what the taint scan passes', () => {
  // The converse, measured on the shape the journal recorded as a LIVE hole in
  // the taint scan: the dotted boolean one-liner. Its bound and destructured
  // siblings flag; this form does not. Adding a sixth taint arm for it is the
  // move that failed five times — the phrase scan covers it on the other axis.
  const body = [
    "const isSpec = ticket.verifyHold.recovery === 'spec';",
    `reply(isSpec ? '${COPIED_SPEC}' : '${COPIED_HAND}');`,
  ];
  const fixture = withRealTable(body);
  assert.deepStrictEqual(scanHoldRecovery(fixture), [],
    'ENTER: this is genuinely a taint-scan hole, not a shape it already covered');
  assert.ok(scanAdvicePhrases(fixture).length >= 1,
    'and the phrase scan closes it without a sixth taint arm');
});
