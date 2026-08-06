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

// Fixed order and the frozen id set: tab ids are part of the agent-facing
// source grammar (`drawer:<tabId>`), so they are chosen once and an unknown id
// is a programming error, not a new tab.
const TAB_IDS = Object.freeze(['log', 'activity', 'ctl', 'term']);

// Beyond this the badge is "a lot"; the count itself keeps counting.
const BADGE_MAX = 99;

function createDrawerHost({ refitActiveTerminal }) {
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

  let statusTimer = null;
  function flash(msg, failed = false) {
    if (!statusEl) return;
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    statusEl.classList.toggle('bad', !!failed);
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.classList.remove('bad');
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
  }

  function copySelection() {
    const text = activeSelection();
    if (isCollapsed() || !text.trim()) { flash('nothing selected', true); return; }
    // A clipboard write is async and CAN reject (permissions, an unfocused
    // document). Unreported, a rejection is indistinguishable from a copy that
    // worked, which is the failure this whole affordance exists to close.
    navigator.clipboard.writeText(text)
      .then(() => flash(`copied · ${bytesLabel(text.length)}`))
      .catch((e) => flash(`copy failed: ${e && e.message ? e.message : e}`, true));
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

  return { register, open, toggle, hasFocus, domSelection };
}

module.exports = { createDrawerHost, TAB_IDS };
