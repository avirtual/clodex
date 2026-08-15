'use strict';
// spawn-focus-steal.test.js — a newly created session must not take the
// keyboard out from under an operator who is typing.
//
// The live defect (2026-08-15): the operator was mid-sentence to the lead when
// `[agent:task start t411]` spawned a seat; focus jumped and the in-flight
// keystrokes became stdin for a freshly spawned CLI.
//
// Three cases, and the THIRD is the one that keeps this file honest: a fix that
// simply stopped focusing new sessions would satisfy the first two and break
// normal use. The regression guard is not optional here.
//
// The draft answer is INJECTED as the query rather than computed, because the
// property under test is that the decision defers to main-side draft state —
// a test that recomputed the draft itself would be asserting its own arithmetic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  shouldFocusNewSession, decideNewSessionFocus, planNewSession,
} = require('../renderer/lib/focus-policy');
const { isDraftOpen } = require('../proxy-util');

// A query standing in for `window.api.draftOpen` → `session:draftOpen`. Records
// what it was asked, so a decision that never consulted the draft is visible.
function draftQuery(open, asked = []) {
  return async (name) => { asked.push(name); return { ok: true, open }; };
}

// ── the three cases the ticket names ────────────────────────────────────────

test('agent-spawned seat + idle focused session → focus does NOT move', async () => {
  const asked = [];
  const target = await decideNewSessionFocus({
    name: 'clodex-hand-411', focused: 'clodex', agentInitiated: true,
    queryDraftOpen: draftQuery(false, asked),
  });
  assert.strictEqual(target, null, 'background work must not take the keyboard');
  // Provenance alone decided it, but the draft was still consulted — the veto
  // has to be reachable for the case below, from this same call shape.
  assert.deepStrictEqual(asked, ['clodex'], 'asked about the FOCUSED session, not the new one');
});

test('agent-spawned seat + OPEN draft → focus does NOT move (the live defect)', async () => {
  const target = await decideNewSessionFocus({
    name: 'clodex-hand-411', focused: 'clodex', agentInitiated: true,
    queryDraftOpen: draftQuery(true),
  });
  assert.strictEqual(target, null);
});

test('manually created session + idle focused session → focus MOVES, as before', async () => {
  const asked = [];
  const target = await decideNewSessionFocus({
    name: 'scratch', focused: 'clodex', agentInitiated: false,
    queryDraftOpen: draftQuery(false, asked),
  });
  assert.strictEqual(target, 'scratch', 'the operator asked for this session; give it the keyboard');
  assert.deepStrictEqual(asked, ['clodex']);
});

// ── the draft veto outranks provenance ──────────────────────────────────────

test('an open draft vetoes a MANUAL create too — rule 1 is above rule 2', async () => {
  // Cmd+T while mid-line is still a half-typed sentence that would be cut off.
  // The dialog is modal, so this is the Cmd+T-then-Escape-then-type ordering
  // and the template-click path, not a hypothetical.
  const target = await decideNewSessionFocus({
    name: 'scratch', focused: 'clodex', agentInitiated: false,
    queryDraftOpen: draftQuery(true),
  });
  assert.strictEqual(target, null);
});

test('the veto reads the draft state main already gates injection on', () => {
  // The one that ships wrong if a second "is typing" notion appears: these are
  // proxy-util's own semantics, and the focus decision must consume THEM.
  const typing = { lastUserInputTs: 200, lastUserSubmitTs: 100 };
  const submitted = { lastUserInputTs: 100, lastUserSubmitTs: 200 };
  assert.strictEqual(isDraftOpen(typing), true);
  assert.strictEqual(isDraftOpen(submitted), false);

  assert.strictEqual(
    shouldFocusNewSession({ agentInitiated: false, focusedDraftOpen: isDraftOpen(typing) }),
    false, 'mid-line: even a manual create waits');
  assert.strictEqual(
    shouldFocusNewSession({ agentInitiated: false, focusedDraftOpen: isDraftOpen(submitted) }),
    true, 'line submitted: nothing to interrupt');
});

