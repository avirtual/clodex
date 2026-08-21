// team-tickets.js — the teams/tickets half of SessionManager: ticket board
// verbs, seat shaping/spawn, spec delivery, review/verdict/auto-merge, the
// ticket loop + suite, watchdog/stall sweep, team role editing, retire.
//
// ─── GRAFT CONTRACT ─────────────────────────────────────────────────────────
//
// This module returns METHODS, not an API. createSessionManager grafts them
// onto SessionManager.prototype, so every one of them runs with `this` = the
// manager instance and NOT with `this` = anything this file constructs.
//
// Three consequences that decide how to change code here:
//
//   1. STATE LIVES ON THE INSTANCE, never in this module. `this._ticketWatch`,
//      `this._stallProbing`, `this.sessions` and the per-session latches are
//      the manager's; this file must not hold ticket state in a closure, which
//      would be per-FACTORY rather than per-manager and would leak across two
//      managers in one process (every test file builds several).
//
//   2. CROSS-BOUNDARY CALLS STAY `this.<name>()`. Reaching core is
//      `this._gatedDeliver(…)`, not an injected handle — that is what let the
//      move be byte-identical. It also means the coupling is INVISIBLE to
//      test/free-identifier-leaks.test.js, which scans module-scope names and
//      can never see a prototype-chain lookup. The seam is gated instead by
//      test/ticket-mixin-surface.test.js. Deleting a core method these bodies
//      call is a runtime TypeError that only that gate will catch.
//
//   3. This is a FILE SPLIT, NOT A DECOUPLING (t380). The coupling graph after
//      the move is the coupling graph before it. Do not read this boundary as a
//      claim that tickets are independent of the session core; the mixin
//      surface test's inventory is the starting spec for that work, not its
//      result.
//
// Everything the methods need from the coordinator arrives through `deps` (all
// names already destructured by createSessionManager, so engine.js is
// unchanged) or through `shared`, which carries the two core-OWNED values the
// cluster reads rather than constructs.

const { nextTicketId, titleLine, ticketTitle, extractTaskDir, extractMustFix, countMustFix, ticketStarted, ticketInFlight, branchSlug } = require('./tickets-store');
const teamCost = require('./team-cost');
const { buildReviewScope } = require('./ticket-review-scope');
const { projectDirFor } = require('./clodex-paths');
// The task-dir helpers below are module-scope (exported, so suites pin the real
// bytes rather than a copy) and so cannot reach the `path` createTicketMethods
// takes through deps. Deliberately NOT named `path`: inside the factory that
// name is the injected one, and shadowing it would silently swap a fixture's
// probe for the real module.
const nodePath = require('path');
const {
  readTail, lastToolFrom, formatStallBody, formatOrphanBody,
  parseCpuTime, sumTreeCpuMs, classifyReviewSeat, formatReviewSeatClause, didGrow,
} = require('./stall-evidence');
const { isDraftOpen } = require('./proxy-util');
const { trackedSessionIds: entrySessionIds } = require('./session-info');
const { hostNotice } = require('./host-stamp');
const { matchSeatRole } = require('./team-manifest');
const { expandTeamRoot } = require('./team-root-expand');
const { CLAUDE_TOOLS } = require('./catalogs');

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
// misdiagnosed timeouts. The margin is the run itself: the suite takes ~74s
// (measured 2026-08-19 at fe8e152), and exceeding 15m of RUNNING means a wedge,
// not a slow suite.
const TICKET_SUITE_TIMEOUT_MS = TICKET_SUITE_LOCK_WAIT_MS + 15 * 60 * 1000;

// The suite-in-flight retry (t440). BOUNDED IN BOTH DIRECTIONS, and the two
// bounds answer different questions: the attempt count bounds how often the loop
// asks, the deadline bounds how long a ticket can sit unmerged. Either alone is
// unsound here — attempts alone let a retry that re-enters a busy merge chain
// stretch to hours, and a deadline alone lets a fast lock flap spin the timer
// hundreds of times.
//
// The numbers are sized against ONE suite run: 73s wall at master fe8e152, 74s
// from a worktree at c1e1b8e, measured 2026-08-19 (scripts/test-digest.sh and
// test/test-digest-lock.test.js carry the same measurement). A delay well under
// that would burn attempts inside a single run without ever outliving it, and a
// delay near it would usually sample the lock just as the next run takes it —
// 30s samples a ~74s run about three times.
// 10 attempts x 30s covers ~5 minutes of continuous contention — three
// back-to-back suite runs — which is the realistic shape here (a hand verifying
// its worktree takes the ROOT's lock, so a team of hands serializes through it).
// Past that, waiting longer is unlikely to help and the escalation is the honest
// answer — which is NOT the same as concluding the lock is wedged, and the
// escalation deliberately does not say so. The 10-minute deadline is the one
// that bites when the retries are themselves delayed behind other merges in the
// chain.
const MERGE_RETRY_DELAY_MS = 30 * 1000;
const MERGE_RETRY_MAX_ATTEMPTS = 10;
const MERGE_RETRY_MAX_WAIT_MS = 10 * 60 * 1000;

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
// CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS is admitted on a different footing
// from its four neighbours, and the distinction is the one that keeps this list
// a ceiling: the others turn a Clodex mechanism off, this one is a RESOURCE
// knob. Its worst case over a doctored template is a seat that reads too much
// or — set to garbage — cannot Read at all. Neither redirects the seat to
// another backend, another credential or another model, which is what the list
// exists to refuse. A key whose abuse costs context is not a key whose abuse
// costs authority; admitting the first does not soften the refusal of the
// second.
//
// It must be PLAIN DIGITS. The CLI does parseInt(v, 10) and takes any result
// > 0, so '6e4' becomes 6 and '1e6' becomes 1 — a one-token Read cap that
// fails every read, one API roundtrip at a time, while passing the > 0 gate
// that would otherwise reject it. test/reviewer-read-token-cap.test.js pins the
// digits-only form against exactly that edit.
const REVIEWER_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'FORCE_PROMPT_CACHING_5M',
  'CLODEX_DISABLE_IPC_PROMPT',
  'CLODEX_SPAWNER_HINT',
  'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
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
// The pointer shapes the clause below is ABOUT. A `~`- or `/`-prefixed pointer
// already means to an agent what it means here, so it earns no prose. The gate
// lives HERE, beside the wording, rather than at each call site: both helpers
// below are exported, and a caller that gated on the raw string being merely
// present would emit prose asserting an absolute path "is relative to the
// PROJECT'S ARTIFACT DIR".
const taskDirRelative = (raw) => !!raw && !raw.startsWith('~') && !nodePath.isAbsolute(raw);

// The rule a RELATIVE pointer needs and an already-placed one does not. Split
// from the line below because the two renderers of a task dir — the hand's
// dispatch and the reviewer's scope — frame the path differently but must state
// the rule identically; a second wording is the divergence in new clothes.
//
// Three things in one clause, because each alone leaves a live failure:
// where the path resolves (an agent resolves it against cwd, and the repo has a
// same-named decoy), that it names the DIRECTORY of a pointer that usually ends
// in a file, and that it may not exist yet — a hand that found it absent
// reported it missing and worked without it, which is the whole ticket.
//
// FACT ONLY, no imperative: this clause is what the reviewer's scope carries,
// and that seat is read-only by construction (REVIEWER_TOOL_CAP has no write
// tool, its scope forbids editing the tree). "So create it" belongs to the
// dispatch alone — see taskDirCreateClause — and folding it back in here hands a
// read-only seat an instruction it cannot follow. What must NOT be answered by
// splitting the WORDING is the half that both seats need: the absence proving
// nothing is exactly the part a reviewer has to know.
const taskDirRuleClause = (raw) => (taskDirRelative(raw)
  ? ` — the spec's \`${raw}\` is relative to the PROJECT'S ARTIFACT DIR, `
    + `not to your cwd, and a same-named directory inside the repo is NOT it. `
    + `This is the directory itself (the pointer may name a file inside it); it may not exist yet, `
    + `and its absence is not evidence that there is no artifact.`
  : '');
// The dispatch-only half. Rendered only where the fact clause was, because it
// reads as its second sentence and dangles without it.
const taskDirCreateClause = ` So create it rather than working without one.`;
// The resolved artifact pointer, for the seat that can WRITE the artifact.
// Exported for the same reason ticketCloseLine is: several suites pin a
// delivered body byte-for-byte, and a copy of this prose in a fixture drifts
// from the real line silently.
const ticketTaskDirLine = (dir, raw) => {
  const rule = taskDirRuleClause(raw);
  return `TASK DIR: ${dir}${rule}${rule ? taskDirCreateClause : ''}\n`;
};
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
    // Plain digits, never exponent form — see REVIEWER_ENV_ALLOWLIST. Read's
    // 25000-token default makes a reviewer paginate through the one diff we
    // most want read in a single pass.
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  },
};

// The review path refuses a template's extraArgs wholesale (an agent-writable
// array of raw CLI argv reaching a seat whose premise is a hard tool cap:
// --allowedTools, --mcp-config and --dangerously-skip-permissions all ride
// there, and REVIEWER_TOOL_CAP screens none of them). `--model` is the single
// carve-out: it grants no authority — tools, posture and env each have their own
// ceiling above — so honoring it cannot widen the seat, and refusing it made
// every reviewer spawn as the default model however it was configured.
// Returns { args, refused }. `args` is [] when the template names no usable
// model, so the caller appends nothing. An ALLOWLIST by construction: the value
// is rebuilt from the parsed model, never passed through from the template's
// array, so no neighbouring token can ride along with it.
//
// `refused` carries the offending spec when a --model was PRESENT but not
// honored, and it is not decoration: a silent refusal reproduces this function's
// own bug one layer in — the operator configured a model, did not get it, and
// nothing said so. The caller must surface it.
function reviewerModelArgs(extraArgs) {
  const a = Array.isArray(extraArgs) ? extraArgs : [];
  // A model NAME never begins with '-'. Refusing one that does keeps this
  // function fail-closed on its own terms: otherwise `['--model','--dangerously-
  // skip-permissions']` emits that flag into the reviewer's argv, and whether it
  // is read as a flag or swallowed as a bogus model name depends on the CLI's
  // parser — an authority decision this allowlist must not delegate downstream.
  const usable = (v) => typeof v === 'string' && v && !v.startsWith('-');
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (typeof tok !== 'string') continue;
    // The FIRST model token decides, valid or not — it is not "the first
    // VALID one". A later well-formed --model does NOT rescue an earlier
    // refused one, because a last-wins CLI would then have honored the
    // earlier token this function rejected.
    if (tok === '--model' || tok === '-m') {
      // A trailing flag with no value is dropped entirely rather than emitted
      // bare — a bare --model would consume whatever argv token followed it.
      const v = a[i + 1];
      if (usable(v)) return { args: ['--model', v], refused: null };
      return { args: [], refused: typeof v === 'string' ? `${tok} ${v}` : tok };
    }
    if (tok.startsWith('--model=')) {
      const v = tok.slice('--model='.length);
      return usable(v) ? { args: ['--model', v], refused: null } : { args: [], refused: tok };
    }
  }
  return { args: [], refused: null };
}

const TICKET_STALL_MS = 30 * 60 * 1000;

// How long past the stall window the rung-2 wake may defer the lead's first
// alarm. Baseline sweep + confirm sweep + jitter is 2-3 minutes; this bounds it,
// so a probe stuck at `unknown` alarms rather than deferring forever. The
// deferral becoming silent alarm DELETION is the failure class this file has
// been burned by three times (MIN_GAP_MS, the wedged-confirm clear, t376).
const WAKE_GRACE_MS = 5 * 60 * 1000;

// The branch an accepted ticket lands on. A literal, matching what
// scripts/release.sh's preflight demands, and deliberately NOT
// gitWorktree.defaultBranch(): that prefers origin/HEAD, which answers about a
// ref this checkout may never merge to, and the auto-merge writes to the tree in
// front of it. A checkout parked anywhere else is a blocked merge, not a merge
// somewhere else.
const MERGE_TARGET_BRANCH = 'master';

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

