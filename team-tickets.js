const { nextTicketId, recordEvent, titleLine, ticketTitle, extractTaskDir, extractMustFix, countMustFix, mustFixTitles, ticketStarted, ticketInFlight, branchSlug, appendReworkReason } = require('./tickets-store');
const teamCost = require('./team-cost');
const { defuseSenderLines } = require('./review-gate');
const { buildReviewScope, reviewBeginLine } = require('./ticket-review-scope');
const { projectDirFor } = require('./clodex-paths');
const { TEST_ROOTS } = require('./scripts/clodex-run-tests');
// Not named `path`: inside createTicketMethods that name is the injected one,
// and shadowing it would swap a fixture's probe for the real module.
const nodePath = require('path');
const {
  readTail, lastToolFromFile, lastApiErrorFrom, formatStallBody, formatOrphanBody,
  sumTreeCpuMs, parsePsRows, classifyReviewSeat, formatReviewSeatClause, didGrow,
} = require('./stall-evidence');
const { isDraftOpen } = require('./proxy-util');
const { resolveAccountLabel, accountMissingError } = require('./accounts');
const { trackedSessionIds: entrySessionIds } = require('./session-info');
const { hostNotice } = require('./host-stamp');
const {
  matchSeatRole, defaultLeadSeat, ROLE_RE, RESERVED_ROLE_KEYS, STOCK_ROLE_DEFS,
  DEFAULT_ROLE_DISPATCH,
} = require('./team-manifest');
const {
  readTeamJson, teamTemplatePath, teamTemplateSave, teamTemplateRemove, teamPromptSave, teamPromptRemove,
  teamPromptFile,
} = require('./team-prompt-dir');
const { resolveModelId, deriveModelTemplate, deriveEffortTemplate } = require('./team-template-derive');
const { seatType, adapterFor, DEFAULT_TYPE, PLATFORMS, hasBypass, resolveEffort } = require('./cli-adapters');
const { readerFor } = require('./transcript-readers');
const { ctxThresholdsFor } = require('./ctx-reminder');
const { formatGatherReport } = require('./team-gather');
const { expandTeamRoot } = require('./team-root-expand');
const { CLAUDE_TOOLS } = require('./catalogs');
const { BOX_ID_RE } = require('./sandbox');
const { ensureDir: ensureDirMode700, atomicWriteFileSync } = require('./fs-util');
const { seedSandboxSessions } = require('./sandbox-seeds');
const RUNNER_OWNER = require('crypto').randomUUID();

const SANDBOX_ACTIONS = ['up', 'rebuild', 'down', 'status'];
const SANDBOX_DEFAULT_REF = 'master';
const SANDBOX_HOME_DIR = '/home/clodex';
const SANDBOX_WORK_DIR = '/home/clodex/work';
const SANDBOX_TEAM_SUBDIRS = ['prompts', 'templates', 'exec'];

function seedClaudeToken(mgr, box) {
  if (typeof box.hasAuthToken !== 'function' || box.hasAuthToken()) return { state: 'present' };
  const ids = (mgr.list ? mgr.list() : []).map((b) => b && b.id).filter((id) => id && id !== box.id);
  const order = ['shared', 'sandbox', ...ids.filter((id) => id !== 'shared' && id !== 'sandbox')];
  for (const id of order) {
    if (!ids.includes(id)) continue;
    const donor = mgr.get(id);
    const tok = donor && typeof donor.authToken === 'function' ? donor.authToken() : null;
    if (!tok) continue;
    const r = box.setAuthToken(tok);
    if (r && r.ok === false) return { state: 'failed', from: id, error: r.error };
    return { state: 'seeded', from: id };
  }
  return { state: 'none' };
}

function claudeSeedClause(seed, boxId) {
  if (!seed || seed.state === 'present') return '';
  if (seed.state === 'seeded') return ` · claude token seeded from ${seed.from}`;
  if (seed.state === 'failed') return ` · claude token from ${seed.from} NOT written: ${seed.error}`;
  return ` · NO CLAUDE TOKEN: no box has one to borrow — paste a \`claude setup-token\` for ${boxId} in Settings ▸ Sandboxes, or log in inside the box`;
}

function leadSeedClause(result, leadName) {
  if (result && result.state !== 'failed') return ` · lead ${leadName} ${result.state}`;
  const error = (result && result.error) || 'the box reported nothing for it';
  const hint = /invalid type "undefined"/.test(error) ? ' (the box image predates the team arm — rebuild it)' : '';
  return ` · lead ${leadName} NOT seeded: ${error}${hint}`;
}

function sha8(sha) {
  const s = String(sha == null ? '' : sha);
  return s ? s.slice(0, 8) : 'unknown';
}

function sandboxRefClause(st) {
  return (st && st.ref) ? ` (ref ${st.ref})` : '';
}

function sandboxVersionClause(peerStatus) {
  if (!peerStatus || !peerStatus.version) return ' · clodex version unknown (box not reporting on its wire)';
  return peerStatus.online
    ? ` · clodex ${peerStatus.version}`
    : ` · clodex ${peerStatus.version} (last seen; the box's wire is offline now)`;
}

function sandboxPortClause(st) {
  const ports = (st && st.ports) || {};
  if (!ports.web && !ports.wire) return '';
  return ` — web ${ports.web ? `http://127.0.0.1:${ports.web}` : '(no port)'}`
    + ` · wire ${ports.wire ? `:${ports.wire}` : '(no port)'}`;
}

const TEAM_FILE_BODY_MAX = 64 * 1024;

const LANDED_TICKET_LIMIT = 5;

// Sized to a whole suite run: a shorter wait escalates a ticket whose only fault
// was closing while the lead's suite was running.
const TICKET_SUITE_LOCK_WAIT_MS = 20 * 60 * 1000;

// The kill timer starts at spawn, so it must stay strictly greater than the lock wait or a queued run is reported killed;
// the running margin must exceed scripts/run-tests.js `RUN_TIMEOUT_MS` so the runner names the hung file first.
const TICKET_SUITE_TIMEOUT_MS = TICKET_SUITE_LOCK_WAIT_MS + 21 * 60 * 1000;

// Keep both bounds: attempts alone let a retry into a busy merge chain stretch to hours,
// a deadline alone lets a fast lock flap spin the timer hundreds of times.
const MERGE_RETRY_DELAY_MS = 30 * 1000;
const MERGE_RETRY_MAX_WAIT_MS = 20 * 60 * 1000;
const MERGE_RETRY_MAX_ATTEMPTS = Math.ceil(MERGE_RETRY_MAX_WAIT_MS / MERGE_RETRY_DELAY_MS);
const BOOT_REQUEUE_LEAD_WAIT_MS = 5 * 60 * 1000;
const BOOT_REQUEUE_LEAD_POLL_MS = 2 * 1000;

// team.json is agent-writable, so the effective allowlist is the intersection of this cap
// and any manifest `tools`: a manifest may narrow it, never widen past it.
const REVIEWER_TOOL_CAP = ['Read', 'Grep', 'Glob'];

const REVIEWER_SHELL_DENY = [
  'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(mv:*)', 'Bash(cp:*)', 'Bash(touch:*)',
  'Bash(mkdir:*)', 'Bash(chmod:*)', 'Bash(chown:*)', 'Bash(ln:*)', 'Bash(tee:*)',
  'Bash(dd:*)', 'Bash(truncate:*)',
  'Bash(sed -i:*)', 'Bash(sed --in-place:*)', 'Bash(perl -i:*)',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git checkout:*)',
  'Bash(git switch:*)', 'Bash(git reset:*)', 'Bash(git restore:*)',
  'Bash(git stash:*)', 'Bash(git push:*)', 'Bash(git pull:*)', 'Bash(git fetch:*)',
  'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git clean:*)',
  'Bash(git worktree:*)', 'Bash(git branch -d:*)', 'Bash(git branch -D:*)',
  'Bash(git tag:*)',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(yarn:*)', 'Bash(pnpm:*)', 'Bash(bun:*)',
  'Bash(node -e:*)', 'Bash(node --eval:*)',
  'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(kill:*)', 'Bash(pkill:*)', 'Bash(killall:*)',
];
const REVIEWER_SHELL_TOOL = 'Bash';

const REVIEWER_CAP_MODES = {
  'tool-denylist': { argv: false, note: null },
  argv: { argv: true, note: 'read-only sandbox (OS-enforced), approvals: never' },
  'settings-profile': { argv: true, note: 'permission profile "reviewer" (:read-only, approvals allowed, writes denied)' },
};

const REVIEWER_ENV_ALLOWLIST = new Set([
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'FORCE_PROMPT_CACHING_5M',
  'CLODEX_DISABLE_IPC_PROMPT',
  'CLODEX_SPAWNER_HINT',
  'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
]);

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
  return { sessionEnv: Object.keys(env).length ? env : null, dropped, badType };
}

const ticketCloseVerb = (id) => `[agent:task done ${id}]`;
const HOLD_RECOVERY = {
  hand: (id) => `Fix what the check named, then close the ticket again — ${ticketCloseVerb(id)} <your report>. `
    + 'That re-runs the checks from where they stopped; the ticket stays done and no rework round is counted.',
  // The spec arm must not tell the reader to reject and re-file: that counts a rework round for a defect the hand did not write,
  // and the refused-task-dir subject in `ticket-loop-verify.test.js` asserts it does not.
  spec: (id) => `Re-closing alone will NOT help: the check re-reads the same spec and fails identically. `
    + `Correct the spec's \`tasks/…\` line first — the spec is editable on the board in any state, and the ticket stays held while you do it — `
    + `then ${ticketCloseVerb(id)} <your report> to re-run the checks from here.`,
  // Own arm rather than the hand's advice, which would send a seat to
  // re-commit against a failure its branch never caused.
  infra: (id) => `This is not something the branch can fix — the check could not RUN. `
    + `Once the cause is cleared, ${ticketCloseVerb(id)} <your report> re-runs the checks from here.`,
};
const holdRecoveryText = (cls, id) => (HOLD_RECOVERY[cls] || HOLD_RECOVERY.hand)(id);
// Not shared with `_notifyHandOfHold` (second person, and the person is the message) or `_notifyMergeLanded`,
// whose closing accept intent is inert only because prose precedes it on its line; ticket-auto-merge.test.js pins it.
const NOTHING_TORN_DOWN = 'Nothing was torn down — the worktree, the branch and the seat are exactly as they were.';

const VERDICT_BRIEF_TITLES = 5;
const VERDICT_BRIEF_TITLE_BYTES = 160;
const ticketCloseLine = (id) => `CLOSE WITH: ${ticketCloseVerb(id)} <your report> — one intent, at the end: it delivers the report to the lead AND marks the ticket done. `
  + `It is a line you emit yourself, like any [agent:…] intent — NOT an exec command, and nothing needs to be granted for it. `
  + `A dm carrying your report does NOT close the ticket: the ticket stays open, and everything downstream of the close (tree verify, review) never runs.\n`;
// The relative-path gate lives here, not at call sites: both helpers are exported, and a caller gating on mere presence
// would call an absolute path relative to the artifact dir.
const taskDirRelative = (raw) => !!raw && !raw.startsWith('~') && !nodePath.isAbsolute(raw);

// One clause shared by the hand's dispatch and the reviewer's scope so the rule has a single wording;
const taskDirRuleClause = (raw) => (taskDirRelative(raw)
  ? ` — the spec's \`${raw}\` is relative to the PROJECT'S ARTIFACT DIR, `
    + `not to your cwd, and a same-named directory inside the repo is NOT it. `
    + `This is the directory itself (the pointer may name a file inside it); it may not exist yet, `
    + `and its absence is not evidence that there is no artifact.`
  : '');
const taskDirCreateClause = ` So create it rather than working without one.`;
const ticketTaskDirLine = (dir, raw) => {
  const rule = taskDirRuleClause(raw);
  return `TASK DIR: ${dir}${rule}${rule ? taskDirCreateClause : ''}\n`;
};
const DEFAULT_REVIEWER_TEMPLATE = 'clodex-team-reviewer';
const DEFAULT_LEAD_TEMPLATE = 'clodex-team-lead';
const REVIEWER_PROMPT_PREFIX = 'clodex-team-reviewer';

const REVIEWER_FALLBACK = {
  systemPromptFile: 'clodex-team-reviewer',
  intents: [],
  tools: ['Read', 'Grep', 'Glob'],
  env: {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    FORCE_PROMPT_CACHING_5M: '1',
    CLODEX_DISABLE_IPC_PROMPT: '1',
    CLODEX_SPAWNER_HINT: 'off',
    // Plain digits, never exponent form: the CLI parses '6e4' as 6. Read's 25000-token default
    // makes a reviewer paginate through the one diff we most want read in a single pass.
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '60000',
  },
};

// Template extraArgs are refused wholesale (--allowedTools, --mcp-config and --dangerously-skip-permissions ride there,
// and REVIEWER_TOOL_CAP screens none); only a rebuilt `--model` is carved out, since it grants no authority.
function reviewerModelArgs(extraArgs, adapter) {
  const a = Array.isArray(extraArgs) ? extraArgs : [];
  const flag = (adapter || adapterFor(DEFAULT_TYPE)).model.flags[0];
  const usable = (v) => typeof v === 'string' && v && !v.startsWith('-');
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (typeof tok !== 'string') continue;
    if (tok === '--model' || tok === '-m') {
      // A value-less --model is dropped, not emitted bare: it would swallow the next argv token.
      const v = a[i + 1];
      if (usable(v)) return { args: [flag, v], refused: null };
      return { args: [], refused: typeof v === 'string' ? `${tok} ${v}` : tok };
    }
    if (tok.startsWith('--model=')) {
      const v = tok.slice('--model='.length);
      return usable(v) ? { args: [flag, v], refused: null } : { args: [], refused: tok };
    }
  }
  return { args: [], refused: null };
}

const TICKET_STALL_MS = 30 * 60 * 1000;

// Bounds the rung-2 wake's deferral of the first alarm (sweeps plus jitter take 2-3 minutes),
// so a probe stuck at `unknown` alarms rather than deferring forever.
const WAKE_GRACE_MS = 5 * 60 * 1000;

const MERGED_ACCEPT_NUDGE_MS = 10 * 60 * 1000;

function humanizeAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function closeOutDetail(ticketId, text) {
  const s = String(text == null ? '' : text).trim();
  const head = `ticket ${ticketId} accepted — `;
  return s.startsWith(head) ? s.slice(head.length) : s;
}

// No `rejected` filter: reject reopens a ticket to 'open', so it would always answer none and read as nothing rejected.
// Mirrored in scripts/clodex-team.js.
const TICKET_FILTERS = ['open', 'done', 'cancelled', 'all'];

const RECENT_DONE_MS = 24 * 60 * 60 * 1000;
const RECENT_DONE_CAP = 10;
const RECENT_DONE_LABEL = `${RECENT_DONE_MS / (60 * 60 * 1000)}h`;

function mintedForTicket(entry, ticket = null) {
  if (!entry || entry.ephemeral !== true || !entry.ticketId) return false;
  if (!ticket) return true;
  return entry.ticketId === ticket.id;
}

function standingSeat(entry) {
  return !mintedForTicket(entry) && !(entry && entry.reviewFor);
}

function seatCwdInTree(root, seatCwd, treePath) {
  if (!treePath) return seatCwd;
  if (!root || !seatCwd) return treePath;
  const rel = nodePath.relative(nodePath.resolve(root), nodePath.resolve(seatCwd));
  if (!rel) return treePath;
  if (rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel)) return treePath;
  return nodePath.join(treePath, rel);
}

function ignoreCwdDir(fs, seatCwd, cwdDir) {
  const dir = nodePath.join(seatCwd, cwdDir);
  const file = nodePath.join(dir, '.gitignore');
  try {
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch { cur = null; }
    if (cur === '*\n') return null;
    if (cur !== null) return `${file} already exists and is not the \`*\` marker, so it was left as is; the hand's tree may show ${cwdDir}/ contents as untracked`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '*\n');
    return null;
  } catch (e) {
    return `could not write ${file} (${e.message}); the hand's tree will show ${cwdDir}/ as untracked`;
  }
}

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
    setTeamTrunk,
    setLead,
    createTeam,
    kitCatalog,
    resolveKit,
    teamsDir,
    refreshAppMenu,
    gatherTeam,
    resolveTeam,
    resolveSystemPromptFile,
    childProcess,
    ensureDir,
    findProjectRoot,
    fs,
    os,
    path,
    pathFor,
    getAccounts,
    getPeerManager,
    getPersistence,
    getRemindScheduler,
    getSandboxManager,
    getTemplates,
    getUiSettings,
    listAllTemplates,
    getUserDataPath,
    gitWorktree,
    isAlive,
    listTeams,
    loadManifest,
    log,
    withoutPrivilegedIntentsFor,
    PENDING_DIR,
    parkedTexts,
  } = deps;
  const seedFetch = deps.fetch || ((...a) => globalThis.fetch(...a));
  const accountStore = () => {
    try { return (typeof getAccounts === 'function' && getAccounts()) || null; }
    catch { return null; }
  };
  const resolveAccount = (label) => resolveAccountLabel(accountStore(), label);
  const allTemplates = () => (typeof listAllTemplates === 'function'
    ? listAllTemplates().filter((t) => t && !t.team)
    : getTemplates().list());
  const {
    // Constructed once by createSessionManager: core's list() badge and these verbs must agree on cache and ordering,
    // which two stores would not.
    ticketsStore,
    // Passed in rather than required, so its export keeps its home and no require cycle forms.
    nameConflict,
    // Derived core-side; re-deriving it here would put the same default in two files.
    SPEC_CONFIRM_MS,
  } = shared;

  // Aliased to the spec latch's window, not re-derived: two numbers for one question drift, and the confirm term cannot be
  // gated away since a wake just inside the grace window still opens a full take-window.
  const WAKE_CONFIRM_MS = SPEC_CONFIRM_MS;

  // Injectable so a test can reach the kill arm: a runner that never exits is SIGKILLed and escalates, never rejects.
  const TICKET_SUITE_TIMEOUT = Number.isFinite(deps.ticketSuiteTimeoutMs)
    ? deps.ticketSuiteTimeoutMs : TICKET_SUITE_TIMEOUT_MS;

  return {
    // The three-marker filter is an identity read off the record, with no stat: a sweep keyed on a missing recorded path
    // would drop records for an unmounted volume or a moved repo. Stale `worktree` pointers are left unswept on purpose.
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

    _validateSeatName(name) {
      if (!name) return { ok: false, error: 'usage [agent:spawn name:X cwd:Y [template:Z]]' };
      if (!AGENT_NAME_RE.test(name)) {
        return { ok: false, error: `invalid name "${name}" — allowed [a-zA-Z0-9._-], 1-64 chars` };
      }
      if (this.sessions.has(name) || getPersistence().get(name)) {
        return { ok: false, error: `name taken "${name}"` };
      }
      return { ok: true };
    },

    _handleSpawnIntent(spawner, intent, opts = {}) {
      const reply = typeof opts.onReply === 'function'
        ? (msg) => opts.onReply(msg)
        : (msg) => this._injectText(spawner, `[agent:spawn] ${msg}`, { parkable: true });
      const name = (intent.name || '').trim();
      const seatName = this._validateSeatName(name);
      if (!seatName.ok) { reply(`error: ${seatName.error}`); return; }

      let spawnerTeam = null;
      try { spawnerTeam = resolveTeam(spawner.cwd); } catch { spawnerTeam = null; }

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
          const own = readTeamJson({ fs, path }, spawnerTeam, 'templates', v);
          if (own) {
            tpl = { ...own, name: v, id: v };
          } else {
            const wanted = v.toLowerCase();
            const all = allTemplates();
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
      }
      let tplLabel = tpl ? (tpl.name || intent.template) : null;

      const rawCwd = (intent.cwd || (tpl && tpl.cwd) || '').trim();
      if (!rawCwd) {
        reply(tpl
          ? `error: template "${tplLabel}" has no cwd — add cwd: to the spawn`
          : 'error: usage [agent:spawn name:X cwd:Y [template:Z]]');
        return;
      }
      // Resolved from the spawner's team so one shipped template serves every team; an unresolved root must refuse, not fall back.
      const spawnerRoot = (spawnerTeam && spawnerTeam.root) || '';
      const expandedCwd = expandTeamRoot(rawCwd, spawnerRoot);
      if (!expandedCwd.ok) {
        reply(`error: ${tpl ? `template "${tplLabel}" cwd: ` : ''}${expandedCwd.reason}`);
        return;
      }
      const cwd = path.resolve(expandedCwd.value.replace(/^~(?=$|\/)/, os.homedir()));

      let leadNote = '';
      let targetTeam = null;
      try { targetTeam = resolveTeam(cwd); } catch { targetTeam = null; }
      if (!tpl && targetTeam && name === targetTeam.lead) {
        const stem = (targetTeam.roles && targetTeam.roles.lead && targetTeam.roles.lead.template)
          || DEFAULT_LEAD_TEMPLATE;
        const shape = this._templateShape(stem, targetTeam);
        if (shape && shape.tpl) {
          tpl = shape.tpl;
          tplLabel = tpl.name || stem;
          leadNote = ` (lead of team ${targetTeam.name})`;
        } else {
          leadNote = ` — lead role template "${stem}" not installed, spawned with no template`;
        }
      }
      // A bare `worktree:` that parsed to nothing must not spawn a normal seat silently, which drops the isolation asked for.
      const branch = (intent.worktree || '').trim() || null;
      if (intent.worktree != null && !branch) {
        reply('error: worktree: needs a branch name — [agent:spawn name:X cwd:Y worktree:<branch>]');
        return;
      }
      let type;
      try { type = seatType(tpl, spawner); } catch (e) { reply('error: spawn: ' + e.message); return; }
      const workspaceId = spawner.workspaceId || DEFAULT_WORKSPACE_ID;

      const spawnerArgs = (getPersistence().get(spawner.name)?.extraArgs) || [];
      const spawnerAdapter = adapterFor(spawner.type) || adapterFor(DEFAULT_TYPE);
      const postureArgs = hasBypass(spawnerAdapter, spawnerArgs) ? [...adapterFor(type).posture.bypassArgs] : [];

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
      const plugins = (tpl && Array.isArray(tpl.plugins)) ? tpl.plugins.map(String) : null;
      const { sessionEnv, dropped: envDropped, badType: envBadType } = filterTemplateEnv(tpl && tpl.env);

      const seatGrants = Array.isArray(tpl && tpl.execCommands) ? tpl.execCommands : [];
      const grantWarn = (targetTeam && name === targetTeam.lead && !seatGrants.includes('clodex-team'))
        ? ` — WARNING: lead seat has no clodex-team exec grant (${tplLabel ? `template "${tplLabel}"` : 'no template'} carries none);`
          + ' the roster verb will bounce until granted'
        : '';

      let roleNote = '';
      {
        let seatTeam = null;
        try { seatTeam = resolveTeam(cwd); } catch { seatTeam = null; }
        if (seatTeam && matchSeatRole(seatTeam, name) === null) {
          const roles = seatTeam.roles || {};
          const has = (k) => Object.prototype.hasOwnProperty.call(roles, k);
          let concrete = null;
          if (tplLabel) {
            if (has(tplLabel)) concrete = tplLabel;
            else concrete = Object.keys(roles).find((k) => roles[k] && roles[k].template === tplLabel) || null;
          }
          roleNote = ` — NOTE: "${name}" binds to NO role on team ${seatTeam.name}`
            + ' (roles bind by seat name, not template): '
            + (concrete
              ? `to fill role ${concrete} name it ${seatTeam.name}-${concrete}`
              : `a seat for role X is named ${seatTeam.name}-X`)
            + `; tickets reach this seat only by name ([agent:task assign <id> ${name}])`;
        }
      }

      setImmediate(async () => {
        let wt = null;
        let spawnCwd = cwd;
        try {
          if (branch) {
            const r = await gitWorktree.createWorktree(cwd, branch);
            if (!r || !r.ok) {
              reply(`error: worktree "${branch}": ${(r && r.error) || 'could not be created'} — nothing spawned`);
              return;
            }
            wt = { path: r.path, branch: r.branch };
            spawnCwd = r.path;
          } else {
            ensureDir(cwd);
          }
          const spawned = await this.create(
            name, type, spawnCwd, childArgs, null, workspaceId,
            null, false, proxy, agents, denyBuiltins, disabledTools, disabledSkills, injectSkills, systemPromptFile, appendPromptFiles,
            Array.isArray(tpl && tpl.execCommands) ? tpl.execCommands : [],
            // `[]` intents (everything gated) is a real value that must apply; an absent key passes null so create() keeps the
            // all-enabled default.
            withoutPrivilegedIntentsFor(Array.isArray(tpl && tpl.intents) ? tpl.intents : null),
            sessionEnv, true,
            // Wire-off only removes a capability (tee, telemetry, warmth), so an agent-initiated spawn may carry it;
            // it cannot redirect traffic.
            (tpl && tpl.noWire) === true,
            plugins, null, null,
            (tpl && tpl.io) === 'stream' ? 'stream' : 'pty',
            (tpl && typeof tpl.effort === 'string' && tpl.effort) ? tpl.effort : null,
          );
          if (wt) {
            try { getPersistence().setWorktree(name, wt); } catch { /* best-effort */ }
          }
          this._applyTemplatePersistence(name, tpl);
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd: spawnCwd, backend: (this.sessions.get(name) || {}).backend || null, noWire: !!(this.sessions.get(name) || {}).noWire, io: (this.sessions.get(name) || {}).io || 'pty',
            // Agent-initiated, so it must not take the keyboard while the operator works elsewhere.
            background: true,
          });
          const where = wt ? `${spawnCwd} (worktree, branch ${wt.branch})` : spawnCwd;
          this._broadcast('ipc-message', {
            type: 'spawn', from: spawner.name, to: name, body: `spawn → ${name} @ ${where}` + (tpl ? ` (template ${tplLabel})` : ''),
          });
          log.info('intent', `spawn by ${spawner.name} → ${name} (${type}) @ ${where}` + (tpl ? ` via template "${tplLabel}"` : ''));
          const promptWarn = (spawned && spawned.missingPrompt) ? ` — WARNING: ${spawned.missingPrompt}` : '';
          reply(`ok: spawned "${name}" (${type}) @ ${where}` + (tpl ? ` via template "${tplLabel}"` : '')
            + leadNote
            + roleNote
            + grantWarn
            + promptWarn
            + (envDropped.length ? ` — env keys not allowed, dropped: ${envDropped.join(', ')}` : '')
            + (envBadType.length ? ` — env keys [${envBadType.join(', ')}] are allowed but their values are not strings — dropped (quote the value in the template)` : ''));
        } catch (err) {
          log.error('intent', `spawn by ${spawner.name} → ${name} failed: ${err.message}`);
          if (this.sessions.has(name)) {
            reply(`warning: "${name}" is running, but its spawn did not finish: ${err.message}`
              + (wt ? ` — its worktree ${wt.path} is kept` : ''));
            return;
          }
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
          if (!tk || (tk.role !== roleKey && tk.assignee !== roleKey)) continue;
          if (tk.state === 'open' || (tk.state === 'done' && (tk.loopStep || tk.mergeWaiting))) tickets.push(tk.id);
        }
      } catch { tickets.push('<ticket check unavailable>'); }
      return { seats: [...seats], tickets };
    },

    _teamInUse(team) {
      const seats = new Set();
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        if (matchSeatRole(team, s.name) !== null) seats.add(s.name);
      }
      const tickets = [];
      for (const tk of ticketsStore.load(team.root)) {
        if (!tk || tk.state === 'cancelled') continue;
        if (tk.state !== 'done'
          || tk.loopStep || tk.mergeWaiting || (!tk.closedOut && tk.worktree && tk.worktree.branch)) tickets.push(tk.id);
      }
      let saved = null;
      try {
        const names = new Set();
        for (const e of getPersistence().list()) {
          if (e && e.name && !seats.has(e.name) && matchSeatRole(team, e.name) !== null) names.add(e.name);
        }
        saved = names.size;
      } catch { saved = null; }
      return { seats: [...seats], tickets, saved };
    },

    teamActivity(teamName) {
      const team = loadManifest(teamName);
      const tickets = ticketsStore.load(team.root).filter((t) => t && t.id);

      const roles = {};
      for (const [key, def] of Object.entries(team.roles || {})) {
        if (key === 'reviewer') continue;
        roles[key] = {
          dispatch: (def && def.dispatch) || DEFAULT_ROLE_DISPATCH,
          live: [],
          open: [],
          last: null,
        };
      }

      const landedAt = (t) => (t.acceptedAt != null ? t.acceptedAt : (t.closedAt != null ? t.closedAt : null));

      const seatTicket = (seatName) => {
        for (const t of tickets) {
          if (t.assignee !== seatName) continue;
          if (t.state === 'open') return { ticket: t.id, step: 'working' };
          if (t.state === 'done' && t.loopStep === 'verify') return { ticket: t.id, step: t.verifyHold ? 'held' : 'verify' };
        }
        return { ticket: null, step: null };
      };

      for (const s of this.sessions.values()) {
        if (!s || !s.agentType || s._dead) continue;
        const role = matchSeatRole(team, s.name);
        if (role === null || !Object.prototype.hasOwnProperty.call(roles, role)) continue;
        const { ticket, step } = seatTicket(s.name);
        roles[role].live.push({ seat: s.name, ticket, step });
      }

      for (const t of tickets) {
        const bucket = (typeof t.role === 'string' && Object.prototype.hasOwnProperty.call(roles, t.role))
          ? roles[t.role] : null;
        if (!bucket) continue;
        if (t.state === 'open') {
          bucket.open.push({
            id: t.id,
            title: t.title == null ? null : t.title,
            assignee: t.assignee == null ? null : t.assignee,
            step: t.parked ? 'parked' : (t.undeliveredAt ? 'undelivered' : 'working'),
          });
          continue;
        }
        const landed = (t.state === 'done' && t.closedOut) || t.state === 'cancelled';
        if (!landed) continue;
        const at = landedAt(t);
        if (at == null) continue;
        if (bucket.last && bucket.last.at >= at) continue;
        bucket.last = {
          id: t.id,
          title: t.title == null ? null : t.title,
          at,
          outcome: t.mergeError ? 'merge-failed' : (t.state === 'cancelled' ? 'cancelled' : 'accepted'),
        };
      }

      const reviewer = { live: [], last: null };
      for (const t of tickets) {
        if (t.loopStep !== 'verify' || t.verifyHold) continue;
        const landedRounds = Number(t.reviewRound) || 0;
        const round = landedRounds + 1;
        const num = /^t?(\d+)$/.exec(String(t.id));
        const scoped = num ? `${team.name}-reviewer-${num[1]}-r${round}` : null;
        const live = scoped ? this.sessions.get(scoped) : null;
        reviewer.live.push({
          ticket: t.id,
          round,
          seat: (live && live.agentType && !live._dead) ? scoped : null,
        });
      }
      for (const t of tickets) {
        if (t.reviewedAt == null) continue;
        if (reviewer.last && reviewer.last.at >= t.reviewedAt) continue;
        reviewer.last = {
          ticket: t.id,
          round: Number(t.reviewRound) || 0,
          verdict: t.verdict == null ? null : t.verdict,
          at: t.reviewedAt,
        };
      }

      const openRows = [];
      const landedRows = [];
      for (const t of tickets) {
        const inVerify = t.state === 'done' && (t.loopStep === 'verify' || t.loopStep === 'review');
        if (t.state === 'open' || inVerify) {
          let step = 'working';
          let since = null;
          let round = null;
          let run = null;
          if (inVerify && t.verifyHold) step = 'held';
          else if (inVerify) {
            step = 'review';
            round = (Number(t.reviewRound) || 0) + 1;
            const vp = t.verifyPhase && typeof t.verifyPhase === 'object' ? t.verifyPhase : null;
            if (vp && (vp.phase === 'suite' || vp.phase === 'reviewer')) {
              step = vp.phase === 'suite' ? 'suite' : 'reviewer-spawn';
              since = typeof vp.since === 'number' ? vp.since : null;
              if (vp.phase === 'suite') run = Number(vp.run) === 2 ? 2 : 1;
            }
          } else if (t.parked) step = 'parked';
          else if (t.undeliveredAt) step = 'undelivered';
          else if (!ticketStarted(t)) step = 'backlog';
          else since = typeof t.startedAt === 'number' ? t.startedAt : null;
          openRows.push({
            sort: typeof t.openedAt === 'number' ? t.openedAt : 0,
            row: {
              id: t.id,
              title: t.title == null ? null : t.title,
              assignee: t.assignee == null ? null : t.assignee,
              step,
              since,
              round,
              ...(run == null ? {} : { run }),
            },
          });
          continue;
        }
        if (!((t.state === 'done' && t.closedOut) || t.state === 'cancelled')) continue;
        const at = landedAt(t);
        if (at == null) continue;
        landedRows.push({
          id: t.id,
          title: t.title == null ? null : t.title,
          at,
          outcome: t.mergeError ? 'merge-failed' : (t.state === 'cancelled' ? 'cancelled' : 'accepted'),
          rounds: Number(t.reviewRound) || 0,
        });
      }
      openRows.sort((a, b) => a.sort - b.sort);
      const open = openRows.map((e) => e.row);
      const landed = landedRows.sort((a, b) => b.at - a.at);
      landed.length = Math.min(landed.length, LANDED_TICKET_LIMIT);

      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const counts = {
        open: tickets.filter((t) => t.state === 'open').length,
        verify: tickets.filter((t) => t.loopStep === 'verify').length,
        done24h: tickets.filter((t) => t.closedAt != null && t.closedAt >= dayAgo).length,
      };

      return { ok: true, team: team.name, roles, reviewer, counts, tickets: { open, landed } };
    },

    _forgetTeam(teamName, root) {
      let dropped = 0;
      for (const [name, w] of this._ticketWatch) {
        if (!w) continue;
        let gone = w.root === root;
        if (root == null) {
          let team = null; try { team = resolveTeam(w.root || ''); } catch { team = null; }
          gone = !team;
        }
        if (gone) { this._ticketWatch.delete(name); dropped += 1; }
      }
      if (dropped) log.info('team', `forgot ${dropped} ticket watch(es) for deleted team "${teamName}"`);
      return dropped;
    },

    // `opts.ticketId` is the caller's explicit claim that routes the verdict to the ticket; never derive it from scope text,
    // or an ad-hoc review that mentions a ticket id diverts its verdict there and the asker is told nothing.
    _handleTeamReview(session, body, opts = {}) {
      const onReply = (opts && typeof opts.onReply === 'function') ? opts.onReply : null;
      const reply = onReply || ((msg) => this._injectText(session, `[agent:team-review] ${msg}`, { parkable: true }));
      const reviewTicket = (opts && opts.ticketId) || null;
      const addDirs = (opts && Array.isArray(opts.addDirs)) ? opts.addDirs.filter((d) => typeof d === 'string' && d) : [];
      const attach = (opts && Array.isArray(opts.attach)) ? opts.attach.filter((p) => typeof p === 'string' && p) : [];
      const scope = String(body == null ? '' : body).trim();
      if (!scope) { reply('error: a review scope is required — [agent:team-review] <what to review>'); return; }

      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      if (!team) { reply('error: this session is not on a team (no team.json owns its cwd)'); return; }
      if (team.lead !== session.name) {
        reply(`error: only the team lead (${team.lead}) can request a review`);
        return;
      }

      if (!reviewTicket) {
        let inVerify = [];
        try {
          // A held ticket sits at `verify` but will spawn no reviewer, so refusing it advises a wait that never ends;
          // `verifyHold` separates a running check from a stopped one, which `loopStep` alone cannot.
          inVerify = ticketsStore.load(team.root)
            .filter((t) => t && t.loopStep === 'verify' && !t.verifyHold)
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

      const templateOverride = (opts && opts.template) || null;
      const templateName = templateOverride || def.template || DEFAULT_REVIEWER_TEMPLATE;
      // Caught: this handler runs from an unawaited async _handleIntent, so an uncaught throw becomes an unhandled rejection
      // and the lead is told nothing; the resolver's fail-closed guard is only useful if it is fail-visible.
      let shape;
      try {
        shape = this.resolveSeatShape(team, 'reviewer', 'review', session, templateOverride);
      } catch (err) {
        reply(`error: ${err && err.message ? err.message : String(err)}`);
        return;
      }
      const reviewTpl = shape.tpl;
      const type = shape.type;
      const roundTicket = reviewTicket ? this._loadTicket(team, reviewTicket) : null;
      if (reviewTicket && !roundTicket) {
        log.warn('intent', `team-review for ticket ${reviewTicket}: ticket not readable from the board — falling back to the counter name and a seat-index round (rounds may collapse in the cost rollup)`);
      }
      const treePath = roundTicket && roundTicket.worktree && typeof roundTicket.worktree.path === 'string'
        ? roundTicket.worktree.path
        : null;
      let treeOk = false;
      if (treePath) {
        try { treeOk = fs.statSync(treePath).isDirectory(); } catch { treeOk = false; }
      }
      const cwd = treeOk ? seatCwdInTree(team.root, shape.cwd, treePath) : shape.cwd;
      const tplWarn = reviewTpl
        ? ''
        : ` — NOTE: reviewer template "${templateName}" not found for this team or in the library; spawned from built-in defaults (install it to customize)`;
      const reviewerSystemPrompt = shape.systemPromptFile;
      // Resolved above the name reservation: an unwired `path` or REGISTRY_DIR throws here, and after the upsert that burns a reviewer name.
      // The dep stays optional; required, it breaks every fixture.
      const resolvePromptFile = typeof resolveSystemPromptFile === 'function'
        ? (stem) => resolveSystemPromptFile(stem, null, team)
        : (stem) => path.join(REGISTRY_DIR, 'library', 'prompts', 'system', `${stem}.md`);
      const promptFile = reviewerSystemPrompt ? resolvePromptFile(reviewerSystemPrompt) : null;
      const promptEscapeWarn = shape.promptEscaped
        ? ` — NOTE: reviewer systemPromptFile "${shape.promptEscaped}" contains a path separator or "..", which could escape the prompt directories it is resolved against; ignored, using the built-in default "${REVIEWER_FALLBACK.systemPromptFile}"`
        : '';
      const envWarn = (shape.envDropped.length
        ? ` — reviewer template env keys [${shape.envDropped.join(', ')}] are outside the allowed set [${[...REVIEWER_ENV_ALLOWLIST].join(', ')}] — dropped (env is an authority surface; requires operator approval)`
        : '')
        + (shape.envBadType.length
          ? ` — reviewer template env keys [${shape.envBadType.join(', ')}] are allowed but their values are not strings — dropped (quote the value in the template)`
          : '');
      const capNote = shape.capNote
        ? ` — ${shape.capNote}${shape.toolsIgnored ? ' (template tools ignored)' : ''}`
        : '';
      const capWarn = shape.beyondCap.length
        ? ` — requested [${shape.beyondCap.join(', ')}] beyond the reviewer cap [${REVIEWER_TOOL_CAP.join(', ')}] — requires operator approval; spawned with [${shape.effectiveTools.join(', ')}]`
        : '';
      const argsWarn = shape.modelRefused
        ? ` — reviewer template model "${shape.modelRefused}" is not a usable model name (a value is required and cannot begin with "-") — ignored; spawned on the default model (fix the template's "extraArgs")`
        : '';
      // Warned, never fatal: refusing the review over a directory blocks the ticket, but silence leaves a reviewer
      // reading the right repo from the wrong place.
      const cwdWarn = (shape.cwdFallback ? ` — NOTE: ${shape.cwdFallback}` : '')
        + ((treePath && !treeOk)
          ? ` — NOTE: ticket ${reviewTicket} records worktree ${treePath} but it is not a directory; reviewer spawned at ${cwd}`
          : '');

      // A `tools` the cap cannot honor must refuse, never fall back to the full cap: widening past the request is never automatic.
      // Both refuse before the name-mint loop, whose synchronous upsert is the reservation.

      // Own message: telling an author to add cap members to a string sends them to the wrong edit.
      if (shape.toolsMalformed) {
        reply(`error: reviewer template "${templateName}" has a "tools" that is not an array (${typeof (shape.tpl && shape.tpl.tools)}) — it cannot be intersected with the reviewer cap [${REVIEWER_TOOL_CAP.join(', ')}], and falling back to the full cap would grant more than the template asked for; no reviewer spawned (make "tools" an array, or remove it to accept the full cap)`);
        return;
      }
      // An empty intersection, including `[]`, must refuse: effectiveTools is [] so disabledTools inverts to every tool
      // and the seat could not read the diff.
      if (shape.requestedTools && shape.effectiveTools.length === 0) {
        reply(`error: reviewer template "${templateName}" requests tools [${shape.requestedTools.join(', ')}], none of which are within the reviewer cap [${REVIEWER_TOOL_CAP.join(', ')}] — the seat would spawn with no tools at all and could not read the diff; no reviewer spawned (fix the template's "tools")`);
        return;
      }
      if (shape.accountMissing) {
        reply(`error: ${accountMissingError('reviewer', shape.accountMissing)}`);
        return;
      }

      const ticketRound = roundTicket ? (Number(roundTicket.reviewRound) || 0) + 1 : 0;
      // Digits-only rather than name-checked: this path falls back to the counter name, unlike `_mintTicketSeat`,
      // whose caller can act on a refusal.
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

      const reviewRound = ticketRound > 0 ? ticketRound : n - 1;
      // Scraping scope prose for an id the caller already gave ties the label to the scope builder's wording;
      // a scope that stopped spelling the id would silently bill every ticket's review to `<team>.review-rN`.
      const reviewLabel = teamCost.reviewWireLabelFor({
        team: team.name, ticketId: reviewTicket || teamCost.ticketIdFromScope(scope), round: reviewRound,
      });
      getPersistence().upsert({
        name, ephemeral: true, reviewFor: session.name,
        ...(reviewTicket ? { reviewTicket } : {}),
        ...(reviewLabel ? { wireLabel: reviewLabel } : {}),
        reviewerTemplate: shape.tpl ? shape.tpl.name : DEFAULT_REVIEWER_TEMPLATE,
      });

      let promptWarn = '';
      if (reviewerSystemPrompt) {
        // Guard only the stat: absorbing the resolution above skipped the whole preflight silently and left the warning unreachable.
        // A null resolution is a miss, not a skip.
        let missing = !promptFile;
        if (promptFile) {
          try { missing = !fs.existsSync(promptFile); }
          catch { missing = false; }
        }
        if (missing) {
          promptWarn = ` — WARNING: role prompt "${reviewerSystemPrompt}.md" not found under teams/${team.name}/prompts/system or library/prompts/system, so the reviewer boots UNBRIEFED (install it, then re-review)`;
        }
      }

      // The scope rides the constructed prompt, not the dm: a new seat's boot re-render wipes a delivery (seen six times in a day),
      // while a prompt is present before the first turn and survives /clear and /compact.
      const reviewBrief = [
        'REVIEW SCOPE — this is the specific work you were spawned to review.',
        '',
        scope,
        '',
        `Report your verdict with [agent:review-done] <verdict>, closed by a bare [agent:end] line, which returns it to ${session.name} and retires you.`,
      ].join('\n');

      setImmediate(async () => {
        try {
          const spawned = await this.create(
            name, type, cwd, [...shape.extraArgs, ...addDirs.flatMap((d) => ['--add-dir', d])], null, shape.workspaceId,
            reviewBrief, false, session.proxy ?? null, shape.agents, shape.denyBuiltins, shape.disabledTools,
            shape.disabledSkills, shape.injectSkills,
            reviewerSystemPrompt, shape.appendPromptFiles, shape.execCommands, shape.intents, shape.env, true,
            false, shape.plugins, shape.shellDeny, null, shape.io || 'pty', shape.effort || null,
          );
          // Report a missing prompt once: suppress create()'s finding when `promptWarn` is already carried; the two texts are worded
          // differently on purpose, so suppression keys on the warn, not on matching text.
          const spawnPromptWarn = (!promptWarn && spawned && spawned.missingPrompt)
            ? ` — WARNING: ${spawned.missingPrompt}` : '';
          // After create(): the setters resolve the entry by name and silently no-op before it exists, leaving the reviewer unstripped.
          this._applyTemplatePersistence(name, shape.tpl);
          this._sendToSession(name, 'session:context-action', {
            action: 'reattach', name, type, cwd, backend: (this.sessions.get(name) || {}).backend || null, noWire: !!(this.sessions.get(name) || {}).noWire, io: (this.sessions.get(name) || {}).io || 'pty',
            background: true,
          });
          // Carries no copy of the scope, which the prompt already has: two copies would disagree once one is edited, and this dm is the losable one.
          // An @-attach is a reference to the file the scope names, not a copy.
          this._deliverParkedActive(name, session.name, reviewBeginLine(type, attach), 'dm');
          // Armed after the nudge so the window measures the nudge's outcome; a reviewer has no other traffic to earn a turn,
          // and the spec-confirm latch does not cover it.
          this._armReviewStartCheck(name, session.name);
          this._broadcast('ipc-message', {
            type: 'team-review', from: session.name, to: name, body: `review → ${name} @ ${cwd}`,
          });
          log.info('intent', `team-review by ${session.name} → ${name} (${type}) @ ${cwd}`);
          reply(`spawned ${name} — it'll report back with [agent:review-done]; watchdog it by name${capNote}${capWarn}${envWarn}${argsWarn}${cwdWarn}${promptWarn}${spawnPromptWarn}${promptEscapeWarn}${tplWarn}`);
        } catch (err) {
          if (!this.sessions.has(name)) getPersistence().remove(name);
          log.error('intent', `team-review by ${session.name} → ${name} failed: ${err.message}`);
          reply(`error: ${err.message}`);
        }
      });
    },

    _landVerdictOnTicket(session, ticketId, verdict) {
      // Bullets and bold are allowed as decoration; `>` is deliberately not, since it is the decoration that marks a quoted line.
      const m = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*|__)?[ \t]*\bVERDICT\b\W*\b(ACCEPT|REWORK)\b/im.exec(verdict);
      if (!m) return null;
      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      if (!team) return null;
      let tickets;
      try { tickets = ticketsStore.load(team.root); } catch { return null; }
      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket) return null;
      // Guard on ticketInFlight, not on state alone: the loop spawns its reviewer after `task done` has written state `done`,
      // so a plain closed-ticket guard would send every loop verdict to the lead.
      if (!ticketInFlight(ticket)) return null;
      ticket.verdict = m[1].toUpperCase();
      ticket.mustFix = extractMustFix(verdict);
      ticket.reviewRound = (Number(ticket.reviewRound) || 0) + 1;
      delete ticket.verifyPhase;
      ticket.reviewedAt = Date.now();
      ticket.lastActivityAt = ticket.reviewedAt;
      recordEvent(ticket, { at: ticket.reviewedAt, kind: 'verdict', by: session.name, verdict: ticket.verdict, round: ticket.reviewRound });
      if (!Array.isArray(ticket.rounds)) ticket.rounds = [];
      let entry = ticket.rounds.find((r) => r && Number(r.round) === ticket.reviewRound);
      if (!entry) {
        entry = {
          round: ticket.reviewRound,
          report: null,
          reportedBy: null,
          reportedAt: null,
          verdict: null,
          mustFix: null,
          reviewedAt: null,
          verdictFile: null,
          diffFile: null,
          deltaFile: null,
          headSha: null,
        };
        ticket.rounds.push(entry);
      }
      entry.verdict = ticket.verdict;
      entry.mustFix = ticket.mustFix;
      entry.reviewedAt = ticket.reviewedAt;
      delete ticket.loopStep;
      // A verdict is progress: clearing nudgedAt closes the stall episode, or the watchdog spends its one nudge on a ticket that just moved.
      ticket.nudgedAt = null;
      try { ticketsStore.save(team.root, tickets); } catch { return null; }
      // Wrapped: the verdict is already saved, and an escaping throw would abandon _handleReviewDone before it retires the reviewer,
      // stranding a live seat that holds the ticket.
      try { this._reconcileTickets(team); }
      catch (e) { log.error('intent', `ticket ${ticketId}: verdict saved but reconcile failed: ${e.message}`); }
      return { verdict: ticket.verdict, mustFix: ticket.mustFix, reviewRound: ticket.reviewRound, reworkRound: Number(ticket.reworkRound) || 0 };
    },

    // Reads the round off the already-stamped record: this runs after the save, unlike _writeTicketDiff, which runs before it and adds one.
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
      this._stampRoundFile(team, ticketId, round, 'verdictFile', path.basename(file));
      return { ok: true, path: file, error: null };
    },

    _seatLedger(seatName, rec) {
      const sessionIds = entrySessionIds(rec);
      let totals = null;
      try {
        totals = JSON.parse(fs.readFileSync(path.join(getUserDataPath(), 'wire-totals.json'), 'utf8'));
      } catch { /* no ledger file yet — the overlay below may still answer */ }
      let live = null;
      let model = null;
      const currentId = (rec && rec.sessionId) || null;
      try {
        const w = this._wireTelemetry && this._wireTelemetry.payload(seatName);
        // The cost check is separate from the id gate: a null `cost.usd` would replace the file's row and publish a recorded spend as zero;
        // Number.isFinite, not typeof, since NaN and Infinity pass typeof and coerce to a confident zero.
        if (w && w.sessionId && w.sessionId === currentId
            && Number.isFinite(w.cost && w.cost.usd)) {
          // Flattened to a wire-totals row, the only shape sumSessions reads; the payload itself would land `cost` as an object and coerce to zero.
          live = {
            cost: w.cost && w.cost.usd, requests: w.cost && w.cost.requests,
            turns: w.turns, refusals: w.refusals,
            inputTokens: w.tokens && w.tokens.input,
            outputTokens: w.tokens && w.tokens.output,
            cacheReadTokens: w.tokens && w.tokens.cacheRead,
            cacheWriteTokens: w.tokens && w.tokens.cacheWrite,
          };
        }
        if (w && w.sessionId && w.sessionId === currentId && typeof w.model === 'string') model = w.model;
      } catch { /* a telemetry fault costs the freshest turn, not the rollup */ }
      const ledger = teamCost.sumSessions(totals, sessionIds, { currentId, live });
      ledger.ids = sessionIds;
      // `resolved` means a ledger was found: a seat with no observable spend reports null rather than 0,
      // so a review whose cost the wire never saw cannot read as free.
      return { ledger, resolved: ledger.known > 0, model };
    },

    _teamLedgerPath(team) {
      if (!team || !team.name) return null;
      try { return path.join(teamsDir, team.name, teamCost.TEAM_LEDGER_FILE); } catch { return null; }
    },

    _appendTeamLedger(team, row) {
      const file = this._teamLedgerPath(team);
      if (!file || !row) return { ok: false, path: null, error: 'no team ledger path' };
      try {
        ensureDir(path.dirname(file));
        fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
        return { ok: true, path: file, error: null };
      } catch (e) {
        return { ok: false, path: null, error: e.message };
      }
    },

    _seatCursorPath(team) {
      if (!team || !team.name) return null;
      try { return path.join(teamsDir, team.name, 'cost-cursor.json'); } catch { return null; }
    },

    _readSeatCursors(team) {
      const file = this._seatCursorPath(team);
      if (!file) return {};
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? {} : null; }
      try {
        const o = JSON.parse(raw);
        return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
      } catch { return null; }
    },

    _writeSeatCursor(team, seat, cursor) {
      const file = this._seatCursorPath(team);
      if (!file || !seat) return false;
      try {
        const all = this._readSeatCursors(team);
        if (!all) return false;
        all[seat] = cursor;
        ensureDir(path.dirname(file));
        atomicWriteFileSync(file, JSON.stringify(all, null, 2));
        return true;
      } catch { return false; }
    },

    _stampSeatCost(session, boundary) {
      try {
        const name = session && session.name;
        if (!name) return { ok: false, error: 'no seat' };
        if (session.clone) return { ok: false, error: 'scratch clone' };
        let team = null;
        try { team = resolveTeam(session.cwd); } catch { team = null; }
        if (!team) return { ok: false, error: 'no team' };
        const entry = getPersistence().get(name) || null;
        if (!entry) return { ok: false, error: 'no record' };
        if (!standingSeat(entry)) return { ok: false, error: 'not a standing seat' };
        const { ledger } = this._seatLedger(name, entry);
        const cursors = this._readSeatCursors(team);
        if (!cursors) {
          log.warn('cost', `seat ${name} on team ${team.name}: cost stamp dropped — the seat-cost cursor file is unreadable`);
          return { ok: false, error: 'the seat-cost cursor file is unreadable' };
        }
        const cursor = cursors[name] || null;
        const row = teamCost.seatLedgerRow({
          seat: name,
          team: team.name,
          role: matchSeatRole(team, name),
          sessionId: (session && session.sessionId) || entry.sessionId || null,
          boundary,
          lifetime: {
            usd: ledger.usd,
            tokens: ledger.inputTokens + ledger.outputTokens + ledger.cacheReadTokens + ledger.cacheWriteTokens,
            requests: ledger.requests,
            turns: ledger.turns,
          },
          cursor,
        });
        if (!row) return { ok: false, error: 'nothing new since the last stamp' };
        const w = this._appendTeamLedger(team, row);
        if (!w.ok) return w;
        const wrote = this._writeSeatCursor(team, name, {
          usd: row.to,
          tokens: (cursor && Number(cursor.tokens) || 0) + row.tokens,
          requests: (cursor && Number(cursor.requests) || 0) + row.requests,
          turns: (cursor && Number(cursor.turns) || 0) + row.turns,
          at: row.at,
        });
        if (!wrote) {
          log.warn('cost', `seat ${name} on team ${team.name}: ledger row appended but the seat-cost cursor could not be written — the next stamp will re-count it`);
          return { ok: false, path: w.path, usd: row.usd, error: 'the seat-cost cursor could not be written' };
        }
        return { ok: true, path: w.path, usd: row.usd, error: null };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    _writeReviewCost(seatName, team, ticket, rec, round, verdict, mustFixCount) {
      try {
        if (!team || !ticket) return { ok: false, path: null, error: 'no ticket' };
        const dest = this._ticketDiffDest(team, ticket);
        if (!dest.ok) return { ok: false, path: null, error: dest.error };
        const { ledger, resolved, model } = this._seatLedger(seatName, rec);
        const row = teamCost.reviewCostRecord({
          ticket: ticket.id, team: team.name, round, seat: seatName,
          // Off the record, not recomputed from the ticket's round: the label is what the proxy billed under, and the two
          // disagree exactly when the seat fell back to the counter name.
          wireLabel: (rec && rec.wireLabel) || null,
          template: (rec && rec.reviewerTemplate) || null,
          wallMs: (rec && typeof rec.createdAt === 'number') ? (Date.now() - rec.createdAt) : null,
          model,
          verdict, mustFix: mustFixCount, ledger, resolved,
        });
        const file = path.join(dest.dir, teamCost.REVIEW_COST_FILE);
        ensureDir(dest.dir);
        fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
        this._appendTeamLedger(team, teamCost.reviewLedgerRow(row));
        return { ok: true, path: file, error: null };
      } catch (e) {
        return { ok: false, path: null, error: e.message };
      }
    },

    _verdictBriefLines(ticketId, landedOn, dispatch) {
      if (landedOn.verdict !== 'REWORK') return [];
      const out = [];
      const titles = mustFixTitles(landedOn.mustFix);
      if (titles.length) {
        out.push('', 'MUST-FIX:');
        for (const t of titles.slice(0, VERDICT_BRIEF_TITLES)) {
          out.push(`- ${defuseSenderLines(t.length > VERDICT_BRIEF_TITLE_BYTES ? `${t.slice(0, VERDICT_BRIEF_TITLE_BYTES - 1)}…` : t)}`);
        }
        const more = titles.length - VERDICT_BRIEF_TITLES;
        if (more > 0) out.push(`+${more} more, in the verdict file below.`);
      }
      out.push('');
      if (dispatch && dispatch.ok) {
        out.push(`Sent straight to ${dispatch.seat} for rework (rework round ${dispatch.round})`
          + `${this._seatReplacedClause(dispatch.replaced)}. NO action is owed from you.`);
        out.push(`If the verdict is wrong and you want to redirect the seat: [agent:task respec ${ticketId}] <the corrected spec>`
          + ' — it reaches that same seat and keeps its tree, and it REPLACES the spec wholesale, so send the whole corrected'
          + ' one rather than a delta. Doing nothing is the normal case.');
      } else {
        const leadHeld = !!(dispatch && dispatch.error && /is holding .* itself/.test(dispatch.error));
        out.push(`The rework was NOT dispatched (${(dispatch && dispatch.error) || 'no live seat was resolved'}) and is OWED:`
          + (leadHeld
            ? ' no seat has been told. Read the full verdict below; the must-fixes are yours to act on.'
            : ` no seat has been told. Read the full verdict below and send it back yourself with [agent:task reject ${ticketId}] <the must-fixes>.`));
      }
      return out;
    },

    _dispatchReworkFromVerdict(team, ticketId, landedOn, written) {
      try {
        if (!team) return { ok: false, error: 'the team could not be resolved from the reviewer seat' };
        const items = landedOn.mustFix
          ? `MUST-FIX:\n${defuseSenderLines(landedOn.mustFix)}`
          : 'The verdict named no must-fix items — read it and fix what it says, or say in your report why it is wrong.';
        const where = written && written.ok
          ? `FULL VERDICT (the reasoning, the nits and what was checked): ${written.path}\nRead it; it is why, and the items above are only what.`
          : `The full verdict could NOT be saved (${(written && written.error) || 'unknown'}), so the items above are all there is.`;
        return this._rejectTicketFromLoop(team, ticketId,
          `the review came back REWORK (review round ${landedOn.reviewRound}).\n\n`
          + `${items}\n\n${where}\n\n`
          + 'Address every item, then report as usual: the loop re-verifies your branch and sends it to a fresh review from there. '
          + 'If you think an item is wrong, say so in your report rather than skipping it silently.',
          { notifyLead: false, cause: 'review REWORK' });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // A summary, never the body: one real verdict was 15839 bytes, and posting that on every review is the inbox flooding
    // the record/dm split exists to prevent.
    _notifyLeadOfVerdict(session, lead, ticketId, landedOn, fullVerdict, prewritten = null, dispatch = null) {
      try {
        const n = countMustFix(landedOn.mustFix);
        const mf = n === 0
          ? 'no must-fixes'
          : `${n} must-fix${n === 1 ? '' : 'es'}`;
        // The full prose goes in the ticket's task dir: a spill is swept by age (30 min), so an overnight lead wakes to a dead path,
        // and a truncated dump of the record hides `verdict` behind a multi-KB `report`.
        const written = prewritten || this._writeVerdictBody(session, ticketId, landedOn, fullVerdict);
        const where = written.ok
          ? `Full verdict (${fullVerdict.length} bytes): ${written.path}`
          : `Full verdict (${fullVerdict.length} bytes) could NOT be saved (${written.error}) — only the summary above survives.`;
        const body = [
          `[ticket ${ticketId} ${landedOn.verdict}] review round ${landedOn.reviewRound}, ${mf}.`,
          `Landed on the ticket record; the board shows it via [agent:task list all].`,
          ...this._verdictBriefLines(ticketId, landedOn, dispatch),
          where,
        ].join('\n');
        // Not urgent: the verdict is durable before this runs, so waking a busy lead buys nothing; a hold or park is logged, not retried.
        const r = this._gatedDeliver(lead, 'ticket-loop', body, false, `[ticket ${ticketId} ${landedOn.verdict}]`);
        if (r && r.error) {
          log.warn('intent', `ticket ${ticketId}: verdict landed but lead ${lead} not notified — ${r.error}`);
        }
      } catch (e) {
        log.error('intent', `ticket ${ticketId}: verdict landed but lead notification failed: ${e.message}`);
      }
    },

    // The merge chain is process-wide, not per team: the suite binds real ports, so two
    // teams' merges overlapping would deadlock as two suites do.
    _queueAutoMerge(team, ticketId, landedOn, verdictText, retry = null) {
      this._mergePending = (this._mergePending || 0) + 1;
      const held = { team: team.name, ticketId };
      if (!Array.isArray(this._mergeHeld)) this._mergeHeld = [];
      this._mergeHeld.push(held);
      if (this._mergePending > 1) {
        log.info('ticket', `auto-merge for ${ticketId} QUEUED behind ${this._mergePending - 1} other merge(s) — one is in flight and the rest are waiting, since one merge runs at a time process-wide and each holds the chain through its whole post-merge suite`);
      }
      this._mergeChain = Promise.resolve(this._mergeChain)
        .catch(() => {})
        .then(() => this._autoMergeTicket(team, ticketId, landedOn, verdictText, retry))
        .catch((e) => {
          log.error('ticket', `auto-merge for ${ticketId} rejected: ${e && e.message ? e.message : String(e)}`);
        })
        // Decrement after the catch so it runs on both arms; a leaked counter reports a phantom queue.
        .then(() => {
          this._mergePending -= 1;
          const i = this._mergeHeld.indexOf(held);
          if (i >= 0) this._mergeHeld.splice(i, 1);
        });
      return this._mergeChain;
    },

    _verdictRejectedSince(ticket, landedOn) {
      if (!ticket || !landedOn || landedOn.reworkRound == null) return false;
      return (Number(ticket.reworkRound) || 0) !== Number(landedOn.reworkRound);
    },

    inFlightMerges() {
      const held = Array.isArray(this._mergeHeld) ? this._mergeHeld : [];
      return held.map((h, i) => (i === 0
        ? `ticket ${h.ticketId} auto-merge and its post-merge suite (team ${h.team})`
        : `ticket ${h.ticketId} auto-merge queued behind it (team ${h.team})`));
    },

    inFlightRestartHolds() {
      return [...this.inFlightExecRuns(), ...this.inFlightMerges()];
    },

    async _awaitBootLeads(leads) {
      const missing = () => leads.filter((n) => { const s = this.sessions.get(n); return !s || !s.agentType; });
      if (!missing().length) return;
      const start = this._mergeRetryNow();
      while (missing().length && this._mergeRetryNow() - start < BOOT_REQUEUE_LEAD_WAIT_MS) {
        await new Promise((res) => this._scheduleMergeRetry(res, BOOT_REQUEUE_LEAD_POLL_MS));
      }
      const left = missing();
      const waited = Math.round((this._mergeRetryNow() - start) / 1000);
      log.info('ticket', left.length
        ? `boot: requeue of waiting merges waited ${waited}s and lead seat(s) ${left.join(', ')} are still not live — requeuing anyway`
        : `boot: requeue of waiting merges waited ${waited}s for lead seat(s) ${leads.join(', ')} to come back`);
    },

    async _requeueWaitingMerges() {
      let names = [];
      try { names = typeof listTeams === 'function' ? listTeams() : []; } catch { names = []; }
      const seen = new Set();
      const candidates = [];
      const isWaiting = (t) => !!t && t.mergeWaiting === 'suite-in-flight' && t.state === 'done' && !t.closedOut
        && t.verdict === 'ACCEPT' && !!(t.worktree && t.worktree.branch);
      for (const name of names) {
        let team;
        try { team = loadManifest(name); } catch { continue; }
        if (!team || !team.root) continue;
        let tickets;
        try { tickets = ticketsStore.load(team.root); } catch { continue; }
        for (const t of tickets) {
          if (!isWaiting(t)) continue;
          const key = `${team.root}\n${t.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ team, id: t.id });
        }
      }
      if (!candidates.length) return [];
      const byTeam = new Map();
      for (const c of candidates) {
        if (!byTeam.has(c.team)) byTeam.set(c.team, []);
        byTeam.get(c.team).push(c.id);
      }
      const queued = [];
      await Promise.all([...byTeam].map(async ([team, ids]) => {
        await this._awaitBootLeads(team.lead ? [team.lead] : []);
        for (const id of ids) await this._requeueOneWaiting(team, id, isWaiting, queued);
      }));
      return queued;
    },

    async _requeueOneWaiting(team, id, isWaiting, queued) {
      const t = this._loadTicket(team, id);
      if (!isWaiting(t)) return;
      const branch = t.worktree.branch;
      const target = await gitWorktree.mergeTargetFor(team).catch(() => null);
      if (target) {
        const m = await gitWorktree.isMerged(team.root, branch, target).catch(() => null);
        if (m && m.ok && m.merged) {
          this._stampMergeWaiting(team, t.id, null);
          log.info('ticket', `boot: ${t.id} is stamped merge waiting (suite-in-flight) but ${branch} is already on ${target} — not requeued, stamp cleared`);
          return;
        }
      }
      const landedOn = { verdict: t.verdict, mustFix: t.mustFix == null ? null : t.mustFix, reviewRound: Number(t.reviewRound) || 1, reworkRound: Number(t.reworkRound) || 0 };
      let verdictText = null;
      const round = Array.isArray(t.rounds) ? t.rounds.find((r) => r && Number(r.round) === landedOn.reviewRound) : null;
      if (round && round.verdictFile) {
        const dest = this._ticketDiffDest(team, t);
        if (dest.ok) {
          try { verdictText = fs.readFileSync(path.join(dest.dir, round.verdictFile), 'utf8'); } catch { verdictText = null; }
        }
      }
      const from = verdictText == null ? 'rebuilt from the record\'s verdict and mustFix' : `read from ${round.verdictFile}`;
      if (verdictText == null) verdictText = `VERDICT: ${t.verdict}\n\nMUST-FIX\n${t.mustFix || '(none)'}\n`;
      log.info('ticket', `boot: requeued the auto-merge for ${t.id} (${team.name}) — it was deferred behind a running suite before the relaunch dropped its retry timer; attempt 0, the wait cap restarts now, verdict ${from}`);
      this._queueAutoMerge(team, t.id, landedOn, verdictText, { attempt: 0, since: this._mergeRetryNow() });
      queued.push(t.id);
    },

    // Two seams, not one: a test usually replaces only the clock or only the delay.
    _mergeRetryNow() { return Date.now(); },

    // unref'd so a pending retry never keeps the process, or a test file, alive.
    _scheduleMergeRetry(fn, ms) {
      const t = setTimeout(fn, ms);
      if (t && t.unref) t.unref();
      return t;
    },

    _suiteLockHolder(team) {
      let pid = null;
      try {
        pid = Number(fs.readFileSync(path.join(team.root, '.test-digest.lock', 'pid'), 'utf8').trim()) || null;
      } catch { return null; }
      if (!pid) return null;
      return isAlive(pid) ? pid : null;
    },

    _stampMergeError(team, ticketId, step) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!step) { if (!('mergeError' in rec) && !('escalationUndelivered' in rec)) return; delete rec.mergeError; }
        else {
          rec.mergeError = step;
          recordEvent(rec, { kind: 'merge-failed', by: 'ticket-loop', step });
        }
        delete rec.escalationUndelivered;
        rec.lastActivityAt = Date.now();
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `merge error stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    // Kept apart from mergeError, which reads as needs a human; a ticket waiting its turn needs none.
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

    // `retry` is a parameter, not manager state: two tickets can wait on one lock and would
    // share a field's attempt count and deadline.
    async _autoMergeTicket(team, ticketId, landedOn, verdictText, retry = null) {
      let deferred = false;
      const abandonedWhy = () => {
        const now = this._loadTicket(team, ticketId);
        if (!now) return 'gone';
        if (now.state !== 'done') return `${now.state}, not done`;
        if (this._verdictRejectedSince(now, landedOn)) return `back from a rejection of this ACCEPT (rework round ${now.reworkRound})`;
        if (now.closedOut) return 'still done but ACCEPTED and closed out';
        return null;
      };
      const fail = (step, evidence, tried) => {
        const why = merged === null ? abandonedWhy() : null;
        if (why) {
          log.info('ticket', `auto-merge for ${ticketId} ABANDONED at ${step}: the ticket is ${why} — nothing was merged, no MERGE FAILED stamped`);
          return;
        }
        // Stamp before the DM: the DM can fail, so the board must carry what it may not.
        this._stampMergeError(team, ticketId, step);
        this._escalateTicket(team, ticketId, `merge: ${step}`, evidence, tried);
      };
      let merged = null;
      let target = null;
      try {
        const ticket = this._loadTicket(team, ticketId);
        if (!ticket) return;
        if (ticket.state !== 'done') return;
        if (this._verdictRejectedSince(ticket, landedOn)) {
          log.info('ticket', `auto-merge for ${ticketId} CANCELLED: the round ${landedOn.reviewRound} ACCEPT that queued it was rejected by the lead (rework round ${ticket.reworkRound}) — nothing was merged; the rework goes through review again`);
          return;
        }
        // Gate on closedOut, not acceptedAt or state: accept leaves state at done, and acceptedAt is
        // stamped on arms that do not close out, where the merge is still owed.
        if (ticket.closedOut) {
          log.info('ticket', `auto-merge for ${ticketId} ABANDONED: the ticket was ACCEPTED and closed out while the merge was pending — nothing was merged`);
          return;
        }
        const wt = ticket.worktree || {};
        const branch = wt.branch;
        const baseSha = wt.baseSha;
        if (!branch || !baseSha) return;
        target = await gitWorktree.mergeTargetFor(team).catch(() => null);
        if (!target) {
          fail('on-master', `could not resolve the merge target branch for ${team.name}: no trunk is set and ${team.root} has no origin/HEAD, main, master or checked-out branch`,
            'nothing was merged; set one with [agent:team trunk <branch>]');
          return;
        }

        // Read must-fixes from the verdict text, not landedOn.mustFix: the gate deciding whether work
        // reaches the trunk must not trust a count another caller computed.
        const mustFix = extractMustFix(verdictText == null ? '' : String(verdictText));
        const n = countMustFix(mustFix);
        if (n > 0) {
          fail('must-fix', `the verdict is ACCEPT but its MUST-FIX body is not empty (${n} item${n === 1 ? '' : 's'}): ${String(mustFix).slice(0, 800)}`,
            'nothing was merged — an ACCEPT that still lists must-fixes is a contradiction the lead resolves, not the loop');
          return;
        }

        // isMerged(root, X, Y) asks whether X is an ancestor of Y, so the base goes first.
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
        if (cur.branch !== target) {
          fail('on-master', `the root checkout is on "${cur.branch}", not the team's trunk ${target} — merging here would land ${branch} on the wrong branch`,
            `nothing was merged; check out ${target} in ${team.root} and merge ${branch} by hand`);
          return;
        }

        // The lock probe is not a hold: a suite starting between it and the merge still races,
        // and closing that needs the lock held across merge, suite and revert.
        const holder = this._suiteLockHolder(team);
        if (holder) {
          // Scheduled, not slept: a sleep would hold the chain and block every merge process-wide.
          // Bounded by attempts and deadline because a stale lock is invisible to isAlive.
          const attempt = (retry && retry.attempt) || 0;
          const since = (retry && retry.since) || this._mergeRetryNow();
          const waited = this._mergeRetryNow() - since;
          if (attempt < MERGE_RETRY_MAX_ATTEMPTS && waited < MERGE_RETRY_MAX_WAIT_MS) {
            log.info('ticket', `auto-merge for ${ticketId} deferred: a suite holds ${team.root}'s lock (pid ${holder}) — retry ${attempt + 1}/${MERGE_RETRY_MAX_ATTEMPTS} in ${Math.round(MERGE_RETRY_DELAY_MS / 1000)}s, ${Math.round(waited / 1000)}s waited so far`);
            this._scheduleMergeRetry(() => {
              try { this._queueAutoMerge(team, ticketId, landedOn, verdictText, { attempt: attempt + 1, since }); }
              catch (e) { log.error('ticket', `auto-merge retry for ${ticketId} failed to requeue: ${e && e.message ? e.message : String(e)}`); }
            }, MERGE_RETRY_DELAY_MS);
            if (!abandonedWhy()) {
              deferred = true;
              this._stampMergeWaiting(team, ticketId, 'suite-in-flight');
            }
            return;
          }
          // The message reports that every sample found the lock held, not a wedge: the pid was verified
          // alive, and naming a wedge invites clearing a valid lock.
          fail('suite-in-flight', `a test suite is already running in the root checkout ${team.root} (pid ${holder}) — merging now would rewrite the files under it`,
            `nothing was merged, and the loop will NOT retry — it already retried ${attempt} time${attempt === 1 ? '' : 's'} over ${Math.round(waited / 1000)}s and the lock was held on every sample. That can be one wedged run or several legitimate ones back to back, so check \`ps\` for a live \`node --test\` before concluding anything, and do not clear the lock by hand. To land it by hand: \`git -C ${team.root} merge --no-ff ${branch}\`, then run the suite in ${team.root}. Otherwise re-review the ticket.`);
          return;
        }

        const ownBase = await gitWorktree.mergeBase(team.root, target, branch).catch(() => ({ ok: false }));

        const why = abandonedWhy();
        if (why) {
          log.info('ticket', `auto-merge for ${ticketId} ABANDONED at the merge step: the ticket is ${why} — nothing was merged`);
          return;
        }
        // The message goes through a file, never -m: it carries an agent-written title and is multi-line.
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
          if (dest.ok) this._stampMergeMsgFile(team, ticketId, path.basename(msgFile));
        } catch (e) {
          fail('merge', `the merge message could not be written: ${e.message}`,
            'nothing was merged — the message file is written before the merge so a failure here costs nothing');
          return;
        }
        const mergeStartedAt = Date.now();
        merged = await gitWorktree.mergeNoFf(team.root, branch, msgFile)
          .catch((e) => ({ ok: false, error: e.message }));
        if (!merged.ok) {
          // Report off `wedged`, never `aborted`: a merge that failed before it started also fails to
          // abort, and a wedged-checkout claim about an untouched tree is a false alarm.
          fail('merge', `git merge --no-ff ${branch} failed:\n${merged.error}`,
            merged.wedged
              ? `ran the merge in ${team.root}; \`git merge --abort\` ALSO failed and MERGE_HEAD is still there, so the checkout is left mid-merge and needs a human`
              : `ran the merge in ${team.root}; the checkout is back where it was (no MERGE_HEAD)`);
          return;
        }
        if (!merged.moved) {
          // git merge --no-ff on an already-merged branch exits 0 and creates nothing, so ok alone
          // would announce a merge that did not happen.
          fail('merge', `git merge --no-ff ${branch} exited 0 but HEAD did not move — the branch was already contained in ${target}, so no merge commit exists`,
            `ran the merge in ${team.root}; nothing to revert`);
          return;
        }

        // Revert first, escalate second: a red trunk blocks every ticket, so the undo is not a
        // question for the lead.
        const suite = await this._runTicketSuite(team, ticket, team.root);
        const mergeSlowOwned = suite.ran && suite.slowOnly
          ? await this._slowTestsOwned(team, ticket, suite.slow, ownBase && ownBase.ok ? ownBase.sha : null)
          : [];
        const slowPass = suite.ran && suite.slowOnly && !mergeSlowOwned.length;
        if ((!suite.ran || !suite.green) && !slowPass) {
          const why = mergeSlowOwned.length
            ? `the suite's slow gate tripped on ${target} after the merge — ${suite.summary}, 0 failing\n`
              + `SLOW GATE: ${mergeSlowOwned.join('; ')}\nThese are tests a file this branch changed contains, so they are this `
              + 'ticket\'s to fix with a seam or a test/slow-tests.json entry — verify should have caught it before the merge.'
            : suite.ran
              ? `the suite FAILS on ${target} after the merge — ${suite.summary}\nFAILING: ${suite.failing || '(the runner reported no test names)'}`
              : `the suite could not be RUN on ${target} after the merge: ${suite.error}`;

          let kept;
          try {
            kept = await this._writeTicketSuiteFailure(team, ticket, suite,
              Number(landedOn && landedOn.reviewRound) || Number(ticket.reviewRound) || 1);
          } catch (e) {
            kept = { ok: false, path: null, error: `the preservation threw: ${e && e.message ? e.message : String(e)}` };
            log.error('ticket', `ticket ${ticketId}: post-merge suite output could not be preserved — ${kept.error}`);
          }
          // The do-not-re-run advice holds only where the revert succeeded, so the clause is built per arm.
          const keptWhere = (reverted) => (kept.ok
            ? (reverted
              ? ` Full output (assertion text, diff and stack) preserved at ${kept.path} — read it instead of re-running, which would measure the reverted tree.`
              : ` Full output (assertion text, diff and stack) preserved at ${kept.path} — read it; ${target} still carries the merge.`)
            : ` The failing output could not be preserved (${kept.error}).`);

          // The revert rewrites the shared checkout like the merge, so it takes the same lock gate; our own
          // killed runner is not a blocker, since isAlive still sees its unreaped pid.
          const holder = this._suiteLockHolder(team);
          const blocker = (holder && holder === suite.runnerPid) ? null : holder;
          if (blocker) {
            const state = suite.ran
              ? `is RED: the merge ${merged.sha} IS on it and the suite FAILED`
              : `carries an UNVERIFIED merge ${merged.sha}: its suite never ran`;
            fail('revert-blocked', `${why}\n\n${target} ${state}, and it was left that way deliberately: a test suite is running in ${team.root} (pid ${blocker}), so reverting now would rewrite the files under it.`,
              `merged ${branch} as ${merged.sha} and did NOT revert. Undo it yourself once that suite finishes: \`git -C ${team.root} revert -m 1 ${merged.sha}\`.${keptWhere(false)}`);
            return;
          }
          const rev = await gitWorktree.revertCommit(team.root, merged.sha)
            .catch((e) => ({ ok: false, error: e.message }));
          fail('suite', why, (rev.ok
            ? `merged ${branch} as ${merged.sha}, ran the suite in ${team.root}, then REVERTED the merge (${rev.sha}) — ${target} is green again and the branch is untouched`
            : `merged ${branch} as ${merged.sha} and the revert ALSO failed (${rev.error}) — ${target} is left carrying the merge and needs a human`) + keptWhere(rev.ok));
          return;
        }

        this._stampMergeError(team, ticketId, null);
        // The range is headBefore..sha, what this merge added, not what the branch carries: they differ
        // when the trunk already had the entry.
        const changelog = await this._mergeTouchedChangelog(team, merged.headBefore, merged.sha);
        // Close out before the notice, which reports the final state, and re-read the row since a suite
        // has run; wrapped so a throw costs the close-out, not the notice.
        let closeOut = null;
        try {
          const fresh = ticketsStore.load(team.root);
          const row = fresh.find((t) => t.id === ticketId);
          // state before acceptedAt: a reopened row can still carry an older acceptedAt.
          const rejectedSince = !!row && this._verdictRejectedSince(row, landedOn);
          const reopened = row && (row.state !== 'done' || rejectedSince);
          const acceptedInFlight = !reopened && row && (row.acceptedAt || row.closedOut);
          const duringSuite = !!(row && ((row.acceptedAt && row.acceptedAt >= mergeStartedAt) || row.closedOut));
          const when = duringSuite ? 'while the post-merge suite ran' : 'before the merge landed';
          // closedOut, not the accepted stamp, picks the sentence: some accept arms stamp yet keep the
          // tree, and calling those a close-out would hide the kept tree.
          const finishedInFlight = acceptedInFlight && !!row.closedOut;
          const who = row && (row.acceptedBy || 'the lead');
          if (reopened) {
            log.info('ticket', `ticket ${ticketId} was reopened (${row.state}) while the post-merge suite ran — the merge stands and the loop tore nothing down`);
          } else if (acceptedInFlight) {
            log.info('ticket', `ticket ${ticketId} was accepted by ${who} ${when} — the loop reports that instead of closing out again`);
          }
          closeOut = !row
            ? { ok: false, closedOut: false, text: `the ticket row for ${ticketId} could not be re-read after the merge` }
            : reopened
              ? { ok: false, closedOut: false, reopened: true, state: rejectedSince ? `rejected, rework round ${row.reworkRound}` : row.state,
                text: `the ticket was reopened (${rejectedSince ? `rejected, rework round ${row.reworkRound}` : row.state}) while the post-merge suite ran, so the seat, worktree and branch were left alone` }
              : finishedInFlight
                ? { ok: true, closedOut: true, already: true,
                  text: `ticket ${ticketId} accepted — ${who} accepted it while the post-merge suite ran` }
                : acceptedInFlight
                  ? { ok: false, closedOut: false, already: true,
                    text: `${who} accepted it ${when}, but that accept did not finish the cleanup `
                      + '(tree or branch kept)' }
                  : await this._closeOutMergedTicket(team, row, fresh, { by: 'ticket-loop' });
        } catch (e) {
          log.error('ticket', `loop close-out for ${ticketId} failed after a green merge: ${e.message}`);
          closeOut = { ok: false, closedOut: false, text: `the loop's close-out threw (${e.message})` };
        }
        const mergedTip = await gitWorktree.revParse(team.root, `${merged.sha}^2`).catch(() => null);
        const branchTip = await gitWorktree.revParse(team.root, branch).catch(() => null);
        this._notifyMergeLanded(team, ticketId, {
          branch, target, sha: merged.sha, rounds, summary: suite.summary, changelog, unioned: merged.unioned, closeOut, mergedTip, branchTip,
          slow: slowPass ? suite.slow : null,
        });
      } catch (e) {
        fail('unexpected', `the auto-merge threw: ${e && e.message ? e.message : String(e)}`,
          merged && merged.ok && merged.sha
            ? `the merge commit ${merged.sha} IS on ${target} and was NOT verified — \`git -C ${team.root} revert -m 1 ${merged.sha}\` undoes it`
            : 'nothing was merged');
      } finally {
        if (!deferred) this._stampMergeWaiting(team, ticketId, null);
      }
    },

    async _mergeTouchedChangelog(team, base, head) {
      try {
        if (!base || !head) return { known: false, error: 'the merge did not report both ends of its range' };
        const d = await gitWorktree.diffText(team.root, base, head)
          .catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));
        if (!d || !d.ok || typeof d.text !== 'string') {
          return { known: false, error: (d && d.error) || 'git diff returned nothing readable' };
        }
        // A non-empty diff with no `diff --git` header is not evidence: a global GIT_EXTERNAL_DIFF
        // emits none, and reading that as no CHANGELOG.md is a false OWED on every merge.
        if (d.text.trim() && !/^diff --git /m.test(d.text)) {
          return { known: false, error: 'the diff carried no git headers to read' };
        }
        let present = false;
        try { present = fs.statSync(path.join(team.root, 'CHANGELOG.md')).isFile(); } catch { present = false; }
        const rootChangelog = /^(?:[^\s/]+\/)?CHANGELOG\.md$/;
        const touched = [...d.text.matchAll(/^diff --git (\S+) (\S+)$/gm)]
          .some((h) => rootChangelog.test(h[1]) || rootChangelog.test(h[2]));
        return { known: true, touched, present };
      } catch (e) {
        return { known: false, error: e && e.message ? e.message : String(e) };
      }
    },

    _notifyMergeLanded(team, ticketId, { branch, target = null, sha, rounds, summary, changelog, unioned, closeOut = null, slow = null, mergedTip = null, branchTip = null }) {
      try {
        const into = target || gitWorktree.mergeTargetForSync(team);
        const collapse = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
        const oneLine = (v) => collapse(v, 300);
        const wideLine = (v) => collapse(v, 600);
        const measured = !!(changelog && changelog.known === true && typeof changelog.touched === 'boolean');
        const changelogLine = measured
          ? (changelog.touched
            // Claim only that the range touched the file, not that an entry was written: a typo fix trips
            // the same header.
            ? `CHANGELOG.md was CHANGED by this merge — the branch touched it, so an entry may already be on ${into}. Look before adding one, or you will write a duplicate.`
            // `=== false`: a result carrying no `present` is not a measured absence.
            : changelog.present === false
              ? `This repo has no CHANGELOG.md at its root — no entry is owed.`
              : `A CHANGELOG.md entry is OWED — the merge carried none (the merge never authors one itself).`)
          // Use diff --stat <sha>^1 <sha>, not show --stat, so the command does not depend on the lead's git config.
          // Wording stays apart from HOLD_RECOVERY's infra arm: hold-recovery-single-source.test.js reads a shared 5-gram as a copy.
          : `CHANGELOG.md: UNKNOWN — the probe did not answer (${oneLine((changelog && changelog.error) || 'no result')}). This is neither of the other two answers: run \`git -C ${team.root} diff --stat ${sha}^1 ${sha}\` before deciding, because a release shipped on the belief that an entry landed ships with no notes.`;
        const stamp = (this._loadTicket(team, ticketId) || {}).suiteRemeasured;
        const closedOutOk = !!(closeOut && closeOut.ok && closeOut.closedOut);
        // A reopen gets its own arm: `Step owed:` names a verb `_taskAccept` refuses.
        const stepLine = closeOut && closeOut.reopened
          ? `Reopened by rework (${closeOut.state}) during the post-merge suite: the merge is on ${into}, `
            + `nothing was torn down, and the rework round's tree is the one now live. No step is owed here.`
          : closedOutOk
            ? `Closed out: ${wideLine(closeOutDetail(ticketId, closeOut.text))}`
            : `Step owed: \`[agent:task accept ${ticketId}]\` — alone in a reply, no tool call beside it. `
              + `The loop could not close it out: ${wideLine(closeOutDetail(ticketId, (closeOut && closeOut.text) || 'it did not run'))}`;
        const body = [
          `[ticket ${ticketId} MERGED] ${branch} → ${into} as ${sha}`,
          ...(mergedTip && branchTip && mergedTip !== branchTip
            ? [`Merged ${branch} at ${mergedTip}, NOT its tip: the branch is now at ${branchTip}, and the commits after ${mergedTip.slice(0, 8)} are not on ${into}.`]
            : []),
          '',
          stepLine,
          '',
          `Review rounds: ${rounds}. Suite on ${into} after the merge: ${defuseSenderLines(summary)}.`,
          ...(slow && slow.length ? [`slow gate tripped by tests outside this diff: ${defuseSenderLines(wideLine(slow.join('; ')))}`] : []),
          ...(unioned ? [`${unioned} conflicted with a bullet another ticket merged first; the loop kept BOTH (the earlier one above this ticket's). Read ## Unreleased once before the next release.`] : []),
          ...(stamp ? [`Verify suite was re-measured. First run: ${defuseSenderLines(oneLine(stamp.first)) || 'unrecorded'} (${defuseSenderLines(wideLine(stamp.firstFailing)) || 'no names recorded'}).`] : []),
          changelogLine,
          ...(closedOutOk || (closeOut && (closeOut.reopened || closeOut.tornDown)) ? [] : [`Nothing was torn down: the worktree, the branch and the seat are still there. [agent:task accept ${ticketId}] retires them when you are ready.`]),
        ].join('\n');
        this._stampMerged(team, ticketId, sha);
        const r = this._gatedDeliver(team.lead, 'ticket-loop', body, false, `[ticket ${ticketId} MERGED]`);
        if (!(r && (r.queued || r.parked))) {
          log.error('ticket', `ticket ${ticketId} merged as ${sha} but ${team.lead} was NOT told (${(r && (r.error || r.held)) || 'unknown delivery failure'})`);
        }
        this._broadcast('ipc-message', { type: 'task', from: 'ticket-loop', to: team.lead, body: `ticket ${ticketId} merged: ${branch} → ${into}` });
        log.info('intent', `ticket ${ticketId} auto-merged: ${branch} → ${into} as ${sha}`);
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
      let landedOn = null;
      if (rec.reviewTicket) landedOn = this._landVerdictOnTicket(session, rec.reviewTicket, verdict);

      // Booked on the unparsed-verdict arm too (that seat spent money and is reaped), one round past
      // the stamped one since nothing landed to bump the counter.
      let booked = false;
      const bookReview = () => {
        try {
          if (booked || !rec.reviewTicket) return;
          booked = true;
          let team = null;
          try { team = resolveTeam(session.cwd); } catch { team = null; }
          const ticket = team ? this._loadTicket(team, rec.reviewTicket) : null;
          const round = landedOn
            ? Number(landedOn.reviewRound)
            : (Number(ticket && ticket.reviewRound) || 0) + 1;
          const w = this._writeReviewCost(
            session.name, team, ticket, rec, round, landedOn ? landedOn.verdict : null,
            landedOn ? countMustFix(landedOn.mustFix) : null,
          );
          if (!w.ok) {
            log.warn('intent', `ticket ${rec.reviewTicket}: review cost for round ${round} not captured (${w.error}) — the seat is about to be reaped, so this round's spend is unrecoverable`);
          }
        } catch (e) {
          log.error('intent', `ticket ${rec.reviewTicket}: review cost booking threw (${e.message}) — the verdict is already durable and the seat still retires`);
        }
      };

      if (landedOn) {
        const rework = landedOn.verdict === 'REWORK';
        let written;
        try {
          written = this._writeVerdictBody(session, rec.reviewTicket, landedOn, verdict);
        } catch (e) {
          written = { ok: false, path: null, error: `the verdict body write threw: ${e && e.message ? e.message : String(e)}` };
        }
        let team = null;
        try { team = resolveTeam(session.cwd); } catch { team = null; }
        if (!rework) this._notifyLeadOfVerdict(session, lead, rec.reviewTicket, landedOn, verdict, written);
        this._broadcast('ipc-message', {
          type: 'review-done', from: session.name, to: rec.reviewTicket, body: `verdict → ticket ${rec.reviewTicket}`,
        });
        log.info('intent', `review-done ${session.name} → ticket ${rec.reviewTicket} (${landedOn.verdict}, round ${landedOn.reviewRound}); retiring (discard)`);
        this._sendToSession(session.name, 'session:context-action', {
          action: 'retired', name: session.name, disposition: 'discard',
        });
        bookReview();
        this.kill(session.name);
        if (landedOn.verdict === 'ACCEPT') {
          if (team) this._queueAutoMerge(team, rec.reviewTicket, landedOn, verdict);
        }
        if (rework) {
          const dispatch = this._dispatchReworkFromVerdict(team, rec.reviewTicket, landedOn, written);
          if (!dispatch.ok) {
            log.warn('intent', `ticket ${rec.reviewTicket}: REWORK landed but the rework was not dispatched (${dispatch.error}) — the lead's brief says it is owed`);
          }
          this._notifyLeadOfVerdict(session, lead, rec.reviewTicket, landedOn, verdict, written, dispatch);
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
      bookReview();
      this.kill(session.name);
    },

    async _classifyTeamRoot(root) {
      let st = null;
      try { st = fs.statSync(root); } catch { st = null; }
      if (!st) {
        let parentIsDir = false;
        try { parentIsDir = fs.statSync(nodePath.dirname(root)).isDirectory(); } catch { parentIsDir = false; }
        return parentIsDir ? { kind: 'new-absent' } : { kind: null, error: 'parent-missing' };
      }
      if (!st.isDirectory()) return { kind: null, error: 'is-file' };
      let entries = [];
      try { entries = fs.readdirSync(root); } catch { entries = []; }
      if (entries.length === 0) return { kind: 'new-empty' };
      if (!(await gitWorktree.repoToplevel(root))) return { kind: null, error: 'files-no-repo' };
      if (!(await gitWorktree.hasCommit(root))) return { kind: null, error: 'repo-no-commits' };
      return { kind: 'takeover' };
    },

    async _handleTeamCreate(session, intent) {
      const reply = (msg) => this._injectText(session, `[agent:team] ${msg}`, { parkable: true });
      const name = intent.name || null;
      const root = intent.root || null;
      const kitList = () => {
        const lines = kitCatalog();
        return lines.length ? `\n${lines.join('\n')}` : ' none are installed';
      };
      if (intent.kit === '?') {
        reply(`kits:${kitList()}`);
        return;
      }
      if (!name) { reply('error: create needs a team name — [agent:team create <name> root:<abs-path> [lead:<seat>]]'); return; }
      if (!root || !nodePath.isAbsolute(root)) {
        reply(`error: create needs an absolute root — [agent:team create ${name} root:<abs-path>]`);
        return;
      }
      const mode = intent.mode == null ? 'kickstart' : String(intent.mode);
      if (mode !== 'kickstart' && mode !== 'interview') {
        reply(`error: mode "${intent.mode}" is not kickstart or interview — no team was created`);
        return;
      }
      let kitDef = null;
      try { kitDef = resolveKit(intent.kit); } catch (err) {
        reply(`error: ${err.message} — no team was created. Kits:${kitList()}`);
        return;
      }
      const cls = await this._classifyTeamRoot(root);
      if (!cls.kind) {
        const refusals = {
          'parent-missing': `error: root ${root} — its parent ${nodePath.dirname(root)} does not exist; `
            + 'Clodex creates the leaf, never the path — no team was created',
          'is-file': `error: root ${root} is a file, not a directory — no team was created`,
          'files-no-repo': `error: root ${root} has files but no git repo — run git init there yourself `
            + '(Clodex will not make a first commit of files it did not create) and re-fire — no team was created',
          'repo-no-commits': `error: root ${root} is a git repo with no commits — `
            + 'make one (git commit --allow-empty -m init) and re-fire — no team was created',
        };
        reply(refusals[cls.error]);
        return;
      }
      const brief = String(intent.body == null ? '' : intent.body).replace(/^\n/, '');
      const hasBrief = brief.trim().length > 0;
      if (!hasBrief && mode === 'interview') {
        reply('error: mode:interview needs a brief body — no team was created');
        return;
      }
      if (hasBrief) {
        const bytes = Buffer.byteLength(brief, 'utf-8');
        if (bytes > TEAM_FILE_BODY_MAX) {
          reply(`error: brief too long (${bytes} > ${TEAM_FILE_BODY_MAX} bytes) — no team was created`);
          return;
        }
      }
      let lead;
      try { lead = defaultLeadSeat(name, intent.lead || null); } catch (err) {
        reply(`error: ${err.message}`);
        return;
      }
      if (hasBrief) {
        const seatName = this._validateSeatName(lead);
        if (!seatName.ok) {
          reply(`error: lead seat ${lead}: ${seatName.error} — no team was created`);
          return;
        }
      }
      try {
        createTeam({ name, root, lead, kit: intent.kit, dryRun: true });
      } catch (err) {
        reply(`error: ${err.message}`);
        return;
      }
      if (cls.kind !== 'takeover') {
        if (cls.kind === 'new-absent') {
          try { fs.mkdirSync(root); } catch (err) {
            reply(`error: could not create ${root} (${err.message}) — no team was created`);
            return;
          }
        }
        const init = await gitWorktree.initRepo(root);
        if (!init || !init.ok) {
          reply(`error: could not git init ${root} (${(init && init.error) || 'unknown'}) — no team was created`);
          return;
        }
      }
      const rootClause = cls.kind === 'takeover' ? '(existing repo, untouched)' : "(new, git init'd)";
      const kitRoles = (kitDef && Object.keys(kitDef.roles).length) ? kitDef.roles : STOCK_ROLE_DEFS;
      const roles = hasBrief ? {
        ...kitRoles,
        hand: { ...kitRoles.hand, dispatch: 'worktree' },
      } : undefined;
      let team;
      try {
        team = createTeam({ name, root, lead, roles, kit: intent.kit });
      } catch (err) {
        reply(`error: ${err.message}`);
        return;
      }
      const dir = nodePath.join(teamsDir, team.name);
      const kitClause = team.kitSeeded ? ` from kit ${team.kitSeeded}` : '';
      const copiedClause = (Array.isArray(team.templatesCopied) && team.templatesCopied.length
        ? `; templates copied to templates/<role>.json for ${team.templatesCopied.join(', ')}`
        : '')
        + (Array.isArray(team.promptsCopied) && team.promptsCopied.length
          ? `; prompts copied to prompts/system/<role>.md for ${team.promptsCopied.join(', ')}`
          : '');
      if (hasBrief) {
        const res = teamPromptSave(this._teamFileDeps(), team.name, 'append', 'team-project', brief);
        if (!res.ok) {
          try { fs.unlinkSync(nodePath.join(dir, 'team.json')); } catch {}
          try { fs.rmdirSync(nodePath.join(dir, 'prompts', 'append')); } catch {}
          for (const r of (Array.isArray(team.promptsCopied) ? team.promptsCopied : [])) {
            try { fs.unlinkSync(nodePath.join(dir, 'prompts', 'system', `${r}.md`)); } catch {}
          }
          try { fs.rmdirSync(nodePath.join(dir, 'prompts', 'system')); } catch {}
          try { fs.rmdirSync(nodePath.join(dir, 'prompts')); } catch {}
          for (const r of (Array.isArray(team.templatesCopied) ? team.templatesCopied : [])) {
            try { fs.unlinkSync(nodePath.join(dir, 'templates', `${r}.json`)); } catch {}
          }
          try { fs.rmdirSync(nodePath.join(dir, 'templates')); } catch {}
          for (const c of (Array.isArray(team.execCopied) ? team.execCopied : [])) {
            try { fs.unlinkSync(nodePath.join(dir, 'exec', `${c}.json`)); } catch {}
          }
          try { fs.rmdirSync(nodePath.join(dir, 'exec')); } catch {}
          try { fs.rmdirSync(dir); } catch {}
          this._refreshAppMenuQuietly();
          reply(`error: could not save the brief (${res.error}) — no team was created; `
            + `re-fire [agent:team create ${name} root:${root}${intent.lead ? ` lead:${intent.lead}` : ''}`
            + `${intent.mode ? ` mode:${intent.mode}` : ''}${intent.kit ? ` kit:${intent.kit}` : ''}] with the brief`);
          return;
        }
      }
      try { if (typeof refreshAppMenu === 'function') refreshAppMenu(); } catch {}
      if (hasBrief) {
        const head = `team "${team.name}" created${kitClause} — root ${team.root} ${rootClause}, lead ${team.lead}, dir ${dir}; `
          + `hand takes a branch + worktree + seat per ticket; brief saved to prompts/append/team-project.md${copiedClause}`;
        const isNew = cls.kind !== 'takeover';
        const rootArm = isNew
          ? `You are the lead of team ${team.name}. This is your first turn. Root ${team.root} is a NEW project — `
            + 'Clodex created and git-init\'d it, and it is empty apart from one empty commit. Follow '
            + '"First turn on a fresh team" in your prompt.'
          : `You are the lead of team ${team.name}. This is your first turn. Root ${team.root} is an EXISTING `
            + 'project you are taking over — Clodex touched none of its files. Follow "First turn on a fresh team" '
            + 'in your prompt.';
        const opener = mode === 'interview'
          ? `${rootArm} The brief is a STARTING POINT another agent wrote from a few words of the operator's, `
            + 'not a spec: follow the INTERVIEW arm of "First turn on a fresh team" — ask before you file.'
          : rootArm;
        const onReply = (msg) => {
          if (/^ok: spawned/.test(msg)) {
            const bare = msg.match(/lead role template "[^"]*" not installed, spawned with no template/);
            if (bare) {
              reply(`${head}; ${team.lead} spawned in the root WITHOUT its template (${bare[0]}) `
                + '— NOT briefed: the brief composes only through that template; install it and respawn.');
              return;
            }
            const briefedClause = mode === 'interview'
              ? 'and briefed (interview mode: it will ask the operator before filing a ticket).'
              : 'and briefed.';
            const leadTemplate = (team.roles && team.roles.lead && team.roles.lead.template) || DEFAULT_LEAD_TEMPLATE;
            reply(`${head}; ${team.lead} spawned in the root on template ${leadTemplate} ${briefedClause} `
              + `Ask ${team.lead} for your first ticket.`);
            this._deliverParkedActive(team.lead, session.name, opener, 'dm');
            return;
          }
          reply(`${head}; ${team.lead} could NOT be spawned (${msg.replace(/^error: /, '')}) — the team is on disk; `
            + `re-fire [agent:spawn name:${team.lead} cwd:${team.root}] yourself. `
            + `Then tell it: root is ${isNew ? 'NEW' : 'an EXISTING project (TAKEOVER)'}`
            + `${mode === 'interview' ? ', interview mode' : ''} — the opener is only delivered on a successful spawn.`);
        };
        this._handleSpawnIntent(session, { name: team.lead, cwd: team.root }, { onReply });
        return;
      }
      reply(`team "${team.name}" created${kitClause} — root ${team.root}, lead ${team.lead}, dir ${dir}${copiedClause}. `
        + 'Next: spawn the lead in that root, then [agent:team role-add …] from it.');
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
            if (intent.dispatch) def.dispatch = intent.dispatch;
            if (intent.cwd) def.cwd = intent.cwd;
            if (intent.account) {
              const acct = this._resolveRoleAccount(intent.account);
              if (!acct.ok) { reply(`error: ${acct.error}`); return; }
              if (acct.label) def.account = acct.label;
            }
            let addClause = '';
            let addUndo = null;
            if (intent.model) {
              const derived = this._deriveRoleModelTemplate(team, name, intent);
              if (!derived.ok) { reply(`error: ${derived.error}`); return; }
              def.template = name;
              addClause = derived.clause;
              addUndo = derived.undo;
            }
            if (intent.effort) {
              const derivedE = this._deriveRoleEffortTemplate(team, name, intent.model ? { ...intent, template: name } : intent);
              if (!derivedE.ok) { if (addUndo) addUndo(); reply(`error: ${derivedE.error}`); return; }
              def.template = name;
              addClause += derivedE.clause;
              const priorUndo = addUndo;
              addUndo = () => { derivedE.undo(); if (priorUndo) priorUndo(); };
            }
            let added;
            try { added = addRole(team.name, name, def); }
            catch (err) { if (addUndo) addUndo(); throw err; }
            const addCopied = (Array.isArray(added && added.templatesCopied) && added.templatesCopied.length
              ? `; templates copied to templates/<role>.json for ${added.templatesCopied.join(', ')}`
              : '')
              + (Array.isArray(added && added.promptsCopied) && added.promptsCopied.length
                ? `; prompts copied to prompts/system/<role>.md for ${added.promptsCopied.join(', ')}`
                : '');
            reply(`role "${name}" added to ${team.name}${addClause}${addCopied}`);
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
            if (intent.dispatch) patch.dispatch = intent.dispatch;
            if (intent.cwd) patch.cwd = intent.cwd;
            if (intent.account) {
              const acct = this._resolveRoleAccount(intent.account);
              if (!acct.ok) { reply(`error: ${acct.error}`); return; }
              patch.account = acct.label || '';
            }
            let setClause = '';
            let setUndo = null;
            if (intent.model) {
              const derived = this._deriveRoleModelTemplate(team, name, intent);
              if (!derived.ok) { reply(`error: ${derived.error}`); return; }
              patch.template = name;
              setClause = derived.clause;
              setUndo = derived.undo;
            }
            let ownDerivedTemplate = false;
            if (intent.effort) {
              const derivedE = this._deriveRoleEffortTemplate(team, name, intent.model ? { ...intent, template: name } : intent);
              if (!derivedE.ok) { if (setUndo) setUndo(); reply(`error: ${derivedE.error}`); return; }
              patch.template = name;
              ownDerivedTemplate = derivedE.reserved;
              setClause += derivedE.clause;
              const priorUndo = setUndo;
              setUndo = () => { derivedE.undo(); if (priorUndo) priorUndo(); };
            }
            try {
              if (ownDerivedTemplate) setRole(team.name, name, patch, { ownDerivedTemplate: true });
              else setRole(team.name, name, patch);
            }
            catch (err) { if (setUndo) setUndo(); throw err; }
            reply(`role "${name}" updated on ${team.name}${setClause}`);
            return;
          }
          case 'role-rm': {
            if (!name) { reply('error: role-rm needs a role name — [agent:team role-rm <name>]'); return; }
            const used = this._roleInUse(team, name);
            if (used.seats.length || used.tickets.length) {
              const parts = [];
              if (used.seats.length) parts.push(`seat(s): ${used.seats.join(', ')}`);
              if (used.tickets.length) parts.push(`in-flight ticket(s): ${used.tickets.join(', ')}`);
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
              if (used.tickets.length) parts.push(`in-flight ticket(s): ${used.tickets.join(', ')}`);
              reply(`error: role "${from}" is in use — ${parts.join('; ')}; reassign/retire them first`);
              return;
            }
            renameRole(team.name, from, to);
            reply(`role "${from}" renamed to "${to}" on ${team.name}`);
            return;
          }
          case 'gather': {
            const dry = !!intent.dry;
            const result = gatherTeam(team.name, { dry });
            reply(formatGatherReport(result, { dry }));
            return;
          }
          case 'set-lead': {
            if (!name) { reply('error: set-lead needs a seat name — [agent:team set-lead <seat>]'); return; }
            setLead(team.name, name);
            reply(`lead of ${team.name} is now "${name}"`);
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
          case 'template-save': {
            const stem = intent.stem || null;
            if (!stem) { reply('error: template-save needs a stem — [agent:team template-save <stem>] <json>'); return; }
            const raw = String(intent.body == null ? '' : intent.body);
            const bytes = Buffer.byteLength(raw, 'utf-8');
            if (bytes > TEAM_FILE_BODY_MAX) { reply(`error: template body too long (${bytes} > ${TEAM_FILE_BODY_MAX} bytes)`); return; }
            let parsed;
            try { parsed = JSON.parse(raw); }
            catch (err) { reply(`error: template body is not JSON (${err.message})`); return; }
            const res = teamTemplateSave(this._teamFileDeps(), team.name, stem, parsed);
            if (!res.ok) { reply(`error: ${res.error}`); return; }
            this._refreshAppMenuQuietly();
            reply(`template "${stem}" saved to ${res.file}`);
            return;
          }
          case 'template-rm': {
            const stem = intent.stem || null;
            if (!stem) { reply('error: template-rm needs a stem — [agent:team template-rm <stem>]'); return; }
            const users = this._rolesNaming(team, 'template', stem);
            if (users.length) {
              reply(`error: template "${stem}" is still named by role(s): ${users.join(', ')} — repoint them with [agent:team role-set …] first`);
              return;
            }
            const res = teamTemplateRemove(this._teamFileDeps(), team.name, stem);
            if (!res.ok) { reply(`error: ${res.error}`); return; }
            this._refreshAppMenuQuietly();
            reply(`template "${stem}" removed from ${res.file}`);
            return;
          }
          case 'prompt-save': {
            const kind = intent.kind || null;
            const stem = intent.stem || null;
            if (!stem) { reply('error: prompt-save needs a kind and a stem — [agent:team prompt-save system|append <stem>] <markdown>'); return; }
            const raw = String(intent.body == null ? '' : intent.body);
            const bytes = Buffer.byteLength(raw, 'utf-8');
            if (bytes > TEAM_FILE_BODY_MAX) { reply(`error: prompt body too long (${bytes} > ${TEAM_FILE_BODY_MAX} bytes)`); return; }
            const res = teamPromptSave(this._teamFileDeps(), team.name, kind, stem, raw);
            if (!res.ok) { reply(`error: ${res.error}`); return; }
            this._refreshAppMenuQuietly();
            reply(`prompt ${kind}/${stem} saved to ${res.file}`);
            return;
          }
          case 'prompt-rm': {
            const kind = intent.kind || null;
            const stem = intent.stem || null;
            if (!stem) { reply('error: prompt-rm needs a kind and a stem — [agent:team prompt-rm system|append <stem>]'); return; }
            const users = kind === 'system' ? this._rolesNaming(team, 'prompt', stem) : [];
            if (users.length) {
              reply(`error: prompt system/${stem} is still named by role(s): ${users.join(', ')} — repoint them with [agent:team role-set …] first`);
              return;
            }
            const res = teamPromptRemove(this._teamFileDeps(), team.name, kind, stem);
            if (!res.ok) { reply(`error: ${res.error}`); return; }
            this._refreshAppMenuQuietly();
            reply(`prompt ${kind}/${stem} removed from ${res.file}`);
            return;
          }
          case 'trunk': {
            this._handleTeamTrunk(team, intent, reply).catch((err) => reply(`error: ${(err && err.message) || err}`));
            return;
          }
          case 'sandbox': {
            this._handleTeamSandbox(team, intent, reply).catch((err) => reply(`error: ${(err && err.message) || err}`));
            return;
          }
          default:
            reply(`error: unknown team verb "${intent.sub}" — use role-add | role-set | role-rm | role-rename | set-lead | watchdog | gather | template-save | template-rm | prompt-save | prompt-rm | sandbox | trunk`);
        }
      } catch (err) {
        reply(`error: ${err.message}`);
      }
    },

    async _handleTeamTrunk(team, intent, reply) {
      const derived = await gitWorktree.mergeTargetFor({ root: team.root });
      if (!intent.branch) {
        reply(team.trunk
          ? `trunk of ${team.name} is "${team.trunk}" (set in team.json; the repo's default would be ${derived ? `"${derived}"` : 'unresolvable'})`
          : `trunk of ${team.name} is ${derived ? `"${derived}"` : 'unresolvable'} (derived from the repo's default branch; not set — [agent:team trunk <branch>] sets it)`);
        return;
      }
      const branches = await gitWorktree.localBranches(team.root);
      if (!branches) { reply(`error: could not list the branches of ${team.root}`); return; }
      if (!branches.includes(intent.branch)) {
        const shown = branches.slice(0, 20).join(', ') + (branches.length > 20 ? `, … (${branches.length} in all)` : '');
        reply(`error: no branch "${intent.branch}" in ${team.root} — it has: ${shown || '(no branches)'}`);
        return;
      }
      const m = setTeamTrunk(team.name, intent.branch);
      reply(`trunk of ${team.name} set to "${m.trunk}" — accepted tickets now merge into it`);
    },

    _teamSandboxFile(team) {
      return path.join(teamsDir, team.name, 'sandbox.json');
    },

    _shipTeamIntoBox(team, box) {
      if (typeof box.stateDir !== 'function') {
        return { dir: null, line: 'sandbox: this box has no state dir; team not shipped' };
      }
      const dest = path.join(box.stateDir(), 'dot', 'teams', team.name);
      const manifest = path.join(dest, 'team.json');
      if (fs.existsSync(manifest)) {
        return { dir: dest, line: `team ${team.name} already present in the box (kept)` };
      }
      ensureDirMode700(dest);
      for (const sub of SANDBOX_TEAM_SUBDIRS) {
        const src = path.join(team.dir, sub);
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, path.join(dest, sub), { recursive: true });
      }
      const obj = JSON.parse(fs.readFileSync(team.file || path.join(team.dir, 'team.json'), 'utf-8'));
      const translated = box.translateHostPath(team.root) || {};
      obj.root = translated.container || SANDBOX_WORK_DIR;
      for (const role of Object.values(obj.roles || {})) {
        if (role && typeof role === 'object') delete role.account;
      }
      delete obj.removedRoleAccounts;
      delete obj.sandboxed;
      atomicWriteFileSync(manifest, `${JSON.stringify(obj, null, 2)}\n`);
      return { dir: dest, line: `team ${team.name} shipped into the box (teams/${team.name})` };
    },

    async _handleTeamSandbox(team, intent, reply) {
      const action = intent.action || 'up';
      if (!SANDBOX_ACTIONS.includes(action)) {
        reply(`error: sandbox action must be ${SANDBOX_ACTIONS.join(' | ')} (got "${action}")`);
        return;
      }
      const mgr = typeof getSandboxManager === 'function' ? getSandboxManager() : null;
      if (!mgr) { reply('error: sandboxes are not enabled on this host — inside a sandbox box there is no docker; run [agent:team sandbox …] from a desktop seat, or use Settings > Sandboxes on the desktop'); return; }

      const boxId = `team-${team.name}`;
      if (!BOX_ID_RE.test(boxId)) {
        reply(`error: box id "${boxId}" must be lowercase letters, digits, dashes or underscores (no dots, no spaces) — rename the team`);
        return;
      }
      let box = mgr.get(boxId);
      if (!box && (action === 'status' || action === 'down')) {
        let removed = false;
        let staleFile = null;
        if (action === 'down') {
          staleFile = this._teamSandboxFile(team);
          try { fs.unlinkSync(staleFile); removed = true; } catch {}
        }
        reply(removed
          ? `sandbox ${boxId}: no box — stale ${staleFile} removed`
          : `sandbox ${boxId}: no box — this team has none; [agent:team sandbox up] creates it`);
        return;
      }
      if (!box) {
        const made = mgr.create(boxId, `${team.name} team`);
        if (made && made.ok === false) { reply(`error: ${made.error}`); return; }
        box = mgr.get(boxId);
        if (!box) { reply(`error: sandbox ${boxId} could not be created`); return; }
      }

      const file = this._teamSandboxFile(team);
      if (action === 'down') {
        const r = await box.down();
        if (r && r.ok === false) { reply(`error: ${r.error}`); return; }
        if (typeof box.unregisterPeer === 'function') box.unregisterPeer();
        try { fs.unlinkSync(file); } catch {}
        reply(`sandbox ${boxId} down — ${file} removed, peer entry ${boxId} unregistered`);
        return;
      }
      if (action === 'status') {
        const st = await box.status();
        const pm = typeof getPeerManager === 'function' ? getPeerManager() : null;
        const peer = pm ? ((pm.statuses() || []).find((p) => p && p.id === boxId) || null) : null;
        reply(`sandbox ${boxId} ${st.state}${sandboxRefClause(st)}${sandboxPortClause(st)}${sandboxVersionClause(peer)}`);
        return;
      }

      const patch = { workDir: team.root };
      if (intent.ref) patch.ref = intent.ref;
      else if (!box.getConfig().ref) patch.ref = SANDBOX_DEFAULT_REF;
      return this._bringUpTeamBox(team, { mgr, box, boxId, patch, action, reply });
    },

    async _bringUpTeamBox(team, { mgr, box, boxId, patch, action, reply }) {
      const file = this._teamSandboxFile(team);
      const saved = box.setConfig(patch);
      if (saved && saved.ok === false) { reply(`error: ${saved.error}`); return { ok: false }; }

      const seed = seedClaudeToken(mgr, box);

      const r = action === 'rebuild' ? await box.rebuild() : await box.up();
      if (r && r.ok === false) { reply(`error: ${r.error}`); return { ok: false }; }
      if (r && r.peerRegistered === false) reply(`peer NOT registered: ${r.peerError}`);
      const st = await box.status();
      const ports = (st && st.ports) || (r && r.ports) || {};
      const token = box.remoteToken();
      let shipped;
      try {
        shipped = this._shipTeamIntoBox(team, box);
      } catch (e) {
        shipped = { dir: null, line: `team NOT shipped: ${e.message}` };
      }
      reply(shipped.line);
      const record = {
        boxId,
        ref: (st && st.ref) || null,
        sha: (st && st.sha) || null,
        webUrl: ports.web ? `http://127.0.0.1:${ports.web}` : null,
        wireUrl: ports.wire ? `http://127.0.0.1:${ports.wire}` : null,
        token,
        webToken: box.webToken(),
        teamDir: shipped.dir,
        startedAt: new Date().toISOString(),
      };
      ensureDirMode700(path.dirname(file));
      atomicWriteFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

      const health = await box.waitHealthy();
      if (!health || health.ok === false) { reply(`error: ${(health && health.error) || 'health check failed'}`); return { ok: false }; }

      const seeds = [
        { name: 'bash', type: 'bash', cwd: SANDBOX_HOME_DIR },
        { name: team.lead, team: team.name },
      ];
      const seeded = await seedSandboxSessions({
        wireUrl: record.wireUrl, token, seeds, optional: [team.lead], fetch: seedFetch,
      });
      if (!seeded || seeded.ok === false) { reply(`error: ${(seeded && seeded.error) || 'seeding failed'}`); return { ok: false }; }
      const results = seeded.results || [];
      const leadResult = results.find((r) => r.name === team.lead);
      const ready = results.filter((r) => r.name !== team.lead && r.state !== 'failed').map((r) => r.name);

      reply(`sandbox ${boxId} ${action} @ ${sha8(record.sha)}${sandboxRefClause(record)}`
        + `${sandboxPortClause({ ports })}`
        + ` · healthy in ${Math.round((health.ms || 0) / 1000)}s`
        + ` · seeded ${ready.join(', ')}`
        + ` · token in ${file}`
        + `${claudeSeedClause(seed, boxId)}`
        + `${leadSeedClause(leadResult, team.lead)}`);
      return { ok: true, record, webUrl: record.webUrl };
    },

    _teamFileDeps() {
      return { fs, path, teamsDir, listTeams };
    },

    _deriveRoleModelTemplate(team, name, intent) {
      const roles = (team && team.roles && typeof team.roles === 'object') ? team.roles : {};
      if (!ROLE_RE.test(name)) return { ok: false, error: `role name "${name}" must match ${ROLE_RE} (${team.file})` };
      if (RESERVED_ROLE_KEYS.has(name)) return { ok: false, error: `the "${name}" role is operator-owned topology; ${intent.sub === 'role-add' ? 'add' : 'edit'} it via the app, not an intent/mutator (${team.file})` };
      if (intent.sub === 'role-set' && !roles[name]) return { ok: false, error: `role "${name}" not found on team "${team.name}" — use role-add (${team.file})` };
      if (intent.sub === 'role-add' && roles[name]) return { ok: false, error: `role "${name}" already exists on team "${team.name}" — use role-set` };
      const current = roles[name] && typeof roles[name] === 'object' ? roles[name].template : null;
      const sharers = this._rolesNaming(team, 'template', name).filter((r) => r !== name);
      if (sharers.length) return { ok: false, error: `template "${name}" is named by role(s): ${sharers.join(', ')} — model: would re-model them too; name a different role or repoint them first` };
      const stem = intent.template || current || 'clodex-team-hand';
      let base = readTeamJson({ fs, path }, team, 'templates', stem);
      if (!base) {
        try { base = allTemplates().find((t) => t && t.name === stem) || null; }
        catch { base = null; }
      }
      if (!base) return { ok: false, error: `no template "${stem}" to derive from` };
      const baseType = base.type || DEFAULT_TYPE;
      const adapter = adapterFor(baseType);
      if (!adapter) return { ok: false, error: `template "${stem}" names type "${base.type}" — known: ${PLATFORMS.join(', ')}` };
      const id = resolveModelId(baseType, intent.model);
      if (!id) {
        const aliases = Object.keys(adapter.model.aliases);
        return { ok: false, error: aliases.length
          ? `model "${intent.model}" is not a model id or alias (${aliases.join(', ')})`
          : `model "${intent.model}" is not a model id — Codex takes no aliases` };
      }
      const deps = this._teamFileDeps();
      const target = teamTemplatePath(deps, team.name, name);
      let prior = null;
      try { prior = target ? fs.readFileSync(target) : null; } catch { prior = null; }
      const res = teamTemplateSave(deps, team.name, name, deriveModelTemplate(base, name, id));
      if (!res.ok) return { ok: false, error: res.error };
      this._refreshAppMenuQuietly();
      const undo = () => {
        try {
          if (prior != null) { fs.writeFileSync(res.file, prior); return; }
          fs.unlinkSync(res.file);
          try { fs.rmdirSync(path.dirname(res.file)); } catch {}
        } catch {}
        this._refreshAppMenuQuietly();
      };
      return { ok: true, undo, clause: ` — template "${name}" derived from ${stem} with --model ${id} (${res.file})` };
    },

    _deriveRoleEffortTemplate(team, name, intent) {
      const roles = (team && team.roles && typeof team.roles === 'object') ? team.roles : {};
      if (!ROLE_RE.test(name)) return { ok: false, error: `role name "${name}" must match ${ROLE_RE} (${team.file})` };
      const reviewerOnly = name === 'reviewer' && intent.sub === 'role-set'
        && !intent.model && !intent.prompt && !intent.template && !intent.dispatch && !intent.cwd;
      if (RESERVED_ROLE_KEYS.has(name) && !reviewerOnly) {
        return { ok: false, error: `the "${name}" role is operator-owned topology; ${intent.sub === 'role-add' ? 'add' : 'edit'} it via the app, not an intent/mutator${name === 'reviewer' ? ' — effort: (with account:) is the only kv it takes alone' : ''} (${team.file})` };
      }
      if (intent.sub === 'role-set' && !roles[name]) return { ok: false, error: `role "${name}" not found on team "${team.name}" — use role-add (${team.file})` };
      if (intent.sub === 'role-add' && roles[name]) return { ok: false, error: `role "${name}" already exists on team "${team.name}" — use role-set` };
      if (!reviewerOnly) {
        const sharers = this._rolesNaming(team, 'template', name).filter((r) => r !== name);
        if (sharers.length) return { ok: false, error: `template "${name}" is named by role(s): ${sharers.join(', ')} — effort: would re-effort them too; name a different role or repoint them first` };
      }
      const current = roles[name] && typeof roles[name] === 'object' ? roles[name].template : null;
      const stem = intent.template || current || (reviewerOnly ? DEFAULT_REVIEWER_TEMPLATE : 'clodex-team-hand');
      let base = readTeamJson({ fs, path }, team, 'templates', stem);
      if (!base) {
        try { base = allTemplates().find((t) => t && t.name === stem) || null; }
        catch { base = null; }
      }
      if (!base) return { ok: false, error: `no template "${stem}" to derive from` };
      const rolePrompt = roles[name] && typeof roles[name].prompt === 'string' ? roles[name].prompt : null;
      if (reviewerOnly && current && current !== name && rolePrompt
          && typeof base.systemPromptFile === 'string' && base.systemPromptFile && base.systemPromptFile !== rolePrompt) {
        return { ok: false, error: `reviewer names template "${current}" explicitly; set Effort on that template in the editor (${team.file})` };
      }
      const baseType = base.type || DEFAULT_TYPE;
      if (!adapterFor(baseType)) return { ok: false, error: `template "${stem}" names type "${base.type}" — known: ${PLATFORMS.join(', ')}` };
      const effort = resolveEffort(baseType, intent.effort);
      if (effort && typeof effort === 'object') return { ok: false, error: effort.error };
      const deps = this._teamFileDeps();
      const target = teamTemplatePath(deps, team.name, name);
      let prior = null;
      try { prior = target ? fs.readFileSync(target) : null; } catch { prior = null; }
      const res = teamTemplateSave(deps, team.name, name, deriveEffortTemplate({ ...base, type: baseType }, name, effort));
      if (!res.ok) return { ok: false, error: res.error };
      this._refreshAppMenuQuietly();
      const undo = () => {
        try {
          if (prior != null) { fs.writeFileSync(res.file, prior); return; }
          fs.unlinkSync(res.file);
          try { fs.rmdirSync(path.dirname(res.file)); } catch {}
        } catch {}
        this._refreshAppMenuQuietly();
      };
      const what = effort ? `effort ${effort}` : 'no effort (the CLI default)';
      return { ok: true, undo, reserved: RESERVED_ROLE_KEYS.has(name), clause: ` — template "${name}" derived from ${stem} with ${what} (${res.file})` };
    },

    _refreshAppMenuQuietly() {
      try { if (typeof refreshAppMenu === 'function') refreshAppMenu(); } catch {}
    },

    _rolesNaming(team, field, stem) {
      const roles = (team && team.roles && typeof team.roles === 'object') ? team.roles : {};
      return Object.entries(roles)
        .filter(([, def]) => def && typeof def === 'object' && def[field] === stem)
        .map(([roleName]) => roleName)
        .sort();
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
      } catch { return ''; }
    },

    _hostIsThisTeamsCode(team, seams = {}) {
      const dir = seams.dir || __dirname;
      const root = team && team.root;
      if (!root) return false;
      try { return fs.realpathSync(root) === fs.realpathSync(dir); } catch { return false; }
    },

    _handleTask(session, intent) {
      let stale = '';
      const reply = (msg) => this._injectText(session, `[agent:task] ${msg}${stale}`, { parkable: true });
      const ack = (msg) => this._taskAck(session, `[agent:task] ${msg}${stale}`);
      let team;
      try { team = resolveTeam(session.cwd); } catch { team = null; }
      // This is the only rejecting return reached before the verb runs, so the payload spill lives here
      // rather than in each verb.
      if (!team) {
        team = this._soloContext(session);
        if (!team) { reply(`error: this session is not on a team and is not inside a git repository — a ticket needs a project to belong to${this._spillRejectedPayload(session, `task ${intent.sub}`, String(intent.body == null ? '' : intent.body).trim())}`); return; }
      }
      try { stale = this._hostIsThisTeamsCode(team) ? this._staleHostSuffix() : ''; } catch { stale = ''; }
      try {
        switch (intent.sub) {
          case 'add': this._taskAdd(session, team, intent, reply, ack); break;
          case 'assign': this._taskAssign(session, team, intent, reply, ack); break;
          case 'start': this._taskStart(session, team, intent, reply, ack); break;
          case 'done': this._taskDone(session, team, intent, reply); break;
          case 'reject': this._taskReject(session, team, intent, reply, ack); break;
          case 'respec': this._taskRespec(session, team, intent, reply, ack); break;
          case 'cancel': this._taskCancel(session, team, intent, reply, ack); break;
          case 'accept': this._taskAccept(session, team, intent, reply, ack).catch((e) => {
            log.warn('intent', `task accept ${intent.id} by ${session.name} failed: ${e.message}`);
            reply(`error: accept ${intent.id || ''} failed: ${e.message}`);
          }); break;
          case 'park': this._taskPark(session, team, intent, reply, ack); break;
          case 'list': this._taskList(session, team, intent, reply); break;
        }
      } catch (e) {
        log.warn('intent', `task ${intent.sub} ${intent.id || ''} by ${session.name} failed: ${e.message}`);
        reply(`error: task ${intent.sub} failed: ${e.message}`);
      }
    },

    _assigneeMissText(team, who) {
      return (team && team.solo)
        ? `"${who}" is not a live session in ${team.name} — with no team, an assignee is a live session name`
        : `"${who}" is neither a team role nor a live seat on ${team.name}`;
    },

    _resolveAssignee(team, who) {
      if (!who) return null;
      if (team.roles && Object.prototype.hasOwnProperty.call(team.roles, who)) return who;
      if (this._teamLiveSeatNames(team.root).includes(who)) return who;
      return null;
    },

    _resolvableAssignTarget(team, ticket) {
      const t = ticket || {};
      return this._resolveAssignee(team, t.role)
        || this._resolveAssignee(team, t.assignee)
        || '<role|name>';
    },

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
      if (ticket.worktree) return null;
      if (this._seatMintPending(a)) return a;
      if (!isRoleKey(ticket.role)) return null;
      return firstSeatFor(ticket.role);
    },

    _seatMintPending(name) {
      try {
        const rec = getPersistence().get(name);
        return !!(rec && rec.ephemeral === true && !rec.createdAt);
      } catch { return false; }
    },

    _repinTicketToSeat(team, ticket) {
      const a = ticket && ticket.assignee;
      if (!a) return null;
      const isRoleKey = (k) => !!(k && team.roles && Object.prototype.hasOwnProperty.call(team.roles, k));
      // Two shapes re-pin: a ticket still on its role, and one whose pinned seat died and degraded to
      // ticket.role; leaving the latter pinned to a dead name re-degrades it on every resolution.
      const role = isRoleKey(a) ? a : (ticket.role || null);
      if (!isRoleKey(role)) return null;
      if (a !== role && this._teamLiveSeatNames(team.root).includes(a)) return null;
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (!seat || seat === team.lead || seat === a) return null;
      ticket.role = role;
      ticket.assignee = seat;
      return seat;
    },

    // `replay` marks a redelivery in the text itself: the seat cannot tell a replay from a fresh
    // assignment, so unmarked it silently double-executes.
    // `onWrite(disposition)` fires when the bytes are durable ('injected' or 'parked'), never on enqueue;
    // a caller that persists "this seat has been told" must stamp from it, not from the `queued` return.
    // `fromBacklog` is caller-supplied and never stamped on the ticket: the assignee is already reassigned
    // here, and a flag on disk would resurface on a later replay describing a state long gone.
    _deliverTicketSpec(team, ticket, specText, fromName, urgent = false, replay = false, respec = false, onWrite = null, fromBacklog = false, prelude = '') {
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (!seat) return { undelivered: true };
      if (seat === team.lead) return { self: true };
      // Worded true of both replay cases (respawn, and never reached a seat): "your process restarted"
      // would be false in the second.
      // Working tree first, since a dead incarnation may never have written an artifact; three branches,
      // because a done/not-done pair sends partial work down the destructive "start over".
      // A respec is marked like a replay: a spilled body looks like a fresh dispatch, and a seat reading it
      // that way compacts and starts clean, discarding in-flight work.
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
      const respecCount = Array.isArray(ticket.respecs) ? ticket.respecs.length : 0;
      const supersededLine = (!respec && respecCount)
        ? `This ticket's spec was REPLACED ${respecCount === 1 ? 'once' : `${respecCount} times`} while it was open, and only the `
          + `current revision is below — the earlier ones are recorded on the ticket but are NOT reproduced here, so a `
          + `correction written as a delta reads as the whole job. If work is already in the tree that the text below never `
          + `mentions, it is more likely a superseded instruction than stray work: do not delete it on that basis, report it.\n`
        : '';
      const backlogLine = fromBacklog
        ? `This ticket had no assignee until this dispatch, so its body was written while nobody was on it and may `
          + `tell you it is blocked, parked, or awaiting someone's word before you start. On that ONE question — whether to `
          + `begin — the board is current and the body is a filing-time snapshot: the board says start, so start. This `
          + `discharges nothing else. Every other caveat, constraint, scope fence and hazard in the body stands exactly as `
          + `written. And if the body gates on a specific condition you cannot confirm was met, report that rather than `
          + `assuming it was discharged.\n`
        : '';
      // Rides every delivery including a replay: a respawned seat has no memory of its tree.
      const wtLine = (ticket && ticket.worktree && ticket.worktree.path)
        ? `WORK IN: ${ticket.worktree.path} (git worktree, branch ${ticket.worktree.branch}) — this is your cwd. `
          + `Commit to ${ticket.worktree.branch} as you go, never push, do not merge. `
          + `${team && team.root ? `The shared checkout is ${team.root}; do not edit files there.` : ''}\n`
        : '';
      // Separate from `WORK IN:`, which must stay the tree root (git commands run there); `role || assignee`
      // because `role` is unset until pinned, and hasOwnProperty because a seat name can equal a prototype key.
      const roleName = (ticket && (ticket.role || ticket.assignee)) || '';
      const roleDef = (team && team.roles && roleName
        && Object.prototype.hasOwnProperty.call(team.roles, roleName)) ? team.roles[roleName] : null;
      // Read through `_roleCwdRel`, the spawn resolver's helper, never raw `roleDef.cwd`: a hand-edited
      // `../../x` or `/etc` would name a path outside the worktree.
      const roleCwdRel = this._roleCwdRel(roleDef).rel;
      // Rides only on a cwd the spawn resolver accepted (it also refuses a missing dir, an escaping symlink and
      // a nested team.json); a symlink that exists only inside the worktree stays unseen.
      const roleCwdHonored = !!roleCwdRel && !!(team && team.root)
        && this._resolveRoleCwd(team, roleDef).fallback === null;
      const areaLine = (roleCwdHonored && ticket && ticket.worktree && ticket.worktree.path)
        ? `YOUR AREA in that tree: ${path.join(ticket.worktree.path, roleCwdRel)} — your role works in "${roleCwdRel}". `
          + `The tree ROOT above stays the path for git commands and for the suite; this is where your files live.\n`
        : '';
      // The tree check is a second condition: a role edited to `spawn` mid-flight, or a mint failure, can leave a
      // real worktree on the record, and the text must yield to that pointer.
      const sharedLine = (roleDef && roleDef.dispatch === 'spawn'
        && !(ticket && ticket.worktree && ticket.worktree.path))
        ? `You are working in the SHARED checkout alongside other seats — you have no worktree and no branch of your own, `
          + `so do tree work only and leave committing to the lead.\n`
        : '';
      // Rendered beside the spec, never into it: `ticket.spec` is the lead's text and only `respec` replaces it.
      const taskDirLine = this._ticketTaskDirRender(team, ticket).line;
      // Rides every dispatch, replays included: a respawned seat has no memory of the verb.
      const closeLine = ticketCloseLine(ticket.id);
      // Every dispatch spills (close line ~410 chars, worktree ~730, threshold 500), so the pointer line must
      // carry the id and the close verb; a spilled body shows only "Message (N bytes) attached".
      const r = this._gatedDeliver(seat, fromName, `${prelude}${head}${supersededLine}${backlogLine}${wtLine}${areaLine}${sharedLine}${taskDirLine}${closeLine}${specText}`, urgent,
        replay
          ? `[ticket ${ticket.id} REPLAY] close with ${ticketCloseVerb(ticket.id)}`
          : respec
            ? `[ticket ${ticket.id} RESPEC] close with ${ticketCloseVerb(ticket.id)}`
            : `[ticket ${ticket.id}] close with ${ticketCloseVerb(ticket.id)}`,
        // Arm first, then the caller's hook in the finally, so a throw in either cannot skip the other; the catch
        // logs because no caller sees a throw from here, and an unwatched spec must not also be invisible.
        (disposition, why) => {
          try { this._armSpecConfirm(seat, ticket.id, disposition, null, why); }
          catch (e) { log.error('intent', `spec latch arm failed for ${seat} on ${ticket.id}: ${e.message}`); }
          finally { if (onWrite) { try { onWrite(disposition, seat); } catch {} } }
        });
      if (!r || r.error) return { undelivered: true };
      if (r.parked) return { parked: r.parked, reason: r.reason || null };
      if (r.held) return { held: true, reason: r.held };
      return { queued: true };
    },

    _armSpecConfirm(seatName, ticketId, disposition, redirect = null, divertedBy = null) {
      const s = this.sessions.get(seatName);
      if (!s || !s.agentType || s._dead) return;
      const kind = redirect ? 'redirect' : 'spec';
      const live = s._specUnconfirmed;
      if (disposition === 'parked' && divertedBy === 'window' && live && live.ticketId === ticketId
          && live.kind === kind && !live.windowRearmed) {
        live.retried = false;
        live.windowRearmed = true;
        log.info('intent', `${kind} write of ${ticketId} parked by the turn-start window on ${seatName} — latch kept for one typed redelivery`);
        return;
      }
      if (disposition !== 'injected') {
        if (disposition === 'parked' && redirect && redirect.carried && live
            && live.ticketId === ticketId && live.kind === kind) {
          this._pruneOwedSpent(s, { ticketId, kind });
          s._specUnconfirmed = { ...live, ...redirect };
          log.info('intent', `${kind} write of ${ticketId} parked on ${seatName} carrying the unconfirmed ${live.label || 'rejection'} — latch kept`);
          return s._specUnconfirmed;
        }
        // Pruned on this call's ticket and kind, outside the latch-match guard below: `_drainOwedSpec` refuses
        // to run while a latch is set, so a parked redelivery finds the slot empty.
        this._pruneOwedSpent(s, { ticketId, kind });
        // Matched on kind too: a parked redirect must not retire a spec latch still watching an earlier dispatch.
        if (s._specUnconfirmed && s._specUnconfirmed.ticketId === ticketId
            && s._specUnconfirmed.kind === kind) {
          s._specUnconfirmed = null;
          clearTimeout(s._specConfirmTimer);
          s._specConfirmTimer = null;
        }
        return;
      }
      // Runs at write time, after the gates: a seat that went busy meanwhile is already working, and a latch
      // over a submitted spec would run its full window with no edge to clear it.
      if (s.activityState !== 'idle') return;
      // The retry budget carries over on ticket and kind only, never label: a second redirect's Ctrl-U destroys
      // the first's draft anyway, so separate budgets would promise a distinction the PTY cannot deliver.
      const prior = s._specUnconfirmed;
      const retried = !!(prior && prior.ticketId === ticketId && prior.kind === kind && prior.retried);
      const rearmed = !!(prior && prior.ticketId === ticketId && prior.kind === kind && prior.windowRearmed);
      // This write's Ctrl-U already destroyed the prior ticket's draft and the assignment below overwrites its
      // watcher, so the loss is owed a redelivery here rather than a second watcher.
      if (prior && prior.ticketId !== ticketId) this._oweDisplacedSpec(s, prior);
      clearTimeout(s._specConfirmTimer);
      // Anchor at write time: a respawned seat's transcript already holds this ticket's marker, and unanchored
      // every later turn matches it. No transcript yet anchors at 0, not -1, so a fresh dispatch stays answerable.
      const size = this._seatTranscriptSize(seatName);
      const since = size < 0 ? 0 : size;
      let sinceFile = null;
      try { sinceFile = fs.realpathSync(pathFor(REGISTRY_DIR, seatName, 'transcript')); } catch {}
      const carry = this._redirectCarry(seatName, ticketId, prior, redirect);
      s._specUnconfirmed = redirect
        ? { ticketId, kind, at: Date.now(), retried, since, sinceFile, ...redirect, ...carry }
        : { ticketId, kind, at: Date.now(), retried, since, sinceFile };
      if (rearmed) s._specUnconfirmed.windowRearmed = true;
      this._armSpecConfirmTimer(s);
      return s._specUnconfirmed;
    },

    _redirectCarry(seatName, ticketId, prior, redirect) {
      if (!(redirect && prior && prior.ticketId === ticketId && prior.kind === 'redirect'
          && typeof prior.reason === 'string' && prior.reason)) return null;
      if (prior.reason === redirect.reason) return prior.carried ? { reason: prior.reason, carried: true } : null;
      if (this._seatTranscriptHas(seatName, ticketId, prior.since, undefined, prior.sinceFile) === true) return null;
      const first = prior.carried ? prior.reason
        : `[ticket ${ticketId} ${prior.label || 'rejected'}] ${prior.reason}`;
      return { reason: `${first}\n[ticket ${ticketId} ${redirect.label}] ${redirect.reason}`, carried: true };
    },

    // One builder for the first delivery and the redelivery, so a replay is the first copy plus a head and
    // cannot drift from it.
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
        try { this._checkSpecConfirm(session); }
        catch (e) { log.error('intent', `spec confirmation check failed for ${session.name}: ${e.message}`); }
      }, SPEC_CONFIRM_MS);
      // Unref'd so the 90s window never keeps a process alive, notably every test file that dispatches a ticket.
      if (session._specConfirmTimer.unref) session._specConfirmTimer.unref();
    },

    _oweDisplacedSpec(session, prior) {
      const key = `${prior.ticketId}:${prior.kind}`;
      const spent = prior.retried || !!(session._specOwedSpent && session._specOwedSpent.has(key));
      const what = prior.kind === 'redirect'
        ? `${prior.label || 'rejection'} for ${prior.ticketId}` : `spec for ${prior.ticketId}`;
      if (spent) {
        let team; try { team = resolveTeam(session.cwd) || this._soloContext(session); } catch { team = null; }
        if (team && team.solo) team = this._soloOpenerTeam(team, ticketsStore.load(team.root).find((t) => t.id === prior.ticketId));
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

    // Released once a write is no longer destroyable (receipt or park), not on proof the seat read it: a
    // parked file on disk cannot be destroyed by a later Ctrl-U.
    // Deletes one ticket+kind key, never the whole set: a turn on one ticket is no evidence about another's destroyed draft.
    _pruneOwedSpent(session, u) {
      if (!session._specOwedSpent || !u) return;
      session._specOwedSpent.delete(`${u.ticketId}:${u.kind}`);
      if (!session._specOwedSpent.size) session._specOwedSpent = null;
    },

    _armSpecOwedTimer(session) {
      session._specOwedTimer = setTimeout(() => {
        session._specOwedTimer = null;
        try { this._drainOwedSpec(session); }
        catch (e) { log.error('intent', `displaced-spec drain failed for ${session.name}: ${e.message}`); }
      }, SPEC_CONFIRM_MS);
      if (session._specOwedTimer.unref) session._specOwedTimer.unref();
    },

    // The wait on a live latch is uncapped on purpose: it resolves itself in every case except a permission
    // dialog, where a write must not be attempted at all.
    _drainOwedSpec(session) {
      const queue = session._specOwed;
      if (!queue || !queue.length) return;
      if (session._dead || !this.sessions.has(session.name)) { session._specOwed = []; return; }
      // A redelivery still in the gates (up to 5 minutes against a 90s re-arm) arms no latch yet, so
      // `_specOwedInFlight` also blocks the drain; it is cleared from the write.
      if (session._specUnconfirmed || session._specOwedInFlight) { this._armSpecOwedTimer(session); return; }
      const u = queue[0];
      const rearm = () => { if (queue.length) this._armSpecOwedTimer(session); };
      const isRedirect = u.kind === 'redirect';
      const step = isRedirect ? 'redirect-undelivered' : 'spec-undelivered';
      const what = isRedirect ? `${u.label || 'rejection'} for ${u.ticketId}` : `spec for ${u.ticketId}`;
      let team; try { team = resolveTeam(session.cwd) || this._soloContext(session); } catch { team = null; }
      if (!team) { this._armSpecOwedTimer(session); return; }
      queue.shift();
      const ticket = ticketsStore.load(team.root).find((t) => t.id === u.ticketId);
      team = this._soloOpenerTeam(team, ticket);
      if (!ticket || ticket.state !== 'open') { rearm(); return; }
      // Logged: this is the only drop taken on a substring heuristic, and a false true would silently recreate
      // the original loss.
      if (this._seatTranscriptHas(session.name, u.ticketId, u.since, undefined, u.sinceFile) === true) {
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
      session._specOwedInFlight = true;
      const done = () => { session._specOwedInFlight = false; };
      const r = isRedirect
        ? this._deliverRedirectReplay(team, ticket, session.name, u, done)
        : this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true, true, false, done);
      if (!r || !(r.queued || r.parked)) {
        // Reached nobody: no latch arms and no onWrite fires, so this is the flag's only way home.
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

    _armReviewStartCheck(seatName, leadName) {
      const s = this.sessions.get(seatName);
      if (!s || !(adapterFor(s.agentType) || {}).caps?.transcript || s._dead) return;
      if (!s._reviewStartArmedAt) {
        s._reviewStartArmedAt = Date.now();
        s._reviewStartSize = Math.max(0, this._seatTranscriptSize(seatName));
        s._reviewStartFile = null;
        try { s._reviewStartFile = fs.realpathSync(pathFor(REGISTRY_DIR, seatName, 'transcript')); } catch {}
      }
      s._reviewStartTimer = setTimeout(() => {
        s._reviewStartTimer = null;
        try { this._checkReviewStarted(s, leadName); }
        catch (e) { log.error('intent', `review start check failed for ${seatName}: ${e.message}`); }
      }, SPEC_CONFIRM_MS);
      // Unref'd so the timer never keeps the process, or a test file, alive.
      if (s._reviewStartTimer.unref) s._reviewStartTimer.unref();
    },

    _checkReviewStarted(session, leadName) {
      if (!session || session._dead) return;
      if (!this.sessions.has(session.name)) return;
      // A permission dialog produces no turn and is not this defect: re-arm uncapped rather than alarm.
      if (session.needsAttention && session.needsAttention.kind === 'permission') {
        this._armReviewStartCheck(session.name, leadName);
        return;
      }
      if (session.activityState !== 'idle') return;
      if (this._seatTurnSince(session.name, session._reviewStartSize || 0, undefined, session._reviewStartFile || null) === true) return;

      if (!session._reviewNudgeRetried) {
        session._reviewNudgeRetried = true;
        log.warn('intent', `reviewer ${session.name} has taken no turn ${SPEC_CONFIRM_MS / 1000}s after spawn — re-sending the start nudge once`);
        this._broadcast('ipc-message', {
          ts: Date.now(), from: 'clodex', to: session.name, kind: 'review-renudged',
          body: `${session.name} never started — re-sending the start nudge`,
        });
        // Restates no scope; the trailing clause makes a nudge that parks and drains after the seat's first turn
        // harmless, since that race cannot be closed from outside the seat.
        this._deliverParkedActive(session.name, leadName,
          'Your review scope is in your system prompt. Begin — ignore this if you have already started.', 'dm');
        // Re-armed so a seat that stays silent after the retry is still escalated.
        this._armReviewStartCheck(session.name, leadName);
        return;
      }

      log.error('intent', `reviewer ${session.name}'s transcript has not grown after a re-sent nudge — it never took a first turn`);
      this._broadcast('ipc-message', {
        ts: Date.now(), from: 'clodex', to: session.name, kind: 'review-unstarted',
        body: `${session.name} never started its review`,
      });
      this._gatedDeliver(leadName, 'clodex-team',
        // `|| Date.now()` yields a visibly wrong 0s rather than NaN for a session that reaches here unarmed.
        `[review ${session.name}] spawned ${Math.round((Date.now() - (session._reviewStartArmedAt || Date.now())) / 1000)}s ago, was re-sent its start nudge, and has STILL taken no turn — its transcript holds no turn record since spawn, so it never started. `
        + 'Its scope is in its system prompt and is intact; what was lost is the nudge that starts it, and re-sending it did not help. '
        + `Recover with an urgent dm to ${session.name} re-sending the scope and telling it to ignore the message if it already has it — NOT a respawn, which mints a second seat and strands this one's mail.`,
        false, `[review ${session.name}] never started`);
    },

    // -1, not 0, for an unreadable link: 0 is a real size, and an fs error must not read as a seat that
    // produced nothing.
    _seatTranscriptSize(name) {
      try {
        const link = pathFor(REGISTRY_DIR, name, 'transcript');
        return fs.statSync(fs.realpathSync(link)).size;
      } catch { return -1; }
    },

    _seatTranscriptHas(name, ticketId, from = 0, tailBytes = 1 << 20, fromFile = null) {
      const tail = this._seatTranscriptTail(name, from, tailBytes, fromFile);
      if (tail === null) return null;
      return tail.includes(`[ticket ${ticketId}]`) || tail.includes(`[ticket ${ticketId} `);
    },

    // Readable with nothing appended is a definite no, not an unknown: null here would surrender fresh seats
    // and wire-routed edges that beat the CLI's append.
    _seatTranscriptTail(name, from = 0, tailBytes = 1 << 20, fromFile = null) {
      let target = null;
      try { target = fs.realpathSync(pathFor(REGISTRY_DIR, name, 'transcript')); } catch {}
      if (!fromFile || target === fromFile) return target ? this._transcriptFileTail(target, from, tailBytes) : null;
      const anchored = this._transcriptFileTail(fromFile, from, tailBytes);
      if (anchored === null) return null;
      const fresh = target ? this._transcriptFileTail(target, 0, tailBytes) : null;
      return fresh === null ? anchored : `${anchored}\n${fresh}`;
    },

    _transcriptFileTail(target, from = 0, tailBytes = 1 << 20) {
      let fd;
      try {
        const size = fs.statSync(target).size;
        if (size <= from) return '';
        const start = Math.max(from, size - tailBytes);
        const len = size - start;
        const buf = Buffer.alloc(len);
        fd = fs.openSync(target, 'r');
        fs.readSync(fd, buf, 0, len, start);
        return buf.toString('utf8');
      } catch { return null; }
      finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
    },

    _seatTurnSince(name, from = 0, tailBytes = 1 << 20, fromFile = null) {
      const tail = this._seatTranscriptTail(name, from, tailBytes, fromFile);
      if (tail === null) return null;
      const s = this.sessions.get(name);
      const reader = readerFor((((s && adapterFor(s.agentType)) || {}).transcript || {}).reader);
      for (const line of tail.split('\n')) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        for (const rec of reader.expand(obj)) {
          const c = reader.classify(rec);
          if (c.turnStart || c.isReply || c.turnEnd) return true;
        }
      }
      return false;
    },

    _soloOpenerTeam(team, ticket) {
      if (!team || !team.solo || !ticket) return team;
      const add = (Array.isArray(ticket.events) ? ticket.events : []).find((e) => e && e.kind === 'add');
      return { ...team, lead: ticket.opener || (add && add.by) || null };
    },

    _checkSpecConfirm(session) {
      const u = session._specUnconfirmed;
      if (!u || session._dead) return;
      // Re-arm uncapped: the operator may answer at any time and a seat that never woke is still worth
      // catching later; the timer is unref'd and cleanup clears it.
      if (session.needsAttention && session.needsAttention.kind === 'permission') {
        this._armSpecConfirmTimer(session);
        return;
      }
      // Second look before spending a redelivery: on a wire-routed seat the clearing edge can race the CLI's
      // append, so a consumed spec can still be armed here.
      if (this._seatTranscriptHas(session.name, u.ticketId, u.since, undefined, u.sinceFile) === true) {
        this._pruneOwedSpent(session, u);
        session._specUnconfirmed = null;
        return;
      }
      let team; try { team = resolveTeam(session.cwd) || this._soloContext(session); } catch { return; }
      if (!team) return;
      const ticket = ticketsStore.load(team.root).find((t) => t.id === u.ticketId);
      team = this._soloOpenerTeam(team, ticket);
      if (!ticket || ticket.state !== 'open') { session._specUnconfirmed = null; return; }
      const holder = this._ticketAssigneeSeat(team, ticket);
      // Reassigned to a live seat (the documented recovery): it clears its own latch, so redelivering here would
      // inject a REPLAY into a seat mid-work and escalate naming the wrong seat.
      if (holder && holder !== session.name) {
        // Logged because this branch also covers the role resolver picking a different sibling, which means a
        // silent seat went unwatched.
        log.info('intent', `${u.kind === 'redirect' ? 'redirect' : 'spec'} latch for ${u.ticketId} dropped at ${session.name}: the ticket now resolves to ${holder}`);
        session._specUnconfirmed = null;
        return;
      }
      // Not dropped quietly like reassignment: the spec reached no one. Each arm reports what was actually lost, so
      // a redirect is not reported as an undelivered spec.
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
        // Safe to redeliver because the latch is still set: the seat cannot have consumed the spec without clearing
        // it, and the leading Ctrl-U replaces an unsubmitted draft rather than concatenating.
        u.retried = true;
        log.warn('intent', `${what} unconfirmed on ${session.name} after ${SPEC_CONFIRM_MS / 1000}s (no turn started) — redelivering once`);
        this._broadcast('ipc-message', {
          ts: Date.now(), from: 'clodex', to: session.name,
          kind: isRedirect ? 'redirect-unconfirmed' : 'spec-unconfirmed',
          body: `ticket ${u.ticketId} ${isRedirect ? `${u.label || 'rejection'} written` : 'spec written'} but no turn started — redelivering`,
        });
        // The redirect rebuilds from the latch snapshot because its reason is persisted nowhere on the record
        // (only `reworkRound` is).
        const r = isRedirect
          ? this._deliverRedirectReplay(team, ticket, session.name, u)
          : this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true, true);
        // A redelivery that reached nobody arms nothing, so the escalation below would be unreachable; `parked`
        // counts as reached: durable, just not confirmable from here.
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
        if (r.parked) { session._specUnconfirmed = null; return; }
        // The arm rides the write, so a redelivery queued and never written arms no timer; re-arm here (a later
        // write's arm replaces this timer and carries `retried`).
        if (!session._specConfirmTimer) this._armSpecConfirmTimer(session);
        return;
      }

      session._specUnconfirmed = null;
      log.error('intent', `${what} still unconfirmed on ${session.name} after a redelivery — escalating`);
      const evidence = isRedirect
        ? `${session.name} never saw the ${u.label || 'rejection'}: it was written twice and the seat started no turn `
          + `(no activity for ${Math.round((Date.now() - u.at) / 1000)}s). It is not stalled on the work — it was never told.`
        : `${session.name} was written to twice and never started a turn (no activity for ${Math.round((Date.now() - u.at) / 1000)}s after dispatch)`;
      this._escalateTicket(team, u.ticketId, step, evidence,
        `the ${isRedirect ? 'rejection' : 'spec'} was injected once and redelivered once after the confirmation window`);
    },

    // Same return shape and arm-first onWrite as _deliverTicketSpec, which _checkSpecConfirm's retry arm reads;
    // the seat is not re-resolved because the caller already settled it.
    _deliverRedirectReplay(team, ticket, seatName, u, onWrite = null) {
      const text = this._redirectDeliveryText(ticket.id, u.label, u.reason, true);
      const r = this._gatedDeliver(seatName, u.from || 'clodex-team', text, true,
        `[ticket ${ticket.id} ${u.label} REDELIVERY] close with ${ticketCloseVerb(ticket.id)}`,
        // Same finally as _deliverTicketSpec: an arm that throws must not leave the caller's in-flight flag set.
        (disposition, why) => {
          try {
            this._armSpecConfirm(seatName, ticket.id, disposition,
              { label: u.label, reason: u.reason, from: u.from, ...(u.carried && disposition === 'injected' ? { carried: true } : {}) }, why);
          } catch (e) { log.error('intent', `redirect latch arm failed for ${seatName} on ${ticket.id}: ${e.message}`); }
          finally { if (onWrite) { try { onWrite(disposition); } catch {} } }
        });
      if (!r || r.error) return { undelivered: true };
      if (r.parked) return { parked: r.parked, reason: r.reason || null };
      if (r.held) return { held: true, reason: r.held };
      return { queued: true };
    },

    _recordUndeliveredDispatch(team, tickets, ticket, d) {
      if (!d || !d.undelivered) return;
      ticket.undeliveredAt = Date.now();
      recordEvent(ticket, { at: ticket.undeliveredAt, kind: 'undelivered', by: 'ticket-loop' });
      ticketsStore.save(team.root, tickets);
    },

    _ticketDeliverySuffix(d, assignee, team = null, ticket = null) {
      if (d.undelivered) {
        const role = team && team.roles
          && Object.prototype.hasOwnProperty.call(team.roles, assignee) ? team.roles[assignee] : null;
        if (role) {
          const tmpl = typeof role.template === 'string' && role.template ? role.template : '<tmpl>';
          const id = (ticket && ticket.id) || '<id>';
          return ` — NOTE: no live seat for "${assignee}" yet; spec not delivered.`
            + ` A seat takes role ${assignee} by NAME: [agent:spawn name:${team.name}-${assignee} template:${tmpl}];`
            + ` or [agent:task assign ${id} <seat>] sends it to a seat by name`;
        }
        return ` — NOTE: no live seat for "${assignee}" yet; spec not delivered (reassign or wait for it to spawn)`;
      }
      if (d.held) return ` — NOTE: spec NOT delivered (${d.reason || 'held'}); the seat cannot be parked for, so it has not seen the spec — re-send when it clears`;
      if (d.parked) return ` — NOTE: spec parked, not injected (${d.reason || 'held'}); it drains on the seat's next turn`;
      return '';
    },

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

    _advanceSeat(team, seatName, closed, delivery = null) {
      if (team && team.solo) return null;
      if (!ticketStarted(closed)) return null;
      const queue = this._openTicketsFor(team, seatName, closed && closed.id);
      const next = queue.find((t) => this._ticketAssigneeSeat(team, t) === seatName);
      if (!next) return null;
      if (next !== queue[0]) {
        log.info('intent', `advance for ${seatName} skipped ${queue.indexOf(next)} ticket(s) ahead of ${next.id}: they resolve to another seat`);
      }
      // Reloaded from the store: the array `_openTicketsFor` built is filtered, not the array on disk.
      if (this._repinTicketToSeat(team, next)) {
        try {
          const all = ticketsStore.load(team.root);
          const t = all.find((x) => x.id === next.id);
          if (t) { t.role = next.role; t.assignee = next.assignee; ticketsStore.save(team.root, all); }
        } catch { /* best-effort: the pin is a measurement, never a reason the hand-off fails */ }
      }
      // REPLAY-marked: every ticket reachable here was already dispatched once via `start` or `assign`, and
      // unmarked the seat compacts and starts clean over work in flight.
      const d = this._deliverTicketSpec(team, next, next.spec, 'clodex-team', true /* urgent */, true /* replay */);
      if (delivery) delivery.d = d || {};
      log.info('intent', `seat ${seatName} advanced to ${next.id} after closing ${closed && closed.id}`);
      return next;
    },

    _stampSpecDelivered(team, ticketId, session, { repin } = {}) {
      if (!session) return;
      const tickets = ticketsStore.load(team.root);
      const rec = tickets.find((x) => x.id === ticketId);
      if (!rec) return;
      // Re-checked at write time, up to 5 minutes after the decision to deliver: a wrong stamp suppresses the
      // replay for a seat that no longer holds the ticket, while a dropped one costs one REPLAY re-send.
      if (this._ticketAssigneeSeat(team, rec) !== session.name) {
        log.info('intent', `replay stamp for ${ticketId} dropped at ${session.name}: the ticket now resolves elsewhere`);
        return;
      }
      rec.deliveredTo = { seat: session.name, incarnation: session.incarnation, at: Date.now() };
      // Replay is a hand-off too, so it re-pins and rides this save; the minted-seat dispatch passes
      // `repin: false` because its ticket was pinned before the spawn's save.
      if (repin) this._repinTicketToSeat(team, rec);
      ticketsStore.save(team.root, tickets);
      log.info('intent', repin
        ? `replayed ${ticketId} to ${session.name} (respawn)`
        : `stamped ${ticketId} delivered to ${session.name} (spawn)`);
    },

    // Returns whether the pass is finished; false means only that a candidate was held, so the caller keeps
    // its one-shot armed.
    _replayOpenTickets(session) {
      if (!session || !session.agentType || session._dead) return true;
      let team; try { team = resolveTeam(session.cwd) || this._soloContext(session); } catch { return true; }
      if (!team) return true;
      const open = this._openTicketsFor(team, session.name);
      if (!open.length) return true;
      let held = false;
      for (const t of open) {
        const board = this._soloOpenerTeam(team, t);
        const d = t.deliveredTo;
        if (d && d.seat === session.name && d.incarnation === session.incarnation) continue;
        // `_openTicketsFor` matches a role ticket to every seat filling it, but delivery resolves to the first live
        // one: without this, two seats send seat #1 the spec twice and stamp seat #2.
        if (this._ticketAssigneeSeat(board, t) !== session.name) continue;
        if (!t.spec) continue;   // hand-edited record — delivering it injects literal "undefined"
        const stamp = () => this._stampSpecDelivered(board, t.id, session, { repin: true });
        const r = this._deliverTicketSpec(board, t, t.spec, 'clodex-team', true, true, false, stamp);
        // Only `held` is retried: it is a property of the seat now, while `self` and `undelivered` are structural
        // and would repeat.
        if (r && r.held) held = true;
        if (!r || !(r.queued || r.parked)) continue;
        return true;
      }
      return !held;
    },

    // Re-checks rather than delivering while the paste latch is missing: a write inside the boot re-render
    // window is stamped delivered but lost; only the deadline forces delivery.
    _armReplayFallback(session, periodMs, deadline) {
      session._replayFallbackTimer = setTimeout(() => {
        session._replayFallbackTimer = null;
        if (session._dead || !session._replayTicketsPending) return;
        if (session._bootDrainTimer || session._bootReplayTimer) return;
        if (!session._bootReadySeen && Date.now() < deadline) {
          this._armReplayFallback(session, periodMs, deadline);
          return;
        }
        this._replayTicketsOnce(session);
      }, periodMs);
    },

    // A `held` verdict delivers and stamps nothing, so it must not consume the flag: the other claude edge is
    // still to come.
    _replayTicketsOnce(session) {
      if (!session || !session._replayTicketsPending || session._dead) return;
      let done = false;
      try { done = this._replayOpenTickets(session); }
      catch (e) { log.error('inject', `ticket replay failed for ${session.name}: ${e.message}`); done = true; }
      if (done) session._replayTicketsPending = false;
    },

    // Only a role-addressed ticket qualifies for a one-shot mode: a seat-addressed one names a session whose cwd is fixed at spawn,
    // so it can be neither moved into a worktree nor made one-shot.
    _ticketDispatchMode(team, assignee) {
      const standing = { mode: 'standing', def: null };
      if (!team || !assignee || !team.roles) return standing;
      if (!Object.prototype.hasOwnProperty.call(team.roles, assignee)) return standing;
      const def = team.roles[assignee];
      if (!def) return standing;
      if (def.dispatch !== 'spawn' && def.dispatch !== 'worktree') return standing;
      // team.json is hand-editable and can predate the manifest's write-time refusal, so the resolver repeats it.
      if (assignee === 'lead' || assignee === 'reviewer') return standing;
      return { mode: def.dispatch, def };
    },

    // The name is `<team>-<role>-<n>` so matchSeatRole, which strips a trailing `[-_]?\d+`, still resolves the seat to its role.
    _mintTicketSeat(team, roleKey, ticket) {
      const n = String(ticket.id).replace(/^t/, '');
      const name = `${team.name}-${roleKey}-${n}`;
      if (!AGENT_NAME_RE.test(name)) return { ok: false, error: `seat name "${name}" is not name-legal` };
      // `name` rides the refusal so callers need not re-derive it; a second copy of the rule would drift.
      if (this.sessions.has(name) || getPersistence().get(name)) return { ok: false, taken: true, name, error: `seat name "${name}" is taken` };
      // Slug from the untruncated first line, not the 80-char-capped title: behind a ~67-char task-dir path
      // the title leaves ~13 characters and sibling tickets get identical branch names.
      const slug = branchSlug(ticket.spec == null ? ticket.title : titleLine(ticket.spec));
      // A recorded branch wins: a re-derived name forks a second branch off HEAD and strands the previous seat's commits,
      // including when a locked tree makes createWorktree refuse, which is the wanted outcome.
      const recorded = ticket.worktree && ticket.worktree.branch;
      return { ok: true, name, branch: recorded || (slug ? `${ticket.id}-${slug}` : String(ticket.id)) };
    },

    // The two dispositions are opposites: a worktree seat's uncommitted work goes with the delete, a spawn seat's work in the shared
    // checkout survives it; a ticket with no `worktree` pointer is the spawn case.
    _ticketDeleteCost(ticket) {
      const p = ticket && ticket.worktree && ticket.worktree.path;
      return p
        ? `that also deletes its worktree, so anything the seat left UNCOMMITTED in ${p} is lost (committed work survives on the branch).`
        : `it had no worktree of its own, so nothing on disk is removed — anything it left in the shared checkout survives.`;
    },

    // Dispatch-time half of verify's task-dir check, run before any seat or worktree is minted; only a MISSING taskDir moves here.
    // Not in `_deliverTicketSpec`, whose funnel also carries the replays a respawned seat depends on.
    _ticketTaskDirRefusal(team, ticket, verb, reSend) {
      if (ticket.taskDir) return null;
      // Solo boards mint no worktree and get no loop step, so they never reach the verify-time refusal this gate avoids.
      if (team && team.solo) return null;
      // A re-send is the redelivery a respawned seat recovers through and stays ungated; assign must not derive it from
      // `ticketStarted`, since a legacy record reads started while owning no seat or tree.
      if (reSend) return null;
      return `ticket ${ticket.id} has no task dir, so nothing was ${verb === 'start' ? 'started' : 'assigned'} — its spec names no \`tasks/…\` path on any line, `
        + `and the review step has nowhere to write its diff. Nothing was changed. `
        + `Fix: re-file it with the artifact dir on the spec's first line, or \`[agent:task respec ${ticket.id}]\` <the corrected spec> to replace it in place.`;
    },

    // Read off the persisted record, not the session's cwd: a role area sits below the tree root and a seat
    // whose tree went missing resumes in the shared checkout.
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

    // Read from git, not the record alone: the record survives the tree, so a recorded path proves nothing about the disk.
    async _existingTicketTree(team, ticket) {
      const wt = ticket && ticket.worktree;
      if (!wt || !wt.path || !wt.branch) return null;
      let listed;
      try { listed = await gitWorktree.listWorktrees(team.root); } catch { return null; }
      if (!listed || !listed.ok) return null;
      // git prints realpath'd paths while the record keeps /tmp as created (/private/tmp on macOS); compare canonically
      // or the match fails and every reuse mints a second tree.
      const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
      const want = real(wt.path);
      // `prunable` is why this reads the listing: a tree deleted by hand stays registered and listed, so path and branch
      // alone would hand the seat a dead `WORK IN:` path.
      const hit = listed.worktrees.find((e) => e.path && !e.isMain && !e.prunable && !e.locked
        && e.branch === wt.branch && real(e.path) === want);
      if (!hit) return null;
      // git emits `prunable` only from 2.36, so on older git the flag never arrives; the existence check is additional,
      // not a replacement, since existence alone races and misses a directory holding no worktree.
      try { if (!fs.existsSync(path.join(hit.path, '.git'))) return null; } catch { return null; }
      // Reuse bypasses git's refusal to check one branch out twice, so the holder is looked for here: two agents in one
      // checkout committing onto one branch is the collision the mechanism exists to prevent.
      if (this._ticketTreeHolder(wt.path)) return null;
      // baseSha was captured at mint and is unrecoverable, so dropping it on reuse downgrades the close-time commit count
      // to its merge-base fallback.
      return { path: wt.path, branch: wt.branch, ...(wt.baseSha ? { baseSha: wt.baseSha } : {}) };
    },

    // A template is agent-writable: privileged intents are stripped and env is confined to REVIEWER_ENV_ALLOWLIST,
    // and only an operator's local GUI create or edit may grant those.
    _templateShape(tplName, team) {
      if (!tplName) return null;
      let tpl = null;
      const own = readTeamJson({ fs, path }, team, 'templates', tplName);
      if (own) tpl = { ...own, name: tplName, id: tplName };
      else {
        try { tpl = allTemplates().find((t) => t && t.name === tplName) || null; }
        catch { tpl = null; }
      }
      if (!tpl) return null;
      const { sessionEnv, dropped, badType } = filterTemplateEnv(tpl.env);
      return {
        tpl,
        extraArgs: (Array.isArray(tpl.extraArgs) && tpl.extraArgs.length) ? tpl.extraArgs : null,
        effort: (typeof tpl.effort === 'string' && tpl.effort) ? tpl.effort : null,
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
        io: tpl.io === 'stream' ? 'stream' : 'pty',
        // Not `|| []`: absent means every shipped bundle, `[]` means none.
        plugins: Array.isArray(tpl.plugins) ? tpl.plugins.map(String) : null,
      };
    },

    _teamRoleEfforts(team) {
      const out = {};
      const roles = (team && team.roles && typeof team.roles === 'object') ? team.roles : {};
      for (const [role, def] of Object.entries(roles)) {
        const stem = (def && typeof def.template === 'string' && def.template)
          ? def.template : (role === 'reviewer' ? DEFAULT_REVIEWER_TEMPLATE : null);
        if (!stem) continue;
        let shape = null;
        try { shape = this._templateShape(stem, team); } catch { shape = null; }
        if (shape && shape.effort) out[role] = shape.effort;
      }
      return out;
    },

    // Lexical and root-free because _resolveRoleCwd (joins onto team.root) and the AREA line (joins onto the worktree) resolve against
    // different bases; one shared verdict keeps the AREA line from accepting `cwd: "/etc"` that the resolver refuses.
    _roleCwdRel(def) {
      const raw = def && typeof def.cwd === 'string' ? def.cwd.trim() : '';
      if (!raw) return { rel: '', raw: '', reason: null };
      if (path.isAbsolute(raw)) return { rel: '', raw, reason: 'absolute' };
      // Normalized before the leading-`..` test: `api/../../elsewhere` does not start with `..` but collapses to one.
      const norm = path.normalize(raw);
      if (norm === '..' || norm.startsWith(`..${path.sep}`)) return { rel: '', raw, reason: 'escape' };
      // "." is the team root: treated as absent, or the AREA line would repeat the tree root the WORK IN: line already names.
      if (norm === '.') return { rel: '', raw, reason: null };
      return { rel: norm, raw, reason: null };
    },

    _resolveRoleCwd(team, def) {
      const root = team && team.root;
      // Re-checked at spawn: team.json is hand-editable and may predate the write gate.
      const { rel, raw, reason } = this._roleCwdRel(def);
      if (!root) return { cwd: root, fallback: null };
      if (reason === 'absolute') {
        return { cwd: root, fallback: `role cwd "${raw}" is absolute (it must be relative to the team root) — the seat was spawned at the root of its checkout instead` };
      }
      if (reason === 'escape') {
        return { cwd: root, fallback: `role cwd "${raw}" resolves outside the team root — the seat was spawned at the root of its checkout instead` };
      }
      if (!rel) return { cwd: root, fallback: null };
      const resolved = path.resolve(root, rel);
      let isDir = false;
      try { isDir = fs.statSync(resolved).isDirectory(); } catch { isDir = false; }
      if (!isDir) {
        return { cwd: root, fallback: `role cwd "${rel}" does not exist under the team root (Clodex never creates it) — the seat was spawned at the root of its checkout instead` };
      }
      // Confined on the real paths of both sides: a `link` to another project passes the lexical check, and a root under /tmp is itself a symlink on macOS.
      const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
      const realRoot = real(root);
      const realCwd = real(resolved);
      if (!realRoot || !realCwd) {
        return { cwd: root, fallback: `role cwd "${rel}" does not exist under the team root (Clodex never creates it) — the seat was spawned at the root of its checkout instead` };
      }
      const within = path.relative(realRoot, realCwd);
      if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) {
        return { cwd: root, fallback: `role cwd "${rel}" resolves outside the team root (it is a symlink to ${realCwd}) — the seat was spawned at the root of its checkout instead` };
      }
      // Compared by root, not name: only a hand-edit gives two manifests one root, while a nested team.json is a different root.
      let owner = null;
      try { owner = resolveTeam(resolved); } catch { owner = null; }
      if (owner && path.resolve(owner.root) !== path.resolve(root)) {
        return { cwd: root, fallback: `role cwd "${rel}" belongs to team "${owner.name}" (its own team.json at ${owner.root} owns that directory), so a seat there would join THAT team's board — the seat was spawned at the root of its checkout instead` };
      }
      return { cwd: resolved, fallback: null };
    },

    _resolveRoleAccount(label) {
      return resolveAccount(label);
    },

    _teamRolePromptStem(team, roleKey, templateOverride) {
      const def = (team && team.roles && team.roles[roleKey]) || null;
      const seededTpl = !!(def && def.template && def.template === roleKey);
      const explicitTpl = !!(templateOverride || (def && def.template && !seededTpl));
      const ownRolePrompt = (def && typeof def.prompt === 'string' && def.prompt)
        ? teamPromptFile({ fs, path }, team, 'system', def.prompt)
        : null;
      return (ownRolePrompt && !explicitTpl) ? def.prompt : null;
    },

    // One shape for both spawn paths: a second copy of the env allowlist filter can be edited without the other.
    // `opener` cannot be derived from (team, roleKey): workspaceId and permission posture are inherited from it.
    resolveSeatShape(team, roleKey, purpose, opener, templateOverride = null) {
      if (purpose !== 'ticket' && purpose !== 'review') {
        throw new Error(`resolveSeatShape: unknown purpose "${purpose}" (expected 'ticket' or 'review')`);
      }
      const def = (team && team.roles && team.roles[roleKey]) || null;
      const review = purpose === 'review';
      const shape = this._templateShape(
        review
          ? (templateOverride || (def && def.template) || DEFAULT_REVIEWER_TEMPLATE)
          : (def && def.template),
        team,
      );
      const tpl = (shape && shape.tpl) || null;
      const type = review ? seatType(tpl, null) : seatType(tpl, opener);
      const openerAdapter = adapterFor(opener.type) || adapterFor(DEFAULT_TYPE);
      const seatAdapter = adapterFor(type);
      const cap = review ? seatAdapter.readOnlyCap : null;
      if (review && !cap) {
        throw new Error(`reviewer template "${(tpl && tpl.name) || DEFAULT_REVIEWER_TEMPLATE}" is type "${type}", which cannot be capped read-only in this build`);
      }
      const capKind = cap ? cap.enforce : null;
      const capMode = (capKind !== null && Object.prototype.hasOwnProperty.call(REVIEWER_CAP_MODES, capKind))
        ? REVIEWER_CAP_MODES[capKind] : null;
      if (review && !capMode) {
        throw new Error(`reviewer template "${(tpl && tpl.name) || DEFAULT_REVIEWER_TEMPLATE}" is type "${type}", whose read-only cap "${capKind}" cannot be enforced in this build`);
      }
      const capArgs = !!capMode && capMode.argv;
      const leadArgs = (getPersistence().get(opener.name)?.extraArgs) || [];
      const postureArgs = hasBypass(openerAdapter, leadArgs) ? [...seatAdapter.posture.bypassArgs] : [];
      const workspaceId = opener.workspaceId || DEFAULT_WORKSPACE_ID;
      const roleCwd = this._resolveRoleCwd(team, def);
      const accountLabel = (def && typeof def.account === 'string' && def.account) ? def.account : null;
      const acct = !accountLabel ? { ok: true, configDir: null }
        : (seatAdapter.account.bootstrap ? { ok: false, label: accountLabel, reason: 'platform' } : resolveAccount(accountLabel));
      const accountDir = acct.ok ? (acct.configDir || null) : null;
      const accountMissing = acct.ok ? null : { label: acct.label, reason: acct.reason };
      const withAccount = (env) => {
        if (!accountDir) return env;
        return { ...(env || {}), [seatAdapter.account.envKey]: accountDir };
      };

      if (!review) {
        return {
          type,
          // Resolved against the MAIN checkout on purpose: _resolveRoleCwd stats the directory and checks nested-team ownership,
          // neither answerable for a tree not yet minted; a worktree dispatch re-roots it at the spawn site.
          cwd: roleCwd.cwd,
          // Carried on the shape, not re-resolved at call sites, where it could disagree with the directory actually used.
          cwdFallback: roleCwd.fallback,
          tpl,
          extraArgs: (shape && shape.extraArgs) || postureArgs,
          effort: (shape && shape.effort) || null,
          agents: (shape && shape.agents) || [],
          denyBuiltins: (shape && shape.denyBuiltins) || [],
          disabledTools: (shape && shape.disabledTools) || [],
          disabledSkills: (shape && shape.disabledSkills) || [],
          injectSkills: (shape && shape.injectSkills) || [],
          effectiveTools: null,
          shellDeny: null,
          // null even when the template carries `tools`: off the review path nothing is asked of the cap, and reporting a request would invite callers to act on it.
          requestedTools: null,
          toolsMalformed: false,
          modelRefused: null,
          systemPromptFile: this._teamRolePromptStem(team, roleKey, null)
            || (shape && shape.systemPromptFile) || (def && def.prompt) || null,
          appendPromptFiles: (shape && shape.appendPromptFiles) || [],
          execCommands: (shape && shape.execCommands) || [],
          // `[]` (everything gated) must apply; null keeps the all-enabled default.
          intents: shape ? shape.intents : null,
          plugins: shape ? shape.plugins : null,
          io: (shape && shape.io) || 'pty',
          env: withAccount((shape && shape.sessionEnv) || null),
          account: accountLabel,
          accountMissing,
          envDropped: (shape && shape.envDropped) || [],
          envBadType: (shape && shape.envBadType) || [],
          beyondCap: [],
          capNote: null,
          toolsIgnored: false,
          promptEscaped: null,
          workspaceId,
          ephemeral: true,
        };
      }

      // Only the reviewer template may narrow the cap; a role def's `tools` is inert and must not read as a second source.
      // Only an absent `tools` takes the full cap; `null` is refused with the other non-arrays.
      const rawTools = tpl ? tpl.tools : undefined;
      const toolsMalformed = rawTools !== undefined && !Array.isArray(rawTools);
      const requestedTools = Array.isArray(rawTools) ? rawTools : null;
      const wantsShell = !toolsMalformed && !!requestedTools && requestedTools.includes(REVIEWER_SHELL_TOOL);
      // Fail-closed on malformed, so the shape alone cannot spawn a widened seat even if a caller forgets the refusal.
      const cappedTools = toolsMalformed
        ? []
        : (requestedTools
          ? REVIEWER_TOOL_CAP.filter((t) => requestedTools.includes(t))
          : REVIEWER_TOOL_CAP.slice());
      const effectiveTools = wantsShell
        ? [...REVIEWER_TOOL_CAP, REVIEWER_SHELL_TOOL]
        : cappedTools;
      const beyondCap = requestedTools
        ? requestedTools.filter((t) => !REVIEWER_TOOL_CAP.includes(t)
          && !(wantsShell && t === REVIEWER_SHELL_TOOL))
        : [];

      // Presence test on the raw template env: a template whose keys were all dropped filters to the same empty result as one
      // with no env, but the first asked for an env and must not get the default.
      const tplSuppliedEnv = !!(tpl && tpl.env && typeof tpl.env === 'object' && !Array.isArray(tpl.env));

      const modelArgs = reviewerModelArgs(shape && shape.extraArgs, seatAdapter);

      let systemPromptFile = this._teamRolePromptStem(team, roleKey, templateOverride)
        || ((tpl && typeof tpl.systemPromptFile === 'string' && tpl.systemPromptFile)
          ? tpl.systemPromptFile
          : ((def && def.prompt) || REVIEWER_FALLBACK.systemPromptFile));
      // A traversing stem from the agent-writable template is rejected here (resolvePromptFile's fallback is a bare path.join) and rides back on `promptEscaped`.
      let promptEscaped = null;
      if (systemPromptFile.includes('/') || systemPromptFile.includes('\\') || systemPromptFile.includes('..')) {
        promptEscaped = systemPromptFile;
        systemPromptFile = REVIEWER_FALLBACK.systemPromptFile;
      }

      return {
        type,
        // Honored on this arm too; the reviewer stays agent-unwritable via RESERVED_ROLE_KEYS, so only the operator's GUI can set its cwd.
        cwd: roleCwd.cwd,
        cwdFallback: roleCwd.fallback,
        tpl,
        // reviewerModelArgs is an allowlist of one flag: a reviewer template's extraArgs are deliberately dropped,
        // and mirroring the ticket arm here reverts that.
        extraArgs: capArgs ? [...modelArgs.args, ...cap.args] : [...postureArgs, ...modelArgs.args],
        shellDeny: (!capArgs && wantsShell) ? REVIEWER_SHELL_DENY.slice() : null,
        // Carried, not re-derived at the call site, where re-parsing would put a second copy of the allowlist.
        modelRefused: modelArgs.refused,
        effort: (shape && shape.effort) || null,
        agents: [],
        denyBuiltins: [],
        disabledTools: capArgs ? [] : CLAUDE_TOOLS.filter((t) => !effectiveTools.includes(t)),
        disabledSkills: (tpl && Array.isArray(tpl.disabledSkills)) ? tpl.disabledSkills.slice() : ['*'],
        injectSkills: [],
        // Carried, not recomputed from disabledTools: the warning prints REVIEWER_TOOL_CAP order and inverting the denylist would print CLAUDE_TOOLS order.
        effectiveTools: capArgs ? [] : effectiveTools,
        // Carried so the refusal prints the exact list asked for, without borrowing beyondCap, which means what the template overreached for.
        requestedTools: capArgs ? null : requestedTools,
        // A separate key: requestedTools null also means absent, and the caller must refuse one and not the other.
        toolsMalformed: capArgs ? false : toolsMalformed,
        systemPromptFile,
        appendPromptFiles: [],
        execCommands: [],
        // `[]`, not null: the reviewer's fallback gates every intent, where null would leave create() all-enabled.
        intents: (shape && Array.isArray(shape.intents)) ? shape.intents : [],
        plugins: shape ? shape.plugins : null,
        io: (shape && shape.io) || 'pty',
        // An object always; the fallback applies when the template supplied no env object, else the reviewer boots without CLODEX_DISABLE_IPC_PROMPT.
        // REVIEWER_FALLBACK.env skips the allowlist pass: it is the shipped set and is not agent-writable.
        env: withAccount(tplSuppliedEnv ? { ...((shape && shape.sessionEnv) || {}) } : { ...REVIEWER_FALLBACK.env }),
        account: accountLabel,
        accountMissing,
        envDropped: (shape && shape.envDropped) || [],
        envBadType: (shape && shape.envBadType) || [],
        beyondCap: capArgs ? [] : beyondCap,
        capNote: capMode ? capMode.note : null,
        toolsIgnored: capArgs && rawTools !== undefined,
        promptEscaped,
        workspaceId,
        ephemeral: true,
      };
    },

    // These are persistence writes that must land after create() mints the entry, since setStripLevel on a missing entry is a silent no-op.
    // Takes the template, not a shape: one caller has none, and a synthetic `{ tpl }` there goes inert once this reads another shape field.
    _applyTemplatePersistence(name, tpl) {
      if (!tpl) return;
      if (tpl.stripLevel === 1 || tpl.stripLevel === 2) getPersistence().setStripLevel(name, tpl.stripLevel);
      if (tpl.autoCompact === false) getPersistence().setAutoCompact(name, false);
      if (Array.isArray(tpl.plugins)) getPersistence().setPlugins(name, tpl.plugins);
    },

    // `mode` defaults to 'worktree', never 'spawn', so a path that never asked for one cannot put a seat in the operator's checkout.
    // `fromBacklog` defaults false because `_taskStart` refuses backlog tickets, so nothing it dispatches was backlog.
    _spawnTicketSeat(opener, team, ticket, roleKey, seat, mode = 'worktree', fromBacklog = false, prelude = '') {
      const isSpawn = mode === 'spawn';
      const reply = (msg) => this._injectText(opener, `[agent:task] ${msg}`, { parkable: true });
      const ack = (msg) => this._taskAck(opener, `[agent:task] ${msg}`);
      // The wire label must be on the record before the deferred create() reads it back to mint the proxy id.
      const seatLabel = teamCost.wireLabelFor({
        team: team.name, ticketId: ticket.id, role: roleKey,
      });
      getPersistence().upsert({
        name: seat.name, ephemeral: true,
        wireLabel: seatLabel || null,
        ticketId: ticket.id,
      });
      // Reloaded from the store, not the caller's array, which may no longer be what is on disk.
      const unpin = () => {
        try {
          const all = ticketsStore.load(team.root);
          const t = all.find((x) => x.id === ticket.id);
          if (!t) return;
          t.assignee = roleKey;
          delete t.role;
          // The dispatch is rolled back, so its stamp goes too or `start` refuses the ticket forever; memory follows disk because the catch reads the in-memory copy.
          t.startedAt = null;
          ticket.startedAt = null;
          ticketsStore.save(team.root, all);
        } catch { /* best-effort — the reply below is the operator-visible half */ }
      };
      const clearTicketTree = () => {
        try {
          const all = ticketsStore.load(team.root);
          const t = all.find((x) => x.id === ticket.id);
          // Memory follows disk even on the early return: the catch's un-pin reads `ticket.worktree` in memory, and a save that threw earlier would leave the two disagreeing.
          if (!t || !t.worktree) { delete ticket.worktree; return; }
          delete t.worktree;
          ticketsStore.save(team.root, all);
          delete ticket.worktree;
        } catch { /* best-effort */ }
      };
      const claimTree = (w) => {
        if (!w || !w.path) return;
        try {
          // A spread, not a mutation of `w`: that object is also written onto the ticket record, where `main` has no reader.
          getPersistence().setWorktree(seat.name, { ...w, ...(team.root ? { main: team.root } : {}) });
          // Compared canonically: a record from another route can name the same tree through a symlinked prefix (/tmp vs /private/tmp).
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
        // A reused tree carries the only commits that survived the previous seat, so only a tree this spawn created is rolled back.
        let reused = false;
        let linkWarn = '';
        try {
          const existing = isSpawn ? null : await this._existingTicketTree(team, ticket);
          // A spawn dispatch clears a tree already on the record (worktree role first, re-assigned to spawn after that seat died): left in place
          // it outvotes the mode in readers such as `loopEligible` and _taskAccept's destroy arm.
          if (isSpawn) { clearTicketTree(); }
          else if (existing) { wt = existing; reused = true; }
          else {
            // Fork from HEAD, not the default branch: a ticket is written against the lead's tree, which may have unpushed commits,
            // and merging a fork of origin/HEAD back would revert them.
            const r = await gitWorktree.createWorktree(team.root, seat.branch, { base: 'HEAD' });
            if (!r || !r.ok) {
              getPersistence().remove(seat.name);
              // Un-pin only when the ticket names no tree: with one, a role-assigned ticket's live WORK IN: pointer is replayed into every seat filling the role.
              const pinned = !!(ticket.worktree && ticket.worktree.path);
              if (!pinned) unpin();
              reply(pinned
                ? `ticket ${ticket.id}: worktree "${seat.branch}" could not be created (${(r && r.error) || 'unknown'}) — no seat spawned; the ticket stays pinned to "${ticket.assignee || roleKey}" and still names its tree ${ticket.worktree.path}; re-assign it to retry`
                : `ticket ${ticket.id}: worktree "${seat.branch}" could not be created (${(r && r.error) || 'unknown'}) — no seat spawned, ticket left assigned to "${roleKey}"`);
              return;
            }
            // createWorktree returns no baseSha for a branch that already exists and `rec.worktree = wt` overwrites wholesale, so the prior fork point is carried
            // (only when the branch matches) or `loopEligible` silently goes false; the HEAD it forked from has moved by close time.
            const prior = (ticket.worktree && ticket.worktree.branch === r.branch)
              ? ticket.worktree.baseSha : null;
            const keep = r.baseSha || prior || null;
            wt = { path: r.path, branch: r.branch, ...(keep ? { baseSha: keep } : {}) };
          }
          // Skipped for a spawn seat rather than writing `worktree: null`: absent is what every reader tests for, and a stored null is a second spelling of it.
          if (!isSpawn) {
            try {
              const all = ticketsStore.load(team.root);
              const rec = all.find((x) => x.id === ticket.id);
              if (rec) { rec.worktree = wt; ticketsStore.save(team.root, all); }
              ticket.worktree = wt;
            } catch { /* best-effort — the spec below still carries it from `ticket` */ }
          }
          // Warns, never aborts: a dep-less tree can still read and commit. Gated on package.json because the
          // `npm install` advice is false for a non-node root.
          if (!isSpawn && wt && wt.path && fs.existsSync(path.join(team.root, 'package.json'))) {
            const e = this._linkWorktreeNodeModules(team.root, wt.path);
            if (e) linkWarn = ` — NOTE: ${e}; the seat starts without dependencies (require() and npm run build:web will fail there until the root has a node_modules)`;
          }
          const shape = this.resolveSeatShape(team, roleKey, 'ticket', opener);
          if (shape.accountMissing) {
            throw new Error(accountMissingError(roleKey, shape.accountMissing));
          }
          // Not inside resolveSeatShape: the tree is minted after the shape is built, and the review path shares that resolver with no tree.
          const seatCwd = seatCwdInTree(team.root, shape.cwd, wt && wt.path);
          let cwdDirWarn = '';
          const cwdDir = adapterFor(shape.type).cwdDir;
          if (cwdDir && wt && wt.path) {
            const e = ignoreCwdDir(fs, seatCwd, cwdDir);
            if (e) cwdDirWarn = ` — NOTE: ${e}`;
          }
          const spawned = await this.create(
            seat.name, shape.type, seatCwd,
            shape.extraArgs, null,
            shape.workspaceId, null, false, opener.proxy ?? null,
            shape.agents, shape.denyBuiltins,
            shape.disabledTools, shape.disabledSkills,
            shape.injectSkills,
            shape.systemPromptFile,
            shape.appendPromptFiles,
            shape.execCommands,
            shape.intents,
            // The `false` is noWire, a literal and never `shape.noWire`: an agent-writable template could blind the wire that measures this seat's cost;
            // it also cannot be dropped, since the plugin list after it is positional.
            { ...shape.env, CLODEX_TICKET: ticket.id }, true,
            false, shape.plugins, null, null, shape.io || 'pty', shape.effort || null,
          );
          // First, before anything that can throw: until claimed the seat lives in a tree no record names, so _ticketTreeHolder is blind
          // to it and session:kill orphans the checkout.
          claimTree(wt);
          this._applyTemplatePersistence(seat.name, shape.tpl);
          this._sendToSession(seat.name, 'session:context-action', {
            // The cwd create() actually got: it feeds the sidebar row's dataset.cwd, and after a restart the row is rebuilt from the persistence record, which is this path.
            action: 'reattach', name: seat.name, type: (this.sessions.get(seat.name) || {}).agentType || null,
            cwd: seatCwd, backend: (this.sessions.get(seat.name) || {}).backend || null,
            noWire: !!(this.sessions.get(seat.name) || {}).noWire,
            io: (this.sessions.get(seat.name) || {}).io || 'pty',
            background: true,
          });
          const d = this._deliverTicketSpec(team, ticket, ticket.spec, 'clodex-team', true, false, false,
            () => this._stampSpecDelivered(team, ticket.id, this.sessions.get(seat.name), { repin: false }), fromBacklog, prelude);
          this._broadcast('ipc-message', {
            type: 'task', from: opener.name, to: seat.name, body: `ticket ${ticket.id} → ${seat.name} @ ${wt ? wt.path : shape.cwd}`,
          });
          log.info('intent', isSpawn
            ? `ticket ${ticket.id} spawned ${seat.name} (${roleKey}) in the shared checkout @ ${shape.cwd}`
            : `ticket ${ticket.id} ${reused ? 'respawned' : 'spawned'} ${seat.name} (${roleKey}) on branch ${wt.branch} @ ${wt.path}`);
          const envWarn = (shape.envDropped.length
            ? ` — template env keys [${shape.envDropped.join(', ')}] are outside the allowed set [${[...REVIEWER_ENV_ALLOWLIST].join(', ')}] — dropped (env is an authority surface; requires operator approval)`
            : '')
            + (shape.envBadType.length
              ? ` — template env keys [${shape.envBadType.join(', ')}] are allowed but their values are not strings — dropped (quote the value in the template)`
              : '');
          const promptWarn = (spawned && spawned.missingPrompt) ? ` — WARNING: ${spawned.missingPrompt}` : '';
          const cwdWarn = shape.cwdFallback ? ` — NOTE: ${shape.cwdFallback}` : '';
          const seatSuffix = this._ticketDeliverySuffix(d, seat.name, team, ticket);
          const seatWarn = isSpawn
            ? `${seatSuffix}${envWarn}${cwdWarn}${promptWarn}`
            : `${seatSuffix}${envWarn}${cwdWarn}${promptWarn}${linkWarn}${cwdDirWarn}`;
          (seatWarn ? reply : ack)(isSpawn
            ? `ticket ${ticket.id} → ${seat.name} in the shared checkout ${shape.cwd} (no branch, no worktree)${seatWarn}`
            : `ticket ${ticket.id} → ${seat.name} on ${reused ? 'its existing tree, branch' : 'branch'} ${wt.branch}${seatWarn}`);
        } catch (err) {
          const live = this.sessions.has(seat.name);
          if (!live) getPersistence().remove(seat.name);
          // create() can seat the session and then throw before claimTree ran; claim in full, not a bare setWorktree,
          // or the reuse path leaves two records on one tree.
          if (live) claimTree(wt);
          // `live` gates the tree removal like the record drop: a seat that exists is sitting in this tree.
          if (wt && !reused && !live) {
            const rm = await gitWorktree.removeWorktree(wt.path).catch(() => ({ ok: false }));
            log.info('worktree', `${rm && rm.ok ? 'removed' : 'ORPHANED'} ${wt.path} after failed ticket spawn of ${seat.name}`);
            clearTicketTree();
          }
          const unpinned = !reused && !live && !(ticket.worktree && ticket.worktree.path);
          if (unpinned) unpin();
          log.error('intent', `ticket ${ticket.id} seat ${seat.name} failed: ${err.message}`);
          // A spawn seat's pin is kept too but it has no tree; naming one would send the lead looking for a checkout that does not exist.
          const keptTree = !!(ticket.worktree && ticket.worktree.path);
          reply(unpinned
            ? `ticket ${ticket.id}: seat ${seat.name} failed to spawn (${err.message}) — ticket left assigned to "${roleKey}"`
            : `ticket ${ticket.id}: seat ${seat.name} failed to spawn (${err.message}) — the ticket stays pinned to "${seat.name}"${keptTree ? ', whose tree is kept' : ' (no worktree — it was working in the shared checkout)'}; re-assign it to retry`);
        }
      });
    },

    _reviewerTemplateNames() {
      try {
        return allTemplates()
          .filter((t) => t && typeof t.systemPromptFile === 'string'
            && t.systemPromptFile.startsWith(REVIEWER_PROMPT_PREFIX))
          .map((t) => t.name).filter(Boolean);
      } catch { return []; }
    },

    _taskAdd(session, team, intent, reply, ack = reply) {
      // Read before the permission check: a non-lead's spec is the longest payload of any ticket verb and this rejection has no re-send to fall back on.
      const spec = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can open a ticket${this._spillRejectedPayload(session, 'task add', spec)}`); return; }
      if (!spec) { reply('error: a ticket needs spec text — [agent:task add [role|name]] <what to do>'); return; }
      if (intent.park && intent.start) {
        reply('error: `park` and `start` are opposite modifiers — park files the ticket held, start dispatches it now; pick one'
          + this._spillRejectedPayload(session, 'task add', spec));
        return;
      }
      let assignee = null;
      if (intent.who) {
        assignee = this._resolveAssignee(team, intent.who);
        if (!assignee) { reply(`error: ${this._assigneeMissText(team, intent.who)}${this._spillRejectedPayload(session, 'task add', spec)}`); return; }
      }
      const reviewerTemplate = intent.reviewer || null;
      if (reviewerTemplate) {
        const known = this._reviewerTemplateNames();
        if (!known.includes(reviewerTemplate)) {
          reply(`error: no template "${reviewerTemplate}" in the library — reviewer templates available: [${known.join(', ')}]${this._spillRejectedPayload(session, 'task add', spec)}`);
          return;
        }
      }
      const tickets = ticketsStore.load(team.root);
      const now = Date.now();
      const title = ticketTitle(spec);
      const twin = intent.dup === true ? null : tickets.find((t) => t.state === 'open' && t.title === title);
      if (twin) {
        reply(`error: an open ticket already carries this title — ${twin.id} (${humanizeAge(now - (twin.openedAt || now))} ago); cancel or respec it, or add \`dup\` to the head line to open a second one deliberately${this._spillRejectedPayload(session, 'task add', spec)}`);
        return;
      }
      // Written only when true: a stored `parked: false` would be a second spelling of the absent state.
      const parked = !!intent.park;
      const ticket = {
        id: nextTicketId(tickets), title, spec,
        assignee, opener: session.name, state: 'open',
        openedAt: now, closedAt: null, lastActivityAt: now, nudgedAt: null,
        // Explicit null, unlike `parked`: `ticketStarted` reads an absent key as a pre-upgrade record that was dispatched,
        // so omitting it would file every new ticket as already started.
        startedAt: null,
        ...(parked ? { parked: true } : {}),
        ...(reviewerTemplate ? { reviewerTemplate } : {}),
      };
      recordEvent(ticket, { at: now, kind: 'add', by: session.name });
      const taskDir = extractTaskDir(spec);
      if (taskDir) ticket.taskDir = taskDir;
      tickets.push(ticket);
      ticketsStore.save(team.root, tickets);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: assignee || '(backlog)', body: `ticket ${ticket.id} opened${parked ? ' (parked)' : ''}` });
      log.info('intent', `task add by ${session.name} → ${ticket.id} (${assignee || 'backlog'}${parked ? ', parked' : ''})`);
      const rvNote = reviewerTemplate ? ` — reviewer template: ${reviewerTemplate}` : '';
      if (parked) {
        ack(`ticket ${ticket.id} parked${assignee ? ` for ${assignee}` : ' (backlog)'} — spec NOT delivered; [agent:task start ${ticket.id}] dispatches it${rvNote}`);
        return;
      }
      if (intent.start) {
        const startMsgs = [];
        let startWarned = false;
        this._taskStart(session, team, { id: ticket.id, reviewer: null },
          (m) => { startWarned = true; startMsgs.push(String(m)); },
          (m) => startMsgs.push(String(m)));
        const after = (ticketsStore.load(team.root) || []).find((t) => t.id === ticket.id);
        const raw = startMsgs.join(' ').trim();
        if (after && ticketStarted(after)) {
          const tail = raw.replace(new RegExp(`^ticket ${ticket.id}\\s*`), '').trim();
          (startWarned ? reply : ack)(`ticket ${ticket.id} created and started ${tail}${rvNote}`);
          return;
        }
        reply(`ticket ${ticket.id} created but NOT started — the ticket exists and is unstarted. Start leg: ${raw || 'no reply'}`);
        return;
      }
      ack((assignee
        ? `ticket ${ticket.id} → ${assignee} (not started) — [agent:task start ${ticket.id}] mints its tree and seat and delivers the spec`
        : `ticket ${ticket.id} (backlog)`) + rvNote);
    },

    // Not a second `assign`: start mints once, and re-sends are assign's job, which the refusals below name.
    _taskStart(session, team, intent, reply, ack = reply) {
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can start a ticket`); return; }
      if (!intent.id) { reply('error: start needs a ticket id — [agent:task start <id>]'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — only an open ticket can be started`); return; }
      if (!ticket.assignee) { reply(`error: ticket ${intent.id} is backlog (no assignee) — [agent:task assign ${intent.id} <role|name>] files AND dispatches it`); return; }
      const noTaskDir = this._ticketTaskDirRefusal(team, ticket, 'start', ticketStarted(ticket));
      if (noTaskDir) { log.info('intent', `task start by ${session.name}: ${ticket.id} refused — no task dir`); reply(noTaskDir); return; }
      const startReviewer = intent.reviewer || null;
      const assignee = ticket.assignee;
      // The role the ticket was filed under mints the seat name; `role` is only written once a dispatch re-pins, so `assignee` still holds it here.
      const roleKey = ticket.role || assignee;
      const { mode: dispatchMode } = this._ticketDispatchMode(team, roleKey);
      // One mint serves both modes (only `worktree` uses the branch): splitting it would put a second name-derivation rule beside the one matchSeatRole depends on.
      const oneShot = dispatchMode !== 'standing';
      const minted = oneShot ? this._mintTicketSeat(team, roleKey, ticket) : null;
      // The not-live diagnosis tests `!this.sessions.has` because `taken` is also true of a live seat and its reply advises Delete Session…;
      // respawning is no fix, since _spawnTicketSeat calls create() directly and would overwrite the record.
      if (minted && minted.taken && minted.name === assignee && !this.sessions.has(assignee)) {
        log.info('intent', `task start by ${session.name}: ${ticket.id} held — seat ${assignee} exists but is not live`);
        reply(`ticket ${ticket.id} is pinned to ${assignee}, whose session exists but is archived or dead — nothing was started. `
          + `Unarchive it from the sidebar (its spec replays on resume), or Delete Session… to release the name and start again — `
          + this._ticketDeleteCost(ticket));
        return;
      }
      if (ticket.worktree && ticket.worktree.path) {
        const dest = (minted && minted.ok) ? minted.name : this._ticketAssigneeSeat(team, ticket);
        const holder = this._ticketTreeHolder(ticket.worktree.path);
        if (holder && holder !== dest) {
          log.info('intent', `task start by ${session.name}: ${ticket.id} refused — tree held by ${holder}`);
          reply(`ticket ${ticket.id}: its worktree is held by ${holder}, which is still live — retire or delete that seat first, then start it. Nothing was changed.`);
          return;
        }
      }
      // Read off the recorded `startedAt`, not inferred from the re-pin: `role` is dispatch-only and wrong for shapes that do not re-pin.
      if (ticketStarted(ticket)) {
        const holder = this._ticketAssigneeSeat(team, ticket);
        if (!holder) {
          reply(`error: ticket ${intent.id} is already started — no live seat holds it now; `
            + `[agent:task assign ${intent.id} ${this._resolvableAssignTarget(team, ticket)}] sends the spec once one is up`);
          return;
        }
        // "holds it", not "is held by": the occupancy refusal owns that phrasing and the suite tells the replies apart by it.
        reply(`error: ticket ${intent.id} is already started — ${holder} holds it; [agent:task assign ${intent.id} ${this._resolvableAssignTarget(team, ticket)}] re-sends the spec to it`);
        return;
      }
      if (startReviewer) {
        const known = this._reviewerTemplateNames();
        if (!known.includes(startReviewer)) {
          reply(`error: no template "${startReviewer}" in the library — reviewer templates available: [${known.join(', ')}]`);
          return;
        }
      }
      // Start is the dispatch, so it unparks: a started ticket left flagged is exempt from the stall watchdog, the backstop for a dead loop step.
      const wasParked = !!ticket.parked;
      delete ticket.parked;
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;
      delete ticket.undeliveredAt;
      // Stamped above both arms and every save, so no path dispatches unrecorded: an unstamped dispatched ticket is startable twice and collides on the tree.
      ticket.startedAt = ticket.lastActivityAt;
      recordEvent(ticket, { at: ticket.startedAt, kind: 'start', by: session.name, to: (minted && minted.ok) ? minted.name : assignee });
      if (startReviewer) ticket.reviewerTemplate = startReviewer;
      const rvNote = startReviewer ? ` — reviewer template: ${startReviewer}` : '';
      const unparked = wasParked ? ' (unparked)' : '';
      if (oneShot && minted.ok) {
        // Re-pinned to the seat before the save: _ticketAssigneeSeat resolves a role to the first live seat holding it,
        // so a role pin would route the next ticket into this one's checkout.
        ticket.role = roleKey;
        ticket.assignee = minted.name;
        ticketsStore.save(team.root, tickets);
        this._spawnTicketSeat(session, team, ticket, roleKey, minted, dispatchMode);
        this._reconcileTickets(team);
        this._broadcast('ipc-message', { type: 'task', from: session.name, to: minted.name, body: `ticket ${ticket.id} started` });
        log.info('intent', dispatchMode === 'spawn'
          ? `task start by ${session.name}: ${ticket.id} → seat ${minted.name}, shared checkout`
          : `task start by ${session.name}: ${ticket.id} → seat ${minted.name}, branch ${minted.branch}`);
        ack((dispatchMode === 'spawn'
          ? `ticket ${ticket.id}${unparked} → spawning ${minted.name} in the shared checkout (no branch)`
          : `ticket ${ticket.id}${unparked} → spawning ${minted.name} in a worktree on branch ${minted.branch}`) + rvNote);
        return;
      }
      // A mint failure is not fatal: the ticket stays role-assigned and takes the ordinary delivery path.
      if (!this._repinTicketToSeat(team, ticket)) delete ticket.role;
      ticketsStore.save(team.root, tickets);
      const d = this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true);
      this._recordUndeliveredDispatch(team, tickets, ticket, d);
      const suffix = this._ticketDeliverySuffix(d, roleKey, team, ticket);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee, body: `ticket ${ticket.id} started` });
      log.info('intent', `task start by ${session.name}: ${ticket.id} → ${ticket.assignee}${wasParked ? ' (unparked)' : ''}`);
      (suffix ? reply : ack)(`ticket ${ticket.id} → ${roleKey}${unparked}${suffix}${rvNote}`);
    },

    _taskAssign(session, team, intent, reply, ack = reply) {
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
      const prevRole = ticket.role || null;
      // Assign mints like _taskStart: a parked ticket released for an opted-in role must still get its own branch,
      // or the hand works in the shared checkout on a spec written for an isolated tree.
      const { mode: dispatchMode } = this._ticketDispatchMode(team, assignee);
      const oneShot = dispatchMode !== 'standing';
      const minted = oneShot ? this._mintTicketSeat(team, assignee, ticket) : null;
      // `taken` by the ticket's current assignee means it already has a seat, but a record outlives an archive or exit,
      // so liveness (`ownSeat`) decides between re-send and the stuck reply, not `taken` alone.
      const own = !!(minted && minted.taken && minted.name === prev);
      const ownSeat = (own && this._ticketAssigneeSeat(team, { assignee: prev }) === prev) ? prev : null;
      // Same gate as start, below the mint only because the re-send test needs `ownSeat`; still above every write and the reassign notice.
      // A ticket that owns a tree is a re-send too, even with no live seat: the seat holding it can be respawned.
      const noTaskDir = this._ticketTaskDirRefusal(team, ticket, 'assign',
        !!ownSeat || !!(ticket.worktree && ticket.worktree.path));
      if (noTaskDir) { log.info('intent', `task assign by ${session.name}: ${ticket.id} refused — no task dir`); reply(noTaskDir); return; }
      // Both refusals run above the reassign notice and every field written below: past them a refusal says "nothing was changed" after the holder was told to stand down and lastActivityAt moved.
      // Occupancy keys off the ticket's tree, not the destination's role; the holder itself is exempt, being a re-send.
      if (ticket.worktree && ticket.worktree.path) {
        const dest = ownSeat || (minted && minted.ok ? minted.name : this._ticketAssigneeSeat(team, { assignee }));
        const holder = this._ticketTreeHolder(ticket.worktree.path);
        if (holder && holder !== dest) {
          log.info('intent', `task assign by ${session.name}: ${ticket.id} refused — tree held by ${holder}`);
          reply(`ticket ${ticket.id}: its worktree is held by ${holder}, which is still live — retire or delete that seat first, then re-assign. Nothing was changed.`);
          return;
        }
      }
      // Taken but not live: respawning would overwrite the record, since _spawnTicketSeat calls create() directly past the nameConflict front door, and split one name across two sidebar rows.
      // The pin stays untouched, because a role-assigned one misroutes this ticket's tree.
      if (own && !ownSeat) {
        log.info('intent', `task assign by ${session.name}: ${ticket.id} held — seat ${prev} exists but is not live`);
        reply(`ticket ${ticket.id} is still pinned to ${prev}, whose session exists but is archived or dead — nothing was delivered. `
          + `Unarchive it from the sidebar (its spec replays on resume), or Delete Session… to release the name and re-assign — `
          + this._ticketDeleteCost(ticket));
        return;
      }
      // Resolved above the notice below, which would otherwise tell the hand its ticket moved when it is only being re-sent.
      const reassigning = !own && prev != null && prev !== assignee;
      if (reassigning) {
        const oldSeat = this._ticketAssigneeSeat(team, { assignee: prev });
        if (oldSeat && oldSeat !== team.lead) {
          this._gatedDeliver(oldSeat, session.name, `[ticket ${ticket.id} reassigned] this ticket moved to ${assignee}`, false, `[ticket ${ticket.id} reassigned]`);
        }
      }
      ticket.assignee = assignee;
      ticket.lastActivityAt = Date.now();
      recordEvent(ticket, { at: ticket.lastActivityAt, kind: 'assign', by: session.name, to: assignee });
      ticket.nudgedAt = null;
      // Assign is the dispatch, so it unparks: a delivered ticket left parked is invisible to advance, replay and the badge.
      const wasParked = !!ticket.parked;
      delete ticket.parked;
      delete ticket.undeliveredAt;
      // Recorded for the same reason start does: an unstamped assigned ticket is still `start`able and would mint a second seat onto this tree.
      // Not re-stamped when already set: a re-send must not restate when work first started.
      if (!ticketStarted(ticket)) ticket.startedAt = ticket.lastActivityAt;
      // Stay pinned to the live seat: un-pinning routes the spec and the WORK IN: line to whichever seat answers the role first, mid-work on another branch.
      if (ownSeat) {
        ticket.assignee = ownSeat;
        ticketsStore.save(team.root, tickets);
        const d2 = this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true);
        this._recordUndeliveredDispatch(team, tickets, ticket, d2);
        this._reconcileTickets(team);
        this._broadcast('ipc-message', { type: 'task', from: session.name, to: ownSeat, body: `ticket ${ticket.id} re-sent` });
        log.info('intent', `task assign by ${session.name}: ${ticket.id} re-sent to its own seat ${ownSeat}`);
        const ownSuffix = this._ticketDeliverySuffix(d2, ownSeat, team, ticket);
        (ownSuffix ? reply : ack)(`ticket ${ticket.id} → ${ownSeat}${wasParked ? ' (unparked)' : ''} (its own seat, spec re-sent)${ownSuffix}`);
        return;
      }
      if (oneShot) {
        if (minted.ok) {
          ticket.role = assignee;
          ticket.assignee = minted.name;
          ticketsStore.save(team.root, tickets);
          this._spawnTicketSeat(session, team, ticket, assignee, minted, dispatchMode, !prev);
          this._reconcileTickets(team);
          log.info('intent', dispatchMode === 'spawn'
            ? `task assign by ${session.name}: ${ticket.id} → seat ${minted.name}, shared checkout`
            : `task assign by ${session.name}: ${ticket.id} → seat ${minted.name}, branch ${minted.branch}`);
          ack(dispatchMode === 'spawn'
            ? `ticket ${ticket.id} → spawning ${minted.name} in the shared checkout (no branch)`
            : `ticket ${ticket.id} → spawning ${minted.name} in a worktree on branch ${minted.branch}`);
          return;
        }
      }
      // A stale `role` is cleared on paths that do not re-pin, or the board keeps rendering a role the ticket is no longer assigned under;
      // the own-seat re-send and the mint keep a pin whose role is still the filed one.
      if (!this._repinTicketToSeat(team, ticket)) delete ticket.role;
      ticketsStore.save(team.root, tickets);
      const d = this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true, false, false, null, !prev);
      this._recordUndeliveredDispatch(team, tickets, ticket, d);
      const suffix = this._ticketDeliverySuffix(d, assignee, team, ticket);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: assignee, body: `ticket ${ticket.id} assigned` });
      log.info('intent', `task assign by ${session.name}: ${ticket.id} ${prev || '(backlog)'}${wasParked ? ' (parked)' : ''} → ${assignee}`);
      const unparked = wasParked ? ' (unparked)' : '';
      // Shows the role the ticket was filed under, not the seat: a seat-to-role arrow would report a move the lead never made.
      const prevShown = prevRole || prev;
      (suffix ? reply : ack)(reassigning ? `ticket ${ticket.id}: ${prevShown} → ${assignee}${unparked}${suffix}` : `ticket ${ticket.id} → ${assignee}${unparked}${suffix}`);
    },

    _taskDone(session, team, intent, reply) {
      // Read above the id check so a command with no resolvable id still preserves the report.
      const report = String(intent.body == null ? '' : intent.body).trim();
      if (!intent.id) { reply(`error: done needs a ticket id — [agent:task done <id>] <report>${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      if (!report) { reply('error: done needs a report — [agent:task done <id>] <what you did>'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      // Re-entry closes a ticket already `done` and held at verify; it is not a reopen, which via `reject` would bump reworkRound
      // and record a rejection that never happened.
      const reentry = ticket.state === 'done' && ticket.loopStep === 'verify' && !!ticket.verifyHold;
      // Read before the re-stamp below deletes `verifyHold`, or the reply prints "undefined" for the check.
      const heldAt = (ticket.verifyHold && ticket.verifyHold.step) || null;
      if (ticket.state !== 'open' && !reentry) {
        // Reachable only from a record the current arms do not produce (a legacy stamp): every class stamped today satisfies the re-entry gate,
        // which tests the stamp's presence, not its class.
        const held = ticket.verifyHold && ticket.verifyHold.step
          ? ` — it is held at "${ticket.verifyHold.step}". ${holdRecoveryText(ticket.verifyHold.recovery, intent.id)}`
          // The other done-at-verify state has no stamp; refusing it stays, since a second loop races a reviewer, but the text is hedged:
          // a process that dies mid-re-verify leaves the same shape, so it must not claim a check is running.
          : (ticket.state === 'done' && ticket.loopStep === 'verify'
            ? ' — it is at the verify step with no hold recorded, so its checks have not reported yet;'
              + " wait for the result (or the watchdog's stall alarm) rather than rejecting it; if the host restarted since, the loop resumes it at boot."
            : '');
        reply(`error: ticket ${intent.id} is ${ticket.state}, not open${held}${this._spillRejectedPayload(session, 'task done', report)}`); return;
      }
      const myRole = matchSeatRole(team, session.name);
      // The degraded pin resolves through `_ticketAssigneeSeat` so a replacement seat can close what it inherited; its `!worktree` gate keeps a
      // worktree ticket's closing with its own seat, since `_writeTicketCost` counts commits on a branch a sibling never saw.
      const isAssignee = ticket.assignee != null
        && (ticket.assignee === session.name || ticket.assignee === myRole
          || this._ticketAssigneeSeat(team, ticket) === session.name);
      const isLead = team.lead === session.name;
      // Names the role the ticket was filed under, not the delivery-time pin: a seat name sends the reader chasing a seat instead of the role they filed against.
      if (!isAssignee && !isLead) { reply(`error: only ticket ${intent.id}'s assignee (${ticket.role || ticket.assignee || 'unassigned'}) or the team lead (${team.lead}) can close it${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      const lead = team.lead;
      if (!isLead) {
        const tag = `[ticket ${ticket.id} ${reentry ? 're-verifying' : 'done'}]`;
        const r = this._gatedDeliver(lead, session.name, `${tag} ${report}`, false, tag);
        const kept = reentry ? `ticket stays held at "${heldAt}" (${holdRecoveryText(ticket.verifyHold && ticket.verifyHold.recovery, ticket.id).trim()})` : 'ticket kept open';
        // Spilled like every other rejecting return, and more needed here: this one tells the sender to wait on an unreachable lead, an interval that can outlive its context.
        if (r && r.error) { reply(`error: ${r.error} — report NOT delivered, ${kept}; re-fire [agent:task done ${ticket.id}] once ${lead} is reachable${this._spillRejectedPayload(session, 'task done', report)}`); return; }
      }
      ticket.state = 'done';
      // First close only: a re-entry must not overwrite closedAt or closedBy, which `_writeTicketCost` and the board read,
      // or a twice-held ticket reports a close after work the hand did before it.
      if (!reentry) {
        ticket.closedAt = Date.now();
        ticket.closedBy = session.name;
      }
      // Persisted as well as delivered, never instead: this is what survives both agents dying.
      ticket.report = report;
      ticket.reportedBy = session.name;
      const reportedAt = reentry ? Date.now() : ticket.closedAt;
      const roundNo = (Number(ticket.reviewRound) || 0) + 1;
      if (!reentry) recordEvent(ticket, { at: ticket.closedAt, kind: 'done', by: session.name, round: roundNo });
      if (!Array.isArray(ticket.rounds)) ticket.rounds = [];
      const lastRound = ticket.rounds[ticket.rounds.length - 1];
      if (lastRound && Number(lastRound.round) === roundNo && lastRound.verdict === null) {
        lastRound.report = report;
        lastRound.reportedBy = session.name;
        lastRound.reportedAt = reportedAt;
      } else {
        ticket.rounds.push({
          round: roundNo,
          report,
          reportedBy: session.name,
          reportedAt,
          verdict: null,
          mustFix: null,
          reviewedAt: null,
          verdictFile: null,
          diffFile: null,
          deltaFile: null,
          headSha: null,
        });
      }
      // On re-entry lastActivityAt is re-timed, not left at `closedAt`, which may be hours old: a hold outlasts TICKET_STALL_MS,
      // so the next sweep would alarm "stuck at verify" about a loop that started seconds ago.
      ticket.lastActivityAt = reentry ? Date.now() : ticket.closedAt;
      // The loop runs only on a ticket with its own tree (its checks are branch questions), and loopStep is stamped in the same write that closes it:
      // a process dying between close and a later stamp would leave a done ticket nothing ever nudges.
      const loopEligible = !!(ticket.worktree && ticket.worktree.branch && ticket.worktree.baseSha);
      if (loopEligible) {
        if (ticket.runnerPid && ticket.runnerOwner === RUNNER_OWNER) this._reapRunner(ticket.id, ticket.runnerPid);
        delete ticket.runnerPid;
        delete ticket.runnerOwner;
        ticket.loopStep = 'verify';
        delete ticket.verifyPhase;
        // verifyHold is cleared here, in the same write that re-stamps the step: TICKET_SUITE_TIMEOUT_MS (20m lock wait + 21m = 41m) outlasts TICKET_STALL_MS (30m),
        // so a stale hold beside loopStep 'verify' fires the wrong alarm and lets a second reviewer spawn in ordinary operation.
        delete ticket.verifyHold;
        // Opening an in-flight phase is a new stall episode, so it spends a fresh nudge here: after `done` nothing else clears nudgedAt
        // (`_touchTicketActivity` skips any ticket that is not `open`).
        ticket.nudgedAt = null;
      }
      ticketsStore.save(team.root, tickets);
      this._reconcileTickets(team);
      const doneSeat = reentry ? null : this._ticketAssigneeSeat(team, ticket);
      const adv = {};
      const next = doneSeat ? this._advanceSeat(team, doneSeat, ticket, adv) : null;
      const nextSuffix = next ? ` — next: ${next.id} delivered to ${doneSeat}${this._ticketDeliverySuffix(adv.d || {}, doneSeat, team, next)}` : '';
      // A re-entry closes nothing, so it says `re-verifying` rather than a second `done` on this channel.
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: lead, body: `ticket ${ticket.id} ${reentry ? 're-verifying' : 'done'}` });
      this._writeTicketCost(team, ticket);
      log.info('intent', `task done ${ticket.id} by ${session.name} → ${lead}${reentry ? ' (re-entry after a verify hold)' : ''}`);
      const skipped = loopEligible ? '' : ' — closed WITHOUT review: the ticket records no branch, so the loop had nothing to verify';
      if (reentry) {
        // prescribes-nothing: a receipt naming the check that held the ticket, to the seat that just cleared it, so no recovery
        // routes through `holdRecoveryText`; the step name must stay, a test pins it.
        reply(`ticket ${ticket.id} re-verifying (was held at "${heldAt}")` + skipped + nextSuffix);
      } else if (!loopEligible) {
        const facts = this._acceptSeatFacts(ticket);
        const closeOut = !next && !facts.branch && facts.ephemeralSeat && facts.seatName && facts.seatName !== lead && this.sessions.has(facts.seatName);
        const head = (isLead ? `ticket ${ticket.id} closed (done)` : `ticket ${ticket.id} closed (done) — report delivered to ${lead}`) + skipped;
        if (!closeOut) { reply(head + nextSuffix); return; }
        const failed = (e) => {
          const why = String((e && e.message) || e).split('\n')[0];
          log.warn('intent', `task done ${ticket.id}: closing out ${facts.seatName} failed: ${why}`);
          const line = `closing out ${facts.seatName} failed (${why}) — [agent:task accept ${ticket.id}] retries`;
          if (!isLead) this._gatedDeliver(lead, 'ticket-loop', `[ticket ${ticket.id}] ${line}`, false, `[ticket ${ticket.id} close-out failed]`);
          reply(`${head}; ${line}${nextSuffix}`);
        };
        return this._closeOutBranchless(team, ticket, tickets, { by: 'ticket-loop', note: '' }).then((r) => {
          if (r.archiveError) return failed(r.archiveError);
          reply(head + (r.archived ? `; ${facts.seatName} was a one-shot seat and was ARCHIVED` : '') + nextSuffix);
        }, failed).catch((e) => log.warn('intent', `task done ${ticket.id}: close-out reply failed: ${String((e && e.message) || e).split('\n')[0]}`));
      }
      if (loopEligible) this._runTicketLoop(team, ticket.id);
    },

    _liveReviewerSeat(team, t) {
      const round = (Number(t.reviewRound) || 0) + 1;
      const num = /^t?(\d+)$/.exec(String(t.id));
      const scoped = num ? `${team.name}-reviewer-${num[1]}-r${round}` : null;
      const live = scoped ? this.sessions.get(scoped) : null;
      return (live && live.agentType && !live._dead) ? scoped : null;
    },

    _resumeOrphanedVerify(team) {
      if (!team || team.solo) return;
      if (!this._verifyLooped) this._verifyLooped = new Set();
      let tickets; try { tickets = ticketsStore.load(team.root); } catch { return; }
      const resume = [];
      let cleared = false;
      for (const t of tickets) {
        const key = `${team.root}\0${t.id}`;
        if (t.state === 'done' && t.loopStep === 'review' && t.verifyPhase
          && !this._verifyLooped.has(key) && !this._liveReviewerSeat(team, t)) {
          delete t.verifyPhase;
          cleared = true;
          continue;
        }
        if (t.state !== 'done' || t.loopStep !== 'verify' || t.verifyHold) continue;
        if (this._verifyLooped.has(key)) continue;
        this._verifyLooped.add(key);
        if (this._liveReviewerSeat(team, t)) continue;
        t.lastActivityAt = Date.now();
        t.nudgedAt = null;
        delete t.runnerPid;
        delete t.runnerOwner;
        resume.push(t.id);
      }
      if (!resume.length && !cleared) return;
      try { ticketsStore.save(team.root, tickets); } catch (e) { log.error('ticket', `verify resume: save failed: ${e.message}`); return; }
      for (const id of resume) {
        log.info('intent', `verify resumed for ${id} after a host restart`);
        this._runTicketLoop(team, id);
      }
    },

    async _runTicketLoop(team, ticketId) {
      if (!this._verifyLooped) this._verifyLooped = new Set();
      this._verifyLooped.add(`${team.root}\0${ticketId}`);
      let held = false;
      let superseded = false;
      let ownPid = null;
      const fail = (step, evidence, tried, recovery) => {
        held = true;
        this._stampVerifyPhase(team, ticketId, null);
        // `cls` is the one predicate for the stamp, the recovery text and the hand notice, and they must agree.
        // `reopened` is not a hold: the reject already succeeded, so a stamp would mark an open ticket.
        const cls = (String(step).startsWith('verify') && recovery !== 'reopened')
          ? (recovery || 'hand')
          : null;
        if (cls) {
          this._stampVerifyHold(team, ticketId, {
            step, at: Date.now(), evidence: String(evidence), recovery: cls,
          });
        }
        this._escalateTicket(team, ticketId, step, evidence, tried,
          { keepHold: true, recovery: cls ? holdRecoveryText(cls, ticketId) : null });
        // Only the `hand` class reaches the seat: `spec` needs a lead-only verb and `infra` is not fixable by a commit.
        // Gate on `cls`, not the raw `recovery`, so a throw never notices a seat for a hold that was not stamped.
        if (cls === 'hand') this._notifyHandOfHold(team, ticketId, step, evidence);
      };
      let atStep = 'verify';
      try {
        const ticket = this._loadTicket(team, ticketId);
        if (!ticket || ticket.loopStep !== 'verify') return;
        const round = ticket.reworkRound || 0;
        const current = (t) => {
          const ok = !!t && t.loopStep === 'verify' && (t.reworkRound || 0) === round;
          if (!ok) superseded = true;
          return ok;
        };
        const wt = ticket.worktree || {};
        const branch = wt.branch;
        const baseSha = wt.baseSha;

        const commits = await gitWorktree.commitsOnBranch(team.root, branch, baseSha)
          .catch((e) => ({ ok: false, count: null, error: e.message }));
        if (!commits.ok) {
          fail('verify: commits-on-branch', `git could not count commits on ${branch} since ${baseSha}: ${commits.error}`,
            `ran commitsOnBranch(${branch}, ${baseSha})`, 'infra');
          return;
        }
        if (commits.count === 0) {
          fail('verify: commits-on-branch', `branch ${branch} has 0 commits beyond ${baseSha} — the ticket was closed with nothing committed`,
            `ran commitsOnBranch(${branch}, ${baseSha}); no reviewer spawned`, 'hand');
          return;
        }

        const anc = await gitWorktree.isMerged(team.root, baseSha, branch)
          .catch((e) => ({ ok: false, error: e.message }));
        if (!anc.ok) {
          fail('verify: base-is-ancestor', `git could not confirm ${baseSha} is an ancestor of ${branch}: ${anc.error}`,
            `ran isMerged(${baseSha}, ${branch})`, 'infra');
          return;
        }
        if (!anc.merged) {
          fail('verify: base-is-ancestor', `${baseSha} is NOT an ancestor of ${branch} — the branch was rebased or reset, so it is no longer the tree the spec was written against`,
            `ran isMerged(${baseSha}, ${branch}); no reviewer spawned`, 'hand');
          return;
        }

        // Resolve the destination before computing the diff: the check is a string match, the diff a git subprocess over the branch.
        // Missing and refused task dirs stay separate arms: one spec-formatting sentence for both is false for the refused path.
        const dest = this._ticketDiffDest(team, ticket);
        if (!dest.ok) {
          // Name the defect only: the route belongs to the `spec` recovery arm, and a second route contradicts it.
          const fix = ticket.taskDir
            ? `The path is named but escapes the projects root.`
            : `Its spec names no \`tasks/…\` path on any line.`;
          fail('verify: task-dir', `ticket ${ticket.id} has no usable task dir to write the review diff into (taskDir: ${ticket.taskDir || 'none'}): ${dest.error}. ${fix}`,
            'checked the task dir BEFORE computing a diff; no diff computed, no reviewer spawned', 'spec');
          return;
        }

        // The failure messages below quote `gitWorktree.diffText`'s argv; change them with its flags.
        const diff = await gitWorktree.diffText(team.root, baseSha, branch)
          .catch((e) => ({ ok: false, text: null, error: e.message }));
        if (!diff.ok) {
          fail('verify: diff', `git diff --text --no-ext-diff -U20 ${baseSha}..${branch} failed: ${diff.error}`,
            `ran diffText(${baseSha}, ${branch})`, 'infra');
          return;
        }
        if (!diff.text || !diff.text.trim()) {
          fail('verify: diff', `git diff --text --no-ext-diff -U20 ${baseSha}..${branch} is empty despite ${commits.count} commit(s) on the branch — there is nothing to review`,
            `ran commitsOnBranch (${commits.count}) then diffText, both succeeded`, 'hand');
          return;
        }

        const written = this._writeTicketDiff(team, ticket, diff.text, diff.headSha);
        if (!written.ok) {
          fail('verify: diff', `the diff could not be written for the reviewer to read: ${written.error}`,
            `ran diffText (${diff.text.length} bytes) then tried to write ${written.path || 'the task dir'}`, 'infra');
          return;
        }
        const delta = await this._writeTicketDelta(team, ticket, written.round, written.prevHeadSha, branch);

        atStep = 'verify: suite';
        this._stampSuiteRemeasured(team, ticketId, null);
        this._stampSuiteSlow(team, ticketId, null);
        const runOpts = { onSpawn: (pid) => { ownPid = pid; this._stampRunnerPid(team, ticketId, pid); } };
        this._stampVerifyPhase(team, ticketId, { phase: 'suite', since: Date.now(), run: 1 });
        let suite = await this._runTicketSuite(team, ticket, null, runOpts);
        let still = this._loadTicket(team, ticketId);
        if (!current(still)) { this._reapRunner(ticketId, suite.runnerPid); return; }
        let firstRed = null;
        let remeasureError = null;
        let slowOwned = [];
        if (suite.ran && !suite.slowOnly && !suite.green) {
          log.info('ticket', `ticket ${ticketId}: verify suite red (${suite.summary}) — re-measuring once`);
          this._stampVerifyPhase(team, ticketId, { phase: 'suite', since: Date.now(), run: 2 });
          const again = await this._runTicketSuite(team, ticket, null, runOpts);
          still = this._loadTicket(team, ticketId);
          if (!current(still)) { this._reapRunner(ticketId, again.runnerPid); return; }
          if (again.ran) {
            firstRed = suite;
            suite = again;
            if (again.green || again.slowOnly) this._stampSuiteRemeasured(team, ticketId, firstRed);
          } else {
            this._reapRunner(ticketId, again.runnerPid);
            remeasureError = again.error;
          }
        }
        if (suite.ran && suite.slowOnly) {
          slowOwned = await this._slowTestsOwned(team, still, suite.slow);
          still = this._loadTicket(team, ticketId);
          if (!current(still)) { this._reapRunner(ticketId, suite.runnerPid); return; }
          if (!slowOwned.length) this._stampSuiteSlow(team, ticketId, suite.slow);
        }
        if (!suite.ran) {
          this._reapRunner(ticketId, suite.runnerPid);
          fail('verify: suite', `the test suite could not be run on ${branch}: ${suite.error}`,
            `ran the suite in ${suite.cwd || 'the ticket worktree'}; no reviewer spawned`, 'infra');
          return;
        }
        const slowPass = suite.slowOnly && !slowOwned.length;
        if (!suite.green && !slowPass) {
          // Wrapped in try/catch because `.catch()` misses a synchronous throw, which would escalate a red suite instead of rejecting it.
          let kept;
          try {
            kept = await this._writeTicketSuiteFailure(team, still, suite);
          } catch (e) {
            kept = { ok: false, path: null, error: `the preservation threw: ${e && e.message ? e.message : String(e)}` };
            // Logged and swallowed, never rethrown: the lead never sees this text, so a systemic break shows only in the log.
            log.error('ticket', `ticket ${ticketId}: the failing suite output could not be preserved — ${kept.error}`);
          }
          const fresh = this._loadTicket(team, ticketId);
          if (!current(fresh)) return;
          const evidence = kept.ok
            ? `FULL OUTPUT (assertion text, diff and stack): ${kept.path}\n`
              + 'Read it instead of re-running the suite.'
            : `The failing output could not be preserved (${kept.error}), so the names above are all there is.`;
          const names = (s) => defuseSenderLines(s.failing || '(the runner reported no test names)');
          const failingLines = firstRed
            ? `FAILING (run 2): ${names(suite)}\n`
              + `FAILING (run 1): ${names(firstRed)}\n\n`
              + 'Both runs were red. Same names both times means the failure is real; different names '
              + 'means the box was starved and you should say so in your report rather than hunt.'
            : `FAILING: ${names(suite)}`;
          const remeasureLine = remeasureError
            ? `\n\nA re-measure was attempted and could not run: ${defuseSenderLines(remeasureError)}`
            : '';
          const rejected = slowOwned.length
            ? this._rejectTicketFromLoop(team, ticketId,
              `the suite's slow gate tripped on your branch — ${defuseSenderLines(suite.summary)}, 0 failing\n\n`
              + `SLOW GATE: ${defuseSenderLines(slowOwned.join('; '))}\n\n`
              + 'These are tests a file your branch changed contains, and each ran past the six-second '
              + 'bar. Nothing asserted wrong: inject the clock or the timeout constant through a seam, '
              + 'or list the test in test/slow-tests.json with the mechanism it genuinely waits on. '
              + 'No reviewer was spawned: the suite is the gate.')
            : this._rejectTicketFromLoop(team, ticketId,
              `the test suite FAILS on your branch — ${defuseSenderLines(suite.summary)}\n\n`
              + `${failingLines}${remeasureLine}\n\n`
              + `${evidence}\n\n`
              + 'Fix these and close the ticket again. No reviewer was spawned: a review of a '
              + 'red branch is wasted, and the suite is the gate.');
          if (!rejected.ok) {
            fail('verify: suite', slowOwned.length
              ? `the suite's slow gate tripped on ${branch} (${suite.summary}, 0 failing) over ${slowOwned.join('; ')} and the rework could not be sent back: ${rejected.error}`
              : `the suite fails on ${branch} (${suite.summary}) and the rework could not be sent back: ${rejected.error}`,
              `ran the suite (exit ${suite.code}); no reviewer spawned; failing: ${suite.failing || 'unnamed'}`
              + `${kept.ok ? ` Full output preserved at ${kept.path}.` : ` The failing output could not be preserved (${kept.error}).`}`, 'reopened');
          }
          return;
        }

        this._stampVerifyPhase(team, ticketId, { phase: 'reviewer', since: Date.now() });
        this._setLoopStep(team, ticketId, 'review');
        atStep = 'review';
        this._spawnTicketReview(team, ticketId, written.path, delta.path);
      } catch (e) {
        fail(atStep, `the loop threw: ${e && e.message ? e.message : String(e)}`,
          atStep === 'review' ? 'verify passed and the diff was written; the throw came at or after the review spawn' : 'no reviewer spawned', 'infra');
      } finally {
        if (!held && !superseded) this._stampVerifyHold(team, ticketId, null);
        if (ownPid) this._stampRunnerPid(team, ticketId, null, ownPid);
      }
    },

    // The link stays in place: recreating it per run would race a concurrent read of it.
    _linkWorktreeNodeModules(rootDir, treeDir) {
      const link = path.join(treeDir, 'node_modules');
      // Existence is lstat and validity is existsSync, which follows the link: a dangling link would otherwise be
      // reported as a link that could not be made.
      const entry = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
      if (!entry(link)) {
        const src = path.join(rootDir, 'node_modules');
        if (!fs.existsSync(src)) {
          let manifest = null;
          try { manifest = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'); } catch { return null; }
          let declares = true;
          try {
            const pkg = JSON.parse(manifest);
            const any = (d) => !!d && typeof d === 'object' && Object.keys(d).length > 0;
            declares = any(pkg && pkg.dependencies) || any(pkg && pkg.devDependencies);
          } catch { declares = true; }
          if (!declares) return null;
          return `neither ${link} nor ${src} exists — the suite cannot resolve its dependencies`;
        }
        try { fs.symlinkSync(src, link); } catch (e) {
          if (!entry(link)) {   // a concurrent run winning the race is fine
            return `could not link node_modules into the worktree: ${e.message}`;
          }
        }
      } else if (!fs.existsSync(link)) {
        return `${link} exists but does not resolve — a dangling link, most likely to a `
          + `${path.join(rootDir, 'node_modules')} that was removed or is being reinstalled`;
      }
      return null;
    },

    // The test lock stays pinned to team.root through CLODEX_TEST_LOCK_DIR, also under `runIn`: the runner's own default roots it at the
    // tree it runs in, a different mutex from the lead's, and the port-binding tests would deadlock.
    async _runTicketSuite(team, ticket, runIn = null, opts = {}) {
      const wt = (ticket && ticket.worktree) || {};
      const cwd = runIn ? String(runIn) : (wt.path ? String(wt.path) : null);
      // `runnerPid` is carried out because a SIGKILLed runner is a zombie that still answers kill(pid, 0) while its pid sits in the
      // lock dir; callers need it to tell our runner from a foreign holder.
      const out = { ran: false, green: false, slowOnly: false, slow: [], code: null, summary: '', failing: '', output: '', cwd, error: null, runnerPid: null, head: null, startedAt: null, headEnd: null };
      if (!cwd) { out.error = 'the ticket has no worktree path to run in'; return out; }

      const runner = path.join(cwd, 'scripts', 'run-tests.js');
      if (!fs.existsSync(runner)) {
        out.error = `no test runner at ${runner} — the branch has no scripts/run-tests.js`;
        return out;
      }

      const linkErr = this._linkWorktreeNodeModules(team.root, cwd);
      if (linkErr) { out.error = linkErr; return out; }
      const link = path.join(cwd, 'node_modules');

      // A removed or re-ranged dependency still resolves from the root's node_modules and goes green, so package.json is compared first.
      // Not named `deps`: that would shadow createSessionManager's injected dependency object.
      const parseDeps = (text) => {
        try {
          const j = JSON.parse(text);
          return { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.optionalDependencies || {}) };
        } catch { return null; }
      };
      const readDeps = (pkgPath) => {
        try { return parseDeps(fs.readFileSync(pkgPath, 'utf8')); } catch { return null; }
      };
      const wantDeps = readDeps(path.join(cwd, 'package.json'));
      const haveDeps = readDeps(path.join(team.root, 'package.json'));
      if (wantDeps && haveDeps) {
        const atBase = wt.baseSha
          ? await gitWorktree.fileAt(team.root, wt.baseSha, 'package.json').catch(() => null)
          : null;
        const baseDeps = atBase && atBase.ok ? parseDeps(atBase.text) : null;
        const branchChanged = (name) => !baseDeps || baseDeps[name] !== wantDeps[name];
        const diffs = [];
        for (const [name, range] of Object.entries(wantDeps)) {
          if (!branchChanged(name)) continue;
          if (!(name in haveDeps)) diffs.push(`+${name}@${range} (added by the branch)`);
          else if (haveDeps[name] !== range) diffs.push(`~${name}: root has ${haveDeps[name]}, branch wants ${range}`);
        }
        for (const name of Object.keys(haveDeps)) {
          if (!(name in wantDeps) && branchChanged(name)) diffs.push(`-${name} (dropped by the branch)`);
        }
        if (diffs.length) {
          out.error = 'the branch changes package.json dependencies, but the suite runs against the ROOT checkout\'s '
            + `installed node_modules (linked at ${link}), so it would verify the wrong dependency set: `
            + `${diffs.slice(0, 10).join('; ')}${diffs.length > 10 ? ` (+${diffs.length - 10} more)` : ''}`
            + ' — install them in the root checkout and re-run, rather than sending this back to the implementer';
          return out;
        }
      }

      // Read before the run and never later: a sha newer than what ran sends a hand editing correct work. The lock wait (taken by the
      // child) stays uncovered; `headEnd` below reports whether HEAD moved.
      out.startedAt = new Date().toISOString();
      out.head = await gitWorktree.currentBranch(cwd).catch(() => null);

      const res = await new Promise((resolve) => {
        let child;
        try {
          child = childProcess.spawn(process.execPath, [runner, '--reporter=dot'], {
            cwd,
            env: {
              ...process.env,
              // `process.execPath` is the Electron binary under the desktop app; without ELECTRON_RUN_AS_NODE the spawn is an app
              // launch, no tap is written and every ticket escalates.
              ELECTRON_RUN_AS_NODE: '1',
              CLODEX_TEST_LOCK_DIR: path.join(team.root, '.test-digest.lock'),
              // Wait for the lock, never refuse: a refusal escalates a ticket whose only fault was closing at a busy moment.
              CLODEX_TEST_LOCK_WAIT_MS: String(TICKET_SUITE_LOCK_WAIT_MS),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            // Own process group so the timeout can kill the grandchildren: an orphaned sweep keeps binding the test ports
            // and deadlocks the next gate run.
            detached: true,
          });
        } catch (e) { resolve({ error: `spawn failed: ${e.message}` }); return; }
        // Set on `out`, not the resolved value: the timeout arm resolves an error-only shape and still needs the pid.
        out.runnerPid = child.pid > 0 ? child.pid : null;
        if (out.runnerPid && opts && typeof opts.onSpawn === 'function') {
          try { opts.onSpawn(out.runnerPid); } catch {}
        }

        // Drain the pipes but keep only the tail: a full pipe blocks the child forever, which the timeout would report as a wedge.
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
          // Detach the drains and resume: a survivor of a missed group kill must not keep appending, or block on a full pipe holding the root lock.
          try { child.stdout.removeAllListeners('data'); child.stdout.resume(); } catch {}
          try { child.stderr.removeAllListeners('data'); child.stderr.resume(); } catch {}
          resolve(v);
        };
        const timer = setTimeout(() => {
          // Kill the group through the negative pid: `child.kill()` signals only the leader, the runner blocked in spawnSync,
          // not the sweep beneath it.
          if (!this._killRunner(child.pid)) {
            try { child.kill('SIGKILL'); } catch {}
          }
          finish({ error: `the suite did not finish within ${TICKET_SUITE_TIMEOUT}ms (killed)`, stdout, stderr });
        }, TICKET_SUITE_TIMEOUT);
        child.on('error', (e) => finish({ error: `the runner could not start: ${e.message}`, stdout, stderr }));
        child.on('close', (code) => finish({ code, stdout, stderr }));
      });

      // Second HEAD read, kept apart from `head` (the header's pre-run capture): the writer only uses it to say HEAD moved.
      // It sits before the `res.error` return so the timeout and crash arms are covered too.
      out.headEnd = await gitWorktree.currentBranch(cwd).catch(() => null);

      const text = `${res.stdout || ''}\n${res.stderr || ''}`;
      // Error and no-TOTALS arms carry the raw capture like the red arm: a crashed post-merge run reverts master just as a red one does.
      // Not hoisted above the green check: a passing ticket would hold a 64KB string for no reader.
      if (res.error) { out.error = res.error; out.output = text; return out; }
      out.code = res.code;

      // TOTALS is the only proof the run completed: exit 0 also comes from a refused lock and an empty tap.
      // Match stdout only, last hit: a TOTALS-shaped stderr line would otherwise shadow the real summary.
      const all = [...String(res.stdout || '').matchAll(/TOTALS: (\d+) pass, (\d+) fail, (\d+) tests/g)];
      const totals = all.length ? all[all.length - 1] : null;
      if (!totals) {
        const hung = String(res.stderr || '').split('\n').filter((l) => /^run-tests: TIMEOUT after .* in .+$/.test(l)).pop();
        const last = String(res.stdout || '').trim().split('\n').filter((l) => l.trim()).pop() || '(no stdout)';
        const note = String(res.stderr || '').split('\n').map((l) => l.trim()).filter((l) => /^run-tests: /.test(l)).pop();
        out.error = hung
          ? `the runner printed no "TOTALS: <n> pass, <n> fail, <n> tests" line on stdout (exit ${res.code}) — ${hung.slice(0, 300)}`
          : `the runner printed no "TOTALS: <n> pass, <n> fail, <n> tests" line on stdout (exit ${res.code}) — last stdout line: ${last.slice(0, 300)}`
            + (note ? `; last runner note: ${note.slice(0, 300)}` : '');
        out.output = text;
        return out;
      }
      const [, pass, failed, tests] = totals;
      if (Number(tests) === 0) {
        out.error = `the runner executed ZERO tests (exit ${res.code}) — a run that verified nothing `
          + 'cannot stand in for a green suite';
        out.output = text;
        return out;
      }
      out.ran = true;
      out.summary = `${pass}/${tests} passing, ${failed} failing (exit ${res.code})`;
      // Green needs both: `fail 0` alone misses an async escape counted as a pass, and exit 0 alone trusts a reporter that never counted.
      out.green = res.code === 0 && Number(failed) === 0;
      if (!out.green) {
        // Parse the dot reporter's `✖ name (Nms)` lines, not tap `not ok`: the runner sends tap to a temp file, so stdout never
        // carries it and a tap parser yields no names.
        const names = [];
        for (const line of text.split('\n')) {
          const m = /^ *✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(line);
          if (m && !names.includes(m[1].trim())) names.push(m[1].trim());
        }
        out.failing = names.slice(0, 20).join('; ').slice(0, 1000);
        out.output = text;
        if (!out.failing) {
          const esc = /ESCAPES: (?!0)(.*)/.exec(text);
          if (esc) out.failing = `escaped errors — ${esc[1].trim().slice(0, 500)}`;
        }
        const slowNames = [];
        let staleEntry = false;
        const stdoutText = String(res.stdout || '');
        const slowRe = /^SLOW: (?:(\d+)ms (.+)|stale allowlist entry (.+))$/gm;
        for (let m = slowRe.exec(stdoutText); m; m = slowRe.exec(stdoutText)) {
          if (m[3]) { staleEntry = true; slowNames.push(`stale allowlist entry ${m[3].trim()}`); } else slowNames.push(m[2].trim());
        }
        out.slow = slowNames;
        out.slowOnly = Number(failed) === 0 && !staleEntry && slowNames.length > 0
          && !/^ESCAPES: [1-9]/m.test(text)
          && names.length > 0 && names.every((n) => slowNames.includes(n));
      }
      return out;
    },

    _reworkSeatName(team, roleKey, ticket) {
      const n = String(ticket.id).replace(/^t/, '');
      for (let k = 2; k <= 20; k += 1) {
        const name = `${team.name}-${roleKey}-${n}-r${k}`;
        if (!AGENT_NAME_RE.test(name)) return null;
        let taken = this.sessions.has(name);
        if (!taken) { try { taken = !!getPersistence().get(name); } catch { taken = true; } }
        if (!taken) return name;
      }
      return null;
    },

    _reworkSeatFor(team, ticket, seat, deliveryText) {
      const unchanged = { seat, replaced: false };
      try {
        if (!seat || !team || !ticket || seat === team.lead) return unchanged;
        const s = this.sessions.get(seat);
        if (!s || !s.agentType || s._dead) return unchanged;
        if (!s.ctxInfo || typeof s.ctxInfo.tok !== 'number') return unchanged;
        let rec = null;
        try { rec = getPersistence().get(seat); } catch { rec = null; }
        if (!rec || rec.ephemeral !== true) return unchanged;
        const wt = ticket.worktree;
        if (!wt || !wt.path || !wt.branch) return unchanged;
        let overrides = null;
        try { overrides = getUiSettings().get().ctxReminderThresholds; } catch { overrides = null; }
        const nudge = ctxThresholdsFor(s.ctxInfo.model || null, overrides).nudge;
        if (!(s.ctxInfo.tok >= nudge)) return unchanged;
        const roleKey = ticket.role || matchSeatRole(team, seat);
        if (!roleKey || !(team.roles && Object.prototype.hasOwnProperty.call(team.roles, roleKey))) return unchanged;
        const opener = this.sessions.get(team.lead);
        if (!opener || !opener.agentType) {
          log.info('intent', `ticket ${ticket.id}: seat ${seat} is past the compact threshold but was KEPT — `
            + `no live lead (${team.lead}) to open a replacement seat`);
          return unchanged;
        }
        const fresh = this._reworkSeatName(team, roleKey, ticket);
        if (!fresh) {
          log.info('intent', `ticket ${ticket.id}: seat ${seat} is past the compact threshold but was KEPT — `
            + `every replacement name for role ${roleKey} is taken`);
          return unchanged;
        }
        const tokens = s.ctxInfo.tok;
        const head = gitWorktree.headShaSync(wt.path);
        const range = wt.baseSha ? `git log --oneline ${wt.baseSha}..HEAD` : 'git log --oneline -20';
        const prefix = `REWORK on a FRESH seat: the previous seat (${seat}) was replaced at ~${Math.round(tokens / 1000)}k `
          + `tokens. Your branch ${wt.branch}${head ? ` at ${head}` : ''} carries its commits; read \`${range}\`, `
          + `\`git status\` (the replaced seat may have left uncommitted edits), the diff, and JOURNAL.md in your `
          + `tree before touching anything. Then:\n${deliveryText || ''}\n`;
        try { getPersistence().setWorktree(seat, null); } catch { /* best-effort */ }
        Promise.resolve(this.archive(seat)).catch((e) => {
          log.error('intent', `rework seat replacement: archiving ${seat} failed: ${e.message}`);
        });
        ticket.role = roleKey;
        ticket.assignee = fresh;
        const stamps = Array.isArray(ticket.seatReplacements) ? ticket.seatReplacements : [];
        ticket.seatReplacements = [...stamps, { at: Date.now(), prev: seat, next: fresh, tokens }];
        this._spawnTicketSeat(opener, team, ticket, roleKey,
          { name: fresh, branch: wt.branch }, 'worktree', false, prefix);
        return { seat: fresh, replaced: true, tokens, prevSeat: seat, threshold: nudge };
      } catch (e) {
        log.error('intent', `rework seat gate failed for ${ticket && ticket.id}: ${e.message}`);
        return unchanged;
      }
    },

    _seatReplacedClause(r) {
      if (!r || !r.replaced) return '';
      return ` — seat ${r.prevSeat} replaced by ${r.seat} (context ~${Math.round(r.tokens / 1000)}k, `
        + `past the ${Math.round(r.threshold / 1000)}k compact threshold); same branch and tree`;
    },

    // The state transition must stay identical to `_taskReject`'s reopen: a ticket reopened by the loop and one reopened
    // by the lead must look the same downstream.
    _rejectTicketFromLoop(team, ticketId, reason, { notifyLead = true, cause = 'suite red' } = {}) {
      try {
        const tickets = ticketsStore.load(team.root);
        const ticket = tickets.find((t) => t.id === ticketId);
        if (!ticket) return { ok: false, error: `ticket ${ticketId} is gone` };
        const seat = this._ticketAssigneeSeat(team, ticket);
        if (seat && seat === team.lead) {
          return { ok: false, error: `${seat} is holding ${ticket.id} itself — the must-fixes are yours to act on` };
        }
        if (!seat) {
          return { ok: false, error: `no live seat holds ${ticket.role || ticket.assignee || 'the ticket'} to send the rework to` };
        }
        ticket.state = 'open';
        recordEvent(ticket, { kind: 'reject', by: 'ticket-loop', cause });
        ticket.closedAt = null;
        ticket.closedBy = null;
        delete ticket.closedOut;
        delete ticket.loopClosedOut;   // left set, the next round cannot be accepted
        delete ticket.acceptedAt;
        delete ticket.acceptedBy;
        delete ticket.acceptNote;
        ticket.lastActivityAt = Date.now();
        ticket.nudgedAt = null;
        ticket.reworkRound = (Number(ticket.reworkRound) || 0) + 1;
        appendReworkReason(ticket, { round: ticket.reworkRound, by: 'ticket-loop', reason });
        delete ticket.loopStep;
        delete ticket.verifyPhase;
        delete ticket.mergedNudgedAt;
        delete ticket.escalationUndelivered;
        delete ticket.mergeError;
        const rework = this._reworkSeatFor(team, ticket, seat,
          this._redirectDeliveryText(ticket.id, 'rejected', reason));
        ticketsStore.save(team.root, tickets);
        this._retireReviewSeatsFor(team, ticketId, 'rejected by the loop');
        const r = rework.replaced
          ? { queued: true }
          : this._gatedDeliver(seat, 'ticket-loop', this._redirectDeliveryText(ticket.id, 'rejected', reason), true,
            `[ticket ${ticket.id} rejected] close with ${ticketCloseVerb(ticket.id)}`,
            (disposition, why) => this._armSpecConfirm(seat, ticket.id, disposition,
              { label: 'rejected', reason, from: 'ticket-loop' }, why));
        const replaced = this._seatReplacedClause(rework);
        this._reconcileTickets(team);
        this._broadcast('ipc-message', { type: 'task', from: 'ticket-loop', to: ticket.assignee || rework.seat, body: `ticket ${ticket.id} rejected: ${cause}${replaced}` });
        log.info('intent', `ticket ${ticket.id} rejected by the loop (${cause}) → ${rework.seat}${replaced}`);
        if (!(r && (r.queued || r.parked))) {
          return { ok: false, error: `the ticket was reopened but the rework message did not reach ${rework.seat} (${(r && (r.error || r.held)) || 'unknown delivery failure'})` };
        }
        // Delivered arm only: the undelivered return above is escalated by the caller, and notifying here too would report one rejection twice.
        if (notifyLead) this._notifyLeadOfLoopRejection(team, ticket, rework.seat, reason, replaced);
        return {
          ok: true, error: null, seat: rework.seat, round: ticket.reworkRound,
          replaced: rework.replaced ? rework : null,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    _notifyLeadOfLoopRejection(team, ticket, seat, reason, replacedClause = '') {
      try {
        if (!team.lead) return;
        const round = Number(ticket.reworkRound) || 1;
        const firstLine = String(reason || '').split('\n')[0].trim().slice(0, 300);
        const body = [
          `[ticket ${ticket.id} REJECTED by the loop] sent back to ${seat} for rework (round ${round})${replacedClause}.`,
          '',
          `WHY: ${firstLine || 'the test suite failed on the branch'}`,
          '',
          (replacedClause
            ? 'A replacement seat is being spawned with the rework as its first write, and the ticket is open again; '
              + 'the failing test names are on the record. If the spawn fails, a separate notice follows. '
            : 'The rework reached the seat and the ticket is open again; the failing test names are on'
              + " the record and in the seat's copy. ") + NOTHING_TORN_DOWN,
        ].join('\n');
        const r = this._gatedDeliver(team.lead, 'ticket-loop', body, false, `[ticket ${ticket.id} REJECTED] round ${round} → ${seat}`);
        if (r && r.error) {
          log.warn('intent', `ticket ${ticket.id} rejected to ${seat} but lead ${team.lead} not notified — ${r.error}`);
        }
      } catch (e) {
        log.error('intent', `ticket ${ticket.id}: rejection landed but lead notification failed: ${e.message}`);
      }
    },

    // No reviewer teardown here: a review round exists only while the ticket is done, and this path never touches `loopStep`.
    _taskRejectFollowUp(session, team, tickets, ticket, reason, reply) {
      const seat = this._ticketAssigneeSeat(team, ticket);
      // Own arm: on a solo board the lead is its own team lead, so folding this into the no-seat arm would claim no live seat holds the role.
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
      const rework = this._reworkSeatFor(team, ticket, seat,
        this._redirectDeliveryText(ticket.id, 'more must-fixes', reason));
      const redirect = { label: 'more must-fixes', reason, from: session.name };
      let armed = null;
      let parkCarry = null;
      const r = rework.replaced
        ? { queued: true }
        : this._gatedDeliver(seat, session.name, this._redirectDeliveryText(ticket.id, 'more must-fixes', reason), true,
          `[ticket ${ticket.id} more must-fixes] close with ${ticketCloseVerb(ticket.id)}`,
          (disposition, why) => {
            const carried = disposition === 'parked' && parkCarry ? { ...redirect, ...parkCarry } : redirect;
            parkCarry = null;
            armed = this._armSpecConfirm(seat, ticket.id, disposition, carried, why) || null;
          },
          { rebody: (disposition) => {
            if (disposition === 'parked') {
              const live = this.sessions.get(seat);
              parkCarry = live ? this._redirectCarry(seat, ticket.id, live._specUnconfirmed, redirect) : null;
              return parkCarry ? this._redirectDeliveryText(ticket.id, 'more must-fixes', parkCarry.reason) : null;
            }
            return armed && armed.carried && typeof armed.reason === 'string'
              ? this._redirectDeliveryText(ticket.id, 'more must-fixes', armed.reason)
              : null;
          } });
      if (!(r && (r.queued || r.parked))) {
        reply(`error: ${ticket.id} is already open for rework and the follow-up did NOT reach ${rework.seat} `
          + `(${(r && (r.error || r.held)) || 'unknown delivery failure'})`
          + `${this._spillRejectedPayload(session, 'task reject', reason)}`);
        return;
      }
      const replaced = this._seatReplacedClause(rework);
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;
      // Filed under the current round, not a bumped one: this path opens no round, and a new number would tell the next
      // reviewer it was sent back once more than it was.
      appendReworkReason(ticket, { round: Number(ticket.reworkRound) || 1, by: session.name, reason });
      recordEvent(ticket, { at: ticket.lastActivityAt, kind: 'reject', by: session.name, followUp: true });
      ticketsStore.save(team.root, tickets);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || rework.seat, body: `ticket ${ticket.id} follow-up must-fixes${replaced}` });
      log.info('intent', `task reject ${ticket.id} by ${session.name} → follow-up to ${rework.seat} (already open for rework)${replaced}`);
      reply(`ticket ${ticket.id} was already open for rework (round ${Number(ticket.reworkRound) || 1}) — `
        + `your must-fixes were delivered to ${rework.seat} as a follow-up, not as a new reopen${replaced}`);
    },

    _loadTicket(team, ticketId) {
      try {
        const tickets = ticketsStore.load(team.root);
        return tickets.find((t) => t.id === ticketId) || null;
      } catch { return null; }
    },

    _notifyHandOfHold(team, ticketId, step, evidence) {
      try {
        const ticket = this._loadTicket(team, ticketId);
        if (!ticket) return;
        const seat = this._ticketAssigneeSeat(team, ticket);
        if (!seat || seat === team.lead) return;
        // The trailing sentence carries only what the `hand` recovery text does not state; its rework-round fact must not be restated beside it.
        const body = `[ticket ${ticketId} HELD] the loop stopped at: ${step}\n\n`
          + `EVIDENCE: ${defuseSenderLines(evidence)}\n\n`
          + `${holdRecoveryText('hand', ticketId)}\n\n`
          + 'Nothing was torn down — your worktree, your branch and this seat are exactly as they were. '
          + 'The ticket was NOT rejected.';
        this._gatedDeliver(seat, 'ticket-loop', body, true,
          `[ticket ${ticketId} HELD] close with ${ticketCloseVerb(ticketId)}`);
      } catch (e) {
        log.error('ticket', `hold notice for ${ticketId} did not reach the hand: ${e.message}`);
      }
    },

    _stampVerifyHold(team, ticketId, hold) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!hold) { if (!('verifyHold' in rec)) return; delete rec.verifyHold; }
        else {
          // Evidence is truncated: tickets.json is rewritten on every ticket write and runner or git error text is unbounded;
          // the escalation message keeps the full text.
          const ev = String(hold.evidence == null ? '' : hold.evidence);
          rec.verifyHold = { ...hold, evidence: ev.length > 400 ? `${ev.slice(0, 400)}…` : ev };
          // A new escalation starts a new stall episode; a leftover `nudgedAt` would put its first alarm on a rung it never climbed.
          rec.lastActivityAt = Date.now();
          rec.nudgedAt = null;
          recordEvent(rec, { at: rec.lastActivityAt, kind: 'verify-hold', by: 'ticket-loop', step: String(hold.step == null ? '' : hold.step) });
        }
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `verify hold stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    async _slowTestsOwned(team, ticket, names, preMergeBase) {
      const wanted = (names || []).map((n) => String(n)).filter(Boolean);
      if (!wanted.length) return [];
      const wt = (ticket && ticket.worktree) || {};
      const branch = wt.branch;
      if (!branch) return [];
      if (preMergeBase !== undefined) return this._slowTestsOwnedFrom(team, branch, wanted, preMergeBase || wt.baseSha || null);
      const target = await gitWorktree.mergeTargetFor(team).catch(() => null);
      const mb = target
        ? await gitWorktree.mergeBase(team.root, target, branch).catch((e) => ({ ok: false, error: e.message }))
        : { ok: false, error: 'no merge target resolved' };
      let base = mb && mb.ok ? mb.sha : null;
      if (!base) {
        base = wt.baseSha || null;
        log.info('ticket', `slow gate: no merge-base of ${target || '(no trunk)'} and ${branch} (${(mb && mb.error) || 'unknown'}) — scoping ${ticket && ticket.id} by recorded base ${base || '(none)'}`);
      }
      return this._slowTestsOwnedFrom(team, branch, wanted, base);
    },

    async _slowTestsOwnedFrom(team, branch, wanted, base) {
      if (!base) return [];
      const d = await gitWorktree.diffNames(team.root, base, branch, TEST_ROOTS.map((r) => `${r}/`))
        .catch(() => ({ ok: false, names: null }));
      if (!d || !d.ok || !Array.isArray(d.names) || !d.names.length) return [];
      const owned = new Set();
      for (const rel of d.names) {
        const f = await gitWorktree.fileAt(team.root, branch, rel).catch(() => ({ ok: false, text: null }));
        if (!f || !f.ok || typeof f.text !== 'string') continue;
        for (const n of wanted) if (f.text.includes(n)) owned.add(n);
      }
      return wanted.filter((n) => owned.has(n));
    },

    _killRunner(pid) {
      // `> 0` is load-bearing: kill(-0) signals our own process group, and a stubbed child's pid shape is not guaranteed.
      if (!(pid > 0)) return false;
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      return true;
    },

    _reapRunner(ticketId, pid) {
      if (!(pid > 0) || pid === process.pid) return false;
      try { process.kill(pid, 0); } catch { return false; }
      this._killRunner(pid);
      log.info('ticket', `ticket ${ticketId}: killed the abandoned suite runner ${pid}`);
      return true;
    },

    _stampRunnerPid(team, ticketId, pid, only = null) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (pid) { rec.runnerPid = pid; rec.runnerOwner = RUNNER_OWNER; }
        else if (!('runnerPid' in rec) || (only != null && rec.runnerPid !== only)) return;
        else { delete rec.runnerPid; delete rec.runnerOwner; }
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `runner pid stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    _stampSuiteSlow(team, ticketId, names) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!names || !names.length) { if (!('suiteSlow' in rec)) return; delete rec.suiteSlow; } else rec.suiteSlow = names.slice(0, 20).map((n) => String(n).slice(0, 200));
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `suite slow stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    _stampSuiteRemeasured(team, ticketId, first) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!first) { if (!('suiteRemeasured' in rec)) return; delete rec.suiteRemeasured; }
        else {
          const names = String(first.failing || '');
          rec.suiteRemeasured = {
            first: String(first.summary || ''),
            firstFailing: names.length > 400 ? `${names.slice(0, 400)}…` : names,
            at: Date.now(),
          };
        }
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `suite re-measure stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    _stampVerifyPhase(team, ticketId, phase) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (!phase) { if (!('verifyPhase' in rec)) return; delete rec.verifyPhase; } else rec.verifyPhase = phase;
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `verify phase stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    _stampMerged(team, ticketId, sha) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        rec.mergedAt = Date.now();
        recordEvent(rec, { at: rec.mergedAt, kind: 'merged', by: 'ticket-loop', sha: String(sha == null ? '' : sha) });
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `merged stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    _stampRoundFile(team, ticketId, round, field, value) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec || !Array.isArray(rec.rounds)) return;
        const entry = rec.rounds.find((r) => r && Number(r.round) === Number(round));
        if (!entry) return;
        entry[field] = value;
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `${field} stamp for ${ticketId} r${round} failed: ${e.message}`);
      }
    },

    _stampMergeMsgFile(team, ticketId, basename) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        rec.mergeMsgFile = basename;
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `mergeMsgFile stamp for ${ticketId} failed: ${e.message}`);
      }
    },

    _setLoopStep(team, ticketId, step) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec) return;
        if (step) rec.loopStep = step; else delete rec.loopStep;
        rec.lastActivityAt = Date.now();
        rec.nudgedAt = null;
        ticketsStore.save(team.root, tickets);
      } catch (e) {
        log.error('ticket', `loopStep ${step} for ${ticketId} failed: ${e.message}`);
      }
    },

    // Shared by the loop's pre-check and the write so they cannot disagree; taskDir is agent-written spec text, so it goes
    // through `teamCost.resolveTaskDir`'s confinement (`~` and `..` would escape the projects root).
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

    // The `rule ?` guard looks redundant with ticketTaskDirLine's own gate but must stay: without it a `~` or absolute pointer emits a bare TASK DIR line.
    // Resolved through `_ticketDiffDest` for its confinement; a refusal drops the line and never fails the caller.
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

    // One file per ticket and round, not the digest's shared last.txt: an unattended second writer would overwrite another
    // ticket's failure and a hand would read it as its own.
    async _writeTicketSuiteFailure(team, ticket, suite, round = (Number(ticket.reviewRound) || 0) + 1) {
      const dest = this._ticketDiffDest(team, ticket);
      if (!dest.ok) return { ok: false, path: null, error: dest.error };
      const body = String((suite && suite.output) || '').trim();
      // An empty capture is reported, never written: an empty file reads as the runner having said nothing.
      if (!body) return { ok: false, path: null, error: 'the run produced no captured output to preserve' };
      // Millisecond resolution only discriminates; the existsSync loop below closes the name.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stem = path.join(dest.dir, `suite-failure-${ticket.id}-r${round}-${stamp}`);
      let file = `${stem}.txt`;
      for (let n = 2; n < 100 && fs.existsSync(file); n++) file = `${stem}-${n}.txt`;
      // `head` comes from the run's pre-run capture, not a re-read: a report-time read names a commit that landed mid-run as the measured one.
      // The re-read is only the fallback for a suite carrying no `head`.
      const head = (suite && suite.head !== undefined && suite.head !== null)
        ? suite.head
        : await gitWorktree.currentBranch((suite && suite.cwd) || '').catch(() => null);
      // `ok:true` with a null head is reachable (`currentBranch` tolerates a failed rev-parse), so the missing sha is stated, not left blank.
      const headSha = head && head.ok ? String(head.head || '').slice(0, 12) : '';
      const headLine = head && head.ok && headSha
        ? `${head.branch} ${headSha}`
        : `${(head && head.branch) || (ticket.worktree && ticket.worktree.branch) || 'unknown'} (commit unresolved)`;
      // Its own line, not a suffix on `# head:`, which readers grep for the tree that ran; absent on an unmoved run so it is noticed.
      const endSha = suite && suite.headEnd && suite.headEnd.ok
        ? String(suite.headEnd.head || '').slice(0, 12) : '';
      const movedLine = suite && suite.head && headSha && endSha && endSha !== headSha
        ? [`# moved: HEAD was ${headSha} when this run was queued and ${endSha} when it finished — `
          + 'the lock wait sits between, so neither is proof of what the suite measured']
        : [];
      // `# start:` is the instant carried out of `_runTicketSuite`, not a fresh clock read: a value minted here would always read as zero elapsed.
      // Omitted when the suite object never ran.
      const startLine = suite && suite.startedAt ? [`# start: ${suite.startedAt}`] : [];
      const header = [
        `# clodex ticket loop — preserved output of the FAILING suite run for ${ticket.id}.`,
        `# tree:  ${(suite && suite.cwd) || 'unknown'}`,
        `# head:  ${headLine}`,
        ...movedLine,
        ...startLine,
        `# when:  ${new Date().toISOString()}`,
        `# count: ${(suite && suite.summary) || 'unknown'}`,
        '',
      ].join('\n');
      // Written aside and renamed so a partial dump (ENOSPC, a kill mid-write) is never at the published path;
      // unlinking after a failed direct write could itself fail.
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

    _writeTicketDiff(team, ticket, text, headSha = null) {
      const dest = this._ticketDiffDest(team, ticket);
      if (!dest.ok) return { ok: false, path: null, round: null, prevHeadSha: null, error: dest.error };
      const taskDir = dest.dir;
      const round = (Number(ticket.reviewRound) || 0) + 1;
      const rounds = Array.isArray(ticket.rounds) ? ticket.rounds : [];
      const prev = rounds.find((r) => r && Number(r.round) === round - 1);
      const prevHeadSha = (prev && typeof prev.headSha === 'string' && prev.headSha) || null;
      const file = path.join(taskDir, `review-${ticket.id}-r${round}.diff`);
      try {
        ensureDir(taskDir);
        fs.writeFileSync(file, text);
      } catch (e) {
        return { ok: false, path: file, round, prevHeadSha, error: e.message };
      }
      this._stampRoundFile(team, ticket.id, round, 'diffFile', path.basename(file));
      if (headSha) this._stampRoundFile(team, ticket.id, round, 'headSha', String(headSha));
      return { ok: true, path: file, round, prevHeadSha, error: null };
    },

    async _writeTicketDelta(team, ticket, round, prevHeadSha, branch) {
      const none = { ok: false, path: null };
      if (!prevHeadSha || !branch || Number(round) < 2) return none;
      this._stampRoundFile(team, ticket.id, round, 'deltaFile', null);
      const dest = this._ticketDiffDest(team, ticket);
      if (!dest.ok) return none;
      const file = path.join(dest.dir, `review-${ticket.id}-r${round}.delta.diff`);
      const dropStale = () => {
        try { fs.unlinkSync(file); } catch (e) {
          if (e.code !== 'ENOENT') {
            log.error('ticket', `ticket ${ticket.id} r${round}: stale delta unlink failed: ${e.message}`);
          }
        }
        this._stampRoundFile(team, ticket.id, round, 'deltaFile', null);
        return none;
      };
      const d = await gitWorktree.diffText(team.root, prevHeadSha, branch)
        .catch((e) => ({ ok: false, text: null, error: e.message }));
      if (!d.ok || !d.text || !d.text.trim()) {
        log.info('ticket', `ticket ${ticket.id} r${round}: no delta diff written (${d.ok ? 'empty range' : d.error})`);
        return dropStale();
      }
      try {
        ensureDir(dest.dir);
        fs.writeFileSync(file, d.text);
      } catch (e) {
        log.error('ticket', `ticket ${ticket.id} r${round}: delta diff write failed: ${e.message}`);
        return dropStale();
      }
      this._stampRoundFile(team, ticket.id, round, 'deltaFile', path.basename(file));
      return { ok: true, path: file };
    },

    // Spawn through `_handleTeamReview`, never hand-rolled: the reviewTicket seed that routes the verdict back lives there.
    _spawnTicketReview(team, ticketId, diffPath, deltaPath = null) {
      const ticket = this._loadTicket(team, ticketId);
      if (!ticket) return;
      const leadSession = this.sessions.get(team.lead);
      if (!leadSession) {
        this._stampVerifyPhase(team, ticketId, null);
        this._escalateTicket(team, ticketId, 'review: spawn',
          `the team lead ${team.lead} has no live session to spawn a reviewer from`,
          'verify passed and the diff was written; no reviewer spawned');
        return;
      }
      // Uses the hand's renderer: a raw relative taskDir lands in the stale `tasks/` decoy of the reviewer's checkout,
      // and `buildReviewScope` has no raw fallback by design.
      const taskDirRender = this._ticketTaskDirRender(team, ticket);
      const scope = buildReviewScope({ ticket, diffPath, deltaPath, taskDir: taskDirRender.dir, taskDirRule: taskDirRender.rule });
      this._handleTeamReview(leadSession, scope, {
        ticketId,
        addDirs: [path.dirname(diffPath)],
        attach: [diffPath, ...(deltaPath ? [deltaPath] : [])],
        template: ticket.reviewerTemplate || null,
        onReply: (msg) => {
          const m = String(msg == null ? '' : msg);
          // An unbriefed reviewer arrives on the SUCCESS reply, so it needs its own test; the error branch never sees it.
          if (/boots UNBRIEFED/.test(m)) {
            this._stampVerifyPhase(team, ticketId, null);
            // keepHold: the seat spawned and carries reviewTicket, so a late verdict still lands on the ticket instead of reaching the lead as raw text.
            this._escalateTicket(team, ticketId, 'review: spawn', m,
              'verify passed, the diff was written and a reviewer seat WAS spawned — but without its role prompt it may never emit a verdict',
              { keepHold: true });
            return;
          }
          if (/^error:/i.test(m)) {
            this._stampVerifyPhase(team, ticketId, null);
            this._escalateTicket(team, ticketId, 'review: spawn', m,
              'verify passed and the diff was written; the reviewer spawn was refused');
            return;
          }
          this._stampVerifyPhase(team, ticketId, null);
          log.info('intent', `ticket ${ticketId} review spawned: ${m}`);
        },
      });
    },

    // Deliver before clearing `loopStep`: clearing first drops the ticket from the sweep's in-flight test, so an undelivered escalation is never surfaced.
    // keepHold is for arms whose reviewer seat is live: releasing the hold there makes its later verdict fail `_landVerdictOnTicket`'s guard.
    _escalateTicket(team, ticketId, step, evidence, tried, { keepHold = false, recovery = null } = {}) {
      try {
        const body = [
          `[ticket ${ticketId} ESCALATED] the loop stopped at: ${step}`,
          '',
          `EVIDENCE: ${defuseSenderLines(evidence)}`,
          `ALREADY TRIED: ${defuseSenderLines(tried)}`,
          '',
          NOTHING_TORN_DOWN,
          ...(recovery ? ['', `RECOVERY: ${recovery}`] : []),
        ].join('\n');
        let disposition = null;
        let returned = false;
        let released = null;
        const onDisposition = (d) => {
          disposition = d || 'injected';
          if (!returned || disposition !== 'parked') return;
          log.info('ticket', `ticket ${ticketId} escalation at ${step} parked for ${team.lead} after the queue returned`);
          if (keepHold || !released) return;
          try {
            const tickets = ticketsStore.load(team.root);
            const rec = tickets.find((t) => t.id === ticketId);
            if (!rec || rec.state !== 'done' || rec.loopStep || rec.acceptedAt || rec.closedOut) return;
            rec.loopStep = released;
            ticketsStore.save(team.root, tickets);
            released = null;
            this._watchParkedEscalation(team, ticketId);
          } catch (e) {
            log.error('ticket', `ticket ${ticketId} late-parked escalation could not re-hold: ${e.message}`);
          }
        };
        const r = this._gatedDeliver(team.lead, 'ticket-loop', body, true, `[ticket ${ticketId} ESCALATED]`, onDisposition, { parkBehindQueue: true });
        returned = true;
        const parked = !!(r && (r.parked || (r.queued && disposition === 'parked')));
        const reached = !!(r && r.queued) && !parked;
        // Keep the undelivered-hold and keepHold reasons as separate branches: only an undelivered escalation is a failure to log.
        if (reached) {
          if (!keepHold) {
            released = (this._loadTicket(team, ticketId) || {}).loopStep || null;
            this._setLoopStep(team, ticketId, null);
          }
        } else if (parked) {
          if (!keepHold) this._watchParkedEscalation(team, ticketId);
          log.info('ticket', `ticket ${ticketId} escalation at ${step} parked for ${team.lead}`);
        } else {
          const why = (r && (r.error || r.held)) || 'unknown delivery failure';
          const parked = this._stampEscalationUndelivered(team, ticketId, step, body);
          log.error('ticket', parked
            ? `ticket ${ticketId} escalation at ${step} did NOT reach ${team.lead} (${why}) — stamped escalationUndelivered so the stall sweep re-surfaces it once ${team.lead} is reachable`
            : `ticket ${ticketId} escalation at ${step} did NOT reach ${team.lead} (${why}) — loopStep kept so the watchdog re-surfaces it`);
        }
        this._broadcast('ipc-message', { type: 'task', from: 'ticket-loop', to: team.lead, body: `ticket ${ticketId} escalated: ${step}` });
        log.info('intent', `ticket ${ticketId} escalated at ${step}: ${evidence}`);
      } catch (e) {
        log.error('ticket', `escalation for ${ticketId} failed: ${e.message}`);
      }
    },

    _watchParkedEscalation(team, ticketId) {
      const lead = this.sessions.get(team.lead);
      if (!lead) return;
      let rec = null;
      try { rec = ticketsStore.load(team.root).find((t) => t.id === ticketId) || null; } catch {}
      if (!rec || !rec.loopStep) return;
      (lead._parkedEscalations || (lead._parkedEscalations = new Map())).set(ticketId, { team, step: rec.loopStep });
    },

    _releaseDrainedEscalations(s) {
      if (typeof parkedTexts !== 'function') return;
      const texts = parkedTexts(PENDING_DIR, s.name);
      for (const [ticketId, { team, step }] of Array.from(s._parkedEscalations)) {
        const tag = `[ticket ${ticketId} ESCALATED]`;
        if (texts.some((t) => t.includes(tag))) continue;
        s._parkedEscalations.delete(ticketId);
        let rec = null;
        try { rec = ticketsStore.load(team.root).find((t) => t.id === ticketId) || null; } catch {}
        if (!rec || rec.loopStep !== step) continue;
        this._setLoopStep(team, ticketId, null);
        log.info('ticket', `ticket ${ticketId} parked escalation drained by ${s.name} — loopStep ${step} released`);
      }
    },

    // Never resolve through `_ticketAssigneeSeat` (first live seat in map order) and never bill the lead's whole-project ledger.
    // A declared unknown costs one row; a guessed seat publishes a foreign ledger that nothing downstream can tell from a measurement.
    _costSeatResolve(team, ticket) {
      const mintedFor = (entry) => mintedForTicket(entry, ticket);
      const at = (name, attribution) => {
        const entry = (name && getPersistence().get(name)) || null;
        // Keep the name when the record is gone: it is still the join key to the seat's other artifacts.
        if (!entry) return { seatName: name || null, entry: null, attribution: 'unknown' };
        return { seatName: name, entry, attribution: mintedFor(entry) ? attribution : 'seat-lifetime' };
      };
      const assignee = ticket && ticket.assignee;
      if (!assignee) return { seatName: null, entry: null, attribution: 'unknown' };
      const isRole = !!(team.roles && Object.prototype.hasOwnProperty.call(team.roles, assignee));
      if (!isRole) {
        // A delivery-time pin names the dead seat once a sibling holding the degraded role closes the ticket,
        // so billing it publishes the wrong seat's lifetime ledger; resolve to unknown instead.
        const closedBy = ticket.closedBy;
        if (ticket.role && closedBy && closedBy !== team.lead && closedBy !== assignee
            && matchSeatRole(team, closedBy) === ticket.role) {
          return { seatName: null, entry: null, attribution: 'unknown' };
        }
        // The lead closing a replay-inherited ticket skips the closer test above, and replay stamps deliveredTo without re-pinning,
        // so a deliveredTo that disagrees with the pin is the only sign another seat did the work.
        const deliveredSeat = ticket.deliveredTo && ticket.deliveredTo.seat;
        if (deliveredSeat && deliveredSeat !== assignee) {
          return { seatName: null, entry: null, attribution: 'unknown' };
        }
        return at(assignee, 'seat');
      }
      const closedBy = ticket.closedBy;
      // deliveredTo only falsifies: its absence is not disagreement, since most closed tickets lack it.
      const delivered = ticket.deliveredTo && ticket.deliveredTo.seat;
      if (closedBy && closedBy !== team.lead && matchSeatRole(team, closedBy) === assignee
          && !(delivered && delivered !== closedBy)) {
        return at(closedBy, 'role-closer');
      }
      return { seatName: null, entry: null, attribution: 'unknown' };
    },

    _costSeatFor(team, ticket) {
      const r = this._costSeatResolve(team, ticket);
      const stamps = (ticket && Array.isArray(ticket.seatReplacements)) ? ticket.seatReplacements : [];
      const ids = entrySessionIds(r.entry);
      if (!stamps.length || !r.entry) return { ...r, sessionIds: ids };
      const seen = new Set(ids);
      for (const stamp of stamps) {
        const prev = stamp && stamp.prev;
        if (!prev || prev === r.seatName) continue;
        let rec = null;
        try { rec = getPersistence().get(prev); } catch { rec = null; }
        if (!rec) return { seatName: r.seatName, entry: null, attribution: 'unknown', sessionIds: [] };
        for (const id of entrySessionIds(rec)) if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
      return { ...r, sessionIds: ids };
    },

    // Written even with an empty ledger: the waste counters must record a ticket that burned a worktree and produced nothing.
    // The taskDir is resolved, not trusted: written verbatim, a literal `~` is mkdir -p'd under the process cwd.
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
        // An escaping taskDir is refused, not redirected to a safer path where nobody looks.
        log.info('intent', `COST.json refused for ${ticket.id}: ${e.message}`);
        return;
      }
      if (!taskDir) return;
      setImmediate(async () => {
        try {
          const { seatName, entry, attribution, sessionIds } = this._costSeatFor(team, ticket);
          const seatResolved = !!entry;
          let totals = null;
          try {
            totals = JSON.parse(fs.readFileSync(path.join(getUserDataPath(), 'wire-totals.json'), 'utf8'));
          } catch { /* no ledger yet — the rollup degrades to its waste half */ }
          const ledger = teamCost.sumSessions(totals, sessionIds);
          ledger.ids = sessionIds;

          // The record's tree counts only for attribution 'seat'; on any other resolution it is whatever the seat holds now
          // and would report another branch's commits.
          const wt = ticket.worktree || (attribution === 'seat' && entry && entry.worktree) || null;
          let commits = null;
          let commitsBase = null;
          if (wt && wt.branch) {
            try {
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
                // git prints realpath'd paths while records keep the path as created (/tmp vs /private/tmp); a raw compare calls a live tree an orphan.
                real: (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } },
              });
            }
          } catch { /* sweep failure costs counter (b), not the record */ }

          const rec = teamCost.costRecord({
            // `seat` is the resolved name: a role-assigned ticket's assignee ('hand') names no seat and cannot join to the spend.
            ticket: { ...ticket, assignee: seatName || null, wireLabel: (entry && entry.wireLabel) || null },
            team: team.name, ledger, worktree: wt, commits, commitsBase,
            orphans, seatResolved, attribution,
          });
          ensureDir(taskDir);
          fs.writeFileSync(path.join(taskDir, teamCost.COST_FILE), JSON.stringify(rec, null, 2));
          this._appendTeamLedger(team, teamCost.ticketLedgerRow(rec));
        } catch (e) {
          log.info('intent', `COST.json not written for ${ticket && ticket.id}: ${e.message}`);
        }
      });
    },

    _taskReject(session, team, intent, reply, ack = reply) {
      const reason = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can reject a ticket${this._spillRejectedPayload(session, 'task reject', reason)}`); return; }
      if (!intent.id) { reply(`error: reject needs a ticket id — [agent:task reject <id>] <reason>${this._spillRejectedPayload(session, 'task reject', reason)}`); return; }
      if (!reason) { reply('error: reject needs a reason — [agent:task reject <id>] <what to fix>'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task reject', reason)}`); return; }
      if (ticket.state !== 'done') {
        if (ticket.state === 'open' && Number(ticket.reworkRound) > 0) {
          this._taskRejectFollowUp(session, team, tickets, ticket, reason, reply);
          return;
        }
        reply(`error: reject reopens a DONE ticket; ${intent.id} is ${ticket.state}${this._spillRejectedPayload(session, 'task reject', reason)}`);
        return;
      }
      const wasClosedOut = !!ticket.closedOut;
      const wasAccepted = !!ticket.acceptedAt;
      ticket.state = 'open';
      recordEvent(ticket, { kind: 'reject', by: session.name });
      ticket.closedAt = null;
      ticket.closedBy = null;
      // Drop closedOut on reopen: `ticketTerminalReason` reads it and would refuse a reminder binding on the rework round.
      delete ticket.closedOut;
      // Drop loopClosedOut and the accept stamp: `_finishAccept` writes both on tree-keeping arms, and left behind they make
      // `task accept` a no-op on the next round's tree.
      delete ticket.loopClosedOut;
      delete ticket.acceptedAt;
      delete ticket.acceptedBy;
      delete ticket.acceptNote;
      delete ticket.closeOutError;
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;
      ticket.reworkRound = (Number(ticket.reworkRound) || 0) + 1;
      // Append after the bump: the reason belongs to the round it opens, not the one that just ended.
      appendReworkReason(ticket, { round: ticket.reworkRound, by: session.name, reason });
      // Reopening ends the loop's hold as accept does: a stale step would let a late verdict land on a ticket the lead sent back.
      delete ticket.loopStep;
      // A reopened ticket owes no check to the verify stamp; a surviving stamp alarms about an escalation on a ticket being worked.
      delete ticket.verifyHold;
      delete ticket.mergedNudgedAt;
      delete ticket.escalationUndelivered;
      delete ticket.mergeError;
      const cancelsMerge = ticket.verdict === 'ACCEPT';
      delete ticket.mergeWaiting;
      const seat = this._ticketAssigneeSeat(team, ticket);
      const rework = (seat && seat !== team.lead)
        ? this._reworkSeatFor(team, ticket, seat, this._redirectDeliveryText(ticket.id, 'rejected', reason))
        : { seat, replaced: false };
      ticketsStore.save(team.root, tickets);
      this._retireReviewSeatsFor(team, ticket.id, 'rejected');
      if (seat && seat !== team.lead && !rework.replaced) {
        this._gatedDeliver(seat, session.name, this._redirectDeliveryText(ticket.id, 'rejected', reason), true,
          `[ticket ${ticket.id} rejected] close with ${ticketCloseVerb(ticket.id)}`,
          (disposition, why) => this._armSpecConfirm(seat, ticket.id, disposition,
            { label: 'rejected', reason, from: session.name }, why));
      }
      const replaced = this._seatReplacedClause(rework);
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} rejected${replaced}` });
      log.info('intent', `task reject ${ticket.id} by ${session.name} → reopened${replaced}`);
      if (cancelsMerge) log.info('ticket', `task reject ${ticket.id}: the round ${ticket.reviewRound} ACCEPT is stale — its queued auto-merge will not run, and the rework's next task done is reviewed again`);
      const archivedSeat = !seat && wasClosedOut && wasAccepted && !ticket.worktree
        ? ` — NOTE: no live seat; its one-shot seat ${this._acceptSeatFacts(ticket).seatName || 'the seat'} was archived at close-out. Resume it from the sidebar, or [agent:task assign ${ticket.id} ${ticket.role || ticket.assignee || '<role>'}] to mint a fresh one.`
        : '';
      ack(`ticket ${ticket.id} reopened (rework) → ${ticket.role || ticket.assignee || 'unassigned'}${replaced}${archivedSeat}`);
    },

    // Gated to `open` because respec delivers: re-dispatching a done or accepted ticket restarts work without reopening it.
    // Not folded into reject, whose body only undoes a close and would make one verb mean two things.
    _taskRespec(session, team, intent, reply, ack = reply) {
      const spec = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can respec a ticket${this._spillRejectedPayload(session, 'task respec', spec)}`); return; }
      if (!intent.id) { reply(`error: respec needs a ticket id — [agent:task respec <id>] <new spec>${this._spillRejectedPayload(session, 'task respec', spec)}`); return; }
      if (!spec) { reply('error: respec needs a new spec — [agent:task respec <id>] <the corrected spec>'); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task respec', spec)}`); return; }
      if (ticket.state !== 'open') {
        // The advice reads the hold's recovery class, not its presence: reject-then-respec is the false rejection for a `hand` hold
        // and the only route for a `spec` one.
        const route = ticket.state === 'done'
          ? (ticket.verifyHold && ticket.verifyHold.recovery !== 'spec'
            ? ` — it is held at "${ticket.verifyHold.step}"; ${holdRecoveryText(ticket.verifyHold.recovery, intent.id)}`
            : ` — reject it first ([agent:task reject ${intent.id}]), then respec`)
          : '';
        reply(`error: respec replaces the spec of an OPEN ticket; ${intent.id} is ${ticket.state}${route}${this._spillRejectedPayload(session, 'task respec', spec)}`);
        return;
      }
      const prevTitle = ticket.title;
      const prevSpec = ticket.spec;
      if (!Array.isArray(ticket.respecs)) ticket.respecs = [];
      const respecAt = Date.now();
      ticket.respecs.push({ at: respecAt, by: session.name, title: prevTitle, spec: prevSpec });
      recordEvent(ticket, { at: respecAt, kind: 'respec', by: session.name });
      ticket.spec = spec;
      ticket.title = ticketTitle(spec);
      const hadTaskDir = !!ticket.taskDir;
      const taskDir = extractTaskDir(spec);
      if (taskDir) ticket.taskDir = taskDir; else delete ticket.taskDir;
      ticket.lastActivityAt = Date.now();
      ticket.nudgedAt = null;
      ticketsStore.save(team.root, tickets);
      // Deliver only when ticketStarted: an unstarted ticket's assignee is a role key that `_ticketAssigneeSeat` resolves to the
      // first live sibling, so a parked-only gate hands the spec to a hand mid-work elsewhere.
      const dispatched = ticketStarted(ticket) && !ticket.parked;
      const d = dispatched
        ? this._deliverTicketSpec(team, ticket, ticket.spec, session.name, true, false, true)
        : { undelivered: true };
      this._reconcileTickets(team);
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} respec'd` });
      log.info('intent', `task respec ${ticket.id} by ${session.name} → spec replaced${dispatched ? ', re-dispatched' : ', not dispatched'}`);
      const target = ticket.role || ticket.assignee || 'unassigned';
      // Name `assign`, not `start`, for a backlog or already-started ticket: `_taskStart` bounces both,
      // and an unusable recovery is the failure this reply exists to avoid.
      const sendVerb = (!ticket.assignee || ticketStarted(ticket))
        ? `[agent:task assign ${ticket.id} ${this._resolvableAssignTarget(team, ticket)}]`
        : `[agent:task start ${ticket.id}]`;
      const deliveryNote = (ticket.parked || !dispatched) ? '' : this._ticketDeliverySuffix(d, target, team, ticket);
      const note = ticket.parked
        ? ` (parked — spec replaced, NOT dispatched; ${sendVerb} sends it)`
        : !dispatched
          ? ` (not started — spec replaced, NOT dispatched; ${sendVerb} sends it)`
          : deliveryNote;
      const dirNote = (hadTaskDir && !ticket.taskDir)
        ? ` — NOTE: the previous spec named a tasks/… dir and this one does not, so the artifact link was dropped`
        : '';
      (deliveryNote || dirNote ? reply : ack)(`ticket ${ticket.id} respec'd → ${target}${note}${dirNote}`);
    },

    _taskCancel(session, team, intent, reply, ack = reply) {
      const reason = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can cancel a ticket${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      if (!intent.id) { reply(`error: cancel needs a ticket id — [agent:task cancel <id>] [reason]${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      if (ticket.state !== 'open') { reply(`error: ticket ${intent.id} is ${ticket.state}, not open — cannot cancel${this._spillRejectedPayload(session, 'task cancel', reason)}`); return; }
      ticket.state = 'cancelled';
      ticket.closedAt = Date.now();
      ticket.closedBy = session.name;
      ticket.lastActivityAt = ticket.closedAt;
      recordEvent(ticket, { at: ticket.closedAt, kind: 'cancel', by: session.name, reason: reason.split('\n')[0] });
      ticketsStore.save(team.root, tickets);
      const seat = ticketStarted(ticket) && !ticket.parked ? this._ticketAssigneeSeat(team, ticket) : null;
      if (seat && seat !== team.lead) this._gatedDeliver(seat, session.name, `[ticket ${ticket.id} cancelled] ${reason || 'cancelled by the lead — stop work on it'}`, false, `[ticket ${ticket.id} cancelled]`);
      this._reconcileTickets(team);
      const adv = {};
      const next = seat ? this._advanceSeat(team, seat, ticket, adv) : null;
      this._broadcast('ipc-message', { type: 'task', from: session.name, to: ticket.assignee || '(unassigned)', body: `ticket ${ticket.id} cancelled` });
      this._writeTicketCost(team, ticket);
      log.info('intent', `task cancel ${ticket.id} by ${session.name}`);
      const dropped = this._cancelTicketReminders(session.name, ticket.id);
      const nextSuffix = next ? this._ticketDeliverySuffix(adv.d || {}, seat, team, next) : '';
      (nextSuffix ? reply : ack)(`ticket ${ticket.id} cancelled${next ? ` — next: ${next.id} delivered to ${seat}${nextSuffix}` : ''}${dropped ? ` ${dropped}` : ''}`);
    },

    // Called from accept and cancel only: a reject reopens a done ticket and its reminder is wanted through the rework round.
    // Never throws into a close path.
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

    _stampTicketRevival(team, seatName, extra = null, ticketId = null) {
      if (!team || !team.root || !seatName) return null;
      let rec = null;
      try { rec = getPersistence().get(seatName); } catch { rec = null; }
      let tickets;
      try { tickets = ticketsStore.load(team.root); } catch { return null; }
      // `ticketId != null`, not truthiness: a falsy id is a caller bug and must fail closed (match nothing)
      // rather than fall back to the ambiguous seat-name lookup.
      const ticket = ticketId != null
        ? tickets.find((t) => t.id === ticketId && !t.revival)
        : tickets.find((t) => t.assignee === seatName && !t.revival);
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

    // The branch comes from the seat's record, not the ticket id, whose title slug a guess cannot rebuild;
    // ephemeralSeat reads the record, never the agent-writable role def.
    _acceptSeatFacts(ticket) {
      const seatName = ticket.assignee || null;
      let rec = null;
      try { rec = seatName ? getPersistence().get(seatName) : null; } catch { rec = null; }
      const branch = (rec && rec.worktree && rec.worktree.branch) || (ticket.worktree && ticket.worktree.branch) || null;
      return { seatName, rec, branch, ephemeralSeat: !!(rec && rec.ephemeral) };
    },

    _finishAccept(team, ticket, tickets, { by, note, seatName, msg, closedOut, complete, actedStamp }) {
      ticket.acceptedAt = Date.now();
      ticket.acceptedBy = by;
      const acceptEvent = recordEvent(ticket, { at: ticket.acceptedAt, kind: 'accept', by: String(by || 'ticket-loop'), closedOut: !!closedOut });
      if (closedOut) ticket.closedOut = true;
      // Stamped only where the loop left nothing to finish; it carries the text because the tree is gone by then.
      const loopClosed = complete && by === 'ticket-loop'
        ? { at: ticket.acceptedAt, text: msg } : null;
      if (loopClosed) ticket.loopClosedOut = loopClosed;
      if (note) ticket.acceptNote = note;
      ticket.lastActivityAt = ticket.acceptedAt;
      // Accept ends the loop's hold on both copies: a surviving loopStep lets a late verdict through `_landVerdictOnTicket`'s
      // done+loopStep arm and stamps a rework on merged, deleted work.
      delete ticket.loopStep;
      // The verify hold goes too: accepting overrules the check, and a surviving stamp keeps alarming on accepted work.
      delete ticket.verifyHold;
      // Clear mergeError only when closedOut and only if it still equals actedStamp: the gate is closedOut, not "invites another accept",
      // and a stamp that landed mid-accept is still true and must survive.
      if (closedOut && ticket.mergeError && String(ticket.mergeError) === actedStamp) delete ticket.mergeError;
      // mergeWaiting is cleared here too because `_autoMergeTicket`'s finally declines to on a deferring pass, and a crash then freezes it onto an accepted row.
      // Unconditional, unlike mergeError: it has one writer and one value, so a compare cannot tell a stamp this accept never saw.
      if (closedOut) delete ticket.mergeWaiting;
      // Re-read: the teardown stamped revival onto its own copy.
      const fresh = ticketsStore.load(team.root);
      const row = fresh.find((t) => t.id === ticket.id);
      if (row) {
        row.acceptedAt = ticket.acceptedAt;
        row.acceptedBy = ticket.acceptedBy;
        recordEvent(row, acceptEvent);
        if (closedOut) row.closedOut = true;
        if (loopClosed) row.loopClosedOut = loopClosed;
        if (note) row.acceptNote = note;
        row.lastActivityAt = ticket.lastActivityAt;
        delete row.loopStep;
        delete row.verifyHold;
        if (closedOut && row.mergeError && String(row.mergeError) === actedStamp) delete row.mergeError;
        // Clear on both copies: `fresh` saves on this path, the `ticket` snapshot on the else branch.
        if (closedOut) delete row.mergeWaiting;
        ticketsStore.save(team.root, fresh);
      } else {
        ticketsStore.save(team.root, tickets);
      }
      // Retire reviewers here, not per arm: `!m.ok` and `!m.merged` end the review round as terminally as the closing arms,
      // and the arms' teardowns target the assignee, never a reviewer seat.
      this._retireReviewSeatsFor(team, ticket.id, 'accepted');
      this._broadcast('ipc-message', { type: 'task', from: by, to: seatName || '(unassigned)', body: `ticket ${ticket.id} accepted` });
      if (msg != null) log.info('intent', `task accept ${ticket.id} by ${by}: ${msg}`);
      // Gated on closedOut: cancelling on the arms that invite another accept drops "check the branch landed" from the message saying it is not shown.
      const dropped = closedOut ? this._cancelTicketReminders(team.lead, ticket.id) : '';
      if (msg == null) return dropped;
      return dropped ? `${msg} ${dropped}` : msg;
    },

    async _closeOutBranchless(team, ticket, tickets, { by, note }) {
      if (!this._closingOut) this._closingOut = new Set();
      const key = `${team.root}\0${ticket.id}`;
      if (this._closingOut.has(key)) {
        return { archived: false, already: true,
          text: `ticket ${ticket.id} was already accepted at ${new Date(ticket.acceptedAt || Date.now()).toLocaleTimeString()} — nothing was changed` };
      }
      this._closingOut.add(key);
      try {
        const { seatName, ephemeralSeat } = this._acceptSeatFacts(ticket);
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true }, ticket.id);
        const dropped = this._finishAccept(team, ticket, tickets, {
          by, note, seatName, closedOut: true, complete: false,
          actedStamp: (ticket.mergeError && String(ticket.mergeError)) || null,
          msg: null,
        });
        let archived = false;
        let archiveError = null;
        const busy = seatName ? this._openTicketsFor(team, seatName, ticket.id) : [];
        const held = busy.length > 0 ? busy[0].id : null;
        if (!held && ephemeralSeat && seatName && this.sessions.has(seatName)) {
          try { await this.archive(seatName); archived = true; } catch (e) { archiveError = e; }
        }
        this._stampCloseOutError(team, ticket, archiveError);
        const msg = held
          ? `ticket ${ticket.id} accepted — no ticket branch recorded, so nothing was removed; ${seatName} was left in place because it holds ${held}`
          : archived
          ? `ticket ${ticket.id} accepted — no ticket branch recorded (it worked in the shared checkout), so nothing was removed; ${seatName} was a one-shot seat and was ARCHIVED (resumable from the sidebar; anything it left uncommitted is still in the checkout)`
          : archiveError
            ? `ticket ${ticket.id} accepted — no ticket branch recorded, so nothing was removed; archiving the one-shot seat ${seatName} failed (${String(archiveError.message || archiveError).split('\n')[0]}) — [agent:task accept ${ticket.id}] retries`
            : `ticket ${ticket.id} accepted — no ticket branch recorded, so nothing was torn down${seatName ? ` (${seatName} left as it is)` : ''}`;
        log.info('intent', `task accept ${ticket.id} by ${by}: ${msg}`);
        return { archived, archiveError, held, text: dropped ? `${msg} ${dropped}` : msg };
      } finally {
        this._closingOut.delete(key);
      }
    },

    _stampCloseOutError(team, ticket, err) {
      const why = err ? String(err.message || err).split('\n')[0] : null;
      if (!why && !ticket.closeOutError) return;
      if (why) ticket.closeOutError = why; else delete ticket.closeOutError;
      const fresh = ticketsStore.load(team.root);
      const row = fresh.find((t) => t.id === ticket.id);
      if (!row) return;
      if (why) row.closeOutError = why; else delete row.closeOutError;
      ticketsStore.save(team.root, fresh);
    },

    async _taskAccept(session, team, intent, reply, ack = reply) {
      const note = String(intent.body == null ? '' : intent.body).trim();
      if (team.lead !== session.name) { reply(`error: only the team lead (${team.lead}) can accept a ticket${this._spillRejectedPayload(session, 'task accept', note)}`); return; }
      if (!intent.id) { reply(`error: accept needs a ticket id — [agent:task accept <id>] [note]${this._spillRejectedPayload(session, 'task accept', note)}`); return; }
      const tickets = ticketsStore.load(team.root);
      const ticket = tickets.find((t) => t.id === intent.id);
      if (!ticket) { reply(`error: no ticket ${intent.id} on ${team.name}${this._spillRejectedPayload(session, 'task accept', note)}`); return; }
      if (ticket.state !== 'done') { reply(`error: accept closes out a DONE ticket; ${intent.id} is ${ticket.state} — it has not been reported yet${this._spillRejectedPayload(session, 'task accept', note)}`); return; }

      // Gated on `loopClosedOut`, not `closedOut && acceptedBy`, which also hold for the dirty-tree downgrade whose reply asks for a second accept.
      if (ticket.loopClosedOut) {
        const at = new Date(ticket.loopClosedOut.at).toLocaleTimeString();
        reply(`ticket ${ticket.id} was already closed out by the loop at ${at}: ${closeOutDetail(ticket.id, ticket.loopClosedOut.text)}`
          + ` Nothing was changed.${this._spillRejectedPayload(session, 'task accept', note)}`);
        return;
      }

      const { branch } = this._acceptSeatFacts(ticket);

      // No branch means the main checkout: acceptance is the stamp alone, and a standing seat is never retired there.
      // A one-shot spawn seat is archived, never destroyed, since its work may be uncommitted in the shared checkout.
      if (!branch) {
        if (ticket.closedOut && ticket.acceptedAt && !ticket.closeOutError) {
          reply(`ticket ${ticket.id} was already accepted at ${new Date(ticket.acceptedAt).toLocaleTimeString()} — nothing was changed${this._spillRejectedPayload(session, 'task accept', note)}`);
          return;
        }
        ack((await this._closeOutBranchless(team, ticket, tickets, { by: session.name, note })).text);
        return;
      }

      const r = await this._closeOutMergedTicket(team, ticket, tickets, { by: session.name, note });
      (r.merged ? ack : reply)(r.text);
    },

    async _closeOutMergedTicket(team, ticket, tickets, { by, note = '' }) {
      // Checked here as well as at the call site: the loop never enters `_taskAccept`, so its state refusal is no gate.
      // One-sided, since a lead accept over a loop close-out is the dirty-row recovery.
      if (by === 'ticket-loop' && ticket.state !== 'done') {
        return { ok: false, closedOut: false, reopened: true, state: ticket.state,
          text: `the ticket was reopened (${ticket.state}) before the loop could close it out, so the seat, worktree and branch were left alone` };
      }
      if (by === 'ticket-loop' && (ticket.acceptedAt || ticket.closedOut)) {
        return { ok: true, closedOut: true, already: true,
          text: `ticket ${ticket.id} accepted — ${ticket.acceptedBy || 'the lead'} accepted it first; the loop changed nothing` };
      }
      const { seatName, rec, branch, ephemeralSeat } = this._acceptSeatFacts(ticket);
      // What this accept acted on, for the compare-and-clear in `_finishAccept`; a plain let because `mergeStamp` below
      // is in its temporal dead zone on the two arms that finish before it.
      let actedStamp = (ticket.mergeError && String(ticket.mergeError)) || null;
      const finish = (msg, closedOut = false, complete = false, merged = false) => ({
        ok: !!complete,
        merged: !!merged,
        closedOut: !!closedOut,
        text: this._finishAccept(team, ticket, tickets, { by, note, seatName, msg, closedOut, complete, actedStamp }),
      });

      const m = await gitWorktree.isMerged(team.root, branch).catch((e) => ({ ok: false, error: e.message }));

      // Re-check in both directions: whichever side passed its entry gate first, the other can still enter this await and both tear down.
      {
        const now = this._loadTicket(team, ticket.id);
        if (now && by === 'ticket-loop' && now.state !== 'done') {
          return { ok: false, closedOut: false, reopened: true, state: now.state,
            text: `the ticket was reopened (${now.state}) while this close-out was running, so the seat, worktree and branch were left alone` };
        }
        if (now && by === 'ticket-loop' && now.acceptedAt && now.acceptedBy !== 'ticket-loop') {
          return { ok: true, closedOut: true, already: true,
            text: `ticket ${ticket.id} accepted — ${now.acceptedBy} accepted it while this close-out was running; the loop changed nothing` };
        }
        if (now && by !== 'ticket-loop' && now.loopClosedOut) {
          return { ok: true, closedOut: true, already: true,
            text: `ticket ${ticket.id} accepted — the loop closed it out while this accept was running; nothing was changed` };
        }
      }

      let archivedSeat = false;
      const seatClause = (archivedWord) => {
        if (!seatName) return 'its ';
        if (archivedSeat) return `${seatName} was ${archivedWord}, and its `;
        // Not "already archived": a gone ephemeral seat may have exited on its own, and this sentence must not assert a teardown nobody can point at.
        if (ephemeralSeat) return `${seatName} is not running, so nothing was archived, and its `;
        // Liveness is separate from whose seat it is: a standing seat that exited keeps its record and a bare role key has none,
        // so an unconditional "left running" may describe a seat that does not exist.
        if (!this.sessions.has(seatName)) return `${seatName} is not running, and its `;
        // Split on `rec`: a live seat with no record is `ephemeralSeat === false` by absence of evidence,
        // and only a record can carry "not a one-shot ticket seat".
        if (!rec) return `${seatName} was left running, and its `;
        return `${seatName} was left running (not a one-shot ticket seat), and its `;
      };
      const archiveIfEphemeral = async () => {
        if (ephemeralSeat && seatName && this.sessions.has(seatName)) {
          await this.archive(seatName);
          archivedSeat = true;
        }
      };

      if (!m.ok) {
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true }, ticket.id);
        await archiveIfEphemeral();
        // Not terminal (no `closedOut`): the reply invites another accept, so a reminder bound to the ticket is still wanted.
        return finish(`ticket ${ticket.id} accepted, but the merge check could NOT run for branch ${branch} (${m.error || 'unknown error'}) — treated as NOT merged: `
          + `${seatClause('archived')}worktree and branch were KEPT. Nothing was removed.`);
      }

      if (!m.merged) {
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true }, ticket.id);
        await archiveIfEphemeral();
        // Not terminal, same reasoning: cancelling a bound reminder in the message reporting that the branch did not land is the worst moment for it.
        return finish(`ticket ${ticket.id} accepted, but branch ${branch} is NOT merged into ${m.base} — `
          + `${seatClause('archived (resumable)')}worktree and branch were KEPT. `
          + `Merge it, then [agent:task accept ${ticket.id}] again to clean up.`);
      }

      // Counted before the teardown, and gating it only in the veto below: `isMerged` alone calls a branch still at its base merged,
      // so the count is what separates landed from never committed.
      const baseSha = (rec && rec.worktree && rec.worktree.baseSha)
        || (ticket.worktree && ticket.worktree.baseSha) || null;
      const c = await gitWorktree.commitsOnBranch(team.root, branch, baseSha)
        .catch((e) => ({ ok: false, count: null, error: e.message }));

      // A zero count means empty only when measured against the recorded fork point: with no baseSha commitsOnBranch falls back to a merge-base,
      // which for an already-merged branch is its tip, so that case is undecidable and gets its own sentence.
      const measured = c.ok && baseSha && c.base === String(baseSha).trim();

      // A function, not a binding: on the `!c.ok` arm `c.base` is undefined and an eager string would report "counted against undefined".
      // Defined here because the veto arm below needs the same sentence.
      const why = () => (baseSha
        ? `its recorded fork point ${baseSha} no longer resolves, so its commits could only be counted against ${c.base}`
        : `no fork point was recorded, so its commits could only be counted against ${c.base}`);

      const freshTicket = this._loadTicket(team, ticket.id) || ticket;
      const mergeStamp = (freshTicket.mergeError && String(freshTicket.mergeError)) || null;
      actedStamp = mergeStamp;
      if (mergeStamp && !(c.ok && measured && c.count === 0)) {
        // No `mergedInto`: this arm exists because the merge cannot be shown. `mergeVetoed` on the revival stamp is the only durable trace
        // that a check is still owed once this terminal arm clears the mark.
        if (seatName) this._stampTicketRevival(team, seatName, { accepted: true, mergeVetoed: mergeStamp }, ticket.id);
        try {
          const board = ticketsStore.load(team.root);
          const row = board.find((t) => t.id === ticket.id);
          if (row && row.revival && row.revival.mergeVetoed !== mergeStamp) {
            row.revival.mergeVetoed = mergeStamp;
            row.lastActivityAt = Date.now();
            ticketsStore.save(team.root, board);
          }
        } catch (e) {
          log.error('ticket', `stamping the merge veto trace on ${ticket.id} failed: ${e.message}`);
        }
        await archiveIfEphemeral();
        // Split on `measured`: on this arm an unmeasured count is deterministically 0 (the branch is an ancestor, so the fallback
        // merge-base is its tip), and a lead reads 0 as nothing at stake.
        const carries = !c.ok
          ? `Its commit count could NOT be obtained (${c.error || 'unknown error'}), so how much is at stake is UNKNOWN.`
          : measured
            ? `Its ${c.count} commit${c.count === 1 ? '' : 's'} beyond ${c.base} may be off ${m.base} entirely.`
            : `How much it carries is UNKNOWN: ${why()}, where an empty branch and one already merged both count 0.`;
        // The veto stays broad on purpose: an allowlist would default a later step to not vetoing. Only the sentences narrow,
        // and on revert-blocked the ancestor answer is yes by construction, so it is never offered as evidence of landing.
        const mergeStandsByDesign = mergeStamp === 'revert-blocked';
        const mergeWasReverted = mergeStamp === 'suite';
        const mergeFateUnknown = mergeStamp === 'unexpected';
        const explain = mergeStandsByDesign
          ? `and that step means the loop MERGED and deliberately did not revert — ${m.base} was left carrying it because a suite was running, so it is red or unverified and an undo is still owed.`
          : mergeWasReverted
            ? 'and an ancestor test cannot tell a merge that still stands from one that was reverted: `git revert -m 1` ADDS a commit, so the merge stays an ancestor either way.'
            : mergeFateUnknown
              ? 'and that step is the loop\'s catch-all, which fires whether or not a merge was ever made — so whether one exists at all is unknown, and the ancestor answer does not settle it.'
              : 'and no merge commit came out of that step — either it failed before the merge ran, or the merge left none behind — so the ancestor answer is not evidence from it.';
        const confirm = mergeStandsByDesign
          ? `Do NOT read the ancestor answer as a landing — it is yes by construction here. Decide the revert first: if you still intend to undo it, revert and re-review instead of accepting again`
          : mergeWasReverted
            ? `Confirm by hand that ${m.base} still carries that merge — a revert of it lands as a later \`Revert "Merge …"\` commit`
            : mergeFateUnknown
              ? `Read the escalation for this ticket first — it says whether a merge was made, and names its sha where there is one. Confirm against ${m.base} accordingly`
              : `The loop never merged this branch, so if ${branch} is an ancestor of ${m.base} now, someone merged it by hand — confirm that`;
        // Terminal: nothing the lead does to the repository clears a mergeError, so a non-terminal refusal would re-refuse for ever.
        // The second accept is the way on, and dropping the bound reminders is the cost paid knowingly, as on the dirty-tree arm.
        return finish(`ticket ${ticket.id} accepted — branch ${branch} is an ancestor of ${m.base}, but the merge loop stamped this ticket MERGE FAILED at "${mergeStamp}", `
          + `${explain} `
          + `${carries} Nothing was removed: ${seatClause('archived (resumable)')}worktree and branch were KEPT. `
          + `${confirm} — because this reply ANSWERS the mark, and a second `
          + `[agent:task accept ${ticket.id}] takes the ordinary merged path.`, true);
      }

      // Stamp before the teardown: destroy() drops the record holding the session id. mergedInto is null only for a measured-empty branch;
      // an unmeasured count keeps m.base, since nulling it would assert not-merged from ignorance.
      if (seatName) {
        this._stampTicketRevival(team, seatName,
          { accepted: true, mergedInto: (measured && c.count === 0) ? null : m.base }, ticket.id);
        // Supersede a mergeVetoed left by an earlier accept: the write-once stamp above no-ops on a second accept,
        // and a stale veto trace would outlive the check it asked for.
        try {
          const fresh = ticketsStore.load(team.root);
          const row = fresh.find((t) => t.id === ticket.id);
          if (row && row.revival && (row.revival.mergeVetoed || row.revival.mergedInto === undefined)) {
            if (row.revival.mergeVetoed) row.revival.mergeVetoedClearedAt = Date.now();
            row.revival.accepted = true;
            row.revival.mergedInto = (measured && c.count === 0) ? null : m.base;
            delete row.revival.mergeVetoed;
            row.lastActivityAt = Date.now();
            ticketsStore.save(team.root, fresh);
          }
        } catch (e) {
          log.error('ticket', `clearing the merge veto trace on ${ticket.id} failed: ${e.message}`);
        }
      }

      let removed = null;
      let downgrade = null;
      // No liveness term: `ephemeralSeat` implies a record, and a seat that is merely not running still has a tree to reclaim.
      if (seatName && ephemeralSeat) {
        const wt = rec && rec.worktree && rec.worktree.path ? rec.worktree.path : null;
        if (wt) {
          const d = await gitWorktree.isDirty(wt).catch((e) => ({ ok: false, error: e.message }));
          if (!d.ok) downgrade = { kind: 'unreadable', path: wt, why: d.error || 'git could not read the tree' };
          else if (d.dirty) downgrade = { kind: 'dirty', path: wt };
        }
        if (downgrade) {
          if (this.sessions.has(seatName)) { await this.archive(seatName); downgrade.archived = true; }
        } else {
          const r = await this.destroy(seatName).catch((e) => ({ ok: false, error: e.message }));
          removed = r || null;
        }
      }
      const del = downgrade && downgrade.kind === 'dirty'
        ? { ok: true, skipped: true }
        : await gitWorktree.deleteBranch(team.root, branch).catch((e) => ({ ok: false, error: e.message }));
      const parts = [];
      if (seatName) {
        const kept = downgrade && downgrade.archived
          ? `${seatName} was ARCHIVED, not retired, and its worktree was KEPT`
          : `${seatName} was NOT retired and its worktree was KEPT`;
        if (downgrade && downgrade.kind === 'dirty') {
          // A second accept is not refused here (state stays `done`, a downgrade never stamps `loopClosedOut`), so the recovery is the same verb again.
          parts.push(`${kept} — ${downgrade.path} has uncommitted work `
            + 'that a removal would have deleted. Commit or clear that tree, then '
            + `[agent:task accept ${ticket.id}] again to finish the cleanup`);
        } else if (downgrade) {
          parts.push(`${kept} — ${downgrade.path} could not be inspected `
            + `(${downgrade.why}), and an unreadable tree is not evidence of a clean one. That is usually a tree already removed; `
            + 'if so, delete the session from the sidebar');
        } else if (!ephemeralSeat) {
          // Split on liveness and on `rec` as `seatClause` does: `!ephemeralSeat` alone carries no claim about a seat that exited or has no record.
          parts.push(`${seatName} was ${this.sessions.has(seatName) ? 'LEFT RUNNING' : 'left alone (its session is not running)'} `
            + `and its worktree KEPT — ${rec ? 'it is not a one-shot ticket seat' : 'no record marks it a one-shot ticket seat'}, `
            + 'so acceptance does not retire it or touch its checkout');
        } else {
          parts.push(removed && removed.worktreeRemoved ? `${seatName} retired and its worktree removed`
            : removed && removed.error ? `${seatName} retired but its worktree could NOT be removed (${removed.error})`
              + `${removed.path ? ` — remove ${removed.path} by hand` : ' — remove it by hand'}`
              : `${seatName} retired`);
        }
      }
      // Test `skipped` before `ok`: the skip returns ok:true, and reporting it as deleted sends the lead looking for a ref that is still there.
      parts.push(del.skipped ? `branch ${branch} was KEPT (the accept above is unfinished)`
        : del.ok ? `branch ${branch} deleted`
          : `branch ${branch} could NOT be deleted (${del.error})`);
      // Zero against a fallback is undecidable: empty and already-fast-forwarded count the same, so neither sentence is safe.
      // Name `c.base`, not `baseSha`, which may not be what the count measured against.
      const outcome = !c.ok
        ? `accepted — branch ${branch} is an ancestor of ${m.base}, but its commit count could NOT be obtained (${c.error || 'unknown error'}), so whether it carried any work is UNKNOWN`
        : c.count === 0 && measured
          // Say "torn down as empty" only where the tree was removed: a kept seat or a failed destroy() would make this clause contradict `parts`.
          ? `accepted — branch ${branch} has 0 commits beyond ${c.base}, so NOTHING was merged${removed && removed.worktreeRemoved ? '; it was torn down as empty' : ''}`
          : c.count === 0
            ? `accepted — branch ${branch} is an ancestor of ${m.base}, but ${why()}, where an empty branch and one already merged both count 0 — so whether it carried any work is UNKNOWN`
            : `accepted — merged into ${m.base}`;
      const complete = !!seatName && ephemeralSeat && !downgrade
        && !!removed && removed.ok !== false && removed.worktreeRemoved !== false
        && del.ok === true && !del.skipped;
      try {
        return finish(`ticket ${ticket.id} ${outcome}; ${parts.join('; ')}.`, true, complete, complete && c.ok && c.count > 0);
      } catch (e) {
        log.error('ticket', `accept ${ticket.id} by ${by}: the board save after the teardown failed: ${e.message}`);
        return { ok: false, closedOut: false,
          tornDown: true,
          text: `error: ticket ${ticket.id}: ${parts.join('; ')} — but the board could NOT be updated (${e.message}) — the ticket still reads done and unaccepted` };
      }
    },

    // Deliberately does not deliver on unpark: that is `assign`'s job, and a second delivery path would let the two disagree
    // about what a seat was told.
    _taskPark(session, team, intent, reply, ack = reply) {
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
      ack(parking
        ? `ticket ${ticket.id} parked — held out of dispatch; [agent:task assign ${ticket.id} ${this._resolvableAssignTarget(team, ticket)}] releases it`
        : `ticket ${ticket.id} unparked → ${ticket.role || ticket.assignee || 'backlog'} — the spec was NOT re-sent; use [agent:task assign ${ticket.id} <role|name>] to deliver it`);
    },

    // scripts/clodex-team.js doTickets is a second implementation of this listing and must stay identical: that script is copied flat
    // into run/bin/ and may require node builtins only, so it cannot share this code.
    _taskList(session, team, intent, reply) {
      const filter = intent.filter || 'open';
      if (!TICKET_FILTERS.includes(filter)) {
        reply(`error: unknown filter "${filter}" — use one of: ${TICKET_FILTERS.join(', ')}`);
        return;
      }
      reply(this._taskListText(team, filter, Date.now()));
    },

    _taskListText(team, filter, now) {
      const tickets = ticketsStore.load(team.root).slice().sort((a, b) => {
        const na = Number(String(a.id).replace(/^t/, '')) || 0;
        const nb = Number(String(b.id).replace(/^t/, '')) || 0;
        return na - nb;
      });
      if (!tickets.length) return `no tickets on ${team.name}`;
      const shown = filter === 'all' ? tickets : tickets.filter((t) => t.state === filter);
      // The board shows the role the lead filed the ticket under; `assignee` is a delivery-time pin to a concrete seat,
      // not the name the lead is looking for.
      const shownFor = (t) => t.role || t.assignee || '—';
      const respecMark = (t) => (Array.isArray(t.respecs) && t.respecs.length ? ` (respec'd ×${t.respecs.length})` : '');
      // Render the stored value, not a phrase of the row's own, or the row asserts a state the record does not carry;
      // used on both row shapes because the stamp lands on `done` tickets.
      const mergeWaitingMark = (t) => (t.mergeWaiting ? ` (merge waiting: ${t.mergeWaiting})` : '');
      // Shaped unlike the parenthetical marks beside it on purpose: "needs me" must be told apart from "waiting its turn" without reading words.
      // The stored step renders verbatim, on both row shapes.
      const mergeErrorMark = (t) => (t.mergeError ? ` !! MERGE FAILED: ${t.mergeError}` : '');
      const row = (t) =>
        `${t.id} [${t.state}${t.parked ? ' parked' : ''}] ${shownFor(t)} ${humanizeAge(now - (t.openedAt || now))} — ${t.title || '(untitled)'}${respecMark(t)}${mergeWaitingMark(t)}${mergeErrorMark(t)}`;
      const verifyMark = (t) => {
        if (t.state !== 'done' || t.verifyHold || (t.loopStep !== 'verify' && t.loopStep !== 'review')) return '';
        const vp = t.verifyPhase && typeof t.verifyPhase === 'object' ? t.verifyPhase : null;
        const age = vp && typeof vp.since === 'number' ? ` (${humanizeAge(now - vp.since)})` : '';
        if (vp && vp.phase === 'suite') return Number(vp.run) === 2 ? ` in verify: re-measuring${age}` : ` in verify: suite run 1${age}`;
        if (vp && vp.phase === 'reviewer') return ' in verify: spawning reviewer';
        return ` in verify: review round ${(Number(t.reviewRound) || 0) + 1}`;
      };
      const closedRow = (t) =>
        `${t.id} [${t.state}]${verifyMark(t)} ${shownFor(t)} closed ${humanizeAge(now - t.closedAt)} ago — ${t.title || '(untitled)'}${respecMark(t)}${mergeWaitingMark(t)}${mergeErrorMark(t)}`;
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
        return closed.length
          ? `no open tickets on ${team.name}${recentBlock}${tail}`
          : `no ${filter} tickets on ${team.name}`;
      }
      return `${head}:\n${lines.join('\n')}${recentBlock}${tail}`;
    },

    // Solo boards no-op: their live seats are every agent session in the repo, none
    // enrolled, so reconciling would hand specs to sessions that never opted in.
    _reconcileTickets(team) {
      if (team && team.solo) return;
      const tickets = ticketsStore.load(team.root);
      const live = this._teamLiveSeatNames(team.root);
      for (const name of live) {
        const role = matchSeatRole(team, name);
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
      let team = null; try { team = resolveTeam(w.root || ''); } catch { team = null; }
      // Walk live seats once outside the loop: this runs on every non-idle edge and
      // the team resolve and seat walk are filesystem work.
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
      this._bootRequeue = this._requeueWaitingMerges().catch((e) => log.error('ticket', `boot requeue of waiting merges failed: ${e && e.message ? e.message : String(e)}`));
    },

    _sweepTickets(now = Date.now()) {
      const sweptBoards = new Set();
      const reconciledTeams = new Set();
      const sweeps = [];
      for (const s of this.sessions.values()) {
        if (!s.agentType || s._dead) continue;
        let team; try { team = resolveTeam(s.cwd); } catch { team = null; }
        if (!team) continue;
        if (!sweptBoards.has(team.root)) {
          sweptBoards.add(team.root);
          // Not awaited: a slow git probe must not hold up the badge reconcile;
          // overlap is handled by _stallProbing.
          sweeps.push(this._sweepTeamTickets(team, now).catch((e) => log.error('ticket', `stall sweep failed: ${e.message}`)));
        }
        if (!reconciledTeams.has(team.file)) {
          reconciledTeams.add(team.file);
          this._reconcileTickets(team);
          this._resumeOrphanedVerify(team);
        }
      }
      return Promise.all(sweeps);
    },

    async _stallEvidence(team, ticket) {
      const out = { tool: null, commits: null, dirty: null, apiError: null };
      const seat = this._ticketAssigneeSeat(team, ticket);
      if (seat) {
        try {
          const link = pathFor(REGISTRY_DIR, seat, 'transcript');
          // The wide re-read runs only when the tail named no tool: a later moment
          // for that field beats no field at all.
          const file = fs.realpathSync(link);
          const tail = readTail(fs, file);
          out.tool = lastToolFromFile(fs, file, tail);
          // Measured: the error record sits at most 2957 bytes from EOF (p90 1985),
          // so the 64KB window is not widened for it.
          out.apiError = lastApiErrorFrom(tail);
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

    // Matches on ephemeral + reviewTicket, the fields review-done routes a verdict on,
    // and returns every match: keepHold leaves a round-1 seat live under the same ticket id.
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

    _retireReviewSeatsFor(team, ticketId, why) {
      const retired = [];
      try {
        for (const s of this._liveReviewSeatsFor(team, ticketId)) {
          try {
            this._sendToSession(s.name, 'session:context-action', {
              action: 'retired', name: s.name, disposition: 'discard',
            });
            let rec = null;
            try { rec = getPersistence().get(s.name); } catch { rec = null; }
            const ticket = this._loadTicket(team, ticketId);
            if (rec && ticket) {
              const round = (Number(ticket.reviewRound) || 0) + 1;
              const w = this._writeReviewCost(s.name, team, ticket, rec, round, null, null);
              if (!w.ok) {
                log.warn('ticket', `ticket ${ticketId}: review cost for the ${why} round not captured for ${s.name} (${w.error}) — the seat is about to be reaped, so this round's spend is unrecoverable`);
              }
            } else {
              log.warn('ticket', `ticket ${ticketId}: review cost not captured for ${s.name} (no ${rec ? 'ticket' : 'record'}) — the seat is about to be reaped, so this round's spend is unrecoverable`);
            }
            const r = this.kill(s.name);
            if (r && typeof r.catch === 'function') {
              r.catch((e) => log.error('ticket',
                `reviewer ${s.name} did NOT retire after all for ${ticketId} — it is STILL LIVE: ${e.message}`));
            }
            retired.push(s.name);
          } catch (e) {
            log.error('ticket', `retiring reviewer ${s.name} for ${ticketId} failed: ${e.message}`);
          }
        }
        if (retired.length) {
          // Log says retiring, not retired, and the push stays synchronous: kill() is async,
          // so deferring the push would leave the list and the message empty.
          log.info('intent', `ticket ${ticketId} ${why} — retiring ${retired.length} live reviewer seat(s) (discard): ${retired.join(', ')}`);
        }
      } catch (e) {
        log.error('ticket', `reviewer teardown for ${ticketId} failed: ${e.message}`);
      }
      return retired;
    },

    // One ps call for the whole table, tree discovered from the snapshot. Null on failure:
    // the classifier reads null as no CPU signal and zero as the wedge verdict.
    _samplePtyTreeCpuMs(pid) {
      return new Promise((resolve) => {
        if (!Number.isInteger(pid) || pid <= 0) { resolve(null); return; }
        try {
          childProcess.execFile('ps', ['-axo', 'pid=,ppid=,time='], { timeout: 5000 }, (err, stdout) => {
            if (err) { resolve(null); return; }
            resolve(sumTreeCpuMs(parsePsRows(stdout), pid));
          });
        } catch { resolve(null); }
      });
    },

    // Review and stall probes keep separate session field pairs so one probe's
    // baseline cannot corrupt the other's clock.
    _sampleSeatLiveness(s, now, stallMs, kind) {
      const sampleField = kind === 'stall' ? '_stallLiveSample' : '_reviewLiveSample';
      const onceField = kind === 'stall' ? '_stallWedgedOnce' : '_reviewWedgedOnce';
      return (async () => {
        const size = this._seatTranscriptSize(s.name);
        // Sample the whole pty tree: a seat inside a long tool call has its CPU in the
        // child, so a root-only sample calls a working seat wedged.
        const cpuMs = await this._samplePtyTreeCpuMs(s.pty && s.pty.pid);
        const prev = s[sampleField] || null;
        const cur = {
          at: now,
          size,
          cpuMs,
          // Seed lastGrowthAt at the first sample rather than null: a flat stretch we
          // never measured is a confidently wrong field.
          lastGrowthAt: (!prev || didGrow(prev.size, size)) ? now : (prev.lastGrowthAt || prev.at),
        };
        const r = classifyReviewSeat(prev, cur, { stallMs });
        // A gap too short to read is not a sample: overwriting the baseline resets the clock
        // every sweep, and below MIN_GAP_MS the probe would answer unknown forever.
        if (r.verdict !== 'unknown' || !prev) s[sampleField] = cur;
        // Two consecutive wedged verdicts: Linux procps reports CPU in whole seconds, so a
        // short composing turn reads exactly 0 there, identical to a wedge.
        let verdict = r.verdict;
        if (verdict === 'wedged') {
          const confirmed = s[onceField] === true;
          s[onceField] = true;
          if (!confirmed) verdict = 'unknown';
        } else if (r.verdict !== 'unknown') {
          s[onceField] = false;
        }
        return { ...r, verdict };
      })();
    },

    _wakeSeatEligible(team, seat, now, stallMs) {
      if (!seat || seat._dead) return false;
      if (seat.name === team.lead) return false;
      // One wake per seat per stall window across all its tickets: the composer is per
      // seat and a second Ctrl-U destroys what the first produced.
      if (seat._stallWakeAt && (now - seat._stallWakeAt) < stallMs) return false;
      if (!(adapterFor(seat.agentType) || {}).caps?.transcript) return false;
      // An unreadable size leaves the wedge verdict on CPU alone, so refuse.
      if (this._seatTranscriptSize(seat.name) < 0) return false;
      if (seat.activityState !== 'idle') return false;
      // Injection ends with Enter, which would answer the permission dialog.
      if (seat.needsAttention && seat.needsAttention.kind === 'permission') return false;
      // The spec latch redelivers the actual content; a wake's induced turn would clear
      // it as consumed while Ctrl-U destroyed the draft it was about.
      if (seat._specUnconfirmed) return false;
      // Same for unconfirmed dms: the induced turn would clear the fifo before its report
      // told the senders. `_dmUnconfirmedLast` does not block, those senders were told.
      if (seat._dmUnconfirmed && seat._dmUnconfirmed.length) return false;
      try { if (isDraftOpen(seat)) return false; } catch { return false; }
      return true;
    },

    // The wake line carries a no-spec exit: the eaten draft may have been the spec with
    // its latch retry spent, and a seat knowing only a ticket id could not say so.
    _wakeText(ticket, now, lead) {
      const last = ticket.lastActivityAt || ticket.openedAt || now;
      return `[ticket ${ticket.id} wake] this ticket has had no activity for ${humanizeAge(now - last)} `
        + `and this seat has taken no turn in that time, so this is an automated wake — nothing new is being asked. `
        + `If your last turn was interrupted (an API error, a lost delivery), resume the ticket and close with `
        + `${ticketCloseVerb(ticket.id)} as before. If you are already working or have already closed it, ignore this. `
        + `If you never received the ticket's spec, say so: [agent:dm ${lead}] ticket ${ticket.id} reached me with no spec.`;
    },

    // No `parkable`: a parked wake drains on the seat's next turn, which never comes.
    // produce aborts inside the queue's critical section so null cancels the Ctrl-U.
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
            // Bound the wake to the episode it was decided for: activity since ends the stall,
            // and waking then spends the next episode's one wake.
            if ((rec.lastActivityAt || null) !== seenAt) return null;
            // The real double-wake dedup: the decision sits outside the `_stallProbing`
            // window, so whichever producer runs first stamps.
            const recLast = rec.lastActivityAt || rec.openedAt || 0;
            if (rec.wakeAt && rec.wakeAt - recLast > 0) return null;
            rec.wakeAt = now;
            ticketsStore.save(team.root, fresh);
            // Seat-side half of the budget, stamped in the same critical section as the record's;
            // on the session so it dies with the seat rather than denying a reused name a wake.
            seat._stallWakeAt = now;
            return finalText;
          } catch (e) {
            log.error('ticket', `wake stamp for ${tid} failed: ${e.message}`);
            return null;
          }
        },
      });
    },

    // Samples come from consecutive sweeps, not from sleeping inside the pass; the sample
    // lives on the session so it dies with the seat, not in a name-keyed map.
    async _probeReviewSeat(team, ticket, now, stallMs) {
      const seats = this._liveReviewSeatsFor(team, ticket.id);
      if (!seats.length) return null;
      let worst = null;
      for (const s of seats) {
        const r = await this._sampleSeatLiveness(s, now, stallMs, 'review');
        // Any moving or unknown seat suppresses: a stranded round-1 seat must not raise an
        // alarm about a round 2 that is working.
        if (r.verdict === 'moving' || r.verdict === 'unknown') {
          return { seat: s.name, ...r };
        }
        if (!worst) worst = { seat: s.name, ...r };
      }
      return worst;
    },

    _stampEscalationUndelivered(team, ticketId, step, body) {
      try {
        const tickets = ticketsStore.load(team.root);
        const rec = tickets.find((t) => t.id === ticketId);
        if (!rec || !rec.mergeError) return false;
        rec.escalationUndelivered = { step, body };
        ticketsStore.save(team.root, tickets);
        return true;
      } catch (e) {
        log.error('ticket', `undelivered escalation stamp for ${ticketId} failed: ${e.message}`);
        return false;
      }
    },

    _sweepUndeliveredMergeErrors(team, tickets) {
      for (const t of tickets) {
        const u = t.escalationUndelivered;
        if (!t.mergeError || !u || typeof u.body !== 'string') continue;
        if (t.state !== 'done' || t.closedOut) continue;
        const tid = t.id;
        const step = u.step;
        const body = `${u.body}\n\n(re-sent by the stall sweep: this escalation did not reach ${team.lead} when it fired)`;
        const r = this._gatedDeliver(team.lead, 'ticket-watchdog', body, true, `[ticket ${tid} ESCALATED]`);
        if (!(r && (r.queued || r.parked))) continue;
        try {
          const fresh = ticketsStore.load(team.root);
          const rec = fresh.find((x) => x.id === tid);
          if (rec && rec.escalationUndelivered) { delete rec.escalationUndelivered; ticketsStore.save(team.root, fresh); }
        } catch (e) { log.error('ticket', `undelivered escalation clear for ${tid} failed: ${e.message}`); }
        log.info('ticket', `ticket ${tid}: re-surfaced the undelivered merge escalation (${step}) to ${team.lead}`);
      }
    },

    _sweepMergedUnaccepted(team, tickets, now) {
      for (const t of tickets) {
        if (typeof t.mergedAt !== 'number' || t.mergedNudgedAt) continue;
        if (t.state !== 'done') continue;
        // An accept that did not close the ticket out still owes a step, whoever ran it. The
        // loop's half asks `loopClosedOut` because its tree-keeping arms set `closedOut`.
        const owes = t.acceptedBy === 'ticket-loop' ? !t.loopClosedOut : !t.closedOut;
        if (!owes && (t.acceptedAt || t.closedOut)) continue;
        if (t.mergeError) continue;
        if (now - t.mergedAt < MERGED_ACCEPT_NUDGE_MS) continue;
        const tid = t.id;
        const body = `[ticket ${tid} merged ${humanizeAge(now - t.mergedAt)} ago, not accepted] Step owed: \`[agent:task accept ${tid}]\`.`;
        this._gatedDeliver(team.lead, 'ticket-watchdog', body, false,
          `[ticket ${tid} merged, not accepted]`,
          () => {
            try {
              const fresh = ticketsStore.load(team.root);
              const rec = fresh.find((x) => x.id === tid);
              if (!rec) return;
              if (rec.mergedNudgedAt) return;
              rec.mergedNudgedAt = now;
              ticketsStore.save(team.root, fresh);
            } catch (e) { log.error('ticket', `merged nudge stamp for ${tid} failed: ${e.message}`); }
          });
      }
    },

    async _sweepTeamTickets(team, now) {
      const stallMs = (typeof team.watchdogMs === 'number' && team.watchdogMs > 0) ? team.watchdogMs : TICKET_STALL_MS;
      const tickets = ticketsStore.load(team.root);
      try { this._sweepMergedUnaccepted(team, tickets, now); } catch (e) {
        log.error('ticket', `merged-unaccepted sweep failed: ${e.message}`);
      }
      try { this._sweepUndeliveredMergeErrors(team, tickets); } catch (e) {
        log.error('ticket', `undelivered merge escalation sweep failed: ${e.message}`);
      }
      // Walk live seats once per board: each `_ticketAssigneeSeat` resolution would
      // otherwise re-walk the run directory.
      const live = this._teamLiveSeatNames(team.root);
      for (const t of tickets) {
        if (!ticketInFlight(t) || t.assignee == null || !ticketStarted(t) || t.parked) continue;
        const last = t.lastActivityAt || t.openedAt || now;
        if (now - last < stallMs) continue;
        // A loop-held ticket is never orphan-tested: the hand is gone by construction, and an
        // orphan verdict would replace the alarm that names the stuck step.
        const loopHeld = t.state === 'done' && !!t.loopStep;
        const foreignRole = !!(t.role && !(team.roles
          && Object.prototype.hasOwnProperty.call(team.roles, t.role)));
        const orphan = !loopHeld && !this._ticketAssigneeSeat(team, t, live);
        // Gate on both nudgedAt and orphanNudgedAt: nudgedAt alone silences the orphan alarm
        // forever for a ticket that first alarmed as a live but quiet stall.
        if (orphan && t.nudgedAt && t.orphanNudgedAt) continue;
        // Geometric re-alarm once the quiet has doubled since the last alarm: a once-per-episode
        // nudge is cleared only by activity, which never comes during a stall.
        const prevAge = t.nudgedAt ? t.nudgedAt - last : 0;
        if (prevAge > 0 && (now - last) < prevAge * 2) continue;
        // Derive repeat from prevAge, not raw nudgedAt (a revival stamp can predate the episode),
        // and as a log2 rung so the 60m, 120m and 240m alarms stay distinguishable.
        const repeat = prevAge > 0 ? Math.max(1, Math.round(Math.log2(prevAge / stallMs)) + 1) : 0;
        if (this._stallProbing.has(t.id)) continue;
        const tid = t.id;
        const seenAt = t.lastActivityAt || null;
        const seenNudge = t.nudgedAt || null;
        // A loop-held ticket names the step, not the seat: 'hand quiet' would point the lead
        // at the wrong actor, so it gets no seat evidence.
        let body;
        // The stamp records orphanNow, re-resolved after the awaited probe; declared here
        // because the onWrite closure reads it and the loop-held arm never re-resolves.
        let orphanNow = orphan;
        if (loopHeld) {
          // Probe only at review: other steps have no seat to ask, and a null from the probe
          // there must not be read as a verdict.
          let seatInfo = null;
          if (t.loopStep === 'review') {
            this._stallProbing.add(tid);
            try { seatInfo = await this._probeReviewSeat(team, t, now, stallMs); }
            catch { /* a failed probe alarms unqualified — never silences */ }
            finally { this._stallProbing.delete(tid); }
            const after = ticketsStore.load(team.root).find((x) => x.id === tid);
            if (!after || !ticketInFlight(after) || after.loopStep !== 'review') continue;
            if ((after.lastActivityAt || null) !== seenAt) continue;
            // Moving or unknown defers a sweep: unknown is a live reviewer with no baseline yet,
            // and alarming then is a blind alarm at a seat nobody asked about.
            if (seatInfo && (seatInfo.verdict === 'moving' || seatInfo.verdict === 'unknown')) continue;
          }
          const head = repeat > 0 ? `[ticket ${tid}] STILL stalled (repeat ${repeat}): ` : `[ticket ${tid}] stalled: `;
          // Name a held ticket off the verifyHold stamp, not loopStep, which reads verify for a
          // running and a held check alike; the loop is waiting on a human, not stuck.
          if (t.verifyHold) {
            // Recovery text comes from the stamp's renderer: one inline sentence was wrong for arms
            // like task-dir, where re-closing re-reads the same taskDir and fails identically.
            body = `${head}the loop ESCALATED at "${t.verifyHold.step}" and is waiting for someone to act — ${humanizeAge(now - last)} ago, and nothing has moved since.`
              + `\n\nEVIDENCE: ${t.verifyHold.evidence}`
              + `\n\nThis is NOT a stalled step — the tree, the branch and the seat are as they were.`
              + `\n\nRECOVERY: ${holdRecoveryText(t.verifyHold.recovery, tid)}`;
          } else {
            body = `${head}the ticket loop is stuck at "${t.loopStep}" — no progress for ${humanizeAge(now - last)} (the hand already reported; nothing was torn down)`
              + formatReviewSeatClause({
                seat: seatInfo && seatInfo.seat, verdict: seatInfo && seatInfo.verdict,
                cpuRead: !!(seatInfo && seatInfo.cpuRead),
                flatFor: seatInfo && seatInfo.flatFor,
                // The measured flat stretch, not the ticket's quiet age: they are different durations
                // and the formatter, handed a self-consistent pair, cannot catch the mismatch.
                age: seatInfo && seatInfo.flatFor != null ? humanizeAge(seatInfo.flatFor) : null,
              });
          }
        } else {
          this._stallProbing.add(tid);
          let ev = { tool: null, commits: null, dirty: null, apiError: null };
          try { ev = await this._stallEvidence(team, t); } catch { /* alarm without evidence beats no alarm */ }
          finally { this._stallProbing.delete(tid); }
          // Re-read after the await: a seat that woke while git ran would otherwise get a false alarm.
          const after = ticketsStore.load(team.root).find((x) => x.id === tid);
          if (!after || !ticketInFlight(after) || (after.lastActivityAt || null) !== seenAt) continue;
          // Re-resolve the seat after the await instead of reusing `live`: a seat spawned during the
          // git probe touches no record, so only a fresh walk flips the orphan classification.
          const seatNow = this._ticketAssigneeSeat(team, after);
          orphanNow = !foreignRole && !seatNow;
          // Rung 2 reads seatNow, never the pre-await snapshot; wakeAge is episode-relative like
          // prevAge, so a stamp from an earlier episode needs no clearing site.
          const wakeSeat = orphanNow ? null : this.sessions.get(seatNow);
          const wakeAge = after.wakeAt ? after.wakeAt - (after.lastActivityAt || after.openedAt || 0) : 0;
          if (wakeSeat && prevAge <= 0 && wakeAge <= 0) {
            // Enforce the grace bound before the probe: with rung 3 held nudgedAt stays null, so an
            // ungated wake could fire hours in, after the lead already owns the recovery.
            const graceLeft = (now - last) < (stallMs + WAKE_GRACE_MS);
            // Any refusal from `_wakeSeatEligible` falls through to the alarm: permanent refusals
            // never become eligible by waiting and transient ones match the pre-rung-2 behaviour.
            if (graceLeft && this._wakeSeatEligible(team, wakeSeat, now, stallMs)) {
              let verdict = null;
              try { verdict = (await this._sampleSeatLiveness(wakeSeat, now, stallMs, 'stall')).verdict; }
              catch { verdict = null; }
              if (verdict === 'wedged') {
                this._wakeStalledSeat(team, after, wakeSeat, now, stallMs);
                continue;
              }
              continue;
            }
          } else if (wakeAge > 0 && (now - after.wakeAt) < WAKE_CONFIRM_MS) {
            continue;
          }
          // Read from the seat resolved now, not the pre-await snapshot, or one seat's silence
          // is attributed to another seat's latch.
          const dmEv = seatNow ? this._dmLatchEvidence(seatNow) : null;
          body = orphanNow
            ? formatOrphanBody({
              ticketId: tid, who: t.assignee, age: humanizeAge(now - last),
              commits: ev.commits, dirty: ev.dirty,
            })
            : formatStallBody({
              ticketId: tid, who: t.role || t.assignee, age: humanizeAge(now - last),
              repeat, tool: ev.tool, commits: ev.commits, dirty: ev.dirty,
              dmLatch: dmEv && { count: dmEv.count, age: humanizeAge(now - dmEv.at) },
              // wakeAge, not the raw field, so an earlier episode's wake is not reported as evidence.
              wake: wakeAge > 0 ? { age: humanizeAge(now - after.wakeAt) } : null,
              apiError: ev.apiError,
            });
        }
        this._gatedDeliver(team.lead, 'ticket-watchdog',
          body, false, '',
          () => {
            try {
              const fresh = ticketsStore.load(team.root);
              const rec = fresh.find((x) => x.id === tid);
              if (!rec) return;
              if ((rec.nudgedAt || null) !== seenNudge) return;
              // Stamp only for the episode it was decided for (activity clears nudgedAt), and with the same
              // `ticketInFlight` as the eligibility gate, or the nudge repeats on every sweep.
              if (!ticketInFlight(rec)) return;
              if ((rec.lastActivityAt || null) !== seenAt) return;
              // Stamp the sweep's instant, not Date.now(): the doubling gate reads nudgedAt - lastActivityAt
              // as the alarm's age, and wall-clock makes the schedule untestable.
              rec.nudgedAt = now;
              // orphanNudgedAt records which message was sent (nudgedAt is one field for two); it is deleted
              // on the stall arm so orphan, live, orphan again is not suppressed by the first stamp.
              if (orphanNow) rec.orphanNudgedAt = now;
              else delete rec.orphanNudgedAt;
              recordEvent(rec, { at: now, kind: 'nudge', by: 'ticket-loop' });
              ticketsStore.save(team.root, fresh);
            } catch (e) { log.error('ticket', `nudge stamp for ${tid} failed: ${e.message}`); }
          });
      }
    },

    async _handleTeamRetire(targetName, requesterName) {
      const fail = (why) => {
        log.warn('intent', `team-retire ${requesterName} → ${targetName} refused: ${why}`);
        this._deliverMessage(requesterName, 'clodex-team', `retire ${targetName} refused: ${why}`, 'dm');
      };
      const target = this.sessions.get(targetName);
      const requester = this.sessions.get(requesterName);
      if (!target) return;
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
          const roleMatch = role ? team.roles[role] : null;
          let rec = null;
          try { rec = getPersistence().get(targetName); } catch { rec = null; }
          discard = !roleMatch || (rec != null && rec.ephemeral === true);
        }
      } catch { discard = false; }
      // Keep dirtyPath and uncheckedPath apart: only a dirty tree is something the operator can
      // commit, and after merge, remove tree, retire the tree is usually already gone.
      let dirtyPath = null;
      let uncheckedPath = null;
      let uncheckedWhy = null;
      // Captured before teardown drops the persistence record.
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
      // Book a hand-retired reviewer only after the discard decision is final and only on discard:
      // an archive keeps the record, and the round may still be running.
      if (discard) {
        try {
          const rec = getPersistence().get(targetName);
          if (rec && rec.ephemeral && rec.reviewTicket) {
            const t = resolveTeam(target.cwd);
            const ticket = t ? this._loadTicket(t, rec.reviewTicket) : null;
            if (t && ticket) {
              const round = (Number(ticket.reviewRound) || 0) + 1;
              const w = this._writeReviewCost(targetName, t, ticket, rec, round, null, null);
              if (!w.ok) {
                log.warn('intent', `ticket ${rec.reviewTicket}: review cost for the retired round not captured for ${targetName} (${w.error}) — the seat is about to be reaped, so this round's spend is unrecoverable`);
              }
            } else {
              log.warn('intent', `ticket ${rec.reviewTicket}: review cost not captured for retired reviewer ${targetName} (no ${t ? 'ticket' : 'team'}) — this round's spend is unrecoverable`);
            }
          }
        } catch (e) {
          log.warn('intent', `review cost not captured for retired reviewer ${targetName}: ${e.message}`);
        }
      }
      // Before teardown: destroy() drops the record that links the ticket to the session.
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
      // destroy, not kill, so a discarded seat's ticket worktree goes with it.
      const teardown = discard ? this.destroy(targetName) : this.archive(targetName);
      teardown.then((r) => {
        let confirm;
        if (dirtyPath) {
          // Route through Resume: the archived seat left this.sessions, so a second team-retire
          // returns at the missing-target check and looks ignored.
          confirm = `retired ${targetName} (ARCHIVED, not discarded — ${dirtyPath} has uncommitted work). `
            + 'A discard would have deleted that tree. Resume it from the sidebar, commit or clear that tree, '
            + 'then retire again to discard.';
        } else if (uncheckedPath) {
          confirm = `retired ${targetName} (ARCHIVED, not discarded — ${uncheckedPath} could not be inspected: ${uncheckedWhy}). `
            + 'That is usually a tree already removed. Archiving was the safe choice: an unreadable tree is not evidence of a clean one, '
            + `and the seat stays resumable. If ${uncheckedPath} is gone and you want the record dropped, delete the session from the sidebar.`;
        } else if (!discard) {
          confirm = `retired ${targetName} (resumable from the sidebar or on next project open)`;
        } else if (r && r.worktreeRemoved) {
          confirm = `retired ${targetName} (discarded — its worktree was removed; committed work survives on the branch)`;
        } else if (r && r.error) {
          // Path from the record: removeWorktree failure strings carry none.
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

module.exports = { createTicketMethods, ticketCloseLine, ticketCloseVerb, ticketTaskDirLine, ignoreCwdDir, REVIEWER_PROMPT_PREFIX };