// ── edges that decide whether the rule is usable ────────────────────────────

test('no focused session → a background seat still takes the empty window', async () => {
  const target = await decideNewSessionFocus({
    name: 'clodex-hand-411', focused: null, agentInitiated: true,
    queryDraftOpen: draftQuery(true),
  });
  assert.strictEqual(target, 'clodex-hand-411',
    'there is no draft behind an empty state — spawning invisibly would be the worse bug');
});

test('a failed draft query does not strand the manual path unfocused', async () => {
  const target = await decideNewSessionFocus({
    name: 'scratch', focused: 'clodex', agentInitiated: false,
    queryDraftOpen: async () => { throw new Error('ipc gone'); },
  });
  assert.strictEqual(target, 'scratch', 'unknown draft ⇒ pre-t412 behaviour for a manual create');
});

test('a failed draft query still holds an AGENT spawn back', async () => {
  // The asymmetry is the point: the failure mode of the query must not be able
  // to reopen the defect, and provenance needs no query to be decided.
  const target = await decideNewSessionFocus({
    name: 'clodex-hand-411', focused: 'clodex', agentInitiated: true,
    queryDraftOpen: async () => { throw new Error('ipc gone'); },
  });
  assert.strictEqual(target, null);
});

test('a session created into its own focus is not asked about itself', async () => {
  const asked = [];
  const target = await decideNewSessionFocus({
    name: 'clodex', focused: 'clodex', agentInitiated: false,
    queryDraftOpen: draftQuery(true, asked),
  });
  assert.deepStrictEqual(asked, [], 'no round trip whose answer cannot change the outcome');
  assert.strictEqual(target, 'clodex');
});

test('the full decision surface, so a silently dropped input is visible', () => {
  // deepStrictEqual on the whole matrix rather than four spot checks: an
  // argument that stops being read still satisfies the case that agrees with
  // its default, and only the exhaustive shape shows which one went dead.
  const matrix = {};
  for (const agentInitiated of [false, true]) {
    for (const focusedDraftOpen of [false, true]) {
      matrix[`agent=${agentInitiated},draft=${focusedDraftOpen}`] =
        shouldFocusNewSession({ agentInitiated, focusedDraftOpen });
    }
  }
  assert.deepStrictEqual(matrix, {
    'agent=false,draft=false': true,   // manual, idle → focus (today's behaviour)
    'agent=false,draft=true': false,   // draft vetoes provenance
    'agent=true,draft=false': false,   // background work stays background
    'agent=true,draft=true': false,
  });
});

// ── fitted is not focused (r1 nit 2) ────────────────────────────────────────
//
// The regression t412 itself introduced: `fitAddon.fit()` rode along inside
// switchSession, so withholding focus silently withheld the MEASUREMENT too. A
// background seat then sat at xterm's 80x24 default against a 120x30 PTY and
// wrapped every line wrong until the operator first clicked it.
//
// Each assertion below names ONE of the two outputs. Asserting them together —
// the shape that reads naturally — is precisely what cannot catch a re-coupling,
// because a fit that only happens when focus does satisfies any test that only
// ever checks them in the same breath.

test('a background-created seat is FITTED even though it is not focused', async () => {
  const plan = await planNewSession({
    name: 'clodex-hand-411', focused: 'clodex', agentInitiated: true,
    queryDraftOpen: draftQuery(false),
  });
  assert.strictEqual(plan.focus, false, 'still no focus theft');
  assert.strictEqual(plan.fit, true, 'but it must be measured against the 120x30 PTY');
});

test('the draft veto withholds focus without withholding the fit', async () => {
  const plan = await planNewSession({
    name: 'clodex-hand-411', focused: 'clodex', agentInitiated: true,
    queryDraftOpen: draftQuery(true),
  });
  assert.strictEqual(plan.focus, false);
  assert.strictEqual(plan.fit, true, 'an operator mid-line still gets a correctly wrapped seat');
});

