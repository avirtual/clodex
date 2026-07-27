// Run: node --test
// Covers ipc-prompt-cache.js — freezing a resumed session's system prompt and
// delivering protocol changes as a diff instead of rewriting it underneath a
// live conversation.
//
// Two layers, deliberately:
//   * the decision (pure: ipcDelta / unifiedDiff / stageDelta / bakePrompt)
//   * the DRAIN, exercised by running the REAL generated ipcdelta.sh through
//     the same harness cli-hooks.test.js uses (nodeInterp = this node, so the
//     bytes the packaged app bakes with its Electron binary are the bytes that
//     run here). A hand-simulated rename would pin my idea of the drain rather
//     than the drain, and the ORDER inside that script is the whole mechanism.
//
// THE ENTER QUESTION THAT SHAPES THIS FILE. cleanupClaudeHook rm -rf's
// run/<name>/ on EVERY exit path, so append-prompt.md is already gone when the
// next create() runs. A "resume" simulated by baking twice WITHOUT that teardown
// would reuse a file production has already deleted — the pin would pass while
// testing nothing. So every reuse pin calls simulateExit() between the two
// bakes and ASSERTS the file is absent at that point.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');
const {
  unifiedDiff, ipcDelta, stageDelta, bakePrompt,
  promptCacheDir, cachePathFor, readCache, DELTA_HEADER,
} = require('../ipc-prompt-cache');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-ipccache-')); }

// A realistic prompt: the real one is ~9KB / ~200 lines, and a one-line diff of
// a 200-line file is the case that matters (a diff of two 3-line strings would
// hide a context/hunk bug).
function promptV(extra = '') {
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push(`grammar line ${i}: [agent:verb${i}] does thing ${i}`);
  return `HOW TO COMMUNICATE:\n${lines.join('\n')}\n${extra}RULES:\n- an intent must start on its own line.\n`;
}

// What session-manager's claude arm actually does with bakePrompt's return.
function bake(root, name, realIpc, resumeId) {
  const baked = bakePrompt(root, name, realIpc, !!resumeId);
  const p = pathFor(root, name, 'appendPrompt');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, baked, { mode: 0o600 });
  return baked;
}

// cleanupClaudeHook, for real: the whole run dir, on every exit path.
function simulateExit(root, name) {
  fs.rmSync(runDirFor(root, name), { recursive: true, force: true });
}

// Assert we are genuinely in the post-teardown window. Called between the two
// bakes of every reuse pin — without this the pin cannot distinguish "reused
// the cache" from "the file happened to still be lying there".
function assertRunDirGone(root, name, why) {
  assert.ok(!fs.existsSync(pathFor(root, name, 'appendPrompt')),
    `${why}: append-prompt.md must be ABSENT here — production deletes the whole run dir on every exit, so a reuse pin that skips this teardown reuses a file that in production is already gone and proves nothing`);
}

