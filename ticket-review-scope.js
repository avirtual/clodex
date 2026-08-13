'use strict';

// The reviewer's scope, built from the ticket record and git alone.
//
// ZERO lead prose is the whole point: the measured defect this closes is that
// every verdict made two round trips through a lead whose own verification had
// a hit rate of zero. A scope a lead has to write by hand is a scope the lead
// is back in the loop for.
//
// Pure by construction — a string in, a string out, no manager, no fs, no git.
// That is what makes the contents assertable without spawning a session, and
// every item below is pinned by test/ticket-review-scope.test.js.

// Taken from resources/library/prompts/system/clodex-team-reviewer.md, which is
// the PRODUCER of this grammar, and kept in the shape _landVerdictOnTicket's
// parser accepts: that parser is line-anchored on VERDICT and reads MUST-FIX as
// a section, so a scope that asked for a different shape here would produce
// verdicts the loop silently fails to land.
// The emit line is PART OF THE GRAMMAR, not decoration around it: this block
// claims to be the authority on how to answer, and a reviewer that writes four
// perfect sections without emitting the intent reports to nobody and retires
// nothing. It works today only because the role prompt happens to carry the
// verb — but the scope survives a prompt edit, and an unbriefed reviewer
// (a missing role prompt is a warned, reachable state) has nothing else.
const VERDICT_GRAMMAR = [
  'Emit your verdict as the LAST thing you do, with the four sections below as its body:',
  '',
  '    [agent:review-done] <your full verdict, in the format below>',
  '    [agent:end]',
  '',
  'That single intent delivers the verdict and retires you. A pass that never emits',
  'it reports to nobody.',
  '',
  '- **VERDICT**: ACCEPT | REWORK — one line, unambiguous.',
  '- **MUST-FIX**: each blocking defect as its own item, with a `file:line` anchor',
  '  and why it is wrong (the failing interleaving / the unmet case / the broken',
  '  invariant). Empty section if none.',
  '- **NITS**: non-blocking improvements, `file:line` where it helps. Empty if none.',
  '- **CHECKED**: what you actually verified (files read, tests traced, cases',
  '  reasoned through) — so the pass\'s real coverage is visible.',
].join('\n');

function text(v) {
  return String(v == null ? '' : v).trim();
}

