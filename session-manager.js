
const NOTIFY_USER_MAX_BYTES = 16 * 1024;

const REBOOT_MIN_INTERVAL = 5 * 60 * 1000;

const REBOOT_NOTICE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const { readEffectiveClaudeEnv, teeBlindBackend } = require('./claude-env');
const { mergeSessionEnv, sanitizeFlat } = require('./env-scopes');
const { pasteModeSignal, strictMcpReason, STRICT_MCP_EXPLANATION, PROXY_AGENT_PREFIX } = require('./proxy-util');
const {
  RELAY_ROSTER_TTL_MS, RELAY_MAX_HOPS,
  buildRelayEnvelope, buildTerminalDm, isRelayEnvelope, hopRule, relayVersionOk,
} = require('./relay-protocol');
const { createFileHeat, aggregateStates, normalizeState, foldRedundancy } = require('./file-heat');
const { readJsonSafe } = require('./fs-util');
const { formatTeamBlock, matchSeatRole, formatRoster, formatCompositionDelta } = require('./team-manifest');
const { CLAUDE_TOOLS } = require('./catalogs');
// Cold-reviewer tool cap (Task 29a). The [agent:team-review] reviewer is SOLD as
// independent verification against a confused lead — but team.json is
// agent-writable, so a lead could widen its own reviewer to every tool. This
// code-level constant is the ceiling: the reviewer's effective allowlist is the
// INTERSECTION of this cap and any manifest `tools`. A manifest may NARROW below
// the cap; it can never widen past it. Not an authority source — a narrowing
// hint. (Until an operator-owned surface exists — T29 GUI may later widen
// per-team from operator clicks.)
const REVIEWER_TOOL_CAP = ['Read', 'Grep', 'Glob'];
// Cold-reviewer sessionEnv key allowlist (T52). The reviewer seat's env now comes
// from a template (resources/library/templates/clodex-team-reviewer.json), which —
// like team.json — is agent-writable. Env is an AUTHORITY surface (ANTHROPIC_BASE_URL,
// proxy/credential redirects, model overrides), so a doctored template must not be
// able to set an arbitrary key on a review seat. This code-level allowlist is the
// ceiling: exactly the keys the SHIPPED default reviewer template uses. A template
// env key outside this set is DROPPED LOUDLY (a note in the lead's confirm line),
// never honored. Not an authority source — same posture as REVIEWER_TOOL_CAP.
const REVIEWER_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'FORCE_PROMPT_CACHING_5M',
  'CLODEX_DISABLE_IPC_PROMPT',
]);
const DEFAULT_REVIEWER_TEMPLATE = 'clodex-team-reviewer';
const REVIEWER_FALLBACK = {
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
  },
  spawnerHint: 'off',
};
const { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir } = require('./tickets-store');
const { hostNotice } = require('./host-stamp');
const { createMemoryLoad } = require('./memory-load');
const { foldDraft } = require('./hint-arm');

const TICKET_STALL_MS = 30 * 60 * 1000;

