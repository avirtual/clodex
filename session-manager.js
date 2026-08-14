// session-manager.js — the SessionManager class: PTY spawn/kill/restore,
// per-session state, intent routing, DM delivery and parking, inject queue.
//
// ─── WINDOW BRIDGE / opaque-handle contract ─────────────────────────────────
//
// This file never imports electron. It reaches renderers through exactly one
// map — `this.windows`, workspaceId → handle — filled by `registerWindow()`,
// emptied by `unregisterWindow()`, and read only by `windowForWorkspace()`,
// `windowForSession()`, `workspaceForWindow()` and `allLiveWindows()`.
// `_sendToSession()` and `_broadcast()` are the routine exits; the one direct
// use of a handle is the `[agent:file view]` path, which needs show + focus +
// send on a single handle.
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
//
// The bridge is covered by test/session-manager.test.js with fake handles.

const NOTIFY_USER_MAX_BYTES = 16 * 1024;

const REBOOT_MIN_INTERVAL = 5 * 60 * 1000;

// How long a queued ticket waits for another run to release the shared lock.
// Generous because the thing being waited for is a whole suite run, and giving
// up early would escalate a ticket whose only fault was closing while the
// lead's suite was running.
const TICKET_SUITE_LOCK_WAIT_MS = 20 * 60 * 1000;

// The ticket loop's suite run. The kill timer starts at SPAWN, so it covers the
// lock wait as well as the run — which is why it is DERIVED from the wait and
// must stay strictly greater than it. Shipped once the other way round (15m
// kill over a 20m wait), which makes the wait unreachable dead code and reports
// a queued run as `did not finish within 900000ms (killed)`: a wedge report for
// a run that was only waiting its turn. test/test-digest-lock.test.js pins the
// same relation for the other entry point, where the inversion cost three
// misdiagnosed timeouts. The margin is the run itself: the suite takes ~24s,
// and exceeding 15m of RUNNING means a wedge, not a slow suite.
const TICKET_SUITE_TIMEOUT_MS = TICKET_SUITE_LOCK_WAIT_MS + 15 * 60 * 1000;

const REBOOT_NOTICE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Retry-with-a-ceiling, NOT confirmed delivery — the distinction is the whole
// reason this exists. Nothing in the stack acknowledges an injected message:
// InjectQueue ends at a fire-and-forget pty.write, so "the notice was parked"
// and "the notice arrived" are not the same claim and no layer here can tell
// them apart. Reading the first as the second is what let the notice go
// undelivered seven times while the log said it was handled. So the notice is
// re-offered a bounded number of times and then given up on, deliberately.
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
// Both fast drains bail on an open draft, so with one open the generic cap was
// the only thing left and the notice sat for the full five minutes. This does
// NOT relax that gate — it schedules _flushParkedNow, the same forced path the
// operator's flush button uses, which is what rescued the notice every time.
//
// Derived, and both bounds are load-bearing:
//   > INJECT_BOOT_MAXWAIT (20s) — past the queue's readiness cap a polite drain
//     either already happened or is not going to, so this cannot pre-empt one.
//   < REBOOT_NOTICE_RETRY_DELAYS[0] (30s) — firing after the first re-park would
//     flush TWO copies of the notice joined into one body. This bound holds for
//     the FIRST, undeferred round only: a draft deferral re-arms past 30s, so a
//     later round can join the ladder's re-park. Accepted, not overlooked — it
//     costs one duplicated line, and t229 already rules a duplicate the safe
//     direction. Do not "fix" it by bounding the re-arm; see _armRebootNoticeFlush.
//
// This deadline does NOT make the retry ladder redundant, and the ladder must not
// be simplified away now that it exists. The queue's readiness gate writes anyway
// once INJECT_BOOT_MAXWAIT elapses, so on a slow seat — t229 measured a 105s
// transcript re-render — a flush at 25s can still evaporate into a booting CLI.
// That is recoverable only because the ladder is there: the notice survives in
// settings, the re-park follows, and the T+150s rung lands after the render.
const REBOOT_NOTICE_FLUSH_MS = 25 * 1000;

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
  'CLODEX_SPAWNER_HINT',
]);
// The ONE filter for every agent-initiated env. It lived in three hand-rolled
// copies against the same constant, so any one could be edited without the
// others — and one of them did diverge, reporting a bad VALUE TYPE as an
// out-of-allowlist key. Two distinct reasons, returned in separate buckets and
// never merged by a caller: an unknown key is an authority question that needs
// operator approval, a non-string value is a template typo that needs an edit.
// Telling the operator to seek approval for a key they already have sends them
// to the wrong fix.
function filterTemplateEnv(rawEnv) {
  const env = {};
  const dropped = [];
  const badType = [];
  if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
    for (const [k, v] of Object.entries(rawEnv)) {
      if (!REVIEWER_ENV_ALLOWLIST.has(k)) { dropped.push(k); continue; }
      if (typeof v !== 'string') { badType.push(k); continue; }
      env[k] = v;
    }
  }
  // null, not `{}`: create() treats an empty map as a REAL empty env, while
  // absence keeps the box's environment.
  return { sessionEnv: Object.keys(env).length ? env : null, dropped, badType };
}
// Sender labels the MANAGER writes on system-originated deliveries; no agent is
// on the other end of any of them. They must never collect the "(reply: …)"
// trailer, and reachability is the wrong test for that: session names are a
// global namespace, so an unrelated seat that happens to be called `team` makes
// `team` look answerable and every seat on the box gets told to reply to it.
// Observed live — team roster/delta notices taught seats to dm a real session
// named `team` in another workspace, which received the replies as nonsense.
// Keep in sync with the senderName literals at the _deliver* call sites.
const SYSTEM_SENDERS = new Set(['team', 'clodex-team', 'reminder', 'memory', 'reboot', 'clodex']);

// The close verb, on the DISPATCH rather than only in the role prompt. Three
// hands in a row finished good work, committed it, reported by dm, and never
// emitted `[agent:task done <id>]` — so the ticket stayed `open` and the verify
// loop, the reviewer spawn and the verdict never fired, with nothing to say so.
// It cannot live only in the prompt: that prompt is a SEEDED file
// (stores.js seedLibraryDefaults), which stops re-syncing the moment the live
// copy diverges, so a shipped fix can sit in the repo and never reach a seat.
// Both observed false beliefs are denied by name — one hand said it could not
// close because `clodex-team` was not granted to it (it confused the intent
// grammar with the exec registry; `task` is not in intent-catalog's gateable set
// and needs no grant at all), and the dm-is-a-close case is invisible from the
// lead's side because the report itself arrives either way.
// The tickets-viewer plugin holds a copy it cannot require (plugin-api §4);
// test/tickets-viewer-path-parity.test.js pins the two together.
//
// COLUMN 1 IS THE SAFETY. This text contains a complete, ready-to-fire
// `[agent:task done <id>]`, and it is inert only because it never starts a line:
// `CLOSE WITH: ` precedes it here and `[agent:from <sender>] ` precedes it on the
// pointer line. IntentScanner's parse is ^-anchored, so reflowing either one to
// put the verb at the start of a line turns delivered text into a firing intent —
// a seat would close its own ticket on receipt of the spec. Keep the prefix.
const ticketCloseVerb = (id) => `[agent:task done ${id}]`;
const ticketCloseLine = (id) => `CLOSE WITH: ${ticketCloseVerb(id)} <your report> — one intent, at the end: it delivers the report to the lead AND marks the ticket done. `
  + `It is a line you emit yourself, like any [agent:…] intent — NOT an exec command, and nothing needs to be granted for it. `
  + `A dm carrying your report does NOT close the ticket: the ticket stays open, and everything downstream of the close (tree verify, review) never runs.\n`;
const DEFAULT_REVIEWER_TEMPLATE = 'clodex-team-reviewer';
const REVIEWER_FALLBACK = {
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
  },
};
// The review path refuses a template's extraArgs wholesale (an agent-writable
// array of raw CLI argv reaching a seat whose premise is a hard tool cap:
// --allowedTools, --mcp-config and --dangerously-skip-permissions all ride
// there, and REVIEWER_TOOL_CAP screens none of them). `--model` is the single
// carve-out: it grants no authority — tools, posture and env each have their own
// ceiling above — so honoring it cannot widen the seat, and refusing it made
// every reviewer spawn as the default model however it was configured.
// Returns [] when the template names no usable model, so the caller appends
// nothing. An ALLOWLIST by construction: the value is rebuilt from the parsed
// model, never passed through from the template's array, so no neighbouring
// token can ride along with it.
function reviewerModelArgs(extraArgs) {
  const a = Array.isArray(extraArgs) ? extraArgs : [];
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (typeof tok !== 'string') continue;
    // Only the FIRST model token is honored: a last-wins CLI would let a second
    // one override it, which would make the allowlist's choice not the effective one.
    if (tok === '--model' || tok === '-m') {
      const v = a[i + 1];
      // A trailing flag with no value is dropped entirely rather than emitted
      // bare — a bare --model would consume whatever argv token followed it.
      return (typeof v === 'string' && v) ? ['--model', v] : [];
    }
    if (tok.startsWith('--model=')) {
      const v = tok.slice('--model='.length);
      return v ? ['--model', v] : [];
    }
  }
  return [];
}
const { createTicketsStore, nextTicketId, ticketTitle, extractTaskDir, extractMustFix, countMustFix, ticketStarted, ticketInFlight, branchSlug } = require('./tickets-store');
const teamCost = require('./team-cost');
const { buildReviewScope } = require('./ticket-review-scope');
const { findRepoRoot } = require('./project-root');
const { projectDirFor } = require('./clodex-paths');
const { readTail, lastToolFrom, formatStallBody, formatOrphanBody } = require('./stall-evidence');
// Aliased deliberately: the manager has its OWN trackedSessionIds() method with
// a different contract (every id across all sessions, no argument). This is the
// per-entry union, and the two must not be mistaken for each other.
const { trackedSessionIds: entrySessionIds } = require('./session-info');
const { hostNotice } = require('./host-stamp');
const { createMemoryLoad } = require('./memory-load');
const { foldDraft } = require('./hint-arm');

const TICKET_STALL_MS = 30 * 60 * 1000;

// The branch an accepted ticket lands on. A literal, matching what
// scripts/release.sh's preflight demands, and deliberately NOT
// gitWorktree.defaultBranch(): that prefers origin/HEAD, which answers about a
// ref this checkout may never merge to, and the auto-merge writes to the tree in
// front of it. A checkout parked anywhere else is a blocked merge, not a merge
// somewhere else.
const MERGE_TARGET_BRANCH = 'master';

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

// Sharpens the near-miss bounce for the one core verb whose argument sits
// OUTSIDE the brackets. `term`'s neighbours in the grammar block — remind, task,
// team — all take theirs inside, so `[agent:term exec pwd]` is a grammar
// confusion rather than a typo, and the generic bounce actively confirms the
// wrong reading: its valid-intents list NAMES `term`, so the seat concludes the
// verb was fine and hunts for a fault elsewhere.
//
// Names the correct form and stops there. It must never reconstruct and run
// what the line probably meant: that would execute something nobody wrote,
// which is worse than the bounce it replaces — the same rule the control-char
// vetting already follows. Reveals nothing gated either, since the bounce lists
// `term` for every seat whether or not it holds the grant.
function nearMissFormHint(text) {
  if (!/^\[agent:term[\s\]]/.test(String(text || ''))) return '';
  return 'The term intent takes its command AFTER the closing bracket — `[agent:term exec] <command>`, not inside it. ';
}

const RECENT_DONE_MS = 24 * 60 * 60 * 1000;
const RECENT_DONE_CAP = 10;
const RECENT_DONE_LABEL = `${RECENT_DONE_MS / (60 * 60 * 1000)}h`;

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
// test/preserve-across-restart.test.js pins that every caller gets these.
// `wireLabel` is here for the same reason: it is seeded ONLY at the team-spawn
// mint, nothing regrows it, and create() re-mints the proxy agent id from
// `entry.wireLabel || name`. Dropped by an in-place restart, the seat's whole
// remaining spend bills to an unlabeled route and its ticket's COST.json reads
// a null label — the ticket looks free because the money went somewhere else.
const ALWAYS_PRESERVE = ['sessionIds', 'pluginGrants', 'wireLabel'];

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

// How many payloads a seat may spill per denied verb, for its whole live session.
// Not 1: intents are handled in sequence, so one turn carrying three denied dms
// would keep an arbitrary one and destroy the rest. Not unbounded: see the rate
// note on _deniedIntentPayload.
const DENIED_SPILL_CAP = 3;

