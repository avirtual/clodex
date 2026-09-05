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

// The Delete Workspace… confirm copy, shared by the tray menu and the Window
// menu because both fire the same teardown (F005). It takes BOTH populations:
// `running` (the live map) and `saved` (the workspace's archived /
// saved-but-not-running records, which the live map cannot see). The old copy
// counted only the first, so a workspace holding ten archived conversations and
// nothing running read "This removes the empty workspace record" — the exact
// case where the deletion costs the most. Saved seats are deleted, not
// preserved: their transcripts stay on disk, and dropping the record is what
// makes them adoptable again through Discover Sessions… (discovery excludes
// tracked sessionIds, and the record is what makes an id tracked).
// The workspace-row suffix in the Window menu, counting BOTH populations for
// the same reason the confirm copy does: a workspace holding only archived
// seats read as bare (no suffix at all), then its delete dialog warned about
// losing them. The two numbers are disjoint by construction —
// savedForWorkspace excludes anything in the live map — so they sum.
function workspaceCountSuffix(running, saved) {
  const total = running + saved;
  if (total === 0) return '';
  const s = total === 1 ? '' : 's';
  // Only the running count needs qualifying, and only when it is not the whole
  // story: "3 sessions (1 running)" tells the operator which ones a click reaches.
  return saved > 0 && running > 0
    ? ` — ${total} session${s} (${running} running)`
    : ` — ${total} session${s}`;
}

function deleteWorkspaceDetail(running, saved) {
  const s = (n) => (n === 1 ? '' : 's');
  if (running > 0 && saved > 0) {
    return `This will kill ${running} running session${s(running)} and delete ${saved} archived or saved session${s(saved)}, `
      + 'then remove the workspace. Transcripts stay on disk — recent ones can be re-adopted with Discover Sessions….';
  }
  if (saved > 0) {
    return `This workspace is not empty: it holds ${saved} archived or saved session${s(saved)}, which this deletes along with `
      + 'the workspace record. Transcripts stay on disk — recent ones can be re-adopted with Discover Sessions….';
  }
  if (running > 0) {
    return `This will kill ${running} running session${s(running)} and remove the workspace. `
      + 'Conversation transcripts on disk are preserved and can be resumed in a new workspace.';
  }
  return 'This removes the empty workspace record. No sessions will be affected.';
}