// First claude spawn on a fresh box (deployed node, sandbox container) hits
// the CLI's interactive onboarding wizard — theme picker etc. — inside a PTY
// nobody on a headless node is watching. Pre-seed the global ~/.claude.json
// so sessions start ready. Merge-only: a file that already completed
// onboarding is left byte-untouched, unparseable JSON is never clobbered, and
// any failure degrades to the wizard (never blocks a spawn). Credentials are
// NOT touched here — the token rides the service env
// (deploy --claude-token-file). Module-level with a deps bag so tests inject
// fs/path + a home dir; create() calls it with the factory's natives.
function preseedClaudeOnboarding({ fs, path, homeDir }) {
  try {
    const p = path.join(homeDir, '.claude.json');
    let j = {};
    if (fs.existsSync(p)) {
      j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
      if (j.hasCompletedOnboarding) return false;
    }
    j.hasCompletedOnboarding = true;
    if (!j.theme) j.theme = 'dark';
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}
function humanizeAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// The filter vocabulary for [agent:task list [filter]]. The three real states a
// ticket is ever written with, plus `all`. Deliberately NOT `rejected`: reject
// reopens a ticket (_taskReject sets state 'open'), so a rejected filter would
// always answer none and be misread as "nothing was rejected".
// Mirrored in scripts/clodex-team.js (the exec listing) — see _taskList.
const TICKET_FILTERS = ['open', 'done', 'cancelled', 'all'];

const RECENT_DONE_MS = 24 * 60 * 60 * 1000;
const RECENT_DONE_CAP = 10;
const RECENT_DONE_LABEL = `${RECENT_DONE_MS / (60 * 60 * 1000)}h`;

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

// Missing-CLI exit heuristic (Task 12). node-pty's execvp failure in the forked
// child is silent (no stderr) — it surfaces as a bare code-1 exit within a couple
// seconds of spawn. Returns the unresolvable command to NAME in the exit toast, or
// null when this isn't that case. Pure (whichBin injected) so it's unit-tested
// directly rather than through a real spawn. Excludes deliberate exits, signals,
// and anything past the fast-fail window (a later code-1 is a real crash, not a
// missing binary — the CLI clearly launched).
function missingToolOnExit({ expected, exitCode, signal, elapsedMs, cmd, whichBin }) {
  if (expected || exitCode !== 1 || signal) return null;
  if (!(elapsedMs <= 5000)) return null;
  const resolved = cmd && cmd.includes('/') ? cmd : whichBin(cmd);
  return resolved ? null : (cmd || null);
}

// Name-collision decision for MINTING a new session (Task 15, GH#9). The name is
// the primary key everywhere (run/<name>/ dir, agent.sock, [agent:dm] bus,
// renderer Map, DOM data-name), so minting over any existing record — live OR
// merely persisted/archived (archive KEEPS the record, stamped archivedAt) —
// would overwrite it and split a name across two sidebar rows. This guards the
// mint FRONT DOOR only (the session:create / team:create / team:join IPC, all via
// spawnFromParams); the resume paths (restore-on-launch, unarchive→retry,
// restart/reload) re-create a persisted name legitimately and DELIBERATELY bypass
// this — that's the whole --resume design, and the mint-vs-resume axis is the
// front-door-vs-restore-path distinction, NOT resumeId (an "adopt" mint carries a
// resumeId but is still a mint; a persisted entry with no sessionId resumes with
// resumeId=null). Pure → unit-tested directly. Returns null (allow) | 'live' |
// 'persisted' so the caller can word the error (live: "already exists"; persisted:
// "archived/saved record — unarchive or rename").
function nameConflict({ liveHas, persistedHas }) {
  if (liveHas) return 'live';
  if (persistedHas) return 'persisted';
  return null;
}

function createSessionManager(deps) {
  const {
    AGENT_NAME_RE,
    COMPACT_CONTINUATION_DELAY,
    COMPACT_INFLIGHT_TIMEOUT,
    DEFAULT_COMPACT_CONTINUATION,
    DEFAULT_WORKSPACE_ID,
    INJECT_BOOT_MAXWAIT,
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
    BUILTIN_AGENTS,
    buildAgentsArg,
    buildIpcPrompt,
    childProcess,
    claimParkedById,
    classifyNotification,
    cleanupClaudeHook,
    cleanupCodexHook,
    cleanupSkillPlugin,
    effectiveInjectedSkills,
    unresolvedSubagentRefs,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    digestTiers,
    ctxReminderFor,
    bakePrompt,
    promptCacheDir,
    diagSummary,
    diagWarning,
    draftChunkSignal,
    drainPending,
    countPending,
    peekPending,
    enqueueOutbox,
    ensureDir,
    execBodyCap,
    findProjectRoot,
    resolveTeam,
    addRole,
    setRole,
    removeRole,
    renameRole,
    setTeamWatchdog,
    fs,
    hasActivePending,
    bodyModeFor,
    intentEnabledFor,
    pluginGrammarLines,
    pluginRowFor,
    validIntentNames,
    intentEnabled,
    isAlive,
    isDigested,
    isDraftOpen,
    isFilenameToken,
    isHumanPtyInput,
    withoutPrivilegedIntentsFor,
    isInjectInFlight,
    canFireCompact,
    lastTranscriptWrite,
    log,
    fencedLines,
    looksLikeIntent,
    memoryStore,
    memoryLoad,
    hintArm,
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
    getPersistence, getTemplates, getUiSettings, getEnvScopes, getPromptLibrary, getAgentLibrary, getRemoteServer, getPeerManager, getRemindScheduler, getNotifications,
    getPluginHooks,
    getUserDataPath, openPath, notifyOS, setAppQuitting, relaunchApp,
  } = deps;

  // Which memory units are live in each agent's context. Every call site below
  // is observer-grade, and partial deps objects (tests, the plugin harness)
  // omit it — so an absent tracker must contribute nothing rather than throw
  // inside a turn handler. An in-memory-only instance (no logDir, so no recall
  // log) is the cheapest null object and keeps the read API's shape honest.
  const memLoad = memoryLoad || createMemoryLoad();
  // Partial deps objects inject composeDigest without its sibling. No tiering
  // means nothing is recorded as loaded, which is the safe direction of the
  // asymmetry — never the reverse.
  const tiersOf = digestTiers || (() => null);

  // Contextual hint arming, off unless engine.js built one (feature-gated).
  // A no-op stand-in rather than a null check at each call site: the draft fold
  // still runs and s._draft still tracks, so turning the flag on mid-life needs
  // no state that only exists when armed.
  const NO_ARM = { onDraft() {}, disarm() {}, onSubmit() {}, onContextReset() {}, forget() {} };
  const arm = hintArm || NO_ARM;

  const ROSTER_SETTLE_MS = deps.rosterSettleMs || 400;
  // Settle margin before the boot-ready rising edge fires its pending drain (T54).
  // The first mode-2004 (which latches _bootReadySeen) is Claude ANNOUNCING
  // bracketed-paste during terminal setup — it can PRECEDE the readline loop
  // actually accepting a submitted Enter. Draining in that SAME synchronous tick
  // writes a pointer into a not-yet-ready composer that the boot re-render then
  // wipes. THIS DEFER IS THE ONLY MARGIN: by the time the deferred drain runs,
  // _bootReadySeen is already latched (set at the edge), so the InjectQueue's own
  // ready-gate is no-op-true and adds zero wait — it can't cover this race, only
  // the wall-clock defer can. Long enough to let the readline loop come up.
  // Injectable for tests (driven at 0); ~750ms in production.
  const BOOT_DRAIN_SETTLE_MS = Number.isFinite(deps.bootDrainSettleMs) ? deps.bootDrainSettleMs : 750;
  const ROSTER_MAX_WAIT_MS = deps.rosterMaxWaitMs || 10000;

  const ticketsStore = createTicketsStore({ fs, path });

  class SessionManager {
    constructor() {
      this.sessions = new Map();
      this.windows = new Map(); // workspaceId -> BrowserWindow
      this._knownDmOrigins = new Set();
      this._relayRosters = new Map();
      this._lastPendingCounts = new Map();
      this._ticketWatch = new Map();
      this._wire = null;       // in-process tee (WIRE_SHADOW only in W1)
      this._shadow = null;     // wire-vs-jsonl intent differ
      this._wireTelemetry = null; // W2 step-4 dark bridge (wire-telemetry.js)
      const { IntentDeduper, ActivityTracker } = require('./wire-intents');
      this._intentDeduper = new IntentDeduper();
      this._activity = new ActivityTracker((name, state, { turnEnd }) => {
        this._emitActivity(name, state, state === 'idle' && turnEnd);
      });
    }


    async _ensureWire() {
      if (this._wire) return this._wire;
      const { rearmPlan } = require('./wire/hold'); // pure re-arm math (used in the turn hook below)
      const { WireProxy } = require('./wire/proxy');
      const { isSubagentRole } = require('./wire/role');
      const { ShadowDiff } = require('./wire/shadow');
      let warmth = null;
      try {
        const { WarmthStore } = require('./wire/warmth');
        warmth = new WarmthStore({ path: path.join(getUserDataPath(), 'wire-warmth.sqlite') });
      } catch (e) {
        this._shadowLog({ type: 'wire-warmth-unavailable', error: e.message });
      }
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
          {
            const s = this.sessions.get(t.agent);
            if (s && s.intentSource === 'wire') {
              this._activity.turnCompleted(t.agent, { reqId: t.reqId, sideCall: t.sideCall, stop: t.stop });
            }
          }
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
          if (s) s.lastMainStop = { isTurn: !!(t.stop && t.stop.is_turn), ts: Date.now() };
          if (s && t.stop && t.stop.is_turn) this._maybeDeliverDigest(s, t.sessionId || s.sessionId);
          if (s && s.intentSource === 'wire') {
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
            if (t.stop && t.stop.is_turn) {
              setImmediate(() => this._maybeFireCompactLatch(s));
            }
            if (t.sessionId && s.sessionId !== t.sessionId) {
              if (this._wireSessionCorroborated(s, t.sessionId)) {
                s.sessionId = t.sessionId;
                getPersistence().setSessionId(t.agent, t.sessionId);
                this._noteConversationForDigest(s, t.sessionId);
              } else {
                this._shadowLog({ type: 'wire-stray-session', agent: t.agent, sessionId: t.sessionId });
              }
            }
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
                }
              } catch (e) {
                this._shadowLog({ type: 'wire-hold-rearm-error', agent: t.agent, error: e.message });
              }
            }
          } else if (s && s.agentType === 'claude') {
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
      wire.on('turn.started', (t) => {
        try {
          const s = this.sessions.get(t.agent);
          if (s && s.intentSource === 'wire') {
            this._activity.turnStarted(t.agent, { reqId: t.reqId, sideCall: t.sideCall });
          }
        } catch { /* observer-grade */ }
      });
      try {
        const { WireTelemetry } = require('./wire-telemetry');
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
      const onWireFailure = (ev, kind) => {
        this._shadowLog({ type: kind, ...ev });
        try {
          this._activity.requestFailed(ev.agent, ev.reqId);
          const s = this.sessions.get(ev.agent);
          if (s && s.intentSource === 'wire' && s.sentinel && !s.sentinel.recovering) {
            s.sentinel.armRecovery((text) => {
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

    _nameForWireSession(sid) {
      if (!sid) return null;
      for (const [name, s] of this.sessions) {
        if (s.sessionId === sid) return name;
      }
      return null;
    }

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

    _sendToSession(name, channel, ...args) {
      const win = this.windowForSession(name);
      if (win) {
        win.webContents.send(channel, ...args);
        return;
      }
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
    }

    _broadcast(channel, ...args) {
      for (const w of this.allLiveWindows()) {
        w.webContents.send(channel, ...args);
      }
    }

    async create(name, type, cwd, extraArgs = [], resumeId = null, workspaceId = DEFAULT_WORKSPACE_ID, systemPromptBody = null, fork = false, proxy = null, agents = [], denyBuiltins = [], disabledTools = [], disabledSkills = [], injectSkills = [], systemPromptFile = null, appendPromptFiles = [], execCommands = [], intents = null, sessionEnv = null, mint = false) {
      if (this.sessions.has(name)) {
        throw new Error(`Session "${name}" already exists`);
      }
      if (cwd) {
        let st = null;
        try { st = fs.statSync(cwd); } catch { /* missing — handled below */ }
        if (!st) throw new Error(`Directory does not exist: ${cwd}`);
        if (!st.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
      }
      let mergedEnv;
      try {
        const store = getEnvScopes && getEnvScopes();
        const all = store ? store.all() : { global: {}, workspaces: {} };
        mergedEnv = mergeSessionEnv({
          base: process.env,
          global: all.global,
          workspace: (all.workspaces && all.workspaces[workspaceId]) || null,
          session: (sessionEnv && typeof sessionEnv === 'object') ? sessionEnv : null,
          overrideFile: path.join(getUserDataPath(), 'env-override.env'),
        });
      } catch {
        mergedEnv = { ...process.env };
      }

      let proxyBase = resolveProxyBase(proxy, getUiSettings());

      let cmd, args;
      const shell = process.env.SHELL || '/bin/bash';
      const warnings = [];
      const agentType = (type === 'claude') ? 'claude' : (type === 'codex') ? 'codex' : null;
      let intentSource = 'jsonl';
      let wireRouted = false;
      const backend = agentType === 'claude' ? teeBlindBackend(readEffectiveClaudeEnv(cwd, { baseEnv: mergedEnv })) : null;
      if (backend && proxyBase) {
        this._shadowLog({ type: 'proxy-off-tee-blind', agent: name, backend });
        proxyBase = null;
      }

      let proxyAgent = null;
      if (agentType) {
        const taken = new Set();
        for (const e of getPersistence().list()) if (e.proxyAgent) taken.add(e.proxyAgent);
        for (const s of this.sessions.values()) if (s.proxyAgent) taken.add(s.proxyAgent);
        proxyAgent = resolveProxyAgentId({ name, fork, existing: getPersistence().get(name), taken });
      }

      // createdAt: stamped ONCE, at the session's first create. kill()+recreate
      // (restart/restore) rebuilds the record from spawn args, so preserve any
      // existing stamp rather than resetting it — the sidebar's "created" sort/
      // group depends on it being stable across restarts.
      // This read is only HALF the invariant, and reading it as the whole thing is
      // what let the bug live: the restore-on-launch path keeps the record, so
      // existingEntry carries the stamp — but every kill()-based restart REMOVES
      // the record first, so existingEntry is null here and the `|| Date.now()`
      // re-mints. The restart callers must therefore re-seed createdAt via
      // _preserveAcrossRestart (engine.restartSession / applySessionArgs, and the
      // [agent:context reload] respawn) BEFORE reaching this line. Pinned in
      // test/createdat-restart.test.js — do not "tidy" the field out of those lists.
      //
      // Computed HERE, ~400 lines above the upsert that consumes it, because the
      // claude arm bakes it into the generated pending-drain hook (setupClaudeHook)
      // and the hook is written before the spawn. The one expression must stay
      // single: recomputing `(existing && existing.createdAt) || Date.now()` down
      // in hook setup would be a second copy that drifts the first time either is
      // touched — the exact construction this ticket exists to remove. Nothing
      // between here and the upsert writes persistence, so the read is unchanged
      // by the move.
      const existingEntry = getPersistence().get(name);
      const createdAt = (existingEntry && existingEntry.createdAt) || Date.now();

      let teamBlock = '';
      let teamName = null;
      let resolvedTeam = null; // kept for the post-spawn roster/delta wiring below
      if (agentType) {
        try {
          const team = resolveTeam(cwd);
          if (team) {
            resolvedTeam = team;
            teamName = team.name;
            teamBlock = formatTeamBlock(team, name);
            const role = matchSeatRole(team, name);
            const def = role ? team.roles[role] : null;
            const promptRidesAsSystem = def && def.prompt && systemPromptFile === def.prompt;
            if (def && def.prompt && !promptRidesAsSystem) {
              try {
                const promptFile = path.join(REGISTRY_DIR, 'library', 'prompts', 'system', `${def.prompt}.md`);
                const rolePrompt = fs.readFileSync(promptFile, 'utf-8');
                if (rolePrompt) teamBlock = `${teamBlock}\n\n${rolePrompt}`;
              } catch { /* missing/unreadable role prompt — skip, team block still stands */ }
            }
          }
        } catch { /* resolution is best-effort — never block a spawn on it */ }
      }

      switch (type) {
        case 'claude': {
          cmd = 'claude';
          if (preseedClaudeOnboarding({ fs, path, homeDir: os.homedir() })) {
            this._shadowLog({ type: 'claude-onboarding-preseeded', agent: name });
          }
          const sysFile = resolveSystemPromptFile(systemPromptFile);
          const appendBodies = readAppendBodies(appendPromptFiles);
          const ipcPrompt = mergedEnv.CLODEX_DISABLE_IPC_PROMPT === '1' ? '' : buildIpcPrompt(intents, this._resolveExecDefs(execCommands), pluginGrammarLines(intents));
          const { cleaned, append } = mergeClaudeSystemPrompt(extraArgs, ipcPrompt, {
            appendBodies, inlineBody: systemPromptBody || null, hasSystemFile: !!sysFile,
          });
          args = cleaned;
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
          // Whether OUR hooks are installed at all. A user-supplied --settings in
          // extraArgs replaces the whole hooks block, so ipcdelta.sh (and every
          // other drain) is absent for that session — which is load-bearing for
          // the frozen prompt below, not just cosmetic.
          let hookInstalled = false;
          if (!args.includes('--settings')) {
            const settingsPath = setupClaudeHook(name, proxyBase, proxyAgent, denyBuiltins, disabledTools, disabledSkills, wireBase, createdAt);
            args.push('--settings', settingsPath);
            hookInstalled = true;
          }
          ensureDir(MSG_DIR);
          if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
          if (getUiSettings().get().disableClaudeDesignMcp
              && !args.includes('--strict-mcp-config')
              && !args.includes('--mcp-config')) {
            let probe = null;
            if (proxyBase) {
              try { probe = await ProxyClient.probe(proxyBase); } catch {}
            }
            const reason = strictMcpReason(proxyBase, probe);
            if (reason) {
              args.push('--strict-mcp-config');
              this._broadcast('ipc-message', {
                type: 'system', from: name, to: name,
                body: `MCP: --strict-mcp-config (${reason}) — ${STRICT_MCP_EXPLANATION[reason]}. All MCP servers are disabled for this session.`,
              });
            }
          }
          if (!args.includes('--agents')) {
            const agentLib = getAgentLibrary().list();
            const effectiveAgents = unionEnabled(agents, agentLib, name);
            const agentsObj = buildAgentsArg(effectiveAgents, agentLib);
            if (agentsObj) args.push('--agents', JSON.stringify(agentsObj));
          }
          if (!args.includes('--plugin-dir')) {
            const pluginDir = writeSkillPlugin(name, injectSkills);
            if (pluginDir) args.push('--plugin-dir', pluginDir);
            try {
              const records = effectiveInjectedSkills(name, injectSkills);
              if (records.length) {
                const agentLib = getAgentLibrary().list();
                const deny = Array.isArray(denyBuiltins) ? denyBuiltins : [];
                const enabled = new Set([
                  ...unionEnabled(agents, agentLib, name),
                  ...BUILTIN_AGENTS.filter((b) => !deny.includes(b)),
                ]);
                for (const { skill, ref } of unresolvedSubagentRefs(records, enabled)) {
                  warnings.push(`Skill "${skill}" calls subagent "${ref}", which isn't enabled for this session — that delegation will fail. Enable it (or remove the deny) in the session's agents.`);
                }
              }
            } catch {}
          } else {
            cleanupSkillPlugin(name);
          }
          if (resumeId && !args.includes('--resume') && !args.includes('-r')) {
            args.push('--resume', resumeId);
            if (fork && !args.includes('--fork-session')) args.push('--fork-session');
          }
          if (sysFile && !args.includes('--system-prompt-file') && !args.includes('--system-prompt')) {
            args.push('--system-prompt-file', sysFile);
          }
          const promptPath = pathFor(REGISTRY_DIR, name, 'appendPrompt');
          const realIpc = teamBlock ? `${append}\n\n${teamBlock}\n` : append;
          // FREEZE on resume (see ipc-prompt-cache.js). create() runs on
          // restore-with---resume too, so writing `realIpc` unconditionally here
          // is what changed the system prompt under continuing conversations and
          // cost 111k-139k tokens a time. A resume re-bakes the bytes this
          // conversation was BORN with and stages any change as a diff for the
          // ipcdelta drain; a genuine boundary regenerates, which is free because
          // the conversation is new anyway.
          //
          // Three conditions, and every one of them is a bug that shipped:
          //   resumeId    — there is a conversation to protect at all.
          //   !mint       — a MINT regenerates even when it carries a resumeId (an
          //                 "adopt"), because reusing a same-named dead session's
          //                 frozen bytes would bake a stranger's prompt. This is
          //                 the mint-vs-restore axis (nameConflict's header), and
          //                 it replaces the _cleanup rm that used to enforce the
          //                 same thing destructively — and wrongly, since restart
          //                 routes through kill() too.
          //   hookInstalled — NO FREEZE WITHOUT A CHANNEL. A user --settings means
          //                 ipcdelta.sh was never installed, so a staged delta can
          //                 never be delivered; freezing there is permanent silent
          //                 staleness, strictly worse than the rewrite this module
          //                 exists to avoid. Regenerating is the honest fallback:
          //                 the session pays the bust once and is CORRECT.
          if (resumeId && !mint && !hookInstalled) {
            warnings.push(`This session's own --settings replaces Clodex's hooks, so the IPC protocol-change channel isn't installed. Its system prompt will be regenerated on every resume instead of frozen — correct, but it re-reads the whole prompt each time.`);
          }
          const baked = bakePrompt(REGISTRY_DIR, name, realIpc, !!resumeId && !mint && hookInstalled);
          // ensureDir here so the write never depends on hook-setup ordering
          // having created the dir first — the same invariant, and the same
          // idiom, as the socket bind's ensureDir below. It is load-bearing on
          // exactly the path this block is about: run/<name>/ is created as a
          // side effect of setupClaudeHook, which is SKIPPED when the caller
          // supplies its own --settings, so without this a --settings session
          // ENOENTs here and cannot spawn at all.
          ensureDir(runDirFor(REGISTRY_DIR, name));
          fs.writeFileSync(promptPath, baked, { mode: 0o600 });
          args.push('--append-system-prompt-file', promptPath);
          break;
        }
        case 'codex': {
          cmd = 'codex';
          const codexSystemBody = systemPromptFile ? getPromptLibrary().raw('system', systemPromptFile) : null;
          const codexAppendBodies = readAppendBodies(appendPromptFiles);
          const { cleaned, merged } = mergeCodexInstructions(extraArgs, buildIpcPrompt(intents, this._resolveExecDefs(execCommands), pluginGrammarLines(intents)), {
            systemBody: codexSystemBody, appendBodies: codexAppendBodies, inlineBody: systemPromptBody || null,
          });
          args = [...cleaned];
          setupCodexHook(name, cwd);
          if (!args.includes('hooks') && !args.includes('codex_hooks')) args.push('--enable', 'hooks');
          if (!args.includes('--no-alt-screen')) args.push('--no-alt-screen');
          if (!args.some(a => a.startsWith('tui.status_line'))) {
            args.push('-c', codexStatusLineArg(getUiSettings()));
          }
          ensureDir(MSG_DIR);
          if (!args.includes(MSG_DIR)) args.push('--add-dir', MSG_DIR);
          const instructionsPath = pathFor(REGISTRY_DIR, name, 'instructions');
          fs.writeFileSync(instructionsPath, teamBlock ? `${merged}\n\n${teamBlock}\n` : merged, { mode: 0o600 });
          args.push('-c', `model_instructions_file=${instructionsPath}`);
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

      const env = { ...mergedEnv, TERM: 'xterm-256color' };
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
        const d = collectSystemDiagnostics();
        const resolved = cmd && cmd.includes('/') ? cmd : whichBin(cmd);
        const warning = diagWarning(d);
        throw new Error(
          `${e.message}${warning ? ` — ${warning}` : ''} `
          + `[cmd=${cmd} resolved=${resolved || 'NOT FOUND on PATH'} `
          + `cwd=${cwd || '(home)'} ${diagSummary(d)}]`,
        );
      }

      let transport = null;
      let socketPath = null;
      if (agentType) {
        ensureDir(runDirFor(REGISTRY_DIR, name));
        socketPath = pathFor(REGISTRY_DIR, name, 'socket');

        // Probe the blocking record's socket BEFORE binding: Transport.start()
        // unlinks socketPath (which is name-derived, so it is the SAME path a live
        // blocker listens on) before it listens, so any probe made after the bind
        // answers "live" unconditionally — for a ghost exactly as for a real agent.
        // The registry records a bare pid, and after an unclean shutdown the OS
        // recycles it, so isAlive() alone reports a stranger's process as our agent
        // and wedges the name. Best-effort: an unreadable record leaves this null and
        // the EEXIST branch falls back to the pid-only verdict it always had.
        let blockerLive = null;
        // The exact bytes the verdict describes. The probe awaits, so another
        // actor can replace the record while we are dialing; a verdict about the
        // record we READ must not be applied to a different record we find later
        // (that is how `blockerLive === false` would force-clean a live agent).
        // Compared byte-wise at the re-read below.
        let blockerRaw = null;
        try {
          blockerRaw = fs.readFileSync(pathFor(REGISTRY_DIR, name, 'registry'), 'utf-8');
          const blocker = JSON.parse(blockerRaw);
          if (blocker && blocker.socket) {
            blockerLive = await Transport.isSocketLive(blocker.socket);
          }
        } catch {}

        // Register FIRST, bind SECOND. socketPath is name-derived, so it is the very
        // path a blocking agent is listening on: Transport.start() unlinks it as its
        // first statement, and force-cleaning a stale record unlinks existing.socket —
        // either one, done after our own bind, pulls the inode out from under a live
        // net.Server, which then keeps listening with no error and no event and is
        // permanently unreachable. With this order every unlink happens while nothing
        // of ours is listening, and a refusal returns having touched nothing.
        // This does leave a window where a registry entry exists before its socket
        // file does; cleanup() prunes exactly that shape, and reaching it needs a
        // second engine sharing this ~/.clodex booting inside a sub-millisecond
        // window. Deliberately uncovered.
        try {
          registry.register(name, socketPath, cwd);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const existingRaw = fs.readFileSync(pathFor(REGISTRY_DIR, name, 'registry'), 'utf-8');
          const existing = JSON.parse(existingRaw);
          if (existingRaw !== blockerRaw) blockerLive = null;
        // The pre-bind probe OVERRIDES isStaleRegistration: proven-not-live wins even
        // when the pid check says "live, and not ours", because that check answers
        // from the pid alone. blockerLive === null means no answer, so the pid-only
        // verdict stands. A proven-LIVE socket also vetoes the own-pid clause: two
        // concurrent creates of one name both pass the sessions.has() check at the top
        // of create() (the map is not written until past the bind), and without the
        // veto the second would unlink the first's socket and rebind, leaving a live
        // server on a detached inode. This does not re-wedge the deterministic-pid
        // Docker case: a listening server belongs to the ENGINE, so "our pid AND
        // something is listening" can only mean this process is bound to that name.
          if (blockerLive === false || (blockerLive !== true && isStaleRegistration(existing.pid, process.pid, isAlive))) {
            registry.unregister(name);
            try { fs.unlinkSync(existing.socket); } catch {}
            registry.register(name, socketPath, cwd);
          } else {
            throw new Error(
              `Session "${name}" is already running elsewhere (pid ${existing.pid})`,
            );
          }
        }

        transport = new Transport(socketPath, (msg) => {
          this._onIncoming(name, msg);
        });
        try {
          await transport.start();
        } catch (e) {
          registry.unregister(name);
          transport = null;
          throw e;
        }
      }

      const session = {
        name, type, cwd, pty: ptyProc, transport, socketPath,
        spawnedAt: Date.now(),
        createdAt,
        agentType, lineBuffer: '', watcher: null,
        sessionId: resumeId || null,
        workspaceId,
        proxyAgent, proxyBase,
        intentSource, wireRouted, backend, sentinel: null,
        fileTouches: [],
        // Peer-visibility facts ([agent:who] labels, dm hold gate): state +
        // since-when, updated in _emitActivity. Restores seed from the resumed
        // transcript's mtime (= last real turn) — seeding "now" would make every
        // GUI restart reset idle clocks, mislabeling long-cold peers as fresh
        // and letting DMs to them past the hold gate for 30 minutes.
        activityState: 'idle',
        activityTs: lastTranscriptWrite(agentType, cwd, resumeId) || Date.now(),
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
        bootResumeId: resumeId || null,
        // Recompute rather than re-write: setupClaudeHook already wrote the
        // digest file pre-spawn, and rewriting here would race the CLI's
        // SessionStart hook cat-ing it (writeFileSync isn't atomic).
        digestNonEmpty: agentType === 'claude' && composeDigest(memoryStore.list(name)) !== null,
      };
      this.sessions.set(name, session);

      // Which units this spawn's digest actually puts in context. Recomposed
      // here rather than reported from writeClaudeDigestFile: the hook cats the
      // digest only for source=startup|clear|compact (see the script in
      // cli-hooks.js), so a RESUMED session receives none — the bake happens
      // either way, and recording it would claim FULL for units the model never
      // saw. That is the suppressing direction of the asymmetry, so a resume
      // records nothing and the units stay ABSENT.
      if (agentType === 'claude' && !resumeId) {
        try { memLoad.noteDigest(name, tiersOf(memoryStore.list(name))); } catch { /* observer-grade */ }
      }

      getPersistence().upsert({
        name, type, cwd,
        extraArgs,
        createdAt,
        sessionId: resumeId || null,
        workspaceId,
        systemPrompt: systemPromptBody || null,
        systemPromptFile: systemPromptFile || null,
        appendPromptFiles: Array.isArray(appendPromptFiles) ? appendPromptFiles : [],
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
        ...(Array.isArray(execCommands) && execCommands.length ? { execCommands: execCommands.map(String) } : {}),
        // Session-scope env (T46). Persisted on the entry so --resume respawns
        // with the SAME env (the wrong AWS identity on restart would be silent
        // and dangerous). Like execCommands, an empty/absent env is NOT a distinct
        // value — absent ≡ {} ≡ "no session env" — so omit it to keep the record
        // lean and let the merge fall through to global/workspace scopes. Stored
        // as the flat { KEY: value } shape create() received (session env has no
        // secret flag — a session credential is opaque either way, and it never
        // reaches an IPC read surface: it lives only on sessions.json at 0600).
        // sanitizeFlat re-applies the key/deny/newline gate at the PERSISTENCE door
        // too: a deny-listed key or newline value must not land on sessions.json
        // even inert (deny-list at every door), and it's what a later --resume reads
        // back — the spawn merge already drops junk, so the record must match.
        ...(() => {
          const clean = sanitizeFlat(sessionEnv);
          return Object.keys(clean).length ? { env: clean } : {};
        })(),
      });

      const onSessionId = (sessionId) => {
        const priorSid = session.sessionId;
        session.sessionId = sessionId;
        getPersistence().setSessionId(name, sessionId);
        // A CHANGED id is /clear — whatever was offered is no longer in front of
        // the model, so the offer cooldown ends early. Read before noteSession,
        // which owns the same transition but reports nothing back. The first id
        // (attach, resume) is not a clear and must not reset.
        if (priorSid && sessionId && priorSid !== sessionId) {
          try { arm.onContextReset(name); } catch { /* observer-grade */ }
          this._firePostClearContinuation(session);
        }
        // /clear mints a new conversation id, which is how the transcript
        // symlink repoint reports it. noteSession only resets on a CHANGE — the
        // first id (attach, resume) adopts, or the digest recorded microseconds
        // earlier in create() would be wiped by the very event that carried it.
        try { memLoad.noteSession(name, sessionId); } catch { /* observer-grade */ }
        this._noteConversationForDigest(session, sessionId);
      };
      if (agentType && session.intentSource === 'wire') {
        const { TranscriptSentinel } = require('./wire-intents');
        session.sentinel = new TranscriptSentinel({
          linkPath: pathFor(REGISTRY_DIR, name, 'transcript'),
          onSessionId,
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
              session.ctxInfo = { pct: c.pct, tok: c.tok, size: c.size, cost: c.cost, modelName: c.modelName };
              if (getRemoteServer()) {
                try { getRemoteServer().pushTelemetry(name, { ctx: session.ctxInfo }); } catch {}
              }
              const warnPath = pathFor(REGISTRY_DIR, name, 'ctxwarn');
              const warn = ctxReminderFor(c.tok);
              try {
                if (warn) fs.writeFileSync(warnPath, warn);
                else fs.rmSync(warnPath, { force: true });
              } catch {}
            }
          } catch {}
        };
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
        try {
          session.ctxWatcher = fs.watch(runDirFor(REGISTRY_DIR, name), (_event, fname) => {
            if (fname === 'ctx') readCtx();
            else if (fname === 'attn.jsonl') readAttn();
          });
        } catch {}
        readCtx();
      }

      ptyProc.onData((data) => {
        session.scrollback = ((session.scrollback || '') + data);
        if (session.scrollback.length > SCROLLBACK_MAX) {
          session.scrollback = session.scrollback.slice(-SCROLLBACK_MAX);
        }
        this._sendToSession(name, 'pty-data', name, data);
        if (getRemoteServer()) { try { getRemoteServer().pushOutput(name, data); } catch {} }

        if (data.includes('\x1b[?2004')) {
          session._pasteModeOn = pasteModeSignal(data, session._pasteModeOn);
          if (session._pasteModeOn && !session._bootReadySeen) {
            session._bootReadySeen = true;
            clearTimeout(session._bootDrainTimer);
            session._bootDrainTimer = setTimeout(() => {
              session._bootDrainTimer = null;
              this._drainPendingAtBootReady(session);
            }, BOOT_DRAIN_SETTLE_MS);
          }
        }

        if (!agentType) {
          this._scanPtyOutput(session, data);
        }

        if (session._bootSettling) this._armBootSettle(session);
      });

      ptyProc.onExit(({ exitCode, signal }) => {
        // The native fd is gone the moment the process exits; any later
        // write/resize/kill into node-pty throws an uncaught Napi::Error that
        // aborts the whole app (SIGABRT). Mark dead so deferred ops bail.
        session._dead = true;
        log.info('session', `exit ${name} code=${exitCode}${signal ? ` signal=${signal}` : ''}`);
        const expected = !!(session._userKilled || session._shuttingDown || session._archived);
        const missingTool = missingToolOnExit({
          expected, exitCode, signal,
          elapsedMs: Date.now() - (session.spawnedAt || 0), cmd, whichBin,
        });
        // Send the exit event BEFORE cleanup so the renderer can still resolve
        // the session → workspace → window mapping. Otherwise the sidebar
        // tab sticks around as a "dead" entry.
        this._sendToSession(name, 'session-exit', name, exitCode, { expected, signal: signal || null, agentType: agentType || null, missingTool });
        this._broadcast('ipc-message', {
          type: 'exit', from: name, to: 'exit',
          body: `code=${exitCode}${signal ? ` signal=${signal}` : ''}${expected ? '' : ' unexpected'}`,
        });
        if (getRemoteServer()) { try { getRemoteServer().notifyExit(name, exitCode); } catch {} }
        if (!agentType && !session._shuttingDown && !session._userKilled && !session._archived) {
          getPersistence().remove(name);
        }
        try { getPluginHooks && getPluginHooks() && getPluginHooks().fireExit(name); } catch {}
        this._cleanup(name);
        if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
        if (typeof refreshAppMenu === 'function') refreshAppMenu();
      });

      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
      if (typeof refreshAppMenu === 'function') refreshAppMenu();
      if (getRemoteServer()) { try { getRemoteServer().notifySessions(); } catch {} }
      log.info('session', `spawn ${name} (${type}) pid=${ptyProc.pid}${resumeId ? ' resumed' : ''} cwd=${cwd}`);
      if (resolvedTeam) {
        this._maybeInjectComposition(session, resolvedTeam, existingEntry);
        if (session.agentType !== 'claude') {
          session._bootSettling = true;
          session._bootSettleSince = Date.now();   // absolute-wait cap anchor
        }
      }
      try { getPluginHooks && getPluginHooks() && getPluginHooks().fireCreate(name); } catch {}
      return { name, type, pid: ptyProc.pid, backend, ...(teamName ? { team: teamName } : {}), ...(warnings.length ? { warnings } : {}) };
    }

    write(name, data) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      if (isHumanPtyInput(data)) {
        s.lastUserInputTs = Date.now();
        const wasInPaste = s._inPaste;
        const sig = draftChunkSignal(data, s._inPaste);
        s._inPaste = sig.inPaste;
        if (sig.closes) s.lastUserSubmitTs = s.lastUserInputTs;
        s.lastMainStop = null;
        if (s.needsAttention) this._setAttention(s, null);
        // Draft accumulation for hint arming. Inside the isHumanPtyInput gate on
        // purpose: injected text (dm delivery, nudges, ticket bodies) must never
        // reach the accumulator, and reusing this gate is what guarantees it
        // rather than a second predicate that can drift from this one.
        this._foldDraft(s, data, wasInPaste);
      }
      try { s.pty.write(data); } catch {}
    }

    // Accumulate the draft and arm a hint against it. Never awaited and never
    // able to throw into write(): a hint is worth nothing next to the user's
    // keystroke reaching the PTY.
    _foldDraft(s, data, wasInPaste) {
      try {
        // The WHOLE previous result carries forward, not just the text: the
        // cursor and the desync flag are what make this a line editor rather
        // than an append-only buffer.
        const r = foldDraft(s._draftState || s._draft || '', data, wasInPaste);
        s._draftState = r;
        s._draft = r.draft;
        const key = s.name;
        if (r.cleared) { arm.disarm(key, this._armCtx(s)); return; }
        if (r.closes) {
          // The final pass runs BEFORE the reset, on the draft the user actually
          // submitted — after the reset there is nothing left to rank.
          arm.onDraft(key, s._draft, this._armCtx(s),
            { final: true, overflow: r.overflow, desync: r.desync });
          s._draft = '';
          s._draftState = null;
          arm.onSubmit(key);
          return;
        }
        arm.onDraft(key, s._draft, this._armCtx(s), { overflow: r.overflow, desync: r.desync });
      } catch (e) { log.debug('hint', `draft fold failed for ${s.name}: ${e.message}`); }
    }

    // The EXACT route when we have it, a glob only as a fallback. A glob is
    // fnmatchcase on the proxy side (proxylab/hints.py _matching_agent_scopes),
    // so `clodex-clodex-*` also matches `clodex-clodex-hand-4f2a` — arming for
    // one agent would arm every agent whose name extends it. Clodex mints
    // proxyAgent itself, so the hash is known here even though it is not
    // knowable from outside.
    _armCtx(s) {
      return {
        agent: s.name,
        base: s.proxyBase || null,
        route: s.proxyAgent || `${PROXY_AGENT_PREFIX}${s.name}-*`,
      };
    }

    // The read API for the contextual-hint injector: 'full' (body is in
    // context — skip the hint), 'title' (an index line rode, so the model knows
    // the unit exists and cannot read it — the BEST hint candidate), 'absent'.
    // Never a boolean: collapsing the three states loses whichever answer the
    // caller needed.
    memoryLoadState(agent, id) { return memLoad.stateOf(agent, id); }
    memoryLiveSet(agent) { return memLoad.liveSet(agent); }
    memoryRecallLog(agent) { return memLoad.recallLog(agent); }

    resize(name, cols, rows, requester = 'owner') {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      try { s.pty.resize(cols, rows); } catch {}
      const key = `${s.pty.cols}x${s.pty.rows}:${requester}`;
      if (s._lastLoggedResize !== key) {
        s._lastLoggedResize = key;
        log.info('resize', `${name} ${s.pty.cols}x${s.pty.rows} by ${requester}`);
      }
      if (getRemoteServer()) {
        try { getRemoteServer().notifyResize(name, s.pty.cols, s.pty.rows); } catch {}
      }
    }

    async kill(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      log.info('session', `kill ${name} (user-initiated) pid=${s.pty.pid}`);
      s._userKilled = true;
      this._notifyComposition(s, 'retired');
      const killRec = getPersistence().get(name);
      if (killRec && killRec.ephemeral && killRec.reviewFor && s.proxyBase && s.proxyAgent) {
        try {
          ProxyClient.spawnerHint(s.proxyBase, s.proxyAgent, { clear: true })
            .catch((e) => log.warn('session', `reviewer spawner-hint(clear) ${s.proxyAgent} failed: ${e.message}`));
        } catch (e) {
          log.warn('session', `reviewer spawner-hint(clear) skipped: ${e.message}`);
        }
      }
      getPersistence().remove(name);
      try { s.pty.kill(); } catch {}
      setTimeout(() => {
        try { process.kill(s.pty.pid, 'SIGKILL'); } catch {}
      }, 5000);
    }

    async archive(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      log.info('session', `archive ${name} pid=${s.pty.pid}`);
      this._notifyComposition(s, 'archived');
      getPersistence().setArchived(name, true);
      s._archived = true;
      try { s.pty.kill(); } catch {}
      setTimeout(() => {
        try { process.kill(s.pty.pid, 'SIGKILL'); } catch {}
      }, 5000);
    }

    sweepReviewerGraveyard() {
      const swept = [];
      const corpses = getPersistence().list()
        .filter((e) => e && e.ephemeral === true && e.reviewFor && e.archivedAt)
        .map((e) => e.name);
      for (const name of corpses) {
        getPersistence().remove(name);
        swept.push(name);
      }
      if (swept.length) {
        log.info('migrate', `swept ${swept.length} archived reviewer seat(s): ${swept.join(', ')}`);
      }
      return swept;
    }

    teamNameFor(cwd) {
      if (!cwd) return null;
      try { const t = resolveTeam(cwd); return t ? t.name : null; } catch { return null; }
    }

    // `{ name, label }` — the warmth label is computed here, not in
    // team-manifest: that module is a pure leaf and warmth is a wire-layer
    // property (proxy snapshot + activity state), so it crosses as data.
    _teamLiveSeats(teamRoot) {
      const seats = [];
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        let root; try { root = findProjectRoot(s.cwd); } catch { root = null; }
        if (!root || root !== teamRoot) continue;
        let label = null;
        try {
          label = peerStatusLabel({
            state: s.activityState || 'idle',
            idleMs: Date.now() - (s.activityTs || Date.now()),
            payload: this._proxyPoller ? this._proxyPoller.snapshot(s.name) : null,
            attention: s.needsAttention ? s.needsAttention.kind : null,
            agentType: s.agentType,
          });
        } catch { label = null; }
        seats.push({ name: s.name, label });
      }
      return seats;
    }

    _teamLiveSeatNames(teamRoot) {
      return this._teamLiveSeats(teamRoot).map((s) => s.name);
    }

    // The roster body for `name`, or null when the seat is not on a team. Called
    // by the boot-digest writer BEFORE the session exists in the map, so the cwd
    // comes from persistence when there is no live session to read it from.
    composeRosterFor(name) {
      let cwd = null;
      const s = this.sessions.get(name);
      if (s && s.cwd) cwd = s.cwd;
      else { try { const e = getPersistence().get(name); if (e) cwd = e.cwd; } catch { cwd = null; } }
      if (!cwd) return null;
      let team; try { team = resolveTeam(cwd); } catch { return null; }
      if (!team) return null;
      return formatRoster(team, this._teamLiveSeats(team.root), { seat: name });
    }

    _rebakeDigest(name) {
      try { writeClaudeDigestFile(name); } catch { /* digest is best-effort */ }
    }

    _maybeInjectComposition(session, team, existingEntry) {
      if (existingEntry && existingEntry.rosterSentAt) {
        // A resumed seat gets no roster MESSAGE (it may already hold one, and a
        // duplicate costs a turn), but its digest must still be re-baked: the
        // pre-spawn write ran before this seat was in the map, so the file on
        // disk carries no roster at all. Skipping this is the shape of the
        // original bug — one stamp suppressing delivery for a seat's whole life.
        if (session.agentType === 'claude') this._rebakeDigest(session.name);
        return;
      }
      this._injectRoster(session, team);
      this._notifyComposition(session, 'spawned');
    }

    _markRosterSent(session) {
      const p = getPersistence();
      if (p && typeof p.setRosterSent === 'function') p.setRosterSent(session.name);
    }

    // Re-seed post-create persistence fields across a kill()+create restart (task
    // 22 rework / MUST-FIX 2, generalized in task 24 / MUST-FIX 2). The APP-RELAUNCH
    // restore path keeps the persistence record (never removed), so create()'s
    // existingEntry carries these fields. But the IN-PLACE restart paths
    // (engine.restartSession / applySessionArgs) route through kill(), which
    // REMOVES the record — so create() rebuilds it from spawn args ONLY, dropping
    // any field seeded AFTER create on the prior spawn: `rosterSentAt` (roster
    // gate → re-injects the roster into a --resume'd context) and a reviewer seat's
    // `ephemeral`/`reviewFor` (identity → review-done can no longer route/retire).
    // Re-seeding AFTER create() is too late for the fields create() itself reads
    // (rosterSentAt gates in create), so the restart callers capture the pre-kill
    // entry and call this AFTER kill, BEFORE create: it re-seeds JUST the requested
    // fields present on the prior entry, and create's own upsert then spread-merges
    // the full record over this stub, preserving them. A prior entry lacking a
    // field seeds nothing for it (a genuinely fresh seat gets its roster).
    _preserveAcrossRestart(name, priorEntry, fields) {
      if (!priorEntry || !Array.isArray(fields) || !fields.length) return;
      const seed = { name };
      let any = false;
      for (const f of fields) {
        if (priorEntry[f] !== undefined) { seed[f] = priorEntry[f]; any = true; }
      }
      if (!any) return;
      const p = getPersistence();
      if (p && typeof p.upsert === 'function') p.upsert(seed);
    }

      // Never actively write into a still-booting TUI: at spawn the trailing Enter is
      // swallowed and the roster is left as an un-submitted draft. Claude parks the
      // roster passively (drains on its first organic hook turn); codex has no passive
      // store, so it stashes the TEAM REF — not a rendered body — and _settleBoot
      // renders + delivers once boot output quiesces. Stashing the ref is what lets a
      // teammate that spawned DURING this seat's boot appear in the roster it receives.
    _injectRoster(session, team) {
      try {
        if (session.agentType === 'claude') {
          this._deliverPassive(session.name, 'team', formatRoster(team, this._teamLiveSeats(team.root), { seat: session.name }), 'dm');
          // Both paths are needed and neither is redundant. setupClaudeHook
          // writes the digest BEFORE this seat exists in the map or in
          // persistence, so a fresh seat's pre-spawn digest cannot contain a
          // roster — the message above is what its FIRST conversation gets.
          // Re-baking here is what every conversation AFTER a context reset
          // gets, since the message will have been discarded with the history.
          this._rebakeDigest(session.name);
          this._markRosterSent(session);
        } else {
          session._pendingRoster = team;   // team ref; body recomputed FRESH by _settleBoot at boot-settle
        }
      } catch (e) {
        log.error('inject', `roster inject failed for ${session.name}: ${e.message}`);
      }
    }

    _armBootSettle(session) {
      if (!session._bootSettling) return;
      if (Date.now() - (session._bootSettleSince || 0) >= ROSTER_MAX_WAIT_MS) {
        clearTimeout(session._bootSettleTimer);
        session._bootSettleTimer = null;
        this._settleBoot(session);
        return;
      }
      clearTimeout(session._bootSettleTimer);
      session._bootSettleTimer = setTimeout(() => this._settleBoot(session), ROSTER_SETTLE_MS);
    }

    _settleBoot(session) {
      session._bootSettleTimer = null;
      session._bootSettling = false;   // boot window closed → deltas deliver normally now
      const team = session._pendingRoster;
      if (!team || session._dead) return;
      session._pendingRoster = null;
      try {
        this._deliverMessage(session.name, 'team', formatRoster(team, this._teamLiveSeats(team.root), { seat: session.name }), 'dm');
        this._markRosterSent(session);   // delivered now → stamp so a restart won't re-inject
      } catch (e) {
        log.error('inject', `roster flush failed for ${session.name}: ${e.message}`);
      }
    }

    _notifyComposition(session, verb) {
      if (!session || !session.agentType) return;
      let team;
      try { team = resolveTeam(session.cwd); } catch { return; }
      if (!team) return;
      const role = matchSeatRole(team, session.name);
      const body = formatCompositionDelta(team.name, verb, { seat: session.name, role });
      const roleDef = role ? (team.roles && team.roles[role]) : null;
      let rec = null; try { rec = getPersistence().get(session.name); } catch { rec = null; }
      const ephemeral = (roleDef && roleDef.ephemeral === true) || (rec && rec.ephemeral === true);
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead || s.name === session.name) continue;
        if (s._bootSettling) continue;   // still booting (codex) → drop the delta (harmless-miss contract)
        if (ephemeral && s.name !== team.lead) continue;
        let root; try { root = findProjectRoot(s.cwd); } catch { root = null; }
        if (!root || root !== team.root) continue;
        this._deliverPassive(s.name, 'team', body, 'dm');
        // The delta rides conversation history and dies with the next context
        // reset; re-baking the digest is what makes this seat's NEXT boot carry
        // the changed composition instead of the one it was minted with.
        if (s.agentType === 'claude') this._rebakeDigest(s.name);
      }
    }

    list() {
      const teamByCwd = new Map();
      const resolvedTeamFor = (cwd) => {
        if (!cwd) return null;
        if (teamByCwd.has(cwd)) return teamByCwd.get(cwd);
        let t = null;
        try { t = resolveTeam(cwd); } catch { t = null; }
        teamByCwd.set(cwd, t);
        return t;
      };
      const teamFor = (cwd) => { const t = resolvedTeamFor(cwd); return t ? t.name : null; };
      const ticketsByDir = new Map();
      const openTicketFor = (s) => {
        try {
          const t = resolvedTeamFor(s.cwd);
          if (!t || !t.file) return null;
          const dir = path.dirname(t.file);
          if (!ticketsByDir.has(dir)) ticketsByDir.set(dir, ticketsStore.load(dir));
          const role = matchSeatRole(t, s.name);
          const open = ticketsByDir.get(dir).find((tk) => tk.state === 'open' && tk.assignee != null
            && (tk.assignee === s.name || tk.assignee === role));
          return open ? open.id : null;
        } catch { return null; }
      };
      return Array.from(this.sessions.values()).map(s => ({
        name: s.name,
        type: s.type,
        pid: s.pty.pid,
        cwd: s.cwd,
        workspaceId: s.workspaceId,
        team: teamFor(s.cwd),
        ticket: s.agentType ? openTicketFor(s) : null,
        backend: s.backend || null,
        activity: s.activityState || 'idle',
        attention: s.needsAttention ? s.needsAttention.kind : null,
        pendingCount: s.agentType === 'claude' ? countPending(PENDING_DIR, s.name) : 0,
      }));
    }

    listForWorkspace(workspaceId) {
      return this.list().filter(s => s.workspaceId === workspaceId);
    }

    livePids() {
      const pids = new Set();
      for (const s of this.sessions.values()) {
        if (s.pty && Number.isInteger(s.pty.pid)) pids.add(s.pty.pid);
      }
      return pids;
    }

    trackedSessionIds() {
      const ids = new Set();
      for (const s of this.sessions.values()) if (s.sessionId) ids.add(s.sessionId);
      for (const e of getPersistence().list()) {
        if (e.sessionId) ids.add(e.sessionId);
        if (Array.isArray(e.sessionIds)) for (const id of e.sessionIds) ids.add(id);
      }
      return ids;
    }

    pendingCountFor(name) {
      const s = this.sessions.get(name);
      return s && s.agentType === 'claude' ? countPending(PENDING_DIR, s.name) : 0;
    }

    peekPendingFor(name) {
      const s = this.sessions.get(name);
      return s && s.agentType === 'claude' ? peekPending(PENDING_DIR, s.name) : [];
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
        for (const name of Array.from(this._lastPendingCounts.keys())) {
          if (live.has(name)) continue;
          this._lastPendingCounts.delete(name);
          this._broadcast('pending-count', { name, count: 0 });
        }
      };
      this._pendingPollTimer = setInterval(tick, intervalMs);
    }

    async killAll() {
      setAppQuitting(true);
      for (const s of this.sessions.values()) {
        s._shuttingDown = true;
      }
      for (const [name] of this.sessions) {
        const s = this.sessions.get(name);
        try { s.pty.kill(); } catch {}
      }
    }

    _cleanup(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      clearTimeout(s._injectHoldTimer);
      clearTimeout(s._injectFlushRetry);
      clearTimeout(s._compactValveTimer);
      clearTimeout(s._postClearValveTimer);
      clearTimeout(s._parkCapTimer);
      clearTimeout(s._bootSettleTimer);
      clearTimeout(s._bootDrainTimer);
      // Drops the pending debounce timer with it — a hint armed after the PTY
      // died would ride the next session under the same name.
      try { arm.forget(name); } catch {}
      s._compactPending = null; // no timer, but null for symmetry with the valve state
      s._postClearContinuation = null;
      // Parked deliveries and the frozen system prompt (ipc-prompt-cache) are
      // deliberately NOT dropped here, under any gate. _userKilled is not a "going
      // away for good" signal — restart routes through kill() too — so gating an rm
      // on it destroyed undelivered mail and busted the prompt cache on the button
      // labelled "restart". Both stale-successor hazards are handled at the READ end
      // instead: drainPending compares the `born` stamp, and a MINT regenerates the
      // prompt unconditionally. Residue for a never-recreated name is a few small
      // files and is harmless.
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
        if (!intent || intent.type === 'escape' || intent.type === 'end') continue;
        this._handleIntent(session.name, intent);
      }
    }

    _noteFileTouches(session, touches, sub = false) {
      try {
        noteFileTouches(session.fileTouches, touches, {
          cwd: session.cwd, ts: Date.now(), sub, resolve: path.resolve,
        });
        this._sendToSession(session.name, 'session-files', session.name, session.fileTouches);
        const count = session.fileTouches.length;
        if (session._peerFileCount !== count) {
          session._peerFileCount = count;
          try { getRemoteServer() && getRemoteServer().pushTelemetry(session.name, { files: { count } }); } catch {}
        }
      } catch { /* observer-grade — never near the PTY/intent path */ }
    }

    _fileHeatFor(session) {
      if (!session.fileHeat) {
        session.fileHeat = createFileHeat({ filePath: pathFor(REGISTRY_DIR, session.name, 'fileHeat') });
      }
      return session.fileHeat;
    }

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

    _emitActivity(name, state, notify) {
      const s = this.sessions.get(name);
      if (s && s.activityState !== state) {
        s.activityState = state; s.activityTs = Date.now();
        if (typeof scheduleTrayRefresh === 'function') scheduleTrayRefresh();
      }
      if (s && state !== 'idle') s.lastMainStop = null;
      if (state !== 'idle') this._touchTicketActivity(name);
      if (s && state !== 'idle' && s.needsAttention) this._setAttention(s, null);
      if (s && state === 'idle') { this._maybeFlushInjectQueue(s); this._drainPendingAtIdle(s); }
      this._sendToSession(name, 'session-activity', name, state);
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

    _setAttention(session, attn) {
      session.needsAttention = attn;
      this._sendToSession(session.name, 'session-attention', session.name, attn);
      if (typeof scheduleTrayRefresh === 'function') scheduleTrayRefresh();
      if (!attn) this._maybeFlushInjectQueue(session);
    }

    _fireCompactContinuation(session) {
      // The live set resets to EMPTY — no attempt to model what the summarizer
      // kept. "Possibly evicted" resolving to "not loaded" is the correct
      // answer for a dedup consumer, and this fires for the CLI's own
      // auto-compact too, because the watcher reads the transcript rather than
      // only knowing about compactions Clodex triggered.
      try { memLoad.noteCompact(session.name); } catch { /* observer-grade */ }
      // Same transition, different ledger. "Already in context" and "already
      // offered" are separate questions on purpose, so they reset side by side
      // here rather than one reading the other.
      try { arm.onContextReset(session.name); } catch { /* observer-grade */ }
      this._clearCompactValve(session);
      const sched = getRemindScheduler && getRemindScheduler();
      if (sched) { try { sched.fireCompactFor(session.name); } catch {} }
      const cont = session._compactContinuation;
      if (cont) {
        session._compactContinuation = null;
        setTimeout(() => {
          if (session._dead) return;
          this._injectText(session, cont, { bypassHold: true });
          const delay = cont.length > LONG_TEXT_THRESHOLD ? LONG_TEXT_DELAY : SHORT_TEXT_DELAY;
          setTimeout(() => this._releaseCompactGuard(session), delay + 200);
        }, COMPACT_CONTINUATION_DELAY);
      } else {
        this._releaseCompactGuard(session);
      }
    }

    _injectHoldReason(session) {
      if (session._compactGuard) return 'compact-window';
      if (session.needsAttention && session.needsAttention.kind === 'permission') return 'dialog';
      if (session.activityState === 'thinking') return 'busy';
      return null;
    }

    _armInjectValve(session) {
      if (session._injectHoldTimer) return;
      session._injectHoldTimer = setTimeout(() => {
        session._injectHoldTimer = null;
        console.warn(`inject hold ${session.name}: release never came (${this._injectHoldReason(session) || 'none'}) — forcing flush after timeout`);
        session._compactGuard = false;
        this._maybeFlushInjectQueue(session, true);
      }, INJECT_HOLD_TIMEOUT);
    }

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

    // Turn-one briefing for a self-cleared agent, fired from the sessionId-CHANGE
    // edge in create()'s onSessionId. That edge is the only reliable "the clear
    // actually landed" signal — /clear mints a new conversation id and the
    // transcript symlink repoints, /compact is in-place and keeps the id. A timer
    // ("probably done by now") would inject into whatever conversation happened to
    // be in front of the model. Named for the phase, not as a sibling of
    // _clearCompactValve, which means "clear the compact valve" — the opposite of
    // what a _clearValve here would mean.
    _firePostClearContinuation(session) {
      const cont = session._postClearContinuation;
      if (!cont) return;
      session._postClearContinuation = null;
      this._clearPostClearValve(session);
      setTimeout(() => {
        if (session._dead) return;
        this._injectText(session, cont);
      }, COMPACT_CONTINUATION_DELAY);
    }

    // A continuation whose clear never landed must EXPIRE rather than wait: the
    // next sessionId change could be an operator's manual /clear minutes later,
    // and a stale briefing injected into an unrelated conversation is worse than
    // a lost one. No retry — the clear it belonged to is gone.
    _armPostClearValve(session) {
      this._clearPostClearValve(session);
      session._postClearValveTimer = setTimeout(() => {
        session._postClearValveTimer = null;
        const dropped = session._postClearContinuation;
        session._postClearContinuation = null;
        if (dropped) {
          log.warn('intent', `clear ${session.name} release valve fired — clear never landed, dropped the continuation (${dropped.length} chars, no retry)`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name,
            body: 'context clear → continuation dropped (clear never landed)',
          });
        }
      }, COMPACT_INFLIGHT_TIMEOUT);
    }

    _clearPostClearValve(session) {
      if (session._postClearValveTimer) { clearTimeout(session._postClearValveTimer); session._postClearValveTimer = null; }
    }

    _maybeFlushInjectQueue(session, force = false) {
      clearTimeout(session._injectFlushRetry);
      session._injectFlushRetry = null;
      if (session._dead) return;
      const queue = session._injectQueue;
      if (!queue || !queue.length) {
        if (!session._compactGuard) {
          clearTimeout(session._injectHoldTimer);
          session._injectHoldTimer = null;
        }
        return;
      }
      if (!force && this._injectHoldReason(session)) return;
      clearTimeout(session._injectHoldTimer);
      session._injectHoldTimer = null;
      session._injectQueue = [];
      this._injectText(session, queue.join('\n'), { bypassHold: true });
    }

    _drainPendingAtIdle(session) {
      if (!session || session.agentType !== 'claude' || session._dead) return;
      try { if (isDraftOpen(session)) return; } catch { return; }   // don't splice an open draft
      if (!hasActivePending(PENDING_DIR, session.name)) return;
      let texts = [];
      try { texts = drainPending(PENDING_DIR, session.name, `idle.${process.pid}`, this._bornFor(session.name)); } catch {}
      if (!texts.length) return;                        // hook already drained, or nothing parked
      this._injectText(session, texts.join('\n\n'), { parkable: true });
    }

    // Boot-ready-edge drain (T54). The idle-edge drain above claims the store
    // EAGERLY (drainPending at schedule time) then fire-and-forgets the inject —
    // fine for a genuinely-parked LIVE seat, but a silent-loss trap on a FRESH boot
    // edge, where the composer may not yet accept input: the file is gone from disk
    // (no ✉) yet the write is wiped by the boot re-render. So the boot path claims
    // LATE instead: peek (non-destructive) to decide whether to bother, then enqueue
    // a fire-time PRODUCER that does the destructive drainPending claim only once the
    // InjectQueue is past its ready + quiet gates and about to write. If the seat
    // died or a draft opened in the meantime the producer claims nothing and returns
    // null — the delivery stays parked, recoverable, its ✉ intact (never worse than
    // pre-T54's recoverable click). Exactly-once holds: the claim is the same atomic
    // dir-rename the hook + idle drains use, so whoever fires first owns the messages.
    _drainPendingAtBootReady(session) {
      if (!session || session.agentType !== 'claude' || session._dead) return;
      try { if (isDraftOpen(session)) return; } catch { return; } // don't splice an open draft
      if (!hasActivePending(PENDING_DIR, session.name)) return;    // nothing active — leave passives parked
      const produce = () => {
        if (session._dead) return null;
        try { if (isDraftOpen(session)) return null; } catch { return null; }
        let texts = [];
        try { texts = drainPending(PENDING_DIR, session.name, `boot.${process.pid}`, this._bornFor(session.name)); } catch { return null; }
        if (!texts.length) return null;                 // hook/idle already claimed it
        return texts.join('\n\n');
      };
      this._injectQueueFor(session).enqueue('', { produce });
    }


    _extractIntents(text) {
      const intents = [];
      const lines = text.split('\n');
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
      let unknown = null;
      while (i < lines.length) {
        const line = lines[i].trim();
        const inFence = fenced[i];
        i++;
        if (inFence) continue;
        const intent = parseIntent(line);
        if (intent && intent.type === 'end') continue;
        if (!intent || intent.type === 'escape') {
          const nearMiss = !intent && looksLikeIntent(line);
          if (nearMiss) {
            if (unknown) unknown.more++;
            else { unknown = { type: 'unknown', text: nearMiss.slice(0, 160), more: 0 }; intents.push(unknown); }
          }
          continue;
        }

        if (bodyModeFor(intent) === 'json') {
          let buf = intent.body || '';
          let j = i;
          let complete = jsonComplete(buf); // may already be complete on the intent line
          while (!complete && j < lines.length) {
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
        }

        const bodyMode = bodyModeFor(intent);
        if (bodyMode === 'greedy' || bodyMode === 'json') {
          const body = [];
          while (i < lines.length) {
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


    async _handleIntent(senderName, intent) {
      const session = this.sessions.get(senderName);

      if (intent.type === 'end') return;

      if (intent.type === 'unknown') {
        if (session && session.agentType) {
          const more = intent.more ? ` (+${intent.more} more unrecognized [agent:…] lines this turn)` : '';
          this._injectText(session,
            `[agent:?] unrecognized intent \`${intent.text}\`${more} — nothing was done. `
            + `Valid intents: ${validIntentNames().join(', ')}. `
            + 'To quote an intent literally, put it in a ``` code fence or escape it as \\[agent:…].', { parkable: true });
        }
        this._broadcast('ipc-message', {
          type: 'intent', from: senderName, to: senderName,
          body: `unrecognized intent bounced: ${intent.text}`,
        });
        return;
      }

      if (!intentEnabledFor(intent.type, getPersistence().get(senderName)?.intents)) {
        if (session && session.agentType) {
          const msg = intent.type === 'resend'
            ? "the resend intent is disabled for this session — the message will deliver with the peer's next turn"
            : `the ${intent.type} intent is disabled for this session`;
          this._injectText(session, `[agent:${intent.type}] ${msg}`, { parkable: true });
        }
        return;
      }

      switch (intent.type) {
        case 'dm': {
          const localTarget = this.sessions.get(intent.target);
          if (localTarget && localTarget.agentType) {
            const r = this._gatedDeliver(intent.target, senderName, intent.body, intent.urgent === true);
            if (r.parked || r.held) {
              const parkId = r.parked || null;
              if (session) {
                let notice;
                if (parkId) {
                  notice = r.noUrgent
                    ? `[agent:dm] parked for ${intent.target} (${r.reason}) as ${parkId} — it'll be delivered after the human answers the dialog.`
                    : `[agent:dm] parked for ${intent.target} (${r.reason}) as ${parkId} — it'll be delivered with ${intent.target}'s next turn. If it can't wait, emit \`[agent:resend ${parkId}]\` to wake them now (delivers the parked copy — don't retype the message).`;
                } else {
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
          } else if (!localTarget) {
            if (intent.target.includes('@')) {
              this._routeFederatedDm(session, senderName, intent);
              break;
            }
            const peer = await registry.getPeer(intent.target);
            if (peer) {
              await Transport.send(peer.socket, {
                type: 'dm', from: senderName, body: intent.body,
              });
            } else {
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
          const verdict = shouldHoldDm({
            urgent: true,
            state: target.activityState || 'idle',
            idleMs: Date.now() - (target.activityTs || Date.now()),
            payload: this._proxyPoller ? this._proxyPoller.snapshot(target.name) : null,
            attention: target.needsAttention ? target.needsAttention.kind : null,
          });
          if (verdict.hold) {
            let reparked = false;
            try { parkDelivery(PENDING_DIR, target.name, claimed.text, this._nextParkSeq(), intent.id, false, this._bornFor(target.name)); reparked = true; } catch {}
            reply(reparked
              ? `${target.name} is ${verdict.reason}; re-parked as ${intent.id} — it'll deliver after the dialog is answered.`
              : `${target.name} is ${verdict.reason} and re-parking failed — try [agent:resend ${intent.id}] again shortly.`);
            break;
          }
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
          const localAgents = Array.from(this.sessions.values())
            .filter(s => s.agentType)
            .map(s => ({ name: s.name, label: peerStatusLabel({
              state: s.activityState || 'idle',
              idleMs: Date.now() - (s.activityTs || Date.now()),
              payload: this._proxyPoller ? this._proxyPoller.snapshot(s.name) : null,
              attention: s.needsAttention ? s.needsAttention.kind : null,
              agentType: s.agentType,
            }) }));
          const externalNames = (await registry.listPeers())
            .map(p => p.name)
            .filter(n => !this.sessions.has(n))
            .map(n => ({ name: n, label: null }));
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
          if (!session || !session.agentType) break;
          this._handleContextIntent(session, intent.sub, intent.body || '');
          break;
        }
        case 'memory': {
          if (!session || !session.agentType) break;
          this._handleMemoryIntent(session, intent.sub, intent.body || '');
          break;
        }
        case 'spawn': {
          if (!session || !session.agentType) break;
          this._handleSpawnIntent(session, intent);
          break;
        }
        case 'file': {
          if (!session || !session.agentType) break;
          this._handleFileIntent(session, intent.sub, intent.path);
          break;
        }
        case 'exec': {
          if (!session || !session.agentType) break;
          this._handleExecIntent(session, intent.cmd, intent.body || '');
          break;
        }
        case 'remind': {
          if (!session || !session.agentType) break;
          this._handleRemindIntent(session, intent.spec, intent.body || '');
          break;
        }
        case 'notify-user': {
          if (!session || !session.agentType) break;
          this._handleNotifyUserIntent(session, intent.body || '');
          break;
        }
        case 'team-review': {
          if (!session || !session.agentType) break;
          this._handleTeamReview(session, intent.body || '');
          break;
        }
        case 'review-done': {
          if (!session || !session.agentType) break;
          this._handleReviewDone(session, intent.body || '');
          break;
        }
        case 'task': {
          if (!session || !session.agentType) break;
          this._handleTask(session, intent);
          break;
        }
        case 'team': {
          if (!session || !session.agentType) break;
          this._handleTeam(session, intent);
          break;
        }
        case 'reboot': {
          if (!session || !session.agentType) break;
          this._handleRebootIntent(session, intent.body || '');
          break;
        }
        default:
          this._dispatchPluginIntent(session, intent);
          break;
      }
    }

    _dispatchPluginIntent(session, intent) {
      const row = pluginRowFor(intent.type);
      if (!row || !row.handler) return;
      if (!session || !session.agentType) return;
      const hooks = getPluginHooks && getPluginHooks();
      const handle = hooks && hooks.handleFor ? hooks.handleFor(session.name) : null;
      if (!handle) return;
      try {
        const r = row.handler(handle, intent);
        if (r && typeof r.then === 'function') {
          log(`[plugin:${row.source}] intent handler for ${intent.type} returned a promise — handlers must be synchronous; result ignored`);
        }
      } catch (e) {
        log(`[plugin:${row.source}] intent handler for ${intent.type} threw: ${(e && e.message) || e}`);
        this._injectText(session, `[agent:${intent.type}] error: ${(e && e.message) || e}`, { parkable: true });
      }
    }

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
      if (Buffer.byteLength(text, 'utf8') > NOTIFY_USER_MAX_BYTES) {
        reply(`note too long (>${Math.round(NOTIFY_USER_MAX_BYTES / 1024)}KB) — keep it a summary, not a payload`);
        return;
      }

      const rec = store.add({ from: who, workspaceId: session.workspaceId || null, body: text });
      const preview = text.split('\n')[0].slice(0, 200);
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

    _handleRebootIntent(session, body) {
      const reply = (msg) => this._injectText(session, `[agent:reboot] ${msg}`, { parkable: true });
      const who = session.name;
      const reason = String(body == null ? '' : body).trim();
      const store = getUiSettings && getUiSettings();
      const settings = store ? store.get() : {};

      const now = Date.now();
      const last = Number.isFinite(settings.lastRebootAt) ? settings.lastRebootAt : 0;
      const sinceMs = now - last;
      if (last && sinceMs < REBOOT_MIN_INTERVAL) {
        const waitS = Math.ceil((REBOOT_MIN_INTERVAL - sinceMs) / 1000);
        reply(`rate-limited — a reboot happened ${Math.round(sinceMs / 1000)}s ago; try again in ${waitS}s`);
        this._broadcast('ipc-message', { type: 'reboot', from: who, to: 'clodex', body: `REFUSED (rate-limited): ${reason || '(no reason)'}` });
        return;
      }

      try { store.set({ lastRebootAt: now, pendingRebootNotice: { name: who, at: now, reason } }); }
      catch (e) { log.error('intent', `reboot: settings write failed (proceeding): ${e.message}`); }
      this._broadcast('ipc-message', { type: 'reboot', from: who, to: 'clodex', body: `rebooting${reason ? `: ${reason}` : ''}` });
      log.info('intent', `reboot by ${who}${reason ? `: ${reason}` : ''}`);
      reply('rebooting — sessions resume on relaunch');
      try {
        if (relaunchApp) relaunchApp();
      } catch (e) {
        log.error('intent', `reboot relaunch failed: ${e.message}`);
        reply(`relaunch failed: ${e.message}`);
        try { store.set({ pendingRebootNotice: null }); }
        catch (e2) { log.error('intent', `reboot notice clear failed: ${e2.message}`); }
      }
    }

    maybeDeliverRebootNotice() {
      const store = getUiSettings && getUiSettings();
      if (!store) return;
      let settings;
      try { settings = store.get(); } catch { return; }
      const notice = settings && settings.pendingRebootNotice;
      if (!notice || !notice.name) return;

      const clear = () => {
        try { store.set({ pendingRebootNotice: null }); }
        catch (e) { log.error('intent', `reboot notice clear failed: ${e.message}`); }
      };
      const retainOrExpire = (why) => {
        const at = Number.isFinite(notice.at) ? notice.at : 0;
        const age = at ? Date.now() - at : Infinity;
        if (age > REBOOT_NOTICE_MAX_AGE) {
          log.error('intent', `reboot notice for ${notice.name} DROPPED (stale >7d) after ${why}`);
          clear();
        } else {
          log.error('intent', `reboot notice for ${notice.name} RETAINED after ${why} — retry next launch`);
        }
      };

      const at = Number.isFinite(notice.at) ? notice.at : 0;
      const when = at ? new Date(at).toISOString() : 'an earlier time';
      const reason = (typeof notice.reason === 'string' ? notice.reason : '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const body = `notice: Clodex restarted and is running again (reboot requested at ${when}${reason ? `: ${reason}` : ''}).`;

      const target = this.sessions.get(notice.name);
      if (target && target.agentType) {
        try {
          if (target.agentType === 'claude') {
            const finalText = this._buildDeliveryText(target, 'reboot', body, 'dm');
            parkDelivery(PENDING_DIR, notice.name, finalText, this._nextParkSeq(), null, false, this._bornFor(notice.name));
            this._armParkCap(target);
            log.info('intent', `reboot notice parked for ${notice.name} (live claude — boot-safe, cap armed)`);
          } else {
            this._deliverMessage(notice.name, 'reboot', body, 'dm');
            log.info('intent', `reboot notice delivered to ${notice.name} (live codex)`);
          }
          clear();
        } catch (e) {
          retainOrExpire(`live deliver failed: ${e.message}`);
        }
        return;
      }
      const entry = getPersistence().get(notice.name);
      if (!entry) {
        log.info('intent', `reboot notice for ${notice.name} dropped — no persisted entry (seat deleted)`);
        clear();
        return;
      }
      try {
        const finalText = this._buildDeliveryText({ name: notice.name, agentType: entry.type }, 'reboot', body, 'dm');
        parkDelivery(PENDING_DIR, notice.name, finalText, this._nextParkSeq(), null, false, this._bornFor(notice.name));
        log.info('intent', `reboot notice for ${notice.name} parked (offline) — drains on resume`);
        clear();
      } catch (e) {
        retainOrExpire(`park failed: ${e.message}`);
      }
    }

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

      const r = sched.add(who, spec, body);
      if (!r.ok) {
        reply(r.error);
        this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${r.error}` });
        return;
      }
      log.info('intent', `remind ${r.record.kind} by ${who}: scheduled ${r.record.id}`);
      this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `scheduled ${r.record.id} (${spec})` });
    }

    // argv comes WHOLLY from the registry entry — the validated JSON payload is
    // handed to the command over STDIN and NEVER contributes to argv, which is what
    // makes argv-injection structurally impossible. The invoking seat's persisted
    // execCommands allowlist is the capability; the registry is read fresh at
    // invocation (no watcher, so a headless host cannot serve a stale cache).
    // Success is SILENT (no re-bill); all three failure classes bounce loudly,
    // because a lost exec is a lost datum.
    // _resolveExecDefs degrades to the bare id STRING on any read/parse failure — a
    // malformed def must never fail a spawn — and drops argv/cwd, which can carry
    // absolute paths that must never reach a prompt.
    _resolveExecDefs(execCommands) {
      if (!Array.isArray(execCommands)) return [];
      return execCommands.map((c) => {
        const name = String(c);
        if (!isFilenameToken(name)) return name;
        try {
          const entry = JSON.parse(fs.readFileSync(
            path.join(REGISTRY_DIR, 'library', 'exec', `${name}.json`), 'utf-8'));
          if (!entry || typeof entry !== 'object') return name;
          return {
            name,
            description: typeof entry.description === 'string' ? entry.description : '',
            schema: (entry.schema && typeof entry.schema === 'object') ? entry.schema : null,
          };
        } catch { return name; }
      });
    }

    _handleExecIntent(session, cmd, rawBody) {
      const reply = (msg) => this._injectText(session, `[agent:exec] ${msg}`, { parkable: true });
      const who = session.name;
      const fail = (msg) => {
        reply(`${cmd}: ${msg}`);
        log.warn('intent', `exec ${cmd} by ${who}: err (${msg})`);
        this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: `err: ${msg}` });
      };

      if (!isFilenameToken(cmd)) {
        fail('invalid command id');
        return;
      }
      const grants = getPersistence().get(who)?.execCommands || [];
      if (!Array.isArray(grants) || !grants.includes(cmd)) {
        fail('not granted to this seat');
        return;
      }
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
      const v = parseAndValidate(entry, rawBody);
      if (!v.ok) {
        fail(v.error);
        return;
      }

      const CLODEX_BIN = path.join(REGISTRY_DIR, 'bin');
      // ${TEAM_ROOT} is what makes an exec def PORTABLE ACROSS TEAMS. A def that
      // hardcodes an absolute project path runs that project's script for every
      // team that holds the grant — a second team asking for its own test digest
      // silently got THIS repo's, which is worse than a missing command because
      // the green result looks like its own. Resolved per CALLING SESSION, so one
      // def serves every team. Empty when the seat's cwd is in no team's root:
      // substituting a wrong root would reintroduce exactly the bug, so a def
      // using the token fails loudly instead (spawn ENOENT on a relative path).
      const teamRoot = (() => {
        try { return resolveTeam(session.cwd)?.root || ''; } catch { return ''; }
      })();
      const expandVars = (s) => String(s)
        .split('${CLODEX_BIN}').join(CLODEX_BIN)
        .split('${CLODEX_HOME}').join(REGISTRY_DIR)
        .split('${TEAM_ROOT}').join(teamRoot);
      const argv = entry.argv.map(expandVars);
      const runCwd = entry.cwd ? expandVars(entry.cwd) : (session.cwd || os.homedir());
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
            // CLODEX_HOME is set EXPLICITLY rather than inherited: the child is
            // a registered exec script (clodex-team, clodex-monitor), whose only
            // channel to the app's root is this variable — there is no --home
            // flag. Inheriting would let a CLODEX_HOME set in the app's
            // environment point the child at a different tree than the app uses.
            env: { ...process.env, CLODEX_HOME: REGISTRY_DIR },
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
        try {
          if (child.stdin) { child.stdin.write(payloadJson); child.stdin.end(); }
        } catch { /* a fast-exiting child may EPIPE — the exit handler reports it */ }
      });
    }

    _handleFileIntent(session, sub, rawPath) {
      const reply = (msg) => this._injectText(session, `[agent:file] ${msg}`, { parkable: true });
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
      if (getRemoteServer()) {
        try { getRemoteServer().pushUiEvent(session.name, 'fileView', { path: vet.path }); } catch {}
      }
    }

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

    _maybeDeliverDigest(s, sid) {
      try {
        if (!sid || s._dead || s.agentType !== 'claude') return;
        if (s.needsAttention) return; // injection would answer the dialog
        if (sid !== s.sessionId) return;
        if (isDigested(getPersistence().get(s.name), sid)) return;
        const units = memoryStore.list(s.name);
        const tiers = tiersOf(units);
        // DELIVERY MUST NOT DEPEND ON THE TRACKER. Taking the text from `tiers`
        // alone made a deps object carrying composeDigest without its sibling
        // stop delivering the digest at all — load tracking is an observer, and
        // an observer that can suppress the thing it observes is a defect.
        const digest = tiers ? tiers.text : composeDigest(units);
        if (!digest) return; // empty store — stay unmarked, try again when units exist
        getPersistence().markDigested(s.name, sid);
        // After the session reset that brought us here, so it re-seeds the live
        // set rather than being cleared by it.
        if (tiers) { try { memLoad.noteDigest(s.name, tiers); } catch { /* observer-grade */ } }
        this._deliverMessage(s.name, 'memory',
          `boot digest (this conversation started before it could ride the first turn)\n\n${digest}`, 'memory');
      } catch { /* observer-grade — never break the turn handler */ }
    }

    _memoryAck(session, line) {
      if (session.agentType === 'claude') {
        try {
          fs.appendFileSync(pathFor(REGISTRY_DIR, session.name, 'acks'), line + '\n');
          return;
        } catch { /* fall through to the injected line */ }
      }
      this._injectText(session, line);
    }

    // The one delete path for a memory unit — the [agent:memory forget] intent
    // and host.library.remove both land here. Returns rather than throws: the
    // plugin seam needs an envelope and the intent needs a message, so the
    // conversion happens once, here.
    removeMemoryUnit(agent, id) {
      try {
        // forget() validates both arguments (MEMORY_AGENT_RE / MEMORY_ID_RE) and
        // throws; a second guard here would be a second set of rules to drift.
        memoryStore.forget(agent, id);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      // Only for a LIVE session: memories outlive sessions, so this can be a
      // dead agent's unit, and writeClaudeDigestFile ensureDir's the agent's run
      // directory — recreating it as a side effect of a delete. The spawn path
      // rebakes the digest, so a dead agent loses nothing.
      const session = this.sessions.get(agent);
      if (session && !session._dead && session.agentType === 'claude') {
        // Reassigned, not discarded: _noteConversationForDigest markDigests on
        // this flag, so a store emptied to zero with a stale true marks a
        // conversation as digested that never received a digest.
        // Best-effort, and scoped to this statement on purpose: do not hoist it
        // to wrap the method. The unlink already happened and is permanent, so
        // a write failure returning { ok: false } invites a retry that fails
        // with "no unit" and reads as a bug in the delete path. The digest is
        // regenerated on next spawn; the delete is not. A throw also leaves the
        // OLD hook-digest.json in place, so a digestNonEmpty left true still
        // describes a digest that exists.
        try { session.digestNonEmpty = writeClaudeDigestFile(agent); } catch { /* best-effort */ }
      }
      return { ok: true };
    }

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
        let scope = '';
        let tags = '';
        let pinned = false;
        let text = body.trim();
        // The loop stops at the first unrecognised key, so an omitted key here
        // strands EVERY directive behind it in the body too. `tags` was missing
        // while the store, the digest and hint-retrieve all read it: four units
        // saved `tags=... pinned=true` and lost the pin, because the parse
        // halted on `tags` before it ever reached `pinned`.
        for (let m; (m = text.match(/^(scope|tags|pinned)=(\S+)\s+([\s\S]+)$/));) {
          if (m[1] === 'scope') scope = m[2];
          else if (m[1] === 'tags') tags = m[2];
          else pinned = m[2] === 'true';
          text = m[3];
        }
        try {
          const unit = memoryStore.remember(agent, { scope, tags, text, source: agent, pinned });
          refreshDigest();
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
        // The highest-signal event in the scheme: one body delivered into the
        // transcript, where it survives until clear/compact. Also the evidence
        // base for evidence-driven archival, which is why this one persists.
        try { memLoad.noteRecall(agent, unit.id, session.sessionId); } catch { /* observer-grade */ }
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
        const res = this.removeMemoryUnit(agent, body.trim());
        if (res.ok) this._memoryAck(session, `[agent:memory] removed ${body.trim()} from the store`);
        else this._injectText(session, `[agent:memory] could not remove: ${res.error}`, { parkable: true });
        return;
      }
      this._injectText(session, `[agent:memory] unknown sub-command "${sub}" (use list|remember|recall|pin|unpin|forget)`, { parkable: true });
    }

    _handleSpawnIntent(spawner, intent) {
      const reply = (msg) => this._injectText(spawner, `[agent:spawn] ${msg}`, { parkable: true });
      const name = (intent.name || '').trim();
      if (!name) { reply('error: usage [agent:spawn name:X cwd:Y [template:Z]]'); return; }
      if (!AGENT_NAME_RE.test(name)) {
        reply(`error: invalid name "${name}" — allowed [a-zA-Z0-9._-], 1-64 chars`);
        return;
      }
      if (this.sessions.has(name) || getPersistence().get(name)) {
        reply(`error: name taken "${name}"`);
        return;
      }

      let tpl = null;
      if (intent.template) {
        const v = intent.template;
        if (v.includes('/') || v.startsWith('~') || v.startsWith('.')) {
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
          if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.type) {
            reply(`error: template file ${v}: not a template object (needs a "type")`);
            return;
          }
          tpl = obj;
        } else {
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
      const tplLabel = tpl ? (tpl.name || intent.template) : null;

      const rawCwd = (intent.cwd || (tpl && tpl.cwd) || '').trim();
      if (!rawCwd) {
        reply(tpl
          ? `error: template "${tplLabel}" has no cwd — add cwd: to the spawn`
          : 'error: usage [agent:spawn name:X cwd:Y [template:Z]]');
        return;
      }
      const cwd = path.resolve(rawCwd.replace(/^~(?=$|\/)/, os.homedir()));
      const type = tpl ? (tpl.type || 'claude') : (spawner.type || 'claude');
      const workspaceId = spawner.workspaceId || DEFAULT_WORKSPACE_ID;

      const spawnerArgs = (getPersistence().get(spawner.name)?.extraArgs) || [];
      const postureArgs = spawnerArgs.includes('--dangerously-skip-permissions')
        ? ['--dangerously-skip-permissions'] : [];

      const proxy = tpl ? (tpl.proxy ?? null) : (spawner.proxy ?? null);
      const childArgs = (tpl && Array.isArray(tpl.extraArgs) && tpl.extraArgs.length)
        ? tpl.extraArgs : postureArgs;
      const agents = (tpl && tpl.agents) || [];
      const denyBuiltins = (tpl && tpl.denyBuiltins) || [];
      const disabledTools = (tpl && tpl.disabledTools) || [];
      const disabledSkills = (tpl && tpl.disabledSkills) || [];
      const injectSkills = (tpl && tpl.injectSkills) || [];
      const systemPromptFile = (tpl && tpl.systemPromptFile) || null;
      const appendPromptFiles = (tpl && tpl.appendPromptFiles) || [];
      // A template's `env` was read ONLY on the cold-reviewer path, so an
      // agent-initiated spawn silently dropped it — a seat whose whole point was
      // CLODEX_DISABLE_IPC_PROMPT booted with the full protocol prompt anyway,
      // and nothing said so. Honored here through the SAME allowlist the reviewer
      // uses, not a wider one: env is an authority surface (base-url, credential
      // and model redirects) and a template is agent-writable, so this stays a
      // fixed code-level ceiling. Keys outside it are dropped and named in the
      // reply, because a silently ignored env key is the bug being fixed.
      const tplEnv = (tpl && tpl.env && typeof tpl.env === 'object' && !Array.isArray(tpl.env)) ? tpl.env : null;
      const envDropped = [];
      let sessionEnv = null;
      if (tplEnv) {
        for (const [k, v] of Object.entries(tplEnv)) {
          if (!REVIEWER_ENV_ALLOWLIST.has(k)) { envDropped.push(k); continue; }
          if (typeof v !== 'string') { envDropped.push(k); continue; }
          (sessionEnv || (sessionEnv = {}))[k] = v;
        }
      }

      setImmediate(async () => {
        try {
          ensureDir(cwd); // self-contained: mkdir the cwd if absent — no external tool
          await this.create(
            name, type, cwd, childArgs, null, workspaceId,
            null, false, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles,
            Array.isArray(tpl && tpl.execCommands) ? tpl.execCommands : [],
            // `[]` intents (everything gated) is a real value that must apply; an
            // absent key (all-enabled template) passes null → create() omits it →
            // the seat keeps the living all-enabled default. PRIVILEGED intents are
            // STRIPPED here (Task 27): this is an AGENT-INITIATED mint, so a template
            // carrying `reboot` (a file path the spawner authored, or a saved
            // template) can't self-grant the capability — only an operator's local
            // GUI create/edit may. null passes through untouched.
            withoutPrivilegedIntentsFor(Array.isArray(tpl && tpl.intents) ? tpl.intents : null),
            sessionEnv, true,
          );
          if (tpl) {
            if (tpl.stripLevel === 1 || tpl.stripLevel === 2) getPersistence().setStripLevel(name, tpl.stripLevel);
            if (tpl.autoCompact === false) getPersistence().setAutoCompact(name, false);
          }
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd, backend: (this.sessions.get(name) || {}).backend || null,
          });
          this._broadcast('ipc-message', {
            type: 'spawn', from: spawner.name, to: name, body: `spawn → ${name} @ ${cwd}` + (tpl ? ` (template ${tplLabel})` : ''),
          });
          log.info('intent', `spawn by ${spawner.name} → ${name} (${type}) @ ${cwd}` + (tpl ? ` via template "${tplLabel}"` : ''));
          reply(`ok: spawned "${name}" (${type}) @ ${cwd}` + (tpl ? ` via template "${tplLabel}"` : '')
            + (envDropped.length ? ` — env keys not allowed, dropped: ${envDropped.join(', ')}` : ''));
        } catch (err) {
          log.error('intent', `spawn by ${spawner.name} → ${name} failed: ${err.message}`);
          reply(`error: ${err.message}`);
        }
      });
    }

    _roleInUse(team, roleKey) {
      const seats = new Set();
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        if (matchSeatRole(team, s.name) === roleKey) seats.add(s.name);
      }
      try {
        for (const e of getPersistence().list()) {
          if (e && e.name && matchSeatRole(team, e.name) === roleKey) seats.add(e.name);
        }
      } catch { seats.add('<persisted-seat check unavailable>'); }
      const tickets = [];
      try {
        const teamDir = path.dirname(team.file);
        for (const tk of ticketsStore.load(teamDir)) {
          if (tk && tk.assignee === roleKey && tk.state === 'open') tickets.push(tk.id);
        }
      } catch { tickets.push('<ticket check unavailable>'); }
      return { seats: [...seats], tickets };
    }

    _handleTeamReview(session, body) {
      const reply = (msg) => this._injectText(session, `[agent:team-review] ${msg}`, { parkable: true });
      const scope = String(body == null ? '' : body).trim();
      if (!scope) { reply('error: a review scope is required — [agent:team-review] <what to review>'); return; }

      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      if (!team) { reply('error: this session is not on a team (no team.json owns its cwd)'); return; }
      if (team.lead !== session.name) {
        reply(`error: only the team lead (${team.lead}) can request a review`);
        return;
      }
      const def = team.roles && team.roles.reviewer;
      if (!def) { reply(`error: team "${team.name}" has no "reviewer" role to spawn`); return; }

      const templateName = def.template || DEFAULT_REVIEWER_TEMPLATE;
      let reviewTpl = null;
      try { reviewTpl = getTemplates().list().find((t) => t && t.name === templateName) || null; }
      catch { reviewTpl = null; }
      const tplWarn = reviewTpl
        ? ''
        : ` — NOTE: reviewer template "${templateName}" not found in the library; spawned from built-in defaults (install it to customize)`;

      let reviewerSystemPrompt =
        (reviewTpl && typeof reviewTpl.systemPromptFile === 'string' && reviewTpl.systemPromptFile)
          ? reviewTpl.systemPromptFile
          : (def.prompt || REVIEWER_FALLBACK.systemPromptFile);
      // Defense-in-depth (T52 nit): the template is agent-writable and its
      // systemPromptFile flows into resolveSystemPromptFile → promptLibrary._file,
      // a bare path.join with no confinement — a stem like "../../../../etc/x"
      // escapes library/prompts/system. This is a PRE-EXISTING, non-escalating gap
      // (def.prompt already flowed through the same resolver, and a system prompt
      // only INSTRUCTS — it grants no tool/intent/env, all of which stay capped),
      // but since T52 makes the template the canonical prompt source, reject a
      // traversing/absolute stem HERE (not in the shared resolver — don't widen the
      // blast radius) and fall back to the shipped default with a loud warn.
      let promptEscapeWarn = '';
      if (reviewerSystemPrompt.includes('/') || reviewerSystemPrompt.includes('\\') || reviewerSystemPrompt.includes('..')) {
        promptEscapeWarn = ` — NOTE: reviewer systemPromptFile "${reviewerSystemPrompt}" contains a path separator or "..", which could escape library/prompts/system; ignored, using the built-in default "${REVIEWER_FALLBACK.systemPromptFile}"`;
        reviewerSystemPrompt = REVIEWER_FALLBACK.systemPromptFile;
      }

      const reviewerIntents = withoutPrivilegedIntentsFor(
        Array.isArray(reviewTpl && reviewTpl.intents) ? reviewTpl.intents : REVIEWER_FALLBACK.intents,
      );

      const rawReviewerEnv =
        (reviewTpl && reviewTpl.env && typeof reviewTpl.env === 'object' && !Array.isArray(reviewTpl.env))
          ? reviewTpl.env : REVIEWER_FALLBACK.env;
      const reviewerEnv = {};
      const droppedEnvKeys = [];
      for (const [k, v] of Object.entries(rawReviewerEnv)) {
        if (REVIEWER_ENV_ALLOWLIST.has(k)) reviewerEnv[k] = String(v == null ? '' : v);
        else droppedEnvKeys.push(k);
      }
      const envWarn = droppedEnvKeys.length
        ? ` — reviewer template env keys [${droppedEnvKeys.join(', ')}] are outside the allowed set [${[...REVIEWER_ENV_ALLOWLIST].join(', ')}] — dropped (env is an authority surface; requires operator approval)`
        : '';

      const wantSpawnerHintOff =
        ((reviewTpl && typeof reviewTpl.spawnerHint === 'string') ? reviewTpl.spawnerHint : REVIEWER_FALLBACK.spawnerHint) === 'off';

      // C2 (T29 Slice 2): the cold reviewer ALWAYS spawns as claude, regardless of
      // the manifest's `type`. team.json is agent-writable and enforcement is at
      // CONSUME, not at a write op (the C3 twin): only create()'s claude arm
      // consumes disabledTools (via setupClaudeHook), so a `type: codex` reviewer
      // would spawn UNCAPPED — codex ignores the denylist entirely, so the T29a
      // tools cap silently evaporates. Forcing claude here is the choke point that
      // makes the cap real however the manifest was written. (This supersedes the
      // old MF4 "refuse a codex reviewer that declares tools" bounce — force+notice
      // is strictly safer than refuse: it also catches the no-tools codex reviewer
      // that MF4 let through fully armed.) The requested type is kept only to warn.
      const requestedType = def.type || 'claude';
      const type = 'claude';
      const cwd = team.root;
      const typeWarn = requestedType !== 'claude'
        ? ` — NOTE: manifest requested reviewer type "${requestedType}", but cold reviewers always spawn as claude (a non-claude seat can't enforce the tools cap); ignoring`
        : '';
      const requestedTools = (Array.isArray(reviewTpl && reviewTpl.tools) && reviewTpl.tools.length)
        ? reviewTpl.tools
        : ((Array.isArray(def.tools) && def.tools.length) ? def.tools : null);
      const effectiveTools = requestedTools
        ? REVIEWER_TOOL_CAP.filter((t) => requestedTools.includes(t))
        : REVIEWER_TOOL_CAP.slice();
      const beyondCap = requestedTools
        ? requestedTools.filter((t) => !REVIEWER_TOOL_CAP.includes(t))
        : [];
      const disabledTools = CLAUDE_TOOLS.filter((t) => !effectiveTools.includes(t));
      const capWarn = beyondCap.length
        ? ` — requested [${beyondCap.join(', ')}] beyond the reviewer cap [${REVIEWER_TOOL_CAP.join(', ')}] — requires operator approval; spawned with [${effectiveTools.join(', ')}]`
        : '';

      let n = 1;
      let name;
      do { name = `${team.name}-reviewer-${n++}`; } while (this.sessions.has(name) || getPersistence().get(name));

      // MUST-FIX 1 (name-mint TOCTOU): a second [agent:team-review] in the SAME lead
      // turn runs its taken-name loop synchronously, BEFORE either deferred create()
      // has populated the sessions map — so both would mint -1 and collide. Reserve
      // the name SYNCHRONOUSLY here: the ephemeral+reviewFor seed IS the reservation,
      // so the second handler's getPersistence().get(name) sees it and bumps to -2.
      // This also carries the seat's identity fields (drives review-done's guard +
      // the team-retire discard disposition); create()'s own upsert spread-merges
      // over this stub, and the restart-preserve seam re-seeds it after a kill().
      getPersistence().upsert({ name, ephemeral: true, reviewFor: session.name });

      let promptWarn = '';
      if (reviewerSystemPrompt) {
        try {
          const promptFile = path.join(REGISTRY_DIR, 'library', 'prompts', 'system', `${reviewerSystemPrompt}.md`);
          if (!fs.existsSync(promptFile)) {
            promptWarn = ` — WARNING: role prompt "${reviewerSystemPrompt}.md" not found under library/prompts/system, so the reviewer boots UNBRIEFED (install it, then re-review)`;
          }
        } catch { /* preflight is best-effort — a stat error is not a spawn blocker */ }
      }

      const leadArgs = (getPersistence().get(session.name)?.extraArgs) || [];
      const postureArgs = leadArgs.includes('--dangerously-skip-permissions')
        ? ['--dangerously-skip-permissions'] : [];


      setImmediate(async () => {
        try {
          await this.create(
            name, type, cwd, postureArgs, null, session.workspaceId || DEFAULT_WORKSPACE_ID,
            null, false, session.proxy ?? null, [], [], disabledTools, [], [],
            reviewerSystemPrompt, [], [], reviewerIntents, reviewerEnv, true,
          );
          try {
            const hintBase = wantSpawnerHintOff ? resolveProxyBase(session.proxy ?? null, getUiSettings()) : null;
            const routeName = (this.sessions.get(name) || {}).proxyAgent || null;
            if (hintBase && routeName) {
              ProxyClient.spawnerHint(hintBase, routeName, { on: false })
                .catch((e) => log.warn('intent', `team-review spawner-hint(off) ${routeName} failed: ${e.message}`));
            }
          } catch (e) {
            log.warn('intent', `team-review spawner-hint(off) skipped: ${e.message}`);
          }
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd, backend: (this.sessions.get(name) || {}).backend || null,
          });
          this._deliverParkedActive(name, session.name, scope, 'dm');
          this._broadcast('ipc-message', {
            type: 'team-review', from: session.name, to: name, body: `review → ${name} @ ${cwd}`,
          });
          log.info('intent', `team-review by ${session.name} → ${name} (${type}) @ ${cwd}`);
          reply(`spawned ${name} — it'll report back with [agent:review-done]; watchdog it by name${capWarn}${envWarn}${typeWarn}${promptWarn}${promptEscapeWarn}${tplWarn}`);
        } catch (err) {
          if (!this.sessions.has(name)) getPersistence().remove(name);
          log.error('intent', `team-review by ${session.name} → ${name} failed: ${err.message}`);
          reply(`error: ${err.message}`);
        }
      });
    }

    _handleReviewDone(session, body) {
      const reply = (msg) => this._injectText(session, `[agent:review-done] ${msg}`, { parkable: true });
      const verdict = String(body == null ? '' : body).trim();
      if (!verdict) { reply('error: a verdict is required — [agent:review-done] <verdict>'); return; }

      const rec = getPersistence().get(session.name);
      if (!rec || !rec.ephemeral || !rec.reviewFor) {
        reply('error: review-done is only for an ephemeral reviewer seat spawned by [agent:team-review]');
        return;
      }
      const lead = rec.reviewFor;
      const r = this._gatedDeliver(lead, session.name, verdict, false);
      if (r && r.error) {
        reply(`error: ${r.error} — verdict NOT delivered, seat kept live; re-fire [agent:review-done] once ${lead} is reachable`);
        return;
      }
      this._broadcast('ipc-message', {
        type: 'review-done', from: session.name, to: lead, body: `verdict → ${lead}`,
      });
      log.info('intent', `review-done ${session.name} → ${lead}; retiring (discard)`);
      this._sendToSession(session.name, 'session:context-action', {
        action: 'retired', name: session.name, disposition: 'discard',
      });
      this.kill(session.name);
    }

    _handleTeam(session, intent) {
      const reply = (msg) => this._injectText(session, `[agent:team] ${msg}`, { parkable: true });
      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      if (!team) { reply('error: this session is not on a team (no team.json owns its cwd)'); return; }
      if (team.lead !== session.name) {
        reply(`error: only the team lead (${team.lead}) can edit team metadata`);
        return;
      }
      const name = intent.name || null;
      const BRIEF_MAX = 500;
      try {
        switch (intent.sub) {
          case 'role-add': {
            if (!name) { reply('error: role-add needs a role name — [agent:team role-add <name>] <brief>'); return; }
            const brief = String(intent.body == null ? '' : intent.body).trim();
            if (brief.length > BRIEF_MAX) { reply(`error: brief too long (${brief.length} > ${BRIEF_MAX} chars)`); return; }
            const def = {
              instantiate: 'session',
              prompt: intent.prompt || null,
              template: intent.template || null,
              brief: brief || null,
            };
            addRole(team.name, name, def);
            reply(`role "${name}" added to ${team.name}`);
            return;
          }
          case 'role-set': {
            if (!name) { reply('error: role-set needs a role name — [agent:team role-set <name>] <brief>'); return; }
            const brief = String(intent.body == null ? '' : intent.body).trim();
            if (brief.length > BRIEF_MAX) { reply(`error: brief too long (${brief.length} > ${BRIEF_MAX} chars)`); return; }
            const patch = {};
            if (brief) patch.brief = brief;
            if (intent.prompt) patch.prompt = intent.prompt;
            if (intent.template) patch.template = intent.template;
            setRole(team.name, name, patch);
            reply(`role "${name}" updated on ${team.name}`);
            return;
          }
          case 'role-rm': {
            if (!name) { reply('error: role-rm needs a role name — [agent:team role-rm <name>]'); return; }
            const used = this._roleInUse(team, name);
            if (used.seats.length || used.tickets.length) {
              const parts = [];
              if (used.seats.length) parts.push(`seat(s): ${used.seats.join(', ')}`);
              if (used.tickets.length) parts.push(`open ticket(s): ${used.tickets.join(', ')}`);
              reply(`error: role "${name}" is in use — ${parts.join('; ')}; reassign/retire them first`);
              return;
            }
            removeRole(team.name, name);
            reply(`role "${name}" removed from ${team.name}`);
            return;
          }
          case 'role-rename': {
            const from = intent.name || null;
            const to = intent.to || null;
            if (!from || !to) { reply('error: role-rename needs <from> <to> — [agent:team role-rename <from> <to>]'); return; }
            const used = this._roleInUse(team, from);
            if (used.seats.length || used.tickets.length) {
              const parts = [];
              if (used.seats.length) parts.push(`seat(s): ${used.seats.join(', ')}`);
              if (used.tickets.length) parts.push(`open ticket(s): ${used.tickets.join(', ')}`);
              reply(`error: role "${from}" is in use — ${parts.join('; ')}; reassign/retire them first`);
              return;
            }
            renameRole(team.name, from, to);
            reply(`role "${from}" renamed to "${to}" on ${team.name}`);
            return;
          }
          case 'watchdog': {
            if (intent.ms == null || !Number.isFinite(intent.ms)) {
              reply('error: watchdog needs a millisecond number — [agent:team watchdog <ms>]');
              return;
            }
            const m = setTeamWatchdog(team.name, intent.ms);
            const clamp = m.watchdogMs !== intent.ms ? ` (clamped from ${intent.ms})` : '';
            reply(`watchdog set to ${m.watchdogMs}ms on ${team.name}${clamp}`);
            return;
          }
          default:
            reply(`error: unknown team verb "${intent.sub}" — use role-add | role-set | role-rm | role-rename | watchdog`);
        }
      } catch (err) {
        reply(`error: ${err.message}`);
      }
    }


    _staleHostSuffix(now = Date.now(), seams = {}) {
      try {
        const dir = seams.dir || __dirname;
        const runRoot = seams.runRoot || path.join(REGISTRY_DIR, 'run');
        const notice = hostNotice(
          runRoot,
          dir,
          { pid: process.pid, startedAt: now - Math.round(process.uptime() * 1000), root: dir },
          { now },
        );
        return notice ? ` — NOTE: ${notice}` : '';
      } catch { return ''; } // instrumentation must never break the reply it rides on
    }

    _handleTask(session, intent) {
      let stale = '';
      try { stale = this._staleHostSuffix(); } catch { stale = ''; }
      const reply = (msg) => this._injectText(session, `[agent:task] ${msg}${stale}`, { parkable: true });
      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      if (!team) { reply('error: this session is not on a team (no team.json owns its cwd)'); return; }
      const teamDir = path.dirname(team.file);
      switch (intent.sub) {
        case 'add': this._taskAdd(session, team, teamDir, intent, reply); break;
        case 'assign': this._taskAssign(session, team, teamDir, intent, reply); break;
        case 'done': this._taskDone(session, team, teamDir, intent, reply); break;
        case 'reject': this._taskReject(session, team, teamDir, intent, reply); break;
        case 'cancel': this._taskCancel(session, team, teamDir, intent, reply); break;
        case 'list': this._taskList(session, team, teamDir, intent, reply); break;
      }
    }

    _resolveAssignee(team, who) {
      if (!who) return null;
      if (team.roles && Object.prototype.hasOwnProperty.call(team.roles, who)) return who; // role-addressed
      if (this._teamLiveSeatNames(team.root).includes(who)) return who; // name-addressed (live seat)
      return null;
    }

    _ticketAssigneeSeat(team, ticket) {
      const a = ticket && ticket.assignee;
      if (!a) return null;
      if (team.roles && Object.prototype.hasOwnProperty.call(team.roles, a)) {
        for (const name of this._teamLiveSeatNames(team.root)) {
          if (matchSeatRole(team, name) === a) return name;
        }
        return null;
      }
      return this._teamLiveSeatNames(team.root).includes(a) ? a : null;
    }

    _deliverTicketSpec(team, ticket, specText, fromName, urgent = false) {
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (!seat) return { undelivered: true };
      if (seat === team.lead) return { self: true }; // self-assign — the lead just wrote it
      const r = this._gatedDeliver(seat, fromName, `[ticket ${ticket.id}] ${specText}`, urgent);
      if (!r || r.error) return { undelivered: true };
      if (r.parked) return { parked: r.parked, reason: r.reason || null };
      if (r.held) return { held: true, reason: r.held };
      return { delivered: true };
    }

    _ticketDeliverySuffix(d, assignee) {
      if (d.undelivered) return ` — NOTE: no live seat for "${assignee}" yet; spec not delivered (reassign or wait for it to spawn)`;
      if (d.held) return ` — NOTE: spec NOT delivered (${d.reason || 'held'}); the seat cannot be parked for, so it has not seen the spec — re-send when it clears`;
      if (d.parked) return ` — NOTE: spec parked, not injected (${d.reason || 'held'}); it drains on the seat's next turn`;
      return '';
    }

    // Hand a seat its next open ticket when it closes one: the COMPLETION edge has no
    // other trigger, and a seat holding a queue otherwise goes idle until a human
    // pokes it. Order is FIFO by openedAt, ties broken by numeric id — array order is
    // not deterministic for two tickets minted in the same ms.
    // `closedId` is redundant on both current callers (each stamps its terminal state
    // and SAVES before calling, so the state filter already excludes it) — kept
    // because that is an ordering ACCIDENT, not a property of the helper: move the
    // advance above the save and without it the seat is handed back what it finished.
    _advanceSeat(team, teamDir, seatName, closedId) {
      const role = matchSeatRole(team, seatName);
      const open = ticketsStore.load(teamDir)
        .filter((t) => t.state === 'open' && t.id !== closedId && t.assignee != null
          && (t.assignee === seatName || (role && t.assignee === role)))
        .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0)
          || (Number(String(a.id).replace(/^t/, '')) || 0) - (Number(String(b.id).replace(/^t/, '')) || 0));
      const next = open[0];
      if (!next) return null;
      this._deliverTicketSpec(team, next, next.spec, 'clodex-team', true);
      log.info('intent', `seat ${seatName} advanced to ${next.id} after closing ${closedId}`);
      return next;
    }

    _taskAdd(session, team, teamDir, intent, reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can open a ticket`); return; }
      const spec = String(intent.body == null ? '' : intent.body).trim();
      if (!spec) { reply('error: a ticket needs spec text — [agent:task add [role|name]] <what to do>'); return; }
      let assignee = null;
      if (intent.who) {
        assignee = this._resolveAssignee(team, intent.who);
        if (!assignee) { reply(`error: "${intent.who}" is neither a team role nor a live seat on ${team.name}`); return; }
      }
      const tickets = ticketsStore.load(teamDir);
      const now = Date.now();
      const ticket = {
        id: nextTicketId(tickets), title: ticketTitle(spec), spec,
        assignee, opener: session.name, state: 'open',
        openedAt: now, closedAt: null, lastActivityAt: now, nudgedAt: null,
      };
      const taskDir = extractTaskDir(spec);
      if (taskDir) ticket.taskDir = taskDir;
      tickets.push(ticket);
      ticketsStore.save(teamDir, tickets);
      let suffix = '';
      if (assignee) {
        const d = this._deliverTicketSpec(team, ticket, spec, session.name, true);
        suffix = this._ticketDeliverySuffix(d, assignee);
      }
      this._reconcileTickets(team, teamDir);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: assignee || '(backlog)', body: `ticket ${ticket.id} opened` });
      log.info('intent', `task add by ${session.name} → ${ticket.id} (${assignee || 'backlog'})`);
      reply(assignee ? `ticket ${ticket.id} → ${assignee}${suffix}` : `ticket ${ticket.id} (backlog)`);
    }

    _taskAssign(session, team, teamDir, intent, reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can assign a ticket`); return; }
      if (!intent.id) { reply('error: assign needs a ticket id — [agent:task assign <id> <role|name>]'); return; }
      if (!intent.who) { reply('error: assign needs an assignee — [agent:task assign <id> <role|name>]'); return; }
      const tickets = ticketsStore.load(teamDir);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — cannot assign`); return; }
      const assignee = this._resolveAssignee(team, intent.who);
      if (!assignee) { reply(`error: "${intent.who}" is neither a team role nor a live seat on ${team.name}`); return; }
      const prev = ticket.assignee;
      const reassigning = prev != null && prev !== assignee;
      if (reassigning) {
        const oldSeat = this._ticketAssigneeSeat(team, { assignee: prev });
        if (oldSeat && oldSeat !== team.lead) {
          this._gatedDeliver(oldSeat, session.name, `[ticket ${ticket.id} reassigned] this ticket moved to ${assignee}`, false);
        }
      }
      ticket.assignee = assignee;
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null; // fresh assignment starts a new stall episode
      ticketsStore.save(teamDir, tickets);
      const d = this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true);
      const suffix = this._ticketDeliverySuffix(d, assignee);
      this._reconcileTickets(team, teamDir);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: assignee, body: `ticket ${ticket.id} assigned` });
      log.info('intent', `task assign by ${session.name}: ${ticket.id} ${prev || '(backlog)'} → ${assignee}`);
      reply(reassigning ? `ticket ${ticket.id}: ${prev} → ${assignee}${suffix}` : `ticket ${ticket.id} → ${assignee}${suffix}`);
    }

    _taskDone(session, team, teamDir, intent, reply) {
      if (!intent.id) { reply('error: done needs a ticket id — [agent:task done <id>] <report>'); return; }
      const report = String(intent.body == null ? '' : intent.body).trim();
      if (!report) { reply('error: done needs a report — [agent:task done <id>] <what you did>'); return; }
      const tickets = ticketsStore.load(teamDir);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open`); return; }
      const myRole = matchSeatRole(team, session.name);
      const isAssignee = ticket.assignee != null && (ticket.assignee === session.name || ticket.assignee === myRole);
      const isLead = team.lead === session.name;
      if (!isAssignee && !isLead) { reply(`error: only ticket ${intent.id}'s assignee (${ticket.assignee || 'unassigned'}) or the team lead (${team.lead}) can close it`); return; }
      const lead = team.lead;
      if (!isLead) {
        const r = this._gatedDeliver(lead, session.name, `[ticket ${ticket.id} done] ${report}`, false);
        if (r && r.error) { reply(`error: ${r.error} — report NOT delivered, ticket kept open; re-fire [agent:task done ${ticket.id}] once ${lead} is reachable`); return; }
      }
      ticket.state = 'done';
      ticket.closedAt = Date.now();
      ticket.closedBy = session.name;
      ticket.lastActivityAt = ticket.closedAt;
      ticketsStore.save(teamDir, tickets);
      this._reconcileTickets(team, teamDir);
      const doneSeat = this._ticketAssigneeSeat(team, ticket);
      const next = doneSeat ? this._advanceSeat(team, teamDir, doneSeat, ticket.id) : null;
      const nextSuffix = next ? ` — next: ${next.id} delivered to ${doneSeat}` : '';
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: lead, body: `ticket ${ticket.id} done` });
      log.info('intent', `task done ${ticket.id} by ${session.name} → ${lead}`);
      reply((isLead ? `ticket ${ticket.id} closed (done)` : `ticket ${ticket.id} closed (done) — report delivered to ${lead}`) + nextSuffix);
    }

    _taskReject(session, team, teamDir, intent, reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can reject a ticket`); return; }
      if (!intent.id) { reply('error: reject needs a ticket id — [agent:task reject <id>] <reason>'); return; }
      const reason = String(intent.body == null ? '' : intent.body).trim();
      if (!reason) { reply('error: reject needs a reason — [agent:task reject <id>] <what to fix>'); return; }
      const tickets = ticketsStore.load(teamDir);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'done') { reply(`error: reject reopens a DONE ticket; ${intent.id} is ${ticket.state}`); return; }
      ticket.state = 'open';
      ticket.closedAt = null;
      ticket.closedBy = null;          // cleared alongside closedAt — it is open again
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;
      ticketsStore.save(teamDir, tickets);
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (seat && seat !== team.lead) this._gatedDeliver(seat, session.name, `[ticket ${ticket.id} rejected] ${reason}`, true);
      this._reconcileTickets(team, teamDir);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} rejected` });
      log.info('intent', `task reject ${ticket.id} by ${session.name} → reopened`);
      reply(`ticket ${ticket.id} reopened (rework) → ${ticket.assignee || 'unassigned'}`);
    }

    _taskCancel(session, team, teamDir, intent, reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can cancel a ticket`); return; }
      if (!intent.id) { reply('error: cancel needs a ticket id — [agent:task cancel <id>] [reason]'); return; }
      const reason = String(intent.body == null ? '' : intent.body).trim();
      const tickets = ticketsStore.load(teamDir);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — cannot cancel`); return; }
      ticket.state = 'cancelled';
      ticket.closedAt = Date.now();
      ticket.closedBy = session.name;  // one shape across both close verbs
      ticket.lastActivityAt = ticket.closedAt;
      ticketsStore.save(teamDir, tickets);
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (reason && seat && seat !== team.lead) this._gatedDeliver(seat, session.name, `[ticket ${ticket.id} cancelled] ${reason}`, false);
      this._reconcileTickets(team, teamDir);
      const next = seat ? this._advanceSeat(team, teamDir, seat, ticket.id) : null;
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} cancelled` });
      log.info('intent', `task cancel ${ticket.id} by ${session.name}`);
      reply(`ticket ${ticket.id} cancelled${next ? ` — next: ${next.id} delivered to ${seat}` : ''}`);
    }

    // Default view is OPEN plus a capped recently-CLOSED section (done only) and a
    // tail that counts done and cancelled SEPARATELY — one number answers neither
    // "what did this team ship" nor "what did I drop". Recently-cancelled is
    // deliberately absent. The filter vocabulary is the real state set: reject sets
    // state back to 'open', so a `rejected` filter would always answer none.
    // NOTE: scripts/clodex-team.js doTickets is a SECOND implementation of this
    // listing and must stay behaviourally identical. It is not shared code on
    // purpose — that script is materialized out of the repo as a flat basename copy
    // into run/bin/ and may require node builtins ONLY, so a shared module would fail
    // to resolve at run time. Change both together.
    _taskList(session, team, teamDir, intent, reply) {
      const filter = intent.filter || 'open';
      if (!TICKET_FILTERS.includes(filter)) {
        reply(`error: unknown filter "${filter}" — use one of: ${TICKET_FILTERS.join(', ')}`);
        return;
      }
      const tickets = ticketsStore.load(teamDir).slice().sort((a, b) => {
        const na = Number(String(a.id).replace(/^t/, '')) || 0;
        const nb = Number(String(b.id).replace(/^t/, '')) || 0;
        return na - nb;
      });
      if (!tickets.length) { reply(`no tickets on ${team.name}`); return; }
      const shown = filter === 'all' ? tickets : tickets.filter((t) => t.state === filter);
      const now = Date.now();
      const row = (t) =>
        `${t.id} [${t.state}] ${t.assignee || '—'} ${humanizeAge(now - (t.openedAt || now))} — ${t.title || '(untitled)'}`;
      const closedRow = (t) =>
        `${t.id} [${t.state}] ${t.assignee || '—'} closed ${humanizeAge(now - t.closedAt)} ago — ${t.title || '(untitled)'}`;
      const lines = shown.map(row);
      const head = filter === 'open' ? `tickets on ${team.name}` : `tickets on ${team.name} [${filter}]`;
      const closed = filter === 'open' ? tickets.filter((t) => t.state !== 'open') : [];
      const doneAll = closed.filter((t) => t.state === 'done');
      const recentAll = doneAll
        .filter((t) => t.closedAt && now - t.closedAt < RECENT_DONE_MS)
        .sort((a, b) => b.closedAt - a.closedAt);
      const recent = recentAll.slice(0, RECENT_DONE_CAP);
      const over = recentAll.length - recent.length;
      const recentBlock = recent.length ? `\nrecently closed:\n${recent.map(closedRow).join('\n')}` : '';
      const cancelledAll = closed.filter((t) => t.state === 'cancelled');
      const tail = closed.length
        ? `\n(${over > 0 ? `+${over} more done in the last ${RECENT_DONE_LABEL}; ` : ''}${doneAll.length} done, ${cancelledAll.length} cancelled`
          + ' — [agent:task list done], [agent:task list cancelled] or [agent:task list all])'
        : '';
      if (!shown.length) {
        reply(closed.length
          ? `no open tickets on ${team.name}${recentBlock}${tail}`
          : `no ${filter} tickets on ${team.name}`);
        return;
      }
      reply(`${head}:\n${lines.join('\n')}${recentBlock}${tail}`);
    }

    _reconcileTickets(team, teamDir) {
      const tickets = ticketsStore.load(teamDir);
      for (const name of this._teamLiveSeatNames(team.root)) {
        const role = matchSeatRole(team, name);
        const open = tickets.find((t) => t.state === 'open' && t.assignee != null
          && (t.assignee === name || t.assignee === role));
        if (open) this._ticketWatch.set(name, { teamDir, role });
        else this._ticketWatch.delete(name);
        this._broadcast('session-ticket', { name, ticket: open ? open.id : null });
      }
    }

    _touchTicketActivity(name) {
      const w = this._ticketWatch.get(name);
      if (!w) return;
      const tickets = ticketsStore.load(w.teamDir);
      let changed = false;
      const now = Date.now();
      for (const t of tickets) {
        if (t.state !== 'open') continue;
        if (t.assignee === name || (w.role && t.assignee === w.role)) {
          t.lastActivityAt = now;
          if (t.nudgedAt) t.nudgedAt = null;
          changed = true;
        }
      }
      if (changed) ticketsStore.save(w.teamDir, tickets);
    }

    startTicketWatchdog(intervalMs = 60000) {
      if (this._ticketWatchdogTimer) return;
      this._ticketWatchdogTimer = setInterval(() => { try { this._sweepTickets(); } catch (e) { log.error('ticket', `watchdog sweep failed: ${e.message}`); } }, intervalMs);
      if (this._ticketWatchdogTimer.unref) this._ticketWatchdogTimer.unref();
    }

    _sweepTickets(now = Date.now()) {
      const seen = new Set();
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        let team; try { team = resolveTeam(s.cwd); } catch { team = null; }
        if (!team) continue;
        const teamDir = path.dirname(team.file);
        if (seen.has(teamDir)) continue;
        seen.add(teamDir);
        this._sweepTeamTickets(team, teamDir, now);
        this._reconcileTickets(team, teamDir); // self-heal the watch map + badges post-restart
      }
    }

    _sweepTeamTickets(team, teamDir, now) {
      const stallMs = (typeof team.watchdogMs === 'number' && team.watchdogMs > 0) ? team.watchdogMs : TICKET_STALL_MS;
      const tickets = ticketsStore.load(teamDir);
      let changed = false;
      for (const t of tickets) {
        if (t.state !== 'open' || t.assignee == null) continue; // backlog/closed exempt
        const last = t.lastActivityAt || t.openedAt || now;
        if (now - last < stallMs) continue;
        if (t.nudgedAt) continue; // one nudge per stall episode
        const r = this._gatedDeliver(team.lead, 'ticket-watchdog',
          `[ticket ${t.id}] stalled: ${t.assignee} quiet ${humanizeAge(now - last)}`, false);
        if (r && !r.error && !r.held) { t.nudgedAt = now; changed = true; }
      }
      if (changed) ticketsStore.save(teamDir, tickets);
    }

    static CONTEXT_COMMANDS = {
      claude: { compact: '/compact', clear: '/clear' },
      codex: { compact: '/compact', clear: '/clear' },
    };

    _handleContextIntent(session, sub, body = '') {
      if (sub === 'reload') {
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
            this._preserveAcrossRestart(name, entry, ['createdAt']);
            await this.create(
              name, entry.type, entry.cwd, entry.extraArgs || [], null, entry.workspaceId,
              entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
              entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
              entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
              Array.isArray(entry.execCommands) ? entry.execCommands : [],
              Array.isArray(entry.intents) ? entry.intents : null,
            );
            const lvl = stripLevelOf(entry);
            if (lvl >= 1) getPersistence().setStripLevel(name, lvl);
            if (entry.label) getPersistence().setLabel(name, entry.label);
            this._sendToSession(name, 'session:context-action', {
              action: 'reattach', name, type: entry.type, cwd: entry.cwd, backend: (this.sessions.get(name) || {}).backend || null,
            });
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
        this._injectText(session,
          `[agent:context] unknown or unsupported sub-command "${sub}" for a ${session.type} session (use compact|clear|reload)`,
          { parkable: true });
        return;
      }
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
        if (session.intentSource === 'wire') {
          session._compactPending = { cmd, continuation: cont };
          this._armCompactValve(session);
          log.info('intent', `compact ${session.name} → latched (fires at next terminal stop, queue empty)`);
          this._broadcast('ipc-message', {
            type: 'context', from: session.name, to: session.name, body: 'context compact → latched',
          });
          return;
        }
        this._executeCompact(session, cmd, cont);
        return;
      }
      if (sub === 'clear' && session._postClearContinuation) {
        this._broadcast('ipc-message', {
          type: 'context', from: session.name, to: session.name,
          body: 'context clear → dropped (already in flight)',
        });
        log.warn('intent', `clear ${session.name} dropped — already in flight`);
        return;
      }
      // Non-compact context command (clear): inject immediately — no guard, no
      // latch. bypassHold: the intent often lands before the sender's own idle
      // event, and a queued bare slash command must never '\n'-join into a flush
      // batch (the command line would swallow the rest as garbage).
      this._injectText(session, cmd, { bypassHold: true });
      // The body is optional and only stored here — a bare clear stays exactly
      // what it was. Storing BEFORE the edge can fire is not a race worth
      // guarding: _injectText is asynchronous and the watcher polls the symlink
      // at 250ms, but the store is synchronous with the intent.
      const cont = sub === 'clear' && body ? body.trim() : '';
      if (cont) {
        session._postClearContinuation = cont;
        this._armPostClearValve(session);
      }
      log.info('intent', `${sub} ${session.name} → ${cmd}${cont ? ' (+continuation)' : ''}`);
      this._broadcast('ipc-message', {
        type: 'context', from: session.name, to: session.name, body: `context ${sub} → ${cmd}`,
      });
    }

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

    _setRelayRoster(via, roster) {
      if (!via) return;
      this._relayRosters.set(via, { roster: Array.isArray(roster) ? roster : [], at: Date.now() });
    }

    _relayRosterEntries() {
      const now = Date.now();
      const out = [];
      for (const [via, rec] of this._relayRosters) {
        if (now - rec.at > RELAY_ROSTER_TTL_MS) { this._relayRosters.delete(via); continue; }
        for (const e of rec.roster) out.push({ name: e.name, origin: e.origin, via, type: e.type });
      }
      return out;
    }

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
      const peers = getPeerManager() ? getPeerManager().statuses() : [];
      const match = peers.find((p) => p.label && p.label.toLowerCase() === origin.toLowerCase());
      if (match) {
        if (!match.online) { bounce(`peer '${origin}' is offline — try again when it's awake.`); return; }
        if (!(match.caps || []).includes('dm')) { bounce(`peer '${origin}' predates dm federation — update its Clodex.`); return; }
        const conn = getPeerManager().get(match.id);
        if (!conn) { bounce(`peer '${origin}' is not reachable right now.`); return; }
        conn.dm({ to: name, from: senderName, body: intent.body, urgent: intent.urgent === true }, (resp) => {
          if (resp && resp.ok && resp.delivered) {
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
      if (this._knownDmOrigins.has(origin) || outboxHasOrigin(OUTBOX_DIR, origin)) {
        const r = enqueueOutbox(OUTBOX_DIR, origin,
          { from: senderName, to: name, body: intent.body, urgent: intent.urgent === true, ts: Date.now() },
          this._nextParkSeq());
        if (!r.ok) { bounce(`could not queue for ${intent.target}: ${r.error}`); return; }
        if (getRemoteServer()) { try { getRemoteServer().notifyDmMail(origin); } catch {} }
        this._broadcast('ipc-message', { type: 'dm', from: senderName, to: `${name}@${origin}`, body: `WIRE→${origin} (outbox): ${intent.body}` });
        return;
      }
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
      bounce(`no route to '${intent.target}' — peer '${origin}' is not configured, has never contacted this box, and no hub advertises it.`);
    }

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

    _relayClaimedDm(srcId, srcLabel, srcCfg, m) {
      const drop = (why) => {
        log.info('peer', `relay from ${srcLabel} → ${m.finalTarget} dropped: ${why}`);
        this._broadcast('ipc-message', { type: 'dm', from: m.from || srcLabel, to: m.finalTarget, body: `WIRE relay DROPPED (${why}): ${m.body || ''}` });
      };
      if (!relayVersionOk(m.rv)) return drop('unsupported relay version');
      const hop = hopRule(m.hops);
      if (!hop.relay) return drop('hop budget exhausted');
      const at = String(m.finalTarget || '').indexOf('@');
      if (at <= 0) return drop('malformed finalTarget');
      const destName = m.finalTarget.slice(0, at);
      const destOrigin = m.finalTarget.slice(at + 1);
      const peers = getUiSettings().get().peers || [];
      const destCfg = peers.find((p) => p && (p.label || '').toLowerCase() === destOrigin.toLowerCase());
      const srcAllowed = !!(srcCfg && srcCfg.relayAllowed);
      const destAllowed = !!(destCfg && destCfg.relayAllowed);
      if (!srcAllowed || !destAllowed) {
        this._bounceRelaySender(srcId, m, `relay to ${m.finalTarget} not permitted (peer not relay-enabled)`);
        return drop('relay not permitted (relayAllowed gate)');
      }
      const dest = (getPeerManager() ? getPeerManager().statuses() : [])
        .find((st) => st.label && st.label.toLowerCase() === destOrigin.toLowerCase());
      if (!dest || !dest.online) return drop(`destination peer '${destOrigin}' offline`);
      if (!(dest.caps || []).includes('dm')) return drop(`destination peer '${destOrigin}' predates dm federation`);
      const conn = getPeerManager().get(dest.id);
      if (!conn) return drop(`destination peer '${destOrigin}' not reachable`);
      const fromAt = String(m.from || '').indexOf('@');
      const senderLocal = fromAt > 0 ? String(m.from).slice(0, fromAt) : String(m.from || '');
      const relayFrom = `${senderLocal || 'peer'}@${srcLabel}`;
      conn.dm(buildTerminalDm({ to: destName, from: relayFrom, body: m.body || '', urgent: m.urgent === true }), (resp) => {
        if (!(resp && resp.ok)) log.info('peer', `relay → ${m.finalTarget} not delivered: ${(resp && resp.error) || 'no response'}`);
      });
      this._broadcast('ipc-message', { type: 'dm', from: relayFrom, to: m.finalTarget, body: `WIRE relay ${srcLabel}→${destOrigin}: ${m.body || ''}` });
    }

    _bounceRelaySender(srcId, m, why) {
      const conn = getPeerManager() ? getPeerManager().get(srcId) : null;
      if (!conn) return;
      const from = String(m.from || '');
      const at = from.indexOf('@');
      const senderLocal = at > 0 ? from.slice(0, at) : from;
      if (!senderLocal) return;
      try { conn.dm({ to: senderLocal, from: 'relay', body: `NOT delivered to ${m.finalTarget}: ${why}.`, urgent: false }, () => {}); } catch {}
    }

    _isDmReachable(senderName) {
      if (!senderName) return false;
      const at = senderName.lastIndexOf('@');
      if (at > 0) {
        const origin = senderName.slice(at + 1);
        const peers = getPeerManager() ? getPeerManager().statuses() : [];
        if (peers.some((p) => p.online && p.label && p.label.toLowerCase() === origin.toLowerCase())) return true;
        return this._relayViaForOrigin(origin) != null;
      }
      const s = this.sessions.get(senderName);
      return !!(s && s.agentType && !s._dead);
    }

    _buildDeliveryText(target, senderName, body, mtype) {
      const prefix = `[agent:from ${senderName}]`;

      // The reply nudge is parenthesized and never at column 1, so IntentScanner
      // (which fires only on a cleaned line STARTING with [agent:) cannot mistake it
      // for a real intent. Emitted only when the path it advertises exists on BOTH
      // ends: the receiver's `dm` intent is enabled AND the sender is dm-reachable
      // right now — otherwise it teaches a reply address that silently drops.
      const trailer = (mtype === 'dm'
          && intentEnabled('dm', getPersistence().get(target.name)?.intents)
          && this._isDmReachable(senderName))
        ? `(reply: start a line with [agent:dm ${senderName}], close the body with a bare [agent:end] line)`
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
      if (!this._maybeParkDelivery(target, finalText)) {
        this._injectText(target, finalText, { parkable: true });
      }
      this._sendToSession(targetName, 'session-mention', targetName, mtype, senderName);
    }

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
      const finalText = this._buildDeliveryText({ name: agent, agentType: entry.type }, 'reminder', body, 'dm');
      try {
        parkDelivery(PENDING_DIR, agent, finalText, this._nextParkSeq(), null, false, this._bornFor(agent));
        log.info('intent', `remind fire for ${agent} parked (offline) — drains on resume`);
        return 'parked';
      } catch (e) {
        log.error('intent', `remind park for ${agent} failed: ${e.message}`);
        return 'error';
      }
    }

    _nextParkSeq() {
      return `${Date.now()}.${String(this._parkSeq = (this._parkSeq || 0) + 1).padStart(9, '0')}`;
    }

    // The generation stamp for `name`: live session first, PERSISTENCE second — an
    // offline-but-resumable park (the reboot notice, a reminder firing at a name with
    // no process) has no session object, and the persisted createdAt is the same
    // value create() will hand that seat on restore, which is what makes the stamps
    // match on arrival. null means "no expectation" at both ends — deliver, never drop.
    _bornFor(name) {
      const s = this.sessions.get(name);
      if (s && typeof s.createdAt === 'number') return s.createdAt;
      try {
        const e = getPersistence().get(name);
        if (e && typeof e.createdAt === 'number') return e.createdAt;
      } catch {}
      return null;
    }

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
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), id, false, this._bornFor(target.name));
      } catch (e) {
        log.error('inject', `park-on-hold failed for ${target.name}: ${e.message}`);
        return null;
      }
      return id;
    }

    _maybeParkDelivery(target, finalText) {
      if (!target || target.agentType !== 'claude' || target._dead) return false;
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
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), null, false, this._bornFor(target.name));
      } catch (e) {
        log.error('inject', `park failed for ${target.name}: ${e.message} — injecting instead`);
        return false;
      }
      this._armParkCap(target);
      return true;
    }

    _armParkCap(target) {
      if (target._parkCapTimer) return;         // earliest-parked deadline governs
      target._parkCapTimer = setTimeout(() => {
        target._parkCapTimer = null;
        this._flushParkedNow(target, `cap.${process.pid}`, 'park-cap');
      }, INJECT_QUIET_MAXWAIT);
    }

    _flushParkedNow(target, tag, kind = 'park-flush') {
      if (target._dead) return { ok: true, count: 0 };
      let texts = [];
      try { texts = drainPending(PENDING_DIR, target.name, tag, this._bornFor(target.name)); } catch {}
      if (!texts.length) return { ok: true, count: 0 };  // another drainer won the claim
      const plural = texts.length === 1 ? 'y' : 'ies';
      const body = kind === 'park-cap'
        ? `park cap fired (${INJECT_QUIET_MAXWAIT / 1000}s, no submit) — injecting ${texts.length} parked deliver${plural}`
        : `flushed ${texts.length} parked deliver${plural} (operator)`;
      log.warn('inject', `${kind} for ${target.name} — draining ${texts.length} parked deliver${plural} via queue`);
      this._broadcast('ipc-message', { ts: Date.now(), from: 'clodex', to: target.name, kind, body });
      // ONE injection for the whole drain, not N. N sequential _injectText calls
      // raced: #1's Enter starts a CLI turn and #2 landed in the turn-start churn
      // where its Enter got swallowed → stranded draft. A forced flush is non-
      // parkable (resend-recursion fix), so a stranded text just sits. Join into a
      // single body with the SAME blank-line separator the out-of-process hook
      // drain uses (cli-hooks.js: texts.join('\\n\\n')), so a seat sees the same
      // combined shape whichever drainer won. drainPending returns park order.
      this._injectText(target, texts.join('\n\n'));
      return { ok: true, count: texts.length };
    }

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
      if (!opts.bypassHold && this._injectHoldReason(session)) {
        (session._injectQueue = session._injectQueue || []).push(text);
        this._armInjectValve(session);
        return;
      }
      // parkable is OPT-IN, not opt-out: a missed tag falls back to inject-through (a
      // possible splice, no worse than before), whereas parking a CLI-driving
      // self-intent (compact/reload continuation, a slash command) would stall the
      // agent. The divert re-checks for an open draft at write time, inside the
      // queue's critical section.
      const divert = opts.parkable ? this._parkDivertFor(session, opts.parkId || null) : null;
      this._injectQueueFor(session).enqueue(text, divert ? { divert } : undefined);
    }

    _parkDivertFor(session, id = null) {
      if (!session || session.agentType !== 'claude') return null;
      return (text) => {
        if (session._dead || !isDraftOpen(session)) return false;
        try {
          parkDelivery(PENDING_DIR, session.name, text, this._nextParkSeq(), id, false, this._bornFor(session.name));
        } catch (e) {
          log.error('inject', `fire-time park failed for ${session.name}: ${e.message} — injecting instead`);
          return false;
        }
        this._armParkCap(session);
        log.info('inject', `diverted to park: draft open (${session.name})`);
        return true;
      };
    }

    _injectQueueFor(session) {
      if (!session._injectPtyQueue) {
        // Boot-readiness gate (T35): the first inject into a freshly spawned
        // claude seat races CLI boot — text+Enter written before the raw-mode
        // input loop is up read as one paste-like chunk and the Enter lands as
        // content, so the message never submits. Gate claude agent seats on the
        // latched mode-2004 edge (_bootReadySeen), capped by INJECT_BOOT_MAXWAIT.
        // Bash/codex pass through (default ready ⇒ true): codex has its own
        // boot-settle machinery and must not be coupled to this.
        const isClaude = session.agentType === 'claude';
        session._injectPtyQueue = new InjectQueue({
          write: (bytes) => { try { session.pty.write(bytes); } catch {} },
          settleMsFor: (t) => (t.length > LONG_TEXT_THRESHOLD ? LONG_TEXT_DELAY : SHORT_TEXT_DELAY),
          quietMs: INJECT_QUIET_MS,
          maxWaitMs: INJECT_QUIET_MAXWAIT,
          lastHumanInputAt: () => session.lastUserInputTs || 0,
          isDead: () => !!session._dead,
          bracketedPaste: () => !!session._pasteModeOn,
          ready: isClaude ? () => !!session._bootReadySeen : undefined,
          readyMaxWaitMs: INJECT_BOOT_MAXWAIT,
          onReadyCapFire: isClaude ? () => {
            log.warn('inject', `boot-readiness cap fired for ${session.name} — injected before mode-2004 seen (${INJECT_BOOT_MAXWAIT / 1000}s cap)`);
          } : null,
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


    _onIncoming(targetName, msg) {
      const sender = msg.from || '?';
      const body = msg.body || '';
      const mtype = msg.type || 'dm';
      if (msg.delivery === 'passive') {
        this._deliverPassive(targetName, sender, body, mtype);
        return;
      }
      if (mtype === 'team-retire') {
        this._handleTeamRetire(targetName, sender);
        return;
      }
      this._deliverMessage(targetName, sender, body, mtype);
    }

    _handleTeamRetire(targetName, requesterName) {
      const fail = (why) => {
        log.warn('intent', `team-retire ${requesterName} → ${targetName} refused: ${why}`);
        this._deliverMessage(requesterName, 'clodex-team', `retire ${targetName} refused: ${why}`, 'dm');
      };
      const target = this.sessions.get(targetName);
      const requester = this.sessions.get(requesterName);
      if (!target) return; // socket outlived the session; nothing to retire
      if (!requester) { fail(`requester "${requesterName}" is not a running session`); return; }
      if (targetName === requesterName) { fail('self-retire is not allowed'); return; }
      const targetRoot = findProjectRoot(target.cwd);
      const requesterRoot = findProjectRoot(requester.cwd);
      if (!requesterRoot || requesterRoot !== targetRoot) {
        fail(`"${requesterName}" and "${targetName}" are not in the same project (no shared team.json root)`);
        return;
      }
      let discard = false;
      try {
        const team = resolveTeam(target.cwd);
        if (team) {
          const role = matchSeatRole(team, targetName);
          const def = role ? team.roles[role] : null;
          discard = !def || def.ephemeral === true;
        }
      } catch { discard = false; }
      const disposition = discard ? 'discard' : 'archive';
      this._sendToSession(targetName, 'session:context-action', { action: 'retired', name: targetName, disposition });
      this._broadcast('ipc-message', {
        ts: Date.now(), from: requesterName, to: targetName, kind: 'retire',
        body: `retire → ${targetName} (${disposition}, project ${targetRoot})`,
      });
      log.info('intent', `team-retire ${requesterName} → ${targetName} (${disposition}, project ${targetRoot})`);
      const teardown = discard ? this.kill(targetName) : this.archive(targetName);
      const confirm = discard
        ? `retired ${targetName} (discarded — state lives in its task artifact)`
        : `retired ${targetName} (resumable from the sidebar or on next project open)`;
      teardown.then(() => {
        this._deliverPassive(requesterName, 'clodex-team', confirm, 'dm');
      }).catch((err) => fail(err.message));
    }

    _deliverPassive(targetName, senderName, body, mtype) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      if (target.agentType !== 'claude' || target._dead) {
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      const finalText = this._buildDeliveryText(target, senderName, body, mtype);
      try {
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), null, true, this._bornFor(target.name));
      } catch (e) {
        log.error('inject', `passive park failed for ${target.name}: ${e.message} — delivering normally`);
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      this._broadcast('ipc-message', {
        ts: Date.now(), from: senderName, to: targetName, kind: 'passive',
        body: body.length > 200 ? `${body.slice(0, 200)}…` : body,
      });
    }

    // Active-class PARK (T54): parked like passive (NO spawn-time PTY write, so
    // the T40/T42 boot-race stays fixed — an early mode-2004 proxy can't strand
    // the text as a Ctrl-U-wiped draft), but TURN-EARNING — a NON-.passive.json
    // entry, so hasActivePending() sees it and the boot-ready rising edge (or any
    // idle edge) drains it. Passive parks never earn a turn by design; a fresh
    // reviewer seat has no other traffic, so passive stalled the scope until a
    // human ✉-click. Used ONLY for the team-review scope — roster/team deltas
    // stay _deliverPassive (genuinely ride-along). Claude-only (pending is a
    // Claude-hook store); park failure falls back to a normal delivery (degraded
    // to noisy beats dropped), same as passive.
    _deliverParkedActive(targetName, senderName, body, mtype) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      if (target.agentType !== 'claude' || target._dead) {
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      const finalText = this._buildDeliveryText(target, senderName, body, mtype);
      try {
        parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), null, false, this._bornFor(target.name));
      } catch (e) {
        log.error('inject', `active park failed for ${target.name}: ${e.message} — delivering normally`);
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      this._broadcast('ipc-message', {
        ts: Date.now(), from: senderName, to: targetName, kind: 'parked',
        body: body.length > 200 ? `${body.slice(0, 200)}…` : body,
      });
    }
  }

  return SessionManager;
}

module.exports = { createSessionManager, isStaleRegistration, missingToolOnExit, nameConflict, preseedClaudeOnboarding };
