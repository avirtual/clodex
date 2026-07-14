// relay-protocol.js — the bytes-on-the-wire commitments for hub-relay DM
// federation. Single, dependency-free source of truth for the two shapes clodex
// blessed (see docs/messaging.md §4 for the prose): the relay ENVELOPE and the
// POST /api/peer/roster payload. Pure functions only — no electron, no fs — so
// both the main-process router (session-manager.js) and the wire layer
// (remote.js / peer-client.js) require it directly, and it's unit-testable
// without a live tunnel.
//
// Topology this serves: a STAR. One hub holds an SSH tunnel to each spoke; spokes
// never dial each other. A spoke→spoke DM is relayed THROUGH the hub — the
// originating spoke enqueues to its own outbox under origin=<hub>, the hub claims
// it and re-delivers to the destination spoke via a plain direct DM.
//
// Two invariants live here and must not be weakened:
//   * `from`'s LOCAL part is SACRED — the sender's agent name is never rewritten,
//     and `from` is never replaced with a hop's own identity (that would point
//     replies at the hub). It is the load-bearing field for the reverse reply
//     path (the destination tags the recipient's sender with it, and the reply
//     re-enters the relay in reverse). The ORIGIN SUFFIX, though, is the hub's to
//     normalize: the spoke stamps its own selfLabel (hostname-ish), but the only
//     namespace the destination can route a reply through is the hub's configured
//     label for the source spoke — the one the roster advertises. The hub
//     rewrites `agent@<spoke selfLabel>` → `agent@<hub's label for that spoke>`
//     on the terminal leg (see _relayClaimedDm); NOT doing so ships an
//     unroutable reply address whenever the two labels diverge.
//   * The TERMINAL hub→dest leg is a PLAIN DIRECT DM — the relay fields
//     (`finalTarget`, `hops`, `rv`) are STRIPPED. This is a deliberate
//     loop-prevention feature, not an accident: if the destination agent is
//     offline the dest box sees an ordinary direct DM to a missing local name and
//     parks/bounces it normally — there is no `finalTarget` for it to chase and
//     no way to re-relay. Do NOT propagate `finalTarget` onto the terminal leg;
//     that reopens the loop the `hops<=0` guard and this strip together close.

'use strict';

// Session/label charset — a wire-supplied name/origin/label is only usable as a
// dm target or a path segment if it matches this (mirrors the box's NAME_RE and
// the outbox ORIGIN_RE). Kept local so this leaf stays dependency-free.
const RELAY_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

// How long a spoke trusts a cached relay roster after its last refresh. The hub
// re-pushes every hello tick (~15s), so a roster not refreshed within this window
// means the hub's leg to us dropped → treat it as gone (TTL-by-liveness). Read at
// use time (who-list, routing), same pattern as the telemetry-stale gate.
const RELAY_ROSTER_TTL_MS = 60000;

// Envelope/roster wire version. Bumped only on a breaking shape change (e.g. a
// future multi-hub source-route). A receiver seeing a version ABOVE what it knows
// must reject rather than misparse — see relayVersionOk (forward guard).
const RELAY_ENVELOPE_V = 1;

// Relay hop budget. Our star consumes exactly ONE relay hop (the hub's re-deliver
// pass). Set to the initial `hops` on the originating spoke; the hub applies
// hopRule: a legitimate single relay lands with hops decremented to 0 (and, being
// the terminal leg, with the relay fields stripped entirely), while any spurious
// re-relay re-enters the outbox already at 0 and is dropped. Named so a future
// intermediate hop is a one-line bump — do NOT inflate headroom now (a higher
// ceiling only lets a misconfigured loop run longer before it dies).
const RELAY_MAX_HOPS = 1;

// Forward-compat guard shared by the envelope and the roster payload: accept an
// absent version (a pre-relay peer that never set it — the field simply isn't
// there) or one at/below what we understand; reject anything newer.
function relayVersionOk(rv) {
  return rv === undefined || rv === null || (Number.isInteger(rv) && rv <= RELAY_ENVELOPE_V);
}

// A wire `from` is valid if it's a bare local name (`agent`) OR a fully-qualified
// federated sender (`agent@docker`). The qualified form is what rides the terminal
// relay leg: `from` is SACRED end-to-end, so the destination box must accept it as
// a sender identity rather than reject the `@`. Both segments are name-charset.
function isQualifiedSender(from) {
  if (typeof from !== 'string') return false;
  const at = from.indexOf('@');
  if (at < 0) return RELAY_NAME_RE.test(from);
  // exactly one '@', both sides name-charset (a second '@' would be a mangled or
  // double-qualified sender — reject it rather than guess).
  const name = from.slice(0, at);
  const origin = from.slice(at + 1);
  return RELAY_NAME_RE.test(name) && RELAY_NAME_RE.test(origin);
}

