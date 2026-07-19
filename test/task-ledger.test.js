'use strict';

// task-ledger: per-task cost attribution over Claude Code transcripts
// (docs/teams-design.md, "Making the number real"). Teams live under
// ~/.clodex/teams/<name>/ (Bogdan ruling 2026-07-19 — zero clodex droppings in
// project repos); task artifacts at teams/<name>/tasks/<id>/. Committed
// synthetic fixtures: a fake CLODEX_HOME with a team + task dirs, and a
// transcripts corpus (sessions + one subagent, plus a .bak that must not
// count) whose tool inputs reference teams/proj/tasks/<id>/.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'task-ledger.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'task-ledger');
const HOME = path.join(FIXTURES, 'home');
const TRANSCRIPTS = path.join(FIXTURES, 'transcripts');

function run(args = [], clodexHome = HOME) {
  return execFileSync(process.execPath, [SCRIPT, '--dir', TRANSCRIPTS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLODEX_HOME: clodexHome },
  });
}

test('task-ledger attributes transcript cost to team task dirs', async (t) => {
  const out = JSON.parse(run(['--team', 'proj', '--json']));

  await t.test('resolves the team and its project root', () => {
    assert.strictEqual(out.team, 'proj');
    assert.strictEqual(out.project, '/fixture/project');
  });

  await t.test('inventory: counts contexts, excludes .bak', () => {
    assert.strictEqual(out.transcripts, 4);       // sess-a/b/c/d, .bak excluded
    assert.strictEqual(out.subagentTranscripts, 1);
    assert.strictEqual(out.contexts, 5);
    // the .bak snapshot's 999999-token Read of task-1 must not leak anywhere
    assert.ok(!JSON.stringify(out).includes('999999'));
  });

  const byId = Object.fromEntries(out.tasks.map((tk) => [tk.id, tk]));

  await t.test('lists every task dir, sorted by attributed tokens', () => {
    assert.deepStrictEqual(out.tasks.map((tk) => tk.id), ['task-1', 'task-12', 'task-2', 'task-3']);
  });

  await t.test('token usage deduped by requestId and split by model tier', () => {
    // task-1 touched by 3 contexts: opus session (req_a1 duplicated → counted
    // once), haiku subagent, sonnet session.
    const t1 = byId['task-1'];
    assert.strictEqual(t1.contexts, 3);
    assert.strictEqual(t1.requests, 4); // opus 2 + haiku 1 + sonnet 1
    assert.strictEqual(t1.models['opus-4-8'].requests, 2); // req_a1 not double-counted
    assert.strictEqual(t1.models['opus-4-8'].total, 1385);
    assert.strictEqual(t1.models['haiku-4-5'].total, 69);
    assert.strictEqual(t1.models['sonnet-5'].total, 130);
    assert.strictEqual(t1.tokens, 1385 + 69 + 130);
  });

  await t.test('a subagent transcript is its own context', () => {
    // the haiku work landed in a subagents/ file, attributed independently of
    // its parent session
    assert.ok(byId['task-1'].models['haiku-4-5']);
  });

  await t.test('a multi-task context is counted in each task (full, not split)', () => {
    // sess-b Edits task-1 AND Reads task-2 → its full sonnet usage lands in both
    assert.strictEqual(byId['task-2'].models['sonnet-5'].total, 130);
    assert.strictEqual(byId['task-1'].models['sonnet-5'].total, 130);
  });

  await t.test('task-id match is whole path segment: task-1 read does not hit task-12', () => {
    // only the explicit `ls .../tasks/task-12/` attributes to task-12
    assert.strictEqual(byId['task-12'].contexts, 1);
    assert.strictEqual(byId['task-12'].models['opus-4-8'].total, 1385);
    assert.strictEqual(byId['task-12'].reopened, false);
  });

  await t.test('REOPENED: marker file and spec.md prior-task reference', () => {
    assert.strictEqual(byId['task-2'].reopened, true);  // "reopened" marker file
    assert.strictEqual(byId['task-3'].reopened, true);  // spec.md names task-1
    assert.strictEqual(byId['task-1'].reopened, false);
  });

  await t.test('a task with a dir but no transcript shows zero', () => {
    assert.strictEqual(byId['task-3'].contexts, 0);
    assert.strictEqual(byId['task-3'].tokens, 0);
    assert.deepStrictEqual(byId['task-3'].models, {});
  });

  await t.test('unattributed bucket collects contexts touching no known task', () => {
    // sess-c (touches no task) + sess-d (mentions only task-99, no dir)
    assert.strictEqual(out.unattributed.contexts, 2);
    assert.strictEqual(out.unattributed.tokens, 36 + 24);
    assert.strictEqual(out.unattributed.models['opus-4-8'].total, 36);
  });

  await t.test('orphan mentions: a tasks/<id>/ with no dir is surfaced', () => {
    assert.deepStrictEqual(out.orphanMentions, ['task-99']);
  });
});

test('task-ledger resolves a team by --project root containment (deepest wins)', () => {
  // Build a throwaway CLODEX_HOME with two nested teams; the deeper root must win.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-home-'));
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-outer-'));
  const inner = path.join(outer, 'packages', 'app');
  fs.mkdirSync(path.join(home, 'teams', 'mono', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(home, 'teams', 'app', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'teams', 'mono', 'team.json'),
    JSON.stringify({ root: outer, lead: 'lead', roles: { lead: {} } }));
  fs.writeFileSync(path.join(home, 'teams', 'app', 'team.json'),
    JSON.stringify({ root: inner, lead: 'lead', roles: { lead: {} } }));

  const out = JSON.parse(run(['--project', path.join(inner, 'src'), '--json'], home));
  assert.strictEqual(out.team, 'app');   // deepest root containing the cwd
  assert.strictEqual(out.project, inner);
});

test('task-ledger errors when no team root contains --project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-none-'));
  fs.mkdirSync(path.join(home, 'teams'), { recursive: true });
  assert.throws(
    () => run(['--project', '/nowhere/at/all', '--json'], home),
    /No team found/,
  );
});

test('task-ledger human output renders tiers, flags and notes', () => {
  const text = run(['--team', 'proj']);
  assert.match(text, /team proj \(root \/fixture\/project\)/);
  assert.match(text, /task-1 {2}opus-4-8=1,385 sonnet-5=130 haiku-4-5=69 {2}ctx=3/);
  assert.match(text, /task-2 \[REOPENED\]/);
  assert.match(text, /task-3 \[REOPENED\] {2}\(no attributed contexts\)/);
  assert.match(text, /\(unattributed\): opus-4-8=36 sonnet-5=24 {2}ctx=2/);
  assert.match(text, /no dir: task-99/);
});

test('task-ledger --help exits 0', () => {
  const text = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(text, /Usage: task-ledger\.js/);
});