function createTicketMethods(deps, shared) {
  const {
    AGENT_NAME_RE,
    DEFAULT_WORKSPACE_ID,
    REGISTRY_DIR,
    addRole,
    setRole,
    removeRole,
    renameRole,
    setTeamWatchdog,
    resolveTeam,
    childProcess,
    ensureDir,
    findProjectRoot,
    fs,
    os,
    path,
    pathFor,
    getPersistence,
    // whenReady-assigned in engine.js, so it crosses as a lazy getter like the
    // others here. Used by _cancelTicketReminders to drop the reminders bound to
    // a ticket that just closed.
    getRemindScheduler,
    getTemplates,
    getUserDataPath,
    gitWorktree,
    isAlive,
    log,
    withoutPrivilegedIntentsFor,
  } = deps;
  const {
    // ticketsStore is constructed ONCE, by createSessionManager, and borrowed
    // here. Constructing a second instance would work (it is fs-backed) and
    // would still be wrong: core's list() badge and these verbs must agree
    // about cache and ordering, and two stores are free to disagree silently.
    ticketsStore,
    // Module-scope in session-manager.js, used by core's create() AND by
    // _taskAssign, AND exported (ipc-handlers imports it). Passed in rather
    // than moved so the export keeps its home and no require cycle is created.
    nameConflict,
    // Derived core-side (session-manager.js, beside BOOT_DRAIN_SETTLE_MS) and
    // borrowed here. It measures how long an injected unit has to produce a turn
    // edge — inject/activity plumbing, not ticket lifecycle — and the dm latch
    // core-side is its third borrower. Re-deriving it from `deps.specConfirmMs`
    // here as well would put the same default in two files.
    SPEC_CONFIRM_MS,
  } = shared;

  // How long a wake has to produce a turn before rung 3 fires. Aliased to the
  // spec latch's window rather than re-derived: both measure "a write was made
  // and no turn followed", and two numbers for one question drift.
  //
  // The first rung-3 alarm fires no later than `stallMs + WAKE_GRACE_MS +
  // WAKE_CONFIRM_MS`. The confirm term cannot be gated away — a wake fired just
  // inside the grace window still opens a full take-window behind it.
  const WAKE_CONFIRM_MS = SPEC_CONFIRM_MS;

  // Injectable ONLY so the kill arm is reachable from a test. Without a seam no
  // subject can pin "a runner that never exits is SIGKILLed and ESCALATES,
  // never rejects" — an arm that decides a ticket's fate and would otherwise
  // ship green while measuring nothing.
  const TICKET_SUITE_TIMEOUT = Number.isFinite(deps.ticketSuiteTimeoutMs)
    ? deps.ticketSuiteTimeoutMs : TICKET_SUITE_TIMEOUT_MS;

  return {
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
    },

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
      // Resolved from the SPAWNER's team, so one shipped template serves every
      // team; a portable template writes "${TEAM_ROOT}" where ours hardcodes an
      // absolute path. Refusing on an unresolved root is the point — see
      // team-root-expand.js.
      const spawnerRoot = (() => {
        try { return resolveTeam(spawner.cwd)?.root || ''; } catch { return ''; }
      })();
      const expandedCwd = expandTeamRoot(rawCwd, spawnerRoot);
      if (!expandedCwd.ok) {
        reply(`error: ${tpl ? `template "${tplLabel}" cwd: ` : ''}${expandedCwd.reason}`);
        return;
      }
      const cwd = path.resolve(expandedCwd.value.replace(/^~(?=$|\/)/, os.homedir()));
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
          const spawned = await this.create(
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
            // Agent-initiated: appears while the operator is working somewhere
            // else, so it may not take the keyboard. The reload respawn in
            // session-manager omits this flag on purpose — that one is the
            // operator's own seat coming back and keeps its focus.
            background: true,
          });
          const where = wt ? `${spawnCwd} (worktree, branch ${wt.branch})` : spawnCwd;
          this._broadcast('ipc-message', {
            type: 'spawn', from: spawner.name, to: name, body: `spawn → ${name} @ ${where}` + (tpl ? ` (template ${tplLabel})` : ''),
          });
          log.info('intent', `spawn by ${spawner.name} → ${name} (${type}) @ ${where}` + (tpl ? ` via template "${tplLabel}"` : ''));
          // The spawning lead is the party who can act on an unresolved role
          // prompt — it named the seat, and the seat itself cannot see that it
          // booted unbriefed. Never blocks: the seat is already up by here.
          const promptWarn = (spawned && spawned.missingPrompt) ? ` — WARNING: ${spawned.missingPrompt}` : '';
          reply(`ok: spawned "${name}" (${type}) @ ${where}` + (tpl ? ` via template "${tplLabel}"` : '')
            + promptWarn
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
    },

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
    },

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

      // SCOPED TO `!reviewTicket`, and that scope is the whole correctness of this
      // guard. The ticket loop reaches this same handler with `opts.ticketId`, for a
      // ticket that is in `verify` BY DEFINITION — that is the step it is spawned
      // from. A board read that did not check `reviewTicket` first would refuse the
      // very spawn this exists to protect, and every ticket would stall at review
      // permanently.
      //
      // What it closes: `task done` stamps `loopStep: 'verify'` and the ticket stays
      // there until the loop's own reviewer is minted at _setLoopStep(…, 'review').
      // That is NOT the 74-81s spawn latency measured after the suite — the suite
      // await ahead of it is MINUTES (see its own comment), so the blind window is
      // a whole suite run. In it the ticket LOOKS unreviewed and is not, so a bare
      // `[agent:team-review]` spawns a second, unattached reviewer whose verdict
      // lands nowhere.
      //
      // Only `verify`. A `review` ticket already HAS its seat on the roster, so a
      // bare call there is visibly redundant; `verify` is the blind window.
      //
      // Fails OPEN on an unreadable board: team-review is the documented escape
      // hatch for when the loop CANNOT spawn a reviewer, so refusing it on a board
      // that cannot be read would remove the hatch in exactly the broken state it
      // exists for.
      if (!reviewTicket) {
        let inVerify = [];
        try {
          inVerify = ticketsStore.load(team.root)
            .filter((t) => t && t.loopStep === 'verify')
            .map((t) => t.id);
        } catch { inVerify = []; }
        if (inVerify.length) {
          const many = inVerify.length > 1;
          reply(`error: ${many ? 'tickets' : 'ticket'} ${inVerify.join(', ')} ${many ? 'are' : 'is'} in the loop's verify step — the loop spawns its OWN reviewer for ${many ? 'each' : 'it'} once the branch's full suite passes — usually a couple of minutes, longer if the suite is queued behind the box-wide lock — and it looks unreviewed the whole time. A review requested here is not attached to ${many ? 'any of them' : 'it'}: its verdict lands nowhere and it re-reads the same diff. Wait for the loop's reviewer. To send an ALREADY-reviewed ticket back for another round, that is [agent:task reject <id>] with the must-fixes, not a second reviewer; no reviewer spawned`);
          return;
        }
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
      // A refused --model must not be silent: the operator configured a model,
      // did not get it, and a quiet fallback to the default is the exact bug the
      // --model carve-out exists to end.
      const argsWarn = shape.modelRefused
        ? ` — reviewer template model "${shape.modelRefused}" is not a usable model name (a value is required and cannot begin with "-") — ignored; spawned on the default model (fix the template's "extraArgs")`
        : '';
      // A role cwd that could not be honored. Warned, never fatal: the seat is
      // already useful at the team root, and the alternative — refusing the review
      // over a directory — blocks the ticket. Silence is what this must not be:
      // the reviewer would be reading the right repo from the wrong place, and
      // nothing else in the system would ever say so.
      const cwdWarn = shape.cwdFallback ? ` — NOTE: ${shape.cwdFallback}` : '';

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
          const spawned = await this.create(
            name, type, cwd, shape.extraArgs, null, shape.workspaceId,
            reviewBrief, false, session.proxy ?? null, shape.agents, shape.denyBuiltins, shape.disabledTools,
            shape.disabledSkills, shape.injectSkills,
            reviewerSystemPrompt, shape.appendPromptFiles, shape.execCommands, shape.intents, shape.env, true,
          );
          // The rule is "reported ONCE", and this is the one caller that can
          // report twice: a reviewer whose prompt rides as system fails the
          // promptWarn check above AND create()'s finding, both to the same lead
          // in the same reply. The pre-existing warn wins — it is the precedent
          // every other relay was brought up to, and it names the recovery.
          // Suppression is on the WARN being carried, not on the two texts
          // matching: they are worded differently on purpose.
          const spawnPromptWarn = (!promptWarn && spawned && spawned.missingPrompt)
            ? ` — WARNING: ${spawned.missingPrompt}` : '';
          // AFTER create(), not before: the setters resolve the entry by name and
          // silently no-op if it isn't there yet. A reviewer that skipped this ran
          // unstripped no matter what the template said, which is invisible from
          // inside the seat.
          this._applyTemplatePersistence(name, shape.tpl);
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd, backend: (this.sessions.get(name) || {}).backend || null, noWire: !!(this.sessions.get(name) || {}).noWire,
            background: true,
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
          reply(`spawned ${name} — it'll report back with [agent:review-done]; watchdog it by name${capWarn}${envWarn}${argsWarn}${cwdWarn}${promptWarn}${spawnPromptWarn}${promptEscapeWarn}${tplWarn}`);
        } catch (err) {
          if (!this.sessions.has(name)) getPersistence().remove(name);
          log.error('intent', `team-review by ${session.name} → ${name} failed: ${err.message}`);
          reply(`error: ${err.message}`);
        }
      });
    },

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
    },

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
    },

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
    },

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
    _queueAutoMerge(team, ticketId, landedOn, verdictText, retry = null) {
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
        .then(() => this._autoMergeTicket(team, ticketId, landedOn, verdictText, retry))
        .catch((e) => {
          log.error('ticket', `auto-merge for ${ticketId} rejected: ${e && e.message ? e.message : String(e)}`);
        })
        // After the catch, so it runs on both arms: a counter that leaked on a
        // rejected merge would report a phantom queue forever after.
        .then(() => { this._mergePending -= 1; });
      return this._mergeChain;
    },

    // The suite-in-flight retry's two seams, as methods so a test can replace
    // them without a real timer and without real seconds. Kept separate because
    // they answer different questions and a test usually wants only one of them:
    // _mergeRetryNow is the clock the DEADLINE is measured against,
    // _scheduleMergeRetry is the delay between attempts.
    _mergeRetryNow() { return Date.now(); },

    // unref'd for the same reason the spec-confirm and review-start timers are:
    // this must never be why the process stays alive, and never why a test file
    // that dispatched one merge hangs for 30 seconds after its assertions pass.
    _scheduleMergeRetry(fn, ms) {
      const t = setTimeout(fn, ms);
      if (t && t.unref) t.unref();
      return t;
    },

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
    },

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
    },

    // The DEFERRED merge's trace on the board, and deliberately NOT mergeError.
    //
    // Why it needs one at all: by the time a merge runs, _landVerdictOnTicket has
    // already deleted `loopStep`, so ticketInFlight is false and the stall sweep
    // never looks at this ticket again. A deferred merge holds its entire retry
    // state in ONE unref'd setTimeout closure for up to ten minutes — a crash or
    // an [agent:reboot] in that window drops the merge with nothing on the record
    // and no DM, which is strictly worse than the terminal refusal this replaced,
    // since that one at least stamped and escalated.
    //
    // Why a SEPARATE field: mergeError reads as "this ticket needs a human". A
    // ticket waiting its turn does not, and stamping it there would send the lead
    // to look at a merge that is going to happen by itself.
    _stampMergeWaiting(team, ticketId, why) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!why) { if (!('mergeWaiting' in rec)) return; delete rec.mergeWaiting; }
        else rec.mergeWaiting = why;
        rec.lastActivityAt = Date.now();
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `merge waiting stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    // `retry` is the suite-in-flight retry's carried state, `{ attempt, since }`,
    // and it is a PARAMETER rather than instance state on purpose: two tickets
    // can be waiting on the same lock at once, and a single field on the manager
    // would have one of them inherit the other's attempt count and deadline.
    async _autoMergeTicket(team, ticketId, landedOn, verdictText, retry = null) {
      // THE mergeWaiting INVARIANT: set on the defer arm, false on EVERY other
      // exit from this function.
      //
      // Held in a `finally` rather than by clearing at each exit, because the
      // exits are not only the ones that are easy to remember. A retry re-enters
      // from the top and can reach a DIFFERENT terminal arm than the one that
      // deferred — dirty tree, moved branch, red suite, exhaustion — and can also
      // take a SILENT return (the ticket was reopened in the gap, or has no
      // branch), or throw. Every one of those would otherwise leave the stamp
      // behind, and a ticket that looks eternally pending is its own bug, of
      // exactly the kind this field was added to prevent. Clearing at each exit
      // is a rule someone must re-apply to every arm added later; a finally is
      // the same rule enforced by control flow.
      //
      // Costs one ticketsStore load per merge, and no save unless the field is
      // actually there — _stampMergeWaiting returns early when it is absent.
      //
      // Attached to the EXISTING try/catch below rather than an outer one: the
      // whole body already runs inside it, so this needs no new block and no
      // reindent of 300 lines whose template literals are byte-sensitive.
      let deferred = false;
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
          // THE ONLY RETRIED ARM, and the only one that should be. Every other
          // fail() here names a state a human has to look at — a dirty tree, a
          // moved branch, a red suite — where retrying would just re-report the
          // same thing later. This one names a condition that is transient BY
          // CONSTRUCTION: the suite lock is box-wide (scripts/test-digest.sh
          // locks the ROOT even when it measures a worktree), so any hand
          // verifying its own branch holds it for the length of a run, and the
          // merge is refused for a reason that resolves itself in ~74s.
          //
          // SCHEDULED, NOT SLEPT, and that distinction is the ticket. The retry
          // runs OUTSIDE this call: _autoMergeTicket returns, its link in
          // _mergeChain resolves, _mergePending decrements, and every merge
          // queued behind it proceeds — including the ones that would have
          // succeeded. A sleep here would hold the chain, so one blocked merge
          // would block ALL merges process-wide and _mergePending's QUEUED line
          // would describe a stall as a queue.
          //
          // Bounded in BOTH directions because the lock can be stale in a way
          // isAlive cannot see: a SIGKILLed runner leaves the dir behind, and the
          // pid file has been observed naming a DEAD pid while a different live
          // run held it. So "wait until the holder exits" is not a terminating
          // condition, and only the attempt count and the deadline are.
          const attempt = (retry && retry.attempt) || 0;
          const since = (retry && retry.since) || this._mergeRetryNow();
          const waited = this._mergeRetryNow() - since;
          if (attempt < MERGE_RETRY_MAX_ATTEMPTS && waited < MERGE_RETRY_MAX_WAIT_MS) {
            log.info('ticket', `auto-merge for ${ticketId} deferred: a suite holds ${team.root}'s lock (pid ${holder}) — retry ${attempt + 1}/${MERGE_RETRY_MAX_ATTEMPTS} in ${Math.round(MERGE_RETRY_DELAY_MS / 1000)}s, ${Math.round(waited / 1000)}s waited so far`);
            this._scheduleMergeRetry(() => {
              // The retry re-enters through _queueAutoMerge, not _autoMergeTicket
              // directly: the chain is what keeps two merges off one checkout,
              // and a retry that skipped it would be exactly the overlapping
              // merge the chain exists to prevent.
              try { this._queueAutoMerge(team, ticketId, landedOn, verdictText, { attempt: attempt + 1, since }); }
              catch (e) { log.error('ticket', `auto-merge retry for ${ticketId} failed to requeue: ${e && e.message ? e.message : String(e)}`); }
            }, MERGE_RETRY_DELAY_MS);
            // NOT stamped as a merge error: the board's mergeError field is read
            // as "this ticket needs a human", and a ticket that is merely waiting
            // its turn does not. The exhausted arm below stamps that one.
            //
            // But it IS stamped as WAITING, because the whole retry state lives
            // in the timer closure above and a crash or a reboot in the next ten
            // minutes would otherwise drop the merge with nothing on the board
            // and no DM. `deferred` is what exempts this arm from the finally's
            // clear — set BEFORE the stamp so an exception between the two
            // cannot leave the field set with the flag false.
            deferred = true;
            this._stampMergeWaiting(team, ticketId, 'suite-in-flight');
            return;
          }
          // EXHAUSTED. The escalation is the old one WORD FOR WORD, including the
          // manual merge command, plus what was waited — a retry that gave up
          // quietly would be worse than the terminal refusal it replaced, since
          // the lead would be waiting on a mechanism that had already stopped.
          //
          // WHAT IT MUST NOT SAY IS WHY. This message reports that every sample
          // found the lock held; it does NOT diagnose a wedge. The loop cannot
          // tell one wedged run from several legitimate ones back to back, and
          // it holds evidence AGAINST the wedge reading: `holder` comes from
          // _suiteLockHolder, which returns null for a dead pid, so the pid
          // printed here was verified alive. Naming a wedge over a live pid is
          // the same reasoning scripts/test-digest.sh's refusal was rewritten to
          // refuse — it is what ends in clearing a valid lock and deadlocking
          // two runs.
          fail('suite-in-flight', `a test suite is already running in the root checkout ${team.root} (pid ${holder}) — merging now would rewrite the files under it`,
            `nothing was merged, and the loop will NOT retry — it already retried ${attempt} time${attempt === 1 ? '' : 's'} over ${Math.round(waited / 1000)}s and the lock was held on every sample. That can be one wedged run or several legitimate ones back to back, so check \`ps\` for a live \`node --test\` before concluding anything, and do not clear the lock by hand. To land it by hand: \`git -C ${team.root} merge --no-ff ${branch}\`, then run the suite in ${team.root}. Otherwise re-review the ticket.`);
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
      } finally {
        // Only the defer arm leaves it set. This runs on that arm too — where
        // `deferred` is true and the stamp must SURVIVE — so the clear is
        // conditional, not unconditional.
        if (!deferred) this._stampMergeWaiting(team, ticketId, null);
      }
    },

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
    },

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
    },

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
    },

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
    },

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
    },

    // Solo has no roles, so naming one as a possibility sends the operator
    // looking for a vocabulary that does not exist here.
    _assigneeMissText(team, who) {
      return (team && team.solo)
        ? `"${who}" is not a live session in ${team.name} — with no team, an assignee is a live session name`
        : `"${who}" is neither a team role nor a live seat on ${team.name}`;
    },

    _resolveAssignee(team, who) {
      if (!who) return null;
      if (team.roles && Object.prototype.hasOwnProperty.call(team.roles, who)) return who; // role-addressed
      if (this._teamLiveSeatNames(team.root).includes(who)) return who; // name-addressed (live seat)
      return null;
    },

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
    //
    // A `spawn` ticket therefore degrades like a standing one, and that is
    // deliberate: there is no tree to misroute into, so the reason for the
    // worktree refusal does not apply. The cost is that a one-shot TICKET can be
    // picked up by a second one-shot seat after the first dies — accepted, since
    // the alternative is a ticket nothing can answer for. Second consequence of
    // the same choice, equally intended: _advanceSeat hands a CLOSING spawn seat
    // the next ticket degrading to its role, so accepting the first ticket can
    // archive a seat that is mid-work on a second — recoverable, since unarchiving
    // resumes it.
    //
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
    },

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
    },

    // `replay` marks a REDELIVERY of a spec the seat may already have acted on.
    // Unmarked, the fix trades a silent drop for a silent double-execution: the
    // seat cannot tell a replay from a fresh assignment (that indistinguishability
    // is the whole finding in this ticket's notes), so the marker has to be in the
    // text, not in the caller's head.
    // `onWrite(disposition)` fires when the bytes become DURABLE — released by the
    // queue ('injected') or parked to disk ('parked') — never on the enqueue. A
    // caller that PERSISTS "this seat has been told" must use it rather than the
    // return: `{queued:true}` says only that the text is in the ready loop, so a
    // stamp taken from it survives a write the boot re-render wiped, and the record
    // then suppresses every later redelivery on the strength of it.
    _deliverTicketSpec(team, ticket, specText, fromName, urgent = false, replay = false, respec = false, onWrite = null) {
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
      // ADDITIVE to the line above, never a rewrite of it. `wt.path` is the tree
      // identity every other mechanism uses — claimTree, the suite runner, the
      // merge — so a `WORK IN:` naming a subdirectory would be copied straight
      // into a git command that then operates in the wrong place. The role's area
      // gets its own line instead, and only when the role actually names one.
      // `role || assignee`, the idiom every other read of the ticket's role uses:
      // `role` is set only once the ticket is PINNED to a seat, and before that
      // the role key lives in `assignee`. Reading `role` alone would drop this
      // line on exactly the first delivery, which is the one that matters most.
      // hasOwnProperty-gated because `assignee` is a seat NAME once pinned, and a
      // seat named like an Object.prototype key must not resolve to a function.
      const roleName = (ticket && (ticket.role || ticket.assignee)) || '';
      const roleDef = (team && team.roles && roleName
        && Object.prototype.hasOwnProperty.call(team.roles, roleName)) ? team.roles[roleName] : null;
      // Through the SAME helper the spawn resolver uses, never off `roleDef.cwd`
      // directly. The load path is deliberately lenient, on the promise that a bad
      // value is neutralized at spawn — and this line is a consumer of that promise
      // too. Read raw, a hand-edited `cwd: "../../elsewhere"` would tell the seat
      // its files live OUTSIDE its worktree while the lead's reply simultaneously
      // said the seat was spawned at the root, and `cwd: "/etc"` would degrade to
      // `<wt>/etc`. Both are the "hand copies a path into a command that runs in
      // the wrong place" hazard this whole line exists to prevent.
      const roleCwdRel = this._roleCwdRel(roleDef).rel;
      // The lexical helper is NOT the whole gate: the resolver refuses three more
      // things it cannot see (the directory missing, a symlink realpathing out of
      // the root, a nested team.json owning it), and a seat whose cwd was refused
      // boots at the tree root. Naming an area it was not spawned in is the same
      // hazard as the raw-read one above, so the line rides only on a value the
      // SPAWN accepted. Not covered, deliberately: the resolver's existence and
      // symlink checks run against team.root while this line joins onto the
      // worktree, so a symlink that exists only INSIDE the worktree is unseen —
      // closing that would need a second resolver on the worktree base, which is
      // more than the line is worth.
      const roleCwdHonored = !!roleCwdRel && !!(team && team.root)
        && this._resolveRoleCwd(team, roleDef).fallback === null;
      const areaLine = (roleCwdHonored && ticket && ticket.worktree && ticket.worktree.path)
        ? `YOUR AREA in that tree: ${path.join(ticket.worktree.path, roleCwdRel)} — your role works in "${roleCwdRel}". `
          + `The tree ROOT above stays the path for git commands and for the suite; this is where your files live.\n`
        : '';
      // A `spawn` seat works in the SHARED checkout, which is the one thing its
      // dispatch cannot leave unsaid: it has no tree of its own, so the isolation
      // every other one-shot seat is handed silently does not exist here, and a
      // hand that assumes it would commit onto whatever branch the operator has
      // checked out. ONE line — the head is already ~420 chars and every dispatch
      // spills, so each added line costs the seat a Read turn.
      //
      // Gated on the ROLE's dispatch, not on the absence of a worktree: a standing
      // seat also has no tree, and it is the operator's own long-lived session
      // that already knows where it lives. Same `role || assignee` idiom as above,
      // and hasOwnProperty-gated for the same reason.
      //
      // The tree check is a SECOND condition, not a replacement: the role's mode
      // and the ticket's pointer can disagree (the operator edits a role from
      // `worktree` to `spawn` mid-flight; _taskAssign's mint-failure falls through
      // to the generic delivery with the inherited tree still on the record), and
      // this line would then tell a seat it has no branch three lines under a
      // `WORK IN: … commit to <branch>`. The tree is REAL on those paths — the
      // loop and the accept teardown act on it — so the text yields to the
      // pointer, never the other way round.
      const sharedLine = (roleDef && roleDef.dispatch === 'spawn'
        && !(ticket && ticket.worktree && ticket.worktree.path))
        ? `You are working in the SHARED checkout alongside other seats — you have no worktree and no branch of your own, `
          + `so do tree work only and leave committing to the lead.\n`
        : '';
      // Rendered BESIDE the spec, never into it: `ticket.spec` is what the lead
      // wrote and `respec` is the only thing that replaces it. Shared with the
      // reviewer's scope through _ticketTaskDirRender — see it for why one
      // renderer rather than two agreeing call sites.
      const taskDirLine = this._ticketTaskDirRender(team, ticket).line;
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
      const r = this._gatedDeliver(seat, fromName, `${head}${wtLine}${areaLine}${sharedLine}${taskDirLine}${closeLine}${specText}`, urgent,
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
        // Both hooks ride ONE onWrite, and the arm goes first: it is the mechanism
        // that catches a write which never reaches a turn, so a throw out of a
        // caller's stamp must not be able to skip it.
        // The `finally` is what keeps the two hooks independent in BOTH
        // directions. The inner try already stops a caller's stamp skipping the
        // arm; without this one an arm that throws (_broadcast inside
        // _oweDisplacedSpec is the reachable case) skips the caller's hook — and
        // that hook is the drain's only in-flight release, so the drain latches
        // shut for the life of the seat. That is the outcome _drainOwedSpec's own
        // comment calls strictly worse than the bug it guards.
        // The catch LOGS rather than swallowing: every `fire` call site guards
        // itself, so a throw here reaches nobody. The write still lands, but no
        // latch is armed — the spec goes out unwatched, which is the one fault
        // mode this mechanism presupposes. It must not be invisible too.
        (disposition) => {
          try { this._armSpecConfirm(seat, ticket.id, disposition); }
          catch (e) { log.error('intent', `spec latch arm failed for ${seat} on ${ticket.id}: ${e.message}`); }
          finally { if (onWrite) { try { onWrite(disposition, seat); } catch {} } }
        });
      if (!r || r.error) return { undelivered: true };
      if (r.parked) return { parked: r.parked, reason: r.reason || null };
      if (r.held) return { held: true, reason: r.held };
      return { queued: true };   // handed to the queue; the write comes later
    },

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
    //
    // `redirect` present switches the latch to kind 'redirect' (a rejection or a
    // follow-up must-fixes sent back to a working seat) and carries the text to
    // rebuild it with. The four properties that make the spec retry safe hold
    // verbatim at those sites — see _redirectDeliveryText — so this is one latch
    // with two kinds, not two latches.
    _armSpecConfirm(seatName, ticketId, disposition, redirect = null) {
      const s = this.sessions.get(seatName);
      if (!s || !s.agentType || s._dead) return;
      const kind = redirect ? 'redirect' : 'spec';
      if (disposition !== 'injected') {
        // A PARK ends this ticket's displacement episode, so the redelivery budget
        // is released here as it is at the two receipt exits. Keyed on THIS call's
        // ticket+kind rather than on the latch cleared below, and that is the whole
        // fix: `_drainOwedSpec` refuses to run while `_specUnconfirmed` is set, so
        // a redelivery that parks from a busy seat or a held dm finds the slot
        // EMPTY and the match below false. A prune placed inside that guard would
        // cover only the fire-time divert — which arms and then clears its own
        // latch — and would be inert for exactly the population this repairs.
        this._pruneOwedSpent(s, { ticketId, kind });
        // A late divert can park text this already armed over — drop the latch
        // rather than leave it watching for an edge that will never come. Matched
        // on kind too: a parked REDIRECT must not silently retire a spec latch
        // that is still legitimately watching an earlier unconsumed dispatch.
        if (s._specUnconfirmed && s._specUnconfirmed.ticketId === ticketId
            && s._specUnconfirmed.kind === kind) {
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
      // The retry budget SURVIVES the replacement when it is the same ticket AND
      // the same kind: the redelivery re-enters here through the write it
      // triggered, and a budget reset there would make the one-shot retry
      // unbounded. Kind is part of the match because a spec and a later redirect
      // on ONE ticket are two different unconsumed writes — carrying a spent spec
      // budget onto the redirect would deny the redirect the single retry this
      // ticket exists to give it.
      //
      // LABEL is deliberately not part of the key. Two redirects on one ticket
      // (`rejected`, then `more must-fixes`) share a budget, and the second's
      // leading Ctrl-U destroys the first's draft anyway — so tracking them
      // separately would promise a discrimination the PTY cannot deliver. That
      // mirrors the spec/respec discipline exactly; do not add it in either
      // direction without changing REPLACE-not-stack first.
      const prior = s._specUnconfirmed;
      const retried = !!(prior && prior.ticketId === ticketId && prior.kind === kind && prior.retried);
      // A prior latch for a DIFFERENT ticket is not a stale watcher being tidied
      // up — it is a loss that is already COMPLETE at this line, and knowable here
      // and nowhere else. This write's leading Ctrl-U has destroyed that ticket's
      // unsubmitted draft, and the latch that was the only thing watching for it is
      // about to be overwritten by the assignment below. Left there, the seat is
      // silent on a ticket it was never told about, and the only mechanism that
      // still speaks is the stall watchdog — which reports it as a STALLED SEAT.
      // That is the misreading _checkSpecConfirm's escalation exists to retire.
      //
      // So this is not a case for a second watcher: there is nothing left to
      // observe. It is owed a redelivery, and REPLACE-not-stack above is untouched
      // — at most one latch is ever live, so the single-composer argument and
      // t349's `thinking` => no-latch invariant both still hold.
      if (prior && prior.ticketId !== ticketId) this._oweDisplacedSpec(s, prior);
      clearTimeout(s._specConfirmTimer);
      // Where this seat's transcript ended when the write went out — the anchor the
      // attribution probe searches FROM. Taken here and not at the deadline because
      // here is write time (this runs inside `produce`), which is the only instant
      // that separates "already in the transcript" from "consumed because of this
      // write". A respawned seat's transcript already holds THIS ticket's marker
      // from the incarnation that died; without the anchor every later turn matches
      // it and the latch clears over a spec the seat never re-received.
      // A seat with NO transcript yet anchors at 0, not at -1. That is the whole
      // t408 shape — a freshly minted seat has written nothing when its spec goes
      // out — and treating "no file" as an unknown baseline would answer "cannot
      // say" for every fresh dispatch, which is precisely the population this
      // mechanism exists to protect. Anchoring at 0 is also exactly right there:
      // with no prior transcript there is no stale marker to false-match, so the
      // unanchored search is the correct one.
      const size = this._seatTranscriptSize(seatName);
      const since = size < 0 ? 0 : size;
      s._specUnconfirmed = redirect
        ? { ticketId, kind, at: Date.now(), retried, since, ...redirect }
        : { ticketId, kind, at: Date.now(), retried, since };
      this._armSpecConfirmTimer(s);
    },

    // The bytes of a seat-bound ticket REDIRECT — a rejection or a follow-up set
    // of must-fixes handed back to the seat that is working the ticket.
    //
    // One builder for the first delivery AND the redelivery, so a replay is the
    // first copy plus a head rather than a second rendering of it that can drift
    // from it. With `replay` false the head is empty and the bytes are exactly
    // what each call site wrote before this existed.
    //
    // The head does the same job as _deliverTicketSpec's: the seat may be holding
    // an unsubmitted copy of the first write, and nothing else in the text lets it
    // tell a redelivery from a second, different rejection. Read as the latter it
    // would go looking for must-fixes that were never filed.
    _redirectDeliveryText(ticketId, label, reason, replay = false) {
      const head = replay
        ? `[ticket ${ticketId} ${label} REDELIVERY] this was already sent to you once and no turn followed, so `
          + `you may already be holding an unsubmitted copy of it — if you have already acted on these points, `
          + `keep going rather than starting them again.\n`
        : '';
      return `${head}[ticket ${ticketId} ${label}] ${ticketCloseLine(ticketId)}${reason}`;
    },

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
    },

    // ── the displaced-latch queue ─────────────────────────────────────────────
    //
    // A queue of ONE-SHOT REDELIVERIES, drained strictly serially — deliberately
    // not a set of parallel latches. Two redeliveries in flight reproduce the bug
    // this fixes: the second's Ctrl-U destroys the first's draft.
    //
    // The budget is `retried`, the same field and the same meaning as everywhere
    // else, read from the DISPLACED latch's own snapshot. A ticket whose one
    // redelivery was already spent gets no second one from here — it escalates,
    // because two writes with no turn is not a lost write and a third copy would
    // not fix it. `_specOwedSpent` carries that bound across the replacement: the
    // redelivery arms a FRESH latch whose `retried` is false (different ticket in
    // the slot, so nothing carries), and without the set a seat under repeated
    // dispatch would displace-and-redeliver the same ticket forever.
    //
    // The fresh latch keeping its own retry is correct rather than generous: from
    // the SEAT's side the destroyed copy never arrived, so the redelivery is its
    // first, the latch's retry is its second, and the escalation lands on the same
    // two-writes-no-turn rule as an undisplaced dispatch.
    _oweDisplacedSpec(session, prior) {
      const key = `${prior.ticketId}:${prior.kind}`;
      const spent = prior.retried || !!(session._specOwedSpent && session._specOwedSpent.has(key));
      const what = prior.kind === 'redirect'
        ? `${prior.label || 'rejection'} for ${prior.ticketId}` : `spec for ${prior.ticketId}`;
      if (spent) {
        let team; try { team = resolveTeam(session.cwd); } catch { team = null; }
        log.error('intent', `${what} was displaced on ${session.name} with its redelivery budget spent — escalating`);
        if (team) {
          this._escalateTicket(team, prior.ticketId,
            prior.kind === 'redirect' ? 'redirect-undelivered' : 'spec-undelivered',
            `${session.name} never started a turn after ${what} was written, and a later dispatch to the same seat `
            + `cleared its composer — it is not stalled on the work, it was never told`,
            'the redelivery budget for this ticket was already spent, so no further copy was written');
        }
        return;
      }
      if (!session._specOwed) session._specOwed = [];
      // One entry per ticket+kind: a third dispatch displacing the SAME owed
      // ticket again describes the same single loss, and two entries would drain
      // as two writes of one spec.
      if (session._specOwed.some((o) => `${o.ticketId}:${o.kind}` === key)) return;
      session._specOwed.push(prior);
      log.warn('intent', `${what} on ${session.name} was displaced by a dispatch of ${session.name}'s next ticket — queued for redelivery`);
      this._broadcast('ipc-message', {
        ts: Date.now(), from: 'clodex', to: session.name,
        kind: 'spec-displaced',
        body: `ticket ${prior.ticketId} was written but its draft was cleared by a later dispatch — queued for redelivery`,
      });
      if (!session._specOwedTimer) this._armSpecOwedTimer(session);
    },

    // The other end of `_specOwedSpent`. The set must outlive the LATCH (that is
    // its whole job — the redelivery arms a fresh latch whose `retried` is false)
    // but it must not outlive the EPISODE, or a ticket dispatched to one seat
    // twice over a long session gets one redelivery ever instead of one each time
    // its draft is destroyed. Unpruned it grew for the life of the seat.
    //
    // THE RULE: the budget is spent on a DESTROYABLE write, and released once that
    // write is no longer at risk. The set does not exist to prove the seat READ
    // anything — it exists to stop a third copy entering a composer that swallowed
    // two (_checkSpecConfirm's escalation says so in as many words). So the three
    // release sites are the three ways a write stops being destroyable:
    //   receipt, attributed turn      (_emitActivity)
    //   receipt, deadline re-probe    (_checkSpecConfirm)
    //   park                          (_armSpecConfirm's non-injected branch)
    // The park site fires for a FRESH dispatch that parks too, not only a
    // redelivery, and that is safe rather than merely harmless: a parked arm
    // creates no latch, so nothing is displaceable until some later INJECTED write
    // arms one — and that write is a genuine new destroyable copy.
    // Receipt qualifies because the seat provably holds the write. A PARK qualifies
    // for a different reason and just as strongly: the bytes are a file on disk, no
    // later Ctrl-U can destroy them, and the park's own drains own them from there.
    // Reading the rule as "receipt and nothing else" is what left every ticket whose
    // first repair parked escalating on a budget spent in the previous episode.
    //
    // Deliberately NOT called on the escalation exits. An escalation is the
    // opposite finding — two writes produced no turn, with the second still at risk
    // in the composer — and restoring the budget there would let the next
    // displacement spray a third copy at a composer that has demonstrably swallowed
    // both, against the rule the whole latch rests on.
    // The lead's re-dispatch after an escalation is not stranded by that: if the
    // seat turns, this prunes and the next episode is fresh; if it stays silent,
    // escalating again is the correct outcome.
    //
    // Keyed on ONE ticket+kind, never a wholesale clear. A turn taken over t2 is no
    // evidence at all about the t1 draft that t2's Ctrl-U destroyed, and t1's key is
    // the one thing bounding a ticket the seat has still never seen.
    //
    // At the receipt sites this rides the latch clear rather than re-testing the
    // probe for `=== true`, and the three-valued care the drain's drop needs is
    // inverse in direction here: there a wrong YES SWALLOWS a real redelivery, while
    // a generous prune at worst grants some future episode the same single budget an
    // undisplaced dispatch already gets. It cannot reopen the loop either — a
    // redelivery loop needs a LIVE latch to displace, and every releasing path has
    // just cleared one or (the park) armed none at all.
    _pruneOwedSpent(session, u) {
      if (!session._specOwedSpent || !u) return;
      session._specOwedSpent.delete(`${u.ticketId}:${u.kind}`);
      if (!session._specOwedSpent.size) session._specOwedSpent = null;
    },

    _armSpecOwedTimer(session) {
      session._specOwedTimer = setTimeout(() => {
        session._specOwedTimer = null;
        // Same hazard as _armSpecConfirmTimer's: the drain reaches real fs work
        // through the delivery path, and a throw out of a setTimeout callback in
        // the app's main process is an unhandled exception in the host.
        try { this._drainOwedSpec(session); }
        catch (e) { log.error('intent', `displaced-spec drain failed for ${session.name}: ${e.message}`); }
      }, SPEC_CONFIRM_MS);
      if (session._specOwedTimer.unref) session._specOwedTimer.unref();
    },

    // Exactly ONE redelivery per pass, and never while a latch is live. That pair
    // IS the serialization: a live latch means an unconfirmed write already owns
    // the composer, and `queued` only promises the bytes are in the ready loop —
    // so draining a second entry behind either one puts two Ctrl-U's in flight and
    // reproduces the collision.
    //
    // Waiting on a live latch is uncapped for the same reason _checkSpecConfirm's
    // permission-dialog re-arm is: the wait is bounded in every case the latch can
    // resolve itself (redeliver, then escalate, both of which clear it), and the
    // one case it is not — a seat sitting on a permission dialog — is precisely
    // the one where a write must not be attempted at all.
    _drainOwedSpec(session) {
      const queue = session._specOwed;
      if (!queue || !queue.length) return;
      if (session._dead || !this.sessions.has(session.name)) { session._specOwed = []; return; }
      // A live latch is not the only thing that owns the composer. `queued` says
      // the bytes are in the ready loop, not that they have been written, and the
      // gates ahead of the write are far longer than this timer: INJECT_QUIET_MAXWAIT
      // is 5 minutes against a 90s re-arm. So a redelivery still waiting in the
      // gates arms NO latch yet, and a drain that tested only `_specUnconfirmed`
      // would send a second unit in behind it — two Ctrl-U's in flight, which is
      // the collision this whole mechanism exists to repair, reproduced by its own
      // fix. The in-flight flag covers exactly that window and is cleared from the
      // WRITE, where the latch takes over.
      if (session._specUnconfirmed || session._specOwedInFlight) { this._armSpecOwedTimer(session); return; }
      // PEEKED, not shifted. The entry is consumed only once this pass has
      // committed to disposing of it: a transient resolveTeam failure below must
      // leave the queue intact, because a shift there drops the ticket on the
      // floor and hands it back to the stall watchdog — the "stalled seat"
      // misdiagnosis this ticket exists to retire, re-created inside its own
      // repair. _checkSpecConfirm deliberately does not consume its latch in the
      // same situation; this matches it structurally rather than by compensation.
      const u = queue[0];
      const rearm = () => { if (queue.length) this._armSpecOwedTimer(session); };
      const isRedirect = u.kind === 'redirect';
      const step = isRedirect ? 'redirect-undelivered' : 'spec-undelivered';
      const what = isRedirect ? `${u.label || 'rejection'} for ${u.ticketId}` : `spec for ${u.ticketId}`;
      let team; try { team = resolveTeam(session.cwd); } catch { team = null; }
      // Still queued, and the timer is re-armed unconditionally — the retry is the
      // whole point of not consuming it.
      if (!team) { this._armSpecOwedTimer(session); return; }
      queue.shift();
      const ticket = ticketsStore.load(team.root).find((t) => t.id === u.ticketId);
      // The three drops, taken with _checkSpecConfirm's own tests rather than new
      // ones that could disagree with it: closed while we waited, reassigned to a
      // live seat that is already working it, or resolving to nobody at all.
      if (!ticket || ticket.state !== 'open') { rearm(); return; }
      // The same second look at the transcript _checkSpecConfirm takes before
      // spending a redelivery, and for the same race: a wire-routed seat's
      // `turn.started` edge can beat the CLI's append, so the latch stays armed
      // over a spec the seat DID consume, and the seat returns to idle without
      // re-probing. Without this the displaced entry redelivers a spec the seat
      // already holds. The snapshot's `since` anchors it identically, so a
      // respawn's stale copy cannot answer for this write.
      //
      // `=== true` for the same reason as there, not as a style: `false` is a
      // positive finding (readable, not consumed) and `null` is a probe that
      // could not answer, and only a definite YES may drop a redelivery. A
      // truthy test would let an unreadable transcript swallow a real one.
      // Logged like the holder branch below. This is the only drop taken on a
      // HEURISTIC (a substring match that _seatTranscriptHas's own header warns can
      // false-positive), and an owed entry can wait behind a live latch for an
      // arbitrarily long time, accumulating transcript that may mention the ticket
      // from a non-delivery source. A false true here re-creates the original
      // silent loss, so it must not also be an invisible one.
      if (this._seatTranscriptHas(session.name, u.ticketId, u.since) === true) {
        log.info('intent', `displaced ${isRedirect ? 'redirect' : 'spec'} for ${u.ticketId} dropped at ${session.name}: its transcript shows the seat received it`);
        rearm();
        return;
      }
      const holder = this._ticketAssigneeSeat(team, ticket);
      if (holder && holder !== session.name) {
        log.info('intent', `displaced ${u.kind === 'redirect' ? 'redirect' : 'spec'} for ${u.ticketId} dropped at ${session.name}: the ticket now resolves to ${holder}`);
        rearm();
        return;
      }
      if (!holder) {
        log.error('intent', `${what} is stranded — displaced at ${session.name} and the ticket now resolves to no live seat`);
        this._escalateTicket(team, u.ticketId, step,
          `${session.name} was written to and never started a turn, a later dispatch cleared its composer, `
          + `and the ticket no longer resolves to any live seat`,
          `the ${isRedirect ? 'rejection' : 'spec'} was injected once; no redelivery was attempted because there is nobody to deliver to`);
        rearm();
        return;
      }
      (session._specOwedSpent || (session._specOwedSpent = new Set())).add(`${u.ticketId}:${u.kind}`);
      log.warn('intent', `redelivering ${what} to ${session.name} — its first copy was destroyed by a later dispatch`);
      this._broadcast('ipc-message', {
        ts: Date.now(), from: 'clodex', to: session.name,
        kind: isRedirect ? 'redirect-unconfirmed' : 'spec-unconfirmed',
        body: `ticket ${u.ticketId} displaced by a later dispatch — redelivering`,
      });
      // Cleared on EVERY disposition, not just `injected`. A parked redelivery is
      // durable and needs no watcher, so nothing else would ever clear this — the
      // flag would latch the drain shut for the life of the seat and strand every
      // later owed entry in silence, which is strictly worse than the bug it
      // guards. The flag's job is only to cover the enqueue-to-write gap.
      session._specOwedInFlight = true;
      const done = () => { session._specOwedInFlight = false; };
      // Through the EXISTING replay path, not a second rendering of the same
      // bytes: the REPLAY head is what lets the seat tell a redelivery from a
      // fresh assignment, and a copy of the text here could drift from it.
      const r = isRedirect
        ? this._deliverRedirectReplay(team, ticket, session.name, u, done)
        : this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true, true, false, done);
      if (!r || !(r.queued || r.parked)) {
        // A delivery that reached nobody arms no latch and fires no onWrite, so
        // the flag has no other way home.
        session._specOwedInFlight = false;
        const why = (r && (r.reason || (r.held && 'held') || (r.undelivered && 'no live seat resolves')))
          || 'unknown delivery failure';
        log.error('intent', `redelivery of displaced ${u.ticketId} to ${session.name} reached nobody (${why}) — escalating`);
        this._escalateTicket(team, u.ticketId, step,
          `${session.name} never started a turn after ${what} was written, a later dispatch cleared its composer, `
          + `and the redelivery could not be handed to a seat: ${why}`,
          `the ${isRedirect ? 'rejection' : 'spec'} was injected once and a redelivery was attempted after it was displaced`);
      }
      rearm();
    },

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
    },

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
    },

    // Has this seat ever written a turn? The link is created at spawn and its
    // target only when the CLI writes — so a link that resolves to nothing is a
    // seat that has produced nothing, and an unreadable/absent link is the same
    // answer for a weaker reason. Every failure reads as "no transcript", which is
    // the direction that ALARMS, so a broken probe is loud rather than silent —
    // the opposite of `_stallEvidence`'s policy, and deliberately: there an absent
    // field degrades an alarm that fires anyway, here it IS the alarm.
    _seatHasTranscript(name) {
      return this._seatTranscriptSize(name) > 0;
    },

    // The same probe, read as a NUMBER instead of a boolean. Split out rather
    // than duplicated: t384's liveness test needs growth between two sweeps, and
    // a second resolver would be free to disagree with this one about where a
    // seat's transcript is — silently, and in the direction that alarms.
    //
    // -1, not 0, for an unreadable link. 0 is a real size (a seat that has
    // written nothing), and collapsing the two makes an fs error look like a
    // seat that produced nothing, which is a claim this cannot support.
    _seatTranscriptSize(name) {
      try {
        const link = pathFor(REGISTRY_DIR, name, 'transcript');
        return fs.statSync(fs.realpathSync(link)).size;
      } catch { return -1; }
    },

    // Has the dispatch for `ticketId` reached this seat's INPUT since byte `from`?
    // The transcript records what the CLI actually consumed, so a spec that was
    // written and wiped is absent from it while one the seat read — injected, or
    // drained from a park by the out-of-process hook — is present. That is what
    // makes a turn attributable to a particular write.
    //
    // `from` is NOT an optimisation, it is the correctness of the whole probe on a
    // respawn. A `--resume` seat's transcript ALREADY contains this ticket's marker
    // from the previous incarnation — that is how it got the spec the first time —
    // so an unanchored search attributes every later turn to the stale copy, and
    // the replay path (the one this ticket's stamp fix touches) is exactly where
    // that bites: t156's whole case is a respawned seat. Callers pass the size
    // captured when the latch armed, which _armSpecConfirm takes at WRITE time —
    // after any resume content exists and before this write can be consumed.
    //
    // Matched on the dispatch MARKER, never the bare id: ids are monotonic, so
    // every low id is a prefix of ~10 live higher ones and `includes('t40')` is
    // true of a transcript that merely mentions t408 — a cross-reference in another
    // spec, a lead dm, a review scope. Discriminating between those is the one job
    // this function has. Two forms because a dispatch pointer line carries either:
    // `[ticket tN]` plain, or `[ticket tN ` followed by REPLAY / RESPEC / a
    // redirect label.
    //
    // Reads a bounded tail, so a seat with a hundred-megabyte transcript does not
    // cost that on a 90s timer. Clamped to `from`, never behind it.
    //
    // Three-valued, and the split carries weight. `false` is a POSITIVE finding —
    // the transcript is readable and this write is not in it — which is what keeps
    // the latch armed. `null` is reserved for a probe that cannot answer at all (no
    // transcript, unreadable link), where the caller must fall back to trusting the
    // turn rather than manufacture a redelivery out of a blind spot. Collapsing the
    // two surrenders both shapes this exists for: a fresh seat (anchored at 0, empty
    // transcript) and a wire-routed edge that beat the CLI's append.
    _seatTranscriptHas(name, ticketId, from = 0, tailBytes = 1 << 20) {
      let fd;
      try {
        const link = pathFor(REGISTRY_DIR, name, 'transcript');
        const target = fs.realpathSync(link);
        const size = fs.statSync(target).size;
        // Readable, and nothing appended since the write: that is a definite NO,
        // not an unknown. The seat cannot have consumed a write that produced no
        // transcript bytes, and answering "cannot say" here would surrender the
        // two shapes this mechanism is for — a fresh seat (anchored at 0, empty
        // transcript) and a wire-routed edge that beat the CLI's append.
        if (size <= from) return false;
        const start = Math.max(from, size - tailBytes);
        const len = size - start;
        const buf = Buffer.alloc(len);
        fd = fs.openSync(target, 'r');
        fs.readSync(fd, buf, 0, len, start);
        const tail = buf.toString('utf8');
        return tail.includes(`[ticket ${ticketId}]`) || tail.includes(`[ticket ${ticketId} `);
      } catch { return null; }
      finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
    },

    // Cleared by a non-idle edge that is ATTRIBUTABLE to this write (see
    // _emitActivity): reaching a turn over the delivered text means the seat
    // submitted, and submitting is exactly what a lost write prevents. A turn the
    // transcript cannot attribute leaves the latch armed, so this still fires for a
    // seat that turned for something else — t408's shape.
    //
    // The three shapes that must NOT alarm are silent for structural reasons rather
    // than tuned ones:
    //   - a seat thinking for minutes on its first turn went non-idle to think over
    //     text its transcript holds, so the latch was gone seconds after the write;
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
      // Second look at the transcript before spending a redelivery. The activity
      // edge that would have cleared this latch can RACE the CLI's append on a
      // wire-routed seat (see _emitActivity), so a spec that really was consumed
      // can still be sitting here armed; by the deadline the write is long since on
      // disk, which makes this the reliable read and the edge the eager one.
      // Anchored identically, so a respawn's stale copy cannot answer for it.
      if (this._seatTranscriptHas(session.name, u.ticketId, u.since) === true) {
        // Receipt, so the episode ENDS here too — same prune as the activity edge's
        // (_emitActivity), for the same reason. This is the RARER of the two
        // confirm exits: a seat that consumes its spec normally clears the latch at
        // the turn and this timer never runs. Pruning only here would leave the fix
        // inert in the common case.
        this._pruneOwedSpent(session, u);
        session._specUnconfirmed = null;
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
        log.info('intent', `${u.kind === 'redirect' ? 'redirect' : 'spec'} latch for ${u.ticketId} dropped at ${session.name}: the ticket now resolves to ${holder}`);
        session._specUnconfirmed = null;
        return;
      }
      // Resolves to NOBODY — the assignee died inside the window and nothing took
      // its role. Dropping this quietly alongside the reassignment case would be
      // this ticket's own premise failing inside its own fix: an open ticket whose
      // spec reached no one, and no one told.
      // Every arm below reports in the vocabulary of what was actually lost. A
      // redirect reported as an undelivered "spec" is the misattribution this
      // extension exists to retire — the lead hears "the seat never got its task"
      // about a seat that has been working the ticket for an hour.
      const isRedirect = u.kind === 'redirect';
      const step = isRedirect ? 'redirect-undelivered' : 'spec-undelivered';
      const what = isRedirect ? `${u.label || 'rejection'} for ${u.ticketId}` : `spec for ${u.ticketId}`;
      const wrote = isRedirect ? `the ${u.label || 'rejection'} was written` : 'its spec was written';

      if (!holder) {
        session._specUnconfirmed = null;
        log.error('intent', `${what} is stranded — ${session.name} never started a turn and the ticket now resolves to no live seat`);
        this._escalateTicket(team, u.ticketId, step,
          `${session.name} never started a turn after ${wrote}, and the ticket no longer resolves to any live seat`,
          `the ${isRedirect ? 'rejection' : 'spec'} was injected once; no redelivery was attempted because there is nobody to deliver to`);
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
        log.warn('intent', `${what} unconfirmed on ${session.name} after ${SPEC_CONFIRM_MS / 1000}s (no turn started) — redelivering once`);
        this._broadcast('ipc-message', {
          ts: Date.now(), from: 'clodex', to: session.name,
          kind: isRedirect ? 'redirect-unconfirmed' : 'spec-unconfirmed',
          body: `ticket ${u.ticketId} ${isRedirect ? `${u.label || 'rejection'} written` : 'spec written'} but no turn started — redelivering`,
        });
        // Marked as a replay: the seat may be holding an unsubmitted copy, and it
        // must not read the second one as a second ticket.
        // The redirect rebuilds from the latch's own snapshot of the text, not
        // from the ticket record: the reason a rejection carries is not persisted
        // anywhere on the record (only `reworkRound` is), so the snapshot IS the
        // only source. It re-arms through the same onWrite hook, which is what
        // makes the second window below reachable.
        const r = isRedirect
          ? this._deliverRedirectReplay(team, ticket, session.name, u)
          : this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true, true);
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
          this._escalateTicket(team, u.ticketId, step,
            `${session.name} never started a turn after ${wrote}, and the redelivery could not be handed to a seat: ${why}`,
            `the ${isRedirect ? 'rejection' : 'spec'} was injected once and a redelivery was attempted after the confirmation window`);
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
      log.error('intent', `${what} still unconfirmed on ${session.name} after a redelivery — escalating`);
      // Spelled out for the redirect, because the lead's default reading of a
      // silent seat on an open ticket is "stalled seat" and the whole value of
      // watching this path is replacing that guess with what actually happened.
      const evidence = isRedirect
        ? `${session.name} never saw the ${u.label || 'rejection'}: it was written twice and the seat started no turn `
          + `(no activity for ${Math.round((Date.now() - u.at) / 1000)}s). It is not stalled on the work — it was never told.`
        : `${session.name} was written to twice and never started a turn (no activity for ${Math.round((Date.now() - u.at) / 1000)}s after dispatch)`;
      this._escalateTicket(team, u.ticketId, step, evidence,
        `the ${isRedirect ? 'rejection' : 'spec'} was injected once and redelivered once after the confirmation window`);
    },

    // The redirect's redelivery. Mirrors _deliverTicketSpec's contract exactly —
    // same return shape, same arm-on-write hook — because _checkSpecConfirm's
    // retry arm reads that shape to decide between escalating, standing down, and
    // re-arming, and a second shape there would need a second copy of that logic.
    //
    // Re-resolves the seat rather than trusting the latch: the caller has already
    // established the ticket still resolves to this session, and resolving again
    // here would be a second answer to a settled question that could disagree.
    // `onWrite(disposition)` mirrors _deliverTicketSpec's, for the same reason and
    // with the same ordering guarantee: the arm goes FIRST, so a throw out of a
    // caller's hook cannot skip the mechanism that catches an unconsumed write.
    _deliverRedirectReplay(team, ticket, seatName, u, onWrite = null) {
      const text = this._redirectDeliveryText(ticket.id, u.label, u.reason, true);
      const r = this._gatedDeliver(seatName, u.from || 'clodex-team', text, true,
        `[ticket ${ticket.id} ${u.label} REDELIVERY] close with ${ticketCloseVerb(ticket.id)}`,
        // Same `finally` as _deliverTicketSpec's, same reason: an arm that throws
        // must not strand the caller's in-flight flag set forever.
        (disposition) => {
          try {
            this._armSpecConfirm(seatName, ticket.id, disposition,
              { label: u.label, reason: u.reason, from: u.from });
          } catch (e) { log.error('intent', `redirect latch arm failed for ${seatName} on ${ticket.id}: ${e.message}`); }
          finally { if (onWrite) { try { onWrite(disposition); } catch {} } }
        });
      if (!r || r.error) return { undelivered: true };
      if (r.parked) return { parked: r.parked, reason: r.reason || null };
      if (r.held) return { held: true, reason: r.held };
      return { queued: true };
    },

    _ticketDeliverySuffix(d, assignee) {
      if (d.undelivered) return ` — NOTE: no live seat for "${assignee}" yet; spec not delivered (reassign or wait for it to spawn)`;
      if (d.held) return ` — NOTE: spec NOT delivered (${d.reason || 'held'}); the seat cannot be parked for, so it has not seen the spec — re-send when it clears`;
      if (d.parked) return ` — NOTE: spec parked, not injected (${d.reason || 'held'}); it drains on the seat's next turn`;
      return '';
    },

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
    },

    // Hand a seat its next open ticket when it closes one: the COMPLETION edge has no
    // other trigger, and a seat holding a queue otherwise goes idle until a human
    // pokes it.
    // Takes the closed TICKET, not its id: the id alone cannot answer the started
    // test below, and both callers hold the record already.
    // `closed.id` is redundant as the exclusion on both current callers (each stamps
    // its terminal state and SAVES before calling, so the state filter already
    // excludes it) — kept because that is an ordering ACCIDENT, not a property of the
    // helper: move the advance above the save and without it the seat is handed back
    // what it finished.
    //
    // An UNSTARTED closed ticket advances nobody. The seat here is resolved from the
    // ticket being closed, and for a backlog ticket sitting on a ROLE that resolver
    // returns whichever seat holds the role — a seat that never had this ticket and
    // is not freed by closing it. There is no completion edge, so the "seat went
    // idle" argument above does not apply, and the head it would push is whatever
    // that seat is already mid-work on. Closing an unstarted backlog ticket then
    // redelivers an unrelated in-flight spec to a working seat.
    // The test is on the CLOSED ticket, never on the candidate: `_openTicketsFor`
    // already carries its own `ticketStarted` term for the other direction.
    //
    // This does NOT cover closing a STARTED sibling: the seat is genuinely freed by
    // that close, so the advance runs, and its head may be the ticket the seat is
    // still mid-work on. Left deliberately, made safe by the REPLAY marking below
    // rather than by suppression. The narrower "exclude what the seat is already
    // working" fix is not implementable here: nothing on the record says which
    // ticket a seat currently holds. `deliveredTo` is the only such stamp and it is
    // written ONLY by `_replayOpenTickets`, never by start/assign/advance, so it is
    // absent on exactly the tickets this would need to test. Adding a write for it
    // is a lifecycle change, not a fix to this function.
    _advanceSeat(team, seatName, closed) {
      if (team && team.solo) return null;
      if (!ticketStarted(closed)) return null;
      const next = this._openTicketsFor(team, seatName, closed && closed.id)[0];
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
      // Marked as a REPLAY. The advance is the only dispatch a queued ticket gets,
      // but it is not always its FIRST delivery: `start` and `assign` both deliver
      // on dispatch, and `_openTicketsFor` only returns tickets that have started —
      // so every ticket reachable here has already had its spec sent once. Unmarked,
      // the seat cannot tell this from a fresh dispatch, and a hand following its
      // brief compacts and starts clean over work already in flight.
      this._deliverTicketSpec(team, next, next.spec, 'clodex-team', true /* urgent */, true /* replay */);
      log.info('intent', `seat ${seatName} advanced to ${next.id} after closing ${closed && closed.id}`);
      return next;
    },

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
        // The stamp rides the WRITE, not this return, which is what
        // _deliverMessage's own contract requires of any caller that PERSISTS
        // "this seat has been told". `queued` only means the bytes entered the
        // inject queue: they sit in the ready loop behind the boot-readiness gate
        // (INJECT_BOOT_MAXWAIT) and the quiet gate (INJECT_QUIET_MAXWAIT, 5min), and
        // a seat that dies in those gates is never written to at all — yet the
        // record said delivered, and a stamped ticket is never replayed again.
        //
        // This does NOT by itself rescue a write the CLI's boot re-render wipes:
        // those bytes really were written, so the hook fires and the stamp is taken.
        // The defence there is the confirmation latch, which no longer stands down
        // for a turn the transcript cannot attribute to this spec — see
        // _checkSpecConfirm. Two mechanisms, two different losses.
        //
        // Deferring the stamp cannot lose one: 'injected' and 'parked' are both
        // durable, and every non-durable outcome (`held`, `undelivered`) never
        // fires the hook at all — which is exactly the set that must NOT stamp.
        //
        // Loaded INSIDE the hook, not out here, and for the reason the old inline
        // load already gave: the hook runs later than this loop (the queue writes
        // past its gates), so a snapshot taken now would be stale by the time it
        // saved and would clobber a concurrent clodex-team write.
        const stamp = () => {
          const tickets = ticketsStore.load(team.root);
          const rec = tickets.find((x) => x.id === t.id);
          if (!rec) return;
          // Re-checked HERE, not at the decision above: this hook fires at WRITE
          // time, which the queue's gates put up to INJECT_QUIET_MAXWAIT (5min)
          // later, and reassignment is the documented recovery for a silent seat —
          // so a hand-off landing inside that window is reachable, not theoretical.
          // Stamping anyway writes `deliveredTo = this seat` against a pin naming
          // another, and nothing self-heals it: `_repinTicketToSeat` bails on
          // pinned-and-live. Dropping the stamp is the safe direction — the stamp
          // only SUPPRESSES redelivery, so losing it costs one REPLAY-marked
          // re-send, while a wrong one suppresses the replay of a seat that no
          // longer holds the ticket and hands the cost falsifier a disagreement
          // that unknowns-out an attribution which was in fact clean. The same
          // holder check _checkSpecConfirm uses to drop a latch on a reassigned
          // ticket. Returning before the re-pin too: whatever made the other seat
          // the holder re-pinned already, and this replay delivered to nobody it
          // should record.
          if (this._ticketAssigneeSeat(team, rec) !== session.name) {
            log.info('intent', `replay stamp for ${t.id} dropped at ${session.name}: the ticket now resolves elsewhere`);
            return;
          }
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
        };
        const r = this._deliverTicketSpec(team, t, t.spec, 'clodex-team', true, true, false, stamp);
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
        return true;
      }
      return !held;
    },

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
    },

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
    },

    // What dispatching this ticket DOES: `{ mode, def }`, mode being
    // 'standing' | 'spawn' | 'worktree'. ONE resolver answers the whole question
    // — a second one beside it (`_ticketSpawnRole`) would be two sources that must
    // agree forever, which is the shape the role-field bar refuses.
    //
    // Deliberately narrow: only a ROLE-addressed ticket qualifies for a one-shot
    // mode. A ticket the lead addressed to a SEAT names a session that already
    // exists and already has a cwd — a session's cwd is fixed at PTY spawn, so
    // there is no expressible "move that seat into a worktree", and equally none
    // for "make that standing seat one-shot".
    //
    // FAIL-CLOSED on the value: anything not recognized resolves to `standing`,
    // never to `spawn`. A spawn seat is a full agent in the operator's own working
    // tree, so a malformed or hand-edited `dispatch` must degrade to the seat that
    // touches nothing, not to the one that edits the checkout.
    _ticketDispatchMode(team, assignee) {
      const standing = { mode: 'standing', def: null };
      if (!team || !assignee || !team.roles) return standing;
      if (!Object.prototype.hasOwnProperty.call(team.roles, assignee)) return standing;
      const def = team.roles[assignee];
      if (!def) return standing;
      if (def.dispatch !== 'spawn' && def.dispatch !== 'worktree') return standing;
      // The manifest refuses to WRITE a non-standing dispatch on these, but
      // team.json is hand-editable and files predating that check exist: the
      // resolver holds the same line, and holds it as an inversion (mirroring
      // assertDispatchAllowed) so a future fourth value is refused by default.
      if (assignee === 'lead' || assignee === 'reviewer') return standing;
      return { mode: def.dispatch, def };
    },

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
      // Slugged from the UNTRUNCATED first line, not from `ticket.title`: the
      // title is capped at 80 for display, and a dispatch opens with a ~67-char
      // task-dir path, so slugging the title left branchSlug ~13 characters and
      // its own 40-char cap never engaged (`t460-the`, `t461-the` — identical).
      // Still line 1 and nothing else, which is what extractTaskDir's
      // line-by-line widening rests on. Pre-spec records carry no `spec`; the
      // title is the only line available for those.
      const slug = branchSlug(ticket.spec == null ? ticket.title : titleLine(ticket.spec));
      // A recorded branch WINS over the derived one: a branch is an identity
      // minted once, not a view of the ticket's current first line. Re-deriving
      // here is safe only while the slug's inputs never move, and they move two
      // ways — the slug rule itself changed (t463), and `_taskRespec` / the
      // viewer's `editSpec` rewrite the spec TEXT. When _existingTicketTree
      // rejects the recorded tree (prunable, locked, no .git, held), the fresh
      // createWorktree below takes THIS name, so a re-derived one forks a second
      // branch off HEAD and the previous seat's commits stop being reachable as
      // the ticket's work — with `worktree.branch` overwritten to match, so the
      // lead's merge target and the hand's commits disagree silently. Same
      // argument as the baseSha carried through on reuse in _existingTicketTree.
      // The recorded name is NOT vetted here: createWorktree validates it
      // downstream against its own charset rule, which is the only check it gets.
      // A LOCKED recorded tree now refuses (git will not check one branch out
      // twice) where it used to fork a second branch. That refusal is the wanted
      // outcome, not a gap to route around: it leaves the ticket pinned to the
      // branch holding its commits. Falling back to the derived name here would
      // restore exactly the split this prevents.
      const recorded = ticket.worktree && ticket.worktree.branch;
      return { ok: true, name, branch: recorded || (slug ? `${ticket.id}-${slug}` : String(ticket.id)) };
    },

    // What Delete Session… costs, for the two refusals that offer it as the way
    // out. The two dispositions are opposites and the wrong one is worse than no
    // advice: a worktree seat's tree goes with the session and its uncommitted
    // work with it, while a spawn seat has no tree at all — its work is in the
    // shared checkout and SURVIVES the delete. A ticket with no `worktree` is the
    // spawn case (and the never-started one, where there is equally nothing on
    // disk to lose), so the pointer is the discriminator.
    _ticketDeleteCost(ticket) {
      const p = ticket && ticket.worktree && ticket.worktree.path;
      return p
        ? `that also deletes its worktree, so anything the seat left UNCOMMITTED in ${p} is lost (committed work survives on the branch).`
        : `it had no worktree of its own, so nothing on disk is removed — anything it left in the shared checkout survives.`;
    },

    // The dispatch-time half of the verify-time `verify: task-dir` check. Asked by
    // both lead-initiated dispatch verbs BEFORE they mint a seat or a worktree,
    // because the ticket is unreviewable either way and refusing at verify only
    // buys the hand a whole no-op round first (t429 cost two). Only the MISSING
    // case moves here: a taskDir that is set but escapes confinement is a
    // different failure with a different recovery, and verify keeps it.
    //
    // Not in `_deliverTicketSpec`, which is the shared funnel but also carries
    // replays and redeliveries — a dispatched ticket must keep being able to
    // replay its spec to a respawned seat, and gating the funnel would strand
    // exactly the recovery a dead hand depends on.
    // `reSend` is the caller's own answer to "is this a redelivery rather than a
    // decision to start work", because the two verbs know it differently: assign
    // has `ownSeat` and the ticket's tree, start refuses an already-started ticket
    // outright a few lines below.
    _ticketTaskDirRefusal(team, ticket, verb, reSend) {
      if (ticket.taskDir) return null;
      // SOLO boards never reach the cost this gate removes: a solo ticket mints no
      // worktree and gets no loop step, so it cannot arrive at the verify-time
      // refusal that makes a task-dir-less dispatch expensive. Gating it would be
      // pure cost on a path that ships fine without artifacts. Same carve-out, and
      // the same reason, as `_advanceSeat`'s.
      if (team && team.solo) return null;
      // A re-send is not a decision to start work: `assign` back to a ticket's own
      // seat is the redelivery a respawned or stuck seat recovers through, the same
      // recovery `_deliverTicketSpec` is deliberately left ungated for. Refusing it
      // would strand that recovery and would refuse work already done — the cost
      // this gate avoids was paid at dispatch. Verify is the backstop, which is why
      // that check stays.
      //
      // Deliberately NOT `ticketStarted` on the assign path: a legacy record with
      // no `startedAt` key and no `parked` flag reads as started while owning no
      // seat and no tree, and an assign on it would mint a fresh worktree seat and
      // run the whole job to a verify-time refusal — precisely the cost this
      // removes. No record on the live board is in that shape today; this closes
      // the hole rather than fixing a live bug.
      if (reSend) return null;
      // `respec` and not `reject`-then-respec: the ticket is still OPEN here (both
      // callers refused a non-open one above), so respec applies directly. The
      // verify-time twin has to name reject first because by then the ticket is
      // `done`, which respec refuses — same fix, two different reachable doors.
      return `ticket ${ticket.id} has no task dir, so nothing was ${verb === 'start' ? 'started' : 'assigned'} — its spec names no \`tasks/…\` path on any line, `
        + `and the review step has nowhere to write its diff. Nothing was changed. `
        + `Fix: re-file it with the artifact dir on the spec's first line, or \`[agent:task respec ${ticket.id}]\` <the corrected spec> to replace it in place.`;
    },

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
    },

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
    },

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
    },

    // A role's `cwd` reduced to a USABLE relative path, or '' — the one place
    // either consumer decides whether the field is honorable at all.
    //
    // Shared by _resolveRoleCwd (which joins it onto team.root) and
    // _deliverTicketSpec's AREA line (which joins it onto the WORKTREE path).
    // That is why the check here is lexical and takes no root: the two consumers
    // resolve against DIFFERENT bases, so a root-taking helper could not serve
    // both, and the second copy is exactly what let the AREA line hand a seat
    // `<wt>/etc` for `cwd: "/etc"` while the resolver refused the same value.
    //
    // Returns the reason rather than a bare '' so the resolver can keep its
    // distinct operator-facing clauses without re-deriving WHY it was rejected —
    // a re-derivation is the divergence this helper exists to remove.
    _roleCwdRel(def) {
      const raw = def && typeof def.cwd === 'string' ? def.cwd.trim() : '';
      if (!raw) return { rel: '', raw: '', reason: null };
      if (path.isAbsolute(raw)) return { rel: '', raw, reason: 'absolute' };
      // Normalized before the leading-`..` test: `api/../../elsewhere` does not
      // START with `..` but collapses to one, and a raw check waves it through.
      const norm = path.normalize(raw);
      if (norm === '..' || norm.startsWith(`..${path.sep}`)) return { rel: '', raw, reason: 'escape' };
      // "." is the team root spelled the long way. Treated as ABSENT rather than
      // honored: it resolves to the same directory the no-cwd path already uses,
      // and honoring it would emit an AREA line pointing at the tree root the
      // WORK IN: line above it already names.
      if (norm === '.') return { rel: '', raw, reason: null };
      return { rel: norm, raw, reason: null };
    },

    // A role's `cwd` → the absolute directory its seat boots in, plus the reason
    // it fell back when it did. Returns {cwd, fallback} where `fallback` is null
    // on the honored path and an operator-facing clause otherwise.
    //
    // NEVER throws and never creates anything: this runs at SPAWN, where the
    // write-time refusals in team-manifest have already had their say, and the
    // remaining cases are ones the disk changed under us. A throw here would
    // block a ticket over a directory; falling back to team.root spawns a working
    // seat in the place the whole team already agreed on. Silent is the one thing
    // it must not be — both call sites print `fallback`.
    //
    // The re-parenting guard is the non-obvious one. resolveTeam is
    // deepest-root-wins, so a nested team.json under `api/` OWNS that directory:
    // a seat booted there resolves onto the CHILD team — its board, its roster,
    // its lead — and every ticket verb the seat runs would quietly address the
    // wrong team. Nothing else in the system would report that.
    _resolveRoleCwd(team, def) {
      const root = team && team.root;
      // Re-checked at spawn even though every write path refuses these: team.json
      // is hand-editable, and a file that predates the write gate must not be able
      // to point a PTY outside the project.
      const { rel, raw, reason } = this._roleCwdRel(def);
      if (!root) return { cwd: root, fallback: null };
      if (reason === 'absolute') {
        return { cwd: root, fallback: `role cwd "${raw}" is absolute (it must be relative to the team root) — the seat was spawned in ${root} instead` };
      }
      if (reason === 'escape') {
        return { cwd: root, fallback: `role cwd "${raw}" resolves outside the team root — the seat was spawned in ${root} instead` };
      }
      if (!rel) return { cwd: root, fallback: null };
      const resolved = path.resolve(root, rel);
      let isDir = false;
      try { isDir = fs.statSync(resolved).isDirectory(); } catch { isDir = false; }
      if (!isDir) {
        return { cwd: root, fallback: `role cwd "${rel}" does not exist under the team root (Clodex never creates it) — the seat was spawned in ${root} instead` };
      }
      // Confinement decided on the REAL paths: the lexical check above compares
      // strings, and `cwd: "link"` where link → another project passes it while
      // pointing a PTY out of the tree. BOTH sides are realpath'd — a project
      // root under /tmp is itself a symlink on macOS (/tmp → /private/tmp), and
      // realpathing only the candidate would reject every legitimate root there.
      const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
      const realRoot = real(root);
      const realCwd = real(resolved);
      if (!realRoot || !realCwd) {
        // Only reachable if the path vanished between the stat above and here.
        return { cwd: root, fallback: `role cwd "${rel}" does not exist under the team root (Clodex never creates it) — the seat was spawned in ${root} instead` };
      }
      const within = path.relative(realRoot, realCwd);
      if (within.startsWith('..') || path.isAbsolute(within)) {
        return { cwd: root, fallback: `role cwd "${rel}" resolves outside the team root (it is a symlink to ${realCwd}) — the seat was spawned in ${root} instead` };
      }
      // Compared by ROOT, not by name: two manifests can name the same root only
      // by hand-edit, while the reparenting case is precisely a DIFFERENT root
      // (a nested team.json) resolving for this path.
      let owner = null;
      try { owner = resolveTeam(resolved); } catch { owner = null; }
      if (owner && path.resolve(owner.root) !== path.resolve(root)) {
        return { cwd: root, fallback: `role cwd "${rel}" belongs to team "${owner.name}" (its own team.json at ${owner.root} owns that directory), so a seat there would join THAT team's board — the seat was spawned in ${root} instead` };
      }
      return { cwd: resolved, fallback: null };
    },

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
      // Resolved ONCE for both arms: a role cwd is not a reviewer concept or a
      // ticket concept, and two copies of this call are exactly the divergence
      // this resolver exists to prevent.
      const roleCwd = this._resolveRoleCwd(team, def);

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
          //
          // A role `cwd` moves this WITHIN the main checkout (team.root by
          // default), never into the worktree: the property above is about which
          // CHECKOUT the seat lives in, and it is unchanged by which subdirectory
          // of that checkout the role names.
          cwd: roleCwd.cwd,
          // Why the cwd is not what the role asked for, or null. A key on the
          // shape rather than a second resolution at the call site: both spawn
          // paths print it, and a re-derivation there could disagree with the
          // directory actually used.
          cwdFallback: roleCwd.fallback,
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
          // Always null here: the ticket arm honors the template's extraArgs
          // verbatim, so no --model is ever refused and there is nothing to
          // report. Present so both purposes return one key set.
          modelRefused: null,
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

      const modelArgs = reviewerModelArgs(shape && shape.extraArgs);

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
        // Honored on this arm too (D4): the resolver is shared, so it costs
        // nothing, and special-casing the reviewer out would be a second rule to
        // remember. The reviewer stays agent-unwritable via RESERVED_ROLE_KEYS —
        // only the operator's GUI can set its cwd at all.
        cwd: roleCwd.cwd,
        cwdFallback: roleCwd.fallback,
        tpl,
        // MERGED onto postureArgs, never replacing them (that is the ticket
        // arm's shape, and the reason a template can hand a ticket seat posture
        // its opener does not hold). reviewerModelArgs is an allowlist of one
        // flag — do not widen it to honor the template's array.
        // Dropping the rest is an ADJUDICATED decision, not an omission: the
        // rationale is owned by the test 'a reviewer template CANNOT contribute
        // extraArgs'. Mirroring the ticket arm here reverts it.
        extraArgs: [...postureArgs, ...modelArgs.args],
        // A --model that was present and refused. Carried, not re-derived at the
        // call site: re-parsing would put a second copy of the allowlist there.
        modelRefused: modelArgs.refused,
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
    },

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
    },

    // No `def` parameter: the resolver derives the role def from (team, roleKey)
    // itself, and passing a second copy in would be exactly the duplicate source
    // this seam removes — a caller could hand in a def for a different role.
    //
    // `mode` is the dispatch mode from `_ticketDispatchMode` — 'worktree' or
    // 'spawn'. It defaults to 'worktree' because that is the shape every caller
    // had before spawn existed, and a defaulted-to-spawn would put a seat in the
    // operator's checkout on a path that never asked for one. On 'spawn' the tree
    // acquisition below is SKIPPED ENTIRELY rather than made to fail softly: a
    // team whose root is not a git repo is the case this mode exists for, so no
    // git call may sit on the DISPATCH path. Elsewhere in the ticket's life some
    // still run and degrade cleanly — `_writeTicketCost`'s orphan sweep is one —
    // so the claim is about this path, not about the mode as a whole.
    _spawnTicketSeat(opener, team, ticket, roleKey, seat, mode = 'worktree') {
      const isSpawn = mode === 'spawn';
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
          // A spawn seat has no tree by construction, so the whole acquisition
          // below is skipped — including `_existingTicketTree`, which shells out
          // to `git worktree list`. Skipped rather than allowed to fail: this mode
          // exists so a team whose root is not a repo can have ephemeral hands,
          // and a git call that merely tolerates failure still runs a subprocess
          // on every dispatch and would leave the non-repo case working by
          // accident rather than by construction.
          const existing = isSpawn ? null : await this._existingTicketTree(team, ticket);
          // Not just "don't write one" — CLEAR one already on the record. A ticket
          // reaches here carrying a tree whenever it was dispatched to a worktree
          // role first and re-assigned to a spawn role after that seat died, which
          // takes only lead verbs. Left in place, the pointer outvotes the mode in
          // every reader that tests for it: the spec says both WORK IN: <another
          // ticket's tree> and "you have no worktree", `loopEligible` goes true so
          // the ticket re-enters the git loop this mode exists to avoid, and
          // _taskAccept resolves a branch and takes the DESTROY arm on the one-shot
          // seat instead of the archive D5 requires. Clearing it makes all four
          // agree by construction rather than by the accident of a fresh ticket.
          // The on-disk git worktree is left alone, still named by the previous
          // seat's persistence record — the same state every other un-pin path here
          // leaves behind.
          if (isSpawn) { clearTicketTree(); }
          else if (existing) { wt = existing; reused = true; }
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
            //
            // On a re-dispatch createWorktree returns NO baseSha: it resolves one
            // only for a branch it CREATED (`if (!exists)`), and the recorded branch
            // this arm now re-checks-out already exists. The previous fork point is
            // therefore the only one there will ever be, and `rec.worktree = wt`
            // below overwrites the record WHOLESALE — so failing to carry it here
            // destroys it rather than merely omitting it, and `loopEligible`
            // (`branch && baseSha`) goes false: no verify, no suite run, no reviewer,
            // no auto-merge, and no watchdog visibility, all silently. Same argument
            // as the carry-through in _existingTicketTree, on the arm that reuses the
            // BRANCH rather than the tree.
            //
            // Guarded on the branch matching: createWorktree disambiguates the PATH
            // with a numeric suffix, never the branch, so a first dispatch whose name
            // collided must not inherit an unrelated ticket's fork point.
            const prior = (ticket.worktree && ticket.worktree.branch === r.branch)
              ? ticket.worktree.baseSha : null;
            const keep = r.baseSha || prior || null;
            wt = { path: r.path, branch: r.branch, ...(keep ? { baseSha: keep } : {}) };
          }
          // Recorded on the TICKET, which is what _deliverTicketSpec reads to tell
          // the seat where to work. On the ticket rather than only on the session
          // because the spec is redelivered on a replay, and a seat that comes back
          // after a respawn needs the location as much as the first one did.
          //
          // Skipped for a spawn seat rather than writing `worktree: null`: ABSENT
          // is the state every reader already tests for (`ticket.worktree &&
          // ticket.worktree.path`), and a stored null would be a second spelling of
          // it for the loop gate, the accept arms and the WORK IN: line to get
          // wrong independently.
          if (!isSpawn) {
            try {
              const all = ticketsStore.load(team.root);
              const rec = all.find((x) => x.id === ticket.id);
              if (rec) { rec.worktree = wt; ticketsStore.save(team.root, all); }
              ticket.worktree = wt;
            } catch { /* best-effort — the spec below still carries it from `ticket` */ }
          }
          const shape = this.resolveSeatShape(team, roleKey, 'ticket', opener);
          const spawned = await this.create(
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
            // shape.cwd, not team.root: this feeds the sidebar row's dataset.cwd,
            // which is what "Reveal Working Directory in Finder" / "Open in
            // Terminal" open. After a restart the row is rebuilt from the
            // persistence record — which IS shape.cwd — so sending the root here
            // makes the app disagree with itself across a restart, on exactly the
            // seats a role cwd creates.
            action: 'reattach', name: seat.name, type: (this.sessions.get(seat.name) || {}).agentType || null,
            cwd: shape.cwd, backend: (this.sessions.get(seat.name) || {}).backend || null,
            noWire: !!(this.sessions.get(seat.name) || {}).noWire,
            background: true,
          });
          const d = this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true);
          this._broadcast('ipc-message', {
            type: 'task', from: opener.name, to: seat.name, body: `ticket ${ticket.id} → ${seat.name} @ ${wt ? wt.path : shape.cwd}`,
          });
          log.info('intent', isSpawn
            ? `ticket ${ticket.id} spawned ${seat.name} (${roleKey}) in the shared checkout @ ${shape.cwd}`
            : `ticket ${ticket.id} ${reused ? 'respawned' : 'spawned'} ${seat.name} (${roleKey}) on branch ${wt.branch} @ ${wt.path}`);
          // The env drops ride the reply here too. A silently ignored env key is
          // the bug the allowlist's own comment names, and this path dropped one
          // without a word while the review and spawn paths both announced it.
          const envWarn = (shape.envDropped.length
            ? ` — template env keys [${shape.envDropped.join(', ')}] are outside the allowed set [${[...REVIEWER_ENV_ALLOWLIST].join(', ')}] — dropped (env is an authority surface; requires operator approval)`
            : '')
            + (shape.envBadType.length
              ? ` — template env keys [${shape.envBadType.join(', ')}] are allowed but their values are not strings — dropped (quote the value in the template)`
              : '');
          // Same rule, the dispatch channel: the lead dispatched this ticket and
          // is the only party who can install the missing prompt. The seat is
          // already working on the spec by the time this lands — a warn, not a
          // block, exactly like the env drops beside it.
          const promptWarn = (spawned && spawned.missingPrompt) ? ` — WARNING: ${spawned.missingPrompt}` : '';
          // Same rule as the env drops beside it: the seat is already working by
          // the time this lands, and the lead is the only party who can fix the
          // role def. A seat silently booted somewhere other than where its role
          // says is the failure this line exists to make visible.
          const cwdWarn = shape.cwdFallback ? ` — NOTE: ${shape.cwdFallback}` : '';
          reply(isSpawn
            ? `ticket ${ticket.id} → ${seat.name} in the shared checkout ${shape.cwd} (no branch, no worktree)${this._ticketDeliverySuffix(d, seat.name)}${envWarn}${cwdWarn}${promptWarn}`
            : `ticket ${ticket.id} → ${seat.name} on ${reused ? 'its existing tree, branch' : 'branch'} ${wt.branch}${this._ticketDeliverySuffix(d, seat.name)}${envWarn}${cwdWarn}${promptWarn}`);
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
          // "whose tree is kept" is only true when there IS one. A spawn seat's
          // pin is kept for the same reason (the record outlives the failure and
          // must not be minted over), but naming a tree it never had tells the
          // lead to go looking for a checkout that does not exist.
          const keptTree = !!(ticket.worktree && ticket.worktree.path);
          reply(unpinned
            ? `ticket ${ticket.id}: seat ${seat.name} failed to spawn (${err.message}) — ticket left assigned to "${roleKey}"`
            : `ticket ${ticket.id}: seat ${seat.name} failed to spawn (${err.message}) — the ticket stays pinned to "${seat.name}"${keptTree ? ', whose tree is kept' : ' (no worktree — it was working in the shared checkout)'}; re-assign it to retry`);
        }
      });
    },

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
    },

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
      // Above the mint and above every write below it: a gate placed one line
      // later still refuses and still returns this string, having already
      // reserved the seat name and cut the worktree.
      //
      // `ticketStarted` is the whole re-send test here, unlike assign's: start
      // refuses an already-started ticket outright a few lines below, so the wider
      // net costs nothing — those tickets never reach a dispatch on this path.
      const noTaskDir = this._ticketTaskDirRefusal(team, ticket, 'start', ticketStarted(ticket));
      if (noTaskDir) { log.info('intent', `task start by ${session.name}: ${ticket.id} refused — no task dir`); reply(noTaskDir); return; }
      const assignee = ticket.assignee;
      // The role the ticket was FILED under, which is what mints the seat name and
      // resolves the worktree opt-in. On an unstarted ticket `assignee` still holds
      // it; `role` is only written once a dispatch path has re-pinned.
      const roleKey = ticket.role || assignee;
      const { mode: dispatchMode } = this._ticketDispatchMode(team, roleKey);
      // Both one-shot modes mint a seat; only `worktree` uses the branch the mint
      // also derives. Left unused rather than conditionally derived: the name is
      // the half both modes need, and splitting the mint would put a second
      // name-derivation rule beside the one `matchSeatRole` depends on.
      const oneShot = dispatchMode !== 'standing';
      const minted = oneShot ? this._mintTicketSeat(team, roleKey, ticket) : null;
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
          + this._ticketDeleteCost(ticket));
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
      if (oneShot && minted.ok) {
        // Re-pinned from the role to the seat BEFORE the save, because
        // _ticketAssigneeSeat resolves a role to the FIRST live seat holding it —
        // leaving it role-assigned would route the NEXT ticket to this one's seat,
        // sitting in the wrong branch's checkout.
        ticket.role = roleKey;
        ticket.assignee = minted.name;
        ticketsStore.save(team.root, tickets);
        this._spawnTicketSeat(session, team, ticket, roleKey, minted, dispatchMode);
        this._reconcileTickets(team);
        this._broadcast('ipc-message', { type: 'task', from: session.name, to: minted.name, body: `ticket ${ticket.id} started` });
        log.info('intent', dispatchMode === 'spawn'
          ? `task start by ${session.name}: ${ticket.id} → seat ${minted.name}, shared checkout`
          : `task start by ${session.name}: ${ticket.id} → seat ${minted.name}, branch ${minted.branch}`);
        reply(dispatchMode === 'spawn'
          ? `ticket ${ticket.id}${unparked} → spawning ${minted.name} in the shared checkout (no branch)`
          : `ticket ${ticket.id}${unparked} → spawning ${minted.name} in a worktree on branch ${minted.branch}`);
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
    },

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
      const { mode: dispatchMode } = this._ticketDispatchMode(team, assignee);
      const oneShot = dispatchMode !== 'standing';
      const minted = oneShot ? this._mintTicketSeat(team, assignee, ticket) : null;
      // The seat name is derived from the ticket id, so "taken" by the ticket's
      // current assignee means the ticket already has its own seat. Whether that
      // seat can be TALKED to is a second question: a record outlives an archive,
      // a natural exit and a non-ephemeral retire, so `taken` alone would send the
      // spec to a name nothing answers for and report "wait for it to spawn" —
      // nothing will. Liveness decides between re-send and the stuck reply below.
      const own = !!(minted && minted.taken && minted.name === prev);
      const ownSeat = (own && this._ticketAssigneeSeat(team, { assignee: prev }) === prev) ? prev : null;
      // Same gate start makes, and for the same reason — assign is the OTHER
      // dispatch path, so a ticket refused by one verb must not be dispatchable by
      // the other. Below the mint only because the re-send test needs `ownSeat`:
      // _mintTicketSeat derives a name and tests whether it is taken, writing
      // nothing, so this is still above every write and above the reassign notice
      // that tells a previous holder to stand down.
      //
      // A ticket that already OWNS a tree is a re-send too, even with no live seat
      // in it: the tree is the work, and the seat holding it can be respawned.
      const noTaskDir = this._ticketTaskDirRefusal(team, ticket, 'assign',
        !!ownSeat || !!(ticket.worktree && ticket.worktree.path));
      if (noTaskDir) { log.info('intent', `task assign by ${session.name}: ${ticket.id} refused — no task dir`); reply(noTaskDir); return; }
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
          + this._ticketDeleteCost(ticket));
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
      if (oneShot) {
        if (minted.ok) {
          ticket.role = assignee;
          ticket.assignee = minted.name;
          ticketsStore.save(team.root, tickets);
          this._spawnTicketSeat(session, team, ticket, assignee, minted, dispatchMode);
          this._reconcileTickets(team);
          log.info('intent', dispatchMode === 'spawn'
            ? `task assign by ${session.name}: ${ticket.id} → seat ${minted.name}, shared checkout`
            : `task assign by ${session.name}: ${ticket.id} → seat ${minted.name}, branch ${minted.branch}`);
          reply(dispatchMode === 'spawn'
            ? `ticket ${ticket.id} → spawning ${minted.name} in the shared checkout (no branch)`
            : `ticket ${ticket.id} → spawning ${minted.name} in a worktree on branch ${minted.branch}`);
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
    },

    _taskDone(session, team, intent, reply) {
      // Read above the id check so a malformed command — where no id resolves and
      // there is nothing to attach the report to — still preserves it.
      const report = String(intent.body == null ? '' : intent.body).trim();
      if (!intent.id) { reply(`error: done needs a ticket id — [agent:task done <id>] <report>${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      if (!report) { reply('error: done needs a report — [agent:task done <id>] <what you did>'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      // RE-ENTRY, the recovery from a verify escalation (t345). The ticket is
      // already `done` and still held at `verify` with a `verifyHold` on the
      // record: the loop told the lead a check failed and stopped there. Closing
      // again is how the hand says the condition is fixed, and it re-runs the
      // checks from where they stopped rather than changing the ticket's state.
      //
      // NOT a reopen, and that is the whole point: `reject` was the only verb
      // that moved a stranded ticket, and it bumps `reworkRound` and records a
      // rejection that never happened. Here nothing failed review — a check did
      // not pass, and the fix is to satisfy it.
      //
      // Gated on `verifyHold`, not on `loopStep === 'verify'` alone: a ticket
      // whose checks are RUNNING is also done-and-at-verify, and re-entering
      // there would put two loops on one ticket, racing to spawn two reviewers
      // for one branch. The stamp is written only when the loop has stopped and
      // handed the ticket to a human, so it is the field that distinguishes them.
      const reentry = ticket.state === 'done' && ticket.loopStep === 'verify' && !!ticket.verifyHold;
      if (ticket.state !== 'open' && !reentry) {
        const held = ticket.verifyHold && ticket.verifyHold.step
          ? ` — it is held at "${ticket.verifyHold.step}"`
          : '';
        reply(`error: ticket ${intent.id} is ${ticket.state}, not open${held}${this._spillRejectedPayload(session, 'task done', report)}`); return;
      }
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
      // NOT on a re-entry: the advance already ran on the first close and handed
      // this seat its next ticket. Running it again re-delivers that ticket's spec
      // to a seat that is holding it — an urgent duplicate dispatch, arriving as a
      // second copy of work already in flight, which is the exact confusion the
      // replay marker exists to prevent one layer down.
      const doneSeat = reentry ? null : this._ticketAssigneeSeat(team, ticket);
      const next = doneSeat ? this._advanceSeat(team, doneSeat, ticket) : null;
      const nextSuffix = next ? ` — next: ${next.id} delivered to ${doneSeat}` : '';
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: lead, body: `ticket ${ticket.id} done` });
      this._writeTicketCost(team, ticket);
      log.info('intent', `task done ${ticket.id} by ${session.name} → ${lead}${reentry ? ' (re-entry after a verify hold)' : ''}`);
      reply((reentry
        ? `ticket ${ticket.id} re-verifying (was held at "${ticket.verifyHold && ticket.verifyHold.step}")`
        : (isLead ? `ticket ${ticket.id} closed (done)` : `ticket ${ticket.id} closed (done) — report delivered to ${lead}`)) + nextSuffix);
      // Fired AFTER the reply, and deliberately not awaited: this handler is
      // synchronous and the checks shell out to git, so awaiting them here would
      // hold the intent handler open across several subprocesses and delay the
      // hand's own confirmation behind work the hand is not waiting for.
      if (loopEligible) this._runTicketLoop(team, ticket.id);
    },

    // The loop step `task done` opens: verify the tree, then spawn the review.
    //
    // Escalation is the ONLY way out of here that reaches the lead — every
    // failure arm below funnels through _escalateTicket, and a second "tell the
    // lead" path added here would reintroduce the round trip the whole design
    // removes. It tears NOTHING down on any arm: the tree, the branch and the
    // seat are exactly what the lead looks at first.
    async _runTicketLoop(team, ticketId) {
      // THE verifyHold INVARIANT, the shape `_autoMergeTicket` states for
      // `mergeWaiting`: set on the fail arms, cleared on EVERY other exit, and
      // held in a `finally` rather than by clearing at each one. The exits are not
      // only the ones easy to remember — the green path spawns a review, four
      // guards return silently on a ticket that moved under the checks, the
      // suite-red arm rejects, and the catch-all throws. A stamp left behind on
      // any of them is a ticket that alarms forever about a check that passed.
      let held = false;
      // A verify escalation is a HOLD, not an exit. Before t345 a DELIVERED one
      // deleted `loopStep`, which left `state=done` with nothing in flight: the
      // stall sweep skipped it forever (ticketInFlight is false), `task done`
      // bounced as "is done, not open", and the ONLY verb that moved it was
      // `task reject` — which bumps `reworkRound` and records a rejection nobody
      // made. The asymmetry was inside this function: the suite-red arm below
      // rejects and reaches the hand, these arms stranded.
      //
      // `keepHold` already meant "something can still act on this ticket" — it
      // was introduced for a live reviewer whose verdict may land. A pending
      // escalation is the same claim about a different actor, so this extends
      // that axis rather than opening a second one. The ticket stays `done` and
      // stays at `verify`; `_taskDone` re-enters the loop from here once the
      // condition the escalation named is fixed.
      //
      // STAMPED BEFORE the DM, for the reason `_stampMergeError`'s call site
      // gives: the delivery is the arm that can fail, and the board must carry
      // what the message may not.
      const fail = (step, evidence, tried) => {
        held = true;
        this._stampVerifyHold(team, ticketId, { step, at: Date.now(), evidence: String(evidence) });
        this._escalateTicket(team, ticketId, step, evidence, tried, { keepHold: true });
      };
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
      } finally {
        // Every exit that is NOT a fail arm: the green path that spawned a
        // review, the four guards that return silently on a ticket which moved
        // under the checks, and the suite-red arm that rejected. A hold surviving
        // any of them makes the sweep alarm about a check that has since passed —
        // and `fail` itself re-stamps, so a second round is not cleared by its own
        // predecessor's stamp. Costs one load per run and no save unless the field
        // is actually there.
        if (!held) this._stampVerifyHold(team, ticketId, null);
      }
    },

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
    },

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
        delete ticket.closedOut;       // same reason as _taskReject's reopen
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
        // Watched like a spec, and for a sharper reason: a seat that never sees
        // its rejection keeps working the version that was just rejected, and the
        // stall sweep then reports it as a stalled seat — the wrong cause, which
        // sends the lead looking at the seat instead of at the delivery.
        const r = this._gatedDeliver(seat, 'ticket-loop', this._redirectDeliveryText(ticket.id, 'rejected', reason), true,
          `[ticket ${ticket.id} rejected] close with ${ticketCloseVerb(ticket.id)}`,
          (disposition) => this._armSpecConfirm(seat, ticket.id, disposition,
            { label: 'rejected', reason, from: 'ticket-loop' }));
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
    },

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
    },

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
      const r = this._gatedDeliver(seat, session.name, this._redirectDeliveryText(ticket.id, 'more must-fixes', reason), true,
        `[ticket ${ticket.id} more must-fixes] close with ${ticketCloseVerb(ticket.id)}`,
        (disposition) => this._armSpecConfirm(seat, ticket.id, disposition,
          { label: 'more must-fixes', reason, from: session.name }));
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
    },

    _loadTicket(team, ticketId) {
      try {
        const tickets = ticketsStore.load(team.root);
        return tickets.find((t) => t.id === ticketId) || null;
      } catch { return null; }
    },

    // Re-load, mutate, save — never a mutation of a caller's snapshot. The loop
    // awaits git between reads, which is a wide enough window for another writer
    // (a verdict, a cancel) to land in, and saving a stale array would silently
    // revert it.
    // The board's copy of a verify escalation — `_stampMergeError`'s counterpart
    // for the loop's own checks, and for the same reason its header gives: the DM
    // is the arm that can fail, and a lead that never read it has nothing else to
    // find the ticket by. The record carries what the message may not.
    //
    // SEPARATE from `loopStep`, which stays at `verify`. The step says where the
    // loop is; this says a human owes it an action. Collapsing them would make
    // every consumer of `loopStep` — the board's rendering, the verdict landing,
    // the sweep's stamp — unable to tell a running check from a waiting one.
    //
    // Cleared by passing null, which is a no-op when the field is absent: the
    // loop's `finally` calls this on every green exit, and a save per clean run
    // for a key that is not there would be a write on the whole happy path.
    _stampVerifyHold(team, ticketId, hold) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!hold) { if (!('verifyHold' in rec)) return; delete rec.verifyHold; }
        else {
          rec.verifyHold = hold;
          // A NEW escalation is a new stall episode, the same argument
          // `_setLoopStep` makes: the ladder must time from the moment the lead
          // was told, and a `nudgedAt` left over from the stall that preceded the
          // close would put this episode's first alarm on a rung it never climbed.
          rec.lastActivityAt = Date.now();
          rec.nudgedAt = null;
        }
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `verify hold stamp for ${ticketId} failed: ${e.message}`);
      }
    },

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
    },

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
    },

    // The ticket's task dir as it is SHOWN to an agent — the one renderer behind
    // both the hand's dispatch and the reviewer's scope.
    //
    // ONE function, not two call sites passing the same arguments, because the
    // invariant is that the two renderings AGREE: same directory, same rule,
    // under the same condition. Two sites that agree today diverge the moment
    // one is edited — which is exactly how this bug existed, with dispatch
    // resolving the pointer while the scope passed `t.taskDir` verbatim into a
    // reviewer whose cwd is the repo the decoy lives in.
    //
    // Resolution and the RULE CLAUSE are two decisions, deliberately — and the
    // three fields exist because the two renderers need different combinations
    // of them, while the CONTENT of each must be identical:
    //  - `dir` resolves whenever it can. An already-absolute pointer resolves to
    //    itself, so there is never a reason to show a reviewer the raw one. The
    //    scope always names a task dir, so this is what it uses.
    //  - `rule` is the FACT, and it is empty for a `~`- or `/`-prefixed pointer:
    //    that one already means the same thing to an agent as it does here, so
    //    the clause would be telling ~100 live seats what they already know.
    //    The gate lives in taskDirRuleClause, beside the prose it gates.
    //  - `line` is the dispatch's whole rendering and is empty on the same
    //    condition, because there it is the entire line rather than a suffix:
    //    every dispatch already spills past the 500-byte threshold, so a
    //    redundant line costs each of those seats a Read turn. The scope pays no
    //    such cost — it names the dir regardless — which is why it takes `dir`
    //    and `rule` rather than `line`.
    //    The `rule ?` guard below looks like it duplicates the clause computed
    //    inside ticketTaskDirLine, and must stay: the helper self-gates only the
    //    clause, so without the outer guard a `~`/absolute pointer still emits a
    //    bare `TASK DIR: <dir>` line to EVERY dispatch. The guard is what
    //    suppresses the whole line, not a redundant recomputation.
    // What must NOT differ is the wording of the fact, and that is why both come
    // from here. `line` additionally carries "so create it", which `rule` must
    // not: the scope's reader is a read-only seat.
    //
    // Through _ticketDiffDest, so the confinement guarding the diff and
    // COST.json guards this too: a second resolver could name a directory
    // Clodex itself would refuse to write, which is worse than naming none. A
    // refusal drops the rendering and NEVER fails the caller — neither a
    // dispatch nor a spawn may die over a display line.
    _ticketTaskDirRender(team, ticket) {
      const raw = String((ticket && ticket.taskDir) || '').trim();
      if (!raw) return { dir: null, rule: '', line: '' };
      let dest = null;
      try { dest = this._ticketDiffDest(team, ticket); } catch { dest = null; }
      if (!dest || !dest.ok) return { dir: null, rule: '', line: '' };
      const rule = taskDirRuleClause(raw);
      return {
        dir: dest.dir,
        rule,
        line: rule ? ticketTaskDirLine(dest.dir, raw) : '',
      };
    },

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
    },

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
    },

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
      // Through the SAME renderer the hand's dispatch uses. The reviewer's cwd is
      // team.root — the repo the stale `tasks/` decoy lives in — so a raw
      // relative pointer here lands it in the wrong tree exactly as it did the
      // hand. buildReviewScope has no `t.taskDir` fallback by design, so a
      // refusal here means the scope names no task dir — never the raw one.
      const taskDirRender = this._ticketTaskDirRender(team, ticket);
      const scope = buildReviewScope({ ticket, diffPath, taskDir: taskDirRender.dir, taskDirRule: taskDirRender.rule });
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
    },

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
    },

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
    },

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
    // The taskDir is RESOLVED, never trusted: it is spec text of whatever shape
    // an agent wrote. Writing it verbatim mkdir -p's a literal `~` under the
    // process cwd and the artifact silently never lands.
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
    },

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
      // A reopened ticket is not terminal. Left set, `ticketTerminalReason` keeps
      // reading it as closed out and refuses a `for <id>` reminder binding on the
      // rework round, which is a round the reminder is wanted for.
      delete ticket.closedOut;
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
      // The verify hold goes with it. A reopened ticket owes nobody the check the
      // stamp names — the lead just decided the work needs rework, which supersedes
      // it — and a stamp outliving the hold would alarm about a pending escalation
      // on a ticket that is being worked, in a body that tells the hand to re-close.
      delete ticket.verifyHold;
      ticketsStore.save(team.root, tickets);
      const seat = this._ticketAssigneeSeat(team, ticket);
      // Same rework reasoning as the loop's reject. This call passed NO tag before,
      // which was harmless while the body was short enough to arrive inline; adding
      // the close line spills it, and an untagged pointer names neither the ticket
      // nor the verb. So the tag is added here rather than left to default.
      if (seat && seat !== team.lead) {
        this._gatedDeliver(seat, session.name, this._redirectDeliveryText(ticket.id, 'rejected', reason), true,
          `[ticket ${ticket.id} rejected] close with ${ticketCloseVerb(ticket.id)}`,
          (disposition) => this._armSpecConfirm(seat, ticket.id, disposition,
            { label: 'rejected', reason, from: session.name }));
      }
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} rejected` });
      log.info('intent', `task reject ${ticket.id} by ${session.name} → reopened`);
      reply(`ticket ${ticket.id} reopened (rework) → ${ticket.role || ticket.assignee || 'unassigned'}`);
    },

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
        // Still gated to `open` — respec DELIVERS, and re-dispatching a closed
        // ticket restarts work on it without reopening it. t345 changes only the
        // ADVICE, and only on a held ticket: "reject it first" is the false
        // rejection that ticket removes, and prescribing it here would route the
        // lead straight back into it. A held ticket is waiting on a check, so the
        // honest answer names the check rather than a verb that misrecords why.
        const route = ticket.state === 'done'
          ? (ticket.verifyHold
            ? ` — it is held at "${ticket.verifyHold.step}", waiting for that check to be satisfied and the ticket closed again; reject it only if the work genuinely needs rework`
            : ` — reject it first ([agent:task reject ${intent.id}]), then respec`)
          : '';
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
    },

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
      const next = seat ? this._advanceSeat(team, seat, ticket) : null;
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} cancelled` });
      this._writeTicketCost(team, ticket);
      log.info('intent', `task cancel ${ticket.id} by ${session.name}`);
      const dropped = this._cancelTicketReminders(session.name, ticket.id);
      reply(`ticket ${ticket.id} cancelled${next ? ` — next: ${next.id} delivered to ${seat}` : ''}${dropped ? ` ${dropped}` : ''}`);
    },

    // Drop the reminders BOUND to a ticket (`[agent:remind for t42 …]`) when it
    // reaches a terminal close. Returns a report fragment, or '' when nothing was
    // bound — the common case, which must stay silent.
    //
    // Called from accept and cancel ONLY. `done` is deliberately not a caller:
    // a reject reopens a done ticket, and the reminder is still wanted through
    // the rework round. `state = 'open'` is written by both rejection
    // transitions, so a done ticket is not closed out until accept.
    //
    // `agent` is the LEAD (both callers are lead-gated), which is also the owner
    // the scheduler enforces against — a bound reminder is still its owner's.
    // Never throws into a close path: a reminder that outlives its ticket is the
    // bug this fixes, but failing to CLOSE the ticket over it would be worse.
    _cancelTicketReminders(agent, ticketId) {
      let sched = null;
      try { sched = getRemindScheduler && getRemindScheduler(); } catch { sched = null; }
      if (!sched || typeof sched.cancelForTicket !== 'function') return '';
      let ids = [];
      try { ids = sched.cancelForTicket(agent, ticketId) || []; } catch { return ''; }
      if (!ids.length) return '';
      log.info('intent', `ticket ${ticketId} closed — cancelled ${ids.length} bound reminder(s): ${ids.join(', ')}`);
      return `— ${ids.length} bound reminder(s) cancelled (${ids.join(', ')}).`;
    },

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
    },

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

      // `closedOut` is passed by the CALLING ARM, never derived here: finish()
      // runs on all four accept paths and cannot tell them apart, and that is
      // exactly the conflation this parameter exists to prevent. Two of the four
      // arms end with "Merge it, then accept again" — they are not terminal, and
      // a reminder bound to the ticket is most wanted precisely there.
      const finish = (msg, closedOut = false) => {
        ticket.acceptedAt = Date.now();
        ticket.acceptedBy = session.name;
        if (closedOut) ticket.closedOut = true;
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
        // The verify hold goes with it, on BOTH writes for the same reason. The
        // lead accepting a ticket held at a failed check is the lead overruling
        // that check — it is a decision, and it ends the wait. Left behind, the
        // sweep would keep alarming that someone owes an action on work that has
        // been accepted and whose tree is gone.
        delete ticket.verifyHold;
        // Re-read: the teardown below stamped revival onto its own copy.
        const fresh = ticketsStore.load(team.root);
        const row = fresh.find((t) => t.id === ticket.id);
        if (row) {
          row.acceptedAt = ticket.acceptedAt;
          row.acceptedBy = ticket.acceptedBy;
          if (closedOut) row.closedOut = true;
          if (note) row.acceptNote = note;
          row.lastActivityAt = ticket.lastActivityAt;
          delete row.loopStep;
          delete row.verifyHold;
          ticketsStore.save(team.root, fresh);
        } else {
          ticketsStore.save(team.root, tickets);
        }
        this._broadcast('ipc-message', { type: 'task', from: session.name, to: seatName || '(unassigned)', body: `ticket ${ticket.id} accepted` });
        log.info('intent', `task accept ${ticket.id} by ${session.name}: ${msg}`);
        // Cancellation is gated on the SAME fact the stamp is: only an accept
        // that closed the ticket out collects its reminders. On the other two
        // arms the reply says "Merge it, then accept again" — cancelling there
        // would drop "check the branch landed" in the very message reporting
        // that it did not.
        const dropped = closedOut ? this._cancelTicketReminders(session.name, ticket.id) : '';
        reply(dropped ? `${msg} ${dropped}` : msg);
      };

      // No branch to reason about (a ticket worked in the main checkout): there
      // is no tree to remove and no ref to delete, so acceptance is the stamp
      // alone — for a STANDING seat. Retiring the operator's persistent seat here
      // would be a teardown the merge fact never licensed.
      //
      // A `spawn` seat is the opposite case and splits this arm: it is one-shot by
      // construction, nothing will ever dispatch to it again, and no cleanup verb
      // reaches it — so left live it accumulates dead rows in the sidebar. Told
      // apart by the RECORD's `ephemeral` (stamped by _spawnTicketSeat), not by
      // re-resolving the role: the role def is agent-writable and may have been
      // edited between dispatch and accept, and the record is the fact about what
      // was actually spawned.
      //
      // ARCHIVED, never destroyed. There is no worktree, so destroying reclaims
      // nothing, while the seat's transcript is the only record of what it did and
      // its work may be UNCOMMITTED in the shared checkout. Archiving is
      // recoverable; destroy is not. Same treatment the `!m.merged` arm gives a
      // worktree seat, for the same reason.
      if (!branch) {
        const ephemeralSeat = !!(rec && rec.ephemeral);
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true });
        let archived = false;
        if (ephemeralSeat && seatName && this.sessions.has(seatName)) {
          await this.archive(seatName);
          archived = true;
        }
        // The reply must say which of the two happened. "Nothing was torn down"
        // after an archive is exactly the class of lie this codebase fixes on
        // sight — the lead reads this line and nothing else.
        //
        // Terminal either way: there is no branch to merge and no second accept to
        // invite, so acceptance is the whole story for this ticket.
        finish(archived
          ? `ticket ${ticket.id} accepted — no ticket branch recorded (it worked in the shared checkout), so nothing was removed; ${seatName} was a one-shot seat and was ARCHIVED (resumable from the sidebar; anything it left uncommitted is still in the checkout)`
          : `ticket ${ticket.id} accepted — no ticket branch recorded, so nothing was torn down${seatName ? ` (${seatName} left as it is)` : ''}`, true);
        return;
      }

      const m = await gitWorktree.isMerged(team.root, branch).catch((e) => ({ ok: false, error: e.message }));

      if (!m.ok) {
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true });
        if (seatName && this.sessions.has(seatName)) await this.archive(seatName);
        // NOT terminal (no `closedOut`): the reply below invites another accept
        // once the merge fact can be established, so the ticket is still live
        // and any reminder bound to it is still wanted.
        finish(`ticket ${ticket.id} accepted, but the merge check could NOT run for branch ${branch} (${m.error || 'unknown error'}) — treated as NOT merged: `
          + `${seatName ? `${seatName} was archived, and its ` : 'its '}worktree and branch were KEPT. Nothing was removed.`);
        return;
      }

      if (!m.merged) {
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true });
        if (seatName && this.sessions.has(seatName)) await this.archive(seatName);
        // NOT terminal (no `closedOut`), same reasoning: "Merge it, then accept
        // again" is an explicit invitation to come back. Cancelling a bound
        // reminder in the message that reports the branch did NOT land is the
        // worst possible moment for it.
        finish(`ticket ${ticket.id} accepted, but branch ${branch} is NOT merged into ${m.base} — `
          + `${seatName ? `${seatName} was archived (resumable), and its ` : 'its '}worktree and branch were KEPT. `
          + `Merge it, then [agent:task accept ${ticket.id}] again to clean up.`);
        return;
      }

      // How many commits the branch actually carries — for the REPLY ONLY. The
      // teardown above and below is unconditional and must stay that way: an
      // empty branch has nothing to lose, and refusing to clean it up leaves
      // dead trees accumulating.
      //
      // Counted HERE, before the teardown: destroy() removes the worktree and
      // deleteBranch() drops the ref, and after either the count is unobtainable
      // — moving this below them turns every reply into the unknown case.
      //
      // `isMerged(root, branch)` alone cannot tell "landed" from "never
      // committed": with no base passed it asks whether the branch is an
      // ancestor of the main checkout's HEAD, and a branch still AT its base is
      // trivially that. So the gate says merged and the reply claimed a merge
      // that never happened. The count is what separates them, and the ticket
      // record already carries the mint-time base to count against.
      const baseSha = (rec && rec.worktree && rec.worktree.baseSha)
        || (ticket.worktree && ticket.worktree.baseSha) || null;
      const c = await gitWorktree.commitsOnBranch(team.root, branch, baseSha)
        .catch((e) => ({ ok: false, count: null, error: e.message }));

      // Whether the count means what "0 commits" would suggest. A count is only
      // evidence of an EMPTY branch when it was measured against the recorded
      // FORK POINT. With no baseSha — a supported shape, since createWorktree
      // deliberately records none for a pre-existing branch — commitsOnBranch
      // falls back to merge-base(defaultBranch, branch), and for a branch already
      // fast-forwarded into master that merge base IS the branch tip, so the
      // count is 0 for work that genuinely landed.
      //
      // Zero-against-a-fallback therefore cannot tell "never committed" from
      // "committed and already merged". Those need opposite sentences, so the
      // undecidable case gets its own rather than borrowing either.
      const measured = c.ok && baseSha && c.base === String(baseSha).trim();

      // Stamp before the teardown — destroy() drops the record the session id
      // lives in, so after it the link is unrecoverable. `mergedInto` records
      // only a merge that can be shown: a demonstrably empty branch is an
      // ancestor of master without anything landing, so writing m.base there
      // stores the same false claim this ticket removes from the reply.
      //
      // The UNDECIDABLE case still stamps m.base, deliberately, and that is why
      // it is not written as `measured ? … : null`. Only the demonstrably-empty
      // branch is known to have merged nothing; an unmeasured count leaves the
      // merge gate's own answer (the branch IS an ancestor) as the best supported
      // fact, and nulling it there would assert "not merged" from ignorance —
      // the reply says UNKNOWN precisely because neither side is established.
      if (seatName) {
        this._stampTicketRevival(team, seatName,
          { accepted: true, mergedInto: (measured && c.count === 0) ? null : m.base });
      }

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
      // FOUR outcomes, one teardown. Each claims only what its evidence supports:
      //
      //   !c.ok                  the count could not be run at all
      //   0 against the FORK     genuinely empty — t309's wording, deliberately
      //                          reused: the loop's verify step already reports
      //                          "branch X has 0 commits beyond Y" for this exact
      //                          condition, and a second vocabulary for one
      //                          condition reads as two different findings
      //   0 against a FALLBACK   undecidable — empty and already-fast-forwarded
      //                          are the same count, so neither sentence is safe
      //   count > 0              work landed
      //
      // The third is not pedantry: it was reached with a real branch whose commit
      // had been merged, and calling it empty is the mirror image of the phantom
      // merge — a true merge reported as nothing.
      //
      // `c.base`, not `baseSha`: commitsOnBranch falls through to a merge-base
      // when the mint-time SHA was rebased or gc'd, and naming a base it did not
      // measure against is the same class of false report as the phantom merge.
      // WHY the count fell back, split on the record rather than asserted. There
      // are two ways to reach an unmeasured count and they need different
      // remediation: no fork point was ever recorded, versus one was recorded and
      // has since been rebased or gc'd away (commitsOnBranch drops a SHA that no
      // longer resolves). Saying "none was recorded" about a record that plainly
      // carries one sends the reader hunting a stamping bug that does not exist.
      // A function, not a binding: on the `!c.ok` arm `c.base` is undefined, and
      // an eagerly-built string sits one careless edit away from reporting
      // "counted against undefined" — the same unverified claim this arm exists
      // to remove. Called only where the count came back and fell back.
      const why = () => (baseSha
        ? `its recorded fork point ${baseSha} no longer resolves, so its commits could only be counted against ${c.base}`
        : `no fork point was recorded, so its commits could only be counted against ${c.base}`);
      const outcome = !c.ok
        ? `accepted — branch ${branch} is an ancestor of ${m.base}, but its commit count could NOT be obtained (${c.error || 'unknown error'}), so whether it carried any work is UNKNOWN`
        : c.count === 0 && measured
          ? `accepted — branch ${branch} has 0 commits beyond ${c.base}, so NOTHING was merged; it was torn down as empty`
          : c.count === 0
            ? `accepted — branch ${branch} is an ancestor of ${m.base}, but ${why()}, where an empty branch and one already merged both count 0 — so whether it carried any work is UNKNOWN`
            : `accepted — merged into ${m.base}`;
      // Terminal on all four: the seat is retired and the branch deleted either
      // way, so nothing here invites a second accept and a bound reminder has
      // done its job. An empty branch is finished work too — there is no tree
      // left to come back to.
      finish(`ticket ${ticket.id} ${outcome}; ${parts.join('; ')}.`, true);
    },

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
    },

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
    },

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
    },

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
    },

    startTicketWatchdog(intervalMs = 60000) {
      if (this._ticketWatchdogTimer) return;
      this._ticketWatchdogTimer = setInterval(() => { try { this._sweepTickets(); } catch (e) { log.error('ticket', `watchdog sweep failed: ${e.message}`); } }, intervalMs);
      if (this._ticketWatchdogTimer.unref) this._ticketWatchdogTimer.unref();
    },

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
    },

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
    },

    // The live reviewer seats for a ticket. Resolved off the SAME record fields
    // review-done routes a verdict on (`ephemeral` + `reviewTicket`), so "the
    // seat this ticket's review belongs to" means one thing in both places. A
    // separate rule here could disagree, and the disagreement would be silent:
    // the alarm would probe some other seat's liveness and report it as this
    // review's.
    //
    // SCOPED TO THE TEAM'S PROJECT, like every sibling resolver in this file
    // (`_teamLiveSeats`, `_ticketAssigneeSeat`). `nextTicketId` maxes over ONE
    // board's list, so `t1` exists on every project at once — an unscoped walk
    // lets project B's live reviewer answer for project A's `t1` and SUPPRESS
    // its alarm, which is silent alarm deletion on a board with no seat at all.
    // `_sweepTeamTickets` documents this same per-BOARD/per-PROJECT hazard for
    // `watchdogMs`; this is the same trap one resolver over. The reviewer's cwd
    // resolves to `team.root` via `_projectRootFor`, so the test is exact.
    //
    // Returns ALL matches, not the first. `keepHold` deliberately leaves a
    // round-1 seat alive still carrying `reviewTicket` while round 2 runs, so
    // two records legitimately share one ticket id and map order decides which
    // one a first-match probe reads — it could measure a stranded seat and call
    // the working one wedged.
    _liveReviewSeatsFor(team, ticketId) {
      const out = [];
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        let root; try { root = this._projectRootFor(s.cwd); } catch { root = null; }
        if (!root || root !== team.root) continue;
        let rec = null;
        try { rec = getPersistence().get(s.name); } catch { rec = null; }
        if (rec && rec.ephemeral && rec.reviewTicket === ticketId) out.push(s);
      }
      return out;
    },

    // Accumulated CPU for a pid, in ms, or null when it cannot be read.
    //
    // `ps` rather than anything in-process: the reviewer is a SEPARATE process
    // (a CLI under a pty), so `process.cpuUsage()` measures this app and would
    // answer confidently about the wrong thing.
    //
    // Null on every failure, and the classifier treats null as "no CPU signal"
    // rather than as zero — zero is the wedge verdict, so a failed sample would
    // otherwise alarm about a healthy seat.
    _sampleCpuMs(pid) {
      return new Promise((resolve) => {
        if (!Number.isInteger(pid) || pid <= 0) { resolve(null); return; }
        try {
          childProcess.execFile('ps', ['-o', 'time=', '-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
            resolve(err ? null : parseCpuTime(stdout));
          });
        } catch { resolve(null); }
      });
    },

    // Accumulated CPU over a pty's whole process tree, in ms, or null.
    //
    // One `ps` call for the entire process table rather than one per descendant:
    // the tree is discovered FROM the snapshot, so a per-pid walk would need a
    // call per level and would read a different instant at each one.
    //
    // No command column is requested, so every row is exactly three
    // whitespace-separated fields and a row that yields anything else is
    // dropped. That is what makes the split safe across ps flavors — BSD ps
    // right-pads its columns and procps pads differently, but neither can
    // introduce an interior space once the command is absent.
    //
    // Same null-on-failure contract and same 5s timeout as `_sampleCpuMs`.
    _samplePtyTreeCpuMs(pid) {
      return new Promise((resolve) => {
        if (!Number.isInteger(pid) || pid <= 0) { resolve(null); return; }
        try {
          childProcess.execFile('ps', ['-axo', 'pid=,ppid=,time='], { timeout: 5000 }, (err, stdout) => {
            if (err) { resolve(null); return; }
            const rows = [];
            for (const line of String(stdout || '').split('\n')) {
              const f = line.trim().split(/\s+/);
              if (f.length !== 3) continue;
              const p = Number(f[0]);
              const pp = Number(f[1]);
              if (!Number.isInteger(p) || !Number.isInteger(pp)) continue;
              rows.push({ pid: p, ppid: pp, timeText: f[2] });
            }
            resolve(sumTreeCpuMs(rows, pid));
          });
        } catch { resolve(null); }
      });
    },

    // One seat's liveness sample/classify/confirm, shared by both probe arms.
    //
    // `kind` selects which pair of session fields holds the state: 'review' for
    // the review-step probe, 'stall' for the rung-2 stall probe. Separate pairs
    // on purpose — a seat is never both, but shared fields would let one probe's
    // baseline corrupt the other's clock if that ever changed.
    //
    // Returns the classifier result with the confirmed verdict substituted; the
    // ALL-seats walk lives in the caller, which is the only part that is
    // review-specific.
    _sampleSeatLiveness(s, now, stallMs, kind) {
      const sampleField = kind === 'stall' ? '_stallLiveSample' : '_reviewLiveSample';
      const onceField = kind === 'stall' ? '_stallWedgedOnce' : '_reviewWedgedOnce';
      return (async () => {
        const size = this._seatTranscriptSize(s.name);
        // TREE CPU, not the CLI pid alone: a seat inside a long tool call has
        // its CPU in the child and reads flat everywhere else, so a root-only
        // sample calls a working seat wedged.
        const cpuMs = await this._samplePtyTreeCpuMs(s.pty && s.pty.pid);
        const prev = s[sampleField] || null;
        const cur = {
          at: now,
          size,
          cpuMs,
          // Anchors "how long has it written nothing" across sweeps. Seeded at
          // the first sample rather than left null: the seat may have been
          // writing for an hour before this probe existed, and claiming a flat
          // stretch we never measured is the confidently-wrong field
          // stall-evidence.js refuses.
          lastGrowthAt: (!prev || didGrow(prev.size, size)) ? now : (prev.lastGrowthAt || prev.at),
        };
        const r = classifyReviewSeat(prev, cur, { stallMs });
        // A gap too short to read is NOT a sample. Overwriting the baseline with
        // it would reset the clock every sweep, so under a sweep interval below
        // MIN_GAP_MS no pair could ever span the minimum and the probe would
        // answer `unknown` forever — the review alarm gone, silently. Keeping the
        // older baseline turns that coupling from silence into latency: the gap
        // grows until it qualifies, and the constraint enforces itself rather
        // than resting on a comment nobody reads.
        if (r.verdict !== 'unknown' || !prev) s[sampleField] = cur;
        // TWO CONSECUTIVE wedged verdicts before the alarm. Linux procps reports
        // CPU in WHOLE SECONDS (macOS gives centiseconds), so a composing turn
        // accruing 0.35s across a short gap reads as exactly 0 there — a single
        // bad sample that looks identical to a wedge. It also absorbs the tree
        // sum's one non-monotonic step (a child exiting between samples drops
        // CPU out of the total). Repeating the verdict costs one sweep against a
        // 30m window and hardens the probe against any one-off bad sample.
        let verdict = r.verdict;
        if (verdict === 'wedged') {
          const confirmed = s[onceField] === true;
          s[onceField] = true;
          if (!confirmed) verdict = 'unknown';
        } else if (r.verdict !== 'unknown') {
          // An unreadable sample neither confirms NOR clears a wedge. Clearing on
          // `unknown` re-enters the bug the baseline guard above just fixed, one
          // layer over: under a sweep interval below MIN_GAP_MS the verdicts
          // alternate wedged/unknown forever, the flag is reset before it can be
          // read a second time, and the alarm never fires — silent alarm deletion,
          // reintroduced by the confirmation step that was itself a hardening fix.
          s[onceField] = false;
        }
        return { ...r, verdict };
      })();
    },

    // The structural half of the rung-2 wake gate. Called at SWEEP time and
    // again inside `produce` from this one definition: the states change between
    // the two, so a second copy would drift in the direction that writes into a
    // seat the sweep refused. The lead is excluded as rung 3's RECIPIENT — an
    // automated write into the operator's session has no rung above it.
    _wakeSeatEligible(team, seat, now, stallMs) {
      if (!seat || seat._dead) return false;
      if (seat.name === team.lead) return false;
      // ONE wake per seat per stall window, across ALL of its tickets: the budget
      // is per-SEAT because the composer is, and a second Ctrl-U destroys what the
      // first produced. Per-ticket `wakeAt` cannot express this (two records know
      // nothing of each other), and `_stallLiveSample` does not either — the first
      // ticket stops probing the moment it wakes, handing the second a readable
      // gap plus an already-true `_stallWedgedOnce`.
      if (seat._stallWakeAt && (now - seat._stallWakeAt) < stallMs) return false;
      // Claude-only for the same reason `_armReviewStartCheck` is: the probe
      // reads `transcript.jsonl`, which only the Claude hook writes, so a codex
      // seat would classify wedged on a one-signal read of permanent silence.
      if (seat.agentType !== 'claude') return false;
      // Not a second copy of the claude test — that stands in for readability,
      // this checks it. `didGrow` refuses -1 -> -1, so a broken symlink leaves the
      // wedge verdict on CPU alone: the one-signal read that excludes codex,
      // reached by another route.
      if (this._seatTranscriptSize(seat.name) < 0) return false;
      if (seat.activityState !== 'idle') return false;
      // Injection ends with Enter, which would ANSWER the dialog.
      if (seat.needsAttention && seat.needsAttention.kind === 'permission') return false;
      // The latch IS the recovery mechanism for an unconsumed write, and it
      // redelivers the actual content. A wake's induced turn clears it as if
      // consumed while the Ctrl-U destroyed the draft it was about.
      if (seat._specUnconfirmed) return false;
      // Same shape one layer over: the induced turn would clear the fifo before
      // its 90s report ever told the senders. `_dmUnconfirmedLast` does NOT
      // block — those senders have been told.
      if (seat._dmUnconfirmed && seat._dmUnconfirmed.length) return false;
      try { if (isDraftOpen(seat)) return false; } catch { return false; }
      return true;
    },

    // The one line a wake injects. Hedged for every race the gate cannot close:
    // the produce-to-Enter gap, and a tool child blocked on I/O (no CPU accrues
    // anywhere in the tree, so a healthy seat can classify wedged).
    //
    // The "no spec" exit is not decoration. The seat's eaten draft may have BEEN
    // the spec, with the spec latch's one retry already spent — waking a seat
    // that knows only a ticket id, with no way to say so, strands it.
    _wakeText(ticket, now, lead) {
      const last = ticket.lastActivityAt || ticket.openedAt || now;
      return `[ticket ${ticket.id} wake] this ticket has had no activity for ${humanizeAge(now - last)} `
        + `and this seat has taken no turn in that time, so this is an automated wake — nothing new is being asked. `
        + `If your last turn was interrupted (an API error, a lost delivery), resume the ticket and close with `
        + `${ticketCloseVerb(ticket.id)} as before. If you are already working or have already closed it, ignore this. `
        + `If you never received the ticket's spec, say so: [agent:dm ${lead}] ticket ${ticket.id} reached me with no spec.`;
    },

    // Rung 2: one injected line into a wedged-confirmed seat, before the lead is
    // told anything. `parkable` is deliberately ABSENT — a parked wake drains on
    // the seat's next turn, which is the thing that is never coming. `produce`
    // aborts instead, inside the queue's critical section, so returning null
    // cancels the Ctrl-U itself. The sweep's decision and the write are separated
    // by the boot-ready gate, the quiet gate and queue depth, and a seat that
    // takes a turn inside that gap must not be written to.
    _wakeStalledSeat(team, ticket, seat, now, stallMs) {
      const tid = ticket.id;
      const seenAt = ticket.lastActivityAt || null;
      const finalText = this._buildDeliveryText(seat, 'ticket-watchdog',
        this._wakeText(ticket, now, team.lead), 'dm', `[ticket ${tid} wake]`);
      this._injectText(seat, '', {
        produce: () => {
          try {
            if (!this._wakeSeatEligible(team, seat, now, stallMs)) return null;
            const fresh = ticketsStore.load(team.root);
            const rec = fresh.find((x) => x.id === tid);
            if (!rec) return null;
            if (!ticketInFlight(rec)) return null;
            // The episode this wake was decided FOR. Activity inside the window
            // ends the stall, and waking then spends the next episode's one wake
            // before it starts.
            if ((rec.lastActivityAt || null) !== seenAt) return null;
            // The real double-wake dedup: the decision point sits outside the
            // `_stallProbing` window, so no sweep-side set serializes this, and
            // whichever producer runs first stamps.
            const recLast = rec.lastActivityAt || rec.openedAt || 0;
            if (rec.wakeAt && rec.wakeAt - recLast > 0) return null;
            // Stamped BEFORE the bytes go out, and with `now` rather than
            // Date.now(): the take-window is measured from the instant the sweep
            // judged, not from when the queue happened to write.
            rec.wakeAt = now;
            ticketsStore.save(team.root, fresh);
            // The seat-side half of the budget, stamped in the same critical
            // section as the record's so the two cannot disagree. On the SESSION,
            // like the liveness samples, so it dies with the seat rather than
            // denying a wake to a fresh seat that reused the name.
            seat._stallWakeAt = now;
            return finalText;
          } catch (e) {
            log.error('ticket', `wake stamp for ${tid} failed: ${e.message}`);
            return null;
          }
        },
      });
    },

    // Two-signal liveness for the seat behind a `loopStep: review` ticket.
    //
    // The samples come from CONSECUTIVE SWEEPS, not from two readings inside
    // one: the sweep already runs every 60s, and sleeping inside a watchdog
    // timer to take a second sample would block the pass behind it. The cost is
    // that the first sweep after a seat appears has no baseline and returns
    // 'unknown' — one sweep, 60s, against a 30m stall window.
    //
    // The sample lives on the SESSION, not in a manager-level map, so it dies
    // with the seat. A map keyed by seat name would accumulate an entry per
    // review round for the life of the process, and a stale entry under a reused
    // name would be compared against a different seat's history.
    async _probeReviewSeat(team, ticket, now, stallMs) {
      const seats = this._liveReviewSeatsFor(team, ticket.id);
      if (!seats.length) return null;   // no live reviewer — the loop-held body stands unqualified
      let worst = null;
      for (const s of seats) {
        const r = await this._sampleSeatLiveness(s, now, stallMs, 'review');
        // ANY seat alive suppresses: with two records sharing a ticket id, a
        // stranded round-1 seat must not be able to raise an alarm about a round
        // 2 that is working. Where the resolver is ambiguous this ticket fails
        // toward "alive" — its whole purpose is removing false alarms.
        if (r.verdict === 'moving' || r.verdict === 'unknown') {
          return { seat: s.name, ...r };
        }
        if (!worst) worst = { seat: s.name, ...r };
      }
      return worst;
    },

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
          // THE REVIEW STEP IS THE ONE LOOP STEP WITH A LIVE SEAT BEHIND IT, and
          // until t384 it was the only step with no seat-liveness input at all:
          // the orphan test excludes loop-held tickets (correctly — they name a
          // step, not an assignee), so `loopStep` age was the whole signal. A 39KB
          // diff takes longer than the window, so the longest-running step was
          // also the one that cried wolf. Measured on t377: the alarm fired at 30m
          // while the reviewer was demonstrably working.
          //
          // Suppression requires BOTH signals to say alive, and the probe is
          // consulted ONLY at `review` — the other steps have no seat to ask
          // about, and a probe that returns null there must not be read as a
          // verdict.
          let seatInfo = null;
          if (t.loopStep === 'review') {
            this._stallProbing.add(tid);
            try { seatInfo = await this._probeReviewSeat(team, t, now, stallMs); }
            catch { /* a failed probe alarms unqualified — never silences */ }
            finally { this._stallProbing.delete(tid); }
            // Re-read after the await for the same reason the seat branch does:
            // the review can land while `ps` runs, and alarming about a step the
            // ticket has already left is the false positive in a new costume.
            const after = ticketsStore.load(team.root).find((x) => x.id === tid);
            if (!after || !ticketInFlight(after) || after.loopStep !== 'review') continue;
            if ((after.lastActivityAt || null) !== seenAt) continue;
            // DEMONSTRABLY ALIVE: transcript growing, or CPU accruing on a turn
            // that has not flushed yet. Not a widened window and not a removed
            // alarm — the ticket stays in-flight and the next sweep asks again,
            // so a seat that wedges later is still caught.
            //
            // `unknown` defers too, and that is the whole point rather than a
            // convenience: it means a reviewer seat IS live but this is the first
            // sample, so there is no baseline to read growth against. Alarming
            // there is the blind pre-t384 alarm — the measured false positive,
            // fired at the first sweep past the window at a seat nobody asked
            // about. Deferring costs ONE sweep (60s) against a 30m window, and it
            // is bounded: the sample is stored below, so the next sweep has a
            // baseline and either classifies or alarms. A seat that is not live
            // returns null and never reaches this, so nothing can defer forever
            // on a seat that no longer exists.
            if (seatInfo && (seatInfo.verdict === 'moving' || seatInfo.verdict === 'unknown')) continue;
          }
          const head = repeat > 0 ? `[ticket ${tid}] STILL stalled (repeat ${repeat}): ` : `[ticket ${tid}] stalled: `;
          // A HELD ticket is not a stuck one, and saying so is the difference
          // between two different recoveries. The loop did not die here: it ran a
          // check, the check failed, and it told the lead — the ticket is waiting
          // on a human to act. "The loop is stuck" sends the lead to look for a
          // dead step, which is the unmarked-repeat hazard this sweep already
          // documents, one class out: an alarm that misnames what is wrong invites
          // exactly the wrong first move.
          //
          // Named off the STAMP rather than off `loopStep`, which reads `verify`
          // on a running check and a held one alike. The stamp exists only in the
          // second case, so it is what separates them — and it carries the check
          // by name, so the alarm re-states what the DM said in case that DM is
          // the one that was never read.
          if (t.verifyHold) {
            body = `${head}the loop ESCALATED at "${t.verifyHold.step}" and is waiting for someone to act — ${humanizeAge(now - last)} ago, and nothing has moved since.`
              + `\n\nEVIDENCE: ${t.verifyHold.evidence}`
              + `\n\nThis is NOT a stalled step — the tree, the branch and the seat are as they were. `
              + `The hand fixes what the check named and closes the ticket again ([agent:task done ${tid}]), which re-runs the checks from here. `
              + `Reject it only if the work genuinely needs rework.`;
          } else {
          body = `${head}the ticket loop is stuck at "${t.loopStep}" — no progress for ${humanizeAge(now - last)} (the hand already reported; nothing was torn down)`
            + formatReviewSeatClause({
              seat: seatInfo && seatInfo.seat, verdict: seatInfo && seatInfo.verdict,
              cpuRead: !!(seatInfo && seatInfo.cpuRead),
              flatFor: seatInfo && seatInfo.flatFor,
              // The MEASURED flat stretch, not the ticket's quiet age. They are
              // different durations and the clause names the seat's: `flatFor`
              // only reaches `stallMs` after the ticket has been quiet for at
              // least twice that, so passing the ticket age says "1h" about a
              // seat measured flat for 30m. The formatter cannot catch this —
              // it is handed a self-consistent pair — so the mismatch lives here.
              age: seatInfo && seatInfo.flatFor != null ? humanizeAge(seatInfo.flatFor) : null,
            });
          }
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
          const seatNow = this._ticketAssigneeSeat(team, after);
          orphanNow = !foreignRole && !seatNow;
          // RUNG 2, between the stall window and the lead's first alarm. Reads
          // `seatNow`, never the pre-await snapshot: a seat that spawned during
          // the git probe is exactly the one this must not wake.
          //
          // `wakeAge` is read the way `prevAge` reads `nudgedAt` — relative to
          // the episode — so a stamp predating this episode's activity reads as
          // not-attempted and needs no clearing site.
          const wakeSeat = orphanNow ? null : this.sessions.get(seatNow);
          const wakeAge = after.wakeAt ? after.wakeAt - (after.lastActivityAt || after.openedAt || 0) : 0;
          if (wakeSeat && prevAge <= 0 && wakeAge <= 0) {
            // Bounded by the grace window, and the bound is enforced BEFORE the
            // probe: with rung 3 held, `nudgedAt` stays null and `prevAge <= 0`
            // holds forever, so an ungated wake could fire hours in — after the
            // lead already owns the recovery.
            const graceLeft = (now - last) < (stallMs + WAKE_GRACE_MS);
            // ANY structural refusal alarms now rather than deferring, against
            // §7 — permanent ones (codex, unreadable transcript, the lead) can
            // never become eligible by waiting, and the transient ones (dialog,
            // latch, draft, mid-turn) are chosen to alarm too: that is exactly
            // the pre-rung-2 behaviour, and the overlap is narrow because
            // `_touchTicketActivity` fires on the turn edge.
            if (graceLeft && this._wakeSeatEligible(team, wakeSeat, now, stallMs)) {
              let verdict = null;
              try { verdict = (await this._sampleSeatLiveness(wakeSeat, now, stallMs, 'stall')).verdict; }
              catch { verdict = null; }   // an unreadable probe alarms, never silences
              if (verdict === 'wedged') {
                // Re-checked inside `produce` at write time; this is the cheap
                // refusal, not the guarantee.
                this._wakeStalledSeat(team, after, wakeSeat, now, stallMs);
                continue;
              }
              // Short of wedged-confirmed — including `unknown`, which is "no
              // baseline yet" rather than a reading. Bounded by the grace test
              // above, so this defers at most a few sweeps and never silently.
              continue;
            }
          } else if (wakeAge > 0 && (now - after.wakeAt) < WAKE_CONFIRM_MS) {
            continue;   // the take-window: the wake may still produce a turn
          }
          // Read from the SEAT the ticket resolves to now, not from the pre-await
          // snapshot: the same staleness the re-resolve above exists to fix would
          // otherwise attribute one seat's silence to another seat's latch.
          const dmEv = seatNow ? this._dmLatchEvidence(seatNow) : null;
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
              // Why the seat is quiet, when this process happens to know: a dm
              // was written into it and no turn ever followed. Only on this arm
              // — the orphan arm has no seat to have been written to, and the
              // loop-held arm names a stuck STEP, where a seat's dm history is
              // not what is stalled.
              dmLatch: dmEv && { count: dmEv.count, age: humanizeAge(now - dmEv.at) },
              // Only when the stamp belongs to THIS episode: `wakeAge` carries
              // that test, so the raw field would report a previous episode's
              // wake as evidence about this one.
              wake: wakeAge > 0 ? { age: humanizeAge(now - after.wakeAt) } : null,
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
    },

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
    },
  };
}

module.exports = { createTicketMethods, ticketCloseLine, ticketCloseVerb, ticketTaskDirLine };
