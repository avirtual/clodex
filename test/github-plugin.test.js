'use strict';
// github-plugin.test.js — the plugin's ENGINE half, driven through the REAL
// plugin host engine and the REAL intent registry.
//
// The plugin ships READ-ONLY: `status`, `ci`, `review` read, `pr --dry` renders
// locally, and a bare `pr` refuses. That scope decision is the thing most likely
// to be undone by a well-meaning later edit ("just put the push back behind a
// flag"), so most of this file exists to make undoing it fail here.
//
// Two independent guards on the removal, because each is blind where the other
// sees:
//   1. BEHAVIOURAL — proc.js is replaced with a recorder, every sub-command is
//      driven, and the recorded argv list is asserted to contain no `git push`
//      and no `gh pr create`. This catches a push added anywhere reachable.
//   2. SOURCE — the plugin's own text is scanned for those two command shapes.
//      This catches a push on a path the fixture does not happen to drive,
//      which is exactly what the behavioural guard cannot see.
//
// Every absence assertion below is paired with a control proving the fixture
// REACHED the state it names (the `ENTER:` idiom, CLAUDE.md ▸ Tests) — a
// recorder that recorded nothing would otherwise satisfy "no push" trivially.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPluginHostEngine } = require('../plugin-host-engine');
const { HOST_API_VERSION } = require('../plugin-api');
const registry = require('../intent-registry');

const PLUGIN_DIR = path.join(__dirname, '..', 'plugins', 'github');
const PROC_PATH = require.resolve(path.join(PLUGIN_DIR, 'proc.js'));
const WORKFLOWS_PATH = require.resolve(path.join(PLUGIN_DIR, 'workflows.js'));
const ENGINE_PATH = require.resolve(path.join(PLUGIN_DIR, 'engine.js'));

// ── the recording proc ──────────────────────────────────────────────────────
// workflows.js DESTRUCTURES its imports at module load, so patching proc's
// exports after the fact would not take: the fake has to be in the require
// cache before workflows is first required. That is why each boot deletes all
// three modules and seeds this entry.

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const no = (stderr = 'nope') => ({ ok: false, code: 1, stdout: '', stderr });

// Answers keyed by the argv the workflows actually send. Anything unmatched
// returns a failure rather than a plausible-looking empty success, so a
// workflow that starts issuing a new command shows up as a changed transcript
// instead of silently reading as "nothing there".
// `state.pr` decides whether the branch already has a PR. It is a fixture knob
// because the two interesting paths diverge on it: `prDryRun` STOPS at an
// existing PR (so a fixture that always has one never reaches the commit read
// where the push used to sit), while `review` needs one to have anything to
// read. `state.dirty` is the same kind of knob for the uncommitted-files
// branch, which used to be a REFUSAL and is now a note (see the dirty-tree
// test).
function answer(cmd, args, state) {
  const line = `${cmd} ${args.join(' ')}`;
  if (line === 'git rev-parse --abbrev-ref HEAD') return ok('feature/chip');
  if (line.startsWith('git rev-parse --verify --quiet refs/remotes/origin/')) return ok('abc123');
  if (line.startsWith('git rev-list')) return ok('2\t3');
  if (line.startsWith('git status --porcelain')) {
    return ok(state.dirty ? ' M renderer.js\n M CHANGELOG.md' : '');
  }
  if (line.startsWith('git log')) return ok('first commit\nsecond commit');
  if (line.startsWith('git diff --stat')) return ok(' 3 files changed, 40 insertions(+)');
  if (line.startsWith('git diff --name-only')) return ok('renderer.js\nmain.js');
  if (line.startsWith('gh repo view')) {
    return Object.assign(ok('{}'), { data: { nameWithOwner: 'avirtual/clodex', defaultBranchRef: { name: 'main' } } });
  }
  if (line.startsWith('gh pr view') && line.includes('reviews')) {
    return Object.assign(ok('{}'), { data: { reviews: [] } });
  }
  if (line.startsWith('gh pr view')) {
    if (!state.pr) return Object.assign(ok(''), { data: null });   // gh's "no PR" answer
    return Object.assign(ok('{}'), {
      data: { number: 7, title: 'A chip', url: 'https://github.com/avirtual/clodex/pull/7', state: 'OPEN' },
    });
  }
  if (line.startsWith('gh pr checks')) {
    return Object.assign(ok('[]'), {
      data: [{ name: 'unit', bucket: 'fail', link: 'https://github.com/o/r/actions/runs/999' }],
    });
  }
  if (line.startsWith('gh run view')) return ok('job\tstep\t2026-01-01T00:00:00Z Error: assertion failed');
  if (line.startsWith('gh api graphql')) {
    return Object.assign(ok('{}'), { data: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } } });
  }
  return no(`unstubbed command: ${line}`);
}

