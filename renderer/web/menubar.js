'use strict';
// menubar.js — the browser frontend's top menu bar (web-frontend Phase 5). It
// replaces the earlier floating "☰" corner button with a real horizontal menu
// bar that mirrors the Electron application menu (app-menus.js): File / Library /
// View / Teams / Window. The Edit/View native roles the browser already
// supplies (undo/copy/reload/full-screen/…) are deliberately omitted.
//
// Layout: the bar lives in its own strip at the top of #main. mount() adds
// `.has-web-menubar` to #main, which (via styles.css, web-gated) pushes
// #terminal-container down by the bar height. That shrink is observed by the
// renderer's existing ResizeObserver on #terminal-container, so xterm refits to
// the reduced height with no explicit refit call here — the proper fix for the
// fit-measurement concern that once justified the corner button.
//
// Actions: request-* drawer/dialog entries fire LOCALLY into the renderer's own
// subscribers via shim.emit() (identical to the app menu's IPC sends); the few
// engine round-trips go over the wire (window.api.* invokes, or shim.invoke for
// the browser-only app:restart). Workspace switching navigates by ?workspace=.
//
// This module is browser-ONLY: never loaded by the Electron renderer, bundled
// only by build/build-web.js.

const BAR_H = 30; // px — kept in sync with the .has-web-menubar offset in styles.css