function createAppMenus(deps) {
  const {
    // value deps
    DEFAULT_WORKSPACE_ID, LOG_FILE, THEME_KEYS, path,
    checkForUpdate, confirmRestartClodex, createWindow,
    // getter deps (TDZ / whenReady-assigned when this factory runs)
    getManager, getPeerManager, getSandboxManager, getUpdateInfo,
    getUiSettings, getWorkspaces, getAgentLibrary, getSkillLibrary, getEnvScopes,
    getPromptLibrary, getTemplates, getExecLibrary,
    // The plugin host (T5) — null under CLODEX_PLUGINS=0 or a failed
    // construction, in which case the Plugins menu is absent rather than empty.
    getPluginHost,
    // The team manifest readers (t288), lazy for the same reason as the rest:
    // they live on the engine, which is assigned after this factory runs.
    getTeams,
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
          const suffix = workspaceCountSuffix(wsSessions, getManager().savedForWorkspace(ws.id).length);
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
                  // BOTH counted at CLICK time, not with the menu template: a
                  // tray menu can sit built for minutes, and these are the
                  // numbers that decide whether the dialog calls a total loss
                  // "empty". The label above may legitimately be stale; the
                  // sentence above a destructive button may not.
                  const wsSaved = getManager().savedForWorkspace(ws.id).length;
                  const wsRunning = getManager().listForWorkspace(ws.id).length;
                  const result = await dialog.showMessageBox({
                    type: 'warning',
                    buttons: ['Delete', 'Cancel'],
                    defaultId: 1,
                    cancelId: 1,
                    message: `Delete workspace "${ws.name || ws.id}"?`,
                    detail: deleteWorkspaceDetail(wsRunning, wsSaved),
                  });
                  if (result.response !== 0) return;
                  getManager().purgeWorkspace(ws.id);
                  getWorkspaces().remove(ws.id);
                  // Clean this workspace's env-scope entry so no secret husk survives
                  // the workspace it belonged to (T46). Best-effort.
                  try { getEnvScopes && getEnvScopes() && getEnvScopes().removeWorkspace(ws.id); } catch {}
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

  function buildLibraryMenu() {
    const truncate = (label) => (label.length > 60 ? label.slice(0, 57) + '…' : label);
    const listOf = (getter) => {
      try { return (getter && getter() && getter().list()) || []; } catch { return []; }
    };
    let bundles = [];
    try {
      const host = getPluginHost ? getPluginHost() : null;
      if (host && typeof host.bundles === 'function') bundles = host.bundles() || [];
    } catch { bundles = []; }

    const kindMenu = ({ channel, library, empty, pluginEntries, newLabel, accelerator, manageLabel }) => {
      const items = library.length ? library : [{ label: empty, enabled: false }];
      for (const b of bundles) {
        const entries = pluginEntries(b);
        if (!entries.length) continue;
        items.push({ type: 'separator' }, { label: b.name || b.id, enabled: false }, ...entries);
      }
      items.push(
        { type: 'separator' },
        { label: newLabel, ...(accelerator ? { accelerator } : {}), click: () => sendToFocused(channel, ':new') },
        { label: manageLabel, click: () => sendToFocused(channel, null) },
      );
      return items;
    };
    const described = (e) => truncate(e.description ? `${e.name}  —  ${e.description}` : e.name);
    const bundleItem = (channel, b, name) => ({
      label: truncate(name),
      click: () => sendToFocused(channel, { plugin: b.id, name }),
    });

    const promptItems = (rows, click) => {
      const out = [];
      for (const kind of ['system', 'append']) {
        const ofKind = rows.filter((p) => p && p.kind === kind);
        if (!ofKind.length) continue;
        out.push({ label: kind === 'system' ? 'System' : 'Append', enabled: false });
        for (const p of ofKind) out.push({ label: truncate(p.name), click: () => click(p, kind) });
      }
      return out;
    };

    return {
      label: 'Library',
      submenu: [
        {
          label: 'Prompts',
          submenu: kindMenu({
            channel: 'request-open-prompts-drawer',
            library: promptItems(listOf(getPromptLibrary), (p, kind) =>
              sendToFocused('request-open-prompts-drawer', { kind, name: p.name })),
            empty: '(no prompts in library)',
            pluginEntries: (b) => promptItems(b.prompts || [], (p, kind) =>
              sendToFocused('request-open-prompts-drawer', { plugin: b.id, kind, name: p.name })),
            newLabel: 'New Prompt…',
            manageLabel: 'Manage Prompts…',
          }),
        },
        {
          label: 'Templates',
          submenu: kindMenu({
            channel: 'request-open-templates-drawer',
            library: listOf(getTemplates).map((t) => ({
              label: truncate(t.name),
              click: () => sendToFocused('request-open-templates-drawer', t.id || t.name),
            })),
            empty: '(no templates in library)',
            pluginEntries: (b) => (b.templates || []).map((t) => bundleItem('request-open-templates-drawer', b, t.name)),
            newLabel: 'New Template…',
            manageLabel: 'Manage Templates…',
          }),
        },
        {
          label: 'Agents',
          submenu: kindMenu({
            channel: 'request-open-agents-drawer',
            library: listOf(getAgentLibrary).map((a) => ({
              label: described(a),
              click: () => sendToFocused('request-open-agents-drawer', a.name),
            })),
            empty: '(no agents in library)',
            pluginEntries: (b) => (b.agents || []).map((a) => bundleItem('request-open-agents-drawer', b, a.name)),
            newLabel: 'New Agent…',
            accelerator: 'CmdOrCtrl+Shift+A',
            manageLabel: 'Manage Agent Types…',
          }),
        },
        {
          label: 'Skills',
          submenu: kindMenu({
            channel: 'request-open-skills-drawer',
            library: listOf(getSkillLibrary).map((sk) => ({
              label: described(sk),
              click: () => sendToFocused('request-open-skills-drawer', sk.name),
            })),
            empty: '(no skills in library)',
            pluginEntries: (b) => (b.skills || []).map((sk) => bundleItem('request-open-skills-drawer', b, sk.name)),
            newLabel: 'New Skill…',
            accelerator: 'CmdOrCtrl+Shift+S',
            manageLabel: 'Manage Skills…',
          }),
        },
        {
          label: 'Exec Commands',
          submenu: kindMenu({
            channel: 'request-open-exec-drawer',
            library: listOf(getExecLibrary).map((c) => ({
              label: truncate(c.name),
              click: () => sendToFocused('request-open-exec-drawer', c.name),
            })),
            empty: '(no exec commands in library)',
            pluginEntries: () => [],
            newLabel: 'New Exec Command…',
            manageLabel: 'Manage Exec Commands…',
          }),
        },
        { type: 'separator' },
        {
          label: 'Inbox…',
          click: () => sendToFocused('request-open-inbox-drawer'),
        },
      ],
    };
  }

  // The top-level Plugins menu. Returns null when
  // there is nothing to show, and the caller then splices NOTHING into the
  // template — an empty "Plugins" menu is worse than no menu, because it looks
  // like a broken feature rather than an absent one. Two ways to get null:
  // CLODEX_PLUGINS=0 (no host at all) and an install with no plugins on disk.
  //
  // WHY THIS CAN BE A MENU AT ALL. Enable/disable state is ENGINE-side — the
  // loader's enabled set and quarantine record, both read through the host
  // object main.js already holds. So the main process can answer "is this plugin
  // on?" with no renderer round trip, which is exactly what a synchronously-built
  // Menu template needs. (Contrast the View menu's absent "Workbench…" item: a
  // plugin's SURFACES are renderer-side and the main process genuinely cannot
  // see them.)
  function buildPluginsMenu() {
    const host = getPluginHost ? getPluginHost() : null;
    if (!host || typeof host.status !== 'function') return null;
    let plugins = [];
    let problems = [];
    try {
      const st = host.status() || {};
      plugins = st.plugins || [];
      problems = st.problems || [];
    } catch { return null; }
    if (!plugins.length && !problems.length) return null;

    const submenu = plugins.map((p) => ({
      // The checkbox shows the user's INTENT, never the quarantine shadow —
      // keeping those two separate is the whole point of the fail-safe design
      // (a quarantine must not silently rewrite what the user asked for).
      // Quarantine is a THIRD state a native checkbox cannot express, so it goes
      // in the label: ticked + "held back" reads correctly, where an unticked
      // box would be a lie about the user's choice.
      label: p.quarantined
        ? `${p.name || p.id} — held back after ${p.failCount || 0} failed launches`
        : (p.name || p.id),
      type: 'checkbox',
      checked: !!p.enabled,
      click: () => {
        // Route through the SAME setEnabled the dialog's checkbox uses, so the
        // every-window plugin-state broadcast tears down renderer halves for us.
        // Enabling clears the quarantine strike first, which makes clicking a
        // held-back plugin a retry with no second code path.
        try { host.setEnabled(p.id, !p.enabled); } catch {}
        scheduleAppMenuRefresh();
      },
    }));
    // A directory that looks like a plugin but was refused (bad manifest, id/dir
    // mismatch). No toggle: there is no id to key one by when the manifest is
    // what is broken. Listed so it is not silently invisible.
    for (const pr of problems) {
      submenu.push({ label: `${pr.dir} — not loaded`, enabled: false });
    }
    submenu.push(
      { type: 'separator' },
      { label: 'Manage Plugins…', click: () => sendToFocused('request-open-plugins-dialog') }
    );
    return { label: 'Plugins', submenu };
  }

  // The top-level Teams menu (t288). Structurally the Plugins menu above, with
  // ONE deliberate inversion: it never returns null. A box with zero teams must
  // still show it, because "Create Team…" is the only route to the first team —
  // teams are otherwise reachable only by right-clicking a sidebar group header
  // that exists solely in the 'project' grouping mode. The plugins menu can hide
  // because a packaged build always ships plugins/workbench; that hole is masked
  // by luck (renderer/web/menubar.js documents it), and copying it here would
  // make an empty box a dead end.
  //
  // Clicking a team asks the RENDERER to open the roles popover: the popover is
  // renderer-side DOM the main process cannot reach, so the menu can only send
  // the request — the same shape as "Manage Plugins…".
  function buildTeamsMenu() {
    const teams = getTeams ? getTeams() : null;
    let names = [];
    try { names = (teams && teams.listTeams()) || []; } catch { names = []; }
    const submenu = [];
    for (const name of names) {
      // A team whose manifest will not load is LISTED, disabled — mirroring the
      // plugins menu's `problems` rows. Omitting it would make a broken team
      // invisible in the one surface that is supposed to enumerate teams, and
      // resolveTeam already skips it, so nothing else would ever mention it.
      let ok = false;
      try { teams.loadManifest(name); ok = true; } catch {}
      if (ok) submenu.push({ label: name, click: () => sendToFocused('request-open-team-roles', name) });
      else submenu.push({ label: `${name} — not loaded`, enabled: false });
    }
    if (!names.length) submenu.push({ label: '(no teams)', enabled: false });
    submenu.push(
      { type: 'separator' },
      { label: 'Create Team…', click: () => sendToFocused('request-open-team-create') }
    );
    return { label: 'Teams', submenu };
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
    // The stock About panel reads the .app bundle's Info.plist, so under `npm start`
    // (running inside Electron's own bundle) it reports Electron's version instead of
    // ours. setAboutPanelOptions overrides those fields at runtime either way.
    if (isMac) {
      app.setAboutPanelOptions({
        applicationName: 'Clodex',
        applicationVersion: app.getVersion(),
        version: `Electron ${process.versions.electron}`,
      });
    }
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
      buildLibraryMenu(),
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
          // No "Workbench…" item: the workbench is a plugin now and owns its
          // own entry point (a sidebar footer button it registers itself). A
          // core menu item here would be chrome that survives disabling the
          // plugin and opens nothing.
          //
          // Note this is NOT the same claim the Plugins menu below disproves.
          // That menu reads ENABLE state, which is engine-side and directly
          // readable from the main process. What a main-process menu still
          // cannot do is open a plugin's SURFACE: the overlay lives in one
          // BrowserWindow's DOM, mounted by that window's renderer half, and
          // nothing here knows whether the focused window has it.
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
          {
            label: 'Show IPC Traffic…',
            accelerator: 'CmdOrCtrl+Shift+B',
            click: () => sendToFocused('request-open-ipc-log'),
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
      // Plugins sits between View and Window, and is ABSENT (not empty) when
      // there is no host or nothing on disk — see buildPluginsMenu.
      ...(() => { const m = buildPluginsMenu(); return m ? [m] : []; })(),
      // Teams sits next to Plugins but is ALWAYS present — see buildTeamsMenu.
      buildTeamsMenu(),
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
          const countSuffix = workspaceCountSuffix(
            getManager().listForWorkspace(ws.id).length,
            getManager().savedForWorkspace(ws.id).length,
          );
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
                  // Both click-time, for the same reason as the tray copy above.
                  const savedCount = getManager().savedForWorkspace(ws.id).length;
                  const runningCount = getManager().listForWorkspace(ws.id).length;
                  const result = await dialog.showMessageBox(parent, {
                    type: 'warning',
                    buttons: ['Delete', 'Cancel'],
                    defaultId: 1,
                    cancelId: 1,
                    message: `Delete workspace "${ws.name || ws.id}"?`,
                    detail: deleteWorkspaceDetail(runningCount, savedCount),
                  });
                  if (result.response !== 0) return;
                  getManager().purgeWorkspace(ws.id);
                  getWorkspaces().remove(ws.id);
                  // Clean this workspace's env-scope entry so no secret husk survives
                  // the workspace it belonged to (T46). Best-effort.
                  try { getEnvScopes && getEnvScopes() && getEnvScopes().removeWorkspace(ws.id); } catch {}
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
    buildLibraryMenu, buildPluginsMenu, buildTeamsMenu, setUiTheme, buildAppMenu,
    refreshAppMenu, scheduleAppMenuRefresh, sendToFocused,
  };
}

module.exports = { createAppMenus, deleteWorkspaceDetail, workspaceCountSuffix };
