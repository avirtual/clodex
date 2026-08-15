// Run: node --test
// The team-preflight resolver + the spawn-path finding it generalizes.
//
// The rule being pinned: a name that resolves to nothing is REPORTED, once, to
// the party who can act on it, and the operation proceeds. Before this, a
// missing role prompt was caught and dropped on the floor at
// session-manager.js's _teamBlockFor — the seat booted unbriefed and nothing
// anywhere said so.
//
// The findings are asserted as WHOLE OBJECTS (deepStrictEqual on the array),
// not by probing fields. A findings array is exactly the fixture shape that
// reads around a missing seam: an unwired probe returns undefined, the loop
// takes its default arm, and a partial assertion happily matches the survivors
// while the row under test was never built.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { teamPreflight } = require('../team-preflight');
const { preflightByRole } = require('../renderer/lib/team-roles');

// A probe set where EVERYTHING resolves. Individual tests remove one thing, so
// the finding under test is the only difference from a known-empty baseline —
// which is what makes an emptiness assertion elsewhere mean something.
function probes({ prompts = [], appends = [], templates = [], execs = {}, files = [] } = {}) {
  return {
    exists: (abs) => files.includes(abs),
    listTemplates: () => templates,
    readExecDef: (id) => (id in execs ? execs[id] : null),
    resolvePrompt: (kind, stem) => {
      const pool = kind === 'system' ? prompts : appends;
      return pool.includes(stem) ? 'library' : null;
    },
  };
}

const TEAM = {
  name: 'shop',
  root: '/repo/shop',
  roles: {
    lead: { prompt: 'clodex-team-lead' },
    hand: { prompt: 'clodex-team-hand', template: 'hand-seat' },
  },
};

test('a fully-resolving team produces NO findings — problems only, absence is resolution', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    appends: ['team-project'],
    templates: [{ name: 'hand-seat', execCommands: ['run-tests'], appendPromptFiles: ['team-project'] }],
    execs: { 'run-tests': { argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'] } },
    files: ['/repo/shop/scripts/t.sh'],
  }));
  // The green baseline every other case in this file is a one-thing delta from.
  assert.deepStrictEqual(findings, []);
});

test('an unresolved role prompt is a warn naming the role, the ref and the consequence', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead'], // hand's prompt is NOT installed
    appends: ['team-project'],
    templates: [{ name: 'hand-seat', execCommands: ['run-tests'], appendPromptFiles: ['team-project'] }],
    execs: { 'run-tests': { argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'] } },
    files: ['/repo/shop/scripts/t.sh'],
  }));
  // WHOLE array, WHOLE object: every field of the finding contract at once. A
  // probe of `findings[0].kind` would pass with `role: undefined`, which is the
  // exact seam this shape exists to hold.
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'prompt',
    role: 'hand',
    ref: 'clodex-team-hand',
    resolvedFrom: null,
    message: 'role "hand": prompt "clodex-team-hand" is not installed under library/prompts/system — a seat spawned for this role boots unbriefed',
  }]);
});

test('an unresolved append stem is a NOTE, not a warn — a fresh team owing a named file is normal', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    appends: [], // the stem the template names is the file the operator is expected to write
    templates: [{ name: 'hand-seat', appendPromptFiles: ['team-project'] }],
  }));
  assert.deepStrictEqual(findings, [{
    level: 'note',
    kind: 'append',
    role: 'hand',
    ref: 'team-project',
    resolvedFrom: null,
    message: 'role "hand": template "hand-seat" composes append prompt "team-project", which is not installed under library/prompts/append — write it, or drop it from the template',
  }]);
  // The severity split is the deliverable, not decoration: promote this to warn
  // and every fresh team reads as broken on its first screen. Asserted against
  // the reduction's survivor, not against an emptiness that an empty array also
  // satisfies.
  const warns = findings.filter((f) => f.level === 'warn');
  assert.strictEqual(findings.length, 1, 'ENTER: the append finding must have been emitted at all');
  assert.deepStrictEqual(warns, [], 'an owed append stem must never be a warn');
});

