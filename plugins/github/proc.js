'use strict';

/**
 * github — process layer.
 *
 * Everything that spawns `git` or `gh` goes through here, so that the three
 * properties this plugin has to hold are held in ONE place:
 *
 *  1. NO CREDENTIAL EVER TOUCHES THIS PLUGIN. There is no token argument, no
 *     token setting, no token in `host.storage` (which is plaintext JSON with
 *     no mode bits — see plugins/plugin-api.md §4), no token in argv and none in the
 *     environment we construct. `gh` is invoked exactly as the operator would
 *     invoke it and reads its own keychain entry itself. The plugin cannot leak
 *     a secret it never holds.
 *  2. NOTHING REJECTS. Every call resolves to a shaped result. A verb that
 *     throws bounces to the agent as `[agent:gh] error: …` (plugins/plugin-api.md §7),
 *     which is a fine channel for "you asked for something impossible" and a
 *     bad one for "the network was down", because the second is a fact the
 *     agent should be told plainly and in full.
 *  3. ARGUMENTS ARE ARRAYS, NEVER A SHELL STRING. `execFile` with no shell, so
 *     an agent-supplied PR title cannot become a command. Nothing here ever
 *     builds a string and hands it to `sh`.
 *
 * `scrub()` is the belt to that braces: even though we never pass a token in,
 * gh's own diagnostics can echo one back (`gh auth status` prints a masked
 * form; a 401 body can carry more). Everything that reaches a log or an agent
 * goes through it first.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 25000;
// 96 MB. Measured, not guessed: `gh run view --log-failed` on a failing
// nodejs/node job returned ~90k chars for one job and blew an 8 MB buffer on
// another. A buffer overflow here reads as "could not fetch the log", which is
// the plugin failing to answer a question it could have answered.
const MAX_BUFFER = 96 << 20;

/** The engine process may have been launched from the GUI with a minimal PATH,
 *  so `gh` is not necessarily reachable. plugins/plugin-api.md never describes the
 *  engine process's environment; git-branches makes the same allowance. */
const EXTRA_PATH_DIRS = [
  '/usr/bin',
  '/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/local/bin',
];

function childEnv() {
  const env = Object.assign({}, process.env);
  const parts = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) if (!parts.includes(dir)) parts.push(dir);
  env.PATH = parts.join(path.delimiter);

  // Non-interactive and parseable. GIT_TERMINAL_PROMPT=0 is the one that
  // matters: without it a push to a repo whose credentials have expired blocks
  // on a username prompt forever, on a PTY nobody is watching.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GH_PROMPT_DISABLED = '1';
  env.GH_NO_UPDATE_NOTIFIER = '1';
  env.GH_PAGER = 'cat';
  env.PAGER = 'cat';
  env.CLICOLOR = '0';
  env.NO_COLOR = '1';
  env.LC_ALL = 'C';

  // We do not set GH_TOKEN. If the OPERATOR has one exported, gh uses it and
  // that is their arrangement, not ours — but we must not copy it anywhere it
  // could be logged, so the scrubber below knows its shape rather than this
  // function trying to delete it (deleting it would break an operator whose
  // only auth IS that variable).
  return env;
}

/** Token shapes GitHub mints, plus the generic bearer/x-access-token forms. */
const SECRET_RE = /\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|x-access-token:[^@\s]+)/g;

/** Redact anything token-shaped before it reaches a log or an agent. */
function scrub(text) {
  return String(text == null ? '' : text).replace(SECRET_RE, '«redacted»');
}

/**
 * Run a command. NEVER rejects.
 * -> { ok, code, stdout, stderr, spawnFailed?, timedOut? }   (all scrubbed)
 */
function run(cmd, args, cwd, opts) {
  const timeout = (opts && opts.timeout) || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      execFile(cmd, args, { cwd, env: childEnv(), timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
        (err, stdout, stderr) => {
          const out = scrub(stdout).trim();
          const errOut = scrub(stderr).trim();
          if (!err) return done({ ok: true, code: 0, stdout: out, stderr: errOut });
          done({
            ok: false,
            code: typeof err.code === 'number' ? err.code : null,
            stdout: out,
            stderr: errOut || scrub(err.message),
            spawnFailed: err.code === 'ENOENT',
            timedOut: !!err.killed,
          });
        });
    } catch (e) {
      done({ ok: false, code: null, stdout: '', stderr: scrub((e && e.message) || e), spawnFailed: true });
    }
  });
}

