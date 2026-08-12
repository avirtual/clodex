'use strict';

// t309 §B: the constructed review scope. Every item the spec requires gets its
// own assertion, because the failure this pins is a scope that builds fine and
// silently omits one — a reviewer cannot report a section it was never given,
// so an omission surfaces as a confident review of the wrong thing.

const { test } = require('node:test');
const assert = require('node:assert');

const { buildReviewScope, VERDICT_GRAMMAR } = require('../ticket-review-scope');

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
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  assert.match(s, /reviewing ticket t42\b/);
  assert.ok(s.includes('THE SPEC BODY: make the widget idempotent.'),
    'the spec body must appear verbatim');
  assert.ok(s.includes('/home/u/.clodex/projects/p/tasks/widget'),
    'the task dir must appear');
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

test('the suite-digest instruction is present (the C ruling moves the check here)', () => {
  const s = buildReviewScope({ ticket: ticket(), diffPath: '/tmp/d.diff' });
  // The loop does not run the suite by ruling; if this instruction is missing
  // the ruling has silently DROPPED the suite check rather than relocating it.
  assert.match(s, /this loop does not run the test suite/);
  assert.match(s, /missing, stale, or non-green suite digest in that report is itself a MUST-FIX/);
});

test('round 1 scope carries no prior-round section at all', () => {
  const s = buildReviewScope({ ticket: ticket({ reviewRound: 0 }), diffPath: '/tmp/d.diff' });
  assert.ok(!/THIS IS ROUND/.test(s), 'a first review must not claim a previous round');
  assert.ok(!/ACCEPTED everything else/.test(s));
});

test('round 2 carries round 1 MUST-FIX verbatim and closes settled ground', () => {
  const s = buildReviewScope({
    ticket: ticket({ reviewRound: 1, mustFix: '- widget.js:12 retry bound is off by one\n- no test for the empty case' }),
    diffPath: '/tmp/d.diff',
  });
  assert.match(s, /THIS IS ROUND 2\./);
  assert.ok(s.includes('- widget.js:12 retry bound is off by one\n- no test for the empty case'),
    "round 1's must-fixes must appear verbatim, both items");
  assert.match(s, /Round 1 ACCEPTED everything else in this change\./);
  assert.match(s, /Do not re-open settled ground/);
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
});

test('a wholly absent ticket still produces an answerable scope', () => {
  const s = buildReviewScope({});
  assert.match(s, /reviewing ticket \(unknown\)/);
  assert.ok(s.includes(VERDICT_GRAMMAR));
});
