'use strict';

/**
 * github — engine half. One intent verb, `[agent:gh …]`.
 *
 * READ-ONLY BY CONSTRUCTION. `status`, `ci` and `review` read; `pr --dry`
 * renders a description locally. Nothing here pushes, and a bare `pr` refuses
 * rather than falling back to the dry run — see REFUSE_PR. Do not add a write
 * path: pushing is the operator's, and an agent verb that opens a real PR is
 * outward-facing and hard to reverse.
 *
 * CREDENTIALS: THERE ARE NONE, AND THAT IS THE DESIGN. `host.storage` is
 * plaintext JSON with no mode bits (plugins/plugin-api.md §4) and `host.settings`
 * lives in the user's UI settings, so this plugin holds no secret at all: no
 * token setting, no token in storage, none in argv, none in the environment it
 * constructs (proc.js). Authentication is `gh`'s own, in the operator's
 * keychain. If gh is not logged in the honest answer — and the one the agent
 * gets — is "the operator must run `gh auth login`", NOT a prompt for a token
 * this plugin has nowhere safe to put.
 *
 * SYNCHRONY (§7): handlers are synchronous, and a returned promise is logged and
 * ignored — its rejection escapes every guard, so failure becomes silence. The
 * handler does the synchronous part and schedules the rest, injecting the answer
 * when it lands. Nothing here returns a promise to the host.
 */

const wf = require('./workflows');

// §10: Node's module cache survives a disable, so a re-enable calls activate()
// again on THIS module object. Reset in activate(), not merely initialised here.
let host = null;

function errText(e) { return String((e && e.message) || e); }
function logInfo(m) { try { if (host) host.log.info(m); } catch (_) { /* ignore */ } }
function logError(m) { try { if (host) host.log.error(m); } catch (_) { /* ignore */ } }

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

// `[agent:gh]`, `[agent:gh status]`, `[agent:gh pr --dry]`. The bracket contents
// are the command; anything after the bracket is the body (greedy, for `pr`).
const LINE_RE = /^\[agent:gh(\s[^\]]*)?\]\s*([\s\S]*)$/;

const SUBS = new Set(['status', 'pr', 'ci', 'review']);

const USAGE = [
  'unknown sub-command. Usage:',
  '  [agent:gh status]        repo, branch vs base, PR, CI and review state',
  '  [agent:gh ci]            failing checks and the tail of each failed step\'s log',
  '  [agent:gh review]        unresolved review threads as a file:line worklist',
  '  [agent:gh pr --dry]      render the PR title, description and diffstat without opening anything',
];

// A bare `pr` must REFUSE, not quietly do the dry run: a verb that silently does
// less than its name says is worse than one that declines, and an agent told
// "opened" when nothing was opened will report that to its operator.
const REFUSE_PR = [
  'opening a pull request is the operator\'s action, not an agent\'s — this plugin cannot push or create one.',
  'Use `[agent:gh pr --dry]` to render the title, description and diffstat of the PR that would be opened,',
  'show that to your operator, and let them open it.',
].join('\n');

const PROMPT_LINES = [
  '  [agent:gh status]           this repo: branch vs base, PR, CI, reviews — one call. Check before opening or merging.',
  '  [agent:gh ci]               failing checks, with the tail of each failed step\'s log.',
  '  [agent:gh review]           unresolved review threads as a file:line worklist.',
  '  [agent:gh pr --dry]         render the PR description your commits would produce. A body (to [agent:end]) becomes its intro. Nothing is pushed — opening the PR is the operator\'s.',
  '  Uses the operator\'s own authenticated gh CLI. You never handle a token — never ask for one.',
].join('\n');

