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
      setPeerManager(new PeerManager({
        selfLabel: SELF_LABEL,
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
    if (!getPeerManager()) return;
    const s = getUiSettings().get();
    const resolved = [];
    for (const p of s.peers || []) {
      if (p.disabled) continue;   // paused: PeerManager.sync sheds it (no connection)
      if (p.sshHost) {
        const url = getTunnelManager() ? getTunnelManager().urlFor(p.id) : null;
        resolved.push({ id: p.id, label: p.label, url: url || 'http://127.0.0.1:1' });
      } else {
        resolved.push({ id: p.id, label: p.label, url: p.url });
      }
    }
    getPeerManager().sync(resolved);
  }

  return {
    forgetPeerAttached, forgetPeerControlled, rememberPeerControlled,
    syncPeerManager, resolvePeerUrls,
  };
}

module.exports = { createPeerWiring };
