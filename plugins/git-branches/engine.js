'use strict';

/**
 * git-branches — engine half.
 *
 * Resolves each session's current git branch by running
 *   git rev-parse --abbrev-ref HEAD
 * in that session's working directory, caches the answer per session, and
 * serves it to the renderer half over `invoke`.
 *
 * Design notes (see NOTES.md for the doc findings behind them):
 *
 *  - The cache is DEMAND-DRIVEN, not push-driven. §14 says it is unspecified
 *    whether `onCreate` fires for sessions restored at launch, and §4 says
 *    there are "(usually) no sessions yet" when `activate` runs — so the
 *    remedy §4 offers (listAll() at activation and reconcile) cannot cover
 *    restored sessions either. Resolving on first ask covers every case,
 *    including sessions that predate this plugin being enabled.
 *  - Lifecycle hooks are used as INVALIDATION only, per Law 2. They are
 *    synchronous, as §4 requires: they capture the name and return, and any
 *    git work is scheduled onto a tracked timer.
 *  - Freshness is a TTL checked on demand rather than an engine-side interval,
 *    because §5's auto-cleared timers exist only on `rhost` — an engine-side
 *    interval would have to be torn down by hand in `deactivate()`, and §10
 *    only gives `deactivate()` a best-effort chance to run. No engine timer
 *    means nothing to leak. (The short-lived timers we do use are tracked and
 *    cleared; they are one-shot and sub-second.)
 *  - The TTL also makes the plugin correct with N windows open: every window's
 *    renderer polls independently, but they all land on one cache, so the
 *    number of `git` processes is bounded by time, not by window count.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GIT_TIMEOUT_MS = 5000;
const MIN_TTL_MS = 2000;
const CREATE_SETTLE_MS = 250;
const MAX_NAMES_PER_CALL = 500;

const DEFAULTS = { refreshSeconds: 10, maxLength: 18 };
const LIMITS = { refreshSeconds: [3, 600], maxLength: [4, 60] };

/** Common install locations, for the case where the app was launched from the
 *  GUI and inherited a minimal PATH. §4 never describes the engine process's
 *  environment, so we do not assume `git` is already reachable. */
const EXTRA_PATH_DIRS = [
  '/usr/bin',
  '/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/local/git/bin',
  '/opt/local/bin',
];

// ---------------------------------------------------------------------------
// Module-level state.
//
// §10: "Node's module cache still holds your code" after a disable, so a
// re-enable calls activate() again on THIS module object. Every one of these is
// therefore reset at the top of activate() rather than merely initialised here.
// ---------------------------------------------------------------------------

