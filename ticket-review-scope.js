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
const VERDICT_GRAMMAR = [
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

  // The §C ruling's other half. The loop deliberately does NOT run the suite
  // (one runner, one lock — an automated caller contending with the lead's run
  // on a minutes-long job is the deadlock this avoids), so the suite claim
  // arrives as a claim inside the report above, and checking it is the
  // reviewer's job. Without this line the ruling would drop the check entirely
  // instead of moving it.
  out.push('SUITE: this loop does not run the test suite — the report above is the only claim about it. '
    + 'A missing, stale, or non-green suite digest in that report is itself a MUST-FIX. '
    + 'So is a claimed digest you cannot reconcile with the tests actually present in the diff.');
  out.push('');

  // Round 2+: the settled ground is stated so the reviewer does not re-open it.
  // An unbounded re-review is how a two-round loop turns into a lead escalation
  // over work round 1 already accepted.
  const round = Number(t.reviewRound) || 0;
  if (round >= 1) {
    const mustFix = text(t.mustFix);
    out.push(`THIS IS ROUND ${round + 1}. Round ${round} returned REWORK. Its MUST-FIX items were, verbatim:`);
    out.push('');
    out.push(mustFix || '(round 1 recorded no MUST-FIX text)');
    out.push('');
    out.push(`Round ${round} ACCEPTED everything else in this change. Review whether those MUST-FIX items are now `
      + 'genuinely fixed, plus any NEW defect the fixes introduced. Do not re-open settled ground: raising a fresh '
      + 'MUST-FIX against code round 1 already passed, and which this round did not touch, is out of scope.');
    out.push('');
  }

  out.push('Report your verdict in exactly this shape:');
  out.push('');
  out.push(VERDICT_GRAMMAR);

  return out.join('\n');
}

module.exports = { buildReviewScope, VERDICT_GRAMMAR };
