// Plugins hand this host data or callbacks, never HTML: everything
// user-supplied is escaped here. Every registered id becomes
// "<pluginId>:<id>" before it reaches the DOM, so a `data-act` carrying a
// colon is by construction a plugin's and never core's.

const { esc } = require('./lib/format');
const { renderDiffHtml } = require('./lib/render-html');

function initPluginHost({
  getActiveSession,          // () -> session name | null
  sessionTypeOf,             // (name) -> 'claude' | 'codex' | 'bash' | 'remote' | …
  activeIsAgent,             // () -> bool
  activePeerQueryable,       // () -> bool
  activePeerConfigurable,    // () -> bool
  scheduleSidebarRelayout,   // () -> void   (the debounced core relayout)
  listSessions,              // () -> Promise<[{name,type,cwd,…}]>  (session:list — WORKSPACE-SCOPED)
  openPath,                  // (p) -> void   (window.api.fileOpen — reveal in Finder)
  showToast,                 // (msg, opts) -> void
// () -> Promise<string|null>  (window.api.selectDirectory — the EXISTING
// dialog:selectDirectory row, not a new one). A plugin cannot reach window.api,
// so a native picker has to arrive as a dep; delegating keeps one main-process
// row behind both core's callers and plugins'.
  selectDirectory,
// No `= () => null` default here: the leak scanner's param matcher cannot
// cross nested parens, and a defaulted arrow hides every dep above it.
  getWorkspaceId,
// (pluginId, sessionName) -> bool. Absent = everything reaches everything, which
// is what a host built before this existed did — the default is today's
// behaviour, not a refusal.
  pluginReachesSession,
} = {}) {
  // The `reaches(` call sites below are the list — deliberately uncounted here,
  // since a comment that counts its siblings goes stale as one is added.
  // Per-session slots HIDE on false; the footer button and the overlay REFUSE
  // instead — dimmed and toasted, never removed, or the chrome reflows on every
  // seat switch. `settingsSections` are ungated: the Plugins dialog configures a
  // plugin process-wide, so a seat decision has nothing to say there.
  function reaches(pluginId, sessionName) {
    if (typeof pluginReachesSession !== 'function') return true;
    if (!sessionName) return true;
    try { return pluginReachesSession(pluginId, sessionName) !== false; } catch { return true; }
  }
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
  const eventListeners = [];  // { pluginId, topic, fn }

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
    try { console.warn(`[plugin:${pluginId}]`, (e && e.message) || e); } catch {}
  }

  // Deliver one core `plugin-event` to the plugin that emitted it. Scope was
  // already applied main-side (plugin-host-engine emitScoped): if this window
  // received the IPC it is an intended recipient, so re-filtering here would
  // second-guess a decision this side cannot see.
  //
  function deliverEvent(pluginId, topic, payload) {
    const t = String(topic);
    // Copy first: a listener that disposes its plugin mutates this array.
    for (const l of [...eventListeners]) {
      if (l.pluginId !== pluginId || l.topic !== t) continue;
      try { l.fn(payload); } catch (e) { warn(pluginId, e); }
    }
  }

  function purge(list, pluginId) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].pluginId === pluginId) list.splice(i, 1);
    }
  }

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

  const statusBar = {
    addAction(spec) {
      return register(statusActions, spec, ['when', 'button', 'onClick']);
    },
    addSegment(spec) {
      return register(statusSegments, spec, ['render']);
    },
  };

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

  function statusBarHtml() {
    const ctx = barContext();
    const out = [];
    for (const a of statusActions) {
      if (!reaches(a.pluginId, ctx.session)) continue;
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
      if (!reaches(s.pluginId, ctx.session)) continue;
      let r = null;
      try { r = s.render(ctx); } catch (e) { warn(s.pluginId, e); continue; }
      if (!r || !r.text) continue;
      const cls = r.accentClass ? ` ${esc(String(r.accentClass))}` : '';
      const tip = r.tip ? ` data-tip="${esc(String(r.tip))}"` : '';
      const act = typeof r.onClick === 'function' || typeof s.onClick === 'function'
        ? ` data-act="${esc(s.id)}"` : '';
      const btn = act ? ' px-ctx-btn' : '';
      out.push(`<span class="px-seg px-plugin${btn}${cls}"${act}${tip}>${esc(String(r.text))}</span>`);
    }
    return out.join('');
  }

  // Must apply the SAME filter statusBarHtml does. This decides whether the bar
  // draws at all, so a laxer test here reserves space for a contribution that
  // then renders empty — an unexplained gap in the chrome of exactly the
  // sessions the plugin is meant to be invisible to.
  function hasVisibleContribution() {
    const ctx = barContext();
    for (const a of statusActions) {
      if (!reaches(a.pluginId, ctx.session)) continue;
      try { if (a.when(ctx)) return true; } catch (e) { warn(a.pluginId, e); }
    }
    for (const s of statusSegments) {
      if (!reaches(s.pluginId, ctx.session)) continue;
      try { const r = s.render(ctx); if (r && r.text) return true; } catch (e) { warn(s.pluginId, e); }
    }
    return false;
  }

  // `reaches` here is enforcement, not hiding, for the same reason handleMenuPick
  // applies it: a `data-act` is a DOM attribute, so a bar painted before a grant
  // was revoked can still route a click here after it.
  function handleBarClick(act, anchorEl) {
    const ctx = barContext();
    for (const a of statusActions) {
      if (a.id !== act) continue;
      if (!reaches(a.pluginId, ctx.session)) return false;
      try { a.onClick(anchorEl, ctx); } catch (e) { warn(a.pluginId, e); }
      return true;
    }
    for (const s of statusSegments) {
      if (s.id !== act) continue;
      if (!reaches(s.pluginId, ctx.session)) return false;
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

  // `resolve` is SYNC by contract: the plugin fills its own cache and calls
  // requestRelayout. Removed from the row when resolve() returns null.
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
      // Per ROW, not per active session: the sidebar paints every session, so
      // this is the one slot where several grant answers are live at once. A
      // badge already on screen must also be REMOVED when the grant goes away,
      // which is why this falls through to the removal below rather than
      // `continue`-ing past it.
      if (!reaches(b.pluginId, name)) { if (chip) chip.remove(); continue; }
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
          // Re-read at CLICK time, not off the paint: a seat switch between the
          // two repaints leaves a live-looking button one frame stale, and the
          // dim is an affordance, not the gate.
          const seat = getActiveSession ? getActiveSession() : null;
          if (!reaches(b.pluginId, seat)) {
            if (showToast) showToast(`${b.label || b.id} is not enabled for ${seat}`);
            return;
          }
          try { b.onClick(el); } catch (e) { warn(b.pluginId, e); }
        });
        footer.appendChild(el);
      }
      el.querySelector('.footer-glyph').textContent = b.glyph ? String(b.glyph) : '';
      el.querySelector('.footer-label').textContent = b.label ? String(b.label) : '';
      const seat = getActiveSession ? getActiveSession() : null;
      const dimmed = !reaches(b.pluginId, seat);
      el.classList.toggle('plugin-footer-dimmed', dimmed);
      if (dimmed) el.setAttribute('data-tip', `Not enabled for ${seat} — tick it under Plugins`);
      else if (b.tip) el.setAttribute('data-tip', String(b.tip));
      else el.removeAttribute('data-tip');
      let badge = null;
      if (typeof b.badge === 'function') {
        try { badge = b.badge(); } catch (e) { warn(b.pluginId, e); }
      }
      const bEl = el.querySelector('.footer-badge');
      bEl.textContent = badge ? String(badge) : '';
      bEl.classList.toggle('zero', !badge);
    }
  }

  const sessionMenu = {
    addProvider(spec) { return register(menuProviders, spec, ['entriesFor', 'onPick']); },
  };

  // `sessionName` is optional and defaults to the active session rather than to
  // "unscoped": every caller opens this menu FOR a session, and a missing
  // argument at some future call site must not become a hole that surfaces a
  // scoped plugin's entries on a seat that never granted it.
  function menuEntriesFor(type, sessionName) {
    const forSession = sessionName || (getActiveSession ? getActiveSession() : null);
    const out = [];
    for (const p of menuProviders) {
      if (!reaches(p.pluginId, forSession)) continue;
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

  function handleMenuPick(act, sessionName, anchorEl) {
    const i = String(act).indexOf(':');
    if (i < 0) return false;
    const owner = act.slice(0, i);
    const bare = act.slice(i + 1);
    for (const p of menuProviders) {
      if (p.pluginId !== owner) continue;
      // Enforcement, not just hiding: an act string is a DOM attribute, so a
      // stale menu (opened before a grant was revoked) can still route here.
      if (!reaches(owner, sessionName)) return false;
      try { p.onPick(bare, sessionName, anchorEl); } catch (e) { warn(p.pluginId, e); }
      return true;
    }
    return false;
  }

  const settings = {
    section(spec) { return register(settingsSections, spec, ['render', 'collect']); },
  };

  // The container comes from the caller (the plugin's own row in Manage Plugins),
  // so this must never reach for a fixed dialog id: two rows expanded at once is
  // an ordinary state, and a document-wide lookup would render one plugin's form
  // into another row's panel.
  function renderSectionsInto(pluginId, containerEl, values = {}) {
    if (!containerEl) return 0;
    const mine = settingsSections.filter((s) => s.pluginId === pluginId);
    for (const el of [...containerEl.querySelectorAll('[data-plugin-section]')]) {
      if (!mine.some((s) => s.id === el.getAttribute('data-plugin-section'))) el.remove();
    }
    for (const s of mine) {
      let el = containerEl.querySelector(`[data-plugin-section="${CSS.escape(s.id)}"]`);
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
        containerEl.appendChild(el);
      }
      const body = el.querySelector('.plugin-section-body');
      body.innerHTML = '';
      try { s.render(body, values || {}); } catch (e) { warn(s.pluginId, e); }
    }
    return mine.length;
  }

  function settingsSectionOwners() {
    return [...new Set(settingsSections.map((s) => s.pluginId))];
  }

  // Null, not {}, when nothing was collected: the caller skips the settings.set
  // entirely, so a plugin that declines to save cannot have an empty patch
  // stamped over its stored values.
  function collectSectionsFrom(pluginId, containerEl) {
    if (!containerEl) return null;
    let patch = null;
    for (const s of settingsSections) {
      if (s.pluginId !== pluginId) continue;
      const el = containerEl.querySelector(`[data-plugin-section="${CSS.escape(s.id)}"]`);
      if (!el) continue;
      const body = el.querySelector('.plugin-section-body');
      try {
        const p = s.collect(body);
        if (p && typeof p === 'object') patch = { ...(patch || {}), ...p };
      } catch (e) { warn(s.pluginId, e); }
    }
    return patch;
  }

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
          // Refused BEFORE the close below, or a refused open still shuts
          // whatever the operator had open.
          const seat = getActiveSession ? getActiveSession() : null;
          if (!reaches(entry.pluginId, seat)) {
            if (showToast) showToast(`${entry.pluginId} is not enabled for ${seat}`);
            return;
          }
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
// Deliberately no unqualified `list()`/`listAll()`: `session:list` is already
// scoped to the sender window, and the explicit wsId filter makes the scope
// the caller's stated one rather than a property of which window asked.
      sessions: Object.freeze({
        active: () => (getActiveSession ? getActiveSession() : null),
        listWorkspace: async (wsId) => {
          if (!listSessions) return [];
          let list = [];
          try { list = await listSessions(); } catch { return []; }
          if (!Array.isArray(list)) return [];
          return list.filter((s) => s && s.workspaceId === wsId);
        },
      }),
      events: Object.freeze({
// Sync-only by construction: deliverEvent's try/catch cannot see an async
// listener's rejection, so awaiting one here would swallow it silently.
        on: (topic, fn) => {
          if (typeof fn !== 'function') return () => {};
          const entry = { pluginId, topic: String(topic), fn };
          eventListeners.push(entry);
          return disposable(pluginId, () => {
            const i = eventListeners.indexOf(entry);
            if (i >= 0) eventListeners.splice(i, 1);
          });
        },
      }),
      ui: Object.freeze({
        openPath: (p) => { if (openPath) openPath(String(p)); },
// Resolves null on cancel AND when the dep is absent, so a caller only ever has
// the one "no directory" branch to write.
        pickDirectory: () => (selectDirectory ? selectDirectory() : Promise.resolve(null)),
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
      lib: Object.freeze({ renderDiffHtml }),
      onDispose: (fn) => disposable(pluginId, fn),
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

  function activate(pluginId, mod, { invoke, css } = {}) {
// Already active in THIS window ⇒ idempotent no-op returning the existing
// rhost, never a throw: the caller reports a throw as a quarantine strike.
    if (activated.has(pluginId)) {
      const prev = resources.get(pluginId);
      return (prev && prev.rhost) || null;
    }
    const r = res(pluginId);
    activated.set(pluginId, mod);
    if (css) {
      // Per-plugin <style> rather than a <link>: works identically in the
      // file:// Electron window and the built web bundle, and removal is one
      // node.
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
// Before the disposers: a registry disposer splices the entry out of `overlays`,
// so the sweep below would miss it — onClose lost, openOverlay left dangling.
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
    for (const o of overlays) {
      if (o.pluginId === pluginId && o.el) {
        if (openOverlay === o) closeOpenOverlay();
        o.el.remove();
        o.el = null;
      }
    }
    if (r.styleEl) { r.styleEl.remove(); r.styleEl = null; }
    for (const list of [statusActions, statusSegments, footerButtons, rowBadges, menuProviders, settingsSections, overlays, eventListeners]) {
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

  function onSeatSwitched() {
    if (openOverlay && !reaches(openOverlay.pluginId, getActiveSession ? getActiveSession() : null)) {
      closeOpenOverlay();
    }
    renderFooterButtons();
  }

  return {
    statusBarHtml, hasVisibleContribution, handleBarClick,
    applyRowBadges, renderFooterButtons, onSeatSwitched,
    menuEntriesFor, handleMenuPick,
    renderSectionsInto, collectSectionsFrom, settingsSectionOwners,
    activate, dispose, disposeAll,
    deliverEvent,
    statusBar, sidebar, sessionMenu, settings, surfaces,
    _counts: () => ({
      actions: statusActions.length, segments: statusSegments.length,
      footer: footerButtons.length, badges: rowBadges.length,
      events: eventListeners.length,
      menus: menuProviders.length, sections: settingsSections.length,
      overlays: overlays.length,
    }),
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
