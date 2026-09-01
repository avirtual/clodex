'use strict';

// t309 §B: the constructed review scope. Every item the spec requires gets its
// own assertion, because the failure this pins is a scope that builds fine and
// silently omits one — a reviewer cannot report a section it was never given,
// so an omission surfaces as a confident review of the wrong thing.

const { test } = require('node:test');
const assert = require('node:assert');

const { buildReviewScope, VERDICT_GRAMMAR } = require('../ticket-review-scope');
const fsReal = require('node:fs');
const pathReal = require('node:path');

function ticket(over = {}) {
  return {
    id: 't42',
    state: 'done',
    spec: 'THE SPEC BODY: make the widget idempotent.',
    taskDir: '/home/u/.clodex/projects/p/tasks/widget',
    report: 'Changed widget.js. Suite green at 4999. I GUESSED the retry bound.',
    reportedBy: 'clodex-hand-42',
    worktree: {
      path: '/home/u/projects/repo-t42',
      branch: 't42-widget',
      baseSha: 'abc1234',
    },
    ...over,
  };
}

test('scope carries the ticket id, spec and task dir', () => {
  // t453: the task dir is PASSED, never read off the ticket. `ticket.taskDir` is
  // the raw spec string, and the reviewer's cwd is the repo — which carries a
  // stale `tasks/` with colliding names — so rendering it verbatim would send
  // the reviewer into a real but wrong tree. The caller resolves it first.
  const s = buildReviewScope({
    ticket: ticket(), diffPath: '/tmp/d.diff', taskDir: '/home/u/.clodex/projects/p/tasks/widget',
  });
  assert.match(s, /reviewing ticket t42\b/);
  assert.ok(s.includes('THE SPEC BODY: make the widget idempotent.'),
    'the spec body must appear verbatim');
  assert.ok(s.includes('/home/u/.clodex/projects/p/tasks/widget'),
    'the task dir must appear');
});

// The absence of a fallback is the SAFETY, so it is pinned rather than left to
// the caller's discipline. A scope that quietly reached for `ticket.taskDir`
// when the caller passed nothing would reintroduce the raw relative pointer on
// exactly the path that must not have it — a REFUSED resolution.
test('an unresolved task dir is omitted entirely — never read off the ticket record', () => {
  const t = ticket({ taskDir: 'tasks/../../../../etc/pwn' });
  const s = buildReviewScope({ ticket: t, diffPath: '/tmp/d.diff' });
  assert.ok(!/TASK DIR:/.test(s),
    'no task dir is named at all when the caller could not resolve one');
  assert.ok(!s.includes('tasks/../../../../etc/pwn'),
    'and the raw pointer is not rendered — the reviewer would resolve it against the repo');
  // ENTER: the rest of the scope must still be built, or this asserts an absence
  // over a scope that failed to render for some unrelated reason.
  assert.match(s, /reviewing ticket t42\b/, 'ENTER: the scope itself still rendered');
});

test('scope carries the worktree in the WORK IN: shape, with the branch', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  // The same shape _deliverTicketSpec uses — asserted literally, since the
  // point is that the hand and the reviewer are told about the tree identically.
  assert.ok(s.includes('WORK IN: /home/u/projects/repo-t42 (git worktree, branch t42-widget)'),
    'WORK IN: line must name the path and branch in the established shape');
});

test('scope names the base sha and the baseSha..HEAD range', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  assert.ok(s.includes('abc1234..HEAD'), 'the review range must be stated as baseSha..HEAD');
  assert.match(s, /base abc1234 is what the spec was written against/);
});

test('scope points at the materialized diff path', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/home/u/tasks/widget/review-t42.diff' });
  assert.ok(s.includes('/home/u/tasks/widget/review-t42.diff'),
    'the diff path must appear so the reviewer can read it');
});

test("the hand's report is carried VERBATIM and framed as the hand's own account", () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  assert.ok(s.includes('Changed widget.js. Suite green at 4999. I GUESSED the retry bound.'),
    'the report must be present byte-for-byte, not paraphrased');
  assert.ok(s.includes('clodex-hand-42'), 'the report must be attributed to its author');
  // The framing is load-bearing: the report is a claim to verify, and the
  // guessed/deviated/deferred pointer is the part unrecoverable from the diff.
  assert.match(s, /verbatim and unedited/);
  assert.match(s, /claim, not evidence/);
  assert.match(s, /guessed, deviated from the spec, assumed, or deferred/);
});

test('scope states the verdict grammar the parser is tuned to', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  assert.ok(s.includes(VERDICT_GRAMMAR), 'the full grammar block must be present');
  for (const kw of ['VERDICT', 'MUST-FIX', 'NITS', 'CHECKED']) {
    assert.ok(s.includes(kw), `grammar must name ${kw}`);
  }
  assert.match(s, /ACCEPT \| REWORK/);
});

