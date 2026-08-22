'use strict';

/**
 * github — engine half. One intent verb, `[agent:gh …]`, with four
 * sub-commands. No renderer half, no UI, no settings: this plugin exists to
 * make an AGENT shorter-winded, not to decorate a window.
 *
 * ---------------------------------------------------------------------------
 * CREDENTIALS: THERE ARE NONE, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 * `host.storage` is plaintext JSON with no mode bits (plugin-api.md §4), and
 * `host.settings` is worse — it lives in the user's UI settings and is readable
 * by anything that reads that file. So this plugin holds NO secret at all:
 *
 *   - no token setting, no token in storage, no token argument on any method,
 *   - no token in argv or in the environment we construct (proc.js),
 *   - a scrubber on every byte that reaches a log or an agent, for the case
 *     where `gh` echoes one back at us.
 *
 * Authentication is `gh`'s, held in the operator's keychain, established by the
 * operator running `gh auth login` in a terminal. The plugin shells out and gh
 * authenticates itself. If gh is not logged in, the honest answer — and the one
 * the agent gets — is "the operator must run `gh auth login`", NOT a prompt for
 * a token that this plugin has nowhere safe to put.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE VERB WITH SUB-COMMANDS
 * ---------------------------------------------------------------------------
 * Verbs are one flat global namespace (plugin-api.md §7, plugin-sources.md
 * §4a): a collision means a plugin does not load. Four verbs would take four
 * slots out of that namespace AND — because every plugin verb is forced
 * privileged — would need four separate ticks in every seat's intent checklist.
 * One verb is one slot and one grant.
 *
 * `gh` is the chosen name. It is short (it lands in every granted seat's system
 * prompt and in every line an agent writes) and it is the literal name of the
 * tool it fronts, so a second plugin that wants it is by definition another
 * GitHub plugin — a collision that is *correct signal* rather than two authors
 * independently reaching for an English word like `notes` or `run`. The failure
 * mode is documented and survivable: this plugin does not load, and Manage
 * Plugins names the holder.
 *
 * ---------------------------------------------------------------------------
 * SYNCHRONY
 * ---------------------------------------------------------------------------
 * §7: handlers are synchronous, and a returned promise is logged and ignored —
 * its rejection escapes every guard, so failure becomes silence. So the handler
 * does the synchronous part (validate, resolve the cwd, take the lock) and
 * schedules the rest, injecting the answer when it lands. Nothing here returns
 * a promise to the host.
 */

const wf = require('./workflows');

// ---------------------------------------------------------------------------
// Module-level state.
//
// §10: Node's module cache survives a disable, so a re-enable calls activate()
// again on THIS module object. Everything is reset at the top of activate()
// rather than merely initialised here.
// ---------------------------------------------------------------------------

let host = null;
/** session name -> true, while a MUTATING sub-command is in flight for it. */
let busy = new Set();

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
const MUTATING = new Set(['pr']);

const USAGE = [
  'unknown sub-command. Usage:',
  '  [agent:gh status]        repo, branch vs base, PR, CI and review state',
  '  [agent:gh pr]            push and open a PR (prose body optional, ends at [agent:end])',
  '  [agent:gh pr --dry]      the same, stopping before the push, to show the description',
  '  [agent:gh ci]            failing checks and the tail of each failed step\'s log',
  '  [agent:gh review]        unresolved review threads as a file:line worklist',
];

const PROMPT_LINES = [
  '  [agent:gh status]           this repo: branch vs base, PR, CI, reviews — one call. Check before opening or merging.',
  '  [agent:gh pr]               push and open a PR; the description is written from your commits. A body (to [agent:end]) becomes its intro. Refuses on a dirty tree, an empty branch, or an existing PR.',
  '  [agent:gh pr --dry]         the same, stopping before the push, so you can show the description first.',
  '  [agent:gh ci]               failing checks, with the tail of each failed step\'s log.',
  '  [agent:gh review]           unresolved review threads as a file:line worklist.',
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

/**
 * The one place a reply is sent. `parkable` is left at its default (true): the
 * agent is mid-turn by construction — it just emitted the line — so the answer
 * rides its next turn rather than interrupting the one in progress.
 */
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
    case 'pr':     return wf.openPr(cwd, { body: intent.body, dry: intent.dry });
    case 'ci':     return wf.ci(cwd);
    case 'review': return wf.review(cwd);
    default:       return Promise.resolve({ ok: false, text: `[gh] ${USAGE.join('\n')}` });
  }
}

/**
 * Synchronous. Validates, resolves the cwd through the mandated gate, takes the
 * lock for mutating sub-commands, and schedules the work.
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

  // Mutating sub-commands take a per-session lock. The handler fires exactly
  // once per matched line (§7), so this is not a de-duplication guard — it is
  // for an agent that emits [agent:gh pr] twice in two turns while the first
  // push is still running. `openPr`'s existing-PR check would not catch that:
  // both calls would pass it before either created anything.
  const mutating = MUTATING.has(intent.sub) && !intent.dry;
  if (mutating) {
    if (busy.has(name)) {
      send(sessionHandle, '[gh] a previous [agent:gh pr] is still running for this session. Nothing was done — wait for its answer.');
      return;
    }
    busy.add(name);
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
    })
    .then(() => { if (mutating) busy.delete(name); });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

module.exports.activate = (h) => {
  host = h;
  busy = new Set();

  host.intents.register({
    verb: 'gh',
    parse: parseLine,
    // A function of the parsed intent, not a flag (§7): only `pr` takes prose,
    // and a greedy body on `status` would swallow the agent's next paragraph.
    bodyMode: (intent) => (intent && intent.sub === 'pr' ? 'greedy' : 'none'),
    label: 'GitHub (status / PR / CI / review)',
    promptLines: PROMPT_LINES,
    handler: handle,
  });

  // Drop a stuck lock if the session dies mid-push. Synchronous, as §4 requires.
  host.sessions.onExit((sh) => { if (sh && sh.name) busy.delete(sh.name); });

  logInfo('activated — [agent:gh] available (holds no credentials; shells out to the operator\'s gh CLI)');
};

module.exports.deactivate = () => {
  busy.clear();
  logInfo('deactivated');
  host = null;
  // The intent row and the session hook are torn down unconditionally by the
  // host (§10); we hold no disposers because there is nothing it would miss.
};

// Exported for the test harness only. Not part of any host contract.
module.exports._internals = { parseLine, USAGE, PROMPT_LINES };