test('fit is unconditional across the whole decision surface', async () => {
  // The property is "no input can turn the fit off", so it is asserted over the
  // same matrix the focus rules use rather than at one convenient point.
  const seen = new Set();
  for (const agentInitiated of [false, true]) {
    for (const open of [false, true]) {
      for (const focused of ['clodex', null]) {
        const plan = await planNewSession({
          name: 'seat', focused, agentInitiated, queryDraftOpen: draftQuery(open),
        });
        seen.add(plan.fit);
      }
    }
  }
  assert.deepStrictEqual([...seen], [true], 'every path fits; none of the eight may skip it');
});

test('the renderer measures the non-focus path instead of returning early', () => {
  // The leaf can only ask for the fit; this is the half that performs it, and
  // an early `return false` before it is the exact shape of the regression.
  const src = read('renderer/renderer.js');
  const fn = src.match(/async function switchToNewSession[\s\S]*?\n\}/);
  assert.ok(fn, 'ENTER: switchToNewSession is still the create-time activation step');
  assert.match(fn[0], /fitSessionInBackground\(name\)/,
    'the non-focus branch must still measure the terminal');

  // And the measurement must not quietly focus, which would restore the theft.
  const fit = src.match(/function fitSessionInBackground[\s\S]*?\n\}/);
  assert.ok(fit, 'ENTER: the background fit helper is still there to check');
  assert.doesNotMatch(fit[0], /\.focus\(\)/, 'measuring must not take the keyboard');
  assert.match(fit[0], /fitAddon\.fit\(\)/);
  assert.match(fit[0], /resizeSession\(name/, 'the PTY has to be told the new size');
});

// ── the wiring: the flag has to reach the decision ──────────────────────────

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The `_sendToSession(..., 'session:context-action', { ... })` argument object,
// brace-matched from the `action: 'reattach'` inside it. A fixed-width window
// would silently clip a push whose comments grew — which it did, on the first
// run of this file, and a clipped push reads as an ABSENT one.
function reattachPushes(src) {
  const out = [];
  for (const m of src.matchAll(/action:\s*'reattach'/g)) {
    let open = src.lastIndexOf('{', m.index);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end > 0) out.push(src.slice(open, end));
  }
  return out;
}

test('every agent-initiated reattach push is marked background', () => {
  // The renderer cannot tell an agent spawn from an operator one without this
  // flag, and an emitter added later without it silently steals focus again.
  const src = read('team-tickets.js');
  const pushes = reattachPushes(src);
  assert.strictEqual(pushes.length, 3,
    'ENTER: the spawn-intent, reviewer and ticket-seat pushes — a changed count means this scan moved off them');
  for (const p of pushes) {
    assert.match(p, /background:\s*true/, `agent-initiated reattach push missing background:true → ${p.slice(0, 120)}`);
  }
});

test('the reload respawn does NOT claim to be background', () => {
  // It is the operator's own seat coming back from [agent:context reload];
  // marking it would move focus away from the session they are watching.
  const pushes = reattachPushes(read('session-manager.js'));
  assert.strictEqual(pushes.length, 1, 'ENTER: session-manager still emits its one reattach push');
  assert.doesNotMatch(pushes[0], /background:\s*true/);
});

test('the renderer routes new sessions through the policy, not straight to switchSession', () => {
  const src = read('renderer/renderer.js');
  // The reattach case is the agent path: it must consult the policy and pass
  // provenance through, or the fix is inert no matter what the leaf decides.
  const reattach = src.match(/case 'reattach':[\s\S]{0,600}?break;/);
  assert.ok(reattach, 'ENTER: the reattach case is still there to check');
  assert.match(reattach[0], /switchToNewSession\(\s*name,\s*\{\s*agentInitiated:\s*background === true/);
  assert.doesNotMatch(reattach[0], /\bswitchSession\(/, 'must not bypass the policy');
});

test('session:draftOpen is contracted, so the renderer can actually ask', () => {
  const { API_CONTRACT } = require('../api-contract');
  const row = API_CONTRACT.find((r) => r.name === 'draftOpen');
  assert.deepStrictEqual(row, { name: 'draftOpen', kind: 'invoke', channel: 'session:draftOpen' });
});