// The physical key is Alt everywhere; only the GLYPH is platform-cosmetic.
// Browsers reach this page from any OS, so show ⌥ on Macs and "Alt+" elsewhere.
// (navigator is global in Node 21+ too, so tests see the host platform's form.)
const ACCEL_ALT = (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')) ? '⌥' : 'Alt+';

const THEMES = [
  { key: 'midnight', label: 'Midnight' },
  { key: 'claude', label: 'Claude' },
  { key: 'paper', label: 'Paper (dim light)' },
  { key: 'light', label: 'Light' },
];

const STYLE = `
#clx-menubar{position:absolute;top:0;left:0;right:0;height:${BAR_H}px;z-index:12;
  display:flex;align-items:stretch;padding:0 5px;
  background:var(--sidebar-bg);border-bottom:1px solid var(--border);
  font:400 13px/1 -apple-system,system-ui,sans-serif;color:var(--text);user-select:none}
#clx-menubar .clx-top{display:flex;align-items:center;padding:0 11px;margin:3px 1px;
  border-radius:5px;cursor:default;color:var(--text)}
#clx-menubar .clx-top:hover,#clx-menubar .clx-top.open{background:var(--sidebar-hover)}
.clx-mb-drop{position:fixed;z-index:100001;min-width:220px;max-width:420px;padding:4px 0;
  background:var(--sidebar-bg);border:1px solid var(--border);border-radius:7px;
  box-shadow:0 8px 28px rgba(0,0,0,.45);
  font:400 13px/1 -apple-system,system-ui,sans-serif;color:var(--text)}
.clx-mb-item{display:flex;align-items:center;justify-content:space-between;gap:18px;
  padding:7px 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}
.clx-mb-item[data-disabled="1"]{opacity:.4;pointer-events:none}
.clx-mb-item:hover{background:var(--accent);color:#fff}
.clx-mb-item .clx-mb-label{overflow:hidden;text-overflow:ellipsis}
.clx-mb-item .clx-accel{opacity:.55;font-size:11px}
.clx-mb-item:hover .clx-accel{opacity:.85;color:#fff}
.clx-mb-item .clx-sub-arrow{opacity:.55}
.clx-mb-sep{height:1px;margin:4px 0;background:var(--border)}
.clx-mb-head{padding:6px 14px 3px;font-size:10px;opacity:.5;text-transform:uppercase;letter-spacing:.05em}
`;

// A colon can't appear in a library name, so ':new' is a safe sentinel telling
// the renderer to open a blank editor (mirrors app-menus.js's New Agent/Skill).
const trunc = (s) => (s && s.length > 60 ? s.slice(0, 57) + '…' : s);

function confirmRestart(invoke) {
  const ok = (typeof window !== 'undefined' && typeof window.confirm === 'function')
    ? window.confirm('Restart Clodex?\n\nRunning sessions will be interrupted and resumed after the restart.')
    : true;
  if (ok) Promise.resolve(invoke('app:restart', [])).catch(() => { /* socket drops on relaunch */ });
}

// Build the declarative menu tree from an injected side-effect context so the
// whole structure is unit-testable without a DOM: ctx = { emit, invoke, nav,
// newWorkspace, api, getTheme }. Each top menu is { label, items } where items()
// returns rows (or a promise of rows). A row is a separator ({sep}), a header
// ({head}), an action ({label, accel?, disabled?, run}) or a submenu
// ({label, submenu:()=>rows}).
function buildMenus(ctx) {
  const { emit, invoke, nav, newWorkspace, api, getTheme } = ctx;
  return [
    {
      label: 'File',
      items: () => [
        { label: 'New Workspace', run: () => newWorkspace() },
        { label: 'New Session…', accel: `${ACCEL_ALT}T`, run: () => emit('request-open-new-dialog') },
        { sep: true },
        { label: 'Sandboxes…', run: () => emit('request-open-sandbox-dialog') },
        { sep: true },
        { label: 'Rename Workspace…', run: () => emit('request-rename-workspace') },
        { label: 'Preferences…', run: () => emit('request-open-preferences') },
        // The browser's ALWAYS-AVAILABLE route to the Manage Plugins dialog.
        // t28 added the real top-level Plugins menu (buildPluginsMenu below), so
        // this is no longer the only route — it is kept deliberately as the
        // fallback for the one case the top-level menu cannot cover: with zero
        // plugins on disk the menu is absent by design, and removing this item
        // would leave a fresh install with NO way to reach the dialog whose
        // "Open Plugins Folder" button is how you install your first plugin.
        // (The desktop has that hole; it is masked there only because a packaged
        // build ships plugins/workbench, so the menu is never actually absent.)
        { label: 'Plugins…', run: () => emit('request-open-plugins-dialog') },
        { sep: true },
        { label: 'Restart Clodex…', run: () => confirmRestart(invoke) },
      ],
    },
    buildLibraryMenu(ctx),
    {
      label: 'View',
      items: () => {
        const cur = getTheme ? getTheme() : null;
        return [
          { label: 'Show IPC Traffic…', run: () => emit('request-open-ipc-log') },
          { sep: true },
          {
            label: 'Theme',
            submenu: () => THEMES.map((t) => ({
              label: `${cur === t.key ? '● ' : ''}${t.label}`,
              // set-theme is the same on-channel the desktop's cross-window sync
              // uses; the renderer's onSetTheme → applyTheme persists to
              // localStorage, so no server round-trip is needed in one tab.
              run: () => emit('set-theme', t.key),
            })),
          },
        ];
      },
    },
    // Teams is STATIC in the bar, unlike Plugins (inserted asynchronously, and
    // removed again): it has no null rule to evaluate, so there is nothing to
    // wait for. Plugins lands immediately before it — see refreshPluginsTop.
    buildTeamsMenu(ctx),
    {
      label: 'Window',
      items: async () => {
        const rows = [{ label: 'New Workspace', run: () => newWorkspace() }];
        const [wss, cur] = await Promise.all([
          Promise.resolve(api.listWorkspaces ? api.listWorkspaces() : []).catch(() => []),
          Promise.resolve(api.currentWorkspace ? api.currentWorkspace() : null).catch(() => null),
        ]);
        if (wss && wss.length) {
          rows.push({ sep: true }, { head: 'Workspaces' });
          for (const ws of wss) {
            const isCur = ws.id === cur;
            rows.push({
              label: `${isCur ? '● ' : ''}${ws.name || ws.id}`,
              // Rename targets the sender's workspace, so it is offered only for
              // the current one; others just navigate. (No wire Delete endpoint.)
              submenu: () => (isCur
                ? [{ label: 'Rename…', run: () => emit('request-rename-workspace') }]
                : [{ label: 'Open', run: () => nav(ws.id) }]),
            });
          }
        }
        const peers = await Promise.resolve(api.peerList ? api.peerList() : []).catch(() => []);
        rows.push({ sep: true }, { head: 'Peers' });
        if (!peers || !peers.length) {
          rows.push({ label: '(no peers configured)', disabled: true });
        } else {
          for (const p of peers) {
            rows.push({
              label: `${p.online ? '● ' : '○ '}${p.label || p.host || p.id}`,
              submenu: () => {
                if (!p.online) return [{ label: 'offline', disabled: true }];
                if (!p.sessions || !p.sessions.length) return [{ label: '(no sessions)', disabled: true }];
                return p.sessions.map((s) => ({ label: s.name, run: () => emit('request-open-peer-session', p.id, s.name) }));
              },
            });
          }
        }
        rows.push({ sep: true }, { label: 'Manage Peered Clodexes…', run: () => emit('request-open-peers-dialog') });
        return rows;
      },
    },
  ];
}

function buildLibraryMenu(ctx) {
  const { emit, api } = ctx;
  const read = async (fn) => {
    try { return (await Promise.resolve(fn ? fn() : [])) || []; } catch { return []; }
  };
  const kindRows = async ({ channel, library, empty, pluginEntries, newLabel, manageLabel, bundles }) => {
    const rows = library.length ? library : [{ label: empty, disabled: true }];
    for (const b of await bundles()) {
      const entries = pluginEntries(b);
      if (!entries.length) continue;
      rows.push({ sep: true }, { head: b.name || b.id }, ...entries);
    }
    rows.push(
      { sep: true },
      { label: newLabel, run: () => emit(channel, ':new') },
      { label: manageLabel, run: () => emit(channel, null) },
    );
    return rows;
  };
  const described = (e) => trunc(e.description ? `${e.name}  —  ${e.description}` : e.name);
  const bundleRow = (channel, b, name) => ({ label: trunc(name), run: () => emit(channel, { plugin: b.id, name }) });
  const promptRows = (rows, click) => {
    const out = [];
    for (const kind of ['system', 'append']) {
      const ofKind = rows.filter((p) => p && p.kind === kind);
      if (!ofKind.length) continue;
      out.push({ head: kind === 'system' ? 'System' : 'Append' });
      for (const p of ofKind) out.push({ label: trunc(p.name), run: () => click(p, kind) });
    }
    return out;
  };
  return {
    label: 'Library',
    items: () => {
      let bundlesOnce = null;
      const bundles = () => bundlesOnce || (bundlesOnce = read(api.pluginCatalog));
      return [
        {
          label: 'Prompts',
          submenu: async () => kindRows({
            channel: 'request-open-prompts-drawer',
            library: promptRows(await read(api.listPrompts), (p, kind) => emit('request-open-prompts-drawer', { kind, name: p.name })),
            empty: '(no prompts in library)',
            pluginEntries: (b) => promptRows(b.prompts || [], (p, kind) => emit('request-open-prompts-drawer', { plugin: b.id, kind, name: p.name })),
            newLabel: 'New Prompt…',
            manageLabel: 'Manage Prompts…',
            bundles,
          }),
        },
        {
          label: 'Templates',
          submenu: async () => kindRows({
            channel: 'request-open-templates-drawer',
            library: (await read(api.listTemplates)).filter((t) => !t.plugin)
              .map((t) => ({ label: trunc(t.name), run: () => emit('request-open-templates-drawer', t.id || t.name) })),
            empty: '(no templates in library)',
            pluginEntries: (b) => (b.templates || []).map((name) => bundleRow('request-open-templates-drawer', b, name)),
            newLabel: 'New Template…',
            manageLabel: 'Manage Templates…',
            bundles,
          }),
        },
        {
          label: 'Agents',
          submenu: async () => kindRows({
            channel: 'request-open-agents-drawer',
            library: (await read(api.listAgents)).map((a) => ({ label: described(a), run: () => emit('request-open-agents-drawer', a.name) })),
            empty: '(no agents in library)',
            pluginEntries: (b) => (b.agents || []).map((name) => bundleRow('request-open-agents-drawer', b, name)),
            newLabel: 'New Agent…',
            manageLabel: 'Manage Agent Types…',
            bundles,
          }),
        },
        {
          label: 'Skills',
          submenu: async () => kindRows({
            channel: 'request-open-skills-drawer',
            library: (await read(api.listSkillLib)).map((sk) => ({ label: described(sk), run: () => emit('request-open-skills-drawer', sk.name) })),
            empty: '(no skills in library)',
            pluginEntries: (b) => (b.skills || []).map((name) => bundleRow('request-open-skills-drawer', b, name)),
            newLabel: 'New Skill…',
            manageLabel: 'Manage Skills…',
            bundles,
          }),
        },
        {
          label: 'Exec Commands',
          submenu: async () => kindRows({
            channel: 'request-open-exec-drawer',
            library: (await read(api.listExecCommands)).map((c) => ({ label: trunc(c.name), run: () => emit('request-open-exec-drawer', c.name) })),
            empty: '(no exec commands in library)',
            pluginEntries: () => [],
            newLabel: 'New Exec Command…',
            manageLabel: 'Manage Exec Commands…',
            bundles,
          }),
        },
        { sep: true },
        { label: 'Inbox…', run: () => emit('request-open-inbox-drawer') },
      ];
    },
  };
}

// ── The top-level Plugins menu (t28) ───────────────────────────────────────
// The browser's mirror of app-menus.js:342's buildPluginsMenu, and it reproduces
// that function's NULL RULE verbatim, because that rule is the whole reason the
// menu is trustworthy: an empty "Plugins" menu looks like a broken feature
// rather than an absent one. Null on either of the desktop's two conditions —
// no host/unreadable status, or zero plugins AND zero problems.
//
// Why this is possible at all, since the comment this replaced said it was not:
// the top-level LABELS are a sync array, but mount() appends them imperatively
// into a plain div, so a sixth can be inserted once an async status arrives —
// and removed again when the last plugin goes. The sync-array property was a
// description of the code, not a constraint of the medium.
//
// Takes an already-fetched status rather than fetching, so the null rule is a
// pure function the tests can walk without a transport.
function buildPluginsMenu(status, ctx) {
  if (!status || !status.ok) return null;
  const plugins = status.plugins || [];
  const problems = status.problems || [];
  if (!plugins.length && !problems.length) return null;
  return {
    label: 'Plugins',
    // Re-read on every OPEN, so a checkbox can never show stale enablement —
    // only the menu's PRESENCE is decided at insert time (and re-decided on the
    // plugin-state broadcast; see refreshPluginsTop in mount).
    items: async () => {
      const st = await ctx.pluginStatus();
      const ps = (st && st.plugins) || [];
      const probs = (st && st.problems) || [];
      const rows = ps.map((p) => ({
        // No checkbox row type in this bar, so enablement rides the same ●/○
        // glyph the Theme and Workspace menus already use for current-ness.
        // Quarantine is a THIRD state and goes in the LABEL for the desktop's
        // reason: an unticked box would be a lie about the user's choice.
        label: p.quarantined
          ? `● ${p.name || p.id} — held back after ${p.failCount || 0} failed launches`
          : `${p.enabled ? '● ' : '○ '}${p.name || p.id}`,
        run: () => ctx.setPluginEnabled(p.id, !p.enabled),
      }));
      // A directory that looks like a plugin but was refused. No toggle: there
      // is no id to key one by when the manifest is what is broken.
      for (const pr of probs) rows.push({ label: `${pr.dir} — not loaded`, disabled: true });
      rows.push({ sep: true }, { label: 'Manage Plugins…', run: () => ctx.emit('request-open-plugins-dialog') });
      return rows;
    },
  };
}

// ── The top-level Teams menu (t288) ────────────────────────────────────────
// The browser's mirror of app-menus.js's buildTeamsMenu, and it reproduces that
// function's INVERSION of the plugins null rule: it is never null. Zero teams
// still shows the menu, because "Create Team…" is the only way to get the first
// one — hiding it would make an empty box a dead end.
//
// Unlike the desktop, which reads listTeams()/loadManifest() in-process, the
// browser has only the team:* invokes. Broken teams are found the same way the
// desktop finds them (a manifest that will not load), here by asking teamGet per
// name on OPEN — teams are few, and a stale list is worse than N small invokes.
function buildTeamsMenu(ctx) {
  return {
    label: 'Teams',
    items: async () => {
      let names = [];
      try { const r = await ctx.teamNames(); names = (r && r.names) || []; } catch { names = []; }
      const rows = [];
      for (const name of names) {
        let ok = false;
        try { const g = await ctx.teamGet(name); ok = !!(g && g.ok); } catch { ok = false; }
        if (ok) rows.push({ label: name, run: () => ctx.emit('request-open-team-roles', name) });
        else rows.push({ label: `${name} — not loaded`, disabled: true });
      }
      if (!names.length) rows.push({ label: '(no teams)', disabled: true });
      rows.push({ sep: true }, { label: 'Create Team…', run: () => ctx.emit('request-open-team-create') });
      return rows;
    },
  };
}

// The target of a workspace switch: THIS page's query with `workspace` swapped,
// never a query rebuilt from the fields we happen to remember (t445).
//
// A switch is a full page load, and the shim reads its connection params at
// module-eval — so any param dropped here is dropped for the rest of the tab's
// life. Two ride along that a rebuild silently lost: `via=tunnel`, which is the
// ONLY thing telling the page it is being viewed through a tunnel rather than on
// the box (lose it and every box-loopback link opens on the viewer's machine
// again — the t445 defect, now intermittent because it takes a workspace switch
// to trigger), and `wirescope=<port>`, t443's forward, whose loss silently
// downgrades dashboard links back to suppressed.
//
// Carrying the whole query forward is what makes that class of loss impossible
// rather than merely fixed twice: a param added later needs no edit here.
function navQuery(id) {
  try {
    const p = new URLSearchParams(location.search);
    p.set('workspace', id);
    return `?${p.toString()}`;
  } catch { return `?workspace=${encodeURIComponent(id)}`; }
}

function injectStyle() {
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function mount(shim) {
  injectStyle();

  const nav = (id) => { location.assign(navQuery(id)); };
  // Mint the workspace ENGINE-side (workspace:new persists the record and returns
  // its id), then navigate to it — a client-side id mint would be a phantom absent
  // from workspaces.json (missing from the switcher, gone at relaunch).
  const newWorkspace = async () => {
    try {
      const api = (typeof window !== 'undefined' && window.api) || {};
      const id = api.newWorkspace ? await api.newWorkspace() : null;
      if (id) nav(id);
    } catch (err) { console.error('menubar newWorkspace', err); }
  };
  const api = (typeof window !== 'undefined' && window.api) || {};
  const ctx = {
    emit: (ch, ...a) => shim.emit(ch, ...a),
    invoke: (ch, args) => shim.invoke(ch, args),
    nav,
    newWorkspace,
    api,
    getTheme: () => { try { return localStorage.getItem('clodex-theme'); } catch { return null; } },
    // Plugin state rides the frozen five-row transport (api-contract.js:284-287),
    // which the browser inherits free — no new wire surface for this menu.
    pluginStatus: async () => {
      if (!api.pluginInvoke) return null;
      try { return await api.pluginInvoke('_host', 'plugins.status'); } catch { return null; }
    },
    // The Teams menu's two reads (t288), both already on the contract — the
    // browser inherits them free, no new wire surface for this menu either.
    teamNames: async () => {
      if (!api.teamNames) return null;
      try { return await api.teamNames(); } catch { return null; }
    },
    teamGet: async (name) => {
      if (!api.teamGet) return null;
      try { return await api.teamGet(name); } catch { return null; }
    },
    setPluginEnabled: async (id, on) => {
      if (!api.pluginSetEnabled) return;
      try { await api.pluginSetEnabled(id, on); } catch (err) { console.error('menubar setEnabled', id, err); }
    },
  };
  const menus = buildMenus(ctx);

  const main = document.getElementById('main');
  if (main && main.classList) main.classList.add('has-web-menubar');

  const bar = document.createElement('div');
  bar.id = 'clx-menubar';

  let state = null; // { top, drop, subs: [] } while a top menu is open
  const closeAll = () => {
    if (!state) return;
    if (state.top.classList) state.top.classList.remove('open');
    state.drop.remove();
    for (const s of state.subs) s.remove();
    state = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDocDown = (e) => {
    if (!state) return;
    if (bar.contains(e.target) || state.drop.contains(e.target) || state.subs.some((s) => s.contains(e.target))) return;
    closeAll();
  };
  const onKey = (e) => { if (e.key === 'Escape') closeAll(); };

  const clampX = (drop) => {
    const r = drop.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth - 4) drop.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
  };
  const clearSubs = () => { if (state) { for (const s of state.subs) s.remove(); state.subs = []; } };

  const openSub = (anchor, row) => {
    clearSubs();
    const drop = document.createElement('div');
    drop.className = 'clx-mb-drop';
    const r = anchor.getBoundingClientRect();
    drop.style.left = `${Math.round(r.right - 3)}px`;
    drop.style.top = `${Math.round(r.top - 5)}px`;
    document.body.appendChild(drop);
    state.subs.push(drop);
    Promise.resolve().then(() => row.submenu()).then((rows) => {
      if (!state || !state.subs.includes(drop)) return;
      renderRows(drop, rows, false);
      clampX(drop);
    }).catch((err) => console.error('menubar submenu', row.label, err));
  };

  function renderRows(container, rows, isTop) {
    for (const row of (rows || [])) {
      if (row.sep) { const s = document.createElement('div'); s.className = 'clx-mb-sep'; container.appendChild(s); continue; }
      if (row.head) { const h = document.createElement('div'); h.className = 'clx-mb-head'; h.textContent = row.head; container.appendChild(h); continue; }
      const el = document.createElement('div');
      el.className = 'clx-mb-item';
      if (row.disabled) el.dataset.disabled = '1';
      const label = document.createElement('span');
      label.className = 'clx-mb-label';
      label.textContent = row.label;
      el.appendChild(label);
      if (row.submenu) {
        const arr = document.createElement('span');
        arr.className = 'clx-sub-arrow';
        arr.textContent = '▸';
        el.appendChild(arr);
        if (!row.disabled) el.addEventListener('mouseenter', () => openSub(el, row));
      } else {
        if (row.accel) { const a = document.createElement('span'); a.className = 'clx-accel'; a.textContent = row.accel; el.appendChild(a); }
        if (isTop) el.addEventListener('mouseenter', clearSubs);
        if (!row.disabled) el.addEventListener('mouseup', () => { closeAll(); try { row.run && row.run(); } catch (err) { console.error('menubar action', row.label, err); } });
      }
      container.appendChild(el);
    }
  }

  const openMenu = (topEl, menu) => {
    const wasOpen = !!state && state.top === topEl;
    closeAll();
    if (wasOpen) return; // clicking the open menu's title toggles it shut
    if (topEl.classList) topEl.classList.add('open');
    const drop = document.createElement('div');
    drop.className = 'clx-mb-drop';
    const r = topEl.getBoundingClientRect();
    drop.style.left = `${Math.round(r.left)}px`;
    drop.style.top = `${Math.round(r.bottom + 2)}px`;
    document.body.appendChild(drop);
    state = { top: topEl, drop, subs: [] };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    Promise.resolve().then(() => menu.items()).then((rows) => {
      if (!state || state.drop !== drop) return;
      renderRows(drop, rows, true);
      clampX(drop);
    }).catch((err) => console.error('menubar items', menu.label, err));
  };

  const makeTop = (menu) => {
    const top = document.createElement('div');
    top.className = 'clx-top';
    top.textContent = menu.label;
    top.addEventListener('mousedown', (e) => { if (e.preventDefault) e.preventDefault(); openMenu(top, menu); });
    // Hover-follow once a menu is open, matching a native menu bar.
    top.addEventListener('mouseenter', () => { if (state && state.top !== top) openMenu(top, menu); });
    return top;
  };

  for (const menu of menus) bar.appendChild(makeTop(menu));

  (main || document.body).appendChild(bar);

  // ── Plugins: inserted asynchronously, and removed again ────────────────────
  // The null rule is enforced HERE, on every evaluation, not once at mount: a
  // plugin removed by a re-scan must take the menu with it, or the bar keeps a
  // top-level label for a feature that is no longer there. Re-runs on the
  // engine's plugin-state broadcast — the same signal the renderer's own plugin
  // teardown listens to — so enable/disable/rescan all reach it by one path.
  let pluginsTop = null;
  const refreshPluginsTop = async () => {
    const menu = buildPluginsMenu(await ctx.pluginStatus(), ctx);
    if (pluginsTop) { if (state && state.top === pluginsTop) closeAll(); pluginsTop.remove(); pluginsTop = null; }
    if (!menu) return;
    pluginsTop = makeTop(menu);
    // Between View and Teams, matching the desktop's template order. insertBefore
    // rather than append because the menus after it are built before we know
    // whether there are plugins at all; falling back to append keeps the menu
    // reachable if the anchor is ever missing, rather than dropping it silently.
    const anchor = bar.children && Array.prototype.find.call(bar.children, (c) => c.textContent === 'Teams' || c.textContent === 'Window');
    if (anchor && bar.insertBefore) bar.insertBefore(pluginsTop, anchor);
    else bar.appendChild(pluginsTop);
  };
  refreshPluginsTop();
  if (api.onPluginEvent) {
    api.onPluginEvent((pluginId, topic) => {
      if (pluginId === '_host' && topic === 'plugin-state') refreshPluginsTop();
    });
  }
}

module.exports = { mount, buildMenus, buildLibraryMenu, buildPluginsMenu, buildTeamsMenu, navQuery, BAR_H, THEMES };
