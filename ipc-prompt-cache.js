// ipc-prompt-cache.js — freeze a session's system prompt, deliver its changes
// as a diff instead of rewriting it underneath a live conversation.
//
// Why this exists: session-manager's claude arm regenerated
// run/<name>/append-prompt.md on EVERY create(), and create() also runs on
// restore-with---resume. So shipping any ipc-prompt.js edit and restarting the
// app changed the system prompt under every continuing conversation. The cache
// breakpoint sits before the system block, so a single byte anywhere in it
// invalidates the whole segment plus everything after — measured at 111k-139k
// tokens per occurrence, three times over five days of one session. The write
// cost does NOT depend on where in the prompt the edit lands (read_tokens was
// 9744 for an insert at char 13605 and for one at 19348), which is why
// "append new material at the tail" saves nothing and is not what this does.
//
// THREE STATES, not two:
//   session_ipc  (session.md)  what is baked into THIS session's system prompt.
//                              Frozen for the life of the conversation.
//   last_ipc     (notified.md) the last prompt we NOTIFIED this agent about.
//   real_ipc                   freshly generated current truth (not stored; it
//                              is whatever create() just built).
//
// The comparison is real_ipc vs last_ipc, NEVER real_ipc vs session_ipc. This
// is the load-bearing detail and the whole reason the design works. session_ipc
// is frozen until a boundary, so comparing against it is LEVEL-triggered: it
// would re-deliver the same delta on every single request, forever. Comparing
// against last_ipc is EDGE-triggered — each change is announced exactly once.
// A later refactor that "simplifies" these two into one comparison reintroduces
// an unbounded repeat; they are not the same value and must not be merged.
//
// EDGE-TRIGGERING'S HAZARD, AND WHY THE ORDER CLOSES IT. A delta that is
// delivered but never absorbed is lost permanently, because last_ipc has
// already advanced past it. So last_ipc is NOT advanced here at all: this
// module only STAGES (delta.md = what to say, next.md = what last_ipc becomes).
// The drain hook emits delta.md and only THEN renames next.md over notified.md.
// The advance is therefore unreachable before delivery by construction rather
// than guarded against — and a crash between the emit and the rename re-delivers
// the same delta next turn. At-least-once, never at-most-once: a repeated diff
// is noise, a dropped one is an agent emitting a verb that no longer exists.
//
// WHERE THE FILES LIVE, and why not under run/<name>/. cleanupClaudeHook rm -rf's
// the whole run/<name>/ dir, and _cleanup calls it on EVERY exit path — natural
// exit, restart's kill, quit's killAll — not only user-kill. A cache under run/
// would be deleted by the exit immediately preceding the resume it exists to
// serve. So this mirrors pending/ exactly (clodex-paths.js: "SHARED state stays
// at the ~/.clodex ROOT and never moves"): the DATA sits at
// ~/.clodex/promptcache/<name>/, only the drain SCRIPT is per-run.
//
// Pure fs + string helpers, dependency-free (no electron), like ctx-reminder.js
// and pending-store.js, so the decision and the diff are unit-testable without
// a live CLI.

'use strict';

const fs = require('fs');
const path = require('path');

// The four texts, all under promptcache/<name>/. `next` is deliberately a
// separate file from `notified` rather than an in-place write: the drain's final
// step has to be ATOMIC (rename) so a half-written last_ipc can't exist.
const CACHE_FILES = {
  session: 'session.md',
  notified: 'notified.md',
  delta: 'delta.md',
  next: 'next.md',
};

// One line of framing, and deliberately no more. The channel is dumb: diff in,
// additionalContext out. A prose renderer can drift from the actual bytes, and
// a REMOVED capability is exactly what a friendlier rendering would soften into
// something an agent reads past — a removal must survive intact.
const DELTA_HEADER = '<system-reminder>'
  + 'Your Clodex instructions changed since this conversation started. Your system '
  + 'prompt still shows the OLD text (rewriting it mid-conversation would re-bill '
  + 'your entire context), so treat the diff below as authoritative where the two '
  + 'disagree. Lines marked - were removed; lines marked + were added.'
  + '</system-reminder>';

function promptCacheDir(root, name) { return path.join(root, 'promptcache', name); }

function cachePathFor(root, name, kind) {
  const base = CACHE_FILES[kind];
  if (!base) throw new Error(`ipc-prompt-cache: unknown kind '${kind}'`);
  return path.join(promptCacheDir(root, name), base);
}

// Absent file → null, never ''. The distinction matters: a missing notified.md
// means "no baseline recorded" (seed it), while an empty one would mean "the
// agent was last told the prompt is empty" and would diff the whole prompt in.
function readCache(root, name, kind) {
  try { return fs.readFileSync(cachePathFor(root, name, kind), 'utf8'); } catch { return null; }
}

