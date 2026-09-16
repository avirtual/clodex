// Run: node --test test/poll-guard.test.js
//
// The generated `run/<name>/poll-guard.sh` is RUN here, not read: it is the
// second PreToolUse hook allowed to speak, and what it denies is a judgement
// about a SEQUENCE of calls, which no source-shape assertion can stand in for.
// One measured hand made 270 identical `git status --short | wc -l` calls over
// 11.7 minutes, each re-reading a 276k window; prose in the hand prompt was
// tried twice and does not bind at the moment of waiting.
//
// A false POSITIVE here is the expensive direction: the edit-run-edit-run loop
// is legitimate and a guard that denied it would wedge every hand. So the table
// below is mostly rows that must NEVER deny, fed through real stdin against the
// real bytes cli-hooks writes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const cp = require('child_process');
const { createCliHooks } = require('../cli-hooks');
const { pathFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ANNOUNCE = 'Result arrives as a notification: do not poll for it.'
  + ' End your turn now unless you have unrelated work.';

function seat() {
  const REGISTRY_DIR = mkTmpRoot('clodex-poll-');
  const h = createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  h.setupClaudeHook('agent1');
  return {
    script: pathFor(REGISTRY_DIR, 'agent1', 'pollGuardScript'),
    state: pathFor(REGISTRY_DIR, 'agent1', 'pollState'),
    settings: pathFor(REGISTRY_DIR, 'agent1', 'settings'),
  };
}

function fire(script, input, env = { CLODEX_TICKET: 't9' }) {
  const e = { ...process.env, ...env };
  if (env.CLODEX_TICKET === undefined) delete e.CLODEX_TICKET;
  const r = cp.spawnSync('bash', [script], {
    input: JSON.stringify(input), encoding: 'utf-8', env: e,
  });
  assert.strictEqual(r.status, 0, 'a nonzero PreToolUse is a different, cruder refusal');
  return r.stdout;
}

const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const read = (p) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: p } });
const submit = () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' });

// Feed a sequence in order and collect what each step said. The unit of the
// guard is the SEQUENCE, so a runner that fired one input at a time against a
// fresh state would exercise nothing the guard exists to catch.
function sequence(script, inputs, env) {
  return inputs.map((i) => {
    const out = fire(script, i, env);
    if (!out) return null;
    return JSON.parse(out).hookSpecificOutput;
  });
}

const denied = (o) => !!o && o.permissionDecision === 'deny';

const SEQUENCES = [
  {
    what: 'three in a row: the third is denied',
    steps: [bash('git status'), bash('git status'), bash('git status')],
    deny: [false, false, true],
  },
  {
    what: 'a fourth identical call is denied too — the deny does not reset the count',
    steps: [bash('git status'), bash('git status'), bash('git status'), bash('git status')],
    deny: [false, false, true, true],
  },
  {
    what: 'a Read between two Bash calls resets: the edit-run-edit-run loop is legitimate',
    steps: [bash('npm test'), bash('npm test'), read('a.js'), bash('npm test')],
    deny: [false, false, false, false],
  },
  {
    what: 'a new prompt resets: a delivered result is a new wait',
    steps: [bash('npm test'), bash('npm test'), submit(), bash('npm test')],
    deny: [false, false, false, false],
  },
  {
    what: 'a different command between two resets the run',
    steps: [bash('ls'), bash('pwd'), bash('ls')],
    deny: [false, false, false],
  },
  {
    what: 'whitespace is collapsed: trailing space and a run of spaces are the SAME command',
    steps: [bash('git  status'), bash('git status  '), bash('git status')],
    deny: [false, false, true],
  },
];

