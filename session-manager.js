// session-manager.js — the SessionManager class: PTY spawn/kill/restore,
// per-session state, intent routing, DM delivery and parking, inject queue.
//
// ─── WINDOW BRIDGE / opaque-handle contract ─────────────────────────────────
//
// A handle is an OPAQUE OBJECT. Everything here touches exactly five methods:
//
//   .webContents.send(channel, ...args)   _sendToSession, _broadcast, file-view
//   .isDestroyed()                        windowForWorkspace, allLiveWindows
//   .isFocused()                          the notify/attention focus gate
//   .show() / .focus()                    the [agent:file view] path only
//
// …plus reference identity: `workspaceForWindow()` compares handles with `===`,
// so a handle must be the same object at register time and at lookup time.
//
// The contract is this small on purpose, because it already has two
// implementations: real Electron BrowserWindows (`main.js`) and plain objects
// backed by a WebSocket connection (`web-host.js`, `handleFor`, a five-key
// literal). `headless-main.js` runs this engine in a process with no electron
// in it at all.
//
// So do not `require('electron')` here, and do not reach into a handle for
// anything outside that list — no `BrowserWindow.fromWebContents`, no
// `instanceof`, no geometry, no `webContents` member other than `.send`. Every
// one of those works under Electron and is undefined under the web host, so it
// fails only at runtime and only for browser clients. Widening the contract
// means widening `handleFor` to match, in the same change.

const NOTIFY_USER_MAX_BYTES = 16 * 1024;

const REBOOT_MIN_INTERVAL = 5 * 60 * 1000;

const REBOOT_NOTICE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Retry-with-a-ceiling, NOT confirmed delivery — the distinction is the whole
// reason this exists. Nothing in the stack acknowledges an injected message:
// InjectQueue ends at a fire-and-forget pty.write, so "the notice was parked"
// and "the notice arrived" are not the same claim and no layer here can tell
// them apart. So the notice is re-offered a bounded number of times and then
// given up on, deliberately.
//
// The delays are measured, not round: a resumed seat produced nothing for 105s
// while a 41MB transcript re-rendered, and both existing margins
// (BOOT_DRAIN_SETTLE_MS 750ms, INJECT_BOOT_MAXWAIT 20s) sit far inside that.
// So the first retry clears the boot cap and the second clears the observed
// re-render.
const REBOOT_NOTICE_RETRY_DELAYS = [30 * 1000, 120 * 1000];
const REBOOT_NOTICE_MAX_ATTEMPTS = 3;

// The notice's OWN deadline for a forced flush, separate from the generic park
// cap (INJECT_QUIET_MAXWAIT, 5 min) it would otherwise inherit. A wake-up notice
// that arrives five minutes after the wake is not a wake-up notice.
//
// Derived, and both bounds are load-bearing:
//   > INJECT_BOOT_MAXWAIT (20s) — past the queue's readiness cap a polite drain
//     either already happened or is not going to, so this cannot pre-empt one.
//   < REBOOT_NOTICE_RETRY_DELAYS[0] (30s) — firing after the first re-park would
//     flush TWO copies of the notice joined into one body. This bound holds for
//     the FIRST, undeferred round only: a draft deferral re-arms past 30s, so a
//     later round can join the ladder's re-park. Accepted, not overlooked — it
//     costs one duplicated line, and a duplicate is the safe direction. Do not
//     "fix" it by bounding the re-arm; see _armRebootNoticeFlush.
//
// This deadline does NOT make the retry ladder redundant, and the ladder must not
// be simplified away now that it exists. The queue's readiness gate writes anyway
// once INJECT_BOOT_MAXWAIT elapses, so on a slow seat — a measured 105s
// transcript re-render — a flush at 25s can still evaporate into a booting CLI.
// That is recoverable only because the ladder is there: the notice survives in
// settings, the re-park follows, and the T+150s rung lands after the render.
const REBOOT_NOTICE_FLUSH_MS = 25 * 1000;

// How long after setting the voice mode the CLI may still be acting on the old
// one, so a tap arriving inside this window must wait it out like the tap that
// set it. The measurement, the observable and why the number is what it is live
// with the wait itself — VOICE_TAP_MODE_SETTLE_MS in
// renderer/voice-submit-watcher.js — and this must not drift from it: this side
// decides who waits, that side performs the wait, and a shorter value here
// silently stops arming the wait it is naming. Pinned equal in
// test/external-tap-trigger.test.js.
const VOICE_MODE_SETTLE_MS = 1500;

// How long the pane must have been untouched before the forced flush is allowed
// to fire. Comfortably longer than INJECT_QUIET_MS (2s), which is tuned to not
// cut mid-WORD: this one has to clear a pause mid-COMPOSITION, and stopping to
// think for a couple of seconds is ordinary.
const REBOOT_NOTICE_DRAFT_STALE_MS = 10 * 1000;

