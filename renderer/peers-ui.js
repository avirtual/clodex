// peers-ui.js — the whole peered-Clodex subsystem as one self-contained
// island. A peer is a session running on another machine's Clodex, reached
// through its remote server; this side is a thin adapter (all protocol/
// reconnect logic lives in main's peer-client.js). The island OWNS: the peer
// bar + the peer rows in the sidebar (renderPeers), per-peer visibility
// (peerVisibleMap) and control mirrors (peerControlledMap), the one-shot
// restore/settle machinery, the take/release-control + type-to-take path, the
// peer-select (eye) and peer-info (ⓘ) popovers, and every onPeer* subscription
// + startup seed.
//
// Core keeps the sessions Map and the sidebar/terminal spine and injects them
// as params. Six functions core still calls come back as destructured handles:
// typeToTakeControl (createTerminal's PendingInput consumer), renderPeerBar
// (switchSession), forgetControlMirror (removeSession), openPeerSession (the
// open-peer-session wire), peerDisplayHost (the warmth toast's name@host), and
// peerHideFromList (Cmd+W on a peer tab). peerStatuses/peerTunnels are core
// Maps (the peers-setup dialog reads them) injected by reference; activeSession,
// ourAppVersion and deployLineHandlers are read through getters (reassignable /
// defined below the init site).
//
// Disable/enable (pause a peer without deleting its config): main flips a
// `disabled` flag and broadcasts `peer-disabled` to every window BEFORE it re-runs
// the peer syncs. Each renderer records the id in `disabledPeers` on that event
// (and the initiator marks it synchronously before the invoke), so when the
// disable-driven `peer-removed` lands, onPeerRemoved SOFT-sheds the tabs —
// removeSession(key, {keepPersisted:true}) drops the terminal without the durable
// detach, so the attachment survives. A disabled peer has no live status, so it
// renders as a dimmed "paused" header (from config, seeded at startup via
// getSettings) with an Enable affordance; live peers get Disable in the ⓘ popover.
// Re-enable re-seeds the one-shot restore set from durable peerAttached so the
// reconnect's peer-state → maybeRestorePeer reattaches the tabs.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the guarantee.

const { PendingInput } = require('../peer-input-queue');
const { versionSeverity, updateApplies, releaseAgeInfo, isHumanPtyInput } = require('../proxy-util');
const { parseDeployLine } = require('../peer-deploy');
const { SEV_LINE } = require('./lib/constants');
const { esc, baseName } = require('./lib/format');
const { wireBulkToggles } = require('./lib/checklists');
const { nextVisibleWithName } = require('./lib/peer-visibility');
const { openUrl: sandboxOpenUrl } = require('./lib/sandbox-view');