// `spawns` is the ledger both removal guards read. It records the argv of every
// command the plugin would have run, whether or not this fake answers it.
function seedProc(spawns, state) {
  const run = (cmd, args) => {
    spawns.push([cmd, ...args]);
    return Promise.resolve(answer(cmd, args, state));
  };
  const exports = {
    run,
    git: (cwd, args) => run('git', args),
    gh: (cwd, args) => run('gh', args),
    ghJson: (cwd, args) => run('gh', args),
    scrub: (t) => String(t == null ? '' : t),
    diagnose: () => null,
    explain: (r, what) => `${what} failed`,
    firstLine: (r) => String((r && r.stderr) || 'no output'),
    DEFAULT_TIMEOUT_MS: 25000,
  };
  require.cache[PROC_PATH] = { id: PROC_PATH, filename: PROC_PATH, loaded: true, exports, children: [], paths: [] };
}

function boot({ pr = true, dirty = false } = {}) {
  const spawns = [];
  const injected = [];
  const state = { pr, dirty };
  for (const p of [ENGINE_PATH, WORKFLOWS_PATH, PROC_PATH]) delete require.cache[p];
  seedProc(spawns, state);
  const engine = require(ENGINE_PATH);

  const session = { name: 'seat', type: 'agent', cwd: '/repo', workspaceId: 'w1' };
  const sessions = new Map([['seat', session]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-gh-'));

  const host = createPluginHostEngine({
    manager: {
      sessions,
      list: () => [...sessions.values()],
      listForWorkspace: () => [...sessions.values()],
      _injectText: (s, text) => injected.push(text),
      _broadcast() {}, _sendToSession() {}, windowForWorkspace: () => null,
    },
    getUiSettings: () => ({ get: () => ({}), set: () => {} }),
    log: { info: () => {}, error: () => {} },
    userDataPath: dir,
    fs, path,
    gitWorktree: {},
    libraryKinds: {},
  });
  host.register('github', engine, { hostApi: HOST_API_VERSION });

  const cleanup = () => {
    try { host.deactivate('github'); } catch {}
    registry._resetPluginRows();
    for (const p of [ENGINE_PATH, WORKFLOWS_PATH, PROC_PATH]) delete require.cache[p];
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { host, engine, session, sessions, spawns, injected, state, cleanup };
}

// Drive a line the way core does: parse through the REGISTERED row (not the
// plugin's own parse), then hand the result to the registered handler as
// (handle, intent) — the argument order session-manager.js uses at the
// _dispatchPluginIntent call site.
async function fire(line, { body } = {}) {
  const row = registry.pluginRowFor('gh');
  const intent = row.parse(line);
  if (body != null) intent.body = body;
  const handle = { name: 'seat', isAlive: () => true, inject: () => {} };
  row.handler(handle, intent);
  // The handler is synchronous and schedules the rest; let the chain settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return intent;
}

const isPush = (argv) => argv[0] === 'git' && argv.includes('push');
const isPrCreate = (argv) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'create';

// ── 1. the removal ──────────────────────────────────────────────────────────

test('github: no sub-command reaches git push or gh pr create', async () => {
  // No existing PR: otherwise the dry run stops at the duplicate refusal and
  // never reaches the description build, which is precisely where the push was.
  const { spawns, cleanup } = boot({ pr: false });
  try {
    for (const line of ['[agent:gh status]', '[agent:gh ci]', '[agent:gh review]',
      '[agent:gh pr]', '[agent:gh pr --dry]', '[agent:gh pr --dry-run]', '[agent:gh pr -n]']) {
      await fire(line, { body: 'why this exists' });
    }

    // ENTER: the absence below is only meaningful if the fixture actually drove
    // the plugin into shelling out. Prove the recorder saw the reads first —
    // `deepEqual(writes, [])` is true of a fixture that ran nothing at all.
    assert.ok(spawns.length >= 10, `expected the sub-commands to shell out; recorded ${spawns.length}`);
    assert.ok(spawns.some((a) => a[0] === 'git'), 'ENTER: git was invoked');
    assert.ok(spawns.some((a) => a[0] === 'gh'), 'ENTER: gh was invoked');
    // And specifically that `pr --dry` got far enough to build a description —
    // the state a push would have immediately followed.
    assert.ok(spawns.some((a) => a[0] === 'git' && a[1] === 'log'),
      'ENTER: the dry run read the commit list, i.e. it reached the point the push used to be');

    assert.deepStrictEqual(spawns.filter(isPush), [], 'nothing may push');
    assert.deepStrictEqual(spawns.filter(isPrCreate), [], 'nothing may create a PR');
  } finally { cleanup(); }
});

test('github: the push commands are absent from the plugin SOURCE, not merely unreached', () => {
  // The behavioural guard above only sees paths the fixture drives. This one
  // catches a push added behind a condition that fixture never satisfies, and
  // a reintroduction that is commented out rather than deleted.
  const files = fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith('.js'));
  // ENTER: the three assertions below are ABSENCES, all true of an empty file
  // list — a plugin dir that existed but yielded no .js would pass this test
  // while scanning nothing. Named rather than counted: a count is what just
  // went wrong in plugin-scope.test.js, and a fourth module should not fail
  // this test, only go unscanned if someone forgets — which naming catches.
  for (const known of ['engine.js', 'proc.js', 'workflows.js']) {
    assert.ok(files.includes(known), `ENTER: ${known} is present to be scanned`);
  }
  for (const file of files) {
    const src = fs.readFileSync(path.join(PLUGIN_DIR, file), 'utf8');
    assert.ok(!/'push'/.test(src), `${file} names a git push argv`);
    assert.ok(!/--set-upstream/.test(src), `${file} names --set-upstream`);
    assert.ok(!/'pr',\s*'create'/.test(src), `${file} names a gh pr create argv`);
  }
});

test('github: a bare `pr` REFUSES and names why — it does not silently dry-run', async () => {
  const { spawns, cleanup } = boot({ pr: false });
  try {
    const replies = [];
    const handle = { name: 'seat', isAlive: () => true, inject: (t) => replies.push(t) };
    const row = registry.pluginRowFor('gh');

    row.handler(handle, row.parse('[agent:gh pr]'));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(replies.length, 1, 'ENTER: the refusal reached the agent');
    const [refusal] = replies;
    assert.match(refusal, /operator/, 'the refusal names whose action opening a PR is');
    assert.match(refusal, /--dry/, 'and points at the verb that does work');
    // The distinguishing assertion: a silent fallback to --dry would have
    // rendered a description, which requires reading the repo. It must not.
    assert.deepStrictEqual(spawns, [], 'a refused `pr` shells out to nothing at all');

    // Control: the same fixture, with --dry, DOES render — so the emptiness
    // above is the refusal and not a broken fixture.
    row.handler(handle, row.parse('[agent:gh pr --dry]'));
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    assert.ok(spawns.length > 0, 'ENTER: --dry does reach the repo');
    assert.strictEqual(replies.length, 2);
    assert.match(replies[1], /Nothing was pushed/, 'the dry run states that nothing happened');
    assert.match(replies[1], /title:/, 'and it renders the description it exists to show');
  } finally { cleanup(); }
});

test('github: an uncommitted tree is a NOTE on the rendering, not a refusal', async () => {
  // This behaviour CHANGED in the cut and the change was adjudicated, so it is
  // pinned here rather than living only in the README. Before: a dirty tree
  // refused, because the PR would have been missing the work it was named
  // after. After: nothing is created, so the description is still the useful
  // answer and the uncommitted files are named as ones left out.
  const { spawns, cleanup } = boot({ pr: false, dirty: true });
  try {
    const replies = [];
    const handle = { name: 'seat', isAlive: () => true, inject: (t) => replies.push(t) };
    const row = registry.pluginRowFor('gh');
    row.handler(handle, row.parse('[agent:gh pr --dry]'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    assert.strictEqual(replies.length, 1, 'ENTER: an answer reached the agent');
    const [out] = replies;

    // ENTER: the dirty state is the one the fixture actually produced — without
    // this, both halves below could be asserting about a clean tree.
    assert.ok(spawns.some((a) => a[0] === 'git' && a[1] === 'status'),
      'ENTER: the workflow read the working tree');
    assert.match(out, /2 file\(s\) are uncommitted/, 'the NOTE names how many files would be left out');

    // The assertion carrying the argument: it is a note and not a refusal
    // precisely because the description STILL RENDERS. A refusal would stop
    // here, and a reader of the first assertion alone could not tell which.
    assert.match(out, /title:/, 'the description renders anyway — this is why it is a note, not a refusal');
    assert.match(out, /## Commits/, 'including the commit evidence');
    assert.match(out, /Nothing was pushed/, 'and it still states that nothing happened');
    assert.ok(spawns.some((a) => a[0] === 'git' && a[1] === 'log'),
      'the commit read happened, i.e. the workflow ran past the point that used to refuse');

    // And it is still read-only on this path.
    assert.deepStrictEqual(spawns.filter(isPush), []);
    assert.deepStrictEqual(spawns.filter(isPrCreate), []);
  } finally { cleanup(); }
});

test('github: a CLEAN tree renders the same description with no NOTE', async () => {
  // Control for the test above: proves the NOTE is produced BY the dirty state
  // rather than being unconditional prose in the template.
  const { cleanup } = boot({ pr: false, dirty: false });
  try {
    const replies = [];
    const handle = { name: 'seat', isAlive: () => true, inject: (t) => replies.push(t) };
    const row = registry.pluginRowFor('gh');
    row.handler(handle, row.parse('[agent:gh pr --dry]'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    assert.strictEqual(replies.length, 1);
    assert.match(replies[0], /title:/, 'ENTER: the description rendered here too');
    assert.ok(!/uncommitted/.test(replies[0]), 'no NOTE when there is nothing uncommitted');
  } finally { cleanup(); }
});

// ── 2. registration ─────────────────────────────────────────────────────────

test('github: activate registers exactly one verb, `gh`, and nothing else', () => {
  const { cleanup } = boot();
  try {
    // MEMBERSHIP, not a count of the whole catalog: pinning the catalog to an
    // exact list is what made a second shipped plugin fail a test about the
    // first (test/plugin-kill-switch.test.js:98-101).
    const mine = registry.rows().filter((r) => r.source === 'github');
    assert.deepStrictEqual(mine.map((r) => r.type), ['gh'],
      'the github plugin contributes exactly one verb');
    assert.strictEqual(mine[0].privileged, true, 'plugin verbs are forced privileged');
  } finally { cleanup(); }
});

test('github: bodyMode is greedy for `pr` and none for every other sub-command', () => {
  const { cleanup } = boot();
  try {
    const row = registry.pluginRowFor('gh');
    // Through the REGISTERED row, so the registry's own wrapper (which coerces
    // anything not 'greedy'/'json' to 'none') is in the path.
    assert.strictEqual(row.bodyMode(row.parse('[agent:gh pr]')), 'greedy');
    assert.strictEqual(row.bodyMode(row.parse('[agent:gh pr --dry]')), 'greedy',
      'the dry run is the one that TAKES a body — it must stay greedy after the cut');
    for (const sub of ['status', 'ci', 'review']) {
      assert.strictEqual(row.bodyMode(row.parse(`[agent:gh ${sub}]`)), 'none',
        `a greedy body on ${sub} would swallow the agent's next paragraph`);
    }
    assert.strictEqual(row.bodyMode(row.parse('[agent:gh]')), 'none', 'the bare verb defaults to status');
  } finally { cleanup(); }
});

test('github: the handler is called as (handle, intent)', async () => {
  const { cleanup } = boot();
  try {
    const seen = [];
    const handle = { name: 'seat', isAlive: () => true, inject: (t) => seen.push(t) };
    const row = registry.pluginRowFor('gh');
    // Exactly session-manager.js's _dispatchPluginIntent call: handle first.
    row.handler(handle, row.parse('[agent:gh status]'));
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(seen.length, 1, 'the answer went to the handle passed FIRST');
    assert.match(seen[0], /^\[gh\]/);

    // Reversed arguments must not silently half-work: with (intent, handle) the
    // plugin sees no usable name and reports nothing rather than throwing into
    // core.
    const before = seen.length;
    row.handler(row.parse('[agent:gh status]'), handle);
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(seen.length, before, 'a reversed call injects nothing');
  } finally { cleanup(); }
});

test('github: the handler returns undefined — never a promise', () => {
  const { cleanup } = boot();
  try {
    // §7: a returned promise is logged and IGNORED, so its rejection escapes
    // every guard and failure becomes silence. The handler must schedule, not
    // return, its async work.
    const row = registry.pluginRowFor('gh');
    const handle = { name: 'seat', isAlive: () => true, inject: () => {} };
    const r = row.handler(handle, row.parse('[agent:gh status]'));
    assert.strictEqual(r, undefined);
  } finally { cleanup(); }
});

// ── 3. teardown ─────────────────────────────────────────────────────────────

test('github: deactivate tears the verb down and leaves nothing behind', () => {
  const { host, cleanup } = boot();
  try {
    assert.ok(registry.pluginRowFor('gh'), 'ENTER: the verb was registered to begin with');
    host.deactivate('github');
    assert.strictEqual(registry.pluginRowFor('gh'), null, 'the intent row is gone');
    assert.deepStrictEqual(registry.rows().filter((r) => r.source === 'github'), [],
      'and no row of ours survives under any other verb');
    assert.deepStrictEqual(host._hookCounts(), { create: 0, exit: 0, text: 0 },
      'no session hook outlives the plugin');
    assert.deepStrictEqual(host._dispatchKeys(), [],
      'an engine-only plugin registers no ipc channel to leak');
  } finally { cleanup(); }
});

test('github: re-activation after a deactivate works — module state is reset, not stale', () => {
  // §10: Node's module cache survives a disable, so a re-enable calls activate()
  // again on the same module object.
  const first = boot();
  first.host.deactivate('github');
  first.cleanup();

  const { host, cleanup } = boot();
  try {
    assert.ok(registry.pluginRowFor('gh'), 'the verb registers again on a fresh host');
    host.deactivate('github');
    assert.strictEqual(registry.pluginRowFor('gh'), null);
  } finally { cleanup(); }
});

// ── 4. parsing ──────────────────────────────────────────────────────────────

test('github: parseLine defaults to status, lower-cases, and flags unknown subs', () => {
  const { engine, cleanup } = boot();
  try {
    const { parseLine } = engine._internals;
    assert.strictEqual(parseLine('[agent:gh]').sub, 'status', 'the bare verb is status');
    assert.strictEqual(parseLine('[agent:gh STATUS]').sub, 'status');
    assert.strictEqual(parseLine('[agent:gh CI]').known, true);
    assert.strictEqual(parseLine('[agent:gh merge]').known, false,
      'an unknown sub-command is marked, not guessed at');
    assert.strictEqual(parseLine('[agent:gh pr --DRY]').dry, true);
    assert.strictEqual(parseLine('[agent:gh pr]').dry, false);
    assert.strictEqual(parseLine('not an intent'), null);
    // The greedy body arrives under `.body`; session-manager appends following
    // lines to that field, so the name is load-bearing.
    assert.strictEqual(parseLine('[agent:gh pr --dry] because X').body, 'because X');
  } finally { cleanup(); }
});

test('github: an unknown sub-command answers with usage that offers only shipped verbs', async () => {
  const { engine, cleanup } = boot();
  try {
    const replies = [];
    const handle = { name: 'seat', isAlive: () => true, inject: (t) => replies.push(t) };
    const row = registry.pluginRowFor('gh');
    row.handler(handle, row.parse('[agent:gh merge]'));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(replies.length, 1, 'ENTER: usage reached the agent');
    // The usage text must not advertise a bare `pr` as a thing that opens a PR,
    // which is what it said before the cut.
    const usage = engine._internals.USAGE.join('\n');
    assert.ok(!/\[agent:gh pr\]/.test(usage), 'usage must not offer a bare `pr`');
    assert.match(usage, /\[agent:gh pr --dry\]/, 'it offers the dry run instead');
    for (const sub of ['status', 'ci', 'review']) {
      assert.ok(usage.includes(`[agent:gh ${sub}]`), `usage lists ${sub}`);
    }
  } finally { cleanup(); }
});

test('github: the prompt lines an agent is given never promise a push', () => {
  const { engine, cleanup } = boot();
  try {
    const lines = engine._internals.PROMPT_LINES;
    assert.ok(!/\[agent:gh pr\]\s/.test(lines), 'no bare `pr` is offered to the agent');
    assert.ok(!/\bpush and open\b/.test(lines), 'the pre-cut wording is gone');
    assert.match(lines, /\[agent:gh pr --dry\]/);
    assert.match(lines, /never ask for one/, 'the no-token instruction survives');
  } finally { cleanup(); }
});

// ── 5. the fsScope gate ─────────────────────────────────────────────────────

test('github: a remote session is refused before anything shells out', async () => {
  const { sessions, spawns, cleanup } = boot();
  try {
    sessions.set('seat', { name: 'seat', type: 'agent', peer: 'box2', workspaceId: 'w1' });
    const replies = [];
    const handle = { name: 'seat', isAlive: () => true, inject: (t) => replies.push(t) };
    registry.pluginRowFor('gh').handler(handle, registry.pluginRowFor('gh').parse('[agent:gh status]'));
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));

    assert.strictEqual(replies.length, 1, 'ENTER: the refusal reached the agent');
    assert.match(replies[0], /remote/);
    assert.deepStrictEqual(spawns, [], 'no command runs for a session with no local fs');
  } finally { cleanup(); }
});
