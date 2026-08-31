// Transport-agnostic: this module must not require electron. Registration and
// every native-GUI touch ride injected seams (handle/on, popupMenu, dialogs,
// shell/app calls) supplied by the host.

const { pathFor } = require('./clodex-paths');
const { nameConflict } = require('./session-manager');
// The SAME predicate the inject queue gates deliveries on. Required directly
// rather than injected so there is one draft notion: a focus decision computed
// from a second one would drift from the delivery it is supposed to agree with.
const { isDraftOpen } = require('./proxy-util');
const { STOCK_ROLE_DEFS } = require('./team-manifest');
const { teamPreflight } = require('./team-preflight');
const { appendRailPrompts } = require('./prompt-rails');
const { validateExecDef } = require('./exec-schema');
const sessionDiscovery = require('./session-discovery');
const gitWorktree = require('./git-worktree');
const { NO_SUCH_METHOD, errorEnvelope, sanitizeGrants, PLUGIN_CAPABILITIES, pluginReaches } = require('./plugin-api');
const { catalogRows, allowlistFromChecked, pluginRowFor } = require('./intent-registry');
const { feedSince } = require('./subagent-ring');
// contexts→peers import (t32 step 4). Electron-free; lives main-side ON PURPOSE
// — an imported token must never round-trip through the renderer (see the
// peer:import handlers below).
const peerImport = require('./peer-import');
const { wireSeatFor } = require('./peer-shell');

