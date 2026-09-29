// Must not require electron: every native touch rides an injected seam, so web-host registers the same channels.
// Open in Terminal is the one execFile made here.

const { pathFor, fixDirFor, seatDirFor } = require('./clodex-paths');
const { nameConflict } = require('./session-manager');
const { stampServedAge } = require('./proxy-util');
// Required directly, not injected: a second draft predicate would drift from the one the
// inject queue gates deliveries on.
const { isDraftOpen } = require('./proxy-util');
const { STOCK_ROLE_DEFS, RESERVED_ROLE_KEYS, defaultLeadSeat } = require('./team-manifest');
const { REVIEWER_PROMPT_PREFIX } = require('./team-tickets');
const { resolveAccountLabel } = require('./accounts');
const { teamPreflight } = require('./team-preflight');
const {
  teamPromptFile, readTeamJson, teamTemplateSave, teamTemplateRemove,
  teamPromptSave, teamPromptRemove,
} = require('./team-prompt-dir');
const { appendRailPrompts } = require('./prompt-rails');
const { validateExecDef } = require('./exec-schema');
const { validateSeatImages } = require('./seat-images');
const { BOX_ID_RE, runningInSandboxBox } = require('./sandbox');
const { SETUP_CHOICES } = require('./stores');
const sessionDiscovery = require('./session-discovery');
const gitWorktree = require('./git-worktree');
const { NO_SUCH_METHOD, errorEnvelope, sanitizeGrants, isValidPluginId, PLUGIN_CAPABILITIES, seatHasPlugin } = require('./plugin-api');
const { catalogRows, allowlistFromChecked, pruneForPlugins, rows: intentRows } = require('./intent-registry');
const { feedSince } = require('./subagent-ring');
// Main-side on purpose: an imported token must never round-trip through the renderer.
const peerImport = require('./peer-import');
const { wireSeatFor } = require('./peer-shell');
const { readBashConsole, RECORD_NAME_RE } = require('./bash-console');
const { createTranscriptSpikeReader } = require('./transcript-spike');
const { mergeCompactNotices } = require('./compact-notices');
const { isAgentType } = require('./cli-adapters');
const { findCodexRollout, codexRolloutsForCwd } = require('./seat-config');
// Read from the module that decides with them, not restated: a second copy would show
// Preferences a number the reminder does not use.
const {
  CTX_MODEL_THRESHOLDS, CTX_REMINDER_NUDGE_TOKENS, CTX_REMINDER_ESCALATE_TOKENS,
} = require('./ctx-reminder');
const { REMOTE_PORT_ENV, coercePort } = require('./service-ports');
const { REMOTE_BASE_PATH_ENV, coerceRemoteBasePath } = require('./remote');

const ENV_LOCKED_SETTINGS = [
  ['remotePort', REMOTE_PORT_ENV, coercePort],
  ['remoteBasePath', REMOTE_BASE_PATH_ENV, coerceRemoteBasePath],
];

function envLockedSettings(env = process.env) {
  const out = {};
  for (const [key, name, coerce] of ENV_LOCKED_SETTINGS) {
    if (coerce(env ? env[name] : null) != null) out[key] = name;
  }
  return out;
}

function recentCwdsFor(settings, wsId) {
  const byWs = settings.recentCwdsByWorkspace || {};
  if (Array.isArray(byWs[wsId])) return byWs[wsId];
  if (wsId === 'default' && Array.isArray(settings.recentCwds)) return settings.recentCwds;
  return [];
}

