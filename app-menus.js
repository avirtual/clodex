// app-menus.js — the tray icon + application menu builders, extracted verbatim
// from main.js (M5). createAppMenus(deps) returns the builder/refresher fns;
// main.js destructures them so its ~30 existing call sites stay byte-identical.
//
// Electron-heavy BY DESIGN: unlike the M3/M4 modules there is no electron-free
// goal here — this file legitimately requires('electron') for Menu/Tray/etc.
// The move is pure relocation; the only body changes are the store/singleton
// getter seams (manager, peerManager, updateInfo, uiSettings, workspaces,
// agentLibrary, skillLibrary) — each is `let`/`const` in main.js and either
// TDZ-bound or whenReady-assigned when createAppMenus is called, so they cross
// as lazy getters (a captured value would be undefined / throw TDZ). Everything
// else (DEFAULT_WORKSPACE_ID, THEME_KEYS, path, and the hoisted functions
// checkForUpdate/confirmRestartClodex/createWindow) is stable and value-injected.
//
// The tray/refresh timer state (tray, trayRefreshTimer, appMenuRefreshTimer)
// moves into the factory closure — same module-private lifetime it had before.

const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage } = require('electron');

function createAppMenus(deps) {
  const {
    // value deps
    DEFAULT_WORKSPACE_ID, LOG_FILE, THEME_KEYS, path,
    checkForUpdate, confirmRestartClodex, createWindow,
    // getter deps (TDZ / whenReady-assigned when this factory runs)
    getManager, getPeerManager, getSandboxManager, getUpdateInfo,
    getUiSettings, getWorkspaces, getAgentLibrary, getSkillLibrary,
  } = deps;

  let tray = null;

  function buildTrayMenu() {
    const sessions = getManager().list();
    const wsList = getWorkspaces().list();
    const template = [];

    // Show all windows
    if (getManager().allLiveWindows().length === 0) {
      template.push({
        label: 'Show Clodex',
        click: () => createWindow(DEFAULT_WORKSPACE_ID),
      });
    } else {
      template.push({
        label: 'Show Clodex',
        click: () => {
          for (const w of getManager().allLiveWindows()) {
            if (w.isMinimized()) w.restore();
            w.show();
          }
          const focused = getManager().allLiveWindows()[0];
          if (focused) focused.focus();
        },
      });
    }
    template.push({ type: 'separator' });

    // Sessions grouped by workspace
    if (sessions.length > 0) {
      const byWs = new Map();
      for (const s of sessions) {
        if (!byWs.has(s.workspaceId)) byWs.set(s.workspaceId, []);
        byWs.get(s.workspaceId).push(s);
      }
      for (const [wsId, list] of byWs) {
        const ws = wsList.find(w => w.id === wsId);
        const wsName = ws ? (ws.name || 'Workspace') : 'Workspace';
        template.push({ label: wsName, enabled: false });
        for (const s of list) {
          // Native menus can't color text without per-item images, so the
          // state rides the glyph: ! blocked on the human · ● mid-turn ·
          // ○ parked at its prompt. Bash sessions have no turn concept.
          const indicator = s.type === 'bash' ? '•'
            : s.attention ? '!'
            : s.activity === 'thinking' ? '●' : '○';
          template.push({
            label: `  ${indicator} ${s.name} (${s.type})`,
            click: () => {
              let win = getManager().windowForWorkspace(s.workspaceId);
              if (!win) win = createWindow(s.workspaceId);
              win.show();
              win.focus();
              win.webContents.send('request-switch-session', s.name);
            },
          });
        }
        template.push({ type: 'separator' });
      }
    } else {
      template.push({ label: '(no sessions)', enabled: false });
      template.push({ type: 'separator' });
    }

    template.push({
      label: 'New Session…',
      click: () => {
        let win = BrowserWindow.getFocusedWindow() || getManager().allLiveWindows()[0];
        if (!win) win = createWindow(DEFAULT_WORKSPACE_ID);
        win.show();
        win.focus();
        win.webContents.send('request-open-new-dialog');
      },
    });
    template.push({
      label: 'Discover Sessions…',
      click: () => {
        let win = BrowserWindow.getFocusedWindow() || getManager().allLiveWindows()[0];
        if (!win) win = createWindow(DEFAULT_WORKSPACE_ID);
        win.show();
        win.focus();
        win.webContents.send('request-open-discovery');
      },
    });
    template.push({
      label: 'New Workspace',
      accelerator: 'Shift+Cmd+N',
      click: () => {
        const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createWindow(id);
        refreshAppMenu();
        refreshTrayMenu();
      },
    });

    // Recent Workspaces — all of them, open or closed, sorted by recency.
    // Each is a submenu with Open/Rename/Delete so users can manage them
    // without needing to open a window first.
    const recent = getWorkspaces().sortedByRecent();
    if (recent.length > 0) {
      template.push({
        label: 'Recent Workspaces',
        submenu: recent.map(ws => {
          const isOpen = !!getManager().windowForWorkspace(ws.id);
          const indicator = isOpen ? '●' : '○';
          const wsSessions = sessions.filter(s => s.workspaceId === ws.id).length;
          const suffix = wsSessions > 0 ? ` — ${wsSessions} session${wsSessions === 1 ? '' : 's'}` : '';
          return {
            label: `${indicator}  ${ws.name || ws.id}${suffix}`,
            submenu: [
              {
                label: isOpen ? 'Focus Window' : 'Open',
                click: () => {
                  const win = getManager().windowForWorkspace(ws.id);
                  if (win) { win.show(); win.focus(); }
                  else createWindow(ws.id);
                },
              },
              {
                label: 'Rename…',
                click: () => {
                  let win = getManager().windowForWorkspace(ws.id);
                  if (!win) win = createWindow(ws.id);
                  win.show();
                  win.focus();
                  win.webContents.send('request-rename-workspace');
                },
              },
              { type: 'separator' },
              {
                label: 'Delete Workspace…',
                click: async () => {
                  const result = await dialog.showMessageBox({
                    type: 'warning',
                    buttons: ['Delete', 'Cancel'],
                    defaultId: 1,
                    cancelId: 1,
                    message: `Delete workspace "${ws.name || ws.id}"?`,
                    detail: wsSessions > 0
                      ? `This will kill ${wsSessions} running session${wsSessions === 1 ? '' : 's'} and remove the workspace.`
                      : 'This removes the empty workspace record.',
                  });
                  if (result.response !== 0) return;
                  for (const s of getManager().listForWorkspace(ws.id)) getManager().kill(s.name);
                  getWorkspaces().remove(ws.id);
                  const win = getManager().windowForWorkspace(ws.id);
                  if (win) win.close();
                  refreshAppMenu();
                  refreshTrayMenu();
                },
              },
            ],
          };
        }),
      });
    }

    if (getUpdateInfo()) {
      template.push({ type: 'separator' });
      template.push({
        label: `Update to v${getUpdateInfo().version}`,
        click: () => shell.openExternal(getUpdateInfo().url),
      });
    }

    template.push({ type: 'separator' });
    template.push({ label: 'Check for Updates…', click: () => checkForUpdate(false) });
    template.push({ label: 'Restart Clodex…', click: () => { confirmRestartClodex(); } });
    template.push({ label: 'Quit Clodex', role: 'quit' });
    return Menu.buildFromTemplate(template);
  }

  function initTray() {
    const iconPath = path.join(__dirname, 'build', 'tray-iconTemplate.png');
    const img = nativeImage.createFromPath(iconPath);
    img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('Clodex');
    tray.setContextMenu(buildTrayMenu());
  }

  function refreshTrayMenu() {
    if (tray) tray.setContextMenu(buildTrayMenu());
  }

  // Activity/attention transitions want the tray's state glyphs fresh, but they
  // fire on every turn boundary — trailing-edge debounce so a burst of
  // transitions costs one rebuild. (macOS snapshots an already-open tray menu,
  // so a rebuild never yanks it out from under the user.)
  let trayRefreshTimer = null;
  function scheduleTrayRefresh() {
    if (trayRefreshTimer || !tray) return;
    trayRefreshTimer = setTimeout(() => {
      trayRefreshTimer = null;
      refreshTrayMenu();
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Application menu (File > New Window, etc.)
  // ---------------------------------------------------------------------------

  function buildAgentsSubmenu() {
    // The custom-subagent library (the reusable agent *types*), not running
    // sessions — those already live in the sidebar. Each entry opens its editor.
    const lib = getAgentLibrary().list();
    const items = [];

    const openDrawer = (name) => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('request-open-agents-drawer', name || null);
    };

    if (lib.length > 0) {
      for (const a of lib) {
        const label = a.description ? `${a.name}  —  ${a.description}` : a.name;
        items.push({
          // Menu labels don't wrap; keep long descriptions from blowing out width.
          label: label.length > 60 ? label.slice(0, 57) + '…' : label,
          click: () => openDrawer(a.name),
        });
      }
    } else {
      items.push({ label: '(no agents in library)', enabled: false });
    }

    items.push(
      { type: 'separator' },
      {
        label: 'New Agent…',
        accelerator: 'CmdOrCtrl+Shift+A',
        // Sentinel (a colon is invalid in an agent name, so it can't collide)
        // tells the renderer to open a blank editor rather than load a type.
        click: () => openDrawer(':new'),
      },
      {
        label: 'Manage Agent Types…',
        click: () => openDrawer(null),
      },
      { type: 'separator' },
      {
        label: 'Show IPC Traffic…',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => {
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send('request-open-ipc-log');
        },
      }
    );

    return items;
  }

  // Parallel to buildAgentsSubmenu, over the skill-injection library. Each entry
  // opens its editor; the library skills are what a session can selectively
  // inject via --plugin-dir.
  function buildSkillsSubmenu() {
    const lib = getSkillLibrary().list();
    const items = [];

    const openDrawer = (name) => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('request-open-skills-drawer', name || null);
    };

    if (lib.length > 0) {
      for (const s of lib) {
        const label = s.description ? `${s.name}  —  ${s.description}` : s.name;
        items.push({
          label: label.length > 60 ? label.slice(0, 57) + '…' : label,
          click: () => openDrawer(s.name),
        });
      }
    } else {
      items.push({ label: '(no skills in library)', enabled: false });
    }

    items.push(
      { type: 'separator' },
      {
        label: 'New Skill…',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => openDrawer(':new'),
      },
      {
        label: 'Manage Skills…',
        click: () => openDrawer(null),
      }
    );

    return items;
  }

  // Theme change from anywhere (View menu or a renderer's Preferences picker):
  // persist the canonical copy, refresh the menu radios, and push to every
  // window so all open workspaces retint together. exceptWc skips the renderer
  // that already applied it locally (the Preferences picker), avoiding a needless
  // re-apply round-trip.
  function setUiTheme(name, exceptWc) {
    if (!THEME_KEYS.includes(name)) return;
    getUiSettings().set({ theme: name });
    refreshAppMenu();
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents === exceptWc) continue;
      w.webContents.send('set-theme', name);
    }
  }

  // View-menu zoom. Custom items rather than the zoomIn/zoomOut roles: a role
  // adjusts the webContents zoom with no hook to refit xterm or persist the
  // factor ('zoom-changed' only fires for gestures, not menu roles). Steps
  // mirror the roles' 0.5 zoomLevel increments (factor = 1.2^level), clamped
  // to ±3 (≈0.58×–1.73×). The nudge tells the renderer to refit the active
  // terminal to the new CSS-pixel geometry; the factor persists on the
  // workspace record (riding the same flow as bounds) and is re-applied on
  // window create. A focused non-workspace window (wirescope) still zooms but
  // persists nothing.
  function adjustZoom(deltaLevel) {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    const level = deltaLevel == null
      ? 0
      : Math.max(-3, Math.min(3, wc.getZoomLevel() + deltaLevel));
    wc.setZoomLevel(level);
    const wsId = getManager().workspaceForWindow(win);
    if (wsId) getWorkspaces().setZoomFactor(wsId, wc.getZoomFactor());
    wc.send('zoom-nudge');
  }

  function buildAppMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
      ...(isMac ? [{
        label: app.getName(),
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Preferences…',
            accelerator: 'CmdOrCtrl+,',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-preferences');
            },
          },
          { label: 'Check for Updates…', click: () => checkForUpdate(false) },
          { label: 'Restart Clodex…', click: () => { confirmRestartClodex(); } },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }] : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'New Workspace',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => {
              const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              createWindow(id);
              refreshAppMenu();
              refreshTrayMenu();
            },
          },
          {
            label: 'New Session…',
            accelerator: 'CmdOrCtrl+T',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-new-dialog');
            },
          },
          {
            label: 'Discover Sessions…',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-discovery');
            },
          },
          {
            label: 'Prompts…',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-prompts-drawer');
            },
          },
          {
            label: 'Templates…',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-templates-drawer');
            },
          },
          {
            label: 'Exec Commands…',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-exec-drawer');
            },
          },
          {
            label: 'Inbox…',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-inbox-drawer');
            },
          },
          { type: 'separator' },
          {
            label: 'Rename Workspace…',
            click: () => {
              const win = BrowserWindow.getFocusedWindow();
              if (win) win.webContents.send('request-rename-workspace');
            },
          },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      {
        label: 'Agents',
        submenu: buildAgentsSubmenu(),
      },
      {
        label: 'Skills',
        submenu: buildSkillsSubmenu(),
      },
      {
        // macOS wires Cmd+C/V/X/A through these roles via the responder chain —
        // the menu must stay present and visible or clipboard shortcuts break in
        // the terminal and dialog inputs. (Looks inapplicable, but it's load-bearing.)
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Workbench…',
            click: () => {
              const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('request-open-workbench');
            },
          },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          {
            // The ops log (~/.clodex/clodex.log) is file-only — errors,
            // lifecycle, peer transitions, migrations. This is its sole UI
            // surface; the in-app IPC panel shows agent traffic, not errors.
            label: 'Open Log File',
            click: () => { shell.openPath(LOG_FILE); },
          },
          { type: 'separator' },
          {
            label: 'Theme',
            submenu: [
              { key: 'midnight', label: 'Midnight' },
              { key: 'claude', label: 'Claude' },
              { key: 'paper', label: 'Paper (dim light)' },
              { key: 'light', label: 'Light' },
            ].map((t) => ({
              label: t.label,
              type: 'radio',
              checked: getUiSettings().get().theme === t.key,
              click: () => setUiTheme(t.key),
            })),
          },
          { type: 'separator' },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => adjustZoom(0.5) },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => adjustZoom(-0.5) },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => adjustZoom(null) },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          ...(isMac ? [
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' },
          ] : []),
        ],
      },
    ];

    // Per-workspace submenu under Window menu: Open / Rename / Delete
    const wsMenu = template.find(m => m.label === 'Window');
    if (wsMenu) {
      const all = getWorkspaces().sortedByRecent();
      if (all.length > 0) {
        wsMenu.submenu.push({ type: 'separator' }, { label: 'Workspaces', enabled: false });
        for (const ws of all) {
          const isOpen = !!getManager().windowForWorkspace(ws.id);
          const indicator = isOpen ? '●' : '○';
          const sessionCount = getManager().listForWorkspace(ws.id).length;
          const countSuffix = sessionCount > 0
            ? ` — ${sessionCount} session${sessionCount === 1 ? '' : 's'}`
            : '';
          wsMenu.submenu.push({
            label: `${indicator}  ${ws.name || ws.id}${countSuffix}`,
            submenu: [
              {
                label: isOpen ? 'Focus Window' : 'Open',
                click: () => {
                  const win = getManager().windowForWorkspace(ws.id);
                  if (win) { win.show(); win.focus(); }
                  else createWindow(ws.id);
                },
              },
              {
                label: 'Rename…',
                click: () => {
                  let win = getManager().windowForWorkspace(ws.id);
                  if (!win) win = createWindow(ws.id);
                  win.show();
                  win.focus();
                  win.webContents.send('request-rename-workspace');
                },
              },
              { type: 'separator' },
              {
                label: isOpen ? 'Close Window (keep workspace)' : 'Already closed',
                enabled: isOpen,
                click: () => {
                  const win = getManager().windowForWorkspace(ws.id);
                  if (win) win.close();
                },
              },
              {
                label: 'Delete Workspace…',
                click: async () => {
                  const parent = BrowserWindow.getFocusedWindow();
                  const result = await dialog.showMessageBox(parent, {
                    type: 'warning',
                    buttons: ['Delete', 'Cancel'],
                    defaultId: 1,
                    cancelId: 1,
                    message: `Delete workspace "${ws.name || ws.id}"?`,
                    detail: sessionCount > 0
                      ? `This will kill ${sessionCount} running session${sessionCount === 1 ? '' : 's'} and remove the workspace. Conversation transcripts on disk are preserved and can be resumed in a new workspace.`
                      : 'This removes the empty workspace record. No sessions will be affected.',
                  });
                  if (result.response !== 0) return;
                  for (const s of getManager().listForWorkspace(ws.id)) getManager().kill(s.name);
                  getWorkspaces().remove(ws.id);
                  const win = getManager().windowForWorkspace(ws.id);
                  if (win) win.close();
                  refreshAppMenu();
                  refreshTrayMenu();
                },
              },
            ],
          });
        }
      }

      // A peer status row → a menu entry: online/offline indicator + label, its
      // submenu the live sessions (click = attach in the focused window, matching
      // how peer tabs live today). No control verbs — sessions only, to keep the
      // menu light. Shared by the Peers and Sandboxes sections below.
      const peerEntry = (st) => {
        const indicator = st.online ? '●' : '○';
        const label = st.label || st.host || st.id;
        let sub;
        if (!st.online) {
          sub = [{ label: 'offline', enabled: false }];
        } else if (!st.sessions || st.sessions.length === 0) {
          sub = [{ label: '(no sessions)', enabled: false }];
        } else {
          sub = st.sessions.map((s) => ({
            label: s.name,
            click: () => sendToFocused('request-open-peer-session', st.id, s.name),
          }));
        }
        return { label: `${indicator}  ${label}`, submenu: sub };
      };

      // Split managed sandbox boxes out of the peer list: a box's peer id IS its
      // box id (sandbox.js registerPeer), so the registry ids ∩ peer ids marks
      // them. Peers = genuine remotes only; boxes get their own subsection. A box
      // gets a peer status row once it's first started (and keeps it, online or
      // offline, until deleted), so boxList is exactly that intersection — a
      // never-started seed box has no row and shows nowhere but the panel.
      const sbMgr = getSandboxManager();
      const boxIds = new Set((sbMgr ? sbMgr.list() : []).map((b) => b && b.id).filter(Boolean));
      const allStatuses = getPeerManager() ? getPeerManager().statuses() : [];
      const peerList = allStatuses.filter((st) => !boxIds.has(st.id));
      const boxList = allStatuses.filter((st) => boxIds.has(st.id));

      // Peers section: genuine remote Clodexes. "Manage Peered Clodexes…" owns the
      // add/edit/remove UI that used to sit in Preferences.
      wsMenu.submenu.push({ type: 'separator' }, { label: 'Peers', enabled: false });
      if (peerList.length === 0) {
        wsMenu.submenu.push({ label: '(no peers configured)', enabled: false });
      } else {
        for (const st of peerList) wsMenu.submenu.push(peerEntry(st));
      }
      wsMenu.submenu.push({
        label: 'Manage Peered Clodexes…',
        click: () => sendToFocused('request-open-peers-dialog'),
      });

      // Sandboxes section: managed Docker boxes, same entry shape. The box rows +
      // their header are gated on a box peer actually existing (registry ∩ peers)
      // so a non-sandbox user sees no clutter — but "Manage Clodex Sandboxes…" is
      // always-on, mirroring the always-on "Manage Peered Clodexes…" above. That
      // keeps a menu path to the panel (which owns box creation/config) even for a
      // fresh install whose seed box was never started, now that File > Sandboxes…
      // is gone.
      if (boxList.length > 0) {
        wsMenu.submenu.push({ type: 'separator' }, { label: 'Sandboxes', enabled: false });
        for (const st of boxList) wsMenu.submenu.push(peerEntry(st));
      } else {
        wsMenu.submenu.push({ type: 'separator' });
      }
      wsMenu.submenu.push({
        label: 'Manage Clodex Sandboxes…',
        click: () => sendToFocused('request-open-sandbox-dialog'),
      });
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function refreshAppMenu() {
    buildAppMenu();
  }

  // Route a menu action to the window the user is looking at (falling back to any
  // open window), matching how Preferences and workspace actions already resolve.
  function sendToFocused(channel, ...args) {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send(channel, ...args);
  }

  // Peer online/offline (and add/remove) flips the Window > Peers indicators and
  // session lists. peer-state can fire in bursts (hello wake + session refresh),
  // so debounce like the tray — one rebuild per burst. (macOS snapshots an
  // already-open menu, so a rebuild never yanks it out from under the user.)
  let appMenuRefreshTimer = null;
  function scheduleAppMenuRefresh() {
    if (appMenuRefreshTimer) return;
    appMenuRefreshTimer = setTimeout(() => {
      appMenuRefreshTimer = null;
      refreshAppMenu();
    }, 500);
  }

  return {
    buildTrayMenu, initTray, refreshTrayMenu, scheduleTrayRefresh,
    buildAgentsSubmenu, buildSkillsSubmenu, setUiTheme, buildAppMenu,
    refreshAppMenu, scheduleAppMenuRefresh, sendToFocused,
  };
}

module.exports = { createAppMenus };
