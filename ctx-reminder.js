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
// window-relative. The shipped values live here, beside the pure decision they
// govern, so the value the helper's tests assert against and the value main.js
// writes the file from are one source of truth (duplicating them into a main.js
// tunables block would risk drift). Operator overrides arrive as an argument.
// Kept dependency-free so the decision is unit-testable without electron, like
// inject-queue.js / pending-store.js.

'use strict';

// Nudge once context passes this; escalate the wording past the second. Cache-
// warm reads are discounted but not free, and the discount lapses.
//
// DO NOT RAISE THESE so that ticket seats are not nudged mid-ticket. That change
// has already been made once, on that reasoning, and it was redundant: a seat
// spawned for one ticket is never nudged AT ANY THRESHOLD, because the ctx tick
// drops the warning for a session whose persistence record is `ephemeral`. The
// raise bought its stated beneficiary nothing and moved every STANDING seat 50k
// deeper, which is where the compacting actually happens. The exemption is
// `ephemeral`, not the threshold — reach for that, or for a per-model row below,
// not for these.
//
// The exact value is a measured trade, not a natural constant, and the two facts
// that decide it are the SHAPE of the cost curve, not the number: replaying a
// real 25-day stream under each cap, everything from 150k to 175k costs within
// ~1% (the region is flat, so buying fewer compacts there is nearly free), and
// the curve only bends upward past 200k. 175k takes the fewer-compacts end of
// that flat region.
//
// The nudge also stays UNDER 200k, the point a long-context surcharge would
// begin if the vendor applies one to a model we route. The nudge is what asks a
// seat to act, so it must get to act before crossing that line; the escalate at
// 225k is only the backstop for a seat that ignored it and is already past.
// Reason from the curve and that line, not from the number — reasoning from the
// number is how this reached 200k the first time.
const CTX_REMINDER_NUDGE_TOKENS = 175_000;
const CTX_REMINDER_ESCALATE_TOKENS = 225_000;

// Per-model thresholds, keyed by the family `modelFamily` derives. Keyed on the
// model ID, never the display name: the display name is vendor prose ("Sonnet
// 4.6") and is not what a threshold priced per model can be indexed by.
//
// EMPTY ON PURPOSE, and not dead code. A model whose read price is low enough
// genuinely wants to compact later — a compact's cost is nearly all fixed while
// the per-turn saving scales with the read rate — but the measured payback was
// already several-fold at a threshold higher than the one shipped here, so
// raising a model buys a margin rather than averting a loss. Against that sits a
// possible long-context surcharge beginning at 200k: if one applies, every turn
// a raised row spends above that line is billed at a higher rate and the
// optimisation inverts. A usage receipt carries token counts and never a rate,
// so nothing here can detect it. The costs of being wrong are asymmetric, so no
// row ships and the settings map is what makes a correction free.
const CTX_MODEL_THRESHOLDS = new Map();

// A nudge below this fires on a session that has merely loaded its system prompt
// and tools, which trains the agent to ignore it; above the ceiling it can never
// fire on any window that exists, which disables the feature while reading as
// configured. Both ends are footguns, so both are clamped.
const CTX_THRESHOLD_MIN = 50_000;
const CTX_THRESHOLD_MAX = 2_000_000;
// Escalate must clear nudge by this much or the two collapse into one event and
// the sterner second warning is unreachable.
const CTX_ESCALATE_MIN_GAP = 25_000;

