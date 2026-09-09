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
const { teamPromptFile } = require('../team-prompt-dir');
const { preflightByRole } = require('../renderer/lib/team-roles');
const { mkTmpRoot } = require('./lib/tmp-roots');

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
    message: 'role "hand": prompt "clodex-team-hand" is not installed under teams/shop/prompts/system or library/prompts/system — a seat spawned for this role boots unbriefed',
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
    message: 'role "hand": template "hand-seat" is in neither teams/shop/templates nor the template library — a seat spawned for this role gets none of its shape',
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
    message: 'role "hand": exec command "broken" has a def under teams/shop/exec or library/exec but no argv to run — the runner refuses it as malformed, so every call bounces',
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
    message: 'role "hand": template "hand-seat" grants exec command "ghost", which has no def installed under teams/shop/exec or library/exec',
  }]);
});

// execLibrary.list() drops a file that does not decode to a def object — bad
// JSON, or valid JSON that is not an object — so such a def and an absent one
// both leave the list, and the operator was told to install a file already on
// disk. The probe separates them with a sentinel; this pins that the leaf gives
// that state its own recovery.
test('a def file that exists but does not decode says REPAIR, not install', () => {
  const findings = teamPreflight(TEAM, probes({
    prompts: ['clodex-team-lead', 'clodex-team-hand'],
    templates: [{ name: 'hand-seat', execCommands: ['garbled'] }],
    // What the bound probe returns when list() dropped the file but raw() finds
    // bytes on disk: present, undecodable, nothing usable out of it.
    execs: { garbled: { name: 'garbled', unreadable: true } },
  }));
  assert.deepStrictEqual(findings, [{
    level: 'warn',
    kind: 'exec',
    role: 'hand',
    ref: 'garbled',
    // null, not 'library': the file is there but nothing RESOLVED out of it.
    resolvedFrom: null,
    message: 'role "hand": exec command "garbled" has a def file under teams/shop/exec or library/exec that could not be read as a def object — the runner cannot read it, so every call fails; repair the file',
  }]);
});