test('the guard denies the third identical consecutive Bash call and nothing else', () => {
  const { script } = seat();

  // ENTER: the row the whole hook exists for. A table reshaped into only
  // never-deny rows would otherwise report green while the guard denied nothing.
  assert.ok(SEQUENCES.some((s) => s.deny.some(Boolean)),
    'at least one sequence must actually reach a deny');
  assert.ok(SEQUENCES.filter((s) => !s.deny.some(Boolean)).length >= 3,
    'and the never-deny rows must outnumber nothing: a false positive wedges every hand');

  for (const { what, steps, deny } of SEQUENCES) {
    const { script: s } = seat();
    const got = sequence(s, steps).map(denied);
    assert.deepStrictEqual(got, deny, what);
  }
  assert.ok(script);
});

test('the deny reason names the ticket, the command and the instruction', () => {
  const { script } = seat();
  const out = sequence(script, [bash('git status --short'), bash('git status --short'), bash('git status --short')], { CLODEX_TICKET: 't417' });
  const reason = out[2].permissionDecisionReason;
  assert.match(reason, /^ticket t417: third identical Bash call in a row \(git status --short\)/);
  assert.match(reason, /END YOUR TURN/);
  assert.strictEqual(out[2].hookEventName, 'PreToolUse');
});

test('the command in the reason is truncated to 60 characters', () => {
  // The reason lands in the seat's context on every denied poll. A 4KB command
  // echoed back three times is the cost this cap exists to bound.
  const { script } = seat();
  const long = `echo ${'x'.repeat(400)}`;
  const out = sequence(script, [bash(long), bash(long), bash(long)]);
  const reason = out[2].permissionDecisionReason;
  const shown = /in a row \(([^)]*)\)/.exec(reason)[1];
  assert.strictEqual(shown.length, 60, 'exactly the first 60 characters, not the whole command');
  assert.ok(long.startsWith(shown));
});

test("a subagent's calls neither deny nor advance the count", () => {
  // A subagent's tool calls fire the PARENT session's hooks. Its polling is its
  // own affair and its commands are not the main context's, so a third call
  // from a subagent must not deny — and must not push the MAIN seat's run
  // toward a deny either.
  const { script } = seat();
  const sub = { ...bash('git status'), agent_id: 'abc123', agent_type: 'general-purpose' };
  const out = sequence(script, [bash('git status'), bash('git status'), sub]);
  assert.deepStrictEqual(out.map(denied), [false, false, false], 'the subagent call is not denied');

  // State not advanced: the next MAIN call is the third of the run, not the fourth.
  const next = sequence(script, [bash('git status')]);
  assert.ok(denied(next[0]), 'ENTER: the main run really was still at two — this is its third call');
});

test('no CLODEX_TICKET, no deny — every other seat is untouched', () => {
  // Spawned with CLODEX_TICKET actively removed rather than emptied: an
  // inherited one from the seat running this suite would pass for the wrong reason.
  const { script } = seat();
  const steps = Array.from({ length: 6 }, () => bash('git status'));
  const out = sequence(script, steps, { CLODEX_TICKET: undefined });
  assert.deepStrictEqual(out, [null, null, null, null, null, null],
    'six identical calls, silent every time');
});

test('a corrupt state file reads as empty: the next call counts as the first', () => {
  const { script, state } = seat();
  sequence(script, [bash('git status'), bash('git status')]);
  fs.writeFileSync(state, 'not json at all{');
  const out = sequence(script, [bash('git status'), bash('git status')]);
  assert.deepStrictEqual(out.map(denied), [false, false],
    'the run restarted at one, so neither of these is a third');
});

test('the PostToolUse announce fires for a backgrounded Bash call and a spawned agent', () => {
  const { script } = seat();
  const post = (tool_name, tool_input) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input });

  const bg = JSON.parse(fire(script, post('Bash', { command: 'npm test', run_in_background: true })));
  assert.strictEqual(bg.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.strictEqual(bg.hookSpecificOutput.additionalContext, ANNOUNCE);

  // The harness sends `Agent`; `Task` is matched too because the name has been
  // both across CLI versions and a miss here is silent.
  for (const tool of ['Agent', 'Task']) {
    const o = JSON.parse(fire(script, post(tool, { description: 'sweep' })));
    assert.strictEqual(o.hookSpecificOutput.additionalContext, ANNOUNCE, `${tool} announces`);
  }

  // A FOREGROUND Bash call is the common case and must stay silent, or every
  // tool result in the session grows by a sentence.
  assert.strictEqual(fire(script, post('Bash', { command: 'npm test' })), '');
  assert.strictEqual(fire(script, post('Bash', { command: 'npm test', run_in_background: false })), '');
  assert.strictEqual(fire(script, post('Read', { file_path: 'a.js' })), '');

  // A subagent spawning its own agent would land this in the SUBAGENT's context.
  assert.strictEqual(fire(script, { ...post('Agent', {}), agent_id: 'abc123' }), '');
});