function initPeersUi({
  sessions, sessionList, getActiveSession, createTerminal, switchSession,
  removeSession, updateSidebarActive, showToast, appendIpcEntry,
  remeasureReadonlyPeer, peerStatuses, peerTunnels, getOurAppVersion,
  getDeployLineHandlers, proxyState, ctxPct, ctxTokens, peerFilesCount,
  filesUnseen, applyCtxBadge, applyWarmBadge, renderProxyBar, openFilePeek,
  isFilesPopoverForKey, openArgsDialog, openSkillsPopover,
}) {
  // Cached GitHub release list ([{tag, published_at}] newest-first) for the peer
  // identity popover's best-effort age/behind line. Seeded once and refreshed
  // when a popover opens; empty until the first fetch / when offline. The popover
  // never blocks on this — it renders from whatever is cached at open time.
  let releasesCache = [];
  window.api.getReleases().then((r) => { releasesCache = Array.isArray(r) ? r : []; }).catch(() => {});
  const peerBar = document.getElementById('peer-bar');
  // Per-peer visibility selection mirrored from main (peer:visible). No entry for
  // a peer ⇒ show all its sessions; an array (possibly empty) restricts to those
  // names. Kept authoritative-enough for rendering by updating from setVisible
  // responses; seeded once at startup.
  let peerVisibleMap = {};

  // Peers paused via disable (id -> { label }). Populated from config at startup
  // and kept in lockstep with main's `disabled` flag through the peer-disabled
  // broadcast; the disable initiator also sets its entry synchronously before the
  // invoke so the disable-driven peer-removed can be discriminated as a SOFT shed.
  const disabledPeers = new Map();

  // Whether a peer session should be listed under the current selection. No map
  // entry ⇒ everything shows; otherwise only names in the array. Attachment
  // overrides this at the call site (an open tab always renders).
  function peerNameVisible(id, name) {
    const sel = peerVisibleMap[id];
    return !Array.isArray(sel) || sel.includes(name);
  }

  // '@' can't appear in local session names, so keys never collide with them.
  function peerKey(id, name) { return `${name}@${id}`; }

  function peerDisplayHost(st) { return (st && (st.host || st.label)) || 'peer'; }

  // Managed sandbox boxes render distinct from generic peers. A box's peer id IS
  // its box id (sandbox.js registerPeer keys off it), so the box-registry ids ∩
  // peer ids marks them. Cached — renderPeers repaints often, so we never fetch
  // per repaint: seeded once at init and refreshed only when a NEW peer id appears
  // (a box's peer shows up when it's first started) or a peer drops. A changed set
  // triggers one repaint.
  let boxIds = new Set();
  async function refreshBoxIds() {
    let boxes = [];
    try { boxes = await window.api.sandboxListBoxes(); } catch { boxes = []; }
    const next = new Set((boxes || []).map((b) => b && b.id).filter(Boolean));
    const changed = next.size !== boxIds.size || [...next].some((x) => !boxIds.has(x));
    boxIds = next;
    if (changed) renderPeers();
  }
  refreshBoxIds();

  // Open a running box's web UI in the external browser. The effective web port is
  // the bug-#4 source of truth: sandboxStatus(id).ports.web (present only while
  // running). Online-gated at the button, but guard anyway — an online peer whose
  // container is mid-recreate could briefly lack ports.
  async function openBoxWeb(id, label) {
    let st;
    try { st = await window.api.sandboxStatus(id); } catch { st = null; }
    const port = st && st.ports && st.ports.web;
    if (!port) {
      showToast(`${label} isn't serving a web UI yet — start it first.`, { kind: 'warm' });
      return;
    }
    window.api.openExternal(sandboxOpenUrl(port));
  }

  // Rebuild a box straight from its sidebar header (the box "upgrade" affordance —
  // recreate on the current code/image). Mirrors the panel's Rebuild and the peer
  // update flow's toast shape: a start toast, then a completion/failure toast. The
  // recreate blips the container offline→online, which the row reflects as its live
  // busy signal (no persistent strip button to spin). Distinct from the generic
  // restart (bounce the same build); both stay meaningful for a box.
  // Busy-lock: a rebuild is a minutes-long recreate reachable from three places
  // (the Sandboxes panel, the header context menu, and now the ⓘ popover), so a
  // second trigger while one is in flight must no-op rather than stack builds.
  const rebuildingBoxes = new Set();
  async function rebuildBox(id, label) {
    if (rebuildingBoxes.has(id)) return;
    rebuildingBoxes.add(id);
    showToast(`Rebuilding ${label} — this can take a few minutes.`, { kind: 'peer-ui' });
    let res;
    try { res = await window.api.sandboxRebuild(id); } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    finally { rebuildingBoxes.delete(id); }
    if (res && res.ok !== false) {
      showToast(`Rebuilt ${label} on the current code.`, { kind: 'peer-ui' });
    } else {
      showToast(`Rebuild failed on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
    }
  }

  function renderPeers() {
    sessionList.querySelectorAll('[data-peer-ui]').forEach((el) => el.remove());
    for (const [id, st] of peerStatuses) {
      const header = document.createElement('div');
      header.className = 'peer-header';
      header.dataset.peerUi = '1';
      // Offline + a managed tunnel that is itself down usually just means the
      // other laptop is asleep; ssh's last stderr line rides the tooltip so a
      // real misconfig (rejected key, unknown host) is diagnosable.
      const tun = peerTunnels.get(id);
      let stateText = st.online ? '' : 'offline';
      if (!st.online && tun && tun.state === 'down') {
        stateText = 'tunnel down';
        if (tun.error) header.dataset.tip = tun.error;
      }
      // Identity surfacing: an online peer's hello carries version + caps (+ os).
      // Show them in the header tooltip; the version delta tints the peer NAME
      // (below) rather than adding state text — the old 'newer'/'outdated' strings
      // pushed the action icons past the sidebar edge. Severity-driven so the name,
      // the ⓘ icon, and the popover all ride the same class.
      let sev = 'unknown';
      if (st.online && st.version) {
        const capList = (st.caps || []).join(', ') || 'none';
        header.dataset.tip = `Clodex v${st.version} · caps: ${capList}${st.platform ? ` · ${st.platform}` : ''}`;
        if (getOurAppVersion()) sev = versionSeverity(getOurAppVersion(), st.version);
      }
      // Tint the name only when the peer is genuinely BEHIND us (patch/minor/major
      // climb yellow→orange→red). current/newer/unknown leave the name at its
      // normal color — a dim tint on a bold label reads as disabled, and an
      // up-to-date (or ahead) peer's name must never render dimmer than a session
      // row. The ⓘ icon still carries the full-range sev tint (dim suits icon chrome).
      const nameSev = (sev === 'patch' || sev === 'minor' || sev === 'major') ? ` peer-sev-${sev}` : '';
      // Right-aligned host action strip mirrors the header context menu: ＋ new
      // session (create-capable peers only), ↻ restart Clodex, ◎ choose visible
      // sessions (the old ⋯ opener). The first two need the peer online; the eye
      // works offline too (you can still curate which open tabs show).
      const hostLabel = peerDisplayHost(st);
      const canCreate = peerSupportsCreate(st);
      const off = st.online ? '' : 'disabled';
      // Managed sandbox box: a distinct chip before the label, plus a web-open (↗)
      // action for its served UI. The generic dot stays (online/offline is still
      // meaningful for a box); the chip is the "this is a box, not a laptop" mark.
      const isBox = boxIds.has(id);
      header.innerHTML = `<span class="peer-dot ${st.online ? 'online' : ''}"></span>` +
        (isBox ? `<span class="peer-box-chip" data-tip="Managed sandbox" aria-label="Managed sandbox">&#9635;</span>` : '') +
        `<span class="peer-label${nameSev}">${esc(hostLabel)}</span>` +
        `<span class="peer-state">${esc(stateText)}</span>` +
        `<span class="peer-actions">` +
          (canCreate ? `<button class="peer-select peer-new" data-tip="New session on ${esc(hostLabel)}" aria-label="New session on ${esc(hostLabel)}" ${off}>&#65291;</button>` : '') +
          (isBox ? `<button class="peer-select peer-web" data-tip="Open ${esc(hostLabel)}’s web UI" aria-label="Open ${esc(hostLabel)} web UI" ${off}>&#8599;</button>` : '') +
          `<button class="peer-select peer-restart" data-tip="Restart Clodex on ${esc(hostLabel)}" aria-label="Restart Clodex on ${esc(hostLabel)}" ${off}>&#8635;</button>` +
          `<button class="peer-select peer-eye" data-tip="Choose which sessions to show" aria-label="Choose which sessions to show">&#9678;</button>` +
          // ⓘ identity: version/caps/age + Update. Only when the hello gives us an
          // identity to show (online + version) — nothing to surface otherwise.
          ((st.online && st.version) ? `<button class="peer-select peer-info peer-sev-${sev}" data-tip="Peer identity & version" aria-label="Peer identity">&#9432;</button>` : '') +
        `</span>`;
      header.querySelector('.peer-eye').addEventListener('click', (e) => {
        e.stopPropagation();
        openPeerSelectPopover(id, e.currentTarget);
      });
      const infoBtn = header.querySelector('.peer-info');
      if (infoBtn) infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPeerInfoPopover(id, e.currentTarget);
      });
      const newBtn = header.querySelector('.peer-new');
      if (newBtn) newBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPeerSessionDialog(id, hostLabel);
      });
      const webBtn = header.querySelector('.peer-web');
      if (webBtn) webBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openBoxWeb(id, hostLabel);
      });
      header.querySelector('.peer-restart').addEventListener('click', (e) => {
        e.stopPropagation();
        restartPeerHost(id, hostLabel);
      });
      // Right-click the peer header: host-level actions (today just remote
      // restart). Restart is host-scoped, so it lives here, not on a session row.
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        window.api.showPeerHeaderMenu({
          id, label: peerDisplayHost(st), online: !!st.online,
          canCreate: peerSupportsCreate(st),
          // Managed box → the menu offers Rebuild (the strip stays uncrowded; a
          // minutes-long recreate fits the menu next to Restart/Update).
          isBox,
          // sev is in scope from this row's identity block; main gates the Update
          // item on it (updateApplies) so we don't offer a pointless restart to a
          // same-version or ahead peer. 'unknown' (offline / unparseable) keeps it.
          sev,
        });
      });
      sessionList.appendChild(header);

      // Online: the peer's live session list. Offline: only tabs we already
      // have open (so they stay reachable), dimmed.
      // Visibility filter: hide names the user deselected — but an ATTACHED tab
      // always renders (never an invisible open terminal). Offline rows are all
      // attached, so attached-wins covers them; we still run peerNameVisible for
      // uniform shape.
      const rows = (st.online
        ? (st.sessions || []).map((s) => ({ name: s.name, cwd: s.cwd, activity: s.activity, stats: s.stats }))
        : [...sessions.entries()]
            .filter(([, e]) => e.peer && e.peer.id === id)
            .map(([, e]) => ({ name: e.peer.name, cwd: '', activity: 'idle' })))
        .filter((s) => peerNameVisible(id, s.name) || sessions.has(peerKey(id, s.name)));
      for (const s of rows) {
        const key = peerKey(id, s.name);
        const item = document.createElement('div');
        item.className = 'session-item peer-item' + (st.online ? '' : ' peer-offline');
        item.dataset.peerUi = '1';
        item.dataset.name = key;
        item.dataset.activity = s.activity || 'idle';
        if (sessions.has(key)) item.classList.add('attached');
        item.dataset.type = 'remote';
        // Full path feeds the hover card (the row shows only the basename).
        item.dataset.cwd = s.cwd || '';
        const cwdLabel = s.cwd ? esc(baseName(s.cwd)) : '';
        item.innerHTML = `
        <span class="session-chip" data-type="remote">@</span>
        <div class="session-info">
          <div class="session-name">${esc(s.name)}<span class="peer-suffix">@${esc(peerDisplayHost(st))}</span></div>
          <div class="session-meta">
            ${cwdLabel ? `<span class="session-cwd">${cwdLabel}</span>` : ''}
            <span class="session-badges">
              <span class="session-warm"></span>
              <span class="session-ctx"></span>
            </span>
          </div>
        </div>` +
          // Close (detach) only makes sense for an attached tab; unattached rows
          // get no X (it was a dead affordance before).
          (sessions.has(key) ? '<button class="session-close" data-tip="Detach">&times;</button>' : '');
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('session-close')) return;
          openPeerSession(id, s.name);
        });
        // Right-click: native peer-flavored menu (Attach / Take·Release control /
        // Detach / Hide). State is read from entry.peer here — the SAME source the
        // peer bar renders from — so the two control paths can't drift.
        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const entry = sessions.get(key);
          window.api.showPeerContextMenu({
            id, name: s.name,
            online: !!st.online,
            attached: sessions.has(key),
            controlled: !!(entry && entry.peer && entry.peer.controlled),
            holder: (entry && entry.peer && entry.peer.holder) || null,
            canCreate: peerSupportsCreate(st),
            canArgs: peerSupportsArgs(st),
            hostLabel: peerDisplayHost(st),
            type: s.type || null,   // gates the bash-meaningless fresh-reload item
          });
        });
        const closeBtn = item.querySelector('.session-close');
        if (closeBtn) closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // X means "gone": detach AND drop from the visibility selection, so the
          // row leaves the list (same end state as "Hide from list"). The
          // keep-browsing case lives on the context menu ("Detach (keep listed)").
          if (sessions.has(key)) peerHideFromList(id, s.name);
        });
        sessionList.appendChild(item);
        // Badges survive the row rebuild: attached rows are owned by the live
        // telemetry stream (peer-telemetry keeps the maps fresh), unattached
        // ones by the coarser stats riding the peer's session list.
        if (!sessions.has(key) && s.stats && typeof s.stats.ctxPct === 'number') {
          ctxPct.set(key, s.stats.ctxPct);
        }
        const pct = ctxPct.get(key);
        if (typeof pct === 'number') applyCtxBadge(key, pct);
        applyWarmBadge(key);
      }
    }
    // Paused peers have no live status, so they render from config as a dimmed
    // header with a single Resume affordance — no session rows, attach or expand
    // (their tabs were shed on disable). A live status always wins the id, so this
    // only paints genuinely-disconnected paused peers.
    for (const [id, cfg] of disabledPeers) {
      if (peerStatuses.has(id)) continue;
      const hostLabel = cfg.label || id;
      const header = document.createElement('div');
      header.className = 'peer-header peer-header-disabled';
      header.dataset.peerUi = '1';
      header.innerHTML = `<span class="peer-dot"></span>` +
        `<span class="peer-label">${esc(hostLabel)}</span>` +
        `<span class="peer-state">paused</span>` +
        `<span class="peer-actions">` +
          `<button class="peer-select peer-enable" data-tip="Resume ${esc(hostLabel)}" aria-label="Resume ${esc(hostLabel)}">&#9654;</button>` +
        `</span>`;
      header.querySelector('.peer-enable').addEventListener('click', (e) => {
        e.stopPropagation();
        enablePeer(id);
      });
      sessionList.appendChild(header);
    }
    updateSidebarActive();
  }

  // Pause a peer without deleting its config. Mark it locally FIRST (guarding the
  // disable-driven peer-removed's soft-shed discrimination against IPC ordering),
  // then flip the flag in main — the broadcast + reconnect machinery does the rest.
  function disablePeer(id, label) {
    disabledPeers.set(String(id), { label: label || String(id) });
    renderPeers();
    window.api.peerSetDisabled(id, true).catch(() => {});
  }

  // Resume a paused peer. Main re-adds it to the syncs (peer reconnects) and
  // broadcasts peer-disabled(false); the broadcast handler clears the local mark
  // and re-seeds the restore set, so nothing else to do here.
  function enablePeer(id) {
    window.api.peerSetDisabled(id, false).catch(() => {});
  }

  // Create the terminal + attach the peer stream, without stealing focus. Used
  // both by openPeerSession (user click) and the startup auto-restore.
  function attachPeerSession(id, name) {
    const key = peerKey(id, name);
    if (sessions.has(key)) return;
    createTerminal(key, { id, name, controlled: false, cols: null, rows: null, holder: null });
    window.api.peerAttach(id, name);
    renderPeers();
  }

  function openPeerSession(id, name) {
    attachPeerSession(id, name);
    switchSession(peerKey(id, name));
  }

  // One-shot auto-reattach of peer tabs persisted from the previous app run.
  // Seeded once at startup (peer:attachedNames); each peer's names are consumed
  // as its live session list arrives. Present names attach and drop from the
  // pending set; a name still missing once the peer has settled online is
  // genuinely gone and gets forgotten from persistence. Consuming per-name is
  // the "one shot": an attached-then-closed tab leaves the pending set, so a
  // later offline/online blip can't resurrect it.
  const peerRestorePending = new Map(); // peerId -> Set<name> awaiting restore
  const peerRestoreSweep = new Set();   // peerId -> settle sweep already scheduled
  // The first online peer-state fires before the peer's session list is fetched
  // (peer-client sets online, then refreshes), so a name missing on that event
  // may just be un-fetched. Give the refresh a beat before declaring it dead.
  const PEER_RESTORE_SETTLE_MS = 6000;

  // Local mirror of ui-settings.peerControlled, seeded at startup and kept in
  // lockstep with the durable store (which main writes inside peer:control /
  // peer:detach). Read on every reattach replay to decide whether to auto-re-take
  // control — covers both an app restart and a box restart/update, since both
  // funnel a fresh replay through onPeerReplay.
  let peerControlledMap = {};
  function peerControlledHas(id, name) {
    return Array.isArray(peerControlledMap[id]) && peerControlledMap[id].includes(name);
  }
  function rememberControlMirror(id, name) {
    const list = Array.isArray(peerControlledMap[id]) ? peerControlledMap[id] : [];
    if (!list.includes(name)) peerControlledMap[id] = [...list, name];
  }
  function forgetControlMirror(id, name) {
    if (!Array.isArray(peerControlledMap[id])) return;
    const list = peerControlledMap[id].filter((n) => n !== name);
    if (list.length) peerControlledMap[id] = list; else delete peerControlledMap[id];
  }
  // A restore re-acquire found the session held by someone else: drop the mirror
  // AND tell main to forget the durable claim, so the stale claim never re-fires.
  function dropPersistedControl(id, name) {
    forgetControlMirror(id, name);
    window.api.peerForgetControlled(id, name);
  }

  function maybeRestorePeer(id) {
    const pending = peerRestorePending.get(id);
    if (!pending || !pending.size) { peerRestorePending.delete(id); return; }
    const st = peerStatuses.get(id);
    if (!st || !st.online) return;       // wait for the peer to wake
    const live = new Set((st.sessions || []).map((s) => s.name));
    for (const name of [...pending]) {
      if (live.has(name)) { attachPeerSession(id, name); pending.delete(name); }
    }
    if (!pending.size) { peerRestorePending.delete(id); return; }
    // Names still missing: schedule one settle sweep. Live sessions that land in
    // the interim get attached on the next peer-state; whatever's still missing
    // while the peer is online after the sweep is forgotten.
    if (peerRestoreSweep.has(id)) return;
    peerRestoreSweep.add(id);
    setTimeout(() => {
      peerRestoreSweep.delete(id);
      const left = peerRestorePending.get(id);
      if (!left || !left.size) { peerRestorePending.delete(id); return; }
      const cur = peerStatuses.get(id);
      if (!cur || !cur.online) return;   // can't verify while offline — retry on next wake
      peerRestorePending.delete(id);
      const liveNow = new Set((cur.sessions || []).map((s) => s.name));
      for (const name of left) {
        if (liveNow.has(name)) attachPeerSession(id, name);
        else window.api.peerForgetAttached(id, name);
      }
    }, PEER_RESTORE_SETTLE_MS);
  }

  // Control-mode strip above the terminal for the active peer session:
  // read-only by default, explicit Take control to type (and gain resize
  // authority); never both hidden and a peer tab active.
  function renderPeerBar() {
    if (!peerBar) return;
    const main = document.getElementById('main');
    const entry = getActiveSession() ? sessions.get(getActiveSession()) : null;
    if (!entry || !entry.peer) {
      peerBar.classList.add('hidden');
      if (main) main.classList.remove('has-peer-bar');
      return;
    }
    if (main) main.classList.add('has-peer-bar');
    const st = peerStatuses.get(entry.peer.id);
    const online = !!(st && st.online);
    const host = peerDisplayHost(st);
    let stateText, btn = '';
    if (!online) {
      stateText = 'peer offline — reconnecting when it wakes';
    } else if (entry.peer.controlled) {
      stateText = 'you are in control';
      btn = '<button id="peer-control-btn" class="controlling">Release control</button>';
    } else if (entry.peer.holder) {
      stateText = `controlled by ${esc(entry.peer.holder)}`;
      btn = '<button id="peer-control-btn">Take control</button>';
    } else {
      stateText = 'read-only';
      btn = '<button id="peer-control-btn">Take control</button>';
    }
    const errText = entry.peer.controlError
      ? `<span class="peer-bar-error">${esc(entry.peer.controlError)}</span>` : '';
    peerBar.innerHTML =
      `<span class="peer-bar-name">${esc(entry.peer.name)}@${esc(host)}</span>` +
      `<span class="peer-bar-state">${stateText}</span>${errText}${btn}`;
    peerBar.classList.remove('hidden');
    const b = document.getElementById('peer-control-btn');
    if (b) b.addEventListener('click', togglePeerControl);
  }

  function togglePeerControl() {
    const entry = getActiveSession() ? sessions.get(getActiveSession()) : null;
    if (!entry || !entry.peer) return;
    applyPeerControl(entry, !entry.peer.controlled);
  }

  // First data-producing keystroke in a read-only peer tab = intent to type.
  // Buffer the keystroke and, if no acquire is already in flight, kick one; the
  // buffered keys flush in order once control is granted. onData while the acquire
  // is pending appends to the same queue (no second acquire) via the in-flight
  // guard inside PendingInput.
  function typeToTakeControl(key, data) {
    // xterm's onData also carries terminal chatter — mouse reports (the Claude
    // pane enables tracking), focus/query replies — so scroll-reading a read-only
    // peer tab would otherwise STEAL control. Gate on the same classifier the main
    // process uses for human-input detection: only a real keystroke takes control.
    if (!isHumanPtyInput(data)) return;
    const entry = sessions.get(key);
    if (!entry || !entry.peer || entry.peer.controlled) return;
    // Offline peer: nothing to acquire (the bar already says "reconnecting"); a
    // peerControl would just fail. Drop the keystroke silently.
    const st = peerStatuses.get(entry.peer.id);
    if (!st || !st.online) return;
    if (!entry.peer.pendingInput) entry.peer.pendingInput = new PendingInput();
    const kick = entry.peer.pendingInput.offer(data);
    if (kick) applyPeerControl(entry, true, { flush: true });
  }

  // Acquire/release control on a specific peer entry — shared by the peer-bar
  // button, the row context menu, type-to-take, and the restore re-acquire, so
  // all drive the same state transition. `flush` (type-to-take only) flushes the
  // pending-input queue on success and drops it on failure.
  async function applyPeerControl(entry, on, { flush = false, dropOnFail = false } = {}) {
    const { id: peerId, name: peerName } = entry.peer;
    // Coalesce concurrent takes on the same entry (type-to-take vs a reattach
    // re-acquire firing together): the in-flight one owns the outcome.
    if (on && entry.peer._acquiring) return;
    // Any fresh attempt clears a stale error banner.
    clearPeerControlError(entry.peer);
    if (on) entry.peer._acquiring = true;
    let res;
    // try/catch/finally: an invoke rejection must land in the normal failure
    // branch below (banner + pendingInput.reset) — letting it propagate would
    // skip the reset and wedge pendingInput.acquiring true, the same silent
    // type-to-take deadlock the unconditional reset exists to prevent. The
    // finally keeps the coalesce guard from wedging either way.
    try {
      res = await window.api.peerControl(peerId, peerName, on);
    } catch (e) {
      res = { ok: false, error: (e && e.message) || 'control request failed' };
    } finally {
      if (on) entry.peer._acquiring = false;
    }
    if (on) {
      if (res && res.ok) {
        entry.peer.controlled = true;
        // Control mode carries resize authority: fit to our pane and push it.
        entry.fitAddon.fit();
        window.api.peerResize(peerId, peerName, entry.terminal.cols, entry.terminal.rows);
        entry.terminal.focus();
        // Flush anything typed during the acquire, in order.
        if (entry.peer.pendingInput) {
          const buffered = entry.peer.pendingInput.drain();
          if (buffered) window.api.peerInput(peerId, peerName, buffered);
        }
        rememberControlMirror(peerId, peerName);   // main persisted via peer:control
      } else {
        // Acquire failed or (with the pre-fix socket-starvation bug) timed out.
        // Never silent: show a transient banner instead of snapping back to a
        // "Take control" button that looks like nothing happened.
        setPeerControlError(entry.peer, (res && res.error) || 'could not take control');
        // Reset UNCONDITIONALLY (not just on flush): a keystroke can land during a
        // restore re-acquire (flush:false) via the coalesce guard, setting
        // pendingInput.acquiring=true. If THIS failing call doesn't clear it,
        // acquiring stays true forever and every later keystroke buffers with
        // kick=false, silently killing type-to-take on the tab. Mirrors the
        // success path's unconditional drain.
        if (entry.peer.pendingInput) entry.peer.pendingInput.reset(); // drop buffer
        // Restore re-acquire that lost to another holder: drop the stale claim so
        // it doesn't retry-loop on every future reconnect.
        if (dropOnFail) dropPersistedControl(peerId, peerName);
      }
    } else {
      entry.peer.controlled = false;
      forgetControlMirror(peerId, peerName);       // main forgot via peer:control
    }
    renderPeerBar();
  }

  // Row context-menu actions from main. Verbs mirror the peer-bar's state
  // transitions plus attach/detach/hide; taking control from an unattached row
  // attaches first so it's one gesture.
  // Host-level remote restart of the whole Clodex on a peer box. Shared by the
  // header ↻ icon and the right-click header menu's 'restart' action so the
  // confirm → fire → toast flow can't drift. `label` is the peer's display host.
  // The peer drops offline and the existing reconnect/auto-reattach brings it
  // back — no special reconnect logic. Failures (connection/timeout) surface as a
  // calm toast, never a retry. Authority is the tunnel (settled model); the
  // confirm is the intentionality gate.
  async function restartPeerHost(id, label) {
    const okToGo = await window.api.confirmPeerRestart(label);
    if (!okToGo) return;
    await doPeerRestart(id, label);
  }

  // Restart core minus its own confirm — shared by the header ↻ (which confirms)
  // and the update-in-place flow (which already confirmed the whole update, so a
  // second dialog on success would be redundant).
  async function doPeerRestart(id, label) {
    const res = await window.api.peerRestart(id);
    if (res && res.ok) {
      showToast(`Restarting Clodex on ${label} — it will reconnect shortly.`, { kind: 'peer-ui' });
    } else {
      showToast(`Restart failed on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
    }
  }

  // "Update Clodex on <box>…": re-run the idempotent deploy script over ssh, then
  // restart the box on ::done so it picks up the new build. Progress surface is
  // deliberately small: a start toast, a completion/failure toast, and the stderr
  // tail in the ipc-log on failure (the peers dialog's live step-list is for the
  // install-from-scratch wizard; a header-menu update has no row to stream into).
  async function updatePeerHost(id, label, sshHost, port, folder) {
    const go = await window.api.confirmPeerUpdate(label);
    if (!go) return;
    showToast(`Updating Clodex on ${label} — this can take a few minutes.`, { kind: 'peer-ui' });
    let sawDone = false;
    const failReasons = [];
    getDeployLineHandlers().set(sshHost, (line) => {
      const ev = parseDeployLine(line);
      if (ev.type === 'done') sawDone = true;
      else if (ev.type === 'fail') failReasons.push(ev.reason ? `${ev.name} — ${ev.reason}` : ev.name);
    });
    let res;
    // folder reuses the peer's persisted deployFolder (main resolved it from
    // config) so an update targets the same install dir as the original deploy.
    try { res = await window.api.peerDeploy(sshHost, { port, folder }); }
    catch (e) { res = { ok: false, error: (e && e.message) || 'deploy failed' }; }
    getDeployLineHandlers().delete(sshHost);
    if (res && res.ok && sawDone) {
      showToast(`Clodex updated on ${label} — restarting to apply.`, { kind: 'peer-ui' });
      await doPeerRestart(id, label);
      return;
    }
    const why = res && res.needSudo ? 'needs sudo on the peer'
      : res && res.timedOut ? 'timed out'
      : failReasons.length ? failReasons.join('; ')
      : (res && res.error) ? res.error
      : `exit ${res ? res.code : '?'}`;
    showToast(`Update failed on ${label}: ${why}`, { kind: 'warm' });
    const detail = (res && res.stderr) ? res.stderr : (res && res.error) || 'no detail';
    appendIpcEntry({ from: 'deploy', to: label, body: `update failed (${why})\n${detail}` });
  }

  window.api.onPeerContextAction(async ({ action, id, name, sshHost, port, folder }) => {
    const key = peerKey(id, name);
    switch (action) {
      case 'attach':
        openPeerSession(id, name);
        break;
      case 'takeControl': {
        if (!sessions.has(key)) openPeerSession(id, name); else switchSession(key);
        const entry = sessions.get(key);
        if (entry && entry.peer && !entry.peer.controlled) await applyPeerControl(entry, true);
        break;
      }
      case 'releaseControl': {
        const entry = sessions.get(key);
        if (entry && entry.peer && entry.peer.controlled) await applyPeerControl(entry, false);
        break;
      }
      case 'detach':
        if (sessions.has(key)) { removeSession(key); renderPeers(); }
        break;
      case 'hide':
        await peerHideFromList(id, name);
        break;
      case 'restart':
        // Host-level remote restart. `name` carries the peer's display label here
        // (the header menu has no session). Shared with the header ↻ icon.
        await restartPeerHost(id, name || 'peer');
        break;
      case 'rebuild':
        // Managed box: recreate on the current code/image (the "upgrade" op). Only
        // offered for box peers (main gates the item on isBox). `name` is the label.
        await rebuildBox(id, name || 'sandbox');
        break;
      case 'newSession':
        // `name` carries the peer's display label here (header menu, no session).
        openPeerSessionDialog(id, name || 'peer');
        break;
      case 'update':
        // Host-level in-place update — re-run the deploy script over ssh, restart
        // on success. `name` is the display label; sshHost/port/folder ride the
        // message (main resolved them from the peer config, url-only peers never
        // get here).
        await updatePeerHost(id, name || 'peer', sshHost, port, folder);
        break;
      case 'editArgs': {
        // Edit Session on a peer — reuse the local dialog with a peer data source
        // (fetch args + box catalogs, save the patch, reattach on restart-to-apply).
        const st = peerStatuses.get(id);
        openArgsDialog(name, peerArgsSource(id, name, peerDisplayHost(st)));
        break;
      }
      case 'editSkills': {
        // Edit Skills on a peer — reuse the local Skills popover with a peer source
        // (fetch the box's catalog, persist the disabled/inject sets, fresh-restart
        // + reattach to apply now). Anchored to the sidebar ROW (no ⚙ button here).
        const st = peerStatuses.get(id);
        const anchor = sessionList.querySelector(`[data-name="${CSS.escape(key)}"]`) || sessionList;
        openSkillsPopover(name, anchor, peerSkillsSource(id, name, peerDisplayHost(st)));
        break;
      }
      case 'restartRemote':
        // Plain host-level restart of a peer SESSION (--resume, keeps history).
        // No confirm — parity with the local plain restart.
        await restartPeerSessionWithReattach(id, name, false);
        break;
      case 'reloadRemote': {
        // Fresh reload of a peer session (new conversation, re-reads skills). Native
        // confirm mirroring doHardRestart — this drops the live conversation.
        const st = peerStatuses.get(id);
        const label = peerDisplayHost(st);
        if (!await window.api.confirmPeerReload(name, label)) break;
        await restartPeerSessionWithReattach(id, name, true);
        break;
      }
      case 'killRemote': {
        // Destructive host-level kill on the peer. Native confirm (intentionality),
        // then the endpoint; the owner's notifySessions fan-out refreshes the list,
        // so no local list surgery — just report the ack. Detach our local tab if
        // we had one open (the session it mirrored is gone).
        const st = peerStatuses.get(id);
        const label = peerDisplayHost(st);
        const okToGo = await window.api.confirmPeerKill(name, label);
        if (!okToGo) break;
        const res = await window.api.peerKillSession(id, name);
        if (res && res.ok) {
          const key = peerKey(id, name);
          if (sessions.has(key)) removeSession(key);
          showToast(`Killed "${name}" on ${label}.`, { kind: 'peer-ui' });
        } else {
          showToast(`Kill failed for "${name}" on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
        }
        break;
      }
    }
  });

  // New-session-on-a-peer dialog. Minimal (name/type/cwd) — the full new-session
  // dialog's fields (prompts/skills/tools/agents/dir-picker) are local-only and
  // don't travel to a remote fs. Errors surface INLINE (the owner's create ack is
  // the only signal — the viewer can't see the box's dialogs). On success the
  // owner's notifySessions refreshes the peer's session list; we just close.
  let peerSessionDialogTarget = null; // { id, label }
  function openPeerSessionDialog(id, label) {
    peerSessionDialogTarget = { id, label };
    const overlay = document.getElementById('peer-session-overlay');
    document.getElementById('peer-session-title').textContent = `New Session on ${label}`;
    document.getElementById('peer-input-name').value = '';
    document.getElementById('peer-input-type').value = 'claude';
    document.getElementById('peer-input-cwd').value = '';
    const err = document.getElementById('peer-session-error');
    err.style.display = 'none';
    err.textContent = '';
    overlay.classList.remove('hidden');
    document.getElementById('peer-input-name').focus();
  }
  function closePeerSessionDialog() {
    peerSessionDialogTarget = null;
    document.getElementById('peer-session-overlay').classList.add('hidden');
  }
  async function submitPeerSessionDialog() {
    if (!peerSessionDialogTarget) return;
    const { id, label } = peerSessionDialogTarget;
    const err = document.getElementById('peer-session-error');
    const showErr = (m) => { err.textContent = m; err.style.display = 'block'; };
    const name = document.getElementById('peer-input-name').value.trim();
    const type = document.getElementById('peer-input-type').value;
    const cwd = document.getElementById('peer-input-cwd').value.trim();
    if (!name) return showErr('Name is required.');
    if (!cwd) return showErr('Working directory is required.');
    const btn = document.getElementById('peer-session-create');
    btn.disabled = true;
    const res = await window.api.peerCreateSession(id, { name, type, cwd });
    btn.disabled = false;
    if (res && res.ok) {
      closePeerSessionDialog();
      // Owner's notifySessions fan-out refreshes the list; but if this peer's
      // visible set is materialized the new name isn't in it — ensure it shows.
      // Generic peers keep no-attach semantics: surface it, don't open it.
      await ensurePeerSessionVisible(id, res.name || name);
      showToast(`Created "${res.name}" (${res.type}) on ${label}.`, { kind: 'peer-ui' });
    } else {
      showErr((res && res.error) || 'create failed — no response');
    }
  }
  document.getElementById('peer-session-cancel').addEventListener('click', closePeerSessionDialog);
  document.getElementById('peer-session-create').addEventListener('click', submitPeerSessionDialog);
  document.getElementById('peer-session-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'peer-session-overlay') closePeerSessionDialog();
  });
  document.getElementById('peer-session-dialog').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submitPeerSessionDialog(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePeerSessionDialog(); }
  });

  // Remove one session from the peer's visible selection (context-menu "Hide from
  // list"). Mirrors the peer-select popover's semantics: no selection yet ⇒
  // materialize an explicit all-known-minus-this list; an existing selection ⇒
  // drop the name. Pairs with Apply-detaches — a hidden attached tab is detached
  // too, so "hidden" always means "gone from the sidebar".
  async function peerHideFromList(id, name) {
    const st = peerStatuses.get(id);
    const sel = peerVisibleMap[id];
    let next;
    if (Array.isArray(sel)) {
      next = sel.filter((n) => n !== name);
    } else {
      const liveNames = st && st.online ? (st.sessions || []).map((s) => s.name) : [];
      const attachedNames = [...sessions.entries()]
        .filter(([, e]) => e.peer && e.peer.id === id).map(([, e]) => e.peer.name);
      next = [...new Set([...liveNames, ...attachedNames])].filter((n) => n !== name);
    }
    const res = await window.api.peerSetVisible(id, next);
    if (res && res.ok) peerVisibleMap = res.peerVisible || {};
    const key = peerKey(id, name);
    if (sessions.has(key)) removeSession(key);
    renderPeers();
  }

  // Ensure a just-created peer session is visible in the sidebar. Once a peer's
  // visible set is materialized (any row hidden ⇒ explicit whitelist), a session
  // created afterward isn't in the array and never renders until eye-toggled.
  // No-op when the selection is unmaterialized (shows all already) or already
  // includes the name; otherwise append + persist, mirroring peerHideFromList's
  // peerSetVisible + res.peerVisible handling. Attachment overrides visibility at
  // the render call site, but this keeps the row present if the tab is later
  // detached, and is the ONLY thing that surfaces a no-attach generic-peer create.
  async function ensurePeerSessionVisible(id, name) {
    const next = nextVisibleWithName(peerVisibleMap[id], name);
    if (!next) return;
    const res = await window.api.peerSetVisible(id, next);
    if (res && res.ok) peerVisibleMap = res.peerVisible || {};
    renderPeers();
  }

  // Transient control-error banner on a peer entry. Auto-clears so it never
  // sticks past the moment; re-renders the bar if the session is still active.
  function setPeerControlError(peer, msg) {
    peer.controlError = msg;
    clearTimeout(peer.controlErrorTimer);
    peer.controlErrorTimer = setTimeout(() => {
      peer.controlError = null;
      peer.controlErrorTimer = null;
      const cur = getActiveSession() ? sessions.get(getActiveSession()) : null;
      if (cur && cur.peer === peer) renderPeerBar();
    }, 4000);
  }

  function clearPeerControlError(peer) {
    peer.controlError = null;
    clearTimeout(peer.controlErrorTimer);
    peer.controlErrorTimer = null;
  }

  window.api.onPeerState((id, status) => {
    // A newly-appeared peer might be a box's peer (first Start) — refresh the box-id
    // cache once so the row can render its box chip/actions. refreshBoxIds repaints
    // only if the set actually changed, so a plain generic-peer connect costs one
    // cheap listBoxes and no extra render.
    const isNewPeer = !peerStatuses.has(id);
    peerStatuses.set(id, status);
    renderPeers();
    renderPeerBar();
    maybeRestorePeer(id);
    if (isNewPeer && !boxIds.has(id)) refreshBoxIds();
  });

  window.api.onPeerActivity((id, name, state) => {
    const el = sessionList.querySelector(`[data-name="${CSS.escape(peerKey(id, name))}"]`);
    if (el) el.dataset.activity = state;
  });

  // Fresh replay = fresh terminal: raw-byte history is not exact terminal
  // state, so reset before applying (also runs after every reconnect).
  window.api.onPeerReplay((id, name, info) => {
    const entry = sessions.get(peerKey(id, name));
    if (!entry) return;
    entry.peer.cols = info.cols; entry.peer.rows = info.rows;
    entry.peer.holder = info.holder || null;
    entry.peer.controlled = false;   // control never survives a (re)attach
    entry.terminal.reset();
    if (info.cols && info.rows) entry.terminal.resize(info.cols, info.rows);
    if (info.data && info.data.length) entry.terminal.write(info.data);
    renderPeerBar();
    // Reconnect replay into the ALREADY-active tab fires no switchSession, so the
    // one place that re-measures a read-only peer never runs — a pane whose
    // geometry shifted during the offline window keeps a stale letterbox until
    // the next manual switch heals it. Re-measure here too when this is the
    // active tab (inactive tabs are covered by the switch-on-activate path).
    if (peerKey(id, name) === getActiveSession() && !entry.peer.controlled) {
      remeasureReadonlyPeer(entry);
    }
    // Control persistence: this reattach replay just reset us to read-only. If the
    // tab is persisted as controlled, re-take control now that the replay has
    // settled — covers an app restart (restored attach → first replay) AND a box
    // restart/update (reconnect replay on an already-open tab). On failure
    // (held by someone else) applyPeerControl shows the banner and dropOnFail
    // sheds the stale claim so it never retry-loops.
    if (peerControlledHas(id, name) && !entry.peer.controlled) {
      applyPeerControl(entry, true, { dropOnFail: true });
    }
  });

  window.api.onPeerData((id, name, data) => {
    const entry = sessions.get(peerKey(id, name));
    if (entry) entry.terminal.write(data);
  });

  // Owner PTY resized: follow its geometry live so new output stops rendering
  // into a stale letterbox. Owner geometry is canonical even in control mode —
  // a controlling viewer's own resize echoes back the same (or PTY-clamped) dims,
  // and applying them is an idempotent resize-in-place, never a feedback loop
  // (viewers push geometry only on explicit fit, not on an applied resize).
  window.api.onPeerResize((id, name, geom) => {
    const entry = sessions.get(peerKey(id, name));
    if (!entry || !entry.peer) return;
    if (!(geom.cols > 0 && geom.rows > 0)) return;
    entry.peer.cols = geom.cols; entry.peer.rows = geom.rows;
    if (entry.terminal.cols !== geom.cols || entry.terminal.rows !== geom.rows) {
      entry.terminal.resize(geom.cols, geom.rows);
    }
  });

  // Owner-initiated UI mirroring: the owner surfaced a session-scoped component
  // (a remote agent's [agent:file view], today) and wants attached viewers to
  // render their own copy. The event carries only a small {kind, args} trigger —
  // content is pulled locally through popoverApi (the query RPC), so it stays on
  // the owner's vetted path. Kinds are dispatched through a registry so new
  // mirrorable components are one entry, not new plumbing.
  //
  // Intrusiveness gate: a remote agent must NOT be able to slam a full-screen
  // modal over whatever the operator is doing in another tab. So a mirrored
  // component renders immediately ONLY when its peer tab is the active one;
  // otherwise it becomes an unobtrusive, session-scoped toast whose click
  // switches to that tab and then renders. `present` is the "act now" path,
  // `announce` the deferred one — every kind supplies both.
  const PEER_UI_KINDS = {
    fileView: {
      label: 'shared a file',
      detail: (args) => (args && args.path ? args.path.split('/').pop() : 'a file'),
      present: (key, args) => { if (args && args.path) openFilePeek(key, args.path); },
    },
  };

  window.api.onPeerUi((id, name, evt) => {
    const key = peerKey(id, name);
    if (!sessions.has(key)) return;             // only attached viewers act
    const spec = evt && PEER_UI_KINDS[evt.kind];
    if (!spec) return;                          // unknown/stale kind — ignore gracefully
    const args = evt.args || {};
    if (getActiveSession() === key) { spec.present(key, args); return; }
    // Not looking at that tab: announce, don't intrude. Click switches + renders.
    const disp = `${name}@${peerDisplayHost(peerStatuses.get(id))}`;
    showToast(`${disp}: ${spec.label} — ${spec.detail(args)}`, {
      kind: 'peer-ui',
      onClick: () => { if (sessions.has(key)) { switchSession(key); spec.present(key, args); } },
    });
  });

  // Status-bar telemetry for an attached peer session, streamed from the
  // owner's poll (plus a seed frame right behind the replay). Feeding it into
  // proxyState / the ctx maps under the peer key makes renderProxyBar, the
  // warmth badge, and the 1s countdown tick render it natively. The owner
  // ships an info-only view (no base/capabilities/sessionId), so every
  // owner-local control (keep-warm, strip, popovers, wirescope link) degrades
  // to plain text here instead of firing at endpoints that only exist on the
  // owner's machine. Partial frames: {proxy} rides the poll, {ctx} the
  // statusline side-channel — merge, don't replace.
  window.api.onPeerTelemetry((id, name, tele) => {
    const key = peerKey(id, name);
    if (!sessions.has(key)) return;
    if (tele.proxy) {
      proxyState.set(key, { payload: tele.proxy, at: Date.now() });
      applyWarmBadge(key);
    }
    if (tele.ctx && typeof tele.ctx.pct === 'number') {
      ctxPct.set(key, tele.ctx.pct);
      if (tele.ctx.tok > 0 && tele.ctx.size > 0) {
        ctxTokens.set(key, { used: tele.ctx.tok, size: tele.ctx.size });
      }
      applyCtxBadge(key, tele.ctx.pct);
    }
    // Touched-files count: owner pushes this only when the count changes (and
    // seeds it once on attach). Latch the unseen highlight only on an INCREASE
    // over a known prior count — the attach seed sets the baseline silently, a
    // later bump lights the badge. Suppressed while its popover is open (that's
    // "seeing" it). Mirrors the local session-files path.
    let filesGrew = false;
    if (tele.files && typeof tele.files.count === 'number') {
      const prev = peerFilesCount.get(key);
      peerFilesCount.set(key, tele.files.count);
      const watching = isFilesPopoverForKey(key);
      if (prev !== undefined && tele.files.count > prev && !watching) {
        filesUnseen.add(key);
        filesGrew = true;
      }
    }
    if (key === getActiveSession()) {
      renderProxyBar();
      // One-shot pulse on the freshly-rebuilt button (imperative, dies with the
      // node) — same treatment as an arriving local file touch.
      if (filesGrew) {
        const btn = document.querySelector('#proxy-actions [data-act="files"]');
        if (btn) btn.classList.add('px-files-flash');
      }
    }
  });

  window.api.onPeerControlChange((id, name, holder) => {
    const entry = sessions.get(peerKey(id, name));
    if (!entry) return;
    const st = peerStatuses.get(id);
    entry.peer.holder = holder;
    // Our client label on that peer is `peer:<label>` (peer-client.js).
    const mine = !!(holder && st && holder === `peer:${st.label}`);
    entry.peer.controlled = mine;
    renderPeerBar();
  });

  window.api.onPeerExit((id, name) => {
    removeSession(peerKey(id, name));
    renderPeers();
  });

  window.api.onPeerTunnel((id, status) => {
    peerTunnels.set(id, status);
    renderPeers();
  });

  window.api.onPeerRemoved((id) => {
    peerStatuses.delete(id);
    peerTunnels.delete(id);
    // A disabled peer's removal is a PAUSE, not a delete: soft-shed its tabs so the
    // durable attachment survives for re-enable. A genuine removal/URL-edit (not in
    // disabledPeers) still hard-detaches — that path's durable-forget is correct.
    const soft = disabledPeers.has(String(id));
    for (const [key, entry] of [...sessions.entries()]) {
      if (entry.peer && entry.peer.id === id) removeSession(key, { keepPersisted: soft });
    }
    renderPeers();
  });

  // Peer paused/resumed from any window (main flips `disabled` + broadcasts this
  // BEFORE re-running the syncs, so it lands ahead of the peer-removed it triggers).
  window.api.onPeerDisabled((id, on, label) => {
    id = String(id);
    if (on) {
      disabledPeers.set(id, { label: label || id });
      // Tabs are shed by the peer-removed that follows in main; discrimination
      // happens there via disabledPeers.has(id).
    } else {
      disabledPeers.delete(id);
      // Re-seed the one-shot restore set from durable truth so the reconnect's
      // peer-state → maybeRestorePeer reattaches the tabs. Set-union is idempotent
      // with any names a startup-disabled seed already left pending.
      window.api.peerAttachedNames().then((map) => {
        const names = (map && map[id]) || [];
        if (!Array.isArray(names) || !names.length) return;
        const pending = peerRestorePending.get(id) || new Set();
        for (const n of names) pending.add(n);
        peerRestorePending.set(id, pending);
        maybeRestorePeer(id);   // in case the peer is already back online
      }).catch(() => {});
    }
    renderPeers();
  });

  // Owner side: one of OUR sessions is being viewed/driven from a peer —
  // flag its tab so remote control is never silent.
  window.api.onSessionPeerControl((name, holder) => {
    const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    if (!el) return;
    // The holder name surfaces in the hover card (via dataset) and the
    // [remote] name marker (CSS on data-remote-control) — no native title.
    if (holder) el.dataset.remoteControl = holder;
    else delete el.dataset.remoteControl;
  });

  // Seed peer list on startup (peer-state events keep it fresh afterwards).
  window.api.peerList().then((statuses) => {
    for (const st of statuses || []) {
      peerStatuses.set(st.id, st);
      if (st.tunnel) peerTunnels.set(st.id, st.tunnel);
    }
    if (peerStatuses.size) renderPeers();
  }).catch(() => {});

  // Seed the one-shot restore map from persisted attachments. peer-state events
  // may land before or after this resolves: if before, the peer is already in
  // peerStatuses and we kick its restore here; if after, its peer-state handler
  // finds the seeded pending entry. Either order restores exactly once.
  window.api.peerAttachedNames().then((map) => {
    for (const [id, names] of Object.entries(map || {})) {
      if (Array.isArray(names) && names.length) peerRestorePending.set(id, new Set(names));
    }
    for (const id of [...peerRestorePending.keys()]) maybeRestorePeer(id);
  }).catch(() => {});

  // Seed the per-peer visibility selection; peer-state events after this just
  // re-render against the local copy (kept fresh from peerSetVisible responses).
  window.api.peerVisible().then((map) => {
    peerVisibleMap = map || {};
    if (peerStatuses.size) renderPeers();
  }).catch(() => {});

  // Seed the control-restore mirror. Kept fresh locally from applyPeerControl /
  // removeSession; on each reattach replay a persisted entry auto-re-takes.
  window.api.peerControlledNames().then((map) => {
    peerControlledMap = map || {};
  }).catch(() => {});

  // Seed the paused-peer set from config so a peer disabled in a previous session
  // renders as a dimmed "paused" header (it has no live status to arrive) and any
  // stray peer-removed for it is discriminated as a soft shed. Kept fresh after
  // this by the peer-disabled broadcast.
  window.api.getSettings().then((s) => {
    for (const p of (s && s.peers) || []) {
      if (p.disabled) disabledPeers.set(String(p.id), { label: p.label || String(p.id) });
    }
    if (disabledPeers.size) renderPeers();
  }).catch(() => {});

  // Peer advertises remote session create/kill (the 'create' cap covers both).
  // Older peers 501 the endpoints, so the viewer hides the affordances.
  function peerSupportsCreate(st) {
    return !!(st && Array.isArray(st.caps) && st.caps.includes('create'));
  }

  // Peer advertises remote session config editing (the 'args' cap — Edit Session).
  // Phase 2's skills editing will ride the same cap. Old boxes 501 the endpoints,
  // so the viewer hides the "Edit Session…" affordance.
  function peerSupportsArgs(st) {
    return !!(st && Array.isArray(st.caps) && st.caps.includes('args'));
  }

  // Restart a PEER session in place and keep our attached tab live on the fresh
  // process — the peer analogue of restartSessionWithReattach. The owner kills the
  // old PTY (which sends an SSE `exit` that tears our tab down via onPeerExit, also
  // fully detaching the peer-client attachment) and respawns the SAME name, so we
  // re-open the attach afterward. The exit event and the restart ack race across
  // two transports; the ack resolves only after the owner's respawn completes, and
  // the exit (sent at kill time) normally lands first, so by the time we're here
  // the tab is already gone. We still poll briefly for the teardown to settle
  // before re-opening, so we never attach onto a tab the exit is about to remove.
  // (If the exit is somehow missed, the stream-close reconnect in peer-client
  // heals it instead — belt and suspenders.)
  // Re-open our attached tab on a freshly-respawned peer session. The owner's
  // kill sends an SSE `exit` that tears the tab down (onPeerExit); we poll briefly
  // for that teardown to settle, then re-attach, so we never re-open onto a tab the
  // exit is about to remove. Shared by restartPeerSessionWithReattach (remote
  // restart/reload) and the Edit Session save (restart-to-apply on a peer). If the
  // exit is somehow missed, peer-client's stream-close reconnect heals it instead.
  function reattachPeerSession(id, name) {
    const key = peerKey(id, name);
    let tries = 20;             // ~2s at 100ms — the exit-driven teardown window
    const reattach = () => {
      if (!sessions.has(key)) { openPeerSession(id, name); return; }
      if (tries-- <= 0) return; // teardown never came; auto-reconnect covers it
      setTimeout(reattach, 100);
    };
    reattach();
  }

  // Data source for editing a PEER session in the shared Edit Session dialog:
  // read args + box catalogs, save the patch, reattach after a restart. wasAttached
  // is captured at save time (the box hasn't killed the PTY yet) so a restart-to-
  // apply only re-opens a tab that was actually open. onRestarted runs only when
  // the save reports restarted:true.
  function peerArgsSource(id, name, label) {
    const key = peerKey(id, name);
    let wasAttached = false;
    return {
      fetch: async () => {
        // Pull the box's editable args and, in parallel, its skill catalog — the
        // Edit Session dialog now hosts a peer-only Skills section (skills editing
        // folded in here instead of a separate popover). Both read the box's own
        // truth (its catalog/library), never local. The skill fetch is best-effort:
        // a non-Claude session or an older box just yields no section.
        const [r, sc] = await Promise.all([
          window.api.peerSessionArgs(id, name),
          window.api.peerSkillCatalog(id, name).catch(() => null),
        ]);
        if (!r || !r.ok) return r || { ok: false, error: `Session "${name}" not found on ${label}.` };
        const cat = r.catalogs || {};
        // Normalize to openArgsDialog's data slots. settings mirrors the getSettings
        // fields the dialog reads (claudeTools + proxy default) from the BOX, never
        // local. skillCatalog is the readSkillCatalog shape (names/disabledSkills/
        // effective/skillLib/injectSkills) or null when unavailable.
        return {
          ok: true,
          res: r,
          settings: { claudeTools: cat.claudeTools || [], proxyUrl: cat.proxyUrl, proxyEnabled: cat.proxyEnabled },
          promptLib: cat.prompts || [],
          agentLib: cat.agents || [],
          skillCatalog: (sc && sc.ok) ? sc : null,
        };
      },
      // The dialog hands us the args patch plus (for a Claude peer) disabledSkills/
      // injectSkills. Skills are roster-frozen on the box (fixed at conversation
      // creation), so a plain box-side resume restart wouldn't re-read them — the
      // exact reason the old Skills popover used a FRESH restart. So when skills ride
      // along we persist args WITHOUT the box restart, persist skills separately,
      // and (if the user asked to apply now) do a fresh restart + reattach here,
      // which re-reads args AND the skill roster. A non-skills peer edit keeps the
      // box-side resume restart (history-preserving) as before.
      save: async (patch) => {
        wasAttached = sessions.has(key);
        const { disabledSkills, injectSkills, restart, ...argsPatch } = patch || {};
        const hasSkills = disabledSkills !== undefined;
        const r = await window.api.peerSetSessionArgs(id, name, { ...argsPatch, restart: hasSkills ? false : restart });
        if (!r || !r.ok) return r;
        if (hasSkills) {
          const rs = await window.api.peerSetSessionSkills(id, name, disabledSkills, injectSkills);
          if (!rs || !rs.ok) return rs;
        }
        // Fresh restart is the only kind that applies the Claude roster (skills/
        // agents/tools). Confirm the history-clearing reload, then reattach through
        // the shared helper (which toasts + reattaches). Returning restarted:false
        // keeps the generic handler from double-reattaching via onRestarted.
        if (hasSkills && restart) {
          if (!await window.api.confirmPeerReload(name, label)) return { ok: true, restarted: false };
          await restartPeerSessionWithReattach(id, name, true);
          return { ok: true, restarted: false };
        }
        return { ok: true, restarted: !!(restart && r.restarted) };
      },
      onRestarted: () => { if (wasAttached) reattachPeerSession(id, name); },
    };
  }

  // Data source for editing a PEER session in the shared Skills popover: read the
  // box's skill catalog, persist the disabled/inject sets, and (when the user asks
  // to apply now) do the box's FRESH restart + reattach via the existing helper —
  // which already toasts and reattaches, so no tail duplication here. The catalog
  // shape (names/effective/skillLib/injectSkills) is identical to the local one, so
  // the popover's render/collect code is unchanged.
  function peerSkillsSource(id, name, label) {
    return {
      fetch: async () => {
        const r = await window.api.peerSkillCatalog(id, name);
        return (r && r.ok) ? r : (r || { ok: false, error: `Session "${name}" not found on ${label}.` });
      },
      save: ({ disabledSkills, injectSkills }) =>
        window.api.peerSetSessionSkills(id, name, disabledSkills, injectSkills),
      restartFresh: () => restartPeerSessionWithReattach(id, name, true),
    };
  }

  async function restartPeerSessionWithReattach(id, name, fresh) {
    const key = peerKey(id, name);
    const st = peerStatuses.get(id);
    const label = peerDisplayHost(st);
    const wasAttached = sessions.has(key);
    const res = await window.api.peerRestartSession(id, name, { fresh: !!fresh });
    if (!res || !res.ok) {
      showToast(`${fresh ? 'Reload' : 'Restart'} failed for "${name}" on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
      return;
    }
    showToast(`${fresh ? 'Reloaded' : 'Restarted'} "${name}" on ${label}.`, { kind: 'peer-ui' });
    if (!wasAttached) return;   // wasn't showing it — nothing to reattach
    reattachPeerSession(id, name);
  }

  // The `⚙ Edit session` button on a PEER session's proxy bar. It opens the shared
  // Edit Session dialog fed by a peer data source (peerArgsSource) — the same path
  // the row's right-click "Edit Session…" uses, so the two can't drift. Skills fold
  // INTO that dialog (a peer-only section there), so a single button covers all the
  // remote config a viewer can edit — no dropdown. Caps ride the hello
  // (peerStatuses), never the telemetry payload (which carries none by design), and
  // the button's own gate (activePeerConfigurable in core) already required the
  // 'args' cap + online, so this just opens.
  function openPeerArgs(key) {
    const entry = key ? sessions.get(key) : null;
    if (!entry || !entry.peer) return;
    const { id, name } = entry.peer;
    const st = peerStatuses.get(id);
    if (!st || !st.online || !peerSupportsArgs(st)) return;
    openArgsDialog(name, peerArgsSource(id, name, peerDisplayHost(st)));
  }

  // --- Per-peer session visibility popover ---------------------------------
  // Clones the tools-popover idiom: a checklist of the peer's sessions, checked =
  // currently shown. No map entry ⇒ every session shown (all checked). Applying
  // with every LIVE name checked and no known-but-gone name unchecked collapses
  // back to show-all (peerSetVisible null); otherwise the checked set is stored.
  // Gone names (in the map but not currently live) are listed dimmed so a
  // temporarily-down session isn't silently dropped just by opening + applying.
  const peerSelectPopover = document.getElementById('peer-select-popover');
  const peerSelectPopoverName = document.getElementById('peer-select-popover-name');
  const peerSelectList = document.getElementById('peer-select-list');
  wireBulkToggles(peerSelectPopover, peerSelectList);

  function closePeerSelectPopover() {
    peerSelectPopover.classList.add('hidden');
    peerSelectPopover.dataset.peerId = '';
  }

  function openPeerSelectPopover(id, anchorBtn) {
    const st = peerStatuses.get(id);
    const sel = peerVisibleMap[id]; // undefined ⇒ show all
    const liveNames = st && st.online ? (st.sessions || []).map((s) => s.name) : [];
    // Known-but-not-live names to preserve: selection entries + our attached tabs
    // for this peer that aren't in the live list. Offline peers have no live list,
    // so everything we know rides this path.
    const known = new Set(liveNames);
    const gone = [];
    const fromSel = Array.isArray(sel) ? sel : [];
    const fromAttached = [...sessions.entries()]
      .filter(([, e]) => e.peer && e.peer.id === id)
      .map(([, e]) => e.peer.name);
    for (const name of [...fromSel, ...fromAttached]) {
      if (!known.has(name)) { known.add(name); gone.push(name); }
    }
    peerSelectList.innerHTML = '';
    const rows = [
      ...liveNames.map((name) => ({ name, gone: false })),
      ...gone.map((name) => ({ name, gone: true })),
    ];
    if (!rows.length) {
      peerSelectList.innerHTML = '<span class="hint-text">No sessions known for this peer yet.</span>';
    }
    for (const r of rows) {
      const row = document.createElement('label');
      row.className = 'agent-check' + (r.gone ? ' peer-select-gone' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = r.name;
      cb.checked = peerNameVisible(id, r.name);
      cb.dataset.gone = r.gone ? '1' : '';
      const txt = document.createElement('span');
      txt.innerHTML = `<strong>${esc(r.name)}</strong>${r.gone ? ' <span class="skill-src">(gone)</span>' : ''}`;
      row.appendChild(cb);
      row.appendChild(txt);
      peerSelectList.appendChild(row);
    }
    peerSelectPopoverName.textContent = peerDisplayHost(st);
    peerSelectPopover.dataset.peerId = id;
    peerSelectPopover.classList.remove('hidden');
    // Anchor above the button, clamped to the viewport (mirrors tools popover).
    const rect = anchorBtn.getBoundingClientRect();
    const w = peerSelectPopover.offsetWidth;
    peerSelectPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
    peerSelectPopover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
  }

  document.getElementById('peer-select-popover-close').addEventListener('click', closePeerSelectPopover);
  document.getElementById('peer-select-popover-cancel').addEventListener('click', closePeerSelectPopover);
  document.getElementById('peer-select-popover-apply').addEventListener('click', async () => {
    const id = peerSelectPopover.dataset.peerId;
    if (!id) return closePeerSelectPopover();
    const boxes = [...peerSelectList.querySelectorAll('input[type="checkbox"]')];
    const checked = boxes.filter((cb) => cb.checked).map((cb) => cb.value);
    // Collapse to show-all only when nothing is excluded: every box checked AND
    // no gone-name was unchecked (an unchecked gone-name is a real exclusion).
    const allChecked = boxes.every((cb) => cb.checked);
    closePeerSelectPopover();
    const res = await window.api.peerSetVisible(id, allChecked ? null : checked);
    if (res && res.ok) peerVisibleMap = res.peerVisible || {};
    else peerVisibleMap = (await window.api.peerVisible().catch(() => peerVisibleMap)) || peerVisibleMap;
    // Apply is authoritative for attached tabs too: any session excluded by this
    // selection that's currently open gets detached (same path as the X — removeSession
    // forgets persistence + re-homes focus if it was active). This deliberately
    // overrides the attached-always-wins RENDER rule, but only for an explicit
    // Apply exclusion; a tab that becomes attached by other means (auto-reattach
    // of a later-unchecked name) still renders, since nothing re-runs this.
    for (const [key, entry] of [...sessions.entries()]) {
      if (entry.peer && entry.peer.id === id && !peerNameVisible(id, entry.peer.name)) {
        removeSession(key);
      }
    }
    renderPeers();
  });
  // Dismiss on outside click / Escape.
  document.addEventListener('mousedown', (e) => {
    if (peerSelectPopover.classList.contains('hidden')) return;
    if (peerSelectPopover.contains(e.target)) return;
    if (e.target.closest('.peer-eye')) return; // the opener handles itself
    closePeerSelectPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !peerSelectPopover.classList.contains('hidden')) closePeerSelectPopover();
  });

  // --- Peer identity popover (the ⓘ icon) ----------------------------------
  // Read-only surface: peer version vs ours, platform, caps, a severity line, and
  // a best-effort "released N days ago · N behind" pulled from the cached release
  // list (omitted entirely when the version isn't a published release / no cache).
  // The Update button reuses the header-menu deploy flow (sshHost + online gated),
  // resolved from config via peer:deployConfig. Never blocks on a fetch.
  const peerInfoPopover = document.getElementById('peer-info-popover');
  const peerInfoPopoverName = document.getElementById('peer-info-popover-name');
  const peerInfoBody = document.getElementById('peer-info-body');
  const peerInfoUpdateBtn = document.getElementById('peer-info-update');
  const peerInfoDisableBtn = document.getElementById('peer-info-disable');
  const peerInfoRelayRow = document.getElementById('peer-info-relay-row');
  const peerInfoRelayCheck = document.getElementById('peer-info-relay');

  function closePeerInfoPopover() {
    peerInfoPopover.classList.add('hidden');
    peerInfoPopover.dataset.peerId = '';
    peerInfoUpdateBtn.classList.add('hidden');
    peerInfoUpdateBtn.onclick = null;
    peerInfoDisableBtn.onclick = null;
    peerInfoRelayRow.classList.add('hidden');
    peerInfoRelayCheck.onchange = null;
  }

  function openPeerInfoPopover(id, anchorBtn) {
    const st = peerStatuses.get(id);
    if (!st) return;
    const label = peerDisplayHost(st);
    peerInfoPopoverName.textContent = label;
    const sev = (getOurAppVersion() && st.version) ? versionSeverity(getOurAppVersion(), st.version) : 'unknown';
    const capList = (st.caps || []).join(', ') || 'none';
    const rows = [];
    rows.push(`<div class="peer-info-line"><span class="peer-info-key">Version</span> Clodex v${esc(st.version || '?')}${getOurAppVersion() ? ` <span class="peer-status-dim">(you run v${esc(getOurAppVersion())})</span>` : ''}</div>`);
    if (st.platform) rows.push(`<div class="peer-info-line"><span class="peer-info-key">Platform</span> ${esc(st.platform)}</div>`);
    rows.push(`<div class="peer-info-line"><span class="peer-info-key">Caps</span> ${esc(capList)}</div>`);
    if (SEV_LINE[sev]) rows.push(`<div class="peer-info-line peer-sev-${sev}">${esc(SEV_LINE[sev])}</div>`);
    // Best-effort age line from the cached release list; omitted whole when the
    // peer's version isn't a known published release (dev build / empty cache).
    const age = releaseAgeInfo(st.version, releasesCache);
    if (age) {
      const bits = [];
      if (age.ageDays != null) bits.push(`released ${age.ageDays} day${age.ageDays === 1 ? '' : 's'} ago`);
      if (age.behind > 0) bits.push(`${age.behind} release${age.behind === 1 ? '' : 's'} behind`);
      if (bits.length) rows.push(`<div class="peer-info-line peer-status-dim">${esc(bits.join(' · '))}</div>`);
    }
    peerInfoBody.innerHTML = rows.join('');
    peerInfoPopover.dataset.peerId = id;
    peerInfoPopover.classList.remove('hidden');
    // Anchor above the button, clamped to the viewport (mirrors the eye popover).
    const rect = anchorBtn.getBoundingClientRect();
    const w = peerInfoPopover.offsetWidth;
    peerInfoPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
    peerInfoPopover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
    // Update button: online + ssh-reachable only (the exact header-menu gate).
    // Resolved async from config; if the peer is url-only it stays hidden. Guard
    // against a stale resolve landing after the popover was closed/retargeted.
    peerInfoUpdateBtn.classList.add('hidden');
    peerInfoUpdateBtn.onclick = null;
    // Update / Rebuild slot. For a managed box, "Update Clodex" is the wrong verb
    // — a rebuild recreates the box on the current code, which IS its update — so
    // the slot offers Rebuild instead (reusing the header flow + its busy-lock).
    // Always available for a box: the ⓘ only opens for an online peer, and a box
    // is always ssh-reachable locally. Generic peers keep the online + ssh + behind
    // gate resolved below.
    if (boxIds.has(id)) {
      peerInfoUpdateBtn.textContent = 'Rebuild';
      peerInfoUpdateBtn.classList.remove('hidden');
      peerInfoUpdateBtn.onclick = () => { closePeerInfoPopover(); rebuildBox(id, label); };
    } else {
      peerInfoUpdateBtn.textContent = 'Update Clodex';
    }
    // Disable (pause) — always offered here: the ⓘ icon only renders for a live
    // peer, so anything reaching this popover is disable-able.
    peerInfoDisableBtn.onclick = () => { closePeerInfoPopover(); disablePeer(id, label); };
    // Relay-mesh membership (hub-relay federation, default OFF). The flag is a
    // hub-side per-peer SETTING, not part of the peer's hello, so read it from
    // config (non-blocking, like the Update resolve below). Guard a stale resolve
    // landing after the popover was closed/retargeted. Toggling persists via main;
    // the gated roster push converges within one hello tick (~15s).
    peerInfoRelayRow.classList.add('hidden');
    peerInfoRelayCheck.onchange = null;
    window.api.getSettings().then((s) => {
      if (peerInfoPopover.classList.contains('hidden') || peerInfoPopover.dataset.peerId !== String(id)) return;
      const cfg = ((s && s.peers) || []).find((p) => String(p.id) === String(id));
      peerInfoRelayCheck.checked = !!(cfg && cfg.relayAllowed);
      peerInfoRelayRow.classList.remove('hidden');
      peerInfoRelayCheck.onchange = () => {
        window.api.peerSetRelayAllowed(id, peerInfoRelayCheck.checked).catch(() => {});
      };
    }).catch(() => {});
    // Hidden when the peer isn't behind us: same-version or ahead has nothing to
    // gain from our deploy (the script pulls latest master). Kept for
    // patch/minor/major and 'unknown' (dev/unparseable — can't rule it out).
    if (!boxIds.has(id) && st.online && updateApplies(sev)) {
      window.api.peerDeployConfig(id).then((cfg) => {
        if (!cfg || !cfg.sshHost) return;
        if (peerInfoPopover.classList.contains('hidden') || peerInfoPopover.dataset.peerId !== String(id)) return;
        peerInfoUpdateBtn.classList.remove('hidden');
        peerInfoUpdateBtn.onclick = () => {
          closePeerInfoPopover();
          updatePeerHost(id, label, cfg.sshHost, cfg.port, cfg.folder);
        };
      }).catch(() => {});
    }
    // Refresh the release cache in the background for next time (never awaited).
    window.api.getReleases().then((r) => { if (Array.isArray(r)) releasesCache = r; }).catch(() => {});
  }

  document.getElementById('peer-info-popover-close').addEventListener('click', closePeerInfoPopover);
  document.getElementById('peer-info-popover-done').addEventListener('click', closePeerInfoPopover);
  document.addEventListener('mousedown', (e) => {
    if (peerInfoPopover.classList.contains('hidden')) return;
    if (peerInfoPopover.contains(e.target)) return;
    if (e.target.closest('.peer-info')) return; // the opener handles itself
    closePeerInfoPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !peerInfoPopover.classList.contains('hidden')) closePeerInfoPopover();
  });

  return {
    typeToTakeControl, renderPeerBar, forgetControlMirror,
    openPeerSession, peerDisplayHost, peerHideFromList,
    ensurePeerSessionVisible, openPeerArgs,
  };
}

module.exports = { initPeersUi };