// Derive the family a model's thresholds are keyed by, or null when the id fits
// no known vendor shape.
//
// This is deliberately NOT the ordered-prefix-regex shape MODEL_WINDOWS uses in
// argv-merge.js. A prefix rule reaches rows it was never meant to own and fails
// SILENTLY when it does. Here the
// grammar is anchored and the lookup is exact equality on its output, so a rule
// is structurally incapable of matching a model another rule owns: two ids share
// thresholds only when they reduce to the same family string, and the reduction
// keeps every component the vendor prices separately.
function modelFamily(modelId) {
  if (!modelId) return null;
  const id = String(modelId).trim().toLowerCase()
    // The CLI marks 1M-mode ids with this suffix; it is a mode, not a model.
    .replace(/\[1m\]$/, '')
    // Bedrock/Vertex qualify the id with a routing prefix ("us.anthropic.").
    .replace(/^.*claude-/, 'claude-');
  // The MINOR version is kept, because it is the axis this vendor's prices move
  // on: claude-fable-5-1 reads at a quarter of claude-fable-5's rate, so a
  // grammar that folded them together could not express the one difference the
  // per-model table exists for. A release date and a routing version are dropped
  // instead — those name a build, not an economic difference, and keeping them
  // would fragment one model across every date it ever shipped under. The two
  // are told apart by width: a date is 8 digits, a version component is 1-3.
  const m = /^claude-([a-z]+)-(\d{1,3})(?:-(\d{1,3}))?(?:-\d{8})?(?:-v\d+(?::\d+)?|@\d+)?$/.exec(id);
  if (!m) return null;
  return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

// Coerce one persisted {nudge, escalate} pair, or null if unusable.
//
// Whole-row validity: a junk nudge drops the PAIR rather than leaving a default
// nudge beside an operator escalate, which could land a nudge above its own
// escalate. escalate is coerced up instead of dropped so an ordering mistake
// still honours the nudge the operator asked for.
function sanitizeThresholdPair(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nudge = raw.nudge;
  if (!Number.isInteger(nudge) || nudge < CTX_THRESHOLD_MIN || nudge > CTX_THRESHOLD_MAX) return null;
  const wanted = Number.isInteger(raw.escalate) ? raw.escalate : 0;
  const escalate = Math.min(Math.max(wanted, nudge + CTX_ESCALATE_MIN_GAP), CTX_THRESHOLD_MAX + CTX_ESCALATE_MIN_GAP);
  return { nudge, escalate };
}

// Sanitize the whole persisted override map. Rows are sparse by design: an
// absent key, an absent row and an unusable row all resolve to the shipped
// value, so a settings file written before this key existed behaves as it did.
// Unrecognized family keys are KEPT if they parse as a family — the shipped
// table can gain a row without a settings migration, and an override for a
// model this build has no row for must survive rather than be swallowed.
function sanitizeCtxThresholds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of Object.keys(raw)) {
    if (key !== 'default' && !/^[a-z]+-\d{1,3}(?:-\d{1,3})?$/.test(key)) continue;
    const pair = sanitizeThresholdPair(raw[key]);
    if (pair) out[key] = pair;
  }
  return out;
}

// Resolve the thresholds in force for a model. `source` names which layer
// answered, so a model that reached the baseline because nothing matched is
// distinguishable from one whose own row says the baseline values — the
// difference a silent lookup miss would hide.
//
// Most specific wins: a per-model row outranks the operator's baseline. The
// other order would let an unrelated baseline edit erase the per-model tuning
// with no indication it had, which is the whole hazard this file is built
// around.
function ctxThresholdsFor(modelId, overrides) {
  const ov = sanitizeCtxThresholds(overrides);
  const family = modelFamily(modelId);
  if (family && ov[family]) return { ...ov[family], family, source: 'settings-model' };
  if (family && CTX_MODEL_THRESHOLDS.has(family)) {
    // Through the same clamp an operator row takes. A shipped row is authored,
    // not typed, so this is not distrust of the value — it is that the gap rule
    // the escalate wording depends on must hold on the path the table exists to
    // be extended on, not only on the path that already has a guard.
    const built = sanitizeThresholdPair(CTX_MODEL_THRESHOLDS.get(family));
    if (built) return { ...built, family, source: 'builtin-model' };
  }
  if (ov.default) return { ...ov.default, family, source: 'settings-default' };
  return {
    nudge: CTX_REMINDER_NUDGE_TOKENS,
    escalate: CTX_REMINDER_ESCALATE_TOKENS,
    family,
    source: 'builtin-default',
  };
}

// Pure decision: given the current absolute input-token count, return the
// system-reminder block to attach to the next prompt, or null when under
// threshold (or the count is unknown/malformed). The caller re-attaches on every
// submit while a string comes back. `thresholds` is what ctxThresholdsFor
// returned; omitted, the shipped baseline applies.
function ctxReminderFor(tokens, thresholds) {
  const nudgeAt = Number.isInteger(thresholds?.nudge) ? thresholds.nudge : CTX_REMINDER_NUDGE_TOKENS;
  const escalateAt = Number.isInteger(thresholds?.escalate) ? thresholds.escalate : CTX_REMINDER_ESCALATE_TOKENS;
  const t = Number(tokens);
  if (!Number.isFinite(t) || t < nudgeAt) return null;
  const k = Math.round(t / 1000);
  if (t >= escalateAt) {
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

module.exports = {
  ctxReminderFor,
  ctxThresholdsFor,
  modelFamily,
  sanitizeCtxThresholds,
  CTX_REMINDER_NUDGE_TOKENS,
  CTX_REMINDER_ESCALATE_TOKENS,
  CTX_MODEL_THRESHOLDS,
  CTX_THRESHOLD_MIN,
  CTX_THRESHOLD_MAX,
  CTX_ESCALATE_MIN_GAP,
};
