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
//      expands), so a tenant that measures itself must do it in onShow, never
//      in mount(). Build DOM in mount; call terminal.open()/fit() from onShow.
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
  const panesEl = document.getElementById('drawer-panes');

  const tenants = new Map(); // id -> { id, def, pane, actions, tabEl, badgeEl, unread, mounted }
  let activeId = null;

  const isCollapsed = () => drawer.classList.contains('collapsed');
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
  }

  function toggle() {
    drawer.classList.toggle('collapsed');
    const expanded = !isCollapsed();
    document.getElementById('main').classList.toggle('drawer-expanded', expanded);
    const rec = tenants.get(activeId);
    if (rec) {
      if (expanded) {
        clearBadge(rec);
        dispatchShow(rec);
      } else {
        dispatchHide(rec);
      }
    }
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
    return function notify(level) {
      if (isVisible(rec.id)) return; // the operator is looking at it
      rec.unread++;
      if (level === 'attention') rec.attention = true;
      renderBadge(rec);
    };
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

  // Rule 3: the drawer's own geometry changes (window resize, collapse
  // transition) reach the active tenant. Nothing else observes this box.
  new ResizeObserver(() => {
    const rec = tenants.get(activeId);
    if (rec && isVisible(rec.id)) dispatchResize(rec);
  }).observe(panesEl);

  // Menu channel kept under its historical name (renaming it buys nothing);
  // its behaviour is now "open the drawer on the log tab".
  window.api.onRequestOpenIpcLog(() => open('log'));

  return { register, open, toggle, hasFocus };
}

module.exports = { createDrawerHost, TAB_IDS };
