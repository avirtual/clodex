// Run: node --test test/bash-guard.test.js
//
// The generated `run/<name>/bash-guard.sh` is RUN here, not read: it is the one
// PreToolUse hook allowed to speak, and what it denies is a judgement about
// shell syntax that no source-shape assertion can stand in for. Hands 811 and
// 812 each swept a red-proof subagent's in-flight revert into a commit with
// `git add -A`, so a false NEGATIVE here costs a ticket; a false positive costs
// a hand one retry. The table below is the contract, exercised through real
// stdin against the real bytes cli-hooks writes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const cp = require('child_process');
const { createCliHooks } = require('../cli-hooks');
const { pathFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const REASON = 'ticket t9: stage only the paths you edited (git add <path>…)'
  + ' — a whole-tree add sweeps a subagent\'s in-flight revert into your commit.';

function guardScript() {
  const REGISTRY_DIR = mkTmpRoot('clodex-guard-');
  const h = createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
  h.setupClaudeHook('agent1');
  return pathFor(REGISTRY_DIR, 'agent1', 'bashGuardScript');
}

function run(script, command, env = { CLODEX_TICKET: 't9' }) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  return cp.execFileSync('bash', [script], {
    input, encoding: 'utf-8', env: { ...process.env, ...env },
  });
}

const TABLE = [
  { cmd: 'git add -A', want: 'deny' },
  { cmd: 'git add --all', want: 'deny' },
  { cmd: 'git add .', want: 'deny' },
  { cmd: 'git add --no-ignore-removal', want: 'deny' },
  { cmd: 'git add -u', want: 'deny' },
  { cmd: 'git add --update', want: 'deny' },
  { cmd: 'git add :/', want: 'deny' },
  { cmd: 'cd sub && git add -A', want: 'deny' },
  { cmd: 'git status && git add -A && git commit -m x', want: 'deny' },
  { cmd: 'git status; git add .', want: 'deny' },
  { cmd: 'git -C /tmp/wt add -A', want: 'deny' },
  { cmd: 'git add -Av', want: 'deny' },
  { cmd: 'git add *', want: 'deny' },
  { cmd: '/usr/bin/git add -A', want: 'deny' },
  { cmd: 'command git add -A', want: 'deny' },
  { cmd: 'env FOO=1 git add -A', want: 'deny' },
  { cmd: 'git commit -am x', want: 'deny' },
  { cmd: 'git commit -qa -m x', want: 'deny' },
  { cmd: 'git commit --all -m x', want: 'deny' },
  { cmd: 'git commit -a', want: 'deny' },

  // A NEWLINE separates commands exactly as `;` does, and stage-then-commit
  // across two lines is the default shape a hand writes. Treated as plain token
  // whitespace it collapses into one segment whose subcommand is whatever the
  // FIRST line ran, and the `git add -A` behind it is never examined at all.
  { cmd: 'git status\ngit add -A', want: 'deny' },
  { cmd: 'cd sub\ngit commit -am x', want: 'deny' },
  { cmd: 'git commit -m x\ngit add -A', want: 'deny' },

  { cmd: 'git add a.js b.js', want: 'pass' },
  { cmd: 'git add cli-hooks.js test/bash-guard.test.js', want: 'pass' },
  { cmd: 'git add -p', want: 'pass' },
  { cmd: 'git add ./cli-hooks.js', want: 'pass' },
  { cmd: 'git status', want: 'pass' },
  { cmd: 'git commit -m "add -A everywhere"', want: 'pass' },
  { cmd: 'git commit -m x', want: 'pass' },
  { cmd: 'echo "git add -A"', want: 'pass' },
  { cmd: 'grep -rn "git add -A" docs', want: 'pass' },
  { cmd: 'ls -A', want: 'pass' },
  // A backslash-newline is a CONTINUATION, not a separator: the escape branch
  // consumes it before the newline split can see it, so this stays ONE `git
  // add` of two paths rather than a second segment starting at `b.js`.
  { cmd: 'git add a.js \\\n  b.js', want: 'pass' },
  { cmd: 'echo hi\ngit status', want: 'pass' },
];

test('the guard denies every whole-tree stage and passes everything else', () => {
  const script = guardScript();

  // ENTER: the row the whole hook exists for. If the table is ever reduced or
  // reshaped into something the loop below iterates vacuously, this fails first
  // and names what went missing — a table of only `pass` rows would otherwise
  // report a green while the guard denied nothing at all.
  assert.ok(TABLE.some((r) => r.cmd === 'git add -A' && r.want === 'deny'),
    'the `git add -A` deny row must be in the table');
  assert.ok(TABLE.filter((r) => r.want === 'deny').length >= 10);

  for (const { cmd, want } of TABLE) {
    const out = run(script, cmd);
    if (want === 'pass') {
      assert.strictEqual(out, '', `must PASS: ${cmd}`);
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(out); } catch {
      assert.fail(`must DENY with hook JSON: ${cmd} — got ${JSON.stringify(out)}`);
    }
    assert.deepStrictEqual(parsed, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: REASON,
      },
    }, `deny shape for: ${cmd}`);
  }
});

test('the reason names the ticket that is being guarded', () => {
  // The id is interpolated from the seat's env, not baked at generation: one
  // script serves whatever ticket the seat currently holds, and a hand reading
  // the refusal must see its OWN id or the message reads as someone else's.
  const script = guardScript();
  const out = JSON.parse(run(script, 'git add -A', { CLODEX_TICKET: 't417' }));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^ticket t417: stage only the paths you edited/);
});

test('no ticket marker, no deny — every other seat is untouched', () => {
  const script = guardScript();
  // Spawned with CLODEX_TICKET actively removed rather than emptied: an
  // inherited one from the seat running this suite would make the assertion
  // pass for the wrong reason.
  const env = { ...process.env };
  delete env.CLODEX_TICKET;
  const r = cp.spawnSync('bash', [script], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git add -A' } }),
    encoding: 'utf-8', env,
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('a malformed payload passes the call through rather than denying it', () => {
  // Fail-OPEN on garbage: this hook sits in front of every Bash call a ticket
  // seat makes, so an unparseable payload that denied would wedge the seat
  // entirely. A missed whole-tree add is recoverable; a seat that cannot run
  // any command is not.
  const script = guardScript();
  for (const raw of ['', 'not json at all', '{]', '{"tool_name":"Bash"}', '{"tool_input":{"command":123}}']) {
    const r = cp.spawnSync('bash', [script], {
      input: raw, encoding: 'utf-8', env: { ...process.env, CLODEX_TICKET: 't9' },
    });
    assert.strictEqual(r.status, 0, `exit 0 on ${JSON.stringify(raw)}`);
    assert.strictEqual(r.stdout, '', `silent on ${JSON.stringify(raw)}`);
  }
});

test('the guard is executable and self-contained', () => {
  const script = guardScript();
  const st = fs.statSync(script);
  assert.strictEqual(st.mode & 0o777, 0o700);
});
