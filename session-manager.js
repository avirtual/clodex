// session-manager.js — the SessionManager class: PTY spawn, per-session
// lifecycle/state, activity + attention tracking, and the local end of intent
// routing (dm/who/name/context/memory/spawn/file/exec/remind/notify-user).
// Extracted verbatim from
// main.js (M4); every method body is byte-identical to the original modulo the
// dependency seams documented below.
//
// createSessionManager(deps) returns the class; main.js constructs it once at
// module load. deps carries everything the class used to read as a main.js
// module global, in three shapes:
//   * value deps  — native modules, dirs, timing consts, the M3 infra objects
//     (registry/Transport/isAlive, JsonlWatcher, ProxyClient), and the pure
//     module-level helpers. Bound once, referenced under their original names.
//   * getter deps — getPersistence, getUiSettings, getPromptLibrary,
//     getAgentLibrary, getRemoteServer, getPeerManager. The stores and the
//     late-bound singletons (remoteServer/peerManager) are assigned in
//     app.whenReady(), AFTER this class is constructed, so they cross as
//     getters — a captured value would be undefined. Each in-class use is getX().
//   * electron seam fns — getUserDataPath, openPath, notifyOS, setAppQuitting.
//     This class NEVER requires('electron'). Its only electron touches were
//     app.getPath('userData') (×2), shell.openPath (×1), the two Notification
//     toasts, and the appQuitting write; all four cross as injected fns. The
//     isFocused gating for the toasts STAYS here (it reads the owning window) —
//     only the Notification construction lives behind notifyOS(). (The dep is
//     notifyOS, not notify, because _emitActivity already has a boolean `notify`
//     parameter that would otherwise shadow it.)
//
// WINDOW BRIDGE / opaque-handle contract: this class owns the
// workspaceId -> BrowserWindow Map (registerWindow/unregisterWindow) and reaches
// windows only through five handle methods — .webContents.send(),
// .isDestroyed(), .isFocused(), .show(), .focus(). It never imports electron to
// do so, which is the whole point. Adding any other electron touch to this
// class is a regression: route it through a new injected dep instead.
//
// LANDMINE (preserved exactly): in the ptyProc.onExit handler, _sendToSession
// MUST run BEFORE _cleanup — _cleanup drops the session from the map that
// session -> workspace -> window resolution depends on, so reversing the order
// strands a dead sidebar tab. See the onExit block in create() (the inline
// comment there marks it) and _cleanup.

// [agent:notify-user] body cap. The inbox is an attention channel, not a
// payload store; a note over this bounces with a "keep it a summary" nudge so a
// runaway turn can't bloat the UI-rendered-wholesale notifications store.
const NOTIFY_USER_MAX_BYTES = 16 * 1024;

// Tee-blind backend detection (Bedrock/Vertex). Pure fs/os/path leaf, required
// directly like ./wire-intents — it's stateless and electron-free, so it needs
// no dep seam. See the wire-intent cutover gate in create().
const { readEffectiveClaudeEnv, teeBlindBackend } = require('./claude-env');
const {
  RELAY_ROSTER_TTL_MS, RELAY_MAX_HOPS,
  buildRelayEnvelope, buildTerminalDm, isRelayEnvelope, hopRule, relayVersionOk,
} = require('./relay-protocol');
// Boiling-pot tier-1 producer + read-time merge (docs/boiling-pot-plan.md).
// Pure electron-free leaves, required directly like ./claude-env — no dep seam.
const { createFileHeat, aggregateStates, normalizeState, foldRedundancy } = require('./file-heat');
const { readJsonSafe } = require('./fs-util');

// A blocking registry file (agent.json) is STALE — safe to force-clean and
// re-register over — when the process it names is dead, OR when it names OUR OWN
// pid for a session this process isn't running. The latter is the deterministic-
// pid case: in Docker the engine is the same pid every boot, so an agent.json
// surviving an unclean shutdown always points at the new engine itself and a bare
// isAlive() check would read it as "running elsewhere" forever, wedging restore
// and fresh create under that name. Desktop is unaffected — a genuinely-other
// Clodex sharing ~/.clodex never has our pid. Pure so it can be tested without the
// create() spawn machinery.
function isStaleRegistration(existingPid, ownPid, isAlive) {
  return !isAlive(existingPid) || existingPid === ownPid;
}

