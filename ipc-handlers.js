// ipc-handlers.js — every ipcMain.handle/on registration, extracted verbatim
// from the app.whenReady() body in main.js (M5). registerIpcHandlers(deps) RUNS
// the registrations (it does not return them); main.js calls it from whenReady in
// place of the blob, after the stores are initialized.
//
// The blob was already 2-space indented inside the whenReady arrow and the factory
// body is 2-space too, so the move is a ZERO-reindent copy — handler bodies are
// byte-identical. The only body changes are the six READ-ONLY mutable-singleton
// getter seams (remoteServer/remoteError/peerManager/tunnelManager/updateInfo/
// releasesCache — 0 writes in the blob, so getters, no setters). Electron names
// are required in-module (electron-heavy, like app-menus). All other names are
// value-injected verbatim: they are every main.js module-scope identifier the blob
// references (stores/manager/proxyPoller/wirescope, the require-consts, the hoisted
// helpers restartSession/waitForSessionExit/fetch*, and the app-menus / peer-wiring
// / remote-wiring exports refreshAppMenu/refreshTrayMenu/setUiTheme/syncPeerManager/
// syncRemoteServer/forget*Peer* etc.), each defined at the call site. The deps set
// was derived by static scan (raw-token ∩ main-scope) so it is a guaranteed
// superset of the real references — an unused dep would simply be inert.

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { pathFor } = require('./clodex-paths');