let host = null;
/** name -> { value: Entry|null, inflight: Promise|null } */
let entries = new Map();
let timers = new Set();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function clampInt(raw, def, [lo, hi]) {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function readSettings() {
  let s = {};
  try {
    s = host.settings.get() || {};
  } catch (_) {
    s = {};
  }
  return {
    refreshSeconds: clampInt(s.refreshSeconds, DEFAULTS.refreshSeconds, LIMITS.refreshSeconds),
    maxLength: clampInt(s.maxLength, DEFAULTS.maxLength, LIMITS.maxLength),
  };
}

/** Slightly under the renderer's poll period, so a poll usually finds the entry
 *  stale and triggers exactly one refresh per period across all windows. */
function ttlMs() {
  return Math.max(MIN_TTL_MS, readSettings().refreshSeconds * 1000 - 1000);
}

// ---------------------------------------------------------------------------
// Timers we own (see header note)
// ---------------------------------------------------------------------------

function schedule(fn, ms) {
  const t = setTimeout(() => {
    timers.delete(t);
    try {
      fn();
    } catch (e) {
      logError(`scheduled task failed: ${errText(e)}`);
    }
  }, ms);
  if (typeof t.unref === 'function') t.unref();
  timers.add(t);
  return t;
}

function clearTimers() {
  for (const t of timers) {
    try {
      clearTimeout(t);
    } catch (_) {
      /* ignore */
    }
  }
  timers.clear();
}

// ---------------------------------------------------------------------------
// Logging helpers (host may be null during teardown races)
// ---------------------------------------------------------------------------

function errText(e) {
  return String((e && e.message) || e);
}

function logInfo(msg) {
  try {
    if (host) host.log.info(msg);
  } catch (_) {
    /* ignore */
  }
}

function logError(msg) {
  try {
    if (host) host.log.error(msg);
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function gitEnv() {
  const env = Object.assign({}, process.env);
  const parts = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(path.delimiter);
  // Read-only, non-interactive, parseable.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

/** Never rejects. -> { ok:true, out } | { ok:false, spawnFailed?, timedOut?, err } */
function runGit(cwd, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      execFile(
        'git',
        args,
        {
          cwd,
          env: gitEnv(),
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 1 << 20,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (!err) return done({ ok: true, out: String(stdout || '').trim() });
          done({
            ok: false,
            spawnFailed: err.code === 'ENOENT',
            timedOut: !!err.killed,
            err: String(stderr || '').trim() || errText(err),
          });
        },
      );
    } catch (e) {
      done({ ok: false, spawnFailed: true, err: errText(e) });
    }
  });
}

/**
 * The command the plugin is specified around is the first one run; the rest of
 * this function only exists to classify the ways it can legitimately fail.
 */
async function probe(cwd) {
  const r = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

  if (r.ok) {
    if (r.out && r.out !== 'HEAD') return { state: 'ok', branch: r.out };
    // Detached HEAD: --abbrev-ref answers the literal string "HEAD".
    const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    return { state: 'detached', sha: sha.ok ? sha.out : '' };
  }

  if (r.spawnFailed) {
    return { state: 'nogit', reason: 'git executable not found on the engine process PATH' };
  }
  if (r.timedOut) {
    return { state: 'error', reason: `git timed out after ${GIT_TIMEOUT_MS}ms` };
  }

  const msg = r.err || '';
  if (/not a git repository/i.test(msg)) return { state: 'notrepo' };

  // A repository whose first commit does not exist yet: HEAD points at a branch
  // ref that has no object, so rev-parse cannot resolve it, but the branch name
  // is real and is what a user expects to see.
  if (/ambiguous argument|unknown revision|needed a single revision/i.test(msg)) {
    const sym = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (sym.ok && sym.out) return { state: 'unborn', branch: sym.out };
    return { state: 'notrepo' };
  }

  return { state: 'error', reason: msg.split('\n')[0].slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Per-session resolution and cache
// ---------------------------------------------------------------------------

/**
 * fsScope is the mandated gate (§4): it is the same guard core uses, and it is
 * what refuses remote sessions. We never read `handle.cwd` directly for this.
 */
const SCOPE_ERROR_STATE = {
  remote: 'remote',
  'Session not found': 'gone',
  'Session has no working directory': 'nocwd',
};

async function computeEntry(name) {
  const at = Date.now();

  let scope;
  try {
    scope = host.sessions.fsScope(name);
  } catch (e) {
    return { state: 'error', reason: `fsScope threw: ${errText(e)}`, at };
  }

  if (!scope || typeof scope !== 'object') {
    return { state: 'error', reason: 'fsScope returned no result', at };
  }
  if (scope.error) {
    const state = SCOPE_ERROR_STATE[scope.error] || 'unavailable';
    return { state, reason: scope.error, at };
  }

  const cwd = scope.cwd;
  if (typeof cwd !== 'string' || !cwd) {
    return { state: 'nocwd', reason: 'Session has no working directory', at };
  }
  // Distinguish "the directory is gone" from "git is missing"; both would
  // otherwise surface as a spawn ENOENT.
  try {
    if (!fs.existsSync(cwd)) {
      return { state: 'nocwd', reason: 'working directory no longer exists', at };
    }
  } catch (_) {
    /* fall through and let git report */
  }

  const result = await probe(cwd);
  return Object.assign({ at: Date.now() }, result);
}

function startRefresh(name) {
  const slot = entries.get(name) || { value: null, inflight: null };
  if (slot.inflight) return slot.inflight;

  const p = computeEntry(name)
    .catch((e) => ({ state: 'error', reason: errText(e), at: Date.now() }))
    .then((value) => {
      // Do not resurrect an entry evicted while we were running (onExit, or a
      // deactivate that cleared the map).
      if (!host) return value;
      const cur = entries.get(name);
      if (cur) {
        cur.value = value;
        cur.inflight = null;
      }
      return value;
    });

  slot.inflight = p;
  entries.set(name, slot);
  return p;
}

/**
 * Never blocks longer than it has to:
 *   - nothing cached  -> await the first resolution (so a badge appears fast)
 *   - forced          -> await
 *   - stale           -> kick off a refresh, answer with the stale value now
 *   - fresh           -> answer immediately
 */
async function getEntry(name, force) {
  const slot = entries.get(name);

  if (!slot || !slot.value) return startRefresh(name);
  if (force) return startRefresh(name);

  if (Date.now() - slot.value.at > ttlMs()) startRefresh(name);
  return slot.value;
}

/** What crosses the process boundary — plain data only (§8), and no `cwd`. */
function publicEntry(e) {
  if (!e || typeof e !== 'object') return { state: 'unknown' };
  const out = { state: e.state, at: e.at };
  if (e.branch) out.branch = e.branch;
  if (e.sha) out.sha = e.sha;
  if (e.reason) out.reason = e.reason;
  return out;
}

// ---------------------------------------------------------------------------
// The [agent:branch] intent
// ---------------------------------------------------------------------------

/**
 * The shipped handler signature is `handler(handle, intent)` — a SessionHandle
 * first, the parsed intent second. `plugin-api.md:739` documents it as
 * `handler(intent, ctx)`, which is backwards and names a second parameter that
 * does not exist; the emitting session's identity is in the argument the docs
 * call `intent`. A doc fix is dispatched. See NOTES.md ▸ Misleading #1.
 *
 * So the emitter is simply `handle.name`, and the reply goes back through
 * `handle.inject()` on the very handle we were given.
 */
function describe(entry) {
  switch (entry && entry.state) {
    case 'ok':
      return `[git-branches] branch: ${entry.branch}`;
    case 'unborn':
      return `[git-branches] branch: ${entry.branch} (no commits yet)`;
    case 'detached':
      return entry.sha
        ? `[git-branches] detached HEAD at ${entry.sha}`
        : '[git-branches] detached HEAD';
    case 'notrepo':
      return '[git-branches] this session\'s working directory is not a git repository';
    case 'remote':
      return '[git-branches] not available for remote sessions';
    case 'nocwd':
      return `[git-branches] no branch: ${entry.reason || 'this session has no working directory'}`;
    case 'gone':
      return '[git-branches] session not found';
    case 'nogit':
      return `[git-branches] no branch: ${entry.reason}`;
    default:
      return `[git-branches] could not determine branch: ${(entry && entry.reason) || 'unknown error'}`;
  }
}

function onBranchIntent(handle) {
  const name = handle && handle.name;
  if (typeof name !== 'string' || !name) {
    logError('[agent:branch] fired without a usable session handle; nothing reported');
    return;
  }

  // force:true — the agent is asking right now, so the TTL is not good enough.
  getEntry(name, true)
    .then((entry) => {
      if (!host) return; // disabled while git was running
      // The session can exit during the git run. inject() on a dead handle is a
      // documented safe no-op (§4), so this check only avoids pointless work.
      if (!handle.isAlive()) return;
      // parkable defaults to true, which is what we want: the agent is mid-turn
      // by definition — it just emitted this line — so the answer is delivered
      // with its next turn instead of interrupting it.
      handle.inject(describe(entry));
    })
    .catch((e) => logError(`[agent:branch] failed for "${name}": ${errText(e)}`));
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

module.exports.activate = (h) => {
  // Re-enable reuses this module object (§10) — start from zero every time.
  host = h;
  entries = new Map();
  clearTimers();

  // --- methods for our own renderer half -----------------------------------

  host.ipc.handle('branch.get', async (name) => {
    if (typeof name !== 'string' || !name) {
      return { ok: false, error: 'a session name is required' };
    }
    return { ok: true, name, entry: publicEntry(await getEntry(name, false)) };
  });

  host.ipc.handle('branch.getMany', async (names, opts) => {
    if (!Array.isArray(names)) return { ok: false, error: 'names must be an array' };
    const force = !!(opts && opts.force);
    const list = names
      .filter((n) => typeof n === 'string' && n)
      .slice(0, MAX_NAMES_PER_CALL);

    const results = {};
    await Promise.all(
      list.map(async (n) => {
        try {
          results[n] = publicEntry(await getEntry(n, force));
        } catch (e) {
          results[n] = { state: 'error', reason: errText(e), at: Date.now() };
        }
      }),
    );
    // Ride settings along so the renderer picks up a changed poll interval
    // without a second round trip — it has no way to read them directly (§13).
    return { ok: true, results, settings: readSettings() };
  });

  host.ipc.handle('settings.get', () => ({ ok: true, values: readSettings() }));

  // --- lifecycle: invalidation only, strictly synchronous (§4) -------------

  host.sessions.onCreate((handle) => {
    const name = handle && handle.name;
    if (!name) return;
    entries.delete(name);
    // Capture synchronously, do the async work later — §4 is explicit that a
    // subscriber returning a promise is a contract violation.
    schedule(() => {
      if (host) startRefresh(name);
    }, CREATE_SETTLE_MS);
  });

  host.sessions.onExit((handle) => {
    const name = handle && handle.name;
    if (!name) return;
    entries.delete(name);
  });

  // --- the intent verb ------------------------------------------------------

  // §7's own example parses the verb unprefixed (`[agent:review …]`), so despite
  // §2 calling the plugin id "an intent-verb namespace", the literal line is
  // `[agent:branch]`. See NOTES.md ▸ Misleading #1.
  const INTENT_RE = /^\[agent:branch\]\s*(.*)$/;

  host.intents.register({
    verb: 'branch',
    parse(line) {
      const m = INTENT_RE.exec(String(line == null ? '' : line));
      // Trailing text is tolerated and ignored; the verb takes no arguments.
      return m ? { arg: (m[1] || '').trim() } : null;
    },
    bodyMode() {
      return 'none';
    },
    label: 'Report git branch',
    promptLines: '  [agent:branch]                   Report this session\'s current git branch',
    // NOTE the argument order: (handle, intent), not the (intent, ctx) printed
    // at plugin-api.md:739. The first argument is a SessionHandle.
    //
    // Deliberately NOT wrapped in try/catch. The host turns a throwing handler
    // into an `[agent:branch] error: …` bounce and cannot let it affect intent
    // handling for other sessions, so a throw reaches the agent that asked —
    // which for a verb whose entire job is to answer is strictly better than
    // swallowing it into a log line the agent never sees.
    handler(handle, _intent) {
      onBranchIntent(handle);
      // Returns undefined: §7 never states whether the return value is used or
      // awaited, so nothing is expressed through it.
    },
  });

  logInfo('activated');
};

module.exports.deactivate = () => {
  clearTimers();
  entries.clear();
  logInfo('deactivated');
  host = null;
  // Everything registered above (dispatch methods, the intent row, both session
  // hooks) is torn down unconditionally by the host per §10; we hold no
  // disposers of our own because there is nothing the host would miss.
};
