'use strict';
// peer-shell.js — the decisions behind a terminal tab pointed at a PEER box:
// whether the serving side offers one at all, what crosses the wire as a seat,
// and what a refusal reads like on the consumer.
//
// A pure leaf (no requires) read by BOTH processes and BOTH ends of the wire:
// remote-wiring decides whether to register the serving handlers, peer-client
// and the renderer decide whether to ask. A second copy anywhere would answer
// the grant question differently the first time either changed, and the
// question is a security one.

// A CAPABILITY STRING, not a flag anyone checks at call time. The serving box
// only advertises `shell` when its handlers exist (remote.js derives caps from
// callback presence), so a box that never granted it 501s the endpoint AND
// omits the string — registration is the capability, the same choice
// enableDrawerServices makes for the web host.
const SHELL_CAP = 'shell';

// Does this box serve peer terminals at all? This drives whether remote-wiring
// passes the serving callbacks, which is what puts `shell` in hello.
//
// Takes the WHOLE settings object, not the peers array. The grant used to live
// on each outbound peer record, which made it unreachable on a serving-only box
// — there was no record to carry it, and adding a dial-out nobody wanted was
// the only way to tick the box. It is a serving-side setting and it now sits
// with the other serving-side settings.
//
// The honest limit, and it must not be overstated anywhere downstream:
// `peerShellEnabled` is AN OPERATOR-INTENT RECORD AND A UI AFFORDANCE, NOT AN
// ENFORCEMENT BOUNDARY. The peer wire has no cryptographic caller identity —
// dmOrigins and the relay gate match a caller-ASSERTED label, and the tunnel is
// the trust boundary (docs/peering.md §1). So the serving handler cannot tell
// which peer is calling: the grant registers the handlers for anything that can
// reach the port. Box-wide is what it always was in effect; per-peer was the
// storage, never the semantics.
//
// That is a deliberate ruling, not an oversight: the enforcement a per-grant
// secret would buy is against a caller already inside the tunnel, who can
// already open a shell through the `create` cap (a bash session takes a
// caller-supplied cwd). A second token tier guarding a door that is open beside
// it is cost without a property. If the tunnel ever stops being the boundary,
// this toggle becomes enforceable for free.
//
// What the `create` cap does NOT cover, and why this consent is separate rather
// than folded into it: `create` spawns a caller its own fresh PTY, while a peer
// terminal attaches to the operator's OWN drawer shell and is handed its
// scrollback (remote-wiring's wtermOpen). The delta is not privilege, it is
// observation of the operator.
function shellCapGranted(settings) {
  return !!(settings && settings.peerShellEnabled === true);
}

function peerHasShellCap(caps) {
  return (Array.isArray(caps) ? caps : []).includes(SHELL_CAP);
}

// The serving box's own seat grammar, duplicated here ON PURPOSE rather than
// imported: this is the CONSUMER-side check, and its job is to guarantee that
// what we put in the URL is something the far side will accept. Sharing one
// constant across the wire would hide the day the two ends disagree, which is
// the day this matters. Kept byte-identical to remote.js NAME_RE / seatOf.
const WIRE_SEAT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

// Split a renderer peer-session key into the parts the wire needs.
//
// THE `@` NEVER CROSSES THE WIRE. The consumer keys peer sessions `name@peerId`
// (peers-ui.js) because its sessions Map is flat and `@` cannot occur in a local
// name. The peerId half is addressing OUR connection — it is meaningless on the
// far side, where the bare name is an ordinary local seat. Sending the composite
// is what broke this before in the other direction: `@` fails the serving
// grammar, a rejected seat becomes null, and null is the key of the SEATLESS
// workspace shell, so every peer row silently shared one local terminal.
// Splitting here is the root-cause fix, not a route around it.
//
// Splits at the FIRST `@`: a local name cannot contain one, so anything after
// it belongs to the id.
function wireSeatFor(key) {
  const s = typeof key === 'string' ? key : '';
  const at = s.indexOf('@');
  if (at <= 0) return null;
  const name = s.slice(0, at);
  const peerId = s.slice(at + 1);
  if (!peerId || !WIRE_SEAT_RE.test(name)) return null;
  return { name, peerId };
}

// The serving side's resize bounds, duplicated for the same reason as
// WIRE_SEAT_RE and pinned against remote.js the same way. This is the second
// thing both ends check: the consumer refuses fast, and the serving side
// refuses again because the wire is not trusted. Neither check may be removed
// on the strength of the other.
const WIRE_COLS_MIN = 20, WIRE_COLS_MAX = 500;
const WIRE_ROWS_MIN = 5, WIRE_ROWS_MAX = 300;

function vetWireResize(cols, rows) {
  const c = parseInt(cols, 10), r = parseInt(rows, 10);
  if (!(c >= WIRE_COLS_MIN && c <= WIRE_COLS_MAX && r >= WIRE_ROWS_MIN && r <= WIRE_ROWS_MAX)) {
    return { ok: false, error: 'bad dimensions' };
  }
  return { ok: true, cols: c, rows: r };
}

// What the consumer's operator reads. Composed here rather than on the serving
// side because only the consumer knows what to call the box.
//
// Every code below has a producer, and that is a requirement, not an
// observation: a refusal vocabulary with unreachable entries reads as evidence
// that a path exists. `off`/`no-seat`/`bad-seat`/`failed` come from
// peer-client's WTERM_STATUS_CODE (the HTTP status of a stream that never
// reached 200 — the SSE path discards the body, so the status IS the code);
// `revoked`/`closed` from the serving side's close frame; `offline` and
// `predates` from the consumer's own pre-flight. If a case here stops being
// reachable, delete it.
//
// `off` and `no-services` are deliberately indistinguishable: a box that
// declines to serve terminals should not also report whether the reason is a
// per-peer decision or a host-wide one. The consumer learns "no", not why.
function peerShellRefusal(code, peerLabel, detail) {
  const box = peerLabel || 'that box';
  switch (code) {
    // Says BOTH remedies because a missing `shell` cap cannot distinguish them,
    // and `predates` is an ALIAS rather than its own sentence for that reason.
    // Unlike the `dm` cap — which every box carrying the feature advertises
    // unconditionally, so its absence really does mean "too old" (see
    // session-manager's "predates dm federation") — `shell` is grant-gated, so
    // an absent cap is equally "no grant" and "no such feature". Asserting
    // either one sends the operator to go fix the wrong box.
    case 'off':
    case 'no-services':
    case 'predates':
      return `terminal sharing isn't available on '${box}' — its operator has to enable it, or its Clodex predates peer terminals.`;
    case 'bad-seat':
    case 'no-seat':
      return `no such session on '${box}'.`;
    case 'offline':
      return `'${box}' is offline.`;
    case 'revoked':
      return `terminal sharing was turned off on '${box}'.`;
    case 'failed':
      return detail
        ? `'${box}' could not open a terminal: ${detail}`
        : `'${box}' could not open a terminal.`;
    default:
      return detail
        ? `'${box}' refused the terminal: ${detail}`
        : `'${box}' refused the terminal.`;
  }
}

module.exports = {
  SHELL_CAP, shellCapGranted, peerHasShellCap, wireSeatFor, peerShellRefusal, WIRE_SEAT_RE,
  vetWireResize, WIRE_COLS_MIN, WIRE_COLS_MAX, WIRE_ROWS_MIN, WIRE_ROWS_MAX,
};