function createSessionManager(deps) {
  const {
    AGENT_NAME_RE,
    COMPACT_CONTINUATION_DELAY,
    COMPACT_INFLIGHT_TIMEOUT,
    DEFAULT_COMPACT_CONTINUATION,
    DEFAULT_WORKSPACE_ID,
    INJECT_HOLD_TIMEOUT,
    INJECT_QUIET_MAXWAIT,
    INJECT_QUIET_MS,
    InjectQueue,
    JsonlWatcher,
    LONG_TEXT_DELAY,
    LONG_TEXT_THRESHOLD,
    MSG_DIR,
    MSG_SPILL_THRESHOLD,
    OUTBOX_DIR,
    PENDING_DIR,
    ProxyClient,
    REGISTRY_DIR,
    RELOAD_CONTINUATION_DELAY,
    SCROLLBACK_MAX,
    SELF_LABEL,
    SHORT_TEXT_DELAY,
    Transport,
    WIRE_INTENTS_LIVE,
    WIRE_SHADOW,
    buildAgentsArg,
    buildIpcPrompt,
    childProcess,
    claimParkedById,
    classifyNotification,
    cleanupClaudeHook,
    cleanupCodexHook,
    cleanupSkillPlugin,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    ctxReminderFor,
    diagSummary,
    diagWarning,
    draftChunkSignal,
    drainPending,
    countPending,
    enqueueOutbox,
    ensureDir,
    execBodyCap,
    fs,
    intentEnabled,
    isAlive,
    isDigested,
    isDraftOpen,
    isFilenameToken,
    isHumanPtyInput,
    isInjectInFlight,
    canFireCompact,
    lastTranscriptWrite,
    log,
    fencedLines,
    looksLikeIntent,
    memoryStore,
    mergeClaudeSystemPrompt,
    mergeCodexInstructions,
    normalizeProxyBase,
    noteFileTouches,
    os,
    outboxHasOrigin,
    parkDelivery,
    parkIdInUse,
    parseAndValidate,
    parseCtxFile,
    parseIntent,
    parseRemindSpec,
    path,
    pathFor,
    peerStatusLabel,
    pty,
    randBase36,
    readAppendBodies,
    refreshAppMenu,
    refreshTrayMenu,
    registry,
    resolveProxyAgentId,
    resolveProxyBase,
    resolveSystemPromptFile,
    runDirFor,
    scheduleTrayRefresh,
    setupClaudeHook,
    setupCodexHook,
    shadowIntentKey,
    shouldHoldDm,
    spillToFile,
    stripLevelOf,
    unionEnabled,
    vetFileIntent,
    whichBin,
    writeClaudeDigestFile,
    writeSkillPlugin,
    // getter deps (whenReady-assigned; see header)
    getPersistence, getTemplates, getUiSettings, getPromptLibrary, getAgentLibrary, getRemoteServer, getPeerManager, getRemindScheduler, getNotifications,
    // electron seam fns (see header)
    getUserDataPath, openPath, notifyOS, setAppQuitting,
  } = deps;

  class SessionManager {
    constructor() {
      this.sessions = new Map();
      this.windows = new Map(); // workspaceId -> BrowserWindow
      // Origins (consumer labels) we've received an inbound wire DM from this run —
      // the box routes outbound DMs to an outbox only for an origin it has heard
      // from (plus any origin dir still on disk after a restart). Runtime-only.
      this._knownDmOrigins = new Set();
      // Hub-relay federation (spoke side): relay rosters a hub pushed us, keyed by
      // `via` (the hub's label). Each value is { roster:[{name,origin,type}], at }.
      // The via-table (origin → via) and the [agent:who] relay listing both derive
      // from this, gated on freshness (RELAY_ROSTER_TTL_MS — a roster not refreshed
      // within the window means the hub's leg dropped). Runtime-only, like
      // _knownDmOrigins.
      this._relayRosters = new Map();
      // name -> last-broadcast parked-DM count, so the pending-count poll emits
      // deltas only (see startPendingPoll). Entry dropped when count returns to 0.
      this._lastPendingCounts = new Map();
      this._wire = null;       // in-process tee (WIRE_SHADOW only in W1)
      this._shadow = null;     // wire-vs-jsonl intent differ
      this._wireTelemetry = null; // W2 step-4 dark bridge (wire-telemetry.js)
      // W3 intent cutover (wire-intents.js): claim-once intent ledger shared by
      // the wire dispatch and the tee-failure recovery watcher, and the
      // wire-event-fed activity tracker. Built eagerly — they're pure state,
      // and the JSONL path never touches them.
      const { IntentDeduper, ActivityTracker } = require('./wire-intents');
      this._intentDeduper = new IntentDeduper();
      this._activity = new ActivityTracker((name, state, { turnEnd }) => {
        // Notify only on a REAL turn end (stop.is_turn) — the quiet-gap idle
        // (mid-turn tool run gone silent) isn't "finished". The JSONL path
        // notified on every 1s flush; this is the honest version.
        this._emitActivity(name, state, state === 'idle' && turnEnd);
      });
    }

    // --- In-process wire tee (Phase W1, shadow mode) ---

    // Lazy singleton: first claude spawn under WIRE_SHADOW brings the tee up.
    // Ephemeral port, per-agent tokens. Everything observed goes to the
    // shadow log; the JSONL path stays the live intent authority.
    async _ensureWire() {
      if (this._wire) return this._wire;
      const { rearmPlan } = require('./wire/hold'); // pure re-arm math (used in the turn hook below)
      const { WireProxy } = require('./wire/proxy');
      const { isSubagentRole } = require('./wire/role');
      const { ShadowDiff } = require('./wire/shadow');
      // Prefix-warmth ledger (W2): durable, same schema as proxylab but its
      // own file (hashes differ by construction — wire/warmth.js header).
      // Store failure never blocks the wire: warmth is telemetry-only.
      let warmth = null;
      try {
        const { WarmthStore } = require('./wire/warmth');
        warmth = new WarmthStore({ path: path.join(getUserDataPath(), 'wire-warmth.sqlite') });
      } catch (e) {
        this._shadowLog({ type: 'wire-warmth-unavailable', error: e.message });
      }
      // Keep-warm driver (W2 step 5): replayable last-request cache + hold
      // auto-pinger, warm-only gated against the warmth store. Passive until
      // something arms a hold (app-side arm/disarm lands with the W2 renderer
      // cutover); its tick loop is unref'd and costs nothing while idle.
      let hold = null;
      if (warmth) {
        try {
          const { HoldKeeper } = require('./wire/hold');
          hold = new HoldKeeper({ warmth });
          hold.on('hold', (ev) => this._shadowLog({ type: 'wire-hold', ...ev }));
          hold.on('hold', (ev) => this._onHoldLifecycle(ev)); // operator-facing subset → clodex.log
          hold.start();
        } catch (e) {
          this._shadowLog({ type: 'wire-hold-unavailable', error: e.message });
          hold = null;
        }
      }
      this._holdKeeper = hold;
      const wire = new WireProxy({ requireTokens: true, warmth, hold });
      await wire.listen();
      this._shadow = new ShadowDiff((rec) => this._shadowLog(rec));
      wire.on('turn.completed', (t) => {
        try {
          // Activity: every non-side-call completion feeds the tracker; only a
          // main-line terminal stop (is_turn) reads as "finished". Wire-owned
          // sessions only — the JsonlWatcher owns activity everywhere else.
          {
            const s = this.sessions.get(t.agent);
            if (s && s.intentSource === 'wire') {
              this._activity.turnCompleted(t.agent, { reqId: t.reqId, sideCall: t.sideCall, stop: t.stop });
            }
          }
          // Touched files + boiling-pot heat ride every non-side-call receipt —
          // subagent turns included (their edits are real file touches / real
          // carriage; the jsonl path never saw them cleanly, the wire does).
          if (!t.sideCall) {
            const s = this.sessions.get(t.agent);
            if (s) {
              if (Array.isArray(t.files) && t.files.length) this._noteFileTouches(s, t.files, isSubagentRole(t.role));
              this._recordHeat(s, t.reads, t.files);
            }
          }
          if (t.sideCall || isSubagentRole(t.role)) return; // intents: main line only
          const intents = this._extractIntents(t.text);
          this._shadowLog({
            type: 'wire-turn', agent: t.agent, sessionId: t.sessionId,
            role: t.role, reqId: t.reqId, textLen: t.text.length,
            intents: intents.length,
          });
          const s = this.sessions.get(t.agent);
          // Prompt-state fact for auto-compact-before-cold: only a terminal
          // main-line stop (stop.is_turn) parks the CLI at its input prompt. A
          // non-terminal stop that then goes quiet is a PAUSED turn — typically
          // a permission dialog, where an injected Enter would answer the
          // dialog. shouldAutoCompact requires this latch to be terminal.
          if (s) s.lastMainStop = { isTurn: !!(t.stop && t.stop.is_turn), ts: Date.now() };
          // Boot-digest append-once: a conversation missing from the digest
          // ledger (resumed from before the feature, or born with an empty
          // store that has units now) gets the digest right after a terminal
          // turn — the cache is hot (append rides at cache-read prices) and
          // the CLI is parked at its prompt.
          if (s && t.stop && t.stop.is_turn) this._maybeDeliverDigest(s, t.sessionId || s.sessionId);
          if (s && s.intentSource === 'wire') {
            // W3 LIVE path: dispatch off the wire receipt. A healthy main-line
            // turn also ends any tee-failure recovery window (the sentinel's
            // stop() flushes its pending text back through this same deduper,
            // so the handover turn can't double-fire). Dispatch is deferred off
            // the wire's finalize callback — _handleIntent can kill/inject
            // PTYs and even unregister this agent from the wire (reload).
            if (s.sentinel) s.sentinel.noteWireHealthy();
            // Per-batch Set: LOAD-BEARING, not a nicety. The deduper allows
            // wire-after-wire (distinct turns), so two IDENTICAL intents in ONE
            // turn's text both pass the cross-turn claim — this Set is the only
            // thing stopping that intra-turn double-fire. Do not "simplify" away.
            const fired = new Set();
            for (const intent of intents) {
              const bkey = shadowIntentKey(t.agent, intent);
              // exec is EXEMPT from intra-turn dedup: two identical registered-
              // command calls in one turn are both legitimate emissions (an
              // idempotent-but-intended retry, or two data packets that serialize
              // the same), unlike a double-pasted dm. The cross-path claim below
              // still guards against a tee-failure replay double-running it.
              if (intent.type !== 'exec' && fired.has(bkey)) {
                log.warn('intent', `intra-turn dup ${intent.type} ${t.agent} — swallowed`);
                continue;
              }
              const v = this._intentDeduper.claim(t.agent, bkey, 'wire');
              if (!v.ok) {
                log.warn('intent', `drop ${intent.type} ${t.agent}: ${v.reason}`);
                this._shadowLog({ type: 'intent-drop', agent: t.agent, intentType: intent.type, source: 'wire', reason: v.reason });
                continue;
              }
              fired.add(bkey);
              setImmediate(() => this._handleIntent(t.agent, intent));
            }
            // Compact LATCH fire (wire-owned Claude only): a [agent:context
            // compact] this turn set _compactPending synchronously in
            // _handleContextIntent (dispatched above via setImmediate — FIFO, so
            // this check, ALSO setImmediate, runs after the dispatch loop's
            // handlers have set the latch). Fire the real /compact only on a
            // TERMINAL main-line stop with both queues empty (canFireCompact) —
            // Claude Code silently drops slash commands while busy. If the queue
            // is non-empty (or this stop is non-terminal) the latch waits for the
            // next terminal stop; no timers. Normal case degenerates to today's
            // behavior: the emitting turn is usually terminal with nothing queued,
            // so this fires it on the very next receipt.
            if (t.stop && t.stop.is_turn) {
              setImmediate(() => this._maybeFireCompactLatch(s));
            }
            // Identity backstop: the sentinel's symlink poll is the primary
            // (it fires at CLI boot, before any turn); the receipt keeps
            // persistence honest even if the hook's symlink got wiped — but
            // only a CORROBORATED id may rebind (see _wireSessionCorroborated:
            // the wire attributes by proxy route, so a child claude spawned
            // inside the session mints stray main-line-looking ids; rebinding
            // to one would point the next --resume at the child's conversation).
            if (t.sessionId && s.sessionId !== t.sessionId) {
              if (this._wireSessionCorroborated(s, t.sessionId)) {
                s.sessionId = t.sessionId;
                getPersistence().setSessionId(t.agent, t.sessionId);
                this._noteConversationForDigest(s, t.sessionId);
              } else {
                this._shadowLog({ type: 'wire-stray-session', agent: t.agent, sessionId: t.sessionId });
              }
            }
            // Keep-warm re-arm across restart: the HoldKeeper is memory-only
            // (wire/hold.js), so an armed hold dies on app restart while its
            // INTENT survives on the sessions.json record. Restore it off the
            // first main-line turn — the organic turn just warmed the prefix, so
            // the warm-gated arm succeeds. Guard UNTIL armed (not once-per-spawn):
            // a decline this turn retries next turn, so a hold is never silently
            // re-lost. Keyed by s.sessionId (the corroborated identity above).
            if (this._holdKeeper && !s._holdRearmed) {
              try {
                const p = getPersistence();
                const rec = p.list().find((x) => x.name === t.agent);
                const plan = rearmPlan(rec && rec.holdUntil, Date.now());
                if (!plan) {
                  s._holdRearmed = true; // nothing persisted — stop re-checking this spawn
                } else if (plan.clear) {
                  p.setHoldUntil(t.agent, null);
                  s._holdRearmed = true;
                  log.info('keepwarm', `disarmed ${t.agent} (expired before re-arm)`);
                } else if (plan.arm && s.sessionId) {
                  const r = this._holdKeeper.arm(s.sessionId, plan.hours);
                  if (r && r.armed && r.until) {
                    s._holdRearmed = true;
                    p.setHoldUntil(t.agent, Math.round(r.until * 1000)); // clamped truth
                    log.info('keepwarm', `re-armed ${t.agent} ${plan.hours.toFixed(2)}h remaining ` +
                      `until ${new Date(r.until * 1000).toISOString()}`);
                  }
                  // decline (prefix not warm yet) → leave the guard, retry next turn
                }
              } catch (e) {
                this._shadowLog({ type: 'wire-hold-rearm-error', agent: t.agent, error: e.message });
              }
            }
          } else if (s && s.agentType === 'claude') {
            // Shadow-compare mode (CLODEX_WIRE_INTENTS=0): record wire
            // sightings for the differ; the JSONL path stays live.
            for (const intent of intents) {
              this._shadow.record('wire', shadowIntentKey(t.agent, intent), {
                agent: t.agent, sessionId: t.sessionId, intentType: intent.type,
                reqId: t.reqId,
              });
            }
          }
        } catch (e) {
          this._shadowLog({ type: 'wire-observer-error', error: e.message });
        }
      });
      // Activity opens on the request, not the response — the bar/tray dot
      // flips to "thinking" the moment a messages call leaves the CLI.
      wire.on('turn.started', (t) => {
        try {
          const s = this.sessions.get(t.agent);
          if (s && s.intentSource === 'wire') {
            this._activity.turnStarted(t.agent, { reqId: t.reqId, sideCall: t.sideCall });
          }
        } catch { /* observer-grade */ }
      });
      // W2 step-4 bridge (clodex-side, dark): shape receipts into poll-payload
      // parity + diff against ProxyPoller emissions (wire-telemetry.js). Its own
      // listener so the shadow-intent handler above stays untouched; every
      // WireTelemetry method swallows its own errors.
      try {
        const { WireTelemetry } = require('./wire-telemetry');
        // Lifetime-totals continuity: wire totals are per-launch; this file
        // carries each session's cumulative base across restarts (and imports
        // wirescope's persisted history via seedLifetime while it still runs).
        const totalsPath = path.join(getUserDataPath(), 'wire-totals.json');
        const persistTotals = {
          read: () => JSON.parse(fs.readFileSync(totalsPath, 'utf8')),
          write: (obj) => fs.writeFileSync(totalsPath, JSON.stringify(obj)),
        };
        this._wireTelemetry = new WireTelemetry({ warmth, hold, log: (rec) => this._shadowLog(rec), persist: persistTotals });
        wire.on('turn.completed', (t) => this._wireTelemetry.noteTurn(t));
      } catch (e) {
        this._shadowLog({ type: 'wire-telemetry-unavailable', error: e.message });
      }
      wire.on('session', (ev) => this._shadowLog({ type: 'wire-session', ...ev }));
      // Failed request: no receipt will come for this reqId. Unstick activity;
      // for a wire-owned session a tee-failure also means that turn's TEXT (and
      // any intents in it) is lost to the wire — arm the transcript recovery
      // watcher: the CLI writes the turn to the transcript regardless, and the
      // sentinel replays the tail through the same dedupe'd dispatch until the
      // wire produces a healthy main-line turn again. Visible, not silent: the
      // IPC log broadcast is the W3 form of the "tee-failure must disable/
      // degrade wire-fed controls visibly" contract — the degradation IS the
      // fallback path, announced.
      const onWireFailure = (ev, kind) => {
        this._shadowLog({ type: kind, ...ev });
        try {
          this._activity.requestFailed(ev.agent, ev.reqId);
          const s = this.sessions.get(ev.agent);
          if (s && s.intentSource === 'wire' && s.sentinel && !s.sentinel.recovering) {
            s.sentinel.armRecovery((text) => {
              // Same per-batch Set as the wire loop (load-bearing — see there).
              const fired = new Set();
              for (const intent of this._extractIntents(text)) {
                const bkey = shadowIntentKey(ev.agent, intent);
                if (fired.has(bkey)) {
                  log.warn('intent', `intra-turn dup ${intent.type} ${ev.agent} — swallowed`);
                  continue;
                }
                const v = this._intentDeduper.claim(ev.agent, bkey, 'recovery');
                if (!v.ok) {
                  log.warn('intent', `drop ${intent.type} ${ev.agent}: ${v.reason}`);
                  this._shadowLog({ type: 'intent-drop', agent: ev.agent, intentType: intent.type, source: 'recovery', reason: v.reason });
                  continue;
                }
                fired.add(bkey);
                setImmediate(() => this._handleIntent(ev.agent, intent));
              }
            });
            this._broadcast('ipc-message', {
              type: 'system', from: ev.agent, to: ev.agent,
              body: `wire ${kind} (${ev.error}) — intent recovery armed on transcript tail`,
            });
          }
        } catch { /* observer-grade */ }
      };
      wire.on('proxy-error', (ev) => onWireFailure(ev, 'wire-error'));
      wire.on('tee-failure', (ev) => onWireFailure(ev, 'wire-tee-failure'));
      this._shadowLog({ type: 'wire-up', port: wire.port });
      this._wire = wire;
      return wire;
    }

    _shadowLog(rec) {
      try {
        fs.appendFile(
          path.join(REGISTRY_DIR, 'wire-shadow.jsonl'),
          JSON.stringify({ ts: Date.now(), ...rec }) + '\n',
          () => {},
        );
      } catch { /* shadow only — never surfaces */ }
    }

    // Resolve a wire session_id back to its (stable) session NAME — the key the
    // hold intent is persisted under. Best-effort: a /clear-rotated id may not
    // match, in which case the caller logs the raw id.
    _nameForWireSession(sid) {
      if (!sid) return null;
      for (const [name, s] of this.sessions) {
        if (s.sessionId === sid) return name;
      }
      return null;
    }

    // clodex.log keep-warm lifecycle (INFO/WARN). The shadow log carries the
    // full firehose (armed / re-anchored / ping / disarmed) for forensics; THIS
    // is the operator-facing subset Bogdan went looking for and found empty:
    // disarms and ping FAILURES only — successful pings and re-anchors stay
    // shadow-only (263 re-anchors in one run is too chatty for clodex.log).
    // Failure-strikes also CLEAR the persisted intent (a dead credential must
    // not re-arm on the next restart); expiry/max-pings just log — the field
    // clears lazily on the next re-arm check. Explicit ('off') disarms are
    // logged+cleared by the wire:hold handler, so they're skipped here.
    // Re-anchors are quiet but DO persist: every organic turn restarts the
    // keeper's window (until = now + hours), so without this the persisted
    // holdUntil lags reality and a restart late in a re-anchored window would
    // wrongly lapse-clear a still-valid hold.
    _onHoldLifecycle(ev) {
      try {
        if (!ev) return;
        if (ev.event === 're-anchored') {
          const name = this._nameForWireSession(ev.session);
          if (name && ev.until > 0) getPersistence().setHoldUntil(name, Math.round(ev.until * 1000));
          return;
        }
        if (ev.event === 'disarmed') {
          if (ev.cause === 'off') return;
          const name = this._nameForWireSession(ev.session);
          if (ev.cause === 'failures' && name) getPersistence().setHoldUntil(name, null);
          log.info('keepwarm', `disarmed ${name || ev.session} (${ev.cause || 'unknown'}` +
            `${ev.pings != null ? `, ${ev.pings} pings` : ''})`);
        } else if (ev.event === 'ping' && ev.result && ev.result.ok === false && !ev.result.skipped) {
          const name = this._nameForWireSession(ev.session);
          const r = ev.result;
          log.warn('keepwarm', `ping FAILED ${name || ev.session}: ${r.reason || r.status_code || 'error'}`);
        }
      } catch { /* logging must never break the emitter */ }
    }

    // --- Window <-> workspace registration ---

    registerWindow(workspaceId, win) {
      this.windows.set(workspaceId, win);
    }

    unregisterWindow(workspaceId) {
      this.windows.delete(workspaceId);
    }

    windowForWorkspace(workspaceId) {
      const w = this.windows.get(workspaceId);
      return w && !w.isDestroyed() ? w : null;
    }

    // Reverse lookup for callers holding only a BrowserWindow (the View-menu
    // zoom persists per workspace). null for non-workspace windows (wirescope).
    workspaceForWindow(win) {
      for (const [wsId, w] of this.windows) {
        if (w === win) return wsId;
      }
      return null;
    }

    windowForSession(name) {
      const s = this.sessions.get(name);
      if (!s) return null;
      return this.windowForWorkspace(s.workspaceId);
    }

    allLiveWindows() {
      const out = [];
      for (const w of this.windows.values()) {
        if (w && !w.isDestroyed()) out.push(w);
      }
      return out;
    }

    // Send an event scoped to the window that owns this session.
    // If no window is currently attached to this session's workspace,
    // buffer pty-data so it can be replayed when a window reopens.
    _sendToSession(name, channel, ...args) {
      const win = this.windowForSession(name);
      if (win) {
        win.webContents.send(channel, ...args);
        return;
      }
      // Buffer PTY output for detached sessions (no window in their workspace)
      if (channel === 'pty-data') {
        const session = this.sessions.get(name);
        if (!session) return;
        if (!session.pendingOutput) session.pendingOutput = '';
        session.pendingOutput += args[1];
        const MAX_BUFFER = 2 * 1024 * 1024; // 2MB per session
        if (session.pendingOutput.length > MAX_BUFFER) {
          session.pendingOutput = session.pendingOutput.slice(-MAX_BUFFER);
        }
      }
      // session-exit / session-activity for detached sessions: just drop.
      // They don't have a UI to notify, and the state will be recomputed
      // from scratch when a window reattaches.
    }

    // Broadcast to every window (used for app-wide events like IPC traffic)
    _broadcast(channel, ...args) {
      for (const w of this.allLiveWindows()) {
        w.webContents.send(channel, ...args);
      }
    }

    async create(name, type, cwd, extraArgs = [], resumeId = null, workspaceId = DEFAULT_WORKSPACE_ID, systemPromptBody = null, fork = false, proxy = null, agents = [], denyBuiltins = [], disabledTools = [], disabledSkills = [], injectSkills = [], systemPromptFile = null, appendPromptFiles = [], execCommands = [], intents = null) {
      if (this.sessions.has(name)) {
        throw new Error(`Session "${name}" already exists`);
      }
      // A nonexistent cwd makes the spawned CLI exit ~immediately (code 1), which
      // the UI renders as a tab that flickers and vanishes — fail loudly up front
      // instead so the dialog / spawn intent / restore path can show the reason.
      // Empty cwd stays legal (the spawn falls back to HOME below).
      if (cwd) {
        let st = null;
        try { st = fs.statSync(cwd); } catch { /* missing — handled below */ }
        if (!st) throw new Error(`Directory does not exist: ${cwd}`);
        if (!st.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
      }
      let proxyBase = resolveProxyBase(proxy, getUiSettings());

      let cmd, args;
      const shell = process.env.SHELL || '/bin/bash';
      const agentType = (type === 'claude') ? 'claude' : (type === 'codex') ? 'codex' : null;
      // W3: which mechanism owns live intent dispatch + activity for this
      // session. 'wire' only when the claude spawn actually registered with the
      // in-process wire (set below); everything else keeps the JSONL path.
      // wireRouted (bytes flow through the tee, whatever owns intents) gates
      // the shadow differ: comparing feeds only makes sense when both exist.
      let intentSource = 'jsonl';
      let wireRouted = false;
      // Which cloud backend this claude session's effective env routes to:
      // 'bedrock' (AWS) | 'vertex' (GCP) | null (Anthropic-direct / non-claude).
      // Read once at spawn from the layered .claude settings `env` blocks. Two
      // consumers: the wire-intent gate below (Bedrock/Vertex bypass the tee, so
      // they must take intents from the JsonlWatcher) and the sidebar chip glyph
      // (B/V in place of A), surfaced via the session record + list().
      const backend = agentType === 'claude' ? teeBlindBackend(readEffectiveClaudeEnv(cwd)) : null;
      // A tee-blind backend (Bedrock/Vertex) routes to AWS/GCP and IGNORES the
      // ANTHROPIC_BASE_URL a proxy needs, so wirescope can never link — it would
      // just show a permanent "Proxy: no live session" and futile poll traffic.
      // Force the proxy off at spawn (the stored preference is untouched — this
      // is cwd-derived, so removing the backend env re-honors it on respawn); the
      // status bar then falls to the CLI side-channel line (model/ctx/cost).
      if (backend && proxyBase) {
        this._shadowLog({ type: 'proxy-off-tee-blind', agent: name, backend });
        proxyBase = null;
      }

      // Stable per-session proxy identity (clodex-<name>-<nonce>). Reuse the
      // persisted one across resume/restart/restore/clear; mint fresh on a new
      // create or a fork (divergent session = fresh cost ledger); lazy-mint for
      // legacy entries that predate this field. Uniqueness enforced against both
      // persisted and live ids. See ProxyPoller / github.com/avirtual/wirescope.
      let proxyAgent = null;
      if (agentType) {
        const taken = new Set();
        for (const e of getPersistence().list()) if (e.proxyAgent) taken.add(e.proxyAgent);
        for (const s of this.sessions.values()) if (s.proxyAgent) taken.add(s.proxyAgent);
        proxyAgent = resolveProxyAgentId({ name, fork, existing: getPersistence().get(name), taken });
      }

      switch (type) {
        case 'claude': {
          cmd = 'claude';
          // IPC protocol always goes in; the posture prompt is a persistent
          // session property — applied on resume/restart too, editable via
          // the Edit Session dialog.
          // Prompt channels: a session-referenced library file replaces the base
          // system prompt (pointed at directly below), while the IPC protocol +
          // ordered library appends + any legacy inline body form the append blob.
          const sysFile = resolveSystemPromptFile(systemPromptFile);
          const appendBodies = readAppendBodies(appendPromptFiles);
          const { cleaned, append } = mergeClaudeSystemPrompt(extraArgs, buildIpcPrompt(intents), {
            appendBodies, inlineBody: systemPromptBody || null, hasSystemFile: !!sysFile,
          });
          args = cleaned;
          // Drop a stale user-persisted --settings that points into the old
          // /tmp/wb-wrap dir — keeping it would skip hook generation entirely
          // and silently break intent delivery after the ~/.clodex move.
          const staleSettings = args.findIndex(
            (a, i) => a === '--settings' && (args[i + 1] || '').startsWith('/tmp/wb-wrap/'));
          if (staleSettings !== -1) args.splice(staleSettings, 2);
          // Shadow mode: register the agent with the in-process wire BEFORE
          // the PTY exists (spawn-bound identity — the wire is never blind to
          // this agent), chaining to the external proxy when one is set. A
          // wire failure falls back to the normal path: a tee must never
          // block a session from starting.
          let wireBase = null;
          if (WIRE_SHADOW) {
            try {
              const wire = await this._ensureWire();
              wireBase = wire.registerAgent(name, {
                sessionId: resumeId || null,
                upstreams: proxyBase
                  ? { anthropic: `${proxyBase}/agent/${proxyAgent || name}/anthropic` }
                  : null,
              });
            } catch (e) {
              console.error('wire shadow unavailable, spawning unshadowed:', e.message);
            }
          }
          // Intent cutover is per-session and spawn-bound: only a session whose
          // bytes actually flow through the wire may take intents from it. A
          // wire-failed spawn stays JSONL — never a silent intent blackout.
          wireRouted = !!wireBase;
          if (wireBase && WIRE_INTENTS_LIVE) {
            // A Bedrock/Vertex-backed session ignores the ANTHROPIC_BASE_URL our
            // hook injects and routes straight to AWS/GCP, so its bytes never
            // traverse the wire tee — turn.completed never fires and the wire
            // intent scanner (plus its activity dot + touched-files) goes dark.
            // Keep the wire registration (Bedrock just ignores it, harmless) but
            // take intents from the JsonlWatcher, which reads the transcript
            // regardless of backend. That lands the session in the already-
            // supported wireRouted && intentSource==='jsonl' state (same as codex
            // / a wire-failed spawn) — no new code path.
            if (backend) this._shadowLog({ type: 'wire-tee-blind', agent: name, backend });
            else intentSource = 'wire';
          }
          if (!args.includes('--settings')) {
            const settingsPath = setupClaudeHook(name, proxyBase, proxyAgent, denyBuiltins, disabledTools, disabledSkills, wireBase);
            args.push('--settings', settingsPath);
          }
          ensureDir(MSG_DIR);
          if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
          // Suppress the auto-injected claude.ai `claude_design` connector (20
          // `mcp__claude_design__*` tools, ~4k tok/turn cache carriage) that the CLI
          // injects with no honored global opt-out. Two mechanisms, and we prefer the
          // surgical one: when this session is routed through a wirescope that strips
          // `claude_design` on the wire (advertised via /_identity
          // capabilities.strip_mcp.servers), the wire removes ONLY the design tools and
          // keeps any real project/user MCP. So we fall back to `--strict-mcp-config`
          // — which is all-or-nothing (it makes the CLI ignore ALL mcp config) — ONLY
          // when no such wire will do it: unrouted, or routed to a proxy that doesn't
          // advertise the strip (kill-switch / strip-off port). Reading the advertised
          // FACT (not assuming routed => strips) keeps a strip-off port from regressing.
          // This is self-sequencing: a pre-v0.6.13 wire advertises no strip_mcp, so the
          // gate keeps pushing strict — byte-identical to the always-strict behavior —
          // until the capable wire is deployed, then flips itself per port. Honors an
          // explicit user flag and won't fight a real `--mcp-config`. Fail-open: if the
          // proxy is momentarily DOWN at the spawn instant, probe is null and we push
          // strict (degraded-but-functional, self-heals next restart) rather than block
          // the spawn on proxy-up — a hiccup must never stop a session starting. The one
          // case that feels it: an agent that has real MCPs AND spawns in the ms-window
          // the proxy is down AND isn't restarted for a while. A comment, not a code path.
          if (getUiSettings().get().disableClaudeDesignMcp
              && !args.includes('--strict-mcp-config')
              && !args.includes('--mcp-config')) {
            let wireStripsDesign = false;
            if (proxyBase) {
              try {
                const probe = await ProxyClient.probe(proxyBase);
                const servers = probe && probe.capabilities && probe.capabilities.strip_mcp
                  && probe.capabilities.strip_mcp.servers;
                wireStripsDesign = Array.isArray(servers) && servers.includes('claude_design');
              } catch {}
            }
            if (!wireStripsDesign) args.push('--strict-mcp-config');
          }
          // clodex-managed custom subagents: a session-only, priority-2 overlay
          // (above project/user .claude/agents) read from the ~/.clodex/agents
          // library. Writes no file, touches no repo. The paired permissions.deny
          // (above) is what forces the model to actually use these lean agents.
          if (!args.includes('--agents')) {
            // Union the persisted enabled agents with any `sessions:`-scoped
            // library agents assigned to THIS session (assignment = intent —
            // computed at spawn, never written back to the record).
            const agentLib = getAgentLibrary().list();
            const effectiveAgents = unionEnabled(agents, agentLib, name);
            const agentsObj = buildAgentsArg(effectiveAgents, agentLib);
            if (agentsObj) args.push('--agents', JSON.stringify(agentsObj));
          }
          // clodex-injected skills: scaffold the enabled library subset into a
          // session-only plugin and load it via --plugin-dir. A plugin's skills/
          // join the always-on roster — the only injection door the CLI gives for
          // skills (no inline --skills flag). Writes only under ~/.clodex.
          if (!args.includes('--plugin-dir')) {
            const pluginDir = writeSkillPlugin(name, injectSkills);
            if (pluginDir) args.push('--plugin-dir', pluginDir);
          } else {
            cleanupSkillPlugin(name);
          }
          if (resumeId && !args.includes('--resume') && !args.includes('-r')) {
            args.push('--resume', resumeId);
            if (fork && !args.includes('--fork-session')) args.push('--fork-session');
          }
          // Point --system-prompt-file directly at the library file (no copy) so
          // editing the shared prompt takes effect on the next spawn; skipped when
          // the ref is missing → the CLI keeps its default system prompt.
          if (sysFile && !args.includes('--system-prompt-file') && !args.includes('--system-prompt')) {
            args.push('--system-prompt-file', sysFile);
          }
          const promptPath = pathFor(REGISTRY_DIR, name, 'appendPrompt');
          fs.writeFileSync(promptPath, append, { mode: 0o600 });
          args.push('--append-system-prompt-file', promptPath);
          break;
        }
        case 'codex': {
          cmd = 'codex';
          // Codex has one instructions channel: fold the system base + ordered
          // appends + legacy inline body into it alongside the IPC protocol.
          const codexSystemBody = systemPromptFile ? getPromptLibrary().raw('system', systemPromptFile) : null;
          const codexAppendBodies = readAppendBodies(appendPromptFiles);
          const { cleaned, merged } = mergeCodexInstructions(extraArgs, buildIpcPrompt(intents), {
            systemBody: codexSystemBody, appendBodies: codexAppendBodies, inlineBody: systemPromptBody || null,
          });
          // Build top-level flags first, then the optional `resume <uuid>`
          // subcommand — clap expects subcommands AFTER top-level args.
          args = [...cleaned];
          setupCodexHook(name, cwd);
          // `codex_hooks` was renamed to `hooks` (deprecated in codex-cli
          // ~0.139). Honor either if the user passed one in extraArgs.
          if (!args.includes('hooks') && !args.includes('codex_hooks')) args.push('--enable', 'hooks');
          if (!args.includes('--no-alt-screen')) args.push('--no-alt-screen');
          if (!args.some(a => a.startsWith('tui.status_line'))) {
            args.push('-c', codexStatusLineArg(getUiSettings()));
          }
          ensureDir(MSG_DIR);
          if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
          const instructionsPath = pathFor(REGISTRY_DIR, name, 'instructions');
          fs.writeFileSync(instructionsPath, merged, { mode: 0o600 });
          args.push('-c', `model_instructions_file=${instructionsPath}`);
          // Optional API proxy routing (skip if the user already set one in args)
          if (proxyBase && !args.some(a => a.startsWith('openai_base_url='))) {
            args.push('-c', `openai_base_url=${proxyBase}/agent/${proxyAgent || name}/openai/v1`);
          }
          if (resumeId) {
            const uuidMatch = resumeId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
            const uuid = uuidMatch ? uuidMatch[1] : resumeId;
            args.push(fork ? 'fork' : 'resume', uuid);
          }
          break;
        }
        case 'bash':
          cmd = shell;
          args = [...extraArgs];
          break;
        default:
          cmd = type;
          args = [...extraArgs];
      }

      const env = { ...process.env, TERM: 'xterm-256color' };
      if (type === 'codex') env.WB_WRAP_NAME = name;

      let ptyProc;
      try {
        ptyProc = pty.spawn(cmd, args, {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: cwd || process.env.HOME || os.homedir(),
          env,
        });
      } catch (e) {
        // node-pty's "posix_spawnp failed." hides whether the helper or the target
        // binary is at fault. Append the resolved cmd + system state so the UI alert
        // is self-diagnosing (arch mismatch is the usual answer — see diagnostics).
        // Lead with diagWarning() when it fires so the alert names the FIX
        // (npx electron-rebuild), not just the raw state.
        const d = collectSystemDiagnostics();
        const resolved = cmd && cmd.includes('/') ? cmd : whichBin(cmd);
        const warning = diagWarning(d);
        throw new Error(
          `${e.message}${warning ? ` — ${warning}` : ''} `
          + `[cmd=${cmd} resolved=${resolved || 'NOT FOUND on PATH'} `
          + `cwd=${cwd || '(home)'} ${diagSummary(d)}]`,
        );
      }

      // Registry + transport — only for agent sessions; bash sessions are private
      let transport = null;
      let socketPath = null;
      if (agentType) {
        // Bind the per-agent socket under run/<name>/ (clodex-paths grammar).
        // ensureDir here so the bind never depends on hook-setup ordering having
        // created the dir first.
        ensureDir(runDirFor(REGISTRY_DIR, name));
        socketPath = pathFor(REGISTRY_DIR, name, 'socket');
        transport = new Transport(socketPath, (msg) => {
          this._onIncoming(name, msg);
        });
        await transport.start();

        try {
          registry.register(name, socketPath);
        } catch (e) {
          // If a stale registration with a dead PID is blocking us, force-clean it
          if (e.code === 'EEXIST') {
            try {
              const existing = JSON.parse(
                fs.readFileSync(pathFor(REGISTRY_DIR, name, 'registry'), 'utf-8'),
              );
              // Stale (dead pid, or our own pid for a session we don't run — the
              // deterministic-pid Docker case) → force-clean and re-register. See
              // isStaleRegistration above for the full rationale.
              if (isStaleRegistration(existing.pid, process.pid, isAlive)) {
                registry.unregister(name);
                try { fs.unlinkSync(existing.socket); } catch {}
                registry.register(name, socketPath);
              } else {
                await transport.stop();
                throw new Error(
                  `Session "${name}" is already running elsewhere (pid ${existing.pid})`,
                );
              }
            } catch (retryErr) {
              await transport.stop();
              throw retryErr;
            }
          } else {
            await transport.stop();
            throw e;
          }
        }
      }

      const session = {
        name, type, cwd, pty: ptyProc, transport, socketPath,
        agentType, lineBuffer: '', watcher: null,
        sessionId: resumeId || null,
        workspaceId,
        proxyAgent, proxyBase,
        intentSource, wireRouted, backend, sentinel: null,
        // Touched-files feed (file-touch.js ring): which files this session's
        // file tools were aimed at. In-memory, session-lifetime — like activity.
        fileTouches: [],
        // Peer-visibility facts ([agent:who] labels, dm hold gate): state +
        // since-when, updated in _emitActivity. Restores seed from the resumed
        // transcript's mtime (= last real turn) — seeding "now" would make every
        // GUI restart reset idle clocks, mislabeling long-cold peers as fresh
        // and letting DMs to them past the hold gate for 30 minutes.
        activityState: 'idle',
        activityTs: lastTranscriptWrite(agentType, cwd, resumeId) || Date.now(),
        // Needs-attention fact from the Notification hook (attention.js):
        // { kind: 'permission'|'other', message, ts } while the CLI is blocked
        // on the human, null otherwise. Cleared on keystroke / turn start.
        needsAttention: null,
        // Auto-compact atPrompt seed. A freshly spawned or resumed CLI is by
        // definition parked at its input prompt — permission dialogs don't
        // survive PTY death. Without this seed, a GUI restart wipes the
        // in-memory turn.completed stamp and an idle restored session can NEVER
        // pass the atPrompt guard (its next turn would re-warm the cache,
        // mooting the compact). Invalidated on any keystroke (write()) or turn
        // start (_emitActivity) — only a fresh terminal wire receipt re-proves
        // the prompt after that. Unproxied sessions are still blocked by the
        // payload.linked guard, so seeding unconditionally is safe.
        lastMainStop: { isTurn: true, ts: Date.now(), seeded: true },
        // Boot-digest bookkeeping (memory-store.js): the id we resumed with
        // (any OTHER id observed later means a conversation born under this
        // session — its SessionStart hook fired with source startup/clear and
        // delivered the digest) and whether the digest file has content (an
        // empty store delivers nothing, so birth must not mark the ledger).
        bootResumeId: resumeId || null,
        // Recompute rather than re-write: setupClaudeHook already wrote the
        // digest file pre-spawn, and rewriting here would race the CLI's
        // SessionStart hook cat-ing it (writeFileSync isn't atomic).
        digestNonEmpty: agentType === 'claude' && composeDigest(memoryStore.list(name)) !== null,
      };
      this.sessions.set(name, session);

      // Persist this session so we can resume it on next launch.
      // Bash/other sessions persist too (restored as fresh shells in the
      // saved cwd); their entry is dropped on natural exit instead.
      // createdAt: stamped ONCE, at the session's first create. kill()+recreate
      // (restart/restore) rebuilds the record from spawn args, so preserve any
      // existing stamp rather than resetting it — the sidebar's "created" sort/
      // group depends on it being stable across restarts.
      const existingEntry = getPersistence().get(name);
      const createdAt = (existingEntry && existingEntry.createdAt) || Date.now();
      getPersistence().upsert({
        name, type, cwd,
        extraArgs,
        createdAt,
        sessionId: resumeId || null,
        workspaceId,
        systemPrompt: systemPromptBody || null,
        systemPromptFile: systemPromptFile || null,
        appendPromptFiles: Array.isArray(appendPromptFiles) ? appendPromptFiles : [],
        // Tri-state, NOT the resolved base: inheriting sessions must keep
        // following the Clodex-level preference across restarts.
        proxy: typeof proxy === 'string' ? normalizeProxyBase(proxy) : (proxy === false ? false : null),
        proxyAgent,
        agents: Array.isArray(agents) ? agents : [],
        denyBuiltins: Array.isArray(denyBuiltins) ? denyBuiltins : [],
        disabledTools: Array.isArray(disabledTools) ? disabledTools : [],
        disabledSkills: Array.isArray(disabledSkills) ? disabledSkills : [],
        injectSkills: Array.isArray(injectSkills) ? injectSkills : [],
        // Intent-gate allowlist is spawn-time config (it bakes into the append
        // blob — see buildIpcPrompt in the claude/codex arms), so it's a create()
        // param persisted by create()'s OWN upsert, not a post-create seed. That's
        // what makes it survive kill()+recreate restarts, which drop the record and
        // rebuild it from spawn args only (stripLevel's re-assert comment documents
        // that hole). Conditional: an ABSENT list (all-enabled default) must stay
        // absent — never freeze `intents: null` onto the record — while `[]`
        // (everything gated) is a real value that persists.
        ...(Array.isArray(intents) ? { intents: intents.map(String) } : {}),
        // execCommands is the capability grant (the allowlist of registered
        // command ids this seat may [agent:exec]). Like intents it's spawn-time
        // config that MUST survive kill()+recreate — which drops the record and
        // rebuilds it from create()'s args only — so it's a create() param
        // persisted by this own upsert, NOT a post-create seed (the hole that
        // dropped grants on every restart). Unlike intents, an empty grant is
        // NOT a distinct value: absent ≡ [] ≡ "nothing granted" (see the `|| []`
        // read in _handleIntent + the export coalesce), so omit an empty list to
        // keep the record lean — matching the template seed's prior .length guard.
        ...(Array.isArray(execCommands) && execCommands.length ? { execCommands: execCommands.map(String) } : {}),
      });

      // Turn observation for agent modes. Two mutually exclusive paths:
      //
      //   wire (W3 cutover)  claude session successfully registered with the
      //     in-process wire — intents/activity ride turn events (_ensureWire
      //     listeners); a TranscriptSentinel keeps the transcript-only jobs
      //     (symlink identity, compact rendezvous, tee-failure recovery).
      //     Steady-state transcript PARSING: none.
      //
      //   jsonl (legacy)  codex sessions (no wire route yet), wire-failed
      //     spawns, and CLODEX_WIRE_INTENTS=0 — the full JsonlWatcher, exactly
      //     the pre-cutover behavior (incl. shadow-compare when wire-routed).
      const onSessionId = (sessionId) => {
        session.sessionId = sessionId;
        getPersistence().setSessionId(name, sessionId);
        this._noteConversationForDigest(session, sessionId);
      };
      if (agentType && session.intentSource === 'wire') {
        const { TranscriptSentinel } = require('./wire-intents');
        session.sentinel = new TranscriptSentinel({
          linkPath: pathFor(REGISTRY_DIR, name, 'transcript'),
          onSessionId,
          // The sentinel never parses transcripts itself: armed windows get a
          // real JsonlWatcher (starts at EOF — exactly the "tail from now"
          // semantics both the compact rendezvous and recovery replay need).
          makeWatcher: ({ onText, onCompactSummary }) => new JsonlWatcher(
            name, onText || (() => {}), () => {}, () => {}, onCompactSummary || (() => {})),
        });
        session.sentinel.start();
      } else if (agentType) {
        session.watcher = new JsonlWatcher(
          name,
          (text) => this._scanJsonlText(text, name),
          onSessionId,
          (state) => this._emitActivity(name, state, state === 'idle'),
          () => this._fireCompactContinuation(session),
          (touches) => this._noteFileTouches(session, touches),
        );
        session.watcher.start();
      }

      // Claude sidechannel: statusline script writes numeric ctx% to a file;
      // tail it to decorate the sidebar tab.
      if (agentType === 'claude') {
        const ctxPath = pathFor(REGISTRY_DIR, name, 'ctx');
        let lastRaw = null;
        const readCtx = () => {
          try {
            const raw = fs.readFileSync(ctxPath, 'utf-8').trim();
            if (raw === lastRaw) return; // push on any field change (pct or tokens)
            lastRaw = raw;
            const c = parseCtxFile(raw);
            if (c.pct != null) {
              this._sendToSession(name, 'session-ctx', name, c.pct, c.tok, c.size, c.cost, c.modelName);
              // Kept for peer attach seeding (getAttachInfo) + live-mirrored to
              // attached peers, so the viewer's ctx chip tracks the owner's.
              session.ctxInfo = { pct: c.pct, tok: c.tok, size: c.size, cost: c.cost, modelName: c.modelName };
              if (getRemoteServer()) {
                try { getRemoteServer().pushTelemetry(name, { ctx: session.ctxInfo }); } catch {}
              }
              // High-context reminder side-channel: when the absolute token count
              // crosses a threshold, drop a {name}-ctxwarn file whose contents the
              // UserPromptSubmit hook cats into additionalContext (nudging the agent
              // to self-compact on its next turn — no PTY interruption). Removed
              // when it drops back under threshold (post-compact). Idempotent: the
              // file content is stable, so re-writing it on every ctx tick is fine.
              const warnPath = pathFor(REGISTRY_DIR, name, 'ctxwarn');
              const warn = ctxReminderFor(c.tok);
              try {
                if (warn) fs.writeFileSync(warnPath, warn);
                else fs.rmSync(warnPath, { force: true });
              } catch {}
            }
          } catch {}
        };
        // Needs-attention tail: the Notification hook appends raw event JSON to
        // attn.jsonl (truncated at setup — offset 0 is always fresh). Rides the
        // same per-agent run-dir watch as the ctx sidechannel.
        const attnPath = pathFor(REGISTRY_DIR, name, 'attn');
        let attnOffset = 0;
        const readAttn = () => {
          try {
            const st = fs.statSync(attnPath);
            if (st.size <= attnOffset) return;
            const fd = fs.openSync(attnPath, 'r');
            const buf = Buffer.alloc(st.size - attnOffset);
            fs.readSync(fd, buf, 0, buf.length, attnOffset);
            fs.closeSync(fd);
            attnOffset = st.size;
            for (const line of buf.toString('utf-8').split('\n')) {
              if (!line.trim()) continue;
              let entry = null;
              try { entry = JSON.parse(line); } catch {}
              this._onAttention(session, entry || {});
            }
          } catch { /* observer-grade */ }
        };
        // Watch the per-agent run dir (not the shared root) — the ctx/attn files
        // are now run/<name>/{ctx,attn.jsonl} with unsuffixed basenames.
        try {
          session.ctxWatcher = fs.watch(runDirFor(REGISTRY_DIR, name), (_event, fname) => {
            if (fname === 'ctx') readCtx();
            else if (fname === 'attn.jsonl') readAttn();
          });
        } catch {}
        readCtx();
      }

      ptyProc.onData((data) => {
        // Always-on scrollback ring: what a peer attach replays. Best-effort
        // recent output, not terminal state — capped small.
        session.scrollback = ((session.scrollback || '') + data);
        if (session.scrollback.length > SCROLLBACK_MAX) {
          session.scrollback = session.scrollback.slice(-SCROLLBACK_MAX);
        }
        this._sendToSession(name, 'pty-data', name, data);
        if (getRemoteServer()) { try { getRemoteServer().pushOutput(name, data); } catch {} }

        // In agent mode, PTY output is pass-through (intents come from JSONL)
        if (!agentType) {
          this._scanPtyOutput(session, data);
        }
      });

      ptyProc.onExit(({ exitCode, signal }) => {
        // The native fd is gone the moment the process exits; any later
        // write/resize/kill into node-pty throws an uncaught Napi::Error that
        // aborts the whole app (SIGABRT). Mark dead so deferred ops bail.
        session._dead = true;
        log.info('session', `exit ${name} code=${exitCode}${signal ? ` signal=${signal}` : ''}`);
        // Every deliberate teardown flags the session first (kill() →
        // _userKilled, which restart also routes through; killAll() →
        // _shuttingDown), so an unflagged exit means the process died on its
        // own — the renderer uses that to surface it instead of silently
        // dropping the tab.
        const expected = !!(session._userKilled || session._shuttingDown);
        // Send the exit event BEFORE cleanup so the renderer can still resolve
        // the session → workspace → window mapping. Otherwise the sidebar
        // tab sticks around as a "dead" entry.
        this._sendToSession(name, 'session-exit', name, exitCode, { expected, signal: signal || null, agentType: agentType || null });
        // Exit observability: an always-on IPC-log entry (every exit, any type) so
        // a vanished tab leaves a forensic trace — grep-stable body: `code=N`
        // always, ` signal=X` / ` unexpected` only when applicable. Physically
        // before _cleanup for handler ordering discipline (this send doesn't ride
        // the session→window map, but the next editor shouldn't have to re-derive
        // which sends do — see the _sendToSession landmine above).
        this._broadcast('ipc-message', {
          type: 'exit', from: name, to: 'exit',
          body: `code=${exitCode}${signal ? ` signal=${signal}` : ''}${expected ? '' : ' unexpected'}`,
        });
        if (getRemoteServer()) { try { getRemoteServer().notifyExit(name, exitCode); } catch {} }
        // Agents keep their entry on natural exit (they get --resume'd next
        // launch). A shell exiting naturally (user typed `exit`) is done —
        // don't respawn it forever. Quit-kills keep entries for restore.
        if (!agentType && !session._shuttingDown && !session._userKilled) {
          getPersistence().remove(name);
        }
        this._cleanup(name);
        if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
        if (typeof refreshAppMenu === 'function') refreshAppMenu();
      });

      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
      if (typeof refreshAppMenu === 'function') refreshAppMenu();
      if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
      log.info('session', `spawn ${name} (${type}) pid=${ptyProc.pid}${resumeId ? ' resumed' : ''} cwd=${cwd}`);
      return { name, type, pid: ptyProc.pid, backend };
    }

    write(name, data) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      // Only HUMAN input carries meaning below — focus reports and terminal
      // query replies ride the same onData path with nobody at the keyboard
      // (isHumanPtyInput). Stamping on those killed the atPrompt latch every
      // time the user merely looked at a pane, which starved auto-compact of
      // its window on any session the user ever viewed.
      if (isHumanPtyInput(data)) {
        // A human touched this pane — auto-compact's quiet-window fact (injecting
        // /compact starts with Ctrl-U, which would eat a half-typed draft).
        s.lastUserInputTs = Date.now();
        // Level-triggered draft latch (isDraftOpen): a chunk carrying Enter/Ctrl-C
        // OUTSIDE a bracketed-paste region CLOSES the draft (stamp submit ts); any
        // other keystroke leaves it open. draftChunkSignal is stateful across
        // chunks (a large paste's 200~…201~ region can span reads), so we thread
        // s._inPaste through. This is what the inject park divert reads to decide,
        // at fire time, whether the operator is still mid-composition. Peer-
        // controller remote input rides this same choke point, tracked for free.
        const sig = draftChunkSignal(data, s._inPaste);
        s._inPaste = sig.inPaste;
        if (sig.closes) s.lastUserSubmitTs = s.lastUserInputTs;
        // And drop the atPrompt latch: a user at the keyboard can open dialog UIs
        // WITHOUT an API turn (/permissions et al.) — the quiet window only covers
        // 2 minutes, a dialog can sit until warmth expiry. Only the next terminal
        // wire receipt re-proves the prompt. Fails toward a missed compact.
        s.lastMainStop = null;
        // A keystroke in the pane means the human is handling whatever the CLI
        // asked for — clear the needs-attention badge (and the dm dialog gate;
        // this same keystroke is what answers the dialog).
        if (s.needsAttention) this._setAttention(s, null);
      }
      // node-pty throws Napi::Error from C++ if the fd closed under us; never
      // let it escape — an unhandled native throw aborts the app.
      try { s.pty.write(data); } catch {}
    }

    resize(name, cols, rows, requester = 'owner') {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      try { s.pty.resize(cols, rows); } catch {}
      // Observability: this is the sole owner-side PTY-mutation path in the peer
      // surface, so log who reflowed the terminal and to what. Dedup on settled
      // dims per session — resize bursts during window drags, and only a real
      // geometry change (or a change of requester) is worth a line. This is what
      // arbitrates the "does a read-only viewer ever perturb the owner" question:
      // every legitimate perturbation must carry requester='peer-control'.
      const key = `${s.pty.cols}x${s.pty.rows}:${requester}`;
      if (s._lastLoggedResize !== key) {
        s._lastLoggedResize = key;
        log.info('resize', `${name} ${s.pty.cols}x${s.pty.rows} by ${requester}`);
      }
      // Mirror the new geometry to any read-only peer viewers so their letterbox
      // follows the owner's. This is the single resize choke point — both the
      // owner's own refit (session:resize IPC) and a controlling viewer's resize
      // (resizePty callback) land here — so one notify covers every case. Read
      // back the PTY's actual dims (canonical) rather than the requested ones.
      if (getRemoteServer()) {
        try { getRemoteServer().notifyResize(name, s.pty.cols, s.pty.rows); } catch {}
      }
    }

    async kill(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      log.info('session', `kill ${name} (user-initiated) pid=${s.pty.pid}`);
      // User-initiated kill — forget this session so it doesn't resume on relaunch
      s._userKilled = true;
      getPersistence().remove(name);
      try { s.pty.kill(); } catch {}
      setTimeout(() => {
        try { process.kill(s.pty.pid, 'SIGKILL'); } catch {}
      }, 5000);
    }

    // Archive: stop the PTY but KEEP the persistence record (marked archivedAt),
    // so the conversation can be resumed later. Unlike kill(), _userKilled stays
    // false so _cleanup doesn't drop parked DMs, and the record is stamped before
    // teardown so a fast _cleanup can't race the mark. Skipped by restore-spawn
    // (session-restore filters archivedAt).
    async archive(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      log.info('session', `archive ${name} pid=${s.pty.pid}`);
      getPersistence().setArchived(name, true);
      s._archived = true;
      try { s.pty.kill(); } catch {}
      setTimeout(() => {
        try { process.kill(s.pty.pid, 'SIGKILL'); } catch {}
      }, 5000);
    }

    list() {
      return Array.from(this.sessions.values()).map(s => ({
        name: s.name,
        type: s.type,
        pid: s.pty.pid,
        cwd: s.cwd,
        workspaceId: s.workspaceId,
        // Cloud backend ('bedrock'|'vertex'|null) driving the sidebar chip glyph.
        backend: s.backend || null,
        // Live turn state + dialog fact, so list() consumers (tray menu,
        // reattach seeding) don't start stale until the next activity event.
        activity: s.activityState || 'idle',
        attention: s.needsAttention ? s.needsAttention.kind : null,
        // Parked-DM count so a freshly opened window paints the ✉ badge without
        // waiting for the next pending-count delta broadcast. Claude-only store.
        pendingCount: s.agentType === 'claude' ? countPending(PENDING_DIR, s.name) : 0,
      }));
    }

    listForWorkspace(workspaceId) {
      return this.list().filter(s => s.workspaceId === workspaceId);
    }

    // Live PTY child pids of the sessions Clodex owns. Session-discovery uses
    // this to exclude Clodex's own agents from the "foreign live process" scan.
    livePids() {
      const pids = new Set();
      for (const s of this.sessions.values()) {
        if (s.pty && Number.isInteger(s.pty.pid)) pids.add(s.pty.pid);
      }
      return pids;
    }

    // Every Claude/Codex conversation id Clodex knows about — the live session
    // id plus each persisted entry's full sessionIds history. Session-discovery
    // subtracts this from the on-disk scan so already-adopted transcripts don't
    // show up as "new".
    trackedSessionIds() {
      const ids = new Set();
      for (const s of this.sessions.values()) if (s.sessionId) ids.add(s.sessionId);
      for (const e of getPersistence().list()) {
        if (e.sessionId) ids.add(e.sessionId);
        if (Array.isArray(e.sessionIds)) for (const id of e.sessionIds) ids.add(id);
      }
      return ids;
    }

    // Parked-DM count for one session (0 for non-claude). Lets the reattach
    // snapshot seed the ✉ badge without waiting for the next poll delta.
    pendingCountFor(name) {
      const s = this.sessions.get(name);
      return s && s.agentType === 'claude' ? countPending(PENDING_DIR, s.name) : 0;
    }

    // Poll the pending store for parked-DM counts and broadcast DELTAS ONLY on the
    // 'pending-count' channel, driving the sidebar ✉ badge. Poll (not event) is
    // deliberate: the UserPromptSubmit hook drains the store OUT OF PROCESS with an
    // atomic dir-rename Node never observes, so Node-side park/drain call sites
    // can't emit a complete signal — a reconcile poll is the only source of truth,
    // and one mechanism beats two. Cheap: a readdir of a handful of tiny dirs per
    // live Claude session per second (jsonl-watcher already polls at 250ms). A
    // count returning to 0 drops the map entry so the map tracks only non-zero
    // sessions. Claude-only: the store is a Claude-hook artifact (codex never parks).
    startPendingPoll(intervalMs = 1000) {
      if (this._pendingPollTimer) return;
      const tick = () => {
        const live = new Set();
        for (const s of this.sessions.values()) {
          if (s.agentType !== 'claude' || s._dead) continue;
          live.add(s.name);
          const count = countPending(PENDING_DIR, s.name);
          if ((this._lastPendingCounts.get(s.name) || 0) === count) continue;
          if (count > 0) this._lastPendingCounts.set(s.name, count);
          else this._lastPendingCounts.delete(s.name);
          this._broadcast('pending-count', { name: s.name, count });
        }
        // A session that went away with a non-zero last count: emit a final 0 so a
        // lingering badge clears, then forget it.
        for (const name of Array.from(this._lastPendingCounts.keys())) {
          if (live.has(name)) continue;
          this._lastPendingCounts.delete(name);
          this._broadcast('pending-count', { name, count: 0 });
        }
      };
      this._pendingPollTimer = setInterval(tick, intervalMs);
    }

    async killAll() {
      // App shutdown — suppress node-pty's native teardown throws from here on.
      setAppQuitting(true);
      // mark all sessions so _cleanup knows not to wipe persistence
      for (const s of this.sessions.values()) {
        s._shuttingDown = true;
      }
      for (const [name] of this.sessions) {
        const s = this.sessions.get(name);
        // Killing an already-exited PTY throws Napi::Error from node-pty's
        // native layer; unguarded on quit it aborts the app with SIGABRT.
        try { s.pty.kill(); } catch {}
      }
      // Deliberately NOT stopping the managed wirescope: it detaches at spawn
      // and outlives the GUI so warmth/cache continuity survives app restarts.
      // The next launch reattaches via its pidfile; the Traffic optimization
      // toggle (settings:set → stop()) is how it actually goes down.
    }

    _cleanup(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      clearTimeout(s._injectHoldTimer);
      clearTimeout(s._injectFlushRetry);
      clearTimeout(s._compactValveTimer);
      clearTimeout(s._parkCapTimer);
      s._compactPending = null; // no timer, but null for symmetry with the valve state
      // Drop any parked deliveries ONLY for a session going away for good — i.e. a
      // user-kill. _cleanup runs from ptyProc.onExit on EVERY exit (natural exit,
      // restart's kill, quit's killAll), so an unconditional rm would eat parked
      // DMs on a restart or app-quit inside the cap window (zero-loss violation).
      // Every other exit path respawns or restores the same name, whose pending
      // store — keyed by name, stable hook path — drains on the next submit. A
      // dir left by a never-recreated session is harmless residue. Best-effort.
      if (s._userKilled) {
        try { fs.rmSync(path.join(PENDING_DIR, name), { recursive: true, force: true }); } catch {}
      }
      if (this._wire) { try { this._wire.unregisterAgent(name); } catch {} }
      if (s.watcher) s.watcher.stop();
      if (s.fileHeat) { try { s.fileHeat.close(); } catch {} } // flush pending heat
      if (s.sentinel) { try { s.sentinel.stop(); } catch {} }
      if (s.ctxWatcher) { try { s.ctxWatcher.close(); } catch {} }
      if (s.transport) s.transport.stop();
      if (s.agentType) registry.unregister(name);
      if (s.agentType === 'claude') { cleanupClaudeHook(name); cleanupSkillPlugin(name); }
      if (s.agentType === 'codex') cleanupCodexHook(name, s.cwd);
      this.sessions.delete(name);
      const live = new Set(this.sessions.keys());
      try { this._intentDeduper.prune(live); this._activity.prune(live); } catch {}
      if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
    }

    // --- PTY output scanning (non-agent mode) ---

    _scanPtyOutput(session, data) {
      session.lineBuffer += data;
      const lines = session.lineBuffer.split(/\r?\n/);
      session.lineBuffer = lines.pop() || '';

      // Deliberately NOT fence-aware (unlike _extractIntents): this path is
      // line-at-a-time over an unbounded terminal stream, so fence state
      // would have to persist on the session — and one `cat`ed markdown file
      // with an unclosed fence would then silently disable intent scanning
      // for the rest of the pane's life. Turn text has a natural end; a PTY
      // doesn't.
      for (const line of lines) {
        const intent = parseIntent(line);
        // `end` is the body terminator — meaningless on the line-at-a-time
        // PTY path (no body capture here), swallowed like escape.
        if (!intent || intent.type === 'escape' || intent.type === 'end') continue;
        this._handleIntent(session.name, intent);
      }
    }

    // Touched-files fan-in shared by both observation paths (wire turn receipts
    // + legacy JsonlWatcher tap): fold into the session's ring and push the
    // fresh list to the owning window. Detached windows just drop the event —
    // the Files popover pulls session:files on open, so nothing is lost.
    _noteFileTouches(session, touches, sub = false) {
      try {
        noteFileTouches(session.fileTouches, touches, {
          cwd: session.cwd, ts: Date.now(), sub, resolve: path.resolve,
        });
        this._sendToSession(session.name, 'session-files', session.name, session.fileTouches);
        // Mirror the count (not the list) to attached peer viewers so their 📄N
        // badge ticks live — the full list stays pull-on-demand via the query
        // endpoint. Deduped on unchanged count: a hot re-edit of the same file
        // grows f.count but not the distinct-file count, and must not spam the
        // wire (same discipline as the resize debounce).
        const count = session.fileTouches.length;
        if (session._peerFileCount !== count) {
          session._peerFileCount = count;
          try { getRemoteServer() && getRemoteServer().pushTelemetry(session.name, { files: { count } }); } catch {}
        }
      } catch { /* observer-grade — never near the PTY/intent path */ }
    }

    // Boiling pot (docs/boiling-pot-plan.md tier 1). Lazily bind the per-agent
    // heat recorder at run/<name>/file-heat.json (created only once a turn
    // actually touches files, so idle sessions never mint an empty file).
    _fileHeatFor(session) {
      if (!session.fileHeat) {
        session.fileHeat = createFileHeat({ filePath: pathFor(REGISTRY_DIR, session.name, 'fileHeat') });
      }
      return session.fileHeat;
    }

    // Fold one turn's reads (carriage) + edits into the per-agent recorder.
    // Best-effort diagnostic — never throws on the hot wire path; recordRead is
    // fire-and-forget (its own stat is swallowed), we just guard the rejection.
    _recordHeat(session, reads, files) {
      try {
        const hasReads = Array.isArray(reads) && reads.length;
        const hasFiles = Array.isArray(files) && files.length;
        if (!hasReads && !hasFiles) return;
        const heat = this._fileHeatFor(session);
        if (!heat) return;
        if (hasReads) for (const r of reads) {
          if (r && r.path) Promise.resolve(heat.recordRead(r.path, r.offset, r.limit)).catch(() => {});
        }
        if (hasFiles) for (const f of files) { if (f && f.path) heat.recordEdit(f.path); }
      } catch { /* observer-grade — heat is a diagnostic, never worth a throw */ }
    }

    // Boiling-pot read-time view. Flush every live recorder so the on-disk files
    // are current, then merge EVERY per-agent file-heat.json (live + dead agents)
    // into one carriage-ranked snapshot (tier 1). Cross-agent merge happens HERE at
    // read time — never at write time (no shared-write contention). Then tier 2:
    // fetch wirescope's /_pot redundancy rollup once per DISTINCT proxy base
    // (global-per-base — ?session= is ignored) and fold it into the ALREADY-SLICED
    // top-N rows by path. Fold-after-slice is deliberate: redundancy never re-ranks
    // (ordering is carriage, fixed by aggregateStates), so we only fold the rows we
    // actually return. Wire-off / fetch failure degrades silently to tier-1 nulls —
    // the drawer already gates its redundant column on non-null.
    async potSnapshot(topN) {
      let snap;
      try {
        for (const s of this.sessions.values()) {
          if (s.fileHeat) { try { s.fileHeat.flush(); } catch {} }
        }
        let names = [];
        try { names = fs.readdirSync(path.join(REGISTRY_DIR, 'run')); } catch {}
        const states = [];
        for (const name of names) {
          const raw = readJsonSafe(pathFor(REGISTRY_DIR, name, 'fileHeat'));
          if (raw) states.push(normalizeState(raw));
        }
        snap = aggregateStates(states, { topN: Number.isInteger(topN) && topN > 0 ? topN : 10 });
      } catch {
        return { window: null, files: [] };
      }
      // Tier 2 — best-effort, isolated so a proxy hiccup never sinks the tier-1
      // view the drawer depends on.
      try {
        const bases = new Set();
        for (const s of this.sessions.values()) { if (s.proxyBase) bases.add(s.proxyBase); }
        if (bases.size && snap.files.length) {
          const results = await Promise.all([...bases].map((base) =>
            ProxyClient.potSeries(base).catch(() => ({ ok: false, files: [] }))));
          const potFiles = [];
          for (const r of results) { if (r && r.ok && Array.isArray(r.files)) potFiles.push(...r.files); }
          if (potFiles.length) foldRedundancy(snap.files, potFiles);
        }
      } catch { /* tier-2 is additive; failure leaves tier-1 nulls intact */ }
      return snap;
    }

    // Activity fan-out shared by both observation paths (wire tracker + legacy
    // JsonlWatcher callback): renderer event + optional "finished" notification
    // when the owning window isn't focused.
    _emitActivity(name, state, notify) {
      // Stamp peer-visibility facts (both intent paths funnel through here).
      const s = this.sessions.get(name);
      if (s && s.activityState !== state) {
        s.activityState = state; s.activityTs = Date.now();
        if (typeof scheduleTrayRefresh === 'function') scheduleTrayRefresh();
      }
      // A turn starting means the CLI is NOT parked at its prompt — drop the
      // atPrompt latch (covers injected turns too, which bypass write()); the
      // turn's terminal wire receipt re-stamps it. Invariant: atPrompt holds
      // iff a turn completed more recently than anything else happened.
      if (s && state !== 'idle') s.lastMainStop = null;
      // A turn resuming also means any dialog was answered (the CLI can't run
      // and ask at the same time) — clear the needs-attention badge. Never
      // cleared on 'idle': the dialog notification often lands AFTER the
      // activity tracker's quiet-fallback flips to idle.
      if (s && state !== 'idle' && s.needsAttention) this._setAttention(s, null);
      // The idle transition is the busy-hold's release event.
      if (s && state === 'idle') { this._maybeFlushInjectQueue(s); this._drainPendingAtIdle(s); }
      this._sendToSession(name, 'session-activity', name, state);
      // notify is only ever true on a real end-of-turn idle, so it doubles as
      // the remote client's "refetch the transcript now" signal.
      if (getRemoteServer()) { try { getRemoteServer().notifyActivity(name, state, notify); } catch {} }
      if (!notify) return;
      const owningWin = this.windowForSession(name);
      if (!owningWin || !owningWin.isFocused()) {
        try {
          notifyOS({
            title: `${name} finished`,
            body: 'Agent completed a turn.',
            silent: false,
          });
        } catch {}
      }
    }

    // A Notification-hook event landed for this session (attention tail in
    // create()). 'idle' chatter is dropped; 'permission'/'other' set the
    // needs-attention fact — badge, OS notification when the owning window
    // isn't focused, and (for 'permission') the dm dialog gate.
    _onAttention(session, entry) {
      const kind = classifyNotification(entry);
      if (kind === 'idle') return;
      this._setAttention(session, {
        kind, ts: Date.now(),
        message: (entry && typeof entry.message === 'string') ? entry.message : '',
      });
      this._broadcast('ipc-message', {
        type: 'attention', from: session.name, to: '',
        body: `${kind}: ${session.needsAttention.message || '(no message)'}`,
      });
      const owningWin = this.windowForSession(session.name);
      if (!owningWin || !owningWin.isFocused()) {
        try {
          notifyOS({
            title: `${session.name} needs you`,
            body: session.needsAttention.message || 'Waiting on a dialog.',
            silent: false,
          });
        } catch {}
      }
    }

    // Single set/clear funnel for the needs-attention fact so the renderer badge
    // can never drift from the dm gate's view of it.
    _setAttention(session, attn) {
      session.needsAttention = attn;
      this._sendToSession(session.name, 'session-attention', session.name, attn);
      if (typeof scheduleTrayRefresh === 'function') scheduleTrayRefresh();
      // Clearing a dialog fact is the dialog-hold's release event. (The flush
      // re-checks all holds, so a clear that rode a turn-start is a no-op.)
      if (!attn) this._maybeFlushInjectQueue(session);
    }

    // Compact summary landed. If this compact was self-fired via
    // [agent:context compact], a continuation was stashed — inject it now as
    // the first post-compact turn so the agent keeps working instead of
    // parking. One-shot: clear the stash so a later manual /compact (no stash)
    // never replays it. Defer so the inject lands after the summary write
    // fully settles in the PTY.
    _fireCompactContinuation(session) {
      // Summary landed = compact completed normally: cancel the in-flight valve
      // so it can't later clear state / log a false "never landed".
      this._clearCompactValve(session);
      // Fire this agent's `on compact` self-reminders. This is the single choke
      // point for EVERY compact flavor — self-fired [agent:context compact],
      // manual /compact, and auto-compact all land the same isCompactSummary
      // entry (jsonl-watcher), and BOTH observation paths (the legacy watcher's
      // onCompactSummary callback and the wire sentinel's armCompact) route here
      // — so hooking the event trigger once covers them all.
      const sched = getRemindScheduler && getRemindScheduler();
      if (sched) { try { sched.fireCompactFor(session.name); } catch {} }
      const cont = session._compactContinuation;
      if (cont) {
        session._compactContinuation = null;
        setTimeout(() => {
          if (session._dead) return;
          this._injectText(session, cont, { bypassHold: true });
          // Release the guard only after the continuation's deferred Enter has
          // fired, so anything queued flushes as a strictly LATER turn.
          const delay = cont.length > LONG_TEXT_THRESHOLD ? LONG_TEXT_DELAY : SHORT_TEXT_DELAY;
          setTimeout(() => this._releaseCompactGuard(session), delay + 200);
        }, COMPACT_CONTINUATION_DELAY);
      } else {
        // Summary landed with nothing stashed (manual /compact, or the stash
        // already fired). No continuation to order against — release now.
        this._releaseCompactGuard(session);
      }
    }

    // Inject-hold queue: while the session can't usefully receive a turn,
    // programmatic injections queue in clodex instead of stacking up in the
    // CLI's stdin, then flush as ONE concatenated turn. Holding costs no
    // latency in turn-terms — a mid-turn inject only becomes the next turn
    // anyway — and batching N held messages saves N-1 full-context billings
    // and lets the agent see them together (message 2 may supersede message 1).
    // Three hold reasons, three release events:
    //   'compact-window'  self-fired /compact ran, continuation hasn't fired —
    //                     an inject here would steal the first post-compact
    //                     turn. Released by _fireCompactContinuation.
    //   'dialog'          a permission dialog is OPEN (attention.js) — the
    //                     inject's Enter would answer it. Released when the
    //                     attention fact clears. Only 'permission' holds:
    //                     'other' has no evidence of a dialog (settled in
    //                     attention.js) and must not gate delivery.
    //   'busy'            mid-turn ('thinking' from either observation path).
    //                     Released on the idle transition.
    // Human keystrokes ride write(), not _injectText — never held.
    _injectHoldReason(session) {
      if (session._compactGuard) return 'compact-window';
      if (session.needsAttention && session.needsAttention.kind === 'permission') return 'dialog';
      if (session.activityState === 'thinking') return 'busy';
      return null;
    }

    // Arm the safety valve if it isn't already running. One timer per session,
    // shared by all hold reasons: 5 min after the FIRST cause (guard armed or
    // first message queued), force the flush past whatever hold is stuck.
    _armInjectValve(session) {
      if (session._injectHoldTimer) return;
      session._injectHoldTimer = setTimeout(() => {
        session._injectHoldTimer = null;
        console.warn(`inject hold ${session.name}: release never came (${this._injectHoldReason(session) || 'none'}) — forcing flush after timeout`);
        // A wedged compact window must not survive the valve — future injects
        // would immediately re-queue against it.
        session._compactGuard = false;
        this._maybeFlushInjectQueue(session, true);
      }, INJECT_HOLD_TIMEOUT);
    }

    // Armed on the [agent:context compact] intent path only — a human's manual
    // /compact and auto-compact-before-cold never queue anything.
    _armCompactGuard(session) {
      session._compactGuard = true;
      this._armInjectValve(session);
    }

    _releaseCompactGuard(session) {
      this._clearCompactValve(session);
      if (!session._compactGuard) return;
      session._compactGuard = false;
      this._maybeFlushInjectQueue(session);
    }

    // In-flight release valve (see COMPACT_INFLIGHT_TIMEOUT): a self-compact whose
    // summary never lands — OR a LATCH that never fires (queue never drains, no
    // further terminal stop) — would otherwise leave _compactPending / _compactGuard
    // / _compactContinuation stuck, silently suppressing every future self-compact
    // via the in-flight guard. On timeout, clear ALL THREE and flush anything
    // queued, logging + mirroring to the IPC drawer. No auto-retry — and the
    // stashed continuation text is dropped (the agent's post-compact follow-up is
    // lost, logged not retried; re-issuing is the agent's call). Cleared on the
    // normal completion path (_fireCompactContinuation / _releaseCompactGuard).
    // Armed at BOTH latch-set and fire time; each arm RESETS the timer
    // (_clearCompactValve first), so the post-fire window is a full 5min.
    //
    // Accepted trade-off: a LEGITIMATE compaction that streams longer than 5 min
    // trips the valve too, freeing the queue so injections can land mid-compaction
    // — exactly the pre-guard status quo. Deliberately accepted: a bounded chance
    // of the old behavior beats a permanent wedge on the common failure case.
    _armCompactValve(session) {
      this._clearCompactValve(session);
      session._compactValveTimer = setTimeout(() => {
        session._compactValveTimer = null;
        const wasStuck = session._compactPending || session._compactGuard || session._compactContinuation;
        session._compactPending = null;
        session._compactGuard = false;
        session._compactContinuation = null;
        if (wasStuck) {
          log.warn('intent', `compact ${session.name} release valve fired — summary never landed, cleared stuck in-flight state (no retry)`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name,
            body: 'context compact → in-flight valve released (summary never landed)',
          });
        }
        this._maybeFlushInjectQueue(session);
      }, COMPACT_INFLIGHT_TIMEOUT);
    }

    _clearCompactValve(session) {
      if (session._compactValveTimer) { clearTimeout(session._compactValveTimer); session._compactValveTimer = null; }
    }

    // Flush the queue as a single '\n'-joined inject — the \n→\r PTY path
    // already carries multi-line dm bodies as one message, so the batch lands
    // as ONE turn in arrival order. No-op while a hold reason stands (the
    // matching release event re-attempts) unless forced by the valve.
    _maybeFlushInjectQueue(session, force = false) {
      clearTimeout(session._injectFlushRetry);
      session._injectFlushRetry = null;
      if (session._dead) return;
      const queue = session._injectQueue;
      if (!queue || !queue.length) {
        // Nothing held; drop the valve unless a compact window still needs it.
        if (!session._compactGuard) {
          clearTimeout(session._injectHoldTimer);
          session._injectHoldTimer = null;
        }
        return;
      }
      // Hold-reason still standing: keep batching, the release event re-attempts.
      // The typing quiet-gate is NOT re-checked here anymore — the InjectQueue the
      // flushed turn drains through owns it now (single source of truth), so it
      // applies uniformly to batch flushes, direct injects, and self-intents.
      if (!force && this._injectHoldReason(session)) return;
      clearTimeout(session._injectHoldTimer);
      session._injectHoldTimer = null;
      session._injectQueue = [];
      this._injectText(session, queue.join('\n'), { bypassHold: true });
    }

    // Piece-3 fallback drain for parked DMs at the busy→idle edge. Closes the
    // no-tool-turn gap: a DM parked while the agent was busy (park-on-busy in
    // _maybeParkDelivery) is normally picked up MID-LOOP by the PostToolUse hook,
    // but a pure-text reply calls no tool, so nothing fires that hook — the DM
    // would then wait for the operator's next UserPromptSubmit (or the long park
    // cap). Draining here at turn-end restores the old idle-flush latency.
    //
    // Exactly-once is the SAME atomic rename-claim the two hooks use: if the
    // PostToolUse hook already drained this turn, drainPending renames a dir that's
    // gone → ENOENT → [] → no-op here. Whoever renames first wins; losers see
    // nothing. So this can't double-deliver against a mid-loop hook drain.
    //
    // Draft-gated: if an operator draft is open we must NOT drain — injecting would
    // risk splicing the draft (the whole reason parking exists). Leave the DMs
    // parked; they drain on the operator's submit (UserPromptSubmit), the next idle
    // with the draft closed, or the park cap. The pre-claim gate is the cheap first
    // line; the parkable inject below is the race backstop (a draft opening between
    // this gate and the queue's write re-parks via the fire-time divert rather than
    // splicing). Claude-only: pending is a Claude-hook store (codex never parks).
    _drainPendingAtIdle(session) {
      if (!session || session.agentType !== 'claude' || session._dead) return;
      if (isDraftOpen(session)) return;                 // don't splice an open draft
      let texts = [];
      try { texts = drainPending(PENDING_DIR, session.name, `idle.${process.pid}`); } catch {}
      if (!texts.length) return;                        // hook already drained, or nothing parked
      // Parkable: if a draft opens before the queue writes, the fire-time divert
      // re-parks each text instead of splicing (best-effort — falls through to a
      // normal inject on park failure, never dropping a DM).
      for (const t of texts) this._injectText(session, t, { parkable: true });
    }

    // --- JSONL text scanning (agent mode) ---

    // Parse a flushed turn's text into its intent list. Shared by the live
    // JSONL path (which handles each) and the wire shadow observer (which
    // only records) — one grammar, one body-capture rule, two callers.
    _extractIntents(text) {
      const intents = [];
      const lines = text.split('\n');
      // A buffer parses as a complete JSON value? (trim first — leading/trailing
      // whitespace and newlines are legal around a value). Used only for exec.
      const jsonComplete = (s) => {
        const t = s.trim();
        if (!t) return false;
        try { JSON.parse(t); return true; } catch { return false; }
      };
      let i = 0;
      // Fence map for the whole turn (intent-scanner.fencedLines): a line
      // inside a ```/~~~ code block is a QUOTE — literal text at every level
      // of this scan (no intent parse, no body boundary, no near-miss
      // bounce). Before this, an intent-shaped example inside a fence FIRED
      // (a fence only renders as a block; raw turn text keeps each line at
      // column 1 — observed live, a documentation block sent two real dms).
      const fenced = fencedLines(lines);
      // One synthesized `unknown` per batch, with a counter for the rest: a
      // near-miss line ([agent:-shaped but parses to nothing) at THIS level was
      // previously dropped in silence — a typo'd verb cost the agent a whole
      // failed attempt with zero feedback. Near-misses INSIDE a captured body
      // never reach here (parseIntent returns null for them, so the body
      // capture keeps them as text) — quoting inside a dm stays safe. Capped
      // at one intent so a pasted doc full of examples yields one bounce, not
      // one per line.
      let unknown = null;
      while (i < lines.length) {
        const line = lines[i].trim();
        const inFence = fenced[i];
        i++;
        if (inFence) continue;
        const intent = parseIntent(line);
        // `end` is a pure body terminator: as `next` inside a capture loop it
        // ends the body (the generic boundary check below covers it — any
        // recognized intent does); at THIS level it is spent and emits
        // nothing. Never pushed → never dispatched, deduped, or gated.
        if (intent && intent.type === 'end') continue;
        if (!intent || intent.type === 'escape') {
          const nearMiss = !intent && looksLikeIntent(line);
          if (nearMiss) {
            if (unknown) unknown.more++;
            else { unknown = { type: 'unknown', text: nearMiss.slice(0, 160), more: 0 }; intents.push(unknown); }
          }
          continue;
        }

        // exec bodies are JSON DATA, not free text. The shared greedy capture
        // below would swallow any prose a seat writes on FOLLOWING lines into the
        // payload, so the downstream JSON.parse then fails on a valid-value-plus-
        // prose buffer (observed live). Terminate exec capture at the JSON value
        // instead: accumulate body lines and JSON.parse the buffer after each; the
        // first line at which it parses is the complete value, so stop there and
        // leave any trailing prose lines for the outer loop to scan. JSON.parse is
        // exact — braces inside strings and multi-line pretty-printed values are
        // both handled — so there is no brace-counting lexer. The scan region is
        // bounded to execBodyCap (exec-schema's DEFAULT_MAX_BYTES backstop) so a
        // runaway non-JSON turn can't drive an unbounded re-parse. If it never
        // parses within the cap — an incomplete value, or prose on the SAME line
        // as the value (unextractable without a lexer) — fall through to the
        // greedy capture so it bounces exactly as it does today. dm / memory /
        // context keep the greedy capture untouched.
        if (intent.type === 'exec') {
          let buf = intent.body || '';
          let j = i;
          let complete = jsonComplete(buf); // may already be complete on the intent line
          while (!complete && j < lines.length) {
            // fenced lines are quoted text — never a boundary
            const next = fenced[j] ? null : parseIntent(lines[j]);
            if (next && next.type !== 'escape') break; // a col-1 intent ends the body
            const grown = buf + '\n' + lines[j];
            if (Buffer.byteLength(grown, 'utf8') > execBodyCap) break; // cap the region
            buf = grown;
            j++;
            complete = jsonComplete(buf);
          }
          if (complete) {
            intent.body = buf;   // exactly the JSON value; trailing prose not consumed
            i = j;               // resume the outer loop at the value's first unused line
            intents.push(intent);
            continue;
          }
          // not complete within the cap → fall through to the greedy capture below,
          // reproducing today's bytes so an incomplete payload bounces as before.
        }

        // For dm: capture the multi-line body — every line from here until the
        // next real intent line (at column 1) or the end of the turn, whichever
        // comes first. Using parseIntent as the boundary keeps it consistent
        // with the scanner: any line that WOULD fire as its own intent ends the
        // body instead of being swallowed, so an agent can emit several intents
        // in one turn. An escaped \[agent:…] line is literal text, not a
        // boundary, so it stays part of the body.
        // dm and `memory remember` carry a free-text body that may span lines;
        // `context compact` (and, later, reload) carry an optional continuation
        // body with the same multi-line capture semantics. `remind` carries the
        // reminder TEXT as its body (free text, greedy capture like dm) — the
        // exec JSON-terminator above does NOT apply to it. `notify-user` carries
        // the inbox note as free text, greedy like dm.
        if (intent.type === 'dm'
          || intent.type === 'exec'
          || intent.type === 'remind'
          || intent.type === 'notify-user'
          || (intent.type === 'memory' && intent.sub === 'remember')
          || (intent.type === 'context' && (intent.sub === 'compact' || intent.sub === 'reload'))) {
          const body = [];
          while (i < lines.length) {
            // fenced lines are quoted text — part of the body, never a
            // boundary (an intent-shaped example in a code block stays text)
            const next = fenced[i] ? null : parseIntent(lines[i]);
            if (next && next.type !== 'escape') break;
            body.push(lines[i]);
            i++;
          }
          while (body.length && !body[body.length - 1].trim()) body.pop();
          if (body.length) {
            const firstBody = intent.body || '';
            intent.body = firstBody + '\n' + body.join('\n');
          }
        }

        intents.push(intent);
      }
      return intents;
    }

    _scanJsonlText(text, senderName) {
      const s = this.sessions.get(senderName);
      for (const intent of this._extractIntents(text)) {
        // Differ: only when this session ALSO has a wire feed to compare
        // against (shadow-compare mode, CLODEX_WIRE_INTENTS=0). A codex or
        // wire-failed session has no wire side — recording it would only
        // manufacture unmatched noise.
        if (WIRE_SHADOW && this._shadow && s && s.wireRouted && s.intentSource === 'jsonl') {
          try {
            this._shadow.record('jsonl', shadowIntentKey(senderName, intent), {
              agent: senderName, sessionId: (s && s.sessionId) || null,
              intentType: intent.type,
            });
          } catch { /* shadow only */ }
        }
        this._handleIntent(senderName, intent);
      }
    }

    // --- Intent handling + message routing ---

    async _handleIntent(senderName, intent) {
      const session = this.sessions.get(senderName);

      // `end` is a body terminator, not an action — both scan paths filter it
      // before dispatch, so this is defensive (a future call site must not
      // bounce it through the gate as "the end intent is disabled").
      if (intent.type === 'end') return;

      // Near-miss bounce (synthesized in _extractIntents): a `[agent:…]`-shaped
      // line that parsed to nothing used to vanish in silence — the agent
      // believed it acted and nothing happened. Diagnostic, not a capability,
      // so it runs BEFORE the intent gate (a seat's allowlist never contains
      // 'unknown', and "the unknown intent is disabled" would be nonsense).
      // Agent sessions only: bash panes never produce it (_scanPtyOutput calls
      // parseIntent directly), and a bounce injected into a shell would be
      // typed at the prompt. Echoing the bounce back at column 1 would bounce
      // again — that requires the agent to actively quote it unescaped, same
      // exposure every existing bounce already has.
      if (intent.type === 'unknown') {
        if (session && session.agentType) {
          const more = intent.more ? ` (+${intent.more} more unrecognized [agent:…] lines this turn)` : '';
          this._injectText(session,
            `[agent:?] unrecognized intent \`${intent.text}\`${more} — nothing was done. `
            + 'Valid intents: dm, resend, who, name, context, memory, spawn, file, exec, remind, notify-user, end. '
            + 'To quote an intent literally, put it in a ``` code fence or escape it as \\[agent:…].', { parkable: true });
        }
        this._broadcast('ipc-message', {
          type: 'intent', from: senderName, to: senderName,
          body: `unrecognized intent bounced: ${intent.text}`,
        });
        return;
      }

      // Per-session intent gating (SEND side). Read the SENDER's allowlist FRESH
      // from persistence on every fire — same as the exec per-command grant below
      // — so a checklist toggle applies WITHOUT a respawn. `intentEnabled` treats
      // an absent list as "all enabled" (back-compat, the overwhelming default)
      // and never gates `name` (identity). A disabled intent gets a loud bounce
      // naming the gate, then stops here. This is send-side ONLY: `_deliverMessage`
      // is untouched, so a dm-GATED agent still RECEIVES dms — it just can't emit
      // them. `exec` that passes here still hits its finer per-command grant in
      // _handleExecIntent (the two gates are coarse + fine, both must allow).
      if (!intentEnabled(intent.type, getPersistence().get(senderName)?.intents)) {
        if (session) {
          // resend has no prompt line — its instruction rides the dm park-bounce
          // notice — so an agent with dm-on/resend-off will be told to emit a
          // handle that then lands here. Spell out that the fallback is a DELAY
          // (the parked copy still drains on the peer's next turn), not a loss.
          const msg = intent.type === 'resend'
            ? "the resend intent is disabled for this session — the message will deliver with the peer's next turn"
            : `the ${intent.type} intent is disabled for this session`;
          this._injectText(session, `[agent:${intent.type}] ${msg}`, { parkable: true });
        }
        return;
      }

      switch (intent.type) {
        case 'dm': {
          // Only deliver to agent sessions; bash sessions can't process intents
          const localTarget = this.sessions.get(intent.target);
          if (localTarget && localTarget.agentType) {
            // Cost gate: a dm injection into a long-idle, not-warm peer re-bills
            // that peer's whole context. Instead of dropping the message, PARK it
            // (Claude targets): it drains as additionalContext on the target's next
            // UserPromptSubmit via the existing pending hook, so nothing is lost and
            // the sender never re-emits the body — the notice hands them a short
            // [agent:resend <id>] to escalate if it can't wait for that next turn.
            // The gate + park-or-deliver core is _gatedDeliver (shared with the wire
            // deliverDm callback); this case owns the sender-notice copy.
            const r = this._gatedDeliver(intent.target, senderName, intent.body, intent.urgent === true);
            if (r.parked || r.held) {
              const parkId = r.parked || null;
              if (session) {
                let notice;
                if (parkId) {
                  // Dialog holds keep the no-urgent stance: parked (drains after the
                  // human answers the dialog), but NO resend advertised — a resend
                  // would refuse identically (injecting answers the dialog).
                  notice = r.noUrgent
                    ? `[agent:dm] parked for ${intent.target} (${r.reason}) as ${parkId} — it'll be delivered after the human answers the dialog.`
                    : `[agent:dm] parked for ${intent.target} (${r.reason}) as ${parkId} — it'll be delivered with ${intent.target}'s next turn. If it can't wait, emit \`[agent:resend ${parkId}]\` to wake them now (delivers the parked copy — don't retype the message).`;
                } else {
                  // Legacy bounce (non-Claude target, or parking failed).
                  const retry = r.noUrgent
                    ? `Resend after ${intent.target} is unblocked (a human has to answer the dialog).`
                    : `If it can't wait, resend as \`[agent:dm ${intent.target} urgent] <message>\`; otherwise it'll be cheapest right after ${intent.target}'s next turn.`;
                  notice = `[agent:dm] NOT delivered to ${intent.target}: ${r.reason}. ${retry}`;
                }
                this._injectText(session, notice, { parkable: true });
              }
              this._broadcast('ipc-message', {
                type: 'dm', from: senderName, to: intent.target,
                body: parkId
                  ? `PARKED (${r.reason}, ${parkId}): ${intent.body}`
                  : `HELD (${r.reason}): ${intent.body}`,
              });
              break;
            }
            // delivered — fall through to the shared ipc broadcast below.
          } else if (!localTarget) {
            // Federated `name@peer` target (no local session; `@` can't occur in a
            // session name, so it's never a socket peer either) → route out. The
            // helper owns its notice + ipc-log, so break before the shared one.
            if (intent.target.includes('@')) {
              this._routeFederatedDm(session, senderName, intent);
              break;
            }
            const peer = registry.getPeer(intent.target);
            if (peer) {
              await Transport.send(peer.socket, {
                type: 'dm', from: senderName, body: intent.body,
              });
            } else {
              // No local session, no federated route, no socket peer: the
              // message has nowhere to go. This used to fall through to the
              // ipc-log broadcast alone — a typo'd target name lost the dm
              // with zero feedback to the sender.
              if (session) {
                this._injectText(session,
                  `[agent:dm] NOT delivered: no agent named "${intent.target}". Check [agent:who] for reachable peers.`,
                  { parkable: true });
              }
              this._broadcast('ipc-message', {
                type: 'dm', from: senderName, to: intent.target,
                body: `UNDELIVERED (no such agent): ${intent.body}`,
              });
              break;
            }
          } else {
            // Target EXISTS but is a bash session — not DM-able (no registry,
            // no socket, can't process intents). Same silent-loss hole as the
            // missing-target case above.
            if (session) {
              this._injectText(session,
                `[agent:dm] NOT delivered: "${intent.target}" is a bash session — bash sessions can't receive dms.`,
                { parkable: true });
            }
            this._broadcast('ipc-message', {
              type: 'dm', from: senderName, to: intent.target,
              body: `UNDELIVERED (bash session): ${intent.body}`,
            });
            break;
          }
          this._broadcast('ipc-message', {
            type: 'dm', from: senderName, to: intent.target, body: intent.body,
          });
          break;
        }
        case 'resend': {
          // Escalate a parked-on-hold dm: claim the parked COPY by id and deliver
          // it NOW, bypassing the cost gate — the sender never re-emits the body.
          // Anyone may resend (same trust domain). Claim + drain race safely: an
          // ENOENT (or no match) means the target's next-turn drain already took
          // it, which is a success, so we report "delivered" not an error.
          const reply = (msg) => { if (session) this._injectText(session, `[agent:resend] ${msg}`, { parkable: true }); };
          const claimed = claimParkedById(PENDING_DIR, intent.id);
          if (!claimed) {
            reply(`nothing parked under "${intent.id}" — it may already have been delivered on the target's next turn.`);
            break;
          }
          const target = this.sessions.get(claimed.name);
          if (!target || target._dead) {
            reply(`can't deliver "${intent.id}": ${claimed.name} is gone.`);
            break;
          }
          // Re-check the DIALOG hold only (urgent bypasses the cost gate). If the
          // target is now dialog-blocked, injecting would answer the dialog — re-park
          // under the SAME id (a later resend still resolves it) and say so.
          const verdict = shouldHoldDm({
            urgent: true,
            state: target.activityState || 'idle',
            idleMs: Date.now() - (target.activityTs || Date.now()),
            payload: this._proxyPoller ? this._proxyPoller.snapshot(target.name) : null,
            attention: target.needsAttention ? target.needsAttention.kind : null,
          });
          if (verdict.hold) {
            let reparked = false;
            try { parkDelivery(PENDING_DIR, target.name, claimed.text, this._nextParkSeq(), intent.id); reparked = true; } catch {}
            reply(reparked
              ? `${target.name} is ${verdict.reason}; re-parked as ${intent.id} — it'll deliver after the dialog is answered.`
              : `${target.name} is ${verdict.reason} and re-parking failed — try [agent:resend ${intent.id}] again shortly.`);
            break;
          }
          // Release the parked copy. Not bypassHold: a mid-turn/compacting target
          // still queues-and-flushes correctly; only the cost hold is bypassed.
          // parkable + the SAME id: if a draft is open in the target pane at fire
          // time, the divert re-parks under intent.id rather than splicing — so the
          // handle survives and a later resend still resolves it. The reply is
          // worded for that possibility (the inject is fire-and-forget, so we can't
          // synchronously know whether it wrote or re-parked).
          this._injectText(target, claimed.text, { parkable: true, parkId: intent.id });
          const origin = (claimed.text.match(/^\[agent:from (\S+)\]/) || [])[1] || senderName;
          this._sendToSession(target.name, 'session-mention', target.name, 'dm', origin);
          reply(`released ${intent.id} to ${claimed.name} — it injects at the next safe moment; if a draft is open there it re-parks under the same id.`);
          this._broadcast('ipc-message', {
            type: 'dm', from: origin, to: claimed.name,
            body: `RESENT (${intent.id}): ${claimed.text}`,
          });
          break;
        }
        case 'who': {
          // ALL local agent sessions, every workspace — for parity with the
          // federated-peer listing below, which already surfaces `name@peer`
          // agents from other machines to every workspace. Once we list agents
          // next door on another Clodex, hiding the ones merely in a different
          // LOCAL workspace is the inconsistent case (and every name is a valid
          // dm handle regardless — a secondary supporting fact). Bash sessions
          // are excluded — they can't process intents. Each local peer carries a
          // reachability status (working / idle-for + cache warmth when known)
          // so senders can weigh whether a dm is worth waking a cold peer — the
          // same facts the dm hold gate reads. External socket peers stay bare
          // names: no visibility.
          const localAgents = Array.from(this.sessions.values())
            .filter(s => s.agentType)
            .map(s => ({ name: s.name, label: peerStatusLabel({
              state: s.activityState || 'idle',
              idleMs: Date.now() - (s.activityTs || Date.now()),
              payload: this._proxyPoller ? this._proxyPoller.snapshot(s.name) : null,
              attention: s.needsAttention ? s.needsAttention.kind : null,
            }) }));
          const externalNames = registry.listPeers()
            .map(p => p.name)
            .filter(n => !this.sessions.has(n))
            .map(n => ({ name: n, label: null }));
          // Federated agents on peered Clodexes: an online peer advertising the
          // 'dm' cap, whose label is a routable name, exposes its agent-type
          // sessions as `name@label` — this is how an agent discovers it CAN
          // initiate a cross-Clodex dm. Bare, like socket peers (no reachability
          // v1); the box lists nothing extra (asymmetric, like reachability).
          const remoteNames = [];
          for (const st of (getPeerManager() ? getPeerManager().statuses() : [])) {
            if (!st.online || !(st.caps || []).includes('dm')) continue;
            if (!st.label || !AGENT_NAME_RE.test(st.label)) continue;
            for (const rs of (st.sessions || [])) {
              if (rs && (rs.type === 'claude' || rs.type === 'codex')) {
                remoteNames.push({ name: `${rs.name}@${st.label}`, label: null });
              }
            }
          }
          // Hub-relay: agents on OTHER spokes reachable through a hub that pushed us
          // its roster. The address stays BARE (`worker@remote-linux`) — the hub is
          // inferred from our via-table at send time, never typed — but the entry is
          // annotated `(via <hub>)` so the sender knows it's a relayed path (best-
          // effort receipts, higher latency, dies if the hub's leg drops). Deduped
          // against directly-reachable addresses so a peer we can reach both ways
          // isn't listed twice.
          const directAddrs = new Set([...localAgents, ...externalNames, ...remoteNames].map(p => p.name));
          const relayNames = [];
          for (const e of this._relayRosterEntries()) {
            const addr = `${e.name}@${e.origin}`;
            if (directAddrs.has(addr)) continue;
            directAddrs.add(addr);
            relayNames.push({ name: addr, label: `via ${e.via}` });
          }
          const others = [...localAgents, ...externalNames, ...remoteNames, ...relayNames].filter(p => p.name !== senderName);
          const list = others.length
            ? others.map(p => p.label ? `${p.name} (${p.label})` : p.name).join(', ')
            : '(none)';
          if (session) this._injectText(session, `[agent:peers] ${list}`, { parkable: true });
          break;
        }
        case 'name': {
          if (session) this._injectText(session, `[agent:name] ${senderName}`, { parkable: true });
          break;
        }
        case 'context': {
          // Self-directed context-lifecycle control (operator-independence): an
          // agent can't self-inject a slash command, but clodex owns the PTY write
          // and can do it on the agent's behalf. Only agent sessions; bash can't.
          if (!session || !session.agentType) break;
          this._handleContextIntent(session, intent.sub, intent.body || '');
          break;
        }
        case 'memory': {
          // Agent self-managing its own clodex memories (spec §10). Agent sessions
          // only — keyed by the agent's session name.
          if (!session || !session.agentType) break;
          this._handleMemoryIntent(session, intent.sub, intent.body || '');
          break;
        }
        case 'spawn': {
          // Agent minting a new persistent peer session (spec Piece 2). Agent
          // sessions only — bash can't process intents and shouldn't spawn peers.
          if (!session || !session.agentType) break;
          this._handleSpawnIntent(session, intent);
          break;
        }
        case 'file': {
          // Agent surfacing a file on the operator's screen. Agent sessions only.
          if (!session || !session.agentType) break;
          this._handleFileIntent(session, intent.sub, intent.path);
          break;
        }
        case 'exec': {
          // Agent firing an operator-registered command (registered-only; no
          // arbitrary shell). Agent sessions only — bash can't process intents.
          if (!session || !session.agentType) break;
          this._handleExecIntent(session, intent.cmd, intent.body || '');
          break;
        }
        case 'remind': {
          // Agent scheduling a durable SELF-reminder (see remind-scheduler.js).
          // Agent sessions only — bash can't process intents, and the delivery
          // rides the DM pipeline which only reaches agent sessions.
          if (!session || !session.agentType) break;
          this._handleRemindIntent(session, intent.spec, intent.body || '');
          break;
        }
        case 'notify-user': {
          // Agent raising a note into the operator's persistent inbox (to get
          // Bogdan's attention when it's blocked on his decision). Agent sessions
          // only — bash can't process intents.
          if (!session || !session.agentType) break;
          this._handleNotifyUserIntent(session, intent.body || '');
          break;
        }
      }
    }

    // [agent:notify-user] text — raise a note into the operator's persistent
    // inbox. Distinct from `_onAttention`: this is agent-initiated (not a CLI
    // permission dialog) and the OS notification fires UNCONDITIONALLY on every
    // arrival, focus or not — the prompt line's "use sparingly, for decisions
    // you're blocked on" is the volume control, not a focus gate. Result tone
    // matches exec/remind: SILENT on a clean add (no re-bill), LOUD
    // `[agent:notify-user] …` bounce on an empty body or an over-cap body (the
    // inbox is an attention channel, not a payload dump). Guarded on the store
    // dep so a build without it is a clean no-op rather than a crash.
    _handleNotifyUserIntent(session, body) {
      const reply = (msg) => this._injectText(session, `[agent:notify-user] ${msg}`, { parkable: true });
      const who = session.name;
      const store = getNotifications && getNotifications();
      if (!store) { reply('the operator inbox is unavailable'); return; }

      const text = String(body == null ? '' : body).trim();
      if (!text) {
        reply('empty note — say what decision you need from the operator');
        return;
      }
      // Cap the body so a runaway turn can't bloat a store the UI renders
      // wholesale. Bytes, not chars — the store persists UTF-8.
      if (Buffer.byteLength(text, 'utf8') > NOTIFY_USER_MAX_BYTES) {
        reply(`note too long (>${Math.round(NOTIFY_USER_MAX_BYTES / 1024)}KB) — keep it a summary, not a payload`);
        return;
      }

      const rec = store.add({ from: who, workspaceId: session.workspaceId || null, body: text });
      const preview = text.split('\n')[0].slice(0, 200);
      // Attention: fire the OS notification (title = sender, body = first line)
      // unconditionally, then broadcast one ipc event. The single `notify`
      // ipc-message both audits into the IPC Traffic log (like remind/exec) AND
      // is the U4 inbox island's live signal — it re-syncs the unread badge and,
      // if the drawer is open, refetches + repaints the (human-scale) list.
      try {
        notifyOS({
          title: who,
          body: preview || 'wants your attention',
          silent: false,
        });
      } catch {}
      this._broadcast('ipc-message', { type: 'notify', from: who, to: 'user', body: preview });
      log.info('intent', `notify-user by ${who}: ${rec.id}`);
    }

    // [agent:remind <spec>] text — schedule/manage a durable self-reminder. The
    // scheduler (injected) owns timing + persistence; this is the intent seam:
    // parse the spec's HEAD to split management (list/cancel) from scheduling,
    // and match exec's result tone — SILENT on a clean schedule/cancel (no
    // re-bill), LOUD `[agent:remind] …` bounce on any parse error or a cancel of
    // an unknown id. `list` always replies (it's a query). Guarded on the
    // scheduler dep so a build without it (shouldn't happen post-whenReady) is a
    // clean no-op rather than a crash.
    _handleRemindIntent(session, spec, body) {
      const reply = (msg) => this._injectText(session, `[agent:remind] ${msg}`, { parkable: true });
      const who = session.name;
      const sched = getRemindScheduler && getRemindScheduler();
      if (!sched) { reply('reminders are unavailable'); return; }

      const parsed = parseRemindSpec(spec);
      if (!parsed.ok) {
        reply(parsed.error);
        this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${parsed.error}` });
        return;
      }

      if (parsed.kind === 'list') {
        const mine = sched.listForAgent(who);
        if (!mine.length) { reply('no reminders scheduled'); return; }
        const lines = mine.map((r) => `  ${r.id}  ${r.spec}${r.body ? ` — ${r.body.split('\n')[0].slice(0, 60)}` : ''}`);
        reply(`${mine.length} reminder(s):\n${lines.join('\n')}`);
        return;
      }

      if (parsed.kind === 'cancel') {
        if (sched.cancel(who, parsed.id)) {
          log.info('intent', `remind cancel ${parsed.id} by ${who}: ok`);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `cancel ${parsed.id}: ok` });
        } else {
          reply(`no reminder ${parsed.id}`); // unknown or not this agent's — loud, identical bounce
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: no reminder ${parsed.id}` });
        }
        return;
      }

      // A real schedule (every/in/at/cron/on compact).
      const r = sched.add(who, spec, body);
      if (!r.ok) {
        reply(r.error);
        this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${r.error}` });
        return;
      }
      // Silent success (no re-bill), like a clean exec. Audit only.
      log.info('intent', `remind ${r.record.kind} by ${who}: scheduled ${r.record.id}`);
      this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `scheduled ${r.record.id} (${spec})` });
    }

    // [agent:exec <cmd>] {json} — fire-and-forget invocation of an OPERATOR-
    // REGISTERED command. The whole value is that the JSON body is DATA, never
    // shell-spliced: we validate it against the command's schema, then hand it to
    // the command via STDIN. argv comes WHOLLY from the registry entry — the
    // payload NEVER contributes to argv, which is what makes argv-injection
    // structurally impossible.
    //
    // Registry: ~/.clodex/library/exec/<cmd>.json, operator-owned (agents cannot
    // register), read fresh at invocation (no watcher — dodges the headless
    // no-live-reload gotcha). Capability: the invoking seat's persisted
    // `execCommands` allowlist must contain <cmd>, else it's refused — the grant
    // rides spawn templates, so a seat not granted a command can't run it.
    //
    // Result asymmetry: SILENT on clean exit 0 (fire-and-forget, no re-bill);
    // LOUD on any of the three failure classes — unknown/ungranted cmd, schema-
    // validation failure, nonzero-exit/timeout — bouncing one terse [agent:exec]
    // line back to the invoking agent (a lost exec = a lost datum, so failure must
    // never be silent). Every attempt logs to both the structured log and the IPC
    // drawer, ok or err.
    _handleExecIntent(session, cmd, rawBody) {
      const reply = (msg) => this._injectText(session, `[agent:exec] ${msg}`, { parkable: true });
      const who = session.name;
      const fail = (msg) => {
        reply(`${cmd}: ${msg}`);
        log.warn('intent', `exec ${cmd} by ${who}: err (${msg})`);
        this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: `err: ${msg}` });
      };

      // 1) cmd id shape — a registry FILENAME token, so a malformed id can't
      // escape library/exec/ when we build the path below.
      if (!isFilenameToken(cmd)) {
        fail('invalid command id');
        return;
      }
      // 2) Capability grant — the invoking seat must be granted this command.
      const grants = getPersistence().get(who)?.execCommands || [];
      if (!Array.isArray(grants) || !grants.includes(cmd)) {
        fail('not granted to this seat');
        return;
      }
      // 3) Load the registry entry (read-at-invocation, no cache/watch). This
      // join mirrors stores.js `EXEC_DIR` (the execLibrary authoring surface) —
      // the two independently derive `library/exec/<cmd>.json` and agree by
      // construction (like AGENTS_DIR / the --agents key); kept un-shared so the
      // dispatcher stays free of a store dependency.
      const entryPath = path.join(REGISTRY_DIR, 'library', 'exec', `${cmd}.json`);
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8'));
      } catch (e) {
        fail(e.code === 'ENOENT' ? 'no such registered command' : `registry read failed (${e.message})`);
        return;
      }
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.argv) || !entry.argv.length) {
        fail('malformed registry entry (needs a non-empty argv)');
        return;
      }
      // 4) Validate the payload (size cap on RAW body → JSON.parse → schema).
      const v = parseAndValidate(entry, rawBody);
      if (!v.ok) {
        fail(v.error);
        return;
      }

      // 5) Run it — argv wholly from the registry, payload only via stdin (or an
      // opt-in temp file). Detached, timeout-killed. Defer off the watcher scan.
      const argv = entry.argv.map(String);
      const runCwd = entry.cwd ? String(entry.cwd) : (session.cwd || os.homedir());
      const timeoutMs = (typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0) ? entry.timeoutMs : 10000;
      const payloadJson = JSON.stringify(v.value);

      setImmediate(() => {
        let child;
        try {
          // NOT detached: a plain child dies on a normal SIGKILL. detached:true
          // would make the child a process-group leader, but child.kill signals
          // only the leader PID (not the group) — so it buys no group-kill while
          // risking orphaned grandchildren on timeout. v1 commands are simple
          // atomic writes with no grandchildren; keep it plain.
          child = childProcess.spawn(argv[0], argv.slice(1), {
            cwd: runCwd,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } catch (e) {
          fail(`spawn failed (${e.message})`);
          return;
        }
        let done = false;
        let stderr = '';
        const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          finish(() => fail(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d.toString(); });
        child.on('error', (e) => finish(() => fail(`run failed (${e.message})`)));
        child.on('exit', (code, signal) => finish(() => {
          if (code === 0) {
            // Success is silent (no re-bill) UNLESS the registry entry opts in
            // with replyStderr: true — then a non-empty stderr injects back
            // with the same tail discipline as the failure path (last line,
            // 200-char slice). The gate keeps ungated entries byte-identical
            // (the bridge-reply commands rely on silent success). stdout stays
            // dropped: it's data, not a channel — a long-running job wanting a
            // richer return is the documented growth path (ephemeral DM
            // channel), deliberately NOT built here.
            const tail = entry.replyStderr === true ? (stderr.trim().split('\n').pop() || '') : '';
            if (tail) {
              reply(`${cmd}: ${tail.slice(0, 200)}`);
              log.info('intent', `exec ${cmd} by ${who}: ok (stderr replied)`);
              this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: `ok: ${tail.slice(0, 200)}` });
            } else {
              log.info('intent', `exec ${cmd} by ${who}: ok`);
              this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: 'ok' });
            }
            return;
          }
          const how = signal ? `killed (${signal})` : `exit ${code}`;
          const tail = stderr.trim().split('\n').pop() || '';
          fail(tail ? `${how}: ${tail.slice(0, 200)}` : how);
        }));
        // Hand the validated payload over stdin, then close it.
        try {
          if (child.stdin) { child.stdin.write(payloadJson); child.stdin.end(); }
        } catch { /* a fast-exiting child may EPIPE — the exit handler reports it */ }
      });
    }

    // [agent:file view|open <path>] — put a file in front of the operator without
    // them having to switch workspaces and hunt for it ("open the report you just
    // wrote"). view = the touched-files peek modal (diff + contents) over this
    // session's workspace window; open = shell.openPath, so the OS default app
    // comes to the foreground regardless of which Clodex window is focused.
    // Vetting (cwd-anchored realpath, regular-file only, launchables refused for
    // open) is vetFileIntent in file-touch.js. Errors inject back as an
    // [agent:file] line; success is silent — the file appearing IS the ack, and
    // an inject costs the agent a turn. Every attempt logs to the IPC drawer.
    _handleFileIntent(session, sub, rawPath) {
      const reply = (msg) => this._injectText(session, `[agent:file] ${msg}`, { parkable: true });
      // Token bucket, not min-gap: "open all three reports" is one legitimate
      // burst; a confused agent machine-gunning windows is not.
      const now = Date.now();
      const times = (session._fileIntentTs = (session._fileIntentTs || []).filter(t => now - t < 30000));
      if (times.length >= 5) { reply('error: rate limit — at most 5 files per 30s'); return; }
      const vet = vetFileIntent({
        sub, rawPath, cwd: session.cwd,
        resolve: path.resolve, extname: path.extname,
        realpath: fs.realpathSync, stat: fs.statSync,
      });
      this._broadcast('ipc-message', {
        type: 'file', from: session.name, to: session.name,
        body: `file ${sub} ${rawPath} → ${vet.ok ? vet.path : `REFUSED: ${vet.error}`}`,
      });
      if (!vet.ok) { reply(`error: ${vet.error}`); return; }
      times.push(now);
      if (sub === 'open') {
        openPath(vet.path).then((err) => { if (err) reply(`error: ${err}`); }).catch(() => {});
        return;
      }
      const win = this.windowForSession(session.name);
      if (!win) { reply('error: your workspace window is closed — [agent:file open] still works'); return; }
      win.show();
      win.focus();
      win.webContents.send('session-file-view', session.name, vet.path);
      // Mirror the surfaced component to any attached peer viewers — the same
      // trigger point, just fanned to remote screens. Small {kind, args} only;
      // the viewer pulls contents through the query RPC. `open` never reaches
      // here (it returned above), so external launches never mirror.
      if (getRemoteServer()) {
        try { getRemoteServer().pushUiEvent(session.name, 'fileView', { path: vet.path }); } catch {}
      }
    }

    // Digest-ledger birth marking: any conversation id OTHER than the one this
    // session resumed with was born under it — its SessionStart hook fired with
    // source startup/clear and cat'd the digest file. Mark iff that file had
    // content: an empty-store birth stays unmarked so units saved later still
    // reach the conversation via _maybeDeliverDigest.
    _noteConversationForDigest(s, sid) {
      if (!sid || sid === s.bootResumeId) return;
      if (s.digestNonEmpty) getPersistence().markDigested(s.name, sid);
    }

    // May a wire-observed session id be trusted as THIS PTY's conversation
    // identity? The transcript symlink is the authority: Claude Code names the
    // transcript file <conversation-uuid>.jsonl, so a resolvable link that
    // disagrees with the wire sid means the sid belongs to something else on
    // the same proxy route (a `claude -p` one-shot / background child spawned
    // from inside the session — the wire attributes by route, not by process).
    // An unresolvable link can't testify; accept, preserving the backstop's
    // original purpose (a wiped symlink must not orphan persistence).
    _wireSessionCorroborated(s, sid) {
      try {
        const real = fs.realpathSync(pathFor(REGISTRY_DIR, s.name, 'transcript'));
        return path.basename(real, '.jsonl') === sid;
      } catch { return true; }
    }

    // Boot-digest append-once (the resume path). The hook only delivers to
    // conversations being born; one resumed from before the ledger existed —
    // or born when the store was empty — never got a digest. Deliver it ONCE
    // as a tail append (prefix cache untouched; only system-prompt bytes bust)
    // and mark the ledger first, so a delivery failure costs a missed digest,
    // never a repeat loop. Wire-turn-completion is the call site: cache hot,
    // CLI at its prompt.
    _maybeDeliverDigest(s, sid) {
      try {
        if (!sid || s._dead || s.agentType !== 'claude') return;
        if (s.needsAttention) return; // injection would answer the dialog
        // Only the PTY's OWN conversation gets the digest: a wire sid that
        // doesn't match the watcher-maintained identity is a stray (a child
        // claude sharing the session's proxy route — each one minted a
        // "never-digested" id and earned trader 7 digests in 4 minutes,
        // 2026-07-10). A skipped match (e.g. s.sessionId briefly stale after
        // /clear) just retries on a later turn — fail toward a missed
        // delivery, never a repeat.
        if (sid !== s.sessionId) return;
        if (isDigested(getPersistence().get(s.name), sid)) return;
        const digest = composeDigest(memoryStore.list(s.name));
        if (!digest) return; // empty store — stay unmarked, try again when units exist
        getPersistence().markDigested(s.name, sid);
        this._deliverMessage(s.name, 'memory',
          `boot digest (this conversation started before it could ride the first turn)\n\n${digest}`, 'memory');
      } catch { /* observer-grade — never break the turn handler */ }
    }

    // Mutation SUCCESS acks (remember/pin/unpin/forget) don't wake the agent:
    // injecting a turn just to say "saved" bills a whole request for pure
    // bookkeeping. For Claude the line is queued to {name}-acks and the
    // UserPromptSubmit hook (setupClaudeHook) attaches it to the agent's NEXT
    // turn as additionalContext — informative bytes, not user-voice input (which
    // also keeps the deletion ack away from Fable's refusal classifier). Codex
    // has no equivalent hook, so it keeps the immediate injected line. Failures
    // always inject — an agent that believes a failed write succeeded acts on a
    // store it doesn't have. Best-effort by design: an ack queued after the
    // conversation's final turn is simply never read.
    _memoryAck(session, line) {
      if (session.agentType === 'claude') {
        try {
          fs.appendFileSync(pathFor(REGISTRY_DIR, session.name, 'acks'), line + '\n');
          return;
        } catch { /* fall through to the injected line */ }
      }
      this._injectText(session, line);
    }

    // Memory MANAGEMENT intents (spec §10): list / remember / recall / pin /
    // unpin / forget, keyed by the agent's own name. Replies/recalls land back
    // in the agent's own input — list via _injectText (a short [agent:memory]
    // line: it's a question, the agent is waiting), mutation acks via
    // _memoryAck (deferred, see above), recall via _deliverMessage so a large
    // unit rides the spill channel and never busts msg0 (snapshot, costs a turn
    // — same semantics as any tail push, §2.2). Mutations rewrite the hook
    // digest file so a later /clear (or the next fresh conversation) boots with
    // the current store, not the spawn-time snapshot.
    _handleMemoryIntent(session, sub, body) {
      const agent = session.name;
      const refreshDigest = () => {
        if (session.agentType === 'claude') session.digestNonEmpty = writeClaudeDigestFile(agent);
      };
      if (sub === 'list') {
        const units = memoryStore.list(agent);
        const summary = units.length
          ? units.map(u => `• ${u.id}${u.scope ? ` [${u.scope}]` : ''}${u.pinned ? ' (pinned)' : ''}: ${u.body.split('\n')[0].slice(0, 60)}`).join('\n')
          : '(no memories yet)';
        this._injectText(session, `[agent:memory] ${units.length} unit(s):\n${summary}`, { parkable: true });
        return;
      }
      if (sub === 'remember') {
        // Optional leading `scope=<token>` / `pinned=true` (any order); the rest
        // is the unit text. pinned rides remember so save-and-pin is one intent —
        // the standalone pin sub only flips EXISTING units.
        let scope = '';
        let pinned = false;
        let text = body.trim();
        for (let m; (m = text.match(/^(scope|pinned)=(\S+)\s+([\s\S]+)$/));) {
          if (m[1] === 'scope') scope = m[2]; else pinned = m[2] === 'true';
          text = m[3];
        }
        try {
          const unit = memoryStore.remember(agent, { scope, text, source: agent, pinned });
          refreshDigest();
          // A conversation that WRITES a unit knows its store — mark it so the
          // append-once path doesn't echo the agent's own words back next turn.
          getPersistence().markDigested(agent, session.sessionId);
          this._memoryAck(session, `[agent:memory] remembered ${unit.id}${scope ? ` [${scope}]` : ''}${pinned ? ' (pinned)' : ''}`);
        } catch (e) {
          this._injectText(session, `[agent:memory] could not remember: ${e.message}`, { parkable: true });
        }
        return;
      }
      if (sub === 'recall') {
        const unit = memoryStore.recall(agent, body);
        if (!unit) {
          this._injectText(session, `[agent:memory] no match for "${body.trim().slice(0, 60)}"`, { parkable: true });
          return;
        }
        // Surface as a tail message (spill if large) — the spec-prescribed recall
        // channel (§10). A neutral 'memory' sender so the delivered label reads
        // "[agent:from memory] (mem-id scope) …", not as a message from itself.
        this._deliverMessage(agent, 'memory', `(${unit.id}${unit.scope ? ` ${unit.scope}` : ''})\n${unit.body}`, 'memory');
        return;
      }
      if (sub === 'pin' || sub === 'unpin') {
        try {
          memoryStore.setPinned(agent, body.trim(), sub === 'pin');
          refreshDigest();
          this._memoryAck(session, `[agent:memory] ${sub}ned ${body.trim()}`);
        } catch (e) {
          this._injectText(session, `[agent:memory] could not ${sub}: ${e.message}`, { parkable: true });
        }
        return;
      }
      if (sub === 'forget') {
        try {
          memoryStore.forget(agent, body.trim());
          refreshDigest();
          // Neutral wording on purpose: "forgot <id>" in the injected turn has
          // tripped Fable's refusal classifier (memory-tampering pattern match).
          this._memoryAck(session, `[agent:memory] removed ${body.trim()} from the store`);
        } catch (e) {
          this._injectText(session, `[agent:memory] could not remove: ${e.message}`, { parkable: true });
        }
        return;
      }
      this._injectText(session, `[agent:memory] unknown sub-command "${sub}" (use list|remember|recall|pin|unpin|forget)`, { parkable: true });
    }

    // Spawn a NEW persistent peer session from inside a running agent (spec
    // Piece 2). `name` is always required; `cwd` comes from the intent or a
    // referenced template. Without a template, everything structural is
    // clodex's job: type / workspace / proxy inherit the spawner, prompts and
    // tool-gating take clodex defaults, only the permission posture is
    // inherited. With `template:Y`, the template supplies type + the full
    // config subset (proxy / agents / tool+skill gating / strip / autocompact)
    // — the automation Bogdan asked for: spawn-matching-a-template by name.
    // The IPC protocol does NOT need an append ref — the IPC prompt (buildIpcPrompt,
    // per-seat but all-enabled by default) is prepended unconditionally for every
    // agent session (see mergeClaudeSystemPrompt / mergeCodexSystemPrompt), so a
    // child spawned with appendPromptFiles=[] still speaks dm/who/context (templates
    // carry no prompt refs — F6). Replies
    // (ok + every error) inject straight back into the spawner's input.
    _handleSpawnIntent(spawner, intent) {
      const reply = (msg) => this._injectText(spawner, `[agent:spawn] ${msg}`, { parkable: true });
      const name = (intent.name || '').trim();
      if (!name) { reply('error: usage [agent:spawn name:X cwd:Y [template:Z]]'); return; }
      // Validate-hard BEFORE touching disk (same discipline as the rename inventory).
      if (!AGENT_NAME_RE.test(name)) {
        reply(`error: invalid name "${name}" — allowed [a-zA-Z0-9._-], 1-64 chars`);
        return;
      }
      // Sessions are globally keyed; a taken name would fight the registry. Refuse
      // up front and tell the spawner, rather than throwing into the void.
      if (this.sessions.has(name) || getPersistence().get(name)) {
        reply(`error: name taken "${name}"`);
        return;
      }

      // Template resolution: `template:VALUE` names a LIBRARY template OR points
      // at a JSON template FILE, resolving to ONE template object fed to the
      // single apply path below (so library and file spawns can't drift).
      // DISCRIMINATOR: a VALUE containing '/' or starting with '~' or '.' is a
      // PATH; a bare token is always a library name — keeping the common named
      // case unambiguous (use ./x.json for a cwd-relative file).
      let tpl = null;
      if (intent.template) {
        const v = intent.template;
        if (v.includes('/') || v.startsWith('~') || v.startsWith('.')) {
          // File path — expand ~, resolve relative to the SPAWNER's cwd, read +
          // parse. TRUST: the spawner is same-trust-domain and can already read
          // files with its own tools, so reading a JSON template it names adds no
          // exposure — no cwd-confinement here (unlike the file-VIEW intent, which
          // paints the operator's screen).
          let p = v.replace(/^~(?=$|\/)/, os.homedir());
          if (!path.isAbsolute(p)) p = path.resolve(spawner.cwd || os.homedir(), p);
          let obj;
          try {
            obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
          } catch (e) {
            const why = e.code === 'ENOENT' ? 'not found'
              : (e instanceof SyntaxError ? `invalid JSON (${e.message})` : e.message);
            reply(`error: template file ${v}: ${why}`);
            return;
          }
          // Template-shaped: a usable `type` is the floor; id/name are optional in
          // a file (the library needs them for lookup, a path spawn doesn't).
          if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.type) {
            reply(`error: template file ${v}: not a template object (needs a "type")`);
            return;
          }
          tpl = obj;
        } else {
          // Library name — case-insensitive exact. Templates are now per-file
          // (filename = identity), so the name is unique on a case-INsensitive
          // FS; the >1 branch stays reachable only on a case-SENSITIVE FS
          // (headless Linux peers), where Foo.json + foo.json can coexist. 0
          // matches errors with the choices, >1 asks to disambiguate. NEVER
          // silent-pick.
          const wanted = v.toLowerCase();
          const all = getTemplates().list();
          const matches = all.filter(t => (t.name || '').toLowerCase() === wanted);
          if (matches.length === 0) {
            const names = all.map(t => t.name).filter(Boolean);
            reply(`error: no template named "${v}"${names.length ? ` — available: ${names.join(', ')}` : ' — none saved'}`);
            return;
          }
          if (matches.length > 1) {
            reply(`error: ambiguous — ${matches.length} templates named "${v}", rename to disambiguate`);
            return;
          }
          tpl = matches[0];
        }
      }
      // Display label for logs/replies — a file template may carry no name.
      const tplLabel = tpl ? (tpl.name || intent.template) : null;

      // cwd from the intent or the template (intent wins); required from at least one.
      const rawCwd = (intent.cwd || (tpl && tpl.cwd) || '').trim();
      if (!rawCwd) {
        reply(tpl
          ? `error: template "${tplLabel}" has no cwd — add cwd: to the spawn`
          : 'error: usage [agent:spawn name:X cwd:Y [template:Z]]');
        return;
      }
      // Expand a leading ~ and resolve to absolute so ensureDir/create get a real path.
      const cwd = path.resolve(rawCwd.replace(/^~(?=$|\/)/, os.homedir()));
      const type = tpl ? (tpl.type || 'claude') : (spawner.type || 'claude');
      const workspaceId = spawner.workspaceId || DEFAULT_WORKSPACE_ID;

      // The spawner's PERMISSION POSTURE is the no-template default for extraArgs: a
      // headless peer that blocks on a permission prompt defeats operator-
      // independence, but force-yolo would be surprising — so the child carries
      // --dangerously-skip-permissions iff the spawner has it (sandboxed parent →
      // sandboxed child). The session object doesn't carry extraArgs, so read the
      // spawner's persisted entry.
      const spawnerArgs = (getPersistence().get(spawner.name)?.extraArgs) || [];
      const postureArgs = spawnerArgs.includes('--dangerously-skip-permissions')
        ? ['--dangerously-skip-permissions'] : [];

      // Config: a template supplies the full subset; otherwise clodex defaults
      // (empty gating) + spawner-inherited proxy. F5: template.extraArgs is used
      // VERBATIM when present (it snapshots the source session's posture, incl.
      // yolo), else fall back to the spawner-posture inherit.
      const proxy = tpl ? (tpl.proxy ?? null) : (spawner.proxy ?? null);
      const childArgs = (tpl && Array.isArray(tpl.extraArgs) && tpl.extraArgs.length)
        ? tpl.extraArgs : postureArgs;
      const agents = (tpl && tpl.agents) || [];
      const denyBuiltins = (tpl && tpl.denyBuiltins) || [];
      const disabledTools = (tpl && tpl.disabledTools) || [];
      const disabledSkills = (tpl && tpl.disabledSkills) || [];
      const injectSkills = (tpl && tpl.injectSkills) || [];
      // Prompt refs are library-file references (like agents/skills), so a
      // template carries them; a non-template spawn keeps null/[] (unchanged).
      // Absent-on-target degrades to the CLI default in create() (F1 grace).
      const systemPromptFile = (tpl && tpl.systemPromptFile) || null;
      const appendPromptFiles = (tpl && tpl.appendPromptFiles) || [];

      // Defer off the JsonlWatcher scan callback that triggered us (same discipline
      // as reload): don't drive a full PTY spawn synchronously from inside a watcher
      // emit. setImmediate lets the scan unwind first.
      setImmediate(async () => {
        try {
          ensureDir(cwd); // self-contained: mkdir the cwd if absent — no external tool
          await this.create(
            name, type, cwd, childArgs, null, workspaceId,
            null, false, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles,
            // execCommands (the capability grant) and intents (the intent-gate
            // allowlist) are BOTH spawn-time create() params now — threaded IN so
            // create()'s own upsert persists them and they survive kill()+recreate.
            // A Bash-less trader seat's "read-only toward the trading system" rides
            // the template as physics; an absent grant passes [] → create() omits it.
            Array.isArray(tpl && tpl.execCommands) ? tpl.execCommands : [],
            // `[]` intents (everything gated) is a real value that must apply; an
            // absent key (all-enabled template) passes null → create() omits it →
            // the seat keeps the living all-enabled default.
            Array.isArray(tpl && tpl.intents) ? tpl.intents : null,
          );
          // stripLevel + autoCompact are NOT create() params — the poller asserts
          // strip on relink and reads autoCompact from persistence. Apply post-
          // create onto the entry, mirroring the ipc-handlers session:create seed.
          if (tpl) {
            if (tpl.stripLevel === 1 || tpl.stripLevel === 2) getPersistence().setStripLevel(name, tpl.stripLevel);
            if (tpl.autoCompact === false) getPersistence().setAutoCompact(name, false);
          }
          // The intent path bypasses the renderer's create flow, so tell the owning
          // window to draw the sidebar tab + terminal (reused verbatim from reload).
          // Dropped harmlessly if the window is detached — the session still spawned
          // and the UI recomputes on reattach.
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd, backend: (this.sessions.get(name) || {}).backend || null,
          });
          this._broadcast('ipc-message', {
            type: 'spawn', from: spawner.name, to: name, body: `spawn → ${name} @ ${cwd}` + (tpl ? ` (template ${tplLabel})` : ''),
          });
          log.info('intent', `spawn by ${spawner.name} → ${name} (${type}) @ ${cwd}` + (tpl ? ` via template "${tplLabel}"` : ''));
          reply(`ok: spawned "${name}" (${type}) @ ${cwd}` + (tpl ? ` via template "${tplLabel}"` : ''));
        } catch (err) {
          log.error('intent', `spawn by ${spawner.name} → ${name} failed: ${err.message}`);
          reply(`error: ${err.message}`);
        }
      });
    }

    // The CLI slash command each context sub-command maps to, per session type.
    // Claude is confirmed; Codex's TUI slash set differs by version, so it's an
    // explicit (best-effort) branch rather than a shared hardcode — an unknown
    // command degrades to a harmless "unknown command" line in the TUI, never a
    // broken session. `reload` is NOT a slash command (handled separately).
    static CONTEXT_COMMANDS = {
      claude: { compact: '/compact', clear: '/clear' },
      codex: { compact: '/compact', clear: '/clear' },
    };

    _handleContextIntent(session, sub, body = '') {
      if (sub === 'reload') {
        // Tier 3 (rare nuclear option): not a slash injection — a fresh respawn
        // with resumeId OMITTED to force a cold boot. Its real purpose is adopting
        // changed STATIC config a running session can't pick up (the prefix is
        // snapshotted at spawn): canonical case is "a library/prompts/system/*
        // building block was edited, respawn to run under it." Re-including the
        // durable briefing is a consequence of the cold boot (the briefing gate
        // keys on resumeId===null), not the motivation.
        const name = session.name;
        const entry = getPersistence().get(name);
        if (!entry) return;
        // Reload-handoff: a cold boot is AMNESIAC, so the handoff body is MANDATORY
        // — it's the previous self's briefing, injected as turn-one in the fresh
        // process. Without it the agent reloads and cold-parks forever. Reject
        // BEFORE killing anything, so a body-less reload leaves the live session
        // fully intact (mandatory means mandatory; refusing is the safe failure).
        const handoff = (body || '').trim();
        if (!handoff) {
          this._injectText(session,
            '[agent:context] reload needs a handoff body — '
            + 'reload drops all history, so the fresh process only knows what you '
            + 'pass it. Re-fire as `[agent:context reload] <briefing for your next '
            + 'self: what you were doing, what to do next>`. Reload aborted; '
            + 'this session is untouched.', { parkable: true });
          return;
        }
        // In-flight guard: a reload is a kill + cold respawn. A duplicate intent
        // (e.g. the same turn re-dispatched via a recovery replay) landing before
        // the respawn completes would double-kill/respawn — strictly worse than a
        // double compact. Drop the dup; the flag self-clears when the fresh
        // process replaces this session object (or on the failure path, where the
        // session is dead anyway).
        if (session._reloadInFlight) {
          this._broadcast('ipc-message', {
            type: 'context', from: name, to: name, body: 'context reload → dropped (already in flight)',
          });
          log.warn('intent', `reload ${name} dropped — already in flight`);
          return;
        }
        session._reloadInFlight = true;
        log.info('intent', `reload ${name} → cold respawn`);
        this._broadcast('ipc-message', {
          type: 'context', from: name, to: name, body: 'context reload → fresh restart',
        });
        // Defer off the JsonlWatcher scan callback that triggered us: reload kills
        // the very watcher mid-emit, and tearing it down from inside its own
        // callback risks a closed-fd reentrancy crash (same defer discipline as
        // _injectText's deferred Enter). setImmediate lets the scan unwind first.
        const waitExit = async (nm, timeoutMs = 8000) => {
          const start = Date.now();
          while (this.sessions.has(nm)) {
            if (Date.now() - start > timeoutMs) return false;
            await new Promise(r => setTimeout(r, 50));
          }
          return true;
        };
        setImmediate(async () => {
          try {
            if (this.sessions.has(name)) {
              await this.kill(name);
              if (!await waitExit(name)) throw new Error('old process did not exit in time');
            }
            // kill() dropped the persistence entry; create() rebuilds it from the
            // snapshot. resumeId=null → cold boot adopts changed static config.
            await this.create(
              name, entry.type, entry.cwd, entry.extraArgs || [], null, entry.workspaceId,
              entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
              entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
              entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
              // Thread the persisted grant + allowlist through the cold respawn — kill()
              // dropped the record, so without these the seat would come back with no
              // exec grant and all-enabled intents (the exact hole the stripLevel
              // re-assert below plugs for stripping).
              Array.isArray(entry.execCommands) ? entry.execCommands : [],
              Array.isArray(entry.intents) ? entry.intents : null,
            );
            const lvl = stripLevelOf(entry);
            if (lvl >= 1) getPersistence().setStripLevel(name, lvl);
            if (entry.label) getPersistence().setLabel(name, entry.label);
            // The intent path bypasses the renderer's restartSessionWithReattach,
            // so tell the owning window to rebuild the sidebar tab + terminal the
            // kill removed. Dropped harmlessly if the window is detached — the
            // session still respawned and the UI recomputes on reattach.
            this._sendToSession(name, 'session:context-action', {
              action: 'reattach', name, type: entry.type, cwd: entry.cwd, backend: (this.sessions.get(name) || {}).backend || null,
            });
            // Inject the mandatory handoff as turn-one once the FRESH process is
            // listening. reattach (above) is a UI signal fired immediately after
            // create() — too early; the new CLI's input loop isn't up yet. The
            // real readiness gate is the SessionStart hook recreating the
            // transcript symlink (= CLI booted; kill's cleanup removed the old
            // one). _injectReloadHandoff polls for it, then settles + injects.
            const fresh = this.sessions.get(name);
            if (fresh) this._injectReloadHandoff(fresh, handoff);
          } catch (err) {
            console.error(`[agent:context reload] ${name} failed:`, err.message);
            getPersistence().upsert(entry); // never let a failed respawn eat the entry
          }
        });
        return;
      }
      const map = SessionManager.CONTEXT_COMMANDS[session.type];
      const cmd = map && map[sub];
      if (!cmd) {
        console.warn(`[agent:context ${sub}] from ${session.name}: unsupported for type ${session.type}`);
        // Loud like memory's unknown-sub bounce — a typo'd sub used to be a
        // console line the agent never saw, so its compact/clear silently
        // didn't happen.
        this._injectText(session,
          `[agent:context] unknown or unsupported sub-command "${sub}" for a ${session.type} session (use compact|clear|reload)`,
          { parkable: true });
        return;
      }
      // In-flight guard: while a self-compact is in flight (LATCH set, guard set,
      // or continuation stashed awaiting the summary), a SECOND /compact would
      // land mid-compaction and collide with the first (observed as "Connection
      // closed mid-response"), or stomp the first's stashed continuation. Drop the
      // duplicate. Path-independent — catches a re-dispatched intent from any
      // source. The release valve bounds how long this suppresses: a failed/
      // abandoned compact (or a latch that never fires) must not wedge self-
      // compact forever.
      if (sub === 'compact' && isInjectInFlight({ pending: session._compactPending, guard: session._compactGuard, continuation: session._compactContinuation })) {
        this._broadcast('ipc-message', {
          type: 'context', from: session.name, to: session.name,
          body: 'context compact → dropped (already in flight)',
        });
        log.warn('intent', `compact ${session.name} dropped — already in flight`);
        return;
      }
      if (sub === 'compact') {
        const cont = (body && body.trim()) ? body.trim() : DEFAULT_COMPACT_CONTINUATION;
        // Wire-owned Claude: LATCH, don't fire now. Claude Code silently discards
        // slash commands while the CLI is busy — which is how the original
        // 3-attempt failure happened (a /compact injected mid-turn evaporated).
        // So stash the intent and let the wire turn.completed fire-check
        // (_maybeFireCompactLatch) run it on the next TERMINAL main-line stop with
        // both inject queues empty (= CLI genuinely parked at its prompt). Arm the
        // valve at LATCH-SET: a latch that never fires (queue never drains, no
        // further terminal stop) must not wedge self-compact via the guard above.
        if (session.intentSource === 'wire') {
          session._compactPending = { cmd, continuation: cont };
          this._armCompactValve(session);
          log.info('intent', `compact ${session.name} → latched (fires at next terminal stop, queue empty)`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name, body: 'context compact → latched',
          });
          return;
        }
        // Non-wire (codex, jsonl-fallback claude): no wire terminal-stop receipt
        // exists to fire a latch off, so inject immediately as before. Documented
        // degradation (messaging.md): a mid-turn compact here can still be dropped
        // by the CLI — the latch protection is wire-only.
        this._executeCompact(session, cmd, cont);
        return;
      }
      // Non-compact context command (clear): inject immediately — no continuation,
      // no guard, no latch. bypassHold: the intent often lands before the sender's
      // own idle event, and a queued bare slash command must never '\n'-join into a
      // flush batch (the command line would swallow the rest as garbage).
      this._injectText(session, cmd, { bypassHold: true });
      log.info('intent', `${sub} ${session.name} → ${cmd}`);
      this._broadcast('ipc-message', {
        type: 'context', from: session.name, to: session.name, body: `context ${sub} → ${cmd}`,
      });
    }

    // Run the actual self-compact: stash the continuation (native /compact PARKS
    // waiting for input after summarizing — without a continuation an operator-
    // independent agent compacts and stalls forever), arm the sentinel's compact
    // rendezvous (isCompactSummary is a transcript fact — nothing rides the wire
    // for it), inject the literal /compact as a turn, then arm the guard + valve.
    // Shared by the non-wire immediate path and the wire latch-fire path. Arming
    // the valve here RESETS it (_armCompactValve → _clearCompactValve first), so
    // the post-fire in-flight window is a full 5min, never the latch-set remainder.
    _executeCompact(session, cmd, continuation) {
      session._compactContinuation = continuation;
      if (session.sentinel) session.sentinel.armCompact(() => this._fireCompactContinuation(session));
      this._injectText(session, cmd, { bypassHold: true });
      this._armCompactGuard(session);
      this._armCompactValve(session);
      log.info('intent', `compact ${session.name} → ${cmd}`);
      this._broadcast('ipc-message', {
        type: 'context', from: session.name, to: session.name, body: `context compact → ${cmd}`,
      });
    }

    // Wire turn.completed fire-check for a latched self-compact (scheduled via
    // setImmediate AFTER the dispatch loop on a terminal main-line stop, so a
    // latch set synchronously by THIS turn's compact intent is already visible —
    // FIFO setImmediate ordering). Fire only when the latch is set AND both inject
    // queues are empty (canFireCompact): a queued inject is about to wake the CLI,
    // and /compact injected then would be silently dropped. Otherwise a no-op —
    // the next terminal stop retries (event-driven, no timers). Never throws into
    // the wire observer.
    _maybeFireCompactLatch(session) {
      try {
        if (!session || session._dead) return;
        const pending = session._compactPending;
        const holdQueueLen = session._injectQueue ? session._injectQueue.length : 0;
        const ptyQueueLen = session._injectPtyQueue ? session._injectPtyQueue.length : 0;
        if (!canFireCompact({ pending, holdQueueLen, ptyQueueLen })) return;
        session._compactPending = null;
        this._executeCompact(session, pending.cmd, pending.continuation);
      } catch (e) {
        this._shadowLog({ type: 'compact-latch-fire-error', agent: session && session.name, error: e.message });
      }
    }

    // Inject a reloaded session's mandatory handoff body as turn-one, once the
    // FRESH process is actually listening. Same-process restart, so the body rides
    // a closure variable across kill→create — no disk needed. Readiness gate: the
    // SessionStart hook repoints run/<name>/transcript.jsonl at CLI boot, and kill()'s
    // cleanup unlinked the old link before we respawned — so link-present = fresh
    // CLI booted. Probe with readlinkSync, NOT session.sessionId: the watcher only
    // sets sessionId once the transcript FILE exists, and Claude creates it lazily
    // on the first user turn — gating turn-one injection on it deadlocks and the
    // timeout eats the handoff (bit us live 2026-07-02). Then a settle delay so
    // the input loop is up, then inject. If the session dies or the link never
    // appears (CLI failed to boot), bail rather than inject blind into a half-dead
    // PTY — but surface the drop in the IPC log, not just the dev console.
    async _injectReloadHandoff(session, handoff, timeoutMs = 30000) {
      const linkPath = pathFor(REGISTRY_DIR, session.name, 'transcript');
      const start = Date.now();
      for (;;) {
        if (session._dead) return;
        try { fs.readlinkSync(linkPath); break; } catch {}
        if (Date.now() - start > timeoutMs) {
          console.error(`[agent:context reload] ${session.name}: fresh CLI never signaled boot (no transcript symlink); handoff not injected`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name,
            body: 'context reload → handoff NOT injected (fresh CLI never signaled boot)',
          });
          return;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, RELOAD_CONTINUATION_DELAY));
      if (!session._dead) this._injectText(session, handoff);
    }

    // --- Message delivery ---

    // The cost-gate + park-or-deliver core, shared by the LOCAL dm case and the
    // wire deliverDm callback so both ends apply identical semantics. `senderTag`
    // is the name the recipient sees in `[agent:from …]` — a plain name locally,
    // `name@origin` for a wire dm (so the reply trailer teaches an address that
    // routes back). Returns a small verdict the caller shapes into a notice / HTTP
    // response; it never injects the notice itself (the local case owns that copy,
    // byte-identical to before):
    //   { delivered:true }                         — injected/parked-for-draft now
    //   { parked:<id>, reason, noUrgent }          — held + parked (resend id)
    //   { held:<reason>, noUrgent }                — held, un-parkable (Codex/dead)
    //   { error:<msg> }                            — target isn't a local agent
    _gatedDeliver(targetName, senderTag, body, urgent) {
      const target = this.sessions.get(targetName);
      if (!target || !target.agentType) return { error: `no such agent "${targetName}"` };
      const verdict = shouldHoldDm({
        urgent: urgent === true,
        state: target.activityState || 'idle',
        idleMs: Date.now() - (target.activityTs || Date.now()),
        payload: this._proxyPoller ? this._proxyPoller.snapshot(targetName) : null,
        attention: target.needsAttention ? target.needsAttention.kind : null,
      });
      if (verdict.hold) {
        // Park only for Claude targets (the drain rides a UserPromptSubmit hook
        // Codex lacks); build the delivery text ONLY when we can actually park, so
        // the bounce path never orphans a >500-byte spill file.
        const canPark = target.agentType === 'claude' && !target._dead;
        const parkId = canPark
          ? this._parkHeldDelivery(target, this._buildDeliveryText(target, senderTag, body, 'dm'))
          : null;
        return parkId
          ? { parked: parkId, reason: verdict.reason, noUrgent: verdict.noUrgent }
          : { held: verdict.reason, noUrgent: verdict.noUrgent };
      }
      this._deliverMessage(targetName, senderTag, body, 'dm');
      return { delivered: true };
    }

    // Route a `name@origin` dm that isn't a local session or socket peer. Runs on
    // BOTH consumer and box (symmetric): (1) if `origin` matches a configured
    // ONLINE peer advertising the 'dm' cap, POST it there (consumer leg); (2) else
    // if `origin` is a known outbox origin (heard from this run, or a dir still on
    // disk), queue it for that origin to claim (box leg); (3) else bounce. Handles
    // its own notice + ipc-log; the caller just breaks after.
    // Hub-relay: cache a roster a hub pushed us (full replacement for that `via`).
    // An empty roster is stored too (not deleted) so a hub that just lost all its
    // relayable agents converges us to empty on the next tick rather than leaving
    // a stale set; the TTL then reaps the entry if the hub stops pushing entirely.
    _setRelayRoster(via, roster) {
      if (!via) return;
      this._relayRosters.set(via, { roster: Array.isArray(roster) ? roster : [], at: Date.now() });
    }

    // Fresh relay entries across every via, as {name, origin, via, type}. Stale
    // rosters (hub leg dropped — no refresh within the TTL) are skipped and pruned.
    _relayRosterEntries() {
      const now = Date.now();
      const out = [];
      for (const [via, rec] of this._relayRosters) {
        if (now - rec.at > RELAY_ROSTER_TTL_MS) { this._relayRosters.delete(via); continue; }
        for (const e of rec.roster) out.push({ name: e.name, origin: e.origin, via, type: e.type });
      }
      return out;
    }

    // The relay hop for an `origin` we can only reach via a hub: the `via` label to
    // enqueue the outbox under, or null if no fresh roster lists that origin. First
    // fresh match wins (our star has a single hub, so there's never a real choice).
    _relayViaForOrigin(origin) {
      const now = Date.now();
      for (const [via, rec] of this._relayRosters) {
        if (now - rec.at > RELAY_ROSTER_TTL_MS) { this._relayRosters.delete(via); continue; }
        if (rec.roster.some((e) => e.origin === origin)) return via;
      }
      return null;
    }

    _routeFederatedDm(session, senderName, intent) {
      const at = intent.target.indexOf('@');
      const name = intent.target.slice(0, at);
      const origin = intent.target.slice(at + 1);
      const bounce = (msg) => { if (session) this._injectText(session, `[agent:dm] ${msg}`, { parkable: true }); };
      if (!AGENT_NAME_RE.test(name) || !AGENT_NAME_RE.test(origin)) {
        bounce(`can't route "${intent.target}" — a federated target is name@peer, both plain names.`);
        return;
      }
      // (1) Consumer leg: a configured peer whose label matches `origin`.
      const peers = getPeerManager() ? getPeerManager().statuses() : [];
      const match = peers.find((p) => p.label && p.label.toLowerCase() === origin.toLowerCase());
      if (match) {
        if (!match.online) { bounce(`peer '${origin}' is offline — try again when it's awake.`); return; }
        if (!(match.caps || []).includes('dm')) { bounce(`peer '${origin}' predates dm federation — update its Clodex.`); return; }
        const conn = getPeerManager().get(match.id);
        if (!conn) { bounce(`peer '${origin}' is not reachable right now.`); return; }
        conn.dm({ to: name, from: senderName, body: intent.body, urgent: intent.urgent === true }, (resp) => {
          if (resp && resp.ok && resp.delivered) {
            // delivered — silent, exactly like a local delivery.
          } else if (resp && resp.ok && resp.parked) {
            if (session) this._injectText(session,
              `[agent:dm] parked on ${origin} for ${name} — it'll be delivered with ${name}'s next turn. If it can't wait, resend as \`[agent:dm ${intent.target} urgent] <message>\`.`,
              { parkable: true });
          } else {
            const why = (resp && resp.error) || 'delivery failed';
            bounce(`NOT delivered to ${intent.target}: ${why}`);
          }
        });
        this._broadcast('ipc-message', { type: 'dm', from: senderName, to: `${name}@${origin}`, body: `WIRE→${origin}: ${intent.body}` });
        return;
      }
      // (2) Box leg: queue for an origin we've heard from (or one lingering on disk).
      if (this._knownDmOrigins.has(origin) || outboxHasOrigin(OUTBOX_DIR, origin)) {
        const r = enqueueOutbox(OUTBOX_DIR, origin,
          { from: senderName, to: name, body: intent.body, urgent: intent.urgent === true, ts: Date.now() },
          this._nextParkSeq());
        if (!r.ok) { bounce(`could not queue for ${intent.target}: ${r.error}`); return; }
        // Ring the doorbell so the consumer claims now instead of waiting a hello
        // interval; the outbox it just landed in is the durable fallback.
        if (getRemoteServer()) { try { getRemoteServer().notifyDmMail(origin); } catch {} }
        // Silent on success — like a local delivery, the sender gets no notice.
        this._broadcast('ipc-message', { type: 'dm', from: senderName, to: `${name}@${origin}`, body: `WIRE→${origin} (outbox): ${intent.body}` });
        return;
      }
      // (2.5) Relay leg: an `origin` we can't reach directly (no configured peer,
      // never heard from) but which a hub advertised in a roster it pushed us. Route
      // THROUGH the hub: enqueue to OUR OWN outbox under origin=<via> (the hub claims
      // it like any box→consumer reply) carrying a relay envelope with the final
      // target. `from` is qualified with OUR label here and never rewritten again —
      // it's the load-bearing field for the reply path. Best-effort: the sender gets
      // a "relayed" ack (ruling 5, the deliberate exception to leg-2 silence), but no
      // end-to-end receipt (that's v2).
      const via = this._relayViaForOrigin(origin);
      if (via) {
        const qualifiedFrom = `${senderName}@${SELF_LABEL}`;
        const env = buildRelayEnvelope({
          to: name, finalTarget: intent.target, from: qualifiedFrom, origin: via,
          body: intent.body, urgent: intent.urgent === true,
        });
        const r = enqueueOutbox(OUTBOX_DIR, via, { ...env, ts: Date.now() }, this._nextParkSeq());
        if (!r.ok) { bounce(`could not relay to ${intent.target} via ${via}: ${r.error}`); return; }
        if (getRemoteServer()) { try { getRemoteServer().notifyDmMail(via); } catch {} }
        if (session) this._injectText(session,
          `[agent:dm] relayed via ${via} → ${intent.target} (best-effort; no delivery receipt${intent.urgent ? '' : ', held for a warm/active recipient'}).`,
          { parkable: true });
        this._broadcast('ipc-message', { type: 'dm', from: qualifiedFrom, to: intent.target, body: `WIRE→${via} (relay→${intent.target}): ${intent.body}` });
        return;
      }
      // (3) No route.
      bounce(`no route to '${intent.target}' — peer '${origin}' is not configured, has never contacted this box, and no hub advertises it.`);
    }

    // Deliver DMs a consumer just claimed from a box's outbox. Each rides straight
    // into _gatedDeliver — NEVER back through _handleIntent (that's the loop
    // guard). The sender tag uses OUR configured label for the peer (NOT the origin
    // the box recorded), so the recipient's reply trailer generates an address that
    // routes back out through our own peer config. `to` must be a local agent;
    // anything else is dropped with an ipc-log line rather than looped. Park gives
    // the remote sender no notice (the accepted mailbox-leg asymmetry — nothing is
    // lost, it drains on the target's next turn).
    //
    // Hub-relay (P4): a claimed message carrying a finalTarget is NOT for a local
    // agent — WE are the hub on the path between two spokes. Relay it onward via a
    // plain direct DM (conn.dm), staying on this claimed-delivery side of the loop
    // guard (never _handleIntent). The hop-count is the belt: a re-relay that
    // somehow loops back arrives with hops already spent and is dropped.
    _deliverClaimedDms(peerId, messages) {
      const cfg = (getUiSettings().get().peers || []).find((p) => p && p.id === peerId);
      const peerLabel = (cfg && cfg.label) || String(peerId);
      for (const m of (Array.isArray(messages) ? messages : [])) {
        if (!m || typeof m.to !== 'string') continue;
        if (isRelayEnvelope(m)) { this._relayClaimedDm(peerId, peerLabel, cfg, m); continue; }
        const senderTag = `${m.from || 'peer'}@${peerLabel}`;
        const local = this.sessions.get(m.to);
        if (!local || !local.agentType) {
          this._broadcast('ipc-message', { type: 'dm', from: senderTag, to: m.to, body: `WIRE←${peerLabel} DROPPED (no local agent "${m.to}"): ${m.body || ''}` });
          log.info('peer', `claimed dm from ${senderTag} dropped — no local agent "${m.to}"`);
          continue;
        }
        this._gatedDeliver(m.to, senderTag, m.body || '', m.urgent === true);
        this._broadcast('ipc-message', { type: 'dm', from: senderTag, to: m.to, body: `WIRE←${peerLabel}: ${m.body || ''}` });
      }
    }

    // Relay one claimed relay-envelope onward (the hub hop). `srcId`/`srcLabel`/
    // `srcCfg` identify the spoke we claimed from (the sender's side); `m` is the
    // relay envelope { rv, to, finalTarget, from, body, urgent, hops }. The terminal
    // leg is a PLAIN direct DM — conn.dm sends only {to,from,origin,body,urgent}, so
    // the relay fields are stripped by construction (a deliberate loop-prevention
    // feature: an offline destination sees an ordinary direct DM to a missing local
    // name and parks/bounces it, with no finalTarget to chase). `from`'s LOCAL part
    // is sacred (the reply path depends on it); its origin suffix is normalized to
    // OUR label for the source spoke — see the inline comment at the rewrite.
    _relayClaimedDm(srcId, srcLabel, srcCfg, m) {
      const drop = (why) => {
        log.info('peer', `relay from ${srcLabel} → ${m.finalTarget} dropped: ${why}`);
        this._broadcast('ipc-message', { type: 'dm', from: m.from || srcLabel, to: m.finalTarget, body: `WIRE relay DROPPED (${why}): ${m.body || ''}` });
      };
      if (!relayVersionOk(m.rv)) return drop('unsupported relay version');
      // Loop-guard belt: budget spent (or malformed) → drop. A legitimate single
      // relay arrives with hops=1 → 0 and proceeds; a looped re-relay arrives at 0.
      const hop = hopRule(m.hops);
      if (!hop.relay) return drop('hop budget exhausted');
      const at = String(m.finalTarget || '').indexOf('@');
      if (at <= 0) return drop('malformed finalTarget');
      const destName = m.finalTarget.slice(0, at);
      const destOrigin = m.finalTarget.slice(at + 1);
      // Access gate (symmetric, both endpoints must be relayAllowed on THIS hub).
      // P1 already hides non-allowed peers from the roster, so reaching here means a
      // hand-typed off-mesh address — bounce explicitly (ruling 7) so the sender
      // isn't left guessing. srcCfg is the sender's spoke; destCfg the destination.
      const peers = getUiSettings().get().peers || [];
      const destCfg = peers.find((p) => p && (p.label || '').toLowerCase() === destOrigin.toLowerCase());
      const srcAllowed = !!(srcCfg && srcCfg.relayAllowed);
      const destAllowed = !!(destCfg && destCfg.relayAllowed);
      if (!srcAllowed || !destAllowed) {
        this._bounceRelaySender(srcId, m, `relay to ${m.finalTarget} not permitted (peer not relay-enabled)`);
        return drop('relay not permitted (relayAllowed gate)');
      }
      // Resolve the destination peer connection (online + dm cap). Best-effort: an
      // offline/unreachable destination just drops (no far-end receipt in v1).
      const dest = (getPeerManager() ? getPeerManager().statuses() : [])
        .find((st) => st.label && st.label.toLowerCase() === destOrigin.toLowerCase());
      if (!dest || !dest.online) return drop(`destination peer '${destOrigin}' offline`);
      if (!(dest.caps || []).includes('dm')) return drop(`destination peer '${destOrigin}' predates dm federation`);
      const conn = getPeerManager().get(dest.id);
      if (!conn) return drop(`destination peer '${destOrigin}' not reachable`);
      // Reply-path normalization: the originating spoke stamped `from`'s origin
      // suffix with its OWN selfLabel (hostname-ish, e.g. agent@clodex-docker),
      // but the only origin namespace the destination can route a reply through
      // is OUR configured label for the source spoke — that's what the relay
      // roster advertises (agent@docker). Rewrite the SUFFIX to srcLabel; the
      // LOCAL part stays sacred (rewriting THAT, or the whole from to the hub's
      // identity, is what the sacred rule forbids). Live failure this fixes:
      // infra dm'd docker@docker, the ack came back stamped docker@clodex-docker
      // — an address that bounces if replied to.
      const fromAt = String(m.from || '').indexOf('@');
      const senderLocal = fromAt > 0 ? String(m.from).slice(0, fromAt) : String(m.from || '');
      const relayFrom = `${senderLocal || 'peer'}@${srcLabel}`;
      // Terminal leg: plain direct DM. The relay fields are stripped by
      // construction — buildTerminalDm returns exactly conn.dm's
      // {to,from,body,urgent} signature (conn.dm stamps origin itself).
      conn.dm(buildTerminalDm({ to: destName, from: relayFrom, body: m.body || '', urgent: m.urgent === true }), (resp) => {
        if (!(resp && resp.ok)) log.info('peer', `relay → ${m.finalTarget} not delivered: ${(resp && resp.error) || 'no response'}`);
      });
      this._broadcast('ipc-message', { type: 'dm', from: relayFrom, to: m.finalTarget, body: `WIRE relay ${srcLabel}→${destOrigin}: ${m.body || ''}` });
    }

    // Bounce a refused relay back to the originating sender on their spoke. Best-
    // effort: the sender is a local agent on the spoke we claimed from (srcId), so
    // we reach them via that spoke's own /api/dm (we're its consumer). `m.from` is
    // `sender@srcLabel`; the bounce targets the bare local name. Silent on failure —
    // a refusal that can't be delivered is logged at the drop site.
    _bounceRelaySender(srcId, m, why) {
      const conn = getPeerManager() ? getPeerManager().get(srcId) : null;
      if (!conn) return;
      const from = String(m.from || '');
      const at = from.indexOf('@');
      const senderLocal = at > 0 ? from.slice(0, at) : from;
      if (!senderLocal) return;
      try { conn.dm({ to: senderLocal, from: 'relay', body: `NOT delivered to ${m.finalTarget}: ${why}.`, urgent: false }, () => {}); } catch {}
    }

    // Is `senderName` an agent a recipient could actually [agent:dm] back RIGHT
    // NOW? Gates the reply trailer (see _buildDeliveryText) so we never advertise
    // a dead reply path. Two reachable shapes:
    //   * name@origin — a federated peer sender: reachable iff that origin peer is
    //     ONLINE (a reply routes through the consumer leg, which bounces an offline
    //     peer). No dm-caps recheck: having RECEIVED a federated dm from them proves
    //     they speak dm federation.
    //   * plain name — a LIVE local agent session: in the map, agent type (bash
    //     sessions aren't DM-able), not dead. A dead-but-resumable sender is
    //     deliberately excluded: a plain local dm to an absent target DROPS in
    //     _deliverMessage (`if (!target) return`), so a trailer would point at a
    //     path that silently discards. This is why 'user' and 'reminder' need no
    //     special-case — neither names a live agent session, so both return false.
    // COUPLING: this "live-or-online only" rule tracks _deliverMessage's drop-if-
    // absent behavior; if local dm parking ever widens to cover absent/resumable
    // targets, widen this to match (a resumable sender would then be reachable).
    _isDmReachable(senderName) {
      if (!senderName) return false;
      const at = senderName.lastIndexOf('@');
      if (at > 0) {
        const origin = senderName.slice(at + 1);
        const peers = getPeerManager() ? getPeerManager().statuses() : [];
        if (peers.some((p) => p.online && p.label && p.label.toLowerCase() === origin.toLowerCase())) return true;
        // Hub-relay: a sender whose origin isn't a directly-configured online peer
        // may still be reachable THROUGH a hub — if a fresh relay roster lists that
        // origin, the reply routes out via the relay leg (_routeFederatedDm 2.5).
        // Without this the trailer would be wrongly suppressed for every relayed dm.
        return this._relayViaForOrigin(origin) != null;
      }
      const s = this.sessions.get(senderName);
      return !!(s && s.agentType && !s._dead);
    }

    // Build the FINAL delivery text (prefix + spill-pointer/inline body + reply
    // trailer) a recipient reads — the exact bytes _deliverMessage would inject.
    // Factored out so the hold-park path parks byte-identical text (same
    // formatting, spill, trailer) rather than duplicating the shaping.
    _buildDeliveryText(target, senderName, body, mtype) {
      const prefix = `[agent:from ${senderName}]`;

      // Reply-syntax nudge, appended as the LAST thing the recipient reads before
      // composing: after a long analytical stretch an agent's register drifts to
      // "report to operator" and it can write a full reply without ever emitting
      // the intent line, leaving the sender blocked. Parenthesized and never at
      // column 1, so IntentScanner (which only fires on a cleaned line STARTING
      // with [agent:) can't mistake it for a real intent. Empty when not
      // applicable, so the pointer line's load-bearing trailing space is preserved.
      //
      // Only emitted when the reply path it advertises actually EXISTS, on both ends:
      //   (a) the RECEIVER's `dm` intent is enabled (fresh persistence read) — a
      //       dm-gated seat can't emit [agent:dm …], so nudging it to is a lie; and
      //   (b) the SENDER is dm-reachable right now (_isDmReachable): a live local
      //       agent session, or an online federated peer. This subsumes the old
      //       hardcoded `user`/`reminder` exclusions — neither is a reachable agent
      //       session, so both fall out naturally — and also fixes external senders
      //       (e.g. a `nc -U` wake script posting from:"t1-wake") that used to
      //       advertise a reply to a name no session answers.
      const trailer = (mtype === 'dm'
          && intentEnabled('dm', getPersistence().get(target.name)?.intents)
          && this._isDmReachable(senderName))
        ? `(reply: start a line with [agent:dm ${senderName}])`
        : '';

      if (body.length > MSG_SPILL_THRESHOLD) {
        const filePath = spillToFile(senderName, body, target.name);
        // @-mention makes Claude Code attach the file inline instead of
        // spending a turn on a Read call; Codex has no equivalent. The
        // trailing space after the path closes the @-autocomplete popup —
        // without it the deferred Enter can land on the popup and select a
        // DIFFERENT file (observed live: pointer said msg-2, body was msg-3).
        // The trailer rides the pointer line (not the spilled file, which may be
        // read after the register has already drifted).
        return target.agentType === 'claude'
          ? `${prefix} Message (${body.length} bytes) attached: @${filePath} ${trailer}`
          : `${prefix} Message (${body.length} bytes) saved to ${filePath} — read it with your Read tool.${trailer ? ' ' + trailer : ''}`;
      }
      return `${prefix} ${body}${trailer ? '\n' + trailer : ''}`;
    }

    _deliverMessage(targetName, senderName, body, mtype) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      const finalText = this._buildDeliveryText(target, senderName, body, mtype);
      // Layer-3 parking: if the operator is mid-composition, park this delivery to
      // drain in with their next prompt (see _maybeParkDelivery) instead of typing
      // it into the pane and splicing the draft. Falls through to a normal inject
      // otherwise, or if parking isn't applicable / fails.
      if (!this._maybeParkDelivery(target, finalText)) {
        // parkable: the delivery-time park above is a one-shot; if the operator
        // opens a draft AFTER it (but before the queue writes), the fire-time
        // divert re-checks and parks rather than splicing the draft.
        this._injectText(target, finalText, { parkable: true });
      }
      this._sendToSession(targetName, 'session-mention', targetName, mtype, senderName);
    }

    // Deliver a fired self-reminder (the remind-scheduler's deliver seam routes
    // here via main.js). Three cases, because a reminder's whole value is
    // durability — a fire must NOT be silently dropped the way a plain dm to an
    // absent target is:
    //   LIVE (session in the map)          → the normal DM inject path.
    //   OFFLINE but resumable (name still  → PARK into the pending store so it
    //     in persistence: exited-naturally,  drains through the UserPromptSubmit
    //     or not-yet-restored at launch —    hook on the agent's next prompt after
    //     start()'s catch-up runs BEFORE     resume. Keyed by name, so a later
    //     windows/sessions restore)          respawn under the same name picks it up.
    //   GONE (no persistence entry — the   → drop, and signal the caller so it can
    //     agent was killed from the UI by     prune the now-ownerless schedule
    //     operator intent)                    (recurring would otherwise recompute
    //                                          and drop forever).
    // Returns 'delivered' | 'parked' | 'gone' | 'error'. The `reminder` sender
    // gets no reply trailer (suppressed in _buildDeliveryText) — it's the
    // agent's own loop, not a conversational dm. The live path still emits the
    // session-mention badge via _deliverMessage, deliberately: the operator
    // seeing the tab light up on a fire is useful signal.
    _deliverReminder(agent, body) {
      const target = this.sessions.get(agent);
      if (target && target.agentType) {
        this._deliverMessage(agent, 'reminder', body, 'dm');
        return 'delivered';
      }
      const entry = getPersistence().get(agent);
      if (!entry) {
        log.info('intent', `remind fire for ${agent} dropped — no live session, no persisted entry`);
        return 'gone';
      }
      // Build the delivery bytes without a live session — _buildDeliveryText only
      // needs a name (spill filename) and agentType (claude @-mention vs codex
      // read-pointer), both known from the persisted entry. No resend id: a self-
      // reminder has no sender to escalate, and drainPending reads id-less parks.
      const finalText = this._buildDeliveryText({ name: agent, agentType: entry.type }, 'reminder', body, 'dm');
      try {
        parkDelivery(PENDING_DIR, agent, finalText, this._nextParkSeq());
        log.info('intent', `remind fire for ${agent} parked (offline) — drains on resume`);
        return 'parked';
      } catch (e) {
        log.error('intent', `remind park for ${agent} failed: ${e.message}`);
        return 'error';
      }
    }

    // Monotonic, lexically-sortable park seq so a drain reads in arrival order,
    // stable across restarts (timestamp dominates; a counter breaks within-ms ties).
    _nextParkSeq() {
      return `${Date.now()}.${String(this._parkSeq = (this._parkSeq || 0) + 1).padStart(9, '0')}`;
    }

    // Mint a short, collision-free resend handle. Ids must be unique across ALL
    // pending stores (resend carries only the id, not the target), so we retry
    // against parkIdInUse; the 5-char base36 space (~60M) makes a collision rare
    // even before the check.
    _mintParkId() {
      for (let i = 0; i < 50; i++) {
        const id = randBase36(5);
        if (!parkIdInUse(PENDING_DIR, id)) return id;
      }
      return randBase36(10); // vanishingly unlikely fallback
    }

    // Park a HELD dm (cost/dialog hold) so it drains on the target's next
    // UserPromptSubmit. Unlike _maybeParkDelivery this does NOT arm the park cap:
    // the cap drains through the inject queue after a timeout, which would defeat
    // the hold by injecting into the cold/blocked target anyway. A held delivery
    // waits for the target's OWN next turn (or an explicit [agent:resend]).
    // Returns the resend id, or null if parking failed (caller falls back to a bounce).
    _parkHeldDelivery(target, finalText) {
      const id = this._mintParkId();
      try {
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), id);
      } catch (e) {
        log.error('inject', `park-on-hold failed for ${target.name}: ${e.message}`);
        return null;
      }
      return id;
    }

    // Park a delivery for a hook drain instead of injecting it now, in either of
    // two cases: the operator is actively composing (drain rides the operator's
    // next UserPromptSubmit), OR the target is mid-turn/busy (drain rides the
    // PostToolUse hook, which fires between tool calls so a busy agent picks the
    // DM up MID-LOOP as CLI-authored, natively-persisted additionalContext — not
    // an in-memory _injectQueue stdin flush at the next idle edge). Returns true
    // if parked (caller must not inject), false to fall through to a normal inject.
    // Claude only — both drains ride Claude hook events Codex's surface lacks;
    // Codex keeps the quiet-gate queue. Self-intents and memory/system lines route
    // through _injectText directly (not here), so they never park — they're for
    // the CLI/bookkeeping, not conversational deliveries.
    //
    // Exactly-once across the two hooks + the Node idle-edge drain + the park cap
    // is guaranteed by drainPending's atomic rename-claim: whoever renames the dir
    // first gets every message then present; the losers see ENOENT and emit nothing.
    _maybeParkDelivery(target, finalText) {
      if (!target || target.agentType !== 'claude' || target._dead) return false;
      // "Composing" = a human touched the pane within the quiet window. Same
      // signal the inject quiet-gate uses (covers local keystrokes AND a peer
      // controller's input, both stamped at the write() choke point).
      const typing = Date.now() - (target.lastUserInputTs || 0) < INJECT_QUIET_MS;
      // "Busy" = mid-turn ('thinking' from either the wire tracker or the JSONL
      // watcher). A busy DM used to flow to _injectText's busy-branch _injectQueue
      // and flush via stdin at the idle edge; parking it instead lets the
      // out-of-process PostToolUse hook deliver it mid-loop (an external script
      // can't see the in-memory queue). The idle-edge Node drain is the fallback
      // for a turn that ends with no tool call (pure-text reply).
      const busy = target.activityState === 'thinking';
      if (!typing && !busy) return false;
      try {
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq());
      } catch (e) {
        // Parking is best-effort; never drop a DM. Fall back to a normal inject.
        log.error('inject', `park failed for ${target.name}: ${e.message} — injecting instead`);
        return false;
      }
      this._armParkCap(target);
      return true;
    }

    // Non-destructive starvation cap: if the operator never submits (walked-away
    // draft), parked deliveries would sit forever, since only a submit drains the
    // hook. After INJECT_QUIET_MAXWAIT, drain them through the normal inject queue
    // instead. The cap is now long (parking is non-destructive to a live draft, so
    // there's no rush) — its only job is the abandoned-draft case. Self-checking
    // against the hook: whoever wins the atomic dir-claim delivers; if the hook
    // already drained on a submit, the cap-fire claim comes back empty and no-ops.
    _armParkCap(target) {
      if (target._parkCapTimer) return;         // earliest-parked deadline governs
      target._parkCapTimer = setTimeout(() => {
        target._parkCapTimer = null;
        this._flushParkedNow(target, `cap.${process.pid}`, 'park-cap');
      }, INJECT_QUIET_MAXWAIT);
    }

    // Claim + drain the target's parked deliveries NOW and inject them through the
    // normal (NON-parkable) path. Shared by the starvation cap (tag `cap.<pid>`)
    // and the operator flush button (tag `flush.<pid>`). The claim is atomic, so it
    // races safely with the UserPromptSubmit hook, the idle-edge drain, and each
    // other — whoever renames the dir first delivers, the losers read empty and
    // no-op. NON-parkable on purpose: re-arming the parkable divert here is what
    // let a resent DM re-park itself (the recursion Bogdan hit); a manual flush must
    // land. A mid-turn target still batches to its idle edge via _injectText's hold
    // gate, so no torn turn. Returns { ok, count }.
    _flushParkedNow(target, tag, kind = 'park-flush') {
      if (target._dead) return { ok: true, count: 0 };
      let texts = [];
      try { texts = drainPending(PENDING_DIR, target.name, tag); } catch {}
      if (!texts.length) return { ok: true, count: 0 };  // another drainer won the claim
      const plural = texts.length === 1 ? 'y' : 'ies';
      const body = kind === 'park-cap'
        ? `park cap fired (${INJECT_QUIET_MAXWAIT / 1000}s, no submit) — injecting ${texts.length} parked deliver${plural}`
        : `flushed ${texts.length} parked deliver${plural} (operator)`;
      log.warn('inject', `${kind} for ${target.name} — draining ${texts.length} parked deliver${plural} via queue`);
      this._broadcast('ipc-message', { ts: Date.now(), from: 'clodex', to: target.name, kind, body });
      for (const t of texts) this._injectText(target, t);
      return { ok: true, count: texts.length };
    }

    // Operator-initiated flush of a session's parked DMs (sidebar ✉ badge click).
    // Operator-only by construction — reached via the session:flushPending
    // ipcMain.handle, never an agent intent (agents keep [agent:resend] for id'd
    // cost-holds; there is deliberately no agent-facing flush verb). Guards:
    //   * unknown / non-claude / dead target → refuse, nothing to flush.
    //   * dialog-blocked → REFUSE WITHOUT DRAINING. Draining would move the
    //     durable, zero-loss parked files into the volatile in-memory inject queue
    //     (lost on quit) where they'd sit behind the dialog anyway — and the Enter
    //     that ends an injection would answer the open dialog. Leave them parked.
    // On a successful claim, cancel the pending starvation cap (the messages are
    // gone from the store) and push an immediate count:0 delta so the badge clears
    // without waiting for the next poll tick.
    flushPending(name) {
      const target = this.sessions.get(name);
      if (!target || target.agentType !== 'claude' || target._dead) {
        return { ok: false, reason: 'no-such-agent' };
      }
      if (this._injectHoldReason(target) === 'dialog') {
        return { ok: false, reason: 'dialog-blocked' };
      }
      const r = this._flushParkedNow(target, `flush.${process.pid}`, 'park-flush');
      if (target._parkCapTimer) { clearTimeout(target._parkCapTimer); target._parkCapTimer = null; }
      this._lastPendingCounts.delete(name);
      this._broadcast('pending-count', { name, count: 0 });
      return r;
    }

    _injectText(session, text, opts = {}) {
      if (session._dead) return;
      // Hold gate (see _injectHoldReason): while the session is compacting,
      // dialog-blocked, or mid-turn, queue instead of writing — the matching
      // release event (or the safety valve) flushes the batch as one turn.
      // Only the compact continuation and the flush itself bypass. (This is the
      // TURN-batching layer — a separate concern from the byte-atomicity layer
      // below, which every injection ultimately drains through.)
      if (!opts.bypassHold && this._injectHoldReason(session)) {
        (session._injectQueue = session._injectQueue || []).push(text);
        this._armInjectValve(session);
        return;
      }
      // Byte-atomicity layer: hand the write to this session's serialized
      // InjectQueue. It performs Ctrl-U + text + settle + Enter as one atomic
      // unit (no interleave with a concurrent injection) and applies the typing
      // quiet-gate before starting. The queue self-drains; callers stay
      // fire-and-forget. Enter fires inside the queue's critical section (bailing
      // if the PTY died) — same death-window guard as before, just serialized.
      //
      // Park-at-fire-time: conversational deliveries/notices pass parkable:true so
      // the queue re-checks (via the divert) whether a draft opened during its
      // quiet-gate wait and parks instead of splicing. OPT-IN by design, not
      // opt-out: a missed tag just falls back to today's inject-through behavior
      // (a possible splice, no worse than before), whereas parking a CLI-driving
      // self-intent (compact/reload continuation, slash command) would stall the
      // agent — so those stay unparkable by omission, which is the safe direction.
      const divert = opts.parkable ? this._parkDivertFor(session, opts.parkId || null) : null;
      this._injectQueueFor(session).enqueue(text, divert ? { divert } : undefined);
    }

    // Build the park-at-fire-time divert for a parkable injection, or null when
    // parking doesn't apply (non-claude: the drain rides a Claude UserPromptSubmit
    // hook Codex lacks — same gate as _maybeParkDelivery). The returned predicate
    // is called by the InjectQueue right before it writes: if a draft is open at
    // that instant, park the text for the operator's next submit (arming the
    // non-destructive cap) and tell the queue to skip the write. Parking is
    // best-effort — on failure it returns false so the delivery still injects.
    // `id` (optional) is a resend handle to preserve across a re-park: a resent DM
    // that hits an open draft at fire time re-parks under the SAME id, so a later
    // [agent:resend <id>] still resolves it (without this the divert re-parked
    // id-less and the handle died). Only the resend call site passes it; every
    // other parkable delivery re-parks id-less as before.
    _parkDivertFor(session, id = null) {
      if (!session || session.agentType !== 'claude') return null;
      return (text) => {
        if (session._dead || !isDraftOpen(session)) return false;
        try {
          parkDelivery(PENDING_DIR, session.name, text, this._nextParkSeq(), id);
        } catch (e) {
          log.error('inject', `fire-time park failed for ${session.name}: ${e.message} — injecting instead`);
          return false;
        }
        this._armParkCap(session);
        log.info('inject', `diverted to park: draft open (${session.name})`);
        return true;
      };
    }

    // Lazily build (and memoize on the session) the per-session InjectQueue. The
    // seams read live session state each call: lastUserInputTs is stamped at the
    // keystroke choke point in write() for BOTH local keystrokes AND peer-
    // controller remote input, so the quiet-gate protects a remote controller's
    // draft too, for free (no separate timestamp needed).
    _injectQueueFor(session) {
      if (!session._injectPtyQueue) {
        session._injectPtyQueue = new InjectQueue({
          write: (bytes) => { try { session.pty.write(bytes); } catch {} },
          settleMsFor: (t) => (t.length > LONG_TEXT_THRESHOLD ? LONG_TEXT_DELAY : SHORT_TEXT_DELAY),
          quietMs: INJECT_QUIET_MS,
          maxWaitMs: INJECT_QUIET_MAXWAIT,
          lastHumanInputAt: () => session.lastUserInputTs || 0,
          isDead: () => !!session._dead,
          // Observability: the quiet-gate cap forced an inject through active
          // typing (splice risk). Should drop to ~zero once parking handles DMs
          // during composition — this line validates that.
          onCapFire: () => {
            log.warn('inject', `quiet-gate cap fired for ${session.name} — injected through active typing (${INJECT_QUIET_MAXWAIT / 1000}s cap)`);
            this._broadcast('ipc-message', {
              ts: Date.now(), from: 'clodex', to: session.name, kind: 'inject-cap',
              body: `inject quiet-gate cap fired (${INJECT_QUIET_MAXWAIT / 1000}s) — possible splice through a live draft`,
            });
          },
        });
      }
      return session._injectPtyQueue;
    }

    // --- Incoming from external peers ---

    _onIncoming(targetName, msg) {
      const sender = msg.from || '?';
      const body = msg.body || '';
      const mtype = msg.type || 'dm';
      this._deliverMessage(targetName, sender, body, mtype);
    }
  }

  return SessionManager;
}

module.exports = { createSessionManager, isStaleRegistration };
