// peer-web-view.js — the pure decision behind the peer web-view (↗) affordance:
// given a peer's LIVE hello state and its web-tunnel state, should the button
// render, what does it say, and is it a "close" click? peers-ui.js is DOM-bound
// and untested by the R1 rule, so everything here that could be gotten wrong
// lives in this leaf instead.
//
// Three rules this file exists to enforce:
//
//   • NO TUNNEL URL BEFORE THERE IS A LIVE ONE (t30). The `url` field carries
//     only what the supervisor reports while its forward is up; a
//     pinned-but-unbound local port is not a service, and peer-tunnel's
//     dead-peer sentinel http://127.0.0.1:1 must never surface as a web link.
//     t923's direct address is not a forward and not bound by this — see the
//     url-kind arm.
//   • A TOKEN-GATED BOX IS NOT A LINK (t30). web-host.js answers an
//     unauthenticated request with a bare 401 — no login form — and a freshly
//     opened tab carries no ?token=/Bearer/cookie. So a gated peer's affordance
//     says the box needs a token rather than promising something to click.
//   • NEVER GUESS WHICH ROUTE A PEER TAKES (t925). Which arm a closed-phase peer
//     gets is read from `status.direct`, which main sets from the same
//     destinationOf a click is routed with. Inferring it from a missing tunnel
//     row promised an ssh peer a loopback address during the window before the
//     rows are seeded.
//
// Both ROUTING refusals this file used to state are gone: a cloud peer's at t36
// ("Clodex can only tunnel to a web UI over ssh" — true when written, false one
// release later), a url peer's at t923. See docs/notes/renderer-lib-peer-web-view.md.

'use strict';

const { directWebUrl } = require('../../peer-web-url');

// Kept for callers that need the narrower question (ssh specifically — e.g. the
// deploy/setup flow, which copies files and runs a shell and genuinely is ssh-only).
function isSshPeer(tunnel) { return !!(tunnel && tunnel.sshHost); }

// Which typed cloud transport dials this peer, phrased for a sentence, or null
// for an ssh/url peer. The tunnel row carries the block under its kind key, so
// naming the real transport costs nothing — the tips below say which forward is
// being opened, and an SSM operator told their box "is reached by URL" would go
// looking for a URL that does not exist.
const CLOUD_TRANSPORT_NAMES = {
  ssm: 'an AWS SSM tunnel',
  kubectl: 'a kubectl port-forward',
  gcloud: 'a GCP IAP tunnel',
  az: 'an Azure Bastion tunnel',
};
function cloudTransportName(tunnel) {
  if (!tunnel) return null;
  for (const [kind, name] of Object.entries(CLOUD_TRANSPORT_NAMES)) {
    if (tunnel[kind]) return name;
  }
  return null;
}

// "over ssh" / "over a kubectl port-forward" — the forward the operator is
// actually getting, for the tips. A tip that says "over ssh" at a kubectl peer
// would be the same category of false-but-plausible sentence this file just
// finished removing.
function transportPhrase(tunnel) {
  const cloud = cloudTransportName(tunnel);
  if (cloud) return `over ${cloud}`;
  return 'over ssh';
}

// state: 'closed' (nothing open) | 'connecting' | 'open' | 'gave-up'
function tunnelPhase(webTunnel) {
  if (!webTunnel) return 'closed';
  if (webTunnel.state === 'up') return 'open';
  if (webTunnel.state === 'gave-up') return 'gave-up';
  if (webTunnel.state === 'closed') return 'closed';
  return 'connecting';
}

// The whole affordance, as data.
//   show     — render the button at all
//   enabled  — clickable
//   action   — 'open' | 'close' | null (what a click does)
//   phase    — see tunnelPhase
//   tip      — the button's tooltip/aria text
//   url      — a live FORWARD's URL, or null. Never composed, only relayed.
//   tokenGated
function webViewAffordance({ status, tunnel, webTunnel } = {}) {
  const st = status || null;
  const webHost = st && st.webHost;
  const phase = tunnelPhase(webTunnel);
  const direct = !!(st && st.direct === true);
  const how = tunnel ? ` ${transportPhrase(tunnel)}` : '';
  const label = (st && (st.host || st.label)) || 'peer';
  // `=== true`, matching peer-client's hello normalization (the single producer,
  // which already coerces to a strict boolean) and peer-wiring's pop decision.
  // One rule in all three places on purpose: if this read truthy while the pop
  // read strict, a value like the string 'yes' would have the UI say "needs a
  // token" while main opened a browser at a 401 — the two halves disagreeing is
  // worse than either rule alone.
  const tokenGated = !!(webHost && webHost.tokenGated === true);
  // Only a live 'up' status carries a URL, and only from the supervisor.
  const url = (phase === 'open' && webTunnel && webTunnel.url) ? webTunnel.url : null;

  // No web frontend reported → nothing to offer. An already-open tunnel still
  // renders (so it can be closed) even if the box just stopped advertising:
  // an open forward the operator can't see is the hole the give-up cap exists
  // to prevent, and hiding its only close button would be the same bug.
  if (!webHost && phase === 'closed') return { show: false, enabled: false, action: null, phase, tip: '', url: null, tokenGated };

  if (direct && phase === 'closed') {
    const address = directWebUrl(st && st.url, webHost && webHost.port);
    if (!address) {
      // Shown-but-disabled, not hidden — a silently missing button reads as
      // "this box has no web UI", which is a different and false claim.
      return {
        show: true, enabled: false, action: null, phase, url: null, tokenGated,
        tip: `${label}'s address can't be read, so there is nothing to open`,
      };
    }
    return {
      show: true, enabled: true, action: 'open', phase, url: null, tokenGated,
      tip: tokenGated
        ? `${label}'s web UI is at ${address} — the box requires a token, so you'll get a URL to open with ?token=…`
        : `Open ${label}'s web UI at ${address} — no tunnel needed`,
    };
  }

  if (phase === 'open') {
    return {
      show: true, enabled: true, action: 'close', phase, url, tokenGated,
      tip: tokenGated
        ? `${label}'s web UI is tunnelled to ${url} and requires a token (?token=…). Click to close the tunnel`
        : `${label}'s web UI is open at ${url} — click to close the tunnel`,
    };
  }
  if (phase === 'connecting') {
    return {
      show: true, enabled: true, action: 'close', phase, url: null, tokenGated,
      tip: `Connecting to ${label}'s web UI${how}… click to cancel`,
    };
  }
  if (phase === 'gave-up') {
    const why = (webTunnel && webTunnel.error) ? ` (${webTunnel.error})` : '';
    return {
      show: true, enabled: true, action: 'open', phase, url: null, tokenGated,
      tip: `Couldn't reach ${label}'s web UI${why} — click to try again`,
    };
  }
  return {
    show: true, enabled: true, action: 'open', phase, url: null, tokenGated,
    tip: tokenGated
      ? `Open ${label}'s web UI${how} — the box requires a token, so you'll get a URL to open with ?token=…`
      : `Open ${label}'s web UI${how}`,
  };
}

module.exports = {
  webViewAffordance, tunnelPhase, isSshPeer,
  cloudTransportName, transportPhrase,
};