function parseLine(line) {
  const m = LINE_RE.exec(String(line == null ? '' : line));
  if (!m) return null;

  const words = String(m[1] || '').trim().split(/\s+/).filter(Boolean);
  const sub = (words.shift() || 'status').toLowerCase();
  const flags = words.map((w) => w.toLowerCase());

  return {
    sub,
    known: SUBS.has(sub),
    dry: flags.includes('--dry') || flags.includes('--dry-run') || flags.includes('-n'),
    // Same-line trailing text is the start of the body; greedy capture appends
    // following lines to `intent.body` (session-manager's _extractIntents), so
    // this field must survive under that name.
    body: (m[2] || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** `parkable` is left at its default: the agent is mid-turn by construction — it
 *  just emitted the line — so the answer rides its next turn. */
function send(handle, text) {
  try {
    if (!handle.isAlive()) return;      // documented safe no-op; this just skips the work
    handle.inject(text);
  } catch (e) {
    logError(`inject to "${handle.name}" failed: ${errText(e)}`);
  }
}

function runSub(cwd, intent) {
  switch (intent.sub) {
    case 'status': return wf.status(cwd);
    case 'ci':     return wf.ci(cwd);
    case 'review': return wf.review(cwd);
    // The refusal is decided here, before any shell-out: it does not depend on
    // repo state, so making the agent wait on `gh repo view` to be told no would
    // be a slower way to say the same thing.
    case 'pr':     return intent.dry
      ? wf.prDryRun(cwd, { body: intent.body })
      : Promise.resolve({ ok: false, text: `[gh] ${REFUSE_PR}` });
    default:       return Promise.resolve({ ok: false, text: `[gh] ${USAGE.join('\n')}` });
  }
}

/**
 * Synchronous. Validates, resolves the cwd through the mandated gate, and
 * schedules the work.
 *
 * NOT wrapped in a try/catch: §7 turns a throwing handler into an
 * `[agent:gh] error: …` bounce that reaches the agent that asked, which for a
 * verb whose whole job is to answer beats a log line nobody reads.
 */
function handle(sessionHandle, intent) {
  const name = sessionHandle && sessionHandle.name;
  if (typeof name !== 'string' || !name) {
    logError('[agent:gh] fired without a usable session handle; nothing reported');
    return;
  }

  if (!intent.known) { send(sessionHandle, `[gh] ${USAGE.join('\n')}`); return; }

  // fsScope is the mandated gate (§4) and the one that refuses peer sessions.
  // We never read handle.cwd for this: fsScope is the same guard core uses, and
  // its 'remote' string is the stable, matchable one.
  const scope = host.sessions.fsScope(name);
  if (!scope || typeof scope !== 'object') {
    send(sessionHandle, '[gh] could not resolve this session\'s working directory.');
    return;
  }
  if (scope.error === 'remote') {
    send(sessionHandle, '[gh] not available for remote sessions — this session lives on a peer machine, so there is no local repository to read.');
    return;
  }
  if (scope.error === 'Session has no working directory') {
    send(sessionHandle, '[gh] this session has no working directory, so there is no repository to act on.');
    return;
  }
  if (scope.error === 'Session not found') {
    send(sessionHandle, '[gh] this session is no longer registered, so its working directory cannot be resolved.');
    return;
  }
  if (scope.error) { send(sessionHandle, `[gh] cannot act on this session: ${scope.error}.`); return; }

  const cwd = scope.cwd;
  if (typeof cwd !== 'string' || !cwd) {
    send(sessionHandle, '[gh] this session has no working directory, so there is no repository to act on.');
    return;
  }

  runSub(cwd, intent)
    .then((r) => {
      if (!host) return;                              // disabled while gh was running
      send(sessionHandle, (r && r.text) || '[gh] no result.');
    })
    .catch((e) => {
      // workflows.js is written not to reject; if one ever does, the agent that
      // asked hears about it rather than the log alone.
      logError(`[agent:gh ${intent.sub}] threw for "${name}": ${errText(e)}`);
      if (host) send(sessionHandle, `[gh] internal error running "${intent.sub}": ${errText(e)}`);
    });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

module.exports.activate = (h) => {
  host = h;

  host.intents.register({
    verb: 'gh',
    parse: parseLine,
    // A function of the parsed intent, not a flag (§7): only `pr` takes prose,
    // and a greedy body on `status` would swallow the agent's next paragraph.
    bodyMode: (intent) => (intent && intent.sub === 'pr' ? 'greedy' : 'none'),
    label: 'GitHub (status / CI / review / PR dry run)',
    promptLines: PROMPT_LINES,
    handler: handle,
  });

  logInfo('activated — [agent:gh] available (read-only; holds no credentials; shells out to the operator\'s gh CLI)');
};

module.exports.deactivate = () => {
  logInfo('deactivated');
  host = null;
  // The intent row is torn down unconditionally by the host (§10); we hold no
  // disposers because there is nothing it would miss.
};

// Exported for the test harness only. Not part of any host contract.
module.exports._internals = { parseLine, USAGE, PROMPT_LINES, REFUSE_PR, SUBS };