// True iff an incoming DM envelope is a RELAY envelope (carries a finalTarget)
// rather than a plain direct DM. Absence of finalTarget => direct DM (the
// backward-compatible shape) — that's the whole discriminator.
function isRelayEnvelope(msg) {
  return !!(msg && typeof msg === 'object' && typeof msg.finalTarget === 'string' && msg.finalTarget);
}

// Build the relay envelope the ORIGINATING spoke enqueues into its own outbox
// under origin=<hub-label>. `from` and `finalTarget` must already be
// fully-qualified by the caller; `to` is the bare final name the destination box
// resolves locally. hops defaults to the ceiling. This is the ONLY place hops is
// seeded, so the budget is single-sourced.
function buildRelayEnvelope({ to, finalTarget, from, origin, body, urgent }) {
  return {
    rv: RELAY_ENVELOPE_V,
    to,
    finalTarget,
    from,
    origin,
    body,
    urgent: !!urgent,
    hops: RELAY_MAX_HOPS,
  };
}

// The hub's hop decision on a claimed relay envelope. Returns { relay, hops } —
// relay:false means DROP (budget exhausted / malformed), relay:true carries the
// decremented hops to stamp on... nothing, because the terminal leg strips them
// (buildTerminalDm). The decrement is still computed so a FUTURE intermediate hop
// (RELAY_MAX_HOPS>1) forwards the reduced budget. Rule: hops<=0 => drop; else
// hops-1 and relay.
function hopRule(hops) {
  const h = Number.isInteger(hops) ? hops : 0;
  if (h <= 0) return { relay: false, hops: 0 };
  return { relay: true, hops: h - 1 };
}

// Compute the relay roster the HUB pushes to one spoke `targetId` — the agents on
// its OTHER peers that this spoke is permitted to reach. Pure: takes the hub's
// peer statuses (PeerManager.statuses() shape: {id,label,online,caps,sessions})
// and the set of peer ids the operator marked relayAllowed. Enforces, in order:
//   * symmetric gate — the target must itself be relayAllowed, else it's not in
//     the mesh at all → empty roster.
//   * split-horizon — never advertise the target's own agents back to it.
//   * both-endpoints gate — only include peer Y where Y is relayAllowed too.
//   * liveness — only online peers with a routable label.
//   * type filter — only claude/codex sessions (the who-list's existing filter;
//     bash can't process intents).
// Returns [{name, origin, type}] (origin = Y's label). Dedup guards a pathological
// duplicate name across the same origin.
function computeRosterFor(targetId, statuses, relayAllowedIds) {
  const allowed = relayAllowedIds instanceof Set ? relayAllowedIds : new Set(relayAllowedIds || []);
  if (!allowed.has(String(targetId))) return [];
  const roster = [];
  const seen = new Set();
  for (const st of (statuses || [])) {
    if (!st || String(st.id) === String(targetId)) continue;   // split-horizon
    if (!st.online) continue;                                   // liveness
    if (!allowed.has(String(st.id))) continue;                 // both-endpoints gate
    if (!st.label || !RELAY_NAME_RE.test(st.label)) continue;  // routable origin only
    for (const sess of (st.sessions || [])) {
      if (!sess || (sess.type !== 'claude' && sess.type !== 'codex')) continue;
      if (!RELAY_NAME_RE.test(String(sess.name || ''))) continue;
      const key = `${sess.name}@${st.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roster.push({ name: sess.name, origin: st.label, type: sess.type });
    }
  }
  return roster;
}

// The PLAIN DIRECT DM the hub delivers on the terminal leg — exactly conn.dm's
// input signature `{to, from, body, urgent}`. Relay fields (finalTarget/hops/rv)
// are deliberately absent (see the terminal-leg invariant up top); `origin` is NOT
// here because conn.dm stamps it with the hub's own selfLabel and would ignore a
// caller value. `from` arrives here already origin-normalized by the caller (local
// part sacred, suffix = the hub's label for the source spoke — see the `from`
// invariant up top). Byte-shaped like a normal consumer→box DM so the destination
// can't tell (or exploit) that it was relayed.
function buildTerminalDm({ to, from, body, urgent }) {
  return { to, from, body, urgent: !!urgent };
}

module.exports = {
  RELAY_ENVELOPE_V,
  RELAY_MAX_HOPS,
  RELAY_ROSTER_TTL_MS,
  RELAY_NAME_RE,
  relayVersionOk,
  isQualifiedSender,
  isRelayEnvelope,
  buildRelayEnvelope,
  hopRule,
  buildTerminalDm,
  computeRosterFor,
};
