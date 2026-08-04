'use strict';
// Three invariants this file enforces by construction:
//  1. No unqualified `list()`. `listAll()` is global; `listWorkspace(id)` is what
//     per-window surfaces want. fsScope refuses PEERS, not foreign workspaces, so
//     nothing downstream catches a global list handed to one window.
//  2. Events are unbuffered: a closed target window means the event is gone, so a
//     plugin cannot maintain renderer state by delta — state is pulled on open.
//  3. onExit is sync-only and positioned — see fireExit and runHooks.

const {
  HOST_API_VERSION, isValidPluginId, RESERVED_PLUGIN_IDS, namespaced, HOST_PSEUDO_ID,
  NO_SUCH_METHOD, errorEnvelope, scopeOf,
} = require('./plugin-api');
const { registerIntent, unregisterSource } = require('./intent-registry');

function createPluginHostEngine(deps) {
  const {
    manager,          // SessionManager — reached ONLY through the facade below
    getUiSettings,    // getter: assigned in the bootstrap, like every store seam
    log,
    userDataPath,     // createEngine's param — host.paths.dataDir derives from it
    fs, path,
    gitWorktree,      // the sanctioned shared leaf exposed as host.lib
    libraryKinds,     // kind -> handler for host.library.remove; unlisted kinds are REFUSED
    libraryPinKinds,  // kind -> handler for host.library.setPin; same refusal rule
    telemetrySnapshot, // proxyPoller.snapshot passthrough — read-only, may be null
    getLoader,        // getter: the plugin loader (Phase 2). Absent ⇒ Phase-1
    onPluginStateChanged,
  } = deps;
  const notifyStateChanged = () => {
    try { if (typeof onPluginStateChanged === 'function') onPluginStateChanged(); } catch {}
  };

// A frozen façade of BOUND wrappers, not the module object: freezing a wrapper
// leaves `gitWorktree` — the same live module object core holds under the same
// require-cache entry — writable, so a plugin could repoint core's calls.
// Derived from the leaf's own keys; a hardcoded name list silently NARROWS a
// frozen surface whenever git-worktree.js gains an export.
  const libGitWorktree = Object.freeze(Object.fromEntries(
    Object.keys(gitWorktree || {})
      .filter((k) => typeof gitWorktree[k] === 'function')
      .map((k) => [k, (...a) => gitWorktree[k](...a)]),
  ));

// Bound wrappers for the same reason as libGitWorktree: the injected table is a
// live object the façade's freeze does not reach, so a plugin could repoint the
// handler core itself calls.
  const libraryHandlers = Object.freeze(Object.fromEntries(
    Object.entries(libraryKinds || {})
      .filter(([, fn]) => typeof fn === 'function')
      .map(([k, fn]) => [k, (ref) => fn(ref)]),
  ));

  const libraryPinHandlers = Object.freeze(Object.fromEntries(
    Object.entries(libraryPinKinds || {})
      .filter(([, fn]) => typeof fn === 'function')
      .map(([k, fn]) => [k, (ref, on) => fn(ref, on)]),
  ));

// The injected transport has no removeHandler, so a per-plugin channel could
// never be unregistered and dispose() would be a lie. Mutating this Map is the
// only disposal primitive available; everything disposable bottoms out here.
  const dispatchMap = new Map();

  const teardowns = new Map();   // pluginId -> Set<fn>
  const registered = new Map();  // pluginId -> manifest-ish record

  function ledger(pluginId) {
    if (!teardowns.has(pluginId)) teardowns.set(pluginId, new Set());
    return teardowns.get(pluginId);
  }
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
      error: (msg) => { try { log.error(scope, String(msg)); } catch {} },
    };
  }

  const createHooks = new Set();
  const exitHooks = new Set();

