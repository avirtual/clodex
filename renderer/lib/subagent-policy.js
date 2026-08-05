// subagent-policy.js — live/done/drop classification for one subagent entry.
//
// Task/background subagents share the parent's session_id on the wire, so they
// arrive in the parent's payload.subagents. There is NO wire signal for
// "subagent done" — a Task sub just stops making requests — so done/aging is
// POLICY we own here, not something to wait for the server to send.
//
// Effective inactivity is `lastActiveS + payloadAgeS`: the payload itself may be
// seconds old, and a sub that was idle 25s when a 10s-old payload was minted is
// idle 35s now. Reading `lastActiveS` alone would report a dead sub as live for
// as long as the poll interval.
//
// Extracted so the sidebar child rows and the drawer's Activity chips classify
// through ONE copy — two consumers disagreeing about whether a sub is done is
// the bug this shape prevents.

const SUBAGENT_ACTIVE_S = 30;   // seen within this window → "live"
const SUBAGENT_DROP_S = 300;    // stale past this → drop the row entirely

// `null` means drop, and it is a third answer, not a flavour of 'done': a done
// sub still renders (dimmed), a dropped one does not render at all.
function classifySubagent(sub, payloadAgeS) {
  const lastActiveS = sub && sub.lastActiveS;
  const eff = (lastActiveS == null) ? 0 : lastActiveS + payloadAgeS;
  if (eff > SUBAGENT_DROP_S) return null;
  return eff < SUBAGENT_ACTIVE_S ? 'active' : 'done';
}

module.exports = { classifySubagent, SUBAGENT_ACTIVE_S, SUBAGENT_DROP_S };