test('the unreadable and no-def arms stay distinguishable — same level, different recovery', () => {
  const findings = teamPreflight(
    { name: 'shop', root: '/repo/shop', roles: { hand: { prompt: 'p', template: 'hand-seat' } } },
    probes({
      prompts: ['p'],
      templates: [{ name: 'hand-seat', execCommands: ['ghost', 'garbled'] }],
      execs: { garbled: { name: 'garbled', unreadable: true } }, // `ghost` has no def at all
    }),
  );
  // ENTER: both rows must exist before the difference between them means
  // anything — a probe change that collapsed one into the other would otherwise
  // be read around by an assertion over the survivor alone.
  assert.strictEqual(findings.length, 2, 'ENTER: both exec findings must have been emitted');
  assert.deepStrictEqual(findings.map((f) => f.level), ['warn', 'warn'], 'same level: both are broken grants');
  assert.deepStrictEqual(findings.map((f) => f.kind), ['exec', 'exec'], 'no new finding kind');
  // The deliverable: the two messages must not be the same sentence. One says
  // install, the other says repair.
  assert.match(findings[0].message, /has no def installed under teams\/shop\/exec or library\/exec/);
  assert.match(findings[1].message, /could not be read as a def object/);
  assert.ok(!/could not be read as a def object/.test(findings[0].message), 'the absent def must not claim a decode failure');
  assert.ok(!/has no def installed/.test(findings[1].message), 'a file on disk must never be reported as missing');
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

// --- t703: the role prompt and the template system prompt disagree ---------

// One rule decides a seat's system prompt: the template's `systemPromptFile`
// when it names one, the role's `prompt` otherwise. Nothing before this read
// `template.systemPromptFile` at all, so a role briefed by one file and shaped
// by a template naming another was invisible here — the operator saw a team
// where both were configured and no sign that only one of them is the system
// prompt.
const PRECEDENCE_TEAM = {
  name: 'shop', root: '/repo/shop',
  roles: { hand: { prompt: 'hand-brief', template: 'hand-seat' } },
};

// Every stem these rows name is INSTALLED, so the only thing this fixture can
// produce is the disagreement note — t704's resolution warn would otherwise
// ride along on each differing row and the note would stop being what is pinned.
function precedenceFindings(systemPromptFile) {
  return teamPreflight(PRECEDENCE_TEAM, probes({
    prompts: ['hand-brief', 'hand-persona', 'other'],
    templates: [{ name: 'hand-seat', systemPromptFile }],
  }));
}

test('t703: a role prompt and a template system prompt that DIFFER get a note', () => {
  assert.deepStrictEqual(precedenceFindings('hand-persona'), [{
    level: 'note', kind: 'prompt', role: 'hand', ref: 'hand-brief', resolvedFrom: null,
    message: 'role "hand" names prompt "hand-brief", and its template "hand-seat" names system prompt "hand-persona" — the template\'s is the system prompt, the role\'s is appended after the team block',
  }], 'the whole finding, with the literal message the popover renders');
});

test('t703: the note is silent on every shape that is not a disagreement', () => {
  // Each row is a delta from the differing case above, which is the only case
  // that speaks. The expected values are literals, not re-derived from the
  // rule under test: a computed expectation here would agree with a resolver
  // that had no rule at all.
  const rows = [
    { what: 'same stem on both — one prompt, applied once', tplSystem: 'hand-brief', expect: [] },
    { what: 'the template names none (the STOCK hand shape)', tplSystem: null, expect: [] },
    { what: 'the template names an empty string', tplSystem: '', expect: [] },
    { what: 'the key is absent from the template entirely', tplSystem: undefined, expect: [] },
  ];
  for (const row of rows) {
    assert.deepStrictEqual(precedenceFindings(row.tplSystem), row.expect, row.what);
  }
  // ENTER: the same fixture with a DIFFERING stem really does produce the note,
  // so the silences above are the rule and not a fixture that reaches nothing.
  assert.strictEqual(precedenceFindings('other').length, 1);
});

test('t703: a role with no prompt at all owes no note, however the template is shaped', () => {
  // The template is then the only source and there is nothing to disagree with
  // — a note here would accuse the operator of a conflict they never wrote.
  const team = { name: 'shop', root: '/repo/shop', roles: { hand: { template: 'hand-seat' } } };
  assert.deepStrictEqual(teamPreflight(team, probes({
    prompts: ['hand-persona'],
    templates: [{ name: 'hand-seat', systemPromptFile: 'hand-persona' }],
  })), []);
});

test('t703: the note rides ALONGSIDE the existing prompt findings, not instead of them', () => {
  // An unresolved role prompt is still the warn it was: the disagreement and
  // the missing file are different facts about different files, and collapsing
  // them would hide whichever came second.
  const findings = teamPreflight(PRECEDENCE_TEAM, probes({
    prompts: ['hand-persona'], // hand-brief is not installed; the template's stem is
    templates: [{ name: 'hand-seat', systemPromptFile: 'hand-persona' }],
  }));
  assert.deepStrictEqual(findings.map((f) => [f.level, f.kind]), [['warn', 'prompt'], ['note', 'prompt']]);
});

test('t703: the note keeps LEVELS/KINDS and the file\'s own prompt-then-template order', () => {
  const { LEVELS, KINDS } = require('../team-preflight');
  const f = precedenceFindings('hand-persona')[0];
  assert.ok(LEVELS.includes(f.level), 'the level is one the popover knows how to render');
  assert.ok(KINDS.includes(f.kind), 'the kind is one the popover knows how to tag');

  // The template resolution moved ABOVE the prompt block so this note could be
  // emitted without a second resolver. The team-copy template note must still
  // arrive AFTER the prompt findings, per the file's severity-descending order.
  // `hand-persona` is installed nowhere here, so t704's resolution warn is the
  // second prompt row — the tuple carries `ref` so the two are distinguishable.
  const ordered = teamPreflight(PRECEDENCE_TEAM, {
    ...probes({ prompts: ['hand-brief'], templates: [] }),
    readTeamTemplate: (stem) => (stem === 'hand-seat' ? { systemPromptFile: 'hand-persona' } : null),
  });
  assert.deepStrictEqual(ordered.map((f2) => [f2.kind, f2.resolvedFrom, f2.ref]), [
    ['prompt', null, 'hand-brief'], ['prompt', null, 'hand-persona'], ['template', 'team', 'hand-seat'],
  ]);
});

// --- t704: the TEMPLATE's system prompt is resolved on disk too ------------

// Since t703 the template's `systemPromptFile` IS the seat's system prompt, and
// it rides the replace rail. A stem installed nowhere therefore boots the seat
// with no system prompt at all, which is worse than the unbriefed case the role
// prompt's warn names — and preflight resolved only the role's stem and the
// template's append stems, never this one.

// `where` maps a stem to what the probe returns for it ('library' | 'team');
// a stem absent from it resolves nowhere. Per-stem rather than a pool, because
// every interesting fixture here has an INSTALLED role prompt sitting beside a
// template stem that does not resolve.
function t704Findings({ systemPromptFile, where = {}, role = { prompt: 'hand-brief', template: 'hand-seat' }, spy = null }) {
  const tpl = { name: 'hand-seat' };
  if (systemPromptFile !== undefined) tpl.systemPromptFile = systemPromptFile;
  return teamPreflight({ name: 'shop', root: '/repo/shop', roles: { hand: role } }, {
    exists: () => false,
    listTemplates: () => [tpl],
    readExecDef: () => null,
    resolvePrompt: (kind, stem) => {
      if (spy) spy.push([kind, stem]);
      return (kind === 'system' && where[stem]) || null;
    },
  });
}

const T704_MISS = {
  level: 'warn', kind: 'prompt', role: 'hand', ref: 'hand-persona', resolvedFrom: null,
  message: 'role "hand": template "hand-seat" names system prompt "hand-persona", which is not installed under teams/shop/prompts/system or library/prompts/system — a seat spawned for this role boots with NO system prompt',
};
const T704_TEAM_COPY = {
  level: 'note', kind: 'prompt', role: 'hand', ref: 'hand-persona', resolvedFrom: 'team',
  message: 'role "hand": template "hand-seat" system prompt "hand-persona" is the team\'s own copy (teams/shop/prompts/system), shadowing the library',
};
// t703's disagreement note, which rides along on every row whose template stem
// differs from the role prompt. Named here so the arrays below stay readable.
const T703_NOTE = {
  level: 'note', kind: 'prompt', role: 'hand', ref: 'hand-brief', resolvedFrom: null,
  message: 'role "hand" names prompt "hand-brief", and its template "hand-seat" names system prompt "hand-persona" — the template\'s is the system prompt, the role\'s is appended after the team block',
};
// The same note for a PLUGIN persona: a role prompt disagreeing with a plugin's
// system prompt is still a disagreement, so t703 speaks where t704 must not.
const T703_NOTE_PLUGIN = {
  level: 'note', kind: 'prompt', role: 'hand', ref: 'hand-brief', resolvedFrom: null,
  message: 'role "hand" names prompt "hand-brief", and its template "hand-seat" names system prompt "rev:strict" — the template\'s is the system prompt, the role\'s is appended after the team block',
};

test('t704: the template system prompt warns when it resolves nowhere and notes the team copy', () => {
  // Every expectation is a literal array, not re-derived from the rule under
  // test: a computed one would agree with a resolver that had no rule at all.
  // Each silence row carries its own `enter` delta, so a fixture that never
  // reached the check cannot pass as a rule that stayed quiet.
  const rows = [
    {
      what: 'installed nowhere — the seat boots with no system prompt',
      systemPromptFile: 'hand-persona', where: { 'hand-brief': 'library' },
      expect: [T703_NOTE, T704_MISS],
    },
    {
      what: 'the team\'s own copy shadows the library',
      systemPromptFile: 'hand-persona', where: { 'hand-brief': 'library', 'hand-persona': 'team' },
      expect: [T703_NOTE, T704_TEAM_COPY],
    },
    {
      what: 'a library hit is silent — the shadowing is the fact, not the resolving',
      systemPromptFile: 'hand-persona', where: { 'hand-brief': 'library', 'hand-persona': 'library' },
      expect: [T703_NOTE],
      enter: { where: { 'hand-brief': 'library' }, expect: [T703_NOTE, T704_MISS] },
    },
    {
      what: 'the template names none (the STOCK hand shape) — nothing to resolve',
      systemPromptFile: undefined, where: { 'hand-brief': 'library' },
      expect: [],
      enter: { systemPromptFile: 'hand-persona', expect: [T703_NOTE, T704_MISS] },
    },
    {
      what: 'the template names an empty string',
      systemPromptFile: '', where: { 'hand-brief': 'library' },
      expect: [],
      enter: { systemPromptFile: 'hand-persona', expect: [T703_NOTE, T704_MISS] },
    },
    {
      what: 'the stem EQUALS the role prompt — the block above already resolved it',
      systemPromptFile: 'hand-brief', where: { 'hand-brief': 'library' },
      expect: [],
      // With that one stem uninstalled the role-prompt block's OWN warn is the
      // whole array: the skip must hold even when the shared stem misses, or
      // the operator gets the same file accused twice in two different voices.
      enter: {
        where: {},
        expect: [{
          level: 'warn', kind: 'prompt', role: 'hand', ref: 'hand-brief', resolvedFrom: null,
          message: 'role "hand": prompt "hand-brief" is not installed under teams/shop/prompts/system or library/prompts/system — a seat spawned for this role boots unbriefed',
        }],
      },
    },
    {
      // `listAllTemplates()` includes plugin templates, whose systemPromptFile
      // is already namespaced (`rev:strict`, as the loader wrote it). The
      // plugin bundle resolves that at spawn time; teams/ and library/ never
      // hold it, so probing here would warn about a seat that boots fine.
      what: 'a plugin-namespaced stem is the plugin\'s to resolve, not ours',
      systemPromptFile: 'rev:strict', where: { 'hand-brief': 'library' },
      expect: [T703_NOTE_PLUGIN],
      enter: { systemPromptFile: 'hand-persona', expect: [T703_NOTE, T704_MISS] },
    },
    {
      what: 'a role with NO prompt at all still gets its template stem resolved',
      role: { template: 'hand-seat' },
      systemPromptFile: 'hand-persona', where: {},
      expect: [T704_MISS],
    },
  ];

  for (const row of rows) {
    assert.deepStrictEqual(t704Findings(row), row.expect, row.what);
    if (!row.enter) continue;
    assert.deepStrictEqual(
      t704Findings({ ...row, ...row.enter }), row.enter.expect,
      `ENTER: ${row.what}`,
    );
  }
});

test('t704: the template stem is probed once per role, and not at all when it equals the role prompt', () => {
  const spy = [];
  t704Findings({ systemPromptFile: 'hand-persona', where: { 'hand-brief': 'library', 'hand-persona': 'library' }, spy });
  assert.deepStrictEqual(spy, [['system', 'hand-brief'], ['system', 'hand-persona']],
    'the role prompt then the template stem, each probed exactly once — no second resolver, no re-probe');

  const same = [];
  t704Findings({ systemPromptFile: 'hand-brief', where: { 'hand-brief': 'library' }, spy: same });
  assert.deepStrictEqual(same, [['system', 'hand-brief']],
    'the equal-stem case costs no extra probe beyond the role-prompt call');

  const noPrompt = [];
  t704Findings({ role: { template: 'hand-seat' }, systemPromptFile: 'hand-persona', where: {}, spy: noPrompt });
  assert.deepStrictEqual(noPrompt, [['system', 'hand-persona']],
    'and a template-only role probes the template stem and nothing else');

  const plugin = [];
  t704Findings({ systemPromptFile: 'rev:strict', where: { 'hand-brief': 'library' }, spy: plugin });
  assert.deepStrictEqual(plugin, [['system', 'hand-brief']],
    'a plugin ref is never probed: the plugin holds it and the disk does not, so asking could only produce a false miss');
});

test('t704: both findings carry a level and a kind the popover knows', () => {
  const { LEVELS, KINDS } = require('../team-preflight');
  for (const f of [T704_MISS, T704_TEAM_COPY]) {
    assert.ok(LEVELS.includes(f.level), `level ${f.level} is renderable`);
    assert.ok(KINDS.includes(f.kind), `kind ${f.kind} is taggable`);
  }
});

test('t704: a probe that throws on the template stem degrades to the warn, never to a crash', () => {
  const findings = teamPreflight({ name: 'shop', root: '/repo/shop', roles: { hand: { template: 'hand-seat' } } }, {
    exists: () => false,
    listTemplates: () => [{ name: 'hand-seat', systemPromptFile: 'hand-persona' }],
    readExecDef: () => null,
    resolvePrompt: () => { throw new Error('EIO'); },
  });
  assert.deepStrictEqual(findings, [T704_MISS]);
});

// --- t705: the runner's plugin-ref rule decides EVERY stem preflight resolves -

// The runner reads append stems through readAppendBodies (engine.js), which
// sends a `<plugin>:<stem>` ref to the plugin bundle. Preflight's probe sees the
// team dir and the library only, so probing a plugin ref could only ever produce
// a miss — and the loop's doctrine is that a finding means something is owed. A
// template composing a plugin append prompt boots fine, so preflight is silent.
//
// The other half is WHICH rule answers "is this a plugin ref". `includes(':')`
// and splitPluginPromptRef disagree on exactly one shape — a stem beginning with
// a colon, which the runner does NOT treat as a plugin ref — so the two spellings
// must be one function or preflight goes quiet over a seat that boots broken.

// The role prompt always resolves here, and the template names no system prompt,
// so the append findings are the whole array rather than survivors of a filter.
function t705Appends({ stems, where = {}, spy = null }) {
  return teamPreflight({ name: 'shop', root: '/repo/shop', roles: { hand: { prompt: 'hand-brief', template: 'hand-seat' } } }, {
    exists: () => false,
    listTemplates: () => [{ name: 'hand-seat', appendPromptFiles: stems }],
    readExecDef: () => null,
    resolvePrompt: (kind, stem) => {
      if (spy) spy.push([kind, stem]);
      if (kind === 'system') return stem === 'hand-brief' ? 'library' : null;
      return where[stem] || null;
    },
  });
}

const T705_OWED = {
  level: 'note', kind: 'append', role: 'hand', ref: 'extra', resolvedFrom: null,
  message: 'role "hand": template "hand-seat" composes append prompt "extra", which is not installed under library/prompts/append — write it, or drop it from the template',
};
const T705_APPEND_TEAM_COPY = {
  level: 'note', kind: 'append', role: 'hand', ref: 'extra', resolvedFrom: 'team',
  message: 'role "hand": prompt "extra" is the team\'s own copy (teams/shop/prompts/append), shadowing the library',
};

test('t705: a plugin-namespaced append stem is the plugin\'s to resolve, and the plain-stem arms are unmoved', () => {
  // Every expectation is a literal array. Re-deriving one from the rule under
  // test would assert only that the resolver agrees with itself, which is true
  // of a resolver holding no rule at all.
  const rows = [
    {
      what: 'a plugin ref is neither probed nor noted — the plugin composes it and the seat boots fine',
      stems: ['rev:extra'], where: {}, expect: [],
      // The SAME row with the namespace removed: an uninstalled plain stem is
      // the owed note, so this silence is the plugin rule and not a fixture
      // that reached no append check at all.
      enter: { stems: ['extra'], expect: [T705_OWED] },
    },
    {
      what: 'a plain stem the team owns is still the shadowing note',
      stems: ['extra'], where: { extra: 'team' }, expect: [T705_APPEND_TEAM_COPY],
    },
    {
      what: 'a plain stem the library holds is still silent',
      stems: ['extra'], where: { extra: 'library' }, expect: [],
      enter: { where: {}, expect: [T705_OWED] },
    },
    {
      what: 'a plain stem installed nowhere is still the "write it" note',
      stems: ['extra'], where: {}, expect: [T705_OWED],
    },
  ];

  for (const row of rows) {
    assert.deepStrictEqual(t705Appends(row), row.expect, row.what);
    if (!row.enter) continue;
    assert.deepStrictEqual(
      t705Appends({ ...row, ...row.enter }), row.enter.expect,
      `ENTER: ${row.what}`,
    );
  }
});

test('t705: the append probe is never asked about a plugin ref, and the loop carries on to the next stem', () => {
  const spy = [];
  t705Appends({ stems: ['rev:extra', 'extra'], where: { extra: 'library' }, spy });
  assert.deepStrictEqual(spy, [['system', 'hand-brief'], ['append', 'extra']],
    'the skip lands BEFORE the probe: `rev:extra` never reaches it, and `extra` still does');
});

const T705_COLON_NOTE = {
  level: 'note', kind: 'prompt', role: 'hand', ref: 'hand-brief', resolvedFrom: null,
  message: 'role "hand" names prompt "hand-brief", and its template "hand-seat" names system prompt ":foo" — the template\'s is the system prompt, the role\'s is appended after the team block',
};
const T705_COLON_MISS = {
  level: 'warn', kind: 'prompt', role: 'hand', ref: ':foo', resolvedFrom: null,
  message: 'role "hand": template "hand-seat" names system prompt ":foo", which is not installed under teams/shop/prompts/system or library/prompts/system — a seat spawned for this role boots with NO system prompt',
};

test('t705: a stem opening with a colon is no plugin ref to the runner, so it is probed and warned about', () => {
  // splitPluginPromptRef needs indexOf(':') > 0. `:foo` falls through the runner's
  // bad-stem check and the library and boots the seat with no system prompt —
  // which is precisely the case the t704 warn exists to name.
  assert.deepStrictEqual(
    t704Findings({ systemPromptFile: ':foo', where: { 'hand-brief': 'library' } }),
    [T705_COLON_NOTE, T705_COLON_MISS],
    'the empty plugin id is not a namespace, and the seat that boots on it is broken',
  );

  const spy = [];
  t704Findings({ systemPromptFile: ':foo', where: { 'hand-brief': 'library' }, spy });
  assert.deepStrictEqual(spy, [['system', 'hand-brief'], ['system', ':foo']],
    'and it is probed like any other stem — the gate is the runner\'s rule, not the colon');
});

test('t705: both call sites go through splitPluginPromptRef, and no second spelling of the rule survives', () => {
  // Source-shape, because the whole point is that ONE function answers the
  // question at two sites: a runtime fixture can show both sites agreeing with
  // the runner today while a second hand-rolled copy sits beside them.
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-preflight.js'), 'utf8');
  assert.ok(/require\('\.\/plugin-prompt-refs'\)/.test(src), 'the rule is imported, not re-derived');
  assert.ok(/function isPluginRef\(stem\) \{\s*\n\s*return splitPluginPromptRef\(stem\) !== null;/.test(src),
    'isPluginRef is splitPluginPromptRef and nothing else');
  assert.ok(/!isPluginRef\(tplSystem\)/.test(src), 'the template system-prompt gate uses it');
  assert.ok(/if \(isPluginRef\(stem\)\) continue;/.test(src), 'the append loop uses it');
  assert.ok(!/includes\(':'\)/.test(src), 'the colon-substring spelling is gone from the module');
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

// Only the deps _teamBlockFor actually touches are real (fs, path, REGISTRY_DIR,
// resolveTeam, readSystemPromptBody); everything else is an inert stub. The
// method is called directly — create() is not, so none of the spawn machinery is
// needed.
//
// readSystemPromptBody must be REAL rather than the Proxy's inert stub: the
// method reads its role prompt through that seam, and a stub returning undefined
// would make every subject below report a missing prompt for the wrong reason —
// the "INSTALLED prompt reports nothing" arms would fail while the "missing
// prompt is reported" arms passed vacuously. It resolves the team's own copy
// before the library through the same leaf the engine's resolver uses, so the
// precedence under test here is the shipped one, not a second statement of it.
function mkManager(root, team) {
  const SessionManager = createSessionManager(new Proxy({
    REGISTRY_DIR: root, fs, path, os,
    knownSkillNames: () => [],
    resolveTeam: () => team,
    readSystemPromptBody: (stem, _plugins, t) => {
      const own = teamPromptFile({ fs, path }, t, 'system', stem);
      const file = own || path.join(root, 'library', 'prompts', 'system', `${stem}.md`);
      try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }, {
    get(t, p) { return p in t ? t[p] : () => {}; },
  }));
  return new SessionManager();
}

function withPrompts(stems) {
  const root = mkTmpRoot('clodex-preflight-');
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

// --- t703: the ticket arm's flip is LOSSLESS -------------------------------

// The flip in resolveSeatShape's ticket arm only holds if the role prompt it
// stopped passing as --system-prompt-file still reaches the seat. It does, by
// the arm of _teamBlockFor that appends a role prompt which did NOT ride as
// system — which is a claim about a DIFFERENT module, so it is proved here
// rather than assumed at the flip.
const T703_TEAM = {
  name: 'shop', root: '/repo/shop', lead: 'shop-lead',
  roles: { hand: { prompt: 'role-delta', template: 'hand-seat' } },
};

test('t703: with the TEMPLATE riding as system prompt, the role prompt is still composed', () => {
  const root = withPrompts(['role-delta', 'tpl-persona']);
  const m = mkManager(root, T703_TEAM);
  // 'tpl-persona' is what the ticket arm now resolves for this role (template
  // first). The role's own 'role-delta' is the stem that used to ride there.
  const r = m._teamBlockFor('shop-hand', '/repo/shop', 'claude', 'tpl-persona');
  assert.ok(r.teamBlock.includes('# role-delta'),
    'the role prompt the template displaced must still reach the seat, appended after the team block');
  assert.ok(!r.teamBlock.includes('# tpl-persona'),
    'and the template\'s own prompt is NOT appended — it rides as --system-prompt-file');
  assert.strictEqual(r.missingPrompt, null);
});

test('t703: when both name the SAME stem the body appears exactly once', () => {
  const root = withPrompts(['role-delta']);
  const m = mkManager(root, T703_TEAM);
  // ENTER: this seat name really does match the hand role, so the absence
  // asserted below is the dedupe and not a seat that reached no role def at
  // all — with no match nothing is ever appended and the count is 0 either way.
  const entered = m._teamBlockFor('shop-hand', '/repo/shop', 'claude', null);
  assert.strictEqual(entered.teamBlock.split('# role-delta').length - 1, 1,
    'ENTER: with the stem NOT riding as system, this exact seat appends it exactly once');

  const r = m._teamBlockFor('shop-hand', '/repo/shop', 'claude', 'role-delta');
  assert.strictEqual(r.teamBlock.split('# role-delta').length - 1, 0,
    'the stem rides as --system-prompt-file, so appending it here would hand the CLI the same body twice');
  assert.strictEqual(r.missingPrompt, null);
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