// Each subscriber in its own try/catch: a throw here lands mid-PTY-teardown.
// SYNC ONLY — the hook must complete before _cleanup(name); an async subscriber
// would resume after the session is already dropped from the map.
  function runHooks(set, label, arg) {
    for (const fn of set) {
      try {
        const r = fn(arg);
        if (r && typeof r.then === 'function') {
          try { log.info('plugin', `contract violation: ${label} subscriber returned a thenable — the hook is SYNCHRONOUS by definition; its result is ignored`); } catch {}
        }
      } catch (e) {
        try { log.info('plugin', `${label} subscriber threw (ignored): ${e && e.message}`); } catch {}
      }
    }
  }

  const hooks = {
    fireCreate(name) { runHooks(createHooks, 'sessions.onCreate', sessionHandle(name)); },
// Called from ptyProc.onExit, AFTER the exit broadcast and BEFORE _cleanup(name).
// The handle is already _dead, so isAlive() is false and inject() no-ops.
// For a naturally-exited bash session the persistence entry is already gone.
    fireExit(name) { runHooks(exitHooks, 'sessions.onExit', sessionHandle(name)); },
    handleFor(name) { return sessionHandle(name); },
  };

  function sessionHandle(name) {
    const s = manager.sessions.get(name);
    if (!s) return null;
    return Object.freeze({
      name: s.name,
      type: s.type,
      cwd: s.cwd,
      workspaceId: s.workspaceId,
      isAlive() {
        const cur = manager.sessions.get(name);
        return !!cur && !cur._dead;
      },
      inject(text, opts = {}) {
        const cur = manager.sessions.get(name);
        if (!cur) return;
        manager._injectText(cur, String(text), { parkable: opts.parkable !== false });
      },
    });
  }

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

    const settings = {
      get() {
        const all = getUiSettings().get().plugins;
        const mine = all && all[pluginId];
        return (mine && typeof mine === 'object') ? { ...mine } : {};
      },
      set(patch) {
        // Spreading a non-object here writes index keys ("0", "1", ...) into the
        // plugin's namespace, so a string patch silently corrupts settings.
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
        const ui = getUiSettings();
        const all = ui.get().plugins || {};
        const next = { ...all, [pluginId]: { ...(all[pluginId] || {}), ...patch } };
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
        listAll: () => manager.list(),
        listWorkspace: (wsId) => manager.listForWorkspace(wsId),
        get: (name) => sessionHandle(name),
// Answers "what cwd, and is this local?" and nothing more. NOT workspace scoping
// (an engine half is never told which window asked — compare handle.workspaceId
// yourself) and NOT cwd confinement. Tier-A plugins are unsandboxed in-process
// Node; the 'remote' string is the one renderers match on.
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

      ipc: Object.freeze({
        handle: (method, fn) => {
          const key = namespaced(pluginId, method);
          dispatchMap.set(key, fn);
          return disposable(pluginId, () => dispatchMap.delete(key));
        },
      }),

      intents: Object.freeze({
        register: (row) => {
          // Scope comes from the REGISTERED MANIFEST, read at call time, not
          // from `row` — a plugin that could name its own scope could declare
          // itself global and undo the operator's decision. `registered.set`
          // runs before activate(), so the record is always there by now.
          // Except after deactivate(), where a late timer would find no record:
          // scopeOf(undefined) resolves to GLOBAL and the ledger disposer no
          // longer fires, so the row would leak permanently at the wider scope
          // — the same silent globalization the loader's manifest refusal
          // exists to prevent. Refuse rather than default.
          const rec = registered.get(pluginId);
          if (!rec) throw new Error(`plugin ${pluginId} is not registered — intents.register after deactivate`);
          const undo = registerIntent(row, pluginId, { scope: scopeOf(rec.manifest) });
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

// Membership test: a pure leaf CORE also uses, lent to plugins. A leaf only one
// plugin uses belongs in that plugin's directory. Bound façade, not the module —
// see libGitWorktree.
      lib: Object.freeze({ gitWorktree: libGitWorktree }),

// Deletion is generic in SHAPE, per-kind in implementation, and an unregistered
// kind is refused rather than falling back to a path unlink: the four library
// kinds do not mean the same thing when deleted and three break silently (a
// memory needs its digest rewritten, a prompt/template/exec is referenced BY
// NAME elsewhere). The refusal is what forces the next kind's author to answer
// "what else has to happen when this file goes away?".
// This engine must stay ignorant of what any kind IS — it forwards refs, never
// reads them; per-kind ref validation belongs to the handler.
      library: Object.freeze({
        remove: (kind, ref) => {
          if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(libraryHandlers, kind)) {
            // Distinct from a failed delete on purpose: asking for a kind that
            // does not exist is a different bug from a file that would not unlink.
            return { ok: false, error: `unknown library kind: ${String(kind)}` };
          }
          if (!ref || typeof ref !== 'object') {
            return { ok: false, error: 'library.remove: ref must be an object' };
          }
          try {
            const res = libraryHandlers[kind](ref);
            if (!res || typeof res !== 'object') {
              return { ok: false, error: 'library.remove: handler returned no result' };
            }
            // Handlers are SYNCHRONOUS. A promise passes the object test, so
            // returning it verbatim would hand the plugin a pending value whose
            // rejection escapes this catch as an unhandled rejection.
            if (typeof res.then === 'function') {
              // Refusing is not enough: the promise is already in flight, and
              // an unattached rejection takes the process down under Node's
              // default. Swallow it — the caller is told the handler is invalid.
              try { res.then(() => {}, () => {}); } catch {}
              return { ok: false, error: `library.remove: handler for ${kind} must be synchronous` };
            }
            // Rebuilt, not forwarded. "Forwards, never interprets" is a rule
            // about the REF; the envelope is this layer's published contract, so
            // enforce it rather than observe it. This keeps a handler's cached
            // or live result object from crossing into plugin land — it does NOT
            // sanitize the error, which still passes through as the handler
            // wrote it.
            return res.ok ? { ok: true } : { ok: false, error: String(res.error ?? 'library.remove failed') };
          } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
          }
        },
        // Separate verb rather than a flag on remove: the two obligations
        // differ. A remove is terminal and its handler must rewrite the digest
        // for a unit that no longer exists; a pin changes WHICH units ride and
        // is refusable (the cap), so it has an error path remove does not.
        setPin: (kind, ref, on) => {
          if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(libraryPinHandlers, kind)) {
            return { ok: false, error: `unknown library kind: ${String(kind)}` };
          }
          if (!ref || typeof ref !== 'object') {
            return { ok: false, error: 'library.setPin: ref must be an object' };
          }
          try {
            const res = libraryPinHandlers[kind](ref, !!on);
            if (!res || typeof res !== 'object') {
              return { ok: false, error: 'library.setPin: handler returned no result' };
            }
            if (typeof res.then === 'function') {
              try { res.then(() => {}, () => {}); } catch {}
              return { ok: false, error: `library.setPin: handler for ${kind} must be synchronous` };
            }
            // The cap refusal has to survive as TEXT — it names the limit and
            // tells the operator to unpin one first, which a boolean cannot.
            return res.ok ? { ok: true } : { ok: false, error: String(res.error ?? 'library.setPin failed') };
          } catch (e) {
            return { ok: false, error: e && e.message ? e.message : String(e) };
          }
        },
      }),

// The poller hands back its LIVE payload — the same object core rebroadcasts to
// every window — so copy on the way out. Never throw: null is this API's
// documented normal case.
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
    logFor(pluginId).error(`events.emit('${t}') dropped — scope is REQUIRED and must be 'all', { session }, or { workspace }`);
    return false;
  }

  function announceState(pluginId, enabled) {
    try { emitScoped(HOST_PSEUDO_ID, 'plugin-state', { id: String(pluginId), enabled: !!enabled }, 'all'); } catch {}
    notifyStateChanged();
  }

  function register(pluginId, mod, manifest = {}) {
// Backstop: the loader refuses reserved ids before this — the invariant belongs
// at both doors, not just the outer one.
    if (RESERVED_PLUGIN_IDS.has(pluginId)) {
      throw new Error(`plugin id "${pluginId}" is reserved — it is a key in uiSettings.plugins`);
    }
    if (!isValidPluginId(pluginId)) throw new Error(`invalid plugin id: ${pluginId}`);
    if (registered.has(pluginId)) throw new Error(`plugin already registered: ${pluginId}`);
    const want = String(manifest.hostApi ?? HOST_API_VERSION);
    if (want !== HOST_API_VERSION) {
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
// Stylesheet TEXT, not a path: text works identically in the file:// window and
// in the web bundle, where no path resolves.
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
    'plugins.userRoot': () => {
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const dir = loader.ensureUserRoot();
      return dir ? { ok: true, dir } : errorEnvelope('no user plugin root configured');
    },
    'plugins.listUserRoot': () => {
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const r = loader.listUserRoot();
      return r ? { ok: true, ...r } : errorEnvelope('no user plugin root configured');
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
    'renderer.report': (pluginId, ok, error) => {
      const loader = getLoader && getLoader();
      if (!loader) return { ok: true, counted: false };
      return { ok: true, ...loader.noteRendererActivation(String(pluginId), !!ok, error) };
    },
  };

  const api = {
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
        // The renderer needs to know WHICH plugins are session-scoped before it
        // can hide any of them, and this is the read it already does at startup.
        // A scope that arrived later than the first paint would show a scoped
        // plugin's UI on every session for a frame.
        scope: scopeOf(r.manifest),
      }));
    },
    setEnabled(pluginId, enabled) {
      const id = String(pluginId);
      const loader = getLoader && getLoader();
// The persisted enabled set is updated FIRST and unconditionally, so a plugin
// whose activate() throws still records the user's decision rather than looking
// like the click was lost.
      if (loader) { try { loader.setEnabledInSettings(id, !!enabled); } catch {} }
      if (!enabled) {
        const ok = deactivate(id);
// Every window: the engine-half teardown above is per-app-run, but each renderer
// half is per-BrowserWindow and only its own window can tear it down.
        announceState(id, false);
        return { ok };
      }
      if (!loader) return errorEnvelope('enabling requires the plugin loader (Phase 2)');
      if (registered.has(id)) { announceState(id, true); return { ok: true, already: true }; }
      const r = loader.activateById(id, api);
      if (r && r.ok) announceState(id, true);
      return r;
    },

    register, deactivate, hooks,
    hostApiVersion: HOST_API_VERSION,
    _dispatchKeys: () => [...dispatchMap.keys()],
    _hookCounts: () => ({ create: createHooks.size, exit: exitHooks.size }),
  };
  return api;
}

module.exports = { createPluginHostEngine };