function registerIpcHandlers(deps) {
  const {
    handle, on,
    popupMenu, showMessageBox, showSaveDialog, showOpenDialog,
    openExternal, openPath, showItemInFolder, getAppVersion, getDesktopPath,
    CLAUDE_SL_COMPONENTS, CLAUDE_TOOLS, CODEX_SL_COMPONENTS,
    DEPLOY_FIX_INJECT_DELAY_MS, ProxyClient, REGISTRY_DIR,
    UPDATE_REPO, buildDeployFixBriefing, checkForUpdate, classifyDeployFolder,
    claudeProjectDir, collectSystemDiagnostics, createWindow, diagSummary,
    checkTools, invalidateToolCache, diagWarning, fetchFileDiff, fetchFilePeek, writeFilePeek, resolveFilePath, fetchProxyBust,
    fetchProxyContext, fetchProxyReport, fetchSessionFiles, fixSessionName,
    forgetPeerAttached, forgetPeerControlled, fs, https,
    jsonlToMarkdown, log, manager,
    openWirescopeWindow, os,
    path, persistence, probePeer, proxyPoller,
    pty, readEffectiveToolState, readVoiceTrigger, readVoiceCapability, readSessionMeta,
    rebuildAllStatusScripts, refreshAppMenu, refreshTrayMenu, rememberPeerControlled,
    createTeam, addRole, resolveTeam, listTeams, loadManifest,
    setRole, removeRole, renameRole, setTeamWatchdog, setLead, setTeamTrunk, gatherTeam, teamsDir,
    teamDeleteCheck, teamDeleteGated,
    resolveDeployFolder, restartSession, restoreSessionsForWorkspace,
    readSessionArgs, applySessionArgs, sessionMeta, sessionInfo,
    readSkillCatalog, applySessionSkills, setUiTheme, sshRun,
    stripLevelOf, syncPeerManager, syncRemoteServer, updateApplies,
    setRemoteToken, hasRemoteToken, refreshRemoteToken, listSpeakVoices,
    wirescope, workspaceOfSender,
    sessionScopeCtx, renameWorkspaceScope,
    templates, workspaces, promptLibrary, agentDefaults,
    agentLibrary, skillLibrary, execLibrary, notifications, uiSettings, envScopes, envDefaults, setupMarker,
    getRemoteServer, getRemoteError, getPeerManager, getTunnelManager,
    getUpdateInfo, getReleasesCache,
    getWebTunnelManager, openPeerWeb, closePeerWeb,
    getSandbox, getSandboxManager,
    enableDrawerServices, enableCtl, enableLocalTerminal, enableConsole, enableAccounts, getCtlService, getBashLive, getDrawerPtys, workspaceOfSenderStrict,
    accounts, moveAccountByModel,
    syncTerminalReports,
    getPluginHost, getPluginLoader, listAllTemplates, listAllPrompts, surfaceOfSender,
    getHelpCorpus, SELF_LABEL,
  } = deps;

  function refreshMenusAfterWrite(channel, ...refreshers) {
    try { for (const fn of refreshers) fn(); }
    catch (err) { log?.error?.('menu', `${channel}: menu rebuild after a landed write failed: ${err.message}`); }
  }

  async function spawnFromParams(e, p) {
    const workspaceId = workspaceOfSender(e);
    const conflict = nameConflict({
      liveHas: manager.sessions.has(p.name),
      persistedHas: !!persistence.get(p.name),
    });
    if (conflict === 'live') throw new Error(`Session "${p.name}" already exists`);
    if (conflict === 'persisted') {
      throw new Error(`A session named "${p.name}" is archived or saved — unarchive it or pick another name.`);
    }
    const seedTools = (p.disabledTools === undefined) ? agentDefaults.getDefaultDeny() : p.disabledTools;
    const seedSkills = (p.disabledSkills === undefined) ? agentDefaults.getDefaultSkillDeny() : p.disabledSkills;
    const seedBuiltins = (p.denyBuiltins === undefined) ? agentDefaults.getDefaultBuiltinDeny() : p.denyBuiltins;
    const session = await manager.create(p.name, p.type, p.cwd, p.extraArgs, p.resumeId || null, workspaceId, p.systemPromptBody || null, !!p.fork, p.proxy ?? null, p.agents || [], seedBuiltins || [], seedTools || [], seedSkills || [], p.injectSkills || [], p.systemPromptFile || null, p.appendPromptFiles || [], Array.isArray(p.execCommands) ? p.execCommands : [], Array.isArray(p.intents) ? p.intents : null, (p.env && typeof p.env === 'object') ? p.env : null, true, p.noWire === true, Array.isArray(p.plugins) ? p.plugins : null, null, null, p.io === 'stream' ? 'stream' : 'pty', (typeof p.effort === 'string' && p.effort.trim()) ? p.effort.trim() : null);
    const seedStrip = (p.stripLevel === undefined || p.stripLevel === null) ? agentDefaults.getStrip(p.name) : p.stripLevel;
    if (seedStrip === 1 || seedStrip === 2) persistence.setStripLevel(p.name, seedStrip);
    return { ok: true, session };
  }

  handle('session:create', async (e, name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents, env, noWire, plugins, io, effort) => {
    try {
      return await spawnFromParams(e, { name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles, execCommands, intents, env, noWire, plugins, io, effort });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('team:create', async (e, spec) => {
    const { teamName, ...p } = spec || {};
    let written = false;
    let res;
    try {
      createTeam({ name: teamName, root: p.cwd, lead: p.name, kit: p.kit });
      written = true;
      res = await spawnFromParams(e, p);
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (written) refreshAppMenu();
    return res;
  });

  async function createBareTeamBox(team, mgr, boxId, lines) {
    let box = mgr.get(boxId);
    if (!box) {
      const made = mgr.create(boxId, `${team.name} team`);
      if (made && made.ok === false) return { ok: false, team, webUrl: null, lines, error: made.error };
      box = mgr.get(boxId);
      if (!box) return { ok: false, team, webUrl: null, lines, error: `sandbox ${boxId} could not be created` };
    }
    const r = await manager._bringUpTeamBox(team, {
      mgr, box, boxId, patch: { workDir: team.root }, action: 'up', reply: (l) => lines.push(l),
    });
    if (!r || !r.ok) {
      return { ok: false, team, webUrl: null, lines, error: lines[lines.length - 1] || `sandbox ${boxId} could not be brought up` };
    }
    return { ok: true, team, webUrl: r.webUrl || null, lines };
  }

  // `root` is forwarded verbatim so createTeam's absolute-path refusal is the single gate;
  // resolving it here would accept a relative root against the main process cwd.
  handle('team:createBare', (_e, spec) => {
    const { name, root, lead, kit, sandboxed } = spec || {};
    const mgr = sandboxed ? getSandboxManager() : null;
    if (sandboxed && !mgr) return { ok: false, error: 'sandboxes are disabled on this host' };
    const boxId = `team-${name}`;
    if (sandboxed && !BOX_ID_RE.test(boxId)) {
      return {
        ok: false,
        error: `a sandboxed team needs a name that fits a box id: ${boxId} must match ${BOX_ID_RE} — rename the team`,
      };
    }
    let team;
    try {
      team = createTeam({ name, root, lead: defaultLeadSeat(name, lead), kit, sandboxed: !!sandboxed });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    refreshAppMenu();
    if (!sandboxed) return { ok: true, team };
    const lines = [];
    return createBareTeamBox(team, mgr, boxId, lines)
      .catch((err) => ({ ok: false, team, webUrl: null, lines, error: lines[lines.length - 1] || err.message }));
  });

  handle('team:join', async (e, spec) => {
    try {
      const { team, role, prompt, ...p } = spec || {};
      let exists = false;
      try { exists = !!loadManifest(team).roles[role]; } catch { exists = false; }
      if (!exists) {
        const def = role === 'hand'
          ? { ...STOCK_ROLE_DEFS.hand }
          : { prompt: prompt || null };
        addRole(team, role, def);
      }
      const dispatch = (loadManifest(team).roles[role] || {}).dispatch;
      if ((dispatch === 'spawn' || dispatch === 'worktree') && !RESERVED_ROLE_KEYS.has(role)) {
        return { ok: false, error: `team ${team}: the ${role} role runs per ticket (dispatch: ${dispatch}) — the ticket loop mints a seat for each ticket, so a standing seat would never receive one; no session was created. Dispatch work with [agent:task add ${role}] from the lead, or set the role's dispatch to standing in the Roles popover to hold a live seat.` };
      }
      return await spawnFromParams(e, p);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  const accountPatchError = (def) => {
    if (!def || typeof def !== 'object' || !('account' in def)) return null;
    const res = resolveAccountLabel(accounts, def.account);
    return res.ok ? null : res.error;
  };

  const fmtPatch = (patch) => Object.entries(patch && typeof patch === 'object' ? patch : {}).map(([k, v]) => {
    let s = typeof v === 'string' ? v.trim() : (v === null ? 'none' : String(v));
    if ((k === 'prompt' || k === 'brief') && s.length > 40) s = `${s.slice(0, 40)}…`;
    return `${k}=${s}`;
  }).join(', ');
  const reviewerTemplateError = (teamName, stem) => {
    const isReviewer = (t) => !!t && typeof t.systemPromptFile === 'string' && t.systemPromptFile.startsWith(REVIEWER_PROMPT_PREFIX);
    let rows = [];
    try { rows = typeof listAllTemplates === 'function' ? (listAllTemplates() || []) : []; } catch { rows = []; }
    const own = rows.filter((t) => t && t.team === teamName);
    let library = [];
    try { library = manager && typeof manager._reviewerTemplateNames === 'function' ? manager._reviewerTemplateNames() : []; } catch { library = []; }
    const ownHit = own.find((t) => t.name === stem);
    if (ownHit ? isReviewer(ownHit) : library.includes(stem)) return null;
    const ownNames = own.filter(isReviewer).map((t) => t.name);
    const known = [...ownNames, ...library.filter((n) => !ownNames.includes(n))];
    return `"${stem}" is not a reviewer template — a reviewer template's system prompt must be ${REVIEWER_PROMPT_PREFIX}*; available: [${known.join(', ')}]`;
  };

  handle('team:setRole', (_e, team, role, patch) => {
    try {
      const bad = accountPatchError(patch);
      if (bad) return { ok: false, error: bad };
      if (role === 'reviewer' && patch && typeof patch === 'object' && 'template' in patch) {
        const notReviewer = reviewerTemplateError(team, patch.template);
        if (notReviewer) return { ok: false, error: notReviewer };
      }
      const saved = setRole(team, role, patch, { operator: true });
      log.info('team', `role "${role}" on team "${team}" saved: ${fmtPatch(patch)}`);
      return { ok: true, team: saved };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // `{operator: true}` lets this channel remove a reserved role (reviewer); the `[agent:team role-rm]`
  // intent calls the same mutator without it and keeps the refusal.
  handle('team:removeRole', (_e, team, role) => {
    try {
      const before = loadManifest(team);
      const blocked = manager._roleInUse(before, role);
      if (blocked.seats.length || blocked.tickets.length) {
        return { ok: false, error: `role "${role}" is in use`, blockedBy: blocked };
      }
      const was = before.roles && before.roles[role] && before.roles[role].account;
      const removed = removeRole(team, role, { operator: true });
      log.info('team', `role "${role}" removed from team "${team}" (account was ${was || 'none'})`);
      return { ok: true, team: removed };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  handle('team:deleteCheck', (_e, team) => {
    try { return teamDeleteCheck(team); }
    catch (err) { return { ok: false, error: err.message }; }
  });

  handle('team:delete', async (_e, team) => {
    let r;
    try { r = await teamDeleteGated(team); }
    catch (err) { return { ok: false, error: err.message }; }
    if (r.ok) refreshMenusAfterWrite('team:delete', refreshAppMenu, refreshTrayMenu);
    return r;
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

  const stripBytes = (list) => (Array.isArray(list)
    ? list.map((i) => {
      if (!i || typeof i !== 'object') return i;
      const { bytes, ...rest } = i;
      return rest;
    })
    : list);
  handle('team:gather', (_e, team, opts) => {
    try {
      const res = gatherTeam(team, opts || {});
      const out = { ok: true, ...res };
      for (const k of ['items', 'copied', 'kept', 'skipped', 'missing', 'failed']) {
        if (k in out) out[k] = stripBytes(out[k]);
      }
      return out;
    } catch (err) { return { ok: false, error: err.message }; }
  });

  handle('team:setWatchdog', (_e, team, ms) => {
    try { return { ok: true, team: setTeamWatchdog(team, ms) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  handle('team:trunk', async (_e, name) => {
    try {
      const team = loadManifest(name);
      const derived = await gitWorktree.mergeTargetFor({ root: team.root });
      return { ok: true, trunk: team.trunk, derived, effective: team.trunk || derived };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  handle('team:setTrunk', async (_e, name, branch) => {
    try {
      const want = typeof branch === 'string' ? branch.trim() : '';
      if (want) {
        const team = loadManifest(name);
        const branches = await gitWorktree.localBranches(team.root);
        if (!branches) return { ok: false, error: `could not list the branches of ${team.root}` };
        if (!branches.includes(want)) return { ok: false, error: `no branch "${want}" in ${team.root} — it has: ${branches.slice(0, 20).join(', ') || '(no branches)'}` };
      }
      return { ok: true, team: setTeamTrunk(name, want || null) };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Writes only the manifest's top-level `lead` pointer; setRole('lead') still refuses. A seat name
  // with no record is accepted on purpose (a stopped lead is the same string).
  handle('team:setLead', (_e, team, seat) => {
    try { return { ok: true, team: setLead(team, seat) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // Probes are bound here so team-preflight stays a pure leaf; `exists` is deliberately unconfined
  // because it checks absolute paths built from the team root.
  handle('team:preflight', (_e, name) => {
    try {
      const team = loadManifest(name);
      let execDefs = null;
      const findings = teamPreflight(team, {
        exists: (abs) => { try { return fs.existsSync(abs); } catch { return false; } },
        listTemplates: () => (listAllTemplates ? listAllTemplates().filter((t) => !t.team) : templates.list()),
        // Use execLibrary.list(): it already parses both `argv` and `cwd`; a second read by name
        // could disagree with that parse.
        readExecDef: (id) => {
          const own = readTeamJson({ fs, path }, team, 'exec', id);
          if (own) {
            return {
              name: id,
              argv: Array.isArray(own.argv) ? own.argv : [],
              cwd: typeof own.cwd === 'string' ? own.cwd : '',
              resolvedFrom: 'team',
            };
          }
          if (!execDefs) execDefs = execLibrary.list();
          const hit = execDefs.find((d) => d && d.name === id);
          if (hit) return hit;
          // list() skips unparseable JSON, so raw() separates absent from garbled; `unreadable` means bytes
          // that do not decode to a def (raw() swallows EACCES/EISDIR, so those still read as absent).
          const bytes = execLibrary.raw(id);
          return bytes == null ? null : { name: id, unreadable: true };
        },
        resolvePrompt: (kind, stem) => (teamPromptFile({ fs, path }, team, kind, stem)
          ? 'team'
          : (promptLibrary.raw(kind, stem) == null ? null : 'library')),
        readTeamTemplate: (stem) => readTeamJson({ fs, path }, team, 'templates', stem),
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

  handle('team:stockRoles', () => {
    const roles = {};
    for (const [key, def] of Object.entries(STOCK_ROLE_DEFS)) {
      roles[key] = { dispatch: def.dispatch != null ? def.dispatch : null };
    }
    return { ok: true, roles };
  });

  handle('team:activity', (_e, name) => {
    try { return manager.teamActivity(name); }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // Only an absent role with an empty def gets the stock def (hand is stock but not reserved); widening
  // RESERVED_ROLE_KEYS instead would lock operator edits of it. team:join must never pass the opt-in.
  const isEmptyDef = (d) => !d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length === 0;
  handle('team:addRole', (_e, team, role, def) => {
    try {
      let absent = false;
      try { absent = !loadManifest(team).roles[role]; } catch { absent = false; }
      const substituted = absent && isEmptyDef(def) && !!STOCK_ROLE_DEFS[role];
      const d = substituted ? { ...STOCK_ROLE_DEFS[role] } : def;
      const bad = accountPatchError(d);
      if (bad) return { ok: false, error: bad };
      const added = addRole(team, role, d, { operator: true });
      const written = (added && added.roles && added.roles[role]) || {};
      const source = added && added.minted ? added.minted : (substituted ? 'stock' : 'caller def');
      const carried = added && added.accountCarried ? ', carried forward' : '';
      if (absent) log.info('team', `role "${role}" added to team "${team}" (${source}; account ${written.account || 'none'}${carried})`);
      return { ok: true, team: added };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // `prompts`, `all` and `teamOwned` stay three lists: the popover tells absent, off-the-rail and
  // team-owned apart by them.
  handle('team:rolePrompts', (_e, team) => {
    try {
      const rows = promptLibrary.list('system');
      const teamRows = (team && listAllPrompts)
        ? listAllPrompts('system').filter((p) => p && p.team === team)
        : [];
      const teamOwned = teamRows.map((p) => p.name);
      const owned = new Set(teamOwned);
      const dedupe = (names) => names.filter((n) => !owned.has(n));
      return {
        ok: true,
        prompts: [...appendRailPrompts(teamRows), ...dedupe(appendRailPrompts(rows))],
        all: [...teamOwned, ...dedupe((rows || []).map((p) => p && p.name).filter(Boolean))],
        teamOwned,
      };
    } catch (err) { return { ok: false, error: err.message, prompts: [], all: [], teamOwned: [] }; }
  });

  handle('worktree:create', async (_e, cwd, branch, opts) =>
    gitWorktree.createWorktree(cwd, branch, opts || null));
  handle('worktree:info', async (_e, cwd) => {
    try { return { ok: true, ...(await gitWorktree.repoInfo(cwd)) }; }
    catch (e) { return { ok: false, error: e.message, isRepo: false, branches: [] }; }
  });
  handle('worktree:remove', async (_e, worktreePath, opts) => gitWorktree.removeWorktree(worktreePath, opts || null));
  handle('session:cwdSuggestions', (e) => {
    const recent = recentCwdsFor(uiSettings.get(), workspaceOfSender(e));
    const counts = new Map();
    for (const s of manager.listForWorkspace(workspaceOfSender(e))) {
      if (!s.cwd) continue;
      counts.set(s.cwd, (counts.get(s.cwd) || 0) + 1);
    }
    const popular = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cwd, count]) => ({ cwd, count }));
    return { ok: true, recent, popular };
  });
  handle('session:noteCwd', (e, cwd) => {
    const dir = typeof cwd === 'string' && cwd.trim();
    if (!dir) return { ok: false };
    const settings = uiSettings.get();
    const wsId = workspaceOfSender(e);
    const cur = recentCwdsFor(settings, wsId);
    const next = [dir, ...cur.filter((c) => c !== dir)].slice(0, 12);
    uiSettings.set({ recentCwdsByWorkspace: { ...(settings.recentCwdsByWorkspace || {}), [wsId]: next } });
    return { ok: true };
  });
  handle('session:markWorktree', (_e, name, worktree) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found' };
    persistence.setWorktree(name, worktree || null);
    return { ok: true };
  });

  // The scm:/worktree:/fs: rows live in plugins/workbench/engine.js, scoped by the host's
  // sessions.fsScope(name); a handler re-added here would widen locality past that gate.

  // No unscoped cross-workspace lister: web-host dispatches any registered channel by name, so a
  // `manager.list()` handler mixes every workspace into one view. session:reservedNames is global on purpose.
  handle('session:list', (e) => manager.listForWorkspace(workspaceOfSender(e)));
  handle('session:reservedNames', () => {
    const live = new Set(manager.sessions.keys());
    const persisted = new Set();
    for (const s of persistence.list()) if (!live.has(s.name)) persisted.add(s.name);
    return { ok: true, names: [...live, ...persisted], live: [...live], persisted: [...persisted] };
  });
  handle('session:kill', async (_e, name) => manager.destroy(name));
  handle('session:move', async (_e, name, newCwd) => manager.move(name, newCwd));
  handle('session:move-to-peer', async (_e, name, peerId, farCwd) => manager.moveToPeer(name, peerId, { farCwd }));
  handle('session:move-to-workspace', (_e, name, workspaceId) => manager.moveToWorkspace(name, workspaceId));
  handle('session:rename', async (_e, name, newName) => manager.rename(name, newName));
  handle('session:scratch-mark', (e, { name, label } = {}) => {
    const here = workspaceOfSender(e);
    if (!persistence.listForWorkspace(here).some((s) => s.name === name)) {
      return { ok: false, error: `session ${name} is not in this workspace` };
    }
    let res;
    try { res = manager.scratchMark(name, label); } catch (err) { return { ok: false, error: err.message }; }
    if (res && res.ok === false) return { ok: false, error: res.error || 'scratch mark refused' };
    return { ok: true };
  });
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

  handle('templates:list', () => (listAllTemplates ? listAllTemplates() : templates.list()));
  handle('templates:save', (_e, template) => {
    try { templates.save(template); }
    catch (e) { return { ok: false, error: e.message, templates: templates.list() }; }
    refreshAppMenu();
    return { ok: true, templates: templates.list() };
  });
  handle('templates:saveByName', (_e, template) => {
    let t;
    try { t = templates.saveByName(template); }
    catch (e) { return { ok: false, error: e.message, templates: templates.list() }; }
    refreshAppMenu();
    return { ok: true, template: t, templates: templates.list() };
  });
  handle('templates:remove', (_e, id) => {
    try { templates.remove(id); }
    catch (e) { return { ok: false, error: e.message, templates: templates.list() }; }
    const list = templates.list();
    if (list.some((t) => t.id === id)) {
      const error = templates.dirWritable && !templates.dirWritable()
        ? 'the library is a read-only mount inside a sandbox box'
        : `its file "${id}.json" is still in the library`;
      return { ok: false, error, templates: list };
    }
    refreshAppMenu();
    return { ok: true, templates: list };
  });

  const teamFileDeps = { fs, path, teamsDir, listTeams };
  const teamTemplateList = () => (listAllTemplates ? listAllTemplates() : templates.list());

  handle('templates:saveTeam', (_e, team, stem, body) => {
    const res = teamTemplateSave(teamFileDeps, team, stem, body);
    if (!res.ok) return { ok: false, error: res.error, templates: teamTemplateList() };
    refreshAppMenu();
    return { ok: true, templates: teamTemplateList() };
  });

  handle('templates:removeTeam', (_e, team, stem) => {
    const res = teamTemplateRemove(teamFileDeps, team, stem);
    if (!res.ok) return { ok: false, error: res.error, templates: teamTemplateList() };
    refreshAppMenu();
    return { ok: true, templates: teamTemplateList() };
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
    // Absent stays absent: writing `intents: []` for an all-enabled seat would
    // freeze every intent off onto the template.
    if (Array.isArray(entry.intents)) t.intents = entry.intents;
    if (entry.noWire === true) t.noWire = true;
    if (entry.io === 'stream') t.io = 'stream';
    if (typeof entry.effort === 'string' && entry.effort) t.effort = entry.effort;
    if (Array.isArray(entry.plugins)) t.plugins = [...entry.plugins];
    try { templates.saveByName(t); }
    catch (e) { return { ok: false, error: e.message, templates: templates.list() }; }
    refreshAppMenu();
    return { ok: true, templates: templates.list() };
  });

  handle('prompts:list', (_e, kind) => (listAllPrompts ? listAllPrompts(kind) : promptLibrary.list(kind)));
  handle('prompts:save', (_e, kind, name, body) => {
    let prompts;
    try { prompts = promptLibrary.save(kind, name, body); }
    catch (err) { return { ok: false, error: err.message }; }
    refreshAppMenu();
    return { ok: true, prompts };
  });
  handle('prompts:remove', (_e, kind, name) => {
    let prompts;
    try { prompts = promptLibrary.remove(kind, name); }
    catch (err) { return { ok: false, error: err.message, prompts: promptLibrary.list() }; }
    refreshAppMenu();
    return { ok: true, prompts };
  });

  const teamPromptList = () => (listAllPrompts ? listAllPrompts() : promptLibrary.list());

  handle('prompts:saveTeam', (_e, team, kind, stem, body) => {
    const res = teamPromptSave(teamFileDeps, team, kind, stem, body);
    if (!res.ok) return { ok: false, error: res.error, prompts: teamPromptList() };
    refreshAppMenu();
    return { ok: true, prompts: teamPromptList() };
  });

  handle('prompts:removeTeam', (_e, team, kind, stem) => {
    const res = teamPromptRemove(teamFileDeps, team, kind, stem);
    if (!res.ok) return { ok: false, error: res.error, prompts: teamPromptList() };
    refreshAppMenu();
    return { ok: true, prompts: teamPromptList() };
  });

  handle('agents:list', () => agentLibrary.list());
  handle('agents:get', (_e, name) => agentLibrary.raw(name));
  handle('agents:save', (_e, name, content) => {
    let agents;
    try { agents = agentLibrary.save(name, content); }
    catch (err) { return { ok: false, error: err.message }; }
    refreshMenusAfterWrite('agents:save', refreshAppMenu);
    return { ok: true, agents };
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
    let skills;
    try { skills = skillLibrary.save(name, content); }
    catch (err) { return { ok: false, error: err.message }; }
    refreshMenusAfterWrite('skilllib:save', refreshAppMenu);
    return { ok: true, skills };
  });
  handle('skilllib:remove', (_e, name) => {
    let skills;
    try { skills = skillLibrary.remove(name); }
    catch (err) { return { ok: false, error: err.message, skills: skillLibrary.list() }; }
    refreshAppMenu();
    return { ok: true, skills };
  });
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
    let commands;
    try { commands = execLibrary.save(name, JSON.stringify(def, null, 2)); }
    catch (err) { return { ok: false, error: err.message }; }
    refreshAppMenu();
    return { ok: true, commands };
  });
  handle('exec:remove', (_e, name) => {
    let commands;
    try { commands = execLibrary.remove(name); }
    catch (err) { return { ok: false, error: err.message, commands: execLibrary.list() }; }
    refreshAppMenu();
    return { ok: true, commands };
  });

  handle('notifications:list', () => notifications.list());
  handle('notifications:page', (_e, opts) => notifications.page(opts || {}));
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

  handle('session:draftOpen', (_e, name) => {
    const s = manager.sessions.get(name);
    return { ok: true, open: !!s && !s._dead && isDraftOpen(s) };
  });

  const transcriptSpike = createTranscriptSpikeReader({
    linkPathFor: (name) => pathFor(REGISTRY_DIR, name, 'transcript'),
    onChange: (name) => manager._sendToSession(name, 'transcript-changed', name),
  });
  handle('transcript:pull', (_e, name, since) => {
    const s = manager.sessions.get(name);
    if (!s || s._dead || !isAgentType(s.agentType)) { transcriptSpike.drop(name); return { ok: false, reason: 'not-agent' }; }
    const res = transcriptSpike.pull(name);
    const extra = res && res.ok && manager.compactNoticesFor(name);
    const box = manager.seatOutbox(name);
    const perms = box && manager.seatPermissions(name);
    const p = perms ? { suffix: `:p${perms.rev}`, fields: { permissions: perms.items } } : { suffix: '', fields: {} };
    if (!res || !res.ok) return box ? { ...res, rev: `-:o${box.rev}${p.suffix}`, records: [], outbox: box.items, ...p.fields } : res;
    let rev = extra ? `${res.rev}:${extra.rev}` : res.rev;
    if (box) rev = `${rev}:o${box.rev}${p.suffix}`;
    if (since === rev) return { ok: true, rev, unchanged: true };
    const records = extra ? mergeCompactNotices(res.records, extra.notices) : res.records;
    return box ? { ok: true, rev, records, source: res.source, outbox: box.items, ...p.fields } : { ok: true, rev, records, source: res.source };
  });

  handle('proxy:snapshot', (_e, name) => stampServedAge(proxyPoller.snapshot(name)));

  // The quota broadcast fires only when a turn arrives, so this read is what
  // keeps a restored reading from staying blank at launch.
  handle('wire:quota', () => {
    const store = manager.quotaStore();
    return store ? manager._quotaPayload(store) : null;
  });

  handle('proxy:context', (_e, name, opts) => fetchProxyContext(name, opts));

  handle('proxy:report', (_e, name, opts) => fetchProxyReport(name, opts));

  handle('proxy:bust', (_e, name) => fetchProxyBust(name));

  // The reply's `seq` is the store head, so polling a quiet feed still advances
  // the cursor and rows are never served twice.
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
        // holdUntil and keepWarmAlways are mutually exclusive: write one, clear the other.
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

  const claudeHistoryLayout = (name, entry) => {
    let slugDir = null;
    try { slugDir = path.dirname(fs.realpathSync(pathFor(REGISTRY_DIR, name, 'transcript'))); } catch {}
    if (!slugDir) slugDir = claudeProjectDir(entry.cwd);
    return {
      fileOf: (sid) => (slugDir ? path.join(slugDir, `${sid}.jsonl`) : null),
      recent: (cutoff) => {
        const found = [];
        try {
          for (const fn of fs.readdirSync(slugDir)) {
            if (!fn.endsWith('.jsonl')) continue;
            let st; try { st = fs.statSync(path.join(slugDir, fn)); } catch { continue; }
            if (st.mtimeMs >= cutoff) found.push(fn.slice(0, -6));
          }
        } catch {}
        return found;
      },
    };
  };
  const codexHistoryLayout = (name, entry) => {
    let home = null;
    try {
      const real = fs.realpathSync(pathFor(REGISTRY_DIR, name, 'transcript'));
      const sessions = path.dirname(path.dirname(path.dirname(path.dirname(real))));
      if (path.basename(sessions) === 'sessions') home = path.dirname(sessions);
    } catch {}
    if (!home) home = (entry.env && entry.env.CODEX_HOME) || path.join(os.homedir(), '.codex');
    const uuidTail = (sid) => (String(sid).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i) || [null, sid])[1];
    return {
      fileOf: (sid) => findCodexRollout({ fs, path }, home, { sessionId: uuidTail(sid) }),
      recent: (cutoff) => (entry.cwd
        ? codexRolloutsForCwd({ fs, path }, home, { cwd: entry.cwd, sinceMs: cutoff }).map((p) => path.basename(p, '.jsonl'))
        : []),
    };
  };
  const historyLayouts = { claude: claudeHistoryLayout, codex: codexHistoryLayout };

  handle('session:history', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found' };
    const layoutFor = isAgentType(entry.type) ? historyLayouts[entry.type] : null;
    if (!layoutFor) return { ok: true, sessions: [], activeId: null };
    const layout = layoutFor(name, entry);
    const activeId = entry.sessionId || null;
    const tracked = new Set([...(Array.isArray(entry.sessionIds) ? entry.sessionIds : []), ...(activeId ? [activeId] : [])]);
    const out = [];
    const seen = new Set();
    const add = (sid, inferred) => {
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      const file = layout.fileOf(sid);
      const meta = file ? readSessionMeta(file) : null;
      if (!meta) {
        if (!inferred) out.push({ sessionId: sid, title: null, lastActive: null, active: sid === activeId, inferred: false, missing: true });
        return;
      }
      out.push({ sessionId: sid, title: meta.title, firstActive: meta.first, lastActive: meta.last, turns: meta.turns, active: sid === activeId, inferred });
    };
    for (const sid of tracked) add(sid, false);
    for (const sid of layout.recent(Date.now() - 7 * 24 * 3600 * 1000)) {
      if (!tracked.has(sid)) add(sid, true);
    }
    out.sort((a, b) => (Date.parse(b.lastActive || 0) || 0) - (Date.parse(a.lastActive || 0) || 0));
    return { ok: true, sessions: out, activeId };
  });

  // The live wire ledger is passed in because wire-totals.json lags a 1s debounce,
  // so the lifetime total would dip between a turn landing and the file write.
  handle('session:info', async (_e, name) => {
    try {
      const entry = persistence.get(name);
      if (!entry) return { ok: false, error: 'Session not found' };
      const payload = proxyPoller ? proxyPoller.snapshot(name) : null;
      let live = null;
      const wt = manager._wireTelemetry;
      if (wt) {
        const w = wt.payload(name);
        // The cost check is separate from the id gate: a null `cost.usd` would replace
        // the file's recorded spend, and NaN passes typeof, so use Number.isFinite.
        if (w && w.sessionId && w.sessionId === entry.sessionId
            && Number.isFinite(w.cost && w.cost.usd)) {
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
        // A new array, never a push: metaFor shares one frozen instance across every row.
        meta[s.name]._tiers = [...(meta[s.name]._tiers || []), 'record'];
        meta[s.name].createdAt = s.createdAt || null;
        meta[s.name].archivedAt = s.archivedAt || null;
        if (!teamByCwd.has(s.cwd)) teamByCwd.set(s.cwd, manager.teamNameFor(s.cwd));
        meta[s.name].team = teamByCwd.get(s.cwd);
        // Omitted on a revoke: the `record` tier claim makes absence mean none granted.
        if (Array.isArray(s.pluginGrants) && s.pluginGrants.length) {
          meta[s.name].pluginGrants = [...s.pluginGrants];
        }
        // Array.isArray alone: `[]` is no plugins, absent is the core-shipped set.
        if (Array.isArray(s.plugins)) meta[s.name].plugins = [...s.plugins];
      }
      return { ok: true, meta };
    } catch (err) {
      return { ok: false, error: err.message, meta: {} };
    }
  });

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
  // Takes a name, unlike file:peek: the session's cwd confines the write.
  handle('file:write', (_e, name, filePath, content, expectMtime) =>
    writeFilePeek(name, filePath, content, expectMtime));
  handle('file:resolve', (_e, name, raw, baseDir) => resolveFilePath(name, raw, baseDir));
  handle('file:open', (_e, filePath) => openPath(filePath));
  handle('file:reveal', (_e, filePath) => { showItemInFolder(filePath); });
  handle('plugins:writeBundleFile', (_e, pluginId, kind, stem, body) => {
    const loader = getPluginLoader && getPluginLoader();
    if (!loader) return { ok: false, error: 'no plugin loader' };
    return loader.writeBundleFile(String(pluginId || ''), String(kind || ''), String(stem || ''), body);
  });

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
  // The collapse to the all-enabled default happens here, not in the renderer:
  // only the engine knows the live row set.
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
  handle('session:skillCatalog', (_e, name) => readSkillCatalog({ name }));
  handle('settings:skillCatalogFor', (_e, cwd, type) => readSkillCatalog({ cwd: cwd || null, type: type || null }));
  handle('settings:voiceMode', (_e, name) => {
    const cap = readVoiceCapability ? readVoiceCapability() : { capable: true, cause: null };
    const seat = (typeof name === 'string' && name) || manager._focusedSession || null;
    const mode = seat && manager.sessions.has(seat) ? manager.voiceModeFor(seat) : null;
    return { ok: true, seat, mode, effective: mode, trigger: readVoiceTrigger(), capable: cap.capable !== false, cause: cap.cause || null };
  });
  handle('settings:setVoiceMode', (_e, mode, name) => manager.voiceMode(mode, typeof name === 'string' && name ? name : null));
  handle('session:setVoice', (_e, name, mode) => manager.setVoice(String(name || ''), mode));

  handle('settings:toolCatalogFor', (_e, cwd) => {
    return { ok: true, effective: readEffectiveToolState(cwd || null).overrides };
  });

  handle('session:setArgs', async (e, name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles, intents, execCommands, env, plugins, io, effort) =>
    applySessionArgs(name, {
      extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins,
      disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles, intents, execCommands, env,
      plugins, io, effort,
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
      defaultSkillDeny: agentDefaults.getDefaultSkillDeny(),
      defaultBuiltinDeny: agentDefaults.getDefaultBuiltinDeny(),
      proxyEnabled: s.proxyEnabled,
      proxyUrl: s.proxyUrl,
      lastCustomProxyUrl: s.lastCustomProxyUrl,
      wirescopeDir: s.wirescopeDir,
      wirescopePort: s.wirescopePort,
      disableClaudeDesignMcp: s.disableClaudeDesignMcp,
      compactOnResume: s.compactOnResume,
      ctxReminderThresholds: s.ctxReminderThresholds,
      ctxThresholdDefaults: {
        default: { nudge: CTX_REMINDER_NUDGE_TOKENS, escalate: CTX_REMINDER_ESCALATE_TOKENS },
        models: [...CTX_MODEL_THRESHOLDS].map(([family, v]) => ({ family, ...v })),
      },
      contextHints: s.contextHints,
      semanticHints: s.semanticHints,
      selectionHints: s.selectionHints,
      voiceSubmit: s.voiceSubmit,
      voiceSubmitPhrase: s.voiceSubmitPhrase,
      speakReplies: s.speakReplies,
      speakVoice: s.speakVoice,
      speakRate: s.speakRate,
      // Enumerated per box: `say` substitutes the system voice for an uninstalled
      // name, so a remembered list would offer voices the operator cannot get.
      speakVoices: typeof listSpeakVoices === 'function' ? listSpeakVoices() : [],
      terminalReports: s.terminalReports,
      terminalRemote: s.terminalRemote,
      intentSpill: s.intentSpill,
      defaultSessionMode: s.defaultSessionMode,
      discoverOnStartup: s.discoverOnStartup,
      theme: s.theme,
      terminalWebgl: s.terminalWebgl,
      transcriptPane: s.transcriptPane,
      transcriptPaneMode: s.transcriptPaneMode,
      sidebarWidth: s.sidebarWidth,
      sidePaneWidth: s.sidePaneWidth,
      dockSplit: s.dockSplit,
      remoteEnabled: s.remoteEnabled,
      remotePort: s.remotePort,
      remoteBasePath: s.remoteBasePath,
      envLockedSettings: envLockedSettings(),
      // Explicit whitelist, not a spread: a flag left unnamed arrives undefined and
      // reads as off, which is wrong for peerShellEnabled on a box that is serving.
      peerShellEnabled: s.peerShellEnabled,
      remoteHasToken: typeof hasRemoteToken === 'function' ? hasRemoteToken() : false,
      // The peer token is write-only: the renderer sees only hasToken, and
      // sanitizePeers carries an omitted token forward when the dialog saves back.
      peers: (s.peers || []).map(({ token, ...rest }) => ({ ...rest, hasToken: !!token })),
    };
  });
  handle('setup:state', () => setupMarker.read());
  handle('setup:complete', (_e, opts = {}) => {
    const choice = opts && opts.choice;
    if (!SETUP_CHOICES.includes(choice)) throw new Error(`Unknown setup choice: ${choice}`);
    if (choice !== 'skipped') uiSettings.set({ defaultSessionMode: choice });
    setupMarker.write({ choice, version: getAppVersion() });
    return setupMarker.read();
  });

  handle('settings:set', (_e, partial) => {
    // Read before the write: the revocation below needs the previous value.
    const prevTerminalReports = uiSettings.get().terminalReports;
    const next = uiSettings.set(partial);
    // No typeof guard: an unwired revocation must throw here, not silently
    // leave undrained reports unswept.
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

  // Write-only: the reply carries just hasToken. The RemoteServer reads the token
  // only at construct, so the refresh is what makes the new gate live.
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

  // A secret is write-only through IPC: the read returns only { key, secret:true, hasValue:true }.
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

  if (enableAccounts) {
    handle('accounts:list', () => {
      if (!accounts) return { ok: false, error: 'accounts not supported on this host' };
      return { ok: true, accounts: accounts.list() };
    });
    handle('accounts:add', (_e, params) => {
      if (!accounts) return { ok: false, error: 'accounts not supported on this host' };
      const p = params || {};
      try {
        return { ok: true, account: accounts.add({ label: p.label, email: p.email, plan: p.plan, configDir: p.configDir }) };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
    handle('accounts:remove', (_e, params) => {
      if (!accounts) return { ok: false, error: 'accounts not supported on this host' };
      try {
        const removed = accounts.remove((params || {}).label);
        return removed ? { ok: true } : { ok: false, error: `unknown account "${(params || {}).label}"` };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
    handle('accounts:resync', (_e, params) => {
      if (!accounts) return { ok: false, error: 'accounts not supported on this host' };
      try {
        return accounts.resync((params || {}).label);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
    handle('accounts:move-by-model', async (_e, params) => {
      if (!moveAccountByModel) return { ok: false, error: 'accounts not supported on this host' };
      const p = params || {};
      if (!p.model || !p.label) {
        return { ok: false, error: 'move needs both a model and an account label', moved: [], skipped: [] };
      }
      try {
        return await moveAccountByModel(p.model, p.label, workspaceOfSender(_e));
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), moved: [], skipped: [] };
      }
    });
  }

  handle('envDefaults:get', () => {
    if (!envDefaults) return { ok: false, error: 'env defaults not supported on this host' };
    return { ok: true, defaults: envDefaults.list() };
  });
  handle('envDefaults:restore', () => {
    if (!envDefaults) return { ok: false, error: 'env defaults not supported on this host' };
    try {
      envDefaults.restore();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  const pluginRefusal = () => errorEnvelope(NO_SUCH_METHOD);
  // The caller surface rides each call because the channel stays registered on every
  // transport; an undefined surface is untrusted, not the desktop.
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
  handle('help:index', () => {
    const corpus = getHelpCorpus && getHelpCorpus();
    if (!corpus) return { ok: false };
    return { ok: true, ...corpus.index() };
  });
  handle('help:page', (_e, name) => {
    const corpus = getHelpCorpus && getHelpCorpus();
    if (!corpus) return { ok: false };
    const doc = corpus.get(String(name || ''));
    return doc ? { ok: true, name: doc.name, title: doc.title, content: doc.content } : { ok: false };
  });
  // Read off intent-registry, not the plugin host, so the checklist survives a missing host.
  // With neither name nor override the rows are core-shipped plugins' only, not every enabled one's.
  handle('intents:catalog', (_e, name, override) => {
    if (Array.isArray(override)) return catalogRows(override.map(String));
    const entry = name ? persistence.get(String(name)) : null;
    return catalogRows(entry ? entry.plugins : undefined);
  });

  handle('session:setPlugins', (_e, name, plugins) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    // Filter ids at the door: this value reaches a directory name.
    const next = Array.isArray(plugins) ? plugins.filter(isValidPluginId) : null;
    persistence.setPlugins(name, next);
    const pruned = pruneForPlugins(entry, next);
    if (Array.isArray(entry.intents) && pruned.intents.length !== entry.intents.length) {
      persistence.setIntents(name, pruned.intents);
    }
    if (Array.isArray(entry.pluginGrants) && pruned.pluginGrants.length !== entry.pluginGrants.length) {
      persistence.setPluginGrants(name, pruned.pluginGrants);
    }
    return { ok: true };
  });

  handle('session:setPluginGrants', (_e, name, grants) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    const next = sanitizeGrants(grants);
    persistence.setPluginGrants(name, next);
    // Global plugins stay reached whatever `next` says; pruning by granted ids alone
    // would drop a verb-only plugin's verbs on every grants save.
    const granted = new Set((next || []).map((g) => String(g).split(':')[0]).filter(Boolean));
    const stillReached = [...new Set(intentRows()
      .filter((r) => r.source && (r.scope !== 'session' || granted.has(r.source)))
      .map((r) => r.source))];
    const kept = pruneForPlugins({ intents: entry.intents }, stillReached).intents;
    if (Array.isArray(entry.intents) && kept.length !== entry.intents.length) {
      persistence.setIntents(name, kept);
    }
    return { ok: true };
  });

  handle('session:pluginGrants', (_e, name, override) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    const host = getPluginHost && getPluginHost();
    const status = host ? host.status() : { plugins: [] };
    const seatPlugins = Array.isArray(override) ? override.map(String) : entry.plugins;
    return {
      ok: true,
      capabilities: [...PLUGIN_CAPABILITIES],
      plugins: (status.plugins || [])
        .filter((p) => p.scope === 'session' && p.enabled && !p.quarantined)
        .filter((p) => seatHasPlugin(p.id, seatPlugins, p.root === 'core'))
        .map((p) => ({ id: p.id, name: p.name, reads: Array.isArray(p.reads) ? [...p.reads] : null })),
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
    // Classify the folder before any ssh: the value becomes a remote shell word.
    const srcClass = classifyDeployFolder(opts.folder);
    if (!srcClass.ok) return { ok: false, error: srcClass.error };
    const shellEsc = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const srcExport = srcClass.srcExport ? ` ${srcClass.srcExport}` : '';
    const preamble =
      `export PORT=${shellEsc(port)} REPO_URL=${shellEsc(repoUrl)} BRANCH=${shellEsc(branch)}${srcExport}\n`;
    const wc = e.sender;
    // Logged once, not per line: a bare catch hides a sender defect, a per-line log buries the run.
    let lineDropLogged = false;
    let lastMarker = null;
    const timeoutMs = 15 * 60 * 1000;    // a cold clone+install+rebuild can be minutes
    log.info('peer', `deploy to ${sshHost} port ${port} branch ${branch} begins`);
    try {
      const res = await sshRun(sshHost, preamble + script, {
        timeoutMs,
        onLine: (line) => {
          if (typeof line === 'string' && line.startsWith('::')) lastMarker = line.trim();
          try { if (!wc.isDestroyed()) wc.send('peer-deploy-line', sshHost, line); }
          catch (err) {
            if (!lineDropLogged) { lineDropLogged = true; log.error('peer', `deploy progress dropped: ${err.message}`); }
          }
        },
      });
      const outcome = res.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : `exit ${res.code}`;
      log.info('peer', `deploy to ${sshHost}: ${outcome}, last marker ${lastMarker || 'none'}`);
      return {
        ok: res.code === 0,
        code: res.timedOut ? null : res.code,
        timedOut: !!res.timedOut,
        needSudo: res.code === 42,
        stderr: (res.stderr || '').trim().split('\n').slice(-20).join('\n'),
      };
    } catch (err) {
      const msg = err && err.message ? err.message : 'ssh failed to start';
      log.error('peer', `deploy to ${sshHost} failed to start: ${msg}`);
      return { ok: false, error: msg };
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
    const dir = fixDirFor(REGISTRY_DIR, host);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch {}
    } catch (err) {
      return { ok: false, error: `could not make fix dir: ${err.message}` };
    }
    try {
      const out = await manager.create(
        name, 'claude', dir, [], null, wsId,
        null, false, null, [], [], [], [], [], null, [],
        [], null, null, true, false, null, null, host || null,
      );
      const briefing = buildDeployFixBriefing({
        sshHost: host, port: p, label, logText,
        docsDir: path.join(__dirname, 'peering'),
      });
      setTimeout(() => {
        try { manager._deliverMessage(name, 'user', briefing, 'dm'); } catch {}
      }, DEPLOY_FIX_INJECT_DELAY_MS);
      log.info('session', `deploy-fix session ${name} for ${host}`);
      return { ok: true, name: out.name, type: 'claude', cwd: dir, backend: out.backend || null, fixFor: host || null };
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
    // Strip `peer` on the way out: it holds the token, and the renderer needs only the name.
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
  // Broadcast before syncPeerManager so renderers mark the peer disabled ahead of peer-removed;
  // never forget attachments here, re-enable restores them.
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
  // Box-wide grant with no peer id: the wire carries no caller identity. syncRemoteServer
  // closes open far shells on revoke; without it a revocation waits for a restart.
  handle('peer:setShellAllowed', (_e, on) => {
    uiSettings.set({ peerShellEnabled: !!on });
    // Every window, payload-free: a window that missed it shows "off" over a box serving
    // shells, and the renderer re-reads settings rather than trusting a delta.
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

  // Gated by enableDrawerServices, not enableLocalTerminal: no local session channel reaches a
  // third machine, so a web client could not otherwise open this shell.
  if (enableDrawerServices) {
    const peerSeat = (key) => {
      const w = wireSeatFor(key);
      if (!w) return null;
      const conn = getPeerManager() && getPeerManager().get(w.peerId);
      return conn ? { conn, seat: w.name } : null;
    };
    // Strict owner: an unresolved sender is refused on open and close, since the default-workspace
    // fallback yields an owner no dropper ever matches and strands the far shell.
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
    // Refuse an anonymous close like the open: swallowing it makes closing a no-op, and shedding
    // on it takes down a pane another window is still watching.
    handle('peer:wtermClose', (e, key) => new Promise((resolve) => {
      const t = peerSeat(key);
      if (!t) return resolve({ ok: false, error: 'no such peer session' });
      const owner = wtermOwner(e);
      if (!owner) return resolve({ ok: false, error: 'no workspace for this window' });
      t.conn.wtermClose(t.seat, owner, resolve);
    }));
    on('peer:wtermInput', (_e, key, data) => {
      const t = peerSeat(key);
      if (t) t.conn.wtermInput(t.seat, String(data ?? ''), () => {});
    });
  }

  handle('defaults:setToolDeny', (_e, list) => {
    agentDefaults.setDefaultDeny(Array.isArray(list) ? list : []);
    return agentDefaults.getDefaultDeny();
  });

  handle('defaults:setSkillDeny', (_e, list) => {
    agentDefaults.setDefaultSkillDeny(Array.isArray(list) ? list : []);
    return agentDefaults.getDefaultSkillDeny();
  });

  handle('defaults:setBuiltinDeny', (_e, list) => {
    agentDefaults.setDefaultBuiltinDeny(Array.isArray(list) ? list : []);
    return agentDefaults.getDefaultBuiltinDeny();
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
  handle('sandbox:detect', () => {
    const mgr = getSandboxManager();
    if (!mgr) return { ok: false, error: 'sandbox manager unavailable' };
    return mgr.detect();
  });
  handle('sandbox:self', () => {
    const inBox = runningInSandboxBox(process.env);
    const libraryWritable = !inBox || !templates || typeof templates.dirWritable !== 'function' || templates.dirWritable();
    return { inBox, label: inBox ? (process.env.CLODEX_BOX_LABEL || SELF_LABEL || null) : null, libraryWritable };
  });
  handle('sandbox:status', (_e, boxId) => withBox(boxId, (s) => s.status()));
  handle('sandbox:openWeb', (_e, boxId) => withBox(boxId, async (s) => {
    const st = await s.status();
    const port = st && st.ports && st.ports.web;
    if (!port) return { ok: false, error: 'box is not serving a web UI' };
    const tok = s.webToken();
    const url = `http://localhost:${port}` + (tok ? `?token=${encodeURIComponent(tok)}` : '');
    openExternal(url);
    return { ok: true };
  }));
  handle('sandbox:getConfig', (_e, boxId) => withBox(boxId, (s) => s.getConfig()));
  handle('sandbox:setConfig', (_e, partial, boxId) => withBox(boxId, (s) => s.setConfig(partial || {})));
  handle('sandbox:translatePath', (_e, hostPath, boxId) => withBox(boxId, (s) => s.translateHostPath(hostPath)));
  handle('sandbox:up', (_e, boxId) => withBox(boxId, (s) => s.up()));
  handle('sandbox:rebuild', (_e, boxId) => withBox(boxId, (s) => s.rebuild()));
  handle('sandbox:down', (_e, boxId) => withBox(boxId, (s) => s.down()));
  handle('sandbox:logsTail', (_e, n, boxId) => withBox(boxId, (s) => s.logsTail(n)));
  // The token crosses in but never back out; reply with a hasToken flag only.
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
    const isAgent = isAgentType(entry.type);
    let seatDir = null;
    let seatDirExists = false;
    try {
      seatDir = seatDirFor(REGISTRY_DIR, name);
      seatDirExists = fs.existsSync(seatDir);
    } catch { seatDirExists = false; }
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
    const movePeerItem = () => {
      let eligible = [];
      try {
        const pm = getPeerManager();
        eligible = (pm ? pm.statuses() : [])
          .filter((st) => st.online && st.canImport && !st.needsUpgrade);
      } catch { eligible = []; }
      if (!eligible.length) return { label: 'Move to Peer…', enabled: false };
      return {
        label: 'Move to Peer…',
        submenu: eligible.map((st) => {
          const peerLabel = st.host || st.label;
          return {
            label: peerLabel,
            click: () => e.sender.send('session:context-action', {
              action: 'moveToPeer', name, cwd, peerId: st.id, peerLabel,
            }),
          };
        }),
      };
    };
    const moveWorkspaceItem = () => {
      const here = workspaceOfSender(e);
      let others = [];
      try { others = (workspaces.list() || []).filter((w) => w.id !== here); } catch { others = []; }
      if (!others.length) return { label: 'Move to Workspace…', enabled: false };
      return {
        label: 'Move to Workspace…',
        submenu: others.map((w) => {
          const workspaceName = w.name || w.id;
          return {
            label: workspaceName,
            click: () => e.sender.send('session:context-action', {
              action: 'moveToWorkspace', name, workspaceId: w.id, workspaceName,
            }),
          };
        }),
      };
    };
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
      ...(isAgent ? [{
        label: 'Move Session…',
        click: () => e.sender.send('session:context-action', { action: 'move', name }),
      }] : []),
      ...(entry.type === 'claude' ? [movePeerItem()] : []),
      moveWorkspaceItem(),
      ...(entry.type === 'claude' ? [{
        label: 'Scratch mark…',
        click: () => e.sender.send('session:context-action', { action: 'scratchMark', name }),
      }] : []),
      { type: 'separator' },
      {
        label: 'Reveal Working Directory in Finder',
        enabled: !!cwd,
        click: () => { if (cwd) showItemInFolder(cwd); },
      },
      {
        label: 'Reveal Seat Folder in Finder',
        enabled: isAgent && seatDirExists,
        click: () => showItemInFolder(seatDir),
      },
      {
        label: 'Open in Terminal',
        enabled: !!cwd,
        click: () => {
          if (!cwd) return;
          // execFile with argv, never exec: cwd is agent-supplied and exec
          // routes it through /bin/sh, where $(...) runs.
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

  handle('seat:send', (e, name, text, images) => {
    const surface = typeof surfaceOfSender === 'function' ? surfaceOfSender(e) : undefined;
    if (surface !== 'desktop') return { ok: false, error: 'seat:send is local only' };
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return { ok: false, error: 'no such session in this workspace' };
    const checked = validateSeatImages(images);
    if (!checked.ok) return checked;
    return manager.seatSend(s.name, typeof text === 'string' ? text : '', checked.images);
  });

  handle('seat:image-upload', (e, name, images) => {
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return { ok: false, error: 'no such session in this workspace' };
    if (!isAgentType(s.agentType)) return { ok: false, error: 'not an agent session' };
    if (!Array.isArray(images) || !images.length) return { ok: false, error: 'no image to upload' };
    const checked = validateSeatImages(images);
    if (!checked.ok) return checked;
    return { ok: true, paths: manager._writeImageFiles(s.name, checked.images) };
  });

  handle('seat:commands', (e, name) => {
    const surface = typeof surfaceOfSender === 'function' ? surfaceOfSender(e) : undefined;
    if (surface !== 'desktop') return { ok: false, error: 'seat:commands is local only' };
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return { ok: false, error: 'no such session in this workspace' };
    return manager.seatCommands(s.name);
  });

  handle('seat:control', (e, name, sub) => {
    const surface = typeof surfaceOfSender === 'function' ? surfaceOfSender(e) : undefined;
    if (surface !== 'desktop') return { ok: false, error: 'seat:control is local only' };
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return { ok: false, error: 'no such session in this workspace' };
    return manager.seatControl(s.name, String(sub || ''));
  });

  handle('seat:permission', (e, name, id, choiceId) => {
    const surface = typeof surfaceOfSender === 'function' ? surfaceOfSender(e) : undefined;
    if (surface !== 'desktop') return { ok: false, error: 'seat:permission is local only' };
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return { ok: false, error: 'no such session in this workspace' };
    return manager.seatPermission(s.name, String(id), String(choiceId));
  });

  handle('seat:interrupt', (e, name) => {
    const surface = typeof surfaceOfSender === 'function' ? surfaceOfSender(e) : undefined;
    if (surface !== 'desktop') return { ok: false, error: 'seat:interrupt is local only' };
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return { ok: false, error: 'no such session in this workspace' };
    return manager.seatInterrupt(s.name);
  });

  on('seat:draft', (e, name, text) => {
    const surface = typeof surfaceOfSender === 'function' ? surfaceOfSender(e) : undefined;
    if (surface !== 'desktop') return;
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return;
    manager.seatDraft(s.name, typeof text === 'string' ? text : '');
  });

  handle('voice:record', (e, name, action, observed = null) => {
    const s = manager.sessions.get(String(name || ''));
    if (!s || s.workspaceId !== workspaceOfSender(e)) return { ok: false, error: 'no such session in this workspace' };
    if (!['start', 'stop', 'toggle'].includes(action)) return { ok: false, error: 'action must be start, stop or toggle' };
    const seen = observed && typeof observed === 'object'
      ? { recording: observed.recording === true, processing: observed.processing === true, text: observed.text === true }
      : null;
    return manager.voiceRecord(s.name, action, { workspaceId: s.workspaceId, observed: seen });
  });

  on('log:voice', (_e, name, line) => {
    log.info('voice', `${String(name || '-').slice(0, 64)} ${String(line || '')}`.slice(0, 300));
  });

  on('voice:markOrigin', (_e, name) => {
    manager.markVoiceOrigin(String(name || ''));
  });

  on('voice:unmarkOrigin', (_e, name) => {
    manager.unmarkVoiceOrigin(String(name || ''));
  });

  on('voice:recording', (_e, name) => {
    manager.noteVoiceRecording(String(name || ''));
  });

  on('voice:draft', (_e, name) => {
    manager.noteVoiceDraft(String(name || ''));
  });

  // Sender resolved strictly: the loose helper maps a gone window to the default
  // workspace, so a dying window's last report would be authorised against it.
  on('session:focused', (e, name) => {
    manager.noteFocusedSession(
      name == null ? null : String(name),
      manager.windowForWorkspace(
        workspaceOfSenderStrict ? workspaceOfSenderStrict(e) : workspaceOfSender(e),
      ),
    );
  });

  handle('app:restore-sessions', (e) => restoreSessionsForWorkspace(workspaceOfSender(e)));

  handle('session:retrySpawn', async (e, name) => {
    const workspaceId = workspaceOfSender(e);
    const entry = persistence.list().find(s => s.name === name);
    if (!entry) return { ok: false, error: 'No saved entry found' };
    try {
      await manager.create(
        entry.name,
        entry.type,
        manager.resumeCwdOf(entry),
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
        false,             // mint: a retry must not hit the name check
        entry.noWire === true,
        Array.isArray(entry.plugins) ? entry.plugins : null,
        Array.isArray(entry.shellDeny) ? entry.shellDeny : null,
        typeof entry.fixFor === 'string' ? entry.fixFor : null,
        entry.io || 'pty',
        typeof entry.effort === 'string' ? entry.effort : null,
      );
      return { ok: true, io: entry.io || 'pty' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('session:forget', (e, name) => {
    manager.clearHintForRecord(name);
    persistence.remove(name);
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
    if (oldName && oldName !== newName) {
      const n = renameWorkspaceScope(oldName, newName);
      if (n) log.info('workspace', `rescoped ${n} library file(s): "${oldName}" → "${newName}"`);
    }
    refreshTrayMenu();
    refreshAppMenu();
    return true;
  });
  if (enableCtl) {
    handle('ctl:run', async (_e, line) => {
      const svc = getCtlService();
      if (!svc) return { command: String(line || ''), output: 'clodexctl: the ctl service is unavailable on this host\n', exitCode: 2, ctx: null, ts: Date.now() };
      return await svc.run(line);
    });
    handle('ctl:context', () => {
      const svc = getCtlService();
      return svc ? svc.context() : null;
    });
    handle('ctl:help', () => {
      const svc = getCtlService();
      return svc ? svc.helpIndex() : null;
    });
  }
  // Gated at registration: web-host dispatches any registered channel by name, so
  // the `if` is the whole boundary; never move the flag check into a handler body.
  if (enableDrawerServices) {
    handle('drawer:armSelection', async (_e, name, payload) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      return await manager.armSelection(String(name || ''), {
        // Bounded here as well as by the composer, so an unbounded string is not
        // scrubbed token-by-token; 64 KiB sits well above the 8000-char attach cap.
        text: typeof p.text === 'string' ? p.text.slice(0, 64 * 1024) : '',
        tab: typeof p.tab === 'string' ? p.tab : '',
        attach: p.attach === true,
      });
    });
    // Inside the gate: it reports the operator's own screen text back.
    handle('drawer:inspectSelection', async (_e, name) => (
      await manager.inspectSelection(String(name || ''))
    ));
    handle('drawer:releaseSelection', async (_e, name) => await manager.releaseSelection(String(name || '')));
  }

  if (enableConsole) {
    handle('console:read', (_e, name, cursor) => {
      const raw = typeof name === 'string' ? name : '';
      const seat = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(raw) ? raw : null;
      if (!seat) return { records: [], cursor: '', reset: false, skipped: 0, live: false };
      const since = typeof cursor === 'string' && RECORD_NAME_RE.test(cursor) ? cursor : '';
      return readBashConsole(REGISTRY_DIR, seat, since);
    });
    handle('console:live', (_e, name) => {
      const raw = typeof name === 'string' ? name : '';
      const seat = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(raw) ? raw : null;
      if (!seat) return [];
      const svc = getBashLive ? getBashLive() : null;
      if (!svc) return [];
      try { return svc.read(seat); } catch { return []; }
    });
  }

  // Own flag, not enableDrawerServices: session:create already hands a web client a
  // shell on this box. drawer:* and peer:wterm* keep the drawer gate.
  if (enableLocalTerminal) {
    // Strict resolution: the shared helper falls back to the default workspace for a
    // gone window, so a closing window's keystroke would land in another workspace's shell.
    const wtermWorkspace = (e) => (workspaceOfSenderStrict ? workspaceOfSenderStrict(e) : workspaceOfSender(e));
    // The seat comes from the payload, the workspace from the sender; the dot-only guard
    // keeps `.` and `..` out of a key that is resolved to a shell cwd.
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
    try {
      workspaces.upsert({ id, name: 'New Workspace', bounds: null });
    } catch (e) {
      log.warn('workspace', `new workspace ${id} not persisted: ${(e && e.message) || e}`);
    }
    createWindow(id);
    refreshAppMenu();
    refreshTrayMenu();
    return id;
  });
}

module.exports = { registerIpcHandlers, envLockedSettings };
