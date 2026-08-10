
const { PendingInput } = require('../peer-input-queue');
const { versionSeverity, updateApplies, releaseAgeInfo, isHumanPtyInput } = require('../proxy-util');
const { parseDeployLine } = require('../peer-deploy');
const { SEV_LINE } = require('./lib/constants');
const { esc, baseName } = require('./lib/format');
const { wireBulkToggles } = require('./lib/checklists');
const { nextVisibleWithName } = require('./lib/peer-visibility');
const { openUrl: sandboxOpenUrl } = require('./lib/sandbox-view');
const { webViewAffordance } = require('./lib/peer-web-view');
const { isPeerExpanded, togglePeerExpanded } = require('./lib/peer-collapse');
const { servedBannerView } = require('./lib/served-banner');

function initPeersUi({
  sessions, sessionList, getActiveSession, createTerminal, switchSession,
  removeSession, updateSidebarActive, showToast, appendIpcEntry,
  remeasureReadonlyPeer, peerStatuses, peerTunnels, peerWebTunnels, getOurAppVersion,
  syncSeatAvailability,
  getDeployLineHandlers, proxyState, ctxPct, ctxTokens, peerFilesCount,
  filesUnseen, applyCtxBadge, applyWarmBadge, renderProxyBar, openFilePeek,
  isFilesPopoverForKey, openArgsDialog, openSkillsPopover,
}) {
  let releasesCache = [];
  window.api.getReleases().then((r) => { releasesCache = Array.isArray(r) ? r : []; }).catch(() => {});
  const peerBar = document.getElementById('peer-bar');
  let peerVisibleMap = {};

  const disabledPeers = new Map();

  // Peer ids the operator has unfolded in THIS workspace. Absence is collapsed,
  // so an empty list before the stored view arrives renders the same as a fresh
  // workspace — which is the default we want anyway, not a flash of the wrong
  // state.
  let expandedPeers = [];
  window.api.getSidebarView().then((res) => {
    const view = res && res.ok && res.view;
    if (!view || !Array.isArray(view.expandedPeers)) return;
    expandedPeers = view.expandedPeers.slice();
    renderPeers();
  }).catch(() => {});

  function togglePeerFold(id) {
    expandedPeers = togglePeerExpanded(expandedPeers, id);
    // A one-key write: workspaces.setView MERGES, so this cannot clobber the
    // sidebar view keys renderer.js owns and this module never carries.
    window.api.setSidebarView({ expandedPeers }).catch(() => {});
    renderPeers();
  }

  function peerNameVisible(id, name) {
    const sel = peerVisibleMap[id];
    return !Array.isArray(sel) || sel.includes(name);
  }

  // '@' can't appear in local session names, so keys never collide with them.
  function peerKey(id, name) { return `${name}@${id}`; }

  function peerDisplayHost(st) { return (st && (st.host || st.label)) || 'peer'; }

  // Does THIS box serve peer terminals? Read from SETTINGS, not from any peer's
  // hello: it is what we serve, and a peer cannot be asked whether we let it in.
  //
  // The persistent indicator ruling 2 asked for. A toast is missed and a chip
  // scrolls away; this sits in the sidebar header for as long as the grant
  // does, which is the property that matters — an operator must never have a
  // shell open on their box that nothing on screen mentions. It is in the
  // HEADER rather than on the peer rows because the grant is box-wide: a
  // serving-only box has no peer rows to draw it on.
  const shellShareChip = document.getElementById('shell-share-chip');
  async function refreshShellAllowed() {
    let s = null;
    try { s = await window.api.getSettings(); } catch { return; }
    if (shellShareChip) shellShareChip.classList.toggle('hidden', !(s && s.peerShellEnabled));
  }
  refreshShellAllowed();
  // The toggle lives in one window's prefs dialog but the grant is box-wide, so
  // every OTHER window has to re-read it. Without this the chip is a boot-time
  // snapshot: a window open since before the grant was turned on says "off"
  // over a box that is serving shells. The attachment mark self-heals on the
  // serving heartbeat; this one has no such tick.
  // Drawer tabs are per-seat and the host only re-asks on a session SWITCH
  // (renderer's switchSession is syncSeatAvailability's one caller). Peer state
  // and the shell grant both change the answer without any switch, so a tunnel
  // blip or a revoked grant leaves a terminal tab visible over a backend that
  // no longer exists — and the tab is the operator's only signal that one does.
  // term-tab refuses to act on a null backend either way; this is what takes the
  // tab away instead of leaving an inert one, which is what the peer terminal
  // looked like while it was quietly sharing a shell.
  const reevaluateSeatTabs = () => { if (syncSeatAvailability) syncSeatAvailability(); };

  window.api.onPeerShellAllowed(() => { refreshShellAllowed(); reevaluateSeatTabs(); });

  // A box's peer id IS its box id, so box ids ∩ peer ids marks managed boxes.
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

  async function togglePeerWeb(id, label) {
    const a = webViewAffordance({
      status: peerStatuses.get(id), tunnel: peerTunnels.get(id), webTunnel: peerWebTunnels.get(id),
    });
    if (a.action === 'close') {
      await window.api.peerCloseWeb(id).catch(() => {});
      peerWebTunnels.delete(id);
      renderPeers();
      showToast(`Closed the web view tunnel to ${label}.`, { kind: 'peer-ui' });
      return;
    }
    if (a.action !== 'open') { showToast(a.tip, { kind: 'warm' }); return; }
    const res = await window.api.peerOpenWeb(id).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
    if (!res || res.ok === false) {
      showToast(`Can't open ${label}'s web UI: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
      return;
    }
    if (res.status) peerWebTunnels.set(id, res.status);
    renderPeers();
    showToast(
      a.tokenGated
        ? `${label}'s web UI needs a token — connecting over ssh, then you'll get the URL to open with ?token=…`
        : `Opening ${label}'s web UI — connecting over ssh…`,
      { kind: a.tokenGated ? 'warm' : 'peer-ui' },
    );
  }

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
      // Rows are resolved before the header is built: a collapsed header shows
      // how many it is hiding, so the header needs the count.
      const rows = (st.online
        ? (st.sessions || []).map((s) => ({ name: s.name, cwd: s.cwd, activity: s.activity, stats: s.stats }))
        : [...sessions.entries()]
            .filter(([, e]) => e.peer && e.peer.id === id)
            .map(([, e]) => ({ name: e.peer.name, cwd: '', activity: 'idle' })))
        .filter((s) => peerNameVisible(id, s.name) || sessions.has(peerKey(id, s.name)));
      const expanded = isPeerExpanded(expandedPeers, id);
      const header = document.createElement('div');
      header.className = 'peer-header' + (expanded ? '' : ' collapsed');
      header.dataset.peerUi = '1';
      const tun = peerTunnels.get(id);
      let stateText = st.online ? '' : 'offline';
      if (!st.online && tun && tun.state === 'down') {
        stateText = 'tunnel down';
        if (tun.error) header.dataset.tip = tun.error;
      }
      let sev = 'unknown';
      if (st.online && st.version) {
        const capList = (st.caps || []).join(', ') || 'none';
        header.dataset.tip = `Clodex v${st.version} · caps: ${capList}${st.platform ? ` · ${st.platform}` : ''}`;
        if (getOurAppVersion()) sev = versionSeverity(getOurAppVersion(), st.version);
      }
      const nameSev = (sev === 'patch' || sev === 'minor' || sev === 'major') ? ` peer-sev-${sev}` : '';
      const hostLabel = peerDisplayHost(st);
      const canCreate = peerSupportsCreate(st);
      const off = st.online ? '' : 'disabled';
      const isBox = boxIds.has(id);
      const webView = isBox
        ? { show: false }
        : webViewAffordance({ status: st, tunnel: tun, webTunnel: peerWebTunnels.get(id) });
      header.innerHTML = `<span class="peer-caret">&#9662;</span>` +
        `<span class="peer-dot ${st.online ? 'online' : ''}"></span>` +
        (isBox ? `<span class="peer-box-chip" data-tip="Managed sandbox" aria-label="Managed sandbox">&#9635;</span>` : '') +
        `<span class="peer-label${nameSev}">${esc(hostLabel)}</span>` +
        ((!expanded && rows.length) ? `<span class="peer-count">${rows.length}</span>` : '') +
        `<span class="peer-state">${esc(stateText)}</span>` +
        `<span class="peer-actions">` +
          (canCreate ? `<button class="peer-select peer-new" data-tip="New session on ${esc(hostLabel)}" aria-label="New session on ${esc(hostLabel)}" ${off}>&#65291;</button>` : '') +
          (isBox ? `<button class="peer-select peer-web" data-tip="Open ${esc(hostLabel)}’s web UI" aria-label="Open ${esc(hostLabel)} web UI" ${off}>&#8599;</button>` : '') +
          (webView.show ? `<button class="peer-select peer-webview peer-webview-${webView.phase}" data-tip="${esc(webView.tip)}" aria-label="${esc(webView.tip)}" ${webView.enabled ? '' : 'disabled'}>&#8599;</button>` : '') +
          `<button class="peer-select peer-restart" data-tip="Restart Clodex on ${esc(hostLabel)}" aria-label="Restart Clodex on ${esc(hostLabel)}" ${off}>&#8635;</button>` +
          `<button class="peer-select peer-eye" data-tip="Choose which sessions to show" aria-label="Choose which sessions to show">&#9678;</button>` +
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
      const webViewBtn = header.querySelector('.peer-webview');
      if (webViewBtn) webViewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePeerWeb(id, hostLabel);
      });
      header.querySelector('.peer-restart').addEventListener('click', (e) => {
        e.stopPropagation();
        restartPeerHost(id, hostLabel);
      });
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        window.api.showPeerHeaderMenu({
          id, label: peerDisplayHost(st), online: !!st.online,
          canCreate: peerSupportsCreate(st),
          isBox,
          sev,
        });
      });
      // Every button in .peer-actions stops propagation, so a bare header click
      // is only ever the empty area, the dot, the caret or the label.
      header.addEventListener('click', () => { togglePeerFold(id); });
      sessionList.appendChild(header);

      for (const s of rows) {
        const key = peerKey(id, s.name);
        const item = document.createElement('div');
        item.className = 'session-item peer-item' + (st.online ? '' : ' peer-offline');
        item.dataset.peerUi = '1';
        // Hidden, not omitted: an attached peer row stays in the DOM so
        // updateSidebarActive and the badge writes below still find it.
        if (!expanded) item.style.display = 'none';
        item.dataset.name = key;
        item.dataset.activity = s.activity || 'idle';
        if (sessions.has(key)) item.classList.add('attached');
        item.dataset.type = 'remote';
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
          (sessions.has(key) ? '<button class="session-close" data-tip="Detach">&times;</button>' : '');
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('session-close')) return;
          openPeerSession(id, s.name);
        });
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

  function enablePeer(id) {
    window.api.peerSetDisabled(id, false).catch(() => {});
  }

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

  // One-shot: each name is consumed from the pending set as it attaches, so a tab
  // attached then closed can't be resurrected by a later offline/online blip. A name
  // still missing once the peer has settled online is forgotten from persistence.
  const peerRestorePending = new Map(); // peerId -> Set<name> awaiting restore
  const peerRestoreSweep = new Set();   // peerId -> settle sweep already scheduled
  // The first online peer-state fires before the peer's session list is fetched
  // (peer-client sets online, then refreshes), so a name missing on that event
  // may just be un-fetched. Give the refresh a beat before declaring it dead.
  const PEER_RESTORE_SETTLE_MS = 6000;

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

  function typeToTakeControl(key, data) {
    // xterm's onData also carries terminal chatter — mouse reports (the Claude
    // pane enables tracking), focus/query replies — so scroll-reading a read-only
    // peer tab would otherwise STEAL control. Gate on the same classifier the main
    // process uses for human-input detection: only a real keystroke takes control.
    if (!isHumanPtyInput(data)) return;
    const entry = sessions.get(key);
    if (!entry || !entry.peer || entry.peer.controlled) return;
    const st = peerStatuses.get(entry.peer.id);
    if (!st || !st.online) return;
    if (!entry.peer.pendingInput) entry.peer.pendingInput = new PendingInput();
    const kick = entry.peer.pendingInput.offer(data);
    if (kick) applyPeerControl(entry, true, { flush: true });
  }

  async function applyPeerControl(entry, on, { flush = false, dropOnFail = false } = {}) {
    const { id: peerId, name: peerName } = entry.peer;
    if (on && entry.peer._acquiring) return;
    clearPeerControlError(entry.peer);
    if (on) entry.peer._acquiring = true;
    let res;
    // An invoke rejection must land in the failure branch below: propagating would skip
    // pendingInput.reset() and wedge acquiring=true (silent type-to-take deadlock).
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
        entry.fitAddon.fit();
        window.api.peerResize(peerId, peerName, entry.terminal.cols, entry.terminal.rows);
        entry.terminal.focus();
        if (entry.peer.pendingInput) {
          const buffered = entry.peer.pendingInput.drain();
          if (buffered) window.api.peerInput(peerId, peerName, buffered);
        }
        rememberControlMirror(peerId, peerName);   // main persisted via peer:control
      } else {
        setPeerControlError(entry.peer, (res && res.error) || 'could not take control');
        // Reset unconditionally, not only when flushing: a keystroke can land during a
        // flush:false re-acquire, and leaving pendingInput.acquiring true makes every
        // later keystroke buffer with kick=false — type-to-take dies on the tab.
        if (entry.peer.pendingInput) entry.peer.pendingInput.reset(); // drop buffer
        if (dropOnFail) dropPersistedControl(peerId, peerName);
      }
    } else {
      entry.peer.controlled = false;
      forgetControlMirror(peerId, peerName);       // main forgot via peer:control
    }
    renderPeerBar();
  }

  async function restartPeerHost(id, label) {
    const okToGo = await window.api.confirmPeerRestart(label);
    if (!okToGo) return;
    await doPeerRestart(id, label);
  }

  async function doPeerRestart(id, label) {
    const res = await window.api.peerRestart(id);
    if (res && res.ok) {
      showToast(`Restarting Clodex on ${label} — it will reconnect shortly.`, { kind: 'peer-ui' });
    } else {
      showToast(`Restart failed on ${label}: ${(res && res.error) || 'no response'}`, { kind: 'warm' });
    }
  }

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
        await rebuildBox(id, name || 'sandbox');
        break;
      case 'pause':
        // `name` is the peer's display label here, as for 'restart'.
        disablePeer(id, name || 'peer');
        break;
      case 'newSession':
        openPeerSessionDialog(id, name || 'peer');
        break;
      case 'update':
        await updatePeerHost(id, name || 'peer', sshHost, port, folder);
        break;
      case 'editArgs': {
        const st = peerStatuses.get(id);
        openArgsDialog(name, peerArgsSource(id, name, peerDisplayHost(st)));
        break;
      }
      case 'editSkills': {
        const st = peerStatuses.get(id);
        const anchor = sessionList.querySelector(`[data-name="${CSS.escape(key)}"]`) || sessionList;
        openSkillsPopover(name, anchor, peerSkillsSource(id, name, peerDisplayHost(st)));
        break;
      }
      case 'restartRemote':
        await restartPeerSessionWithReattach(id, name, false);
        break;
      case 'reloadRemote': {
        const st = peerStatuses.get(id);
        const label = peerDisplayHost(st);
        if (!await window.api.confirmPeerReload(name, label)) break;
        await restartPeerSessionWithReattach(id, name, true);
        break;
      }
      case 'killRemote': {
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

  // Once a peer's visible set is materialized, a name created afterward is absent from
  // it and never renders. This is the only thing that surfaces a no-attach create;
  // attachment overrides visibility at the render site, this keeps the row after detach.
  async function ensurePeerSessionVisible(id, name) {
    const next = nextVisibleWithName(peerVisibleMap[id], name);
    if (!next) return;
    const res = await window.api.peerSetVisible(id, next);
    if (res && res.ok) peerVisibleMap = res.peerVisible || {};
    renderPeers();
  }

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
    const isNewPeer = !peerStatuses.has(id);
    peerStatuses.set(id, status);
    renderPeers();
    renderPeerBar();
    reevaluateSeatTabs();
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
    // A reconnect replay into the already-active tab fires no switchSession, so this is
    // the only place a read-only peer's stale letterbox gets re-measured.
    if (peerKey(id, name) === getActiveSession() && !entry.peer.controlled) {
      remeasureReadonlyPeer(entry);
    }
    if (peerControlledHas(id, name) && !entry.peer.controlled) {
      applyPeerControl(entry, true, { dropOnFail: true });
    }
  });

  window.api.onPeerData((id, name, data) => {
    const entry = sessions.get(peerKey(id, name));
    if (entry) entry.terminal.write(data);
  });

  // Owner geometry is canonical even in control mode; applying it can't feed back,
  // since viewers push geometry only on explicit fit, never on an applied resize.
  window.api.onPeerResize((id, name, geom) => {
    const entry = sessions.get(peerKey(id, name));
    if (!entry || !entry.peer) return;
    if (!(geom.cols > 0 && geom.rows > 0)) return;
    entry.peer.cols = geom.cols; entry.peer.rows = geom.rows;
    if (entry.terminal.cols !== geom.cols || entry.terminal.rows !== geom.rows) {
      entry.terminal.resize(geom.cols, geom.rows);
    }
  });

  // The event carries only a {kind, args} trigger — content is pulled locally through
  // the query RPC, so it stays on the owner's vetted path. Intrusiveness gate: a remote
  // agent must not slam a modal over another tab, so a kind renders immediately only in
  // the active tab and otherwise announces via toast. Every kind supplies both paths.
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
    const disp = `${name}@${peerDisplayHost(peerStatuses.get(id))}`;
    showToast(`${disp}: ${spec.label} — ${spec.detail(args)}`, {
      kind: 'peer-ui',
      onClick: () => { if (sessions.has(key)) { switchSession(key); spec.present(key, args); } },
    });
  });

  // Partial frames: {proxy} rides the poll, {ctx} the statusline side-channel — merge,
  // never replace. The owner ships an info-only view (no base/capabilities/sessionId),
  // so owner-local controls degrade to text instead of firing at absent endpoints.
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

  window.api.onPeerWebTunnel((id, status) => {
    if (status && status.state === 'closed') peerWebTunnels.delete(String(id));
    else peerWebTunnels.set(String(id), status);
    if (status && status.firstUp && status.url) {
      const st = peerStatuses.get(String(id));
      const label = peerDisplayHost(st);
      const gated = !!(st && st.webHost && st.webHost.tokenGated);
      showToast(
        gated
          ? `${label}'s web UI is tunnelled to ${status.url} — it requires a token, so open it with ?token=…`
          : `${label}'s web UI is open at ${status.url}`,
        { kind: gated ? 'warm' : 'peer-ui', sticky: gated },
      );
    }
    renderPeers();
  });

  window.api.onPeerRemoved((id) => {
    peerStatuses.delete(id);
    peerTunnels.delete(id);
    peerWebTunnels.delete(String(id));
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
    } else {
      disabledPeers.delete(id);
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

  window.api.onSessionPeerControl((name, holder) => {
    const el = sessionList.querySelector(`[data-name="${CSS.escape(name)}"]`);
    if (!el) return;
    if (holder) el.dataset.remoteControl = holder;
    else delete el.dataset.remoteControl;
  });

  // Seats on THIS box whose terminal a peer is watching right now (t219). The
  // header chip beside a peer's name reports the GRANT — a setting, and true
  // whether or not anyone is looking. This reports ATTACHMENT, which is the
  // thing that must never be unannounced: opening the stream SPAWNS the shell,
  // so a remote party can be sitting in a terminal on this box with no tab open
  // for it here.
  //
  // The message carries the WHOLE set, not a delta. A delta stream drifts the
  // moment one message is missed — a window opened after the fact would show
  // marks that were cleared before it existed — and the server already knows
  // the answer, so recomputing it here would be a second source of truth for a
  // safety indicator.
  //
  // It also goes to EVERY window, unfiltered, and that is not an oversight to
  // narrow into a per-workspace send. Filtering by workspace would add a mapping
  // that can be wrong, and a mark that fails to appear is the failure mode this
  // indicator exists to prevent.
  //
  // TWO surfaces, and the row is the weaker one. It resolves for at most one
  // window (session names are globally unique) and for some served seats it
  // resolves for NONE: a killed or archived session has no row, `rowPasses`
  // display:none's a filtered one, and archived rows carry no `.session-badges`
  // for the glyph to hang on. The BANNER below is what makes the claim true —
  // it is bound to the size of this set and to nothing about any row, so a seat
  // nobody can see still says a peer is in a shell here. The row attribute
  // stays as the per-seat detail: which one.
  const servedBanner = document.getElementById('served-terminal-banner');
  const servedText = document.getElementById('served-terminal-text');
  window.api.onServedTerminals((seats) => {
    const live = new Set(Array.isArray(seats) ? seats.map(String) : []);
    for (const el of sessionList.querySelectorAll('[data-served-terminal]')) {
      if (!live.has(el.dataset.name)) delete el.dataset.servedTerminal;
    }
    for (const seat of live) {
      const el = sessionList.querySelector(`[data-name="${CSS.escape(seat)}"]`);
      if (el) el.dataset.servedTerminal = '1';
    }
    if (!servedBanner) return;
    // The decision is a leaf (served-banner.js) and this is assignment only:
    // the strings come back finished and go in with textContent, so a seat name
    // — which is operator-supplied — never becomes markup.
    const view = servedBannerView([...live]);
    if (servedText) servedText.textContent = view.text;
    servedBanner.dataset.tip = view.tip;
    servedBanner.classList.toggle('hidden', view.hidden);
  });

  window.api.peerList().then((statuses) => {
    for (const st of statuses || []) {
      peerStatuses.set(st.id, st);
      if (st.tunnel) peerTunnels.set(st.id, st.tunnel);
      // A web tunnel survives a window close (main owns it), so a reopened
      // window seeds the affordance's open state rather than offering to open a
      // second forward to the same box.
      if (st.webTunnel) peerWebTunnels.set(String(st.id), st.webTunnel);
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

  window.api.peerVisible().then((map) => {
    peerVisibleMap = map || {};
    if (peerStatuses.size) renderPeers();
  }).catch(() => {});

  window.api.peerControlledNames().then((map) => {
    peerControlledMap = map || {};
  }).catch(() => {});

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

  function peerSupportsArgs(st) {
    return !!(st && Array.isArray(st.caps) && st.caps.includes('args'));
  }

  // The owner's kill sends an SSE `exit` that tears our tab down (onPeerExit), and that
  // exit races the restart ack across two transports. Poll for the teardown to settle
  // before re-opening, or we attach onto a tab the exit is about to remove. A missed
  // exit is healed instead by peer-client's stream-close reconnect.
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

  // wasAttached is captured at save time — the box hasn't killed the PTY yet; by
  // onRestarted the tab is already gone.
  function peerArgsSource(id, name, label) {
    const key = peerKey(id, name);
    let wasAttached = false;
    return {
      fetch: async () => {
        const [r, sc] = await Promise.all([
          window.api.peerSessionArgs(id, name),
          window.api.peerSkillCatalog(id, name).catch(() => null),
        ]);
        if (!r || !r.ok) return r || { ok: false, error: `Session "${name}" not found on ${label}.` };
        const cat = r.catalogs || {};
        return {
          ok: true,
          res: r,
          settings: { claudeTools: cat.claudeTools || [], proxyUrl: cat.proxyUrl, proxyEnabled: cat.proxyEnabled },
          promptLib: cat.prompts || [],
          agentLib: cat.agents || [],
          skillCatalog: (sc && sc.ok) ? sc : null,
        };
      },
      // Skills are roster-frozen at conversation creation on the box, so a resume
      // restart never re-reads them. When skills ride along, persist args WITHOUT the
      // box restart, persist skills separately, and apply with a FRESH restart here.
      // A non-skills peer edit keeps the history-preserving resume restart.
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

  function openPeerArgs(key) {
    const entry = key ? sessions.get(key) : null;
    if (!entry || !entry.peer) return;
    const { id, name } = entry.peer;
    const st = peerStatuses.get(id);
    if (!st || !st.online || !peerSupportsArgs(st)) return;
    openArgsDialog(name, peerArgsSource(id, name, peerDisplayHost(st)));
  }

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
    const allChecked = boxes.every((cb) => cb.checked);
    closePeerSelectPopover();
    const res = await window.api.peerSetVisible(id, allChecked ? null : checked);
    if (res && res.ok) peerVisibleMap = res.peerVisible || {};
    else peerVisibleMap = (await window.api.peerVisible().catch(() => peerVisibleMap)) || peerVisibleMap;
    // Apply overrides the attached-always-wins render rule: an open tab excluded by
    // this selection is detached. Only an explicit Apply does this — a tab attached
    // later (auto-reattach of an unchecked name) still renders.
    for (const [key, entry] of [...sessions.entries()]) {
      if (entry.peer && entry.peer.id === id && !peerNameVisible(id, entry.peer.name)) {
        removeSession(key);
      }
    }
    renderPeers();
  });
  document.addEventListener('mousedown', (e) => {
    if (peerSelectPopover.classList.contains('hidden')) return;
    if (peerSelectPopover.contains(e.target)) return;
    if (e.target.closest('.peer-eye')) return; // the opener handles itself
    closePeerSelectPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !peerSelectPopover.classList.contains('hidden')) closePeerSelectPopover();
  });

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
    const rect = anchorBtn.getBoundingClientRect();
    const w = peerInfoPopover.offsetWidth;
    peerInfoPopover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
    peerInfoPopover.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
    peerInfoUpdateBtn.classList.add('hidden');
    peerInfoUpdateBtn.onclick = null;
    if (boxIds.has(id)) {
      peerInfoUpdateBtn.textContent = 'Rebuild';
      peerInfoUpdateBtn.classList.remove('hidden');
      peerInfoUpdateBtn.onclick = () => { closePeerInfoPopover(); rebuildBox(id, label); };
    } else {
      peerInfoUpdateBtn.textContent = 'Update Clodex';
    }
    peerInfoDisableBtn.onclick = () => { closePeerInfoPopover(); disablePeer(id, label); };
    // relayAllowed is a hub-side per-peer setting, not part of the peer's hello — read
    // it from config, not from peerStatuses.
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
      // No terminal-sharing row here: it is one box-wide serving setting, and
      // it lives in Preferences with the other things this box serves. Drawn
      // per peer it would read as a per-peer permission, which is the one thing
      // about this feature an operator can reasonably get wrong.
    }).catch(() => {});
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
