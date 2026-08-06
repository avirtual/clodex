// drawer-host.js — the bottom drawer as a TAB HOST. It owns the collapsed/
// expanded state, the layout contract with #main, the tab strip and its unread
// badges, and pane swapping; tenants (ipc-log today) own only their content.
//
// FACTORY (R2): the toggle refits the active SESSION terminal after the layout
// shift. That is renderer.js's `refitActiveTerminal`, injected — NOT a local
// copy over `sessions` + `getActiveSession`. The copy this replaced (inherited
// from ipc-log.js's toggle) treated a peer row as a local session and pushed
// `resizeSession` upstream for it, which breaks the read-only-peer invariant at
// renderer.js's `remeasureReadonlyPeer`: a read-only viewer must never send
// dimensions to the owner. One implementation means the peer rules cannot drift
// out of this file's sight again.
//
// Four rules here exist for tenants that do not exist yet, and each is the
// kind of mistake that is cheap now and a contract migration later:
//
//   1. NOTHING in the drawer's subtree is ever hidden with `display:none` —
//      not the panes, not their ancestor on collapse. Collapse is height-only
//      (--drawer-collapsed-h) and inactive panes go `visibility:hidden`. An
//      xterm inside a display:none ancestor measures zero and never recovers
//      (the CLAUDE.md gotcha); a per-tenant version of this rule is one every
//      tenant has to remember and one will forget, so it lives in .drawer-pane.
//   2. onShow fires inside a rAF AFTER the visibility flip — a terminal hidden
//      across a window resize has stale measurements the instant it is shown,
//      and reading them in the same frame as the flip reads the old geometry.
//      THE CONTRACT IS STRONGER THAN "fires when shown": onShow and onHide are
//      strictly alternating at-most-once EDGE transitions, enforced host-side
//      by `rec.shown`. A tenant may therefore acquire in onShow and release in
//      onHide with no idempotence of its own — a double onShow would leak the
//      Activity tenant's 1500ms poll interval past an onHide that can only
//      clear one, and an onHide with no preceding onShow would release
//      something never acquired. Both are reachable in one frame (expand →
//      collapse → expand queues two rAFs; a tab switch drops a queued onShow
//      while firing the previous tenant's onHide), which is why this is the
//      host's job and not a warning in the tenant docs.
//   3. onResize fires from a ResizeObserver on #drawer-panes as well as on
//      toggle. renderer.js's observer watches #terminal-container only and
//      refits the session terminal — nothing else watches the drawer.
//   4. mount() runs BEFORE the pane has geometry (the click path selects, then
//      expands), so a tenant that measures itself must not do it in mount().
//      But onShow is not the authoritative measurement either: it fires one rAF
//      (~16ms) after the collapse class flips, while #drawer transitions its
//      height over 200ms — so the pane there has non-zero but NOT FINAL
//      geometry, and a fit() computes rows for a mid-transition box. So: build
//      DOM in mount, OPEN in onShow, FIT in onResize. The ResizeObserver fires
//      through the transition and dispatchResize's per-frame coalescing always
//      schedules once more after the last callback, so the final onResize
//      carries settled geometry. A tenant that fits only in onShow is wrong in a
//      way that looks right, because the numbers it reads are plausible.
//   5. `selection()` is the tenant's, not the host's. A generic
//      document.getSelection() read would work for the DOM tenants and return
//      EMPTY for the terminal — xterm paints rows into a canvas, so its selected
//      text exists only in its own model. A host-side read is therefore not a
//      simpler version of this contract, it is one that silently excludes the
//      tenant most worth selecting from. A tenant that omits it has no selection
//      and the shared button stays disabled for it, which is honest.
//
// DOM-bound, so no unit tests per the R1 rule.

// Selection → wirescope debounce, same value and same reason as hint-arm's:
// `selectionchange` fires on every mouse move during a drag, so arming on the
// raw event would POST dozens of times for one selection. Cancelled per event,
// so only the pause after the operator stops dragging arms.
const ARM_DEBOUNCE_MS = 300;

