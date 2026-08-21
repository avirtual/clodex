'use strict';

// lib/cost-by-line.js — the "By line" cost attribution model behind the cost
// popover's per-line section: whole-tree total, the main line's own share, each
// subagent's share, and each billed share as a percentage of the total.
//
// WHY THE SCOPE PICK IS HERE and not three field reads at the call site. Under
// the W2 overlay (wire-telemetry.js `overlay`, ON by default) `p.cost` is the
// wire's persisted ALL-TIME ledger while `p.subagents[].estUsd` is left
// poll-scoped — dividing the second by the first gives a share that shrinks the
// longer the box stays up, and the wire ledger carries no `mainUsd` at all, so
// the main row vanishes and with no subagents the whole section does.
// `costRun` is the poll's own cost object, preserved by that same overlay:
// same producer and same scope as `subagents`, `mainUsd` included. Picking the
// coherent PAIR — never patching `mainUsd` onto the wire object, which would
// pair a run-scoped numerator with an all-time denominator inside one object —
// is what makes this section render identically with the overlay on and off,
// which test/cost-by-line.test.js pins. Nothing displayed here comes from the
// wire, so nothing here may vary with it.
//
// Fallback: with the overlay off `costRun` is absent and `p.cost` IS the poll's
// object, the same scope again. If the poll carried no cost the overlay sets
// `costRun = null` and the fallback lands on the wire object — but then the
// poll had no cost figures at all, so there is nothing better to show.
//
// null = render nothing (capability off, no cost object, or nothing attributed
// yet). A null share is UNBILLED, never $0 (pre-0.22 wirescope / unpriced).
function costByLine(p) {
  if (!p || !p.capabilities || !p.capabilities.cost_by_line) return null;
  const cost = (p.costRun || p.cost);
  if (!cost) return null;
  const total = typeof cost.usd === 'number' ? cost.usd : null;
  const main = typeof cost.mainUsd === 'number' ? cost.mainUsd : null;
  const subs = Array.isArray(p.subagents) ? p.subagents : [];
  const billedSubs = subs.filter((s) => typeof s.estUsd === 'number');
  if (main == null && !billedSubs.length) return null; // nothing attributed yet
  const pct = (v) => (total && total > 0 && typeof v === 'number') ? Math.round((v / total) * 100) : null;
  const rows = [];
  if (main != null) rows.push({ label: 'Main line', usd: main, pct: pct(main), main: true });
  for (const s of subs) {
    const usd = typeof s.estUsd === 'number' ? s.estUsd : null;
    rows.push({ label: s.label || s.key, usd, pct: pct(usd), main: false });
  }
  // Billed rows sorted high→low; unbilled (null) sink to the bottom.
  rows.sort((a, b) => (b.usd == null ? -1 : b.usd) - (a.usd == null ? -1 : a.usd));
  return { total, rows };
}

module.exports = { costByLine };