// tmp + rename, same discipline as pending-store's publish: a reader (the drain
// hook, running in another process on the agent's own turn) must never see a
// partial file.
function writeCache(root, name, kind, text) {
  const dest = cachePathFor(root, name, kind);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, dest);
}

function clearCache(root, name, kind) {
  try { fs.unlinkSync(cachePathFor(root, name, kind)); } catch {}
}

// --- diff ---------------------------------------------------------------

// Longest common subsequence over LINES, table-driven. The prompt is ~9KB /
// ~200 lines, so the O(n*m) table is a few tens of thousands of small ints —
// paid once per spawn, never per turn. Returns the LCS length table.
function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

// A unified diff of two texts, context lines included so a hunk is readable in
// isolation. No @@ line numbers: they'd be noise here (the reader can't seek
// into a system prompt it doesn't have) and a spurious source of churn — an
// insert near the top would renumber every later hunk and make an unrelated
// change look large. Hunks are separated by a marker instead.
function unifiedDiff(oldText, newText, opts = {}) {
  const context = opts.context != null ? opts.context : 3;
  const a = String(oldText == null ? '' : oldText).split('\n');
  const b = String(newText == null ? '' : newText).split('\n');
  const table = lcsTable(a, b);

  // Walk the table into a flat op list: ' ' common, '-' removed, '+' added.
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < a.length) { ops.push(['-', a[i++]]); }
  while (j < b.length) { ops.push(['+', b[j++]]); }

  // Keep only changed runs plus `context` common lines either side.
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] === ' ') continue;
    for (let m = Math.max(0, k - context); m <= Math.min(ops.length - 1, k + context); m++) keep[m] = true;
  }

  const out = [];
  let gap = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) { gap = true; continue; }
    if (gap && out.length) out.push('@@');
    gap = false;
    out.push(ops[k][0] + ops[k][1]);
  }
  return out.join('\n');
}

// --- the decision -------------------------------------------------------

// Edge-triggered: given the last prompt we announced and the current truth,
// what (if anything) do we owe this agent? Pure — no I/O — so the rule itself
// is testable without a filesystem.
function ipcDelta(lastIpc, realIpc) {
  if (lastIpc == null || realIpc === lastIpc) return null;
  const body = unifiedDiff(lastIpc, realIpc);
  if (!body.trim()) return null;
  return `${DELTA_HEADER}\n\n${body}`;
}

// Producer side, called from create(). Stages a delta for the drain hook to
// deliver, and returns it (or null when there is nothing to say).
//
// NOTE what this does NOT do: it never writes notified.md. Only the drain does,
// and only after it has emitted. See the module header.
function stageDelta(root, name, lastIpc, realIpc) {
  const delta = ipcDelta(lastIpc, realIpc);
  if (!delta) {
    // Nothing owed — and clear any delta staged by an EARLIER spawn that never
    // drained. Without this, a change that was later reverted would leave a
    // stale delta.md/next.md pair whose eventual drain would advance last_ipc
    // to a value that is no longer real.
    clearCache(root, name, 'delta');
    clearCache(root, name, 'next');
    return null;
  }
  // next.md first: if we crash between the two writes, a next.md with no
  // delta.md is inert (the drain gates on delta.md), whereas a delta.md with no
  // next.md would emit and then fail to advance — re-delivering forever.
  writeCache(root, name, 'next', realIpc);
  writeCache(root, name, 'delta', delta);
  return delta;
}

// Boundary side. `reuse` is true for a plain resume (the whole point of this
// module) and false at a genuine conversation boundary — a fresh session,
// [agent:context reload], or restartSession({fresh:true}) — where the CLI is
// building a new conversation and regenerating costs nothing.
//
// Returns the blob to actually bake into append-prompt.md.
function bakePrompt(root, name, realIpc, reuse) {
  const baked = reuse ? readCache(root, name, 'session') : null;
  if (baked == null) {
    // A boundary (or a first run with no cache at all). session_ipc == last_ipc
    // == real_ipc by construction, so a fresh session can never be handed a
    // delta — zero deltas is the healthy steady state, and a fresh session
    // producing one would mean last_ipc was initialized wrong.
    writeCache(root, name, 'session', realIpc);
    writeCache(root, name, 'notified', realIpc);
    clearCache(root, name, 'delta');
    clearCache(root, name, 'next');
    return realIpc;
  }
  // Resuming. last_ipc defaults to what is BAKED when no notified.md exists —
  // the first resume after upgrading into this feature has a session.md only if
  // it was written by this code, but a missing notified.md is still the
  // recoverable case, and the baked bytes are the honest baseline for it.
  const lastIpc = readCache(root, name, 'notified');
  stageDelta(root, name, lastIpc == null ? baked : lastIpc, realIpc);
  return baked;
}

module.exports = {
  CACHE_FILES, DELTA_HEADER,
  promptCacheDir, cachePathFor, readCache, writeCache, clearCache,
  unifiedDiff, ipcDelta, stageDelta, bakePrompt,
};