// Defaults folded into the BASE of the env-scope merge, so every scope
// (global/workspace/session/override) still beats them. They must NOT move to
// the app-owned block applied after the merge (env-scopes.js) — those win by
// design, and a default that overrides the operator's own setting is a worse
// bug than the one it fixes.
//
// CLAUDE_STREAM_IDLE_TIMEOUT_MS is a FLOOR in the CLI, not a default:
// max(env||0, 300000), clamped to [1, 1800000] — so it can only raise the
// stall threshold, and 1800000 is the highest expressible value. The cost of
// setting it at all: the CLI then skips its tengu_byte_stream_idle_timeout_ms
// remote-config lookup, which makes us immune to a silent server-side
// tightening and equally locked out of a silent server-side fix. It must be
// baked here rather than documented as an operator export:
// claude-env.js's startup scrub deletes every inherited CLAUDE_* key that is
// not a SCRUB_SURVIVOR, so a shell export of this one never reaches a seat.
const BASE_ENV_DEFAULTS = { CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000' };

const { readEffectiveClaudeEnv, teeBlindBackend } = require('./claude-env');
const { mergeSessionEnv, sanitizeFlat } = require('./env-scopes');
const { pasteModeSignal, strictMcpReason, STRICT_MCP_EXPLANATION, PROXY_AGENT_PREFIX } = require('./proxy-util');
const {
  RELAY_ROSTER_TTL_MS, RELAY_MAX_HOPS,
  buildRelayEnvelope, buildTerminalDm, isRelayEnvelope, hopRule, relayVersionOk,
} = require('./relay-protocol');
const { formatTeamBlock, matchSeatRole, formatRoster, formatCompositionDelta } = require('./team-manifest');
// Sender labels the MANAGER writes on system-originated deliveries; no agent is
// on the other end of any of them. They must never collect the "(reply: …)"
// trailer, and reachability is the wrong test for that: session names are a
// global namespace, so an unrelated seat that happens to be called `team` makes
// `team` look answerable and every seat on the box gets told to reply to it.
// Keep in sync with the senderName literals at the _deliver* call sites.
const SYSTEM_SENDERS = new Set(['team', 'clodex-team', 'reminder', 'memory', 'reboot', 'clodex']);

const { createTicketsStore, ticketTerminalReason } = require('./tickets-store');
const { findRepoRoot } = require('./project-root');
const { atomicWriteFileSync } = require('./fs-util');
const { previewLine } = require('./body-preview');
const { createMemoryLoad } = require('./memory-load');
const { foldDraft } = require('./hint-arm');
const { didGrow } = require('./stall-evidence');
const { seatHasPlugin } = require('./plugin-api');
// ticketCloseLine and ticketTaskDirLine are re-exported below rather than used
// here: they moved with the spec-delivery verbs, and tests import them from this
// module's path. Removing the re-export as unused breaks those importers.
const { createTicketMethods, ticketCloseLine, ticketTaskDirLine } = require('./team-tickets');

// Process-life identity for a spawned session (ticket replay). Module-level and
// NOT a deps seam: every value this is compared against was minted by the same
// build, so an injectable generator could only ever be stubbed into agreeing with
// itself. The pid is what makes it unique across app processes — the property the
// whole replay condition rests on.
let incarnationSeq = 0;
function nextIncarnation() {
  return `${process.pid}.${Date.now().toString(36)}.${++incarnationSeq}`;
}

// First claude spawn on a fresh box (deployed node, sandbox container) hits
// the CLI's interactive onboarding wizard — theme picker etc. — inside a PTY
// nobody on a headless node is watching. Pre-seed the global ~/.claude.json
// so sessions start ready. Merge-only: a file that already completed
// onboarding is left byte-untouched, unparseable JSON is never clobbered, and
// any failure degrades to the wizard (never blocks a spawn). Credentials are
// NOT touched here — the token rides the service env
// (deploy --claude-token-file).
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
// Names the correct form and stops there. It must never reconstruct and run
// what the line probably meant: that would execute something nobody wrote,
// which is worse than the bounce it replaces — the same rule the control-char
// vetting already follows. Reveals nothing gated either, since the bounce lists
// `term` for every seat whether or not it holds the grant.
function nearMissFormHint(text) {
  if (!/^\[agent:term[\s\]]/.test(String(text || ''))) return '';
  return 'The term intent takes its command AFTER the closing bracket — `[agent:term exec] <command>`, not inside it. ';
}

// Fields _preserveAcrossRestart carries whether or not a caller asks. The test
// for membership is that NO caller can regrow the field: append-only history
// (sessionIds) and operator decisions no spawn argument carries (pluginGrants —
// not a create() parameter, so create's rebuild upsert writes a record without
// it) — AND that no caller re-asserts it after create(). That second clause is
// what keeps `label`/`stripLevel` out: no caller can regrow them either, but
// all three call sites deliberately re-assert them post-create, so moving them
// here would make two writers for one field.
// A field a restart can legitimately reset (rosterSentAt on a fresh
// restart) must stay caller-controlled.
// `wireLabel` is here for the same reason: it is seeded ONLY at the team-spawn
// mint, nothing regrows it, and create() re-mints the proxy agent id from
// `entry.wireLabel || name`. Dropped by an in-place restart, the seat's whole
// remaining spend bills to an unlabeled route and its ticket's COST.json reads
// a null label — the ticket looks free because the money went somewhere else.
// `keepWarmAlways`/`holdUntil` pass both clauses too — written only by
// setKeepWarmAlways/setHoldUntil off an operator action, absent from create()'s
// argument list and its rebuild upsert, re-asserted by no caller. They must
// move as a PAIR: ipc-handlers' wire:hold writes each by clearing the other, so
// preserving one alone resurrects a seat holding both, and rearmPlan reads
// `always` first — a stale `keepWarmAlways` would outrank the deadline the
// operator actually set. Losing them is silent and unbounded: the perpetual
// hold is the one mode whose seat nobody is sitting at, so no turn arrives to
// notice the flag is gone and _maybeRearmHold never runs against anything.
// `worktree` is here because ABSENT is the DANGEROUS state and stale is the safe
// one — the reverse of the usual intuition about a preserved pointer. destroy()
// reads `entry.worktree.path` to find the tree; with no pointer it takes the
// `if (!worktree)` arm, drops the record and returns ok, leaving the checkout
// with nothing in the APP naming it — the delete path can no longer find it and
// reports success. A pointer to a tree that is already gone instead fails
// removeWorktree, which KEEPS the record and rides the path out for the operator.
// _ticketTreeHolder reads occupancy off the record too, so a reloaded seat
// without it is invisible and its LIVE tree can be handed to a second seat.
// `autoCompact` is stored ONLY as the opt-OUT (`false`; enabling deletes the
// key), so losing it fails toward the more destructive default — autoCompactOf
// reads absence as ON and compacts a seat the operator exempted.
// `digested` is append-only history like `sessionIds`, and unlike `rosterSentAt`
// it carries the conversation identity INSIDE its value: a fresh restart mints an
// id that is by construction not in the array, so a preserved list cannot
// suppress a digest that is due. That is what makes it safe here where a bare
// timestamp is not.
const ALWAYS_PRESERVE = ['sessionIds', 'pluginGrants', 'wireLabel', 'keepWarmAlways', 'holdUntil', 'worktree', 'autoCompact', 'digested'];

// The delayed backstop SIGKILL for a pty that ignored `pty.kill()`. The `> 0`
// is the whole function: `process.kill` reads non-positive pids as BROADCASTS,
// not as process ids, and both callers reach it from a `setTimeout` five
// seconds after the session object was captured.
//   -1  signals EVERY process the user may signal — the entire desktop.
//    0  signals our own process group — the whole app.
// Neither is theoretical. A test fixture whose stub pty carried `pid: -1`
// reached kill() and SIGKILLed ~277 processes (Dock, WindowServer, Terminal,
// Chrome, Postgres) three times over, and the bare `catch {}` swallowed it so
// nothing reached the log. A pid is not required to be real here: `pty` is an
// injected seam, and an exited pty can leave the field undefined.
// team-tickets.js's suite-runner guards the identical call for the identical
// reason; that guard predates this one and did not reach this file.
function sigkillPid(pid, name, log) {
  if (!(pid > 0)) {
    if (log) log.warn('session', `refusing SIGKILL for ${name}: pid is ${pid}, which would broadcast rather than target`);
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

// A blocking registry file (agent.json) is STALE — safe to force-clean and
// re-register over — when the process it names is dead, OR when it names OUR OWN
// pid for a session this process isn't running. The latter is the deterministic-
// pid case: in Docker the engine is the same pid every boot, so an agent.json
// surviving an unclean shutdown always points at the new engine itself and a bare
// isAlive() check would read it as "running elsewhere" forever, wedging restore
// and fresh create under that name. Desktop is unaffected — a genuinely-other
// Clodex sharing ~/.clodex never has our pid.
function isStaleRegistration(existingPid, ownPid, isAlive) {
  return !isAlive(existingPid) || existingPid === ownPid;
}

// node-pty's execvp failure in the forked child is silent (no stderr) — it
// surfaces as a bare code-1 exit within a couple seconds of spawn. Excludes
// deliberate exits, signals, and anything past the fast-fail window (a later
// code-1 is a real crash, not a missing binary — the CLI clearly launched).
function missingToolOnExit({ expected, exitCode, signal, elapsedMs, cmd, whichBin }) {
  if (expected || exitCode !== 1 || signal) return null;
  if (!(elapsedMs <= 5000)) return null;
  const resolved = cmd && cmd.includes('/') ? cmd : whichBin(cmd);
  return resolved ? null : (cmd || null);
}

// Name-collision decision for MINTING a new session. The name is the primary
// key everywhere (run/<name>/ dir, agent.sock, [agent:dm] bus, renderer Map,
// DOM data-name), so minting over any existing record — live OR merely
// persisted/archived (archive KEEPS the record, stamped archivedAt) — would
// overwrite it and split a name across two sidebar rows. This guards the mint
// FRONT DOOR only (the session:create / team:create / team:join IPC, all via
// spawnFromParams); the resume paths (restore-on-launch, unarchive→retry,
// restart/reload) re-create a persisted name legitimately and DELIBERATELY
// bypass this — that's the whole --resume design, and the mint-vs-resume axis is
// the front-door-vs-restore-path distinction, NOT resumeId (an "adopt" mint
// carries a resumeId but is still a mint; a persisted entry with no sessionId
// resumes with resumeId=null).
function nameConflict({ liveHas, persistedHas }) {
  if (liveHas) return 'live';
  if (persistedHas) return 'persisted';
  return null;
}

// How many payloads a seat may spill per denied verb, for its whole live session.
// Not 1: intents are handled in sequence, so one turn carrying three denied dms
// would keep an arbitrary one and destroy the rest. Not unbounded: see the rate
// note on _deniedIntentPayload.
const DENIED_SPILL_CAP = 3;

// What to do with the body of an intent the gate just refused. Keyed on the
// INTENT rather than the type because `memory` and `context` split on `sub`.
//   'spill' — hand the payload back on disk. Reserved for bodies whose value IS
//             the composition: prose the sender wrote once and cannot regenerate.
//   'note'  — tell the sender the body is gone, write nothing.
//   'none'  — say nothing, because nothing was lost.
// 'note' is the DEFAULT on purpose. Silence about a destroyed payload is the
// defect this function exists to fix, so it has to be argued for per verb (below,
// `context` is the single case) rather than inherited by any verb nobody
// classified — including a plugin verb that gains a greedy body later.
function deniedBodyDisposition(intent) {
  if (!intent || !intent.body) return { how: 'none', label: null };
  switch (intent.type) {
    case 'dm': case 'notify-user': case 'remind':
      return { how: 'spill', label: intent.type };
    case 'memory':
      // `remember` is the only sub with a greedy body; a future one that gained a
      // body would be reported as lost rather than silently spilled under the
      // wrong label.
      if (intent.sub === 'remember') return { how: 'spill', label: 'memory remember' };
      return { how: 'note', label: `memory ${intent.sub || ''}`.trim() };
    // The one verb whose denial makes the body MOOT rather than lost: the
    // compact/clear/reload did not happen, so the continuation note is still sitting
    // in the context it was written for, and the post-reset self it addresses does
    // not exist. Nothing to hand back, and a "your body was not saved" line here
    // would be a false alarm.
    case 'context':
      return { how: 'none', label: null };
    // exec's body is a JSON args object derived from the same line the sender just
    // wrote, and it means nothing apart from the command that was refused. Lost, so
    // it is reported; not composed, so it is not written to disk.
    default:
      return { how: 'note', label: intent.type };
  }
}

const { speakable } = require('./speakable');

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
    INJECT_SPEAKING_STALE_MS,
    INJECT_VOICE_DRAFT_STALE_MS,
    InjectQueue,
    JsonlWatcher,
    LONG_TEXT_DELAY,
    LONG_TEXT_THRESHOLD,
    MSG_DIR,
    MSG_SPILL_THRESHOLD,
    MSG_MAX_AGE,
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
    DROPPED_AGENT_FIELDS,
    qualifiedAgentName,
    buildIpcPrompt,
    childProcess,
    claimParkedById,
    classifyNotification,
    cleanupClaudeHook,
    cleanupCodexHook,
    cleanupSkillPlugin,
    cleanupAgentPlugin,
    effectiveInjectedSkills,
    effectiveInjectedAgents,
    unresolvedSubagentRefs,
    codexStatusLineArg,
    collectSystemDiagnostics,
    composeDigest,
    digestTiers,
    ctxReminderFor,
    ctxThresholdsFor,
    CTX_THRESHOLD_MIN,
    bakePrompt,
    promptCacheDir,
    readCache,
    enqueueNotice,
    versionNoticeFor,
    clearNotices,
    appVersion,
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
    gitWorktree,
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
    intentEnabledForSeat,
    pluginGrammarLines,
    pluginRowFor,
    validIntentNames,
    intentEnabled,
    isAlive,
    isDigested,
    isDraftOpen,
    isFilenameToken,
    clampReplyBody,
    isHumanPtyInput,
    withoutPrivilegedIntentsFor,
    isInjectInFlight,
    canFireCompact,
    lastTranscriptWrite,
    log,
    fencedLines,
    looksLikeIntent,
    memoryStore,
    commonMemoryRecall,
    memoryLoad,
    hintArm,
    selectionArm: selectionArmDep,
    voiceOriginArm: voiceOriginArmDep,
    mergeClaudeSystemPrompt,
    mergeCodexInstructions,
    normalizeProxyBase,
    noteFileTouches,
    createSubagentStore,
    noteSubagentTurn,
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
    termAvailableFor,
    termExec: termExecDep,
    whichBin,
    writeClaudeDigestFile,
    readVoiceMode,
    writeVoiceMode,
    writeSkillPlugin,
    writeAgentPlugin,
    writeBundlePlugins = () => [],
    getPluginBundles = () => [],
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
  const NO_ARM = { onDraft() {}, disarm() {}, onSubmit() {}, onContextReset() {}, forget() {}, holding() { return false; } };
  const arm = hintArm || NO_ARM;

  // Same shape, same reason, for the drawer selection. Its stand-in REPORTS the
  // refusal rather than resolving to a bare success: the renderer prints what
  // comes back on the operator's status line, and a silent `{armed:false}` would
  // read as "nothing selected" on a host that simply never built the armer.
  const NO_SELECTION_ARM = {
    arm: () => Promise.resolve({ armed: false, reason: 'selection hints are unavailable on this host' }),
    release: () => Promise.resolve({ armed: false }),
    onSubmit() {},
    forget() {},
  };
  const selectionArm = selectionArmDep || NO_SELECTION_ARM;

  // Same stand-in shape: a host that built no armer marks nothing, and the
  // hands-free submit is unaffected.
  const voiceOriginArm = voiceOriginArmDep || { arm: () => false };

  const termExec = termExecDep
    || (() => ({ ok: false, error: 'terminal tabs are not available on this host' }));

  // A SILENT speaker when none is injected, rather than a bare destructure whose
  // absence would be swallowed by the try/catch at each call site. Every test
  // fixture builds this manager without one, and speech is observer-grade: a
  // host that wires no speaker gets no narration, never a broken session.
  const speaker = deps.speaker || {
    speak: () => false, stop: () => false, interruptForRecorder: () => false, isSpeaking: () => false,
  };

  const ROSTER_SETTLE_MS = deps.rosterSettleMs || 400;
  // Settle margin before the boot-ready rising edge fires its pending drain.
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

  // How long an INJECTED unit has to produce a turn edge before the write is
  // treated as lost. Not a stall threshold: it measures the FIRST turn after a
  // write, and a seat that submitted anything at all has already cleared its
  // latch, so this can never fire on a slow turn however long it runs.
  //
  // It lives HERE, not with the ticket verbs, because nothing in its value
  // derives from the ticket lifecycle — it is a property of the inject/activity
  // plumbing, and it now has three borrowers with only one of them ticket-shaped
  // (the spec/redirect latch, the review-start nudge, and the dm latch below).
  // Derived ONCE and lent to team-tickets.js through the shared bag: two
  // `Number.isFinite(deps.specConfirmMs)` literals is the duplicated-default
  // shape that drifts.
  // Injectable for tests, which drive it LONG and call the checks directly — at
  // 0 a check races the delivery it is meant to judge and reads a latch the
  // production ordering never produces. 90s in production.
  const SPEC_CONFIRM_MS = Number.isFinite(deps.specConfirmMs) ? deps.specConfirmMs : 90 * 1000;

  // How many outstanding dm units one seat's latch remembers. A bound, not a
  // tuning: the latch reports rather than acts, so the only cost of a deep FIFO
  // is memory on a seat nobody is reading. Overflow drops the OLDEST and counts
  // it — the dropped unit's sender loses its notice, which is one more reason the
  // broadcast is the load-bearing half of the report and not decoration.
  const DM_LATCH_CAP = Number.isFinite(deps.dmLatchCap) ? deps.dmLatchCap : 8;

  // clodexHome is INJECTED, never left to the store's default: the board now
  // resolves under it, so a test that repoints REGISTRY_DIR would otherwise read
  // and write the operator's real ~/.clodex board.
  const ticketsStore = createTicketsStore({ fs, path, clodexHome: REGISTRY_DIR });

  class SessionManager {
    constructor() {
      this.sessions = new Map();
      this.windows = new Map(); // workspaceId -> BrowserWindow
      // The seat the operator is LOOKING at, as last reported by a renderer.
      // Global rather than per-window on purpose: the external tap has to pick
      // ONE seat for the whole box, and the last report is the one that moved
      // most recently — which is the window he is in.
      this._focusedSession = null;
      // WHICH SEAT HOLDS THE MICROPHONE. One name for the whole box, because
      // there is one microphone: a seat may arm only if it IS this, so two
      // seats cannot both hold it by construction. A per-seat "may I arm?"
      // test cannot express that — a dozen seats each answering locally all
      // answer yes, which is how the operator's speech reached two composers.
      //
      // NOT merged with _focusedSession above, which it tracks by default: an
      // external tap moves this and deliberately does NOT move that, so after
      // one tap the two differ, and a later untargeted tap must still route by
      // the seat he is LOOKING at rather than the one he last named.
      this._micTarget = null;
      // IS CLODEX THE FRONTMOST APPLICATION? The second condition on the
      // automatic re-arm, and independent of the target: the operator browsed
      // the web with Clodex behind it, a turn ended, the re-arm fired, and the
      // CLI transcribed the VIDEO he was watching into that seat's composer.
      // The seat legitimately held the microphone — nobody was talking to it.
      //
      // Starts FALSE. Before any host has reported, no seat may arm: the
      // opposite default records the room at launch, which is the failure.
      this._appFocused = false;
      // Whether any host has EVER reported app focus. Distinct from the flag
      // itself, which cannot carry it: `false` is both "backgrounded" and "no
      // host answers this". The headless/browser host never reports — a remote
      // operator must not arm a recorder attached to the HOST's microphone —
      // and on that path the tap must not try to raise a window either, since
      // there is no window to bring forward and the attempt only fans a
      // `focus-hint` nobody asked for.
      this._appFocusReported = false;
      // When the spoken tap last set the voice mode, box-wide. The CLI observes
      // that write on a delay, so this is what tells a tap arriving inside the
      // window that it must wait too — see voiceTap. Starts 0: nothing has been
      // written, so no tap owes a wait for it.
      this._lastVoiceModeWriteAt = 0;
      // Box-wide recorder stamp — see noteVoiceRecording. Separate from the
      // per-seat field of the same name because audio has no seat.
      this._lastVoiceRecordingTs = 0;
      this._knownDmOrigins = new Set();
      this._relayRosters = new Map();
      this._lastPendingCounts = new Map();
      this._ticketWatch = new Map();
      // Ticket ids with a stall probe in flight. The probe is async (git), so
      // without this two overlapping sweeps both pass the escalation gate and
      // alarm twice on one stall.
      this._stallProbing = new Set();
      this._wire = null;       // in-process tee (WIRE_SHADOW only in W1)
      this._shadow = null;     // wire-vs-jsonl intent differ
      this._wireTelemetry = null; // W2 step-4 dark bridge (wire-telemetry.js)
      const { IntentDeduper, ActivityTracker } = require('./wire-intents');
      this._intentDeduper = new IntentDeduper();
      this._activity = new ActivityTracker((name, state, { turnEnd }) => {
        this._emitActivity(name, state, state === 'idle' && turnEnd);
      }, {
        // activityTs is read as idleMs at four sites, one of which decides
        // whether a dm is delivered or parked (shouldHoldDm). _emitActivity only
        // fires on a LABEL CHANGE, so stamping there alone froze the clock for a
        // seat that keeps working in one state — parking dms at a busy seat.
        // Stamp from the wire event instead. Two separate properties, one per
        // mechanism — do not merge them:
        //   Math.max buys exactly one thing: an out-of-order event cannot drag
        //   the clock backwards, which would inflate idleMs into the hold band.
        //   The lastTranscriptWrite restore seed surviving is NOT Math.max's
        //   doing — it holds because this callback never FIRES for traffic the
        //   tracker did not count (sideCall, not-in-flight). Weaken those
        //   filters and the seed goes, with nothing here to catch it.
        onEvent: (name, ts) => {
          const s = this.sessions.get(name);
          if (s) s.activityTs = Math.max(s.activityTs || 0, ts);
        },
      });
    }


    // The write goes through atomicWriteFileSync, not fs.writeFileSync. This is
    // all-time per-session cost history rewritten IN FULL on wire-telemetry's 1s
    // debounce, and the read side above swallows a parse error by design — so a
    // torn write drops the whole ledger with nothing reporting it.
    //
    // Two consequences worth stating so neither is rediscovered as a mystery:
    // `read` uses the INJECTED fs while `write` uses fs-util's own require('fs')
    // — identical in production, but a future fake-fs fixture would get a
    // split-brain pair. And the first atomic write tightens the ledger's mode to
    // 0600 (the temp file is opened that way), where a bare write left it at the
    // umask default.
    _wireTotalsPersist(totalsPath) {
      return {
        read: () => JSON.parse(fs.readFileSync(totalsPath, 'utf8')),
        write: (obj) => atomicWriteFileSync(totalsPath, JSON.stringify(obj)),
      };
    }

    async _ensureWire() {
      if (this._wire) return this._wire;
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
          const { HoldEntryStore } = require('./wire/hold-store');
          // userData, NOT ~/.clodex/run/<name>/ — that is rm -rf'd on every exit
          // path, and surviving exactly that is the point of this file.
          const entryStore = new HoldEntryStore({
            path: path.join(getUserDataPath(), 'wire-hold-entries.json'),
            // MESSAGE only. The records carry request bytes and a bearer token;
            // the shadow log must never gain a line holding either.
            onError: (message) => this._shadowLog({ type: 'wire-hold-store-error', error: message }),
          });
          hold = new HoldKeeper({ warmth, entryStore });
          hold.on('hold', (ev) => this._shadowLog({ type: 'wire-hold', ...ev }));
          hold.on('hold', (ev) => this._onHoldLifecycle(ev)); // operator-facing subset → clodex.log
          hold.start();
          this._restorePerpetualHolds(hold);
        } catch (e) {
          this._shadowLog({ type: 'wire-hold-unavailable', error: e.message });
          hold = null;
        }
      }
      this._holdKeeper = hold;
      const wire = new WireProxy({ requireTokens: true, warmth, hold });
      // Account plan quota rides the `anthropic-ratelimit-unified-*` response
      // headers of every forwarded Claude turn. Header presence IS the gate for
      // a READING: a codex turn carries none, so a codex seat yields no quota
      // without anyone filtering by session type.
      //
      // The provider check is the second gate, and it covers what the first
      // cannot: a 429 carries no ratelimit headers from ANY provider, so the
      // store's 429 branch is reached on status alone and would file a codex
      // refusal against the Claude org — turning the chip loud for a plan that
      // was never refused. This wire is multi-provider.
      wire.on('response', (ev) => {
        if (!ev || !ev.headers) return;
        if (ev.provider !== 'anthropic') return;
        const store = this.quotaStore();
        if (!store) return;
        // Client bytes first: this event fires before the response head is
        // written downstream, and the store's write is a synchronous disk sync.
        // Doing it inline puts that sync on time-to-first-token for every
        // Claude turn. Nothing here is ordering-sensitive — the store is keyed
        // by org and note() stamps its own timestamp — so deferring costs no
        // accuracy.
        setImmediate(() => {
          try {
            const snap = store.note(ev.headers, { status: ev.status });
            if (snap) this._broadcast('wire-quota', snap);
          } catch (e) {
            this._shadowLog({ type: 'wire-quota-error', error: e.message });
          }
        });
      });
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
              if (isSubagentRole(t.role)) this._noteSubagentTurn(s, t);
            }
          }
          if (t.sideCall || isSubagentRole(t.role)) return; // intents: main line only
          // Plugin turn-text feed. Positioned INSIDE the main-line filter above
          // deliberately, and NOT gated on stop.is_turn: `turn.completed` fires
          // per REQUEST (~4.4 per user turn), and gating would drop the text of
          // every tool-loop hop — the same reason intent extraction below is not
          // gated on it either.
          this._publishAgentText({
            session: t.agent, text: t.text, source: 'wire', truncated: t.truncated,
            isTurnEnd: !!(t.stop && t.stop.is_turn), files: t.files, reads: t.reads,
          });
          const intents = this._extractIntents(t.text);
          this._shadowLog({
            type: 'wire-turn', agent: t.agent, sessionId: t.sessionId,
            role: t.role, reqId: t.reqId, textLen: t.text.length,
            intents: intents.length,
          });
          const s = this.sessions.get(t.agent);
          if (s) s.lastMainStop = { isTurn: !!(t.stop && t.stop.is_turn), ts: Date.now() };
          // Already past the side-call / subagent filter above, so this is the
          // main line's own text. `stop.is_turn` is the wire's truthful
          // discriminator — the same one ActivityTracker trusts for its
          // notification-worthy idle.
          this._maybeSpeak(t.agent, t.text, !!(t.stop && t.stop.is_turn));
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
              this._onWireSessionRotated(s, t.agent, t.sessionId);
            }
            // Deliberately NOT inside the rotation guard above: the re-arm probe
            // also has to run on the first turn after an app restart, where
            // nothing rotated and the gate was never closed. Main-line-only is
            // already guaranteed by the side-call/subagent early return further
            // up, and it must stay that way: noteRequest is main-line-gated too,
            // so a hold armed off a side call would have no replayable entry and
            // holdDecision would skip forever — a state a perpetual hold, which
            // never self-disarms, cannot get out of.
            this._maybeRearmHold(s, t.agent);
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
        const persistTotals = this._wireTotalsPersist(path.join(getUserDataPath(), 'wire-totals.json'));
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
            s.sentinel.armRecovery((text, touches) => {
              // Published from the recovery replay too, and this is exactly the
              // path that makes the feed AT-LEAST-ONCE rather than exactly-once:
              // the tail replayed here overlaps the handover turn the wire may
              // already have delivered. Intents survive that overlap through the
              // content-keyed deduper below; raw text has no such key. Not
              // publishing here would instead lose text precisely when the wire
              // produced no receipt, which is the worse failure.
              this._publishAgentText({
                session: ev.agent, text, source: 'jsonl', truncated: false,
                files: Array.isArray(touches) ? touches : [],
              });
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

    // Lazily built because REGISTRY_DIR resolves post-whenReady.
    _shadowLog(rec) {
      try {
        if (!this._shadowSink) {
          const { ShadowLog } = require('./wire/shadow-log');
          this._shadowSink = new ShadowLog({ fs, path, dir: REGISTRY_DIR });
        }
        this._shadowSink.append(rec);
      } catch { /* shadow only — never surfaces */ }
    }

    _nameForWireSession(sid) {
      if (!sid) return null;
      for (const [name, s] of this.sessions) {
        if (s.sessionId === sid) return name;
      }
      return null;
    }

    // Conversations this seat has moved off, oldest first. Bounded: only the
    // recent past can still have a turn in flight, and a long-lived seat clears
    // many times. Written at BOTH handover sites, read only by the backstop.
    _noteSessionLeft(s, sid) {
      if (!sid) return;
      const left = s._leftSessionIds || (s._leftSessionIds = []);
      if (left.includes(sid)) return;
      left.push(sid);
      if (left.length > 8) left.shift();
    }

    // BACKSTOP path for the same handover onSessionId does. It runs only when the
    // wire id is the first news of the clear — a wiped transcript symlink, where
    // the sentinel never fired. On an ordinary clear the symlink beats the wire
    // and this is normally unreachable — probabilistic, not structural, since a
    // stalled event loop could let the wire win — so it must not be the only
    // place the handover lives.
    //
    // A /clear mints a new wire sessionId under a live session. The keeper is
    // keyed on that id, so the old conversation's hold must END here and the
    // re-arm gate reopen for the new one on the same turn.
    _onWireSessionRotated(s, agent, newSessionId) {
      // Never rotate BACKWARDS onto a conversation this seat has already left.
      // The interleaving: the sentinel fires onSessionId(new), the handover there
      // completes, a main-line turn re-arms the new id — and only THEN does a
      // turn.completed still in flight from the old conversation land carrying
      // the old id. The inequality at the call site holds, so without this the
      // backstop would end the hold that was just handed over and reassign
      // s.sessionId backwards. Corroboration below cannot be what stops it: it
      // fails OPEN when realpathSync throws, and a momentarily unresolvable
      // symlink is exactly what a clear transiently produces.
      //
      // "It self-heals on the next main-line turn" is not a defence for this
      // feature — the seat it exists for is idle by definition, so the next turn
      // is when the operator comes back, and the seat is cold by then.
      //
      // Backstop only. onSessionId is driven by the symlink, which IS the
      // authority on which conversation is live, so it needs no such guard.
      if (s._leftSessionIds && s._leftSessionIds.includes(newSessionId)) {
        this._shadowLog({ type: 'wire-stale-session', agent, sessionId: newSessionId });
        return;
      }
      if (!this._wireSessionCorroborated(s, newSessionId)) {
        this._shadowLog({ type: 'wire-stray-session', agent, sessionId: newSessionId });
        return;
      }
      const oldSid = s.sessionId;
      this._noteSessionLeft(s, oldSid);
      // Before the reassignment, or the old id is unreachable and its hold sits
      // in _holds forever: holdDecision never disarms a PERPETUAL hold
      // (`!hold.always` guards both the expired and max-pings branches) and a
      // dead prefix only ever skips. tick() then re-hashes that conversation's
      // whole message array — _entries retains the bytes — once a minute, per
      // /clear, for the life of the app. A timed hold self-heals via the expired
      // branch, which is why this was invisible before perpetual holds existed.
      //
      // endSession's cause is 'session-ended', which _onHoldLifecycle logs
      // without touching the re-arm gate — the reset below is this path's own
      // job and must stay here. Routing the handover through the 'failures'
      // cause instead would reopen the gate twice and muddy which path owns it.
      if (this._holdKeeper && oldSid) this._holdKeeper.endSession(oldSid);
      s.sessionId = newSessionId;
      s._holdRearmed = false;
      getPersistence().setSessionId(agent, newSessionId);
      this._noteConversationForDigest(s, newSessionId);
    }

    // STARTUP re-arm for PERPETUAL holds — the one mode whose purpose is a seat
    // nobody is sitting at. _maybeRearmHold below restores the intent on the
    // seat's next main-line turn, which an idle seat never takes: measured, an
    // armed `always` hold sat 5.5 hours across a restart without a single ping
    // while keepWarmAlways was on its record the whole time. This runs off
    // _ensureWire instead, so no turn is required.
    //
    // Only the keeper's own persisted entries can arm here — a hold needs
    // replayable last-request bytes, which is exactly what a restart loses and
    // what wire/hold-store.js keeps for perpetual seats alone. The persistence
    // record is the AUTHORITY on whether a given conversation may still be
    // pinged, not the source of what to ping.
    _restorePerpetualHolds(hold) {
      try {
        // A conversation id is pingable iff some seat still claims it
        // perpetually. sessionIds (the /clear history), not just sessionId: the
        // persisted entry can predate a rotation, and the record's current id
        // is not necessarily the one whose bytes we hold.
        const perpetual = new Set();
        for (const rec of getPersistence().list()) {
          if (!rec || !rec.keepWarmAlways || rec.archived || rec.archivedAt) continue;
          if (rec.sessionId) perpetual.add(rec.sessionId);
          for (const id of Array.isArray(rec.sessionIds) ? rec.sessionIds : []) perpetual.add(id);
        }
        const r = hold.restorePerpetual({ accept: (sid) => perpetual.has(sid) });
        if (r.restored || r.declined || r.dropped) {
          // Counts only — a name or an id here would be the first step toward a
          // log line that carries what was replayed.
          log.info('keepwarm', `restored ${r.restored} perpetual hold(s) at startup ` +
            // "declined" without a cause: the count also covers warmth-store
            // errors, which are deliberately NOT treated as a cold prefix.
            `(${r.declined} declined, ${r.dropped} no longer armed)`);
        }
      } catch (e) {
        this._shadowLog({ type: 'wire-hold-restore-error', error: e.message });
      }
    }

    // Restore a persisted keep-warm intent onto the session's CURRENT wire id.
    // Retried every main-line turn until it lands rather than latched once per
    // spawn: arm() is warm-gated, so a first-turn decline would otherwise lose
    // the hold silently.
    _maybeRearmHold(s, agent) {
      if (!this._holdKeeper || s._holdRearmed) return;
      try {
        // Required here, not at module top: wire/* is loaded lazily by
        // _ensureWire so a wire-less host never pulls it in. The keeper guard
        // above means _ensureWire has already run, and require is cached.
        const { rearmPlan } = require('./wire/hold');
        const p = getPersistence();
        const rec = p.list().find((x) => x.name === agent);
        const plan = rearmPlan(rec && rec.holdUntil, Date.now(), !!(rec && rec.keepWarmAlways));
        if (!plan) {
          s._holdRearmed = true; // nothing persisted — stop re-checking this spawn
        } else if (plan.clear) {
          p.setHoldUntil(agent, null);
          s._holdRearmed = true;
          log.info('keepwarm', `disarmed ${agent} (expired before re-arm)`);
        } else if (plan.arm && s.sessionId) {
          const r = plan.always
            ? this._holdKeeper.arm(s.sessionId, 0, { always: true })
            : this._holdKeeper.arm(s.sessionId, plan.hours);
          // A perpetual re-arm has no `until` to write back; the seat flag
          // in persistence is already the whole truth for it.
          if (r && r.armed && (r.always || r.until)) {
            s._holdRearmed = true;
            if (r.always) {
              log.info('keepwarm', `re-armed ${agent} perpetually (seat property)`);
            } else {
              p.setHoldUntil(agent, Math.round(r.until * 1000)); // clamped truth
              log.info('keepwarm', `re-armed ${agent} ${plan.hours.toFixed(2)}h remaining ` +
                `until ${new Date(r.until * 1000).toISOString()}`);
            }
          }
        }
      } catch (e) {
        this._shadowLog({ type: 'wire-hold-rearm-error', agent, error: e.message });
      }
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
          // A failure disarm is PROVISIONAL: it stops the LIVE hold and writes
          // nothing. No ping failure — credential-shaped or not — may
          // erase a persisted keep-warm intent, because a rejected replay is not
          // evidence about what the operator asked for. The CLI owns the OAuth
          // file and refreshes it on its next real turn, so an overnight 401 is
          // transient (measured recovery: ~12 minutes) while the erase was
          // permanent and silent. A `holdUntil` deadline is not cleared here
          // either — it expires by TIME, and rearmPlan's lapse branch notices that.
          //
          // Reopening the gate is what makes the surviving flag mean anything:
          // _maybeRearmHold latches _holdRearmed once an arm lands, so without
          // this the intent would sit in sessions.json un-restored until the next
          // /clear or app restart. Only 'failures' reopens it: 'off' returned
          // above, 'expired'/'max-pings' are terminal for the timed holds that
          // can reach them, and 'session-ended' already resets the gate on the
          // rotation path that emits it.
          if (ev.cause === 'failures' && name) {
            const s = this.sessions.get(name);
            if (s) s._holdRearmed = false;
          }
          log.info('keepwarm', `disarmed ${name || ev.session} (${ev.cause || 'unknown'}` +
            `${ev.pings != null ? `, ${ev.pings} pings` : ''}` +
            `${ev.lastResult ? `, last ${ev.lastResult}` : ''})`);
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
      // Stops whatever is playing, from any seat in any workspace: the speaker
      // is box-wide and cannot attribute an utterance to a session. Sessions
      // survive a window close by design, so nothing else on this path would.
      try { speaker.stop(); } catch {}
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

    // Account plan quota read off our own wire's response headers.
    //
    // Built on FIRST USE rather than in `_ensureWire`, and that is load-bearing
    // for the restored reading: `_ensureWire` runs when the first wire-routed
    // session spawns, which on a cold launch is AFTER the window asks for the
    // quota it should already be able to show. Constructing here lets the
    // startup read restore from disk with no wire and no session.
    quotaStore() {
      if (this._quotaStore !== undefined) return this._quotaStore;
      try {
        const { QuotaStore } = require('./wire/quota');
        this._quotaStore = new QuotaStore({
          // userData, NOT ~/.clodex/run/<name>/ — that is rm -rf'd on every exit
          // path, and surviving exactly that is the point of this file.
          path: path.join(getUserDataPath(), 'wire-quota.sqlite'),
          // MESSAGE only: these headers arrive on the same response as an
          // authorization header, so nothing here hands the log an object.
          onError: (message) => this._shadowLog({ type: 'wire-quota-store-error', error: message }),
        });
      } catch (e) {
        this._shadowLog({ type: 'wire-quota-unavailable', error: e.message });
        this._quotaStore = null;
      }
      return this._quotaStore;
    }

    // The plan quota is the ACCOUNT's, so it goes out window-wide on its own
    // channel rather than riding a per-session payload. Deliberately NOT folded
    // into the wirescope poller's `session-proxy`: that poller returns early
    // when no session has a wirescope base, which would make the wire source —
    // the one that needs no external service — depend on one existing.
    _broadcastQuota() {
      const store = this.quotaStore();
      if (!store) return;
      try {
        const snap = store.snapshot();
        if (snap) this._broadcast('wire-quota', snap);
      } catch (e) {
        this._shadowLog({ type: 'wire-quota-error', error: e.message });
      }
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

    async create(name, type, cwd, extraArgs = [], resumeId = null, workspaceId = DEFAULT_WORKSPACE_ID, systemPromptBody = null, fork = false, proxy = null, agents = [], denyBuiltins = [], disabledTools = [], disabledSkills = [], injectSkills = [], systemPromptFile = null, appendPromptFiles = [], execCommands = [], intents = null, sessionEnv = null, mint = false, noWire = false, plugins = null) {
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
      const baseEnv = { ...BASE_ENV_DEFAULTS, ...process.env };
      try {
        const store = getEnvScopes && getEnvScopes();
        const all = store ? store.all() : { global: {}, workspaces: {} };
        mergedEnv = mergeSessionEnv({
          base: baseEnv,
          global: all.global,
          workspace: (all.workspaces && all.workspaces[workspaceId]) || null,
          session: (sessionEnv && typeof sessionEnv === 'object') ? sessionEnv : null,
          overrideFile: path.join(getUserDataPath(), 'env-override.env'),
        });
      } catch {
        mergedEnv = { ...baseEnv };
      }

      let proxyBase = resolveProxyBase(proxy, getUiSettings());
      // Wire-off: the seat's whole point is that ANTHROPIC_BASE_URL is
      // never set for it — Anthropic's remote access refuses to attach when it
      // is. Nulling proxyBase here is not a second switch: setupClaudeHook falls
      // back to proxyBase whenever wireBase is absent, so skipping only the wire
      // registration below would re-set the variable through the external proxy
      // and defeat the flag entirely. Same reason the tee-blind case just below
      // nulls it.
      const wireOff = noWire === true;
      if (wireOff) proxyBase = null;

      let cmd, args;
      const shell = process.env.SHELL || '/bin/bash';
      const warnings = [];
      const agentType = (type === 'claude') ? 'claude' : (type === 'codex') ? 'codex' : null;
      let intentSource = 'jsonl';
      let wireRouted = false;
      // Claude-arm only; stays null for codex/bash, which have no baked prompt
      // and so no refresh path. Stashed on the session below so refreshPrompt()
      // replays the SAME inputs (see _realIpcFor).
      let promptRecipe = null;
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
        // The wire label, not the seat name, is what the id is minted FROM when
        // the spawn path seeded one. A seat name outlives its ticket — it is
        // recycled, retired, renamed — so spend keyed by it cannot be rolled up
        // per ticket after the fact.
        //
        // Only the EXTERNAL proxy id carries this. The in-process wire's
        // registerAgent() keeps taking the bare name: `t.agent` is a sessions-map
        // key at ~10 call sites and wire-telemetry prunes against that map, so a
        // divergent label there would silently drop every telemetry record.
        const existingEntry = getPersistence().get(name);
        const labelFrom = (existingEntry && existingEntry.wireLabel) || name;
        proxyAgent = resolveProxyAgentId({ name: labelFrom, fork, existing: existingEntry, taken });
      }

      // CLODEX_SPAWNER_HINT=off|on — suppress (or force) wirescope's [wirescope]
      // spawn-directive block for this seat's ROUTE. Fired here, before the PTY
      // spawn, because the block rides inside the marked system prefix and
      // carries the last system cache marker: a flip after the seat's first turn
      // reshapes that prefix and costs a warm bust.
      // Strict match, not a parser: this sits on an authority-adjacent path. The
      // likely typos ('0', 'OFF', ' off') would otherwise fail silently, their only
      // symptom a block reappearing in a prompt nobody reads — hence the warn.
      const hintWant = mergedEnv.CLODEX_SPAWNER_HINT;
      const hintValid = hintWant === 'off' || hintWant === 'on';
      let spawnerHintSet = false;
      if (hintValid && proxyBase && proxyAgent) {
        spawnerHintSet = true;
        try {
          ProxyClient.spawnerHint(proxyBase, proxyAgent, { on: hintWant === 'on' })
            .catch((e) => log.warn('session', `spawner-hint(${hintWant}) ${proxyAgent} failed: ${e.message}`));
        } catch (e) {
          log.warn('session', `spawner-hint(${hintWant}) skipped: ${e.message}`);
        }
      } else if (hintWant && !hintValid) {
        log.warn('session', `spawner-hint: CLODEX_SPAWNER_HINT=${JSON.stringify(hintWant)} not recognized (expected "off" or "on") — no hint set for ${name}`);
      }

      // The POST above lands before the session exists, so kill() cannot clear it
      // if create() throws on the way to sessions.set — the route would keep a row
      // in a TTL-less table forever. Called at every throw site past this point,
      // mirroring the registry.unregister unwind below.
      const abandonHint = () => {
        if (!spawnerHintSet) return;
        try {
          ProxyClient.spawnerHint(proxyBase, proxyAgent, { clear: true }).catch(() => {});
        } catch {}
      };

      // createdAt: stamped ONCE, at the session's first create. kill()+recreate
      // (restart/restore) rebuilds the record from spawn args, so preserve any
      // existing stamp rather than resetting it — the sidebar's "created" sort/
      // group depends on it being stable across restarts.
      // This read is only HALF the invariant: the restore-on-launch path keeps
      // the record, so existingEntry carries the stamp — but every kill()-based
      // restart REMOVES the record first, so existingEntry is null here and the
      // `|| Date.now()` re-mints. The restart callers must therefore re-seed
      // createdAt via _preserveAcrossRestart (engine.restartSession /
      // applySessionArgs, and the [agent:context reload] respawn) BEFORE reaching
      // this line — do not "tidy" the field out of those lists.
      //
      // Computed HERE, above the upsert that consumes it, because the claude arm
      // bakes it into the generated pending-drain hook (setupClaudeHook) and the
      // hook is written before the spawn. The one expression must stay single:
      // recomputing `(existing && existing.createdAt) || Date.now()` down in hook
      // setup would be a second copy that drifts the first time either is
      // touched. Nothing between here and the upsert writes persistence.
      const existingEntry = getPersistence().get(name);
      const createdAt = (existingEntry && existingEntry.createdAt) || Date.now();

      const { teamBlock, teamName, resolvedTeam, missingPrompt } = this._teamBlockFor(name, cwd, agentType, systemPromptFile);
      // The GUI's relay of the one rule. `warnings` already rides the create()
      // return into a renderer toast, so the operator who spawned this seat is
      // told on the channel they are looking at. The intent callers read
      // `missingPrompt` off the return instead and append it to their own reply —
      // a toast is not visible to the agent that asked for the spawn.
      if (missingPrompt) warnings.push(missingPrompt);

      switch (type) {
        case 'claude': {
          cmd = 'claude';
          if (preseedClaudeOnboarding({ fs, path, homeDir: os.homedir() })) {
            this._shadowLog({ type: 'claude-onboarding-preseeded', agent: name });
          }
          const sysFile = resolveSystemPromptFile(systemPromptFile);
          promptRecipe = {
            extraArgs,
            intents,
            execCommands,
            // Captured at spawn, exactly like `intents` beside it — refreshPrompt
            // REPLAYS this object, so a member that re-read persistence would
            // make clear/compact write different bytes than the spawn did. A
            // grant edited live therefore reaches the prompt on the seat's next
            // respawn, which is the same deal the intent checklist already
            // offers; the fire-time gate is what applies immediately.
            pluginGrants: (existingEntry && existingEntry.pluginGrants) || null,
            plugins: Array.isArray(plugins) ? plugins : null,
            appendPromptFiles,
            inlineBody: systemPromptBody || null,
            hasSystemFile: !!sysFile,
            ipcDisabled: mergedEnv.CLODEX_DISABLE_IPC_PROMPT === '1',
          };
          // ONE call, both outputs. Not two calls at their respective use sites:
          // readAppendBodies hits the disk, so a second call could legitimately
          // read different bytes and put `args` and the baked prompt out of sync.
          const { cleaned, realIpc } = this._realIpcFor(promptRecipe, teamBlock);
          args = cleaned;
          const staleSettings = args.findIndex(
            (a, i) => a === '--settings' && (args[i + 1] || '').startsWith('/tmp/wb-wrap/'));
          if (staleSettings !== -1) args.splice(staleSettings, 2);
          // Register the agent with the in-process wire BEFORE the PTY exists
          // (spawn-bound identity), chaining to the external proxy when one is
          // set. A wire failure falls back to the normal path: a tee must never
          // block a session from starting.
          let wireBase = null;
          if (WIRE_SHADOW && !wireOff) {
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
          // Both overlays ride --plugin-dir but gate on DIFFERENT flags: a
          // user-supplied plugin dir replaces the skills scaffold by intent,
          // yet cannot express the agent library, so it must not drop it.
          // Sampled BEFORE the agents block pushes its own, or the skills gate
          // reads our push as the user's and drops every injected skill.
          const userPluginDir = args.includes('--plugin-dir');
          const agentRecords = effectiveInjectedAgents(name, agents);
          const injectedAgents = [];
          const injectedSkills = [];
          if (!args.includes('--agents')) {
            const agentPluginDir = writeAgentPlugin(name, agents);
            if (agentPluginDir) args.push('--plugin-dir', agentPluginDir);
            for (const rec of agentRecords) injectedAgents.push({ ...rec, qualified: qualifiedAgentName(rec.name) });
          } else {
            cleanupAgentPlugin(name);
          }
          if (!userPluginDir) {
            const pluginDir = writeSkillPlugin(name, injectSkills);
            if (pluginDir) args.push('--plugin-dir', pluginDir);
            try {
              for (const rec of effectiveInjectedSkills(name, injectSkills)) {
                injectedSkills.push({ name: rec.name, content: rec.content });
              }
            } catch {}
            try {
              const seatPlugins = Array.isArray(plugins) ? plugins : null;
              const wanted = (getPluginBundles() || [])
                .filter((b) => seatHasPlugin(b.id, seatPlugins, b.shipped));
              for (const b of writeBundlePlugins(name, wanted)) {
                args.push('--plugin-dir', b.dir);
                for (const s of b.skills) injectedSkills.push({ name: `${b.id}:${s.name}`, content: s.content });
                for (const a of b.agents) injectedAgents.push({ ...a, qualified: `${b.id}:${a.name}` });
              }
            } catch (e) {
              warnings.push(`Plugin-owned skills and agents could not be scaffolded for this session: ${(e && e.message) || e}`);
            }
          } else {
            cleanupSkillPlugin(name);
          }
          // The CLI's own warning for three of these goes to a log the
          // operator doesn't read, and initialPrompt gets none at all.
          for (const rec of injectedAgents) {
            const dropped = DROPPED_AGENT_FIELDS.filter((f) => (rec.meta || {})[f]);
            if (dropped.length) {
              warnings.push(`Agent "${rec.name}" sets ${dropped.join(', ')}, which the plugin loader ignores — that field has no effect on this session. Move the agent to .claude/agents/ if you need it.`);
            }
          }
          try {
            if (injectedSkills.length) {
              const deny = Array.isArray(denyBuiltins) ? denyBuiltins : [];
              // Every injected agent matches by QUALIFIED name — a skill saying
              // `subagent_type: "test-runner"` does not dispatch even with
              // test-runner enabled. Built-ins keep bare names.
              const enabled = new Set([
                ...injectedAgents.map((a) => a.qualified),
                ...BUILTIN_AGENTS.filter((b) => !deny.includes(b)),
              ]);
              for (const { skill, ref } of unresolvedSubagentRefs(injectedSkills, enabled)) {
                const owner = injectedAgents.find((a) => a.name === ref);
                const hint = owner
                  ? ` Use "${owner.qualified}" — injected subagents are namespaced.`
                  : ' Enable it (or remove the deny) in the session\'s agents.';
                warnings.push(`Skill "${skill}" calls subagent "${ref}", which isn't enabled for this session — that delegation will fail.${hint}`);
              }
            }
          } catch {}
          if (resumeId && !args.includes('--resume') && !args.includes('-r')) {
            args.push('--resume', resumeId);
            if (fork && !args.includes('--fork-session')) args.push('--fork-session');
          }
          if (sysFile && !args.includes('--system-prompt-file') && !args.includes('--system-prompt')) {
            args.push('--system-prompt-file', sysFile);
          }
          const promptPath = pathFor(REGISTRY_DIR, name, 'appendPrompt');
          // FREEZE on resume (see ipc-prompt-cache.js). create() runs on
          // restore-with---resume too, so writing `realIpc` unconditionally here
          // changed the system prompt under continuing conversations and cost
          // 111k-139k tokens a time. A resume re-bakes the bytes this conversation
          // was BORN with and stages any change as a diff for the ipcdelta drain.
          //
          // Three conditions:
          //   resumeId    — there is a conversation to protect at all.
          //   !mint       — a MINT regenerates even when it carries a resumeId (an
          //                 "adopt"), because reusing a same-named dead session's
          //                 frozen bytes would bake a stranger's prompt.
          //   hookInstalled — no freeze without a channel. A user --settings means
          //                 ipcdelta.sh was never installed, so a staged delta can
          //                 never be delivered; freezing there is permanent silent
          //                 staleness, strictly worse than the rewrite this module
          //                 exists to avoid.
          if (resumeId && !mint && !hookInstalled) {
            warnings.push(`This session's own --settings replaces Clodex's hooks, so the IPC protocol-change channel isn't installed. Its system prompt will be regenerated on every resume instead of frozen — correct, but it re-reads the whole prompt each time.`);
          }
          const reuse = !!resumeId && !mint && hookInstalled;
          const baked = bakePrompt(REGISTRY_DIR, name, realIpc, reuse);
          // First producer on the notice queue (notice-queue.js). Gated on the
          // SAME `reuse` as the freeze above, for the same reasons.
          //
          // Per-session HERE rather than a fan-out at app startup: a fan-out
          // only reaches sessions that exist when it runs, so a seat archived
          // now and unarchived in three weeks would learn nothing.
          //
          // A record with no version at all yields no notice: versionNoticeFor
          // needs both sides, and inventing a floor would announce an upgrade we
          // cannot describe.
          //
          // The else is the boundary side. The producer guard above is not enough
          // on its own: it sits on the producer while an undrained notice sits
          // on the consumer, so a mint would still be DELIVERED whatever the
          // dead namesake enqueued before it died.
          try {
            if (reuse) {
              const notice = versionNoticeFor(existingEntry && existingEntry.appVersion, appVersion);
              if (notice) enqueueNotice(REGISTRY_DIR, name, notice);
            } else {
              clearNotices(REGISTRY_DIR, name);
            }
          } catch { /* an advisory must never block a spawn */ }
          // ensureDir so the write never depends on hook-setup ordering having
          // created the dir first: run/<name>/ is created as a side effect of
          // setupClaudeHook, which is SKIPPED when the caller supplies its own
          // --settings, so without this a --settings session ENOENTs here and
          // cannot spawn at all.
          ensureDir(runDirFor(REGISTRY_DIR, name));
          fs.writeFileSync(promptPath, baked, { mode: 0o600 });
          args.push('--append-system-prompt-file', promptPath);
          break;
        }
        case 'codex': {
          cmd = 'codex';
          const codexSystemBody = systemPromptFile ? getPromptLibrary().raw('system', systemPromptFile) : null;
          const codexAppendBodies = readAppendBodies(appendPromptFiles);
          const { cleaned, merged } = mergeCodexInstructions(extraArgs, buildIpcPrompt(intents, this._resolveExecDefs(execCommands), pluginGrammarLines(intents, Array.isArray(plugins) ? plugins : null)), {
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

      // Applied AFTER the scope merge, in env-scopes.js's app-owned-key slot:
      // these override any value an env scope set, deliberately. CLODEX_HOME
      // belongs here because a seat that runs scripts/task-ledger.js or
      // clodex-team.js from its own shell must land on the same tree as the
      // exec route already does — a scope-set value would resurrect exactly the
      // split those pins closed.
      // FORCE_HYPERLINK: a CLI that gates OSC 8 emission on a TERM_PROGRAM
      // allowlist reads it from OUR process env, so its hyperlinks would appear
      // when Clodex is launched from a terminal and vanish when launched from
      // Finder. Forcing it removes that inheritance. Click-to-open does NOT
      // depend on this — it scans rendered text (renderer.js, registerLinkProvider)
      // precisely because the Claude CLI is not observed to emit OSC 8 either way.
      const env = { ...mergedEnv, TERM: 'xterm-256color', CLODEX_HOME: REGISTRY_DIR, FORCE_HYPERLINK: '1' };
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
        abandonHint();
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
        try {
          registry.register(name, socketPath, cwd);
        } catch (e) {
          if (e.code !== 'EEXIST') { abandonHint(); throw e; }
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
            abandonHint();
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
          abandonHint();
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
        // Recorded from the POST actually made, not re-read in kill(): the env
        // can change under a live seat, and a clear driven by the new value
        // would either leak a row or clear one this seat never set.
        spawnerHintSet,
        // Ticket-replay incarnation key. Minted here and NEVER persisted, so that
        // its absence from a resumed record is itself the signal that this process
        // has not been handed its open tickets' specs (_replayOpenTickets).
        // `sessionId` cannot serve — it is assigned from `resumeId` just below, so
        // a --resume carries the SAME id, which is exactly the case that loses a
        // delivery.
        //
        // pid + ms + counter because this is the only value in create() that must
        // be unique ACROSS processes: a fresh process colliding with its
        // predecessor's key would read its own tickets as already delivered and
        // replay nothing.
        incarnation: nextIncarnation(),
        // The tri-state as REQUESTED (false=off, string=explicit, null=follow the
        // pref), kept alongside the base it resolved to: _armCtx has to re-resolve
        // per draft, and the base alone cannot say whether an explicit route or a
        // pref that has since been unticked produced it.
        // NOT named `proxy`: `_handleSpawnIntent` and `_handleTeamReview` read
        // `spawner.proxy ?? null` / `session.proxy ?? null` off the live session,
        // which have always resolved to null (the field lived only in the
        // persistence record). Naming it `proxy` here silently makes a child
        // inherit its spawner's route — a real decision, but not this one.
        proxyRequested: typeof proxy === 'string' ? normalizeProxyBase(proxy) : (proxy === false ? false : null),
        intentSource, wireRouted, backend, noWire: wireOff, sentinel: null,
        fileTouches: [],
        // Called defensively because this runs AFTER the agent socket is bound:
        // an observer dep that is merely absent must degrade to "no feed" (which
        // `_noteSubagentTurn` already handles), never throw out of create() and
        // strand a listening socket.
        subagentStore: createSubagentStore ? createSubagentStore() : null,
        // Peer-visibility facts ([agent:who] labels, dm hold gate): state from
        // _emitActivity (transition-deduped), timestamp from every counted wire
        // event (the ActivityTracker onEvent seam). Restores seed from the resumed
        // transcript's mtime (= last real turn) — seeding "now" would make every
        // GUI restart reset idle clocks, mislabeling long-cold peers as fresh
        // and letting DMs to them past the hold gate for 30 minutes.
        activityState: 'idle',
        // Math.min clamps a FUTURE mtime (NFS, rsync -t, a clock step). It used
        // to self-correct on the next transition, which assigned Date.now(); the
        // clock is monotonic now, so a future seed would stick forever, keep
        // idleMs negative, and make `idleMs < DM_HOLD_IDLE_MS` trivially true —
        // that seat could never be held again.
        activityTs: Math.min(lastTranscriptWrite(agentType, cwd, resumeId) || Date.now(), Date.now()),
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
        promptRecipe,
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
        // The version this seat is running under AS OF THIS SPAWN — the baseline
        // the next spawn compares against to decide whether it owes a "Clodex was
        // upgraded" notice (notice-queue.js). Written for every type, not just
        // claude: a value that is only sometimes present is a baseline whose
        // absence means two different things.
        //
        // Unconditional, and it must stay so. This is the ADVANCE half of an
        // edge-triggered comparison: the read above happens before this line,
        // so omitting the write on any path leaves the old version on the
        // record and every subsequent resume re-enqueues the same notice.
        appVersion,
        sessionId: resumeId || null,
        workspaceId,
        systemPrompt: systemPromptBody || null,
        systemPromptFile: systemPromptFile || null,
        appendPromptFiles: Array.isArray(appendPromptFiles) ? appendPromptFiles : [],
        proxy: typeof proxy === 'string' ? normalizeProxyBase(proxy) : (proxy === false ? false : null),
        proxyAgent,
        // Written UNCONDITIONALLY, including the `false` that looks redundant on a
        // fresh record: upsert spread-MERGES (stores.js), so omitting it on the
        // no-hint path leaves a stale `true` from an earlier spawn, and the
        // record-dropping exits below would then clear a row this seat never set.
        // The live path reads the session flag; only the exits that run without a
        // session (forget, reviewer sweep) need it here.
        spawnerHintSet,
        agents: Array.isArray(agents) ? agents : [],
        // Written UNCONDITIONALLY like spawnerHintSet above, for the same reason:
        // upsert spread-MERGES, so omitting `false` leaves a stale `true` from an
        // earlier spawn and the seat silently stays wire-off after being turned
        // back on. Absence and false mean the same thing here (unlike `intents`,
        // whose absence is a distinct living default), so there is nothing to lose
        // by writing the boolean every time.
        noWire: wireOff,
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
        // Same conditional-omit rule as `intents` above: freezing `plugins: null`
        // onto the record writes a value where the absent list means all.
        ...(Array.isArray(plugins) ? { plugins: plugins.map(String) } : {}),
        ...(Array.isArray(execCommands) && execCommands.length ? { execCommands: execCommands.map(String) } : {}),
        // Session-scope env. Persisted on the entry so --resume respawns with the
        // SAME env (the wrong AWS identity on restart would be silent and
        // dangerous). An empty/absent env is NOT a distinct value — absent ≡ {} ≡
        // "no session env" — so omit it and let the merge fall through to
        // global/workspace scopes. sanitizeFlat re-applies the key/deny/newline
        // gate at the PERSISTENCE door too: a deny-listed key or newline value
        // must not land on sessions.json even inert, and it is what a later
        // --resume reads back — the spawn merge already drops junk, so the record
        // must match.
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
          // The keep-warm handover rides THIS edge. The symlink repoint reports
          // the clear seconds before the new conversation's first upstream
          // response, so by the time the wire's turn.completed runs the
          // assignment above has already made its `s.sessionId !== t.sessionId`
          // test false and _onWireSessionRotated does NOT run on an ordinary
          // clear. That method keeps the same two lines for the backstop case (a
          // wiped symlink); it is a second site on purpose, so do not consolidate
          // the handover into it.
          try { if (this._holdKeeper) this._holdKeeper.endSession(priorSid); } catch { /* observer-grade */ }
          session._holdRearmed = false;
          this._noteSessionLeft(session, priorSid);
          try { arm.onContextReset(name); } catch { /* observer-grade */ }
          // BEFORE the continuation: a clear discarded the conversation, so the
          // prompt-file rewrite has no warm cache left to bust and the fresh
          // conversation should start on current bytes rather than inherit the
          // freeze. Ordering matters — the continuation is this conversation's
          // first turn, and a rewrite after it would bust what it just seeded.
          try { this.refreshPrompt(name, 'clear'); } catch { /* never block the continuation on a refresh */ }
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
          (text, touches, meta) => this._scanJsonlText(text, name, touches, meta),
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
              // An ephemeral seat is never nudged: it is retired at `done`, the
              // moment a compact would cost it exactly the context its rework
              // needs. Suppressed HERE, not inside ctxReminderFor, which stays
              // pure. Read off the persistence record, never re-derived from the
              // name shape.
              //
              // Read here rather than memoized at create: get() re-reads
              // ui-settings.json, so an edited threshold applies to a running
              // session without a restart. A failed read resolves to the shipped
              // defaults, never to no reminder.
              //
              // Gated on the floor rather than on the shipped nudge: no override
              // can fire below it, because sanitizeThresholdPair drops a row
              // whose nudge is under CTX_THRESHOLD_MIN. So this skips the
              // ui-settings.json re-parse for the whole quiet life of a session
              // without capping how low an operator can set the threshold.
              let ctxOverrides = null;
              if (c.tok >= CTX_THRESHOLD_MIN) {
                try { ctxOverrides = getUiSettings().get().ctxReminderThresholds; } catch {}
              }
              let warn = ctxReminderFor(c.tok, ctxThresholdsFor(c.model, ctxOverrides));
              // Read lazily at the first over-threshold tick, not eagerly at
              // create: get() re-parses the whole of sessions.json and _load()
              // can WRITE it (the workspaceId backfill), while the record may be
              // seeded just after create. Memoized only on a record actually
              // returned — a missing or throwing read leaves it unset, so the
              // seat stays NUDGED and a later tick can still settle it, rather
              // than being silently silenced by a failed read.
              if (warn) {
                if (session._ephemeralSeat === undefined) {
                  let rec = null;
                  try { rec = getPersistence().get(name); } catch {}
                  if (rec) session._ephemeralSeat = !!rec.ephemeral;
                }
                if (session._ephemeralSeat) warn = null;
              }
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
              // Same margin, same reason: a ticket spec written before the readline
              // loop is up is wiped by the boot re-render, and the replay stamps it
              // delivered — so the loss is silent until the NEXT respawn.
              this._replayTicketsOnce(session);
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
        // NEVER fired here. Both arms defer to the edge where the seat can actually
        // receive, which is a different edge per agent type — a write at create()
        // lands in a CLI whose input loop is not up, and the boot re-render wipes it
        // while the replay stamps it delivered: the same silent drop this exists to
        // close, one layer down.
        session._replayTicketsPending = true;
        if (session.agentType !== 'claude') {
          session._bootSettling = true;
          session._bootSettleSince = Date.now();   // absolute-wait cap anchor
          // That cap is NOT wall-clock: _settleBoot runs only from _armBootSettle,
          // which runs only from onData, so a codex seat emitting nothing never
          // settles and would lose its spec for the life of the process. The reason
          // this arm has no ordinary fallback — never fire while boot output is
          // streaming — says nothing about a seat that has produced no output at all,
          // so the timer below fires only in that case (`!_bootSettleTimer` ⇒ onData
          // never ran).
          session._replayFallbackTimer = setTimeout(() => {
            session._replayFallbackTimer = null;
            if (session._bootSettleTimer) return;   // output seen; the settle owns it
            this._replayTicketsOnce(session);
          }, INJECT_BOOT_MAXWAIT);
        } else {
          // Claude's queue gates on _bootReadySeen, but that gate CANNOT cover this
          // race on its own (see BOOT_DRAIN_SETTLE_MS): by the time the drain runs the
          // latch is already set, so the gate is no-op-true and adds zero wait. Only
          // the wall-clock defer is margin, so the replay rides it.
          // The fallback covers a seat that never emits mode-2004 at all — the
          // edge-armed drain never runs there, and without this its spec is lost for
          // the life of the process.
          this._armReplayFallback(session, INJECT_BOOT_MAXWAIT, Date.now() + 3 * INJECT_BOOT_MAXWAIT);
        }
      }
      try { getPluginHooks && getPluginHooks() && getPluginHooks().fireCreate(name); } catch {}
      return { name, type, pid: ptyProc.pid, backend, noWire: wireOff, ...(teamName ? { team: teamName } : {}), ...(missingPrompt ? { missingPrompt } : {}), ...(warnings.length ? { warnings } : {}) };
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
          // The CLI's hook drains the attachment queue on this same submit, so
          // the pending list has served its purpose. Holding it longer would
          // suppress a peek for text the transcript now carries anyway — once
          // it is IN the conversation, re-selecting it is an ordinary selection
          // about an ordinary part of the context.
          //
          // The renderer is told because its status line claims a delivery that
          // had not happened yet; this is the event that makes the claim true
          // and then retires it.
          try {
            if (selectionArm.onSubmit(key)) this._sendToSession(key, 'selection-sent', key);
          } catch {}
          return;
        }
        arm.onDraft(key, s._draft, this._armCtx(s), { overflow: r.overflow, desync: r.desync });
      } catch (e) { log.debug('hint', `draft fold failed for ${s.name}: ${e.message}`); }
    }

    // The EXACT route when we have it, a glob only as a fallback. A glob is
    // fnmatchcase on the proxy side, so `clodex-clodex-*` also matches
    // `clodex-clodex-hand-4f2a` — arming for one agent would arm every agent
    // whose name extends it.
    _armCtx(s) {
      return {
        agent: s.name,
        // Re-resolved every draft, not read straight off the session: `proxyBase`
        // was captured at SPAWN, so unticking traffic optimization left a routed
        // session POSTing hints at a wirescope that had just been stopped — and a
        // rejected POST does not release the pre-arm's hold, so the inject queue
        // then sat for its full cap before delivering.
        // Re-resolution and NOT the live pref alone: an explicitly-routed session
        // keeps its hints when the global pref is off. Used only as a BOOLEAN —
        // the value is the CAPTURED base, because that is the one the child's env
        // was baked with, so editing proxyUrl mid-session correctly does not move
        // it. That also makes a null capture win on its own, which preserves the
        // spawn-time decisions re-resolution cannot reconstruct.
        base: resolveProxyBase(s.proxyRequested, getUiSettings()) ? s.proxyBase : null,
        route: s.proxyAgent || `${PROXY_AGENT_PREFIX}${s.name}-*`,
      };
    }

    // The drawer's selection. The PEEK half is routed through _armCtx like every
    // other hint so the route grammar and the proxy-off rule have ONE
    // implementation — a second base resolution here would re-introduce the
    // captured-base bug that comment describes. The ATTACH half ignores all of
    // it: a hard copy goes into the seat's queue file for the CLI's own hook,
    // so it works with wirescope off entirely.
    //
    // A session that is not in the map is not an error the operator needs to see:
    // it is a selection that outlived the tab it came from (the debounce fires
    // ~300ms after the drag, and a session can die inside that window).
    armSelection(name, payload) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return Promise.resolve({ armed: false, reason: 'no such session' });
      return selectionArm.arm(s.name, payload || {}, this._armCtx(s));
    }

    // Routed through _armCtx like every other hint, which is what keeps the
    // captured-vs-live base rule and the route grammar in one place.
    //
    // Returns nothing and awaits nothing: the caller is one write away from
    // sending the operator's message, and the marker is worth less than that
    // write. A seat that is gone is not an error — the submit it would have
    // marked cannot happen either.
    markVoiceOrigin(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      try { voiceOriginArm.arm(this._armCtx(s)); } catch {}
    }

    // The submit that marker was armed for stood down. Same shape as its
    // neighbour for the same reason — the renderer calls this from paths the
    // operator's own keystroke runs on.
    //
    // A seat that is gone needs no unwind: the marker is one-shot and dies with
    // its TTL, and there is no next turn on a dead seat to mislabel.
    unmarkVoiceOrigin(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      try { voiceOriginArm.disarm(this._armCtx(s)); } catch {}
    }

    // The renderer saw the CLI's recording indicator lit on this seat. Stamped
    // as a LEVEL the renderer keeps refreshing, not an edge, and the difference
    // is what bounds the failure: an edge-shaped signal whose "stopped" event is
    // lost — window closed, seat switched, renderer gone — leaves the seat
    // marked speaking forever, and forever means every message to it is
    // deferred. A stamp that must be refreshed decays on its own instead.
    //
    // Its OWN field. `lastUserInputTs` has three readers (the inject gate, the
    // reboot-notice draft staleness, and _maybeParkDelivery's typing test) and
    // stamping this into it would silently change what the other two mean.
    noteVoiceRecording(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      s.lastVoiceRecordingTs = Date.now();
      // BOX-WIDE COPY, kept ALONGSIDE the per-seat field above rather than
      // replacing it. The two answer different questions and must not be merged:
      // an inject targets ONE seat, so its gate is correctly per-seat, while the
      // microphone and the speaker are properties of the room. The renderer only
      // ever reports the ACTIVE seat's recorder, so a per-seat read is
      // permanently undefined for every background seat — gating audio on it
      // means no gate at all for exactly the case that matters: dictating into
      // the focused seat while another seat finishes a turn.
      // RISING EDGE, computed BEFORE the stamp below overwrites the evidence.
      // The renderer reports the recorder as a LEVEL every ~300ms while it is
      // lit, so an unguarded call runs the interrupt hundreds of times per
      // dictation; it is harmless (stop() is a no-op when nothing is playing)
      // but it makes the call site claim an event it is not detecting.
      const recorderJustLit = Date.now() - (this._lastVoiceRecordingTs || 0) >= INJECT_SPEAKING_STALE_MS;
      this._lastVoiceRecordingTs = Date.now();
      // He tapped the microphone while a narration was still playing — the
      // converse of the gate in _maybeSpeak, and the harder half. Stopping is
      // what a person does when interrupted; see interruptForRecorder for the
      // alternative that was rejected.
      if (recorderJustLit) { try { speaker.interruptForRecorder(); } catch {} }
    }

    // The renderer saw a DICTATED draft still sitting unsent in this seat's
    // composer. Same level shape and same expiry reason as the recorder stamp
    // above, and its own field again for the same reason: this one is read by
    // the park divert, and folding it into either of the others would change
    // what those readers mean.
    //
    // What it buys over the recorder stamp is the window the operator is
    // actually exposed in — he stops talking, the indicator goes dark, and he
    // spends the next minute READING the transcription before he sends it.
    noteVoiceDraft(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return;
      s.lastVoiceDraftTs = Date.now();
    }

    // Which seat a renderer is showing. Kept even when the name is not a live
    // session: the record is a REPORT, and validating it here against a map
    // that a spawn may not have filled yet would silently drop the first
    // report for a seat that is about to exist. The reader below resolves it.
    // `win` is the window the report CAME FROM, resolved in main where the
    // sender is known. Without it the two writes below cannot be told apart,
    // and that is the whole of this method.
    //
    // The ROUTING record updates unconditionally: an external tap that names no
    // seat must keep landing on the seat he is looking at even when the report
    // arrived from a background window, which is the feature the tap exists for.
    //
    // The MICROPHONE does not. A window reports its own `activeSession`, and it
    // does so with NO operator action at all — a seat exiting in a background
    // window switches that window to its next seat and reports it. Retargeting
    // on that took the microphone off the seat he was dictating into and gave
    // it to one he could not see, which is this ticket's own bug through a
    // third door: a box-wide resource written from per-window state.
    //
    // So the AUTHORITY to move the microphone is two box-wide facts, neither of
    // which a window knows about itself — whether it is the focused window, and
    // whether the app is frontmost. The window supplies only the name.
    noteFocusedSession(name, win = null) {
      this._focusedSession = name || null;
      let reporterInFront = false;
      try { reporterInFront = !!win && win.isFocused() === true; } catch { reporterInFront = false; }
      if (!reporterInFront || !this._appFocused) return;
      this._setMicTarget(this._focusedSession);
    }

    // THE ONLY WRITER of the target, so the invariant is enforceable by reading
    // one function: every path that moves the microphone comes through here and
    // every window learns the same name.
    //
    // Broadcast to ALL windows, not sent to the target's: the losers are what
    // makes this an invariant. A seat that has just STOPPED being the target
    // has to hear so, or it goes on believing it may arm and the second live
    // recorder — the whole bug — survives.
    //
    // Idempotent by the equality guard: the focus report repeats on every
    // window focus, and re-broadcasting an unchanged name would put a frame on
    // every window each time he alt-tabs.
    _setMicTarget(name) {
      const next = name || null;
      if (this._micTarget === next) return;
      this._micTarget = next;
      this._broadcast('mic-target', next);
    }

    // A window opened, or reloaded, and starts life believing it holds nothing.
    // Without this it would stay that way until the target next CHANGED — and
    // the target does not change while the operator is dictating into the seat
    // he already picked, so the re-arm would be dead in a fresh window.
    micTarget() { return this._micTarget; }

    // The host telling us whether Clodex is the frontmost APPLICATION. Only a
    // host can answer it: a window reporting its own focus answers a different
    // question — a window can be the focused window of an app that is itself
    // behind a browser, which is exactly the case that recorded video audio.
    //
    // Same broadcast-plus-pull shape as the target above, and the same
    // idempotence guard: window focus churns between sibling windows without
    // the APP's frontmost-ness changing at all.
    noteAppFocused(focused) {
      const next = focused === true;
      // Set BEFORE the equality guard, or a host whose first report is `false`
      // (the common desktop case: launched into the background) would be
      // indistinguishable from a host that never reports at all.
      this._appFocusReported = true;
      if (this._appFocused === next) return;
      this._appFocused = next;
      this._broadcast('app-focused', next);
    }

    appFocused() { return this._appFocused; }

    // Every decline a voice verb can reach, in one place so `select` cannot
    // admit a seat `tap` would refuse. Falling back to the focused seat on an
    // ABSENT target is the tap's rule and stays here; an UNMATCHED name is a
    // decline for both — never a fallback, or a named select would arm a seat
    // he did not name while he believes he switched.
    _voiceRoute(target = null) {
      const name = target || this._focusedSession;
      if (!name) return { ok: false, error: 'no target and no focused session' };
      const s = this.sessions.get(name);
      if (!s || s._dead) return { ok: false, error: `no live session "${name}"` };
      if (s.agentType !== 'claude') return { ok: false, error: `"${name}" is not a claude seat` };
      const win = this.windowForSession(name);
      if (!win) return { ok: false, error: `"${name}" has no window attached` };
      return { ok: true, name, session: s, win };
    }

    // SELECT THEN ARM. The tab has to be the one he is looking at before the
    // recorder lights, or he dictates into a seat he cannot see.
    //
    // The switch frame goes to the target's OWN window; the raise stays
    // voiceTap's single site, asked for explicitly — one raise mechanism, and
    // it already orders retarget → raise → frame correctly.
    //
    // A NAME IS MANDATORY HERE, checked before _voiceRoute rather than inside
    // it: the route's absent-target fallback is the TAP's rule, and an empty
    // string reaches it as falsy and resolves to the focused seat — selecting
    // and ARMING a seat he did not name while he believes he switched. That is
    // the outcome this verb calls worse than silence, and it arrives from an
    // unset shell variable, not from exotic input. The check lives in the
    // MANAGER because the socket is the trust boundary every front-end shares.
    voiceSelect(target = null) {
      if (typeof target !== 'string' || !target.trim()) {
        return { ok: false, error: 'select needs a seat name' };
      }
      const r = this._voiceRoute(target);
      if (!r.ok) return r;
      // Ahead of the tap: the tap's raise brings the window forward.
      this._sendToSession(r.name, 'request-switch-session', r.name);
      return this.voiceTap(r.name, { raise: true });
    }

    // Switch the CLI's push-to-talk mode by WRITING the settings file it reads.
    // A running CLI picks that up: the mode is read through a live store
    // selector rather than cached at startup, and the CLI watches the settings
    // directory. Observed directly — an external edit moved a live session. Not
    // immediately, though: that watcher debounces ~1s, which is why the write
    // stamps `_lastVoiceModeWriteAt` and a tap inside the window waits it out.
    //
    // BOTH WRITE SURFACES land here — the spoken verb and the Preferences /
    // popover row over `settings:setVoiceMode`. That is what keeps the stamp
    // above true of every write: a surface reaching past this to the writer
    // would move the mode without arming the wait it creates.
    //
    // NOT AN INJECTION, and not a spawned CLI either. Injection dragged in the
    // composer, the inject queue, the quiet gate and `parkable` — and a PARKED
    // slash command never executes, because the hook hands parked text back as
    // additionalContext, which the model reads as prose instead of typing. So
    // the verb could silently do nothing behind an open draft. Spawning was
    // measured and rejected: `/voice` declares supportsNonInteractive false, so
    // `claude -p "/voice tap"` exits 0 and changes nothing, and the positional
    // form starts an interactive TUI that needs a pty and does not self-exit.
    //
    // TAKES NO SEAT. The file is one per box, so there is no mic holder, window
    // or live session for this to resolve, and arming a mode before any seat
    // exists is a thing he can reasonably want from across the room. An invalid
    // mode and a failed write are the only declines left.
    voiceMode(mode) {
      const r = writeVoiceMode(mode);
      if (!r.ok) {
        log.warn('voice', `mode ${mode} failed: ${r.error}`);
        return r;
      }
      // SAME MEMO AS THE TAP'S OWN WRITE, and it has to be: `mode tap` followed
      // by the tap phrase is the exact two-phrase workflow this ticket replaces,
      // and without this stamp the tap that follows sends its byte under a mode
      // the CLI has not observed — the blink, on the way out of the blink.
      //
      // `tap` only. Moving to `hold` or `off` arms nothing, so a tap that
      // followed one has no reason to wait: the wait exists to let the CLI catch
      // up to TAP, and stamping here for a mode that will not arm would delay a
      // later tap for nothing.
      if (mode === 'tap') this._lastVoiceModeWriteAt = Date.now();
      log.info('voice', `mode ${mode}`);
      return { ok: true, mode };
    }

    // Spoken replies on or off, from across the room. CLODEX'S OWN setting, so
    // this is an ordinary store write — no CLI, no slash command, no pty. The
    // contrast with `mode` is which side owns the value: voice mode lives in
    // the CLI's settings file, this lives in Clodex's store.
    //
    // BOX-WIDE. There is no per-seat speech flag, so this takes no seat name and
    // never consults the microphone holder.
    //
    // EXPLICIT ON/OFF, NEVER A TOGGLE: he cannot see the current state from
    // across the room, so a toggle fired on a mis-hear leaves him unsure which
    // state he is in and saying it again to check flips it back. Explicit is
    // idempotent and safe to repeat, the same reasoning that has `select`
    // decline an unmatched name rather than guess.
    voiceSpeech(state) {
      if (state !== 'on' && state !== 'off') return { ok: false, error: `unknown speech state "${state}" (use on|off)` };
      const store = getUiSettings && getUiSettings();
      if (!store) return { ok: false, error: 'no settings store' };
      const on = state === 'on';
      store.set({ speakReplies: on });
      log.info('voice', `speech ${state}`);
      // No push to the windows, and none to add: nothing subscribes to this
      // value. The speaking gate reads the store at every turn end, and the
      // voice popover re-reads it on OPEN — so both already agree with the
      // store the moment this returns. A broadcast invented here would be a
      // second notification mechanism serving no reader.
      return { ok: true, state, speakReplies: on };
    }

    // ENSURE-ON from outside the app: a Voice Control wake word arrived over
    // this box's agent socket asking for the recorder.
    //
    // ROUTES ONLY. Whether a key may actually be written is decided in the
    // renderer, against the seat's own screen — main cannot read the recording
    // indicator, and a decision made here would be made blind.
    //
    // An explicit target overrides the focused seat, so a script can address a
    // seat the operator is not looking at.
    voiceTap(target = null, { raise = false } = {}) {
      const r = this._voiceRoute(target);
      if (!r.ok) return r;
      const { name, win } = r;
      // THE TAP RETARGETS, and the automatic re-arm never does. That asymmetry
      // is the design: he NAMED this seat, so it takes the microphone from
      // whoever held it; a re-arm names nobody, so it gets no say in who holds
      // it and may only arm the seat that already does.
      //
      // BEFORE the frame, so the seat cannot receive its own tap while another
      // seat is still recorded as the holder.
      //
      // Only past every decline above: a tap that routed nowhere must not move
      // the microphone off the seat that has it.
      this._setMicTarget(name);
      // FOCUS-THEN-ARM, not decline. No path arms the recorder while Clodex is
      // in the background — a microphone behind a browser records whatever the
      // room is playing. But the tap NAMES a seat, so unlike the automatic
      // re-arm it knows which window to raise, and raising it is what keeps the
      // daily workflow (a Voice Control phrase with another app in front)
      // working rather than silently declining.
      //
      // `show()` then `focus()`, the pair the file-view path already uses and
      // the window-bridge contract already documents — this adds no window
      // capability. AFTER the retarget and BEFORE the frame: the seat must
      // already hold the microphone when its window comes forward, and the
      // renderer decides whether the key may be written against an app that is
      // by then coming to the front.
      // `raise` is the CALLER'S INTENT and is why it ORs rather than extending
      // the focus test: app-focus answers "is Clodex buried", which is the
      // tap's question, and it is FALSE exactly when he is looking at another
      // Clodex WINDOW. A select must cross that gap — its whole job is moving
      // him between windows — so it says so instead of re-deriving it.
      if (raise || (this._appFocusReported && !this._appFocused)) {
        try { win.show(); win.focus(); } catch { /* a host that cannot raise still routes the tap */ }
      }
      // In `hold` the tap arms nothing: that arm expects a HELD key, so it
      // starts recording and sets a release timer through an auto-repeat
      // fallback, and one synthetic keystroke has no auto-repeat.
      //
      // BELOW every decline, so a tap that routes nowhere changes no box-wide
      // setting. The mode is NOT restored afterwards: restoring races his
      // dictation, and `mode hold` is the deliberate stand-down verb.
      //
      // READ FIRST, so an already-tap file is left alone. The renderer owes a
      // ~1s wait whenever the CLI may not have caught up, and paying it on every
      // tap would delay the common case for nothing.
      //
      // `effective`, not `mode`: with voice switched off the file still names
      // tap or hold beside the flag, and the tap has to turn voice back ON.
      const cur = readVoiceMode();
      if (!cur || cur.effective !== 'tap') {
        const w = writeVoiceMode('tap');
        // Reported, not fatal: the mode it could not change may already suit,
        // so the tap is still worth routing.
        if (w.ok) this._lastVoiceModeWriteAt = Date.now();
        else log.warn('voice', `tap could not set mode: ${w.error}`);
      }
      // THE QUESTION IS "HAS THE CLI OBSERVED TAP YET", NOT "DID I JUST WRITE".
      // Those differ for the tap that matters most: he says the phrase, sees
      // nothing happen, and says it again. The second one reads a file the first
      // already set to tap, so a did-I-write flag reports nothing to wait for
      // and sends its byte under the mode the CLI is still on — the blink, back,
      // on the repeat he made BECAUSE of the blink.
      //
      // So it is the age of the last write that decides, and any tap inside that
      // window inherits the wait. The memo is the only state this needs, and it
      // lives here because the renderer cannot see the write at all.
      const settling = this._lastVoiceModeWriteAt
        && (Date.now() - this._lastVoiceModeWriteAt) < VOICE_MODE_SETTLE_MS;
      this._sendToSession(name, 'voice-tap', name, !!settling);
      return { ok: true, name };
    }

    releaseSelection(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return Promise.resolve({ armed: false });
      return selectionArm.release(s.name, this._armCtx(s));
    }

    // What is on its way to this session's agent, for the drawer's inspector.
    // Read-only: it registers nothing and takes nothing back, so opening the
    // popover cannot change what rides the next request.
    inspectSelection(name) {
      const s = this.sessions.get(name);
      if (!s || s._dead) return Promise.resolve(null);
      return selectionArm.inspect(s.name, this._armCtx(s));
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
      if (s.spawnerHintSet && s.proxyBase && s.proxyAgent) {
        try {
          ProxyClient.spawnerHint(s.proxyBase, s.proxyAgent, { clear: true })
            .catch((e) => log.warn('session', `spawner-hint(clear) ${s.proxyAgent} failed: ${e.message}`));
        } catch (e) {
          log.warn('session', `spawner-hint(clear) skipped: ${e.message}`);
        }
      }
      getPersistence().remove(name);
      try { s.pty.kill(); } catch {}
      setTimeout(() => { sigkillPid(s.pty.pid, name, log); }, 5000);
    }

    // Poll the map the kill path actually releases. engine.js has its own copy
    // reaching in from outside for the restart paths; this one exists so the
    // electron-free manager can wait without an injected seam.
    async _waitForExit(name, timeoutMs = 8000) {
      const start = Date.now();
      while (this.sessions.has(name) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return !this.sessions.has(name);
    }

    // kill() PLUS the worktree the record names. Every route that ends a seat
    // for good must come through here, never `kill()` directly: `kill()` drops
    // the persistence record, and that record is the only pointer to the
    // checkout — so a caller that kills without removing the tree first orphans
    // it irrecoverably, along with whatever unmerged commits its branch carries.
    //
    // NOT folded into kill() itself: the restart paths (engine.js) kill and
    // recreate the same seat, and destroying its checkout there would delete the
    // tree out from under a session that is coming right back.
    //
    // Captured BEFORE the kill and removed AFTER the pty exits, so git is not
    // racing a live cwd.
    //
    // A seat that has ALREADY exited still gets its record dropped here, and
    // that is this method's own drop, not kill()'s: kill() returns at `if (!s)`
    // before its `remove()`, so on a dead seat the tree went and the record
    // naming it stayed — a record pointing at nothing. Widened HERE rather than
    // in kill() because the restart paths call kill() on purpose to recreate the
    // same seat, while all three destroy() callers mean gone for good.
    //
    // That drop is placed PER RETURN, never once up front: destroy() must not
    // return having dropped the record while the tree it named still stands.
    // Dropping first is the same irrecoverable orphan the header forbids — a
    // failed `removeWorktree` would leave a checkout on disk with nothing naming
    // it. So the two safe returns call it and the failure return deliberately
    // does not.
    async destroy(name) {
      const entry = getPersistence().get(name);
      const worktree = entry && entry.worktree && entry.worktree.path ? entry.worktree : null;
      const wasLive = this.sessions.has(name);
      // clearHintForRecord BEFORE remove, for the reason its own header gives:
      // this is an exit with no live session to read `spawnerHintSet` off, the
      // hint table has no TTL, and the record is the last place the route id
      // exists. Both are no-ops once kill() has already dropped the record, so
      // this is a live seat's second call, not a double drop.
      const dropRecord = () => {
        if (wasLive) return;
        this.clearHintForRecord(name);
        getPersistence().remove(name);
      };
      await this.kill(name);
      // No tree to lose, so nothing can strand: this is the r1 case the drop
      // exists for, and it must keep dropping.
      if (!worktree) { dropRecord(); return { ok: true }; }
      await this._waitForExit(name);
      const r = await gitWorktree.removeWorktree(worktree.path).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) {
        dropRecord();
        log.info('worktree', `removed ${worktree.path} (branch ${worktree.branch}) after destroying ${name}`);
        return { ok: true, worktreeRemoved: true };
      }
      const error = (r && r.error) || 'unknown error';
      log.info('worktree', `remove failed for ${worktree.path} after destroying ${name}: ${error}`);
      // NO dropRecord() here, and that is the invariant, not an omission: the
      // tree is still on disk and this record is the only thing naming it. The
      // path rides the result so the caller's failure sentence can tell the
      // operator what to remove by hand.
      return { ok: true, worktreeRemoved: false, error, path: worktree.path };
    }

    async archive(name) {
      const s = this.sessions.get(name);
      if (!s) return;
      log.info('session', `archive ${name} pid=${s.pty.pid}`);
      this._notifyComposition(s, 'archived');
      getPersistence().setArchived(name, true);
      s._archived = true;
      try { s.pty.kill(); } catch {}
      setTimeout(() => { sigkillPid(s.pty.pid, name, log); }, 5000);
    }

    // The exits that DROP a record run without a live session, so they cannot read
    // `spawnerHintSet` off it — hence the persisted mirror. Dropping the record is
    // the last moment the route id is knowable, and the hint table has no TTL, so a
    // row not cleared here is permanent. Gated on the seat having set the override
    // itself: a blind clear would also wipe one an operator set out-of-band through
    // /_hint, which is supported pre-launch arm config.
    clearHintForRecord(name) {
      const entry = getPersistence().get(name);
      if (!entry || entry.spawnerHintSet !== true || !entry.proxyAgent) return;
      const base = resolveProxyBase(entry.proxy ?? null, getUiSettings());
      if (!base) return;
      try {
        ProxyClient.spawnerHint(base, entry.proxyAgent, { clear: true })
          .catch((e) => log.warn('session', `spawner-hint(clear) ${entry.proxyAgent} failed: ${e.message}`));
      } catch (e) {
        log.warn('session', `spawner-hint(clear) skipped: ${e.message}`);
      }
    }

    // The team half of realIpc. Extracted from create() so refreshPrompt() can
    // rebuild the SAME bytes: a second copy of this assembly would drift, and the
    // drift would show up as a permanent phantom delta (refresh bakes A, the next
    // create() bakes B, every spawn diffs them forever).
    //
    // Deliberately NOT cached across calls. The re-resolution BUYS something: an
    // edit to team.json or to a role prompt lands at the seat's next context reset
    // instead of waiting for a respawn. A later "optimization" that memoizes this
    // per session is trading that property for a few ms of disk reads.
    _teamBlockFor(name, cwd, agentType, systemPromptFile) {
      let teamBlock = '';
      let teamName = null;
      let resolvedTeam = null;
      // The one visibility rule's spawn-path half: a role prompt that resolves to
      // nothing is REPORTED to the caller and the spawn proceeds. Returned rather
      // than warned here, because each caller has a different party who can act on
      // it (the spawning lead, the ticket dispatcher, the operator's toast) and a
      // main-process log is where a real error goes to hide.
      let missingPrompt = null;
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
            if (def && def.prompt) {
              // Resolved on BOTH arms. When the prompt rides as
              // --system-prompt-file this method appends nothing and the stem is
              // resolved instead by resolveSystemPromptFile at prompt-build time
              // — where a miss returns null and the seat boots with NO system
              // prompt at all, strictly worse than unbriefed and reported by
              // nobody. Same path both resolvers use, so one read answers for
              // both; a present-but-empty file is NOT a miss.
              const promptFile = path.join(REGISTRY_DIR, 'library', 'prompts', 'system', `${def.prompt}.md`);
              let rolePrompt = null;
              try { rolePrompt = fs.readFileSync(promptFile, 'utf-8'); }
              catch { rolePrompt = null; }
              if (rolePrompt == null) {
                missingPrompt = promptRidesAsSystem
                  ? `role "${role}" names system prompt "${def.prompt}", which is not installed under library/prompts/system — ${name} boots with NO system prompt`
                  : `role "${role}" names prompt "${def.prompt}", which is not installed under library/prompts/system — ${name} boots unbriefed`;
              } else if (!promptRidesAsSystem && rolePrompt) {
                teamBlock = `${teamBlock}\n\n${rolePrompt}`;
              }
            }
          }
        } catch { /* resolution is best-effort — never block a spawn on it */ }
      }
      return { teamBlock, teamName, resolvedTeam, missingPrompt };
    }

    // The bytes that BECOME run/<name>/append-prompt.md, from ONE recipe.
    //
    // create() and refreshPrompt() must agree byte-for-byte, and a second copy of
    // this assembly does not merely risk drift — it PERMANENTLY corrupts the
    // cache. refreshPrompt bakes with reuse=false, which writes its result into
    // session.md; if those bytes differ from what create() would build, every
    // later spawn diffs recipe-against-recipe and stages a delta describing a
    // change that never happened. It also disarms the `realIpc === session.md`
    // no-op guard, so a --fork-session (mint ⇒ reuse=false, already fresh-baked,
    // inheriting the parent's warm cache) eats a full rewrite instead of a no-op.
    //
    // The recipe is CAPTURED at create() onto the live session rather than
    // re-derived from the persistence entry: `extraArgs` and the resolved
    // `CLODEX_DISABLE_IPC_PROMPT` decision are spawn-time inputs that the entry
    // does not carry in the form used here, and re-deriving them is how the two
    // halves diverged in the first place. Only `teamBlock` is passed separately,
    // because it is the ONE part that is deliberately re-resolved per refresh
    // (see _teamBlockFor) and create() already computed it for other uses.
    _realIpcFor(recipe, teamBlock) {
      const ipcPrompt = recipe.ipcDisabled
        ? ''
        : buildIpcPrompt(recipe.intents, this._resolveExecDefs(recipe.execCommands),
          pluginGrammarLines(recipe.intents, recipe.plugins));
      const { cleaned, append } = mergeClaudeSystemPrompt(recipe.extraArgs, ipcPrompt, {
        appendBodies: readAppendBodies(recipe.appendPromptFiles),
        inlineBody: recipe.inlineBody,
        hasSystemFile: recipe.hasSystemFile,
      });
      return { cleaned, realIpc: teamBlock ? `${append}\n\n${teamBlock}\n` : append };
    }

    // Rewrite a LIVE session's append-prompt.md from current truth, at a moment
    // where doing so is free. The CLI watches this file and busts its prompt cache
    // when it changes — which is the whole reason the three-file freeze exists — so
    // this may ONLY be called where there is no warm cache left to lose:
    //   * clear  — the conversation is gone; nothing to protect.
    //   * compact — called AFTER the summary lands and BEFORE the continuation is
    //               injected, so the rewrite rides the bust the compact already paid.
    // Calling it anywhere else re-bills the whole context (measured 111k-139k).
    //
    // --fork-session reaches the clear site warm (a fork mints a sid), and is safe
    // only because mint=true baked seconds earlier, so the no-op guard holds. That
    // guard is load-bearing, not redundant.
    //
    // Writing the file is only half: session.md must advance with it or the next
    // spawn re-bakes the OLD bytes and stages a phantom delta, and notified.md must
    // advance too or the agent is handed a diff describing what it is already
    // reading. bakePrompt(reuse=false) does all three in one atomic-enough step,
    // which is why this reuses it rather than writing the file directly.
    refreshPrompt(name, why) {
      const session = this.sessions.get(name);
      if (!session || session._dead || session.agentType !== 'claude') return false;
      const entry = getPersistence().get(name);
      if (!entry) return false;
      // No captured recipe = this session predates the capture (spawned by an
      // older build and still live across an app upgrade). Refusing is the only
      // safe answer: rebuilding from the persistence entry is exactly the second
      // recipe _realIpcFor exists to delete, and it would write divergent bytes
      // into session.md permanently. The seat keeps its frozen prompt until its
      // next respawn, which captures one.
      if (!session.promptRecipe) {
        this._shadowLog({ type: 'prompt-refresh-skipped', agent: name, reason: 'no-recipe' });
        return false;
      }
      try {
        const promptPath = pathFor(REGISTRY_DIR, name, 'appendPrompt');
        if (!fs.existsSync(promptPath)) { // no baked prompt = nothing this seat reads
          this._shadowLog({ type: 'prompt-refresh-skipped', agent: name, reason: 'no-prompt-file' });
          return false;
        }
        // This path takes the finding too. Refresh RE-RESOLVES on every
        // clear/compact, so a prompt file deleted after the seat booted first
        // bites here: the rebake drops the role prompt and the seat comes out of
        // its reset unbriefed. There is no reply channel at a clear, so it rides
        // the ipc-message the refresh already broadcasts.
        //
        // In practice this covers the APPEND arm only. Do not restructure the
        // refresh to force a broadcast on the other arm: the `already current`
        // guard is what keeps a clear/compact from re-baking identical bytes
        // under a live CLI.
        const { teamBlock, missingPrompt } = this._teamBlockFor(name, entry.cwd, session.agentType, entry.systemPromptFile || null);
        const { realIpc } = this._realIpcFor(session.promptRecipe, teamBlock);
        if (realIpc === readCache(REGISTRY_DIR, name, 'session')) return false; // already current
        const baked = bakePrompt(REGISTRY_DIR, name, realIpc, false);
        // tmp + rename: create() writes this path before the PTY exists, but here
        // the CLI is live and watching it. A partial read bakes a truncated system
        // prompt that no later refresh repairs (the guard above sees session.md
        // already current).
        const tmp = `${promptPath}.tmp.${process.pid}.${Date.now()}`;
        try {
          fs.writeFileSync(tmp, baked, { mode: 0o600 });
          fs.renameSync(tmp, promptPath);
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch {}
          throw e;
        }
        log.info('prompt', `refreshed ${name} (${why}) — ${baked.length} bytes`);
        this._broadcast('ipc-message', {
          type: 'context', from: name, to: name,
          body: `prompt refreshed (${why})${missingPrompt ? ` — ${missingPrompt}` : ''}`,
        });
        return true;
      } catch (e) {
        this._shadowLog({ type: 'prompt-refresh-error', agent: name, error: e.message });
        return false;
      }
    }

    teamNameFor(cwd) {
      if (!cwd) return null;
      try { const t = resolveTeam(cwd); return t ? t.name : null; } catch { return null; }
    }

    // The ONE board key / live-seat scope derivation. Team-first: when a
    // team owns the cwd its root is returned unchanged, byte for byte, so the
    // team path never moves boards. Only a teamless cwd falls through to the
    // repo root.
    //
    // Every ticket handler funnels through this rather than reaching for
    // `team.root` or `findProjectRoot` directly. A second ad-hoc derivation is
    // how a solo session and a team'd session in the same repo end up on
    // different boards — each correct read alone, and neither visible to the
    // other.
    _projectRootFor(cwd) {
      let team = null;
      try { team = resolveTeam(cwd); } catch { team = null; }
      if (team) return team.root;
      try { return findRepoRoot(cwd, { fs }); } catch { return null; }
    }

    // A stand-in "team" for a session no team.json owns, in the shape the verbs
    // already read — so the solo case is a different VALUE, not a second code
    // path through seven handlers.
    //
    // `lead` is the sender: solo has exactly one actor, so every lead-only gate
    // becomes a no-op rather than a refusal. `roles` is null, which makes the
    // role machinery inert by construction — `matchSeatRole` and
    // `_ticketDispatchMode` both bail on a falsy `roles`. `solo` marks the
    // context for the three dispatch helpers that must NOT run here.
    // Returns null outside a git repo — the caller turns that into the refusal.
    _soloContext(session) {
      const root = this._projectRootFor(session && session.cwd);
      if (!root) return null;
      return { name: path.basename(root), root, lead: session.name, roles: null, solo: true };
    }

    // `{ name, label }` — the warmth label is computed here, not in
    // team-manifest: that module is a pure leaf and warmth is a wire-layer
    // property (proxy snapshot + activity state), so it crosses as data.
    _teamLiveSeats(teamRoot) {
      const seats = [];
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        // `_projectRootFor`, not `findProjectRoot`: the latter is team-derived and
        // answers null for a teamless session, which would leave a solo board with
        // no live seats at all and make `[agent:task assign]` unable to name one.
        let root; try { root = this._projectRootFor(s.cwd); } catch { root = null; }
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

    // `entry` with `worktree` removed IFF a DIFFERENT LIVE seat now holds that
    // checkout; `entry` untouched otherwise, and untouched on any throw. Every
    // path that writes a PRE-KILL snapshot back after a restart must run its
    // entry through this — the success path via _preserveAcrossRestart, and all
    // three failure paths (engine.js restartSession / applySessionArgs, the
    // [agent:context reload] intent), whose catch arms re-upsert the snapshot
    // wholesale. The catch arms are not a lesser case: the window is held open by
    // a CLI slow to die, and a CLI slow enough to hold it past waitForSessionExit's
    // 8s is precisely the one whose restart then throws.
    //
    // THE WINDOW. kill() removes the record synchronously and the seat leaves
    // this.sessions only at pty exit, so for the whole waitForSessionExit poll a
    // restarting seat is live in its tree and named by no record — invisible to
    // _ticketTreeHolder, which reads occupancy off the RECORD. A re-dispatch
    // landing there reuses the tree, claimTree finds no record to clear, and
    // writing the snapshot back then puts a SECOND record on it: session:kill
    // removes the tree named by whichever row is deleted, so Delete Session… on
    // the restarted seat force-removes the checkout the other seat is committing
    // in.
    //
    // ONE READER. _ticketTreeHolder is the same question the dispatch asked when
    // it decided the tree was free, so this guard cannot disagree with the
    // hand-off it is reacting to. A second scan — here or in engine.js — would be
    // a second source of truth about who holds a tree.
    //
    // The other seat must be LIVE. A stale pointer from an ARCHIVED seat is
    // expected state on a real board (archive KEEPS the record), and stripping
    // for one would drop the pointer on an ORDINARY restart — landing in the
    // ABSENT state ALWAYS_PRESERVE calls the dangerous one.
    //
    // `holder !== name` and NOT `holder != null`, and the difference is reachable:
    // on the catch arms create() can have SUCCEEDED and a later step thrown, which
    // leaves the seat live with a rebuilt record already naming the tree, so the
    // holder this resolves is the seat's OWN name. Stripping there would delete a
    // pointer nothing else holds.
    //
    // Stripping is safe precisely BECAUSE a different live seat holds it: that
    // seat's record still names the checkout, so nothing is orphaned. On any
    // throw we keep it, because stale beats absent.
    _stripClaimedTree(entry) {
      if (!entry || !entry.name || !entry.worktree || !entry.worktree.path) return entry;
      if (typeof this._ticketTreeHolder !== 'function') return entry;
      let holder = null;
      try { holder = this._ticketTreeHolder(entry.worktree.path); } catch { return entry; }
      if (!holder || holder === entry.name) return entry;
      if (log) log.info('session', `restart of ${entry.name}: dropping worktree ${entry.worktree.path} from the restored record — ${holder} holds it now`);
      // Copy-and-delete rather than a `{ worktree, ...rest }` destructure: the
      // free-identifier scanner does not model an object rest binding and reads
      // `rest` as a dangling reference. Not worth whitelisting a name in a guard
      // that catches real extraction bugs to buy one line of style.
      const stripped = { ...entry };
      delete stripped.worktree;
      return stripped;
    }

    // Re-seed post-create persistence fields across a kill()+create restart. The
    // APP-RELAUNCH restore path keeps the persistence record, so create()'s
    // existingEntry carries these fields. But the IN-PLACE restart paths
    // (engine.restartSession / applySessionArgs) route through kill(), which
    // REMOVES the record — so create() rebuilds it from spawn args ONLY, dropping
    // any field seeded AFTER create on the prior spawn: `rosterSentAt` (re-injects
    // the roster into a --resume'd context) and a reviewer seat's
    // `ephemeral`/`reviewFor` (review-done can no longer route/retire).
    // Re-seeding AFTER create() is too late for the fields create() itself reads,
    // so the restart callers capture the pre-kill entry and call this AFTER kill,
    // BEFORE create; create's own upsert then spread-merges the full record over
    // this stub. A prior entry lacking a field seeds nothing for it.
    //
    // ALWAYS_PRESERVE is carried whether or not a caller names it: `sessionIds` is
    // the seat's session_id HISTORY, which is what the cost panel sums a name's
    // whole spend over. Only setSessionId appends to it, and only on a CHANGE, so
    // an array dropped here never regrows — the seat's lifetime cost silently
    // restarts from the current id. All three callers omitted it, so the invariant
    // lives in the helper, not in its callers.
    _preserveAcrossRestart(name, priorEntry, fields) {
      if (!priorEntry || !Array.isArray(fields)) return;
      let seed = { name };
      for (const f of [...fields, ...ALWAYS_PRESERVE]) {
        if (priorEntry[f] !== undefined) seed[f] = priorEntry[f];
      }
      seed = this._stripClaimedTree(seed);
      // Counted AFTER the strip, not tracked while seeding: a seed reduced to a
      // bare { name } must not manufacture a record for a seat that had nothing
      // else to preserve — that would hand create() an existingEntry and suppress
      // the roster inject, which is the failure the `any` guard has always been
      // about.
      if (Object.keys(seed).length <= 1) return;
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
      if (session._dead) return;
      const team = session._pendingRoster;
      if (team) {
        session._pendingRoster = null;
        try {
          // Stamped from the WRITE, not the enqueue: `rosterSentAt` is read back by
          // _maybeInjectComposition to suppress the roster for the seat's whole life,
          // so a stamp taken here can suppress a roster that was never delivered.
          // The gap is real even though this path has no ready gate (the roster is
          // codex-only and `ready` is installed for claude): the delivery rides a
          // promise chain, then the quiet gate, and an inject hold parks it for up to
          // INJECT_HOLD_TIMEOUT — all inside the boot window this function runs in,
          // where a seat that dies early hits the _dead early-returns instead.
          // Same shape as the deliveredTo bug.
          this._deliverMessage(session.name, 'team', formatRoster(team, this._teamLiveSeats(team.root), { seat: session.name }), 'dm',
            '', () => this._markRosterSent(session));
        } catch (e) {
          log.error('inject', `roster flush failed for ${session.name}: ${e.message}`);
        }
      }
      // AFTER the roster, and outside its guard: a RESUMED seat has no pending
      // roster (_maybeInjectComposition skips it on rosterSentAt) and is precisely
      // the seat whose tickets need replaying, so an early return on `!team` would
      // skip the replay in the only case it matters.
      this._replayTicketsOnce(session);
    }

    _notifyComposition(session, verb) {
      if (!session || !session.agentType) return;
      let team;
      try { team = resolveTeam(session.cwd); } catch { return; }
      if (!team) return;
      const role = matchSeatRole(team, session.name);
      const body = formatCompositionDelta(team.name, verb, { seat: session.name, role });
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead || s.name === session.name) continue;
        if (s._bootSettling) continue;   // still booting (codex) → drop the delta (harmless-miss contract)
        let root; try { root = findProjectRoot(s.cwd); } catch { root = null; }
        if (!root || root !== team.root) continue;
        // The DM goes to the LEAD ALONE. Who else is up is the lead's dispatch
        // problem; a hand, reviewer or designer cannot act on the news that a
        // sibling restarted, so delivering it to them is a pure interruption —
        // it wakes a working seat and costs a turn of its context to say nothing
        // it can use. This is unconditional: it does NOT depend on whether the
        // seat that changed was ephemeral. Relevance is a property of the
        // RECIPIENT, not of the subject.
        if (s.name === team.lead) this._deliverPassive(s.name, 'team', body, 'dm');
        // The re-bake stays for EVERY seat, and that is why it sits outside the
        // guard above. The delta rides conversation history and dies with the
        // next context reset; re-baking is what makes this seat's NEXT boot
        // carry the changed composition instead of the one it was minted with.
        // Folding it into the lead-only branch would leave every other seat
        // booting a stale roster — silently, since nothing reads it back.
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
      const ticketsByRoot = new Map();
      // Memoized like the two above, and for a sharper reason: this runs per
      // (session × ticket), and _teamLiveSeats rebuilds a peerStatusLabel and a
      // proxy-poller snapshot for every live seat on each call.
      const liveByRoot = new Map();
      const liveSeatsFor = (t) => {
        if (!liveByRoot.has(t.root)) liveByRoot.set(t.root, this._teamLiveSeatNames(t.root));
        return liveByRoot.get(t.root);
      };
      // Which manifest role a seat holds. Memoized per session, and the ONE place
      // this row resolves it: the renderer cannot compute it (matchSeatRole strips
      // an `-r<N>` review tail then a numeric one, guards its lookup with
      // hasOwnProperty, and short-circuits on the lead pointer), and a second copy
      // in a second process is the divergence this codebase keeps paying for.
      const roleByName = new Map();
      const roleFor = (s) => {
        if (roleByName.has(s.name)) return roleByName.get(s.name);
        let role = null;
        try {
          const t = resolvedTeamFor(s.cwd);
          role = t ? matchSeatRole(t, s.name) : null;
        } catch { role = null; }
        roleByName.set(s.name, role);
        return role;
      };
      const openTicketFor = (s) => {
        try {
          const t = resolvedTeamFor(s.cwd);
          if (!t || !t.root) return null;
          if (!ticketsByRoot.has(t.root)) ticketsByRoot.set(t.root, ticketsStore.load(t.root));
          // The shared helper, not a second matchSeatRole call: the ticket badge
          // and the row's `role` must not be able to disagree about which role a
          // seat holds.
          const role = roleFor(s);
          const live = liveSeatsFor(t);
          // Same filter as _reconcileTickets: this is the badge on first paint
          // and that is the badge on every change, so a term here that is
          // missing there shows a ticket until the next reconcile and then
          // drops it.
          const open = ticketsByRoot.get(t.root).find((tk) => tk.state === 'open' && tk.assignee != null && !tk.parked
            && (tk.assignee === s.name || tk.assignee === role
              || this._ticketAssigneeSeat(t, tk, live) === s.name));
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
        // Non-agent (bash) sessions are null by construction, not by omission: a
        // bash session has no registry entry and no socket, so it cannot hold a
        // role, and this must not become a second place that decides that.
        role: s.agentType ? roleFor(s) : null,
        ticket: s.agentType ? openTicketFor(s) : null,
        backend: s.backend || null,
        noWire: !!s.noWire,
        activity: s.activityState || 'idle',
        attention: s.needsAttention ? s.needsAttention.kind : null,
        pendingCount: s.agentType === 'claude' ? countPending(PENDING_DIR, s.name) : 0,
      }));
    }

    listForWorkspace(workspaceId) {
      return this.list().filter(s => s.workspaceId === workspaceId);
    }

    // Workspace teardown runs over PERSISTENCE, not over the live map.
    // listForWorkspace above filters list(), which maps `this.sessions`. An
    // archived session is never spawned by design, so it is never in that map:
    // killing what listForWorkspace returns and then dropping the workspace record
    // leaves persistence rows carrying a workspaceId no window will ever carry
    // again. Those rows are then unreachable from every surface — every IPC
    // listing is workspace-scoped, and discovery excludes any conversation whose
    // sessionId is in trackedSessionIds(), which unions in the orphan itself.
    // Hence the two methods below: one to SEE that population, one to reap it.

    // The rows a workspace holds that listForWorkspace cannot see: archived, or
    // saved-but-not-running. This is the count the confirm dialog needs — it is
    // exactly the population whose total loss the dialog used to call "empty".
    savedForWorkspace(workspaceId) {
      return getPersistence().listForWorkspace(workspaceId).filter(e => e && e.name && !this.sessions.has(e.name));
    }

    // Kill the live seats, then drop every persisted row still pointing at the
    // workspace. Order matters only for economy: kill() removes its own record
    // synchronously (nothing awaits before it), so the second pass sees only
    // what the first could not reach. clearHintForRecord before remove, for the
    // reason sweepReviewerGraveyard does it — dropping the record is the last
    // moment the seat's proxy route id is knowable and the hint table has no TTL.
    purgeWorkspace(workspaceId) {
      const killed = [];
      for (const s of this.listForWorkspace(workspaceId)) { killed.push(s.name); this.kill(s.name); }
      const dropped = [];
      for (const e of getPersistence().listForWorkspace(workspaceId)) {
        if (!e || !e.name) continue;
        this.clearHintForRecord(e.name);
        getPersistence().remove(e.name);
        dropped.push(e.name);
      }
      if (dropped.length) {
        log.info('session', `workspace ${workspaceId}: dropped ${dropped.length} saved/archived record(s): ${dropped.join(', ')}`);
      }
      return { killed, dropped };
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
    // can't emit a complete signal. A count returning to 0 drops the map entry so
    // the map tracks only non-zero sessions. Claude-only: the store is a
    // Claude-hook artifact (codex never parks).
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
      clearTimeout(s._replayFallbackTimer);
      clearTimeout(s._parkedDrainFallbackTimer);
      clearTimeout(s._rebootNoticeRetryTimer);
      clearTimeout(s._rebootNoticeFlushTimer);
      clearTimeout(s._specConfirmTimer);
      // The displaced-spec drain owns its own timer rather than borrowing
      // _specConfirmTimer: the two are live at the same time by construction (the
      // drain waits for the latch to resolve), so one field could not hold both.
      clearTimeout(s._specOwedTimer);
      clearTimeout(s._dmConfirmTimer);
      clearTimeout(s._reviewStartTimer);
      // Drops the pending debounce timer with it — a hint armed after the PTY
      // died would ride the next session under the same name. The offer
      // cooldown goes too: a retired seat's name is reused by its replacement,
      // and the replacement must not start life already suppressed.
      try { arm.forget(name, name); } catch {}
      // Same hazard, sharper, and it does not stop at the memo: _armCtx falls
      // back to a NAME GLOB when the exact route is unknown, so a dead seat's
      // ATTACHMENT still matches its same-named replacement for the rest of its
      // 1800s TTL. Passing the dying session's ctx is what lets forget take the
      // registration off the proxy rather than only forgetting it here.
      try { selectionArm.forget(name, this._armCtx(s)); } catch {}
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
      // AFTER the watcher stop, and the order is the whole of it: stop() calls
      // _flushPending(), which re-enters _maybeSpeak and can START a narration.
      // Stopping the speaker first therefore leaves a dead seat talking, which
      // is the case this call exists to prevent.
      //
      // Unconditional — the speaker is box-wide and cannot attribute an
      // utterance to a session, so the alternative is leaving a dead seat's
      // voice playing.
      if (s.watcher) s.watcher.stop();
      try { speaker.stop(); } catch {}
      if (s.sentinel) { try { s.sentinel.stop(); } catch {} }
      if (s.ctxWatcher) { try { s.ctxWatcher.close(); } catch {} }
      if (s.transport) s.transport.stop();
      if (s.agentType) registry.unregister(name);
      if (s.agentType === 'claude') { cleanupClaudeHook(name); cleanupSkillPlugin(name); cleanupAgentPlugin(name); }
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

    // One subagent turn into the session's ring. Observer-grade: this runs from
    // the wire tee's turn.completed, which the proxy emits only AFTER the client's
    // final byte, so a throw here cannot reach the request.
    //
    // ACCEPTED MISATTRIBUTION WINDOW: RoleClassifier's per-session fingerprint map
    // is empty on a fresh Clodex process, so until the first main-line turn
    // establishes it, the documented cc_is_subagent leak (a parent turn carrying a
    // recycled x-claude-code-agent-id) can file ONE parent turn as a subagent row
    // here. It is self-clearing and deliberately not gated: do not "fix" a
    // misattributed row by weakening genuineSubagent's fingerprint backstop — that
    // trades a cosmetic, one-turn artefact for the leak the backstop exists to
    // catch.
    //
    // The key must stay byte-identical to wirescope's instance key (agent-id
    // verbatim, role as fallback): the feed is looked up by the chip's key, so a
    // mismatch shows an empty feed for a live subagent rather than failing.
    _noteSubagentTurn(session, t) {
      try {
        if (!session.subagentStore) return;
        noteSubagentTurn(session.subagentStore, {
          key: t.agentId || t.role,
          role: t.role,
          model: t.model,
          text: t.text,
          // Separate field, deliberately: `text` is the only one that reaches
          // the intent scanner, and merging the two here would make an agent
          // reasoning about an intent fire it.
          thinking: t.thinking,
          tools: t.toolUses,
          truncated: t.truncated,
          thinkingTruncated: t.thinkingTruncated,
          ts: Date.now(),
        });
      } catch { /* observer-grade — never near the PTY/intent path */ }
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

    _emitActivity(name, state, notify) {
      const s = this.sessions.get(name);
      if (s && s.activityState !== state) {
        // Not Date.now(): the gap-idle and post-sweep transitions are this
        // process INFERRING quiet from a timer, and stamping them "now" reports
        // the seat as fresher than its last real event by up to
        // INFLIGHT_MAX_AGE_MS — a long-cold seat reads as minutes idle and its
        // dm is delivered instead of held. Identity on wire-driven edges (the
        // tracker just stamped the same ts); falls back to now for jsonl-source
        // sessions, whose transitions arrive from JsonlWatcher and have no wire
        // event at all — the two watcher families are disjoint by construction.
        // The fallback does not threaten a wire session's restore seed only
        // because a wire session cannot reach a transition without a counted
        // event having set lastEventTs first: reachability, not Math.max.
        s.activityState = state;
        s.activityTs = Math.max(s.activityTs || 0, this._activity.lastEventTs(name) || Date.now());
        if (typeof scheduleTrayRefresh === 'function') scheduleTrayRefresh();
      }
      if (s && state !== 'idle') s.lastMainStop = null;
      // A turn started — but a turn confirms THIS write only if this write caused
      // it, and on a fresh seat it frequently did not: a spec injected at spawn+1s
      // and wiped by the boot re-render, an unrelated roster park draining 12s
      // later, and the turn the seat took to READ THE ROSTER cleared the spec
      // latch. The record said delivered and the seat held nothing.
      //
      // So the turn is ATTRIBUTED before it clears anything: the transcript records
      // what the CLI actually consumed, and the dispatch names its ticket id on the
      // pointer line. Absent ⇒ the seat turned for something else and is still
      // owed its spec, so the latch stays armed and its deadline redelivers.
      //
      // This edge can RACE the transcript rather than following it. For a
      // jsonl-routed seat the edge is derived from the transcript, so a consumed
      // spec is already on disk; but a WIRE-routed seat gets its activity from wire
      // `turn.started` alone, which can arrive before the CLI has appended the user
      // message. The race is one-sided and lands on the safe side: it leaves the
      // latch armed over a delivered spec, and _checkSpecConfirm re-probes at the
      // deadline, so the worst case is a check, not a spurious redelivery.
      //
      // Bounded fs work despite sitting in the hot path: gated on a latch that is
      // set only inside the 90s window after a dispatch.
      if (s && state !== 'idle' && s._specUnconfirmed) {
        const u = s._specUnconfirmed;
        // Anchored at the byte the transcript had reached when this write went out:
        // a respawned seat's transcript already holds this ticket's marker from the
        // incarnation that died, and an unanchored match would attribute every turn
        // to it. null (no transcript, unreadable link, nothing new) trusts the turn,
        // as before: the probe must never manufacture a redelivery out of its own
        // blind spot.
        const has = this._seatTranscriptHas(s.name, u.ticketId, u.since);
        if (has === false) {
          log.warn('inject', `${s.name} started a turn but ${u.ticketId} is absent from its transcript — not clearing the latch, the turn was something else`);
        } else {
          // An ATTRIBUTED turn is receipt, which ends this ticket's displacement
          // episode — the COMMON of the two receipt exits (the other is
          // _checkSpecConfirm's deadline re-probe, reached only when no turn
          // cleared the latch first).
          this._pruneOwedSpent(s, u);
          s._specUnconfirmed = null;
          clearTimeout(s._specConfirmTimer);
          s._specConfirmTimer = null;
        }
      }
      // Same edge, same meaning, for the plain-dm latch — and it is a SEPARATE
      // field, so it inherits nothing from the spec latch above by construction.
      // That is why this line and the _cleanup entry each carry their own test.
      if (s && state !== 'idle' && ((s._dmUnconfirmed && s._dmUnconfirmed.length) || s._dmUnconfirmedLast)) {
        this._clearDmConfirm(s);
      }
      // Same edge, same meaning, for a reviewer's first turn. The check re-reads
      // `activityState` itself and would decline anyway, so this is the cheap arm
      // of a belt-and-braces pair: it stops a healthy review holding a timer for
      // its whole run, and it makes the disarm survive a seat that starts and
      // finishes inside the window (idle -> thinking -> idle), where the state read
      // at the deadline is idle again and only the transcript would say otherwise.
      if (s && state !== 'idle' && s._reviewStartTimer) {
        clearTimeout(s._reviewStartTimer);
        s._reviewStartTimer = null;
      }
      if (state !== 'idle') this._touchTicketActivity(name);
      if (s && state !== 'idle' && s.needsAttention) this._setAttention(s, null);
      if (s && state === 'idle') { this._maybeFlushInjectQueue(s); this._drainPendingAtIdle(s); }
      // `notify` is TURN-END, not merely idle, and the renderer needs that
      // distinction: two emitters produce `idle` MID-TURN — the wire tracker's
      // gap-idle timer when a tool runs long with nothing in flight, and the
      // jsonl watcher's 1s text flush between tool calls. A consumer that acts
      // on the state alone acts in the middle of turns.
      this._sendToSession(name, 'session-activity', name, state, !!notify);
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
      // answer for a dedup consumer, and on the jsonl-intent path this fires for
      // the CLI's own auto-compact too, because the watcher reads the transcript
      // rather than only knowing about compactions Clodex triggered. A wire-routed
      // seat reaches here only via _executeCompact's armCompact, so a CLI-initiated
      // auto-compact there does NOT land here.
      try { memLoad.noteCompact(session.name); } catch { /* observer-grade */ }
      // Same transition, different ledger. "Already in context" and "already
      // offered" are separate questions on purpose, so they reset side by side
      // here rather than one reading the other.
      try { arm.onContextReset(session.name); } catch { /* observer-grade */ }
      // The compact has landed and the continuation has NOT been injected yet:
      // this is the one instant where rewriting the prompt file is CHEAP — not
      // free, and the distinction bounds where this call may be copied to. The
      // cache breakpoint sits BEFORE the system block, so the rewrite still turns
      // a read hit on that whole segment into a write; it is ~10-20% of a
      // mid-conversation bust, affordable only because the compaction already
      // discarded everything after it. Later is not equivalent — the continuation
      // is the new conversation's first turn, and rewriting after it re-bills the
      // context it just built.
      try { this.refreshPrompt(session.name, 'compact'); } catch { /* never block the continuation on a refresh */ }
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
      // Mixed queue: plain texts and unclaimed producers, in arrival order. If any
      // entry is a producer the whole flush becomes one, so the claim still happens
      // at write time — joining eagerly here would re-introduce the eager claim on
      // the hold-release path specifically, which is the hardest one to notice.
      if (queue.some((e) => e && typeof e.produce === 'function')) {
        const produce = () => {
          const parts = [];
          for (const e of queue) {
            if (e && typeof e.produce === 'function') {
              let p = null;
              try { p = e.produce(); } catch { p = null; }
              if (p) parts.push(p);
            } else if (e) parts.push(e);
          }
          return parts.length ? parts.join('\n') : null;
        };
        this._injectText(session, '', { bypassHold: true, produce });
        return;
      }
      this._injectText(session, queue.join('\n'), { bypassHold: true });
    }

    // Claims LATE, like the boot-ready drain below. The eager version claimed here
    // and fire-and-forgot the inject, which is a silent loss whenever the write does
    // not happen: _drain returns without writing on every isDead() check, and the
    // parkable divert can re-park, so a seat dying between the claim and the write
    // dropped the messages with the files already deleted. The producer runs inside
    // the queue's critical section, so claim and write are the same instant.
    _drainPendingAtIdle(session) {
      if (!session || session.agentType !== 'claude' || session._dead) return;
      // Dictated as well as typed: with only the typed check here, a dictated
      // draft passed the guard, drainPending CLAIMED the files destructively, and
      // the divert then re-parked the joined text as ONE ACTIVE entry. No message
      // was lost, but a `.passive.` entry came back active — and a passive park
      // never earns a turn by design, so the promotion wakes a seat that should
      // have stayed quiet.
      if (this._anyDraftOpen(session)) return;   // don't splice an open draft
      if (!hasActivePending(PENDING_DIR, session.name)) return;
      this._injectText(session, '', {
        parkable: true,
        produce: () => {
          if (session._dead) return null;
          if (this._anyDraftOpen(session)) return null;
          let texts = [];
          try { texts = drainPending(PENDING_DIR, session.name, `idle.${process.pid}`, this._bornFor(session.name)); } catch { return null; }
          if (!texts.length) {
            log.debug('inject', `idle drain for ${session.name} claimed nothing — hook already drained it`);
            return null;
          }
          return texts.join('\n\n');
        },
      });
    }

    // Boot-ready-edge drain. Claims LATE, like every other drain: peek
    // (non-destructive) to decide whether to bother, then enqueue a fire-time
    // PRODUCER that does the destructive drainPending claim only once the InjectQueue
    // is past its ready + quiet gates and about to write. If the seat died or a draft
    // opened in the meantime the producer claims nothing and returns null — the
    // delivery stays parked, recoverable. Exactly-once holds: the claim is the same
    // atomic dir-rename the hook + idle drains use, so whoever fires first owns the
    // messages.
    _drainPendingAtBootReady(session) {
      if (!session || session.agentType !== 'claude' || session._dead) return;
      if (this._anyDraftOpen(session)) return;                     // don't splice an open draft
      if (!hasActivePending(PENDING_DIR, session.name)) return;    // nothing active — leave passives parked
      // Every bail here is a park that stays on disk EXCEPT the last one, where the
      // claim already succeeded and came back empty. Saying which is the difference
      // between "deferred" and "someone else took it", and the silence over both is
      // why a lost boot-window delivery left no evidence across seven reboots.
      const produce = () => {
        if (session._dead) return null;
        if (this._anyDraftOpen(session)) return null;
        let texts = [];
        try { texts = drainPending(PENDING_DIR, session.name, `boot.${process.pid}`, this._bornFor(session.name)); } catch { return null; }
        if (!texts.length) {
          log.debug('inject', `boot-ready drain for ${session.name} claimed nothing — another drainer won or every entry failed the born check`);
          return null;
        }
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
      // of this scan (no intent parse, no body boundary, no near-miss bounce).
      // Before this, an intent-shaped example inside a fence FIRED: a fence only
      // renders as a block; raw turn text keeps each line at column 1.
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

    _scanJsonlText(text, senderName, touches, meta) {
      const s = this.sessions.get(senderName);
      // Mirrors the publish gate directly below and for the same reason: a
      // wire-routed session with a live tee already spoke from turn.completed,
      // and speaking here too would say every reply twice. A tee-blind
      // (Bedrock/Vertex) session is wireRouted but never fires turn.completed,
      // so `!s.backend` is what keeps this its ONLY voice rather than none.
      if (!(s && s.wireRouted && !s.backend)) {
        this._maybeSpeak(senderName, text, !!(meta && meta.turnEnd));
      }
      // A wire-routed session running intentSource:'jsonl' (shadow mode) has
      // BOTH junctions live. Publishing here too would double-deliver every
      // turn deterministically, so the wire wins: it is already firing and
      // carries reads + a real turn-end signal this path cannot know.
      //
      // `!s.backend` is the load-bearing half. A tee-blind (Bedrock/Vertex)
      // session is ALSO wireRouted — the registration is kept and merely
      // ignored — but its bytes never traverse the tee, so turn.completed
      // never fires and this watcher is its ONLY junction. Discriminating on
      // wireRouted alone blanks the feed for it permanently.
      if (!(s && s.wireRouted && !s.backend)) {
        this._publishAgentText({
          session: senderName, text, source: 'jsonl', truncated: false,
          files: Array.isArray(touches) ? touches : [],
        });
      }
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

// The single door to the plugin turn-text feed. Consume-only, like every other
// plugin hook: a throw here lands in the wire's event handler, which also
// dispatches intents, so it must never escape. The engine owns the grant check
// and the setImmediate deferral — this side only decides WHAT is published and
// from WHERE.
    _publishAgentText(ev) {
      try {
        const hooks = getPluginHooks && getPluginHooks();
        if (!hooks || typeof hooks.fireAgentText !== 'function') return;
        // Nothing to say: 576 of 1359 measured requests carried no text at all
        // (pure tool calls). An event with neither text nor file touches is a
        // wake-up with no payload, paid by every subscriber.
        const hasFiles = Array.isArray(ev.files) && ev.files.length;
        const hasReads = Array.isArray(ev.reads) && ev.reads.length;
        if (!ev.text && !hasFiles && !hasReads) return;
        hooks.fireAgentText(ev);
      } catch { /* consume-only */ }
    }


    // Speak the agent's FINAL reply, when the operator asked to hear it.
    //
    // TURN-END IS THE WHOLE FEATURE. The caller supplies it from a source that
    // knows: the wire's `stop.is_turn`, or the transcript entry's own
    // `stop_reason` via isTurnEndEntry. Deliberately NOT the renderer activity
    // seam, whose `turnEnd` is `state === 'idle'` for jsonl sessions and so is
    // true on every inter-tool flush — reading it here would narrate after every
    // tool call, which is precisely what the operator asked not to happen.
    //
    // Off by default and read fresh per turn: the setting is a live toggle, so a
    // cached answer would keep talking after it was switched off.
    _maybeSpeak(name, text, turnEnd) {
      if (!turnEnd || !text) return;
      try {
        const s = this.sessions.get(name);
        if (!s || !s.agentType) return;
        const store = getUiSettings && getUiSettings();
        const cfg = store ? store.get() : null;
        if (!cfg || cfg.speakReplies !== true) return;
        // ONLY THE SEAT HOLDING CONTROL SPEAKS. speak() kills the previous
        // utterance rather than queueing it, so several seats narrating their
        // own turn ends complete NO reply between them.
        //
        // Do not reduce this to _micTarget alone. It is null on a box he
        // alt-tabbed away from before naming a seat, and the strict read
        // silences the feature outright there. Both null is nobody holding
        // control, and then nobody speaks.
        const holder = this._micTarget || this._focusedSession;
        if (!holder || name !== holder) return;
        // DO NOT TALK OVER A LIVE MICROPHONE. Read the BOX-WIDE stamp, never the
        // per-seat one: the recorder is reported only for the active seat, so
        // `s.lastVoiceRecordingTs` is undefined on every background seat and a
        // gate reading it would pass exactly when he is dictating into another
        // pane. The microphone and the speaker are both box-wide, and this reads
        // box-wide with them.
        //
        // Absent evidence reads as NOT recording, matching the inject gate's
        // polarity — the cost of a wrong "quiet" here is one narration he can
        // stop, while a deferral nothing releases would silence the feature
        // permanently.
        if (Date.now() - (this._lastVoiceRecordingTs || 0) < INJECT_SPEAKING_STALE_MS) return;
        const say = speakable(text);
        if (!say) return;
        speaker.speak(say, { voice: cfg.speakVoice, rate: cfg.speakRate });
      } catch { /* observer-grade: speech must never break turn handling */ }
    }


    async _handleIntent(senderName, intent) {
      const session = this.sessions.get(senderName);

      if (intent.type === 'end') return;

      if (intent.type === 'unknown') {
        if (session && session.agentType) {
          const more = intent.more ? ` (+${intent.more} more unrecognized [agent:…] lines this turn)` : '';
          // Seat-scoped: this list is written INTO the seat's context, so naming
          // a verb from a plugin the seat does not have would advertise that
          // plugin's existence to exactly the agents it is meant to be
          // invisible to.
          const seatPlugins = getPersistence().get(senderName)?.plugins;
          this._injectText(session,
            `[agent:?] unrecognized intent \`${intent.text}\`${more} — nothing was done. `
            + nearMissFormHint(intent.text)
            + `Valid intents: ${validIntentNames(seatPlugins).join(', ')}. `
            + 'To quote an intent literally, put it in a ``` code fence or escape it as \\[agent:…].', { parkable: true });
        }
        this._broadcast('ipc-message', {
          type: 'intent', from: senderName, to: senderName,
          body: `unrecognized intent bounced: ${intent.text}`,
        });
        return;
      }

      if (!intentEnabledForSeat(intent.type, getPersistence().get(senderName))) {
        if (session && session.agentType) {
          const msg = intent.type === 'resend'
            ? "the resend intent is disabled for this session — the message will deliver with the peer's next turn"
            : `the ${intent.type} intent is disabled for this session${this._deniedIntentPayload(session, intent)}`;
          this._injectText(session, `[agent:${intent.type}] ${msg}`, { parkable: true });
        }
        return;
      }

      switch (intent.type) {
        case 'dm': {
          const localTarget = this.sessions.get(intent.target);
          if (localTarget && localTarget.agentType) {
            // The ONE site where a live local sender exists to be told, which is
            // why the latch is armed from here and not from inside
            // _gatedDeliver — see _armDmConfirm.
            const r = this._gatedDeliver(intent.target, senderName, intent.body, intent.urgent === true, '',
              (disposition) => this._armDmConfirm(intent.target, senderName, disposition));
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
        case 'term': {
          if (!session || !session.agentType) break;
          this._handleTermIntent(session, intent.sub, intent.body || '');
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
      const preview = previewLine(text, 200);
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
        // "requested", not "happened": the stamp is written at QUEUE time, and the
        // restart may still be waiting for an all-idle window, or have been
        // cancelled/dropped without ever running — _rebootAbandoned deliberately
        // leaves the stamp behind so there is no rapid-retry window.
        reply(`rate-limited — a reboot was requested ${Math.round(sinceMs / 1000)}s ago; try again in ${waitS}s`);
        this._broadcast('ipc-message', { type: 'reboot', from: who, to: 'clodex', body: `REFUSED (rate-limited): ${reason || '(no reason)'}` });
        return;
      }

      try { store.set({ lastRebootAt: now, pendingRebootNotice: { name: who, at: now, reason } }); }
      catch (e) { log.error('intent', `reboot: settings write failed (proceeding): ${e.message}`); }
      this._broadcast('ipc-message', { type: 'reboot', from: who, to: 'clodex', body: `rebooting${reason ? `: ${reason}` : ''}` });
      log.info('intent', `reboot by ${who}${reason ? `: ${reason}` : ''}`);
      reply('reboot queued — restarting once every session is idle; sessions resume on relaunch');
      try {
        // The host decides WHEN. Under Electron the restart waits for a sustained
        // all-idle window, so this seat's own turn finishes and flushes first —
        // which means the wait can also be given up, and onAbandon is the only way
        // the seat hears about that.
        // `requester` is for the OPERATOR's give-up notification, not for this
        // seat: without it the desktop notice reads as the operator's own restart
        // failing, when in fact an agent they never asked armed it.
        //
        // `born` and `now` are captured HERE, not re-read in the callback: the
        // wait runs up to 30 minutes and only carries the name across, so both
        // ends of the abandon have to be able to tell this request from a later
        // one wearing the same name. Rate-limiting is 5 minutes, well inside the
        // wait, so a kill + same-name recreate is reachable, not theoretical.
        const born = this._bornFor(who);
        if (relaunchApp) relaunchApp({ requester: who, onAbandon: (why) => this._rebootAbandoned(who, why, born, now) });
      } catch (e) {
        log.error('intent', `reboot relaunch failed: ${e.message}`);
        reply(`relaunch failed: ${e.message}`);
        try { store.set({ pendingRebootNotice: null }); }
        catch (e2) { log.error('intent', `reboot notice clear failed: ${e2.message}`); }
      }
    }

    // A deferred reboot ended without restarting. Two things are now wrong and
    // both have to be undone: the seat is blocked on a relaunch that will never
    // come, and pendingRebootNotice would announce that restart on some later
    // launch.
    //
    // `why` is the host's reason and drives the ADVICE, which is opposite in the
    // two cases. 'cancelled' is a human pressing Cancel Pending Restart: telling
    // that seat to "ask again when work settles" turns the operator's no into an
    // invitation to re-arm the moment REBOOT_MIN_INTERVAL lapses, leaving them
    // cancelling the same restart on a loop. Anything else is the 30-minute cap.
    //
    // `born`/`at` identify THIS request across the wait; both guards below are
    // against a later request that the name alone cannot distinguish.
    _rebootAbandoned(who, why, born, at) {
      const cancelled = why === 'cancelled';
      const store = getUiSettings && getUiSettings();
      if (store) {
        try {
          const cur = store.get();
          const notice = cur && cur.pendingRebootNotice;
          // Only if it is still THIS REQUEST's notice. The name is not enough:
          // the later requester may BE this name — a same-name recreated seat, or
          // this same seat re-requesting once the 5-minute rate limit lapses —
          // and clearing then discards a pending restart that is still armed.
          // `at` is the request's own timestamp, already persisted in the record.
          const mine = notice && notice.name === who && (at == null || notice.at === at);
          if (mine) store.set({ pendingRebootNotice: null });
          else if (notice) log.info('intent', `reboot abandon by ${who}: notice left alone — it is not this request's`);
        } catch (e) { log.error('intent', `reboot notice clear failed: ${e.message}`); }
      }
      log.warn('intent', cancelled
        ? `reboot requested by ${who} CANCELLED by the operator`
        : `reboot requested by ${who} ABANDONED — sessions never settled`);
      this._broadcast('ipc-message', {
        type: 'reboot',
        from: 'clodex',
        to: who,
        body: cancelled ? 'reboot CANCELLED (operator)' : 'reboot DROPPED (sessions stayed busy)',
      });
      // The wait may have run for up to 30 minutes; the requester may be gone.
      // Re-resolve by name rather than holding the session object across it —
      // but a name is not an identity across that long a gap. A seat killed and
      // recreated under the same name resolves here, and the inject is parkable,
      // so it would land in the NEW seat's next prompt as a report about a
      // restart it never asked for. Same generation stamp the parked deliveries
      // use; null born means no expectation, so deliver.
      const live = this.sessions.get(who);
      if (!live) return;
      if (born != null && live.createdAt !== born) {
        log.info('intent', `reboot abandon by ${who}: inject SKIPPED — the live ${who} is a different seat than the requester`);
        return;
      }
      this._injectText(live, cancelled
        ? '[agent:reboot] reboot CANCELLED — the operator cancelled the pending restart. Nothing was restarted, and this is a decision, not a timeout: do not re-request it, ask them first.'
        : '[agent:reboot] reboot DROPPED — sessions stayed busy, so the restart was never taken. Nothing was restarted; ask again when work settles.',
        { parkable: true });
    }

    maybeDeliverRebootNotice(opts = {}) {
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

      // Both bounds are checked BEFORE attempting, not only after a throw: once
      // the retry below makes retention the normal outcome rather than the error
      // path, an unchecked notice would be re-offered at every launch for as long
      // as it existed. Age is the outer bound; attempts is the one that actually
      // ends a doomed notice.
      const priorAttempts = Number.isFinite(notice.attempts) && notice.attempts > 0 ? notice.attempts : 0;
      const noticeAge = Number.isFinite(notice.at) && notice.at ? Date.now() - notice.at : Infinity;
      if (noticeAge > REBOOT_NOTICE_MAX_AGE) {
        log.info('intent', `reboot notice for ${notice.name} DROPPED (stale >7d, ${priorAttempts} attempts)`);
        clear();
        return;
      }
      if (priorAttempts >= REBOOT_NOTICE_MAX_ATTEMPTS) {
        log.warn('intent', `reboot notice for ${notice.name} GIVEN UP after ${priorAttempts} attempts — never confirmed reaching the seat`);
        clear();
        return;
      }

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
      // An armed retry means an offer for THIS notice is already in flight, so a
      // second restore is not a second delivery opportunity — it only re-stamps an
      // attempt. restoreSessionsForWorkspace runs once per workspace, so a
      // two-workspace launch made two offers ~0.4s apart and the ladder burned to
      // its ceiling before its first rung elapsed. The budget is per notice, not
      // per restore — suppress the duplicate rather than widen the budget.
      //
      // Keyed on the in-flight timer, not a launch-scoped flag: at the ceiling no
      // timer is armed, and a later call must still reach the give-up-and-clear
      // above. `retry` marks the ladder's own re-offer, which is not a duplicate.
      if (!opts.retry && target && target._rebootNoticeRetryTimer) {
        log.debug('intent', `reboot notice for ${notice.name} already in flight (retry armed) — not re-stamping an attempt`);
        return;
      }
      if (target && target.agentType) {
        try {
          if (target.agentType === 'claude') {
            const finalText = this._buildDeliveryText(target, 'reboot', body, 'dm');
            parkDelivery(PENDING_DIR, notice.name, finalText, this._nextParkSeq(), null, false, this._bornFor(notice.name));
            this._armParkCap(target);
            this._armRebootNoticeFlush(target);
            // Park is a promise to deliver, not a receipt — so this branch does NOT
            // clear(). The settings copy is the only durable one, and clearing it
            // here destroyed it while the parked file was still undelivered: a
            // drain claims destructively (the claim renames the dir away) and its
            // pty.write can then evaporate into a booting CLI, leaving no copy
            // anywhere and no trace that anything was lost. Retention is what makes
            // a retry possible at all; the ceiling below is what keeps at-least-once
            // from becoming forever.
            this._armRebootNoticeRetry(target, notice);
            log.info('intent', `reboot notice parked for ${notice.name} (live claude — boot-safe, cap armed; retry armed, attempt ${(Number.isFinite(notice.attempts) ? notice.attempts : 0) + 1}/${REBOOT_NOTICE_MAX_ATTEMPTS})`);
            return;
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

    // The notice's dedicated deadline: give the polite drains their window, then
    // force the park out rather than inheriting the generic 5-minute cap.
    //
    // Scope note, deliberate: drainPending claims the seat's WHOLE park dir, so
    // anything else parked for this seat leaves early with the notice. Bounded by
    // one deferral round, NOT by REBOOT_NOTICE_FLUSH_MS: the re-arm below is
    // unbounded, so a chain that started at T+0 can still be alive minutes later
    // and sweep a DM parked just before it fires.
    _armRebootNoticeFlush(target, parkedAt = Date.now()) {
      if (target._rebootNoticeFlushTimer) return;   // one deadline per launch, earliest governs
      // Carried across a re-arm, NOT restamped: the turn check below asks "did the
      // seat wake since the PARK", and refreshing this on every round would keep
      // moving the line the turn has to beat, so a seat that woke during round 1
      // would look unwoken forever.
      const fire = () => {
        target._rebootNoticeFlushTimer = null;
        if (target._dead) return;
        // A turn since the park means a drain already ran and the seat processed
        // input — forcing here would splice for nothing. Same signal the retry
        // ladder uses, and the seeded spawn stop is excluded for the same reason.
        const stop = target.lastMainStop;
        if (stop && !stop.seeded && Number.isFinite(stop.ts) && stop.ts > parkedAt) {
          log.debug('inject', `reboot notice flush for ${target.name} skipped — seat took a turn since the park`);
          return;
        }
        // A FRESH draft is the one thing this deadline must never interrupt. The
        // forced flush enqueues non-parkable, so at write time the queue emits a
        // bare Ctrl-U clear-line into whatever is typed — the splice
        // INJECT_QUIET_MAXWAIT was raised to 5 min to avoid after it cut live
        // composition mid-word twice.
        //
        // Re-arm rather than flush, and deliberately WITHOUT a round bound: the
        // 300s _armParkCap is armed independently at T+0 and remains the ultimate
        // backstop, so unbounded re-arming degrades at worst to the previous
        // behaviour while giving 25s whenever the operator is away. A bound would
        // only re-introduce the splice this check exists to prevent — do not add one.
        //
        // The field case is untouched: a restored seat has no lastUserInputTs, so
        // Date.now() - 0 is stale and the notice flushes at the first deadline.
        if (Date.now() - (target.lastUserInputTs || 0) <= REBOOT_NOTICE_DRAFT_STALE_MS) {
          log.debug('inject', `reboot notice flush for ${target.name} deferred — draft touched within ${REBOOT_NOTICE_DRAFT_STALE_MS / 1000}s; re-arming`);
          this._armRebootNoticeFlush(target, parkedAt);
          return;
        }
        log.info('inject', `reboot notice flush cap (${REBOOT_NOTICE_FLUSH_MS / 1000}s) for ${target.name} — forcing the parked notice out`);
        // Timer callback: _flushParkedNow calls countPending outside a try by
        // design, so a throw here escapes as an uncaughtException and takes the
        // app down rather than costing one undelivered notice.
        try {
          this._flushParkedNow(target, `reboot.${process.pid}`, 'park-flush');
        } catch (e) {
          log.error('inject', `reboot notice flush for ${target.name} failed: ${e.message}`);
        }
      };
      target._rebootNoticeFlushFire = fire;
      target._rebootNoticeFlushDelay = REBOOT_NOTICE_FLUSH_MS;
      // Stamped for the same reason as the delay above: the staleness threshold is
      // the operator's whole protection against a spliced draft, and a test that
      // only exercises it at 1s and 60s stays green if it drifts down to
      // INJECT_QUIET_MS, which is exactly the value that reinstates the splice.
      target._rebootNoticeDraftStaleMs = REBOOT_NOTICE_DRAFT_STALE_MS;
      target._rebootNoticeFlushTimer = setTimeout(fire, REBOOT_NOTICE_FLUSH_MS);
    }

    // Re-offer the notice WITHIN this launch. The cross-launch retry (the notice
    // surviving in settings) is only the backstop for a crash between park and
    // delivery: a copy arriving at the next launch answers a question nobody is
    // still asking.
    //
    // The liveness test is deliberately NOT _armParkedDrainFallback's
    // fs.existsSync on the park file. That timer is the right shape against "the
    // drain never fired" and blind to the failure here: the drain DID fire, the
    // file is gone, and the write vanished — which existsSync reads as success.
    //
    // What is observable is that the seat took a turn after the park. It is
    // inference, not confirmation: a turn the operator caused would satisfy it
    // too. That costs at most one duplicate notice, whereas trusting the claim
    // costs the message.
    _armRebootNoticeRetry(target, notice) {
      const attempt = (Number.isFinite(notice.attempts) && notice.attempts > 0 ? notice.attempts : 0) + 1;
      const store = getUiSettings && getUiSettings();
      if (store) {
        try { store.set({ pendingRebootNotice: { ...notice, attempts: attempt } }); }
        catch (e) { log.error('intent', `reboot notice attempt-stamp failed: ${e.message}`); }
      }
      const parkedAt = Date.now();
      const delay = REBOOT_NOTICE_RETRY_DELAYS[attempt - 1];
      if (delay == null || attempt >= REBOOT_NOTICE_MAX_ATTEMPTS) return;
      clearTimeout(target._rebootNoticeRetryTimer);
      const fire = () => {
        target._rebootNoticeRetryTimer = null;
        if (target._dead) return;
        // A turn since the park is the delivered-enough signal; clear and stop.
        const stop = target.lastMainStop;
        const turned = !!(stop && !stop.seeded && Number.isFinite(stop.ts) && stop.ts > parkedAt);
        if (turned) {
          if (store) {
            try { store.set({ pendingRebootNotice: null }); }
            catch (e) { log.error('intent', `reboot notice clear failed: ${e.message}`); }
          }
          log.info('intent', `reboot notice for ${target.name} presumed delivered (seat took a turn) — cleared after ${attempt} attempt(s)`);
          return;
        }
        log.warn('intent', `reboot notice for ${target.name} unconfirmed ${Math.round((Date.now() - parkedAt) / 1000)}s after park (no turn since) — re-offering, attempt ${attempt + 1}/${REBOOT_NOTICE_MAX_ATTEMPTS}`);
        this.maybeDeliverRebootNotice({ retry: true });
      };
      target._rebootNoticeRetryFire = fire;
      target._rebootNoticeRetryDelay = delay;
      target._rebootNoticeRetryTimer = setTimeout(fire, delay);
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
        const lines = mine.map((r) => {
          const preview = previewLine(r.body, 60);
          return `  ${r.id}  ${r.spec}${preview ? ` — ${preview}` : ''}`;
        });
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

      // A `for <id>` binding names a ticket that must actually exist on this
      // seat's team, and the check is here rather than in the parser because the
      // parser is a pure leaf with no board to consult. Binding to a ticket that
      // is not on the board can never be cancelled — which reproduces exactly the
      // orphaned-reminder bug, minus the visible reminder that something was
      // supposed to happen. So it bounces instead of arming.
      if (parsed.ticket) {
        let team = null;
        try { team = resolveTeam(session.cwd); } catch { team = null; }
        if (!team) {
          const e = `no team here — a "for ${parsed.ticket}" binding needs a team board`;
          reply(e);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${e}` });
          return;
        }
        let row = null;
        try { row = ticketsStore.load(team.root).find((t) => t && t.id === parsed.ticket) || null; } catch { row = null; }
        if (!row) {
          const e = `no ticket ${parsed.ticket} on ${team.name} — nothing to bind this reminder to`;
          reply(e);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${e}` });
          return;
        }
        // Existence is not enough: a binding to an ALREADY-TERMINAL ticket can
        // never be collected, because no verb will name it again — _taskCancel
        // refuses a non-open ticket, and an accept that closed out is not
        // repeated. So it would arm and then fire stale.
        //
        // The SAME predicate decides here and at close time (ticketTerminal /
        // ticketTerminalReason in tickets-store), so the set refused here and
        // the set collected there cannot drift apart.
        const why = ticketTerminalReason(row);
        if (why) {
          const e = `ticket ${parsed.ticket} is ${why} — nothing left to bind to`;
          reply(e);
          this._broadcast('ipc-message', { type: 'remind', from: who, to: who, body: `err: ${e}` });
          return;
        }
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
        // The collector keeps the HEAD of stderr and drops the overflow, so its
        // cap must clear the reply budget or the clamp's input would be smaller
        // than its output. The 1024 is SLACK, not a data budget — nothing
        // between the budget and the cap is ever delivered — and a cut sets
        // stderrTruncated, so the loss is reported rather than silent.
        const replyMax = (typeof entry.replyMaxBytes === 'number' && entry.replyMaxBytes > 0)
          ? Math.floor(entry.replyMaxBytes) : 0;
        const stderrCap = Math.max(2000, replyMax + 1024);
        // A host that never passes the dep still replies, narrowly, instead of
        // throwing inside the exit handler where the failure is swallowed whole.
        const clamp = clampReplyBody
          || ((s, n) => String(s == null ? '' : s).trim().slice(0, n));
        let done = false;
        let stderr = '';
        let stderrTruncated = false;
        const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          // A TIMEOUT IS NOT A FAILURE, and telling the two apart is the caller's
          // whole decision. A command that exits nonzero has ANSWERED — the right
          // response is to read the answer. A command killed at the ceiling has
          // not: the work may have completed and lost only its report, or may
          // still be running right now. `clodex-run-tests` is exactly that shape —
          // its digest exists only on the wrapper's stderr, so a SIGKILL at the
          // ceiling drops a green suite's number on the floor while the suite runs
          // on and keeps the box-wide lock.
          //
          // The "may still be running" clause is the load-bearing half: without
          // it the natural next move is to re-fire the command, which for a
          // lock-taking one queues a second run behind the first.
          // Seconds are omitted below 1s rather than rounded: Math.round would
          // render a sub-second ceiling as `0s`, and a stated zero reads as a
          // bug in the reporter rather than as the configured ceiling.
          const ceiling = timeoutMs >= 1000
            ? `${Math.round(timeoutMs / 1000)}s (${timeoutMs}ms)`
            : `${timeoutMs}ms`;
          finish(() => fail(`TIMED OUT after ${ceiling} — no result was returned. `
            + 'This is not a failure report: the command was killed at its ceiling, so it may have '
            + 'succeeded and lost only its output, and any work it started may still be running.'));
        }, timeoutMs);
        if (child.stderr) {
          // setEncoding, not d.toString(): a chunk boundary inside a multi-byte
          // sequence yields U+FFFD mid-row, and every ticket row carries an
          // em-dash. Multi-chunk collection is the norm on the widened path.
          if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
          child.stderr.on('data', (d) => {
            if (stderr.length < stderrCap) stderr += d.toString();
            else stderrTruncated = true;   // makes the clamp's count honest
          });
        }
        child.on('error', (e) => finish(() => fail(`run failed (${e.message})`)));
        child.on('exit', (code, signal) => finish(() => {
          if (code === 0) {
            // A widened def (replyMaxBytes) returns stderr from the TOP, not the
            // last line: its output is a listing whose first rows are the answer
            // (a ticket board, one error per bad file), and the last line of a
            // listing is its footer. The narrow default keeps taking the last
            // line — those commands end with their digest.
            const body = entry.replyStderr !== true ? ''
              : replyMax ? clamp(stderr, replyMax, { truncated: stderrTruncated })
                : (stderr.trim().split('\n').pop() || '').slice(0, 200);
            if (body) {
              reply(`${cmd}: ${body}`);
              log.info('intent', `exec ${cmd} by ${who}: ok (stderr replied)`);
              const shown = body.length > 200 ? `${body.slice(0, 200)}…` : body;
              this._broadcast('ipc-message', { type: 'exec', from: who, to: cmd, body: `ok: ${shown}` });
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

    // `[agent:term exec] <cmd>` — run one command on the agent's OWN terminal
    // tab and report the result back to that agent alone.
    //
    // BOTH halves of the target are derived from the sender: the seat is the
    // session's name and the window is its workspace. The agent supplies
    // neither, so there is no seat string to validate and no way to reach
    // another agent's terminal or the seatless workspace shell.
    //
    // The result does NOT come back from here. It arrives later, on the seat's
    // selection queue, when the shell's D mark says the command ended.
    _handleTermIntent(session, sub, rawBody) {
      const reply = (msg) => this._injectText(session, `[agent:term] ${msg}`, { parkable: true });
      if (sub !== 'exec') {
        reply(`unknown form \`term ${sub}\` — the only one is [agent:term exec] followed by the command`);
        return;
      }
      // The seat TYPE check: a bash session is already a shell and a peer
      // session lives on another box, so neither has a terminal tab of its own.
      // The same predicate the renderer uses to decide whether to DRAW the tab,
      // read from the shared leaf so the two answers cannot drift.
      //
      // Today it cannot fire: the switch above requires `agentType`, which is
      // non-null only for claude/codex, and a peer is not a local session at all.
      // The refusal that ACTUALLY fires for a seat with no terminal is `no-shell`,
      // from the exec itself. This stays because the structural reason is an
      // accident of two other decisions: make bash sessions intent-capable, or
      // give a peer a local session record, and this becomes the only thing
      // standing between them and a shell they should not have.
      // No truthiness guard on the dep. An unwired termAvailableFor must throw
      // here rather than skip the check.
      if (!termAvailableFor(session.type)) {
        reply(`a ${session.type} session has no terminal tab of its own, so there is nothing to run a command in`);
        return;
      }
      const res = termExec(session.workspaceId, session.name, rawBody);
      this._broadcast('ipc-message', {
        type: 'term', from: session.name, to: session.name,
        body: res.ok ? `exec: ${res.command}` : `exec REFUSED: ${res.error}`,
      });
      if (!res.ok) {
        log.warn('intent', `term exec by ${session.name}: refused (${res.error})`);
        reply(res.error);
        return;
      }
      log.info('intent', `term exec by ${session.name}: ${res.command}`);
      // No "sent" acknowledgement. It would cost the agent a turn to read
      // something it already knows, and the result is coming on its own.
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
        // with "no unit" and reads as a bug in the delete path.
        try { session.digestNonEmpty = writeClaudeDigestFile(agent); } catch { /* best-effort */ }
      }
      return { ok: true };
    }

    // The one operator-pin path. Same shape and same obligation as
    // removeMemoryUnit: changing which units ride the boot digest is only real
    // once the digest is rewritten, and a plugin cannot know when to do that.
    setOperatorPin(agent, id, on) {
      try {
        memoryStore.setOperatorPinned(agent, id, !!on);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      const session = this.sessions.get(agent);
      if (session && !session._dead && session.agentType === 'claude') {
        // Best-effort for the reasons the delete path documents: the pin is
        // already written and permanent, so reporting failure here would invite
        // a retry against a store that is already correct.
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
          ? units.map(u => `• ${u.id}${u.scope ? ` [${u.scope}]` : ''}${u.pinned ? ' (pinned)' : ''}: ${previewLine(u.body, 60)}`).join('\n')
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
        // A hint may offer a COMMON unit's id, whose body lives in a store this
        // agent does not own. Without the fallback that offer names an action
        // the agent cannot take, and the truncated body is unreachable.
        let unit = memoryStore.recall(agent, body);
        if (!unit && commonMemoryRecall) {
          try { unit = commonMemoryRecall(body); } catch { unit = null; }
        }
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


    // A ticket verb's body is composed in the sender's turn and exists nowhere else,
    // so a validation error that just returns destroys it. Every rejecting return a
    // ticket command can reach — the entry-point team check, the verbs below, and
    // done's undeliverable-report branch — routes its reply suffix through here, so
    // the payload is on disk before the sender is told no. No exceptions: a site
    // added without one is a silent regression, since the suite stays green.
    // The two outcomes must be DISTINGUISHABLE in the reply: a sender that reads
    // "saved to <path>" stops holding the only copy, so a failed spill reports the
    // failure and never a path.
    // The success line names the DEADLINE because the file is not durable:
    // sweepSpilledMessages exempts only names a PARKED pointer references, and a
    // promptly-delivered bounce is never parked — so the common case expires
    // MSG_MAX_AGE after the spill. An unqualified "saved" would be the same false
    // claim as naming a path for a spill that failed, one timer delayed.
    _spillRejectedPayload(session, verb, body) {
      if (!body) return '';
      try {
        const path_ = spillToFile(`${verb} (rejected)`, body, session.name);
        return ` — your ${verb} body (${body.length} bytes) is saved for the next ${Math.round(MSG_MAX_AGE / 60)} minutes and then swept: ${path_} — copy it out before then`;
      } catch (e) {
        log.warn('intent', `spill of rejected ${verb} body for ${session.name} failed: ${e.message}`);
        return ` — WARNING: your ${verb} body could NOT be saved (${e.message}) and exists only in your own turn — copy it before you continue`;
      }
    }

    // The disabled-intent gate's payload suffix. Separate from the ticket sites
    // (_spillRejectedPayload above) for two reasons that are properties of THIS
    // gate, not of spilling:
    //
    // A denial is not a mistake. The ticket sites reject an input the sender can
    // correct — wrong id, not your ticket — so telling it to copy the body out and
    // retry is actionable. Here retrying is guaranteed to bounce identically; only
    // the operator can change the seat's allowlist, so this path says whose call
    // it is instead.
    //
    // And a denial REPEATS without bound: a seat that has not internalised a
    // denied verb emits one every turn, forever, and an unconditional spill would
    // write a file each time. sweepSpilledMessages bounds spill AGE, not RATE, so
    // the rate has to be capped at the source. Hence the per-(seat, verb) budget:
    // keyed by verb because a seat can be denied several capabilities and one must
    // not eat another's budget, and held on the live Session so a respawn starts
    // over.
    //
    // Past the budget the sender is still told the body is gone. The
    // saved/not-saved outcomes stay distinguishable in the reply: a sender that
    // reads "saved" stops holding the only copy.
    _deniedIntentPayload(session, intent) {
      const { how, label } = deniedBodyDisposition(intent);
      if (how === 'none') return '';
      const off = ` — this capability is off for this seat; retrying will bounce the same way, and only the operator can turn it on (Edit Session → Intents)`;
      const body = String(intent.body);
      if (how === 'spill') {
        const used = (session._deniedSpills || (session._deniedSpills = new Map())).get(label) || 0;
        if (used < DENIED_SPILL_CAP) {
          try {
            const path_ = spillToFile(`${label} (denied)`, body, session.name);
            session._deniedSpills.set(label, used + 1);
            return `${off}. Your ${label} body (${body.length} bytes) is saved for the next ${Math.round(MSG_MAX_AGE / 60)} minutes and then swept: ${path_} — copy it out before then`;
          } catch (e) {
            log.warn('intent', `spill of denied ${label} body for ${session.name} failed: ${e.message}`);
            return `${off}. WARNING: your ${label} body (${body.length} bytes) could NOT be saved (${e.message}) and exists only in your own turn — copy it before you continue`;
          }
        }
        return `${off}. Your ${label} body (${body.length} bytes) was NOT saved — ${DENIED_SPILL_CAP} bodies for this verb have already been spilled this session and the rest are dropped; it exists only in your own turn`;
      }
      return `${off}. Your ${label} body (${body.length} bytes) was NOT saved and exists only in your own turn`;
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
            // Same field set as engine.js's restartSession/applySessionArgs — a
            // reload is a kill()+create() like theirs, and `ephemeral` is what
            // tells `task accept` whether the loop minted this seat. Dropped
            // here, a reloaded ticket seat reads as the operator's standing seat
            // at accept: no teardown, a leaked worktree, and a reply claiming it
            // is not a one-shot ticket seat.
            this._preserveAcrossRestart(name, entry, ['ephemeral', 'reviewFor', 'reviewTicket', 'createdAt']);
            await this.create(
              name, entry.type, entry.cwd, entry.extraArgs || [], null, entry.workspaceId,
              entry.systemPrompt || null, false, entry.proxy ?? null, entry.agents || [],
              entry.denyBuiltins || [], entry.disabledTools || [], entry.disabledSkills || [],
              entry.injectSkills || [], entry.systemPromptFile || null, entry.appendPromptFiles || [],
              Array.isArray(entry.execCommands) ? entry.execCommands : [],
              Array.isArray(entry.intents) ? entry.intents : null,
              // Session env, same expression as the other two kill()-based
              // respawns (engine.js restartSession, session-restore.js). Omitting
              // it defaults sessionEnv to null and the reloaded seat spawns with
              // NO session env at all — silently, since create() then re-persists
              // the entry without it, so every later --resume is wrong too.
              (entry.env && typeof entry.env === 'object') ? entry.env : null,
              false,           // mint — a reload respawns an existing record
              entry.noWire === true,
              Array.isArray(entry.plugins) ? entry.plugins : null,
            );
            const lvl = stripLevelOf(entry);
            if (lvl >= 1) getPersistence().setStripLevel(name, lvl);
            if (entry.label) getPersistence().setLabel(name, entry.label);
            this._sendToSession(name, 'session:context-action', {
              action: 'reattach', name, type: entry.type, cwd: entry.cwd, backend: (this.sessions.get(name) || {}).backend || null, noWire: !!(this.sessions.get(name) || {}).noWire,
            });
            const fresh = this.sessions.get(name);
            if (fresh) this._injectReloadHandoff(fresh, handoff);
          } catch (err) {
            console.error(`[agent:context reload] ${name} failed:`, err.message);
            // Never let a failed respawn eat the entry — but not its `worktree` if
            // another live seat took the checkout while this reload was in flight.
            // Re-upserting the whole pre-kill snapshot is how a failure path puts
            // a second record on one tree; see _stripClaimedTree.
            getPersistence().upsert(this._stripClaimedTree(entry));
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
    // a closure variable across kill→create. Readiness gate: the SessionStart hook
    // repoints run/<name>/transcript.jsonl at CLI boot, and kill()'s cleanup
    // unlinked the old link before we respawned — so link-present = fresh CLI
    // booted. Probe with readlinkSync, NOT session.sessionId: the watcher only
    // sets sessionId once the transcript FILE exists, and Claude creates it lazily
    // on the first user turn — gating turn-one injection on it deadlocks and the
    // timeout eats the handoff. Then a settle delay so the input loop is up, then
    // inject. If the session dies or the link never appears, bail rather than
    // inject blind into a half-dead PTY — but surface the drop in the IPC log.
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


    // `onWrite` (see _deliverMessage) fires once the text is DURABLE — parked, or
    // released by the queue. A caller that persists "this seat has been told" must
    // use it rather than the return, which is only a queue acceptance.
    _gatedDeliver(targetName, senderTag, body, urgent, tag = '', onWrite = null) {
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
          ? this._parkHeldDelivery(target, this._buildDeliveryText(target, senderTag, body, 'dm', tag))
          : null;
        // A park IS durable, so it fires onWrite; a bare `held` reached nobody and
        // must not — that asymmetry is the same one the nudge/replay stamps encode.
        // It reports `parked` explicitly: this text is a FILE, drained by the
        // out-of-process hook mid-loop, so a caller confirming a write must not
        // treat it as one. An argument-less call here reads as `injected`.
        if (parkId && typeof onWrite === 'function') { try { onWrite('parked'); } catch {} }
        return parkId
          ? { parked: parkId, reason: verdict.reason, noUrgent: verdict.noUrgent }
          : { held: verdict.reason, noUrgent: verdict.noUrgent };
      }
      this._deliverMessage(targetName, senderTag, body, 'dm', tag, onWrite);
      // `queued`, not `delivered`: _deliverMessage returns once the text is parked
      // or handed to the inject queue, and the queue writes it later — within one
      // poll of the seat's readiness latch. Every negative verdict above IS decided
      // synchronously and is therefore exact; only success is a statement about the
      // future. A caller needing certainty passes _deliverMessage an onWrite hook.
      return { queued: true };
    }

    // The plain-dm delivery latch.
    //
    // A dm written into an idle seat that then never starts a turn was invisible
    // in every direction: the sender is told "queued", the operator's log shows a
    // delivery, and mode-2004 stays on in the swallowing state, so
    // `_bootReadySeen` latches and the queue's ready-gate is a no-op true. Every
    // signal this process has reads healthy while the message vanishes.
    //
    // It DETECTS AND REPORTS. It does not retry, dedupe, order, or confirm
    // per-unit, and it must not grow any of those: the content of a dm is
    // arbitrary, so a duplicate can be expensive to execute and no board record
    // proves the copy identical; and dms arrive concurrently, so with two units
    // outstanding the second's leading Ctrl-U destroys the first's eaten draft and
    // one turn-edge cannot say which unit cleared.
    //
    // Armed ONLY from the `'dm'` arm of _handleIntent, and deliberately not from
    // inside _gatedDeliver: there it would cover all 16 delivery sites including
    // the notices this fires, and an unconfirmed report of an unconfirmed report
    // has no fixed point.
    _armDmConfirm(targetName, senderName, disposition) {
      const s = this.sessions.get(targetName);
      if (!s || !s.agentType || s._dead) return;
      // 'parked' is durable and drained out-of-process mid-loop, so it produces
      // no activity edge to confirm and would latch forever. Unlike the spec
      // latch this does NOT clear on a non-injected disposition: that latch keys
      // on one ticket and a park supersedes its own earlier write, while these
      // entries are independent units from independent senders — a parked unit
      // says nothing about an injected one still sitting eaten.
      if (disposition !== 'injected') return;
      // Read at WRITE time (this runs inside the queue's producer, which is the
      // whole reason the hook exists). A seat that went busy while the unit
      // waited in the gates got it into a live turn, and a seat already working
      // is by definition not the wedged shape this catches.
      if (s.activityState !== 'idle') return;
      const fifo = s._dmUnconfirmed || (s._dmUnconfirmed = []);
      // `since` is where the transcript ended at WRITE time — the baseline
      // _checkDmConfirm compares against. Taken at the same instant as the state
      // read above, which is what separates bytes the seat had already produced
      // from bytes that can only have arrived after this write.
      //
      // Stored RAW: -1 (no transcript, unreadable link) is NOT normalised to 0.
      // `didGrow` refuses -1 at either end, so an unreadable seat yields "no
      // growth" and the check falls through to the behaviour it had before this
      // baseline existed. _armSpecConfirm's opposite choice answers a different
      // question — a byte offset to search FROM, where 0 means the whole file —
      // and copying it here would let a seat's first written byte read as growth.
      fifo.push({ sender: senderName, at: Date.now(), since: this._seatTranscriptSize(targetName) });
      while (fifo.length > DM_LATCH_CAP) this._overflowDmEntry(s, fifo.shift());
      // Pegged to the OLDEST outstanding unit and never restarted by a later
      // one. Restarting on each push starves the detector into silence in
      // exactly its own case: a wedged seat is the seat people keep dm-ing, and
      // `urgent` short-circuits shouldHoldDm ahead of the idle band, so urgent
      // dms keep being INJECTED into a wedged seat forever. A stream faster than
      // one per window would push the deadline out indefinitely while entries
      // accumulate and nobody is ever told. Each unit still gets its full window:
      // _checkDmConfirm reports only the units that are actually ripe.
      if (!s._dmConfirmTimer) this._armDmConfirmTimer(s);
    }

    // The cap bounds per-seat MEMORY, and must not bound per-seat SENDERS: a
    // dropped unit keeps its sender, coalesced into one record per sender (so
    // the bound is the session count). Dropping the entry outright silenced
    // precisely the sender whose message was starved out, while still counting
    // it into the total the broadcast reports — a report that is mute toward the
    // one party it exists to inform.
    _overflowDmEntry(session, gone) {
      const ov = session._dmOverflow || (session._dmOverflow = new Map());
      const rec = ov.get(gone.sender);
      if (rec) { rec.count += 1; rec.at = Math.min(rec.at, gone.at); }
      else ov.set(gone.sender, { count: 1, at: gone.at });
    }

    _armDmConfirmTimer(session, delayMs = SPEC_CONFIRM_MS) {
      clearTimeout(session._dmConfirmTimer);
      session._dmConfirmTimer = setTimeout(() => {
        session._dmConfirmTimer = null;
        // Fires SPEC_CONFIRM_MS after every dm to an idle seat, in the app's main
        // process, where a throw out of a setTimeout callback is an unhandled
        // exception in the host rather than a failed report.
        try { this._checkDmConfirm(session); }
        catch (e) {
          log.error('intent', `dm confirmation check failed for ${session.name}: ${e.message}`);
          // The timer was nulled above and the throw skipped every re-arm inside
          // the check, so a surviving fifo would go unwatched until some later
          // push armed a fresh full window — silence in the one case this exists
          // to end, arrived at through the error path.
          if (session._dmUnconfirmed && session._dmUnconfirmed.length && !session._dmConfirmTimer) {
            this._armDmConfirmTimer(session);
          }
        }
      }, delayMs);
      // Observer-grade in both senses, like the two ticket-side watchers: never
      // the reason a process stays alive, never the reason one dies.
      if (session._dmConfirmTimer.unref) session._dmConfirmTimer.unref();
    }

    // A turn started, so the seat's composer submitted. For a multi-entry FIFO
    // the earlier entries were Ctrl-U-destroyed INTO the submitted line's
    // history — either way nothing is still sitting eaten, and finer
    // discrimination cannot be had.
    // `_dmUnconfirmedLast` goes too: it exists to attribute a seat's SILENCE,
    // and a seat that took a turn is not silent.
    _clearDmConfirm(session) {
      session._dmUnconfirmed = [];
      session._dmOverflow = null;
      session._dmUnconfirmedLast = null;
      clearTimeout(session._dmConfirmTimer);
      session._dmConfirmTimer = null;
    }

    _checkDmConfirm(session) {
      const fifo = session._dmUnconfirmed;
      if (!fifo || !fifo.length || session._dead) return;
      // A dialog is the one wait that is legitimately unbounded and produces no
      // activity. Re-arm rather than clear — the dm may still be unread behind
      // it — and uncapped, because the operator may answer at any time and a
      // seat that never woke is still worth reporting an hour later. It cannot
      // leak: the timer is unref'd and _cleanup clears it when the session dies.
      if (session.needsAttention && session.needsAttention.kind === 'permission') {
        this._armDmConfirmTimer(session);
        return;
      }
      const now = Date.now();
      // PARTIAL drain: only the units that have had their full window. The rest
      // stay and the timer re-arms for the remainder, which is what lets the
      // deadline be pegged to the oldest without judging a unit written a second
      // before it. A ripe set can also be EMPTY here — the cap shifts out the
      // entry the pending timer was pegged to, so it fires early relative to the
      // new oldest. That must re-arm, not return: returning is how an overflowing
      // seat goes permanently silent. (Draining every window instead of
      // accumulating also makes the cap far less reachable than it looks.)
      const ripe = [];
      while (fifo.length && now - fifo[0].at >= SPEC_CONFIRM_MS) ripe.push(fifo.shift());
      if (!ripe.length) {
        this._armDmConfirmTimer(session, Math.max(0, SPEC_CONFIRM_MS - (now - fifo[0].at)));
        return;
      }
      // Second look before spending a report, for the reason _checkSpecConfirm
      // re-probes at its own deadline: the activity edge that would have cleared
      // this latch RACES the CLI's transcript append on a wire-routed seat, so a dm
      // that was read can still be sitting here armed. By the deadline the bytes
      // are on disk, which makes this the reliable read and the edge the eager one.
      //
      // GROWTH, never a content match. A dm has no per-unit anchor —
      // _buildDeliveryText gives every dm from a peer the same `[agent:from
      // <sender>]` prefix — so a marker-style search would clear the latch over a
      // transcript merely holding an EARLIER dm from that sender, suppressing a
      // real swallow. That direction must not be traded for this one. Attribution
      // would buy nothing here regardless: a non-idle edge already clears the whole
      // fifo unattributed, and per-unit confirmation is what _armDmConfirm refuses.
      //
      // MAX, not min: growth must beat the NEWEST write's baseline, so a stream of
      // dms cannot have an old low anchor vouch for the recent ones. `since`
      // missing reads as -1, which `didGrow` refuses at either end — like an
      // unreadable transcript, it suppresses nothing. This can only ever subtract a
      // report, never manufacture one.
      const anchor = Math.max(...ripe.map((e) => (typeof e.since === 'number' ? e.since : -1)));
      if (didGrow(anchor, this._seatTranscriptSize(session.name))) {
        log.info('intent', `dm confirmation for ${session.name} withdrawn — its transcript grew past ${anchor} bytes since the write, so the seat consumed input and the activity edge was simply missed`);
        // BOTH residues go, for one reason: growth refutes the seat's silence, and
        // anything still describing that silence would be spent on refuted
        // evidence. Overflow records are older than everything ripe by
        // construction, so they would be reported one window later. And
        // `_dmUnconfirmedLast` outlives its own report by design — it is what
        // _dmLatchEvidence hands the stall sweep — so a report fired at an earlier
        // window survives into this one and has the sweep attribute the seat's
        // quiet to a swallowed dm that this branch just proved was read.
        session._dmOverflow = null;
        session._dmUnconfirmedLast = null;
        if (fifo.length) this._armDmConfirmTimer(session, Math.max(0, SPEC_CONFIRM_MS - (now - fifo[0].at)));
        return;
      }
      // Overflow records are attributed to THIS report: they are older than
      // everything surviving in the fifo by construction, so they are ripe
      // whenever anything is.
      const overflow = session._dmOverflow
        ? [...session._dmOverflow].map(([sender, r]) => ({ sender, count: r.count, at: r.at }))
        : [];
      const dropped = overflow.reduce((n, r) => n + r.count, 0);
      session._dmOverflow = null;
      const entries = ripe.slice();
      const total = entries.length + dropped;
      const oldest = Math.min(entries[0].at, ...overflow.map((r) => r.at));
      const ageS = Math.round((now - oldest) / 1000);
      // Re-armed for whatever is still young, so one wedge produces a report per
      // window rather than one report ever. The repetition is the feature: it is
      // how a sender whose message arrived after an earlier report gets told.
      if (fifo.length) this._armDmConfirmTimer(session, Math.max(0, SPEC_CONFIRM_MS - (now - fifo[0].at)));
      // Kept, not discarded: this is what lets the stall sweep attribute a silent
      // seat to a swallowed dm rather than to stalled work, which is the
      // misattribution the sweep makes today. Cleared by a turn, and by the
      // withdrawal above — both are proof the seat was not silent after all.
      // ACCUMULATES across reports — a sustained wedge fires repeatedly, and
      // replacing here would shrink the evidence to the last window during
      // exactly the stall the attribution exists for.
      const prev = session._dmUnconfirmedLast;
      session._dmUnconfirmedLast = {
        entries: prev ? [...prev.entries, ...entries] : entries,
        // Dropped units are counted here too, so the sweep clause and the
        // broadcast describe the same backlog with the same number.
        dropped: (prev ? prev.dropped || 0 : 0) + dropped,
        at: prev ? Math.min(prev.at, oldest) : oldest,
        firedAt: now,
      };

      // Every sender with something outstanding in this report, dropped ones
      // included — the whole point of keeping overflow records.
      const senders = [...new Set([...entries.map((e) => e.sender), ...overflow.map((r) => r.sender)])];
      log.warn('intent', `${total} dm${total === 1 ? '' : 's'} written to ${session.name} but no turn started after ${ageS}s — telling ${senders.join(', ')}; nothing re-sent`);
      // FIRST, and never inside the per-sender loop: the notice below travels by
      // the very channel whose reliability is in question — a sender that is
      // itself in a swallowing state loses the notice to the same failure. The
      // broadcast is the out-of-band path that keeps this from being circular,
      // so it must not be reachable only through the path it is covering for.
      this._broadcast('ipc-message', {
        ts: Date.now(), from: 'clodex', to: session.name, kind: 'dm-unconfirmed',
        body: `${total} dm${total === 1 ? '' : 's'} to ${session.name} (from ${senders.join(', ')}) written but no turn started after ${ageS}s — nothing was re-sent`,
      });

      for (const who of senders) {
        // A sender that died inside the window has nowhere to be told; the
        // broadcast above already carries the event.
        const sender = this.sessions.get(who);
        if (!sender || !sender.agentType || sender._dead) continue;
        // This sender's share includes its DROPPED units. A sender whose only
        // message was shifted out by the cap would otherwise reach this loop
        // with an empty share and be told nothing — the starved sender is
        // exactly the one that needs the notice.
        const ovMine = overflow.find((r) => r.sender === who);
        const mineCount = entries.filter((e) => e.sender === who).length + (ovMine ? ovMine.count : 0);
        const mineAt = Math.min(
          ...entries.filter((e) => e.sender === who).map((e) => e.at),
          ...(ovMine ? [ovMine.at] : []),
        );
        const mineAgeS = Math.round((Date.now() - mineAt) / 1000);
        // The hedge is chosen by the TOTAL outstanding, not by this sender's
        // share: another sender's concurrent write is what destroyed this one's
        // draft, so a sender holding the only one of its own messages is still
        // in the ambiguous case whenever the seat's window held more than one.
        // "may not have been seen" and not "was lost" — a confidently wrong
        // report is worse than a hedged one.
        const one = mineCount === 1;
        const noun = one ? 'your message' : `your ${mineCount} messages`;
        const verb = one ? 'was' : 'were';
        const when = one ? `${mineAgeS}s ago` : `(oldest ${mineAgeS}s ago)`;
        const hedge = total === 1
          ? 'it may have been swallowed before it was read'
          : `${one ? 'it' : 'they'} may not have been seen`;
        const ambiguity = total === 1 ? ''
          : ` ${total} messages were outstanding at that seat and concurrent writes overwrite one another's unsubmitted text, so which of them landed cannot be told from here.`;
        this._injectText(sender,
          `[agent:dm] ${noun} to ${session.name} ${verb} written into its terminal ${when} and ${session.name} `
          + `has not started a turn since — ${hedge}.${ambiguity} NOTHING was re-sent, and nothing will be. `
          + `If it matters, resend it yourself: \`[agent:dm ${session.name} urgent] <message>\` lands immediately. `
          + `(A seat that displayed the message and simply stayed idle looks the same from here, so this can be a false alarm.)`,
          { parkable: true });
      }
    }

    // Evidence for the stall sweep: has this seat a live or recently-expired
    // unconfirmed-dm latch? Both sets are returned as one span because they are
    // the same silence — `_dmUnconfirmedLast` holds what a fired report covered
    // and is cleared by anything that refutes that silence (a turn, or the
    // deadline check's growth withdrawal), so what remains is still unaccounted for.
    _dmLatchEvidence(seatName) {
      const s = this.sessions.get(seatName);
      if (!s) return null;
      const last = (s._dmUnconfirmedLast && s._dmUnconfirmedLast.entries) || [];
      const live = s._dmUnconfirmed || [];
      // Cap-dropped units count HERE as well as in the broadcast's total. Two
      // numbers describing one seat's silence that disagree cost an hour to
      // reconcile, and the sweep clause is read next to the broadcast.
      const dropped = ((s._dmUnconfirmedLast && s._dmUnconfirmedLast.dropped) || 0)
        + (s._dmOverflow ? [...s._dmOverflow.values()].reduce((n, r) => n + r.count, 0) : 0);
      const all = [...last, ...live];
      const count = all.length + dropped;
      if (!count) return null;
      const at = Math.min(...all.map((e) => e.at),
        ...(s._dmOverflow ? [...s._dmOverflow.values()].map((r) => r.at) : []),
        ...(s._dmUnconfirmedLast ? [s._dmUnconfirmedLast.at] : []));
      return { count, at };
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

    // `tag` rides the POINTER line ONLY. A spilled message is announced as "Message
    // (N bytes) attached", so any marker the body carries is invisible until the file
    // is opened — and a codex seat must spend a turn on a Read to see it at all. On
    // the inline branch the body is right there, so repeating the marker in the
    // prefix would print it twice.
    _buildDeliveryText(target, senderName, body, mtype, tag = '') {
      const prefix = `[agent:from ${senderName}]`;

      // The reply nudge is parenthesized and never at column 1, so IntentScanner
      // (which fires only on a cleaned line STARTING with [agent:) cannot mistake it
      // for a real intent. Emitted only when the path it advertises exists on BOTH
      // ends: the receiver's `dm` intent is enabled AND the sender is dm-reachable
      // right now — otherwise it teaches a reply address that silently drops.
      // The SYSTEM_SENDERS check must come BEFORE reachability, not lean on it:
      // reachability asks "is a session called this?", which is true by accident
      // the moment someone names a seat `team`.
      const trailer = (mtype === 'dm'
          && !SYSTEM_SENDERS.has(senderName)
          && intentEnabled('dm', getPersistence().get(target.name)?.intents)
          && this._isDmReachable(senderName))
        ? `(reply: start a line with [agent:dm ${senderName}], close the body with a bare [agent:end] line)`
        : '';

      if (body.length > MSG_SPILL_THRESHOLD) {
        const filePath = spillToFile(senderName, body, target.name);
        const marked = `${prefix}${tag ? ` ${tag}` : ''}`;
        // @-mention makes Claude Code attach the file inline instead of
        // spending a turn on a Read call; Codex has no equivalent. The
        // trailing space after the path closes the @-autocomplete popup —
        // without it the deferred Enter can land on the popup and select a
        // DIFFERENT file (observed live: pointer said msg-2, body was msg-3).
        // The trailer rides the pointer line (not the spilled file, which may be
        // read after the register has already drifted).
        return target.agentType === 'claude'
          ? `${marked} Message (${body.length} bytes) attached: @${filePath} ${trailer}`
          : `${marked} Message (${body.length} bytes) saved to ${filePath} — read it with your Read tool.${trailer ? ' ' + trailer : ''}`;
      }
      return `${prefix} ${body}${trailer ? '\n' + trailer : ''}`;
    }

    // `onWrite` fires when the text is DURABLE — parked to disk, or released by the
    // queue — never on the enqueue. A caller that persists "this seat has been told"
    // must use it: enqueue returns while the bytes are still in the ready loop, so a
    // stamp taken from the return outlives a write that the boot re-render wiped, and
    // the seat is then suppressed forever on the strength of it.
    //
    // It receives WHICH disposition made the text durable: 'injected' for a write
    // released by the queue, 'parked' for a file the seat drains on its own. Both
    // are durable, so a caller recording "told" treats them alike — but they differ
    // in whether CONSUMPTION is observable from this process. An injected unit ends
    // with an Enter, so consuming it starts a turn; a parked file is drained by the
    // out-of-process hook mid-loop, and a seat already `thinking` produces no fresh
    // activity edge for it. A caller that waits for such an edge must therefore arm
    // on 'injected' only.
    _deliverMessage(targetName, senderName, body, mtype, tag = '', onWrite = null) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      const finalText = this._buildDeliveryText(target, senderName, body, mtype, tag);
      const fire = typeof onWrite === 'function' ? onWrite : null;
      if (!this._maybeParkDelivery(target, finalText)) {
        this._injectText(target, finalText, {
          parkable: true,
          // A park via the fire-time divert is durable too, so the stamp is taken
          // once the producer runs and the write is imminent — the same instant the
          // divert decides. Returning the text unchanged keeps this a pure hook.
          // Reports 'parked' when the divert claims it: the bytes become a file, not
          // a write, and an observer keying on consumption must see that difference.
          ...(fire ? {
            produce: () => { try { fire('injected'); } catch {} return finalText; },
            onDivert: () => { try { fire('parked'); } catch {} },
          } : {}),
        });
      } else if (fire) {
        try { fire('parked'); } catch {}   // parked to disk = durable; the stamp is honest
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
      // watcher). Parking a busy DM lets the out-of-process PostToolUse hook
      // deliver it mid-loop (an external script can't see the in-memory queue).
      // The idle-edge Node drain is the fallback for a turn that ends with no tool
      // call (pure-text reply).
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
      // Any forced flush ends the notice's deferral chain, not just the operator's
      // (flushPending). The chain otherwise dies only on a real turn or its own
      // flush, so a pane kept warm past the 300s park cap left it alive after the
      // cap had already delivered the notice — and the next unrelated park would
      // then be forced out early by a timer that no longer had anything to deliver.
      //
      // Ahead of the count check below on purpose: an empty mailbox means another
      // drainer already took the notice, so the chain has nothing left to deliver
      // either. Moving this after that early return would leave it armed in exactly
      // the case where it is most certainly stale.
      if (target._rebootNoticeFlushTimer) { clearTimeout(target._rebootNoticeFlushTimer); target._rebootNoticeFlushTimer = null; }
      // Claim LATE, like the boot-ready drain: drainPending DELETES the parked
      // files, and enqueue returns before the queue has written anything, so
      // claiming here meant a wiped or never-reached write destroyed the only
      // copy. The producer runs inside the queue's critical section, past the ready
      // and quiet gates, so the files are claimed only when the write is imminent.
      // The count is a non-destructive PRE-count for the return value and the log
      // line; the drain may legitimately yield fewer, which costs an over-count in
      // a log, never a message.
      const count = countPending(PENDING_DIR, target.name);
      // Logged BEFORE the early return, which is where it has to be: with the
      // return first, a cap firing on an already-empty mailbox was silent and
      // indistinguishable from a cap that never fired at all. That absence was
      // read as evidence the timer was broken, and it could not have been.
      if (!count) {
        log.debug('inject', `${kind} for ${target.name} — nothing parked (already drained elsewhere)`);
        return { ok: true, count: 0 };
      }
      const plural = count === 1 ? 'y' : 'ies';
      const body = kind === 'park-cap'
        ? `park cap fired (${INJECT_QUIET_MAXWAIT / 1000}s, no submit) — injecting ${count} parked deliver${plural}`
        : `flushed ${count} parked deliver${plural} (operator)`;
      log.warn('inject', `${kind} for ${target.name} — draining ${count} parked deliver${plural} via queue`);
      this._broadcast('ipc-message', { ts: Date.now(), from: 'clodex', to: target.name, kind, body });
      // ONE injection for the whole drain, not N. N sequential _injectText calls
      // raced: #1's Enter starts a CLI turn and #2 landed in the turn-start churn
      // where its Enter got swallowed → stranded draft. A forced flush is non-
      // parkable, so a stranded text just sits. Join into a single body with the
      // SAME blank-line separator the out-of-process hook drain uses, so a seat
      // sees the same combined shape whichever drainer won.
      this._injectText(target, '', {
        produce: () => {
          if (target._dead) return null;
          let texts = [];
          try { texts = drainPending(PENDING_DIR, target.name, tag, this._bornFor(target.name)); } catch { return null; }
          return texts.length ? texts.join('\n\n') : null;   // another drainer won the claim
        },
      });
      return { ok: true, count };
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
      // The notice's own deadline is cleared inside _flushParkedNow, for every
      // forced flush rather than only this one.
      this._lastPendingCounts.delete(name);
      this._broadcast('pending-count', { name, count: 0 });
      return r;
    }

    // `produce` carries a payload that is still ON DISK and unclaimed; the queue
    // evaluates it at write time. Every branch below must keep it a callback: the
    // moment it is flattened into a string the claim has already happened, which
    // is the loss this pattern exists to prevent.
    _injectText(session, text, opts = {}) {
      if (session._dead) return;
      const produce = typeof opts.produce === 'function' ? opts.produce : null;
      if (!opts.bypassHold && this._injectHoldReason(session)) {
        // Held as an ENTRY, not as text — see above. Flattening here would claim
        // now and hold the bytes in memory for the whole hold, so a process that
        // dies during a compact window or a permission dialog loses them.
        (session._injectQueue = session._injectQueue || []).push(produce ? { produce } : text);
        this._armInjectValve(session);
        return;
      }
      // parkable is OPT-IN, not opt-out: a missed tag falls back to inject-through (a
      // possible splice, no worse than before), whereas parking a CLI-driving
      // self-intent (compact/reload continuation, a slash command) would stall the
      // agent. The divert re-checks for an open draft at write time, inside the
      // queue's critical section.
      const baseDivert = opts.parkable ? this._parkDivertFor(session, opts.parkId || null) : null;
      // The divert runs AFTER `produce`, so a caller told 'injected' by the producer
      // can still have its text parked a moment later. Reporting the claim lets such
      // a caller correct itself — last disposition wins.
      const onDivert = typeof opts.onDivert === 'function' ? opts.onDivert : null;
      const divert = (baseDivert && onDivert)
        ? (t) => {
          const claimed = baseDivert(t);
          if (claimed) { try { onDivert(); } catch {} }
          return claimed;
        }
        : baseDivert;
      const qopts = {};
      if (divert) qopts.divert = divert;
      if (produce) qopts.produce = produce;
      this._injectQueueFor(session).enqueue(produce ? '' : text, Object.keys(qopts).length ? qopts : undefined);
    }

    // A dictated draft reads as open here and NOWHERE ELSE. `isDraftOpen` is
    // fed only by `isHumanPtyInput` in write(), i.e. by TYPING — dictation is
    // recorded by the CLI and painted into its own composer, so a dictated
    // draft never sets those stamps and the divert that protects a typed draft
    // never engaged for one. This is the parity, kept to the divert rather than
    // widened into `isDraftOpen`, whose five other call sites ask a question
    // about keystrokes that this cannot answer.
    //
    // An EXPIRING stamp, so it releases on its own: he submits (the composer
    // empties, the renderer stops reporting, and the submit drains the park),
    // he clears it, the seat loses focus, the window closes, the screen becomes
    // unreadable — every one of those stops the level and the stamp goes stale.
    // Past that the park cap bounds it again from a timer that reads no voice
    // signal at all, so the protection cannot outlive its release.
    // What every drain and the divert must agree "an open draft" means. The two
    // predicates are separate because typed and dictated drafts reach Clodex by
    // different routes (see _voiceDraftOpen); a reader consulting only the typed
    // one treats a dictated draft as no draft at all.
    _anyDraftOpen(session) {
      try { return isDraftOpen(session) || this._voiceDraftOpen(session); } catch { return false; }
    }

    _voiceDraftOpen(session) {
      return Date.now() - (session.lastVoiceDraftTs || 0) < INJECT_VOICE_DRAFT_STALE_MS;
    }

    _parkDivertFor(session, id = null) {
      if (!session || session.agentType !== 'claude') return null;
      return (text) => {
        if (session._dead) return false;
        if (!this._anyDraftOpen(session)) return false;
        try {
          parkDelivery(PENDING_DIR, session.name, text, this._nextParkSeq(), id, false, this._bornFor(session.name));
        } catch (e) {
          log.error('inject', `fire-time park failed for ${session.name}: ${e.message} — injecting instead`);
          return false;
        }
        this._armParkCap(session);
        const why = isDraftOpen(session) ? 'draft open' : 'dictated draft open';
        log.info('inject', `diverted to park: ${why} (${session.name})`);
        return true;
      };
    }

    _injectQueueFor(session) {
      if (!session._injectPtyQueue) {
        // Boot-readiness gate: the first inject into a freshly spawned
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
          hintHeld: () => { try { return !!(arm.holding && arm.holding(session.name)); } catch { return false; } },
          // Dictation gets the protection typing already has. Fed as its own
          // input rather than by stamping lastUserInputTs, which has two other
          // readers whose meaning that would quietly change.
          //
          // ABSENT EVIDENCE READS AS NOT SPEAKING, and that polarity is the
          // OPPOSITE of `recorderBlocksRearm`'s in voice-submit.js, where an
          // unreadable screen BLOCKS. Both are correct because the two mistakes
          // are not the same mistake. There, missing a lit recorder writes a key
          // that CUTS HIM OFF mid-sentence, so doubt must block. Here, a
          // deferral that cannot be released stops delivery to the seat
          // ENTIRELY, so doubt must deliver — a terminal nobody can read, or a
          // renderer that went away, must not silently wedge every message. Do
          // not "make these consistent": aligning them breaks whichever one is
          // aligned to the other.
          speaking: () => Date.now() - (session.lastVoiceRecordingTs || 0) < INJECT_SPEAKING_STALE_MS,
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
      // Not a message to an agent at all — a box-wide request that happens to
      // arrive on an agent's socket, since that is the only local-user-only
      // pipe Clodex already listens on (~/.clodex is 0700, the socket 0600).
      // `targetName` is therefore just whichever socket the sender could reach,
      // NOT the seat this acts on: `msg.target` names that, or the focused seat
      // does. Delivered to nobody's transcript, so it takes no `body`.
      if (mtype === 'voice-tap') {
        const r = this.voiceTap(typeof msg.target === 'string' ? msg.target : null);
        if (!r.ok) log.info('voice', `external tap declined: ${r.error}`);
        return;
      }
      if (mtype === 'voice-select') {
        const r = this.voiceSelect(typeof msg.target === 'string' ? msg.target : null);
        if (!r.ok) log.info('voice', `external select declined: ${r.error}`);
        return;
      }
      if (mtype === 'voice-mode') {
        const r = this.voiceMode(typeof msg.mode === 'string' ? msg.mode : null);
        if (!r.ok) log.info('voice', `external mode declined: ${r.error}`);
        return;
      }
      if (mtype === 'voice-speech') {
        const r = this.voiceSpeech(typeof msg.state === 'string' ? msg.state : null);
        if (!r.ok) log.info('voice', `external speech declined: ${r.error}`);
        return;
      }
      if (mtype === 'team-retire') {
        // Async since the discard branch probes the worktree for uncommitted
        // work before choosing a disposition. Caught here, not left floating: a
        // rejection would otherwise retire nothing and tell no one.
        this._handleTeamRetire(targetName, sender).catch((e) => {
          // A DM, not just a log line: a throw in the sync prelude retires
          // nothing, and a main-process warn the requester cannot see leaves the
          // lead waiting on a confirmation that is never coming.
          log.warn('intent', `team-retire ${sender} → ${targetName} failed: ${e.message}`);
          this._deliverMessage(sender, 'clodex-team', `retire ${targetName} failed: ${e.message}`, 'dm');
        });
        return;
      }
      this._deliverMessage(targetName, sender, body, mtype);
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

    // Active-class PARK: parked like passive (NO spawn-time PTY write, so the
    // boot-race stays fixed — an early mode-2004 proxy can't strand the text as a
    // Ctrl-U-wiped draft), but TURN-EARNING — a NON-.passive.json entry, so
    // hasActivePending() sees it and the boot-ready rising edge (or any idle edge)
    // drains it. Passive parks never earn a turn by design; a fresh reviewer seat
    // has no other traffic, so passive stalled the scope until a human ✉-click.
    // Used ONLY for the team-review scope. Claude-only (pending is a Claude-hook
    // store); park failure falls back to a normal delivery.
    _deliverParkedActive(targetName, senderName, body, mtype) {
      const target = this.sessions.get(targetName);
      if (!target) return;
      if (target.agentType !== 'claude' || target._dead) {
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      const finalText = this._buildDeliveryText(target, senderName, body, mtype);
      let parkedFile;
      try {
        parkedFile = parkDelivery(PENDING_DIR, target.name, finalText, this._nextParkSeq(), null, false, this._bornFor(target.name));
      } catch (e) {
        log.error('inject', `active park failed for ${target.name}: ${e.message} — delivering normally`);
        this._deliverMessage(targetName, senderName, body, mtype);
        return;
      }
      this._armParkedDrainFallback(target, parkedFile, INJECT_BOOT_MAXWAIT, Date.now() + 3 * INJECT_BOOT_MAXWAIT);
      this._broadcast('ipc-message', {
        ts: Date.now(), from: senderName, to: targetName, kind: 'parked',
        body: body.length > 200 ? `${body.slice(0, 200)}…` : body,
      });
    }

    // The second edge for an active park. _deliverParkedActive is the ONLY park
    // path that arms no timer of its own, and its target is the one seat that can
    // never reach the other two drains: the boot-ready rising edge is one-shot, and
    // both the idle drain and the out-of-process hook need a turn the seat will
    // never take, because the thing it is missing IS its first turn. So a park whose
    // boot-ready edge does not fire — measured twice, seat alive and the files still
    // unclaimed 8s later — is silent and permanent.
    //
    // Recovery for a seat ALREADY in that state is a plain dm re-sending the scope,
    // never a respawn: the seat is healthy and its name is reserved, so a respawn
    // mints a SECOND seat while the first keeps its parked mail and its `born`
    // stamp — and the stamp is what makes the old mail undeliverable to the new
    // seat. A dm lands on the live seat and drains the park with it.
    //
    // Re-checks rather than delivering on schedule: a drain forced while the latch
    // is still missing puts the write back inside the boot re-render window with
    // the messages already claimed off disk. Deferring to an armed _bootDrainTimer
    // is what preserves BOOT_DRAIN_SETTLE_MS as the margin — this timer never
    // shortens it. A plain _armParkCap here would be that same forced delivery.
    //
    // EVERY path out of a pass either delivers or leaves a timer armed. A bare
    // return anywhere here makes this second edge one-shot in exactly the way the
    // first one is: yielding to a drain that then bails (an open draft, a producer
    // that claims nothing) would end with the park unclaimed and nothing alive to
    // notice.
    // `file` scopes a pass to the park it was armed FOR: hasActivePending is
    // name-scoped, so a later pass would otherwise find UNRELATED mail parked
    // meanwhile by _maybeParkDelivery and force it through, bypassing _injectText's
    // hold check and splicing into the very thinking seat that park protects.
    // `drained` marks a pass that FOLLOWS a terminal drain, and it gates the warn,
    // not the re-arm. Bounding the re-arm instead is wrong: a seat whose draft
    // stays open across two periods would have its park abandoned with nothing
    // scheduled to look again. So the timer lives as long as the park does, and
    // only the first drain announces itself. It is bounded in the ways that
    // actually end: the pass returns once the file is claimed, and _cleanup clears
    // the handle when the seat dies.
    _armParkedDrainFallback(session, file, periodMs, deadline, drained = false) {
      if (!session || session.agentType !== 'claude') return;
      if (session._parkedDrainFallbackTimer) return;   // earliest arm governs, like the park cap
      const stillParked = () => {
        try { return fs.existsSync(path.join(PENDING_DIR, session.name, file)); } catch { return false; }
      };
      session._parkedDrainFallbackTimer = setTimeout(() => {
        session._parkedDrainFallbackTimer = null;
        if (session._dead) return;
        if (!stillParked()) return;                    // this park was claimed — nothing owed
        // Re-arm rather than yield outright: the drain may bail (draft open, or its
        // producer claims nothing) and would leave the park silent and permanent.
        // Extending the deadline is what keeps this from expiring while deferring.
        if (session._bootDrainTimer) {
          this._armParkedDrainFallback(session, file, periodMs, deadline + periodMs, drained);
          return;
        }
        if (!session._bootReadySeen && Date.now() < deadline) {
          this._armParkedDrainFallback(session, file, periodMs, deadline, drained);
          return;
        }
        // seen=… is the discriminator: a park landing AFTER the edge was already
        // spent is the likeliest real case, and there the edge fired — early — so an
        // unqualified "never fired" would misdiagnose it.
        if (!drained) {
          log.warn('inject', `parked-drain fallback for ${session.name} — boot-ready drain never fired (boot-ready seen=${!!session._bootReadySeen}); draining active park`);
        }
        this._drainPendingAtBootReady(session);
        // The drain can return having drained nothing (open draft, or its producer
        // claims nothing), so the warn above asserts something that may not have
        // happened. Every following pass verifies and retries in silence until the
        // file is gone — the log says it once, the timer keeps its promise.
        this._armParkedDrainFallback(session, file, periodMs, deadline, true);
      }, periodMs);
    }
  }

  // Graft the teams/tickets half onto the prototype. defineProperty and
  // not Object.assign: class methods are non-enumerable, and "no behaviour
  // change" includes property descriptors — an enumerable graft would change
  // what any for-in or spread over the prototype chain sees.
  //
  // The grafted methods run with `this` = the manager, so the ticket state they
  // use stays where it is: `_ticketWatch` / `_stallProbing` are still
  // initialised in the constructor above and NOT here. Moving that init into
  // team-tickets.js would need a new `_initTicketState()` call, which is a
  // behavioural edit — accepted residue, deliberately.
  const ticketMethods = createTicketMethods(deps, { ticketsStore, nameConflict, SPEC_CONFIRM_MS });
  for (const [k, v] of Object.entries(ticketMethods)) {
    Object.defineProperty(SessionManager.prototype, k,
      { value: v, writable: true, configurable: true, enumerable: false });
  }

  return SessionManager;
}

module.exports = { createSessionManager, deniedBodyDisposition, isStaleRegistration, missingToolOnExit, nameConflict, preseedClaudeOnboarding, ticketCloseLine, ticketTaskDirLine };
