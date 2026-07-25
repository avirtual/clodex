// plugin-host.js — the RENDERER half of the plugin host (plugin-plan.md [internal design doc, not in this repo]
// §2.1-2.6, §3.3). Owns the six UI registries core reads from, and the `rhost`
// object a plugin's renderer half is activated with. Phase 1 ships no plugins:
// core populates nothing here, the registries sit empty, and every accessor
// returns the empty answer that reproduces today's bytes exactly.
//
// FACTORY (island convention): initPluginHost(deps) returns the handles core
// calls at its five seams (see renderer.js). Deps are the core functions the
// registries need to do their job — never the reverse; no registry reaches back
// into renderer.js scope (free-identifier-leaks gate).
//
// THREE LAWS this file exists to enforce:
//
// 1. DECLARATIVE ONLY. A plugin hands us data or a callback returning data —
//    never an HTML string. Everything user-supplied is escaped HERE. That is
//    what lets the same specs cross the Tier-B (out-of-process) boundary later
//    without changing shape.
//
// 2. NAMESPACED IDS. Every registered id becomes "<pluginId>:<id>" before it
//    reaches the DOM, so two plugins cannot collide and a `data-act` carrying a
//    colon is by construction a plugin's, never core's.
//
// 3. REAL TEARDOWN (plan §3.1, Reviewer MUST-FIX A2). Window close is free
//    teardown — the whole renderer dies. DISABLE-WITHOUT-CLOSE is not, and it
//    is the path that leaves callbacks firing against a removed container in
//    every open window. So a plugin gets THREE overlapping mechanisms and the
//    host trusts none of them individually:
//      a. an optional `dispose()` returned from activate(), invoked FIRST;
//      b. `rhost.onDispose(fn)` for anything it set up out of band;
//      c. host-WRAPPED setInterval/setTimeout/addEventListener, which the host
//         unregisters itself — so the common leaks need no plugin discipline.
//    `_liveResources()` is the introspection seam the W9 gate asserts zero on.

const { esc } = require('./lib/format');
// A sanctioned shared LEAF, exposed to plugins as `rhost.lib.renderDiffHtml`
// (plan §4 W5). render-html.js stays core because renderer.js, files-popover,
// bust-popover and cost-popover all use it — a plugin gets a named, versioned
// view of it rather than a private copy (drifts) or a relative require that
// escapes the plugin directory (which the no-backdoor lint exists to kill).
const { renderDiffHtml } = require('./lib/render-html');

