'use strict';

// The reviewer's scope, built from the ticket record, git, and a
// caller-resolved `taskDir`/`taskDirRule`.
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

// Applied HERE and not where the reason is stored: the record keeps what the
// lead actually said, and only this rendering is bounded — the scope rides a
// system prompt and a reason is unbounded lead prose. A cut is rendered as a
// visible marker rather than silently, so a reviewer never mistakes a truncated
// demand for the whole of one.
const REWORK_REASON_CAP = 2000;

function capReason(v) {
  const t = text(v);
  if (t.length <= REWORK_REASON_CAP) return t;
  return `${t.slice(0, REWORK_REASON_CAP)}\n… [truncated for the review scope — ${t.length - REWORK_REASON_CAP} more characters are on the ticket record]`;
}

// The per-entry cap bounds ONE reason; this bounds the block. They are not the
// same limit reached twice: the realistic producer is the loop, whose composed
// reject reason runs ~1-1.5 KB and stays comfortably under the per-entry cap, so
// a hand re-closing a red branch N times files N entries that are each legal and
// together unbounded.
const REWORK_BLOCK_BUDGET = 8000;

// Keeps the MOST RECENT entries: those are the demands the reviewer is being
// asked to check, while an earlier round's is either already fixed or restated by
// a later one. Measured over the rendered chunks, so the budget bounds what the
// scope actually carries rather than what the record holds.
//
// One entry always survives a budget of any size — a block that were only a drop
// notice would tell the reviewer reasons exist and then show it none.
function budgetEntries(chunks) {
  const kept = [];
  let total = 0;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    total += chunks[i].length;
    if (kept.length && total > REWORK_BLOCK_BUDGET) break;
    kept.unshift(chunks[i]);
  }
  return kept;
}

// `ticket` is the record; `diffPath` is where the materialized diff was written.
// Callers pass the diff path rather than the diff itself: the diff is unbounded
// and the scope rides a system prompt, so the reviewer is pointed at the file.
// `taskDir` is the RESOLVED directory and `taskDirRule` the clause explaining a
// relative pointer, both rendered by team-tickets `_ticketTaskDirRender` — the
// one renderer the hand's dispatch also goes through, so the two cannot state
// the same fact differently.
//
// There is deliberately NO fallback to `ticket.taskDir`. That field is the raw
// spec string, and the reviewer's cwd is the repo — which carries a stale
// `tasks/` whose names collide with the artifact dir's, so a relative pointer
// rendered verbatim sends the reviewer into a real but wrong tree, silently.
// A fallback also reintroduces it on exactly the path that must not have it:
// when resolution is REFUSED, the raw escaping string is what would be shown.
// Naming no task dir is the correct degradation; the caller resolves or the
// scope says nothing.
function buildReviewScope({ ticket, diffPath = null, taskDir = null, taskDirRule = '' } = {}) {
  const t = ticket || {};
  const id = text(t.id) || '(unknown)';
  const wt = t.worktree || {};
  const branch = text(wt.branch);
  const wtPath = text(wt.path);
  const baseSha = text(wt.baseSha);
  const dir = text(taskDir);
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
    out.push(`TASK DIR: ${dir}${text(taskDirRule) ? taskDirRule : ''}`);
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

  // Kept SEPARATE from the MUST-FIX block above, which is the load-bearing part:
  // that block is what the previous REVIEWER found, this is what the lead or the
  // loop said when it sent the ticket back afterwards. Merging them would
  // attribute one party's words to the other — the confusion this block exists
  // to remove.
  //
  // Gated on the field being present and non-empty so a record without it renders
  // byte for byte as it did before: every ticket minted before this field existed
  // is such a record, and a scope that changed shape for them would be a
  // migration.
  const reasons = Array.isArray(t.reworkReasons) ? t.reworkReasons.filter((r) => r && text(r.reason)) : [];
  if (reasons.length) {
    out.push('REWORK REASONS ON RECORD — what the lead or the loop said when this ticket was sent back, '
      + 'verbatim. These are NOT the previous round\'s MUST-FIX items: those are what a reviewer found, '
      + 'these are what whoever reopened the ticket asked for afterwards, and they are the only record of '
      + 'why the ticket came back at all. Each is labelled with the rework round it was sent during; more '
      + 'than one under the same round means further must-fixes went to a seat already holding that round.');
    out.push('');
    const chunks = reasons.map((r) => {
      const who = text(r.by) || '(unattributed)';
      return `Rework round ${Number(r.round) || 1} — from ${who}:\n\n${capReason(r.reason)}`;
    });
    const kept = budgetEntries(chunks);
    const dropped = chunks.length - kept.length;
    // The same rule the per-entry cap follows: a truncation must be visible as
    // one. Stated ABOVE the entries, because a reviewer that reads them first has
    // already taken the block for the whole history.
    if (dropped) {
      out.push(`[${dropped} EARLIER rework reason${dropped === 1 ? '' : 's'} on this ticket ${dropped === 1 ? 'is' : 'are'} not shown here — this block is `
        + `bounded and carries the ${kept.length} most recent. The full record is on the ticket.]`);
      out.push('');
    }
    for (const chunk of kept) {
      out.push(chunk);
      out.push('');
    }
  }

  out.push('Report your verdict in exactly this shape:');
  out.push('');
  out.push(VERDICT_GRAMMAR);

  return out.join('\n');
}

module.exports = { buildReviewScope, VERDICT_GRAMMAR };
