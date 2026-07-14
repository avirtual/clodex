'use strict';
// menubar.js — the browser frontend's top menu bar (web-frontend Phase 5). It
// replaces the earlier floating "☰" corner button with a real horizontal menu
// bar that mirrors the Electron application menu (app-menus.js): File / Agents /
// Skills / View / Window. The Edit/View native roles the browser already
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
        { label: 'New Session…', run: () => emit('request-open-new-dialog') },
        { sep: true },
        { label: 'Prompts…', run: () => emit('request-open-prompts-drawer') },
        { label: 'Templates…', run: () => emit('request-open-templates-drawer') },
        { label: 'Exec Commands…', run: () => emit('request-open-exec-drawer') },
        { label: 'Inbox…', run: () => emit('request-open-inbox-drawer') },
        { sep: true },
        { label: 'Rename Workspace…', run: () => emit('request-rename-workspace') },
        { label: 'Preferences…', run: () => emit('request-open-preferences') },
        { sep: true },
        { label: 'Restart Clodex', run: () => confirmRestart(invoke) },
      ],
    },
    {
      label: 'Agents',
      items: async () => {
        const lib = await Promise.resolve(api.listAgents ? api.listAgents() : []).catch(() => []);
        const rows = [];
        if (lib && lib.length) {
          for (const a of lib) rows.push({ label: trunc(a.description ? `${a.name}  —  ${a.description}` : a.name), run: () => emit('request-open-agents-drawer', a.name) });
        } else {
          rows.push({ label: '(no agents in library)', disabled: true });
        }
        rows.push(
          { sep: true },
          { label: 'New Agent…', run: () => emit('request-open-agents-drawer', ':new') },
          { label: 'Manage Agent Types…', run: () => emit('request-open-agents-drawer', null) },
          { sep: true },
          { label: 'Show IPC Traffic…', run: () => emit('request-open-ipc-log') },
        );
        return rows;
      },
    },
    {
      label: 'Skills',
      items: async () => {
        const lib = await Promise.resolve(api.listSkillLib ? api.listSkillLib() : []).catch(() => []);
        const rows = [];
        if (lib && lib.length) {
          for (const s of lib) rows.push({ label: trunc(s.description ? `${s.name}  —  ${s.description}` : s.name), run: () => emit('request-open-skills-drawer', s.name) });
        } else {
          rows.push({ label: '(no skills in library)', disabled: true });
        }
        rows.push(
          { sep: true },
          { label: 'New Skill…', run: () => emit('request-open-skills-drawer', ':new') },
          { label: 'Manage Skill Library…', run: () => emit('request-open-skills-drawer', null) },
        );
        return rows;
      },
    },
    {
      label: 'View',
      items: () => {
        const cur = getTheme ? getTheme() : null;
        return [
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

function tokenQuery() {
  try {
    const t = new URLSearchParams(location.search).get('token');
    return t ? `&token=${encodeURIComponent(t)}` : '';
  } catch { return ''; }
}

function injectStyle() {
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function mount(shim) {
  injectStyle();

  const nav = (id) => { location.assign(`?workspace=${encodeURIComponent(id)}${tokenQuery()}`); };
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
  const ctx = {
    emit: (ch, ...a) => shim.emit(ch, ...a),
    invoke: (ch, args) => shim.invoke(ch, args),
    nav,
    newWorkspace,
    api: (typeof window !== 'undefined' && window.api) || {},
    getTheme: () => { try { return localStorage.getItem('clodex-theme'); } catch { return null; } },
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

  for (const menu of menus) {
    const top = document.createElement('div');
    top.className = 'clx-top';
    top.textContent = menu.label;
    top.addEventListener('mousedown', (e) => { if (e.preventDefault) e.preventDefault(); openMenu(top, menu); });
    // Hover-follow once a menu is open, matching a native menu bar.
    top.addEventListener('mouseenter', () => { if (state && state.top !== top) openMenu(top, menu); });
    bar.appendChild(top);
  }

  (main || document.body).appendChild(bar);
}

module.exports = { mount, buildMenus, BAR_H, THEMES };
