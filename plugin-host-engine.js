'use strict';
// plugin-host-engine.js — the ENGINE half of the plugin host (docs/plugin-plan.md
// §3.2/§3.3/§3.4). `createPluginHostEngine(deps)` returns the object the engine
// hands to ipc-handlers as `getPluginHost()`, and the per-plugin `host` object
// each plugin's `activate(host)` receives.
//
// Electron-free, deps-object factory — the same convention as session-manager.js
// and every other M3 module, for the same reason: the headless host stands this
// up with no Electron at all, and a plugin engine half inherits that constraint
// (test/electron-boundary.test.js walks plugins/*/engine.js).
//
// ── The three laws this file exists to enforce by construction ──────────────
//
// 1. NO UNQUALIFIED `list()`. The API offers `listAll()` and `listWorkspace(id)`
//    and nothing else. `manager.list()` is GLOBAL; `session:list` — what the
//    sidebar actually shows — is `manager.listForWorkspace(workspaceOfSender(e))`,
//    i.e. workspace-scoped. Conflating them silently converts a per-window
//    dropdown into a cross-workspace surface, and `fsScope` would NOT catch it:
//    fsScope refuses PEERS, not foreign workspaces. A default-named `list()`
//    makes the wrong one the easy one, so it does not exist here.
//
// 2. EVENTS ARE UNBUFFERED HINTS WITH MANDATORY SCOPE. `emit` requires a scope
//    and drops when the target window is closed — only pty-data ever buffers.
//    A plugin therefore CANNOT correctly maintain renderer state by delta, which
//    is deliberate: state is pulled on window open / surface open / reattach.
//    `'all'` reaches every workspace, so it carries invalidation hints only.
//
// 3. `onExit` IS SYNC-ONLY AND POSITIONED. See the hook spec below — it fires
//    after the exit broadcast and before `_cleanup(name)`, inside the documented
//    landmine ordering that a plugin must not be able to re-break.

const {
  HOST_API_VERSION, isValidPluginId, namespaced, HOST_PSEUDO_ID,
  NO_SUCH_METHOD, errorEnvelope,
} = require('./plugin-api');
// The intent grammar table (§2.3). `registerIntent` enforces rules P1/P5 itself;
// `unregisterSource` is the belt to the per-registration ledger's braces, so a
// plugin that somehow leaks a row still loses it at deactivation.
const { registerIntent, unregisterSource } = require('./intent-registry');