function initPluginHost({
  getActiveSession,          // () -> session name | null
  sessionTypeOf,             // (name) -> 'claude' | 'codex' | 'bash' | 'remote' | …
  activeIsAgent,             // () -> bool
  activePeerQueryable,       // () -> bool
  activePeerConfigurable,    // () -> bool
  scheduleSidebarRelayout,   // () -> void   (the debounced core relayout)
  // Core capabilities a plugin's renderer half reaches through rhost instead of
  // window.api (the no-backdoor lint). All three have non-workbench consumers in
  // core, which is exactly why they are wrapped rather than moved.
  listSessions,              // () -> Promise<[{name,type,cwd,…}]>  (session:list — WORKSPACE-SCOPED)
  openPath,                  // (p) -> void   (window.api.fileOpen — reveal in Finder)
  showToast,                 // (msg, opts) -> void
  // GETTER-shaped: this window's workspace id is filled ASYNCHRONOUSLY
  // (renderer.js:353 awaits window.api.currentWorkspace()), so a captured value
  // would be null forever. Law 1 of §3.3 requires rhost to carry it.
  // No `= () => null` default: the leak scanner's param matcher cannot cross
  // nested parens, and a defaulted arrow in this list would hide EVERY dep
  // above it from the scan (verified — it did).
  getWorkspaceId,
} = {}) {
  // ── Registries ────────────────────────────────────────────────────────────
  // Arrays, not Maps: render order is registration order, and every consumer
  // iterates. Each entry keeps its owning pluginId so disable can filter.
  const statusActions = [];   // { pluginId, id, when, button, onClick }
  const statusSegments = [];  // { pluginId, id, render }
  const footerButtons = [];   // { pluginId, id, glyph, label, tip, onClick, badge }
  const rowBadges = [];       // { pluginId, id, resolve }
  const menuProviders = [];   // { pluginId, id, entriesFor, onPick }
  const settingsSections = []; // { pluginId, id, title, render, collect }
  const overlays = [];        // { pluginId, id, mount, onOpen, onClose, el, mounted }

  // pluginId -> { disposers:Set<fn>, timers:Set, intervals:Set, listeners:[], styleEl }
  const resources = new Map();
  const activated = new Map(); // pluginId -> the plugin's renderer module

  function res(pluginId) {
    if (!resources.has(pluginId)) {
      resources.set(pluginId, {
        disposers: new Set(), timers: new Set(), intervals: new Set(),
        listeners: [], styleEl: null, ownDispose: null, rhost: null,
      });
    }
    return resources.get(pluginId);
  }

  // A disposer that is safe to call twice and removes itself from the ledger,
  // so `dispose()` inside a plugin and host teardown never double-fire.
  function disposable(pluginId, fn) {
    const r = res(pluginId);
    let done = false;
    const d = () => {
      if (done) return;
      done = true;
      r.disposers.delete(d);
      try { fn(); } catch (e) { warn(pluginId, e); }
    };
    r.disposers.add(d);
    return d;
  }

  function warn(pluginId, e) {
    // Never throw out of a registry walk: one broken plugin must not blank the
    // status bar or the sidebar for every other contribution.
    try { console.warn(`[plugin:${pluginId}]`, (e && e.message) || e); } catch {}
  }

  // Remove every entry a plugin owns from every registry, in place.
  function purge(list, pluginId) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].pluginId === pluginId) list.splice(i, 1);
    }
  }

  // ── The context object every §2.1 callback receives ───────────────────────
  // Built fresh per render pass from core's own predicates, so a plugin sees
  // exactly what the bar sees and cannot drift from it.
  function barContext() {
    const session = getActiveSession ? getActiveSession() : null;
    return Object.freeze({
      session,
      type: session && sessionTypeOf ? sessionTypeOf(session) : null,
      peerQueryable: !!(activePeerQueryable && activePeerQueryable()),
      peerConfigurable: !!(activePeerConfigurable && activePeerConfigurable()),
      isAgent: !!(activeIsAgent && activeIsAgent()),
      workspaceId: getWorkspaceId ? getWorkspaceId() : null,
    });
  }

  // ── §2.1 Status bar ───────────────────────────────────────────────────────
  // Contributions render INSIDE #proxy-actions via renderSessionActions, which
  // every branch of renderProxyBar calls (incl. both early returns) — so a
  // plugin's segment is never silently dropped on Bedrock/Vertex or unlinked
  // sessions. Verified: renderer.js:3010 (top call) and :3040 (!linked re-call).
  const statusBar = {
    addAction(spec) {
      return register(statusActions, spec, ['when', 'button', 'onClick']);
    },
    addSegment(spec) {
      return register(statusSegments, spec, ['render']);
    },
  };

  // Shared registration guts: validate, namespace, push, hand back a disposer.
  function register(list, spec, fnKeys, pluginId) {
    const owner = pluginId || (spec && spec.pluginId) || null;
    if (!owner) throw new Error('plugin registration requires a pluginId');
    if (!spec || typeof spec.id !== 'string' || !spec.id) {
      throw new Error(`[plugin:${owner}] registration requires a string id`);
    }
    for (const k of fnKeys) {
      if (typeof spec[k] !== 'function') {
        throw new Error(`[plugin:${owner}] ${spec.id}: ${k}() must be a function`);
      }
    }
    const entry = { ...spec, pluginId: owner, id: `${owner}:${spec.id}` };
    list.push(entry);
    return disposable(owner, () => {
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    });
  }

  // HTML for the plugin half of #proxy-actions, appended to core's own buttons.
  // Both label and tip are escaped here (law 1) — a plugin cannot inject markup.
  function statusBarHtml() {
    const ctx = barContext();
    const out = [];
    for (const a of statusActions) {
      let show = false, b = null;
      try { show = !!a.when(ctx); } catch (e) { warn(a.pluginId, e); continue; }
      if (!show) continue;
      try { b = a.button(ctx); } catch (e) { warn(a.pluginId, e); continue; }
      if (!b || !b.label) continue;
      const cls = b.accentClass ? ` ${esc(String(b.accentClass))}` : '';
      const tip = b.tip ? ` data-tip="${esc(String(b.tip))}"` : '';
      out.push(`<button class="px-action px-plugin${cls}" data-act="${esc(a.id)}"${tip}>${esc(String(b.label))}</button>`);
    }
    for (const s of statusSegments) {
      let r = null;
      try { r = s.render(ctx); } catch (e) { warn(s.pluginId, e); continue; }
      if (!r || !r.text) continue;
      const cls = r.accentClass ? ` ${esc(String(r.accentClass))}` : '';
      const tip = r.tip ? ` data-tip="${esc(String(r.tip))}"` : '';
      // Clickable segments opt in by supplying onClick; the data-act is what the
      // core delegated listener matches, same as the ctx/cost/bust segments.
      const act = typeof r.onClick === 'function' || typeof s.onClick === 'function'
        ? ` data-act="${esc(s.id)}"` : '';
      const btn = act ? ' px-ctx-btn' : '';
      out.push(`<span class="px-seg px-plugin${btn}${cls}"${act}${tip}>${esc(String(r.text))}</span>`);
    }
    return out.join('');
  }

  // The §2.1 bar-visibility question. Core's hide branch fires only when NO
  // agent/peer condition holds; this lets a segment keep the bar alive for a
  // session type core would hide it for (e.g. a bash session).
  function hasVisibleContribution() {
    const ctx = barContext();
    for (const a of statusActions) {
      try { if (a.when(ctx)) return true; } catch (e) { warn(a.pluginId, e); }
    }
    for (const s of statusSegments) {
      try { const r = s.render(ctx); if (r && r.text) return true; } catch (e) { warn(s.pluginId, e); }
    }
    return false;
  }

  // Route a namespaced data-act from the bar to its owner. Returns true iff a
  // plugin owned it, so core's dispatch chain can fall through unchanged.
  function handleBarClick(act, anchorEl) {
    const ctx = barContext();
    for (const a of statusActions) {
      if (a.id !== act) continue;
      try { a.onClick(anchorEl, ctx); } catch (e) { warn(a.pluginId, e); }
      return true;
    }
    for (const s of statusSegments) {
      if (s.id !== act) continue;
      let r = null;
      try { r = s.render(ctx); } catch (e) { warn(s.pluginId, e); return true; }
      const fn = (r && typeof r.onClick === 'function') ? r.onClick : s.onClick;
      if (typeof fn === 'function') {
        try { fn(anchorEl, ctx); } catch (e) { warn(s.pluginId, e); }
      }
      return true;
    }
    return false;
  }

  // ── §2.2 Sidebar ──────────────────────────────────────────────────────────
  // A footer button is DOM the host owns, so registration paints it and the
  // disposer un-paints it — the caller never has to remember either.
  function addFooterButton(spec, pluginId) {
    const d = register(footerButtons, spec, ['onClick'], pluginId);
    renderFooterButtons();
    return () => { d(); renderFooterButtons(); };
  }

  const sidebar = {
    footerButton(spec) { return addFooterButton(spec); },
    rowBadge(spec) { return register(rowBadges, spec, ['resolve']); },
    requestRelayout() { if (scheduleSidebarRelayout) scheduleSidebarRelayout(); },
  };

  // Paint plugin badges into a row's .session-badges, mirroring applyPrBadge
  // (renderer.js:1045) — one span per registered badge, data-tip for the
  // body-delegated tooltip, removed when resolve() returns null. `resolve` is
  // SYNC by contract: the plugin fills its own cache and calls requestRelayout.
  function applyRowBadges(item) {
    if (!item || !rowBadges.length) return;
    const badges = item.querySelector('.session-badges');
    if (!badges) return;
    const name = item.dataset.name;
    const meta = { type: item.dataset.type || null, cwd: item.dataset.cwd || '' };
    for (const b of rowBadges) {
      const sel = `[data-plugin-badge="${CSS.escape(b.id)}"]`;
      let chip = badges.querySelector(sel);
      let r = null;
      try { r = b.resolve(name, meta); } catch (e) { warn(b.pluginId, e); }
      if (!r || !r.text) { if (chip) chip.remove(); continue; }
      if (!chip) {
        chip = document.createElement('span');
        chip.setAttribute('data-plugin-badge', b.id);
        badges.appendChild(chip);
      }
      chip.className = `session-plugin-badge${r.cls ? ` ${String(r.cls)}` : ''}`;
      chip.textContent = String(r.text);
      if (r.tip) chip.setAttribute('data-tip', String(r.tip));
      else chip.removeAttribute('data-tip');
    }
  }

  // Footer buttons match #sidebar-footer's existing two (glyph span + label
  // span); the optional badge() adds a count chip like #inbox-count.
  function renderFooterButtons() {
    const footer = document.getElementById('sidebar-footer');
    if (!footer) return;
    for (const el of [...footer.querySelectorAll('[data-plugin-footer]')]) {
      if (!footerButtons.some((b) => b.id === el.getAttribute('data-plugin-footer'))) el.remove();
    }
    for (const b of footerButtons) {
      let el = footer.querySelector(`[data-plugin-footer="${CSS.escape(b.id)}"]`);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.setAttribute('data-plugin-footer', b.id);
        // Built node-by-node rather than innerHTML-joined: nothing here is a
        // string a plugin supplied, and the two existing footer buttons'
        // structure (glyph span + label span) is reproduced exactly.
        for (const cls of ['footer-glyph', 'footer-label', 'footer-badge']) {
          const sp = document.createElement('span');
          sp.className = cls;
          el.appendChild(sp);
        }
        el.addEventListener('click', () => {
          try { b.onClick(el); } catch (e) { warn(b.pluginId, e); }
        });
        footer.appendChild(el);
      }
      el.querySelector('.footer-glyph').textContent = b.glyph ? String(b.glyph) : '';
      el.querySelector('.footer-label').textContent = b.label ? String(b.label) : '';
      if (b.tip) el.setAttribute('data-tip', String(b.tip));
      let badge = null;
      if (typeof b.badge === 'function') {
        try { badge = b.badge(); } catch (e) { warn(b.pluginId, e); }
      }
      const bEl = el.querySelector('.footer-badge');
      bEl.textContent = badge ? String(badge) : '';
      bEl.classList.toggle('zero', !badge);
    }
  }

  // ── §2.4 Session menu ─────────────────────────────────────────────────────
  // The table stays a table: providers return entry LISTS, not predicates.
  const sessionMenu = {
    addProvider(spec) { return register(menuProviders, spec, ['entriesFor', 'onPick']); },
  };

  // Extra entries for the ⚙ menu, appended after core's sessionMenuEntries.
  // `act` is namespaced by the host, which is also how routeSessionAction tells
  // a plugin pick from a core one.
  function menuEntriesFor(type) {
    const out = [];
    for (const p of menuProviders) {
      let entries = null;
      try { entries = p.entriesFor(type); } catch (e) { warn(p.pluginId, e); continue; }
      if (!Array.isArray(entries)) continue;
      for (const en of entries) {
        if (!en || typeof en.act !== 'string' || !en.label) continue;
        out.push({ act: `${p.pluginId}:${en.act}`, label: String(en.label) });
      }
    }
    return out;
  }

  // Route a namespaced act back to the provider that offered it. Returns true
  // iff a plugin owned it (core's routeSessionAction falls through otherwise).
  function handleMenuPick(act, sessionName, anchorEl) {
    const i = String(act).indexOf(':');
    if (i < 0) return false;
    const owner = act.slice(0, i);
    const bare = act.slice(i + 1);
    for (const p of menuProviders) {
      if (p.pluginId !== owner) continue;
      try { p.onPick(bare, sessionName, anchorEl); } catch (e) { warn(p.pluginId, e); }
      return true;
    }
    return false;
  }

  // ── §2.5 Settings ─────────────────────────────────────────────────────────
  const settings = {
    section(spec) { return register(settingsSections, spec, ['render', 'collect']); },
  };

  // Mount every registered section into #prefs-dialog before .dialog-actions,
  // then hand each its own persisted values. Called from openPrefs.
  // `values` comes from the caller (core awaits pluginInvoke('_host',
  // 'settings.get') per plugin) — this half never touches window.api.
  function renderSettingsSections(valuesByPlugin = {}) {
    const dialog = document.getElementById('prefs-dialog');
    if (!dialog) return;
    for (const el of [...dialog.querySelectorAll('[data-plugin-section]')]) {
      if (!settingsSections.some((s) => s.id === el.getAttribute('data-plugin-section'))) el.remove();
    }
    const actions = dialog.querySelector('.dialog-actions');
    for (const s of settingsSections) {
      let el = dialog.querySelector(`[data-plugin-section="${CSS.escape(s.id)}"]`);
      if (!el) {
        el = document.createElement('section');
        el.setAttribute('data-plugin-section', s.id);
        el.setAttribute('data-plugin', s.pluginId);
        if (s.title) {
          const h = document.createElement('h3');
          h.textContent = String(s.title);
          el.appendChild(h);
        }
        const body = document.createElement('div');
        body.className = 'plugin-section-body';
        el.appendChild(body);
        if (actions) dialog.insertBefore(el, actions); else dialog.appendChild(el);
      }
      const body = el.querySelector('.plugin-section-body');
      body.innerHTML = '';
      try { s.render(body, valuesByPlugin[s.pluginId] || {}); } catch (e) { warn(s.pluginId, e); }
    }
  }

  // Which plugins have a section, so the caller knows whose values to pull
  // BEFORE anything is rendered (pull-on-open, §3.3). Empty ⇒ zero invokes.
  function settingsSectionOwners() {
    return [...new Set(settingsSections.map((s) => s.pluginId))];
  }

  // -> [{ pluginId, patch }] for the Save handler to persist. Collecting is
  // separate from persisting so the transport stays core's.
  function collectSettingsSections() {
    const dialog = document.getElementById('prefs-dialog');
    if (!dialog) return [];
    const out = [];
    for (const s of settingsSections) {
      const el = dialog.querySelector(`[data-plugin-section="${CSS.escape(s.id)}"]`);
      if (!el) continue;
      const body = el.querySelector('.plugin-section-body');
      try {
        const patch = s.collect(body);
        if (patch && typeof patch === 'object') out.push({ pluginId: s.pluginId, patch });
      } catch (e) { warn(s.pluginId, e); }
    }
    return out;
  }

  // ── §2.6 Whole-surface mounting ───────────────────────────────────────────
  // The disable guarantee: the host creates the container and removes it
  // WHOLESALE on teardown, so cleanup never trusts the plugin's own code
  // (MUST-FIX 6). mount() is called once, lazily, at first open.
  let openOverlay = null;

  function closeOpenOverlay() {
    if (!openOverlay) return;
    const o = openOverlay;
    openOverlay = null;
    if (o.el) o.el.classList.add('hidden');
    if (typeof o.onClose === 'function') {
      try { o.onClose(); } catch (e) { warn(o.pluginId, e); }
    }
  }

  const surfaces = {
    overlay(spec) {
      const dispose = register(overlays, spec, ['mount']);
      const entry = overlays[overlays.length - 1];
      return {
        open(opts) {
          closeOpenOverlay(); // one overlay at a time, host-centralized
          if (!entry.el) {
            entry.el = document.createElement('div');
            entry.el.className = 'plugin-overlay hidden';
            entry.el.setAttribute('data-plugin', entry.pluginId);
            document.body.appendChild(entry.el);
            try { entry.mount(entry.el); } catch (e) { warn(entry.pluginId, e); }
          }
          entry.el.classList.remove('hidden');
          openOverlay = entry;
          if (typeof entry.onOpen === 'function') {
            try { entry.onOpen(opts); } catch (e) { warn(entry.pluginId, e); }
          }
        },
        close() { if (openOverlay === entry) closeOpenOverlay(); },
        dispose() {
          if (openOverlay === entry) closeOpenOverlay();
          if (entry.el) { entry.el.remove(); entry.el = null; }
          dispose();
        },
      };
    },
  };

  // Escape closes the open overlay — centralized here so no plugin installs its
  // own document-level key handler for it (one less thing teardown must reach).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openOverlay) { e.stopPropagation(); closeOpenOverlay(); }
  });

  // ── rhost: what a plugin's renderer half is activated with ────────────────
  // Note what is NOT here: window.api. Plugins reach the engine only through
  // `invoke`, which the no-backdoor lint (test/plugin-boundary.test.js) enforces.
  function buildRhost(pluginId, invoke) {
    const r = res(pluginId);
    return Object.freeze({
      id: pluginId,
      get workspaceId() { return getWorkspaceId ? getWorkspaceId() : null; },
      invoke: (method, ...args) => invoke(pluginId, method, args),
      // ── sessions (renderer side) ──
      // ONE accessor, and it is the SCOPED one. There is deliberately no
      // `listAll()` here and no unqualified `list()`: the engine half's law 1
      // exists because conflating the two silently widens a per-window dropdown
      // into a cross-workspace surface, and `fsScope` would NOT catch it (it
      // refuses PEERS, not foreign workspaces). `session:list` is already
      // sender-window-scoped [ipc-handlers.js:387
      // `manager.listForWorkspace(workspaceOfSender(e))`]; the filter here makes
      // the scope the CALLER's stated one rather than an implicit property of
      // which window happened to ask.
      sessions: Object.freeze({
        // The session the user is looking at in THIS window, or null. Same
        // predicate the status-bar context uses, so a plugin and the bar can
        // never disagree about what "active" means.
        active: () => (getActiveSession ? getActiveSession() : null),
        listWorkspace: async (wsId) => {
          if (!listSessions) return [];
          let list = [];
          try { list = await listSessions(); } catch { return []; }
          if (!Array.isArray(list)) return [];
          return list.filter((s) => s && s.workspaceId === wsId);
        },
      }),
      ui: Object.freeze({
        // Reveal a path in the OS file manager. Core's row (window.api.fileOpen)
        // stays — files-popover.js uses it too.
        openPath: (p) => { if (openPath) openPath(String(p)); },
        // Core's toast host, so a plugin's errors look like every other error in
        // the app instead of an alert().
        showToast: (msg, opts) => {
          if (showToast) showToast(String(msg), opts || {});
          else { try { console.warn(`[plugin:${pluginId}]`, msg); } catch {} }
        },
        statusBar: Object.freeze({
          addAction: (s) => register(statusActions, s, ['when', 'button', 'onClick'], pluginId),
          addSegment: (s) => register(statusSegments, s, ['render'], pluginId),
        }),
        sidebar: Object.freeze({
          footerButton: (s) => addFooterButton(s, pluginId),
          rowBadge: (s) => register(rowBadges, s, ['resolve'], pluginId),
          requestRelayout: sidebar.requestRelayout,
        }),
        sessionMenu: Object.freeze({
          addProvider: (s) => register(menuProviders, s, ['entriesFor', 'onPick'], pluginId),
        }),
        settings: Object.freeze({
          section: (s) => register(settingsSections, s, ['render', 'collect'], pluginId),
        }),
        surfaces: Object.freeze({
          overlay: (s) => surfaces.overlay({ ...s, pluginId }),
        }),
      }),
      // Sanctioned shared pure leaves, mirroring the engine host's `lib`.
      lib: Object.freeze({ renderDiffHtml }),
      // ── Law 3: the teardown surface ──
      onDispose: (fn) => disposable(pluginId, fn),
      // Wrapped timers/listeners. The plugin writes ordinary code; the host
      // holds the handles and clears them on disable, so the common leak needs
      // no discipline from the plugin author.
      setInterval: (fn, ms, ...a) => {
        const h = setInterval(fn, ms, ...a);
        r.intervals.add(h);
        return h;
      },
      clearInterval: (h) => { r.intervals.delete(h); clearInterval(h); },
      setTimeout: (fn, ms, ...a) => {
        const h = setTimeout(() => { r.timers.delete(h); fn(); }, ms, ...a);
        r.timers.add(h);
        return h;
      },
      clearTimeout: (h) => { r.timers.delete(h); clearTimeout(h); },
      addEventListener: (target, type, fn, opts) => {
        target.addEventListener(type, fn, opts);
        r.listeners.push({ target, type, fn, opts });
      },
      removeEventListener: (target, type, fn, opts) => {
        target.removeEventListener(type, fn, opts);
        const i = r.listeners.findIndex((l) => l.target === target && l.type === type && l.fn === fn);
        if (i >= 0) r.listeners.splice(i, 1);
      },
      log: {
        info: (...a) => { try { console.log(`[plugin:${pluginId}]`, ...a); } catch {} },
        error: (...a) => { try { console.error(`[plugin:${pluginId}]`, ...a); } catch {} },
      },
    });
  }

  // ── Activation / disposal ─────────────────────────────────────────────────
  // Once per BrowserWindow (law 1 of §3.3). `mod.activate(rhost)` MAY return a
  // dispose function; if it does, that runs before host teardown.
  function activate(pluginId, mod, { invoke, css } = {}) {
    // Already active in THIS window ⇒ an idempotent no-op returning the rhost the
    // plugin already holds, NEVER a throw (t8). This used to throw, and the one
    // real caller — renderer.js's `plugin-state` subscriber — catches around
    // activation and reports the catch to `_host` renderer.report as a renderer
    // FAILURE, which is a genuine quarantine strike. So an enable broadcast
    // arriving at a window that had already activated (two windows toggling, a
    // toggle racing the catalog pull at startup) put a strike on a perfectly
    // HEALTHY plugin, and two of those quarantine it. Double activation is not a
    // fault condition — it is the expected shape of an unbuffered broadcast
    // (§3.3 law 2) reaching a window that already pulled.
    if (activated.has(pluginId)) {
      const prev = resources.get(pluginId);
      return (prev && prev.rhost) || null;
    }
    const r = res(pluginId);
    activated.set(pluginId, mod);
    if (css) {
      // Per-plugin <style> rather than a <link>: works identically in the
      // file:// Electron window and the built web bundle, and removal is one
      // node (plan §2.6 CSS decision).
      const st = document.createElement('style');
      st.setAttribute('data-plugin-style', pluginId);
      st.textContent = String(css);
      document.head.appendChild(st);
      r.styleEl = st;
    }
    const rhost = buildRhost(pluginId, invoke || (() => Promise.resolve({ ok: false, error: 'no transport' })));
    r.rhost = rhost;   // so a repeat activate() hands back the same one
    let own = null;
    try {
      own = mod && typeof mod.activate === 'function' ? mod.activate(rhost) : null;
    } catch (e) {
      warn(pluginId, e);
      dispose(pluginId);        // a half-activated plugin leaves nothing behind
      throw e;
    }
    if (typeof own === 'function') r.ownDispose = own;
    else if (mod && typeof mod.deactivate === 'function') r.ownDispose = () => mod.deactivate();
    return rhost;
  }

  // Full teardown for one plugin. Order matters: the plugin's own dispose runs
  // FIRST (while its DOM still exists), then host-held resources, then the
  // registry rows and containers.
  function dispose(pluginId) {
    const r = resources.get(pluginId);
    activated.delete(pluginId);
    if (!r) return false;
    if (r.ownDispose) {
      try { r.ownDispose(); } catch (e) { warn(pluginId, e); }
      r.ownDispose = null;
    }
    // Close an open overlay BEFORE the disposers run. A registry disposer
    // splices the entry out of `overlays`, so by the time the sweep below
    // looks, an eagerly-disposed overlay is invisible to it — `onClose` would
    // never fire and `openOverlay` would be left pointing at a dead plugin,
    // suppressing the next open's close. Found by test, not by reading.
    if (openOverlay && openOverlay.pluginId === pluginId) closeOpenOverlay();
    for (const h of r.intervals) clearInterval(h);
    r.intervals.clear();
    for (const h of r.timers) clearTimeout(h);
    r.timers.clear();
    for (const l of r.listeners) {
      try { l.target.removeEventListener(l.type, l.fn, l.opts); } catch {}
    }
    r.listeners.length = 0;
    for (const d of [...r.disposers]) d();
    r.disposers.clear();
    // Containers the host created, removed wholesale — teardown never trusts
    // the plugin to have cleaned its own interior.
    for (const o of overlays) {
      if (o.pluginId === pluginId && o.el) {
        if (openOverlay === o) closeOpenOverlay();
        o.el.remove();
        o.el = null;
      }
    }
    if (r.styleEl) { r.styleEl.remove(); r.styleEl = null; }
    for (const list of [statusActions, statusSegments, footerButtons, rowBadges, menuProviders, settingsSections, overlays]) {
      purge(list, pluginId);
    }
    for (const el of [...document.querySelectorAll(`[data-plugin="${CSS.escape(pluginId)}"]`)]) el.remove();
    for (const el of [...document.querySelectorAll(`[data-plugin-badge^="${CSS.escape(pluginId)}:"]`)]) el.remove();
    resources.delete(pluginId);
    renderFooterButtons();
    return true;
  }

  function disposeAll() {
    for (const id of [...resources.keys()]) dispose(id);
  }

  return {
    // Core's five seams.
    statusBarHtml, hasVisibleContribution, handleBarClick,
    applyRowBadges, renderFooterButtons,
    menuEntriesFor, handleMenuPick,
    renderSettingsSections, collectSettingsSections, settingsSectionOwners,
    // Lifecycle (the Phase-2 loader and the in-tests fake plugin drive these).
    activate, dispose, disposeAll,
    // Direct registry access for core-registered contributions (none in Phase 1).
    statusBar, sidebar, sessionMenu, settings, surfaces,
    // Introspection seams — read-only counts, never the live containers.
    _counts: () => ({
      actions: statusActions.length, segments: statusSegments.length,
      footer: footerButtons.length, badges: rowBadges.length,
      menus: menuProviders.length, sections: settingsSections.length,
      overlays: overlays.length,
    }),
    // W9 gate #1 asserts this is zero for a disabled plugin.
    _liveResources: (pluginId) => {
      const r = resources.get(pluginId);
      if (!r) return { timers: 0, intervals: 0, listeners: 0, disposers: 0, style: false };
      return {
        timers: r.timers.size, intervals: r.intervals.size,
        listeners: r.listeners.length, disposers: r.disposers.size,
        style: !!r.styleEl,
      };
    },
  };
}

module.exports = { initPluginHost };
