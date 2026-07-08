// High-context self-compact reminder (Claude sessions).
//
// Why this exists: a long-running agent's context grows unbounded, and every
// turn re-sends the ENTIRE conversation as input — so payload cost scales with
// absolute token count, not with fraction-of-window (a 250k conversation is
// expensive even on a 1M-window model). Rather than have Clodex type /compact at
// some arbitrary moment (the parked auto-compact ceiling), we advise the agent
// its context is heavy and let it pick its own boundary via
// `[agent:context compact] <handoff>`.
//
// Delivery is UserPromptSubmit additionalContext (a {name}-ctxwarn file the hook
// cats in), NOT a PTY injection: no interruption, no inject-queue interaction,
// and it's self-targeting — a session receiving no prompts isn't growing, so it
// never gets nagged. The reminder recurs on every submit while over threshold
// (the file's mere presence drives it); the escalation wording counters
// habituation, so no extra throttle state is needed.
//
// Thresholds are ABSOLUTE tokens (per the payload-cost rationale above), not
// window-relative. Constants live here, beside the pure decision they govern, so
// the value the helper's tests assert against and the value main.js writes the
// file from are one source of truth (duplicating them into a main.js tunables
// block would risk drift). Kept dependency-free so the decision is unit-testable
// without electron, like inject-queue.js / pending-store.js.

'use strict';

// Nudge once context passes this; escalate the wording past the second. Cache-
// warm reads are discounted but not free, and the discount lapses.
const CTX_REMINDER_NUDGE_TOKENS = 150_000;
const CTX_REMINDER_ESCALATE_TOKENS = 250_000;

// Pure decision: given the current absolute input-token count, return the
// system-reminder block to attach to the next prompt, or null when under
// threshold (or the count is unknown/malformed). The caller re-attaches on every
// submit while a string comes back.
function ctxReminderFor(tokens) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t < CTX_REMINDER_NUDGE_TOKENS) return null;
  const k = Math.round(t / 1000);
  if (t >= CTX_REMINDER_ESCALATE_TOKENS) {
    return '<system-reminder>'
      + `Your context is very heavy (~${k}k tokens) — well past the point where you should have compacted. `
      + 'Every turn re-sends the entire conversation as input; cache-warm discounts reduce but do not remove that cost, and they lapse. '
      + 'Unless you are mid-step on something genuinely important, wrap up at the next natural boundary and run '
      + '[agent:context compact] <handoff> with a short continuation note so you resume with a lean window.'
      + '</system-reminder>';
  }
  return '<system-reminder>'
    + `Your context is getting heavy (~${k}k tokens). `
    + 'Every turn re-sends the entire conversation as input, so cost grows with total size; cache-warm discounts help but do not make it free. '
    + 'At the next natural boundary — unless you are mid-something genuinely important — consider running '
    + '[agent:context compact] <handoff> with a short continuation note to reset to a lean window.'
    + '</system-reminder>';
}

module.exports = { ctxReminderFor, CTX_REMINDER_NUDGE_TOKENS, CTX_REMINDER_ESCALATE_TOKENS };