test('a missing template is a warn and STOPS that role — no findings about a file that does not exist', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [], // hand-seat is not installed
  }));
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'template',
    role: 'hand',
    ref: 'hand-seat',
    resolvedFrom: null,
    message: 'role "hand": template "hand-seat" is not in the template library — a seat spawned for this role gets none of its shape',
  }]);
});

test('a ${TEAM_ROOT} exec script missing under THIS team root is a warn naming the expanded path', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['run-tests'] }],
    execs: { 'run-tests': { argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'] } },
    files: [], // the script is not there
  }));
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'exec',
    role: 'hand',
    ref: 'run-tests',
    // 'library': the DEF resolved; the portable path inside it did not. That
    // distinction is the whole point of the ${TEAM_ROOT} token.
    resolvedFrom: 'library',
    message: 'role "hand": exec command "run-tests" needs /repo/shop/scripts/t.sh, which does not exist under this team\'s root',
  }]);
});

// The runner expands `cwd` with the same substitution it applies to argv
// (session-manager, _handleExecIntent: `runCwd = entry.cwd ? expandVars(entry.cwd) : …`),
// and our own shipped clodex-run-tests.json carries `"cwd": "${TEAM_ROOT}"` —
// so scanning argv alone gave a tick to a def that ENOENTs at run time.
test('a ${TEAM_ROOT} cwd missing under THIS team root is a warn, even when every argv resolves', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['run-tests'] }],
    execs: { 'run-tests': { argv: ['/bin/sh', '${TEAM_ROOT}/scripts/t.sh'], cwd: '${TEAM_ROOT}/scripts' } },
    // The SCRIPT is installed; only the working directory is not. Without the
    // cwd scan this fixture produces [] and reads as a healthy team.
    files: ['/repo/shop/scripts/t.sh'],
  }));
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'exec',
    role: 'hand',
    ref: 'run-tests',
    resolvedFrom: 'library',
    message: 'role "hand": exec command "run-tests" runs in /repo/shop/scripts, which does not exist under this team\'s root',
  }]);
});

test('a resolving ${TEAM_ROOT} cwd is silent — the check is a resolution, not a blanket accusation', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['run-tests'] }],
    // The exact shape of the shipped def: script under the root, cwd AT the root.
    execs: { 'run-tests': { argv: ['/bin/sh', '${TEAM_ROOT}/scripts/test-digest.sh'], cwd: '${TEAM_ROOT}' } },
    files: ['/repo/shop/scripts/test-digest.sh', '/repo/shop'],
  }));
  assert.deepStrictEqual(findings, []);
});

// execLibrary.list() normalizes a missing or non-array argv to [], so the
// malformed def arrives here looking like "resolved, nothing to check" — while
// the runner refuses it on every call ("malformed registry entry (needs a
// non-empty argv)"). A command that bounces every time was preflight-clean.
test('a def with an empty argv is a warn — preflight accepts nothing the runner would refuse', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['broken'] }],
    execs: { broken: { argv: [], cwd: '${TEAM_ROOT}' } },
    files: ['/repo/shop'],
  }));
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'exec',
    role: 'hand',
    ref: 'broken',
    // The def itself IS installed and readable — that is what distinguishes
    // this from the no-def-at-all case, which carries resolvedFrom: null.
    resolvedFrom: 'library',
    message: 'role "hand": exec command "broken" has a def under library/exec but no argv to run — the runner refuses it as malformed, so every call bounces',
  }]);
});

test('the empty-argv warn ENDS that def — a def that cannot run is not also accused of its paths', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['broken'] }],
    // cwd points at a directory that does NOT exist. The runner never reaches
    // the cwd expansion for this def, so reporting it would name a consequence
    // of a command that cannot run at all.
    execs: { broken: { cwd: '${TEAM_ROOT}/nowhere' } },
    files: [],
  }));
  assert.strictEqual(findings.length, 1, 'ENTER: the malformed-def warn must have been emitted at all');
  assert.deepStrictEqual(findings.map((f) => f.message.includes('no argv to run')), [true]);
});

