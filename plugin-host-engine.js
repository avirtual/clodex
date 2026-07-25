'use strict';
// plugin-host-engine.js — the ENGINE half of the plugin host (plugin-plan.md [internal design doc, not in this repo]
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
  HOST_API_VERSION, isValidPluginId, RESERVED_PLUGIN_IDS, namespaced, HOST_PSEUDO_ID,
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
    telemetrySnapshot, // proxyPoller.snapshot passthrough — read-only, may be null
    getLoader,        // getter: the plugin loader (Phase 2). Absent ⇒ Phase-1
                      // behavior — disable works, enable refuses, nothing loads.
    // Optional (T5): "the enabled/quarantine picture changed". The app menu's
    // Plugins entry is built from that picture, and it must be right after a
    // toggle from ANY window, from the menu itself, or from a quarantine trip —
    // so the notification belongs at the one place all three converge rather
    // than at each caller. Electron-free: this is a plain callback, and the
    // headless host simply doesn't pass one.
    onPluginStateChanged,
  } = deps;
  const notifyStateChanged = () => {
    try { if (typeof onPluginStateChanged === 'function') onPluginStateChanged(); } catch {}
  };

  // ── host.lib's bound façade (t8 F2) ────────────────────────────────────────
  // `Object.freeze({ gitWorktree })` froze the WRAPPER only. `gitWorktree` is
  // the live module object core itself holds under the same require-cache entry
  // (`ipc-handlers.js:35`), so `host.lib.gitWorktree.removeWorktree = mine` used
  // to repoint CORE's calls — `worktree:remove`, the session-delete flow and
  // New-Session's `createWorktree` — at the plugin's function, and it survived
  // `deactivate`. Interception of core through the sanctioned door.
  //
  // So plugins get a frozen façade of BOUND wrappers instead: assigning to a
  // member throws (frozen), and each wrapper delegates to the real module, which
  // the plugin now has no reference to. Derived from the leaf's own keys rather
  // than a hardcoded name list — the list would have to be re-edited whenever
  // git-worktree.js gains an export, and getting that wrong silently NARROWS a
  // frozen `"1"` surface. Functions only; the leaf is all functions, and a
  // non-function member would need its own decision (handing one out by value
  // would re-open exactly this hole for anything mutable).
  const libGitWorktree = Object.freeze(Object.fromEntries(
    Object.keys(gitWorktree || {})
      .filter((k) => typeof gitWorktree[k] === 'function')
      .map((k) => [k, (...a) => gitWorktree[k](...a)]),
  ));

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
          try { log.info('plugin', `contract violation: ${label} subscriber returned a thenable — the hook is SYNCHRONOUS by definition (plugin-plan.md [internal design doc, not in this repo] §3.2); its result is ignored`); } catch {}
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
        // The PEER refusal as a host guarantee (MUST-FIX 5), reproducing the
        // sessionCwd guard in ipc-handlers verbatim. It lives here so the
        // refusal — including the exact 'remote' string renderers match on — is
        // not each plugin's code to get right.
        //
        // What this answers: "what cwd, and is this local?" That is ALL it
        // answers, and an earlier version of this comment claimed more — that a
        // careless plugin "cannot widen locality" — while disproving itself four
        // lines later. It is NOT workspace scoping (the plugin transport
        // discards the Electron event, so an engine half is never told which
        // window asked; compare handle.workspaceId yourself) and it is NOT cwd
        // confinement (nothing stops a plugin resolving a path out of the cwd
        // this returns, or following a symlink that leaves it). A Tier-A plugin
        // is unsandboxed in-process Node holding a cwd and require('fs');
        // docs/plugin-api.md §4 states the same thing in the same words, and the
        // published contract is explicit that the host API is a contract, not a
        // containment boundary.
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
      // `gitWorktree` is PERMANENT and, since W5, the ONLY entry: git-worktree.js
      // stays core because the New-Session worktree row and the delete flow's
      // removeWorktree depend on it (§4 W5). That is the test for membership
      // here — a leaf CORE also uses, lent to plugins. A leaf only one plugin
      // uses belongs in that plugin's directory instead; git-scm.js and
      // fs-explorer.js sat here through W2-W4 purely so the DOM move could land
      // as its own revertable commit, and moved into plugins/workbench/ at W5.
      // A frozen façade of BOUND wrappers, NOT the module object — see
      // libGitWorktree above for why the one-level freeze was a hole.
      lib: Object.freeze({ gitWorktree: libGitWorktree }),

      // Read-only, may be null (no proxy linked / no telemetry for this session).
      // "Read-only" was a COMMENT: the poller hands back its live payload — the
      // same object core rebroadcasts to every window — so a plugin that kept or
      // mutated it edited core's state and every other reader's view of it. Deep
      // copy on the way out (t8), so read-only is a property of the value rather
      // than a request. structuredClone is preferred and the JSON round-trip is
      // the fallback for a payload it refuses (a function, a symbol); either way
      // a failure yields null, because this API's documented normal case is null
      // and it must never throw into a plugin.
      telemetry: Object.freeze({
        snapshot: (name) => {
          let live;
          try { live = telemetrySnapshot ? telemetrySnapshot(name) : null; } catch { return null; }
          if (live == null || typeof live !== 'object') return live ?? null;
          try { return structuredClone(live); } catch {}
          try { return JSON.parse(JSON.stringify(live)); } catch { return null; }
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
    logFor(pluginId).error(`events.emit('${t}') dropped — scope is REQUIRED and must be 'all', { session }, or { workspace } (plugin-plan.md [internal design doc, not in this repo] §3.3)`);
    return false;
  }

  // The enable/disable hint, broadcast on the `_host` pseudo-id so it rides the
  // EXISTING `plugin-event` row rather than becoming a sixth api-contract row
  // (§1 freezes the transport at five). Every open window activates or disposes
  // the plugin's renderer half itself when it lands — the engine cannot reach
  // into a renderer's registries, and pretending otherwise is how the multi-
  // window blind spot §3.3 exists to prevent gets re-introduced.
  function announceState(pluginId, enabled) {
    try { emitScoped(HOST_PSEUDO_ID, 'plugin-state', { id: String(pluginId), enabled: !!enabled }, 'all'); } catch {}
    // Renderers hear the hint above; the MAIN process hears this one. Both halves
    // of the UI (every window's DOM, and the app menu's checkboxes) are stale at
    // exactly the same moment, so they are refreshed from the same call.
    notifyStateChanged();
  }

  // ── Registration + lifecycle ───────────────────────────────────────────────
  // Phase 1 ships NO plugins: core populates the registries and the loader that
  // walks plugins/*/manifest.json is Phase 2. `register` is the seam that loader
  // will call, and the in-tests fake plugin drives today.
  function register(pluginId, mod, manifest = {}) {
    // Reserved first, for the same reason validateManifest does it: "invalid
    // plugin id: enabled" reads like a typo for a string that satisfies the
    // regex. The loader refuses such a manifest before it ever reaches here, so
    // this is the backstop for the in-tests fake and any future non-loader
    // caller — the invariant belongs at BOTH doors, not just the outer one.
    if (RESERVED_PLUGIN_IDS.has(pluginId)) {
      throw new Error(`plugin id "${pluginId}" is reserved — it is a key in uiSettings.plugins`);
    }
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
  // Every plugin ON DISK, with the user's intent and any quarantine shadowing it.
  // Named separately from the two surfaces that serve it because they need
  // different shapes of the SAME read: `_host` `plugins.status` is the renderer's
  // async round trip, and `api.status()` is the app menu's — the menu template is
  // built synchronously (Menu.buildFromTemplate) and cannot await a dispatch.
  // One function, so the menu and any renderer surface can never disagree.
  function pluginsStatus() {
    const loader = getLoader && getLoader();
    if (!loader) return { plugins: [], problems: [] };
    return loader.status();
  }

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
    // ── The fail-safe surface (§2.5's Plugins section) ────────────────────
    // Every plugin ON DISK, with the user's intent and any quarantine shadowing
    // it — NOT `catalog()`, which lists only what successfully registered and so
    // would hide the exact plugin the section exists to let you fix.
    'plugins.status': () => ({ ok: true, ...pluginsStatus() }),
    // Re-scan the plugin roots without restarting (t22). A HOST service on the
    // `_host` pseudo-id, NOT a sixth `plugin:*` row: api-contract.js:276 freezes
    // the plugin transport at five rows "for every plugin, forever", and this is
    // host plumbing rather than any plugin's method — the same reasoning that put
    // `plugins.status`, `renderer.info` and `renderer.report` here.
    //
    // Every window is told afterwards, because a newly loaded plugin's RENDERER
    // half is per-BrowserWindow and only the window holding it can activate it —
    // the engine reaching into a renderer is the multi-window blind spot §3.3
    // exists to prevent. The `plugin-state` hint each window already handles for
    // enable/disable does exactly this job, so a re-scan reuses it rather than
    // inventing a second path that could drift from it.
    // Where a user drops a plugin. Served rather than reconstructed in the
    // renderer: the roots are configured at the engine bootstrap and the renderer
    // has no business knowing that the user root is `~/.clodex/plugins` — that is
    // exactly the consumer-rebuilding-a-producer-fact shape this project keeps
    // hitting. Creates the directory (see ensureUserRoot for why that is not a
    // violation of "the app never creates it").
    'plugins.userRoot': () => {
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const dir = loader.ensureUserRoot();
      return dir ? { ok: true, dir } : errorEnvelope('no user plugin root configured');
    },
    'plugins.rescan': () => {
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const r = loader.rescan(api);
      for (const id of r.added) announceState(id, true);
      for (const id of r.removed) announceState(id, false);
      // A CHANGED plugin gets no announce: nothing about it moved in this
      // process, and telling windows to re-activate would re-run the OLD cached
      // module's renderer half for a version the user thinks they just installed.
      if (r.added.length || r.removed.length) notifyStateChanged();
      return { ok: true, ...r };
    },
    // A window reporting its renderer half's outcome. Only the FIRST report per
    // app run counts (the loader's rule) — N windows must not mean N strikes.
    'renderer.report': (pluginId, ok, error) => {
      const loader = getLoader && getLoader();
      if (!loader) return { ok: true, counted: false };
      return { ok: true, ...loader.noteRendererActivation(String(pluginId), !!ok, error) };
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
    // The app menu's read (T5). Same data `_host` `plugins.status` serves the
    // renderer, minus the envelope — a MAIN-process caller has the host object
    // in hand and would only be unwrapping its own answer. Sync by construction,
    // because Menu.buildFromTemplate takes a template, not a promise.
    status: pluginsStatus,
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
      if (!enabled) {
        const ok = deactivate(id);
        // Tell EVERY window (§4 W7: "disable removes button, overlay, styles and
        // dispatch entries in every window"). The engine half's teardown above is
        // per-app-run; each renderer half is per-BrowserWindow and can only be
        // torn down by the window holding it. 'all' is right here precisely
        // because the payload is an invalidation hint with no data in it (§3.3).
        announceState(id, false);
        return { ok };
      }
      if (!loader) return errorEnvelope('enabling requires the plugin loader (Phase 2)');
      if (registered.has(id)) { announceState(id, true); return { ok: true, already: true }; }
      const r = loader.activateById(id, api);
      if (r && r.ok) announceState(id, true);
      return r;
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