// What to do with the body of an intent the gate just refused. Pure → unit-tested
// directly, and keyed on the INTENT rather than the type because `memory` and
// `context` split on `sub`.
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
    readCache,
    enqueueNotice,
    versionNoticeFor,
    clearNotices,
    // The running app's version, injected like every other host fact. A
    // getter-free constant is enough: the app cannot upgrade itself
    // mid-process, so the value a seat is compared against is fixed for the
    // life of this manager by construction.
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
    // Recall fallback for ids the agent's own store does not hold; absent, the
    // common half of the hint corpus is simply not recallable.
    commonMemoryRecall,
    memoryLoad,
    hintArm,
    selectionArm: selectionArmDep,
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

  // Same shape and same reason as NO_SELECTION_ARM above: a host that built no
  // drawer service must still answer the agent, because the alternative is an
  // exec that does nothing and reports nothing.
  const termExec = termExecDep
    || (() => ({ ok: false, error: 'terminal tabs are not available on this host' }));

  // Injectable ONLY so the kill arm is reachable from a test. Without a seam no
  // subject can pin "a runner that never exits is SIGKILLed and ESCALATES,
  // never rejects" — an arm that decides a ticket's fate and would otherwise
  // ship green while measuring nothing.
  const TICKET_SUITE_TIMEOUT = Number.isFinite(deps.ticketSuiteTimeoutMs)
    ? deps.ticketSuiteTimeoutMs : TICKET_SUITE_TIMEOUT_MS;

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
  // How long after a spec is WRITTEN — the clock starts at the queue's write, not
  // at the enqueue, so the gates ahead of it do not eat the window — a seat has to
  // START A TURN before the write is treated as lost. Not a stall threshold: it
  // measures the FIRST turn only, and a seat that submitted anything at all has
  // already cleared the latch, so this can never fire on a slow turn however long
  // it runs.
  // Injectable for tests, which drive it LONG and call the check directly — at 0
  // the check races the delivery it is meant to judge and reads a latch the
  // production ordering never produces. 90s in production.
  const SPEC_CONFIRM_MS = Number.isFinite(deps.specConfirmMs) ? deps.specConfirmMs : 90 * 1000;
  const ROSTER_MAX_WAIT_MS = deps.rosterMaxWaitMs || 10000;

  // clodexHome is INJECTED, never left to the store's default: the board now
  // resolves under it, so a test that repoints REGISTRY_DIR would otherwise read
  // and write the operator's real ~/.clodex board.
  const ticketsStore = createTicketsStore({ fs, path, clodexHome: REGISTRY_DIR });

  class SessionManager {
    constructor() {
      this.sessions = new Map();
      this.windows = new Map(); // workspaceId -> BrowserWindow
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
                // No exec exemption here, unlike the wire loop above, and adding
                // one would be INERT rather than wrong: it would only hand the
                // second exec to IntentDeduper.claim, which rejects
                // recovery-after-recovery unconditionally (a replay tail repeats
                // every poll). The exemption did arrive by drift (one of two
                // adjacent guards was edited), but the EFFECT is not drift —
                // claim ALLOWS wire-after-wire, so on the wire side this Set is
                // the only intra-turn dedup and the exemption there is
                // load-bearing.
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
          // evidence about what the operator asked for. The 401 is the case that
          // settled this: the CLI owns the OAuth file and refreshes it on its
          // next real turn, so an overnight rejection is transient (measured
          // recovery: ~12 minutes) while the erase was permanent and silent.
          // A `holdUntil` deadline is not cleared here either — it expires by
          // TIME, and rearmPlan's lapse branch is what notices that.
          //
          // Accepted cost: a genuinely dead credential burns the 2-ping strike
          // budget once per re-arm rather than once per launch. Two warm
          // cache-read pings beats discarding an explicit operator setting
          // unattended. The bound is per-TURN, and NOT because a turn proves the
          // credential works — a 401'd main-line turn emits turn.completed too
          // (proxy.js tees any non-SSE /v1/messages POST regardless of status)
          // and the re-arm probe never inspects it. It holds only because a
          // re-arm needs a main-line turn at all: an idle seat earns none, and an
          // actively-used seat with a dead credential burns two replays per turn
          // until the operator notices — which they will, because their own turns
          // are failing alongside.
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

    async create(name, type, cwd, extraArgs = [], resumeId = null, workspaceId = DEFAULT_WORKSPACE_ID, systemPromptBody = null, fork = false, proxy = null, agents = [], denyBuiltins = [], disabledTools = [], disabledSkills = [], injectSkills = [], systemPromptFile = null, appendPromptFiles = [], execCommands = [], intents = null, sessionEnv = null, mint = false, noWire = false) {
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
      // Wire-off (T189): the seat's whole point is that ANTHROPIC_BASE_URL is
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
        // the spawn path seeded one (team ticket seats and reviewers do, via
        // their pre-create upsert). A seat name outlives its ticket — it is
        // recycled, retired, renamed — so spend keyed by it cannot be rolled up
        // per ticket after the fact. `<team>.<ticket>.<role>` in the proxy route
        // segment makes the attribution durable at the point it is billed.
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
      // reshapes that prefix and costs a warm bust. Anything but off/on posts
      // nothing, so the common path gains no traffic.
      // Strict match, not a parser: this sits on an authority-adjacent path. The
      // likely typos ('0', 'OFF', ' off') would otherwise fail silently, their only
      // symptom a block reappearing in a prompt nobody reads — hence the warn.
      // Unset stays silent, which is what keeps the common path quiet.
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

      const { teamBlock, teamName, resolvedTeam } = this._teamBlockFor(name, cwd, agentType, systemPromptFile);

      switch (type) {
        case 'claude': {
          cmd = 'claude';
          if (preseedClaudeOnboarding({ fs, path, homeDir: os.homedir() })) {
            this._shadowLog({ type: 'claude-onboarding-preseeded', agent: name });
          }
          const sysFile = resolveSystemPromptFile(systemPromptFile);
          // Captured, not re-derived: refreshPrompt replays THIS object through
          // the same _realIpcFor, which is what keeps the two paths byte-equal.
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
          // Shadow mode: register the agent with the in-process wire BEFORE
          // the PTY exists (spawn-bound identity — the wire is never blind to
          // this agent), chaining to the external proxy when one is set. A
          // wire failure falls back to the normal path: a tee must never
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
          const reuse = !!resumeId && !mint && hookInstalled;
          const baked = bakePrompt(REGISTRY_DIR, name, realIpc, reuse);
          // First producer on the notice queue (notice-queue.js). Gated on the
          // SAME `reuse` as the freeze above, and every clause earns its place
          // for the same reason it does there: no conversation to inform
          // (!resumeId) or a fresh one built against this very host, a MINT
          // adopting a dead namesake's record (whose version says nothing about
          // THIS conversation), or no drain installed to deliver it.
          //
          // Per-session HERE rather than a fan-out at app startup: a fan-out
          // only reaches sessions that exist when it runs, so a seat archived
          // now and unarchived in three weeks would learn nothing. This
          // comparison runs at the seat's own spawn, which covers archived and
          // restored sessions with no extra path.
          //
          // A record with no version at all (written by a build before this
          // existed) yields no notice: versionNoticeFor needs both sides, and
          // inventing a floor would announce an upgrade we cannot describe. The
          // upsert below records the running version, so the NEXT one is real.
          //
          // The else is the boundary side, exactly as bakePrompt clears its own
          // staging when reuse is false. The producer guard above is not enough
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
          const codexGrants = (existingEntry && existingEntry.pluginGrants) || null;
          const { cleaned, merged } = mergeCodexInstructions(extraArgs, buildIpcPrompt(intents, this._resolveExecDefs(execCommands), pluginGrammarLines(intents, codexGrants)), {
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
        // has not been handed its open tickets' specs (_replayOpenTickets). Every
        // candidate read back off the record fails for one reason: the record is
        // what survived the respawn. `sessionId` in particular cannot serve — it is
        // assigned from `resumeId` just below, so a --resume carries the SAME id,
        // which is exactly the case that loses a delivery.
        //
        // pid + ms + counter rather than randBase36 (the house idiom for park
        // handles) because this is the only value in create() that must be unique
        // ACROSS processes: a fresh process colliding with its predecessor's key
        // would read its own tickets as already delivered and replay nothing. Two
        // app processes cannot share a pid at the same millisecond, and the counter
        // separates managers built inside one process.
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
        // Wire-fed subagent turn feeds, bounded by subagent-ring.js itself.
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
        // The append-prompt recipe as SPAWNED (null for non-claude). refreshPrompt
        // replays it; nothing else reads it. It dies with the session, which is
        // correct — the next spawn captures its own.
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
        // The version this seat is running under AS OF THIS SPAWN — the
        // baseline the next spawn compares against to decide whether it owes a
        // "Clodex was upgraded" notice (notice-queue.js). Written for every
        // type, not just claude: the record outlives the agent type it was
        // written under, and a value that is only sometimes present is a
        // baseline whose absence means two different things.
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
          // The keep-warm handover rides THIS edge. The symlink repoint is what
          // reports a clear, and it lands seconds before the new conversation's
          // first upstream response — so by the time the wire's turn.completed
          // runs, the assignment above has already made its
          // `s.sessionId !== t.sessionId` test false and _onWireSessionRotated
          // does NOT run on an ordinary clear. That method keeps the same two
          // lines for the backstop case (a wiped symlink, where the wire id is
          // the first news of the clear); it is a second site on purpose, so do
          // not consolidate the handover into it. Why the old hold must be ended
          // rather than left to lapse: see _onWireSessionRotated.
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
          (text, touches) => this._scanJsonlText(text, name, touches),
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
      return { name, type, pid: ptyProc.pid, backend, noWire: wireOff, ...(teamName ? { team: teamName } : {}), ...(warnings.length ? { warnings } : {}) };
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
    // fnmatchcase on the proxy side (proxylab/hints.py _matching_agent_scopes),
    // so `clodex-clodex-*` also matches `clodex-clodex-hand-4f2a` — arming for
    // one agent would arm every agent whose name extends it. Clodex mints
    // proxyAgent itself, so the hash is known here even though it is not
    // knowable from outside.
    _armCtx(s) {
      return {
        agent: s.name,
        // Re-resolved every draft, not read straight off the session: `proxyBase`
        // was captured at SPAWN, so unticking traffic optimization left a routed
        // session ranking and POSTing hints at a wirescope that had just been
        // stopped — and a rejected POST does not release the pre-arm's hold, so
        // the inject queue then sat for its full cap before delivering.
        // Re-resolution and NOT the live pref alone: an explicitly-routed session
        // keeps its hints when the global pref is off. Used only as a BOOLEAN —
        // the value is the CAPTURED base, because that is the one the child's env
        // was baked with (the upstreams and openai_base_url args above), so
        // editing proxyUrl mid-session correctly does not move it. That also makes
        // a null capture win on its own, which is what preserves the spawn-time
        // decisions re-resolution cannot reconstruct: the tee-blind nulling above,
        // and a session spawned while the pref was off, whose CLI does not route
        // through wirescope at all and cannot gain hints by ticking it back on.
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
      setTimeout(() => {
        try { process.kill(s.pty.pid, 'SIGKILL'); } catch {}
      }, 5000);
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
    // Team-retire did exactly that while telling the operator "state lives in
    // its task artifact".
    //
    // NOT folded into kill() itself: the restart paths (engine.js) kill and
    // recreate the same seat, and destroying its checkout there would delete the
    // tree out from under a session that is coming right back.
    //
    // Captured BEFORE the kill and removed AFTER the pty exits, so git is not
    // racing a live cwd.
    async destroy(name) {
      const entry = getPersistence().get(name);
      const worktree = entry && entry.worktree && entry.worktree.path ? entry.worktree : null;
      await this.kill(name);
      if (!worktree) return { ok: true };
      await this._waitForExit(name);
      const r = await gitWorktree.removeWorktree(worktree.path).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok) {
        log.info('worktree', `removed ${worktree.path} (branch ${worktree.branch}) after destroying ${name}`);
        return { ok: true, worktreeRemoved: true };
      }
      const error = (r && r.error) || 'unknown error';
      log.info('worktree', `remove failed for ${worktree.path} after destroying ${name}: ${error}`);
      return { ok: true, worktreeRemoved: false, error };
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

    sweepReviewerGraveyard() {
      const swept = [];
      const corpses = getPersistence().list()
        .filter((e) => e && e.ephemeral === true && e.reviewFor && e.archivedAt)
        .map((e) => e.name);
      for (const name of corpses) {
        this.clearHintForRecord(name);
        getPersistence().remove(name);
        swept.push(name);
      }
      if (swept.length) {
        log.info('migrate', `swept ${swept.length} archived reviewer seat(s): ${swept.join(', ')}`);
      }
      return swept;
    }

    // The team half of realIpc. Extracted from create() so refreshPrompt() can
    // rebuild the SAME bytes: a second copy of this assembly would drift, and the
    // drift would show up as a permanent phantom delta (refresh bakes A, the next
    // create() bakes B, every spawn diffs them forever).
    //
    // Deliberately NOT cached across calls, even though refreshPrompt re-resolves
    // the whole team on every clear/compact. That re-resolution BUYS something: an
    // edit to team.json or to a role prompt lands at the seat's next context reset
    // instead of waiting for a respawn. A later "optimization" that memoizes this
    // per session is trading that property for a few ms of disk reads.
    _teamBlockFor(name, cwd, agentType, systemPromptFile) {
      let teamBlock = '';
      let teamName = null;
      let resolvedTeam = null;
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
      return { teamBlock, teamName, resolvedTeam };
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
          pluginGrammarLines(recipe.intents, recipe.pluginGrants));
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
        const { teamBlock } = this._teamBlockFor(name, entry.cwd, session.agentType, entry.systemPromptFile || null);
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
          type: 'context', from: name, to: name, body: `prompt refreshed (${why})`,
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

    // The ONE board key / live-seat scope derivation (t303). Team-first: when a
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
    // `_ticketWorktreeRole` both bail on a falsy `roles`, so `_resolveAssignee`
    // is left with its live-seat branch, and a solo assign names a live session.
    // `solo` marks the context for the three dispatch helpers that must NOT run
    // here (see `_reconcileTickets`).
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
    //
    // ALWAYS_PRESERVE is carried whether or not a caller names it, and that is
    // deliberate rather than a shortcut: `sessionIds` is the seat's session_id
    // HISTORY, which is what the cost panel sums a name's whole spend over
    // (session-info trackedSessionIds → sumAgentCost). Only setSessionId appends
    // to it, and only on a CHANGE, so an array dropped here never regrows — the
    // seat's lifetime cost silently restarts from the current id and reads as
    // "agent total below session total". All three callers omitted it and none
    // had a reason to; an opt-in field list makes a fourth caller repeat the
    // same omission, so the invariant lives in the helper, not in its callers.
    _preserveAcrossRestart(name, priorEntry, fields) {
      if (!priorEntry || !Array.isArray(fields)) return;
      const seed = { name };
      let any = false;
      for (const f of [...fields, ...ALWAYS_PRESERVE]) {
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
      const openTicketFor = (s) => {
        try {
          const t = resolvedTeamFor(s.cwd);
          if (!t || !t.root) return null;
          if (!ticketsByRoot.has(t.root)) ticketsByRoot.set(t.root, ticketsStore.load(t.root));
          const role = matchSeatRole(t, s.name);
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

    // WORKSPACE TEARDOWN RUNS OVER PERSISTENCE, NOT OVER THE LIVE MAP (F005).
    // listForWorkspace above filters list(), which maps `this.sessions` — the
    // live map. An archived session is never spawned by design
    // (session-restore.js), so it is never in that map: killing what
    // listForWorkspace returns and then dropping the workspace record leaves
    // persistence rows carrying a workspaceId no window will ever carry again.
    // Those rows are then unreachable from every surface — every IPC listing is
    // workspace-scoped, and discovery excludes any conversation whose sessionId
    // is in trackedSessionIds(), which unions in the orphan itself. The
    // conversation is stranded by the very record that was meant to keep it.
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
      clearTimeout(s._replayFallbackTimer);
      clearTimeout(s._parkedDrainFallbackTimer);
      clearTimeout(s._rebootNoticeRetryTimer);
      clearTimeout(s._rebootNoticeFlushTimer);
      clearTimeout(s._specConfirmTimer);
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
      if (s.watcher) s.watcher.stop();
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

    // One subagent turn into the session's ring. Observer-grade like
    // _noteFileTouches: this runs from the wire tee's turn.completed, which the
    // proxy emits only AFTER the client's final byte (wire/proxy.js — "client
    // bytes first, always"), so a throw here cannot reach the request. The catch
    // is the second line of that defence, not the first.
    //
    // ACCEPTED MISATTRIBUTION WINDOW (operator ruling, t209): RoleClassifier's
    // per-session fingerprint map is empty on a fresh Clodex process, so until
    // the first main-line turn establishes it, the documented cc_is_subagent
    // leak (wire/role.js — a parent turn carrying a recycled
    // x-claude-code-agent-id, wire-confirmed 2026-06-14) can file ONE parent
    // turn as a subagent row here. It is self-clearing and deliberately not
    // gated: do not "fix" a misattributed row by weakening genuineSubagent's
    // fingerprint backstop — that trades a cosmetic, one-turn artefact for the
    // leak the backstop exists to catch.
    //
    // The key must stay byte-identical to wirescope's instance key (agent-id
    // verbatim, role as fallback): the chip strip is wirescope's and the feed is
    // looked up by the chip's key, so a mismatch shows an empty feed for a live
    // subagent rather than failing.
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
      // A turn started, so the last spec write reached a composer that submitted it.
      if (s && state !== 'idle' && s._specUnconfirmed) {
        s._specUnconfirmed = null;
        clearTimeout(s._specConfirmTimer);
        s._specConfirmTimer = null;
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
      // context it just built. This fires for the CLI's own auto-compact too (the
      // watcher reads the transcript, not only Clodex-triggered compactions),
      // which is exactly when a seat would otherwise never refresh at all.
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
      try { if (isDraftOpen(session)) return; } catch { return; }   // don't splice an open draft
      if (!hasActivePending(PENDING_DIR, session.name)) return;
      this._injectText(session, '', {
        parkable: true,
        produce: () => {
          if (session._dead) return null;
          try { if (isDraftOpen(session)) return null; } catch { return null; }
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

    // Boot-ready-edge drain (T54). Claims LATE, like every other drain: peek
    // (non-destructive) to decide whether to bother, then enqueue a fire-time
    // PRODUCER that does the destructive drainPending claim only once the InjectQueue
    // is past its ready + quiet gates and about to write. If the seat died or a draft
    // opened in the meantime the producer claims nothing and returns null — the
    // delivery stays parked, recoverable, its ✉ intact. Exactly-once holds: the claim
    // is the same atomic dir-rename the hook + idle drains use, so whoever fires
    // first owns the messages.
    _drainPendingAtBootReady(session) {
      if (!session || session.agentType !== 'claude' || session._dead) return;
      try { if (isDraftOpen(session)) return; } catch { return; } // don't splice an open draft
      if (!hasActivePending(PENDING_DIR, session.name)) return;    // nothing active — leave passives parked
      // Every bail here is a park that stays on disk EXCEPT the last one, where the
      // claim already succeeded and came back empty. Saying which is the difference
      // between "deferred" and "someone else took it", and the silence over both is
      // why a lost boot-window delivery left no evidence across seven reboots.
      const produce = () => {
        if (session._dead) return null;
        try { if (isDraftOpen(session)) return null; } catch { return null; }
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

    _scanJsonlText(text, senderName, touches) {
      const s = this.sessions.get(senderName);
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


    async _handleIntent(senderName, intent) {
      const session = this.sessions.get(senderName);

      if (intent.type === 'end') return;

      if (intent.type === 'unknown') {
        if (session && session.agentType) {
          const more = intent.more ? ` (+${intent.more} more unrecognized [agent:…] lines this turn)` : '';
          // Grants-scoped: this list is written INTO the seat's context, so
          // naming a session-scoped plugin's verb here would advertise the
          // plugin's existence to exactly the agents it is meant to be
          // invisible to.
          const grants = getPersistence().get(senderName)?.pluginGrants;
          this._injectText(session,
            `[agent:?] unrecognized intent \`${intent.text}\`${more} — nothing was done. `
            + nearMissFormHint(intent.text)
            + `Valid intents: ${validIntentNames(grants).join(', ')}. `
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
            : `the ${intent.type} intent is disabled for this session${this._deniedIntentPayload(session, intent)}`;
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
        // "requested", not "happened": the stamp is written at QUEUE time, and since
        // t282 the restart may still be waiting for an all-idle window, or have been
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
        // the seat hears about that. Nobody is watching the desktop notification
        // on its behalf.
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

      // Both bounds are checked BEFORE attempting, not only after a throw. The old
      // code reached its stale-drop solely through retainOrExpire, so a notice that
      // never threw could not expire — and once the retry below makes retention the
      // normal outcome rather than the error path, an unchecked notice would be
      // re-offered at every launch for as long as it existed. Age is the outer
      // bound; attempts is the one that actually ends a doomed notice.
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
      // two-workspace launch made two offers ~0.4s apart: the ladder burned to its
      // ceiling before its first rung elapsed, the 30s rung was never used, and
      // delivery fell through to the generic 5-minute cap. The budget is per notice,
      // not per restore — suppress the duplicate rather than widen the budget.
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
    // and sweep a DM parked just before it fires. The 300s park cap would have
    // flushed that DM anyway, and the turn check below means a seat that has
    // already woken forces nothing at all.
    _armRebootNoticeFlush(target, parkedAt = Date.now()) {
      if (target._rebootNoticeFlushTimer) return;   // one deadline per launch, earliest governs
      // Carried across a re-arm, NOT restamped: the turn check below asks "did the
      // seat wake since the PARK", and refreshing this on every round would keep
      // moving the line the turn has to beat, so a seat that woke during round 1
      // would look unwoken forever.
      // Named like the retry's fire, and for the same reason: a test drives it
      // directly instead of waiting out 25s of wall clock.
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
        // bare Ctrl-U clear-line into whatever is typed (inject-queue.js) — the
        // splice INJECT_QUIET_MAXWAIT was raised to 5 min to avoid after it cut
        // live composition mid-word twice. Shortening the deadline to 25s without
        // this check would make that 12x more likely, trading the annoyance this
        // ticket fixes for a worse one.
        //
        // Re-arm rather than flush, and deliberately WITHOUT a round bound: the
        // 300s _armParkCap is armed independently at T+0 and remains the ultimate
        // backstop, so unbounded re-arming degrades at worst to exactly master's
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
        // app down rather than costing one undelivered notice. The ladder re-parks.
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
    // still asking, because by then something else has woken the agent — which is
    // exactly how this defect stayed invisible.
    //
    // The liveness test is deliberately NOT _armParkedDrainFallback's
    // fs.existsSync on the park file. That timer is the right shape against "the
    // drain never fired" and blind to the failure here: the drain DID fire, the
    // file is gone, and the write vanished — which existsSync reads as success.
    //
    // What is observable is that the seat took a turn after the park. A turn means
    // the CLI processed input, which is the closest this layer gets to delivery.
    // It is inference, not confirmation: a turn the operator caused would satisfy
    // it too. That costs at most one duplicate notice — self-dating, one line, and
    // by ruling the safe direction — whereas trusting the claim costs the message.
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
      // Held as a named function so a test can run the retry on demand rather than
      // waiting out a 30s/120s wall-clock delay or reaching into Node's Timeout
      // internals. The delay itself is asserted separately from the behaviour.
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
          finish(() => fail(`timed out after ${timeoutMs}ms`));
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
    // tab, where the operator can watch it happen, and report the result back to
    // that agent alone.
    //
    // BOTH halves of the target are derived from the sender: the seat is the
    // session's name and the window is its workspace. The agent supplies
    // neither, so there is no seat string to validate and no way to reach
    // another agent's terminal or the seatless workspace shell. That is stronger
    // than the IPC path, which takes the seat from its payload.
    //
    // The result does NOT come back from here. It arrives later, on the seat's
    // selection queue, when the shell's D mark says the command ended — see the
    // onExecResult wiring where the drawer PTYs are built.
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
      // Today it cannot fire, and that is worth stating rather than leaving a
      // reader to assume it is load-bearing: the switch above requires
      // `agentType`, which is non-null only for claude/codex, and a peer is not
      // a local session at all (nothing but create() writes `sessions`, and it
      // only ever stores claude/codex/bash). The refusal that ACTUALLY fires for
      // a seat with no terminal is `no-shell`, from the exec itself. This stays
      // because the structural reason is an accident of two other decisions:
      // make bash sessions intent-capable, or give a peer a local session
      // record, and this becomes the only thing standing between them and a
      // shell they should not have.
      // No truthiness guard on the dep. An unwired termAvailableFor must throw
      // here rather than skip the check — the same posture termExec gets from
      // its host stand-in above, where the fallback ANSWERS instead of silently
      // doing nothing.
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
        // with "no unit" and reads as a bug in the delete path. The digest is
        // regenerated on next spawn; the delete is not. A throw also leaves the
        // OLD hook-digest.json in place, so a digestNonEmpty left true still
        // describes a digest that exists.
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
      // `worktree:<branch>` spawns the seat in its own `git worktree` on that
      // branch, off the repo containing cwd. The branch name is validated inside
      // createWorktree (it reaches git argv), so this only rejects the empty form
      // — a bare `worktree:` that parsed to nothing must not spawn a NORMAL seat
      // silently, which is the isolation the caller asked for going missing.
      const branch = (intent.worktree || '').trim() || null;
      if (intent.worktree != null && !branch) {
        reply('error: worktree: needs a branch name — [agent:spawn name:X cwd:Y worktree:<branch>]');
        return;
      }
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
      // and nothing said so. Honored here through the SAME filter the reviewer and
      // ticket paths use, not a copy of it: env is an authority surface (base-url,
      // credential and model redirects) and a template is agent-writable, so this
      // stays a fixed code-level ceiling. Keys outside it are dropped and named in
      // the reply, because a silently ignored env key is the bug being fixed.
      const { sessionEnv, dropped: envDropped, badType: envBadType } = filterTemplateEnv(tpl && tpl.env);

      setImmediate(async () => {
        // Declared OUTSIDE the try: the catch below removes the worktree, and a
        // binding scoped to the try is invisible there.
        let wt = null;
        let spawnCwd = cwd;
        try {
          if (branch) {
            // BEFORE create(), never after: the seat must boot with the worktree as
            // its cwd. Retrofitting one onto a live session would leave the PTY,
            // the hook's transcript symlink and the prompt's team block all built
            // against the old path.
            const r = await gitWorktree.createWorktree(cwd, branch);
            if (!r || !r.ok) {
              reply(`error: worktree "${branch}": ${(r && r.error) || 'could not be created'} — nothing spawned`);
              return;
            }
            wt = { path: r.path, branch: r.branch };
            spawnCwd = r.path;
          } else {
            ensureDir(cwd); // self-contained: mkdir the cwd if absent — no external tool
          }
          await this.create(
            name, type, spawnCwd, childArgs, null, workspaceId,
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
            // Wire-off is not an authority grant in the privileged-intent sense —
            // it REMOVES a capability (the tee, wire telemetry, warmth)
            // rather than adding one, so an agent-initiated template spawn may
            // carry it. What it cannot do is redirect traffic: proxyBase is nulled
            // outright, never pointed somewhere the template chose.
            (tpl && tpl.noWire) === true,
          );
          // AFTER create(), which is what mints the persistence entry: setWorktree
          // silently no-ops when no entry exists, so recording it earlier would
          // write nothing and leave Delete Session… unable to offer the removal.
          if (wt) {
            try { getPersistence().setWorktree(name, wt); } catch { /* best-effort */ }
          }
          this._applyTemplatePersistence(name, tpl);
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd: spawnCwd, backend: (this.sessions.get(name) || {}).backend || null, noWire: !!(this.sessions.get(name) || {}).noWire,
          });
          const where = wt ? `${spawnCwd} (worktree, branch ${wt.branch})` : spawnCwd;
          this._broadcast('ipc-message', {
            type: 'spawn', from: spawner.name, to: name, body: `spawn → ${name} @ ${where}` + (tpl ? ` (template ${tplLabel})` : ''),
          });
          log.info('intent', `spawn by ${spawner.name} → ${name} (${type}) @ ${where}` + (tpl ? ` via template "${tplLabel}"` : ''));
          reply(`ok: spawned "${name}" (${type}) @ ${where}` + (tpl ? ` via template "${tplLabel}"` : '')
            + (envDropped.length ? ` — env keys not allowed, dropped: ${envDropped.join(', ')}` : '')
            + (envBadType.length ? ` — env keys [${envBadType.join(', ')}] are allowed but their values are not strings — dropped (quote the value in the template)` : ''));
        } catch (err) {
          log.error('intent', `spawn by ${spawner.name} → ${name} failed: ${err.message}`);
          // The worktree outlives a failed spawn otherwise: create() threw, so no
          // session record exists and nothing on the UI can offer to remove it.
          if (wt) {
            const r = await gitWorktree.removeWorktree(wt.path).catch(() => ({ ok: false }));
            log.info('worktree', `${r && r.ok ? 'removed' : 'ORPHANED'} ${wt.path} after failed spawn of ${name}`);
          }
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
        for (const tk of ticketsStore.load(team.root)) {
          if (tk && tk.assignee === roleKey && tk.state === 'open') tickets.push(tk.id);
        }
      } catch { tickets.push('<ticket check unavailable>'); }
      return { seats: [...seats], tickets };
    }

    // `opts.ticketId` marks this review as a TICKET's, which routes its verdict to
    // the ticket record instead of back to the asker. It is a caller's explicit
    // claim, never derived from the scope text: an ad-hoc review whose prose
    // happens to mention a ticket id would otherwise divert its verdict to that
    // ticket and the asker would be told nothing.
    _handleTeamReview(session, body, opts = {}) {
      // The loop calls this AS the lead (it is lead-gated), so without a diversion
      // every spawn reply would print in the lead's terminal — a second path to
      // the lead beside escalation, which the loop's design forbids. onReply
      // diverts, and must never suppress: the same reply carries the template and
      // tool-cap refusals, and the loop turns those into escalations.
      const onReply = (opts && typeof opts.onReply === 'function') ? opts.onReply : null;
      const reply = onReply || ((msg) => this._injectText(session, `[agent:team-review] ${msg}`, { parkable: true }));
      const reviewTicket = (opts && opts.ticketId) || null;
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
      // Caught, because this handler is reached from an unawaited async
      // _handleIntent: an uncaught throw here becomes an unhandled rejection and
      // the lead is told NOTHING. The resolver's purpose guard is deliberately
      // fail-closed, and fail-closed is only useful if it is also fail-visible.
      let shape;
      try {
        shape = this.resolveSeatShape(team, 'reviewer', 'review', session);
      } catch (err) {
        // Not err.message alone: a non-Error throw would report "error: undefined",
        // which tells the lead nothing at all.
        reply(`error: ${err && err.message ? err.message : String(err)}`);
        return;
      }
      const reviewTpl = shape.tpl;
      const type = shape.type;
      const cwd = shape.cwd;
      const tplWarn = reviewTpl
        ? ''
        : ` — NOTE: reviewer template "${templateName}" not found in the library; spawned from built-in defaults (install it to customize)`;
      const reviewerSystemPrompt = shape.systemPromptFile;
      const promptEscapeWarn = shape.promptEscaped
        ? ` — NOTE: reviewer systemPromptFile "${shape.promptEscaped}" contains a path separator or "..", which could escape library/prompts/system; ignored, using the built-in default "${REVIEWER_FALLBACK.systemPromptFile}"`
        : '';
      // Two reasons, never merged: an unknown key is an authority question, a
      // non-string value is a template typo. Telling the operator to seek
      // approval for a key that is already allowed sends them to the wrong fix.
      const envWarn = (shape.envDropped.length
        ? ` — reviewer template env keys [${shape.envDropped.join(', ')}] are outside the allowed set [${[...REVIEWER_ENV_ALLOWLIST].join(', ')}] — dropped (env is an authority surface; requires operator approval)`
        : '')
        + (shape.envBadType.length
          ? ` — reviewer template env keys [${shape.envBadType.join(', ')}] are allowed but their values are not strings — dropped (quote the value in the template)`
          : '');
      const capWarn = shape.beyondCap.length
        ? ` — requested [${shape.beyondCap.join(', ')}] beyond the reviewer cap [${REVIEWER_TOOL_CAP.join(', ')}] — requires operator approval; spawned with [${shape.effectiveTools.join(', ')}]`
        : '';

      // Two refusals, one ruling: a `tools` the cap cannot honor must NOT fall back
      // to the full cap. The only fallback available grants more than the template
      // asked for, the template is agent-writable, and widening past the request is
      // the one direction that must never be automatic. Both refuse BEFORE the
      // name-mint loop below: that loop's synchronous upsert IS the reservation, so
      // bailing after it burns a reviewer name permanently. Both report via reply(),
      // not throw, for the same reason as the resolveSeatShape catch above.
      // They are disjoint by construction — malformed carries requestedTools: null —
      // so the order between them cannot change which message fires.

      // A wrong TYPE is a syntax error to fix, and telling an author to add cap
      // members to a string sends them to the wrong edit — hence its own message.
      if (shape.toolsMalformed) {
        reply(`error: reviewer template "${templateName}" has a "tools" that is not an array (${typeof (shape.tpl && shape.tpl.tools)}) — it cannot be intersected with the reviewer cap [${REVIEWER_TOOL_CAP.join(', ')}], and falling back to the full cap would grant more than the template asked for; no reviewer spawned (make "tools" an array, or remove it to accept the full cap)`);
        return;
      }
      // A well-formed list the cap intersects emptily — including `[]` — is a list
      // to fix: effectiveTools is [], so disabledTools inverts to every tool and the
      // seat would spawn unable to read the diff it reviews.
      if (shape.requestedTools && shape.effectiveTools.length === 0) {
        reply(`error: reviewer template "${templateName}" requests tools [${shape.requestedTools.join(', ')}], none of which are within the reviewer cap [${REVIEWER_TOOL_CAP.join(', ')}] — the seat would spawn with no tools at all and could not read the diff; no reviewer spawned (fix the template's "tools")`);
        return;
      }

      // A ticket's reviewer is named for the TICKET AND THE ROUND
      // (`<team>-reviewer-<n>-r<round>`), not for a seat counter. Two properties
      // depend on it: a watchdog can address the seat by a name that means one
      // review, and a reminder aimed at a finished review cannot reach whoever
      // claimed `-reviewer-1` next.
      //
      // The round is read off the TICKET — the same durable counter
      // _writeTicketDiff adds one to and _landVerdictOnTicket stamps — and NOT
      // off the mint index below. kill() removes the seat's record when a
      // reviewer retires, so the index restarts at 1 for round 2; anything
      // derived from it renumbers round 2 as round 1. Measured on t332: REWORK
      // then ACCEPT, both billed to review-r1.
      //
      // A taken scoped name falls back to the counter rather than refusing: the
      // loop has no way to act on a refusal here, and a second reviewer for a
      // round whose verdict has not landed is an anomaly worth spawning through
      // rather than a reason to strand the ticket.
      //
      // The name is unique per (ticket, ROUND), not per review. A verdict that
      // fails to parse leaves _landVerdictOnTicket's counter unbumped while
      // kill() still reaps the record, so a re-review of that ticket mints the
      // same name and the same cost label a second time. Narrower than the
      // collapse above — two reviews of ONE round, not two rounds merged — and
      // bumping at spawn would trade it for a round number that counts spawns
      // rather than verdicts, which is the number the loop's rework ladder reads.
      const roundTicket = reviewTicket ? this._loadTicket(team, reviewTicket) : null;
      // _loadTicket returns null for a missing ticket AND for an unreadable
      // board. Silent, that degrades a ticket review to the counter name and to
      // `reviewRound = n - 1` — the exact t332 round collapse this mint exists to
      // prevent, reintroduced with no signal. Logged so it is auditable.
      if (reviewTicket && !roundTicket) {
        log.warn('intent', `team-review for ticket ${reviewTicket}: ticket not readable from the board — falling back to the counter name and a seat-index round (rounds may collapse in the cost rollup)`);
      }
      const ticketRound = roundTicket ? (Number(roundTicket.reviewRound) || 0) + 1 : 0;
      // The ticket number is required to be digits rather than name-checked: it
      // is the only part of this name not already in the counter name below, so
      // a team name that would spell an illegal seat spells one either way. The
      // sibling mint _mintTicketSeat DOES check AGENT_NAME_RE and returns a
      // structured refusal — it has a caller that can act on one; this path
      // falls back to the counter name instead, so the asymmetry is deliberate.
      const ticketNum = /^t?(\d+)$/.exec(String(reviewTicket || ''));
      let name = null;
      if (ticketRound > 0 && ticketNum) {
        const scoped = `${team.name}-reviewer-${ticketNum[1]}-r${ticketRound}`;
        if (!this.sessions.has(scoped) && !getPersistence().get(scoped)) name = scoped;
      }
      let n = 1;
      if (!name) {
        do { name = `${team.name}-reviewer-${n++}`; } while (this.sessions.has(name) || getPersistence().get(name));
      }

      // MUST-FIX 1 (name-mint TOCTOU): a second [agent:team-review] in the SAME lead
      // turn runs its taken-name loop synchronously, BEFORE either deferred create()
      // has populated the sessions map — so both would mint -1 and collide. Reserve
      // the name SYNCHRONOUSLY here: the ephemeral+reviewFor seed IS the reservation,
      // so the second handler's getPersistence().get(name) sees it and bumps to -2.
      // This also carries the seat's identity fields (drives review-done's guard +
      // the team-retire discard disposition); create()'s own upsert spread-merges
      // over this stub, and the restart-preserve seam re-seeds it after a kill().
      // `wireLabel` rides the SAME synchronous stub as the name reservation, and
      // that is the ordering that makes it work: create() reads it back off the
      // record to mint the proxy agent id, so a label written after the deferred
      // create() would label nothing. The round comes from the ticket when there
      // is one, so round 2's spend stays off round 1's label; the seat index is
      // only a fallback for an ad-hoc review, which has no ticket to count on.
      const reviewRound = ticketRound > 0 ? ticketRound : n - 1;
      // The id comes from `reviewTicket` when there is one — the caller's explicit
      // claim — and only falls back to the scope prose for an ad-hoc review, which
      // has no claim to read. Scraping prose we already hold the answer to makes
      // the label depend on the scope builder's wording: a scope that stopped
      // spelling the id would silently bill every ticket's review to `<team>.review-rN`.
      const reviewLabel = teamCost.reviewWireLabelFor({
        team: team.name, ticketId: reviewTicket || teamCost.ticketIdFromScope(scope), round: reviewRound,
      });
      getPersistence().upsert({
        name, ephemeral: true, reviewFor: session.name,
        // Rides the SAME synchronous stub as reviewFor, for the same reason the
        // label does: review-done reads it back off the record, so a field written
        // after the deferred create() would route nothing. `reviewFor` stays
        // regardless — it is still the seat's identity (review-done's guard) and
        // the fallback destination when the ticket cannot be resolved.
        ...(reviewTicket ? { reviewTicket } : {}),
        ...(reviewLabel ? { wireLabel: reviewLabel } : {}),
      });

      let promptWarn = '';
      if (reviewerSystemPrompt) {
        try {
          const promptFile = path.join(REGISTRY_DIR, 'library', 'prompts', 'system', `${reviewerSystemPrompt}.md`);
          if (!fs.existsSync(promptFile)) {
            promptWarn = ` — WARNING: role prompt "${reviewerSystemPrompt}.md" not found under library/prompts/system, so the reviewer boots UNBRIEFED (install it, then re-review)`;
          }
        } catch { /* preflight is best-effort — a stat error is not a spawn blocker */ }
      }

      // The scope rides the seat's CONSTRUCTED PROMPT, not the dm below. A dm is a
      // delivery, and the one seat that cannot reliably take a delivery is a brand
      // new one: the park drains into the CLI's boot re-render, which wipes it, and
      // the t194 fallback then finds the park claimed and correctly concludes
      // nothing is owed. Measured six times in one day — seat alive, zero tokens,
      // transcript target never created, scope gone. A prompt is present before the
      // first turn instead of being written at it, so there is no window to lose it
      // in. It also survives /clear and /compact, which a delivered dm does not:
      // create() persists this as `systemPrompt` and refreshPrompt replays it, so a
      // reviewer that compacts mid-review still knows what it is reviewing.
      const reviewBrief = [
        'REVIEW SCOPE — this is the specific work you were spawned to review.',
        '',
        scope,
        '',
        `Report your verdict with [agent:review-done] <verdict>, which returns it to ${session.name} and retires you.`,
      ].join('\n');

      setImmediate(async () => {
        try {
          await this.create(
            name, type, cwd, shape.extraArgs, null, shape.workspaceId,
            reviewBrief, false, session.proxy ?? null, shape.agents, shape.denyBuiltins, shape.disabledTools,
            shape.disabledSkills, shape.injectSkills,
            reviewerSystemPrompt, shape.appendPromptFiles, shape.execCommands, shape.intents, shape.env, true,
          );
          // AFTER create(), not before: the setters resolve the entry by name and
          // silently no-op if it isn't there yet. A reviewer that skipped this ran
          // unstripped no matter what the template said, which is invisible from
          // inside the seat.
          this._applyTemplatePersistence(name, shape.tpl);
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd, backend: (this.sessions.get(name) || {}).backend || null, noWire: !!(this.sessions.get(name) || {}).noWire,
          });
          // Kept, and deliberately CONTENTLESS: the prompt above carries the scope,
          // but a prompt alone never makes the CLI take a turn. This is the nudge
          // that starts it. Losing this one to the boot re-render costs a start, not
          // the scope — and the t194 fallback re-drains it; losing the scope with it
          // was the failure. Do not re-inline the scope here: two copies would
          // disagree the moment one is edited, and the dm copy is the losable one.
          this._deliverParkedActive(name, session.name, 'Your review scope is in your system prompt. Begin.', 'dm');
          // Armed AFTER the nudge, so the window measures the nudge's outcome and
          // not the spawn's. A reviewer is the one seat with no other traffic to
          // earn a turn from, so nothing else here would ever notice it not taking
          // one — the spec-confirm latch does not cover it (that watches a TICKET
          // spec injected into an existing seat, and this scope is never injected).
          this._armReviewStartCheck(name, session.name);
          this._broadcast('ipc-message', {
            type: 'team-review', from: session.name, to: name, body: `review → ${name} @ ${cwd}`,
          });
          log.info('intent', `team-review by ${session.name} → ${name} (${type}) @ ${cwd}`);
          reply(`spawned ${name} — it'll report back with [agent:review-done]; watchdog it by name${capWarn}${envWarn}${promptWarn}${promptEscapeWarn}${tplWarn}`);
        } catch (err) {
          if (!this.sessions.has(name)) getPersistence().remove(name);
          log.error('intent', `team-review by ${session.name} → ${name} failed: ${err.message}`);
          reply(`error: ${err.message}`);
        }
      });
    }

    // Write a parsed verdict onto its ticket, or null when it cannot be placed —
    // no team owns the reviewer's cwd, no such ticket, or the verdict text names
    // neither ACCEPT nor REWORK. Every null is a fall-through to the lead, so a
    // reviewer that answered off-grammar still reaches a human rather than
    // silently stamping a ticket with a verdict nobody chose.
    //
    // `reviewRound` counts on the TICKET, not off the reviewer seat's name index:
    // the round has to survive the reviewer AND the hand dying, and a seat index
    // is gone with the seat.
    _landVerdictOnTicket(session, ticketId, verdict) {
      // Line-anchored, because §3 feeds round 1's verdict into round 2's review
      // scope: the previous verdict arrives QUOTED inside the new body, so an
      // unanchored match takes the first mention anywhere in the text and can
      // land the OLD round's ACCEPT on a ticket the reviewer just sent back.
      // Bullets and bold are allowed as decoration; `>` is deliberately NOT —
      // a quoted line is exactly the shape being excluded, and it is the one
      // piece of decoration that carries that meaning.
      const m = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*|__)?[ \t]*\bVERDICT\b\W*\b(ACCEPT|REWORK)\b/im.exec(verdict);
      if (!m) return null;
      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      if (!team) return null;
      let tickets;
      try { tickets = ticketsStore.load(team.root); } catch { return null; }
      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket) return null;
      // A closed ticket takes no verdict: the seat was retired and the loop step
      // is over, so stamping one would revive a finished ticket's review fields
      // and leave the board showing a round nobody can act on. Null falls through
      // to the lead, who is the one who can.
      //
      // `done` + a live `loopStep` is the ONE exception, and it is not a
      // loosening: the loop spawns its reviewer AFTER `task done` has already
      // written state `done`, so under the plain guard every loop verdict would
      // fall through to the lead — which is precisely the round trip this whole
      // design removes. `loopStep` is what distinguishes a ticket the loop is
      // still holding from one that is genuinely finished; an ad-hoc review of a
      // long-closed ticket has no loopStep and still correctly falls through.
      if (!ticketInFlight(ticket)) return null;
      ticket.verdict = m[1].toUpperCase();
      ticket.mustFix = extractMustFix(verdict);
      ticket.reviewRound = (Number(ticket.reviewRound) || 0) + 1;
      ticket.reviewedAt = Date.now();
      ticket.lastActivityAt = ticket.reviewedAt;
      // The loop's hand-off point: the verdict is the step the loop was waiting
      // on, so it no longer holds the ticket and the watchdog must stop treating
      // it as in-flight. Cleared here rather than in the caller because this is
      // the write that makes the verdict durable — a clear in a caller that
      // throws first would leave a landed verdict permanently marked in-flight.
      delete ticket.loopStep;
      // A verdict is progress, so it closes the stall episode the review opened —
      // otherwise the watchdog spends its one nudge on a ticket that just moved.
      ticket.nudgedAt = null;
      try { ticketsStore.save(team.root, tickets); } catch { return null; }
      // Wrapped because the verdict is ALREADY SAVED above: an escaping throw
      // here would abandon _handleReviewDone before it retires the reviewer,
      // leaving a landed verdict with a live reviewer seat still holding the
      // ticket — a half-completed loop step, which nothing downstream reconciles.
      // Badges are recomputed on the next mutation; a stranded seat is not.
      try { this._reconcileTickets(team); }
      catch (e) { log.error('intent', `ticket ${ticketId}: verdict saved but reconcile failed: ${e.message}`); }
      return { verdict: ticket.verdict, mustFix: ticket.mustFix, reviewRound: ticket.reviewRound };
    }

    // The verdict prose, written beside the diff it reviewed. Shares
    // _ticketDiffDest's resolution so the body cannot land somewhere the diff
    // would not, and takes the round from the ALREADY-STAMPED record — this
    // runs after the save, where `reviewRound` is the round that just landed,
    // unlike _writeTicketDiff which runs before it and adds one.
    _writeVerdictBody(session, ticketId, landedOn, fullVerdict) {
      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      if (!team) return { ok: false, path: null, error: 'no team' };
      const ticket = this._loadTicket(team, ticketId);
      if (!ticket) return { ok: false, path: null, error: `no ticket ${ticketId}` };
      const dest = this._ticketDiffDest(team, ticket);
      if (!dest.ok) return { ok: false, path: null, error: dest.error };
      const round = Number(landedOn.reviewRound) || Number(ticket.reviewRound) || 1;
      const file = path.join(dest.dir, `review-${ticketId}-r${round}.verdict.md`);
      try {
        ensureDir(dest.dir);
        fs.writeFileSync(file, fullVerdict);
      } catch (e) {
        return { ok: false, path: null, error: e.message };
      }
      return { ok: true, path: file, error: null };
    }

    // The lead's copy of a TICKET verdict: a SUMMARY, never the body. The record
    // stays the store — this only tells the lead the store changed, because a
    // lead that does not know a review finished is a lead not merging it.
    //
    // Summary rather than fall-through, against the measured alternative: one
    // real verdict was 15839 bytes, and posting that to the inbox on every
    // review is the flooding the record/dm split was built to prevent. The
    // fields here are the ones the lead acts on — which ticket, which way it
    // went, which round, and whether there is work to hand back — and they are
    // exactly what a truncated dump of the record hides, since `verdict` sits
    // after a multi-KB `report`.
    //
    // Called AFTER _landVerdictOnTicket has returned, i.e. after the save: a
    // throw here must never unwind a durable verdict, so everything is wrapped
    // and the worst case is a landed verdict the lead has to poll for — the
    // status quo this fixes, never a lost one. Ordering is the invariant; do
    // not hoist this above the save.
    _notifyLeadOfVerdict(session, lead, ticketId, landedOn, fullVerdict) {
      try {
        const n = countMustFix(landedOn.mustFix);
        const mf = n === 0
          ? 'no must-fixes'
          : `${n} must-fix${n === 1 ? '' : 'es'}`;
        // The full prose goes in the ticket's task dir, beside the diff it is
        // about. Not a spill: those are swept by AGE (MSG_MAX_AGE, 30 min), so
        // an overnight lead wakes to a dead path — and not the record either,
        // which a truncated dump already hides `verdict` inside. The task dir
        // is durable, outside the user's repo, and costs the record nothing.
        const written = this._writeVerdictBody(session, ticketId, landedOn, fullVerdict);
        const where = written.ok
          ? `Full verdict (${fullVerdict.length} bytes): ${written.path}`
          : `Full verdict (${fullVerdict.length} bytes) could NOT be saved (${written.error}) — only the summary above survives.`;
        const body = [
          `${landedOn.verdict} on ticket ${ticketId} (review round ${landedOn.reviewRound}, ${mf}).`,
          `Landed on the ticket record; the board shows it via [agent:task list all].`,
          where,
        ].join('\n');
        // Not urgent: a verdict is durable on the record before this runs, so
        // waking a busy lead buys nothing the next turn does not. A hold or a
        // park is therefore an acceptable outcome and is logged, not retried.
        const r = this._gatedDeliver(lead, session.name, body, false, `[ticket ${ticketId} ${landedOn.verdict}]`);
        if (r && r.error) {
          log.warn('intent', `ticket ${ticketId}: verdict landed but lead ${lead} not notified — ${r.error}`);
        }
      } catch (e) {
        log.error('intent', `ticket ${ticketId}: verdict landed but lead notification failed: ${e.message}`);
      }
    }

    // An ACCEPT lands the branch on master. The edge the loop used to stop dead
    // at: dispatch, verify, review and reject all ran themselves, and every
    // accept then cost the lead six manual steps.
    //
    // EVERY failure arm escalates through _escalateTicket — the loop's existing
    // single channel to the lead, deliberately not a second one — and every one
    // of them leaves the tree, the branch and the seat exactly as they were.
    //
    // What this does NOT do, and must not: `task accept`. That retires the seat
    // and destroys the worktree, which is the lead's call after reading the
    // verdict; a merge is recoverable by a revert, a destroyed worktree is not.
    // It also does not touch CHANGELOG.md — that file conflicts across every
    // live branch, so it stays the lead's, and the notification says an entry is
    // owed instead.
    // ONE merge at a time, process-wide, chained rather than fired.
    //
    // Every step of a merge writes the shared root checkout, and the suite in
    // the middle of it runs for MINUTES. Two ACCEPTs landing in that window is
    // not a scheduler-tick race: ticket A merges and blocks inside its suite,
    // B's gates all pass (root is clean and on master — A's merge is clean), and
    // B's `git merge` mutates the tree under A's running suite child. A's result
    // then describes A+B, and if it is red the revert of A either conflicts or
    // succeeds and leaves B merged and never verified, with B's "merge landed"
    // notification firing on a suite that measured A.
    //
    // The chain is on the manager, not per team: the writes collide on a
    // checkout, but the suite binds real PORTS, so two teams' merges overlapping
    // deadlock exactly as two suites would. `.catch` inside the link, so one
    // rejected merge cannot break the chain for every merge after it.
    _queueAutoMerge(team, ticketId, landedOn, verdictText) {
      // COUNTED, not probed: a promise cannot be asked whether it has settled,
      // and the count is the only place the wait becomes visible. Because the
      // chain is process-wide, a merge wedged on team A stalls team B for as
      // long as a suite can take (the lock wait alone is 20 minutes) with
      // nothing in the log where a lead debugging the silence would look.
      this._mergePending = (this._mergePending || 0) + 1;
      if (this._mergePending > 1) {
        log.info('ticket', `auto-merge for ${ticketId} QUEUED behind ${this._mergePending - 1} other merge(s) — one is in flight and the rest are waiting, since one merge runs at a time process-wide and each holds the chain through its whole post-merge suite`);
      }
      this._mergeChain = Promise.resolve(this._mergeChain)
        .catch(() => {})
        .then(() => this._autoMergeTicket(team, ticketId, landedOn, verdictText))
        .catch((e) => {
          log.error('ticket', `auto-merge for ${ticketId} rejected: ${e && e.message ? e.message : String(e)}`);
        })
        // After the catch, so it runs on both arms: a counter that leaked on a
        // rejected merge would report a phantom queue forever after.
        .then(() => { this._mergePending -= 1; });
      return this._mergeChain;
    }

    // The pid holding the root checkout's suite lock, or null. Reads the same
    // `<lock>/pid` file scripts/run-tests.js writes, and treats a lock naming a
    // DEAD pid as absent for the same reason the runner reclaims it: a killed
    // run never cleans up, and refusing every merge forever afterwards would be
    // a wedge with no way out.
    //
    // The catch covers ONLY the read — an absent lock dir is the normal case and
    // means nobody holds it. The liveness probe stays OUTSIDE it: a throw there
    // swallowed into "nobody is running a suite" would silently disable the gate,
    // and a gate that fails open is worse than none, since the escalation it owes
    // never arrives either. Let it reach _autoMergeTicket's catch-all, which
    // escalates and merges nothing.
    _suiteLockHolder(team) {
      let pid = null;
      try {
        pid = Number(fs.readFileSync(path.join(team.root, '.test-digest.lock', 'pid'), 'utf8').trim()) || null;
      } catch { return null; }
      if (!pid) return null;
      return isAlive(pid) ? pid : null;
    }

    // What the DM could not deliver, left on the board. Re-load/mutate/save, the
    // same don't-trust-a-snapshot rule _setLoopStep states.
    //
    // A null step CLEARS it, and the green path calls it that way: a ticket that
    // failed at `clean-tree`, was retried and then merged would otherwise carry
    // the old failure forever, and a stale field on a board is read as current.
    _stampMergeError(team, ticketId, step) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!step) { if (!('mergeError' in rec)) return; delete rec.mergeError; }
        else rec.mergeError = step;
        rec.lastActivityAt = Date.now();
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `merge error stamp for ${ticketId} failed: ${e.message}`);
      }
    }

    async _autoMergeTicket(team, ticketId, landedOn, verdictText) {
      const fail = (step, evidence, tried) => {
        // Stamped BEFORE the DM, because the DM is the arm that can fail. An
        // undelivered escalation is otherwise lost outright: _landVerdictOnTicket
        // already deleted `loopStep`, so _escalateTicket's "loopStep kept so the
        // watchdog re-surfaces it" is false here — ticketInFlight is false and
        // the stall sweep never looks at this ticket again. The board carries
        // what the DM may not.
        this._stampMergeError(team, ticketId, step);
        this._escalateTicket(team, ticketId, `merge: ${step}`, evidence, tried);
      };
      let merged = null;
      try {
        const ticket = this._loadTicket(team, ticketId);
        if (!ticket) return;
        // The verdict→merge gap is async (a git ancestor check, then a whole
        // suite), and the loop re-loads across every other such gap for the same
        // reason: a `task reject` or `task cancel` landing inside it reopens the
        // ticket, and merging a reopened ticket lands work its own team has just
        // decided is not finished. Silent, like the no-branch case — the lead who
        // reopened it does not need to be told the loop noticed.
        if (ticket.state !== 'done') return;
        const wt = ticket.worktree || {};
        const branch = wt.branch;
        const baseSha = wt.baseSha;
        // A ticket worked in the SHARED checkout has no branch to merge, exactly
        // as it had no loop to run. Silent, not an escalation: nothing went
        // wrong, there is simply nothing to land.
        if (!branch || !baseSha) return;

        // STEP 1 — the must-fixes in the verdict BODY are empty.
        //
        // Parsed from the verdict TEXT with extractMustFix, never off a count
        // someone else computed: seven confirmed instances of a DM header
        // claiming "10 must-fixes" over a body reading "(none)".
        //
        // This is a cheap belt, not a second source of truth — `landedOn.mustFix`
        // is `extractMustFix` on this same string, so today the two cannot
        // disagree. What it buys is that the gate deciding whether work reaches
        // master reads the verdict itself, so a future caller that computes or
        // forwards that field differently cannot widen it by accident.
        //
        // An ACCEPT that still lists must-fixes is a contradiction only a human
        // can resolve, so it escalates — a wrong merge is the expensive
        // direction.
        const mustFix = extractMustFix(verdictText == null ? '' : String(verdictText));
        const n = countMustFix(mustFix);
        if (n > 0) {
          fail('must-fix', `the verdict is ACCEPT but its MUST-FIX body is not empty (${n} item${n === 1 ? '' : 's'}): ${String(mustFix).slice(0, 800)}`,
            'nothing was merged — an ACCEPT that still lists must-fixes is a contradiction the lead resolves, not the loop');
          return;
        }

        // STEP 2 — the recorded base is still an ancestor of the branch head.
        // Same question, same argument order and same reason as the verify
        // step's CHECK 2: isMerged(root, X, Y) asks "is X an ancestor of Y", so
        // the base goes first. A NO means the branch is not the tree the spec
        // was written against, and merging it lands work reviewed against
        // something else.
        const anc = await gitWorktree.isMerged(team.root, baseSha, branch)
          .catch((e) => ({ ok: false, error: e.message }));
        if (!anc.ok) {
          fail('base-is-ancestor', `git could not confirm ${baseSha} is an ancestor of ${branch}: ${anc.error}`,
            `ran isMerged(${baseSha}, ${branch}); nothing was merged`);
          return;
        }
        if (!anc.merged) {
          fail('base-is-ancestor', `${baseSha} is NOT an ancestor of ${branch} — the branch was rebased or reset, so it is not the tree the review was written against`,
            `ran isMerged(${baseSha}, ${branch}); nothing was merged`);
          return;
        }

        // STEP 3 — the checkout we are about to write to is clean and on
        // master. BOTH, and before the merge: a dirty tree makes git refuse
        // mid-way, and a checkout parked on another branch would take the merge
        // silently onto whatever it is sitting on.
        const dirty = await gitWorktree.isDirty(team.root).catch((e) => ({ ok: false, error: e.message }));
        if (!dirty.ok) {
          fail('clean-tree', `git could not report the state of the root checkout ${team.root}: ${dirty.error}`,
            'nothing was merged — an unknown tree state is never read as clean');
          return;
        }
        if (dirty.dirty) {
          fail('clean-tree', `the root checkout ${team.root} has uncommitted changes, so a merge would mix them into the merge commit`,
            'nothing was merged; run `git -C ' + team.root + ' status` to see what is uncommitted');
          return;
        }
        const cur = await gitWorktree.currentBranch(team.root).catch((e) => ({ ok: false, error: e.message }));
        if (!cur.ok) {
          fail('on-master', `git could not say which branch ${team.root} is on: ${cur.error}`,
            'nothing was merged');
          return;
        }
        if (cur.branch !== MERGE_TARGET_BRANCH) {
          fail('on-master', `the root checkout is on "${cur.branch}", not ${MERGE_TARGET_BRANCH} — merging here would land ${branch} on the wrong branch`,
            `nothing was merged; check out ${MERGE_TARGET_BRANCH} in ${team.root} and merge ${branch} by hand`);
          return;
        }

        // STEP 3b — nobody is running a suite in the checkout we are about to
        // rewrite.
        //
        // The suite lock serializes the RUNS; it does not serialize the git
        // writes BETWEEN them, and the merge is exactly such a write. The lead's
        // exec grant runs `clodex-run-tests` in team.root and holds this lock for
        // minutes; a merge landing mid-run rewrites the files under the running
        // child, and the lead gets a spurious red with nothing naming the cause.
        // That is not hypothetical — suite-lock contention produced a false
        // rejection on this team already.
        //
        // A hairline race survives (a run starting between this check and the
        // merge). Closing it properly means holding the mkdir lock across
        // merge→suite→revert and handing the held lock to a child that expects to
        // acquire it — a bigger change than this step should carry. The
        // in-process chain covers the loop's own concurrency, which is the case
        // this ticket creates; this covers the lead's.
        const holder = this._suiteLockHolder(team);
        if (holder) {
          // The recovery is spelled out because there is NO retry: _queueAutoMerge
          // is reachable only from an ACCEPT landing, so a refused merge is
          // refused for good — nothing re-drives it, and "try again later" would
          // describe a mechanism that does not exist. Same defect class as
          // claiming a wedged checkout: a false promise in the one message whose
          // whole job is to be trusted.
          fail('suite-in-flight', `a test suite is already running in the root checkout ${team.root} (pid ${holder}) — merging now would rewrite the files under it`,
            `nothing was merged, and the loop will NOT retry — no path re-drives a merge once its verdict has landed. To land it by hand: \`git -C ${team.root} merge --no-ff ${branch}\`, then run the suite in ${team.root}. Otherwise re-review the ticket.`);
          return;
        }

        // STEP 4 — the merge itself, always with a merge commit.
        //
        // The message goes through a FILE, never `-m`: it is generated text
        // carrying a ticket title an agent wrote, and it is multi-line by
        // construction. The file also survives for the lead to read if the merge
        // is refused.
        const rounds = Number(landedOn && landedOn.reviewRound) || Number(ticket.reviewRound) || 1;
        const msg = [
          `Merge ${ticketId}: ${ticketTitle(ticket.spec)}`,
          '',
          `Branch: ${branch}`,
          `Review rounds: ${rounds}`,
          `Verdict: ACCEPT (auto-merged by the ticket loop)`,
          '',
        ].join('\n');
        let msgFile = null;
        try {
          const dest = this._ticketDiffDest(team, ticket);
          const dir = dest.ok ? dest.dir : os.tmpdir();
          if (dest.ok) ensureDir(dir);
          msgFile = path.join(dir, `merge-${ticketId}.msg`);
          fs.writeFileSync(msgFile, msg);
        } catch (e) {
          fail('merge', `the merge message could not be written: ${e.message}`,
            'nothing was merged — the message file is written before the merge so a failure here costs nothing');
          return;
        }
        merged = await gitWorktree.mergeNoFf(team.root, branch, msgFile)
          .catch((e) => ({ ok: false, error: e.message }));
        if (!merged.ok) {
          // Reported off `wedged`, never off `aborted`: a merge that failed
          // BEFORE it started (bad ref, unreadable message file) also fails to
          // abort, and claiming a wedged shared checkout about an untouched tree
          // is a false alarm in the one message whose job is to be trusted.
          fail('merge', `git merge --no-ff ${branch} failed:\n${merged.error}`,
            merged.wedged
              ? `ran the merge in ${team.root}; \`git merge --abort\` ALSO failed and MERGE_HEAD is still there, so the checkout is left mid-merge and needs a human`
              : `ran the merge in ${team.root}; the checkout is back where it was (no MERGE_HEAD)`);
          return;
        }
        if (!merged.moved) {
          // `--no-ff` on an already-merged branch prints "Already up to date",
          // exits 0 and creates nothing. Reading ok alone would announce a merge
          // that did not happen and then run a suite proving nothing about it.
          fail('merge', `git merge --no-ff ${branch} exited 0 but HEAD did not move — the branch was already contained in ${MERGE_TARGET_BRANCH}, so no merge commit exists`,
            `ran the merge in ${team.root}; nothing to revert`);
          return;
        }

        // STEP 5 — the FULL suite, on the merged master, through the same lock
        // the lead's exec grant takes. The merge is the first moment the two
        // trees have ever been combined, so nothing before it can have tested
        // this state.
        //
        // A red master blocks every other ticket in the team, so the undo is not
        // optional and must not be a question put to the lead: revert first,
        // escalate with the evidence second.
        const suite = await this._runTicketSuite(team, ticket, team.root);
        if (!suite.ran || !suite.green) {
          // `ran:false` is undone as well as red, though the spec names only
          // red: an unverified merge sitting on master is the state this whole
          // step exists to prevent, and a revert is cheap and recoverable while
          // a silently unverified master is neither.
          const why = suite.ran
            ? `the suite FAILS on ${MERGE_TARGET_BRANCH} after the merge — ${suite.summary}\nFAILING: ${suite.failing || '(the runner reported no test names)'}`
            : `the suite could not be RUN on ${MERGE_TARGET_BRANCH} after the merge: ${suite.error}`;

          // The failing output, kept — the SAME writer the loop's verify run
          // uses, not a second mechanism. This dump matters more than that one:
          // a red post-merge suite REVERTS master, and the revert is what makes
          // the evidence unreproducible — re-running the suite afterwards
          // measures a tree the failure is no longer in.
          //
          // Attempted on the UNRAN arm as well. A crashed or timed-out run
          // reverts master exactly as a red one does, so its output is just as
          // unreproducible — and `suite.error`, inlined in `why` above, is a
          // 300-char last line standing in for a 64KB capture. Whether there is
          // anything worth keeping is the writer's judgement, not this arm's: it
          // refuses an empty capture, which is what a spawn failure carrying no
          // streams produces.
          //
          // WRAPPED for the reason the verify arm is wrapped, and with more at
          // stake: `.catch()` cannot catch a synchronous throw, and one escaping
          // here would reach the method's catch-all — which escalates WITHOUT
          // reverting, leaving a red master standing because the evidence
          // mechanism threw. Preservation must never outrank the undo.
          let kept;
          try {
            kept = await this._writeTicketSuiteFailure(team, ticket, suite);
          } catch (e) {
            kept = { ok: false, path: null, error: `the preservation threw: ${e && e.message ? e.message : String(e)}` };
            log.error('ticket', `ticket ${ticketId}: post-merge suite output could not be preserved — ${kept.error}`);
          }
          // BOTH directions, the rule t370 r3 settled: naming the file when it
          // exists and going silent when it does not leaves the lead — the only
          // reader on either arm here — unable to tell "preservation failed"
          // from "nobody thought to look".
          // The "do not re-run" advice holds only where the revert SUCCEEDED.
          // On the two arms that leave the merge standing, re-running really
          // does reproduce, and those arms are exactly where the lead is acting
          // by hand — so the clause is built per-arm rather than once.
          const keptWhere = (reverted) => (kept.ok
            ? (reverted
              ? ` Full output (assertion text, diff and stack) preserved at ${kept.path} — read it instead of re-running, which would measure the reverted tree.`
              : ` Full output (assertion text, diff and stack) preserved at ${kept.path} — read it; ${MERGE_TARGET_BRANCH} still carries the merge.`)
            : ` The failing output could not be preserved (${kept.error}).`);

          // The revert is a write to the shared root checkout exactly as the
          // merge is, so it needs the same gate — and it needs it MORE, because
          // the path that reaches it is the one a live suite creates: our own run
          // waits TICKET_SUITE_LOCK_WAIT_MS for a lock the lead's exec grant is
          // holding, the runner dies, `ran` is false, and reverting here would
          // rewrite the tree under that still-running child.
          //
          // The asymmetry is the point. Today a red suite and a suite we were
          // never allowed to run arrive here as the same value, and reverting
          // treats them the same — the most destructive action available, taken
          // on no evidence. An unverified merge on master is undone by one
          // command the lead can run whenever they like; a torn write into a
          // running suite costs a debugging session and reports a failure that
          // was never in the code.
          // The ran-TRUE case reaches here too, and it was priced rather than
          // overlooked: our own runner releases the root lock at exit, so a
          // ticket-B verify run spinning in run-tests.js's wait loop can take it
          // in the sliver before this probe. That leaves a genuinely RED master
          // standing, against the rule that red is always undone. The
          // alternative trades it for a torn write into B's live run plus a
          // spurious red on B, so the ruling stands — but the message below must
          // then say RED, not merely unverified.
          // Our OWN runner is not a blocker. On the timeout path it is SIGKILLed
          // and this probe runs before it is reaped, so isAlive answers true for
          // a corpse whose pid the killed runner never cleared from the lock dir
          // — the gate would then refuse the revert and tell the lead to wait
          // for a suite that no longer exists.
          const holder = this._suiteLockHolder(team);
          const blocker = (holder && holder === suite.runnerPid) ? null : holder;
          if (blocker) {
            const state = suite.ran
              ? `is RED: the merge ${merged.sha} IS on it and the suite FAILED`
              : `carries an UNVERIFIED merge ${merged.sha}: its suite never ran`;
            fail('revert-blocked', `${why}\n\n${MERGE_TARGET_BRANCH} ${state}, and it was left that way deliberately: a test suite is running in ${team.root} (pid ${blocker}), so reverting now would rewrite the files under it.`,
              `merged ${branch} as ${merged.sha} and did NOT revert. Undo it yourself once that suite finishes: \`git -C ${team.root} revert -m 1 ${merged.sha}\`.${keptWhere(false)}`);
            return;
          }
          const rev = await gitWorktree.revertCommit(team.root, merged.sha)
            .catch((e) => ({ ok: false, error: e.message }));
          fail('suite', why, (rev.ok
            ? `merged ${branch} as ${merged.sha}, ran the suite in ${team.root}, then REVERTED the merge (${rev.sha}) — ${MERGE_TARGET_BRANCH} is green again and the branch is untouched`
            : `merged ${branch} as ${merged.sha} and the revert ALSO failed (${rev.error}) — ${MERGE_TARGET_BRANCH} is left carrying the merge and needs a human`) + keptWhere(rev.ok));
          return;
        }

        // Green. The lead is told through the SAME channel every escalation
        // uses — a merge that landed and a merge that could not are the same
        // question for the lead, and a second channel is what the loop's design
        // forbids.
        this._stampMergeError(team, ticketId, null);
        this._notifyMergeLanded(team, ticketId, {
          branch, sha: merged.sha, rounds, summary: suite.summary,
        });
      } catch (e) {
        // A throw AFTER the merge landed is the dangerous shape: master carries
        // an unverified merge and nothing else will notice. Name the sha, so the
        // lead has the one thing needed to undo it.
        fail('unexpected', `the auto-merge threw: ${e && e.message ? e.message : String(e)}`,
          merged && merged.ok && merged.sha
            ? `the merge commit ${merged.sha} IS on ${MERGE_TARGET_BRANCH} and was NOT verified — \`git -C ${team.root} revert -m 1 ${merged.sha}\` undoes it`
            : 'nothing was merged');
      }
    }

    // The merge landed. Rides _escalateTicket's channel — one lead DM from the
    // loop, whichever way it went — and states the CHANGELOG debt, because
    // CHANGELOG.md is deliberately not touched by the merge: it conflicts across
    // every live branch, so it stays the lead's, and an unstated debt is one the
    // release then ships without.
    // COLUMN 1 IS THE SAFETY, the same knife-edge ticketCloseLine documents and
    // for a worse consequence: the last line carries a complete, ready-to-fire
    // `[agent:task accept <id>]`, inert only because `Nothing was torn down: `
    // precedes it. IntentScanner's parse is ^-anchored, so a reflow putting the
    // verb at the start of a line makes the LEAD auto-accept on receipt —
    // retiring the seat and destroying the worktree, the one thing this whole
    // step promises not to do, and the one action here that no revert undoes.
    // Keep the prefix.
    _notifyMergeLanded(team, ticketId, { branch, sha, rounds, summary }) {
      try {
        const body = [
          `[ticket ${ticketId} MERGED] ${branch} → ${MERGE_TARGET_BRANCH} as ${sha}`,
          '',
          `Review rounds: ${rounds}. Suite on ${MERGE_TARGET_BRANCH} after the merge: ${summary}.`,
          `A CHANGELOG.md entry is OWED — the merge does not write one (it conflicts across every live branch).`,
          `Nothing was torn down: the worktree, the branch and the seat are still there. [agent:task accept ${ticketId}] retires them when you are ready.`,
        ].join('\n');
        const r = this._gatedDeliver(team.lead, 'ticket-loop', body, false, `[ticket ${ticketId} MERGED]`);
        if (!(r && (r.queued || r.parked))) {
          log.error('ticket', `ticket ${ticketId} merged as ${sha} but ${team.lead} was NOT told (${(r && (r.error || r.held)) || 'unknown delivery failure'})`);
        }
        this._broadcast('ipc-message', { type: 'task', from: 'ticket-loop', to: team.lead, body: `ticket ${ticketId} merged: ${branch} → ${MERGE_TARGET_BRANCH}` });
        log.info('intent', `ticket ${ticketId} auto-merged: ${branch} → ${MERGE_TARGET_BRANCH} as ${sha}`);
      } catch (e) {
        log.error('ticket', `merge notification for ${ticketId} failed: ${e.message}`);
      }
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
      // A TICKET review's verdict lands on the ticket record, not on the lead: the
      // loop reads it from there, and a record survives both agents dying while a
      // dm survives neither. `reviewFor` is untouched — an ad-hoc
      // [agent:team-review] still reports to whoever asked.
      // Falls THROUGH to the lead delivery below when the ticket cannot be
      // resolved or the verdict does not parse: a verdict is a cold review's
      // entire output, and losing it costs more than a misrouted one.
      let landedOn = null;
      if (rec.reviewTicket) landedOn = this._landVerdictOnTicket(session, rec.reviewTicket, verdict);
      if (landedOn) {
        this._notifyLeadOfVerdict(session, lead, rec.reviewTicket, landedOn, verdict);
        this._broadcast('ipc-message', {
          type: 'review-done', from: session.name, to: rec.reviewTicket, body: `verdict → ticket ${rec.reviewTicket}`,
        });
        log.info('intent', `review-done ${session.name} → ticket ${rec.reviewTicket} (${landedOn.verdict}, round ${landedOn.reviewRound}); retiring (discard)`);
        this._sendToSession(session.name, 'session:context-action', {
          action: 'retired', name: session.name, disposition: 'discard',
        });
        this.kill(session.name);
        // ACCEPT alone, and fired UNAWAITED — this handler is synchronous and
        // the merge shells out to git and then runs a whole suite, so awaiting
        // it would hold the intent handler open for minutes. Same shape and same
        // reason as _taskDone firing _runTicketLoop.
        //
        // AFTER the verdict is durable and the reviewer retired: the merge reads
        // the record, and a merge that throws must never cost the verdict or
        // strand the seat. A REWORK is untouched by this and takes the path it
        // always did.
        if (landedOn.verdict === 'ACCEPT') {
          // Re-resolved off the reviewer's cwd rather than threaded out of
          // _landVerdictOnTicket: that function returns the verdict fields by
          // contract, and widening its return to carry the team so one caller
          // can avoid a resolve is how a narrow contract turns into a bag. A
          // null is unreachable here (the verdict landed, so the team resolved
          // moments ago) and is skipped rather than escalated — there would be
          // no team to escalate to.
          let team = null;
          try { team = resolveTeam(session.cwd); } catch { team = null; }
          // QUEUED, not fired: see _queueAutoMerge for why two of these must
          // never overlap.
          if (team) this._queueAutoMerge(team, rec.reviewTicket, landedOn, verdict);
        }
        return;
      }
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
      // No team is the SOLO case, not an error (t303): tickets are the primitive
      // and teams consume them, so a lone operator must be able to file one
      // without instantiating a team to be their own lead. `_soloContext` returns
      // a stand-in with the same shape the verbs already read.
      //
      // The refusal that REMAINS is "no project": outside a git repo there is
      // nothing to key a board to. It is deliberately not a cwd fallback — a
      // wrong board is silent forever, a refusal is read once.
      // The first rejecting return a ticket command meets, and the only one reached
      // before the verb runs — so the payload invariant holds at the entry point
      // rather than at each interior exit. The verbs that carry no body (assign,
      // list) fall out on the helper's empty-body guard.
      if (!team) {
        team = this._soloContext(session);
        if (!team) { reply(`error: this session is not on a team and is not inside a git repository — a ticket needs a project to belong to${this._spillRejectedPayload(session, `task ${intent.sub}`, String(intent.body == null ? '' : intent.body).trim())}`); return; }
      }
      switch (intent.sub) {
        case 'add': this._taskAdd(session, team, intent, reply); break;
        case 'assign': this._taskAssign(session, team, intent, reply); break;
        case 'start': this._taskStart(session, team, intent, reply); break;
        case 'done': this._taskDone(session, team, intent, reply); break;
        case 'reject': this._taskReject(session, team, intent, reply); break;
        case 'respec': this._taskRespec(session, team, intent, reply); break;
        case 'cancel': this._taskCancel(session, team, intent, reply); break;
        // Async alone among the verbs: the merge gate is a git call and every
        // destructive step is downstream of its answer. Caught here for the same
        // reason team-retire's is — a floating rejection tears nothing down and
        // tells no one, leaving the lead waiting on a confirmation that never comes.
        case 'accept': this._taskAccept(session, team, intent, reply).catch((e) => {
          log.warn('intent', `task accept ${intent.id} by ${session.name} failed: ${e.message}`);
          reply(`error: accept ${intent.id || ''} failed: ${e.message} — nothing was removed`);
        }); break;
        case 'park': this._taskPark(session, team, intent, reply); break;
        case 'list': this._taskList(session, team, intent, reply); break;
      }
    }

    // Solo has no roles, so naming one as a possibility sends the operator
    // looking for a vocabulary that does not exist here.
    _assigneeMissText(team, who) {
      return (team && team.solo)
        ? `"${who}" is not a live session in ${team.name} — with no team, an assignee is a live session name`
        : `"${who}" is neither a team role nor a live seat on ${team.name}`;
    }

    _resolveAssignee(team, who) {
      if (!who) return null;
      if (team.roles && Object.prototype.hasOwnProperty.call(team.roles, who)) return who; // role-addressed
      if (this._teamLiveSeatNames(team.root).includes(who)) return who; // name-addressed (live seat)
      return null;
    }

    // A delivery-time pin RECORDS which seat received the work; it must not become
    // the only route back to the ticket. A seat that dies holding a pin would
    // otherwise take its whole queue with it — the tickets name something nothing
    // answers for, and no sibling of the same role can be handed them.
    //
    // So the pin degrades to `ticket.role` once the pinned seat is not live. It
    // lives HERE, in the one resolver, and not in the callers: a lister that
    // degrades while this does not makes a ticket visible but undeliverable, and
    // `_advanceSeat` then reports a hand-off it never performed — the sibling is
    // starved of its real next ticket and told each time that it got one.
    //
    // Gated on `!ticket.worktree`, which keeps the worktree flow's one-shot
    // property: a tree is bound to the seat holding it, so handing a worktree
    // ticket to a sibling would drop it in another branch's checkout. A dead
    // worktree seat has its own explicit recovery, which names the two real exits
    // rather than guessing a new holder.
    // `liveNames` lets a caller in a LOOP walk the live seats once instead of once
    // per ticket. Both reads here are filesystem work, and `_touchTicketActivity`
    // runs on every non-idle activity edge — much hotter than the listers.
    _ticketAssigneeSeat(team, ticket, liveNames = null) {
      const a = ticket && ticket.assignee;
      if (!a) return null;
      const live = liveNames || this._teamLiveSeatNames(team.root);
      const isRoleKey = (k) => !!(k && team.roles && Object.prototype.hasOwnProperty.call(team.roles, k));
      const firstSeatFor = (roleKey) => {
        for (const name of live) {
          if (matchSeatRole(team, name) === roleKey) return name;
        }
        return null;
      };
      if (isRoleKey(a)) return firstSeatFor(a);
      if (live.includes(a)) return a;
      if (ticket.worktree || !isRoleKey(ticket.role)) return null;
      return firstSeatFor(ticket.role);
    }

    // Re-pin a ROLE-assigned ticket to the concrete seat that is about to receive
    // it, in the shape the worktree flow already uses: `role` keeps what the lead
    // filed (the board and the cost rollup read it), `assignee` records who
    // actually got the work. Without it a role ticket carries no record of which
    // seat spent, and the close-time cost path can only infer one.
    //
    // Resolution goes through `_ticketAssigneeSeat` — the SAME resolver the
    // delivery below uses — so the pin can never name a seat other than the one
    // the spec reached. A second resolution here would be free to disagree, and
    // the disagreement would be invisible: both halves look right alone.
    //
    // The LEAD is never pinned to. `_costSeatFor` excludes it on purpose (its
    // ledger spans every ticket in the project, so the lifetime-sum shape is
    // categorically wrong for it), and that exclusion keys off the assignee still
    // being a role — writing `lead` here would read downstream as an exact seat
    // pin and bill one ticket for the lead's entire life.
    _repinTicketToSeat(team, ticket) {
      const a = ticket && ticket.assignee;
      if (!a) return null;
      const isRoleKey = (k) => !!(k && team.roles && Object.prototype.hasOwnProperty.call(team.roles, k));
      // Two shapes re-pin: a ticket still ON its role, and one whose pinned seat
      // DIED and degraded back to `ticket.role`. The second matters because the
      // degraded ticket is the oldest, so it owns the queue head — leaving it
      // pinned to a dead name would re-degrade it on every later resolution and
      // leave the record naming a seat that never did the work.
      const role = isRoleKey(a) ? a : (ticket.role || null);
      if (!isRoleKey(role)) return null;
      if (a !== role && this._teamLiveSeatNames(team.root).includes(a)) return null; // pinned and live — leave it
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (!seat || seat === team.lead || seat === a) return null;
      ticket.role = role;
      ticket.assignee = seat;
      return seat;
    }

    // `replay` marks a REDELIVERY of a spec the seat may already have acted on.
    // Unmarked, the fix trades a silent drop for a silent double-execution: the
    // seat cannot tell a replay from a fresh assignment (that indistinguishability
    // is the whole finding in this ticket's notes), so the marker has to be in the
    // text, not in the caller's head.
    _deliverTicketSpec(team, ticket, specText, fromName, urgent = false, replay = false, respec = false) {
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (!seat) return { undelivered: true };
      if (seat === team.lead) return { self: true }; // self-assign — the lead just wrote it
      // Worded to be true of BOTH replay cases: a spec redelivered after a respawn,
      // and one that never reached a seat at all (assigned to a role with nobody
      // live). "your process restarted" would be a lie in the second.
      // Points at the WORKING TREE first, not the task artifact: the incarnation that
      // died is precisely the one that may never have written an artifact, so absent
      // notes are no evidence of absent work. And it must offer three branches — a
      // done/not-done pair sends the realistic partial case down "start over", which
      // is the destructive one.
      // A RESPEC is the third case, and it is marked for the same reason replay is:
      // over ~500 bytes the body spills and the seat sees only "Message (N bytes)
      // attached", which is byte-identical in shape to a fresh dispatch. A hand that
      // reads it as one follows its brief — compact, start clean — and discards the
      // in-flight work of the very ticket being corrected. It must say "keep going,
      // the spec changed", never "begin".
      const head = replay
        ? `[ticket ${ticket.id} REPLAY] this ticket was already open and assigned to you when this process `
          + `started, so an earlier incarnation of you may have already done some or all of it. `
          + `BEFORE you build, edit, or commit anything: run \`git status\` and \`git log\` and check the task `
          + `artifact. Then — if the work is DONE, close the ticket instead of redoing it; if NOTHING was `
          + `started, do the task as specified below; if it is PARTIALLY done, do NOT restart it — report what `
          + `you found and ask how to proceed.\n`
        : respec
          ? `[ticket ${ticket.id} RESPEC] the lead has REPLACED this ticket's spec — you are already working `
            + `it, so do NOT start over and do NOT compact: keep the tree and the context you have. The text `
            + `below SUPERSEDES the spec you were given; re-read it, keep whatever work still applies, and `
            + `discard only what the new spec contradicts. If work you have already done is now out of scope, `
            + `say so in your report rather than silently reverting it.\n`
          : `[ticket ${ticket.id}] `;
      // A ticket with its own worktree: the seat's cwd is the REPO, so the tree is
      // somewhere it would not otherwise look (git puts a worktree BESIDE the repo).
      // Rides the spec on every delivery INCLUDING a replay — a respawned seat needs
      // the location as much as the first incarnation did, and it has no memory of it.
      const wtLine = (ticket && ticket.worktree && ticket.worktree.path)
        ? `WORK IN: ${ticket.worktree.path} (git worktree, branch ${ticket.worktree.branch}) — cd there first. `
          + `That tree is yours for this ticket: commit to ${ticket.worktree.branch} as you go, never push, and do not merge it. `
          + `Your cwd is the shared repo checkout; editing files there instead would collide with the other seats working in it.\n`
        : '';
      // Rides EVERY dispatch, replays included: a respawned seat has no memory of
      // the verb, exactly as it has none of its worktree. See ticketCloseLine.
      const closeLine = ticketCloseLine(ticket.id);
      // EVERY dispatch spills now: the head alone is ~420 chars and a worktree one
      // ~730, against a 500-byte threshold. So the pointer line is all a seat sees
      // before deciding whether to spend a Read turn, and it must carry the id AND
      // the verb — a spilled body announces itself only as "Message (N bytes)
      // attached", which would put the close verb behind the very turn this line
      // exists to save. The verb is safe here for the same reason as in the body:
      // `[agent:from <sender>] ` precedes the tag, so it is never at column 1.
      const r = this._gatedDeliver(seat, fromName, `${head}${wtLine}${closeLine}${specText}`, urgent,
        replay
          ? `[ticket ${ticket.id} REPLAY] close with ${ticketCloseVerb(ticket.id)}`
          : respec
            ? `[ticket ${ticket.id} RESPEC] close with ${ticketCloseVerb(ticket.id)}`
            : `[ticket ${ticket.id}] close with ${ticketCloseVerb(ticket.id)}`,
        // Arms from the WRITE, not from this return. `queued` covers two dispositions
        // and only one of them is confirmable: an injected unit ends with an Enter, so
        // consuming it starts a turn, while a parked file is drained by the
        // out-of-process hook mid-loop and a seat already `thinking` emits no fresh
        // activity edge for it. Arming over a park would therefore redeliver into a
        // seat that HAS the spec and is working on it.
        (disposition) => this._armSpecConfirm(seat, ticket.id, disposition));
      if (!r || r.error) return { undelivered: true };
      if (r.parked) return { parked: r.parked, reason: r.reason || null };
      if (r.held) return { held: true, reason: r.held };
      return { queued: true };   // handed to the queue; the write comes later
    }

    // `queued` says the bytes were handed to the inject queue, not that the seat
    // received them — see _gatedDeliver's own note on the word. The gap is real
    // and silent: a write landing inside the CLI's boot re-render is either wiped
    // (the seat's context is empty) or survives with its Enter eaten as content
    // (a draft that never submits), and BOTH stamp the record delivered. Measured
    // across 24 consecutive dispatches, the write goes out 1.02s after spawn in
    // every case — healthy and lost alike — so no timing constant separates them
    // and widening the boot margin cannot be the fix.
    //
    // What separates them is what happens NEXT. The injected unit ends with a
    // '\r'; if it lands, the CLI submits and the turn drives activityState off
    // 'idle'. So a seat that never leaves idle after a write did not consume the
    // spec — this is not a proxy for the failure, it is the same event seen from
    // the other side.
    //
    // Armed from the WRITE (_deliverMessage's onWrite), never from the enqueue, and
    // only for the 'injected' disposition. Two reasons, both load-bearing:
    //
    // A PARKED delivery is not confirmable. The file is drained by the
    // out-of-process PostToolUse hook mid-loop, and ActivityTracker._set dedupes on
    // unchanged state — so a seat that was already `thinking` when the spec parked
    // consumes it without ever producing a fresh edge. Arming there would redeliver
    // a full spec into a seat actively working on it. The park has its own
    // durability (park cap, idle drain, hook drain) and needs no watcher.
    //
    // And arming at ENQUEUE would start the clock before the bytes exist: the quiet
    // gate can hold a write for up to INJECT_QUIET_MAXWAIT (5 min), so a spec still
    // queued at the window would get a redelivery enqueued BEHIND it — the first
    // write then lands, starts a turn, clears the latch, and the second copy writes
    // anyway, because nothing cancels a queued unit.
    // `disposition` is REQUIRED and has no default: the unsafe value is `injected`,
    // so a caller that forgets to pass one would arm a 90s latch over text it never
    // wrote. Defaulting is what made the hold-park's argument-less onWrite silent.
    _armSpecConfirm(seatName, ticketId, disposition) {
      const s = this.sessions.get(seatName);
      if (!s || !s.agentType || s._dead) return;
      if (disposition !== 'injected') {
        // A late divert can park text this already armed over — drop the latch
        // rather than leave it watching for an edge that will never come.
        if (s._specUnconfirmed && s._specUnconfirmed.ticketId === ticketId) {
          s._specUnconfirmed = null;
          clearTimeout(s._specConfirmTimer);
          s._specConfirmTimer = null;
        }
        return;
      }
      // The park decision was taken back at _deliverMessage time, but the boot-ready
      // (20s) and quiet (INJECT_QUIET_MAXWAIT, 5min) gates sit AHEAD of the write, so
      // a seat that went busy while the unit waited gets it into a live turn. This
      // runs inside `produce` — that is the whole reason the arm moved here — so the
      // state read is the one at write time. The divert only rescues a seat with an
      // open draft; one that already submitted has none, is `thinking`, and emits no
      // fresh edge, so the latch would run its full window over a delivered spec.
      // A seat already working is by definition not the wedged shape this catches.
      if (s.activityState !== 'idle') return;
      // An earlier unconfirmed spec is REPLACED, not stacked: the new write's
      // leading Ctrl-U clears whatever the old one left in the composer, so the
      // old latch describes a draft that no longer exists.
      // The retry budget SURVIVES the replacement when it is the same ticket: the
      // redelivery re-enters here through the write it triggered, and a budget reset
      // there would make the one-shot retry unbounded.
      const prior = s._specUnconfirmed;
      const retried = !!(prior && prior.ticketId === ticketId && prior.retried);
      clearTimeout(s._specConfirmTimer);
      s._specUnconfirmed = { ticketId, at: Date.now(), retried };
      this._armSpecConfirmTimer(s);
    }

    _armSpecConfirmTimer(session) {
      session._specConfirmTimer = setTimeout(() => {
        session._specConfirmTimer = null;
        // The redelivery path reaches _buildDeliveryText -> spillToFile, which is
        // real fs work and can throw. This fires 90s after EVERY dispatch in the
        // app's main process, where a throw out of a setTimeout callback is not a
        // failed redelivery but an unhandled exception in the host.
        try { this._checkSpecConfirm(session); }
        catch (e) { log.error('intent', `spec confirmation check failed for ${session.name}: ${e.message}`); }
      }, SPEC_CONFIRM_MS);
      // Observer-grade, like the ticket watchdog, in BOTH senses: it must never be
      // the reason a process stays alive, and never the reason one dies. In the app
      // the loop is held open by Electron anyway, so the timer still fires; unref'd
      // it also stops a 90s window from holding every test file that dispatches a
      // ticket open until node kills it.
      if (session._specConfirmTimer.unref) session._specConfirmTimer.unref();
    }

    // A reviewer seat that never takes its first turn, and nothing says so.
    //
    // Measured twice: `clodex-reviewer-365-r2` sat alive and idle for ~30 minutes,
    // `clodex-reviewer-375-r1` for 4 — the second caught by the operator, not by
    // any alarm. Both had their scope: since the scope moved into the seat's
    // system prompt it cannot be lost in delivery, so what goes missing is the
    // contentless START nudge, and a reviewer with no nudge has no other traffic
    // to earn a turn from. The park's own two drain edges (boot-ready rising edge,
    // `_armParkedDrainFallback`) are the recovery for that, and when both miss the
    // seat is silent and permanent with nothing watching.
    //
    // The tell is the TRANSCRIPT, not the clock: the hook creates
    // `run/<name>/transcript.jsonl` as a symlink at spawn and its target file only
    // appears once the CLI writes a turn. Measured in both directions on the same
    // night — t375's target still absent 4 minutes after the link was created,
    // while a healthy `clodex-reviewer-371-r1` had 254KB with a moving mtime
    // inside five. So absence of the target is not a proxy for "no first turn",
    // it is the same event.
    //
    // `activityState` is required as well, and it is the conservative term: a seat
    // whose hook never installed would have no transcript however hard it works,
    // and alarming there would report the detector's own blind spot as a wedge.
    // A seat that took a turn cannot be idle-with-no-transcript — it reached idle
    // THROUGH thinking, which is what writes the file.
    //
    // REDELIVERS ONCE, then escalates. The nudge at the spawn site is deliberately
    // CONTENTLESS ('…scope is in your system prompt. Begin.'), so a second copy
    // duplicates no content and can strand nothing — worst case a reviewer is told
    // to begin twice. That is what makes this safe where a spec redelivery needs
    // _checkSpecConfirm's whole latch argument to be.
    //
    // Measured, 3/3, against the real CLI (scripts/t381-injection-repro): a seat
    // sitting in a single modal swallows one delivery WHOLE — text and Enter both —
    // and the NEXT delivery lands. That is exactly the recovery this check used to
    // ask the lead to perform by hand, and the operator's one-poke rescue of
    // clodex-reviewer-377-r1 is the same event. Chained modals (first-run
    // onboarding) still defeat it; that is a boot-time shape, not this one.
    _armReviewStartCheck(seatName, leadName) {
      const s = this.sessions.get(seatName);
      // Claude-only, because the artifact is: `transcript.jsonl` is written by the
      // Claude hook. A codex seat would read as permanently silent. The review path
      // forces claude today (the C2 tool-cap constant), so this guard is about a
      // future caller, not about a case that exists.
      if (!s || s.agentType !== 'claude' || s._dead) return;
      // Stamped on the FIRST arm only, and every later arm reuses it: the
      // redelivery arms a second window, and the permission-dialog branch re-arms
      // UNCAPPED, so a constant in the escalation prose is wrong by however many
      // windows have run — "spawned 90s ago" for a seat stuck on a dialog for an
      // hour is a false statement in the one sentence an operator reads to decide
      // whether to look now.
      if (!s._reviewStartArmedAt) s._reviewStartArmedAt = Date.now();
      s._reviewStartTimer = setTimeout(() => {
        s._reviewStartTimer = null;
        try { this._checkReviewStarted(s, leadName); }
        catch (e) { log.error('intent', `review start check failed for ${seatName}: ${e.message}`); }
      }, SPEC_CONFIRM_MS);
      // Observer-grade in both senses, exactly like the spec-confirm timer: never
      // the reason the process stays alive, never the reason a test file hangs for
      // 90s after spawning a reviewer.
      if (s._reviewStartTimer.unref) s._reviewStartTimer.unref();
    }

    _checkReviewStarted(session, leadName) {
      if (!session || session._dead) return;
      if (!this.sessions.has(session.name)) return;   // retired inside the window
      // A dialog is an unbounded wait that produces no turn and no transcript, and
      // it is not this defect — the seat has its scope and is asking about it. Same
      // treatment as _checkSpecConfirm: re-arm rather than alarm, uncapped, because
      // the operator may answer at any time and a seat that never woke is still
      // worth catching later.
      if (session.needsAttention && session.needsAttention.kind === 'permission') {
        this._armReviewStartCheck(session.name, leadName);
        return;
      }
      if (session.activityState !== 'idle') return;   // it started; nothing owed
      if (this._seatHasTranscript(session.name)) return;

      // First window: re-send the nudge rather than waking the lead. The two
      // guards above are what make this safe — a seat that started between the arm
      // and here is either non-idle or has a transcript, so it is never poked.
      if (!session._reviewNudgeRetried) {
        session._reviewNudgeRetried = true;
        log.warn('intent', `reviewer ${session.name} has taken no turn ${SPEC_CONFIRM_MS / 1000}s after spawn — re-sending the start nudge once`);
        this._broadcast('ipc-message', {
          ts: Date.now(), from: 'clodex', to: session.name, kind: 'review-renudged',
          body: `${session.name} never started — re-sending the start nudge`,
        });
        // Contentless for the spawn site's reason: the scope lives in the system
        // prompt, and a second copy here would be the two-copies-disagree bug.
        //
        // The trailing clause is not politeness. A nudge submitted at t=89.9s
        // leaves the seat idle-with-no-transcript when this fires at t=90s, so the
        // retry parks and drains at the seat's next idle edge — AFTER its first
        // turn, telling a reviewer mid-review to "Begin" and inviting a second
        // report. That race cannot be closed from outside the seat, so the prose
        // makes the duplicate harmless instead of pretending a guard closed it.
        this._deliverParkedActive(session.name, leadName,
          'Your review scope is in your system prompt. Begin — ignore this if you have already started.', 'dm');
        // Watch the redelivery the same way the first nudge was watched. Without
        // this the retry is fire-and-forget and a seat that stays silent after it
        // is never escalated — the failure would go quiet instead of getting
        // louder, which is worse than the bug this fixes.
        this._armReviewStartCheck(session.name, leadName);
        return;
      }

      // Two nudges, no turn. Whatever is wrong is not a single lost write — a
      // chained modal, or something else entirely — and a third copy will not fix
      // it. Hand it to the lead, who can look at the seat.
      log.error('intent', `reviewer ${session.name} produced no transcript after a re-sent nudge — it never took a first turn`);
      this._broadcast('ipc-message', {
        ts: Date.now(), from: 'clodex', to: session.name, kind: 'review-unstarted',
        body: `${session.name} never started its review`,
      });
      this._gatedDeliver(leadName, 'clodex-team',
        // Measured from the first arm, not a constant: see the stamp's comment.
        // The `|| Date.now()` yields a visibly wrong 0s rather than `NaN s` for a
        // session that reaches here unarmed — a wrong number sends an operator to
        // look at the seat, NaN reads as a broken tool and sends them elsewhere.
        `[review ${session.name}] spawned ${Math.round((Date.now() - (session._reviewStartArmedAt || Date.now())) / 1000)}s ago, was re-sent its start nudge, and has STILL taken no turn — no transcript exists, so it never started. `
        + 'Its scope is in its system prompt and is intact; what was lost is the nudge that starts it, and re-sending it did not help. '
        + `Recover with an urgent dm to ${session.name} re-sending the scope and telling it to ignore the message if it already has it — NOT a respawn, which mints a second seat and strands this one's mail.`,
        false, `[review ${session.name}] never started`);
    }

    // Has this seat ever written a turn? The link is created at spawn and its
    // target only when the CLI writes — so a link that resolves to nothing is a
    // seat that has produced nothing, and an unreadable/absent link is the same
    // answer for a weaker reason. Every failure reads as "no transcript", which is
    // the direction that ALARMS, so a broken probe is loud rather than silent —
    // the opposite of `_stallEvidence`'s policy, and deliberately: there an absent
    // field degrades an alarm that fires anyway, here it IS the alarm.
    _seatHasTranscript(name) {
      try {
        const link = pathFor(REGISTRY_DIR, name, 'transcript');
        return fs.statSync(fs.realpathSync(link)).size > 0;
      } catch { return false; }
    }

    // Cleared by ANY non-idle activity (see _emitActivity): reaching a turn at all
    // means the seat submitted, and submitting is exactly what a lost write
    // prevents. The three shapes that must NOT alarm are silent for structural
    // reasons rather than tuned ones:
    //   - a seat thinking for minutes on its first turn went non-idle to think,
    //     so the latch was gone seconds after the write;
    //   - a seat that finished and is idle reached idle THROUGH thinking, which
    //     cleared it — a terminal idle with the latch still set is unreachable;
    //   - a seat blocked on a permission dialog re-arms below instead of firing,
    //     so a dialog answered ten minutes later is still checked afterwards.
    _checkSpecConfirm(session) {
      const u = session._specUnconfirmed;
      if (!u || session._dead) return;
      // A dialog is the one wait that is legitimately unbounded and produces no
      // activity. Re-arm rather than clear: the spec may still be unread behind it.
      // The re-arm is DELIBERATELY uncapped — the operator may answer at any time,
      // and a seat that never woke is still worth catching an hour later. It cannot
      // leak: the timer is unref'd and _cleanup clears it when the session dies.
      if (session.needsAttention && session.needsAttention.kind === 'permission') {
        this._armSpecConfirmTimer(session);
        return;
      }
      let team; try { team = resolveTeam(session.cwd); } catch { return; }
      if (!team) return;
      const ticket = ticketsStore.load(team.root).find((t) => t.id === u.ticketId);
      // Closed while we waited — nothing left to redeliver.
      if (!ticket || ticket.state !== 'open') { session._specUnconfirmed = null; return; }
      // Who holds the ticket NOW. The two ways that stops being this session are
      // opposite in what they mean, and collapsing them loses the louder one.
      const holder = this._ticketAssigneeSeat(team, ticket);
      // REASSIGNED to a live seat. This is the operator's documented recovery for a
      // silent seat, so it is the common case, not an edge: `task assign` re-pins the
      // ticket and delivers to the new seat, which starts work and clears its OWN
      // latch — nothing clears this one. Without this, _deliverTicketSpec re-resolves
      // to the new holder and injects a REPLAY into a seat mid-work on it, and the
      // second window escalates naming the wrong seat.
      if (holder && holder !== session.name) {
        // Logged because this branch collapses two different things: an operator
        // reassignment, and the role resolver simply picking a different sibling for
        // the same role. Both drop the latch correctly, but only the second means a
        // silent seat went unwatched, and nothing else would leave a trace of it.
        log.info('intent', `spec latch for ${u.ticketId} dropped at ${session.name}: the ticket now resolves to ${holder}`);
        session._specUnconfirmed = null;
        return;
      }
      // Resolves to NOBODY — the assignee died inside the window and nothing took
      // its role. Dropping this quietly alongside the reassignment case would be
      // this ticket's own premise failing inside its own fix: an open ticket whose
      // spec reached no one, and no one told.
      if (!holder) {
        session._specUnconfirmed = null;
        log.error('intent', `spec for ${u.ticketId} is stranded — ${session.name} never started a turn and the ticket now resolves to no live seat`);
        this._escalateTicket(team, u.ticketId, 'spec-undelivered',
          `${session.name} never started a turn after its spec was written, and the ticket no longer resolves to any live seat`,
          'the spec was injected once at dispatch; no redelivery was attempted because there is nobody to deliver to');
        return;
      }

      if (!u.retried) {
        // Safe to redeliver precisely BECAUSE the latch is still set: the seat
        // cannot have consumed the spec without submitting, and cannot submit
        // without clearing this. So the retry cannot duplicate work that was
        // taken — and where the first copy is sitting unsubmitted in the
        // composer (the Enter-eaten case), the redelivery's leading Ctrl-U
        // replaces that draft rather than concatenating with it.
        u.retried = true;
        log.warn('intent', `spec for ${u.ticketId} unconfirmed on ${session.name} after ${SPEC_CONFIRM_MS / 1000}s (no turn started) — redelivering once`);
        this._broadcast('ipc-message', {
          ts: Date.now(), from: 'clodex', to: session.name, kind: 'spec-unconfirmed',
          body: `ticket ${u.ticketId} spec written but no turn started — redelivering`,
        });
        // Marked as a replay: the seat may be holding an unsubmitted copy, and it
        // must not read the second one as a second ticket.
        const r = this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true, true);
        // A redelivery that reached nobody arms nothing, so the second window would
        // never run and the escalation below would be unreachable — the one case
        // where this mechanism most needs to speak (spec undeliverable, seat gone)
        // is the one it would go silent on. `parked` counts as reached: the file is
        // durable and the seat drains it, it is simply not confirmable from here,
        // which is the same reason the arm skips it.
        if (!r || !(r.queued || r.parked)) {
          const why = (r && (r.reason || (r.held && 'held') || (r.undelivered && 'no live seat resolves')))
            || 'unknown delivery failure';
          session._specUnconfirmed = null;
          log.error('intent', `redelivery of ${u.ticketId} to ${session.name} reached nobody (${why}) — escalating`);
          this._escalateTicket(team, u.ticketId, 'spec-undelivered',
            `${session.name} never started a turn after its spec was written, and the redelivery could not be handed to a seat: ${why}`,
            'the spec was injected once at dispatch and a redelivery was attempted after the confirmation window');
          return;
        }
        // A `parked` redelivery is durable but produces no edge to confirm, so there
        // is nothing further to watch; the park's own drains own it from here.
        if (r.parked) { session._specUnconfirmed = null; return; }
        // `queued` is a statement about the future, and the arm now rides the WRITE —
        // so a redelivery that is queued and then never written (the seat dies in the
        // gates, the queue is still holding it) arms no timer, and the latch would
        // dead-end with its retry spent: silent, in the case this exists to report.
        // Re-arm explicitly when the write has not already done it. Harmless if it
        // lands later — that arm replaces this timer and carries `retried` forward.
        if (!session._specConfirmTimer) this._armSpecConfirmTimer(session);
        return;
      }

      // Two writes, no turn. Whatever is wrong is not a lost write, and a third
      // copy would not fix it — hand it to the lead, who can look at the seat.
      session._specUnconfirmed = null;
      log.error('intent', `spec for ${u.ticketId} still unconfirmed on ${session.name} after a redelivery — escalating`);
      this._escalateTicket(team, u.ticketId, 'spec-undelivered',
        `${session.name} was written to twice and never started a turn (no activity for ${Math.round((Date.now() - u.at) / 1000)}s after dispatch)`,
        'the spec was injected once at dispatch and redelivered once after the confirmation window');
    }

    _ticketDeliverySuffix(d, assignee) {
      if (d.undelivered) return ` — NOTE: no live seat for "${assignee}" yet; spec not delivered (reassign or wait for it to spawn)`;
      if (d.held) return ` — NOTE: spec NOT delivered (${d.reason || 'held'}); the seat cannot be parked for, so it has not seen the spec — re-send when it clears`;
      if (d.parked) return ` — NOTE: spec parked, not injected (${d.reason || 'held'}); it drains on the seat's next turn`;
      return '';
    }

    // Every open ticket resolving to `seatName`, oldest first — advance takes the
    // head, replay takes the whole list. ONE resolver on purpose: a second copy of
    // the role-or-name match would let advance and replay disagree about which
    // tickets are a seat's, and the disagreement would be invisible (each would
    // look right in isolation).
    // Order is FIFO by openedAt, ties broken by numeric id — array order is not
    // deterministic for two tickets minted in the same ms.
    // Backlog (`assignee == null`) is excluded here, so it can never be replayed
    // to anybody — an unassigned ticket resolves to no seat by definition.
    // `parked` is the same exclusion for a ticket that DOES name its seat: the
    // lead filed who it is for without filing that it starts now. It is dropped
    // rather than sorted last, so it cannot occupy the head that advance takes
    // — a parked ticket must not make a live one wait, and ordering by a flag
    // would make dispatch order depend on it.
    // The degraded pin (a dead seat's ticket falling back to its role) is NOT a
    // second clause here: it is `_ticketAssigneeSeat`'s, and this asks that
    // resolver rather than re-deriving liveness. A copy of the rule here could
    // disagree with the one delivery uses, and the disagreement is invisible —
    // this would list a ticket the delivery then refuses, and `_advanceSeat`
    // would report a hand-off that never happened.
    // `ticketStarted` is the third exclusion, alongside backlog and parked, and it
    // is here rather than in the badge filters on purpose. Both callers DISPATCH
    // what this returns — advance pushes the head at a seat that just closed one,
    // replay re-delivers on respawn — and an added-but-unstarted ticket assigned
    // to a ROLE matches every seat filling that role, so without this the spec of
    // a ticket that has no tree of its own is delivered into the checkout of one
    // that does. That is `add` still dispatching, by a later edge; the seam
    // `task start` exists to create leaks without it.
    // The two badge filters (`_reconcileTickets` and the session-list builder)
    // deliberately do NOT carry this term: a filed ticket is worth showing on the
    // row, and those two must move together or the badge flickers between paints.
    _openTicketsFor(team, seatName, excludeId = null) {
      const role = matchSeatRole(team, seatName);
      const live = this._teamLiveSeatNames(team.root);
      return ticketsStore.load(team.root)
        .filter((t) => t.state === 'open' && t.id !== excludeId && t.assignee != null && !t.parked
          && ticketStarted(t)
          && (t.assignee === seatName || (role && t.assignee === role)
            || this._ticketAssigneeSeat(team, t, live) === seatName))
        .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0)
          || (Number(String(a.id).replace(/^t/, '')) || 0) - (Number(String(b.id).replace(/^t/, '')) || 0));
    }

    // Hand a seat its next open ticket when it closes one: the COMPLETION edge has no
    // other trigger, and a seat holding a queue otherwise goes idle until a human
    // pokes it.
    // `closedId` is redundant on both current callers (each stamps its terminal state
    // and SAVES before calling, so the state filter already excludes it) — kept
    // because that is an ordering ACCIDENT, not a property of the helper: move the
    // advance above the save and without it the seat is handed back what it finished.
    _advanceSeat(team, seatName, closedId) {
      if (team && team.solo) return null;
      const next = this._openTicketsFor(team, seatName, closedId)[0];
      if (!next) return null;
      // Handing a queued ticket to a seat IS its dispatch — the only one it gets —
      // so it re-pins like the two lead-driven paths. Reloaded from the store
      // rather than saving the filtered array `_openTicketsFor` built, which is
      // not the array on disk.
      if (this._repinTicketToSeat(team, next)) {
        try {
          const all = ticketsStore.load(team.root);
          const t = all.find((x) => x.id === next.id);
          if (t) { t.role = next.role; t.assignee = next.assignee; ticketsStore.save(team.root, all); }
        } catch { /* best-effort: the pin is a measurement, never a reason the hand-off fails */ }
      }
      this._deliverTicketSpec(team, next, next.spec, 'clodex-team', true);
      log.info('intent', `seat ${seatName} advanced to ${next.id} after closing ${closedId}`);
      return next;
    }

    // A ticket's spec is delivered when it is ASSIGNED and never again, so a seat
    // that dies between assignment and completion comes back holding a bare id
    // with no body — and from inside the seat that is indistinguishable from a
    // ticket it has correctly been told to hold. No design that waits for the seat
    // to notice will ever fire; the asymmetry has to be resolvable from the RECORD.
    //
    // Redeliver when the record cannot SHOW this incarnation has the spec:
    // `deliveredTo.incarnation` is minted at spawn and lives only in memory, so
    // after a respawn it cannot match and the absence is itself the signal. A
    // timestamp would not work — `deliveredAt` survives the very respawn that lost
    // the delivery, and any key read back off the record has the same defect for
    // the same reason: the record is what survived.
    // Returns whether the pass is FINISHED — delivered, or found nothing it could
    // ever deliver. False means only that a candidate was held, which is temporary by
    // nature, so the caller keeps its one-shot armed for the next edge.
    _replayOpenTickets(session) {
      if (!session || !session.agentType || session._dead) return true;
      let team; try { team = resolveTeam(session.cwd); } catch { return true; }
      if (!team) return true;
      const open = this._openTicketsFor(team, session.name);
      if (!open.length) return true;
      let held = false;
      for (const t of open) {
        const d = t.deliveredTo;
        if (d && d.seat === session.name && d.incarnation === session.incarnation) continue;
        // `_openTicketsFor` matches a ROLE ticket to every seat filling that role,
        // but _deliverTicketSpec re-resolves to the FIRST live seat with it. Without
        // this, two seats on one role send the spec to seat #1 twice and stamp it
        // with seat #2, which received nothing.
        if (this._ticketAssigneeSeat(team, t) !== session.name) continue;
        if (!t.spec) continue;   // hand-edited record — delivering it injects literal "undefined"
        const r = this._deliverTicketSpec(team, t, t.spec, 'clodex-team', true, true);
        // Stamp only what reached the seat, or is durably on its way. `parked`
        // counts — the text is in the seat's pending store and drains on its next
        // turn — but `held` and `undelivered` do NOT: stamping those would record a
        // delivery that never happened and suppress the next replay, which is this
        // bug with extra steps.
        // `queued` is WEAKER than `parked` and knowingly so: the bytes are in the
        // inject queue, written within a poll of the seat's readiness latch, so a
        // write wiped by a boot re-render still stamps. t156's latch is what keeps
        // that window shut in practice; at _armReplayFallback's ceiling it reopens.
        // Closing it properly means stamping from a write-time hook here too — a
        // change to the replay, which t156 already latched and t168 does not touch.
        // `held` is the one non-delivery worth retrying: it is a property of the seat
        // at this instant, not of the ticket. `self` and `undelivered` are structural
        // and would be identical on every later pass.
        if (r && r.held) held = true;
        if (!r || !(r.queued || r.parked)) continue;
        // ONE ticket per respawn, not N. N back-to-back injects race: #1's Enter
        // starts a turn and #2 lands in the turn-start churn where its Enter is
        // swallowed → stranded draft (_flushParkedNow documents the same race being
        // fixed once already). Head-only rather than joining, because the seat's next
        // ticket already arrives on close via _advanceSeat — a proven path.
        // Loaded HERE, after the delivery decided: an early load would be a wider
        // window for a concurrent clodex-team write to be clobbered by the save.
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((x) => x.id === t.id);
        if (!rec) return true;
        rec.deliveredTo = { seat: session.name, incarnation: session.incarnation, at: Date.now() };
        // Replay is the OTHER hand-off, so it re-pins for the same reason advance
        // does: handing a queued ticket to a seat IS its dispatch. Without this a
        // ticket inherited from a dead seat keeps naming that seat, and its cost
        // lands on a ledger belonging to something that never did the work.
        // Rides this save, which is already the post-delivery reload. A DEGRADED
        // worktree ticket never reaches here — the resolver's `!worktree` gate
        // keeps it off this path. One pinned to its own live seat does reach it
        // (the ordinary ticket-seat respawn, resolved above that gate), and the
        // re-pin is a no-op on it: `_repinTicketToSeat` bails on pinned-and-live.
        this._repinTicketToSeat(team, rec);
        ticketsStore.save(team.root, tickets);
        log.info('intent', `replayed ${t.id} to ${session.name} (respawn)`);
        return true;
      }
      return !held;
    }

    // The claude fallback for a seat that never announces bracketed paste. It must
    // not deliver while the latch is still MISSING: `enqueue` returns delivered
    // synchronously but the bytes wait in the queue's ready loop and are written
    // within one poll of whenever the latch does arrive — so firing at the cap for a
    // seat that announces just after it puts the write back inside the re-render
    // window, stamped delivered. Same defect as the original, one layer further out.
    //
    // So re-check instead of delivering: any latch arriving during a period this
    // short leaves _bootDrainTimer armed at the next check, and the drain owns it.
    // The ceiling is what stops an unbootable seat re-arming forever; delivering at
    // that point is a considered last resort, since a spec injected into a seat that
    // never came up is no worse than the spec being dropped.
    _armReplayFallback(session, periodMs, deadline) {
      session._replayFallbackTimer = setTimeout(() => {
        session._replayFallbackTimer = null;
        if (session._dead || !session._replayTicketsPending) return;
        if (session._bootDrainTimer) return;                       // edge latched; the drain owns it
        if (!session._bootReadySeen && Date.now() < deadline) {
          this._armReplayFallback(session, periodMs, deadline);
          return;
        }
        this._replayTicketsOnce(session);
      }, periodMs);
    }

    // One replay per process, whichever edge gets there first: the claude arm has two
    // (the boot-ready drain and a fallback for a seat that never announces), and both
    // must be safe to fire.
    // The one-shot is spent only on an outcome that REACHED the seat. A `held` verdict
    // delivers nothing and stamps nothing, so consuming the flag there would burn the
    // process's only replay on a pass that did no work — while the other claude edge
    // is still to come.
    _replayTicketsOnce(session) {
      if (!session || !session._replayTicketsPending || session._dead) return;
      let done = false;
      try { done = this._replayOpenTickets(session); }
      catch (e) { log.error('inject', `ticket replay failed for ${session.name}: ${e.message}`); done = true; }
      if (done) session._replayTicketsPending = false;
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

    // The disabled-intent gate's payload suffix. Separate from the t166 ticket
    // sites (_spillRejectedPayload above) for two reasons that are properties of
    // THIS gate, not of spilling:
    //
    // A denial is not a mistake. Every t166 site rejects an input the sender can
    // correct — wrong id, not your ticket — so telling it to copy the body out and
    // retry is actionable. Here retrying is guaranteed to bounce identically; only
    // the operator can change the seat's allowlist, from the local GUI. Any copy
    // that reads as "fix it and try again" sends the sender into a loop it cannot
    // exit, so this path says whose call it is instead.
    //
    // And a denial REPEATS without bound. A t166 bounce is a rare error; a seat
    // that has not internalised a denied verb emits one every turn, forever, and an
    // unconditional spill would write a file each time. sweepSpilledMessages bounds
    // spill AGE (MSG_MAX_AGE), not RATE, and engine.js's sweep header explicitly
    // rules against adding a second expiry policy that could disagree with parking
    // — so the rate has to be capped at the source. Hence the per-(seat, verb)
    // budget: keyed by verb because a seat can be denied several capabilities and
    // one must not eat another's budget, and held on the live Session so a respawn
    // (fresh context, has not read the earlier bounces) starts over.
    //
    // Past the budget the sender is still told the body is gone. The
    // saved/not-saved outcomes stay distinguishable in the reply for the same
    // reason _spillRejectedPayload distinguishes them: a sender that reads "saved"
    // stops holding the only copy.
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

    // The role def for a ticket that should get its OWN branch + seat, or null.
    // Deliberately narrow: only a ROLE-addressed ticket qualifies. A ticket the
    // lead addressed to a SEAT names a session that already exists and already
    // has a cwd — a session's cwd is fixed at PTY spawn, so there is no
    // expressible "move that seat into a worktree".
    _ticketWorktreeRole(team, assignee) {
      if (!team || !assignee || !team.roles) return null;
      if (!Object.prototype.hasOwnProperty.call(team.roles, assignee)) return null;
      const def = team.roles[assignee];
      if (!def || def.dispatch !== 'worktree') return null;
      // The manifest refuses to WRITE this pair, but team.json is hand-editable
      // and files predating that check exist: the resolver holds the line too.
      if (assignee === 'lead' || assignee === 'reviewer') return null;
      return def;
    }

    // `<team>-<role>-<n>` from the ticket id, which is what keeps matchSeatRole
    // working: it strips a trailing `[-_]?\d+`, so the seat still resolves to its
    // role. A taken name is NOT worked around with a second numbering scheme —
    // that would produce a name matchSeatRole cannot decompose.
    _mintTicketSeat(team, roleKey, ticket) {
      const n = String(ticket.id).replace(/^t/, '');
      const name = `${team.name}-${roleKey}-${n}`;
      if (!AGENT_NAME_RE.test(name)) return { ok: false, error: `seat name "${name}" is not name-legal` };
      // `name` rides the refusal too: the name is derived, so a caller holding a
      // ticket that already has a seat has no other way to learn which one without
      // re-deriving it, and a second copy of this rule is how the two drift.
      if (this.sessions.has(name) || getPersistence().get(name)) return { ok: false, taken: true, name, error: `seat name "${name}" is taken` };
      const slug = branchSlug(ticket.title);
      return { ok: true, name, branch: slug ? `${ticket.id}-${slug}` : String(ticket.id) };
    }

    // The live seat working in `treePath`, or null. Read off the PERSISTED record
    // rather than the session: a seat's cwd is the shared repo (it is told its tree
    // rather than booted in it), so cwd cannot answer this.
    _ticketTreeHolder(treePath) {
      if (!treePath) return null;
      const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      const want = real(treePath);
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        let rec; try { rec = getPersistence().get(s.name); } catch { rec = null; }
        const held = rec && rec.worktree && rec.worktree.path;
        if (held && real(held) === want) return s.name;
      }
      return null;
    }

    // The ticket's tree, when it still exists — a seat dies, its tree does not.
    // Read from git rather than from the record alone: the record survives the
    // tree, so a recorded path proves nothing about what is on disk now.
    async _existingTicketTree(team, ticket) {
      const wt = ticket && ticket.worktree;
      if (!wt || !wt.path || !wt.branch) return null;
      let listed;
      try { listed = await gitWorktree.listWorktrees(team.root); } catch { return null; }
      if (!listed || !listed.ok) return null;
      // git prints realpath'd paths; the record carries the path as created, which
      // on macOS keeps the /tmp → /private/tmp symlink. Compare canonically or the
      // match silently fails and every reuse mints a second tree.
      const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      const want = real(wt.path);
      // `prunable` is the whole reason this reads the LISTING and not just the
      // record: a tree the operator deleted by hand stays registered and is printed
      // here like any other, so matching on path and branch alone would hand the
      // seat a `WORK IN:` path with nothing at the end of it. Rejecting it falls
      // through to createWorktree, which prunes the stale entry as it goes.
      // `locked` is a deliberate "do not touch this tree" the operator set.
      const hit = listed.worktrees.find((e) => e.path && !e.isMain && !e.prunable && !e.locked
        && e.branch === wt.branch && real(e.path) === want);
      if (!hit) return null;
      // Belt and braces for the `prunable` annotation, which git only emits from
      // 2.36 — on an older git the flag never arrives and the check above silently
      // reverts to matching a tree that is no longer on disk. Additional, not a
      // replacement: an existence check alone races and misses a directory that
      // survives without holding a worktree. Both of ITS failure directions are
      // safe, since a wrong reject falls through to making a fresh tree.
      try { if (!fs.existsSync(path.join(hit.path, '.git'))) return null; } catch { return null; }
      // Occupancy is the check git used to make for us — it refuses to check one
      // branch out twice, and that refusal is what caught a ticket moved to a
      // second worktree role while the first seat was still cd'd into the tree.
      // Reuse walks around it, so the holder has to be looked for here: two agents
      // editing one checkout and committing onto one branch is the collision the
      // whole mechanism exists to prevent. _taskAssign refuses earlier and names
      // the holder; this is the backstop for every other caller.
      if (this._ticketTreeHolder(wt.path)) return null;
      // baseSha carried through: it was captured when the tree was MINTED and is
      // unrecoverable here, so dropping it on reuse quietly downgrades the
      // close-time commit count to its merge-base fallback for exactly the
      // tickets that outlived a seat.
      return { path: wt.path, branch: wt.branch, ...(wt.baseSha ? { baseSha: wt.baseSha } : {}) };
    }

    // Mint the worktree, spawn the seat, then hand it the spec. Async and
    // fire-and-forget like the other spawn paths: the ticket record is already
    // saved, so a crash here loses the seat, never the ticket.
    // Resolve a library template NAME into the seat shape create() takes.
    // Extracted because the ticket path used to pass `[]` for every one of these
    // and a role's `template:` was inert for exactly the seats it was written
    // for — the hands — while the spawn-intent path 40 lines up honored it. Two
    // call sites, one resolution; a third inherits it instead of re-deriving it.
    //
    // AGENT-INITIATED, both callers: a template is agent-writable, so privileged
    // intents are stripped and env is confined to REVIEWER_ENV_ALLOWLIST. Only an
    // operator's local GUI create/edit may grant those.
    _templateShape(tplName) {
      if (!tplName) return null;
      let tpl = null;
      try { tpl = getTemplates().list().find((t) => t && t.name === tplName) || null; }
      catch { tpl = null; }
      if (!tpl) return null;
      const { sessionEnv, dropped, badType } = filterTemplateEnv(tpl.env);
      return {
        tpl,
        extraArgs: (Array.isArray(tpl.extraArgs) && tpl.extraArgs.length) ? tpl.extraArgs : null,
        agents: tpl.agents || [],
        denyBuiltins: tpl.denyBuiltins || [],
        disabledTools: tpl.disabledTools || [],
        disabledSkills: tpl.disabledSkills || [],
        injectSkills: tpl.injectSkills || [],
        systemPromptFile: tpl.systemPromptFile || null,
        appendPromptFiles: tpl.appendPromptFiles || [],
        execCommands: Array.isArray(tpl.execCommands) ? tpl.execCommands : [],
        intents: withoutPrivilegedIntentsFor(Array.isArray(tpl.intents) ? tpl.intents : null),
        sessionEnv,
        envDropped: dropped,
        envBadType: badType,
        noWire: tpl.noWire === true,
      };
    }

    // The ONE seat shape both team spawn paths pass to create(). They diverged
    // silently twice — the review path hand-rolled a second copy of the env
    // allowlist filter against the same constant, so either copy could be edited
    // without the other. `purpose` selects the reviewer's hard rules; everything
    // else resolves identically for both.
    //
    // `opener` is the session doing the spawning (the lead). It is not derivable
    // from (team, roleKey): `type` and `workspaceId` are inherited from it, and so
    // is the permission posture.
    resolveSeatShape(team, roleKey, purpose, opener) {
      // Explicit, because the switch below is otherwise FAIL-OPEN: `!review`
      // takes the ticket arm, so a typo'd 'reviewer' at a future call site would
      // spawn a reviewer with no tool cap, no forced claude and no env fallback,
      // and nothing would fail. This method is the choke point that makes the cap
      // real, so an unrecognized purpose must not resolve to the weaker seat.
      if (purpose !== 'ticket' && purpose !== 'review') {
        throw new Error(`resolveSeatShape: unknown purpose "${purpose}" (expected 'ticket' or 'review')`);
      }
      const def = (team && team.roles && team.roles[roleKey]) || null;
      const review = purpose === 'review';
      const shape = this._templateShape(
        review ? ((def && def.template) || DEFAULT_REVIEWER_TEMPLATE) : (def && def.template),
      );
      const tpl = (shape && shape.tpl) || null;
      const leadArgs = (getPersistence().get(opener.name)?.extraArgs) || [];
      const postureArgs = leadArgs.includes('--dangerously-skip-permissions')
        ? ['--dangerously-skip-permissions'] : [];
      const workspaceId = opener.workspaceId || DEFAULT_WORKSPACE_ID;

      if (!review) {
        return {
          // The seat's type comes from the opener, not from the role: a role that
          // wants codex hands names a codex TEMPLATE. The role field that used to
          // sit here was honored verbatim on this path and overridden with a
          // warning on the review path.
          type: opener.type || 'claude',
          // The REPO, not the worktree. The seat is TOLD where its tree is and goes
          // there itself. Booting it in the worktree would bind the seat's whole
          // identity — transcript, project root, team block, recent-cwd — to one
          // branch's checkout, which is removed when the ticket's session is deleted.
          cwd: team.root,
          tpl,
          extraArgs: (shape && shape.extraArgs) || postureArgs,
          agents: (shape && shape.agents) || [],
          denyBuiltins: (shape && shape.denyBuiltins) || [],
          disabledTools: (shape && shape.disabledTools) || [],
          disabledSkills: (shape && shape.disabledSkills) || [],
          injectSkills: (shape && shape.injectSkills) || [],
          // Reviewer-only concept: no cap applies off the review path, so there is
          // no allowlist to report. Present so both purposes return one key set.
          effectiveTools: null,
          // null even when the template DOES carry `tools`: this field means "what
          // the reviewer cap was asked to intersect", and off the review path
          // nothing is asked of the cap — reporting a request no arm honored would
          // invite a caller to act on it.
          requestedTools: null,
          // Same posture: nothing off the review path judges the template's
          // `tools` at all, so there is no malformation to report.
          toolsMalformed: false,
          // The template's systemPromptFile does NOT displace `def.prompt`: for
          // claude both ride --append-system-prompt-file and create() dedupes them
          // by name equality, so passing both is how a template-shaped seat still
          // gets its role delta.
          systemPromptFile: (def && def.prompt) || (shape && shape.systemPromptFile) || null,
          appendPromptFiles: (shape && shape.appendPromptFiles) || [],
          execCommands: (shape && shape.execCommands) || [],
          // `[]` (everything gated) is a real value that must apply; null means the
          // seat keeps the living all-enabled default. Not interchangeable.
          intents: shape ? shape.intents : null,
          env: (shape && shape.sessionEnv) || null,
          envDropped: (shape && shape.envDropped) || [],
          envBadType: (shape && shape.envBadType) || [],
          beyondCap: [],
          promptEscaped: null,
          workspaceId,
          ephemeral: true,
        };
      }

      // C2 (T29 Slice 2): the cold reviewer ALWAYS spawns as claude. This is CODE,
      // not a manifest field: only create()'s claude arm consumes disabledTools
      // (via setupClaudeHook), so a codex reviewer would spawn UNCAPPED — codex
      // ignores the denylist entirely, and the tools cap would silently evaporate.
      // Forcing claude here is the choke point that makes the cap real.
      const type = 'claude';

      // The reviewer TEMPLATE may narrow the cap; nothing widens it. The role def
      // used to be a second source here and it was inert on every other role,
      // which is what made a `tools:` on a hand read as a restriction and enforce
      // nothing.
      // THREE states, not two: only an ABSENT `tools` takes the full cap. An empty
      // array and a wrong-typed value both used to collapse to the same null as
      // absent, so a template that asked for nothing — or asked malformedly —
      // spawned with every capped tool. That is the widening direction, reached by
      // a typo, on a file agents can write.
      // `null` counts as absent: it is JSON's conventional "no value", and a
      // template round-tripped through a writer that emits nulls for missing
      // fields must not start refusing. Safe only while NO editor writes `tools` —
      // if it ever joins EDITOR_OWNED, a cleared control emitting null starts
      // meaning "the operator removed every tool", and reading that as "take the
      // full cap" is the widening this guard exists to kill. Move null to the
      // malformed/empty arm at the same time.
      const rawTools = tpl && tpl.tools;
      const toolsMalformed = rawTools != null && !Array.isArray(rawTools);
      // `[]` survives as `[]` here, and reaches the same empty intersection a
      // disjoint list does — one refusal covers both.
      const requestedTools = Array.isArray(rawTools) ? rawTools : null;
      // Fail-closed on malformed, so the SHAPE alone cannot spawn a widened seat
      // even if a future caller forgets the refusal. Only the caller can make it
      // visible, and only the caller can bail before the name is minted.
      const effectiveTools = toolsMalformed
        ? []
        : (requestedTools
          ? REVIEWER_TOOL_CAP.filter((t) => requestedTools.includes(t))
          : REVIEWER_TOOL_CAP.slice());
      const beyondCap = requestedTools
        ? requestedTools.filter((t) => !REVIEWER_TOOL_CAP.includes(t))
        : [];

      // Presence test only — _templateShape still owns the FILTERING. The
      // fallback hinges on whether the template supplied an env object at all,
      // which is not recoverable from the filtered result: a template whose keys
      // were every one of them dropped yields the same empty result as a template
      // with no env, and those two must not resolve alike (the first asked for an
      // env and got none of it; the second never asked, and takes the default).
      const tplSuppliedEnv = !!(tpl && tpl.env && typeof tpl.env === 'object' && !Array.isArray(tpl.env));

      let systemPromptFile =
        (tpl && typeof tpl.systemPromptFile === 'string' && tpl.systemPromptFile)
          ? tpl.systemPromptFile
          : ((def && def.prompt) || REVIEWER_FALLBACK.systemPromptFile);
      // Defense-in-depth (T52 nit): the template is agent-writable and its
      // systemPromptFile flows into resolveSystemPromptFile → promptLibrary._file,
      // a bare path.join with no confinement — a stem like "../../../../etc/x"
      // escapes library/prompts/system. This is a PRE-EXISTING, non-escalating gap
      // (def.prompt already flowed through the same resolver, and a system prompt
      // only INSTRUCTS — it grants no tool/intent/env, all of which stay capped),
      // but since T52 makes the template the canonical prompt source, reject a
      // traversing/absolute stem HERE (not in the shared resolver — don't widen the
      // blast radius) and fall back to the shipped default. The rejected stem rides
      // back on `promptEscaped` because the caller warns about it loudly.
      let promptEscaped = null;
      if (systemPromptFile.includes('/') || systemPromptFile.includes('\\') || systemPromptFile.includes('..')) {
        promptEscaped = systemPromptFile;
        systemPromptFile = REVIEWER_FALLBACK.systemPromptFile;
      }

      return {
        type,
        cwd: team.root,
        tpl,
        // MERGED onto postureArgs, never replacing them (that is the ticket
        // arm's shape, and the reason a template can hand a ticket seat posture
        // its opener does not hold). reviewerModelArgs is an allowlist of one
        // flag — do not widen it to honor the template's array.
        extraArgs: [...postureArgs, ...reviewerModelArgs(shape && shape.extraArgs)],
        agents: [],
        denyBuiltins: [],
        disabledTools: CLAUDE_TOOLS.filter((t) => !effectiveTools.includes(t)),
        disabledSkills: [],
        injectSkills: [],
        // Carried, not recomputed from disabledTools: the warning below prints it
        // in REVIEWER_TOOL_CAP order, and inverting the denylist would print it in
        // CLAUDE_TOOLS order instead — a silent change to operator-facing text.
        effectiveTools,
        // Carried so the refusal can PRINT the exact list the template asked for
        // without borrowing beyondCap, whose meaning is "what you overreached for"
        // — identical content in the refusal state today, but a future edit to one
        // message would silently change the other. It also states the guard's
        // precondition, which effectiveTools alone no longer carries: [] arises in
        // three ways — a well-formed request that intersects the cap emptily, `[]`
        // itself, and a malformed `tools` (fail-closed above) — but NEVER for an
        // absent/null `tools`, which takes the non-empty constant. So the guard
        // below needs requestedTools truthy to mean "a real request emptied out";
        // malformed carries requestedTools: null and is refused separately.
        requestedTools,
        // A separate key, not inferable from requestedTools being null: null also
        // means "absent", which takes the full cap. The caller must refuse one and
        // not the other, and re-reading tpl.tools to tell them apart would put a
        // second copy of this type judgment at the call site.
        toolsMalformed,
        systemPromptFile,
        appendPromptFiles: [],
        execCommands: [],
        // `[]`, not null: the reviewer's fallback gates every intent. See the
        // ticket arm — the two values mean opposite things to create().
        intents: (shape && Array.isArray(shape.intents)) ? shape.intents : [],
        // An object always, never null — and the fallback applies whenever the
        // TEMPLATE supplied no usable env, not merely when the template is
        // missing: a reviewer that booted without CLODEX_DISABLE_IPC_PROMPT gets
        // the full protocol prompt it was configured not to have.
        // REVIEWER_FALLBACK.env needs no allowlist pass: it IS the shipped set the
        // allowlist was drawn from, and unlike a template it is not agent-writable.
        env: tplSuppliedEnv ? { ...((shape && shape.sessionEnv) || {}) } : { ...REVIEWER_FALLBACK.env },
        envDropped: (shape && shape.envDropped) || [],
        envBadType: (shape && shape.envBadType) || [],
        beyondCap,
        promptEscaped,
        workspaceId,
        ephemeral: true,
      };
    }

    // stripLevel/autoCompact are persistence writes, not create() args, so they
    // land AFTER create() mints the entry — setStripLevel on a missing entry is a
    // silent no-op, which is how a template's strip level got lost before.
    // Takes the TEMPLATE, not a shape: one caller has no shape to give (its
    // template can be a bare JSON file named by path), and a synthetic `{ tpl }`
    // there would be a second source that agrees only until this writer reads a
    // second shape field — at which point that path goes inert silently.
    _applyTemplatePersistence(name, tpl) {
      if (!tpl) return;
      if (tpl.stripLevel === 1 || tpl.stripLevel === 2) getPersistence().setStripLevel(name, tpl.stripLevel);
      if (tpl.autoCompact === false) getPersistence().setAutoCompact(name, false);
    }

    // No `def` parameter: the resolver derives the role def from (team, roleKey)
    // itself, and passing a second copy in would be exactly the duplicate source
    // this seam removes — a caller could hand in a def for a different role.
    _spawnTicketSeat(opener, team, ticket, roleKey, seat) {
      const reply = (msg) => this._injectText(opener, `[agent:task] ${msg}`, { parkable: true });
      // Reserved SYNCHRONOUSLY, before any await: two tickets opened in one lead
      // turn both run their taken-name check above before either create() lands,
      // and the persistence stub is what makes the second one see the first.
      // Same ordering contract as the reviewer's stub: the label must be on the
      // record BEFORE the deferred create() reads it back to mint the proxy id.
      const seatLabel = teamCost.wireLabelFor({
        team: team.name, ticketId: ticket.id, role: roleKey,
      });
      getPersistence().upsert({
        name: seat.name, ephemeral: true,
        ...(seatLabel ? { wireLabel: seatLabel } : {}),
      });
      // Un-pin the ticket back to its role. Reloaded from the store rather than
      // mutating the caller's array: this runs after the caller returned, so that
      // array may no longer be what is on disk.
      const unpin = () => {
        try {
          const all = ticketsStore.load(team.root);
          const t = all.find((x) => x.id === ticket.id);
          if (!t) return;
          t.assignee = roleKey;
          delete t.role;
          // The dispatch is being rolled back, so the record of it goes too. Both
          // callers reach here only when the ticket has NO tree left to point at,
          // which is the same condition that makes it genuinely unstarted — and a
          // ticket left stamped would be refused by `start` forever, reachable
          // only through `assign`. Memory follows disk for the same reason
          // clearTicketTree does it: the catch below reads the in-memory copy.
          t.startedAt = null;
          ticket.startedAt = null;
          ticketsStore.save(team.root, all);
        } catch { /* best-effort — the reply below is the operator-visible half */ }
      };
      const clearTicketTree = () => {
        try {
          const all = ticketsStore.load(team.root);
          const t = all.find((x) => x.id === ticket.id);
          // Memory follows disk even on the early return. The catch's un-pin reads
          // `ticket.worktree` in memory while unpin() and this reload from the
          // store, so a save that threw earlier would leave the two disagreeing —
          // and the guard would skip an un-pin the on-disk state calls for.
          if (!t || !t.worktree) { delete ticket.worktree; return; }
          delete t.worktree;
          ticketsStore.save(team.root, all);
          delete ticket.worktree;
        } catch { /* best-effort */ }
      };
      // One tree, one record — the write and the scan that enforces it, together.
      // They are one operation and must not be separated: writing this seat's
      // pointer without clearing the others ADDS a second record naming the tree,
      // which is worse than the stale pointer it was meant to fix. session:kill
      // reads the tree off whichever record it is deleting, so Delete Session… on
      // either row would `worktree remove --force` the checkout out from under the
      // seat living in it, and the delete handler cannot detect that — it has one
      // path and one record.
      //
      // The scan is NOT gated on `reused`. A fresh tree lands on the same path
      // just as easily: the seat is archived (record kept), the operator deletes
      // the directory, _existingTicketTree rejects the stale entry, and
      // createWorktree prunes it and recomputes the identical default path, which
      // is free again by then. `reused` is false and the collision is identical.
      const claimTree = (w) => {
        if (!w || !w.path) return;
        try {
          getPersistence().setWorktree(seat.name, w);
          // Canonically. A record written through another route (session:markWorktree,
          // a spawn-intent tree, one carried across a restart) can name the same
          // tree through a symlinked prefix (/tmp vs /private/tmp), and a raw string
          // compare skips it — re-opening the exact bug this closes.
          const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
          const want = real(w.path);
          for (const e of getPersistence().list()) {
            if (e.name !== seat.name && e.worktree && e.worktree.path && real(e.worktree.path) === want) {
              getPersistence().setWorktree(e.name, null);
            }
          }
        } catch { /* best-effort */ }
      };
      setImmediate(async () => {
        let wt = null;
        // A reused tree is not this spawn's to destroy: it carries the commits the
        // previous seat left on the branch, which are the only thing that survived
        // it. Only a tree this spawn created is rolled back below.
        let reused = false;
        try {
          const existing = await this._existingTicketTree(team, ticket);
          if (existing) { wt = existing; reused = true; }
          else {
            // base HEAD, not the default branch: a ticket is written against the
            // tree the lead is looking at, which routinely has unpushed commits.
            // Forking from origin/HEAD instead hands the seat a stale checkout in
            // which the spec's symbols may not exist, and merging that branch back
            // would revert everything the lead had not pushed.
            const r = await gitWorktree.createWorktree(team.root, seat.branch, { base: 'HEAD' });
            if (!r || !r.ok) {
              // NO fallback to team.root. The spec was written for an isolated
              // checkout; spawning in the shared one would have the hand commit
              // onto whatever branch the operator happens to have checked out.
              getPersistence().remove(seat.name);
              // Same invariant as the catch below: un-pin ONLY when the ticket has
              // no tree to point at. Reaching here means _existingTicketTree
              // rejected the recorded tree (locked, or held) and the fresh one
              // failed too — so `ticket.worktree` still names a real tree that
              // nothing has cleared, and a role-assigned ticket carrying a live
              // WORK IN: pointer is replayed into every seat filling that role.
              const pinned = !!(ticket.worktree && ticket.worktree.path);
              if (!pinned) unpin();
              // The pinned assignee names a seat that does not exist and whose
              // record was just removed. Say so, and name the recovery: the name
              // is free again, so a re-assign re-mints it and re-enters this path.
              reply(pinned
                ? `ticket ${ticket.id}: worktree "${seat.branch}" could not be created (${(r && r.error) || 'unknown'}) — no seat spawned; the ticket stays pinned to "${ticket.assignee || roleKey}" and still names its tree ${ticket.worktree.path}; re-assign it to retry`
                : `ticket ${ticket.id}: worktree "${seat.branch}" could not be created (${(r && r.error) || 'unknown'}) — no seat spawned, ticket left assigned to "${roleKey}"`);
              return;
            }
            // baseSha is the fork point, captured HERE because it is unrecoverable
            // later: the ref this forked from is 'HEAD', which has moved by the time
            // the ticket closes and counts its commits against it.
            wt = { path: r.path, branch: r.branch, ...(r.baseSha ? { baseSha: r.baseSha } : {}) };
          }
          // Recorded on the TICKET, which is what _deliverTicketSpec reads to tell
          // the seat where to work. On the ticket rather than only on the session
          // because the spec is redelivered on a replay, and a seat that comes back
          // after a respawn needs the location as much as the first one did.
          try {
            const all = ticketsStore.load(team.root);
            const rec = all.find((x) => x.id === ticket.id);
            if (rec) { rec.worktree = wt; ticketsStore.save(team.root, all); }
            ticket.worktree = wt;
          } catch { /* best-effort — the spec below still carries it from `ticket` */ }
          const shape = this.resolveSeatShape(team, roleKey, 'ticket', opener);
          await this.create(
            seat.name, shape.type, shape.cwd,
            shape.extraArgs, null,
            shape.workspaceId, null, false, opener.proxy ?? null,
            shape.agents, shape.denyBuiltins,
            shape.disabledTools, shape.disabledSkills,
            shape.injectSkills,
            shape.systemPromptFile,
            shape.appendPromptFiles,
            shape.execCommands,
            shape.intents,
            // Stops at the 20th positional: `noWire` is deliberately NOT threaded
            // from the template here. A ticket seat is one Clodex spawns on the
            // lead's behalf with no operator checkbox behind it, and a template is
            // agent-writable — so honoring it would let a template silently blind
            // the wire that measures what this seat costs. Pinned by t189.
            shape.env, true,
          );
          this._applyTemplatePersistence(seat.name, shape.tpl);
          // FIRST, before anything else that can throw. Between create() and this
          // line the seat is live in a tree no record names, and _ticketTreeHolder
          // reads occupancy off the RECORD — so it is blind to it, and session:kill
          // (which reads entry.worktree to remove the tree) orphans the checkout
          // forever. A throw anywhere in that window used to leave exactly that state.
          claimTree(wt);
          this._sendToSession(seat.name, 'session:context-action', {
            action: 'reattach', name: seat.name, type: (this.sessions.get(seat.name) || {}).agentType || null,
            cwd: team.root, backend: (this.sessions.get(seat.name) || {}).backend || null,
            noWire: !!(this.sessions.get(seat.name) || {}).noWire,
          });
          const d = this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true);
          this._broadcast('ipc-message', {
            type: 'task', from: opener.name, to: seat.name, body: `ticket ${ticket.id} → ${seat.name} @ ${wt.path}`,
          });
          log.info('intent', `ticket ${ticket.id} ${reused ? 'respawned' : 'spawned'} ${seat.name} (${roleKey}) on branch ${wt.branch} @ ${wt.path}`);
          // The env drops ride the reply here too. A silently ignored env key is
          // the bug the allowlist's own comment names, and this path dropped one
          // without a word while the review and spawn paths both announced it.
          const envWarn = (shape.envDropped.length
            ? ` — template env keys [${shape.envDropped.join(', ')}] are outside the allowed set [${[...REVIEWER_ENV_ALLOWLIST].join(', ')}] — dropped (env is an authority surface; requires operator approval)`
            : '')
            + (shape.envBadType.length
              ? ` — template env keys [${shape.envBadType.join(', ')}] are allowed but their values are not strings — dropped (quote the value in the template)`
              : '');
          reply(`ticket ${ticket.id} → ${seat.name} on ${reused ? 'its existing tree, branch' : 'branch'} ${wt.branch}${this._ticketDeliverySuffix(d, seat.name)}${envWarn}`);
        } catch (err) {
          const live = this.sessions.has(seat.name);
          if (!live) getPersistence().remove(seat.name);
          // create() itself can seat the session and THEN throw, so the claimTree
          // above may never have run. A live seat whose record does not name its
          // tree is invisible to _ticketTreeHolder (which reads occupancy off the
          // record) and its checkout is orphaned by session:kill, which reads
          // entry.worktree to know what to remove.
          //
          // The FULL claim, not a bare setWorktree: on the reuse path the tree's
          // previous record still names it, so writing only this seat's pointer
          // leaves two records on one tree — worse than the orphan it fixes. Safe
          // to clear the others here for the same reason as on the success path:
          // `live` means this seat really is in that tree, and the `!live` arm
          // below (which may remove the tree) writes nothing.
          if (live) claimTree(wt);
          // `live` gates the tree removal for the same reason it gates the record
          // drop: create() may have succeeded and a later step thrown, and a seat
          // that exists is sitting in this tree.
          if (wt && !reused && !live) {
            const rm = await gitWorktree.removeWorktree(wt.path).catch(() => ({ ok: false }));
            log.info('worktree', `${rm && rm.ok ? 'removed' : 'ORPHANED'} ${wt.path} after failed ticket spawn of ${seat.name}`);
            // The pointer dies with the tree. Left behind, a later reuse check
            // reads a path that no longer exists and the spec sends a hand there.
            clearTicketTree();
          }
          // Un-pin only when the ticket has NO tree to point at. With one — the
          // reuse path always, and the `live` case below — a role-assigned ticket
          // is matched to every seat filling that role by _openTicketsFor, so the
          // next hand's replay would deliver this ticket's WORK IN: line into a
          // different branch's checkout. A pinned dead assignee is inert by
          // comparison: nothing resolves it, and the next assign re-enters the
          // respawn path.
          //
          // `!live` for the same reason the two branches above carry it: create()
          // may have succeeded and a later step thrown, and then the tree is
          // deliberately KEPT (a live seat is sitting in it) and clearTicketTree()
          // does not run — so un-pinning here would leave a role-assigned ticket
          // still naming an occupied tree, which is the misroute this guards.
          // The tree test is the predicate, not a proxy for it: `!reused && !live`
          // coincides with it on every path a CAUGHT throw takes today, only
          // because clearTicketTree() above runs on exactly that path. A throw
          // reaching here with `wt === null` and a ticket that still names a tree
          // would un-pin one naming a LIVE tree — the misroute this guards. Read
          // the ticket itself instead.
          const unpinned = !reused && !live && !(ticket.worktree && ticket.worktree.path);
          if (unpinned) unpin();
          log.error('intent', `ticket ${ticket.id} seat ${seat.name} failed: ${err.message}`);
          // Branched on the predicate rather than asserting the un-pin happened:
          // it is now skipped in more states than it used to be, and the commonest
          // failure (create() seats, a later step throws) keeps the pin while this
          // line used to say the ticket had gone back to the role.
          reply(unpinned
            ? `ticket ${ticket.id}: seat ${seat.name} failed to spawn (${err.message}) — ticket left assigned to "${roleKey}"`
            : `ticket ${ticket.id}: seat ${seat.name} failed to spawn (${err.message}) — the ticket stays pinned to "${seat.name}", whose tree is kept; re-assign it to retry`);
        }
      });
    }

    _taskAdd(session, team, intent, reply) {
      // Read before the permission check, not after: a non-lead's spec is the longest
      // payload any ticket verb carries, and the check below is the one rejection in
      // the system with no re-send to fall back on.
      const spec = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can open a ticket${this._spillRejectedPayload(session, 'task add', spec)}`); return; }
      if (!spec) { reply('error: a ticket needs spec text — [agent:task add [role|name]] <what to do>'); return; }
      let assignee = null;
      if (intent.who) {
        assignee = this._resolveAssignee(team, intent.who);
        if (!assignee) { reply(`error: ${this._assigneeMissText(team, intent.who)}${this._spillRejectedPayload(session, 'task add', spec)}`); return; }
      }
      const tickets = ticketsStore.load(team.root);
      const now = Date.now();
      // Written only when true: absent is the overwhelming majority and is what
      // every record predating this field carries, so a stored `parked: false`
      // would be a second spelling of the same state for readers to get wrong.
      const parked = !!intent.park;
      const ticket = {
        id: nextTicketId(tickets), title: ticketTitle(spec), spec,
        assignee, opener: session.name, state: 'open',
        openedAt: now, closedAt: null, lastActivityAt: now, nudgedAt: null,
        // Written as an explicit null, against the convention `parked` follows
        // two lines down, and that asymmetry is the point: `ticketStarted` reads
        // an ABSENT key as a pre-upgrade record that the old `add` dispatched.
        // Omitting it here would file every new ticket as already started.
        startedAt: null,
        ...(parked ? { parked: true } : {}),
      };
      const taskDir = extractTaskDir(spec);
      if (taskDir) ticket.taskDir = taskDir;
      tickets.push(ticket);
      ticketsStore.save(team.root, tickets);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: assignee || '(backlog)', body: `ticket ${ticket.id} opened${parked ? ' (parked)' : ''}` });
      log.info('intent', `task add by ${session.name} → ${ticket.id} (${assignee || 'backlog'}${parked ? ', parked' : ''})`);
      // WRITES ONLY. `add` used to mint the seat and deliver the spec itself,
      // which left no seam between "the work is written down" and "the work is
      // running" — and every later loop step has to hang off that seam. Dispatch
      // now lives in `_taskStart` alone; two spawn paths for one job is the
      // defect this split exists to avoid, so do not restore a delivery here.
      if (parked) {
        reply(`ticket ${ticket.id} parked${assignee ? ` for ${assignee}` : ' (backlog)'} — spec NOT delivered; [agent:task start ${ticket.id}] dispatches it`);
        return;
      }
      reply(assignee
        ? `ticket ${ticket.id} → ${assignee} (not started) — [agent:task start ${ticket.id}] mints its tree and seat and delivers the spec`
        : `ticket ${ticket.id} (backlog)`);
    }

    // The dispatch half `add` used to do inline. Split out so there is a seam
    // between writing a ticket and running it: everything downstream (verify,
    // review, auto-reject) keys off the moment work STARTS, and inside `add`
    // that moment was indistinguishable from the write.
    //
    // Deliberately NOT a second `assign`: assign moves a ticket and re-sends a
    // spec to a seat that may already hold one, start is the one-shot that mints.
    // The re-send case is left to assign, and the refusals below name it.
    _taskStart(session, team, intent, reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can start a ticket`); return; }
      if (!intent.id) { reply('error: start needs a ticket id — [agent:task start <id>]'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — only an open ticket can be started`); return; }
      if (!ticket.assignee) { reply(`error: ticket ${intent.id} is backlog (no assignee) — [agent:task assign ${intent.id} <role|name>] files AND dispatches it`); return; }
      const assignee = ticket.assignee;
      // The role the ticket was FILED under, which is what mints the seat name and
      // resolves the worktree opt-in. On an unstarted ticket `assignee` still holds
      // it; `role` is only written once a dispatch path has re-pinned.
      const roleKey = ticket.role || assignee;
      const wtDef = this._ticketWorktreeRole(team, roleKey);
      const minted = wtDef ? this._mintTicketSeat(team, roleKey, ticket) : null;
      // ORDER: the two specific diagnoses below run BEFORE the general
      // already-started refusal, and that is not a style choice. Both of them
      // describe states that only a DISPATCHED ticket can be in — its seat name
      // is taken, its tree is occupied — so with the general check first they
      // become unreachable, and the lead is told "already started, re-send with
      // assign" about a seat that is archived or a tree held by someone else.
      // Both are advice that cannot work. Safe to mint above them: _mintTicketSeat
      // only derives a name and tests whether it is taken; it writes nothing.
      // Taken by THIS ticket's own seat, which means an earlier dispatch's record
      // outlived its session (archived, or a natural exit).
      // Nothing here can fix it, for the same reason as in `assign`:
      // _spawnTicketSeat calls create() directly, so respawning would overwrite a
      // record that still exists and split one name across two sidebar rows.
      // NOT-LIVE is tested here rather than inherited from an earlier refusal:
      // `taken` is true of a live seat too, and this reply tells the lead to
      // Unarchive or Delete Session… — destructive advice about a seat that is
      // in fact running. The occupancy refusal below is the one that owns that
      // case, so the two must not be separated by ordering alone.
      if (minted && minted.taken && minted.name === assignee && !this.sessions.has(assignee)) {
        log.info('intent', `task start by ${session.name}: ${ticket.id} held — seat ${assignee} exists but is not live`);
        reply(`ticket ${ticket.id} is pinned to ${assignee}, whose session exists but is archived or dead — nothing was started. `
          + `Unarchive it from the sidebar (its spec replays on resume), or Delete Session… to release the name and start again — `
          + `that also deletes its worktree, so anything the seat left UNCOMMITTED in ${ticket.worktree && ticket.worktree.path ? ticket.worktree.path : 'that tree'} is lost (committed work survives on the branch).`);
        return;
      }
      // Same occupancy refusal `assign` makes, and above every write below it for
      // the same reason: two agents editing one checkout and committing onto one
      // branch is the collision the whole worktree mechanism exists to prevent.
      if (ticket.worktree && ticket.worktree.path) {
        const dest = (minted && minted.ok) ? minted.name : this._ticketAssigneeSeat(team, ticket);
        const holder = this._ticketTreeHolder(ticket.worktree.path);
        if (holder && holder !== dest) {
          log.info('intent', `task start by ${session.name}: ${ticket.id} refused — tree held by ${holder}`);
          reply(`ticket ${ticket.id}: its worktree is held by ${holder}, which is still live — retire or delete that seat first, then start it. Nothing was changed.`);
          return;
        }
      }
      // The general refusal, last: everything above it is a MORE specific reading
      // of the same "this ticket has already been dispatched" fact, and a lead
      // told only the general one has no way to reach the recovery.
      // Read off the recorded fact, not inferred from the re-pin: `role` is a
      // dispatch-only marker, right for the shapes that re-pin and wrong for the
      // ones that do not, and start is the one-shot so it must answer for all.
      if (ticketStarted(ticket)) {
        // "holds it", not "is held by": the occupancy refusal above owns that
        // phrasing, and the two replies are told apart by it across the suite.
        const holder = this._ticketAssigneeSeat(team, ticket) || assignee;
        reply(`error: ticket ${intent.id} is already started — ${holder} holds it; [agent:task assign ${intent.id} ${ticket.role || assignee}] re-sends the spec to it`);
        return;
      }
      // Start IS the dispatch, so it unparks — parking means "not started yet",
      // and a started ticket left flagged stays exempt from the stall watchdog,
      // which is the one backstop a dead loop step has.
      const wasParked = !!ticket.parked;
      delete ticket.parked;
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;   // dispatch starts a fresh stall episode
      // Stamped above BOTH arms and above every save below, so no path can
      // dispatch without recording that it did — an unstamped dispatched ticket
      // is startable a second time, which is the tree collision this fixes.
      ticket.startedAt = ticket.lastActivityAt;
      const unparked = wasParked ? ' (unparked)' : '';
      if (wtDef && minted.ok) {
        // Re-pinned from the role to the seat BEFORE the save, because
        // _ticketAssigneeSeat resolves a role to the FIRST live seat holding it —
        // leaving it role-assigned would route the NEXT ticket to this one's seat,
        // sitting in the wrong branch's checkout.
        ticket.role = roleKey;
        ticket.assignee = minted.name;
        ticketsStore.save(team.root, tickets);
        this._spawnTicketSeat(session, team, ticket, roleKey, minted);
        this._reconcileTickets(team);
        this._broadcast('ipc-message', { type: 'task', from: session.name, to: minted.name, body: `ticket ${ticket.id} started` });
        log.info('intent', `task start by ${session.name}: ${ticket.id} → seat ${minted.name}, branch ${minted.branch}`);
        reply(`ticket ${ticket.id}${unparked} → spawning ${minted.name} in a worktree on branch ${minted.branch}`);
        return;
      }
      // A mint failure is NOT fatal: the ticket stays role-assigned and takes the
      // ordinary delivery path, which reaches a live seat if one exists and
      // reports "no live seat" if not.
      if (!this._repinTicketToSeat(team, ticket)) delete ticket.role;
      ticketsStore.save(team.root, tickets);
      const d = this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true);
      const suffix = this._ticketDeliverySuffix(d, roleKey);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee, body: `ticket ${ticket.id} started` });
      log.info('intent', `task start by ${session.name}: ${ticket.id} → ${ticket.assignee}${wasParked ? ' (unparked)' : ''}`);
      reply(`ticket ${ticket.id} → ${roleKey}${unparked}${suffix}`);
    }

    _taskAssign(session, team, intent, reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can assign a ticket`); return; }
      if (!intent.id) { reply('error: assign needs a ticket id — [agent:task assign <id> <role|name>]'); return; }
      if (!intent.who) { reply('error: assign needs an assignee — [agent:task assign <id> <role|name>]'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — cannot assign`); return; }
      const assignee = this._resolveAssignee(team, intent.who);
      if (!assignee) { reply(`error: ${this._assigneeMissText(team, intent.who)}`); return; }
      const prev = ticket.assignee;
      // Captured before the re-pin below rewrites it — the reply reports where the
      // ticket came FROM, which is the role it was filed under.
      const prevRole = ticket.role || null;
      // Assign is the OTHER dispatch path, so it mints like _taskAdd: releasing a
      // parked ticket for an opted-in role must still get its own branch, or the
      // documented park-then-release flow silently opts the role out and the hand
      // works in the shared checkout holding a spec written for an isolated tree.
      const wtDef = this._ticketWorktreeRole(team, assignee);
      const minted = wtDef ? this._mintTicketSeat(team, assignee, ticket) : null;
      // The seat name is derived from the ticket id, so "taken" by the ticket's
      // current assignee means the ticket already has its own seat. Whether that
      // seat can be TALKED to is a second question: a record outlives an archive,
      // a natural exit and a non-ephemeral retire, so `taken` alone would send the
      // spec to a name nothing answers for and report "wait for it to spawn" —
      // nothing will. Liveness decides between re-send and the stuck reply below.
      const own = !!(minted && minted.taken && minted.name === prev);
      const ownSeat = (own && this._ticketAssigneeSeat(team, { assignee: prev }) === prev) ? prev : null;
      // BOTH refusals run here, above the reassign notice and above every field
      // this method writes. Below them the ticket has already been mutated and
      // saved, so a refusal there tells the lead "nothing was changed" while the
      // holder has been told to stand down, `parked` has been silently cleared,
      // and `lastActivityAt` has been pushed forward — which defers the one
      // watchdog nudge a stalled ticket gets, once per retry.
      //
      // Occupancy keys off the TICKET's tree, not the destination's role: a
      // destination with no worktree of its own still receives the WORK IN: line
      // of whatever tree this ticket carries, and a non-worktree role, a
      // name-addressed seat, lead and reviewer all reach that delivery. The
      // holder itself is exempt — that is a re-send to the seat already in there.
      if (ticket.worktree && ticket.worktree.path) {
        const dest = ownSeat || (minted && minted.ok ? minted.name : this._ticketAssigneeSeat(team, { assignee }));
        const holder = this._ticketTreeHolder(ticket.worktree.path);
        if (holder && holder !== dest) {
          log.info('intent', `task assign by ${session.name}: ${ticket.id} refused — tree held by ${holder}`);
          reply(`ticket ${ticket.id}: its worktree is held by ${holder}, which is still live — retire or delete that seat first, then re-assign. Nothing was changed.`);
          return;
        }
      }
      // Taken but not live. Nothing here can fix it: the name is held by a record
      // this path must not mint over — _spawnTicketSeat calls create() directly,
      // bypassing the nameConflict front door, so respawning would overwrite the
      // record and split one name across two sidebar rows. The ticket keeps its
      // pin untouched (a pinned dead assignee is inert; a role-assigned one
      // misroutes this ticket's tree) and the reply names the two real exits,
      // because no amount of re-assigning reaches one.
      if (own && !ownSeat) {
        log.info('intent', `task assign by ${session.name}: ${ticket.id} held — seat ${prev} exists but is not live`);
        reply(`ticket ${ticket.id} is still pinned to ${prev}, whose session exists but is archived or dead — nothing was delivered. `
          + `Unarchive it from the sidebar (its spec replays on resume), or Delete Session… to release the name and re-assign — `
          + `that also deletes its worktree, so anything the seat left UNCOMMITTED in ${ticket.worktree && ticket.worktree.path ? ticket.worktree.path : 'that tree'} is lost (committed work survives on the branch).`);
        return;
      }
      // Resolved above the notice below, which would otherwise tell the hand its
      // ticket moved elsewhere when it is only being re-sent.
      const reassigning = !own && prev != null && prev !== assignee;
      if (reassigning) {
        const oldSeat = this._ticketAssigneeSeat(team, { assignee: prev });
        if (oldSeat && oldSeat !== team.lead) {
          this._gatedDeliver(oldSeat, session.name, `[ticket ${ticket.id} reassigned] this ticket moved to ${assignee}`, false);
        }
      }
      ticket.assignee = assignee;
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null; // fresh assignment starts a new stall episode
      // Assign IS the dispatch, so it unparks: the spec goes out two lines below
      // whatever the flag said, and leaving it set would mean a ticket that was
      // delivered yet still invisible to advance, replay and the badge.
      const wasParked = !!ticket.parked;
      delete ticket.parked;
      // Assign is the OTHER dispatch path, so it records the dispatch for the same
      // reason start does — an assigned-but-unstamped ticket is still `start`able,
      // and starting it mints a second seat onto the tree this assign just sent a
      // hand into. Not re-stamped when it is already set: this is the moment work
      // FIRST started, and a re-send must not restate it (§4/§5 measure from it).
      if (!ticketStarted(ticket)) ticket.startedAt = ticket.lastActivityAt;
      // Stay pinned to the live seat. Un-pinning would route the spec, and the
      // WORK IN: line naming this ticket's tree, to whichever seat answers for the
      // role first — another ticket's hand, mid-work in a different branch.
      if (ownSeat) {
        ticket.assignee = ownSeat;
        ticketsStore.save(team.root, tickets);
        const d2 = this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true);
        this._reconcileTickets(team);
        this._broadcast('ipc-message', { type: 'task', from: session.name, to: ownSeat, body: `ticket ${ticket.id} re-sent` });
        log.info('intent', `task assign by ${session.name}: ${ticket.id} re-sent to its own seat ${ownSeat}`);
        reply(`ticket ${ticket.id} → ${ownSeat}${wasParked ? ' (unparked)' : ''} (its own seat, spec re-sent)${this._ticketDeliverySuffix(d2, ownSeat)}`);
        return;
      }
      if (wtDef) {
        if (minted.ok) {
          ticket.role = assignee;
          ticket.assignee = minted.name;
          ticketsStore.save(team.root, tickets);
          this._spawnTicketSeat(session, team, ticket, assignee, minted);
          this._reconcileTickets(team);
          log.info('intent', `task assign by ${session.name}: ${ticket.id} → seat ${minted.name}, branch ${minted.branch}`);
          reply(`ticket ${ticket.id} → spawning ${minted.name} in a worktree on branch ${minted.branch}`);
          return;
        }
      }
      // A stale `role` is cleared on the paths that do NOT re-pin, mirroring the
      // worktree flow's un-pin: the lead has just re-filed this ticket against
      // something else, so a role left from an earlier pin now names a role the
      // ticket is no longer assigned under, and the board would keep rendering it.
      // The two returning paths above are exempt by construction — the own-seat
      // re-send and the mint both keep a pin whose role is still the filed one.
      if (!this._repinTicketToSeat(team, ticket)) delete ticket.role;
      ticketsStore.save(team.root, tickets);
      const d = this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true);
      const suffix = this._ticketDeliverySuffix(d, assignee);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: assignee, body: `ticket ${ticket.id} assigned` });
      log.info('intent', `task assign by ${session.name}: ${ticket.id} ${prev || '(backlog)'}${wasParked ? ' (parked)' : ''} → ${assignee}`);
      const unparked = wasParked ? ' (unparked)' : '';
      // `prevShown` is the role the ticket was filed under, not the seat it was
      // pinned to: every operator-facing string in this system speaks roles, and a
      // seat→role arrow would report a move the lead never made.
      const prevShown = prevRole || prev;
      reply(reassigning ? `ticket ${ticket.id}: ${prevShown} → ${assignee}${unparked}${suffix}` : `ticket ${ticket.id} → ${assignee}${unparked}${suffix}`);
    }

    _taskDone(session, team, intent, reply) {
      // Read above the id check so a malformed command — where no id resolves and
      // there is nothing to attach the report to — still preserves it.
      const report = String(intent.body == null ? '' : intent.body).trim();
      if (!intent.id) { reply(`error: done needs a ticket id — [agent:task done <id>] <report>${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      if (!report) { reply('error: done needs a report — [agent:task done <id>] <what you did>'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      const myRole = matchSeatRole(team, session.name);
      // The degraded pin resolves through `_ticketAssigneeSeat`, so a seat that
      // replaced a dead one under the same role can close what it inherited —
      // and it carries that resolver's `!worktree` gate, which an ad-hoc check
      // here did not: a worktree ticket's closability stays with its own seat,
      // since `_writeTicketCost` counts commits on a branch a sibling never saw.
      const isAssignee = ticket.assignee != null
        && (ticket.assignee === session.name || ticket.assignee === myRole
          || this._ticketAssigneeSeat(team, ticket) === session.name);
      const isLead = team.lead === session.name;
      // Names the ROLE the ticket was filed under, not the delivery-time pin: the
      // pin is an implementation fact about who received it, and a bounce that
      // reports a seat name sends the reader chasing a seat instead of the role
      // they filed against.
      if (!isAssignee && !isLead) { reply(`error: only ticket ${intent.id}'s assignee (${ticket.role || ticket.assignee || 'unassigned'}) or the team lead (${team.lead}) can close it${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      const lead = team.lead;
      if (!isLead) {
        const r = this._gatedDeliver(lead, session.name, `[ticket ${ticket.id} done] ${report}`, false);
        // Spilled like every other rejecting return, and MORE needed here: the others
        // invite an immediate retry, this one tells the sender to wait on an
        // unreachable lead — an interval that can outlive its context or its process.
        // Keeping the ticket open preserves the ticket's state, never the report.
        if (r && r.error) { reply(`error: ${r.error} — report NOT delivered, ticket kept open; re-fire [agent:task done ${ticket.id}] once ${lead} is reachable${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      }
      ticket.state = 'done';
      ticket.closedAt = Date.now();
      ticket.closedBy = session.name;
      // The report is persisted AS WELL AS delivered, never instead of: the
      // delivery above is what reaches the lead, and this is what survives both
      // agents dying. It is also the only place the hand's own flagged guesses
      // and deviations exist in a form the review scope can quote verbatim —
      // a message is losable, and paraphrasing them loses exactly the part a
      // cold reviewer cannot reconstruct.
      ticket.report = report;
      ticket.reportedBy = session.name;
      ticket.lastActivityAt = ticket.closedAt;
      // The loop only runs on a ticket that has its own tree: every check below
      // it (commits on the branch, base still an ancestor, a diff) is a question
      // about a branch, and a ticket worked in the shared checkout has none. Those
      // close exactly as they did before this ticket — `done` stays terminal for
      // them, and no loopStep means the watchdog change below cannot see them.
      //
      // Stamped BEFORE the save, in the same write that closes the ticket: the
      // step is what tells the watchdog this `done` is still in flight, and a
      // process that dies between the close and a later stamp would leave a
      // ticket nothing ever nudges — the one outcome this design must not have.
      const loopEligible = !!(ticket.worktree && ticket.worktree.branch && ticket.worktree.baseSha);
      if (loopEligible) {
        ticket.loopStep = 'verify';
        // Opening an in-flight phase is a NEW stall episode, so it spends a fresh
        // nudge — the same argument `_setLoopStep` makes, and it must be made here
        // too because this is the only stamp site the sweep cannot recover from.
        // After `done`, nothing else clears `nudgedAt`: `_touchTicketActivity`
        // skips any ticket that is not `open`. So a ticket already nudged while
        // open (seat went quiet, watchdog fired, lead closed it for the dead hand
        // — a path this handler explicitly supports) would enter the loop
        // permanently un-nudgeable, and a verify step that then dies is the
        // never-surfaced ticket this design must not have.
        ticket.nudgedAt = null;
      }
      ticketsStore.save(team.root, tickets);
      this._reconcileTickets(team);
      const doneSeat = this._ticketAssigneeSeat(team, ticket);
      const next = doneSeat ? this._advanceSeat(team, doneSeat, ticket.id) : null;
      const nextSuffix = next ? ` — next: ${next.id} delivered to ${doneSeat}` : '';
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: lead, body: `ticket ${ticket.id} done` });
      this._writeTicketCost(team, ticket);
      log.info('intent', `task done ${ticket.id} by ${session.name} → ${lead}`);
      reply((isLead ? `ticket ${ticket.id} closed (done)` : `ticket ${ticket.id} closed (done) — report delivered to ${lead}`) + nextSuffix);
      // Fired AFTER the reply, and deliberately not awaited: this handler is
      // synchronous and the checks shell out to git, so awaiting them here would
      // hold the intent handler open across several subprocesses and delay the
      // hand's own confirmation behind work the hand is not waiting for.
      if (loopEligible) this._runTicketLoop(team, ticket.id);
    }

    // The loop step `task done` opens: verify the tree, then spawn the review.
    //
    // Escalation is the ONLY way out of here that reaches the lead — every
    // failure arm below funnels through _escalateTicket, and a second "tell the
    // lead" path added here would reintroduce the round trip the whole design
    // removes. It tears NOTHING down on any arm: the tree, the branch and the
    // seat are exactly what the lead looks at first.
    async _runTicketLoop(team, ticketId) {
      const fail = (step, evidence, tried) => this._escalateTicket(team, ticketId, step, evidence, tried);
      // Tracks the step the RECORD is actually at, for the catch-all alone: an
      // unexpected throw after the record advanced to `review` would otherwise
      // report `verify`, sending the lead to look at the wrong half of the loop
      // while the ticket says something else. Every named arm passes its own
      // step literal and does not read this.
      let atStep = 'verify';
      try {
        const ticket = this._loadTicket(team, ticketId);
        // Gone or already moved on: another path (cancel, accept, a second done)
        // owns it now, and re-driving a step against a stale snapshot is how two
        // reviewers end up on one ticket.
        if (!ticket || ticket.loopStep !== 'verify') return;
        const wt = ticket.worktree || {};
        const branch = wt.branch;
        const baseSha = wt.baseSha;

        // CHECK 1 — commits on the branch. Zero means the hand worked somewhere
        // nobody can see, and a reviewer would be handed an empty range.
        const commits = await gitWorktree.commitsOnBranch(team.root, branch, baseSha)
          .catch((e) => ({ ok: false, count: null, error: e.message }));
        if (!commits.ok) {
          fail('verify: commits-on-branch', `git could not count commits on ${branch} since ${baseSha}: ${commits.error}`,
            `ran commitsOnBranch(${branch}, ${baseSha})`);
          return;
        }
        if (commits.count === 0) {
          fail('verify: commits-on-branch', `branch ${branch} has 0 commits beyond ${baseSha} — the ticket was closed with nothing committed`,
            `ran commitsOnBranch(${branch}, ${baseSha}); no reviewer spawned`);
          return;
        }

        // CHECK 2 — the base is still an ancestor of the branch. A rebase or a
        // reset under the hand means the tree is not the one the spec was
        // written against, and every line number in the spec is then suspect.
        //
        // ARGUMENTS DELIBERATELY IN THIS ORDER: isMerged(cwd, X, Y) asks
        // "is X an ancestor of Y", so asking whether the BASE is contained in
        // the BRANCH is isMerged(root, baseSha, branch). It reads backwards and
        // it is not — swapping it asks whether the branch is already merged into
        // its own base, which is true only when the hand did nothing.
        const anc = await gitWorktree.isMerged(team.root, baseSha, branch)
          .catch((e) => ({ ok: false, error: e.message }));
        if (!anc.ok) {
          fail('verify: base-is-ancestor', `git could not confirm ${baseSha} is an ancestor of ${branch}: ${anc.error}`,
            `ran isMerged(${baseSha}, ${branch})`);
          return;
        }
        if (!anc.merged) {
          fail('verify: base-is-ancestor', `${baseSha} is NOT an ancestor of ${branch} — the branch was rebased or reset, so it is no longer the tree the spec was written against`,
            `ran isMerged(${baseSha}, ${branch}); no reviewer spawned`);
          return;
        }

        // CHECK 3 — there is somewhere to PUT the diff, asked BEFORE computing
        // one. The same question `_writeTicketDiff` asks below, hoisted: nine
        // measured firings each computed a diff (78625 bytes at the worst) and
        // discarded it on a destination that was already unresolvable when the
        // step began. The check is a string match; the work it guards is a git
        // subprocess over the whole branch.
        //
        // The evidence names the CAUSE, not just the symptom: every one of those
        // firings read as a loop bug, and the fix is a line in the spec.
        //
        // TWO arms, kept apart because they have different causes and different
        // recoveries. A MISSING taskDir is the spec-formatting case; a REFUSED
        // one is `resolveTaskDir` throwing on a path that escapes confinement
        // (`extractTaskDir`'s charset admits `.` and `/`, so `tasks/../../..`
        // extracts fine). Collapsing them onto `.ok` and printing the
        // spec-formatting sentence for both tells the lead something FALSE about
        // the refused path and drops the only description of what was refused.
        const dest = this._ticketDiffDest(team, ticket);
        if (!dest.ok) {
          // `task edit` and "re-run task done" are NOT the recovery and must not
          // be suggested: there is no `edit` verb in the task grammar
          // (intent-registry parseTask), and the ticket is already `done` here,
          // which `_taskDone` refuses. `task reject` is what reopens it.
          const fix = ticket.taskDir
            ? `Fix: correct the path in the ticket's spec so it stays under the projects root.`
            : `Its spec names no \`tasks/…\` path on any line. Fix: \`[agent:task reject ${ticket.id}] <reason>\` to reopen it, then re-file with the artifact dir in the spec.`;
          fail('verify: task-dir', `ticket ${ticket.id} has no usable task dir to write the review diff into (taskDir: ${ticket.taskDir || 'none'}): ${dest.error}. ${fix}`,
            'checked the task dir BEFORE computing a diff; no diff computed, no reviewer spawned');
          return;
        }

        // CHECK 4 — the diff materializes, non-empty. This is also the artifact
        // the reviewer reads, so the check and the deliverable are the same
        // operation: a diff that cannot be written is a review that cannot happen.
        const diff = await gitWorktree.diffText(team.root, baseSha, branch)
          .catch((e) => ({ ok: false, text: null, error: e.message }));
        if (!diff.ok) {
          fail('verify: diff', `git diff --text ${baseSha}..${branch} failed: ${diff.error}`,
            `ran diffText(${baseSha}, ${branch})`);
          return;
        }
        if (!diff.text || !diff.text.trim()) {
          fail('verify: diff', `git diff --text ${baseSha}..${branch} is empty despite ${commits.count} commit(s) on the branch — there is nothing to review`,
            `ran commitsOnBranch (${commits.count}) then diffText, both succeeded`);
          return;
        }

        const written = this._writeTicketDiff(team, ticket, diff.text);
        if (!written.ok) {
          fail('verify: diff', `the diff could not be written for the reviewer to read: ${written.error}`,
            `ran diffText (${diff.text.length} bytes) then tried to write ${written.path || 'the task dir'}`);
          return;
        }

        // CHECK 5 — the suite actually RUNS, on the ticket's branch, and passes.
        //
        // ORDER IS THE POINT, not an implementation detail: a cold review costs
        // ~100k tokens dominated by context acquisition, so paying it for a
        // branch that fails its own suite is the most expensive mistake this
        // loop can make. Suite first; reviewer only on green.
        //
        // Checks 1-4 are tree SHAPE — they prove the work EXISTS. Only an
        // execution proves it WORKS, and only a FULL run catches a blast radius
        // outside the diff: t309 added a key to git-worktree.js and broke
        // plugin-host-engine.test.js, a file its diff never touched. The hand
        // could not have known to run it and the reviewer had no shell, so
        // nothing before this check could have caught it.
        atStep = 'verify: suite';
        const suite = await this._runTicketSuite(team, ticket);
        // Checks 1-3 were milliseconds of git; this await is MINUTES, and the
        // entry guard above is now a snapshot that old. A lead `task accept`
        // landing inside that window deletes loopStep, retires the seat, removes
        // the worktree and deletes the branch — and every arm below would then
        // act on it: _setLoopStep would re-write the hold onto a finished
        // ticket, making it in-flight again so a late verdict can stamp REWORK
        // onto merged, deleted work. A mid-run `task reject` is the twin: a
        // reviewer spawned for a ticket that is already open again. Re-load and
        // bail, the same don't-trust-the-snapshot rule _setLoopStep states.
        const still = this._loadTicket(team, ticketId);
        if (!still || still.loopStep !== 'verify') return;
        if (!suite.ran) {
          // Could not RUN is not the same as failed, and must not reject: the
          // hand cannot fix a lock it does not hold or a runner that would not
          // start, and sending it back with "the suite did not run" is a rework
          // round nobody can close.
          fail('verify: suite', `the test suite could not be run on ${branch}: ${suite.error}`,
            `ran the suite in ${suite.cwd || 'the ticket worktree'}; no reviewer spawned`);
          return;
        }
        if (!suite.green) {
          // BEFORE the reject, which increments `reworkRound` — the file is
          // named for the round that just FAILED, not the one it opens, so the
          // number in the path matches the run the hand is being sent back over.
          // WRAPPED, not merely awaited: `.catch()` cannot catch a synchronous
          // throw, and a preservation failure turning a RED suite into an
          // ESCALATION would mean the hand never gets its rework — the evidence
          // mechanism eating the rejection it exists to serve. The property this
          // ticket ships is that a rejection with no evidence is still a correct
          // rejection, and that has to hold by construction rather than by which
          // git module happens to be injected.
          let kept;
          try {
            kept = await this._writeTicketSuiteFailure(team, still, suite);
          } catch (e) {
            kept = { ok: false, path: null, error: `the preservation threw: ${e && e.message ? e.message : String(e)}` };
            // LOGGED as well as swallowed, and the swallow is the guarantee —
            // do not convert this into a rethrow. The throw's text reaches only
            // the HAND, inside the rejection body: _notifyLeadOfLoopRejection
            // forwards `reason.split('\n')[0]`, which is the suite summary line,
            // never this one. So a SYSTEMIC break (a bad injected gitWorktree, a
            // rename) is invisible to the lead and absent from the record
            // entirely, discoverable only by a hand that happens to read it.
            log.error('ticket', `ticket ${ticketId}: the failing suite output could not be preserved — ${kept.error}`);
          }
          // The freshness snapshot at the top of this arm is now as old as the
          // git subprocesses the write just awaited. Milliseconds, not the
          // minutes the suite took — but this is the mutation the comment above
          // warns about, and a `task accept` landing in the gap would reopen an
          // accepted ticket and bump its rework round. The WRITE is harmless
          // either way (a file beside the ticket's artifacts); the REJECT is not.
          const fresh = this._loadTicket(team, ticketId);
          if (!fresh || fresh.loopStep !== 'verify') return;
          // Named ABSOLUTELY in the message, so the hand needs no convention to
          // find it. A write failure rides the same line rather than being
          // swallowed: a rejection with no evidence is still a correct
          // rejection, but the hand must learn WHY there is nothing to read
          // instead of hunting for a file that was never written — which is this
          // ticket's own bug, one level down.
          const evidence = kept.ok
            ? `FULL OUTPUT (assertion text, diff and stack): ${kept.path}\n`
              + 'Read it instead of re-running the suite.'
            : `The failing output could not be preserved (${kept.error}), so the names above are all there is.`;
          const rejected = this._rejectTicketFromLoop(team, ticketId,
            `the test suite FAILS on your branch — ${suite.summary}\n\n`
            + `FAILING: ${suite.failing || '(the runner reported no test names)'}\n\n`
            + `${evidence}\n\n`
            + 'Fix these and close the ticket again. No reviewer was spawned: a review of a '
            + 'red branch is wasted, and the suite is the gate.');
          // Reject is the designed rework channel, but it needs a seat to reach.
          // With none, the ticket would sit reopened and unread, so the lead
          // gets it instead — the failure is real either way and must surface.
          if (!rejected.ok) {
            fail('verify: suite', `the suite fails on ${branch} (${suite.summary}) and the rework could not be sent back: ${rejected.error}`,
              `ran the suite (exit ${suite.code}); no reviewer spawned; failing: ${suite.failing || 'unnamed'}`
              // The file is written BEFORE the reject is attempted, so it exists
              // on this path too — and this is the arm where the lead is the only
              // remaining reader, the hand having never received anything. Keeping
              // the output and telling nobody is the original defect wearing a
              // different hat.
              // BOTH directions. Naming the file when it exists was round 1;
              // saying so when it does not is the same requirement mirrored,
              // because silence here is indistinguishable from nobody having
              // thought to look — and this is the arm with no other reader.
              + `${kept.ok ? ` Full output preserved at ${kept.path}.` : ` The failing output could not be preserved (${kept.error}).`}`);
          }
          return;
        }

        this._setLoopStep(team, ticketId, 'review');
        atStep = 'review';
        this._spawnTicketReview(team, ticketId, written.path);
      } catch (e) {
        // The catch-all is an escalation, never a swallow: an unexpected throw
        // here leaves a ticket marked in-flight, and the watchdog's one nudge is
        // a worse way to learn about it than being told the exception.
        fail(atStep, `the loop threw: ${e && e.message ? e.message : String(e)}`,
          atStep === 'review' ? 'verify passed and the diff was written; the throw came at or after the review spawn' : 'no reviewer spawned');
      }
    }

    // Run the suite in the ticket's WORKTREE while holding the ROOT checkout's
    // lock. Returns { ran, green, code, summary, failing, output, cwd, error }.
    //
    // `output` is the run's captured text, carried out ONLY when the suite is
    // red, for _writeTicketSuiteFailure to preserve. The reduction to `failing`
    // keeps test NAMES and drops the assertion text, diff and stack — and the
    // loop's rejection reaches only the hand, so the hand is the one party who
    // can diagnose a red gate and the only evidence it had was those names.
    //
    // `ran:false` means the suite never executed (no worktree, no runner, spawn
    // failure, lock never acquired, no summary) — an escalation, never a
    // rejection. `ran:true, green:false` is a real red suite.
    //
    // THE LOCK IS THE SUBTLE PART. Both entry points root it at their own
    // checkout (`scripts/run-tests.js` uses `path.join(__dirname,'..')`), so a
    // worktree runner would take the WORKTREE's lock — a different mutex from
    // the one the lead's run holds. That is not serialization: both runs would
    // reach the port-binding tests together and deadlock at 0% CPU, which is
    // indistinguishable from a slow suite. CLODEX_TEST_LOCK_DIR pins the mutex
    // to the root checkout while the tests still run in the worktree.
    //
    // `runIn` overrides which tree the tests execute in WITHOUT touching the
    // lock, which stays pinned to team.root either way. The post-merge run needs
    // exactly that: it verifies MASTER, in the root checkout, and must still
    // serialize against the loop's worktree runs and the lead's exec grant —
    // three producers on one mutex.
    async _runTicketSuite(team, ticket, runIn = null) {
      const wt = (ticket && ticket.worktree) || {};
      const cwd = runIn ? String(runIn) : (wt.path ? String(wt.path) : null);
      // `runnerPid` is surfaced so a caller probing the root lock can tell OUR
      // runner from a foreign one. On the timeout path the child is SIGKILLed
      // and finish() resolves in the same tick, before it is reaped — and a
      // zombie answers kill(pid, 0), so isAlive reads the corpse as live while
      // its pid is still in the lock dir (a killed runner never runs its exit
      // handler). Without this the revert gate blames a process that no longer
      // exists and tells the lead to wait for a suite that will never finish.
      const out = { ran: false, green: false, code: null, summary: '', failing: '', output: '', cwd, error: null, runnerPid: null };
      if (!cwd) { out.error = 'the ticket has no worktree path to run in'; return out; }

      const runner = path.join(cwd, 'scripts', 'run-tests.js');
      if (!fs.existsSync(runner)) {
        // The worktree's OWN runner, not the root's: it must be the branch's
        // copy so a ticket that changes the runner is verified by the version it
        // ships, and a branch predating the runner is a fact worth escalating
        // rather than papering over with the root's copy.
        out.error = `no test runner at ${runner} — the branch has no scripts/run-tests.js`;
        return out;
      }

      // A git worktree has no node_modules, and nothing installs one. Without
      // this the 7 files requiring electron/node-pty/ws fail MODULE_NOT_FOUND
      // and the loop would reject every ticket for a defect in its own harness.
      // A symlink to the root's tree costs nothing, is gitignored (so it neither
      // dirties the tree nor blocks worktree removal), and is left in place —
      // recreating it per run would race a concurrent read of it.
      const link = path.join(cwd, 'node_modules');
      // EXISTENCE is lstat, VALIDITY is existsSync, and conflating them names
      // the wrong cause: existsSync FOLLOWS the link, so a link whose target is
      // momentarily gone (a root `npm install` mid-flight) reads as absent, the
      // symlinkSync below then fails EEXIST, and the escalation says "could not
      // link node_modules" for a tree that HAS the link and is missing the
      // TARGET. The two states need different sentences because they need
      // different fixes.
      const entry = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
      if (!entry(link)) {
        const src = path.join(team.root, 'node_modules');
        if (!fs.existsSync(src)) {
          out.error = `neither ${link} nor ${src} exists — the suite cannot resolve its dependencies`;
          return out;
        }
        try { fs.symlinkSync(src, link); } catch (e) {
          if (!entry(link)) {   // a concurrent run winning the race is fine
            out.error = `could not link node_modules into the worktree: ${e.message}`;
            return out;
          }
        }
      } else if (!fs.existsSync(link)) {
        out.error = `${link} exists but does not resolve — a dangling link, most likely to a `
          + `${path.join(team.root, 'node_modules')} that was removed or is being reinstalled`;
        return out;
      }

      // A branch that CHANGES package.json's dependencies cannot be verified
      // against the root's installed tree, and the failure is silent in both
      // directions: an ADDED dep is MODULE_NOT_FOUND (a red suite the hand
      // cannot fix by editing code — the reject arm sends it back to rewrite
      // correct work), while a REMOVED or RE-RANGED one still resolves out of
      // the root's node_modules and the suite goes GREEN over a dependency set
      // the branch does not declare. The second is the dangerous one.
      //
      // So ESCALATE on any difference rather than reject: the resolution is an
      // `npm install` in the SHARED root checkout, which is the lead's call and
      // outside what a hand can do from inside its worktree.
      // NOT named `deps`: that is createSessionManager's own injected dependency
      // object, and shadowing it here would silently cut this method off from
      // every seam the factory provides the moment someone reaches for one.
      const readDeps = (pkgPath) => {
        try {
          const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          return { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.optionalDependencies || {}) };
        } catch { return null; }
      };
      const wantDeps = readDeps(path.join(cwd, 'package.json'));
      const haveDeps = readDeps(path.join(team.root, 'package.json'));
      // Only when BOTH parsed: an unreadable package.json is a different fault,
      // and escalating every ticket in a repo that has none would be worse than
      // the hole this closes.
      if (wantDeps && haveDeps) {
        const diffs = [];
        for (const [name, range] of Object.entries(wantDeps)) {
          if (!(name in haveDeps)) diffs.push(`+${name}@${range} (added by the branch)`);
          else if (haveDeps[name] !== range) diffs.push(`~${name}: root has ${haveDeps[name]}, branch wants ${range}`);
        }
        for (const name of Object.keys(haveDeps)) {
          if (!(name in wantDeps)) diffs.push(`-${name} (dropped by the branch)`);
        }
        if (diffs.length) {
          out.error = 'the branch changes package.json dependencies, but the suite runs against the ROOT checkout\'s '
            + `installed node_modules (linked at ${link}), so it would verify the wrong dependency set: `
            + `${diffs.slice(0, 10).join('; ')}${diffs.length > 10 ? ` (+${diffs.length - 10} more)` : ''}`
            + ' — install them in the root checkout and re-run, rather than sending this back to the implementer';
          return out;
        }
      }

      const res = await new Promise((resolve) => {
        let child;
        try {
          child = childProcess.spawn(process.execPath, [runner, '--reporter=dot'], {
            cwd,
            env: {
              ...process.env,
              // `process.execPath` under the desktop app is the ELECTRON
              // binary, not node (measured: .../Electron.app/Contents/MacOS/
              // Electron), and engine.js is hosted by main.js as well as
              // headless-main.js. Without this the spawn is an app launch, the
              // runner's own re-spawn of process.execPath is not a node --test
              // invocation, no tap is written, and EVERY ticket escalates with
              // "the tap stream is missing". Same idiom as cli-hooks.js's
              // INTERP; plain node ignores the variable, so this is a no-op
              // under the headless host and in tests.
              //
              // Consequence worth stating: the suite then runs under ELECTRON'S
              // node (24.17.0 at Electron 43), not the system node the lead's
              // `npm test` uses (25.8.1). That is a real difference — the
              // blake2b512 lesson in scripts/electron-smoke.js is exactly a
              // behaviour that split between the two runtimes — so a green here
              // is a green under the runtime the app itself ships.
              ELECTRON_RUN_AS_NODE: '1',
              CLODEX_TEST_LOCK_DIR: path.join(team.root, '.test-digest.lock'),
              // WAIT, never refuse: a second ticket closing during a run must
              // QUEUE. Refusing would report "could not run" and escalate a
              // ticket whose only sin was closing at a busy moment, and skipping
              // the check outright is the false green this exists to prevent.
              CLODEX_TEST_LOCK_WAIT_MS: String(TICKET_SUITE_LOCK_WAIT_MS),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            // Its OWN process group, so the timeout can kill the whole tree.
            // This child's entire job is to have grandchildren: it blocks in
            // spawnSync running `node --test`, which starts a file per test.
            // Killing the runner alone leaves that sweep alive and reparented,
            // still binding the real ports cli/test/attach.test.js uses — and
            // the killed runner never ran its exit handler, so it left a lock
            // dir naming a dead pid that the NEXT gate run legitimately
            // reclaims. That run then reaches the ports alongside the orphan
            // and deadlocks at 0% CPU, which is the wedge the whole mutex
            // exists to prevent, self-inflicted and invisible in the
            // escalation text.
            detached: true,
          });
        } catch (e) { resolve({ error: `spawn failed: ${e.message}` }); return; }
        // Recorded on the OUTER object, not the resolved value: the timeout arm
        // resolves a shape that carries only an error, and the pid is needed on
        // exactly that path.
        out.runnerPid = child.pid > 0 ? child.pid : null;

        // Bounded and drained. The output is read to keep the pipes from filling
        // (a full pipe blocks the child forever, which the timeout would then
        // report as a wedge), but only the TAIL is kept: a dot-reporter run of
        // this suite is small, and the summary this parses is at the end.
        let stdout = '';
        let stderr = '';
        let done = false;
        const cap = (s, add) => (s + add).slice(-64 * 1024);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
        child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
        const finish = (v) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          // Detach the drains. A group kill that misses something leaves a
          // writer on these pipes, and every byte it sends would keep appending
          // to strings this closure holds long after the result was resolved.
          // resume() keeps the stream in flowing-discard mode once the last
          // consumer is gone, so a writer that survived the group kill cannot
          // back up on the pipe and block holding the root lock.
          try { child.stdout.removeAllListeners('data'); child.stdout.resume(); } catch {}
          try { child.stderr.removeAllListeners('data'); child.stderr.resume(); } catch {}
          resolve(v);
        };
        const timer = setTimeout(() => {
          // The GROUP, via the negative pid — `child.kill()` signals only the
          // group leader, which is the runner blocked in spawnSync, not the
          // sweep underneath it. session-manager.js's exec path records that
          // distinction and then chooses a plain child on the grounds that "v1
          // commands have no grandchildren"; that reasoning does not reach here,
          // where grandchildren are the point. Falls back to the plain kill so a
          // platform or a fake child without a real pid still gets signalled.
          // `> 0` is load-bearing, not defensive noise: kill(-0) signals OUR
          // OWN process group — the whole app — and childProcess is an injected
          // seam, so a stubbed child's pid shape is not guaranteed to be a real
          // pid. cli/src/dial.js guards the identical call the same way.
          if (child.pid > 0) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {
              try { child.kill('SIGKILL'); } catch {}
            }
          } else {
            try { child.kill('SIGKILL'); } catch {}
          }
          finish({ error: `the suite did not finish within ${TICKET_SUITE_TIMEOUT}ms (killed)`, stdout, stderr });
        }, TICKET_SUITE_TIMEOUT);
        child.on('error', (e) => finish({ error: `the runner could not start: ${e.message}`, stdout, stderr }));
        child.on('close', (code) => finish({ code, stdout, stderr }));
      });

      const text = `${res.stdout || ''}\n${res.stderr || ''}`;
      // The capture rides the UNRAN arms too, not the red one alone. A post-merge
      // run that crashed or timed out REVERTS master exactly as a red one does,
      // so its output is unreproducible for the same reason — and without this
      // the whole account of it is a 300-char last line. Kept raw for
      // _writeTicketSuiteFailure to judge: an empty capture is refused there, so
      // a spawn failure (which resolves carrying no streams at all) still
      // preserves nothing rather than writing a confidently empty artifact.
      //
      // Not hoisted above the green check below: a green run's output is noise
      // nobody reads, and holding a 64KB string on every passing ticket is a
      // cost with no reader.
      if (res.error) { out.error = res.error; out.output = text; return out; }
      out.code = res.code;

      // The runner's own TOTALS line is the only evidence the run COMPLETED.
      // Exit 0 alone is not: the runner exits non-zero on a refused lock, a
      // missing path and an empty tap, and every one of those is "never ran".
      // Requiring the line is what stops a false green from a run that produced
      // nothing — the exact defect class this whole ticket is about.
      // STDOUT ONLY, and the LAST match in it. The runner prints its summary to
      // stdout, last. Searching the combined text instead puts ALL of stderr
      // after ALL of stdout regardless of when either was written, so any
      // TOTALS-shaped line a test file writes to stderr would always beat the
      // real summary — including a green decoy over a red run, which is the
      // shadowing this guards, one stream over.
      const all = [...String(res.stdout || '').matchAll(/TOTALS: (\d+) pass, (\d+) fail, (\d+) tests/g)];
      const totals = all.length ? all[all.length - 1] : null;
      if (!totals) {
        const last = text.trim().split('\n').filter((l) => l.trim()).pop() || '(no output)';
        out.error = `the runner produced no TOTALS summary (exit ${res.code}) — last line: ${last.slice(0, 300)}`;
        out.output = text;
        return out;
      }
      const [, pass, failed, tests] = totals;
      // A sweep that discovered no test files prints `0 pass, 0 fail, 0 tests`
      // and exits 0, satisfying every other green condition. That is a run which
      // verified NOTHING reaching a reviewer — the one outcome this check
      // exists to prevent. It escalates rather than rejects: the hand cannot fix
      // a suite that found no tests to run.
      if (Number(tests) === 0) {
        out.error = `the runner executed ZERO tests (exit ${res.code}) — a run that verified nothing `
          + 'cannot stand in for a green suite';
        return out;
      }
      out.ran = true;
      out.summary = `${pass}/${tests} passing, ${failed} failing (exit ${res.code})`;
      // Green is the CONJUNCTION, deliberately: `fail 0` alone misses an escape
      // (an error on an async continuation that outlives its test is counted a
      // PASS and only the exit code is honest), and exit 0 alone would trust a
      // reporter that never counted. Either one disagreeing means not green.
      out.green = res.code === 0 && Number(failed) === 0;
      if (!out.green) {
        // The `✖ name (1.23ms)` shape, which is what the DOT reporter prints in
        // its "Failed tests:" block — NOT tap's `not ok N - name`. The runner
        // sends tap to a temp file it consumes itself, so no tap ever reaches
        // this stdout and a `not ok` parser silently yields no names at all.
        // Measured against the real runner on a real failing branch, which is
        // the only reason this is right: a stub reproducing the tap shape would
        // have pinned the wrong contract and every real rejection would have
        // named nothing.
        const names = [];
        for (const line of text.split('\n')) {
          const m = /^ *✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(line);
          // The trailing summary repeats each failure, so the same name arrives
          // twice; the hand should see a list of distinct tests, not doubles.
          if (m && !names.includes(m[1].trim())) names.push(m[1].trim());
        }
        out.failing = names.slice(0, 20).join('; ').slice(0, 1000);
        // The RED arm only. A green run's output is noise nobody reads, and
        // carrying it would hold a 64KB string on every passing ticket.
        out.output = text;
        if (!out.failing) {
          const esc = /ESCAPES: (?!0)(.*)/.exec(text);
          if (esc) out.failing = `escaped errors — ${esc[1].trim().slice(0, 500)}`;
        }
      }
      return out;
    }

    // Reject a ticket back to its seat from inside the loop.
    //
    // NOT `_taskReject`: that one is an intent handler — it is lead-only, needs a
    // calling session and a `reply`, and the loop has neither. The STATE
    // TRANSITION is deliberately identical to it, because a ticket reopened by
    // the loop and one reopened by the lead must be indistinguishable to every
    // reader downstream; if that handler's transition changes, this must follow.
    _rejectTicketFromLoop(team, ticketId, reason) {
      try {
        const tickets = ticketsStore.load(team.root);
        const ticket = tickets.find((t) => t.id === ticketId);
        if (!ticket) return { ok: false, error: `ticket ${ticketId} is gone` };
        const seat = this._ticketAssigneeSeat(team, ticket);
        // Resolved BEFORE the write: with no seat to receive it the ticket must
        // stay done for the lead to escalate on, not sit reopened and unread.
        if (!seat || seat === team.lead) {
          return { ok: false, error: `no live seat holds ${ticket.role || ticket.assignee || 'the ticket'} to send the rework to` };
        }
        ticket.state = 'open';
        ticket.closedAt = null;
        ticket.closedBy = null;
        ticket.lastActivityAt = Date.now();
        ticket.nudgedAt = null;
        // Written here for the reason the header gives: _taskReject's guard reads
        // it to tell a rejection-reopened ticket from one that never closed, and a
        // marker set in only one of the two transitions would make that answer
        // depend on WHO rejected — the asymmetry this pair exists to prevent.
        ticket.reworkRound = (Number(ticket.reworkRound) || 0) + 1;
        delete ticket.loopStep;
        ticketsStore.save(team.root, tickets);
        // Rework needs the verb as much as a first dispatch: the seat closes a
        // SECOND time, and without it here that close depends on the seeded role
        // prompt — the stale-file dependency this whole line exists to remove from
        // the dispatch path. The reason text pushes this well past the spill
        // threshold, so the tag carries the verb too.
        const r = this._gatedDeliver(seat, 'ticket-loop', `[ticket ${ticket.id} rejected] ${ticketCloseLine(ticket.id)}${reason}`, true,
          `[ticket ${ticket.id} rejected] close with ${ticketCloseVerb(ticket.id)}`);
        this._reconcileTickets(team);
        this._broadcast('ipc-message', { type: 'task', from: 'ticket-loop', to: ticket.assignee || seat, body: `ticket ${ticket.id} rejected: suite red` });
        log.info('intent', `ticket ${ticket.id} rejected by the loop (suite red) → ${seat}`);
        // Undelivered is still reopened: the board is correct and the watchdog
        // sees an open ticket, which is recoverable. Reporting it lets the caller
        // escalate so the lead learns the hand was never told.
        if (!(r && (r.queued || r.parked))) {
          return { ok: false, error: `the ticket was reopened but the rework message did not reach ${seat} (${(r && (r.error || r.held)) || 'unknown delivery failure'})` };
        }
        // The DELIVERED arm only. The undelivered one above returns an error the
        // call site already escalates on, and firing both would report one
        // rejection to the lead twice, by two channels, as two events.
        this._notifyLeadOfLoopRejection(team, ticket, seat, reason);
        return { ok: true, error: null, seat };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    // The lead's copy of a LOOP REJECTION. Without it the well-behaved case —
    // suite red, hand alive, rework delivered — is silent to the lead by
    // construction: the only other lead-facing signal on this path is the call
    // site's escalation, which fires exactly when delivery FAILED. A lead cannot
    // adjudicate a rejection it never sees, and "the hand is quietly on round 3"
    // is the state it is supposed to be watching for.
    //
    // Shaped after _notifyLeadOfVerdict and for the same reasons: SUMMARY, never
    // the suite dump — which ticket, which seat, how many rounds deep, and one
    // line of why is what the lead acts on, and the failing test names are
    // already on the record and in the hand's own copy. Non-urgent, because the
    // reopen is durable before this runs, so a hold or a park is an acceptable
    // outcome. Wrapped, and called AFTER the save: a throw here must never
    // unwind the rejection. Ordering is the invariant; do not hoist it.
    _notifyLeadOfLoopRejection(team, ticket, seat, reason) {
      try {
        if (!team.lead) return;
        const round = Number(ticket.reworkRound) || 1;
        // The reason opens with the one-line summary the loop composed; the rest
        // is the failing-test dump, which is deliberately not forwarded.
        const firstLine = String(reason || '').split('\n')[0].trim().slice(0, 300);
        const body = [
          `[ticket ${ticket.id} REJECTED by the loop] sent back to ${seat} for rework (round ${round}).`,
          '',
          `WHY: ${firstLine || 'the test suite failed on the branch'}`,
          '',
          'The rework reached the seat and the ticket is open again; the failing test names are on'
          + ' the record and in the seat\'s copy. Nothing was torn down — the worktree, the branch'
          + ' and the seat are exactly as they were.',
        ].join('\n');
        const r = this._gatedDeliver(team.lead, 'ticket-loop', body, false, `[ticket ${ticket.id} REJECTED] round ${round} → ${seat}`);
        if (r && r.error) {
          log.warn('intent', `ticket ${ticket.id} rejected to ${seat} but lead ${team.lead} not notified — ${r.error}`);
        }
      } catch (e) {
        log.error('intent', `ticket ${ticket.id}: rejection landed but lead notification failed: ${e.message}`);
      }
    }

    // A lead `task reject` on a ticket a rejection ALREADY reopened. Not a
    // reopen: the close was undone once already and every write reject makes
    // would be a no-op here, so this only delivers the new must-fixes to the seat
    // that is holding the rework right now.
    //
    // It deliberately bumps NOTHING that implies a fresh review round —
    // `reworkRound` counts transitions into open, and no transition happens here.
    // `lastActivityAt`/`nudgedAt` ARE stamped, but only once the follow-up is
    // actually away: the stamps say "this seat was handed work just now", and
    // writing them ahead of a delivery that then fails resets the stall episode
    // over a message nobody received — the watchdog would then wait a full window
    // before nudging about a seat that was never told anything.
    //
    // With no live seat this must FAIL LOUDLY rather than reply success — same
    // reasoning as the loop's own pre-write seat check: rework nobody receives
    // must never read as delivered.
    _taskRejectFollowUp(session, team, tickets, ticket, reason, reply) {
      const seat = this._ticketAssigneeSeat(team, ticket);
      // Its own arm, because on a SOLO board `_soloContext` makes the lead its own
      // team lead, so a self-held ticket lands here with a seat that resolved fine.
      // Folding it into the no-seat arm below tells the operator no live seat holds
      // the role when one demonstrably does — their own.
      if (seat && seat === team.lead) {
        reply(`error: ${ticket.id} is already open for rework and ${seat} is holding it — `
          + 'a follow-up to yourself is not delivered; the must-fixes are yours to act on'
          + `${this._spillRejectedPayload(session, 'task reject', reason)}`);
        return;
      }
      if (!seat) {
        reply(`error: ${ticket.id} is already open for rework, but no live seat holds `
          + `${ticket.role || ticket.assignee || 'the ticket'} to send the follow-up to`
          + `${this._spillRejectedPayload(session, 'task reject', reason)}`);
        return;
      }
      const r = this._gatedDeliver(seat, session.name, `[ticket ${ticket.id} more must-fixes] ${ticketCloseLine(ticket.id)}${reason}`, true,
        `[ticket ${ticket.id} more must-fixes] close with ${ticketCloseVerb(ticket.id)}`);
      if (!(r && (r.queued || r.parked))) {
        reply(`error: ${ticket.id} is already open for rework and the follow-up did NOT reach ${seat} `
          + `(${(r && (r.error || r.held)) || 'unknown delivery failure'})`
          + `${this._spillRejectedPayload(session, 'task reject', reason)}`);
        return;
      }
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;
      ticketsStore.save(team.root, tickets);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || seat, body: `ticket ${ticket.id} follow-up must-fixes` });
      log.info('intent', `task reject ${ticket.id} by ${session.name} → follow-up to ${seat} (already open for rework)`);
      reply(`ticket ${ticket.id} was already open for rework (round ${Number(ticket.reworkRound) || 1}) — `
        + `your must-fixes were delivered to ${seat} as a follow-up, not as a new reopen`);
    }

    _loadTicket(team, ticketId) {
      try {
        const tickets = ticketsStore.load(team.root);
        return tickets.find((t) => t.id === ticketId) || null;
      } catch { return null; }
    }

    // Re-load, mutate, save — never a mutation of a caller's snapshot. The loop
    // awaits git between reads, which is a wide enough window for another writer
    // (a verdict, a cancel) to land in, and saving a stale array would silently
    // revert it.
    _setLoopStep(team, ticketId, step) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (step) rec.loopStep = step; else delete rec.loopStep;
        rec.lastActivityAt = Date.now();
        // Advancing a step IS progress, so it ends the stall episode: without
        // this a slow but healthy loop spends its one nudge while working.
        rec.nudgedAt = null;
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `loopStep ${step} for ${ticketId} failed: ${e.message}`);
      }
    }

    // Where a ticket's review diff would go, WITHOUT writing anything — the
    // question the loop asks before computing a diff and the one the write asks
    // again. One function so the cheap pre-check cannot answer differently from
    // the write it guards: two copies of this rule would let the loop clear a
    // destination that then refuses the diff, which is the waste it exists to
    // prevent.
    //
    // The taskDir is RESOLVED through the same confinement _writeTicketCost uses
    // and for the same reason: it is spec TEXT, an agent wrote it, and a `~` or a
    // `..` in it would otherwise be joined into a path outside the projects root.
    _ticketDiffDest(team, ticket) {
      let taskDir = null;
      try {
        taskDir = teamCost.resolveTaskDir({
          taskDir: ticket.taskDir,
          projectDir: projectDirFor(REGISTRY_DIR, team.root),
          projectsRoot: path.join(REGISTRY_DIR, 'projects'),
          homedir: os.homedir(),
        });
      } catch (e) {
        return { ok: false, dir: null, error: `task dir refused: ${e.message}` };
      }
      if (!taskDir) {
        return { ok: false, dir: null, error: `ticket ${ticket.id} has no resolvable task dir to write the diff into (taskDir: ${ticket.taskDir || 'none'})` };
      }
      return { ok: true, dir: taskDir, error: null };
    }

    // The failing suite run's OUTPUT, preserved beside the ticket's other
    // artifacts. scripts/test-digest.sh does this for the lead's exec grant
    // (`save_failing_output`); this is the same guarantee for the loop's run,
    // which reaches the script not at all — it spawns the BRANCH's
    // scripts/run-tests.js, deliberately, so nothing in the digest runs.
    //
    // PER TICKET AND ROUND, not the digest's one shared
    // `~/.clodex/test-failures/last.txt`. That file has exactly one writer
    // today; the loop would be a second, and an UNATTENDED one — it fires on
    // ticket close, so two tickets closing minutes apart overwrite each other
    // and a hand reads another ticket's failure as its own. Wrong evidence is
    // worse than none, because it is acted on. A per-round name also keeps
    // round 1's evidence alive through round 2, the same reason _writeTicketDiff
    // puts the round in ITS name.
    //
    // Resolved through _ticketDiffDest, so the confinement that guards the diff
    // guards this too: `taskDir` is spec TEXT an agent wrote, and a `~` or `..`
    // in it would otherwise join into a path outside the projects root.
    async _writeTicketSuiteFailure(team, ticket, suite) {
      const dest = this._ticketDiffDest(team, ticket);
      if (!dest.ok) return { ok: false, path: null, error: dest.error };
      const body = String((suite && suite.output) || '').trim();
      // An empty capture is reported, never written: a file that exists and says
      // nothing reads as "the runner said nothing", which is the confidently
      // empty artifact t363's own raw-fallback arm exists to avoid.
      if (!body) return { ok: false, path: null, error: 'the run produced no captured output to preserve' };
      const round = (Number(ticket.reworkRound) || 0) + 1;
      // The STAMP is what makes the name unique, not the round. `reworkRound`
      // does not move on a REVIEW round, so a ticket re-reviewed and re-merged
      // computes the same round twice and a second red post-merge run would
      // overwrite the first — the overwrite hazard the per-round name exists to
      // prevent, reachable through the one dimension the round does not count.
      // A stamp rather than a merge-attempt counter: this writer serves the
      // verify path too, where a merge counter means nothing, and it needs no
      // new persisted field whose bump ordering could be got wrong. It also
      // covers every repeat dimension at once (review round, re-merge, a retry
      // inside one round), sorts chronologically, and agrees with the `# when:`
      // line already in the file.
      //
      // The stamp's resolution is milliseconds, so it is a discriminator and not
      // a guarantee; the existence check is what closes the name. Leaving it out
      // would put the whole mechanism back on "two runs of one ticket cannot
      // land in the same millisecond", which is true of real suite runs (they
      // take minutes) and not true of anything else that calls this.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stem = path.join(dest.dir, `suite-failure-${ticket.id}-r${round}-${stamp}`);
      let file = `${stem}.txt`;
      for (let n = 2; n < 100 && fs.existsSync(file); n++) file = `${stem}-${n}.txt`;
      // The COMMIT, not just the branch name. Two rounds of one ticket differ
      // only by timestamp otherwise, yet the branch MOVED between them and that
      // movement is the entire content of a round — a hand comparing r1 to r2
      // could not tell which tree each measured. Read from the worktree that
      // actually ran (test-digest.sh's `# head:` does the same with rev-parse),
      // and degraded to the branch name alone rather than failing the write: a
      // preserved dump with a vaguer header beats no dump.
      const head = await gitWorktree.currentBranch((suite && suite.cwd) || '')
        .catch(() => null);
      // `ok:true` with a NULL head is reachable — currentBranch tolerates a
      // failed `rev-parse HEAD` (git-worktree.js) — and interpolating it yields
      // `# head:  tl-1 `, a line that claims a commit and carries none. The sha
      // is the half a reader cannot reconstruct, so its absence has to be said,
      // not left as a trailing space.
      const headSha = head && head.ok ? String(head.head || '').slice(0, 12) : '';
      const headLine = head && head.ok && headSha
        ? `${head.branch} ${headSha}`
        : `${(head && head.branch) || (ticket.worktree && ticket.worktree.branch) || 'unknown'} (commit unresolved)`;
      const header = [
        `# clodex ticket loop — preserved output of the FAILING suite run for ${ticket.id}.`,
        `# tree:  ${(suite && suite.cwd) || 'unknown'}`,
        `# head:  ${headLine}`,
        `# when:  ${new Date().toISOString()}`,
        `# count: ${(suite && suite.summary) || 'unknown'}`,
        '',
      ].join('\n');
      // WRITTEN ASIDE AND RENAMED, so a truncated dump at the published path is
      // impossible rather than cleaned up afterwards. ENOSPC or a kill mid-write
      // leaves writeFileSync having produced a PARTIAL file, and a dump that
      // stops mid-stack reads as complete — the hand then diagnoses off evidence
      // missing the part it needed, which is worse than no file because it gets
      // acted on. Writing straight to `file` and unlinking on failure closed
      // that by cleanup, which has its own failure mode (the unlink can fail);
      // the rename closes it by construction, so `ok:false` means "nothing is at
      // that path" for every call site with nothing left to check.
      //
      // A rename onto a full disk still succeeds — it writes no data — so the
      // ENOSPC that killed the write cannot resurface here and publish a partial
      // file. The tmp is removed best-effort and its failure is not reported:
      // a leftover `.tmp` is litter beside the artifacts, not something a reader
      // can mistake for this run's output.
      const tmp = `${file}.tmp`;
      try {
        ensureDir(dest.dir);
        fs.writeFileSync(tmp, `${header}${body}\n`);
        fs.renameSync(tmp, file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        return { ok: false, path: null, error: e.message };
      }
      return { ok: true, path: file, error: null };
    }

    // The materialized diff, written beside the ticket's other artifacts.
    _writeTicketDiff(team, ticket, text) {
      const dest = this._ticketDiffDest(team, ticket);
      if (!dest.ok) return { ok: false, path: null, error: dest.error };
      const taskDir = dest.dir;
      // The round is in the NAME so round 2 does not overwrite round 1: round 1's
      // diff is the one artifact a round 2 reviewer might want to diff against,
      // and it is unrecoverable once the branch moves on.
      const round = (Number(ticket.reviewRound) || 0) + 1;
      const file = path.join(taskDir, `review-${ticket.id}-r${round}.diff`);
      try {
        ensureDir(taskDir);
        fs.writeFileSync(file, text);
      } catch (e) {
        return { ok: false, path: file, error: e.message };
      }
      return { ok: true, path: file, error: null };
    }

    // Spawn the loop's reviewer through the EXISTING team-review path, with the
    // constructed scope as its body. Not a hand-rolled spawn: that path already
    // owns the reviewer template, the tool cap, the name reservation and the
    // reviewTicket seed that routes the verdict back to the ticket.
    _spawnTicketReview(team, ticketId, diffPath) {
      const ticket = this._loadTicket(team, ticketId);
      if (!ticket) return;
      // _handleTeamReview is lead-gated and replies into the CALLING session, so
      // it must be called as the lead. A lead that is not live is a genuine
      // blocker for this step — there is no session to spawn from.
      const leadSession = this.sessions.get(team.lead);
      if (!leadSession) {
        this._escalateTicket(team, ticketId, 'review: spawn',
          `the team lead ${team.lead} has no live session to spawn a reviewer from`,
          'verify passed and the diff was written; no reviewer spawned');
        return;
      }
      const scope = buildReviewScope({ ticket, diffPath });
      // onReply diverts _handleTeamReview's reply away from the lead's terminal.
      // Diverted, NOT suppressed: that reply is also how every spawn refusal
      // (a broken reviewer template, an empty tool intersection) is reported, and
      // swallowing it would turn a failed spawn into a ticket that is marked
      // under review with no reviewer — silence in exactly the case that needs a
      // human. Errors become escalations; a success is logged.
      this._handleTeamReview(leadSession, scope, {
        ticketId,
        onReply: (msg) => {
          const m = String(msg == null ? '' : msg);
          // An UNBRIEFED reviewer is a review that will not happen: the seat
          // spawns and boots without its role prompt, so it does not know the
          // verdict grammar or that it must emit one. That arrives on the SUCCESS
          // reply, so it needs its own test — the error branch below never sees
          // it, and a log line about it reaches nobody who can install the prompt.
          if (/boots UNBRIEFED/.test(m)) {
            // keepHold: the seat DID spawn and still carries reviewTicket. An
            // unbriefed reviewer may never emit a verdict — but if it does, the
            // hold is what lets that verdict land on the ticket instead of
            // falling through to the lead as raw text.
            this._escalateTicket(team, ticketId, 'review: spawn', m,
              'verify passed, the diff was written and a reviewer seat WAS spawned — but without its role prompt it may never emit a verdict',
              { keepHold: true });
            return;
          }
          if (/^error:/i.test(m)) {
            this._escalateTicket(team, ticketId, 'review: spawn', m,
              'verify passed and the diff was written; the reviewer spawn was refused');
            return;
          }
          log.info('intent', `ticket ${ticketId} review spawned: ${m}`);
        },
      });
    }

    // The one channel out of the loop to the lead.
    //
    // Tears nothing down, by design: the tree, the branch and the seat stay
    // exactly as they are, because the lead's first act on an escalation is to
    // look at them.
    //
    // ORDER IS LOAD-BEARING: deliver FIRST, and clear `loopStep` only once the
    // delivery is durable. Clearing it first drops the ticket out of the sweep's
    // in-flight test, so an escalation the lead never received leaves a ticket
    // nobody is ever told about — no reviewer was spawned, no nudge can fire, and
    // the only trace is a log line. `_gatedDeliver` fails in two reachable ways:
    // `{error}` when the lead has no live session, and `{held}` with NO park when
    // the hold verdict lands on a target that cannot park (a codex lead, or one
    // `_dead` mid-restart). A park IS durable — it is a written file the seat
    // drains — so `parked` counts as reached and `held` does not.
    //
    // On failure the hold STAYS, which is what hands the ticket to the watchdog:
    // it re-surfaces once the lead is reachable, which is the whole point of §E.
    //
    // `keepHold` is for the arms that escalate while a REVIEWER SEAT IS STILL
    // LIVE and still carries `reviewTicket`. Releasing the hold there looks
    // right — the lead was told — but it makes the ticket not-in-flight, and a
    // verdict that seat emits afterwards then fails `_landVerdictOnTicket`'s
    // guard: nothing is written to `verdict`/`mustFix`, `reviewRound` stays 0,
    // and a later round 2 announces itself as round 1. The loop legitimately
    // still holds a ticket whose reviewer has not answered yet.
    _escalateTicket(team, ticketId, step, evidence, tried, { keepHold = false } = {}) {
      try {
        const body = [
          `[ticket ${ticketId} ESCALATED] the loop stopped at: ${step}`,
          '',
          `EVIDENCE: ${evidence}`,
          `ALREADY TRIED: ${tried}`,
          '',
          'Nothing was torn down — the worktree, the branch and the seat are exactly as they were.',
        ].join('\n');
        const r = this._gatedDeliver(team.lead, 'ticket-loop', body, false, `[ticket ${ticketId} ESCALATED]`);
        const reached = !!(r && (r.queued || r.parked));
        // Two independent reasons to keep the hold, deliberately not collapsed
        // into one branch: an undelivered escalation keeps it so the watchdog
        // re-surfaces the ticket, and `keepHold` keeps it because a live
        // reviewer may still land a verdict. Only the first is a failure, so
        // only the first logs one.
        if (reached) {
          if (!keepHold) this._setLoopStep(team, ticketId, null);
        } else {
          const why = (r && (r.error || r.held)) || 'unknown delivery failure';
          // log.error, not info: this is the arm where a human must eventually
          // look, and the ticket is deliberately left marked in-flight so the
          // stall sweep keeps it visible until the lead can be reached.
          log.error('ticket', `ticket ${ticketId} escalation at ${step} did NOT reach ${team.lead} (${why}) — loopStep kept so the watchdog re-surfaces it`);
        }
        this._broadcast('ipc-message', { type: 'task', from: 'ticket-loop', to: team.lead, body: `ticket ${ticketId} escalated: ${step}` });
        log.info('intent', `ticket ${ticketId} escalated at ${step}: ${evidence}`);
      } catch (e) {
        log.error('ticket', `escalation for ${ticketId} failed: ${e.message}`);
      }
    }

    // Which seat's ledger a closing ticket's cost belongs to.
    //
    // NOT `_ticketAssigneeSeat`: that resolves a role to the FIRST live seat
    // holding it in sessions-map order, which on a team with three live hands
    // (the normal case) picks a seat at random and stamps the result as
    // measured. A guessed seat is worse than none — it publishes a foreign
    // lifetime ledger and a foreign wireLabel under this ticket's id, and
    // nothing downstream can tell it from a measurement.
    //
    // `closedBy` is evidence only when the closer HOLDS the ticket's role.
    // Preferring it unconditionally is the trap: `_taskCancel` is lead-only and
    // the lead can also close a `task done` for a seat that no longer can, so
    // closedBy is frequently the LEAD, whose record is the largest ledger in the
    // system. That trades a foreign hand's spend for the lead's whole life.
    //
    // The lead is excluded even when it legitimately holds the ticket's role —
    // `matchSeatRole(team, team.lead)` returns 'lead' unconditionally, so a
    // `lead`-assigned ticket would otherwise satisfy the guard exactly. The
    // lifetime-sum shape this rollup uses is an approximation that only holds
    // for a SHORT-LIVED actor: an ephemeral hand's lifetime is roughly one
    // ticket, while the lead's spans every ticket in the project — and would be
    // counted again into the next lead ticket, and the next. Approximately right
    // for a hand is categorically wrong for the lead.
    //
    // Everything else is UNKNOWN, on purpose. A declared unknown costs one
    // ticket's row in a rollup; a confident wrong number poisons every rollup
    // that sums it.
    _costSeatFor(team, ticket) {
      const at = (name, attribution) => {
        const entry = (name && getPersistence().get(name)) || null;
        // The NAME survives a missing record: a seat archived or deleted after
        // the close has no ledger, but it is still the join key back to its
        // other artifacts. `seatResolved: false` carries the no-ledger fact.
        return entry ? { seatName: name, entry, attribution }
          : { seatName: name || null, entry: null, attribution: 'unknown' };
      };
      const assignee = ticket && ticket.assignee;
      if (!assignee) return { seatName: null, entry: null, attribution: 'unknown' };
      const isRole = !!(team.roles && Object.prototype.hasOwnProperty.call(team.roles, assignee));
      if (!isRole) {
        // A delivery-time pin is exact evidence ONLY while it names the seat that
        // actually worked. A ticket whose pinned seat died degrades to its role,
        // and a sibling holding that role may then close it — at which point the
        // pin names one seat and the work was done by another. Billing the pin
        // here would publish the DEAD seat's lifetime ledger and wireLabel under
        // the sibling's work, and a surviving record (archived, retired
        // non-ephemeral, any restart that did not delete it) makes that a
        // confident wrong number rather than an empty one.
        //
        // `unknown`, not the closer: the seat branch has no closer-side evidence
        // to promote, so crediting one would be a guess wearing a measurement's
        // clothes. One declared-unknown row is cheap; a wrong number poisons
        // every rollup that sums it.
        const closedBy = ticket.closedBy;
        if (ticket.role && closedBy && closedBy !== team.lead && closedBy !== assignee
            && matchSeatRole(team, closedBy) === ticket.role) {
          return { seatName: null, entry: null, attribution: 'unknown' };
        }
        // The same `deliveredTo` falsifier the role branch carries, and it is
        // needed here for a case the closer test above cannot see: the LEAD
        // closing a replay-inherited ticket short-circuits that test, and closing
        // on a seat's behalf is the dominant habit. Replay hands a degraded ticket
        // to a sibling and stamps the seat it reached WITHOUT re-pinning, so the
        // record names a dead seat while another did the work. The stamp is
        // written only by replay and only to the seat the resolver named, so a
        // disagreement here implies precisely that case and cannot misfire on an
        // exactly-pinned seat that closed its own ticket.
        const deliveredSeat = ticket.deliveredTo && ticket.deliveredTo.seat;
        if (deliveredSeat && deliveredSeat !== assignee) {
          return { seatName: null, entry: null, attribution: 'unknown' };
        }
        return at(assignee, 'seat');
      }
      const closedBy = ticket.closedBy;
      // deliveredTo is a FALSIFIER only. Any role-holder may close another's
      // ticket, so a closer who is not the seat the spec went to is not evidence
      // of who spent. Its ABSENCE is evidence of nothing — it is on a small
      // minority of closed tickets, and reading absence as disagreement would
      // unknown-out most of them.
      const delivered = ticket.deliveredTo && ticket.deliveredTo.seat;
      if (closedBy && closedBy !== team.lead && matchSeatRole(team, closedBy) === assignee
          && !(delivered && delivered !== closedBy)) {
        return at(closedBy, 'role-closer');
      }
      return { seatName: null, entry: null, attribution: 'unknown' };
    }

    // COST.json — the per-ticket rollup (DESIGN.md §7.1), written at close.
    //
    // Deferred and fully best-effort: the commit count shells out to git, and a
    // rollup is a measurement, never a reason a ticket fails to close. Every
    // failure mode here (no taskDir, an unreadable totals file, a git error, an
    // unwritable dir) costs this one artifact and nothing else.
    //
    // Written even when the ledger is empty, because the WASTE counters are the
    // half of the record that has to exist for the zero-commit case — a ticket
    // that closed having burned a worktree and produced nothing is precisely the
    // t290 case being graded, and skipping it would make the counter measure
    // only the tickets that did work.
    //
    // The taskDir is RESOLVED, never trusted: it is spec text, and no ticket in
    // the live store carries an absolute one. Writing it verbatim mkdir -p's a
    // literal `~` under the process cwd and the artifact silently never lands.
    _writeTicketCost(team, ticket) {
      if (!ticket || !ticket.taskDir) return;
      let taskDir = null;
      try {
        taskDir = teamCost.resolveTaskDir({
          taskDir: ticket.taskDir,
          projectDir: projectDirFor(REGISTRY_DIR, team.root),
          projectsRoot: path.join(REGISTRY_DIR, 'projects'),
          homedir: os.homedir(),
        });
      } catch (e) {
        // An escaping taskDir is a refusal to write, loudly — not a fallback to
        // some safer path, which would put the artifact where nobody looks.
        log.info('intent', `COST.json refused for ${ticket.id}: ${e.message}`);
        return;
      }
      if (!taskDir) return;
      setImmediate(async () => {
        try {
          const { seatName, entry, attribution } = this._costSeatFor(team, ticket);
          const seatResolved = !!entry;
          const sessionIds = entrySessionIds(entry);
          let totals = null;
          try {
            totals = JSON.parse(fs.readFileSync(path.join(getUserDataPath(), 'wire-totals.json'), 'utf8'));
          } catch { /* no ledger yet — the rollup degrades to its waste half */ }
          const ledger = teamCost.sumSessions(totals, sessionIds);
          ledger.ids = sessionIds;

          // The ticket's own tree first: it is the ticket's tree by construction.
          // The record's is a fallback and counts ONLY for an exactly-pinned
          // seat — on an inferred seat it is that seat's CURRENT tree, and even
          // on an exact but long-lived name-addressed one it may be a tree the
          // seat carries for itself. Either way it reports `worktreeMinted: true`
          // with a commit count taken on some other branch. For a minted ticket
          // seat the two are the same object, so this ordering is inert there.
          const wt = ticket.worktree || (attribution === 'seat' && entry && entry.worktree) || null;
          let commits = null;
          let commitsBase = null;
          if (wt && wt.branch) {
            try {
              // The mint-time fork SHA when the record has one. Without it
              // commitsOnBranch falls back to a merge-base; it never counts
              // against the main checkout's live HEAD, which answers wrongly in
              // both directions.
              const r = await gitWorktree.commitsOnBranch(team.root, wt.branch, wt.baseSha || null);
              if (r && typeof r.count === 'number') { commits = r.count; commitsBase = r.base || null; }
            } catch { /* a git failure costs the commit count, not the record */ }
          }

          let orphans = null;
          try {
            const listed = await gitWorktree.listWorktrees(team.root);
            if (listed && listed.ok) {
              orphans = teamCost.orphanedCheckouts({
                worktrees: listed.worktrees,
                records: getPersistence().list(),
                // git prints realpath'd paths, records carry the path as created
                // (/tmp vs /private/tmp) — a raw compare reports a live tree as
                // an orphan.
                real: (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } },
              });
            }
          } catch { /* sweep failure costs counter (b), not the record */ }

          const rec = teamCost.costRecord({
            // `seat` is the RESOLVED name, not the ticket's `assignee`: a
            // role-assigned ticket's assignee is 'hand', which names no seat and
            // could not be joined back to the spend it is reporting.
            ticket: { ...ticket, assignee: seatName || null, wireLabel: (entry && entry.wireLabel) || null },
            team: team.name, ledger, worktree: wt, commits, commitsBase,
            orphans, seatResolved, attribution,
          });
          ensureDir(taskDir);
          fs.writeFileSync(path.join(taskDir, teamCost.COST_FILE), JSON.stringify(rec, null, 2));
        } catch (e) {
          log.info('intent', `COST.json not written for ${ticket && ticket.id}: ${e.message}`);
        }
      });
    }

    _taskReject(session, team, intent, reply) {
      const reason = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can reject a ticket${this._spillRejectedPayload(session, 'task reject', reason)}`); return; }
      if (!intent.id) { reply(`error: reject needs a ticket id — [agent:task reject <id>] <reason>${this._spillRejectedPayload(session, 'task reject', reason)}`); return; }
      if (!reason) { reply('error: reject needs a reason — [agent:task reject <id>] <what to fix>'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task reject', reason)}`); return; }
      if (ticket.state !== 'done') {
        // `open` is TWO different tickets and the bounce below is right for only
        // one of them. `reworkRound` is what tells them apart: a ticket open
        // because a rejection reopened it has a seat holding rework right now, so
        // further must-fixes are a coherent follow-up rather than a second undo of
        // a close that already happened. A ticket that never closed has nothing
        // for reject to undo and still belongs to `respec` — see this file's
        // _taskRespec header, which that split is still load-bearing for.
        if (ticket.state === 'open' && Number(ticket.reworkRound) > 0) {
          this._taskRejectFollowUp(session, team, tickets, ticket, reason, reply);
          return;
        }
        reply(`error: reject reopens a DONE ticket; ${intent.id} is ${ticket.state}${this._spillRejectedPayload(session, 'task reject', reason)}`);
        return;
      }
      ticket.state = 'open';
      ticket.closedAt = null;
      ticket.closedBy = null;          // cleared alongside closedAt — it is open again
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;
      // The marker that makes the guard above decidable. Nothing else on the
      // record distinguishes a rejection-reopened ticket from one that never
      // closed, and `state = 'open'` is written in exactly three places: a mint
      // (which never sets this) and the two rejection transitions. It counts
      // rather than flags because the lead's rejection notice reports how many
      // rounds deep the seat is, and it is NOT cleared on a later close — a
      // counter reset every round would report round 1 forever.
      // Distinct from `reviewRound` and deliberately so: a loop rejection spawns
      // no reviewer, so no review round happens on this path.
      ticket.reworkRound = (Number(ticket.reworkRound) || 0) + 1;
      // Reopening ends the loop's hold for the same reason accept does: the
      // ticket is `open` again, so the sweep tracks it on the ordinary path and a
      // stale step would otherwise let a late verdict land on a ticket the lead
      // has already sent back.
      delete ticket.loopStep;
      ticketsStore.save(team.root, tickets);
      const seat = this._ticketAssigneeSeat(team, ticket);
      // Same rework reasoning as the loop's reject. This call passed NO tag before,
      // which was harmless while the body was short enough to arrive inline; adding
      // the close line spills it, and an untagged pointer names neither the ticket
      // nor the verb. So the tag is added here rather than left to default.
      if (seat && seat !== team.lead) {
        this._gatedDeliver(seat, session.name, `[ticket ${ticket.id} rejected] ${ticketCloseLine(ticket.id)}${reason}`, true,
          `[ticket ${ticket.id} rejected] close with ${ticketCloseVerb(ticket.id)}`);
      }
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} rejected` });
      log.info('intent', `task reject ${ticket.id} by ${session.name} → reopened`);
      reply(`ticket ${ticket.id} reopened (rework) → ${ticket.role || ticket.assignee || 'unassigned'}`);
    }

    // Replace an OPEN ticket's spec and re-dispatch it. The correction path for a
    // ticket that is still in flight, where `reject` is meaningless: reject's whole
    // body undoes a close (state, closedAt, closedBy, loopStep), and every one of
    // those writes is a no-op on a ticket that never closed. Two verbs, two states,
    // no overlap — widening reject to cover this would make one verb mean "undo the
    // close" or "replace the spec" depending on where it lands.
    //
    // Gated to `open` even though the board's own editSpec is state-agnostic: that
    // one only corrects a record, this one DELIVERS. Re-dispatching a done or
    // accepted ticket would restart work on it without reopening it — a lifecycle
    // change through the back door, and the board would still read closed.
    _taskRespec(session, team, intent, reply) {
      // Read before every refusal below: the body IS the new spec, and losing a
      // re-spec to a bounce is the same loss that made cancel-and-refile lossy.
      const spec = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can respec a ticket${this._spillRejectedPayload(session, 'task respec', spec)}`); return; }
      if (!intent.id) { reply(`error: respec needs a ticket id — [agent:task respec <id>] <new spec>${this._spillRejectedPayload(session, 'task respec', spec)}`); return; }
      if (!spec) { reply('error: respec needs a new spec — [agent:task respec <id>] <the corrected spec>'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task respec', spec)}`); return; }
      if (ticket.state !== 'open') {
        const route = ticket.state === 'done' ? ` — reject it first ([agent:task reject ${intent.id}]), then respec` : '';
        reply(`error: respec replaces the spec of an OPEN ticket; ${intent.id} is ${ticket.state}${route}${this._spillRejectedPayload(session, 'task respec', spec)}`);
        return;
      }
      // The supersession record, so the board can show the spec CHANGED and by whom
      // — an open ticket silently rewritten into different work is the loss this
      // verb exists to prevent. The superseded TITLE is kept, not its full text:
      // tickets.json holds every ticket on the board and specs run to kilobytes, so
      // retaining each one would grow the file without bound on a ticket corrected
      // repeatedly.
      const prevTitle = ticket.title;
      if (!Array.isArray(ticket.respecs)) ticket.respecs = [];
      ticket.respecs.push({ at: Date.now(), by: session.name, title: prevTitle });
      ticket.spec = spec;
      // Derived from the spec, so both are recomputed — the same pair, from the same
      // helpers, that the board's editSpec re-derives. A stale title is the board's
      // summary line describing a spec that no longer exists; a stale taskDir points
      // the seat's journal at another ticket's artifacts.
      ticket.title = ticketTitle(spec);
      const hadTaskDir = !!ticket.taskDir;   // read before the line below overwrites it
      const taskDir = extractTaskDir(spec);
      if (taskDir) ticket.taskDir = taskDir; else delete ticket.taskDir;
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null; // a corrected spec starts a new stall episode, as assign does
      ticketsStore.save(team.root, tickets);
      // Deliver only to a ticket that was actually DISPATCHED, which is
      // `ticketStarted` — not `parked` alone. An added-but-unstarted ticket keeps
      // `assignee` at the ROLE KEY it was filed under, and `_ticketAssigneeSeat`
      // resolves a bare role key to the FIRST live seat holding that role, with no
      // started term of its own. So a parked-only gate hands this ticket's spec to
      // whichever sibling answers for the role first — a hand mid-work in another
      // ticket's worktree. `add` was stripped of its delivery for exactly this and
      // says so ("do not restore a delivery here"); gating anywhere but here would
      // restore it by a new door.
      //
      // Neither arm re-pins or stamps `startedAt`: that would make respec a third
      // dispatch path, which is the seam the add/start split exists to create.
      // Correcting the spec of an undispatched ticket is a WRITE, and `task start`
      // remains the one verb that sends it.
      const dispatched = ticketStarted(ticket) && !ticket.parked;
      const d = dispatched
        ? this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true, false, true)
        : { undelivered: true };
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} respec'd` });
      log.info('intent', `task respec ${ticket.id} by ${session.name} → spec replaced, re-dispatched`);
      const target = ticket.role || ticket.assignee || 'unassigned';
      // The undispatched arms say WHICH verb sends the corrected spec. Silence here
      // reads as "delivered" and is how a lead ends up believing a hand has the new
      // text, which is the failure this whole ticket is about.
      // The route is picked from the STATE, not fixed at `start`. `_taskStart`
      // refuses a backlog ticket (no assignee) and refuses an already-started one
      // — a started-then-parked ticket reaches this arm, since park accepts a
      // started ticket — and both redirect to `assign`. Naming `start` in either
      // case hands back a command that bounces, which is the failure `_taskPark`'s
      // own reply guards against: an unusable recovery in the one reply whose
      // whole job is to name the way out.
      const sendVerb = (!ticket.assignee || ticketStarted(ticket))
        ? `[agent:task assign ${ticket.id} ${ticket.role || ticket.assignee || '<role|name>'}]`
        : `[agent:task start ${ticket.id}]`;
      const note = ticket.parked
        ? ` (parked — spec replaced, NOT dispatched; ${sendVerb} sends it)`
        : !dispatched
          ? ` (not started — spec replaced, NOT dispatched; ${sendVerb} sends it)`
          : this._ticketDeliverySuffix(d, target);
      // Surfaced, not silent: the loop hard-fails later on a ticket with no task dir
      // and routes the lead to `reject`, three steps downstream of the respec that
      // dropped it. Cheaper to learn here, while the spec is still in hand.
      const dirNote = (hadTaskDir && !ticket.taskDir)
        ? ` — NOTE: the previous spec named a tasks/… dir and this one does not, so the artifact link was dropped`
        : '';
      reply(`ticket ${ticket.id} respec'd → ${target}${note}${dirNote}`);
    }

    _taskCancel(session, team, intent, reply) {
      const reason = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can cancel a ticket${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      if (!intent.id) { reply(`error: cancel needs a ticket id — [agent:task cancel <id>] [reason]${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — cannot cancel${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      ticket.state = 'cancelled';
      ticket.closedAt = Date.now();
      ticket.closedBy = session.name;  // one shape across both close verbs
      ticket.lastActivityAt = ticket.closedAt;
      ticketsStore.save(team.root, tickets);
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (reason && seat && seat !== team.lead) this._gatedDeliver(seat, session.name, `[ticket ${ticket.id} cancelled] ${reason}`, false);
      this._reconcileTickets(team);
      const next = seat ? this._advanceSeat(team, seat, ticket.id) : null;
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} cancelled` });
      this._writeTicketCost(team, ticket);
      log.info('intent', `task cancel ${ticket.id} by ${session.name}`);
      reply(`ticket ${ticket.id} cancelled${next ? ` — next: ${next.id} delivered to ${seat}` : ''}`);
    }

    // Write the revival link onto the TICKET, at the last moment it is knowable.
    //
    // The board is the durable index; nothing else is. `assignee` is a seat NAME
    // and seat names RECYCLE (`_mintTicketSeat` derives them from role + ticket
    // number), so it does not identify the session that did the work. On a
    // discard the persistence record — the only other holder of the session id —
    // is dropped outright, and on an archive it survives only until the seat is
    // deleted. Stamping here makes "revive whoever did t301" a lookup instead of
    // archaeology in a lead context that dies at its next compact.
    //
    // Called BEFORE teardown on BOTH dispositions. On discard the stamp is the
    // only surviving trace, and it still names the branch and commit a hotfix
    // would start from.
    _stampTicketRevival(team, seatName, extra = null) {
      if (!team || !team.root || !seatName) return null;
      let rec = null;
      try { rec = getPersistence().get(seatName); } catch { rec = null; }
      let tickets;
      try { tickets = ticketsStore.load(team.root); } catch { return null; }
      // The ticket this seat was minted for: the pin is the seat name, and a
      // ticket already accepted is not re-stamped by a later retire of the same
      // seat — the first stamp names the session that did the work.
      const ticket = tickets.find((t) => t.assignee === seatName && !t.revival);
      if (!ticket) return null;
      const wt = rec && rec.worktree ? rec.worktree : null;
      ticket.revival = {
        seat: seatName,
        sessionId: (rec && rec.sessionId) || null,
        branch: (wt && wt.branch) || null,
        worktree: (wt && wt.path) || null,
        baseSha: (wt && wt.baseSha) || null,
        at: Date.now(),
        ...(extra || {}),
      };
      ticket.lastActivityAt = Date.now();
      try { ticketsStore.save(team.root, tickets); } catch { return null; }
      return ticket;
    }

    // `[agent:task accept <id>]` — the lead's acknowledgement, and the only verb
    // that tears anything down.
    //
    // NOT folded into `done`: `done` is emitted by the ASSIGNEE and carries its
    // report, so retiring on it would kill the seat the instant it reports —
    // before the lead has read a word, and before the two rework rounds a reject
    // exists to send. Acceptance is the lead's judgement and arrives later.
    //
    // Every destructive step is gated on ONE fact — `merge-base --is-ancestor`.
    // Once the branch is in, the tree protects nothing and the seat has nothing
    // to resume into; until then the seat is archived and tree and branch are
    // kept. A check that could not RUN is treated as not merged: `ok:false` is
    // absence of evidence, and inferring "merged" from it deletes unmerged work.
    async _taskAccept(session, team, intent, reply) {
      const note = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can accept a ticket${this._spillRejectedPayload(session, 'task accept', note)}`); return; }
      if (!intent.id) { reply(`error: accept needs a ticket id — [agent:task accept <id>] [note]${this._spillRejectedPayload(session, 'task accept', note)}`); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task accept', note)}`); return; }
      // Accepting un-reported work is how a half-finished branch gets its tree
      // deleted, so the state is named in the refusal rather than coerced.
      if (ticket.state !== 'done') { reply(`error: accept closes out a DONE ticket; ${intent.id} is ${ticket.state} — it has not been reported yet${this._spillRejectedPayload(session, 'task accept', note)}`); return; }

      // The branch comes from the SEAT'S RECORD, never from the ticket id: the
      // name is minted with a title slug (`_mintTicketSeat`), so the id alone
      // cannot reconstruct it and a guessed branch name would fail the gate and
      // report an accepted ticket as unmerged.
      const seatName = ticket.assignee || null;
      let rec = null;
      try { rec = seatName ? getPersistence().get(seatName) : null; } catch { rec = null; }
      const branch = (rec && rec.worktree && rec.worktree.branch) || (ticket.worktree && ticket.worktree.branch) || null;

      const finish = (msg) => {
        ticket.acceptedAt = Date.now();
        ticket.acceptedBy = session.name;
        if (note) ticket.acceptNote = note;
        ticket.lastActivityAt = ticket.acceptedAt;
        // Accept ENDS the loop's hold, and both writes below must say so.
        // An accept can land while a review is still out (the lead does not wait
        // for the verdict), and this path retires the seat, removes the worktree
        // and deletes the branch. A `loopStep` surviving that lets the late
        // verdict through `_landVerdictOnTicket`'s done+loopStep arm, stamping a
        // REWORK — with a bumped reviewRound — onto merged-and-deleted work,
        // which the lead then hears about only as a summary of a stamp nobody
        // asked for. Cleared, a late verdict cannot be placed and correctly
        // falls through to the lead in FULL, who is the one who can act on it.
        delete ticket.loopStep;
        // Re-read: the teardown below stamped revival onto its own copy.
        const fresh = ticketsStore.load(team.root);
        const row = fresh.find((t) => t.id === ticket.id);
        if (row) {
          row.acceptedAt = ticket.acceptedAt;
          row.acceptedBy = ticket.acceptedBy;
          if (note) row.acceptNote = note;
          row.lastActivityAt = ticket.lastActivityAt;
          delete row.loopStep;
          ticketsStore.save(team.root, fresh);
        } else {
          ticketsStore.save(team.root, tickets);
        }
        this._broadcast('ipc-message', { type: 'task', from: session.name, to: seatName || '(unassigned)', body: `ticket ${ticket.id} accepted` });
        log.info('intent', `task accept ${ticket.id} by ${session.name}: ${msg}`);
        reply(msg);
      };

      // No branch to reason about (a ticket worked in the main checkout): there
      // is no tree to remove and no ref to delete, so acceptance is the stamp
      // alone. Retiring the seat here would be a teardown the merge fact never
      // licensed.
      if (!branch) {
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true });
        finish(`ticket ${ticket.id} accepted — no ticket branch recorded, so nothing was torn down${seatName ? ` (${seatName} left as it is)` : ''}`);
        return;
      }

      const m = await gitWorktree.isMerged(team.root, branch).catch((e) => ({ ok: false, error: e.message }));

      if (!m.ok) {
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true });
        if (seatName && this.sessions.has(seatName)) await this.archive(seatName);
        finish(`ticket ${ticket.id} accepted, but the merge check could NOT run for branch ${branch} (${m.error || 'unknown error'}) — treated as NOT merged: `
          + `${seatName ? `${seatName} was archived, and its ` : 'its '}worktree and branch were KEPT. Nothing was removed.`);
        return;
      }

      if (!m.merged) {
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true });
        if (seatName && this.sessions.has(seatName)) await this.archive(seatName);
        finish(`ticket ${ticket.id} accepted, but branch ${branch} is NOT merged into ${m.base} — `
          + `${seatName ? `${seatName} was archived (resumable), and its ` : 'its '}worktree and branch were KEPT. `
          + `Merge it, then [agent:task accept ${ticket.id}] again to clean up.`);
        return;
      }

      // Merged: the four steps. Stamp FIRST — destroy() drops the record the
      // session id lives in, so after it the link is unrecoverable.
      if (seatName) this._stampTicketRevival(team, seatName, { accepted: true, mergedInto: m.base });
      let removed = null;
      if (seatName && (this.sessions.has(seatName) || rec)) {
        const r = await this.destroy(seatName).catch((e) => ({ ok: false, error: e.message }));
        removed = r || null;
      }
      const del = await gitWorktree.deleteBranch(team.root, branch).catch((e) => ({ ok: false, error: e.message }));
      const parts = [];
      if (seatName) {
        parts.push(removed && removed.worktreeRemoved ? `${seatName} retired and its worktree removed`
          : removed && removed.error ? `${seatName} retired but its worktree could NOT be removed (${removed.error})`
            : `${seatName} retired`);
      }
      parts.push(del.ok ? `branch ${branch} deleted` : `branch ${branch} could NOT be deleted (${del.error})`);
      finish(`ticket ${ticket.id} accepted — merged into ${m.base}; ${parts.join('; ')}.`);
    }

    // Park an ALREADY-OPEN ticket, or the unpark direction if it is parked. A
    // flag settable only at file time would be write-once, leaving cancel-and-
    // refile as the only way to change a lead's mind — which is the cost this
    // ticket exists to remove.
    // Toggle rather than park/unpark verbs: the state is one bit and the reply
    // names which way it went, so a lead cannot ask for the wrong direction.
    // Deliberately does NOT deliver on unpark — that is `assign`'s job, and a
    // second delivery path would let the two disagree about what a seat was told.
    _taskPark(session, team, intent, reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can park a ticket`); return; }
      if (!intent.id) { reply('error: park needs a ticket id — [agent:task park <id>]'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — only an open ticket can be parked`); return; }
      const parking = !ticket.parked;
      if (parking) ticket.parked = true;
      else delete ticket.parked;
      ticket.lastActivityAt = Date.now();
      // A parked ticket is exempt from the watchdog, so a stamp left behind
      // would spend the one nudge of the episode that starts when it unparks.
      ticket.nudgedAt = null;
      ticketsStore.save(team.root, tickets);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(backlog)', body: `ticket ${ticket.id} ${parking ? 'parked' : 'unparked'}` });
      log.info('intent', `task ${parking ? 'park' : 'unpark'} ${ticket.id} by ${session.name}`);
      reply(parking
        // The ROLE, not the pin: `_resolveAssignee` takes a role key or a LIVE
        // seat, so suggesting a pin that has degraded (its seat is gone) hands
        // back a command that bounces — an unusable recovery in the one reply
        // whose whole job is to name the way out.
        ? `ticket ${ticket.id} parked — held out of dispatch; [agent:task assign ${ticket.id} ${ticket.role || ticket.assignee || '<role|name>'}] releases it`
        : `ticket ${ticket.id} unparked → ${ticket.role || ticket.assignee || 'backlog'} — the spec was NOT re-sent; use [agent:task assign ${ticket.id} <role|name>] to deliver it`);
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
    _taskList(session, team, intent, reply) {
      const filter = intent.filter || 'open';
      if (!TICKET_FILTERS.includes(filter)) {
        reply(`error: unknown filter "${filter}" — use one of: ${TICKET_FILTERS.join(', ')}`);
        return;
      }
      const tickets = ticketsStore.load(team.root).slice().sort((a, b) => {
        const na = Number(String(a.id).replace(/^t/, '')) || 0;
        const nb = Number(String(b.id).replace(/^t/, '')) || 0;
        return na - nb;
      });
      if (!tickets.length) { reply(`no tickets on ${team.name}`); return; }
      const shown = filter === 'all' ? tickets : tickets.filter((t) => t.state === filter);
      const now = Date.now();
      // A parked ticket is open and assigned and yet will not be dispatched, so
      // without a marker the open list is the one place that reads exactly like
      // a ticket in flight.
      // The ROLE is what the lead filed the ticket under, so it is what the board
      // reads as; `assignee` is now a delivery-time pin to a concrete seat, which
      // is a cost-attribution fact and not the name the lead is looking for.
      const shownFor = (t) => t.role || t.assignee || '—';
      // The respec suffix rides the TITLE, which is re-derived from each new spec:
      // without it the row silently changes text between two listings and the lead
      // has no way to tell a corrected ticket from one it misremembers.
      const respecMark = (t) => (Array.isArray(t.respecs) && t.respecs.length ? ` (respec'd ×${t.respecs.length})` : '');
      const row = (t) =>
        `${t.id} [${t.state}${t.parked ? ' parked' : ''}] ${shownFor(t)} ${humanizeAge(now - (t.openedAt || now))} — ${t.title || '(untitled)'}${respecMark(t)}`;
      const closedRow = (t) =>
        `${t.id} [${t.state}] ${shownFor(t)} closed ${humanizeAge(now - t.closedAt)} ago — ${t.title || '(untitled)'}${respecMark(t)}`;
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

    // Solo no-ops here, and in `_advanceSeat` — NOT because there is nothing to
    // reconcile, but because these walk seats by ROLE to dispatch specs. A solo
    // board's "live seats" are every agent session in the repo, none of which
    // enrolled in anything; falling through would deliver specs to sessions that
    // never opted in. Not delivering is the recoverable failure.
    _reconcileTickets(team) {
      if (team && team.solo) return;
      const tickets = ticketsStore.load(team.root);
      const live = this._teamLiveSeatNames(team.root);
      for (const name of live) {
        const role = matchSeatRole(team, name);
        // Degraded pins resolve through `_ticketAssigneeSeat` here too, or the
        // seat that inherited a dead one's queue gets no badge for work it holds.
        const open = tickets.find((t) => t.state === 'open' && t.assignee != null && !t.parked
          && (t.assignee === name || t.assignee === role
            || this._ticketAssigneeSeat(team, t, live) === name));
        if (open) this._ticketWatch.set(name, { root: team.root, role });
        else this._ticketWatch.delete(name);
        this._broadcast('session-ticket', { name, ticket: open ? open.id : null });
      }
    }

    _touchTicketActivity(name) {
      const w = this._ticketWatch.get(name);
      if (!w) return;
      const tickets = ticketsStore.load(w.root);
      let changed = false;
      const now = Date.now();
      // `team` is needed to resolve a degraded pin; without it an inherited ticket
      // never refreshes `lastActivityAt` and the watchdog nudges the lead about
      // work somebody is actively doing.
      let team = null; try { team = resolveTeam(w.root || ''); } catch { team = null; }
      // Walked ONCE for the whole loop, not once per ticket: this runs on every
      // non-idle activity edge and both the team resolve and the seat walk are
      // filesystem work.
      const live = team ? this._teamLiveSeatNames(team.root) : null;
      for (const t of tickets) {
        if (t.state !== 'open') continue;
        if (t.assignee === name || (w.role && t.assignee === w.role)
          || (team && this._ticketAssigneeSeat(team, t, live) === name)) {
          t.lastActivityAt = now;
          if (t.nudgedAt) t.nudgedAt = null;
          changed = true;
        }
      }
      if (changed) ticketsStore.save(w.root, tickets);
    }

    startTicketWatchdog(intervalMs = 60000) {
      if (this._ticketWatchdogTimer) return;
      this._ticketWatchdogTimer = setInterval(() => { try { this._sweepTickets(); } catch (e) { log.error('ticket', `watchdog sweep failed: ${e.message}`); } }, intervalMs);
      if (this._ticketWatchdogTimer.unref) this._ticketWatchdogTimer.unref();
    }

    // Returns a promise resolving when every board's stall probe has finished.
    // The reconcile pass below does NOT wait on it — badges must not sit behind a
    // git call — so the return is for callers that need the sweep to have
    // completed (the tests) rather than an ordering the runtime depends on.
    _sweepTickets(now = Date.now()) {
      // TWO dedup keys, because the two calls below are scoped differently and
      // collapsing them under one key breaks whichever loses.
      //
      // The SWEEP is per BOARD: the board is the project's, so two different teams
      // rooted at one project must nudge ONCE between them, not twice about the
      // same stalled ticket. Note that this makes `watchdogMs` iteration-order
      // dependent when two teams share a root — whichever team is reached first
      // governs the stall window for that pass.
      //
      // RECONCILE is per TEAM: it walks _teamLiveSeatNames(team.root), which is
      // project-scoped and therefore already returns the OTHER team's seats, but
      // resolves each one's role with matchSeatRole(team, name). Deduping it by
      // root means the second team never gets its pass, so its role-assigned seats
      // resolve to no role against the first team's manifest and are silently
      // stripped — _ticketWatch.delete plus a `session-ticket: null` broadcast
      // every sweep, with nothing to restore them. Keyed by team.file, each team
      // reconciles against its own manifest.
      const sweptBoards = new Set();
      const reconciledTeams = new Set();
      const sweeps = [];
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        let team; try { team = resolveTeam(s.cwd); } catch { team = null; }
        if (!team) continue;
        if (!sweptBoards.has(team.root)) {
          sweptBoards.add(team.root);
          // Deliberately not awaited: the sweep now makes git calls, and the
          // reconcile below maintains the sidebar badges — holding those behind a
          // slow probe would stall the UI on a repo under load. Overlap is
          // handled by _stallProbing, not by serializing the pass.
          sweeps.push(this._sweepTeamTickets(team, now).catch((e) => log.error('ticket', `stall sweep failed: ${e.message}`)));
        }
        if (!reconciledTeams.has(team.file)) {
          reconciledTeams.add(team.file);
          this._reconcileTickets(team); // self-heal the watch map + badges post-restart
        }
      }
      return Promise.all(sweeps);
    }

    // Evidence for a stalled seat's alarm: what its last tool call was and how it
    // ended, whether its branch carries commits, whether its tree is dirty.
    //
    // Every probe is best-effort and a failure DROPS its field rather than
    // guessing. The alarm's whole job is to be trustworthy enough to act on
    // without a hand probe; a wrong field spends that trust to save a git call.
    //
    // `dirty` is never returned without `tool` being attempted, because dirty
    // alone is what the lead reasoned from on t312 and it is identical for a seat
    // writing and a seat killed mid-write.
    async _stallEvidence(team, ticket) {
      const out = { tool: null, commits: null, dirty: null };
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (seat) {
        try {
          const link = pathFor(REGISTRY_DIR, seat, 'transcript');
          out.tool = lastToolFrom(readTail(fs, fs.realpathSync(link)));
        } catch { /* no transcript, codex, or unreadable — omit the field */ }
      }
      const wt = ticket.worktree || null;
      if (wt && wt.branch) {
        const r = await gitWorktree.commitsOnBranch(team.root, wt.branch, wt.baseSha || null)
          .catch(() => ({ ok: false }));
        if (r && r.ok && typeof r.count === 'number') out.commits = r.count;
      }
      if (wt && wt.path) {
        const d = await gitWorktree.isDirty(wt.path).catch(() => ({ ok: false }));
        if (d && d.ok) out.dirty = d.dirty === true;
      }
      return out;
    }

    // Async since t322: the alarm body carries git facts, and git is async. The
    // caller (_sweepTickets) does not await — a slow probe must not delay the
    // reconcile pass behind it — so overlapping sweeps are possible and
    // `_stallProbing` is what keeps them from double-nudging.
    async _sweepTeamTickets(team, now) {
      const stallMs = (typeof team.watchdogMs === 'number' && team.watchdogMs > 0) ? team.watchdogMs : TICKET_STALL_MS;
      const tickets = ticketsStore.load(team.root);
      // Walked ONCE for the whole board, not once per ticket: the orphan test below
      // asks `_ticketAssigneeSeat` about every eligible ticket and each resolution
      // would otherwise re-walk the run directory. Same reason `_touchTicketActivity`
      // hoists it.
      const live = this._teamLiveSeatNames(team.root);
      for (const t of tickets) {
        // UNSTARTED is the exemption, not unassigned: `add` writes the ROLE NAME
        // into `assignee`, so a ticket the lead filed as backlog and never
        // dispatched is indistinguishable from a live one under an `assignee`
        // test. Seven such tickets alarmed in one burst before ticketStarted
        // drew the line here — and against the t322 ladder each would have gone
        // on repeating at 30m/60m/120m/240m forever, since no seat exists to go
        // quiet. `parked` stays as its own term: a parked ticket can already
        // have started, so ticketStarted does not cover it. The `assignee` term
        // stays too, narrowed to what it was always meant to catch: a legacy
        // record with no `startedAt` key reads as STARTED, so an unassigned one
        // would newly alarm about a seat that cannot be resolved.
        // `done` stopped being terminal when the loop started running past it: a
        // done ticket with a live `loopStep` has checks running or a review in
        // flight, and if that step dies nothing else ever nudges anyone. The
        // predicate is shared with the stamp below and with the verdict landing —
        // see ticketInFlight; divergence between them is silent, not loud.
        if (!ticketInFlight(t) || t.assignee == null || !ticketStarted(t) || t.parked) continue; // unstarted/unassigned/parked/closed exempt
        const last = t.lastActivityAt || t.openedAt || now;
        if (now - last < stallMs) continue;
        // A loop-held ticket names the STEP, not the seat (see the body below), so
        // it is never orphan-tested: the hand is finished and gone by construction
        // there, and asking whether a seat is live would classify every loop-held
        // ticket as unassigned and replace the alarm that names the stuck step.
        const loopHeld = t.state === 'done' && !!t.loopStep;
        // ORPHAN: the assignee resolves to no live seat. Measured on t376 — a
        // retired hand's ticket alarmed "hand quiet 31m", then "STILL stalled
        // (repeat 1): hand quiet 1h" about a seat that had not existed for an hour.
        // Nothing was quiet; nothing was there.
        //
        // Resolution goes through the SAME `_ticketAssigneeSeat` the dispatch uses,
        // so "no seat" here means exactly what "undeliverable" means there. A
        // separate liveness test would be free to disagree, and the disagreement
        // would be silent in the worse direction: a ticket the sweep calls orphaned
        // while dispatch still routes it stops alarming about a seat that IS there.
        //
        // Note this is reachable for a worktree ticket in a way a role ticket is
        // not: `_ticketAssigneeSeat` deliberately refuses to degrade a worktree pin
        // to its role, so a retired worktree seat resolves to null permanently
        // rather than being re-answered by a sibling.
        // ANOTHER TEAM'S ticket, seen because the stall sweep is deduped per BOARD
        // while the board is per PROJECT — the hazard `_sweepTickets` already
        // documents for `watchdogMs`. Team A wins the dedup and resolves team B's
        // ticket against A's `roles`, where B's role key is not a role at all: the
        // pin fails `isRoleKey`, the seat name is not in A's live set, and a ticket
        // with a perfectly live B seat reads as orphaned.
        //
        // That was survivable while this only changed WORDING. It is not now that it
        // changes CLASSIFICATION: the orphan arm is one-shot, so B's genuinely
        // stalled ticket would get one wrongly-worded alarm and then permanent
        // silence — the same failure mode as the must-fix, arrived at sideways.
        // Falling back to the stall body is the safe direction: a ticket that is
        // merely mis-worded still keeps its escalation ladder.
        //
        // Applied at `orphanNow` (the classification that picks the body and the
        // stamp) and deliberately NOT here: this gate only ever consults
        // `orphanNudgedAt`, which cannot be set for a foreign ticket precisely
        // because `orphanNow` refused it. A second copy of the term would be
        // unreachable by any state, and an unreachable guard reads as a live
        // invariant to the next person to touch this.
        const foreignRole = !!(t.role && !(team.roles
          && Object.prototype.hasOwnProperty.call(team.roles, t.role)));
        const orphan = !loopHeld && !this._ticketAssigneeSeat(team, t, live);
        // ONE ORPHAN alarm, ever — not the geometric ladder below. The ladder
        // re-escalates because a stall can end and the seat can come back; an
        // orphan cannot resolve itself, so every repeat carries identical
        // information and the whole cost of the t376 defect was the repeating.
        //
        // BOTH terms are load-bearing, and gating on `nudgedAt` ALONE is a defect
        // that deletes the alarm rather than de-duplicating it. The live->orphan
        // transition is the ticket's own motivating trace: t376 alarmed first as a
        // live-but-quiet stall, which stamps `nudgedAt`, and the seat was retired
        // only afterwards. With one term, every later sweep sees a truthy stamp and
        // `continue`s forever — and `nudgedAt` is cleared only by activity
        // (unreachable: there is no seat), assign, respec, park or a verdict. The
        // lead would hear "hand quiet 31m" and then nothing, ever.
        //
        // `orphanNudgedAt` records that the ORPHAN message specifically has been
        // sent. Keeping `nudgedAt` in the gate is what makes it need no new clearing
        // sites: every existing `nudgedAt = null` writer (assign, activity, park,
        // respec) already reopens the ticket to alarming, so a reassignment starts a
        // clean episode exactly as before.
        if (orphan && t.nudgedAt && t.orphanNudgedAt) continue;
        // NOT one nudge per episode any more (t322). `nudgedAt` is cleared only by
        // seat ACTIVITY, which by definition never comes during a stall, so a
        // single alarm the lead dismissed bought permanent silence: measured on
        // t312, where the 30m alarm was waved off and the remaining 28 minutes of
        // a 55.7m stall raised nothing at all.
        //
        // Geometric instead: re-alarm once the quiet has DOUBLED since the alarm
        // that was already sent. Lands at 30m, 60m, 120m, 240m — log2 in stall
        // duration, so an all-night stall speaks ~5 times rather than 16 and a
        // dead ticket can never flood the lead's prompt stream. The first repeat
        // at 60m is the earliest that is not just re-asking, with identical
        // evidence, a question the lead answered minutes ago.
        //
        // `prevAge <= 0` means the stamp predates this episode's activity, so it
        // falls THROUGH and alarms: a fresh episode has not spoken yet.
        const prevAge = t.nudgedAt ? t.nudgedAt - last : 0;
        if (prevAge > 0 && (now - last) < prevAge * 2) continue;
        // A repeat, and it must SAY it is one. An unmarked repeat reads as a new
        // stall and invites the lead to re-answer what it already answered.
        //
        // Derived from `prevAge`, NOT from the raw `nudgedAt`: the gate above
        // treats a stamp predating the episode as "this episode has not spoken
        // yet" and falls through to alarm, so reading the field directly labels
        // that FIRST alarm a repeat. `_stampTicketRevival` reaches it — it writes
        // `lastActivityAt` without clearing `nudgedAt`, unlike every other writer.
        // The lie self-heals after one alarm, which is exactly why it needs a pin
        // rather than a comment: telling the lead it already answered something it
        // never saw is the confidently-wrong field this module exists to prevent.
        //
        // The ORDINAL, not a boolean in integer clothing: `prevAge > 0 ? 1 : 0`
        // printed "repeat 1" on the 60m, 120m and 240m rungs alike, making the
        // three indistinguishable in the one field that separates a half-hour
        // stall from an all-night one. log2 recovers it without state because
        // `prevAge` IS the age at which the previous alarm fired and the gate
        // above only passes on a DOUBLING, so the ladder is 1·2·4·8·stallMs.
        // `round` absorbs the 60s sweep granularity (a 30m window alarming at
        // 61m must still read rung 2, not 1); `max(1,·)` covers a stamp taken
        // while `watchdogMs` was TIGHTER than it is now, where the ratio is < 1
        // and the log negative. Off-ladder — a first alarm that landed late
        // because no sweep ran at the window — this is the rung reached, which
        // can exceed the number of messages actually sent; the rung is the
        // useful quantity (how old is this stall) and is what the pins assert.
        const repeat = prevAge > 0 ? Math.max(1, Math.round(Math.log2(prevAge / stallMs)) + 1) : 0;
        // A ticket already being probed by an overlapping sweep is skipped rather
        // than double-nudged: the git probes below are async, so two sweeps can
        // both pass this gate before either stamps.
        if (this._stallProbing.has(t.id)) continue;
        // `nudgedAt` is read back at the top of this loop to time the NEXT alarm,
        // so a stamp taken from the return silences the watchdog on exactly the
        // ticket it exists to surface — a nudge wiped by a boot re-render costs
        // the alarm entirely.
        // The stamp therefore rides onWrite, which fires LATER than this loop (the
        // queue writes after its gates). It cannot mutate `t`: that object is this
        // sweep's snapshot and nothing saves it. So it re-loads, stamps and saves on
        // its own — the same load-after-the-delivery-decided shape _replayOpenTickets
        // uses, and for the same reason: a wide window invites clobbering a
        // concurrent write.
        const tid = t.id;
        const seenAt = t.lastActivityAt || null;
        const seenNudge = t.nudgedAt || null;
        // A loop-held ticket names the STEP, not the seat: the hand is finished
        // and the loop is what is stuck, so "hand quiet 45m" points the lead at
        // the wrong actor entirely — the first thing to check differs completely
        // between a silent seat and a dead verify step. It gets no seat evidence
        // for the same reason: the hand's last tool call is not what is stuck.
        let body;
        // The classification the STAMP records, which is not always the one the
        // eligibility gate computed: the git probe below is awaited, and a seat can
        // come up while it runs. Declared out here because the onWrite closure reads
        // it and the loop-held arm never re-resolves.
        let orphanNow = orphan;
        if (loopHeld) {
          const head = repeat > 0 ? `[ticket ${tid}] STILL stalled (repeat ${repeat}): ` : `[ticket ${tid}] stalled: `;
          body = `${head}the ticket loop is stuck at "${t.loopStep}" — no progress for ${humanizeAge(now - last)} (the hand already reported; nothing was torn down)`;
        } else {
          this._stallProbing.add(tid);
          let ev = { tool: null, commits: null, dirty: null };
          try { ev = await this._stallEvidence(team, t); } catch { /* alarm without evidence beats no alarm */ }
          finally { this._stallProbing.delete(tid); }
          // Re-read after the await: the seat may have woken while git ran, and
          // an alarm about a seat that is now working is the false positive this
          // ticket exists to stop producing.
          const after = ticketsStore.load(team.root).find((x) => x.id === tid);
          if (!after || !ticketInFlight(after) || (after.lastActivityAt || null) !== seenAt) continue;
          // Re-resolve the SEAT after the await too, not just the ticket record. The
          // `lastActivityAt` re-read above cannot cover this: a seat that spawns
          // during the git probe has touched nothing, so the record is byte-identical
          // while the classification has flipped. Sending an orphan alarm — "not a
          // live seat, reassign or cancel it" — about a seat that is now live is the
          // same class of confidently-wrong report this ticket exists to remove, and
          // it would additionally stamp `orphanNudgedAt` and suppress the real alarm.
          // The walk is re-done rather than reusing `live`, which is this pass's
          // pre-await snapshot and is exactly the stale thing in question.
          // `foreignRole` rides here too: it is a property of the ticket and the
          // sweeping team, not of the seat, so re-resolving without it would let the
          // await path reach a classification the gate above deliberately refused.
          orphanNow = !foreignRole && !this._ticketAssigneeSeat(team, after);
          // The orphan branch shares the probe above and diverges only here: the git
          // facts are what decide between reassign, cancel and park, so they are worth
          // the same calls. `ev.tool` is null for an orphan by construction — the
          // probe resolves its transcript through the same resolver that just
          // returned no seat — and formatOrphanBody takes no tool field at all.
          body = orphanNow
            ? formatOrphanBody({
              ticketId: tid, who: t.assignee, age: humanizeAge(now - last),
              commits: ev.commits, dirty: ev.dirty,
            })
            : formatStallBody({
              ticketId: tid, who: t.role || t.assignee, age: humanizeAge(now - last),
              repeat, tool: ev.tool, commits: ev.commits, dirty: ev.dirty,
            });
        }
        this._gatedDeliver(team.lead, 'ticket-watchdog',
          body, false, '',
          () => {
            try {
              const fresh = ticketsStore.load(team.root);
              const rec = fresh.find((x) => x.id === tid);
              // NOT `if (rec.nudgedAt) return` any more: on a re-escalation the
              // field is legitimately set, and refusing to re-stamp it would
              // freeze the doubling clock at the first alarm's age — every later
              // sweep would then pass the gate and nudge, inverting the rule.
              // The guard is instead "nobody else stamped since we decided",
              // which is the same shape as the lastActivityAt check below.
              if (!rec) return;                                  // closed
              if ((rec.nudgedAt || null) !== seenNudge) return;  // another sweep won
              // The stamp must identify the EPISODE it was decided for, not just the
              // ticket: _touchTicketActivity clears `nudgedAt` on any activity, so a
              // seat that speaks inside this window ends the stall. Stamping anyway
              // spends the next episode's one nudge before it starts, and only
              // activity clears it — which never comes during a stall.
              // The SAME predicate as the eligibility test above, and it must
              // stay the same one: this guard decides whether the one nudge is
              // spent, so a shape the loop nudges but this refuses to stamp
              // re-nudges every single sweep — the one-nudge-per-episode rule,
              // inverted, on precisely the in-flight tickets §E added.
              if (!ticketInFlight(rec)) return;
              if ((rec.lastActivityAt || null) !== seenAt) return;
              // `now`, not Date.now(): the doubling gate reads this back as
              // `nudgedAt - lastActivityAt` to size the NEXT alarm, so it has to
              // be the instant the sweep judged, not the instant the delivery
              // happened to be written. Wall-clock here also makes the escalation
              // schedule untestable — the gate would measure a drift the caller
              // cannot control rather than the age the sweep decided on.
              rec.nudgedAt = now;
              // Which MESSAGE was sent, alongside when. The eligibility gate needs
              // to tell "already told the lead this seat is gone" from "already
              // told the lead this seat is quiet", and `nudgedAt` cannot: it is one
              // field for two messages, which is what silenced the live->orphan
              // transition. Deleted rather than left stale on the stall arm, so a
              // ticket that goes orphan->live->orphan (reassigned to a seat that
              // then also dies) is not suppressed by the first round's stamp.
              if (orphanNow) rec.orphanNudgedAt = now;
              else delete rec.orphanNudgedAt;
              ticketsStore.save(team.root, fresh);
            } catch (e) { log.error('ticket', `nudge stamp for ${tid} failed: ${e.message}`); }
          });
      }
      // No save here: the only field this sweep writes is `nudgedAt`, and each stamp
      // now saves its own re-loaded copy from onWrite. A save of `tickets` at this
      // point would write back a snapshot taken BEFORE those stamps and undo them.
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
              // Session env, same expression as the other two kill()-based
              // respawns (engine.js restartSession, session-restore.js). Omitting
              // it defaults sessionEnv to null and the reloaded seat spawns with
              // NO session env at all — silently, since create() then re-persists
              // the entry without it, so every later --resume is wrong too.
              (entry.env && typeof entry.env === 'object') ? entry.env : null,
              false,           // mint — a reload respawns an existing record
              entry.noWire === true,
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
    // activity edge for it (ActivityTracker._set dedupes on unchanged state). A
    // caller that waits for such an edge must therefore arm on 'injected' only.
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
      // copy — with flushPending broadcasting pending-count: 0 on top of it.
      // The producer runs inside the queue's critical section, past the ready and
      // quiet gates, so the files are claimed only when the write is imminent.
      // The count is a non-destructive PRE-count for the return value and the log
      // line; the drain may legitimately yield fewer (another drainer won, a born
      // mismatch restored one), which costs an over-count in a log, never a message.
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
      // parkable (resend-recursion fix), so a stranded text just sits. Join into a
      // single body with the SAME blank-line separator the out-of-process hook
      // drain uses (cli-hooks.js: texts.join('\\n\\n')), so a seat sees the same
      // combined shape whichever drainer won. drainPending returns park order.
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
          hintHeld: () => { try { return !!(arm.holding && arm.holding(session.name)); } catch { return false; } },
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

    async _handleTeamRetire(targetName, requesterName) {
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
      // Two independent facts, one from each store that actually knows. The
      // MANIFEST answers "is this seat the team's at all" — an unrecognized seat
      // is not the team's to preserve. The persistence RECORD answers "was this
      // seat spawned to be thrown away", stamped at spawn by the path that knew
      // (the ticket seat and the review reservation both stamp it). The role def
      // used to carry an `ephemeral` copy of the second fact and it could
      // disagree with the record; one word in two stores is how it did.
      let discard = false;
      try {
        const team = resolveTeam(target.cwd);
        if (team) {
          const role = matchSeatRole(team, targetName);
          const roleMatch = role ? team.roles[role] : null;
          let rec = null;
          try { rec = getPersistence().get(targetName); } catch { rec = null; }
          discard = !roleMatch || (rec != null && rec.ephemeral === true);
        }
      } catch { discard = false; }
      // A discard force-removes the seat's worktree, so an UNCOMMITTED diff or an
      // untracked file dies with it. Retire is a routine lead-triggerable action
      // and a ticket seat is ephemeral by construction, which together make that
      // the common path, not the corner: downgrade to archive instead and say
      // why, so the operator's exit is "commit, then retire again" rather than
      // "notice afterwards". Committed work was never at risk — it is on the
      // branch — so this only ever costs a resumable session nobody wanted.
      //
      // An UNREADABLE tree (git missing, path gone) also downgrades: `ok:false`
      // is not evidence of a clean tree, and archiving something discardable is
      // recoverable while the reverse is not.
      // Two paths to the SAME downgrade, and they must stay distinguishable at
      // the confirmation: "git says this tree has changes" and "git could not
      // look at this tree" archive alike, but only the first is something the
      // operator can go and commit. Telling them to commit a tree that no longer
      // exists is the failure this split exists to prevent — and it is the
      // NORMAL path, since correct cleanup order (merge, remove tree, retire
      // seat) reaches the retire with the tree already gone.
      let dirtyPath = null;
      let uncheckedPath = null;
      let uncheckedWhy = null;
      // Captured here because kill() drops the persistence record: by the time
      // the confirmation is built, the record this path came from is gone.
      let discardPath = null;
      if (discard) {
        const rec = (() => { try { return getPersistence().get(targetName); } catch { return null; } })();
        const wt = rec && rec.worktree && rec.worktree.path ? rec.worktree.path : null;
        if (wt) {
          discardPath = wt;
          const d = await gitWorktree.isDirty(wt).catch((e) => ({ ok: false, error: e.message }));
          if (!d.ok) { discard = false; uncheckedPath = wt; uncheckedWhy = d.error || 'git could not read the tree'; }
          else if (d.dirty) { discard = false; dirtyPath = wt; }
        }
      }
      const disposition = discard ? 'discard' : 'archive';
      // Before teardown, while the persistence record still holds the session id:
      // destroy() drops it, and then the link from ticket to session is gone for
      // good. Same reason discardPath is captured above.
      try {
        const t = resolveTeam(target.cwd);
        if (t) this._stampTicketRevival(t, targetName, { disposition });
      } catch { /* the stamp is a convenience; a retire must not fail on it */ }
      this._sendToSession(targetName, 'session:context-action', { action: 'retired', name: targetName, disposition });
      this._broadcast('ipc-message', {
        ts: Date.now(), from: requesterName, to: targetName, kind: 'retire',
        body: `retire → ${targetName} (${disposition}, project ${targetRoot})`,
      });
      log.info('intent', `team-retire ${requesterName} → ${targetName} (${disposition}, project ${targetRoot})`);
      // destroy(), not kill(): a discarded seat is gone for good, and its ticket
      // worktree goes with it. The archive branch keeps the tree deliberately —
      // the seat is resumable, and its checkout is what it resumes into.
      const teardown = discard ? this.destroy(targetName) : this.archive(targetName);
      teardown.then((r) => {
        // The confirmation names what actually happened to the checkout. "State
        // lives in its task artifact" was true only of what the seat committed
        // or wrote out, and a discard deletes the tree — so the wording mirrors
        // _taskAssign's, which the app already uses for the same loss.
        let confirm;
        if (dirtyPath) {
          // The exit routes through RESUME on purpose: the seat was just
          // archived, so its pty is dead and it has left this.sessions — a second
          // team-retire returns at `if (!target)` and does nothing at all, which
          // reads to the lead as the tool ignoring it.
          confirm = `retired ${targetName} (ARCHIVED, not discarded — ${dirtyPath} has uncommitted work). `
            + 'A discard would have deleted that tree. Resume it from the sidebar, commit or clear that tree, '
            + 'then retire again to discard.';
        } else if (uncheckedPath) {
          // Deliberately does NOT tell the operator to go commit anything: the
          // commonest way to land here is a tree that is already gone, and an
          // instruction to commit in it names a directory that cannot be opened.
          confirm = `retired ${targetName} (ARCHIVED, not discarded — ${uncheckedPath} could not be inspected: ${uncheckedWhy}). `
            + 'That is usually a tree already removed. Archiving was the safe choice: an unreadable tree is not evidence of a clean one, '
            + `and the seat stays resumable. If ${uncheckedPath} is gone and you want the record dropped, delete the session from the sidebar.`;
        } else if (!discard) {
          confirm = `retired ${targetName} (resumable from the sidebar or on next project open)`;
        } else if (r && r.worktreeRemoved) {
          confirm = `retired ${targetName} (discarded — its worktree was removed; committed work survives on the branch)`;
        } else if (r && r.error) {
          // The path comes from the record, not from r.error: removeWorktree's
          // failure strings carry no path, so "remove it by hand" would name
          // nothing to remove.
          confirm = `retired ${targetName} (discarded, but its worktree could NOT be removed: ${r.error}`
            + `${discardPath ? ` — remove ${discardPath} by hand` : ' — remove it by hand'})`;
        } else {
          confirm = `retired ${targetName} (discarded — state lives in its task artifact)`;
        }
        log.info('intent', `team-retire ${requesterName} → ${targetName} done: ${confirm}`);
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
    // unclaimed 8s later — is silent and permanent, and the drain is what is
    // missing, not the write: the delivery that eventually rescued it was an
    // operator flush through this same queue, with no boot-readiness cap in sight.
    //
    // Recovery for a seat ALREADY in that state is a plain dm re-sending the scope,
    // never a respawn. Respawning is the intuitive move and it is wrong: the seat is
    // healthy and its name is reserved, so a respawn mints a SECOND seat while the
    // first keeps its parked mail and its `born` stamp — and the stamp is what makes
    // the old mail undeliverable to the new seat (drainPending discards a `born`
    // mismatch). A dm lands on the live seat and drains the park with it.
    //
    // Modeled on _armReplayFallback, and re-checks for the same reason rather than
    // delivering on schedule: a drain forced while the latch is still missing puts
    // the write back inside the boot re-render window with the messages already
    // claimed off disk. Deferring to an armed _bootDrainTimer is what preserves
    // BOOT_DRAIN_SETTLE_MS as the margin — this timer never shortens it. A plain
    // _armParkCap here would be that same forced delivery, which is why it isn't one.
    //
    // EVERY path out of a pass either delivers or leaves a timer armed. A bare
    // return anywhere here makes this second edge one-shot in exactly the way the
    // first one is, which is the defect this method exists to cover, one layer out:
    // yielding to a drain that then bails (an open draft at :2514, a producer that
    // claims nothing) would end with the park unclaimed and nothing alive to notice.
    // `file` scopes a pass to the park it was armed FOR: hasActivePending is
    // name-scoped, so a later pass would otherwise find UNRELATED mail parked
    // meanwhile by _maybeParkDelivery and force it through, bypassing _injectText's
    // hold check and splicing into the very thinking seat that park protects.
    // `drained` marks a pass that FOLLOWS a terminal drain, and it gates the warn,
    // not the re-arm. Bounding the re-arm instead was the obvious move and it is
    // wrong: a seat whose draft stays open across two periods would have its park
    // abandoned with nothing scheduled to look again — this ticket's own defect,
    // reintroduced by the thing meant to stop the log from repeating. So the timer
    // lives as long as the park does, and only the first drain announces itself. It
    // is bounded in the ways that actually end: the pass returns once the file is
    // claimed, and _cleanup clears the handle when the seat dies.
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
        // unqualified "never fired" would misdiagnose it. This defect was found in
        // these lines and nothing else.
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

  return SessionManager;
}

module.exports = { createSessionManager, deniedBodyDisposition, isStaleRegistration, missingToolOnExit, nameConflict, preseedClaudeOnboarding, ticketCloseLine };