test('the grammar names the intent that EMITS the verdict, not just its sections', () => {
  // Four perfect sections that are never emitted report to nobody and retire
  // nothing. This works today only because the role prompt carries the verb —
  // but the scope claims to be the authority on how to answer, it survives a
  // prompt edit, and an unbriefed reviewer (a reachable, warned-about state)
  // has nothing else to go on.
  assert.ok(VERDICT_GRAMMAR.includes('[agent:review-done]'),
    'the emit intent belongs to the grammar constant itself');
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  assert.ok(s.includes('[agent:review-done]'));
});

test('the emitted grammar is one _landVerdictOnTicket actually parses', () => {
  // Pins the two halves together: the scope tells the reviewer to write this
  // shape, and the shipped parser must accept what that instruction produces.
  // Divergence here is silent — a well-formed verdict that lands nowhere.
  const verdictRe = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*|__)?[ \t]*\bVERDICT\b\W*\b(ACCEPT|REWORK)\b/im;
  const sample = VERDICT_GRAMMAR.replace('ACCEPT | REWORK — one line, unambiguous.', 'ACCEPT');
  const m = verdictRe.exec(sample);
  assert.ok(m, 'the grammar line as instructed must match the shipped verdict regex');
  assert.strictEqual(m[1], 'ACCEPT');
});

test('the scope tells the reviewer the suite ALREADY RAN and was green', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  // PINNED BECAUSE IT ONCE DRIFTED INTO A LIE. This text used to say the loop
  // does not run the suite, and stayed that way after verify started running it
  // — nothing failed, because nothing checked. Reviewers act on these words, so
  // a scope that describes a loop we no longer ship sends every reviewer to
  // demand a digest the machine has already settled.
  assert.match(s, /RAN the full test suite on this branch and it was GREEN/);
  assert.match(s, /red suite is rejected to the implementer and never reaches a reviewer/);
});

test('the scope does NOT ask the reviewer to reconcile a suite digest', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  // The absence IS the instruction, and it is asserted separately from the
  // presence above because the two fail for different reasons: this one catches
  // a well-meaning re-addition of the old must-fix rule, which would make the
  // reviewer file a fault against every ticket that no longer carries a digest.
  assert.ok(!/does not run the test suite/.test(s),
    'the scope must not claim the loop skips the suite — verify runs it before any reviewer is spawned');
  // Bounded by the NEXT SECTION, never by a blank line. `split('\n\n')[0]`
  // scoped this to the FIRST PARAGRAPH after `SUITE:`, which holds only while
  // that text is a single `out.push` — reformat it into two paragraphs and the
  // slice silently narrows to the first half, so a MUST-FIX re-added in the
  // second half satisfies this check by leaving the slice rather than by not
  // existing. The two ENTER guards are what make the slice falsifiable at all:
  // an anchor that stops matching yields an EMPTY slice, and every absence
  // assertion is true of an empty slice.
  const after = s.split('SUITE:')[1] || '';
  const end = after.indexOf('Report your verdict in exactly this shape:');
  assert.ok(end > 0, 'ENTER: both anchors are present, so the slice is bounded by real section boundaries');
  const suiteSection = after.slice(0, end);
  assert.match(suiteSection, /green suite does NOT prove/,
    'ENTER: the slice reaches the END of the SUITE section — a narrowed slice would drop the very text this absence check is about');
  assert.ok(!/MUST-FIX/.test(suiteSection),
    'a missing digest is no longer a must-fix: the claim is verified by the machine, not the reviewer');
});

test('the scope still puts the half a green suite cannot prove ON the reviewer', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  // Dropping the digest check must not drop the JUDGEMENT with it. A green run
  // cannot see a test that asserts nothing or that would pass against unfixed
  // code, and those are exactly what a reviewer is for — without this line the
  // change would have relaxed the review instead of retargeting it.
  assert.match(s, /whether it would still pass against the\s+unfixed code|would still pass against the unfixed code/);
  assert.match(s, /asserting\s+nothing is green and worthless|asserting nothing is green and worthless/);
});

test('round 1 scope carries no prior-round section at all', () => {
  const s = buildReviewScope({ ticket: ticket({ reviewRound: 0 }), diffPath: '/tmp/d.diff' });
  assert.ok(!/THIS IS ROUND/.test(s), 'a first review must not claim a previous round');
  assert.ok(!/ACCEPTED everything else/.test(s));
});