test('an exec command with no def installed is a warn — an unreadable def is not a skipped check', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['ghost'] }],
    execs: {}, // no def
  }));
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'exec',
    role: 'hand',
    ref: 'ghost',
    resolvedFrom: null,
    message: 'role "hand": template "hand-seat" grants exec command "ghost", which has no def installed under library/exec',
  }]);
});

test('an argv without ${TEAM_ROOT}, or with a token this module cannot expand, is NOT accused', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['a', 'b', 'c'] }],
    execs: {
      // No token: an absolute or PATH-resolved command this module has no
      // business stat-ing (it is not the team's file).
      a: { argv: ['npm', 'test'] },
      // ${CLODEX_BIN} is expanded by the exec RUNNER from a host path this pure
      // module does not know. Guessing would accuse a file that is on disk.
      b: { argv: ['${CLODEX_BIN}/clodex-ctl', '${TEAM_ROOT}/x'] },
      // Bare token with no team root would substitute nothing; covered below.
      c: { argv: ['bash'] },
    },
    files: [],
  }));
  // `b`'s SECOND element does resolve-check (it is a clean ${TEAM_ROOT} path);
  // the first is skipped. So exactly one finding, and it must be the one naming
  // the path we could actually build.
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'exec',
    role: 'hand',
    ref: 'b',
    resolvedFrom: 'library',
    message: 'role "hand": exec command "b" needs /repo/shop/x, which does not exist under this team\'s root',
  }]);
});

test('a team with no root does not accuse a ${TEAM_ROOT} path it cannot build', () => {
  const rootless = { name: 'shop', roles: { hand: { prompt: 'p', template: 'hand-seat' } } };
  const findings = teamPreflight(rootless, probes({
    prompts: ['p'],
    templates: [{ name: 'hand-seat', execCommands: ['run-tests'] }],
    execs: { 'run-tests': { argv: ['bash', '${TEAM_ROOT}/scripts/t.sh'] } },
    files: [],
  }));
  assert.deepStrictEqual(findings, []);
});

test('findings arrive severity-descending within a role and in manifest role order', () => {
  const team = {
    name: 'shop',
    root: '/repo/shop',
    roles: {
      lead: { prompt: 'installed' },
      hand: { prompt: 'gone', template: 'hand-seat' },
      scout: { prompt: 'installed', template: 'nope' },
    },
  };
  const findings = teamPreflight(team, probes({
    prompts: ['installed'],
    appends: [],
    templates: [{ name: 'hand-seat', execCommands: ['ghost'], appendPromptFiles: ['owed'] }],
    execs: {},
  }));
  // The ORDER is a surface contract: a popover renders findings in arrival
  // order, so a worse problem must not sort under a lesser one.
  assert.deepStrictEqual(
    findings.map((f) => [f.role, f.kind, f.level]),
    [['hand', 'prompt', 'warn'], ['hand', 'exec', 'warn'], ['hand', 'append', 'note'], ['scout', 'template', 'warn']],
  );
  // lead resolves fully, so it contributes nothing — asserted as an absence
  // that is only meaningful because the three rows above did survive.
  assert.strictEqual(findings.filter((f) => f.role === 'lead').length, 0);
});

test('a malformed/absent team, or roles that are not objects, yields [] rather than throwing', () => {
  const p = probes({});
  assert.deepStrictEqual(teamPreflight(null, p), []);
  assert.deepStrictEqual(teamPreflight({}, p), []);
  assert.deepStrictEqual(teamPreflight({ roles: [] }, p), []);
  assert.deepStrictEqual(teamPreflight({ roles: { a: null, b: 'x' } }, p), []);
});