function createPluginHostEngine(deps) {
  const {
    manager,          // SessionManager — reached ONLY through the facade below
    getUiSettings,    // getter: assigned in the bootstrap, like every store seam
    log,
    userDataPath,     // createEngine's param — host.paths.dataDir derives from it
    fs, path,
    gitWorktree,      // the sanctioned shared leaf exposed as host.lib
    gitScm,           // TEMPORARY (W2→W4) — see the `lib` registration below
    fsExplorer,       // TEMPORARY (W2→W4) — ditto
    telemetrySnapshot, // proxyPoller.snapshot passthrough — read-only, may be null
    getLoader,        // getter: the plugin loader (Phase 2). Absent ⇒ Phase-1
                      // behavior — disable works, enable refuses, nothing loads.
  } = deps;

  // ── The dispatch map (§3.4) ────────────────────────────────────────────────
  // ONE Map, keyed `"<pluginId>:<method>"`, mutated by register/dispose/disable.
  // This is the entire reason the transport is a single multiplexed channel: the
  // injected transport has NO removeHandler, so a per-plugin ipcMain channel
  // could never be unregistered and `dispose()` would be a lie at every level of
  // the API. Mutating a Map is a disposal primitive; unregistering a channel is
  // not available to us. Everything disposable in this file bottoms out here.
  const dispatchMap = new Map();

  // Per-plugin teardown ledgers: everything the host handed out on behalf of a
  // plugin, so `deactivate` tears down regardless of what the plugin's own
  // `deactivate()` does or forgets. Host-driven teardown never trusts the plugin.
  const teardowns = new Map();   // pluginId -> Set<fn>
  const registered = new Map();  // pluginId -> manifest-ish record

  function ledger(pluginId) {
    if (!teardowns.has(pluginId)) teardowns.set(pluginId, new Set());
    return teardowns.get(pluginId);
  }
  // Wrap a disposer so it is (a) idempotent and (b) removed from the ledger when
  // called directly, so a plugin that disposes eagerly doesn't leave a stale
  // entry that fires again at deactivate.
  function disposable(pluginId, fn) {
    let done = false;
    const d = () => {
      if (done) return;
      done = true;
      ledger(pluginId).delete(d);
      try { fn(); } catch (e) { logFor(pluginId).info(`dispose failed: ${e && e.message}`); }
    };
    ledger(pluginId).add(d);
    return d;
  }

  function logFor(pluginId) {
    const scope = `plugin:${pluginId}`;
    return {
      info: (msg) => { try { log.info(scope, String(msg)); } catch {} },
      error: (msg) => { try { log.info(scope, `ERROR ${msg}`); } catch {} },
    };
  }

  // ── Session hooks (§3.2) ───────────────────────────────────────────────────
  // session-manager calls these two through injected deps. Subscriber sets are
  // module-level here (not per-plugin) so the manager has ONE thing to call; the
  // per-plugin ledger holds the unsubscribe.
  const createHooks = new Set();
  const exitHooks = new Set();

  // Run a hook set with the landmine discipline (§3.2, MUST-FIX 4):
  //   * every subscriber in its own try/catch — a throwing plugin must not take
  //     down PTY teardown, which is mid-flight through the exit landmine;
  //   * SYNC ONLY — a thenable return is a contract violation, logged and
  //     ignored. The hook's whole correctness is that it completes BEFORE
  //     `_cleanup(name)` runs. An async subscriber would resume after cleanup,
  //     observing a session already dropped from the map — i.e. it would silently
  //     re-break the exact ordering the hook was placed to respect. Rejecting it
  //     loudly is the only way a plugin cannot re-break it.
  function runHooks(set, label, arg) {
    for (const fn of set) {
      try {
        const r = fn(arg);
        if (r && typeof r.then === 'function') {
          try { log.info('plugin', `contract violation: ${label} subscriber returned a thenable — the hook is SYNCHRONOUS by definition (docs/plugin-plan.md §3.2); its result is ignored`); } catch {}
        }
      } catch (e) {
        try { log.info('plugin', `${label} subscriber threw (ignored): ${e && e.message}`); } catch {}
      }
    }
  }

  // The two entry points session-manager.js calls. Exposed on the returned host
  // object (NOT on the per-plugin `host`) — plugins subscribe, core fires.
  const hooks = {
    fireCreate(name) { runHooks(createHooks, 'sessions.onCreate', sessionHandle(name)); },
    // Called from inside ptyProc.onExit, AFTER the session-exit send + exit
    // ipc-message broadcast, BEFORE _cleanup(name). The handle is already _dead
    // (onExit sets it first thing), so isAlive() is false and inject() no-ops —
    // both are the honest answers, not degradations.
    //
    // Documented, not hidden: for a naturally-exited BASH session the persistence
    // entry has ALREADY been removed by the time this fires (the removal sits
    // just above the _cleanup call). A plugin keying durable state off a session
    // name must not expect to find a persistence record here.
    fireExit(name) { runHooks(exitHooks, 'sessions.onExit', sessionHandle(name)); },
    // Mint a handle for session-manager's plugin-intent dispatch tail (R-INT-2).
    // Exposed HERE rather than reimplemented there so the handle's shape has one
    // owner — a second copy in session-manager would drift the moment §3.2 grows
    // a method.
    handleFor(name) { return sessionHandle(name); },
  };

  // ── SessionHandle (§3.2) ───────────────────────────────────────────────────
  // Opaque and small, lifted from the window-bridge charter's five-handle-methods
  // discipline. No raw session object, no `pty`, no persistence entry ever
  // crosses this line. Anything a plugin needs beyond this is a deliberate future
  // host addition — never a reach-in.
  function sessionHandle(name) {
    const s = manager.sessions.get(name);
    if (!s) return null;
    // Identity is snapshotted at mint: cwd/workspaceId are stable for the life of
    // a session, and freezing them means a handle held across an exit still
    // reports what the session WAS rather than throwing on a dropped map entry.
    return Object.freeze({
      name: s.name,
      type: s.type,
      cwd: s.cwd,
      workspaceId: s.workspaceId,
      isAlive() {
        const cur = manager.sessions.get(name);
        return !!cur && !cur._dead;
      },
      // Safe no-op on a dead session: _injectText's first line is `if
      // (session._dead) return;`. parkable defaults TRUE, matching the exec reply
      // convention — a plugin's reply to an agent is conversational traffic and
      // should park rather than interrupt a live turn.
      inject(text, opts = {}) {
        const cur = manager.sessions.get(name);
        if (!cur) return;
        manager._injectText(cur, String(text), { parkable: opts.parkable !== false });
      },
    });
  }

  // ── The per-plugin host object (§3.2) ──────────────────────────────────────
  function buildHost(pluginId) {
    const plog = logFor(pluginId);
    const dataDir = path.join(userDataPath, 'plugins', pluginId);

    // Whole-file JSON at dataDir/state.json, tmp+rename atomic (the team-manifest
    // pattern). Deliberately NOT a store: plugin state must not share a file with
    // core persistence, so a corrupt plugin write can never damage sessions.json.
    const statePath = path.join(dataDir, 'state.json');
    const storage = {
      get() {
        try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; }
      },
      set(obj) {
        try {
          fs.mkdirSync(dataDir, { recursive: true });
          const tmp = `${statePath}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(obj ?? {}, null, 2));
          fs.renameSync(tmp, statePath);
          return true;
        } catch (e) { plog.error(`storage.set failed: ${e && e.message}`); return false; }
      },
    };

    // uiSettings.plugins[pluginId] — shallow-merge patches, the store's own
    // get()/set(patch) semantics one level down.
    const settings = {
      get() {
        const all = getUiSettings().get().plugins;
        const mine = all && all[pluginId];
        return (mine && typeof mine === 'object') ? { ...mine } : {};
      },
      set(patch) {
        const ui = getUiSettings();
        const all = ui.get().plugins || {};
        const next = { ...all, [pluginId]: { ...(all[pluginId] || {}), ...(patch || {}) } };
        ui.set({ plugins: next });
        return true;
      },
    };

    return Object.freeze({
      id: pluginId,
      hostApiVersion: HOST_API_VERSION,
      log: plog,
      paths: Object.freeze({ dataDir }),
      storage,
      settings,

      sessions: Object.freeze({
        // GLOBAL. See law 1 — named so the caller must mean it.
        listAll: () => manager.list(),
        // WORKSPACE-SCOPED. What the sidebar and every per-window dropdown want.
        listWorkspace: (wsId) => manager.listForWorkspace(wsId),
        get: (name) => sessionHandle(name),
        // The locality refusal as a HOST GUARANTEE (MUST-FIX 5), reproducing the
        // sessionCwd guard in ipc-handlers verbatim. It lives here so a buggy or
        // careless plugin CANNOT widen locality: every filesystem-touching plugin
        // handler's first line is this call, and the refusal is not its code.
        // Note this refuses PEERS, not foreign workspaces — scoping across
        // workspaces is listWorkspace's job, not this one's.
        fsScope: (name) => {
          const s = manager.sessions.get(name);
          if (!s) return { error: 'Session not found' };
          if (s.peer) return { error: 'remote' }; // peer sessions have no local fs
          if (!s.cwd) return { error: 'Session has no working directory' };
          return { cwd: s.cwd };
        },
        onCreate: (fn) => {
          createHooks.add(fn);
          return disposable(pluginId, () => createHooks.delete(fn));
        },
        onExit: (fn) => {
          exitHooks.add(fn);
          return disposable(pluginId, () => exitHooks.delete(fn));
        },
      }),

      // ── ipc (§3.4) ─────────────────────────────────────────────────────────
      // `method` is namespaced by pluginId here, never by the plugin, so two
      // plugins cannot collide and a dispatch key always names its owner.
      ipc: Object.freeze({
        handle: (method, fn) => {
          const key = namespaced(pluginId, method);
          dispatchMap.set(key, fn);
          return disposable(pluginId, () => dispatchMap.delete(key));
        },
      }),

      // ── intents (§2.3) ─────────────────────────────────────────────────────
      // Register an `[agent:<verb>]` grammar row. The rules that make this safe
      // (P1 forced-privileged, P5 namespace/collision) are enforced INSIDE
      // intent-registry, not here, because the same rules must hold for any other
      // caller — this is a pass-through with the plugin's id attached, plus the
      // teardown ledger every other registration goes through.
      //
      // Throws on a bad shape or a collision. That is deliberate: a refused verb
      // is an activation error the plugin author must see, and swallowing it
      // would leave a plugin believing it owns a verb that never fires.
      intents: Object.freeze({
        register: (row) => {
          const undo = registerIntent(row, pluginId);
          return disposable(pluginId, undo);
        },
      }),

      // ── events (§3.3) ──────────────────────────────────────────────────────
      // Scope is REQUIRED — there is no default, because every plausible default
      // is wrong: 'all' leaks across workspaces, and any session/workspace guess
      // silently drops. An omitted scope is a logged no-op, not a broadcast.
      events: Object.freeze({
        emit: (topic, payload, scope) => emitScoped(pluginId, topic, payload, scope),
      }),

      // Sanctioned shared pure leaves — frozen, named, versioned. The rejected
      // alternatives were a private copy (drifts) and a raw relative require
      // (which the no-backdoor lint exists to kill).
      //
      // `gitWorktree` is PERMANENT: git-worktree.js stays core because the
      // New-Session worktree row and the delete flow's removeWorktree depend on
      // it (§4 W5).
      //
      // `gitScm` and `fsExplorer` are **TEMPORARY — DELETED IN W5**. They exist
      // only so W2 (the DOM move) can land as its own revertable commit: the
      // moment the workbench's DOM lives in the plugin, its data calls must go
      // through `rhost.invoke` → engine rows, and those rows must call something
      // — but git-scm.js / fs-explorer.js are still at the core root, where the
      // no-backdoor lint forbids the plugin from requiring them. Without these
      // two entries W2+W4+W5+W6 would have to land as ONE commit. W5 moves both
      // files into plugins/workbench/, switches that plugin to a local
      // `require('./git-scm')`, and removes these two lines. They are NOT
      // permanent host API.
      lib: Object.freeze({ gitWorktree, gitScm, fsExplorer }),

      // Read-only, may be null (no proxy linked / no telemetry for this session).
      telemetry: Object.freeze({
        snapshot: (name) => {
          try { return telemetrySnapshot ? telemetrySnapshot(name) : null; } catch { return null; }
        },
      }),
    });
  }

  // Scoped emit (§3.3). Every branch inherits core's documented drop semantics —
  // a closed window means the event is GONE, and that is precisely why the
  // contract says pull-on-open rather than maintain-by-delta.
  function emitScoped(pluginId, topic, payload, scope) {
    const t = String(topic);
    if (scope === 'all') {
      // Invalidation hints ONLY — a broadcast reaches every workspace, so a data
      // payload here is a cross-workspace leak. The contract bans it; this is
      // where a reviewer should look if one appears.
      manager._broadcast('plugin-event', pluginId, t, payload);
      return true;
    }
    if (scope && typeof scope === 'object' && scope.session) {
      manager._sendToSession(String(scope.session), 'plugin-event', pluginId, t, payload);
      return true;
    }
    if (scope && typeof scope === 'object' && scope.workspace) {
      const win = manager.windowForWorkspace(String(scope.workspace));
      if (win) win.webContents.send('plugin-event', pluginId, t, payload);
      return true;
    }
    logFor(pluginId).error(`events.emit('${t}') dropped — scope is REQUIRED and must be 'all', { session }, or { workspace } (docs/plugin-plan.md §3.3)`);
    return false;
  }

  // ── Registration + lifecycle ───────────────────────────────────────────────
  // Phase 1 ships NO plugins: core populates the registries and the loader that
  // walks plugins/*/manifest.json is Phase 2. `register` is the seam that loader
  // will call, and the in-tests fake plugin drives today.
  function register(pluginId, mod, manifest = {}) {
    if (!isValidPluginId(pluginId)) throw new Error(`invalid plugin id: ${pluginId}`);
    if (registered.has(pluginId)) throw new Error(`plugin already registered: ${pluginId}`);
    const want = String(manifest.hostApi ?? HOST_API_VERSION);
    if (want !== HOST_API_VERSION) {
      // Named error, not a half-activation against a surface the plugin predates.
      throw new Error(`plugin ${pluginId} wants hostApi "${want}" but this host is "${HOST_API_VERSION}"`);
    }
    registered.set(pluginId, { id: pluginId, manifest, mod });
    const host = buildHost(pluginId);
    try {
      if (mod && typeof mod.activate === 'function') mod.activate(host);
    } catch (e) {
      logFor(pluginId).error(`activate failed: ${e && e.message}`);
      deactivate(pluginId);
      throw e;
    }
    return host;
  }

  // Best-effort plugin teardown, then UNCONDITIONAL host teardown. The order
  // matters: the plugin gets to release its own resources first, but whether it
  // does or not, every dispatch entry / hook / registry row the host handed out
  // on its behalf goes away. The honest full-unload is still the restart
  // boundary (Tier A is in-process JS); this is the reachable part.
  function deactivate(pluginId) {
    const rec = registered.get(pluginId);
    if (rec && rec.mod && typeof rec.mod.deactivate === 'function') {
      try { rec.mod.deactivate(); } catch (e) { logFor(pluginId).error(`deactivate threw (ignored): ${e && e.message}`); }
    }
    for (const d of [...ledger(pluginId)]) d();
    // Belt to the ledger's braces: intent rows live in a MODULE-level table (that
    // is what makes a plugin verb live on all three feeds), so a row that escaped
    // the ledger would outlive its plugin and keep parsing into a dead handler.
    unregisterSource(pluginId);
    teardowns.delete(pluginId);
    registered.delete(pluginId);
    return true;
  }

  // ── Host services on the `_host` pseudo-id (§2.5) ──────────────────────────
  // The renderer's settings sections persist through the SAME one multiplexed
  // channel rather than a channel of their own. Deliberately NOT in dispatchMap:
  // these are host services, not plugin registrations — they belong to no
  // plugin's teardown ledger and must never be disposable. `pluginId` is an
  // argument, and an unregistered one is refused, so a renderer cannot write
  // settings for a plugin that isn't loaded.
  const hostMethods = {
    'settings.get': (pluginId) => {
      if (!registered.has(String(pluginId))) return errorEnvelope('no such plugin');
      return { ok: true, values: buildHost(String(pluginId)).settings.get() };
    },
    'settings.set': (pluginId, patch) => {
      if (!registered.has(String(pluginId))) return errorEnvelope('no such plugin');
      buildHost(String(pluginId)).settings.set(patch);
      return { ok: true };
    },
    // What a WINDOW needs to activate a plugin's renderer half: the module path
    // to require and the plugin's stylesheet TEXT (§2.6 injects a per-plugin
    // <style>, and text works identically in the file:// window and the web
    // bundle where no path resolves).
    //
    // This rides the `_host` pseudo-id rather than becoming a sixth api-contract
    // row BECAUSE §1 freezes the plugin transport at five rows for every plugin
    // forever. A new row here would be the first crack in that, for something
    // that is by definition host plumbing, not a plugin's own method.
    'renderer.info': (pluginId) => {
      if (!registered.has(String(pluginId))) return errorEnvelope('no such plugin');
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const info = loader.rendererInfo(String(pluginId));
      return info ? { ok: true, ...info } : errorEnvelope('no such plugin');
    },
  };

  // Named rather than returned anonymously: `setEnabled` hands this same object
  // to the loader as the host to register INTO, so the loader has exactly the
  // surface ipc-handlers has and no more.
  const api = {
    // ── The ipc-handlers surface (the four Phase-0 handlers call these) ──
    // Unknown (pluginId, method) degrades LOUDLY: a shaped refusal the caller can
    // render, never an undefined resolution indistinguishable from success.
    async dispatch(pluginId, method, args = []) {
      if (String(pluginId) === HOST_PSEUDO_ID) {
        const hf = hostMethods[String(method)];
        if (typeof hf !== 'function') return errorEnvelope(NO_SUCH_METHOD);
        try { return hf(...args); } catch (e) { return errorEnvelope(String((e && e.message) || e)); }
      }
      const fn = dispatchMap.get(namespaced(String(pluginId), String(method)));
      if (typeof fn !== 'function') return errorEnvelope(NO_SUCH_METHOD);
      try {
        return await fn(...args);
      } catch (e) {
        return errorEnvelope(String((e && e.message) || e));
      }
    },
    catalog() {
      return [...registered.values()].map((r) => ({
        id: r.id,
        name: r.manifest.name || r.id,
        version: r.manifest.version || null,
        enabled: true,
        announce: r.manifest.announce || null,
      }));
    },
    setEnabled(pluginId, enabled) {
      const id = String(pluginId);
      const loader = getLoader && getLoader();
      // The persisted enabled set is updated FIRST and unconditionally, so a
      // plugin whose activate() throws still records the user's decision — the
      // alternative silently reverts the toggle and looks like the click was
      // lost. Phase 1 had no loader; without one this degrades to exactly its
      // behavior (disable tears down, enable refuses), which is what keeps the
      // kill switch and a failed-loader run honest rather than half-working.
      if (loader) { try { loader.setEnabledInSettings(id, !!enabled); } catch {} }
      if (!enabled) return { ok: deactivate(id) };
      if (!loader) return errorEnvelope('enabling requires the plugin loader (Phase 2)');
      if (registered.has(id)) return { ok: true, already: true };
      return loader.activateById(id, api);
    },

    // ── The engine-internal surface ──
    register, deactivate, hooks,
    hostApiVersion: HOST_API_VERSION,
    // Test/introspection seams — read-only views, never the live containers.
    _dispatchKeys: () => [...dispatchMap.keys()],
    _hookCounts: () => ({ create: createHooks.size, exit: exitHooks.size }),
  };
  return api;
}

module.exports = { createPluginHostEngine };