test('round 2 carries round 1 MUST-FIX verbatim and closes settled ground', () => {
  const s = buildReviewScope({
    ticket: ticket({ reviewRound: 1, verdict: 'REWORK', mustFix: '- widget.js:12 retry bound is off by one\n- no test for the empty case' }),
    diffPath: '/tmp/d.diff',
  });
  assert.match(s, /THIS IS ROUND 2\./);
  assert.ok(s.includes('- widget.js:12 retry bound is off by one\n- no test for the empty case'),
    "round 1's must-fixes must appear verbatim, both items");
  assert.match(s, /Round 1 returned REWORK\./);
  assert.match(s, /Round 1 raised nothing else against this change\./);
  assert.match(s, /Do not re-open settled ground/);
});

test('the round-2 opener is DERIVED from the recorded verdict, never assumed', () => {
  // A round 2 can follow an ACCEPT the lead rejected anyway. Asserting "returned
  // REWORK" unconditionally opens the scope with a falsehood the reviewer cannot
  // check, and contradicts the settled-ground sentence that follows it.
  const acc = buildReviewScope({ ticket: ticket({ reviewRound: 1, verdict: 'ACCEPT', mustFix: '- x' }), diffPath: '/tmp/d.diff' });
  assert.match(acc, /Round 1 returned ACCEPT, and the lead sent it back anyway\./);
  assert.ok(!/returned REWORK/.test(acc), 'an ACCEPTed round must not be reported as REWORK');

  // No recorded verdict at all: say nothing about it rather than guessing.
  const none = buildReviewScope({ ticket: ticket({ reviewRound: 1, verdict: null, mustFix: '- x' }), diffPath: '/tmp/d.diff' });
  assert.match(none, /THIS IS ROUND 2\. The MUST-FIX items on record/);
  assert.ok(!/returned REWORK/.test(none) && !/returned ACCEPT/.test(none),
    'an unknown prior verdict is stated as neither');
});

test('round 2 with no recorded mustFix text says so rather than emitting a blank', () => {
  // A blank where the must-fixes should be reads as "round 1 asked for nothing",
  // which invites an ACCEPT of unfixed work.
  const s = buildReviewScope({ ticket: ticket({ reviewRound: 1, mustFix: null }), diffPath: '/tmp/d.diff' });
  assert.match(s, /\(round 1 recorded no MUST-FIX text\)/);
});

test('missing optional fields degrade without throwing or printing undefined', () => {
  const s = buildReviewScope({ ticket: { id: 't9' } });
  assert.match(s, /reviewing ticket t9\b/);
  assert.ok(!/undefined/.test(s), 'no field may leak the string "undefined" into the scope');
  assert.ok(!/null/.test(s), 'no field may leak the string "null" into the scope');
  // The grammar is unconditional: a degraded scope still has to tell the
  // reviewer how to answer, or the verdict cannot land at all.
  assert.ok(s.includes(VERDICT_GRAMMAR));
  // Asserted HERE specifically, on the most degraded ticket in the file, so the
  // emit line cannot be made conditional on a field this scope does not have.
  assert.ok(s.includes('[agent:review-done]'),
    'even a scope built from almost nothing must say how to emit the verdict');
});

test('a wholly absent ticket still produces an answerable scope', () => {
  const s = buildReviewScope({});
  assert.match(s, /reviewing ticket \(unknown\)/);
  assert.ok(s.includes(VERDICT_GRAMMAR));
});


// ── t618: the rework reasons the record now carries ────────────────────────
//
// Grepped before writing: the round>=2 subjects above claim the MUST-FIX block,
// the derived opener and the no-mustFix fallback, and nothing above claims
// anything about what the LEAD said when it sent the ticket back. That gap is
// what these add — the reader of the round-2 scope could see what the previous
// reviewer found and never what it was reopened for.

// The golden is rendered from `ticket-review-scope.js` AT THE BASE COMMIT this
// change was written against, not from the current module: a golden captured
// from the post-change code would agree with itself and could not detect the
// migration this subject exists to forbid. The live board carries 617 tickets
// and none of them have the field.
const GOLDEN_NO_REWORK = fsReal.readFileSync(
  pathReal.join(__dirname, 'fixtures', 'review-scope-round2-no-rework-reasons.txt'), 'utf8');

test('a ticket with NO rework reasons renders byte for byte as it did before the field existed', () => {
  const t = ticket({ reviewRound: 1, verdict: 'ACCEPT', mustFix: '(none)' });
  const s = buildReviewScope({
    ticket: t, diffPath: '/tmp/d.diff', taskDir: '/home/u/.clodex/projects/p/tasks/widget',
  });
  // The WHOLE string, not a regex over it: a regex asserting the absence of the
  // new heading would pass over any other shape change the field's arrival made
  // to the 617 records that do not have it.
  assert.strictEqual(s, GOLDEN_NO_REWORK,
    'the scope for a record without the field must be unchanged, to the byte');
});