function registerIpcHandlers(deps) {
  const {
    CLAUDE_SKILLS, CLAUDE_SL_COMPONENTS, CLAUDE_TOOLS, CODEX_SL_COMPONENTS,
    DEPLOY_FIX_INJECT_DELAY_MS, ProxyClient, REGISTRY_DIR, SKILL_REENABLE_CONFIRMED,
    UPDATE_REPO, buildDeployFixBriefing, checkForUpdate, classifyDeployFolder,
    claudeProjectDir, collectSystemDiagnostics, createWindow, diagSummary,
    diagWarning, fetchFileDiff, fetchFilePeek, fetchProxyBust,
    fetchProxyContext, fetchProxyReport, fetchSessionFiles, fixSessionName,
    forgetPeerAttached, forgetPeerControlled, fs, https,
    jsonlToMarkdown, log, manager, maybeCompactBeforeResume,
    openWirescopeWindow, os, parseCtxFile,
    path, persistence, probePeer, proxyPoller,
    pty, readEffectiveSkillState, readEffectiveToolState, readSessionMeta,
    rebuildAllStatusScripts, refreshAppMenu, refreshTrayMenu, rememberPeerControlled,
    resolveDeployFolder, restartSession, readSessionArgs, applySessionArgs,
    readSkillCatalog, applySessionSkills, setUiTheme, sshRun,
    stripLevelOf, syncPeerManager, syncRemoteServer, updateApplies,
    waitForSessionExit, wirescope, workspaceOfSender,
    sessionScopeCtx, renameWorkspaceScope,
    // stores (siblings of persistence above, declared in main.js's multi-line
    // `let persistence, templates, …` list) — value-injected: initStores runs
    // before this factory in whenReady and the stores are never reassigned.
    templates, workspaces, promptLibrary, agentDefaults,
    agentLibrary, skillLibrary, uiSettings,
    // read-only mutable singletons (get seams)
    getRemoteServer, getRemoteError, getPeerManager, getTunnelManager,
    getUpdateInfo, getReleasesCache,
  } = deps;

  ipcMain.handle('session:create', async (e, name, type, cwd, extraArgs, systemPromptBody, resumeId, fork, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, stripLevel, systemPromptFile, appendPromptFiles) => {
    try {
      const workspaceId = workspaceOfSender(e);
      // Seed tool denies from the global "*" default when the caller passed none.
      // The new-session dialog always pre-populates its checklist from the default
      // and sends an explicit array (incl. [] for "deny nothing"), so this only
      // fires for non-dialog callers — keeping new sessions on the shared, lean
      // tools segment. An explicit array always wins (undefined === "untouched").
      const seedTools = (disabledTools === undefined) ? agentDefaults.getDefaultDeny() : disabledTools;
      const session = await manager.create(name, type, cwd, extraArgs, resumeId || null, workspaceId, systemPromptBody || null, !!fork, proxy ?? null, agents || [], denyBuiltins || [], seedTools || [], disabledSkills || [], injectSkills || [], systemPromptFile || null, appendPromptFiles || []);
      // Strip level isn't a spawn arg (it's a proxy-side override the poller
      // asserts once the session links), so persist it onto the entry after
      // create() rather than threading it through the 15-param spawn path.
      // Set at creation = the cold-cache path: the first re-write is tiny.
      // An explicit dialog choice wins; otherwise seed from this agent name's
      // standing default (set previously from the bottom-bar menu, kill-proof).
      const seedStrip = (stripLevel === 1 || stripLevel === 2) ? stripLevel : agentDefaults.getStrip(name);
      if (seedStrip === 1 || seedStrip === 2) persistence.setStripLevel(name, seedStrip);
      return { ok: true, session };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('session:list', (e) => manager.listForWorkspace(workspaceOfSender(e)));
  ipcMain.handle('session:listAll', () => manager.list());
  ipcMain.handle('session:kill', (_e, name) => manager.kill(name));
  ipcMain.handle('session:resize', (_e, name, cols, rows) => manager.resize(name, cols, rows));
  ipcMain.handle('session:setLabel', (_e, name, label) => persistence.setLabel(name, label));
  ipcMain.handle('session:setAutoCompact', (_e, name, on) => persistence.setAutoCompact(name, on !== false));

  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('update:check', () => checkForUpdate(false));
  ipcMain.handle('update:info', () => getUpdateInfo());
  // Cached release list for the peer-identity popover's age/behind line. Returns
  // [] until the first fetch lands / when offline — the renderer never blocks on
  // it (it renders from whatever is cached at open time).
  ipcMain.handle('update:releases', () => getReleasesCache());
  ipcMain.handle('update:open', () => {
    if (getUpdateInfo()) shell.openExternal(getUpdateInfo().url);
  });
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Spawn-health diagnostics for the renderer banner — recomputed live so a
  // post-launch `electron-rebuild` clears the warning on the next poll.
  ipcMain.handle('diagnostics:get', () => {
    const d = collectSystemDiagnostics();
    return { ...d, warning: diagWarning(d), summary: diagSummary(d) };
  });

  ipcMain.handle('templates:list', () => templates.list());
  ipcMain.handle('templates:save', (_e, template) => { templates.save(template); return templates.list(); });
  ipcMain.handle('templates:remove', (_e, id) => { templates.remove(id); return templates.list(); });

  // Prompts library (~/.clodex/library/prompts/{system,append}/*.md). Both
  // Claude and Codex; referenced by session (system replaces, append composes).
  ipcMain.handle('prompts:list', (_e, kind) => promptLibrary.list(kind));
  ipcMain.handle('prompts:save', (_e, kind, name, body) => {
    try { return { ok: true, prompts: promptLibrary.save(kind, name, body) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('prompts:remove', (_e, kind, name) => {
    return { ok: true, prompts: promptLibrary.remove(kind, name) };
  });

  // Custom subagent library (~/.clodex/agents/*.md). Claude-only.
  ipcMain.handle('agents:list', () => agentLibrary.list());
  ipcMain.handle('agents:get', (_e, name) => agentLibrary.raw(name));
  ipcMain.handle('agents:save', (_e, name, content) => {
    try {
      const agents = agentLibrary.save(name, content);
      refreshAppMenu(); // Agents menu lists the library — keep it current.
      return { ok: true, agents };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('agents:remove', (_e, name) => {
    const agents = agentLibrary.remove(name);
    refreshAppMenu();
    return { ok: true, agents };
  });

  // Skill-injection library (~/.clodex/skills/*.md). Claude-only. Mirrors the
  // agents handlers; the Skills app menu lists this library, so save/remove
  // refresh the menu.
  ipcMain.handle('skilllib:list', () => skillLibrary.list());
  ipcMain.handle('skilllib:get', (_e, name) => skillLibrary.raw(name));
  ipcMain.handle('skilllib:save', (_e, name, content) => {
    try {
      const skills = skillLibrary.save(name, content);
      refreshAppMenu();
      return { ok: true, skills };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('skilllib:remove', (_e, name) => {
    const skills = skillLibrary.remove(name);
    refreshAppMenu();
    return { ok: true, skills };
  });
  ipcMain.handle('prompts:inject', (_e, name, body) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    manager._injectText(s, body);
    return { ok: true };
  });

  // Last-known proxy telemetry for a session — lets the renderer fill the
  // status bar immediately on attach/switch instead of waiting for the next poll.
  ipcMain.handle('proxy:snapshot', (_e, name) => proxyPoller.snapshot(name));

  // Fetch the per-line tool roster + context composition for a session
  // (wirescope /_context). Read-only; gated by the caller on the
  // context_view/context_composition capability. Uses the live record's
  // session_id (from the snapshot), never a possibly-stale persisted one.
  ipcMain.handle('proxy:context', (_e, name, opts) => fetchProxyContext(name, opts));

  // Fetch the on-demand per-session cost/efficiency report (wirescope /_report,
  // report_version 1). Disk-based on the proxy side, but we still resolve the
  // session_id from the live record and gate the caller on the
  // capabilities.context_report flag. detail=1 reserves the (v1.1) per-turn
  // series; harmless to pass against a v1 proxy that ignores it.
  ipcMain.handle('proxy:report', (_e, name, opts) => fetchProxyReport(name, opts));

  // On-demand cache-bust forensics for one session (the bust-inspector
  // popover). Resolves the live session_id from the poller snapshot (never a
  // stale persisted one), then fetches /_bust — the per-transition divergence
  // series. Heavy disk read, called only when the popover opens (same profile
  // as proxy:report), never in the 5s poll.
  ipcMain.handle('proxy:bust', (_e, name) => fetchProxyBust(name));

  // On-demand live-activity detail for one subagent row (the child popover).
  // Resolves the live session_id from the poller snapshot (never a stale
  // persisted one), then fetches /_subagents for the given child key. Called on
  // a 1-2s loop only while the popover is open — never in the 5s poll. A `found:
  // false` body is a normal outcome (child expired / session cold), surfaced as
  // ok:true with the proxy's reason so the popover can close gracefully.
  ipcMain.handle('proxy:subagentDetail', async (_e, name, child, maxlen) => {
    const s = manager.sessions.get(name);
    if (!s || !s.proxyBase) return { ok: false, error: 'Session is not routed through a proxy' };
    const snap = proxyPoller.snapshot(name);
    if (!snap || !snap.linked || !snap.sessionId) {
      return { ok: false, error: 'No live proxy session (unlinked)' };
    }
    if (typeof child !== 'string' || !child) return { ok: false, error: 'Missing child key' };
    try {
      const r = await ProxyClient.subagentDetail(s.proxyBase, snap.sessionId, child, maxlen);
      if (r.status !== 200 || !r.json) return { ok: false, error: `proxy returned ${r.status}` };
      return { ok: true, data: r.json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Open an external URL in the default browser (e.g. the proxy session page).
  // http(s) only — never hand arbitrary schemes to the OS opener.
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Open a wirescope page in an in-app, clodex-chromed window instead of the
  // system browser. backgroundColor is the caller's active theme `--bg` so the
  // frame matches; the page content stays wirescope's own.
  ipcMain.handle('app:openWirescope', (_e, url, backgroundColor) => {
    openWirescopeWindow(url, backgroundColor);
  });

  // Arm/disarm a cache hold for a session. Writes are gated: the session must
  // be routed AND exactly linked to a live proxy record (we use that record's
  // own session_id, never a possibly-stale persisted one), and the proxy must
  // advertise the hold capability. hours=0 disarms.
  ipcMain.handle('proxy:hold', async (_e, name, hours, force) => {
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

  // In-process twin of proxy:hold — arm/disarm the wire HoldKeeper (wire/hold.js)
  // for the session's wire-observed session_id. Same return contract as
  // proxy:hold so the renderer's doWarmHold works unchanged; which channel the
  // fire button uses is decided by the payload's holdSource (set by
  // WireTelemetry.overlay under CLODEX_WIRE_TELEMETRY). hours<=0 disarms;
  // arming is warm-gated like the proxy's (force is the only override).
  ipcMain.handle('wire:hold', (_e, name, hours, force) => {
    if (!manager._holdKeeper || !manager._wireTelemetry) {
      return { ok: false, error: 'In-process wire keep-warm is not running' };
    }
    const w = manager._wireTelemetry.payload(name);
    if (!w || !w.sessionId) {
      return { ok: false, error: 'The wire has not seen a turn for this session yet' };
    }
    try {
      const j = (hours > 0)
        ? manager._holdKeeper.arm(w.sessionId, hours, { force: !!force })
        : manager._holdKeeper.disarm(w.sessionId);
      return { ok: true, status: 200, armed: !!j.armed, skipped: j.skipped || null, body: j };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Set the per-session strip LEVEL (0 off / 1 thinking / 2 thinking + tool
  // results). Cumulative ladder. Persists our authoritative level (the proxy
  // overrides are in-memory) and pushes the level's wire state now. Level 2's
  // tool-result strip is gated on a separate capability and rejected until the
  // proxy advertises it (the menu disables it too).
  ipcMain.handle('proxy:setStripLevel', async (_e, name, level) => {
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
    // L2 (edit-acks + failed-call stubs) folds into strip_thinking as a level —
    // there is no separate capability. Gate on the advertised max_level.
    if (lvl === 2 && !(cap.max_level >= 2)) {
      return { ok: false, error: 'This proxy does not support level 2 stripping yet' };
    }
    persistence.setStripLevel(name, lvl);
    // A bottom-bar choice is also this agent name's standing default, so every
    // future session of that name (even after a kill that drops the sessions.json
    // entry) is seeded with it. Kill-proof; consulted only at session birth.
    agentDefaults.setStrip(name, lvl);
    proxyPoller.noteStripAsserted(name, snap.sessionId, lvl);
    try {
      // One /_strip mechanism, three levels: 0 clears, 1 strips thinking, 2 adds
      // edit-acks + failed-call stubs on top. At level 0, hold OFF with an explicit
      // 0-override when the proxy's global default is ON (else a clear reverts to it).
      const gd = (snap.strip && snap.strip.globalDefaultLevel) || 0;
      const r = await ProxyClient.stripThinking(s.proxyBase, snap.sessionId, lvl, lvl === 0 && gd >= 1);
      const j = r.json || {};
      return { ok: true, status: r.status, level: lvl, effective: !!j.effective, body: j };
    } catch (e) {
      // The push failed but our level is persisted; the poller will retry on the
      // next tick. Surface the error so the UI can flag it.
      proxyPoller.stripAsserted.delete(name);
      return { ok: false, error: e.message, level: lvl };
    }
  });

  // Editable args for the Edit Session dialog. The shape lives in main.js's
  // readSessionArgs (shared with the peer session-args GET endpoint so local +
  // remote reads can't drift); this handler is the thin local adapter.
  ipcMain.handle('session:getArgs', (_e, name) => readSessionArgs(name));

  // Past conversations for the session picker. Two tiers:
  //  - tracked: ids clodex observed live (persisted sessionIds ∪ current active
  //    id) — authoritative, correctly attributed even when agents share a cwd.
  //  - inferred: other recent transcripts sitting in the same project dir that
  //    clodex never observed (pre-feature history, or started outside clodex).
  //    Best-effort and flagged: a cwd shared by >1 agent can't be split, so
  //    these may belong to a sibling agent. The renderer renders them dimmed.
  ipcMain.handle('session:history', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found' };
    if (entry.type !== 'claude' && entry.type !== 'codex') return { ok: true, sessions: [], activeId: null };
    // Prefer the live symlink's real directory; fall back to the cwd→slug path.
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
    // Bootstrap: recent sibling transcripts we didn't observe (last 7 days).
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
  // --- Touched-files feed + peek/diff -----------------------------------
  // The feed is the session's in-memory ring (facts: tool + path + when, from
  // the wire receipts or the legacy jsonl tap). Peek/diff are read-only looks
  // at the CURRENT disk/git state — created-vs-modified truth comes from git
  // here, never from the feed.
  ipcMain.handle('session:files', (_e, name) => fetchSessionFiles(name));
  ipcMain.handle('file:peek', (_e, filePath) => fetchFilePeek(filePath));
  ipcMain.handle('file:diff', (_e, name, filePath) => fetchFileDiff(name, filePath));
  ipcMain.handle('file:open', (_e, filePath) => shell.openPath(filePath));

  // Focused per-session tool gating: persist disabledTools only (leaves
  // extraArgs/proxy/posture/agents untouched). Takes effect on next spawn;
  // the renderer calls session:restart afterward if the user wants it now.
  ipcMain.handle('session:setTools', (_e, name, disabledTools) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setDisabledTools(name, Array.isArray(disabledTools) ? disabledTools : []);
    return { ok: true };
  });
  // Focused per-session skill gating (mirror of setTools): persist disabledSkills
  // (+ optional injectSkills), applied on next spawn via skillOverrides. Thin
  // adapter over the shared main.js applySessionSkills — the peer session-skills
  // POST endpoint calls the same helper, keeping local + remote in lockstep.
  ipcMain.handle('session:setSkills', (_e, name, disabledSkills, injectSkills) =>
    applySessionSkills(name, disabledSkills, injectSkills));
  // Focused per-session agent composition (mirror of setSkills/setTools):
  // persist the enabled custom-subagent list + denyBuiltins only, leaving
  // extraArgs/proxy/posture/tools/skills untouched. Takes effect on the next
  // FRESH start — the agent roster, like skills, is frozen at conversation
  // creation, so --resume replays the old one (the popover does the fresh
  // restart when the user asks for it now).
  ipcMain.handle('session:setAgents', (_e, name, agents, denyBuiltins) => {
    if (!persistence.get(name)) return { ok: false, error: 'Session not found in persistence' };
    persistence.setAgents(name,
      Array.isArray(agents) ? agents : [],
      Array.isArray(denyBuiltins) ? denyBuiltins : []);
    return { ok: true };
  });
  // Agent catalog for the Agents popover. Unlike skills there's no transcript
  // roster or lower-layer/policy state to merge — built-ins are irreducible and
  // have no trim lever — so the catalog is simply the custom-subagent library
  // plus this session's persisted enabled set + denyBuiltins flag.
  ipcMain.handle('session:agentCatalog', (_e, name) => {
    const entry = persistence.get(name);
    if (!entry) return { ok: false, error: 'Session not found in persistence' };
    return {
      ok: true,
      // Scope-filtered offer list (same resolver the Edit Session agents catalog
      // uses) — a workspace/personal-scoped agent isn't offered to a session it
      // doesn't belong to. The drawer still shows everything (agentLibrary.list()).
      agents: agentLibrary.listFor(sessionScopeCtx(name)),
      enabled: Array.isArray(entry.agents) ? entry.agents : [],
      denyBuiltins: Array.isArray(entry.denyBuiltins) ? entry.denyBuiltins : [],
    };
  });
  // Skill catalog for the Skills popover (the static CLAUDE_SKILLS seed ∪ the live
  // transcript roster ∪ the persisted disabled set ∪ lower-layer overrides; never
  // empty for Claude). Thin adapter over the shared main.js readSkillCatalog — the
  // union logic lives there so the peer skill-catalog GET returns an identical shape.
  ipcMain.handle('session:skillCatalog', (_e, name) => readSkillCatalog(name));
  // Skill catalog for the NEW-SESSION dialog (no session/transcript yet, just a
  // chosen cwd). Static seed + whatever a lower settings layer for that cwd
  // already disables, with the same effective-state + provenance so a globally-
  // off skill renders disabled+labeled here too. This is the CLEAN trim path:
  // the skill roster is evaluated at conversation creation, so a fresh session
  // applies skillOverrides immediately — no restart/clear dance.
  ipcMain.handle('settings:skillCatalogFor', (_e, cwd) => {
    const eff = readEffectiveSkillState(cwd || null);
    const names = [...new Set([...CLAUDE_SKILLS, ...Object.keys(eff.overrides)])].sort();
    return { ok: true, names, effective: eff.overrides, skillsLocked: eff.skillsLocked, canReenable: SKILL_REENABLE_CONFIRMED };
  });
  // Tool provenance for the NEW-SESSION dialog (mirror of skillCatalogFor): the
  // tool list itself is the static CLAUDE_TOOLS seed (sent via getSettings), so
  // here we only need the per-cwd lower-layer deny state to render externally-
  // off tools as read-only + labeled before the session exists.
  ipcMain.handle('settings:toolCatalogFor', (_e, cwd) => {
    return { ok: true, effective: readEffectiveToolState(cwd || null).overrides };
  });

  // Apply edited args. The core (undefined-untouched semantics, stripLevel/label
  // re-assert, catch-and-upsert recovery) lives in main.js's applySessionArgs,
  // shared with the peer session-args POST endpoint. This handler maps the
  // positional IPC args to the patch object and supplies the sender's workspace
  // as the respawn target (the peer path passes the entry's own workspaceId).
  ipcMain.handle('session:setArgs', async (e, name, extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles) =>
    applySessionArgs(name, {
      extraArgs, restart, proxy, systemPrompt, agents, denyBuiltins,
      disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles,
    }, workspaceOfSender(e)));

  // Restart in place: kill the PTY and respawn with the persisted settings,
  // resuming the same conversation. Useful after a CLI upgrade, a global
  // preference change, or a wedged TUI. The core lives in restartSession()
  // (module scope) so the peer restart-session endpoint shares the exact
  // strip-level re-assert + failed-respawn safety net rather than duplicating
  // (and drifting from) it. The IPC handler only supplies the sender's
  // workspace as the respawn target.
  ipcMain.handle('session:restart', async (e, name, opts = {}) =>
    restartSession(name, opts, workspaceOfSender(e)));

  ipcMain.handle('settings:get', () => {
    const s = uiSettings.get();
    return {
      statusline: s.statusline,
      claudeComponents: CLAUDE_SL_COMPONENTS,
      codexComponents: CODEX_SL_COMPONENTS,
      claudeTools: CLAUDE_TOOLS,
      defaultToolDeny: agentDefaults.getDefaultDeny(),
      proxyEnabled: s.proxyEnabled,
      proxyUrl: s.proxyUrl,
      wirescopeDir: s.wirescopeDir,
      wirescopePort: s.wirescopePort,
      disableClaudeDesignMcp: s.disableClaudeDesignMcp,
      compactOnResume: s.compactOnResume,
      theme: s.theme,
      remoteEnabled: s.remoteEnabled,
      remotePort: s.remotePort,
      peers: s.peers,
    };
  });
  ipcMain.handle('settings:set', (_e, partial) => {
    const next = uiSettings.set(partial);
    rebuildAllStatusScripts(manager);
    // The Traffic optimization toggle is the proxy's single control: on brings
    // the managed wirescope up, off tears it down. stop() only ever kills OUR
    // child — an adopted external instance is never touched either way.
    if (wirescope.autoStartWanted()) wirescope.start().catch(() => {});
    else wirescope.stop();
    syncRemoteServer();
    syncPeerManager();
    return next;
  });

  // Remote access status for the prefs dialog: running/port/error. The URL
  // shown is the localhost one — off-machine reach is the user's tailnet.
  ipcMain.handle('remote:status', () => ({
    running: !!(getRemoteServer() && getRemoteServer().running),
    port: uiSettings.get().remotePort,
    error: getRemoteError(),
  }));

  // ---- Peer deploy wizard: probe a box, then install/update Clodex on it.
  // Tunnel-free — both ssh in and curl hello ON the box (see peer-deploy.js /
  // ssh-run.js). Classification + the deploy script live off-electron so they're
  // unit-tested; these handlers are the thin electron adapter.
  ipcMain.handle('peer:probe', async (_e, sshHost, port) => {
    if (!sshHost || typeof sshHost !== 'string') return { kind: 'ssh-fail', stderr: 'no ssh host given' };
    try {
      return await probePeer(sshHost, port || uiSettings.get().remotePort || 7900);
    } catch (e) {
      return { kind: 'ssh-fail', stderr: e && e.message ? e.message : 'probe failed' };
    }
  });

  // Run the idempotent deploy script on the box, streaming each stdout line to
  // the caller window as a `peer-deploy-line` event (the wizard parses ::markers
  // via peer-deploy.parseDeployLine). Resolves with { code, timedOut, stderr }:
  // code 0 = success, 42 = needs sudo (script emitted the exact commands as
  // ::need-sudo/::sudo-cmd lines), anything else = failure.
  ipcMain.handle('peer:deploy', async (e, sshHost, opts = {}) => {
    if (!sshHost || typeof sshHost !== 'string') return { ok: false, error: 'no ssh host given' };
    let script;
    try {
      script = fs.readFileSync(path.join(__dirname, 'peering', 'clodex-deploy.sh'), 'utf8');
    } catch (err) {
      return { ok: false, error: `deploy script unreadable: ${err.message}` };
    }
    // Params ride the environment the remote bash inherits — prepend exports so
    // the script's ${VAR:-default} reads them without changing its shebang line.
    const port = Number.isInteger(opts.port) ? opts.port : (uiSettings.get().remotePort || 7900);
    const repoUrl = typeof opts.repoUrl === 'string' && opts.repoUrl ? opts.repoUrl : `https://github.com/${UPDATE_REPO}`;
    const branch = typeof opts.branch === 'string' && opts.branch ? opts.branch : 'master';
    // Optional deploy-folder override → a CLODEX_SRC export appended to the
    // preamble. classifyDeployFolder renders the tilde/absolute forms safely; a
    // blank folder yields '' (script default stands). A malformed folder is a
    // hard stop BEFORE we ssh — the wizard validates too, but never trust the
    // renderer for a value that becomes a remote shell word.
    const srcClass = classifyDeployFolder(opts.folder);
    if (!srcClass.ok) return { ok: false, error: srcClass.error };
    const shellEsc = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    const srcExport = srcClass.srcExport ? ` ${srcClass.srcExport}` : '';
    const preamble =
      `export PORT=${shellEsc(port)} REPO_URL=${shellEsc(repoUrl)} BRANCH=${shellEsc(branch)}${srcExport}\n`;
    const wc = e.sender;
    try {
      const res = await sshRun(sshHost, preamble + script, {
        timeoutMs: 15 * 60 * 1000,       // a cold clone+install+rebuild can be minutes
        onLine: (line) => { try { if (!wc.isDestroyed()) wc.send('peer-deploy-line', sshHost, line); } catch {} },
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

  // Agent fallback for a failed deploy: spin up a local ad-hoc Claude session
  // (cwd = homedir, focused window's workspace) and hand it the deploy log +
  // playbook pointers so it can untangle the box. The briefing rides the spill
  // channel via _deliverMessage (>500B → file + @-attach). Injection is deferred
  // a beat so the fresh CLI has reached its input prompt before we type.
  ipcMain.handle('peer:deployFix', async (e, sshHost, port, label, logText) => {
    const host = typeof sshHost === 'string' ? sshHost : '';
    const p = Number.isInteger(port) ? port : (uiSettings.get().remotePort || 7900);
    const name = fixSessionName(label || host || 'peer', new Set(manager.sessions.keys()));
    const wsId = workspaceOfSender(e);
    const dir = os.homedir();
    try {
      const out = await manager.create(
        name, 'claude', dir, [], null, wsId,
        null, false, null, [], [], [], [], [], null, [],
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

  // ---- Peered Clodexes: renderer-facing thin adapter. All protocol,
  // reconnect and buffering logic lives in peer-client.js; events reach the
  // renderer as peer-state / peer-activity / peer-replay / peer-data /
  // peer-control / peer-exit broadcasts.
  ipcMain.handle('peer:list', () => {
    const out = getPeerManager() ? getPeerManager().statuses() : [];
    const tunnels = new Map((getTunnelManager() ? getTunnelManager().statuses() : []).map((t) => [t.id, t]));
    for (const st of out) st.tunnel = tunnels.get(st.id) || null;
    return out;
  });
  ipcMain.handle('peer:attach', (_e, id, name) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return { ok: false, error: 'no such peer' };
    const res = conn.attach(name);
    // Persist the attachment so the tab auto-restores on the next app launch.
    if (res && res.ok) {
      const map = { ...(uiSettings.get().peerAttached || {}) };
      const list = Array.isArray(map[id]) ? map[id] : [];
      if (!list.includes(name)) { map[id] = [...list, name]; uiSettings.set({ peerAttached: map }); }
    }
    return res;
  });
  ipcMain.handle('peer:detach', (_e, id, name) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return { ok: false, error: 'no such peer' };
    const res = conn.detach(name);
    // Explicit detach = user closed the tab: stop persisting it. Control implies
    // attachment, so a gone tab drops its control claim too.
    forgetPeerAttached(id, name);
    forgetPeerControlled(id, name);
    return res;
  });
  // Renderer reads this once at startup to seed its one-shot restore map.
  ipcMain.handle('peer:attachedNames', () => uiSettings.get().peerAttached || {});
  // Renderer prunes a persisted name that no longer exists on the live peer,
  // without a live connection to detach from.
  ipcMain.handle('peer:forgetAttached', (_e, id, name) => {
    forgetPeerAttached(id, name);
    return { ok: true };
  });
  // Pause/resume a peer WITHOUT deleting its config (disabled:true on the record).
  // A disabled peer is dropped from both syncs (syncPeerManager), so its tunnel +
  // connection tear down and a peer-removed sheds the UI tabs — but crucially this
  // path never calls forgetPeerAttached/forgetPeerControlled, so the persisted
  // attachments/claims survive for re-enable. The flag is broadcast to every window
  // BEFORE syncPeerManager runs, so each renderer marks the peer disabled ahead of
  // the peer-removed it triggers and soft-sheds (keeps the durable record) instead
  // of treating it as an explicit user detach.
  ipcMain.handle('peer:setDisabled', (_e, id, on) => {
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
  // Per-peer visibility selection. Renderer reads the whole map at startup and
  // keeps a local copy fresh from setVisible responses.
  ipcMain.handle('peer:visible', () => uiSettings.get().peerVisible || {});
  // names = array ⇒ restrict this peer to those names (empty = show none);
  // names = null ⇒ delete the key (back to show-all). Sanitized through the
  // same name regex the persistence layer enforces.
  ipcMain.handle('peer:setVisible', (_e, id, names) => {
    const map = { ...(uiSettings.get().peerVisible || {}) };
    if (names === null || names === undefined) {
      delete map[id];
    } else if (Array.isArray(names)) {
      map[id] = names.filter((n) => typeof n === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(n));
    } else {
      return { ok: false, error: 'names must be an array or null' };
    }
    uiSettings.set({ peerVisible: map });
    return { ok: true, peerVisible: map };
  });
  ipcMain.handle('peer:control', (_e, id, name, on) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.control(name, !!on, (res) => {
      // Persist the control claim on a successful take, drop it on a successful
      // release — so it auto-re-takes across a restart of this app OR the box.
      // (Mirrors peer:attach's inline persist.) A failed take never persists.
      if (res && res.ok) {
        if (on) rememberPeerControlled(id, name); else forgetPeerControlled(id, name);
      }
      resolve(res);
    });
  }));
  // Renderer reads this once at startup to seed its control-restore mirror.
  ipcMain.handle('peer:controlledNames', () => uiSettings.get().peerControlled || {});
  // Explicit drop of a persisted control claim — used when a restore re-acquire
  // finds the session is held by someone else (stale claim, don't retry-loop).
  ipcMain.handle('peer:forgetControlled', (_e, id, name) => {
    forgetPeerControlled(id, name);
    return { ok: true };
  });
  ipcMain.handle('peer:resize', (_e, id, name, cols, rows) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.resize(name, cols, rows, resolve);
  }));
  // Host-level remote restart of a peer's Clodex (restart-only, no self-update:
  // the operator git-pulls on the peer host, then triggers this to pick up the
  // new code). Authority is the tunnel, same as every other peer RPC; the
  // viewer fronts a confirm dialog for intentionality. The peer acks, then
  // quits + relaunches; its offline/online blip rides the existing reconnect.
  ipcMain.handle('peer:restart', (_e, id) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.restart(resolve);
  }));
  // Remote session create/kill on a peer — makes the Mac the cockpit for a
  // headless box. Trust is the tunnel (settled); the viewer fronts a dialog
  // (create) / confirm (kill) for intentionality. The ack carries the outcome.
  ipcMain.handle('peer:createSession', (_e, id, spec) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.createSession(spec || {}, resolve);
  }));
  ipcMain.handle('peer:killSession', (_e, id, name) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.killSession(String(name || ''), resolve);
  }));
  // Remote session restart on a peer — plain restart (keeps history) or a
  // fresh reload (new conversation, re-reads skills). The viewer fronts a
  // confirm only for the fresh variant, mirroring the local hard-restart.
  ipcMain.handle('peer:restartSession', (_e, id, name, opts) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.restartSession(String(name || ''), opts || {}, resolve);
  }));
  // Edit Session on a peer — read the box's editable args + catalogs, then apply
  // an edited patch. Gated in the UI on the 'args' cap (+ online); old boxes 501
  // and the affordance is hidden. Thin adapters over the peer-client request pair.
  ipcMain.handle('peer:sessionArgs', (_e, id, name) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.sessionArgs(String(name || ''), resolve);
  }));
  ipcMain.handle('peer:setSessionArgs', (_e, id, name, patch) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.setSessionArgs(String(name || ''), patch || {}, resolve);
  }));
  // Edit Skills on a peer — read the box's skill catalog, then persist an edited
  // disabled/inject set. Same 'args' cap + online gate as Edit Session; thin
  // adapters over the peer-client skill request pair.
  ipcMain.handle('peer:skillCatalog', (_e, id, name) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.skillCatalog(String(name || ''), resolve);
  }));
  ipcMain.handle('peer:setSessionSkills', (_e, id, name, disabledSkills, injectSkills) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.setSessionSkills(String(name || ''), disabledSkills, injectSkills, resolve);
  }));
  // Popover data for a peer session — one kind-dispatched pull, answered by
  // the owner from the same sources its own popups use.
  ipcMain.handle('peer:query', (_e, id, name, kind, args) => new Promise((resolve) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (!conn) return resolve({ ok: false, error: 'no such peer' });
    conn.query(name, String(kind || ''), args, resolve);
  }));
  // Keystrokes: fire-and-forget like local pty-input; a failed send surfaces
  // as the terminal simply not echoing.
  ipcMain.on('peer:input', (_e, id, name, data) => {
    const conn = getPeerManager() && getPeerManager().get(id);
    if (conn) conn.input(name, String(data ?? ''), () => {});
  });

  // Global default tool-deny set new sessions inherit (the "*" agent-default).
  // An explicit [] is honored (deny nothing); separate store from uiSettings, so
  // it gets its own setter. Returns the persisted set for the renderer to render.
  ipcMain.handle('defaults:setToolDeny', (_e, list) => {
    agentDefaults.setDefaultDeny(Array.isArray(list) ? list : []);
    return agentDefaults.getDefaultDeny();
  });

  // Theme set from a renderer's Preferences picker. The sender already applied
  // it locally, so skip echoing back to it; sync the other windows + menu.
  ipcMain.handle('theme:set', (e, name) => { setUiTheme(name, e.sender); });

  ipcMain.handle('wirescope:status', () => wirescope.status());
  ipcMain.handle('wirescope:start', () => wirescope.start());
  ipcMain.handle('wirescope:stop', () => wirescope.stop());
  ipcMain.handle('wirescope:restart', () => wirescope.restart());
  // Capture-log size/reclaimable readout. A non-200 / missing-endpoint result
  // (older proxy without /_prune) comes back ok:false → the renderer hides the
  // whole capture-logs affordance (presence IS the capability).
  ipcMain.handle('wirescope:pruneInfo', async () => {
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
  // Execute (or dry-run) a prune. opts: { olderThan, tier, scope, dryRun }.
  // wirescope enforces the safety guards (skips active/warm/recent); clodex just
  // relays and surfaces the result body.
  ipcMain.handle('wirescope:prune', async (_e, opts) => {
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

  ipcMain.handle('session:exportMarkdown', async (_e, name) => {
    const s = manager.sessions.get(name);
    if (!s) return { ok: false, error: 'Session not found' };
    if (!s.agentType) return { ok: false, error: 'Export only works for agent sessions' };

    // Resolve the JSONL file via the symlink
    const linkPath = pathFor(REGISTRY_DIR, name, 'transcript');
    let jsonlPath;
    try {
      jsonlPath = fs.realpathSync(linkPath);
    } catch {
      return { ok: false, error: 'No transcript found yet — wait until the agent has responded at least once.' };
    }

    // Ask user where to save
    const defaultPath = path.join(
      app.getPath('desktop'),
      `${name}-${new Date().toISOString().slice(0, 10)}.md`,
    );
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
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

  ipcMain.on('session:context-menu', (e, { name, cwd }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    // Quick prompt picker — set the session's system/append prompt refs without
    // opening the Edit Session dialog. Persists immediately + applies on next
    // (re)start; the renderer is told so it can offer to restart now.
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
    const menu = Menu.buildFromTemplate([
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
        click: () => { if (cwd) shell.showItemInFolder(cwd); },
      },
      {
        label: 'Open in Terminal',
        enabled: !!cwd,
        click: () => {
          if (!cwd) return;
          // Open Terminal.app at the cwd
          const { exec } = require('child_process');
          exec(`open -a Terminal "${cwd.replace(/"/g, '\\"')}"`);
        },
      },
      { type: 'separator' },
      {
        label: 'Export Conversation as Markdown…',
        click: () => e.sender.send('session:context-action', { action: 'export', name }),
      },
      { type: 'separator' },
      {
        label: 'Kill Session',
        click: () => e.sender.send('session:context-action', { action: 'kill', name }),
      },
    ]);
    menu.popup({ window: win });
  });

  // Peer session rows get their own menu — the verbs (attach/control/detach/
  // hide) differ entirely from a local session's, so it's a separate template
  // rather than an overload. State is supplied by the renderer (the source of
  // truth for attach/control lives there, not in persistence); we only render.
  ipcMain.on('peer:context-menu', (e, st) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { id, name, online, attached, controlled, holder, canCreate, canArgs, hostLabel, type } = st || {};
    const act = (action) => () => e.sender.send('peer:context-action', { action, id, name });
    const template = [];
    // Who holds it, when it's not us — informational, like the peer bar. Take
    // control stays enabled (acquire is last-wins), matching the bar.
    if (holder && !controlled) {
      template.push({ label: `Controlled by ${holder}`, enabled: false });
      template.push({ type: 'separator' });
    }
    if (!attached) {
      template.push({ label: 'Attach', click: act('attach') });
      template.push({ label: 'Take control', enabled: !!online, click: act('takeControl') });
    } else if (controlled) {
      template.push({ label: 'Release control', click: act('releaseControl') });
      template.push({ label: 'Detach (keep listed)', click: act('detach') });
    } else {
      template.push({ label: 'Take control', enabled: !!online, click: act('takeControl') });
      template.push({ label: 'Detach (keep listed)', click: act('detach') });
    }
    template.push({ type: 'separator' });
    template.push({ label: 'Hide from list', click: act('hide') });
    // Host-level lifecycle on the peer — restart/reload/kill. All gated on the
    // create capability (they ship together) + peer online. Restart mirrors the
    // local pair: a plain restart (--resume, keeps history, no confirm) and a
    // fresh reload (new conversation, re-reads skills, confirmed in the renderer
    // like doHardRestart). Kill is the destructive removal (no resume).
    // Edit Session — remote args editing (the 'args' cap). Opens the shared dialog
    // populated from the box's catalogs; online-gated (needs a live read/respawn).
    if (canArgs) {
      template.push({ type: 'separator' });
      template.push({
        label: `Edit Session "${name}" on ${hostLabel || 'peer'}…`,
        enabled: !!online,
        click: act('editArgs'),
      });
      // Edit Skills rides the SAME 'args' cap. Skills are Claude-only (the local
      // popover is gated on type==='claude'), so offer it for claude sessions only.
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
      // Fresh reload = new conversation + skill re-read: meaningless for bash
      // (no conversation/roster), so it's offered for agents only.
      if (type !== 'bash') {
        template.push({
          label: `Reload "${name}" on ${hostLabel || 'peer'} (fresh)…`,
          enabled: !!online,
          click: act('reloadRemote'),
        });
      }
      template.push({ type: 'separator' });
      template.push({
        label: `Kill "${name}" on ${hostLabel || 'peer'}`,
        enabled: !!online,
        click: act('killRemote'),
      });
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Peer HEADER right-click: host-level actions (remote restart today). Distinct
  // from the per-session menu above — restart is host-scoped. The label rides
  // through as `name` so the renderer's confirm/toast can address the peer; the
  // action reuses the same peer:context-action channel. Restart needs the peer
  // online (a down peer has nothing to restart — the process-gone case is out
  // of scope).
  // Deploy target for a peer id — the SINGLE resolver both the popover's Update
  // button (peer:deployConfig) and the header-menu "Update Clodex…" item read,
  // so the folder-precedence rule lives in exactly one place. { sshHost, port,
  // folder } for an ssh-reachable peer, or null (url-only / unknown id) so the
  // caller hides Update. folder follows resolveDeployFolder: the box's live
  // self-reported srcDir wins over the persisted deployFolder guess (a stale
  // guess must not shadow live truth), which wins over '' (script default).
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
  ipcMain.handle('peer:deployConfig', (_e, id) => deployTargetFor(id));

  ipcMain.on('peer:header-menu', (e, st) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { id, label, online, canCreate, sev } = st || {};
    const template = [];
    // Create is gated on the peer advertising the 'create' capability (older
    // peers 501 the endpoint); the renderer passes canCreate from st.caps.
    if (canCreate) {
      template.push({
        label: `New Session on ${label || 'peer'}…`,
        enabled: !!online,
        click: () => e.sender.send('peer:context-action', { action: 'newSession', id, name: label }),
      });
      template.push({ type: 'separator' });
    }
    template.push({
      label: `Restart Clodex on ${label || 'peer'}`,
      enabled: !!online,
      click: () => e.sender.send('peer:context-action', { action: 'restart', id, name: label }),
    });
    // "Update Clodex on <box>…" re-runs the idempotent deploy script over ssh.
    // Only offered for peers reached via an ssh host (a url-only peer has no ssh
    // route) and only when online (nothing to update on an unreachable box).
    // Same deployTargetFor resolver as the popover — reported srcDir wins. Also
    // gated on severity (updateApplies): hidden for a same-version or ahead box,
    // the renderer passes sev from the header row it already computed.
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
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Native confirm for remote restart — mirrors dialog:confirmKill. The peer's
  // sessions resume via the normal quit/restore lifecycle, so the copy says so.
  ipcMain.handle('dialog:confirmPeerRestart', async (_e, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Restart Clodex on ${label || 'this peer'}?`,
      detail: 'The remote app will quit and reopen. Its sessions will resume after the restart.',
    });
    return result.response === 0;
  });

  // Native confirm for the in-place update (re-run the deploy script over ssh).
  // Cancel default; the box's app restarts on success, so the copy says so.
  ipcMain.handle('dialog:confirmPeerUpdate', async (_e, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Update', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Update Clodex on ${label || 'this peer'}?`,
      detail: 'Re-runs the deploy script over ssh (git pull → build → restart). Safe and idempotent; it can take a few minutes. The box restarts on success and its sessions resume.',
    });
    return result.response === 0;
  });

  // Native confirm for the agent fallback after a failed deploy — opens a local
  // ad-hoc Claude session to untangle the box. Cancel default.
  ipcMain.handle('dialog:confirmDeployFix', async (_e, sshHost) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Open agent session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Open an agent session to fix this?',
      detail: `Creates a local Claude session briefed with the deploy log and the playbook for ${sshHost || 'the box'}, so it can ssh in and finish the install.`,
    });
    return result.response === 0;
  });

  // Native confirm for killing a session ON a peer — destructive (removes it on
  // the remote box, no resume), distinct from local Detach/Hide. Mirrors
  // confirmKill's copy but names the host so it's unmistakably the remote one.
  ipcMain.handle('dialog:confirmPeerKill', async (_e, name, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'warning',
      buttons: ['Kill', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Kill session "${name}" on ${label || 'the peer'}?`,
      detail: 'This ends the agent process on the remote box and removes it — it will not resume.',
    });
    return result.response === 0;
  });

  // Native confirm for a fresh peer reload — mirrors doHardRestart's copy
  // (new conversation, CLI re-reads skills/tools/settings; old convo stays in
  // 🕘 history). Plain peer restart has NO confirm, parity with the local plain
  // restart; only the fresh variant (which drops the live conversation) asks.
  ipcMain.handle('dialog:confirmPeerReload', async (_e, name, label) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'question',
      buttons: ['Reload', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Reload "${name}" on ${label || 'the peer'} with a fresh conversation?`,
      detail: 'Starts a new conversation so the CLI reloads tools, skills, and settings from disk '
        + '(a plain restart keeps the old roster). The current conversation isn\'t lost — it stays '
        + 'available under 🕘 history on the remote box.',
    });
    return result.response === 0;
  });

  ipcMain.handle('dialog:confirmKill', async (_e, name) => {
    const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
      type: 'warning',
      buttons: ['Kill', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Kill session "${name}"?`,
      detail: 'This ends the agent process. The conversation history is preserved and can be resumed later.',
    });
    return result.response === 0;
  });

  ipcMain.on('pty-input', (_e, name, data) => {
    manager.write(name, data);
  });

  // Renderer tells us it's ready — restore sessions for its workspace.
  // Sessions already running (this can happen for the default workspace on
  // second window creation via tray) are returned as-is so the renderer can
  // render them without double-spawning.
  const readCtxFor = (name) => {
    try {
      const c = parseCtxFile(fs.readFileSync(pathFor(REGISTRY_DIR, name, 'ctx'), 'utf-8'));
      return { ctx: c.pct, ctxTok: c.tok, ctxSize: c.size };
    } catch { return { ctx: null, ctxTok: null, ctxSize: null }; }
  };

  ipcMain.handle('app:restore-sessions', async (e) => {
    const workspaceId = workspaceOfSender(e);
    const saved = persistence.listForWorkspace(workspaceId);
    const restored = [];
    for (const entry of saved) {
      if (manager.sessions.has(entry.name)) {
        // Already running — report it and flush any buffered output so the
        // new terminal shows everything that happened while detached
        const session = manager.sessions.get(entry.name);
        const replay = session.pendingOutput || null;
        session.pendingOutput = '';
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          replay,
          // Seed the sidebar dot with the CURRENT state — activity events
          // while detached were dropped, so without this a busy or blocked
          // session reattaches showing idle grey until its next transition.
          activity: session.activityState || 'idle',
          attention: session.needsAttention || null,
          ...readCtxFor(entry.name),
          proxy: proxyPoller.snapshot(entry.name),
        });
        continue;
      }
      try {
        // Resume-time bake (opt-in, fail-safe): slim the transcript before
        // --resume so the replayed prefix is small + permanently slimmer. Safe
        // regardless of cache warmth — the bake is byte-identical to the live
        // wire (bake ⊆ live-strip), so it can't bust a warm prefix. No-op unless
        // the compactOnResume setting + a live wirescope are both present.
        await maybeCompactBeforeResume(entry);
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
        );
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          ...readCtxFor(entry.name),
          proxy: proxyPoller.snapshot(entry.name),
        });
      } catch (err) {
        // DO NOT remove from persistence — surface the failure to the UI
        // so the user can retry or delete. Silently wiping was the cause
        // of the "agents vanish after upgrade" bug.
        console.error(`Failed to restore session ${entry.name}:`, err.message);
        log.error('session', `restore failed ${entry.name}: ${err.message}`);
        restored.push({
          name: entry.name,
          type: entry.type,
          cwd: entry.cwd,
          label: entry.label || null,
          failed: true,
          error: err.message,
        });
      }
    }
    return restored;
  });

  // Retry spawning a session that failed during restore
  ipcMain.handle('session:retrySpawn', async (e, name) => {
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
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // "Forget" a session — remove from persistence without killing (it's not running)
  ipcMain.handle('session:forget', (_e, name) => {
    persistence.remove(name);
    return true;
  });

  // Workspace management
  ipcMain.handle('workspace:list', () => workspaces.list());
  ipcMain.handle('workspace:current', (e) => workspaceOfSender(e));
  ipcMain.handle('workspace:setName', (e, name) => {
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
  ipcMain.handle('workspace:new', () => {
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createWindow(id);
    refreshAppMenu();
    refreshTrayMenu();
  });
}

module.exports = { registerIpcHandlers };