test('the PostToolUse announce does not advance or reset the deny count', () => {
  // The announce and the counter share one script. A PostToolUse that fell
  // through to the Bash branch would count every tool RESULT as a call.
  const { script } = seat();
  const out = sequence(script, [
    bash('git status'),
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } },
    bash('git status'),
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } },
    bash('git status'),
  ]);
  assert.deepStrictEqual(out.map(denied), [false, false, false, false, true],
    'the three PreToolUse calls are what counts; the results between them are not calls');
});

test('a malformed payload passes the call through rather than denying it', () => {
  // Fail-OPEN on garbage: this hook sits in front of every tool call a ticket
  // seat makes, so an unparseable payload that denied would wedge the seat.
  const { script } = seat();
  for (const raw of ['', 'not json at all', '{]', '{"tool_name":"Bash"}', '{"tool_input":{"command":123}}']) {
    const r = cp.spawnSync('bash', [script], {
      input: raw, encoding: 'utf-8', env: { ...process.env, CLODEX_TICKET: 't9' },
    });
    assert.strictEqual(r.status, 0, `exit 0 on ${JSON.stringify(raw)}`);
    assert.strictEqual(r.stdout, '', `silent on ${JSON.stringify(raw)}`);
  }
});

test('the guard is generated, gated on CLODEX_TICKET before stdin, and exits 0', () => {
  const { script } = seat();
  const body = fs.readFileSync(script, 'utf-8');
  assert.match(body.split('\n')[1], /^\[ -n "\$CLODEX_TICKET" \] \|\| exit 0$/,
    'the ticket gate must be the first statement, ahead of the stdin read');
  assert.match(body, /exit 0\n$/);
  assert.ok(!/require\('\.\//.test(body), 'no relative require inside a generated body');
  assert.strictEqual(fs.statSync(script).mode & 0o777, 0o700);
});

test('the guard is registered under all three events, and per-tool nowhere it would over-fire', () => {
  const { script, settings } = seat();
  const s = JSON.parse(fs.readFileSync(settings, 'utf-8'));

  // PreToolUse under the MATCHER-LESS entry: a non-Bash tool between two Bash
  // calls is what resets the count, so the hook must see every tool, not Bash.
  const anyPre = s.hooks.PreToolUse.find((e) => e.matcher === '');
  assert.ok(anyPre, 'ENTER: a matcher-less PreToolUse entry must exist');
  assert.deepStrictEqual(anyPre.hooks, [{ type: 'command', command: script }],
    'the matcher-less PreToolUse entry carries the poll guard only');

  // The Bash-only entry keeps its two: widening the live observer to every tool
  // would record Reads into the console, and the git-add guard has nothing to
  // say about a non-Bash call.
  const bashPre = s.hooks.PreToolUse.filter((e) => e.matcher === 'Bash');
  assert.strictEqual(bashPre.length, 1);
  assert.ok(!bashPre[0].hooks.some((h) => h.command === script));

  assert.ok(s.hooks.UserPromptSubmit[0].hooks.some((h) => h.command === script),
    'without the submit registration a delivered result never resets the run');

  const announce = s.hooks.PostToolUse.filter((e) => e.hooks.some((h) => h.command === script));
  assert.deepStrictEqual(announce.map((e) => e.matcher).sort(), ['Agent|Task', 'Bash'],
    'the announce fires after a Bash call and after a spawn, and after nothing else');
});
