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
  NO_SUCH_METHOD, NOT_ON_THIS_SURFACE, errorEnvelope, scopeOf, pluginGranted,
  seatHasPlugin, methodSurfaceOf, surfaceAllows,
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
    getPersistence,   // getter: the sessions store — read for per-session plugin grants
    onPluginStateChanged,
  } = deps;
  const notifyStateChanged = () => {
    try { if (typeof onPluginStateChanged === 'function') onPluginStateChanged(); } catch {}
  };

// A frozen façade of BOUND wrappers, not the module object: freezing a wrapper
// leaves `gitWorktree` — the same live module object core holds under the same
// require-cache entry — writable, so a plugin could repoint core's calls.
//
// Derived from the leaf's own keys MINUS an explicit withhold list, because the
// two obvious designs each fail silently in one direction: deriving from every
// key WIDENS the published surface the day git-worktree.js gains an export, and
// a hardcoded lend-list NARROWS it the day one is renamed. Partitioning means a
// new export belongs to exactly one of the two sets and lands in neither by
// accident — the test pins the partition, so adding an export fails until it is
// classified.
//
// WITHHELD is the safe default for anything that MUTATES refs. A plugin holding
// `deleteBranch` could destroy a branch core never asked it to touch, and a
// worktree's branch is where a seat's only committed work lives.
//
// `diffText` is withheld on a second ground: every lent member returns METADATA
// — paths, branches, counts, a dirty flag — and it returns file CONTENT, for any
// repo path the caller names, whether or not Clodex ever opened it. Core added
// it for the ticket loop; no plugin has asked. Lending is a published API that
// narrowing later would break, so it stays withheld until something needs it.
// `mergeNoFf` and `revertCommit` are the strongest case the withhold rule has:
// they do not merely mutate a ref, they COMMIT to whatever the shared checkout
// has checked out — the tree every seat's branch is cut from. `currentBranch` is
// lent, being read-only metadata of exactly the kind the rest of the lent set
// returns.
  const LIB_GIT_WITHHELD = new Set(['deleteBranch', 'isMerged', 'diffText', 'mergeNoFf', 'revertCommit']);
  const libGitWorktree = Object.freeze(Object.fromEntries(
    Object.keys(gitWorktree || {})
      .filter((k) => typeof gitWorktree[k] === 'function' && !LIB_GIT_WITHHELD.has(k))
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
  const textHooks = new Map();   // pluginId -> Set<fn>; keyed because the grant is per-PLUGIN

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
    fireAgentText(ev) { fireAgentText(ev); },
  };

// The turn-text feed. Unlike onCreate/onExit this is DEFERRED, not synchronous:
// the wire junction that calls it is the same one that dispatches intents, so a
// subscriber doing real work on a 4MB turn inline would delay every intent
// behind it. setImmediate is the same escape the intent loop already takes.
//
// One frozen event object shared by every subscriber, built ONCE before the
// grant loop: `files`/`reads` arrive as the wire collector's live arrays, which
// core also reads these arrays, so a subscriber mutating one would corrupt
// core's view. Freezing beats copying per subscriber.
  function agentTextEvent(ev) {
    // Defaults to the path that CLAIMS LESS. 'wire' would mean isTurnEnd:false
    // and reads:[] — two assertions — for a source nobody recognised; 'jsonl'
    // means two nulls. Both callers pass a literal, so this only decides what an
    // unrecognised third caller would get, and it should fail toward "unknown".
    const src = ev && ev.source === 'wire' ? 'wire' : 'jsonl';
    // null, never false/[]: the jsonl path has no protocol turn-end signal and
    // no tool-use blocks to read. `false` and `[]` are CLAIMS a plugin cannot
    // tell apart from an observation; null says "not knowable here". Same
    // discipline as the sidebar-meta merge bugs — absent and false differ.
    const frozenList = (v) => (Array.isArray(v) ? Object.freeze(v.map((x) => Object.freeze({ ...x }))) : null);
    return Object.freeze({
      session: String((ev && ev.session) || ''),
      text: typeof (ev && ev.text) === 'string' ? ev.text : '',
      source: src,
      truncated: !!(ev && ev.truncated),
      isTurnEnd: src === 'wire' ? !!(ev && ev.isTurnEnd) : null,
      files: frozenList(ev && ev.files) || Object.freeze([]),
      reads: src === 'wire' ? (frozenList(ev && ev.reads) || Object.freeze([])) : null,
    });
  }

  function fireAgentText(ev) {
    if (textHooks.size === 0) return;              // nothing subscribed: no grant reads, no event build
    const event = agentTextEvent(ev);
    if (!event.session) return;
    // ONE setImmediate around the whole dispatch, not one per subscriber: the
    // grant read below is a synchronous whole-file sessions.json read + parse
    // (and _load can WRITE the file back-filling workspaceId), so leaving it on
    // the caller's stack would pay the exact cost the deferral exists to avoid,
    // once per REQUEST. Reading here still means read-at-delivery — a revoke
    // lands on the next turn.
    setImmediate(() => {
      const entry = readSeatEntry(event.session);
      const grants = (entry && Array.isArray(entry.pluginGrants)) ? entry.pluginGrants : null;
      for (const [pluginId, set] of textHooks) {
        const rec = registered.get(pluginId);
        // OUTER of the two: a grant token for a plugin the seat no longer has
        // sits on disk until its next `plugins` write, and would keep feeding it.
        if (!seatHasPlugin(pluginId, entry && entry.plugins, rec && rec.shipped)) continue;
        // Gated on the `turns` capability SPECIFICALLY, not on any grant:
        // a plugin granted only `toolInputs` holding turn text would defeat the
        // whole point of splitting the grants by risk.
        if (!pluginGranted(pluginId, 'turns', grants)) continue;
        // Scope from the REGISTERED MANIFEST, same rule as intents.register:
        // grants persist per session and survive an upgrade that flips a
        // manifest session→global, so a stale token would keep delivering to a
        // plugin the grants editor no longer even lists.
        if (!rec || scopeOf(rec.manifest) !== 'session') continue;
        for (const fn of set) {
          try { fn(event); } catch (e) {
            try { log.info('plugin', `sessions.onAgentText subscriber threw (ignored): ${e && e.message}`); } catch {}
          }
        }
      }
    });
  }

// Read at DELIVERY, never cached: a revoke has to take effect on the next turn,
// and a cache here would be the same "stale grant lives for the process's life"
// shape the sidebar-meta revoke bug had.
  function readSeatEntry(sessionName) {
    try {
      const p = getPersistence && getPersistence();
      return (p && p.get(sessionName)) || null;
    } catch { return null; }   // no persistence ⇒ no grants ⇒ pluginGranted refuses
  }

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
// Turn text, gated by the per-session `turns` grant (t190's vocabulary). A
// GLOBAL-scoped plugin can never receive anything here — the grants editor
// offers session-scoped plugins only — which is deliberate: text is exactly the
// exposure per-session scope was built for. See plugins/plugin-api.md §2.2.
//
// AT-LEAST-ONCE, not exactly-once. Intents get exactly-once from a deduper keyed
// on intent CONTENT; raw text has no such key, and the tee-failure recovery
// replay genuinely re-delivers a handover turn's tail.
        onAgentText: (fn) => {
          if (typeof fn !== 'function') return () => {};
          // Post-deactivate late subscribe, same window intents.register refuses.
          // Returning rather than throwing: a leaked subscriber costs nothing in
          // correctness (delivery re-checks the record), but the re-created Set
          // would have no teardown left to drain it, defeating fireAgentText's
          // size===0 fast path for the process's life — a persistence read per
          // request, forever, for a plugin nobody is running.
          if (!registered.has(pluginId)) return () => {};
          // Diagnostic only — the enforcement is at delivery, because an upgrade
          // can flip the manifest after this runs. Without it the refusal is the
          // one silent no-op in this file, and the shape that hits it is an
          // author who simply omitted the field.
          if (scopeOf(registered.get(pluginId).manifest) !== 'session') {
            logFor(pluginId).info('sessions.onAgentText: this plugin\'s manifest is global — the feed never delivers to a global plugin; add "scope": "session"');
          }
          if (!textHooks.has(pluginId)) textHooks.set(pluginId, new Set());
          textHooks.get(pluginId).add(fn);
          return disposable(pluginId, () => {
            const set = textHooks.get(pluginId);
            if (!set) return;
            set.delete(fn);
            // Drop the empty Set, not just the fn: fireAgentText's fast path is
            // `textHooks.size === 0`, and an empty Set left behind would keep
            // every turn reading persistence for grants nobody is waiting on.
            if (set.size === 0) textHooks.delete(pluginId);
          });
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
          const undo = registerIntent(row, pluginId, { scope: scopeOf(rec.manifest), shipped: rec.shipped });
          return disposable(pluginId, undo);
        },
      }),

      // ── events ────────────────────────────────────────────────────────────
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

  function register(pluginId, mod, manifest = {}, opts = {}) {
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
    registered.set(pluginId, {
      id: pluginId, manifest, mod, shipped: opts.shipped === true,
      skills: Array.isArray(opts.skills) ? opts.skills : [],
      agents: Array.isArray(opts.agents) ? opts.agents : [],
    });
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
    // Belt to the ledger's braces, same reasoning as unregisterSource below: a
    // text subscriber that escaped the ledger would keep receiving turn text
    // after the operator disabled the plugin.
    textHooks.delete(pluginId);
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
    // ── The fail-safe surface (the settings Plugins section) ──────────────
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
    'plugins.validateCandidate': (dir) => {
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const r = loader.validateCandidate(String(dir || ''));
      return r.ok ? { ok: true, ...r } : errorEnvelope(r.error);
    },
    'plugins.register': (dir) => {
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const r = loader.registerUserPlugin(String(dir || ''));
      return r.ok ? { ok: true, ...r } : errorEnvelope(r.error);
    },
    'plugins.unregister': (pluginId) => {
      const loader = getLoader && getLoader();
      if (!loader) return errorEnvelope('no plugin loader');
      const r = loader.unregisterUserPlugin(String(pluginId || ''));
      return r.ok ? { ok: true, ...r } : errorEnvelope(r.error);
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

  const HOST_DESKTOP_ONLY = new Set([
    'plugins.validateCandidate', 'plugins.register', 'plugins.unregister',
  ]);

  const api = {
// `callerSurface` is REQUIRED in effect: everything but the exact string
// 'desktop' is treated as untrusted, so a transport that forgets to declare
// itself gets the restricted branch rather than inheriting the desktop's reach.
// One multiplexed channel serves every plugin method, so `enableDrawerServices`
// — a gate that works by not registering a channel — cannot see this call at
// all; the check has to be here.
    async dispatch(pluginId, method, args = [], callerSurface = undefined) {
      if (String(pluginId) === HOST_PSEUDO_ID) {
        // UNGATED by default, ruled deliberately (t217): these are the plugin
        // SUBSYSTEM's own plumbing, and the web renderer's plugin UI cannot
        // function without settings.get/set, renderer.info and plugins.status.
        // `plugins.rescan` is the sharp one — it loads code — but gating it
        // alone would be theatre: `plugin:setEnabled` reaches activateById →
        // loadOne over a separate unconditional channel with identical effect.
        // Both belong to "core's own web surface is privileged", a wider
        // question than plugin dispatch, ticketed separately. HOST_DESKTOP_ONLY
        // is the exception: those three take a caller-supplied path, so a web
        // client could otherwise link an arbitrary host directory into the
        // plugin root and have its code loaded. The list is pinned by
        // test/plugin-surface-gate.test.js — a new method argues for itself.
        const hf = hostMethods[String(method)];
        if (typeof hf !== 'function') return errorEnvelope(NO_SUCH_METHOD);
        if (HOST_DESKTOP_ONLY.has(String(method)) && !surfaceAllows(callerSurface, 'desktop')) {
          return errorEnvelope(NOT_ON_THIS_SURFACE);
        }
        try { return hf(...args); } catch (e) { return errorEnvelope(String((e && e.message) || e)); }
      }
      const fn = dispatchMap.get(namespaced(String(pluginId), String(method)));
      if (typeof fn !== 'function') return errorEnvelope(NO_SUCH_METHOD);
      // AFTER the existence check, so an unknown method still answers
      // NO_SUCH_METHOD on every surface: answering "not on this surface" for a
      // method that does not exist would turn the refusal into an oracle for
      // enumerating the desktop-only method names.
      const rec = registered.get(String(pluginId));
      const required = methodSurfaceOf(rec && rec.manifest, method);
      if (!surfaceAllows(callerSurface, required)) return errorEnvelope(NOT_ON_THIS_SURFACE);
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
        shipped: r.shipped === true,
        enabledByDefault: r.manifest.enabledByDefault !== false,
        skills: r.skills.map((s) => s.name),
        agents: r.agents.map((a) => a.name),
      }));
    },
    bundles() {
      return [...registered.values()]
        .filter((r) => r.skills.length || r.agents.length)
        .map((r) => ({
          id: r.id,
          shipped: r.shipped === true,
          skills: r.skills.map((s) => ({ ...s })),
          agents: r.agents.map((a) => ({ ...a })),
        }));
    },
    updateBundle(pluginId, skills, agents) {
      const rec = registered.get(String(pluginId));
      if (!rec) return false;
      rec.skills = Array.isArray(skills) ? skills : [];
      rec.agents = Array.isArray(agents) ? agents : [];
      return true;
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
    // Most of the `_host` table is exempt from the surface gate (see dispatch),
    // so a test pins the whole table as a literal — a new method must edit that
    // list rather than inherit web reach from the early return.
    _hostMethodNames: () => Object.keys(hostMethods),
    _hookCounts: () => ({
      create: createHooks.size,
      exit: exitHooks.size,
      text: [...textHooks.values()].reduce((n, s) => n + s.size, 0),
    }),
  };
  return api;
}

module.exports = { createPluginHostEngine };
