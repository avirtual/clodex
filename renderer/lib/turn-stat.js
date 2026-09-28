'use strict';
// turn-stat.js — the "which turn number do we show" decision, shared by the
// statusbar and the sidebar hovercard so the two can never disagree.
//
// Two turn counts ride the proxy payload:
//   p.turns         — turns_completed, cumulative since the wire session began
//                     (spans compacts; "turn 143" after a day's work)
//   p.context.turns — turns_in_context, wire-truth count of turns in the LIVE
//                     context (main-line only, resets at compact)
// The live number is what an operator needs at a glance ("where is this
// context NOW"); the cumulative one still matters but rides the tooltip.
// Leaf: no DOM. NEW module — deliberately NOT in the leak-scanner's
// RENDERER_SCANNED_MODULES (that guard is for move-only extractions).

// { now, total } with nulls for missing halves; null when neither exists.
function turnStat(p) {
  const total = p && typeof p.turns === 'number' ? p.turns : null;
  const now = p && p.context && typeof p.context.turns === 'number' ? p.context.turns : null;
  if (now == null && total == null) return null;
  return { now, total };
}

// Statusbar segment: { text, tip }. Prefers the live count; degrades to the
// cumulative one (pre-feature proxy / context stats not fired yet) with a tip
// that says so.
function turnSeg(p) {
  const t = turnStat(p);
  if (!t) return null;
  if (t.now != null) {
    const tip = t.total != null
      ? `Turns in the live context (resets at compact) — ${t.total} completed since session start`
      : 'Turns in the live context (resets at compact)';
    return { text: `turn ${t.now}`, tip };
  }
  return { text: `turn ${t.total}`, tip: 'Turns completed since session start (live-context count unavailable)' };
}

// Hovercard line: both numbers inline — a hovercard IS the tooltip surface,
// so nothing can hide behind a title attribute there.
function turnLine(p) {
  const t = turnStat(p);
  if (!t) return null;
  if (t.now != null) {
    return t.total != null ? `turn ${t.now} (${t.total} total)` : `turn ${t.now}`;
  }
  return `turn ${t.total} total`;
}

// Request count, same live-first policy. p.sinceCompact is the wirescope
// since-compact rollup (poller-shaped; null on older proxies — degrades to the
// cumulative count with a tip that says it spans compacts). `compacted:false`
// means the session has never compacted, so since-boundary === since-start —
// the tip stays honest either way.
function reqSeg(p) {
  const total = p && p.cost && typeof p.cost.requests === 'number' ? p.cost.requests : null;
  const sc = p && p.sinceCompact;
  const now = sc && typeof sc.requests === 'number' ? sc.requests : null;
  if (now != null) {
    const since = sc.compacted ? 'since the last compact' : 'since session start (never compacted)';
    const tail = total != null && sc.compacted ? ` — ${total} total since session start` : '';
    return { text: `req ${now}`, tip: `API roundtrips ${since} (tool-loop calls, not just your prompts)${tail}` };
  }
  if (total == null) return null;
  return { text: `req ${total}`, tip: 'API roundtrips since session start, spans compacts (tool-loop calls, not just your prompts)' };
}

function reqLine(p) {
  const total = p && p.cost && typeof p.cost.requests === 'number' ? p.cost.requests : null;
  const sc = p && p.sinceCompact;
  const now = sc && typeof sc.requests === 'number' ? sc.requests : null;
  if (now == null) return total != null ? `req ${total}` : null;
  if (total == null) return `req ${now}`;
  if (sc.compacted) return `req ${now} (${total} total)`;
  if (p.costRun) return `req ${now} (${total} all-time)`;
  return `req ${now}`;
}

// Cost, same live-first policy (operator ruling 07-15, reversing the earlier
// cumulative-first call: THREE surfaces were showing three different cost
// scopes under near-identical labels). The number that answers "what is this
// costing me NOW" is since-compact spend; the cumulatives ride the tooltip
// with their scopes NAMED (second ruling, same day — a single unlabeled
// "total" contradicted the wirescope dashboard):
//   p.costRun.usd — wirescope's per-registration figure, zeroes when the
//                   agent's CLI process spawns ("this run"; preserved by the
//                   W2 overlay before it clobbers p.cost, absent otherwise)
//   p.cost.usd    — the payload producer's cumulative; under the overlay this
//                   is the persisted ALL-TIME ledger (additive across
//                   restarts), on a raw poll it's the run figure itself.
// When both are present they are different scopes and both are shown; with
// only p.cost the label stays the neutral "total" (its scope varies by
// producer). { text, tip } — text keeps the ~$ estimate marker.
function fmtCost(v) { return v >= 1 ? v.toFixed(2) : v.toFixed(4); }
function costScopes(p) {
  const total = p && p.cost && typeof p.cost.usd === 'number' ? p.cost.usd : null;
  const run = p && p.costRun && typeof p.costRun.usd === 'number' ? p.costRun.usd : null;
  return { total, run: run != null && total != null ? run : null };
}
function costSeg(p) {
  const { total, run } = costScopes(p);
  const sc = p && p.sinceCompact;
  const now = sc && typeof sc.estUsd === 'number' ? sc.estUsd : null;
  if (now != null) {
    const since = sc.compacted ? 'since the last compact' : 'since session start (never compacted)';
    let tail = '';
    if (run != null) tail = ` — $${fmtCost(run)} this run · $${fmtCost(total)} all-time`;
    else if (total != null && sc.compacted) tail = ` — $${fmtCost(total)} total`;
    return { text: `~$${fmtCost(now)}`, tip: `Estimated spend ${since} (whole tree incl. subagents)${tail}` };
  }
  if (total == null) return null;
  if (run != null) return { text: `~$${fmtCost(run)}`, tip: `Estimated spend this run (since the agent's process started) — $${fmtCost(total)} all-time` };
  return { text: `~$${fmtCost(total)}`, tip: 'Estimated total spend (spans compacts)' };
}

function costLine(p) {
  const { total, run } = costScopes(p);
  const sc = p && p.sinceCompact;
  const now = sc && typeof sc.estUsd === 'number' ? sc.estUsd : null;
  if (now != null) {
    if (run != null) return `~$${fmtCost(now)} ($${fmtCost(run)} run · $${fmtCost(total)} all-time)`;
    return total != null && sc.compacted ? `~$${fmtCost(now)} ($${fmtCost(total)} total)` : `~$${fmtCost(now)}`;
  }
  if (total == null) return null;
  if (run != null) return `~$${fmtCost(run)} ($${fmtCost(total)} all-time)`;
  return `~$${fmtCost(total)}`;
}

module.exports = { turnStat, turnSeg, turnLine, reqSeg, reqLine, costSeg, costLine };
