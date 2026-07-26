// peer-web-view.js — the pure decision behind the peer web-view (↗) affordance:
// given a peer's LIVE hello state and its web-tunnel state, should the button
// render, what does it say, and is it a "close" click? peers-ui.js is DOM-bound
// and untested by the R1 rule, so everything here that could be gotten wrong
// lives in this leaf instead.
//
// Two rules this file exists to enforce, both from t30:
//
//   • NO URL BEFORE THERE IS A LIVE ONE. The affordance never composes a URL —
//     the only URL is the one the supervisor reports while its forward is up.
//     (peer-tunnel's dead-peer sentinel http://127.0.0.1:1 is a wire-tunnel
//     placeholder and must never surface as a web link.)
//   • A TOKEN-GATED BOX IS NOT A LINK. web-host.js answers an unauthenticated
//     request with a bare 401 — no login form — and a freshly opened tab carries
//     no ?token=/Bearer/cookie. So a gated peer's affordance says the box needs
//     a token rather than promising something to click.
//
// ssh-only, by ruling: a peer reached by plain URL has no transport Clodex can
// drive a forward over, so the affordance says so rather than silently hiding.
// Since t32 that ruling has a SECOND way to be false — a peer dialled over a
// typed cloud transport (ssm) does have a managed wire tunnel, but the web view
// needs its OWN second forward and only the ssh template can open one. Same
// answer (no button), a different true reason, and the tip must say which.

'use strict';

// Is this peer reached over a Clodex-managed ssh tunnel? The wire tunnel row IS
// the signal on this side — the renderer never sees the peer record itself. Note
// a cloud-transport peer HAS a tunnel row (carrying `ssm`) but no sshHost, so
// this stays a test for sshHost specifically, not for "has a tunnel".
function isSshPeer(tunnel) { return !!(tunnel && tunnel.sshHost); }

// Which typed cloud transport dials this peer, phrased for a sentence, or null
// for an ssh/url peer. The tunnel row carries the block under its kind key, so
// naming the real transport costs nothing — and telling an SSM operator their
// box "is reached by URL" would be a false explanation of a true limit, sending
// them to look for a URL that does not exist.
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
//   url      — a live URL, or null. NEVER composed here.
//   tokenGated
function webViewAffordance({ status, tunnel, webTunnel } = {}) {
  const st = status || null;
  const webHost = st && st.webHost;
  const phase = tunnelPhase(webTunnel);
  const ssh = isSshPeer(tunnel);
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

  if (!ssh && phase === 'closed') {
    // ssh-only limitation, stated rather than hidden — a silently missing button
    // reads as "this box has no web UI", which is a different and false claim.
    // Which non-ssh transport it is matters: telling an ssm peer's operator it
    // "is reached by URL" would be a false explanation of a true limit, and
    // they'd go looking for a URL that doesn't exist.
    const how = cloudTransportName(tunnel) || 'URL';
    return {
      show: true, enabled: false, action: null, phase, url: null, tokenGated,
      tip: `${label} is reached by ${how}, not ssh — Clodex can only tunnel to a web UI over ssh`,
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
      tip: `Connecting to ${label}'s web UI over ssh… click to cancel`,
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
      ? `Open ${label}'s web UI over ssh — the box requires a token, so you'll get a URL to open with ?token=…`
      : `Open ${label}'s web UI over ssh`,
  };
}

module.exports = { webViewAffordance, tunnelPhase, isSshPeer, cloudTransportName };