function registerIpcHandlers(deps) {
  const {
    handle, on,
    popupMenu, showMessageBox, showSaveDialog, showOpenDialog,
    openExternal, openPath, showItemInFolder, getAppVersion, getDesktopPath,
    CLAUDE_SKILLS, CLAUDE_SL_COMPONENTS, CLAUDE_TOOLS, CODEX_SL_COMPONENTS,
    DEPLOY_FIX_INJECT_DELAY_MS, ProxyClient, REGISTRY_DIR, SKILL_REENABLE_CONFIRMED,
    UPDATE_REPO, buildDeployFixBriefing, checkForUpdate, classifyDeployFolder,
    claudeProjectDir, collectSystemDiagnostics, createWindow, diagSummary,
    checkTools, invalidateToolCache, diagWarning, fetchFileDiff, fetchFilePeek, writeFilePeek, resolveFilePath, fetchProxyBust,
    fetchProxyContext, fetchProxyReport, fetchSessionFiles, fixSessionName,
    forgetPeerAttached, forgetPeerControlled, fs, https,
    jsonlToMarkdown, log, manager,
    openWirescopeWindow, os,
    path, persistence, probePeer, proxyPoller,
    pty, readEffectiveSkillState, readEffectiveToolState, readVoiceMode, readVoiceTrigger, readSessionMeta,
    rebuildAllStatusScripts, refreshAppMenu, refreshTrayMenu, rememberPeerControlled,
    createTeam, addRole, resolveTeam, listTeams, loadManifest,
    setRole, removeRole, renameRole, setTeamWatchdog, setLead,
    resolveDeployFolder, restartSession, restoreSessionsForWorkspace,
    readSessionArgs, applySessionArgs, sessionMeta, sessionInfo,
    readSkillCatalog, applySessionSkills, setUiTheme, sshRun,
    stripLevelOf, syncPeerManager, syncRemoteServer, updateApplies,
    setRemoteToken, hasRemoteToken, refreshRemoteToken, listSpeakVoices,
    wirescope, workspaceOfSender,
    sessionScopeCtx, renameWorkspaceScope,
    templates, workspaces, promptLibrary, agentDefaults,
    agentLibrary, skillLibrary, execLibrary, notifications, uiSettings, envScopes,
    getRemoteServer, getRemoteError, getPeerManager, getTunnelManager,
    getUpdateInfo, getReleasesCache,
    getWebTunnelManager, openPeerWeb, closePeerWeb,
    getSandbox, getSandboxManager,
    enableDrawerServices, enableLocalTerminal, getCtlService, getDrawerPtys, workspaceOfSenderStrict,
    syncTerminalReports,
    getPluginHost, surfaceOfSender,
  } = deps;

  async function spawnFromParams(e, p) {
    const workspaceId = workspaceOfSender(e);
    // Mint front door: every mint transport funnels here, while the resume paths
    // (restore, unarchive→retry, restart) call manager.create directly and may
    // legitimately re-create a persisted name. Reject a mint over any existing
    // record, live OR archived/persisted; resumeId is not the discriminator.
    const conflict = nameConflict({
      liveHas: manager.sessions.has(p.name),
      persistedHas: !!persistence.get(p.name),
    });
    if (conflict === 'live') throw new Error(`Session "${p.name}" already exists`);
    if (conflict === 'persisted') {
      throw new Error(`A session named "${p.name}" is archived or saved — unarchive it or pick another name.`);
    }
    const seedTools = (p.disabledTools === undefined) ? agentDefaults.getDefaultDeny() : p.disabledTools;
    const session = await manager.create(p.name, p.type, p.cwd, p.extraArgs, p.resumeId || null, workspaceId, p.systemPromptBody || null, !!p.fork, p.proxy ?? null, p.agents || [], p.denyBuiltins || [], seedTools || [], p.disabledSkills || [], p.injectSkills || [], p.systemPromptFile || null, p.appendPromptFiles || [], Array.isArray(p.execCommands) ? p.execCommands : [], Array.isArray(p.intents) ? p.intents : null, (p.env && typeof p.env === 'object') ? p.env : null, true, p.noWire === true);
    const seedStrip = (p.stripLevel === 1 || p.stripLevel === 2) ? p.stripLevel : agentDefaults.getStrip(p.name);
    if (seedStrip === 1 || seedStrip === 2) persistence.setStripLevel(p.name, seedStrip);
    return { ok: true, session };
  }

  handle('session:create', async (e, name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents, env, noWire) => {
    try {
      return await spawnFromParams(e, { name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents, env, noWire });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // The manifest write happens FIRST; the spawn then resolves the now-written
  // team and attaches the role prompt. A write refusal leaves the session unspawned.
  handle('team:create', async (e, spec) => {
    const { teamName, ...p } = spec || {};
    let written = false;
    let res;
    try {
      createTeam({ name: teamName, root: p.cwd, lead: p.name });
      written = true;
      res = await spawnFromParams(e, p);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    // Refresh OUTSIDE the try (house pattern, agents:remove): inside it, a throwing
    // rebuild would report failure for a write that landed, and the operator's retry
    // would then hit "already exists". Gated on the WRITE, not on `res`: the spawn
    // throws on a name conflict AFTER the team exists, and that team is exactly what
    // the menu is now missing.
    if (written) refreshAppMenu();
    return res;
  });

  // The manifest write with NO spawn (t288): the Teams menu creates a team before
  // any seat exists, so there is nothing to adopt as lead. `lead` is a seat NAME
  // the manifest records, and the default `<team>-lead` names a seat that has
  // never existed — which is NOT the state a team is in when its lead is merely
  // stopped: a stopped lead has a persisted record and restarts by name, while
  // this one resolves to nothing until something creates it. The team popover's
  // lead row (team:setLead) is that something; without a front door this default
  // is an orphan pointer the operator can only fix by hand-editing team.json.
  // `root` is forwarded verbatim so createTeam's absolute-path refusal is the
  // single gate; resolving it here would silently accept a relative root against
  // whatever cwd the main process happens to have.
  handle('team:createBare', (_e, spec) => {
    const { name, root, lead } = spec || {};
    let team;
    try {
      // The DEFAULT lead is minted here, so the refusal for it is owed here too:
      // `${name}-lead` overflows the 64-char seat-name limit (NAME_RE in
      // team-manifest.js) for a 60-64 char team name, and createTeam would then
      // refuse a `lead` field the Create Team… dialog never shows. An EXPLICIT
      // lead is the caller's own value and goes to the writer untouched.
      const seat = lead || `${name}-lead`;
      if (!lead && seat.length > 64) {
        throw new Error(`team name "${name}" is too long: its default lead seat name "${seat}" exceeds the 64-character seat-name limit`);
      }
      team = createTeam({ name, root, lead: seat });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    // Refreshed AFTER the try/catch (house pattern, agents:remove). The Electron
    // menu is a TEMPLATE rebuilt only here — it has no open-time hook, unlike the
    // web mirror which re-reads in items() — so without this the fresh-box flow
    // (create, then use the menu) still shows (no teams). A throwing rebuild must
    // not turn the landed write into {ok:false}; the retry would hit "already exists".
    refreshAppMenu();
    return { ok: true, team };
  });

  handle('team:join', async (e, spec) => {
    try {
      const { team, role, prompt, ...p } = spec || {};
      // Joining an EXISTING role adopts it as the team defines it; only an
      // absent role is minted. addRole is exact-match-or-throw, so re-riding a
      // stock def only stayed a no-op while STOCK_ROLE_DEFS and the def on disk
      // matched byte-for-byte — a team seeded by an older build (or whose role
      // an operator has since edited) then made "join as hand" fail outright
      // with "already exists with a different definition". The team's own
      // definition is the authority here; a join must not rewrite it.
      let exists = false;
      try { exists = !!loadManifest(team).roles[role]; } catch { exists = false; }
      if (!exists) {
        const def = role === 'hand'
          ? { ...STOCK_ROLE_DEFS.hand }
          : { prompt: prompt || null };
        addRole(team, role, def);
      }
      return await spawnFromParams(e, p);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('team:setRole', (_e, team, role, patch) => {
    try { return { ok: true, team: setRole(team, role, patch) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // `{operator: true}`: this channel IS the operator (the renderer), so it may
  // remove a reserved role — `reviewer` in practice, `lead` is refused for
  // everyone. The `[agent:team role-rm]` intent calls the same mutator without
  // the opt-in and keeps today's refusal. The C5 in-use guard runs first,
  // unchanged: a reviewer with a live seat or an open ticket is not removable.
  handle('team:removeRole', (_e, team, role) => {
    try {
      const blocked = manager._roleInUse(loadManifest(team), role);
      if (blocked.seats.length || blocked.tickets.length) {
        return { ok: false, error: `role "${role}" is in use`, blockedBy: blocked };
      }
      return { ok: true, team: removeRole(team, role, { operator: true }) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  handle('team:renameRole', (_e, team, from, to) => {
    try {
      const blocked = manager._roleInUse(loadManifest(team), from);
      if (blocked.seats.length || blocked.tickets.length) {
        return { ok: false, error: `role "${from}" is in use`, blockedBy: blocked };
      }
      return { ok: true, team: renameRole(team, from, to) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  handle('team:setWatchdog', (_e, team, ms) => {
    try { return { ok: true, team: setTeamWatchdog(team, ms) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // Re-point the lead SEAT. Not a role edit: setRole('lead') still refuses, and
  // this writes only the manifest's top-level `lead` pointer. A seat name with no
  // record is accepted by the writer on purpose (a stopped lead is the same
  // string); the popover is what tells the operator whether it resolves.
  handle('team:setLead', (_e, team, seat) => {
    try { return { ok: true, team: setLead(team, seat) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // The probes are bound HERE rather than inside team-preflight.js so the module
  // stays a pure leaf: every disk touch it makes is one of these four, which is
  // what lets the whole findings table be asserted from a fixture with no library
  // installed. `exists` is deliberately not confined — it checks absolute paths
  // built from the team's own root, not caller-supplied name segments.
  handle('team:preflight', (_e, name) => {
    try {
      const team = loadManifest(name);
      // Listed once per CALL and never cached across calls: a preflight run after
      // the operator installs the missing file must see it. The leaf calls this
      // probe once per granted command, and re-listing the whole exec directory
      // per command is the cost this local memo removes.
      let execDefs = null;
      const findings = teamPreflight(team, {
        exists: (abs) => { try { return fs.existsSync(abs); } catch { return false; } },
        listTemplates: () => templates.list(),
        // execLibrary.list() already parses every def and keeps both `argv` and
        // `cwd` — the two strings the runner expands, so both must survive to
        // the leaf. Reading the one file again by name would be a second parse
        // of the same bytes that can disagree with the first.
        readExecDef: (id) => {
          if (!execDefs) execDefs = execLibrary.list();
          const hit = execDefs.find((d) => d && d.name === id);
          if (hit) return hit;
          // list() `continue`s past a file whose JSON fails to parse, so absence
          // from it means "no file" OR "garbled file" — two different operator
          // recoveries (write one vs. repair the one on disk), and two different
          // runner failures. raw() is the only thing that separates them, and it
          // reads bytes rather than re-parsing, so it cannot disagree with the
          // parse above. The sentinel keeps the leaf pure: it names this one
          // condition, and must not grow into a general "list() had a problem".
          //
          // It means exactly READABLE BYTES THAT DO NOT DECODE TO A DEF OBJECT —
          // not every "the file is there but broken" state. raw() swallows
          // EACCES/EISDIR and returns null, so a def we lack permission to read
          // still reports as "no def installed": the same wrong-repair class,
          // one notch out. Fixing that means probing existence rather than
          // bytes, which costs a second disk touch and a reach past the store's
          // public surface; deliberately not taken here.
          // Not redundant with raw()'s own catch: that one covers the READ,
          // while _file() resolves outside it and throws on a name confineOrThrow
          // refuses. Uncaught, one bad name in one template collapses the whole
          // team's preflight to {ok:false} — reporting nothing because a single
          // name was bad is the swallow this module exists to kill.
          let bytes = null;
          try { bytes = execLibrary.raw(id); } catch { bytes = null; }
          return bytes == null ? null : { name: id, unreadable: true };
        },
        resolvePrompt: (kind, stem) => (promptLibrary.raw(kind, stem) == null ? null : 'library'),
      });
      return { ok: true, findings };
    } catch (err) { return { ok: false, error: err.message, findings: [] }; }
  });

  handle('team:names', () => {
    try { return { ok: true, names: listTeams() }; }
    catch (err) { return { ok: false, error: err.message, names: [] }; }
  });

  handle('team:forCwd', (_e, cwd) => {
    try { const t = resolveTeam(cwd); return { team: t ? t.name : null, root: t ? t.root : null }; }
    catch { return { team: null, root: null }; }
  });

  handle('team:get', (_e, name) => {
    try { return { ok: true, team: loadManifest(name) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // Same opt-in as team:removeRole, and it only changes one case: re-minting a
  // reserved key the operator had removed. addRole then writes the STOCK def and
  // ignores `def` entirely, so this channel cannot author a reviewer either.
  // team:join above deliberately does NOT pass it — a join must never mint one.
  //
  // The stock-def substitution below generalizes that recovery to `hand`, which is
  // a stock role but NOT a reserved one — so addRole's reserved branch never sees
  // it and an empty def would write a hand with no prompt: a role that exists,
  // spawns, and boots unbriefed. Widening RESERVED_ROLE_KEYS instead would lock
  // editing and renaming a role operators legitimately customize, so the fix
  // belongs here, at the operator door, not in the manifest's lock set.
  //
  // SECURITY: the def written is Clodex's own or the caller's, never a blend. The
  // substitution is gated on the caller's def being EMPTY, so nothing of the
  // caller's survives it; a non-empty def is passed through untouched and takes
  // addRole's ordinary validation. The reserved branch downstream still ignores
  // `def` entirely — that is what keeps remove-then-re-add of a reviewer safe —
  // and the intent path (`[agent:team role-add]`) never reaches here at all: it
  // calls the mutator without the operator opt-in, which this handler is the only
  // caller to pass.
  //
  // SEED-ONLY, and the absence check is what makes that true — the same shape
  // team:join uses. addRole is exact-match-or-throw, so substituting the stock def
  // for a role the team ALREADY has would turn a no-op re-add (empty def matching
  // an empty-normalized role on disk) into "already exists with a different
  // definition": the stock def refusing a live team's role. Gating on absence
  // keeps this a mint and nothing else. Pinned by team-hand-template-portable.test.js.
  const isEmptyDef = (d) => !d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length === 0;
  handle('team:addRole', (_e, team, role, def) => {
    try {
      let absent = false;
      try { absent = !loadManifest(team).roles[role]; } catch { absent = false; }
      const d = absent && isEmptyDef(def) && STOCK_ROLE_DEFS[role] ? { ...STOCK_ROLE_DEFS[role] } : def;
      return { ok: true, team: addRole(team, role, d, { operator: true }) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // `prompts` is the picker's offering (append-rail only); `all` is every system
  // prompt on disk. The popover needs both to tell a stored prompt that is ABSENT
  // from one that is present but off the rail — one message for both facts sent
  // the operator looking for a file that was there all along.
  handle('team:rolePrompts', () => {
    try {
      const rows = promptLibrary.list('system');
      return {
        ok: true,
        prompts: appendRailPrompts(rows),
        all: (rows || []).map((p) => p && p.name).filter(Boolean),
      };
    } catch (err) { return { ok: false, error: err.message, prompts: [], all: [] }; }
  });

  handle('worktree:create', async (_e, cwd, branch, opts) =>
    gitWorktree.createWorktree(cwd, branch, opts || null));
  handle('worktree:info', async (_e, cwd) => {
    try { return { ok: true, ...(await gitWorktree.repoInfo(cwd)) }; }
    catch (e) { return { ok: false, error: e.message, isRepo: false, branches: [] }; }
  });
  // Scoped, not global: `popular` is built from directory paths, so an unscoped
  // list would hand a web-host connection bound to one workspace the cwds of
  // every other one. See the rule at `session:list` below — this handler was the
  // violation of it, registered thirty lines above where it is stated.
  handle('session:cwdSuggestions', (e) => {
    const recent = Array.isArray(uiSettings.get().recentCwds) ? uiSettings.get().recentCwds : [];
    const counts = new Map();
    for (const s of manager.listForWorkspace(workspaceOfSender(e))) {
      if (!s.cwd) continue;
      counts.set(s.cwd, (counts.get(s.cwd) || 0) + 1);
    }
    const popular = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cwd, count]) => ({ cwd, count }));
    return { ok: true, recent, popular };
  });
  handle('session:noteCwd', (_e, cwd) => {
    const dir = typeof cwd === 'string' && cwd.trim();
    if (!dir) return { ok: false };
    const cur = Array.isArray(uiSettings.get().recentCwds) ? uiSettings.get().recentCwds : [];
    const next = [dir, ...cur.filter((c) => c !== dir)].slice(0, 12);
    uiSettings.set({ recentCwds: next });
    return { ok: true };
  });
  handle('session:markWorktree', (_e, name, worktree) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found' };
    persistence.setWorktree(name, worktree || null);
    return { ok: true };
  });

  // The fourteen scm:/worktree:/fs: rows that used to live here moved into
  // plugins/workbench/engine.js (plugin-plan.md [internal design doc, not in this repo] §4 W6) — the workbench is a
  // plugin now and reaches its own data over the plugin transport. Their
  // `sessionCwd` helper went with them: the host's `sessions.fsScope(name)` is
  // the same guarantee, offered to every plugin instead of re-implemented per
  // handler, which is what stops a plugin widening locality by accident.

  // No unscoped cross-workspace lister on this surface: web-host dispatches any
  // registered channel by name without consulting the contract, so a
  // `manager.list()` handler hands an authenticated connection every workspace's
  // sessions when it is bound to one. In-process callers (app-menus.js) use
  // `getManager().list()` directly and need no channel.
  //
  // That rule is now OWNED BY A TEST rather than by this paragraph:
  // test/ipc-unscoped-listing.test.js runs the one-line grep this comment
  // effectively specifies — no `manager.list()` anywhere in the registration
  // source — and pins `session:cwdSuggestions` to the sender's workspace. It
  // lived here as prose, with the violating handler registered THIRTY LINES
  // ABOVE it, until F012. A comment that names its own violating pattern is one
  // grep away from being executable, and the gap is where that sat.
  //
  // One channel below is deliberately global and is NOT a lapse:
  // `session:reservedNames` unions `manager.sessions.keys()` with
  // `persistence.list()` because session names are keyed GLOBALLY — a
  // reservation check scoped to one workspace would hand out a name that then
  // fails to create. It returns names only, no cwds and no session state. Read
  // the rule above as covering the session LISTING, which is the mechanism it
  // describes; the name NAMESPACE is global by construction and cannot be
  // scoped without breaking creation.
  handle('session:list', (e) => manager.listForWorkspace(workspaceOfSender(e)));
  handle('session:reservedNames', () => {
    const names = new Set(manager.sessions.keys());
    for (const s of persistence.list()) names.add(s.name);
    return { ok: true, names: [...names] };
  });
  // Delegates to manager.destroy — kill plus the worktree the record names.
  // This handler used to BE that logic, which is why team-retire (which cannot
  // reach an ipcMain handler) leaked every tree it discarded. One implementation
  // now, so a new delete route inherits it instead of reimplementing half.
  handle('session:kill', async (_e, name) => manager.destroy(name));
  handle('session:flushPending', (_e, name) => manager.flushPending(name));
  handle('session:peekPending', (_e, name) => manager.peekPendingFor(name));
  handle('session:resize', (_e, name, cols, rows) => manager.resize(name, cols, rows));
  handle('session:setLabel', (_e, name, label) => persistence.setLabel(name, label));
  handle('session:setAutoCompact', (_e, name, on) => persistence.setAutoCompact(name, on !== false));

  handle('dialog:selectDirectory', async () => {
    const result = await showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('update:check', () => checkForUpdate(false));
  handle('update:info', () => getUpdateInfo());
  handle('update:releases', () => getReleasesCache());
  handle('update:open', () => {
    if (getUpdateInfo()) openExternal(getUpdateInfo().url);
  });
  handle('app:getVersion', () => getAppVersion());

  handle('diagnostics:get', () => {
    const d = collectSystemDiagnostics();
    const warning = diagWarning(d);
    const cliMissingIsCause = !!warning && !diagWarning({ ...d, claude: 'present', codex: 'present' });
    return { ...d, warning, summary: diagSummary(d), cliMissingIsCause };
  });

  handle('tools:check', async () => {
    try { return await checkTools(); }
    catch { return { byTool: {}, list: [] }; }
  });

  handle('tools:invalidate', () => {
    try { invalidateToolCache(); return { ok: true }; }
    catch { return { ok: false }; }
  });

  handle('templates:list', () => templates.list());
  handle('templates:save', (_e, template) => { templates.save(template); return templates.list(); });
  handle('templates:saveByName', (_e, template) => {
    const t = templates.saveByName(template);
    return { ok: true, template: t, templates: templates.list() };
  });
  handle('templates:remove', (_e, id) => {
    // A refused name now throws (stores.js confines at _file). Caught here so
    // it reads like every other refusal on this surface instead of rejecting
    // the invoke, and so the caller can tell it apart from a real delete.
    try { templates.remove(id); } catch { /* refused name — nothing was deleted */ }
    return templates.list();
  });
  handle('templates:exportFromSession', (_e, name, templateName) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: `no session "${name}"` };
    const tn = (templateName || '').trim();
    if (!tn) return { ok: false, error: 'template name required' };
    const t = {
      name: tn,
      type: entry.type,
      cwd: entry.cwd || null,
      extraArgs: Array.isArray(entry.extraArgs) ? entry.extraArgs : [],
      proxy: entry.proxy ?? null,
      agents: Array.isArray(entry.agents) ? entry.agents : [],
      execCommands: Array.isArray(entry.execCommands) ? entry.execCommands : [],
      denyBuiltins: Array.isArray(entry.denyBuiltins) ? entry.denyBuiltins : [],
      disabledTools: Array.isArray(entry.disabledTools) ? entry.disabledTools : [],
      disabledSkills: Array.isArray(entry.disabledSkills) ? entry.disabledSkills : [],
      injectSkills: Array.isArray(entry.injectSkills) ? entry.injectSkills : [],
      systemPromptFile: entry.systemPromptFile || null,
      appendPromptFiles: Array.isArray(entry.appendPromptFiles) ? entry.appendPromptFiles : [],
    };
    if (entry.stripLevel === 1 || entry.stripLevel === 2) t.stripLevel = entry.stripLevel;
    if (entry.autoCompact === false) t.autoCompact = false;
    // Intent gate: an opt-out field like stripLevel/autoCompact — present ONLY when
    // the seat has a restricted allowlist (≥1 intent off). An all-enabled seat has
    // no `intents` key, so we must NOT write `intents: []` here (that would freeze
    // "everything gated" onto a template that meant "all on"). Absent stays absent.
    if (Array.isArray(entry.intents)) t.intents = entry.intents;
    // Opt-out field like stripLevel/autoCompact: written only when ON, so an
    // ordinary (wired) session exports a template with no `noWire` key at all.
    if (entry.noWire === true) t.noWire = true;
    templates.saveByName(t);
    return { ok: true, templates: templates.list() };
  });

  handle('prompts:list', (_e, kind) => promptLibrary.list(kind));
  handle('prompts:save', (_e, kind, name, body) => {
    try { return { ok: true, prompts: promptLibrary.save(kind, name, body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  handle('prompts:remove', (_e, kind, name) => {
    try { return { ok: true, prompts: promptLibrary.remove(kind, name) }; }
    catch (err) { return { ok: false, error: err.message, prompts: promptLibrary.list() }; }
  });

  handle('agents:list', () => agentLibrary.list());
  handle('agents:get', (_e, name) => agentLibrary.raw(name));
  handle('agents:save', (_e, name, content) => {
    try {
      const agents = agentLibrary.save(name, content);
      refreshAppMenu(); // Agents menu lists the library — keep it current.
      return { ok: true, agents };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  handle('agents:remove', (_e, name) => {
    let agents;
    try { agents = agentLibrary.remove(name); }
    catch (err) { return { ok: false, error: err.message, agents: agentLibrary.list() }; }
    refreshAppMenu();
    return { ok: true, agents };
  });

  handle('skilllib:list', () => skillLibrary.list());
  handle('skilllib:get', (_e, name) => skillLibrary.raw(name));
  handle('skilllib:save', (_e, name, content) => {
    try {
      const skills = skillLibrary.save(name, content);
      refreshAppMenu();
      return { ok: true, skills };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  handle('skilllib:remove', (_e, name) => {
    let skills;
    try { skills = skillLibrary.remove(name); }
    catch (err) { return { ok: false, error: err.message, skills: skillLibrary.list() }; }
    refreshAppMenu();
    return { ok: true, skills };
  });
  // Operator-only by construction: there is deliberately NO exec-write intent
  // verb, so an agent can neither register a command nor grant itself one.
  // save() rejects any def the exec dispatcher would later refuse.
  handle('exec:list', () => execLibrary.list());
  handle('exec:get', (_e, name) => execLibrary.raw(name));
  handle('exec:save', (_e, name, content) => {
    let def;
    try {
      def = JSON.parse(content);
    } catch (err) {
      return { ok: false, error: `invalid JSON: ${err.message}` };
    }
    const check = validateExecDef(def, name);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      return { ok: true, commands: execLibrary.save(name, JSON.stringify(def, null, 2)) };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  handle('exec:remove', (_e, name) => {
    try { return { ok: true, commands: execLibrary.remove(name) }; }
    catch (err) { return { ok: false, error: err.message, commands: execLibrary.list() }; }
  });

  handle('notifications:list', () => notifications.list());
  handle('notifications:markRead', (_e, id) => notifications.markRead(id));
  handle('notifications:markAllRead', () => notifications.markAllRead());
  handle('notifications:remove', (_e, id) => notifications.remove(id));
  handle('notifications:unreadCount', () => notifications.unreadCount());

  handle('prompts:inject', (_e, name, body) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    manager._injectText(s, body);
    return { ok: true };
  });

  // A session the window no longer has, or never had, is not typing — an
  // unknown name answers false rather than erroring, because the one caller
  // (the focus decision) must not turn a lookup miss into a refusal to focus.
  handle('session:draftOpen', (_e, name) => {
    const s = manager.sessions.get(name);
    return { ok: true, open: !!s && !s._dead && isDraftOpen(s) };
  });

  handle('proxy:snapshot', (_e, name) => proxyPoller.snapshot(name));

  // The account plan quota a window can show before any turn is forwarded.
  // Without this read a restored reading would sit on disk until the next
  // forwarded turn — the blank-at-launch case persistence exists to fix, since
  // the broadcast that carries it fires only when a turn arrives.
  handle('wire:quota', () => {
    const store = manager.quotaStore();
    return store ? store.snapshot() : null;
  });

  handle('proxy:context', (_e, name, opts) => fetchProxyContext(name, opts));

  handle('proxy:report', (_e, name, opts) => fetchProxyReport(name, opts));

  handle('proxy:bust', (_e, name) => fetchProxyBust(name));

  // Wire-fed subagent feed: a plain read of an in-memory ring, no proxy round
  // trip. It needs no wirescope link — any wire-routed session has the turns,
  // which is why it replaced the proxy-polled endpoint. `since` is the caller's
  // last seen `seq`;
  // the reply's `seq` is the store HEAD, so polling a quiet feed still advances
  // the cursor and rows can never be served twice.
  handle('proxy:subagentFeed', (_e, name, child, since) => {
    const s = manager.sessions.get(name);
    if (!s || !s.subagentStore) return { ok: false, error: 'Session has no wire feed' };
    if (typeof child !== 'string' || !child) return { ok: false, error: 'Missing child key' };
    const n = Number(since);
    return { ok: true, data: feedSince(s.subagentStore, child, Number.isFinite(n) ? n : 0) };
  });

  handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) openExternal(url);
  });

  handle('app:openWirescope', (_e, url, backgroundColor) => {
    openWirescopeWindow(url, backgroundColor);
  });

  handle('proxy:hold', async (_e, name, hours, force) => {
    const s = manager.sessions.get(name);
    if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
    const snap = proxyPoller.snapshot(name);
    if (!snap || !snap.linked || !snap.sessionId) {
      return { ok: false, error: 'No live proxy session to hold (unlinked)' };
    }
    if (snap.capabilities && snap.capabilities.hold === false) {
      return { ok: false, error: 'This proxy does not support holds' };
    }
    try {
      const r = await ProxyClient.hold(s.proxyBase, snap.sessionId, hours, !!force);
      const j = r.json || {};
      // Distinguish armed from declined (skipped) — a 200 can mean "I chose
      // not to act". Surface the reason so the UI never reads a no-op as success.
      return { ok: true, status: r.status, armed: !!j.armed, skipped: j.skipped || null, body: j };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('wire:hold', (_e, name, hours, force, always) => {
    if (!manager._holdKeeper || !manager._wireTelemetry) {
      return { ok: false, error: 'In-process wire keep-warm is not running' };
    }
    const w = manager._wireTelemetry.payload(name);
    if (!w || !w.sessionId) {
      return { ok: false, error: 'The wire has not seen a turn for this session yet' };
    }
    try {
      const j = (always || hours > 0)
        ? manager._holdKeeper.arm(w.sessionId, hours, { force: !!force, always: !!always })
        : manager._holdKeeper.disarm(w.sessionId);
      // A perpetual arm has no `until`, so it must not be gated on one.
      if (j.armed && (j.always || j.until)) {
        // The two are mutually exclusive states of ONE control: writing the new
        // one without clearing the other would leave a seat that the operator
        // set back to 4h still re-arming perpetually after every restart.
        if (j.always) {
          persistence.setKeepWarmAlways(name, true);
          persistence.setHoldUntil(name, null);
          log.info('keepwarm', `armed ${name} perpetually (no deadline)`);
        } else {
          persistence.setHoldUntil(name, Math.round(j.until * 1000));
          persistence.setKeepWarmAlways(name, false);
          log.info('keepwarm', `armed ${name} ${hours}h until ${new Date(j.until * 1000).toISOString()}`);
        }
      } else if (!always && !(hours > 0)) {
        persistence.setHoldUntil(name, null);
        persistence.setKeepWarmAlways(name, false);
        log.info('keepwarm', `disarmed ${name} (explicit)`);
      }
      return { ok: true, status: 200, armed: !!j.armed, skipped: j.skipped || null, body: j };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('proxy:setStripLevel', async (_e, name, level) => {
    const s = manager.sessions.get(name);
    if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
    const snap = proxyPoller.snapshot(name);
    if (!snap || !snap.linked || !snap.sessionId) {
      return { ok: false, error: 'No live proxy session (unlinked)' };
    }
    const caps = snap.capabilities || {};
    const cap = caps.strip_thinking;
    if (!cap || !cap.available) {
      return { ok: false, error: 'This proxy does not support strip-thinking' };
    }
    let lvl = (level === 1 || level === 2) ? level : 0;
    if (lvl === 2 && !(cap.max_level >= 2)) {
      return { ok: false, error: 'This proxy does not support level 2 stripping yet' };
    }
    persistence.setStripLevel(name, lvl);
    agentDefaults.setStrip(name, lvl);
    proxyPoller.noteStripAsserted(name, snap.sessionId, lvl);
    try {
      const gd = (snap.strip && snap.strip.globalDefaultLevel) || 0;
      const r = await ProxyClient.stripThinking(s.proxyBase, snap.sessionId, lvl, lvl === 0 && gd >= 1);
      const j = r.json || {};
      return { ok: true, status: r.status, level: lvl, effective: !!j.effective, body: j };
    } catch (e) {
      proxyPoller.stripAsserted.delete(name);
      return { ok: false, error: e.message, level: lvl };
    }
  });

  handle('session:getArgs', (_e, name) => readSessionArgs(name));

  handle('session:history', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found' };
    if (entry.type !== 'claude' && entry.type !== 'codex') return { ok: true, sessions: [], activeId: null };
    let slugDir = null;
    try { slugDir = path.dirname(fs.realpathSync(pathFor(REGISTRY_DIR, name, 'transcript'))); } catch {}
    if (!slugDir) slugDir = claudeProjectDir(entry.cwd);
    const activeId = entry.sessionId || null;
    const tracked = new Set([...(Array.isArray(entry.sessionIds) ? entry.sessionIds : []), ...(activeId ? [activeId] : [])]);
    const out = [];
    const seen = new Set();
    const add = (sid, inferred) => {
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      const meta = slugDir ? readSessionMeta(path.join(slugDir, `${sid}.jsonl`)) : null;
      if (!meta) {
        if (!inferred) out.push({ sessionId: sid, title: null, lastActive: null, active: sid === activeId, inferred: false, missing: true });
        return;
      }
      out.push({ sessionId: sid, title: meta.title, firstActive: meta.first, lastActive: meta.last, turns: meta.turns, active: sid === activeId, inferred });
    };
    for (const sid of tracked) add(sid, false);
    try {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const fn of fs.readdirSync(slugDir)) {
        if (!fn.endsWith('.jsonl')) continue;
        const sid = fn.slice(0, -6);
        if (tracked.has(sid)) continue;
        let st; try { st = fs.statSync(path.join(slugDir, fn)); } catch { continue; }
        if (st.mtimeMs >= cutoff) add(sid, true);
      }
    } catch {}
    out.sort((a, b) => (Date.parse(b.lastActive || 0) || 0) - (Date.parse(a.lastActive || 0) || 0));
    return { ok: true, sessions: out, activeId };
  });

  // The ⓘ panel. On demand only — the transcript scan streams tens of MB, which
  // is fine for a click and would not be for the poll. The live wire ledger is
  // passed in for the CURRENT session because wire-totals.json is written on a
  // 1s debounce: without it the agent lifetime total appears to go DOWN between
  // a turn landing and the file catching up.
  handle('session:info', async (_e, name) => {
    try {
      const entry = persistence.get(name);
      if (!entry) return { ok: false, error: 'Session not found' };
      const payload = proxyPoller ? proxyPoller.snapshot(name) : null;
      let live = null;
      const wt = manager._wireTelemetry;
      if (wt) {
        const w = wt.payload(name);
        // Only when the wire agrees on the session identity — a stale agent
        // record would credit this session with another's ledger.
        if (w && w.sessionId && w.sessionId === entry.sessionId) {
          live = { cost: w.cost && w.cost.usd, requests: w.cost && w.cost.requests, turns: w.turns, refusals: w.refusals };
        }
      }
      return { ok: true, info: await sessionInfo.collect({ name, entry, payload, live }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('discovery:scan', async (_e, opts) => {
    try {
      const maxAgeMs = (opts && Number(opts.maxAgeMs)) || sessionDiscovery.DEFAULT_MAX_AGE_MS;
      const tracked = manager.trackedSessionIds();
      const disk = sessionDiscovery.discoverAdoptable({ tracked, maxAgeMs, readMeta: readSessionMeta });
      let live = [];
      if (!opts || opts.live !== false) {
        try { live = await sessionDiscovery.discoverLiveProcesses({ ownPids: manager.livePids() }); } catch {}
      }
      const liveCwds = new Set(live.map((p) => p.cwd).filter(Boolean));
      for (const r of disk) r.liveInCwd = !!(r.cwd && liveCwds.has(r.cwd));
      return { ok: true, disk, live };
    } catch (e) {
      return { ok: false, error: e.message, disk: [], live: [] };
    }
  });

  handle('sidebar:meta', async (e, opts) => {
    const workspaceId = workspaceOfSender(e);
    const list = persistence.listForWorkspace(workspaceId);
    const sessions = list.map((s) => ({ name: s.name, cwd: s.cwd }));
    const includePr = !opts || opts.includePr !== false;
    try {
      const meta = await sessionMeta.metaFor(sessions, { includePr });
      const teamByCwd = new Map();
      for (const s of list) {
        if (!meta[s.name]) meta[s.name] = {};
        // A new array, never a push: metaFor freezes ONE instance and shares it
        // across every row, so extending it in place would re-tier the whole
        // batch (and throw). Claiming the tier is what makes the four keys below
        // authoritative — including by omission, which is how a revoke lands.
        meta[s.name]._tiers = [...(meta[s.name]._tiers || []), 'record'];
        meta[s.name].createdAt = s.createdAt || null;
        meta[s.name].archivedAt = s.archivedAt || null;
        if (!teamByCwd.has(s.cwd)) teamByCwd.set(s.cwd, manager.teamNameFor(s.cwd));
        meta[s.name].team = teamByCwd.get(s.cwd);
        // Per-session plugin grants (t190). Carried on the meta refresh rather
        // than a new channel: the sidebar paints every session at once, so the
        // renderer needs an answer for each ROW, and this is already the
        // per-row read that runs on a timer.
        //
        // Omitted rather than empty-filled on a revoke: the `record` claim above
        // makes absence mean "none granted", so the renderer's clear is what
        // lands it. Before the tier existed this key had to be written
        // unconditionally, because an omitted key read as "unchanged" and every
        // badge kept painting off the stale array.
        if (Array.isArray(s.pluginGrants) && s.pluginGrants.length) {
          meta[s.name].pluginGrants = [...s.pluginGrants];
        }
      }
      return { ok: true, meta };
    } catch (err) {
      return { ok: false, error: err.message, meta: {} };
    }
  });

  // Unarchive must clear the stamp BEFORE the operator's respawn upsert, which
  // would otherwise re-inherit archivedAt.
  handle('session:archive', async (_e, name) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found' };
    await manager.archive(name);
    return { ok: true };
  });
  handle('session:unarchive', (_e, name) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found' };
    persistence.setArchived(name, false);
    return { ok: true };
  });
  handle('session:files', (_e, name) => fetchSessionFiles(name));
  handle('file:peek', (_e, filePath) => fetchFilePeek(filePath));
  handle('file:diff', (_e, name, filePath) => fetchFileDiff(name, filePath));
  // Takes a name, unlike file:peek — the session's cwd is what confines the
  // write, so there is no nameless form of this row to reach for.
  handle('file:write', (_e, name, filePath, content, expectMtime) =>
    writeFilePeek(name, filePath, content, expectMtime));
  // "Does this displayed string name a real file?" — the renderer scans text for
  // path-shaped tokens but cannot stat, so it asks here before opening a peek.
  handle('file:resolve', (_e, name, raw, baseDir) => resolveFilePath(name, raw, baseDir));
  handle('file:open', (_e, filePath) => openPath(filePath));
  handle('file:reveal', (_e, filePath) => { showItemInFolder(filePath); });

  handle('session:setTools', (_e, name, disabledTools) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setDisabledTools(name, Array.isArray(disabledTools) ? disabledTools : []);
    return { ok: true };
  });
  handle('session:setSkills', (_e, name, disabledSkills, injectSkills) =>
    applySessionSkills(name, disabledSkills, injectSkills));
  handle('session:setAgents', (_e, name, agents, denyBuiltins) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setAgents(name,
      Array.isArray(agents) ? agents : [],
      Array.isArray(denyBuiltins) ? denyBuiltins : []);
    return { ok: true };
  });
  // Applies IMMEDIATELY, no restart: the fire-time gate re-reads persistence.
  // `intents` is the raw checked set (array, [] = none checked) or null (hidden);
  // the collapse to the all-enabled default must happen HERE, not in the renderer,
  // because only the engine knows the live row set. null removes the key.
  handle('session:setIntents', (_e, name, intents) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setIntents(name, Array.isArray(intents) ? allowlistFromChecked(intents) : null);
    return { ok: true };
  });
  handle('session:agentCatalog', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    return {
      ok: true,
      agents: agentLibrary.listFor(sessionScopeCtx(name)),
      enabled: Array.isArray(entry.agents) ? entry.agents : [],
      denyBuiltins: Array.isArray(entry.denyBuiltins) ? entry.denyBuiltins : [],
    };
  });
  handle('session:skillCatalog', (_e, name) => readSkillCatalog(name));
  handle('settings:skillCatalogFor', (_e, cwd) => {
    const eff = readEffectiveSkillState(cwd || null);
    const names = [...new Set([...CLAUDE_SKILLS, ...Object.keys(eff.overrides)])].sort();
    return { ok: true, names, effective: eff.overrides, skillsLocked: eff.skillsLocked, canReenable: SKILL_REENABLE_CONFIRMED };
  });
  // Box-wide, so it takes no session name: ~/.claude/settings.json is global and
  // every Claude session on this box shares it. Reading it MAIN-side is what lets
  // the browser frontend have this control at all — a renderer-side fs read would
  // ship a button that is dead over web-host.
  // The trigger key rides this same channel rather than a second one: both are
  // read-only facts about the CLI's own config, and the re-arm needs the mode
  // and the key together to decide anything.
  handle('settings:voiceMode', () => ({ ok: true, ...readVoiceMode(), trigger: readVoiceTrigger() }));

  handle('settings:toolCatalogFor', (_e, cwd) => {
    return { ok: true, effective: readEffectiveToolState(cwd || null).overrides };
  });

  handle('session:setArgs', async (e, name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles, intents, execCommands, env) =>
    applySessionArgs(name, {
      extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins,
      disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles, intents, execCommands, env,
    }, workspaceOfSender(e)));

  handle('session:restart', async (e, name, opts = {}) =>
    restartSession(name, opts, workspaceOfSender(e)));

  handle('settings:get', () => {
    const s = uiSettings.get();
    return {
      statusline: s.statusline,
      claudeComponents: CLAUDE_SL_COMPONENTS,
      codexComponents: CODEX_SL_COMPONENTS,
      claudeTools: CLAUDE_TOOLS,
      defaultToolDeny: agentDefaults.getDefaultDeny(),
      proxyEnabled: s.proxyEnabled,
      proxyUrl: s.proxyUrl,
      lastCustomProxyUrl: s.lastCustomProxyUrl,
      wirescopeDir: s.wirescopeDir,
      wirescopePort: s.wirescopePort,
      disableClaudeDesignMcp: s.disableClaudeDesignMcp,
      compactOnResume: s.compactOnResume,
      contextHints: s.contextHints,
      semanticHints: s.semanticHints,
      selectionHints: s.selectionHints,
      voiceSubmit: s.voiceSubmit,
      voiceSubmitComposition: s.voiceSubmitComposition,
      voiceSubmitRearm: s.voiceSubmitRearm,
      voiceSubmitPhrase: s.voiceSubmitPhrase,
      speakReplies: s.speakReplies,
      speakVoice: s.speakVoice,
      speakRate: s.speakRate,
      // Enumerated per box, not a constant: the installed set is far smaller
      // than the documented one and differs per machine, and `say` answers an
      // uninstalled name by substituting the system voice rather than failing.
      // Offering a name from memory would offer one the operator cannot get.
      speakVoices: typeof listSpeakVoices === 'function' ? listSpeakVoices() : [],
      terminalReports: s.terminalReports,
      discoverOnStartup: s.discoverOnStartup,
      theme: s.theme,
      sidebarWidth: s.sidebarWidth,
      remoteEnabled: s.remoteEnabled,
      remotePort: s.remotePort,
      // This object is an explicit WHITELIST, not a spread: a serving-side flag
      // the renderer reads has to be named here or it arrives `undefined`, and
      // `!!undefined` is indistinguishable from a real "off" at every consumer.
      // For this key that reads as "sharing is off" on a box that is serving —
      // the one direction the indicator must never be wrong in.
      peerShellEnabled: s.peerShellEnabled,
      remoteHasToken: typeof hasRemoteToken === 'function' ? hasRemoteToken() : false,
      // Peer auth token is WRITE-ONLY (remote-auth-plan.md [internal design doc, not in this repo] §4): the renderer
      // sees only a `hasToken` boolean, never the value. The Peers dialog saves
      // the array back, so an omitted `token` carries forward in sanitizePeers —
      // the value never has to round-trip through the UI.
      peers: (s.peers || []).map(({ token, ...rest }) => ({ ...rest, hasToken: !!token })),
    };
  });
  handle('settings:set', (_e, partial) => {
    // Read BEFORE the write: the revocation below is a transition, and the only
    // place the previous value still exists is here.
    const prevTerminalReports = uiSettings.get().terminalReports;
    const next = uiSettings.set(partial);
    // No truthiness guard on the dep, matching the posture the term intent
    // takes: an unwired revocation must throw here rather than skip silently.
    // This is the transition that withdraws undrained reports, and a `typeof`
    // check turns forgetting to inject it into the queue quietly never being
    // swept — the precise failure a surviving mutant already found once.
    syncTerminalReports(prevTerminalReports);
    rebuildAllStatusScripts(manager);
    if (wirescope.autoStartWanted()) wirescope.start().catch(() => {});
    else wirescope.stop();
    syncRemoteServer();
    syncPeerManager();
    return next;
  });

  handle('remote:status', () => ({
    running: !!(getRemoteServer() && getRemoteServer().running),
    port: uiSettings.get().remotePort,
    error: getRemoteError(),
  }));

  // Set (non-empty string) or clear (empty/null) the operator wire token, then
  // force the RemoteServer to rebuild so the new gate is live at once (it reads
  // the token only at construct). WRITE-ONLY: returns just a hasToken boolean —
  // the value never rounds back through IPC. A host without the setter no-ops.
  handle('remote:setToken', (_e, token) => {
    if (typeof setRemoteToken !== 'function') return { ok: false, error: 'remote token not supported on this host' };
    try {
      const hasToken = setRemoteToken(token);
      if (typeof refreshRemoteToken === 'function') refreshRemoteToken();
      return { ok: true, hasToken };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // A value marked `secret` is WRITE-ONLY through IPC: the read handler never
  // returns it, only { key, secret:true, hasValue:true }. `scope` is 'global' or a
  // workspaceId; session-scope env rides create()'s env param, not a stored scope.
  handle('envScopes:get', (_e, scope) => {
    if (!envScopes) return { ok: false, error: 'env scopes not supported on this host' };
    const raw = envScopes.getScope(scope === 'global' ? 'global' : String(scope));
    const vars = Object.entries(raw).map(([key, rec]) => {
      const secret = !!(rec && typeof rec === 'object' && rec.secret);
      if (secret) return { key, secret: true, hasValue: true };
      const value = rec && typeof rec === 'object' ? rec.value : rec;
      return { key, secret: false, value: String(value == null ? '' : value) };
    }).sort((a, b) => a.key.localeCompare(b.key));
    return { ok: true, scope: scope === 'global' ? 'global' : String(scope), vars };
  });
  handle('envScopes:set', (_e, scope, key, value, secret) => {
    if (!envScopes) return { ok: false, error: 'env scopes not supported on this host' };
    try {
      envScopes.set(scope === 'global' ? 'global' : String(scope), key, value, secret === true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  handle('envScopes:delete', (_e, scope, key) => {
    if (!envScopes) return { ok: false, error: 'env scopes not supported on this host' };
    try {
      envScopes.remove(scope === 'global' ? 'global' : String(scope), key);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // One multiplexed channel for every plugin, forwarded to the engine-owned
  // dispatch Map. The injected transport has no removeHandler, so a per-plugin
  // channel could never be unregistered — this is the only shape in which
  // dispose() is implementable. A missing host degrades to a shaped refusal
  // rather than an undefined resolution.
  const pluginRefusal = () => errorEnvelope(NO_SUCH_METHOD);
  // The CALLER SURFACE rides the call, because it cannot ride registration:
  // this channel stays registered on every transport (the web renderer's plugin
  // UI needs it), so `enableDrawerServices`-style gating by absence would take
  // plugins away from the web entirely. Supplied per-transport like
  // workspaceOfSender; a transport that supplies nothing yields undefined,
  // which the host treats as untrusted rather than as the desktop.
  handle('plugin:invoke', async (_e, pluginId, method, args) => {
    const host = getPluginHost && getPluginHost();
    if (!host) return pluginRefusal();
    const surface = typeof surfaceOfSender === 'function' ? surfaceOfSender(_e) : undefined;
    return host.dispatch(pluginId, method, Array.isArray(args) ? args : [], surface);
  });
  handle('plugin:catalog', () => {
    const host = getPluginHost && getPluginHost();
    return host ? host.catalog() : [];
  });
  handle('plugin:setEnabled', async (_e, pluginId, enabled) => {
    const host = getPluginHost && getPluginHost();
    if (!host) return pluginRefusal();
    return host.setEnabled(String(pluginId), enabled !== false);
  });
  // Served, not statically required: a plugin can register a verb, and in a web
  // bundle a require freezes at build time. Straight off intent-registry, NOT off
  // the plugin host — the registry is a module-level table both halves mutate, so
  // it stays authoritative with no host (kill switch, construction failed), where
  // routing through the host would blank the checklist in exactly those cases.
  // The session name is OPTIONAL and its absence is not a shortcut for "show
  // everything": with no session there are no grants, so a session-scoped
  // plugin's rows do not surface. That is the right answer for the only caller
  // that has no name to give — the NEW-session dialog, which is choosing what a
  // seat that does not exist yet may do.
  handle('intents:catalog', (_e, name) => {
    const entry = name ? persistence.get(String(name)) : null;
    return catalogRows(entry && entry.pluginGrants);
  });

  // Companion to session:setIntents, and deliberately a SEPARATE channel rather
  // than a field on it: the two are written by different UI blocks, and folding
  // grants into the intents payload would make a checklist save that omitted
  // them silently revoke every grant.
  handle('session:setPluginGrants', (_e, name, grants) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    const next = sanitizeGrants(grants);
    persistence.setPluginGrants(name, next);
    // A revoked grant must also drop the plugin's verbs from the allowlist, at
    // this one write point. Without it the two decisions diverge silently and
    // the UI hides the side that still bites: the row vanishes from the
    // checklist and the grammar line from the prompt, while `intentEnabledFor`
    // — scope-blind by design, and staying that way — keeps letting the seat
    // fire the verb into a plugin it holds no capability on. The popover's own
    // save order (intents first, grants second) makes that the DEFAULT outcome
    // of an in-dialog revoke.
    // A null allowlist needs no reconcile: a plugin row is enabled only by
    // explicit inclusion in an array, never by the all-enabled default.
    if (Array.isArray(entry.intents)) {
      const kept = entry.intents.filter((t) => {
        const row = pluginRowFor(t);
        if (!row || row.scope !== 'session') return true;
        return pluginReaches(row.source, next);
      });
      if (kept.length !== entry.intents.length) persistence.setIntents(name, kept);
    }
    return { ok: true };
  });

  // What the grants UI needs to draw itself: the session-scoped plugins that
  // exist, plus what this session has already granted. Only SCOPED plugins are
  // listed — a global plugin has no per-session decision to offer, so listing it
  // would invite an operator to withhold something that is not withheld.
  handle('session:pluginGrants', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    const host = getPluginHost && getPluginHost();
    const status = host ? host.status() : { plugins: [] };
    return {
      ok: true,
      capabilities: [...PLUGIN_CAPABILITIES],
      plugins: (status.plugins || [])
        .filter((p) => p.scope === 'session' && p.enabled && !p.quarantined)
        .map((p) => ({ id: p.id, name: p.name })),
      granted: Array.isArray(entry.pluginGrants) ? [...entry.pluginGrants] : [],
    };
  });

  handle('peer:probe', async (_e, sshHost, port, opts = {}) => {
    if (!sshHost || typeof sshHost !== 'string') return { kind: 'ssh-fail', stderr: 'no ssh host given' };
    let token = typeof opts.token === 'string' && opts.token.trim() ? opts.token.trim() : null;
    if (!token && opts.peerId) {
      const saved = (uiSettings.get().peers || []).find((p) => p && p.id === opts.peerId);
      if (saved && typeof saved.token === 'string' && saved.token) token = saved.token;
    }
    try {
      return await probePeer(sshHost, port || uiSettings.get().remotePort || 7900, { token });
    } catch (e) {
      return { kind: 'ssh-fail', stderr: e && e.message ? e.message : 'probe failed' };
    }
  });

  handle('peer:deploy', async (e, sshHost, opts = {}) => {
    if (!sshHost || typeof sshHost !== 'string') return { ok: false, error: 'no ssh host given' };
    let script;
    try {
      script = fs.readFileSync(path.join(__dirname, 'peering', 'clodex-deploy.sh'), 'utf8');
    } catch (err) {
      return { ok: false, error: `deploy script unreadable: ${err.message}` };
    }
    const port = Number.isInteger(opts.port) ? opts.port : (uiSettings.get().remotePort || 7900);
    const repoUrl = typeof opts.repoUrl === 'string' && opts.repoUrl ? opts.repoUrl : `https://github.com/${UPDATE_REPO}`;
    const branch = typeof opts.branch === 'string' && opts.branch ? opts.branch : 'master';
    // A malformed folder is a hard stop BEFORE we ssh — never trust the renderer
    // for a value that becomes a remote shell word.
    const srcClass = classifyDeployFolder(opts.folder);
    if (!srcClass.ok) return { ok: false, error: srcClass.error };
    const shellEsc = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const srcExport = srcClass.srcExport ? ` ${srcClass.srcExport}` : '';
    const preamble =
      `export PORT=${shellEsc(port)} REPO_URL=${shellEsc(repoUrl)} BRANCH=${shellEsc(branch)}${srcExport}\n`;
    const wc = e.sender;
    // The catch cannot stay bare: it fires per line, so a sender defect drops
    // EVERY line of a 15-minute deploy and reports nothing. Logged once — a
    // per-line log would bury the run it is meant to explain.
    let lineDropLogged = false;
    try {
      const res = await sshRun(sshHost, preamble + script, {
        timeoutMs: 15 * 60 * 1000,       // a cold clone+install+rebuild can be minutes
        onLine: (line) => {
          try { if (!wc.isDestroyed()) wc.send('peer-deploy-line', sshHost, line); }
          catch (err) {
            if (!lineDropLogged) { lineDropLogged = true; log.error('peer', `deploy progress dropped: ${err.message}`); }
          }
        },
      });
      return {
        ok: res.code === 0,
        code: res.timedOut ? null : res.code,
        timedOut: !!res.timedOut,
        needSudo: res.code === 42,
        stderr: (res.stderr || '').trim().split('\n').slice(-20).join('\n'),
      };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'ssh failed to start' };
    }
  });

  // Injection is deferred a beat so the fresh CLI has reached its input prompt
  // before we type.
  handle('peer:deployFix', async (e, sshHost, port, label, logText) => {
    const host = typeof sshHost === 'string' ? sshHost : '';
    const p = Number.isInteger(port) ? port : (uiSettings.get().remotePort || 7900);
    const taken = new Set(manager.sessions.keys());
    for (const s of persistence.list()) taken.add(s.name);
    const name = fixSessionName(label || host || 'peer', taken);
    const wsId = workspaceOfSender(e);
    const dir = os.homedir();
    try {
      const out = await manager.create(
        name, 'claude', dir, [], null, wsId,
        null, false, null, [], [], [], [], [], null, [],
        [], null, null, true,
      );
      const briefing = buildDeployFixBriefing({
        sshHost: host, port: p, label, logText,
        docsDir: path.join(__dirname, 'peering'),
      });
      setTimeout(() => {
        try { manager._deliverMessage(name, 'user', briefing, 'dm'); } catch {}
      }, DEPLOY_FIX_INJECT_DELAY_MS);
      log.info('session', `deploy-fix session ${name} for ${host}`);
      return { ok: true, name: out.name };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'could not create fix session' };
    }
  });

  handle('peer:list', () => {
    const out = getPeerManager() ? getPeerManager().statuses() : [];
    const tunnels = new Map((getTunnelManager() ? getTunnelManager().statuses() : []).map((t) => [t.id, t]));
    const webTuns = new Map(
      ((getWebTunnelManager && getWebTunnelManager()) ? getWebTunnelManager().statuses() : []).map((t) => [t.id, t]),
    );
    for (const st of out) {
      st.tunnel = tunnels.get(st.id) || null;
      st.webTunnel = webTuns.get(st.id) || null;
    }
    return out;
  });
  handle('peer:importPreview', () => {
    const warnings = [];
    const { store, error, file } = peerImport.loadContexts({ warn: (m) => warnings.push(m) });
    if (error) return { ok: false, error, file };
    const peers = uiSettings.get().peers || [];
    // Strip `peer` on the way out — it holds the token. The renderer needs the
    // NAME to send back, nothing else.
    const candidates = peerImport.collectCandidates(store, peers)
      .map(({ peer, ...rest }) => rest);
    return { ok: true, file, warnings, candidates };
  });
  handle('peer:importApply', (_e, names) => {
    const wanted = Array.isArray(names) ? names.filter((n) => typeof n === 'string') : null;
    const { store, error, file } = peerImport.loadContexts();
    if (error) return { ok: false, error, file };
    const before = uiSettings.get().peers || [];
    const candidates = peerImport.collectCandidates(store, before);
    const chosen = candidates.filter((c) => c.action === 'add' && (!wanted || wanted.includes(c.name)));
    if (chosen.length === 0) return { ok: true, imported: [], rejected: [], file };
    const next = peerImport.applyCandidates(before, candidates, { names: wanted });
    const after = uiSettings.set({ peers: next }).peers || [];
    const kept = new Set(after.map((p) => p && p.id));
    const imported = chosen.filter((c) => kept.has(c.peer.id)).map((c) => c.name);
    const rejected = chosen.filter((c) => !kept.has(c.peer.id)).map((c) => c.name);
    if (imported.length) syncPeerManager();
    return { ok: true, imported, rejected, file };
  });

  handle('peer:openWeb', (_e, id) => (openPeerWeb ? openPeerWeb(id) : { ok: false, error: 'unsupported host' }));
  handle('peer:closeWeb', (_e, id) => (closePeerWeb ? closePeerWeb(id) : { ok: true }));
  handle('peer:attach', (_e, id, name) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return { ok: false, error: 'no such peer' };
    const res = conn.attach(name);
    if (res && res.ok) {
      const map = { ...(uiSettings.get().peerAttached || {}) };
      const list = Array.isArray(map[id]) ? map[id] : [];
      if (!list.includes(name)) { map[id] = [...list, name]; uiSettings.set({ peerAttached: map }); }
    }
    return res;
  });
  handle('peer:detach', (_e, id, name) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return { ok: false, error: 'no such peer' };
    const res = conn.detach(name);
    forgetPeerAttached(id, name);
    forgetPeerControlled(id, name);
    return res;
  });
  handle('peer:attachedNames', () => uiSettings.get().peerAttached || {});
  handle('peer:forgetAttached', (_e, id, name) => {
    forgetPeerAttached(id, name);
    return { ok: true };
  });
  // Pause without deleting. This path must NOT call forgetPeerAttached/
  // forgetPeerControlled — the persisted attachments survive re-enable — and the
  // broadcast must precede syncPeerManager so each renderer marks the peer
  // disabled ahead of the peer-removed it triggers (soft shed, not user detach).
  handle('peer:setDisabled', (_e, id, on) => {
    const peers = (uiSettings.get().peers || []).map((p) => ({ ...p }));
    const rec = peers.find((p) => String(p.id) === String(id));
    if (!rec) return { ok: false, error: 'no such peer' };
    if (on) rec.disabled = true; else delete rec.disabled;
    uiSettings.set({ peers });
    manager._broadcast('peer-disabled', String(id), !!on, rec.label || String(id));
    syncPeerManager();
    log.info('peer', `${rec.label || id} ${on ? 'disabled' : 'enabled'}`);
    return { ok: true };
  });
  handle('peer:setRelayAllowed', (_e, id, on) => {
    const peers = (uiSettings.get().peers || []).map((p) => ({ ...p }));
    const rec = peers.find((p) => String(p.id) === String(id));
    if (!rec) return { ok: false, error: 'no such peer' };
    if (on) rec.relayAllowed = true; else delete rec.relayAllowed;
    uiSettings.set({ peers });
    log.info('peer', `${rec.label || id} relay ${on ? 'allowed' : 'disallowed'}`);
    return { ok: true };
  });
  // The peer-terminal grant: ONE box-wide serving setting, taking no peer id.
  // The wire has no cryptographic caller identity, so the serving handler
  // cannot tell which peer is calling (see peer-shell.js) — a per-peer record
  // was storage that never matched the semantics, and it left a serving-only
  // box with nowhere to put the flag.
  //
  // syncRemoteServer is what makes the toggle take effect: it re-derives the
  // wterm callbacks, and dropping them closes open streams first, so turning
  // this off ends shells that are already running. Not bookkeeping — without
  // it a revocation is on paper only until the next restart.
  handle('peer:setShellAllowed', (_e, on) => {
    uiSettings.set({ peerShellEnabled: !!on });
    // Every window, not just the one that toggled: the header chip is the
    // standing statement that the grant is on, and a window that missed the
    // change goes on showing "off" over a box that serves shells — the one
    // direction this indicator must never be wrong in. Carries no payload; the
    // renderer re-reads settings, so there is one derivation of the chip rather
    // than a delta that can drift.
    manager._broadcast('peer-shell-allowed');
    syncRemoteServer();
    log.info('peer', `terminal sharing ${on ? 'ENABLED' : 'revoked'}`);
    return { ok: true };
  });
  handle('peer:visible', () => uiSettings.get().peerVisible || {});
  handle('peer:setVisible', (_e, id, names) => {
    const map = { ...(uiSettings.get().peerVisible || {}) };
    if (names === null || names === undefined) {
      delete map[id];
    } else if (Array.isArray(names)) {
      map[id] = names.filter((n) => typeof n === 'string' && /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(n));
    } else {
      return { ok: false, error: 'names must be an array or null' };
    }
    uiSettings.set({ peerVisible: map });
    return { ok: true, peerVisible: map };
  });
  handle('peer:control', (_e, id, name, on) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.control(name, !!on, (res) => {
      if (res && res.ok) {
        if (on) rememberPeerControlled(id, name); else forgetPeerControlled(id, name);
      }
      resolve(res);
    });
  }));
  handle('peer:controlledNames', () => uiSettings.get().peerControlled || {});
  handle('peer:forgetControlled', (_e, id, name) => {
    forgetPeerControlled(id, name);
    return { ok: true };
  });
  handle('peer:resize', (_e, id, name, cols, rows) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.resize(name, cols, rows, resolve);
  }));
  handle('peer:restart', (_e, id) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.restart(resolve);
  }));
  handle('peer:createSession', (_e, id, spec) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.createSession(spec || {}, resolve);
  }));
  handle('peer:catalogs', (_e, id) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.getCatalogs(resolve);
  }));
  handle('peer:killSession', (_e, id, name) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.killSession(String(name || ''), resolve);
  }));
  handle('peer:restartSession', (_e, id, name, opts) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.restartSession(String(name || ''), opts || {}, resolve);
  }));
  handle('peer:sessionArgs', (_e, id, name) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.sessionArgs(String(name || ''), resolve);
  }));
  handle('peer:setSessionArgs', (_e, id, name, patch) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.setSessionArgs(String(name || ''), patch || {}, resolve);
  }));
  handle('peer:skillCatalog', (_e, id, name) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.skillCatalog(String(name || ''), resolve);
  }));
  handle('peer:setSessionSkills', (_e, id, name, disabledSkills, injectSkills) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.setSessionSkills(String(name || ''), disabledSkills, injectSkills, resolve);
  }));
  handle('peer:query', (_e, id, name, kind, args) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.query(name, String(kind || ''), args, resolve);
  }));
  on('peer:input', (_e, id, name, data) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (conn) conn.input(name, String(data ?? ''), () => {});
  });

  // A terminal tab pointed at a PEER seat's shell. Behind `enableDrawerServices`
  // — NOT the `enableLocalTerminal` flag its local namesake now uses, and
  // that difference is the whole point of the split.
  //
  // The local family was un-gated for the web surface because a web client can
  // already spawn `$SHELL` on this box through `session:create`. That argument
  // stops dead here: no local session channel reaches a THIRD machine, so these
  // four are the one part of the terminal that a web connection genuinely could
  // not otherwise have. The web host's connection is bound to a workspace on
  // THIS box.
  //
  // Gated even though the rest of `peer:*` is not, and the difference is real:
  // every other peer channel drives a session the far side already exposes to
  // attach, while this one opens a SHELL. Covered by
  // test/drawer-services-seam.test.js's prefix list.
  //
  // Unlike the peer channels above, these take the renderer's COMPOSITE session
  // key (`name@peerId`) and split it here with peer-shell's wireSeatFor. One
  // splitter, in one place: an (id, name) pair passed separately can be
  // mismatched by a caller, and the seat that reaches the wire must be the bare
  // name — an `@` arriving at the far side fails its grammar, becomes null, and
  // null is the key of the SEATLESS WORKSPACE SHELL.
  if (enableDrawerServices) {
    const peerSeat = (key) => {
      const w = wireSeatFor(key);
      if (!w) return null;
      const conn = getPeerManager() && getPeerManager().get(w.peerId);
      return conn ? { conn, seat: w.name } : null;
    };
    // The SENDER is load-bearing on open and close, and this is the one place
    // that knows it. `_wterms` is keyed by seat per connection, so without a
    // window recorded here a want has no owner: the renderer that placed it
    // reloads, its `held` dies with it, and the stream and its shell are
    // stranded on the far box with nothing left that could close them. The
    // workspace id is the window: it is 1:1 with a BrowserWindow, and these
    // handlers register only under `enableDrawerServices`, which the web host
    // turns off — so the desktop host is the only registrar.
    //
    // STRICT resolution, and unresolved is a REFUSAL on BOTH doors — the same
    // ruling the local `wterm:*` family makes on the same input, for a reason
    // that is sharper here. The shared helper falls back to the default
    // workspace, and an owner nothing will ever drop is precisely the
    // undroppable want this ticket exists to eliminate: every dropper (the
    // navigation listener, the close handler) passes a REAL workspace id, so a
    // fallback or a sentinel bucket could never be matched by any of them.
    const wtermOwner = (e) => (workspaceOfSenderStrict ? workspaceOfSenderStrict(e) : workspaceOfSender(e));
    handle('peer:wtermOpen', (e, key) => new Promise((resolve) => {
      const t = peerSeat(key);
      if (!t) return resolve({ ok: false, error: 'no such peer session' });
      const owner = wtermOwner(e);
      if (!owner) return resolve({ ok: false, error: 'no workspace for this window' });
      t.conn.wtermOpen(t.seat, owner, resolve);
    }));
    handle('peer:wtermResize', (_e, key, cols, rows) => new Promise((resolve) => {
      const t = peerSeat(key);
      if (!t) return resolve({ ok: false, error: 'no such peer session' });
      t.conn.wtermResize(t.seat, cols, rows, resolve);
    }));
    // The close is refused on the same input as the open, and the symmetry is
    // the point: one rule, at one seam, for a sender that cannot be named.
    // There is no correct thing to do further down with an anonymous close —
    // swallowing it makes the only closing path a no-op, shedding on it takes
    // down a pane another window is still watching. The dying window's wants
    // are shed by main's `closed` hook, which drops by workspace id and knows
    // exactly whose they were, so nothing is leaked by declining here.
    handle('peer:wtermClose', (e, key) => new Promise((resolve) => {
      const t = peerSeat(key);
      if (!t) return resolve({ ok: false, error: 'no such peer session' });
      const owner = wtermOwner(e);
      if (!owner) return resolve({ ok: false, error: 'no workspace for this window' });
      t.conn.wtermClose(t.seat, owner, resolve);
    }));
    // Fire-and-forget, same shape as peer:input and for the same reason: a
    // keystroke that waits for a reply makes typing feel like the network.
    on('peer:wtermInput', (_e, key, data) => {
      const t = peerSeat(key);
      if (t) t.conn.wtermInput(t.seat, String(data ?? ''), () => {});
    });
  }

  handle('defaults:setToolDeny', (_e, list) => {
    agentDefaults.setDefaultDeny(Array.isArray(list) ? list : []);
    return agentDefaults.getDefaultDeny();
  });

  handle('theme:set', (e, name) => { setUiTheme(name, e.sender); });

  handle('wirescope:status', () => wirescope.status());
  handle('wirescope:start', () => wirescope.start());
  handle('wirescope:stop', () => wirescope.stop());
  handle('wirescope:restart', () => wirescope.restart());
  handle('wirescope:pruneInfo', async () => {
    try {
      const r = await ProxyClient.pruneInfo(wirescope.baseUrl());
      if (r.status !== 200 || !r.json || r.json.ok === false) {
        return { ok: false, error: (r.json && r.json.error) || `proxy returned ${r.status}` };
      }
      return { ok: true, data: r.json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  handle('wirescope:prune', async (_e, opts) => {
    const o = opts || {};
    if (!o.olderThan) return { ok: false, error: 'older_than required' };
    try {
      const r = await ProxyClient.prune(wirescope.baseUrl(), o);
      if (r.status !== 200 || !r.json) {
        return { ok: false, error: (r.json && r.json.error) || `proxy returned ${r.status}` };
      }
      return { ok: true, data: r.json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  const withBox = (boxId, fn) => {
    const s = getSandbox(boxId);
    if (!s) return { ok: false, error: `no such sandbox: ${boxId}` };
    return fn(s);
  };
  // Docker detection is docker-WIDE, not box-scoped: it must NOT go through
  // withBox. Deleting the last sandbox leaves no box to resolve against, and the
  // dialog mis-renders "no such sandbox" as "Docker isn't installed".
  handle('sandbox:detect', () => {
    const mgr = getSandboxManager();
    if (!mgr) return { ok: false, error: 'sandbox manager unavailable' };
    return mgr.detect();
  });
  handle('sandbox:status', (_e, boxId) => withBox(boxId, (s) => s.status()));
  handle('sandbox:getConfig', (_e, boxId) => withBox(boxId, (s) => s.getConfig()));
  handle('sandbox:setConfig', (_e, partial, boxId) => withBox(boxId, (s) => s.setConfig(partial || {})));
  handle('sandbox:translatePath', (_e, hostPath, boxId) => withBox(boxId, (s) => s.translateHostPath(hostPath)));
  handle('sandbox:up', (_e, boxId) => withBox(boxId, (s) => s.up()));
  handle('sandbox:rebuild', (_e, boxId) => withBox(boxId, (s) => s.rebuild()));
  handle('sandbox:down', (_e, boxId) => withBox(boxId, (s) => s.down()));
  handle('sandbox:logsTail', (_e, n, boxId) => withBox(boxId, (s) => s.logsTail(n)));
  // Auth token (M4): write-only paste + clear. The token value crosses IN here
  // but NEVER back out — setToken/clearToken return a boolean hasToken flag only.
  handle('sandbox:setToken', (_e, token, boxId) => withBox(boxId, (s) => s.setAuthToken(token)));
  handle('sandbox:clearToken', (_e, boxId) => withBox(boxId, (s) => s.clearAuthToken()));
  handle('sandbox:listBoxes', () => (getSandboxManager() ? getSandboxManager().list() : []));
  handle('sandbox:createBox', (_e, id, label) => {
    const mgr = getSandboxManager();
    if (!mgr) return { ok: false, error: 'sandbox manager unavailable' };
    return mgr.create(id, label);
  });
  handle('sandbox:deleteBox', (_e, id) => {
    const mgr = getSandboxManager();
    if (!mgr) return { ok: false, error: 'sandbox manager unavailable' };
    return mgr.remove(id);
  });

  handle('session:exportMarkdown', async (_e, name) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    if (!s.agentType) return { ok: false, error: 'Export only works for agent sessions' };

    const linkPath = pathFor(REGISTRY_DIR, name, 'transcript');
    let jsonlPath;
    try {
      jsonlPath = fs.realpathSync(linkPath);
    } catch {
      return { ok: false, error: 'No transcript found yet — wait until the agent has responded at least once.' };
    }

    const defaultPath = path.join(
      getDesktopPath(),
      `${name}-${new Date().toISOString().slice(0, 10)}.md`,
    );
    const result = await showSaveDialog({
      defaultPath,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' };

    try {
      const md = jsonlToMarkdown(jsonlPath, s.agentType, name);
      fs.writeFileSync(result.filePath, md);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  on('session:context-menu', (e, { name, cwd }) => {
    const entry = persistence.get(name) || {};
    const isAgent = entry.type === 'claude' || entry.type === 'codex';
    const sysPrompts = promptLibrary.list('system');
    const appendPrompts = promptLibrary.list('append');
    const curSys = entry.systemPromptFile || null;
    const curAppend = entry.appendPromptFiles || [];
    const notifyPromptsChanged = () =>
      e.sender.send('session:context-action', { action: 'promptsChanged', name });
    const promptsSubmenu = [
      { label: 'System prompt', enabled: false },
      {
        label: '(CLI default)', type: 'radio', checked: !curSys,
        click: () => { persistence.setPromptRefs(name, null, curAppend); notifyPromptsChanged(); },
      },
      ...sysPrompts.map(p => ({
        label: p.name, type: 'radio', checked: curSys === p.name,
        click: () => { persistence.setPromptRefs(name, p.name, curAppend); notifyPromptsChanged(); },
      })),
      { type: 'separator' },
      { label: 'Append prompts', enabled: false },
      ...(appendPrompts.length ? appendPrompts.map(p => ({
        label: p.name, type: 'checkbox', checked: curAppend.includes(p.name),
        click: () => {
          const next = curAppend.includes(p.name)
            ? curAppend.filter(x => x !== p.name) : [...curAppend, p.name];
          persistence.setPromptRefs(name, curSys, next);
          notifyPromptsChanged();
        },
      })) : [{ label: '(no append prompts in library)', enabled: false }]),
    ];
    popupMenu([
      {
        label: 'Rename…',
        click: () => e.sender.send('session:context-action', { action: 'rename', name }),
      },
      {
        label: 'Edit Session…',
        click: () => e.sender.send('session:context-action', { action: 'editArgs', name }),
      },
      ...(isAgent ? [{ label: 'Prompts', submenu: promptsSubmenu }] : []),
      {
        label: 'Restart Session',
        click: () => e.sender.send('session:context-action', { action: 'restart', name }),
      },
      { type: 'separator' },
      {
        label: 'Reveal Working Directory in Finder',
        enabled: !!cwd,
        click: () => { if (cwd) showItemInFolder(cwd); },
      },
      {
        label: 'Open in Terminal',
        enabled: !!cwd,
        click: () => {
          if (!cwd) return;
          // execFile, never exec: `cwd` is agent-supplied ([agent:spawn cwd:Y]
          // stores it verbatim) and exec routes through /bin/sh, where double
          // quotes do NOT suppress $(...). Passing argv keeps it one word with
          // no shell in the path at all. Same rule as `shellEsc` above.
          const { execFile } = require('child_process');
          execFile('open', ['-a', 'Terminal', cwd]);
        },
      },
      { type: 'separator' },
      {
        label: 'Export Conversation as Markdown…',
        click: () => e.sender.send('session:context-action', { action: 'export', name }),
      },
      ...(isAgent ? [{
        label: 'Export as Template…',
        click: () => e.sender.send('session:context-action', { action: 'exportTemplate', name }),
      }] : []),
      { type: 'separator' },
      {
        label: 'Delete Session…',
        click: () => e.sender.send('session:context-action', { action: 'kill', name }),
      },
    ], e);
  });

  on('peer:context-menu', (e, st) => {
    const { id, name, online, attached, controlled, holder, canCreate, canArgs, hostLabel, type } = st || {};
    const act = (action) => () => e.sender.send('peer:context-action', { action, id, name });
    const template = [];
    if (holder && !controlled) {
      template.push({ label: `Controlled by ${holder}`, enabled: false });
      template.push({ type: 'separator' });
    }
    if (!attached) {
      template.push({ label: 'Attach', click: act('attach') });
      template.push({ label: 'Take Control', enabled: !!online, click: act('takeControl') });
    } else if (controlled) {
      template.push({ label: 'Release Control', click: act('releaseControl') });
      template.push({ label: 'Detach (keep listed)', click: act('detach') });
    } else {
      template.push({ label: 'Take Control', enabled: !!online, click: act('takeControl') });
      template.push({ label: 'Detach (keep listed)', click: act('detach') });
    }
    template.push({ type: 'separator' });
    template.push({ label: 'Hide from List', click: act('hide') });
    if (canArgs) {
      template.push({ type: 'separator' });
      template.push({
        label: `Edit Session "${name}" on ${hostLabel || 'peer'}…`,
        enabled: !!online,
        click: act('editArgs'),
      });
      if (type === 'claude') {
        template.push({
          label: `Edit Skills "${name}" on ${hostLabel || 'peer'}…`,
          enabled: !!online,
          click: act('editSkills'),
        });
      }
    }
    if (canCreate) {
      template.push({ type: 'separator' });
      template.push({
        label: `Restart "${name}" on ${hostLabel || 'peer'}`,
        enabled: !!online,
        click: act('restartRemote'),
      });
      if (type !== 'bash') {
        template.push({
          label: `Reload "${name}" on ${hostLabel || 'peer'} (fresh)…`,
          enabled: !!online,
          click: act('reloadRemote'),
        });
      }
      template.push({ type: 'separator' });
      template.push({
        label: `Kill "${name}" on ${hostLabel || 'peer'}…`,
        enabled: !!online,
        click: act('killRemote'),
      });
    }
    popupMenu(template, e);
  });

  function deployTargetFor(id) {
    const cfg = (uiSettings.get().peers || []).find((p) => p && p.id === id);
    if (!cfg || !cfg.sshHost) return null;
    const st = getPeerManager() ? getPeerManager().statuses().find((s) => s.id === id) : null;
    const reported = st && st.online ? st.srcDir : null;
    return {
      sshHost: cfg.sshHost,
      port: Number.isInteger(cfg.remotePort) ? cfg.remotePort : 7900,
      folder: resolveDeployFolder(reported, cfg.deployFolder),
    };
  }
  handle('peer:deployConfig', (_e, id) => deployTargetFor(id));

  on('peer:header-menu', (e, st) => {
    const { id, label, online, canCreate, sev, isBox } = st || {};
    const template = [];
    if (canCreate) {
      template.push({
        label: `New Session on ${label || 'peer'}…`,
        enabled: !!online,
        click: () => e.sender.send('peer:context-action', { action: 'newSession', id, name: label }),
      });
      template.push({ type: 'separator' });
    }
    template.push({
      label: `Restart Clodex on ${label || 'peer'}…`,
      enabled: !!online,
      click: () => e.sender.send('peer:context-action', { action: 'restart', id, name: label }),
    });
    if (isBox) {
      template.push({
        label: `Rebuild ${label || 'sandbox'}`,
        enabled: !!online,
        click: () => e.sender.send('peer:context-action', { action: 'rebuild', id, name: label }),
      });
    }
    const target = (online && updateApplies(sev)) ? deployTargetFor(id) : null;
    if (target) {
      template.push({ type: 'separator' });
      template.push({
        label: `Update Clodex on ${label || 'peer'}…`,
        click: () => e.sender.send('peer:context-action', {
          action: 'update', id, name: label,
          sshHost: target.sshHost,
          port: target.port,
          folder: target.folder,
        }),
      });
    }
    // Enabled offline as well as online. The only other way to pause a peer is
    // the ⓘ popover, whose button renders solely when `online && version` — so
    // an offline or version-less peer had no pause at all before this item.
    template.push({ type: 'separator' });
    template.push({
      label: `Pause ${label || 'peer'}`,
      click: () => e.sender.send('peer:context-action', { action: 'pause', id, name: label }),
    });
    popupMenu(template, e);
  });

  handle('dialog:confirmPeerRestart', async (_e, label) => {
    const result = await showMessageBox({
      type: 'question',
      buttons: ['Restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Restart Clodex on ${label || 'this peer'}?`,
      detail: 'The remote app will quit and reopen. Its sessions will resume after the restart.',
    });
    return result.response === 0;
  });

  handle('dialog:confirmPeerUpdate', async (_e, label) => {
    const result = await showMessageBox({
      type: 'question',
      buttons: ['Update', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Update Clodex on ${label || 'this peer'}?`,
      detail: 'Re-runs the deploy script over ssh (git pull → build → restart). Safe and idempotent; it can take a few minutes. The peer restarts on success and its sessions resume.',
    });
    return result.response === 0;
  });

  handle('dialog:confirmDeployFix', async (_e, sshHost) => {
    const result = await showMessageBox({
      type: 'question',
      buttons: ['Open Agent Session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Open an agent session to fix this?',
      detail: `Creates a local Claude session briefed with the deploy log and the playbook for ${sshHost || 'the peer'}, so it can ssh in and finish the install.`,
    });
    return result.response === 0;
  });

  handle('dialog:confirmPeerKill', async (_e, name, label) => {
    const result = await showMessageBox({
      type: 'warning',
      buttons: ['Kill', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Kill session "${name}" on ${label || 'the peer'}?`,
      detail: 'This ends the agent process on the remote machine and removes it — it will not resume.',
    });
    return result.response === 0;
  });

  handle('dialog:confirmPeerReload', async (_e, name, label) => {
    const result = await showMessageBox({
      type: 'question',
      buttons: ['Reload', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Reload "${name}" on ${label || 'the peer'} with a fresh conversation?`,
      detail: 'Starts a new conversation so the CLI reloads tools, skills, and settings from disk '
        + '(a plain restart keeps the old roster). The current conversation isn\'t lost — it stays '
        + 'available under 🕘 history on the remote machine.',
    });
    return result.response === 0;
  });

  handle('dialog:confirmKill', async (_e, name) => {
    const entry = persistence.get(name);
    const displayName = (entry && entry.label) || name;
    const worktree = entry && entry.worktree && entry.worktree.path ? entry.worktree : null;
    const detail = 'This forgets the session entirely — its conversation can\'t be resumed. '
      + 'To keep it, archive it instead (the ✕ button or ⌘W).'
      + (worktree ? `\n\nThis session runs in a git worktree (branch "${worktree.branch}" at ${worktree.path}); deleting also runs \`git worktree remove --force\`.` : '');
    const result = await showMessageBox({
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete session "${displayName}"?`,
      detail,
    });
    return result.response === 0;
  });

  on('pty-input', (_e, name, data) => {
    manager.write(name, data);
  });

  // The renderer knows a submit is voice-originated (it watched the composition
  // or the recorder); the proxy base and route live here. Carries no text — the
  // marker's wording is decided in voice-origin-arm.js, so a doctored payload
  // cannot choose what the agent is told.
  on('voice:markOrigin', (_e, name) => {
    manager.markVoiceOrigin(String(name || ''));
  });

  // The recorder is lit on this seat, resent while it stays lit. Carries no
  // timestamp: main stamps its own clock, so a renderer cannot hold a seat's
  // injection open by reporting a future time.
  on('voice:recording', (_e, name) => {
    manager.noteVoiceRecording(String(name || ''));
  });

  // A dictated draft is sitting unsent in this seat's composer, resent while it
  // sits. Same shape and same reason as the recorder report above: no timestamp
  // crosses, main stamps its own clock, and main expires it.
  on('voice:draft', (_e, name) => {
    manager.noteVoiceDraft(String(name || ''));
  });

  // The operator switched seats, or focused this window. Main keeps the last
  // report as "the seat he is looking at" — an external voice tap that names no
  // target lands here.
  //
  // Null clears it, and clearing has to be possible: a window that closed with
  // its last seat archived leaves nothing focused, and a stale name would send
  // the next tap at a seat he is not watching.
  on('session:focused', (_e, name) => {
    manager.noteFocusedSession(name == null ? null : String(name));
  });

  // What a window that opened or reloaded mid-dictation missed. Read-only: the
  // target moves on a focus report or an external tap, never on being asked.
  handle('voice:micTarget', () => manager.micTarget());

  // The same catch-up read for the frontmost-app condition. Read-only: the flag
  // moves on the host's focus/blur events, never on being asked.
  handle('voice:appFocused', () => manager.appFocused());

  handle('app:restore-sessions', (e) => restoreSessionsForWorkspace(workspaceOfSender(e)));

  handle('session:retrySpawn', async (e, name) => {
    const workspaceId = workspaceOfSender(e);
    const entry = persistence.list().find(s => s.name === name);
    if (!entry) return { ok: false, error: 'No saved entry found' };
    try {
      await manager.create(
        entry.name,
        entry.type,
        entry.cwd,
        entry.extraArgs || [],
        entry.sessionId,
        workspaceId,
        entry.systemPrompt || null,
        false,
        entry.proxy ?? null,
        entry.agents || [],
        entry.denyBuiltins || [],
        entry.disabledTools || [],
        entry.disabledSkills || [],
        entry.injectSkills || [],
        entry.systemPromptFile || null,
        entry.appendPromptFiles || [],
        Array.isArray(entry.execCommands) ? entry.execCommands : [],
        Array.isArray(entry.intents) ? entry.intents : null,
        (entry.env && typeof entry.env === 'object') ? entry.env : null,
        false,             // mint — retry re-spawns an existing record
        entry.noWire === true,
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('session:forget', (e, name) => {
    manager.clearHintForRecord(name);
    persistence.remove(name);
    // The seat's workbench shell has no record to resume from, so it dies with
    // the seat. Nothing else reaps it: window close is the wrong event, and a
    // long-lived workspace would otherwise accumulate one orphaned shell per
    // deleted seat, unreachable from any UI.
    try {
      const w = getDrawerPtys();
      const ws = workspaceOfSenderStrict ? workspaceOfSenderStrict(e) : workspaceOfSender(e);
      if (w && ws && w.killSeat) w.killSeat(ws, String(name || ''));
    } catch {}
    return true;
  });

  handle('workspace:list', () => workspaces.list());
  handle('workspace:current', (e) => workspaceOfSender(e));
  handle('workspace:getView', (e) => {
    const w = workspaces.get(workspaceOfSender(e));
    return { ok: true, view: (w && w.view) || null };
  });
  handle('workspace:setView', (e, view) => {
    workspaces.setView(workspaceOfSender(e), view || {});
    return { ok: true };
  });
  handle('workspace:setName', (e, name) => {
    const id = workspaceOfSender(e);
    const prev = workspaces.get(id);
    const oldName = prev && prev.name;
    const newName = name || 'Workspace';
    workspaces.setName(id, newName);
    // Keep `workspace:`-scoped skills/agents pointing at the renamed workspace
    // (they key off the DISPLAY name) — rewrite them in the same motion so they
    // don't orphan. Exact-match on the old name; count logged.
    if (oldName && oldName !== newName) {
      const n = renameWorkspaceScope(oldName, newName);
      if (n) log.info('workspace', `rescoped ${n} library file(s): "${oldName}" → "${newName}"`);
    }
    refreshTrayMenu();
    refreshAppMenu();
    return true;
  });
  // The drawer's service-backed tenants. GATED AT REGISTRATION, and the `if` is
  // the whole boundary: web-host.js runs this same registrar and its invoke
  // frame dispatches any registered channel BY NAME without consulting
  // api-contract, so a `ctl:run` that exists at all is a token-backed verb
  // runner for any authenticated web connection. A renderer-side `available()`
  // is chosen by the client and protects nothing. Do not convert this into a
  // handler that checks the flag in its body.
  //
  // The LOCAL drawer terminal is no longer in this block — it has its own
  // flag below. The two are separate because their arguments are separate, and
  // merging them again would re-gate a shell the same host already hands out.
  //
  // Pinned by test/drawer-services-seam.test.js (asserts `ctl:`/`drawer:` are
  // ABSENT from the web-host handler map — absent, not present-and-guarded).
  if (enableDrawerServices) {
    handle('ctl:run', async (_e, line) => {
      const svc = getCtlService();
      if (!svc) return { command: String(line || ''), output: 'clodexctl: the ctl service is unavailable on this host\n', exitCode: 2, ctx: null, ts: Date.now() };
      return await svc.run(line);
    });
    handle('ctl:context', () => {
      const svc = getCtlService();
      return svc ? svc.context() : null;
    });
    // The tab's cheat sheet. Read-only, derived from the allowlist and the CLI's
    // help registry — no context, no wire, no token — but it stays inside this
    // gate with the rest of the family: a channel the web host does not register
    // cannot be probed to enumerate what the desktop's runner would accept.
    handle('ctl:help', () => {
      const svc = getCtlService();
      return svc ? svc.helpIndex() : null;
    });
    // The drawer selection as a tail hint on the named session's route. Inside
    // this gate for the sharpest reason of the three: every other channel here
    // runs something on the host, while this one writes caller-supplied text
    // into an agent's next request — an ungated registration is a prompt
    // injection channel for any authenticated web connection.
    //
    // The tier comes from the payload because the two gestures are genuinely
    // different (a drag vs a click) and the renderer is the only thing that can
    // tell them apart; everything ELSE about how a tier behaves — its id, TTL,
    // framing and cap — is decided in selection-hint.js, so a doctored payload
    // can choose which of two vetted shapes it gets and nothing more.
    handle('drawer:armSelection', async (_e, name, payload) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      return await manager.armSelection(String(name || ''), {
        // Bounded HERE and not only by the composer's cap: the composer clamps
        // what goes on the wire, which leaves an unbounded string crossing the
        // transport and getting scrubbed token-by-token first. The slice is
        // generously above the 8000-char attach cap so it can only ever cut
        // something the composer was going to cut anyway.
        text: typeof p.text === 'string' ? p.text.slice(0, 64 * 1024) : '',
        tab: typeof p.tab === 'string' ? p.tab : '',
        attach: p.attach === true,
      });
    });
    // Read-only, and inside this gate with the other two for the same reason:
    // it reports the operator's own screen text back, which is exactly what a
    // web-host connection must not be able to ask for.
    handle('drawer:inspectSelection', async (_e, name) => (
      await manager.inspectSelection(String(name || ''))
    ));
    handle('drawer:releaseSelection', async (_e, name) => await manager.releaseSelection(String(name || '')));
  }

  // The LOCAL drawer terminal, on its own flag rather than the drawer-service
  // gate above, because the argument that gates the others does not reach it. A
  // `wterm:spawn` on this box is `$SHELL` on this box — and any surface that can
  // reach `session:create` (ungated, no drawer flag) can already spawn a
  // `type: 'bash'` session, which is the same shell, same machine, same user,
  // over the ordinary session channels. Gating this one while that door stands
  // open bought no security, only a missing tab.
  //
  // What that argument does NOT cover, and why the split is two flags rather
  // than deleting the gate:
  //   `ctl:*` / `drawer:*` above — a verb runner and a read of the operator's
  //       own screen text, neither of which `session:create` grants.
  //   `peer:wterm*` below — a shell on a THIRD machine, which no local session
  //       channel can reach at all.
  // Both keep `enableDrawerServices`. A host that wants a local terminal is
  // saying something narrower than a host that wants the drawer's services.
  if (enableLocalTerminal) {
    // STRICT resolution, unlike every other handler here: the shared helper
    // falls back to the default workspace when the sender's window is gone, so
    // an in-flight keystroke from a closing window would land in a DIFFERENT
    // workspace's shell. Unresolved is a refusal, not a default.
    const wtermWorkspace = (e) => (workspaceOfSenderStrict ? workspaceOfSenderStrict(e) : workspaceOfSender(e));
    // The SEAT comes from the payload, unlike the workspace — and that asymmetry
    // is deliberate. The workspace is a security boundary (a caller-supplied one
    // would let a connection write into another workspace's shell), so it is
    // taken from the sender. A seat is a scoping key WITHIN the window the
    // sender already owns: the worst a forged one can do is open a shell in a
    // sibling seat's cwd, which that connection can already do by switching to
    // it. Validated for shape only, so a junk value cannot alias a real seat's
    // shell or escape the key grammar. The dot-only guard is t115's grammar,
    // not decoration: `.` and `..` are spelled entirely in this charset, and
    // this value is resolved against the session map to choose a shell's cwd.
    const seatOf = (v) => {
      const t = typeof v === 'string' ? v : '';
      return /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(t) ? t : null;
    };
    handle('wterm:spawn', (e, opts) => {
      const w = getDrawerPtys();
      if (!w) return { ok: false, error: 'drawer terminals are unavailable on this host' };
      const ws = wtermWorkspace(e);
      if (!ws) return { ok: false, error: 'no workspace for this window' };
      return w.spawn(ws, seatOf(opts && opts.seat), opts || {});
    });
    handle('wterm:write', (e, seat, data) => {
      const w = getDrawerPtys();
      const ws = wtermWorkspace(e);
      return w && ws ? w.write(ws, seatOf(seat), data) : false;
    });
    handle('wterm:resize', (e, seat, cols, rows) => {
      const w = getDrawerPtys();
      const ws = wtermWorkspace(e);
      return w && ws ? w.resize(ws, seatOf(seat), cols, rows) : false;
    });
  }

  handle('workspace:new', () => {
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Persist the record HERE, not only inside createWindow: the web host stubs
    // createWindow, so without this upsert a browser New Workspace jumps to an id
    // that never reaches workspaces.json. Desktop's own upsert then no-ops.
    workspaces.upsert({ id, name: 'New Workspace', bounds: null });
    createWindow(id);
    refreshAppMenu();
    refreshTrayMenu();
    return id;
  });
}

module.exports = { registerIpcHandlers };