test('an EMPTY rework-reasons array is the same non-event as an absent one', () => {
  // Reached in production by a reject whose reason was whitespace, and by any
  // record a future writer initialises eagerly. A heading over nothing tells the
  // reviewer a reason exists and then shows it none.
  const s = buildReviewScope({
    ticket: ticket({ reviewRound: 1, verdict: 'ACCEPT', mustFix: '(none)', reworkReasons: [] }),
    diffPath: '/tmp/d.diff', taskDir: '/home/u/.clodex/projects/p/tasks/widget',
  });
  assert.strictEqual(s, GOLDEN_NO_REWORK);
});

test('recorded rework reasons render verbatim, attributed, and SEPARATELY from MUST-FIX', () => {
  const s = buildReviewScope({
    ticket: ticket({
      reviewRound: 1, verdict: 'ACCEPT', mustFix: '(none)',
      reworkReasons: [
        { round: 1, at: 1, by: 'clodex', reason: 'the retry bound is off by one and the empty case is untested' },
        { round: 2, at: 2, by: 'ticket-loop', reason: 'SUITE RED: widget.test.js' },
      ],
    }),
    diffPath: '/tmp/d.diff',
  });
  assert.ok(s.includes('the retry bound is off by one and the empty case is untested'),
    'the first reason appears verbatim');
  assert.ok(s.includes('SUITE RED: widget.test.js'), 'and so does the second');
  assert.match(s, /Rework round 1 — from clodex:/, 'attributed to who sent it, under its round');
  assert.match(s, /Rework round 2 — from ticket-loop:/, 'the loop is named as itself, not as the lead');

  // The load-bearing separation: the MUST-FIX block is what the previous
  // REVIEWER found, the rework block is what the lead or the loop said
  // afterwards. Merging them attributes one party's words to the other, which is
  // the confusion this whole ticket removes — so the ordering is asserted, not
  // merely the presence of both.
  const mf = s.indexOf('The MUST-FIX items on record from round 1 were');
  const rw = s.indexOf('REWORK REASONS ON RECORD');
  assert.ok(mf !== -1 && rw !== -1, 'ENTER: both blocks rendered — otherwise the ordering below is vacuous');
  assert.ok(mf < rw, 'the two blocks are distinct and ordered, never interleaved');
  assert.ok(!s.slice(mf, rw).includes('SUITE RED: widget.test.js'),
    'no rework reason may fall inside the block attributed to the previous reviewer');
});

test('the round-2 opener and MUST-FIX block are untouched by the new block', () => {
  // The new block is ADDITIVE. Without this, a change that moved a reason into
  // the existing block would satisfy every subject above.
  const s = buildReviewScope({
    ticket: ticket({ reviewRound: 1, verdict: 'REWORK', mustFix: '- widget.js:12 off by one', reworkReasons: [{ round: 1, at: 1, by: 'clodex', reason: 'r' }] }),
    diffPath: '/tmp/d.diff',
  });
  assert.match(s, /THIS IS ROUND 2\. Round 1 returned REWORK\./);
  assert.ok(s.includes('- widget.js:12 off by one'));
});

test('an over-long reason is truncated VISIBLY at render, and only at render', () => {
  // The cap lives in the renderer because the scope rides a system prompt while
  // the record must keep what was actually said. A silent cut would let a
  // reviewer read a truncated demand as the whole of one.
  const long = `START${'x'.repeat(5000)}END`;
  const t = ticket({ reviewRound: 1, verdict: 'ACCEPT', reworkReasons: [{ round: 1, at: 1, by: 'clodex', reason: long }] });
  const s = buildReviewScope({ ticket: t, diffPath: '/tmp/d.diff' });
  assert.ok(s.includes('START'), 'the head of the reason survives');
  assert.ok(!s.includes('END'), 'ENTER: the reason really was long enough to be cut');
  assert.match(s, /\[truncated for the review scope — \d+ more characters are on the ticket record\]/,
    'and the cut is visible as one, naming where the rest is');
  assert.strictEqual(t.reworkReasons[0].reason, long,
    'the RECORD is not mutated by rendering it — the cap is the scope\'s, not the store\'s');
});

test('a malformed rework entry degrades rather than leaking undefined into the scope', () => {
  const s = buildReviewScope({
    ticket: ticket({ reviewRound: 1, verdict: 'ACCEPT', reworkReasons: [null, { reason: '' }, { reason: 'the real one' }] }),
    diffPath: '/tmp/d.diff',
  });
  assert.ok(s.includes('the real one'), 'ENTER: the well-formed entry still renders');
  assert.ok(!/undefined/.test(s), 'no entry may leak "undefined" into the scope');
  assert.match(s, /Rework round 1 — from \(unattributed\):/, 'a missing author is stated as unknown, not blank');
});