const git = (cwd, args, opts) => run('git', args, cwd, opts);
const gh = (cwd, args, opts) => run('gh', args, cwd, opts);

/** `gh … --json` with the parse folded in. -> { ok, data } | { ok:false, … } */
async function ghJson(cwd, args, opts) {
  const r = await gh(cwd, args, opts);
  if (!r.ok) return r;
  if (!r.stdout) return { ok: true, code: 0, stdout: '', stderr: r.stderr, data: null };
  try {
    return Object.assign({}, r, { data: JSON.parse(r.stdout) });
  } catch (e) {
    // A gh that printed something we cannot parse is a real failure, not an
    // empty answer: answering "no PRs" because JSON.parse threw would be the
    // plugin lying, which is the one outcome worse than an error.
    return { ok: false, code: r.code, stdout: r.stdout, stderr: `gh returned unparseable JSON: ${(e && e.message) || e}` };
  }
}

// ---------------------------------------------------------------------------
// Failure classification
//
// The whole point of this block: an agent acting on a wrong answer is worse
// than one told plainly that the call failed. Every one of these has a distinct
// remedy, so collapsing them into "gh failed" would leave the agent guessing —
// and an agent that guesses "not authenticated" when the real answer is "not a
// repo" will do something unhelpful with confidence.
// ---------------------------------------------------------------------------

/** -> a human sentence naming the remedy, or null if `r` is not one of these. */
function diagnose(r) {
  if (!r || r.ok) return null;

  if (r.spawnFailed) {
    return 'the `gh` CLI is not installed, or is not on this app\'s PATH. Install it (https://cli.github.com) and restart Clodex.';
  }
  if (r.timedOut) {
    return 'the GitHub CLI timed out. GitHub may be slow or unreachable; nothing was changed.';
  }

  const m = `${r.stderr || ''}\n${r.stdout || ''}`;

  if (/gh auth login|GH_TOKEN environment variable|authentication token/i.test(m)) {
    return 'the `gh` CLI is not authenticated. The OPERATOR must run `gh auth login` in a terminal — this plugin holds no credentials and cannot do it for you.';
  }
  if (/not a git repository/i.test(m)) {
    return 'this session\'s working directory is not inside a git repository.';
  }
  if (/no git remotes found|none of the git remotes configured/i.test(m)) {
    return 'this git repository has no GitHub remote, so there is no repo to talk to.';
  }
  if (/could not resolve to a Repository|Could not resolve to a Repository/i.test(m)) {
    return 'GitHub does not recognise this repository, or the authenticated account cannot see it.';
  }
  if (/error connecting to|dial tcp|no such host|network is unreachable|TLS handshake|i\/o timeout|connection refused/i.test(m)) {
    return 'could not reach GitHub — check the network connection. Nothing was changed.';
  }
  if (/HTTP 401|Bad credentials/i.test(m)) {
    return 'GitHub rejected the operator\'s credentials (HTTP 401). They must re-run `gh auth login`.';
  }
  if (/HTTP 403|rate limit|SAML enforcement|resource not accessible/i.test(m)) {
    return 'GitHub refused the request (HTTP 403) — a rate limit, an SSO requirement, or a token missing the needed scope.';
  }
  if (/HTTP 404/i.test(m)) {
    return 'GitHub returned 404 — the repository, PR or run does not exist, or is not visible to the authenticated account.';
  }
  return null;
}

/** The first useful line of a failure, for when `diagnose` has no opinion. */
function firstLine(r) {
  const m = String((r && (r.stderr || r.stdout)) || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return m.length ? m[0].slice(0, 300) : 'no output';
}

/** Everything a caller needs to explain a failed command in one sentence. */
function explain(r, what) {
  const d = diagnose(r);
  if (d) return d;
  return `${what} failed: ${firstLine(r)}`;
}

module.exports = { run, git, gh, ghJson, scrub, diagnose, explain, firstLine, DEFAULT_TIMEOUT_MS };