// Run the REAL generated drain. Returns the additionalContext it emitted, or
// null when it emitted nothing.
function runDrain(root, name) {
  const h = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  h.setupClaudeHook(name);
  const script = pathFor(root, name, 'ipcdeltaScript');
  const r = require('child_process').spawnSync('/bin/bash', [script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `drain exited ${r.status}: ${r.stderr}`);
  const out = r.stdout.trim();
  if (!out) return null;
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

// ------------------------------------------------------------------ the diff

test('unifiedDiff: shows an added line with context, and marks a REMOVAL', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight';
  const d = unifiedDiff(a, 'one\ntwo\nthree\nfour\nADDED\nfive\nsix\nseven\neight');
  assert.ok(d.includes('+ADDED'), 'an added line must appear with a + marker');
  assert.ok(d.includes(' four'), 'with surrounding context so the hunk reads in isolation');

  // The asymmetric-risk case: an intent REMOVED from the protocol. A friendly
  // renderer is exactly what would soften this into something read past.
  const rem = unifiedDiff(a, 'one\ntwo\nthree\nfour\nsix\nseven\neight');
  assert.ok(rem.includes('-five'), 'a removed line must appear with a - marker — a stale prompt documenting a dead verb is the worse failure direction');
  assert.ok(!rem.includes('+five'), 'and must not also read as an addition');
});

test('unifiedDiff: distant regions are elided, not run together', () => {
  const a = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 2', 'line 2 CHANGED').replace('line 55', 'line 55 CHANGED');
  const d = unifiedDiff(a, b);
  assert.ok(d.includes('@@'), 'two far-apart changes must be separated by a hunk marker, not joined by 50 lines of context');
  assert.ok(!d.includes('line 30'), 'untouched distant lines must not be carried into the delta — the point is a cheap tail append');
});

// -------------------------------------------------------- the edge-triggering

test('ipcDelta: identical prompts owe nothing', () => {
  assert.strictEqual(ipcDelta(promptV(), promptV()), null);
});

test('ipcDelta: a changed prompt owes a diff, framed but NOT transformed', () => {
  const d = ipcDelta(promptV(), promptV('[agent:newverb] fresh capability\n'));
  assert.ok(d, 'a changed prompt must produce a delta');
  assert.ok(d.startsWith(DELTA_HEADER), 'one line of framing');
  assert.ok(d.includes('+[agent:newverb] fresh capability'),
    'the delta must carry the literal changed bytes — the channel is dumb (diff in, additionalContext out); a prose renderer can drift from what actually changed');
});

// ------------------------------------------------- (1)(2) freeze on resume

test('resume with an UNCHANGED prompt leaves the baked bytes byte-identical', () => {
  const root = tmp(), name = 'agent1';
  const v1 = promptV();
  const born = bake(root, name, v1, null);

  simulateExit(root, name);
  assertRunDirGone(root, name, 'unchanged-resume');

  const resumed = bake(root, name, v1, 'sess-abc');
  assert.strictEqual(resumed, born, 'a resume must re-bake the exact bytes the conversation was born with');
  assert.strictEqual(fs.readFileSync(pathFor(root, name, 'appendPrompt'), 'utf8'), born);
  assert.ok(!fs.existsSync(cachePathFor(root, name, 'delta')), 'and nothing to announce');
});

test('resume with a CHANGED prompt STILL bakes the original bytes, and stages a delta', () => {
  const root = tmp(), name = 'agent2';
  const v1 = promptV();
  const born = bake(root, name, v1, null);

  simulateExit(root, name);
  assertRunDirGone(root, name, 'changed-resume');

  // Ship an ipc-prompt.js change and restart the app — the exact scenario that
  // cost 111k-139k tokens a time.
  const v2 = promptV('[agent:newverb] fresh capability\n');
  const resumed = bake(root, name, v2, 'sess-abc');

  assert.strictEqual(resumed, born,
    'THE POINT OF THE TICKET: the system prompt must not move under a continuing conversation, even though the generated truth changed');
  assert.notStrictEqual(v2, born, 'ENTER: the two versions must actually differ, or this pin asserts that unchanged input produces unchanged output');

  const delta = readCache(root, name, 'delta');
  assert.ok(delta && delta.includes('+[agent:newverb] fresh capability'),
    'the capability change must still REACH the agent — frozen prompt, fresh knowledge');
  assert.strictEqual(readCache(root, name, 'next'), v2, 'and next.md must hold what last_ipc becomes once delivered');
});

// -------------------------------------------------- (6) fresh session, no delta

test('a FRESH session receives no delta, by construction', () => {
  const root = tmp(), name = 'newborn';
  bake(root, name, promptV(), null);

  assert.strictEqual(readCache(root, name, 'delta'), null,
    'session_ipc == last_ipc == real_ipc at birth, so there is nothing to diff against — a fresh session being handed a delta means last_ipc was initialized wrong, and every new agent would get a diff against nothing');
  assert.strictEqual(readCache(root, name, 'notified'), readCache(root, name, 'session'),
    'the baseline must be seeded to the baked prompt, not left empty');
  assert.strictEqual(runDrain(root, name), null, 'and the drain must emit nothing');
});

// ------------------------------------------ (3) delivered exactly ONCE (edge)

test('a delta is delivered exactly ONCE across many turns (edge-, not level-triggered)', () => {
  const root = tmp(), name = 'agent3';
  const v1 = promptV();
  bake(root, name, v1, null);
  simulateExit(root, name);
  assertRunDirGone(root, name, 'once');

  const v2 = promptV('[agent:newverb] fresh capability\n');
  bake(root, name, v2, 'sess-abc');

  // Turn 1: the real drain emits.
  const first = runDrain(root, name);
  assert.ok(first && first.includes('+[agent:newverb] fresh capability'),
    'ENTER: the first turn must actually deliver the delta — if it never delivers, "delivered once" is vacuously true');

  // Turns 2..N: silence. Comparing against session_ipc (frozen, still v1) would
  // re-announce the same change on every single request forever.
  for (let turn = 2; turn <= 5; turn++) {
    assert.strictEqual(runDrain(root, name), null,
      `turn ${turn}: the change was already announced — re-delivering it means the comparison is against the FROZEN session_ipc (level-triggered) instead of last_ipc (edge-triggered), which repeats unboundedly`);
  }
  assert.strictEqual(readCache(root, name, 'notified'), v2, 'last_ipc must have advanced to the delivered truth');

  // And a later resume with that same truth owes nothing further.
  simulateExit(root, name);
  bake(root, name, v2, 'sess-abc');
  assert.strictEqual(runDrain(root, name), null, 'a resume at the announced version owes nothing');
});

test('a SECOND change after the first was absorbed diffs from the announced version', () => {
  const root = tmp(), name = 'agent4';
  const v1 = promptV();
  bake(root, name, v1, null);
  simulateExit(root, name);

  const v2 = promptV('[agent:newverb] fresh capability\n');
  bake(root, name, v2, 'sess-abc');
  assert.ok(runDrain(root, name), 'ENTER: the first delta must land before a second can be measured against it');
  simulateExit(root, name);

  const v3 = promptV('[agent:newverb] fresh capability\n[agent:secondverb] another one\n');
  bake(root, name, v3, 'sess-abc');
  const second = runDrain(root, name);
  assert.ok(second.includes('+[agent:secondverb] another one'), 'the new change must be announced');
  assert.ok(!second.includes('+[agent:newverb] fresh capability'),
    'but NOT the already-absorbed one — the baseline is what the agent was last told, not what its prompt says');
});

// --------------------------------------- (5) no advance without delivery

test('last_ipc does NOT advance when the delta is never delivered', () => {
  const root = tmp(), name = 'agent5';
  const v1 = promptV();
  bake(root, name, v1, null);
  simulateExit(root, name);

  const v2 = promptV('[agent:newverb] fresh capability\n');
  bake(root, name, v2, 'sess-abc');

  // The agent never took a turn (app quit, crash, session idle) — no drain ran.
  assert.strictEqual(readCache(root, name, 'notified'), v1,
    'staging must not advance last_ipc: an edge-triggered delta that advances before delivery is lost PERMANENTLY, because it is never mentioned again');
  assert.ok(readCache(root, name, 'delta'), 'ENTER: a delta must be staged and still pending here, or there is nothing that could have been lost');

  // Next launch, still undelivered: the agent must still learn about it.
  simulateExit(root, name);
  bake(root, name, v2, 'sess-abc');
  const out = runDrain(root, name);
  assert.ok(out && out.includes('+[agent:newverb] fresh capability'),
    'an undelivered change must survive to the next turn — at-least-once is the safe direction (a repeated diff is noise; a dropped one leaves an agent emitting a verb that no longer exists)');
});

// ----------------------------------------------- (4) boundaries regenerate

test('a boundary regenerates the frozen prompt (fresh / reload / fresh-restart)', () => {
  const root = tmp(), name = 'agent6';
  const v1 = promptV();
  const born = bake(root, name, v1, null);
  simulateExit(root, name);
  assertRunDirGone(root, name, 'boundary');

  // [agent:context reload] and restartSession({fresh:true}) both call create()
  // with resumeId null — a genuinely new conversation, so regenerating is free.
  const v2 = promptV('[agent:newverb] fresh capability\n');
  const rebaked = bake(root, name, v2, null);

  assert.notStrictEqual(rebaked, born, 'a new conversation must adopt the current prompt — freezing it forever would strand the session on stale text');
  assert.strictEqual(rebaked, v2);
  assert.strictEqual(readCache(root, name, 'delta'), null,
    'and it owes no delta: a conversation born with the new prompt already has it');
  assert.strictEqual(readCache(root, name, 'notified'), v2, 'the baseline resets with it');
});

// ------------------------------------------------------- staging hygiene

test('a change that is reverted before delivery clears the stale staging', () => {
  const root = tmp(), name = 'agent7';
  const v1 = promptV();
  bake(root, name, v1, null);

  simulateExit(root, name);
  const v2 = promptV('[agent:newverb] fresh capability\n');
  bake(root, name, v2, 'sess-abc');
  assert.ok(readCache(root, name, 'delta'), 'ENTER: a delta must be staged first, or the clearing under test never has anything to clear');

  // The operator reverts the change and restarts again before the agent ever
  // took a turn. The staged pair now describes a change that no longer exists.
  simulateExit(root, name);
  bake(root, name, v1, 'sess-abc');

  assert.strictEqual(readCache(root, name, 'delta'), null,
    'a stale delta must be cleared — otherwise its eventual drain would advance last_ipc to a version that is no longer real');
  assert.strictEqual(readCache(root, name, 'next'), null, 'and so must its next.md');
  assert.strictEqual(runDrain(root, name), null, 'nothing is owed');
});

test('the drain advances last_ipc only AFTER emitting, and is idempotent on re-run', () => {
  const root = tmp(), name = 'agent8';
  const v1 = promptV();
  bake(root, name, v1, null);
  simulateExit(root, name);
  const v2 = promptV('[agent:newverb] fresh capability\n');
  bake(root, name, v2, 'sess-abc');

  assert.strictEqual(readCache(root, name, 'notified'), v1, 'ENTER: last_ipc must still be the OLD value going in, or the advance under test already happened');
  assert.ok(runDrain(root, name), 'the drain emits');
  assert.strictEqual(readCache(root, name, 'notified'), v2, 'and only then advances last_ipc');
  assert.strictEqual(readCache(root, name, 'delta'), null, 'consuming the staged delta');
  assert.strictEqual(readCache(root, name, 'next'), null);
});

test('the generated drain EMITS before it advances — pinned as byte order', () => {
  // The order inside ipcdelta.sh is the entire safety property, and it is only
  // observable under a crash BETWEEN the two steps — which a test cannot stage
  // against a real subprocess without faking the failure it claims to survive.
  // So pin the order in the generated bytes, the same way this repo pins every
  // other hook script. Reordering these two lines is silent at runtime on the
  // happy path and only shows up as a permanently-lost delta in production.
  const root = tmp(), name = 'ordered';
  const h = createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  h.setupClaudeHook(name);
  const body = fs.readFileSync(pathFor(root, name, 'ipcdeltaScript'), 'utf8');

  const emitAt = body.indexOf('console.log');
  const renameAt = body.indexOf('renameSync');
  const unlinkAt = body.indexOf('unlinkSync');
  assert.ok(emitAt > 0 && renameAt > 0 && unlinkAt > 0,
    'ENTER: the drain must actually contain an emit, a rename and an unlink, or the ordering assertions below compare -1s and pass vacuously');
  assert.ok(emitAt < renameAt,
    'the emit MUST come before the rename that advances last_ipc: advancing first means a delta that fails to deliver is never mentioned again, because the baseline has already moved past it');
  assert.ok(renameAt < unlinkAt,
    'and the staged delta must only be dropped after the advance it pays for');
});

// --------------------------------------------------------- cache placement

test('the cache lives at the SHARED root, outside the run dir that every exit deletes', () => {
  const root = tmp(), name = 'agent9';
  bake(root, name, promptV(), null);

  const dir = promptCacheDir(root, name);
  assert.strictEqual(dir, path.join(root, 'promptcache', name));
  assert.ok(!dir.startsWith(runDirFor(root, name)),
    'promptcache must NOT sit under run/<name>/ — cleanupClaudeHook rm -rf s that dir on every exit path, including the one immediately before the resume this cache exists to serve');

  simulateExit(root, name);
  assert.ok(fs.existsSync(cachePathFor(root, name, 'session')),
    'so the frozen prompt must survive a session exit — this is the failure that would make the whole feature a no-op');
});
