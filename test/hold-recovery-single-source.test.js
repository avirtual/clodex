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
//   any read of `recovery`, however bound    FLAG unless the helper is called
//   a render marked `prescribes-nothing`     PASS — written claim, and counted
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

  // TWO render shapes, and missing the second is how the narrowed defect first
  // slipped past this rule: `${name}` inside a literal, and `\`…\` + name`
  // concatenated onto one. The historical sweep sentence is written the second
  // way, so an interpolation-only test reads the exact defect as clean.
  const aliasRendered = (raw, names) => [...names].some((n) => {
    const interpolated = new RegExp(`\\$\\{[^}]*\\b${n}\\b`).test(raw);
    const concatenated = new RegExp('[`\'"][^`\'"]*[`\'"]\\s*\\+[^;]*\\b' + n + '\\b').test(raw)
      || new RegExp(`\\b${n}\\b\\s*\\+\\s*[\`'"]`).test(raw);
    return interpolated || concatenated;
  });

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
    if (!helper && !/prescribes-nothing/.test(stmt) && aliasRendered(raw, stampAliases)) {
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