test('a probe that THROWS degrades to unresolved, never to a crashed popover', () => {
  const findings = teamPreflight(TEAM, {
    exists: () => { throw new Error('EIO'); },
    listTemplates: () => { throw new Error('EIO'); },
    readExecDef: () => { throw new Error('EIO'); },
    resolvePrompt: () => { throw new Error('EIO'); },
  });
  // Both prompts unresolved (throw ⇒ null), and hand's template unresolved
  // because the listing threw — the role stops there, per the missing-template rule.
  assert.deepStrictEqual(findings.map((f) => [f.role, f.kind]), [
    ['lead', 'prompt'], ['hand', 'prompt'], ['hand', 'template'],
  ]);
});

test('missing probes do not silently pass every check', () => {
  // The unwired-seam case CLAUDE.md's Tests section names: a fixture that
  // forgets a probe must not read as "everything resolves".
  const findings = teamPreflight(TEAM, {});
  assert.deepStrictEqual(findings.map((f) => [f.role, f.kind]), [
    ['lead', 'prompt'], ['hand', 'prompt'], ['hand', 'template'],
  ]);
});

test('preflightByRole buckets by role and OMITS roles that owe nothing', () => {
  const findings = [
    { level: 'warn', kind: 'prompt', role: 'hand', ref: 'p', resolvedFrom: null, message: 'm1' },
    { level: 'note', kind: 'append', role: 'hand', ref: 'a', resolvedFrom: null, message: 'm2' },
    { level: 'warn', kind: 'template', role: 'scout', ref: 't', resolvedFrom: null, message: 'm3' },
  ];
  const map = preflightByRole(findings);
  assert.deepStrictEqual([...map.keys()], ['hand', 'scout']);
  assert.deepStrictEqual(map.get('hand').map((f) => f.message), ['m1', 'm2'], 'arrival order kept');
  // A role with nothing owed is ABSENT, not present-and-empty: the popover reads
  // "no key" as resolved, and a present empty array would render an empty box.
  assert.strictEqual(map.has('lead'), false);
  assert.deepStrictEqual([...preflightByRole([]).keys()], []);
  assert.deepStrictEqual([...preflightByRole(null).keys()], []);
  // A finding with no role cannot be attached to a row, and must not become a
  // bucket keyed '' that renders under nothing.
  assert.deepStrictEqual([...preflightByRole([{ role: '', message: 'x' }, null, 'junk']).keys()], []);
});

// --- the spawn-path half: _teamBlockFor stops swallowing --------------------

const { createSessionManager } = require('../session-manager');

// Only the four deps _teamBlockFor actually touches are real (fs, path,
// REGISTRY_DIR, resolveTeam); everything else is an inert stub. The method is
// called directly — create() is not, so none of the spawn machinery is needed.
function mkManager(root, team) {
  const SessionManager = createSessionManager(new Proxy({
    REGISTRY_DIR: root, fs, path, os,
    resolveTeam: () => team,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }, {
    get(t, p) { return p in t ? t[p] : () => {}; },
  }));
  return new SessionManager();
}

function withPrompts(stems) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-preflight-'));
  const dir = path.join(root, 'library', 'prompts', 'system');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of stems) fs.writeFileSync(path.join(dir, `${s}.md`), `# ${s}\nbody\n`);
  return root;
}

const SEAT_TEAM = {
  name: 'shop',
  root: '/repo/shop',
  lead: 'shop-lead',
  roles: { lead: { prompt: 'lead-prompt' }, hand: { prompt: 'hand-prompt' } },
};

test('_teamBlockFor: an INSTALLED role prompt composes and reports nothing', () => {
  const root = withPrompts(['lead-prompt']);
  const m = mkManager(root, SEAT_TEAM);
  const r = m._teamBlockFor('shop-lead', '/repo/shop', 'claude', null);
  assert.ok(r.teamBlock.includes('# lead-prompt'), 'ENTER: the role prompt must have been composed at all');
  assert.strictEqual(r.missingPrompt, null, 'a resolved prompt reports nothing');
  assert.strictEqual(r.teamName, 'shop');
});

