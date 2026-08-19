// peer-wiring.js — outbound peer-manager + tunnel-manager reconciliation and the
// persisted-attachment/control helpers, extracted verbatim from main.js (M5).
// createPeerWiring(deps) returns the five functions; main.js destructures them so
// its existing call sites (whenReady + the ipc handlers) stay byte-identical.
//
// Move-only. peerOnlineLog is a module-private Map only touched here, so it moves
// into the factory closure (same lifetime it had at module scope). Body changes
// are seams only:
//   * uiSettings -> getUiSettings() — the store is a `let` assigned in whenReady.
//   * peerManager / tunnelManager -> get+set (getPeerManager/setPeerManager,
//     getTunnelManager/setTunnelManager) — main.js `let` singletons this code
//     constructs and other main.js code (ipc handlers, before-quit) reads/nulls.
// manager, log, SELF_LABEL and scheduleAppMenuRefresh (from the app-menus
// destructure) are all defined at the call site and value-inject byte-identical.

function createPeerWiring(deps) {
  const {
    manager, log, SELF_LABEL, scheduleAppMenuRefresh,
    getUiSettings,
    getPeerManager, setPeerManager,
    getTunnelManager, setTunnelManager,
    getWebTunnelManager, setWebTunnelManager,
    openExternal,
  } = deps;

  // Last-logged online state per peer id — the ops log records online/offline
  // TRANSITIONS, not every (bursty) peer-state event.
  const peerOnlineLog = new Map();

  // Drop a persisted peer-tab attachment (explicit detach, or a name the peer
  // no longer has). No-op if it wasn't persisted, so callers can fire freely.
  function forgetPeerAttached(id, name) {
    const map = { ...(getUiSettings().get().peerAttached || {}) };
    if (!Array.isArray(map[id]) || !map[id].includes(name)) return;
    const list = map[id].filter((n) => n !== name);
    if (list.length) map[id] = list; else delete map[id];
    getUiSettings().set({ peerAttached: map });
  }

  // Same for a persisted control claim. Fired on explicit release, on detach/hide
  // (controlled implies attached, so a gone tab drops both), and on a stale-claim
  // drop when a restore re-acquire finds someone else holds it.
  function forgetPeerControlled(id, name) {
    const map = { ...(getUiSettings().get().peerControlled || {}) };
    if (!Array.isArray(map[id]) || !map[id].includes(name)) return;
    const list = map[id].filter((n) => n !== name);
    if (list.length) map[id] = list; else delete map[id];
    getUiSettings().set({ peerControlled: map });
  }

  // Add a persisted control claim (idempotent). Fired on a successful take —
  // explicit or type-to-take.
  function rememberPeerControlled(id, name) {
    const map = { ...(getUiSettings().get().peerControlled || {}) };
    const list = Array.isArray(map[id]) ? map[id] : [];
    if (list.includes(name)) return;
    map[id] = [...list, name];
    getUiSettings().set({ peerControlled: map });
  }

  function syncPeerManager() {
    const s = getUiSettings().get();
    if (!getPeerManager()) {
      const { PeerManager } = require('./peer-client');
      const { computeRosterFor } = require('./relay-protocol');
      setPeerManager(new PeerManager({
        selfLabel: SELF_LABEL,
        // Hub-relay: compute the roster to push to spoke `targetId` — agents on our
        // OTHER relayAllowed peers, split-horizon'd and both-endpoints-gated. Reads
        // live settings + peer statuses each call, so a relayAllowed toggle takes
        // effect on the next hello tick with no extra wiring.
        computeRoster: (targetId) => {
          const allowed = new Set(
            (getUiSettings().get().peers || [])
              .filter((p) => p && p.relayAllowed)
              .map((p) => String(p.id)),
          );
          if (!allowed.has(String(targetId))) return [];
          return computeRosterFor(targetId, getPeerManager().statuses(), allowed);
        },
        emit: (channel, ...args) => {
          // DM federation: claimed box→consumer messages are internal, not a
          // renderer event — deliver them locally and stop (keep bodies off the
          // generic ipc fan-out; deliverClaimedDms does its own ipc-log line).
          if (channel === 'peer-dms') {
            try { manager._deliverClaimedDms(args[0], args[1]); } catch (e) { log.error('peer', `claimed dm delivery failed: ${e.message}`); }
            return;
          }
          try { manager._broadcast(channel, ...args); } catch {}
          // Keep the Window > Peers menu's indicators + session lists fresh.
          if (channel === 'peer-state' || channel === 'peer-removed') scheduleAppMenuRefresh();
          // Ops log: peer online/offline TRANSITIONS only (peer-state fires in
          // bursts — hello wake + session refresh — so log on change, not per
          // event), plus removals. Control changes on OUR sessions log at their
          // own site (session-peer-control below).
          try {
            if (channel === 'peer-state') {
              const [id, status] = args;
              const online = !!(status && status.online);
              if (peerOnlineLog.get(id) !== online) {
                peerOnlineLog.set(id, online);
                log.info('peer', `${(status && status.label) || id} ${online ? 'online' : 'offline'}`);
              }
            } else if (channel === 'peer-removed') {
              const [id] = args;
              peerOnlineLog.delete(id);
              log.info('peer', `removed ${id}`);
            } else if (channel === 'peer-wterm-closed') {
              // The CONSUMER half of the peer terminal's visibility. The serving
              // box logs opens and closes at its own wiring; this end logs only
              // the ending, and only the explained one — a shell we opened on
              // someone else's machine that stopped because they revoked it is
              // the event an operator later needs to find, and it is the one a
              // toast in a closed drawer would have eaten.
              const [id, seat, why] = args;
              log.info('peer', `terminal ${seat}@${id} closed: ${why}`);
            }
          } catch { /* logging never breaks the emit fan-out */ }
        },
      }));
    }
    if (!getTunnelManager()) {
      const { TunnelManager } = require('./peer-tunnel');
      setTunnelManager(new TunnelManager({
        // Tunnel came up (fresh local port) or died: repoint/park the peer
        // connection, and let the renderer show tunnel state next to the peer.
        onState: (id, status) => {
          resolvePeerUrls();
          try { manager._broadcast('peer-tunnel', id, status); } catch {}
        },
      }));
    }
    // Disabled peers are paused, not removed: exclude them from both the tunnel
    // and peer syncs, so their tunnel/connection is torn down (and the UI soft-
    // sheds their tabs on the resulting peer-removed) while the record — and its
    // persisted attachments/claims — stays in s.peers for re-enable.
    getTunnelManager().sync((s.peers || []).filter((p) => !p.disabled));
    // Same already-filtered list to the web tunnels — which is close #2 of the
    // web view's four (peer removed or disabled). Only PRUNES: a web tunnel is
    // never opened by reconciliation, only by someone asking to look (t30b).
    // Skipped when nothing has ever been opened, so the on-demand manager isn't
    // constructed just to iterate an empty map.
    if (getWebTunnelManager && getWebTunnelManager()) {
      getWebTunnelManager().sync((s.peers || []).filter((p) => !p.disabled));
    }
    // And the companion wirescope forwards on the same list, so a peer that is
    // removed, disabled or re-pointed does not leave one open behind the web
    // view it belongs to (t443). Same laziness: never constructed here.
    if (wirescopeTunnelManager) {
      try { wirescopeTunnelManager.sync((s.peers || []).filter((p) => !p.disabled)); } catch {}
    }
    resolvePeerUrls();
    // Prune persisted attachments + visibility selections for peers that no
    // longer exist in settings.
    const ids = new Set((s.peers || []).map((p) => p.id));
    const patch = {};
    for (const field of ['peerAttached', 'peerVisible', 'peerControlled']) {
      const cur = s[field] || {};
      const next = {};
      let changed = false;
      for (const [id, names] of Object.entries(cur)) {
        if (ids.has(id)) next[id] = names; else changed = true;
      }
      if (changed) patch[field] = next;
    }
    if (Object.keys(patch).length) getUiSettings().set(patch);
    // Reflect add/edit/remove in the Window > Peers menu right away: a newly-added
    // OFFLINE peer never emits peer-state (its initial state is already offline),
    // so the emit-driven refresh wouldn't pick it up on its own.
    if (typeof scheduleAppMenuRefresh === 'function') scheduleAppMenuRefresh();
  }

  // Managed-tunnel peers ride their tunnel's current local port; while the
  // tunnel is down they keep a dead placeholder URL so the connection object
  // (and its sidebar presence) stays alive, just offline — calm, like a
  // sleeping laptop.
  function resolvePeerUrls() {
    // Required lazily, like the managers below, so this factory keeps its
    // load-order freedom; peer-tunnel owns the kind list, so the question
    // "does this peer use a managed cloud transport" is asked of it.
    const { hasCloudTransport } = require('./peer-tunnel');
    if (!getPeerManager()) return;
    const s = getUiSettings().get();
    const resolved = [];
    for (const p of s.peers || []) {
      if (p.disabled) continue;   // paused: PeerManager.sync sheds it (no connection)
      // Carry the operator auth token so the peer client presents Bearer on a
      // tokened remote wire (remote-auth-plan.md [internal design doc, not in this repo] §4). Absent for untokened
      // peers, so the wire to them is unchanged. Tunneled peers hit loopback on
      // the far side and usually need no token — but if that node sets one, it
      // rides through here too.
      const token = (typeof p.token === 'string' && p.token) ? p.token : null;
      // Keyed off "this peer is dialled through a MANAGED TUNNEL", not off
      // sshHost specifically — ssh and the typed cloud kinds (t32) both land on
      // a local port TunnelManager owns, and both need the dead placeholder
      // while that tunnel is down. Testing sshHost here would have left every
      // cloud peer resolving to `undefined` url. Asking the tunnel manager
      // "do you have a tunnel for this peer?" is not enough: it answers null
      // while the tunnel is merely DOWN, which is exactly when the placeholder
      // has to keep the connection object alive.
      if (p.sshHost || hasCloudTransport(p)) {
        const url = getTunnelManager() ? getTunnelManager().urlFor(p.id) : null;
        resolved.push({ id: p.id, label: p.label, url: url || 'http://127.0.0.1:1', token });
      } else {
        resolved.push({ id: p.id, label: p.label, url: p.url, token });
      }
    }
    getPeerManager().sync(resolved);
  }

  // ---- Peer web view (t30b; cloud transports t36) ---------------------------
  // A SEPARATE, on-demand forward to a peer's browser frontend, opened only
  // when someone asks to look at it. Distinct from the peer tunnel above on
  // purpose: that one carries Clodex's own wire for every dialable peer and re-picks
  // its local port on each respawn; this one exists per explicit request and
  // pins its port, because the consumer is a browser tab Clodex cannot re-point.
  // Full reasoning in web-tunnel.js's header.

  // Peers whose web view may be popped in the operator's browser on first up.
  // A TOKEN-GATED box is deliberately absent: web-host.js answers an
  // unauthenticated request with a bare 401 (no login form, no redirect) and the
  // token can only ride ?token= / Bearer / a cookie — none of which a freshly
  // opened tab carries. Popping one would hand the operator a dead end they
  // cannot fix from the browser, so the tunnel opens and the URL is reported
  // instead. Keyed by peer id and set at open time, because tokenGated is a fact
  // from the peer's hello, not something the supervisor could know.
  const webPopAllowed = new Set();

  // ---- The companion wirescope forward (t443) --------------------------------
  // A SECOND forward, to the box's own wirescope, raised with the web view and
  // torn down with it. It exists so the dashboard links inside that page resolve:
  // the page is served BY the box, so its links are built against the box's
  // loopback wirescope, which the operator's browser cannot reach. Without this
  // the browser resolves them against ITSELF, where a local wirescope is usually
  // listening on 7800 — the operator's own dashboard showing a foreign session
  // id, which is worse than a broken link because it looks right.
  //
  // SUBORDINATE, in the strong sense: it must never be the reason the web view
  // fails. Every call into it is wrapped, its failures are not surfaced, and a
  // box with no wirescope (CLODEX_WIRESCOPE=off is a supported deploy option) is
  // a normal quiet case — the web frontend opens and simply has no link.
  //
  // Deliberately NOT the same manager instance as the web view's: the web
  // manager's state is broadcast on `peer-web-tunnel`, which the renderer reads
  // as the ↗ affordance's phase. A second tunnel emitting on that channel under
  // the same peer id would drive the button from the wrong forward.
  let wirescopeTunnelManager = null;
  function ensureWirescopeTunnelManager() {
    if (wirescopeTunnelManager) return wirescopeTunnelManager;
    const { WebTunnelManager } = require('./web-tunnel');
    // Same policy as the web forward, and for the same reason (web-tunnel.js
    // header, inversion 1): the consumer is a browser tab holding a dead string,
    // so the local port is pinned and never re-picked on respawn.
    wirescopeTunnelManager = new WebTunnelManager({
      onState: (id, status) => {
        // Logged, never broadcast and never popped — see above. A give-up here
        // costs the link and nothing else, so it is info, not an error.
        if (status && status.state === 'gave-up') {
          log.info('peer', `wirescope forward for ${id} gave up — the web view keeps working without a dashboard link`);
        }
      },
    });
    return wirescopeTunnelManager;
  }

  // Raise the wirescope forward for one peer, and answer with the LOCAL port the
  // page should use — or null, which every caller must treat as "no link".
  //
  // Called BEFORE the web forward on purpose. Both managers pick their pinned
  // port through the same one-shot `net.createServer().listen(0)`, so opening
  // this one first means its port is picked first; the web view's own pop is
  // additionally behind a spawn and a TCP probe. The null branch is still real
  // (a peer with no wirescope in its hello, a refused transport) and is what
  // makes this safe when the ordering ever stops holding.
  function openPeerWirescope(id, dest) {
    const key = String(id);
    const conn = getPeerManager() && getPeerManager().get(key);
    const st = conn ? conn.status() : null;
    const wirescope = st && st.wirescope;
    // No field in the hello (a peer too old to send it) and an explicit null
    // (wirescope off on the box) are the SAME answer here: no forward. The port
    // is never defaulted to 7800 — see peer-client's normalization.
    //
    // Re-validated in full rather than trusting that normalization: this is the
    // side that SPENDS the value, and `Number.isInteger` alone admits 0 and
    // 70000, which reach the supervisor as a forward nothing can serve.
    const port = wirescope && wirescope.port;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    try {
      const res = ensureWirescopeTunnelManager().open({
        id: key, sshHost: dest.sshHost, remotePort: port,
        ...(dest.cloud ? { [dest.cloud.kind]: dest.cloud.block } : {}),
      });
      if (!res || !res.ok) return null;
      const local = wirescopeLocalPort(key);
      // Both arms log. A forward that opened but has no local port yet is the
      // one state where everything looks healthy and the page still gets no
      // link — silent, it is indistinguishable from "the box has no wirescope",
      // which is a different diagnosis entirely.
      if (local) log.info('peer', `wirescope forward for ${key}: 127.0.0.1:${local} → ${port}`);
      else log.info('peer', `wirescope forward for ${key} opened but reported no local port yet — no dashboard link on this page`);
      return local;
    } catch (e) {
      log.info('peer', `wirescope forward for ${key} not raised: ${e.message}`);
      return null;
    }
  }

  // The pinned local port, read from the supervisor rather than remembered here.
  // NOT gated on `state === 'up'`, which is what `url()` gates on: the two
  // forwards race, and the page URL can only be composed once. The pin is what
  // makes that safe — the port is this forward's for as long as it lives, so a
  // tab holding it starts working the moment the forward does. The failure this
  // trades for is a link at a dead port on our OWN loopback: visibly broken,
  // never a confidently-wrong dashboard.
  //
  // Wrapped like every other call into this forward: it runs on the pop path,
  // where a throw would cost the operator the browser window they asked for —
  // the one failure mode subordination exists to rule out.
  function wirescopeLocalPort(id) {
    if (!wirescopeTunnelManager) return null;
    try {
      const st = wirescopeTunnelManager.statusFor(String(id));
      const port = st && st.localPort;
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch { return null; }
  }

  function closePeerWirescope(id) {
    if (!wirescopeTunnelManager) return;
    try { wirescopeTunnelManager.close(String(id)); } catch {}
  }

  // The page URL the operator's browser is sent to. `?wirescope=` carries a PORT,
  // not a base: the forward is on our loopback by construction, so the page can
  // only ever compose 127.0.0.1:<port> from it and a value arriving from anywhere
  // else cannot re-point dashboard links at another origin.
  function pageUrl(url, port) {
    if (!port) return url;
    return `${url}${url.includes('?') ? '&' : '?'}wirescope=${port}`;
  }

  function ensureWebTunnelManager() {
    if (getWebTunnelManager()) return getWebTunnelManager();
    const { WebTunnelManager } = require('./web-tunnel');
    setWebTunnelManager(new WebTunnelManager({
      // State moves (up / down / gave-up / closed) reach the renderer on their
      // own channel so the affordance renders from live state — it never has to
      // poll, and it never has to cache a URL from when a popover opened.
      onState: (id, status) => {
        try { manager._broadcast('peer-web-tunnel', id, status); } catch {}
        // The web view reaching a TERMINAL state takes the companion with it —
        // the other half of "raised with the web view, torn down with it", and
        // the half that has no caller behind it. `closePeerWeb` covers the
        // operator closing the view; nobody at all covers a view that dies on
        // its own, and `gave-up` is exactly that: the affordance renders
        // `action: 'open'` at that state, so there is no close button left to
        // press, while the companion's ssh child keeps republishing the box's
        // unauthenticated wirescope on this machine's loopback. That is the
        // "forgotten forward open to a remote machine" web-tunnel.js inversion 3
        // exists to prevent.
        //
        // `down` is deliberately NOT terminal: it is one respawn away from up,
        // and both ports are pinned, so the operator's tab recovers by itself —
        // tearing the companion down on a wifi blip would cost the dashboard
        // link permanently, since only a fresh ↗ click re-raises it.
        if (status && (status.state === 'gave-up' || status.state === 'closed')) closePeerWirescope(id);
        // firstUp rides ONE emit, on the once-per-tunnel first success — so the
        // browser opens once and a respawn after a wifi blip does not pop a
        // second window (the pinned port means the existing tab just works).
        // The pop lives here, not in the supervisor, which stays electron-free.
        //
        // Since t37 that emit waits for the local port to ACCEPT, not merely for
        // the child to be alive — a browser opened into a `kubectl port-forward`
        // that has not started listening shows an error page and self-refreshes.
        // `ready: false` means the probe bound lapsed and the supervisor popped
        // anyway; logged distinctly, because a fallback that reads exactly like
        // the happy path is one nobody can debug from the log.
        if (status && status.firstUp && status.url) {
          if (webPopAllowed.has(String(id))) {
            log.info('peer', status.ready === false
              ? `web view up for ${id} → ${status.url} (port never confirmed — opening anyway)`
              : `web view up for ${id} → ${status.url}`);
            // The page URL is the ONLY channel into a tab the BOX served, so the
            // wirescope port rides it here — read at pop time, since the forward
            // was raised moments ago and may only just have picked its port.
            // Logged as the bare URL above: the param is plumbing, and the
            // operator's line should stay the address they can paste.
            try { openExternal(pageUrl(status.url, wirescopeLocalPort(id))); }
            catch (e) { log.error('peer', `web view open failed: ${e.message}`); }
          } else {
            log.info('peer', `web view up for ${id} → ${status.url} (token required — not opened)`);
          }
        }
      },
    }));
    return getWebTunnelManager();
  }

  // Open the web view for one peer. Refuses rather than guesses on every missing
  // input: an unknown peer, a peer with no forwardable transport (url-only — the
  // supervisor phrases that one, since it owns the kind list), and no live
  // webHost in the peer's hello (nothing to forward to; a guessed port is exactly
  // the lie t30a exists to prevent).
  //
  // The whole record's transport fields are handed to the supervisor rather than
  // sshHost alone (t36). Naming one field here was the door a kubectl peer was
  // refused at while its WIRE tunnel dialled fine: any layer that rebuilds a
  // record from named fields silently drops what it doesn't name, so this passes
  // the record and lets the module that owns the kind table decide.
  function openPeerWeb(id) {
    const key = String(id);
    const rec = (getUiSettings().get().peers || []).find((p) => p && String(p.id) === key);
    if (!rec) return { ok: false, error: 'no such peer' };
    // Asked of the supervisor, which owns the kind table — not re-derived here
    // from a `rec.sshHost || rec.ssm || …` chain, which is a list to forget a
    // kind from. Required lazily, like the managers below.
    const { destinationOf } = require('./web-tunnel');
    const dest = destinationOf(rec);
    if (!dest) {
      return { ok: false, error: 'this peer is reached by URL — Clodex can only tunnel to a web UI over a transport it dials itself (ssh, SSM, kubectl, GCP IAP, Azure Bastion)' };
    }
    const conn = getPeerManager() && getPeerManager().get(key);
    const st = conn ? conn.status() : null;
    const webHost = st && st.webHost;
    if (!webHost) return { ok: false, error: 'this peer reports no web frontend' };
    const tokenGated = webHost.tokenGated === true;
    // Decided BEFORE the tunnel starts, so the once-per-tunnel firstUp emit can
    // never race ahead of the decision and pop a 401 at the operator.
    if (tokenGated) webPopAllowed.delete(key); else webPopAllowed.add(key);
    // The companion forward, raised BEFORE the web one so its pinned port exists
    // when the pop composes the URL. Skipped for a token-gated box: no pop means
    // no URL is ever composed, so a forward for it would be one nothing can use
    // — and the gating decision stays where t30b put it rather than being
    // re-derived here.
    if (!tokenGated) openPeerWirescope(key, dest);
    const res = ensureWebTunnelManager().open({
      id: key, sshHost: dest.sshHost, remotePort: webHost.port,
      ...(dest.cloud ? { [dest.cloud.kind]: dest.cloud.block } : {}),
    });
    // A refused web open leaves the companion raised two lines above with
    // nothing to decorate. Unreachable today — the refusals the supervisor can
    // still return here are all caught earlier in this function — but the
    // ordering is what creates the window, so it is closed where the ordering
    // lives rather than trusted to stay unreachable.
    if (!res || res.ok === false) closePeerWirescope(key);
    // tokenGated rides the result so the renderer can say "this box wants a
    // token" rather than implying a link is coming.
    return { ...res, tokenGated };
  }

  function closePeerWeb(id) {
    webPopAllowed.delete(String(id));
    // Subordinate to the web view in BOTH directions: the companion forward goes
    // when the view goes. Unconditionally, before the early return — a web
    // manager that was never built does not imply the wirescope one wasn't.
    closePeerWirescope(id);
    if (!getWebTunnelManager()) return { ok: true };
    return getWebTunnelManager().close(String(id));
  }

  return {
    forgetPeerAttached, forgetPeerControlled, rememberPeerControlled,
    syncPeerManager, resolvePeerUrls, openPeerWeb, closePeerWeb,
    // App shutdown. The companion forwards are ssh/vendor CHILD processes with
    // no persistence record behind them, so a quit that skipped this would
    // orphan one holding a local port — the same reason the web manager is
    // stopped there. Kept private otherwise: nothing outside opens or reads it.
    stopPeerWirescopeTunnels: () => {
      if (!wirescopeTunnelManager) return;
      try { wirescopeTunnelManager.stopAll(); } catch {}
      wirescopeTunnelManager = null;
    },
  };
}

module.exports = { createPeerWiring };