// `ticket` is the record; `diffPath` is where the materialized diff was written.
// Callers pass the diff path rather than the diff itself: the diff is unbounded
// and the scope rides a system prompt, so the reviewer is pointed at the file.
function buildReviewScope({ ticket, diffPath = null, taskDir = null } = {}) {
  const t = ticket || {};
  const id = text(t.id) || '(unknown)';
  const wt = t.worktree || {};
  const branch = text(wt.branch);
  const wtPath = text(wt.path);
  const baseSha = text(wt.baseSha);
  const dir = text(taskDir) || text(t.taskDir);
  const out = [];

  out.push(`You are reviewing ticket ${id}.`);
  out.push('');

  // The same `WORK IN:` shape _deliverTicketSpec uses, deliberately: the hand
  // was told where the tree is in exactly these words, and a reviewer given a
  // different phrasing for the same fact has to work out they are the same tree.
  if (wtPath) {
    out.push(`WORK IN: ${wtPath} (git worktree, branch ${branch || '(unknown)'}) — cd there first. `
      + 'Read only; do not commit, merge, push or edit anything in that tree.');
    out.push('');
  }

  if (baseSha) {
    out.push(`REVIEW RANGE: ${baseSha}..HEAD on branch ${branch || '(unknown)'}. `
      + `The base ${baseSha} is what the spec was written against — anything already in it is NOT yours to review.`);
    out.push('');
  }

  if (diffPath) {
    out.push(`DIFF: the full diff of that range is materialized at ${diffPath}. `
      + 'Read it first; it is the authoritative statement of what changed.');
    out.push('');
  }

  if (dir) {
    out.push(`TASK DIR: ${dir}`);
    out.push('');
  }

  const spec = text(t.spec);
  if (spec) {
    out.push('SPEC — what this ticket was asked to do:');
    out.push('');
    out.push(spec);
    out.push('');
  }

  // Verbatim, and introduced as the hand's OWN account rather than as fact.
  // Where a hand says it guessed, deviated or deferred is the highest-value
  // attention point in the review and exists nowhere else — a paraphrase is
  // exactly the operation that drops it.
  const report = text(t.report);
  if (report) {
    const who = text(t.reportedBy);
    out.push(`IMPLEMENTER'S REPORT — ${who ? `${who}'s` : 'the implementer\'s'} own account of the work, verbatim and unedited. `
      + 'It is a claim, not evidence: verify it against the diff. Pay particular attention to anywhere it says it '
      + 'guessed, deviated from the spec, assumed, or deferred — those are the author telling you where to look, '
      + 'and they are not recoverable from the diff alone.');
    out.push('');
    out.push(report);
    out.push('');
  }

  // The reviewer is only reached on a GREEN suite: verify runs it on the branch
  // and rejects a red one to the hand before any reviewer is spawned. The
  // contention that once made an automated run unsafe is handled rather than
  // avoided — the run takes the root checkout's lock and waits, so it serializes
  // with the lead's run instead of deadlocking against it.
  //
  // So the digest check is not merely moved here, it is GONE: demanding one
  // would send the reviewer to reconcile a claim the machine has already
  // settled, and a reviewer who treats its absence as a must-fix now files one
  // against every ticket. What replaces it is the half a green suite cannot
  // reach — a passing test that asserts nothing, or that passes against unfixed
  // code, is invisible to the runner and visible only to a reader.
  out.push('SUITE: the loop RAN the full test suite on this branch and it was GREEN before you were '
    + 'spawned — a red suite is rejected to the implementer and never reaches a reviewer. So do NOT '
    + 'ask for a suite digest, and do NOT treat a missing or stale one in the report as a fault: that '
    + 'claim is already verified and is not yours to re-check. What a green suite does NOT prove is '
    + 'yours: whether each new test measures what it claims, whether it would still pass against the '
    + 'unfixed code, and whether the change is the right one. A test that passes while asserting '
    + 'nothing is green and worthless, and the run cannot tell you which it was.');
  out.push('');

  // Round 2+: the settled ground is stated so the reviewer does not re-open it.
  // An unbounded re-review is how a two-round loop turns into a lead escalation
  // over work round 1 already accepted.
  const round = Number(t.reviewRound) || 0;
  if (round >= 1) {
    const mustFix = text(t.mustFix);
    // Derived, never assumed: a round 2 can follow an ACCEPT the lead rejected
    // anyway. Stating "returned REWORK" unconditionally opens the scope with a
    // falsehood the reviewer cannot check, and contradicts the settled-ground
    // sentence below it.
    const prior = text(t.verdict).toUpperCase();
    const priorClause = prior === 'REWORK' ? ` Round ${round} returned REWORK.`
      : prior === 'ACCEPT' ? ` Round ${round} returned ACCEPT, and the lead sent it back anyway.`
        : '';
    out.push(`THIS IS ROUND ${round + 1}.${priorClause} The MUST-FIX items on record from round ${round} were, verbatim:`);
    out.push('');
    out.push(mustFix || `(round ${round} recorded no MUST-FIX text)`);
    out.push('');
    out.push(`Round ${round} raised nothing else against this change. Review whether those MUST-FIX items are now `
      + 'genuinely fixed, plus any NEW defect the fixes introduced. Do not re-open settled ground: raising a fresh '
      + `MUST-FIX against code round ${round} already passed, and which this round did not touch, is out of scope.`);
    out.push('');
  }

  out.push('Report your verdict in exactly this shape:');
  out.push('');
  out.push(VERDICT_GRAMMAR);

  return out.join('\n');
}

module.exports = { buildReviewScope, VERDICT_GRAMMAR };