test('_teamBlockFor: a MISSING role prompt is reported instead of swallowed, and the block still stands', () => {
  const root = withPrompts([]); // nothing installed
  const m = mkManager(root, SEAT_TEAM);
  const r = m._teamBlockFor('shop-lead', '/repo/shop', 'claude', null);
  // The whole point: this used to be a bare `catch {}`. The team block survives
  // (never block a spawn), but the finding now exists for the caller to relay.
  assert.ok(r.teamBlock, 'ENTER: the team block must still be built — this is a report, not a block');
  assert.ok(r.missingPrompt, 'a missing role prompt must be reported, not swallowed');
  assert.match(r.missingPrompt, /boots unbriefed/);
  assert.match(r.missingPrompt, /lead-prompt/);
  assert.ok(!/NO system prompt/.test(r.missingPrompt), 'the append arm must not claim the system-prompt consequence');
});

test('_teamBlockFor: the RIDES-AS-SYSTEM arm reports too, with the worse consequence named', () => {
  const root = withPrompts([]);
  const m = mkManager(root, SEAT_TEAM);
  // systemPromptFile === def.prompt ⇒ this method appends nothing and the stem
  // is resolved by resolveSystemPromptFile at prompt-build time, where a miss
  // returns null and the seat boots with NO system prompt at all. Checking only
  // the arm that reads the file is how that case stayed invisible.
  const r = m._teamBlockFor('shop-lead', '/repo/shop', 'claude', 'lead-prompt');
  assert.ok(r.missingPrompt, 'the rides-as-system arm must report — it is the WORSE failure, not an exempt one');
  assert.match(r.missingPrompt, /NO system prompt/);
  assert.ok(!/boots unbriefed/.test(r.missingPrompt), 'the two arms must name different consequences');
});

test('_teamBlockFor: rides-as-system with the prompt INSTALLED reports nothing and appends nothing', () => {
  const root = withPrompts(['lead-prompt']);
  const m = mkManager(root, SEAT_TEAM);
  const r = m._teamBlockFor('shop-lead', '/repo/shop', 'claude', 'lead-prompt');
  assert.strictEqual(r.missingPrompt, null);
  // The dedupe that keeps the CLI from being handed the same prompt twice: this
  // arm must not compose the body it is already getting as --system-prompt-file.
  assert.ok(!r.teamBlock.includes('# lead-prompt'), 'the rides-as-system arm must not ALSO append the prompt');
});

test('_teamBlockFor: no team, no agent type, or a role with no prompt reports nothing', () => {
  const root = withPrompts([]);
  assert.strictEqual(mkManager(root, null)._teamBlockFor('x', '/tmp', 'claude', null).missingPrompt, null);
  assert.strictEqual(mkManager(root, SEAT_TEAM)._teamBlockFor('shop-lead', '/repo/shop', null, null).missingPrompt, null,
    'a bash session is not in a team and must not be accused of a missing prompt');
  const noPrompt = { name: 'shop', root: '/repo/shop', lead: 'shop-lead', roles: { lead: {} } };
  assert.strictEqual(mkManager(root, noPrompt)._teamBlockFor('shop-lead', '/repo/shop', 'claude', null).missingPrompt, null,
    'a role that names no prompt owes nothing');
});

test('_teamBlockFor: a seat matching NO role reports nothing', () => {
  const root = withPrompts([]);
  const m = mkManager(root, SEAT_TEAM);
  // Not a seat of any role in this team — there is no def, so no prompt is owed
  // and inventing a finding would accuse the operator of a name they never wrote.
  const r = m._teamBlockFor('some-other-agent', '/repo/shop', 'claude', null);
  assert.strictEqual(r.missingPrompt, null);
  assert.ok(r.teamBlock, 'ENTER: it still resolves the team — the absence above is about the ROLE');
});