// Fixed order and the frozen id set: tab ids are part of the agent-facing
// source grammar (`drawer:<tabId>`), so they are chosen once and an unknown id
// is a programming error, not a new tab.
const TAB_IDS = Object.freeze(['log', 'activity', 'ctl', 'term']);

// Beyond this the badge is "a lot"; the count itself keeps counting.
const BADGE_MAX = 99;

// onArmChanged: something was armed, handed over, or released — the inspector's
// badge is stale. Fired rather than polled so the badge costs a proxy read only
// when the state it reports actually moved.
function createDrawerHost({ refitActiveTerminal, getActiveSession, onArmChanged = null }) {
  const armChanged = () => { try { if (onArmChanged) onArmChanged(); } catch {} };
  const drawer = document.getElementById('drawer');
  const drawerHeader = document.getElementById('drawer-header');
  const tabsEl = document.getElementById('drawer-tabs');
  const actionsEl = document.getElementById('drawer-actions');
  const toggleBtn = document.getElementById('drawer-toggle');
  const tallBtn = document.getElementById('drawer-tall');
  const copyBtn = document.getElementById('drawer-copy');
  const statusEl = document.getElementById('drawer-status');
  const panesEl = document.getElementById('drawer-panes');

  const tenants = new Map(); // id -> { id, def, pane, actions, tabEl, badgeEl, unread, mounted }
  let activeId = null;

  const isCollapsed = () => drawer.classList.contains('collapsed');

  // Tall mode persists per window across restarts — a drawer the operator sized
  // for a debugging session should still be that size after a reload. localStorage
  // rather than the settings store: it is per-window view state, the same tier as
  // the sidebar width, and it must be readable synchronously at boot (an async
  // read would apply the class a frame late and animate the drawer open).
  const TALL_KEY = 'clodex-drawer-tall';
  let tall = false;
  try { tall = localStorage.getItem(TALL_KEY) === '1'; } catch {}
  const isVisible = (id) => !isCollapsed() && activeId === id;

  function renderBadge(rec) {
    rec.badgeEl.textContent = rec.unread > BADGE_MAX ? `${BADGE_MAX}+` : String(rec.unread);
    rec.badgeEl.classList.toggle('zero', rec.unread === 0);
    rec.badgeEl.classList.toggle('attention', rec.attention && rec.unread > 0);
  }

  function clearBadge(rec) {
    rec.unread = 0;
    rec.attention = false;
    renderBadge(rec);
  }

  function mountIfNeeded(rec) {
    if (rec.mounted) return;
    rec.mounted = true;
    if (rec.def.mount) rec.def.mount(rec.pane, rec.actions);
  }

  // Post-flip, in a rAF: see rule 2 above. `rec.shown` is the edge state that
  // makes the pair alternating — two rAFs queued in one frame both find the
  // tab visible, and only the first may fire.
  function dispatchShow(rec) {
    requestAnimationFrame(() => {
      if (rec.shown || !isVisible(rec.id)) return; // already shown, or toggled back within the frame
      rec.shown = true;
      if (rec.def.onShow) rec.def.onShow();
      dispatchResize(rec);
    });
  }

  function dispatchHide(rec) {
    if (!rec.shown) return; // no onShow ever landed — nothing to release
    rec.shown = false;
    if (rec.def.onHide) rec.def.onHide();
  }

  // Coalesced to one call per frame: #drawer animates its height over 200ms,
  // so a single toggle produces a dozen ResizeObserver callbacks — and for the
  // terminal tenant each one is a fit() plus a wterm:resize, i.e. a SIGWINCH
  // storm through whatever interactive program is running in it.
  function dispatchResize(rec) {
    if (rec.pendingResize) return;
    rec.pendingResize = true;
    requestAnimationFrame(() => {
      rec.pendingResize = false;
      if (isVisible(rec.id) && rec.def.onResize) rec.def.onResize();
    });
  }

  // The drawer's layout shift changes the session terminal's box. The rAF is
  // load-bearing: the CSS height transition means the new geometry is not
  // readable in the frame that flips the class, so fitting synchronously
  // measures the OLD box. renderer.js's own callers (ResizeObserver, zoom
  // nudge) fire after layout already settled and so need no rAF of their own.
  function refitSessionTerminal() {
    requestAnimationFrame(refitActiveTerminal);
  }

  function select(id) {
    const rec = tenants.get(id);
    if (!rec || rec.id === activeId) return;
    const prev = tenants.get(activeId);
    if (prev) {
      prev.pane.classList.remove('active');
      prev.tabEl.classList.remove('active');
      // Action groups are DETACHED rather than display:none'd — the no-display
      // rule covers the whole drawer subtree, and a detached node keeps its
      // listeners, so re-activating a tab needs no rewiring.
      if (prev.actions.parentNode) prev.actions.remove();
      dispatchHide(prev);
    }
    activeId = id;
    rec.pane.classList.add('active');
    rec.tabEl.classList.add('active');
    actionsEl.appendChild(rec.actions);
    mountIfNeeded(rec);
    clearBadge(rec);
    if (!isCollapsed()) dispatchShow(rec);
    // Each tenant owns its own selection, so the shared button's state is only
    // meaningful relative to the active one.
    syncCopy();
  }

  // Tall mode is remembered across collapses but only ever REACHES the layout
  // while expanded: #main's offsets are what keep the session terminal from
  // painting under the drawer, so a collapsed-but-tall drawer with the class
  // still on would reserve 70% for a 36px bar.
  function syncTall() {
    const expanded = !isCollapsed();
    drawer.classList.toggle('tall', tall && expanded);
    document.getElementById('main').classList.toggle('drawer-tall', tall && expanded);
    if (tallBtn) {
      tallBtn.classList.toggle('on', tall);
      tallBtn.title = tall ? 'Restore panel height' : 'Make the panel taller';
      tallBtn.setAttribute('aria-pressed', tall ? 'true' : 'false');
    }
  }

  function setTall(next) {
    if (tall === next) return;
    tall = next;
    syncTall();
    try { localStorage.setItem(TALL_KEY, tall ? '1' : '0'); } catch {}
    // Both boxes changed. The tenant's own resize is coalesced to one call per
    // frame by dispatchResize, so the 200ms height transition is one SIGWINCH
    // at the end rather than a storm.
    const rec = tenants.get(activeId);
    if (rec && isVisible(rec.id)) dispatchResize(rec);
    refitSessionTerminal();
  }

  function toggle() {
    drawer.classList.toggle('collapsed');
    const expanded = !isCollapsed();
    document.getElementById('main').classList.toggle('drawer-expanded', expanded);
    syncTall();
    const rec = tenants.get(activeId);
    if (rec) {
      if (expanded) {
        clearBadge(rec);
        dispatchShow(rec);
      } else {
        dispatchHide(rec);
      }
    }
    // Collapse gates the copy button (see syncCopy), and collapsing fires no
    // selectionchange — so without this the state set while expanded persists.
    syncCopy();
    refitSessionTerminal();
  }

  function open(id) {
    if (!tenants.has(id)) return;
    select(id);
    if (isCollapsed()) toggle();
  }

  // Tenants register statically from renderer.js at boot; the register calls
  // ARE the registry (four known tenants do not justify a dynamic one).
  //
  // `available()` hides a tab in an environment that cannot serve it. It is a
  // UI nicety the client controls and NOT a security boundary: a tenant backed
  // by IPC is kept off the web surface by its handlers being absent from that
  // host's map at REGISTRATION (engine's enableDrawerServices seam), because
  // web-host dispatches any registered channel by name.
  function register(def) {
    if (!TAB_IDS.includes(def.id)) throw new Error(`drawer: unknown tab id ${def.id}`);
    if (def.available && !def.available()) return () => {};

    const pane = document.createElement('div');
    pane.className = 'drawer-pane';
    pane.dataset.tab = def.id;
    panesEl.appendChild(pane);

    const actions = document.createElement('div');
    actions.className = 'drawer-action-group';

    const tabEl = document.createElement('button');
    tabEl.type = 'button';
    tabEl.className = 'drawer-tab';
    tabEl.dataset.tab = def.id;
    const labelEl = document.createElement('span');
    labelEl.className = 'drawer-tab-label';
    labelEl.textContent = def.label || def.id;
    const badgeEl = document.createElement('span');
    badgeEl.className = 'drawer-badge zero';
    badgeEl.textContent = '0';
    tabEl.appendChild(labelEl);
    tabEl.appendChild(badgeEl);
    tabEl.addEventListener('click', (e) => {
      e.stopPropagation(); // the header itself toggles; a tab click must not
      if (def.id === activeId && !isCollapsed()) { toggle(); return; }
      select(def.id);
      if (isCollapsed()) toggle();
    });

    const rec = {
      id: def.id, def, pane, actions, tabEl, badgeEl,
      unread: 0, attention: false, mounted: false,
      shown: false,        // the onShow/onHide edge state (rule 2)
      pendingResize: false,
    };
    tenants.set(def.id, rec);

    // Fixed order by TAB_IDS, whatever order renderer.js registers in.
    const after = TAB_IDS.slice(TAB_IDS.indexOf(def.id) + 1)
      .map((id) => tenants.get(id)).find(Boolean);
    tabsEl.insertBefore(tabEl, after ? after.tabEl : null);

    if (activeId === null) selectFirst(rec);
    function notify(level) {
      if (isVisible(rec.id)) return; // the operator is looking at it
      rec.unread++;
      if (level === 'attention') rec.attention = true;
      renderBadge(rec);
    }
    // A tenant whose selection changes without a document `selectionchange`
    // (xterm, which owns its own selection model) calls this to re-sync the
    // shared copy button. Guarded on being the active tenant so a background
    // tenant cannot arm a button that would copy someone else's text.
    notify.selectionChanged = () => { if (rec.id === activeId) syncCopy(); };
    return notify;
  }

  // The first registered tenant is active from boot (collapsed, but active) so
  // its pane is mounted and accumulating before anyone opens the drawer.
  function selectFirst(rec) {
    activeId = rec.id;
    rec.pane.classList.add('active');
    rec.tabEl.classList.add('active');
    actionsEl.appendChild(rec.actions);
    mountIfNeeded(rec);
    // The drawer boots collapsed, so this is a no-op today — but the onShow
    // contract must not depend on that ordering.
    if (!isCollapsed()) dispatchShow(rec);
  }

  // ONE copy button for every tenant, in the header rather than per-tenant
  // action groups: the gesture is the same everywhere (select, copy) and four
  // implementations would drift into four behaviours. It reads the ACTIVE
  // tenant's selection through rule 5.
  // RAW, never trimmed: the operator selected indented output and the leading
  // whitespace is part of it — a diff, a stack trace and a YAML block all mean
  // something different one column left. Emptiness is decided by the CALLERS
  // trimming their own test copy, so whitespace-only never arms the button while
  // real indentation survives the copy.
  function activeSelection() {
    const rec = tenants.get(activeId);
    if (!rec || !rec.def.selection) return '';
    try { return String(rec.def.selection() || ''); } catch { return ''; }
  }

  function bytesLabel(n) {
    return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
  }

  // The DOM tenants' half of rule 5, offered here so three panes share one
  // implementation. Scoped by CONTAINMENT rather than just non-empty: a
  // selection living in the sidebar, a dialog, or a sibling pane is not this
  // tenant's to hand over, and treating it as one would make the copy button's
  // behaviour depend on where the operator last dragged.
  function domSelection(el) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !el) return '';
    for (let i = 0; i < sel.rangeCount; i++) {
      // commonAncestorContainer is a TEXT NODE for a within-line selection, so
      // ask the container whether it contains the node rather than walking up
      // looking for an element.
      if (!el.contains(sel.getRangeAt(i).commonAncestorContainer)) return '';
    }
    // Raw for the same reason activeSelection is — indentation is content.
    return String(sel);
  }

  // The status line carries two things with different lifetimes: a transient
  // report of what just happened (copied, failed) and a STANDING statement of
  // what is currently riding the agent's next request. The standing one is what
  // the operator needs — text is being sent on their behalf and nothing else on
  // screen says so — so a flash borrows the line and hands it back rather than
  // clearing it.
  //
  // The standing claim is COMPOSED from two independent facts rather than
  // stored as one string, because the two have different lifetimes and one
  // clearing the other is a silent leak: a peek dies on the next click, while
  // an attachment rides every request for half an hour and its only off switch
  // is a gesture the operator will not make if nothing says it is there.
  let statusTimer = null;
  function stickyText() {
    // Attach outranks peek: it is deliberate, it persists, and the arm
    // suppresses a peek carrying the same bytes anyway.
    const name = activeName();
    if (name && attachedBy.has(name)) return attachedBy.get(name);
    return peekOn && peekOn === name ? peekLabel : '';
  }
  function paintStatus() {
    if (!statusEl) return;
    const sticky = stickyText();
    statusEl.textContent = sticky;
    statusEl.classList.toggle('bad', false);
    statusEl.classList.toggle('armed', !!sticky);
  }
  function refreshStatus() {
    if (!statusTimer) paintStatus();
  }
  function flash(msg, failed = false) {
    if (!statusEl) return;
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    statusEl.classList.toggle('bad', !!failed);
    statusEl.classList.remove('armed');
    statusTimer = setTimeout(() => {
      statusTimer = null;
      paintStatus();
    }, 1600);
  }

  // Disabled rather than hidden when there is nothing selected: a button that
  // appears and disappears under the cursor moves the two beside it, and the
  // operator clicks the wrong one.
  //
  // COLLAPSED COUNTS AS NOTHING SELECTED, and that is not belt-and-braces: a
  // DOM selection dies when the operator drags elsewhere, but xterm's SURVIVES
  // collapse. Without this, term-active → collapse → select in the sidebar
  // leaves the button armed and copying terminal text the operator can no longer
  // see, reporting a confident byte count for it.
  function syncCopy() {
    if (!copyBtn) return;
    const has = !isCollapsed() && !!activeSelection().trim();
    copyBtn.disabled = !has;
    copyBtn.classList.toggle('armed', has);
    // Every selection change in the drawer funnels through here — the document
    // listener, xterm's own callback, tab switches and collapse all call it — so
    // this is the one place the arm has to hang off to cover all four tenants.
    scheduleArm();
  }

  // ── The selection's trip to the agent ──────────────────────────────────────
  //
  // Two gestures, and the difference in how they REPORT is deliberate. Merely
  // selecting is passive: the operator did not ask for anything, so a refusal
  // (the pref is off, this session does not route through wirescope) is silent —
  // a status line that nattered on every drag would be trained out of sight, and
  // the line is the only thing that says text is riding. Clicking Copy is an
  // explicit ask, so every outcome including a refusal is reported.

  let armTimer = null;
  // The session a peek is currently registered on, so a switch away can take it
  // back from the session that holds it rather than from the new one.
  let peekOn = null;
  let peekLabel = '';
  // Attachments are per-session BY CONSTRUCTION (each rides its own route), so
  // the claim has to be too — one string would follow the operator to a session
  // that has nothing attached and vanish from the one that does.
  const attachedBy = new Map();
  // Every peek arm carries the generation it was issued in; a Copy click or a
  // session switch bumps it. A result from a superseded generation is DISCARDED
  // rather than painted — it describes a selection that is no longer the one on
  // screen, and painting it flips `attached` back to `riding next`.
  let armGen = 0;

  const activeName = () => (getActiveSession ? getActiveSession() : null);

  // Only the peek half. An attachment is deliberate and is taken back by the
  // second Copy click, never by clicking away.
  function releasePeek() {
    const name = peekOn;
    armGen++;
    peekOn = null;
    peekLabel = '';
    refreshStatus();
    if (!name || !window.api.drawerReleaseSelection) return;
    window.api.drawerReleaseSelection(name).then(armChanged, () => {});
  }

  function label(res, fallback) {
    const size = bytesLabel(res && res.bytes != null ? res.bytes : fallback);
    return res && res.truncated ? `${size} (truncated)` : size;
  }

  async function armPeek() {
    const name = activeName();
    const text = activeSelection();
    // Collapsed counts as no selection here for the same reason it does on the
    // button: xterm's selection survives a collapse, and text the operator can
    // no longer see must not keep riding their requests.
    if (!name || isCollapsed() || !text.trim()) { releasePeek(); return; }
    if (peekOn && peekOn !== name) releasePeek();
    if (!window.api.drawerArmSelection) { releasePeek(); return; }
    // Claimed BEFORE the await, not after: a session switch landing mid-flight
    // has to find a handle to release, or the peek stays registered on the
    // session the operator walked away from and rides one of its requests. The
    // main-process clear is memo-gated, so releasing a peek that never armed
    // costs nothing.
    const gen = ++armGen;
    peekOn = name;
    let res;
    try {
      res = await window.api.drawerArmSelection(name, { text, tab: activeId, attach: false });
    } catch {
      if (gen === armGen) { peekOn = null; peekLabel = ''; refreshStatus(); }
      return;
    }
    if (gen !== armGen) return;
    if (res && res.armed) {
      peekLabel = `riding next · ${label(res, text.length)}`;
    } else {
      // Not armed for whatever reason (off, no route, already attached) — say
      // nothing, but do not leave a stale claim that something is riding.
      peekOn = null;
      peekLabel = '';
    }
    refreshStatus();
    armChanged();
  }

  // Cancelled per event so only the pause arms — a drag fires selectionchange on
  // every mouse move, and each one would otherwise be a POST.
  function scheduleArm() {
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { armTimer = null; armPeek(); }, ARM_DEBOUNCE_MS);
  }

  // The clipboard and the wire, not either/or: Copy is an ATTACH gesture, and
  // the operator also expects to be able to paste what they just copied.
  async function copySelection() {
    const text = activeSelection();
    if (isCollapsed() || !text.trim()) { flash('nothing selected', true); return; }
    const name = activeName();
    // A pending peek would re-register the same bytes under the weaker framing a
    // moment after this attaches them. The generation bump covers the half this
    // cannot: a peek arm already awaiting its round trip is not cancellable, so
    // its result is discarded instead (the main process takes it off the wire).
    clearTimeout(armTimer);
    armTimer = null;
    armGen++;
    peekOn = null;
    peekLabel = '';
    // Both legs are started before either is awaited: the clipboard write must
    // not wait on a proxy round trip, and a proxy that is down must not cost the
    // operator the copy.
    const clip = navigator.clipboard.writeText(text).then(() => null, (e) => (e && e.message ? e.message : String(e)));
    const wire = (name && window.api.drawerArmSelection)
      ? window.api.drawerArmSelection(name, { text, tab: activeId, attach: true })
        .catch((e) => ({ armed: false, reason: e && e.message ? e.message : String(e) }))
      : Promise.resolve({ armed: false, reason: 'no active session' });
    const [clipErr, res] = await Promise.all([clip, wire]);
    if (clipErr) { flash(`copy failed: ${clipErr}`, true); return; }
    const clipSize = bytesLabel(text.length);
    if (res && res.handed) {
      // Queued for the transcript, delivered on the operator's next submit —
      // so the standing claim is about a DELIVERY that has not happened yet,
      // and it is cleared when it does rather than by any gesture here.
      if (name) attachedBy.set(name, `sending · ${label(res, text.length)}`);
      refreshStatus();
      armChanged();
      flash(`copied · ${clipSize} · sending`);
      return;
    }
    flash(`copied · ${clipSize} · not sent (${(res && res.reason) || 'unavailable'})`);
  }

  if (copyBtn) {
    // Pressing a toolbar button collapses the document selection as part of
    // mousedown's default action, so by the time `click` runs the selection this
    // button exists to honour is already gone. (xterm's own selection survives —
    // but the DOM tenants' does not, and one handler serves both.)
    copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
    copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copySelection(); });
    // Covers the DOM tenants. xterm fires no selectionchange, so term-tab drives
    // the same sync through the `onSelectionChange` handle it gets at register.
    document.addEventListener('selectionchange', syncCopy);
    syncCopy();
  }

  // Cmd-chords are captured at document level and act on the active SIDEBAR
  // session, so a drawer terminal with focus would archive an unrelated
  // session on Cmd+W. renderer.js's handlers early-return on this.
  //
  // TENANT CONTENT ONLY, never the header: tabs and the toggle are <button>s,
  // and Chromium leaves a clicked button focused — scoping this to #drawer
  // would make one tab click suppress every Cmd chord until the operator
  // clicked back into the terminal.
  function hasFocus() {
    return panesEl.contains(document.activeElement);
  }

  drawerHeader.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    toggle();
  });
  toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  if (tallBtn) {
    tallBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Talling a collapsed drawer opens it — the operator asked for more room,
      // and applying the mode invisibly would read as a dead button.
      if (isCollapsed()) toggle();
      setTall(!tall);
    });
  }
  // Boot: a remembered tall flag has to reach the DOM, and the drawer boots
  // collapsed so this only sets the button state until the first expand.
  syncTall();

  // Rule 3: the drawer's own geometry changes (window resize, collapse
  // transition) reach the active tenant. Nothing else observes this box.
  new ResizeObserver(() => {
    const rec = tenants.get(activeId);
    if (rec && isVisible(rec.id)) dispatchResize(rec);
  }).observe(panesEl);

  // Menu channel kept under its historical name (renaming it buys nothing);
  // its behaviour is now "open the drawer on the log tab".
  window.api.onRequestOpenIpcLog(() => open('log'));

  // Called when the operator switches SESSIONS. The peek is registered on one
  // session's route, so leaving that session must take it back — otherwise the
  // status line claims text is riding a request the operator is no longer
  // looking at, and the text rides it anyway. An ATTACHMENT deliberately stays
  // where it was put; it is per-session by construction and the operator asked
  // for it.
  function onSessionChanged() {
    clearTimeout(armTimer);
    armTimer = null;
    releasePeek();
    // Tenants that are SCOPED to a seat need to re-acquire, and the onShow/
    // onHide pair cannot tell them: rule 2 makes it strictly alternating, so a
    // switch while the tab is already visible fires neither. Only the VISIBLE
    // tenant is told — a hidden one re-acquires on its next onShow anyway, and
    // waking it here would spawn shells for panes nobody is looking at.
    const active = tenants.get(activeId);
    if (active && active.shown && active.def.onSeatChanged) {
      try { active.def.onSeatChanged(); } catch {}
    }
    // The attachment stays where it was put, so switching BACK has to find the
    // claim again — stickyText() reads it off the map by the now-current name,
    // and this repaint is what makes that visible without a selection change.
    refreshStatus();
  }

  // A session the operator deleted cannot be switched back to, so its claim has
  // no owner left to repaint it. The main process clears the registration
  // itself (selectionArm.forget); this drops the renderer's half so a rebuilt
  // session of the same name does not inherit a claim it never made.
  function forgetSession(name) {
    if (!name || !attachedBy.delete(name)) return;
    if (peekOn === name) releasePeek();
    refreshStatus();
  }

  // The queue went out with a submit. The claim was about a pending delivery,
  // so it retires here rather than on any gesture — the text is in the
  // transcript now and is nothing the operator still needs warning about.
  function onSelectionSent(name) {
    if (!name || !attachedBy.delete(name)) return;
    refreshStatus();
    armChanged();
  }

  return {
    register, open, toggle, hasFocus, domSelection,
    onSessionChanged, forgetSession, onSelectionSent,
  };
}

module.exports = { createDrawerHost, TAB_IDS };
