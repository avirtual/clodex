'use strict';
// args-dialog-team-append.test.js — t826: Edit Session must draw the seat's
// TEAM-OWN append prompts and must not drop an append stem it could not draw.
//
// The casualty: clodex-ios-lead carried `appendPromptFiles: ["team-project"]`
// (a stem living in ~/.clodex/teams/clodex-ios/prompts/append/). An account
// change through Edit Session ▸ Account saved the dialog; the checklist had
// drawn library stems only, and the save rebuilt the list from checked boxes
// alone, so `[]` was written and the team brief left the lead's composed prompt
// with no warning. t809 fixed the same defect in the TEMPLATE editor; the args
// dialog is the second door onto the same record.
//
// Both halves live in DOM/IPC-bound renderer code no fixture here can drive, so
// they are pinned by source shape, in the style of team-template-append.test.js
// and echo-rewrite-wiring.test.js. The engine half — readSessionArgs handing the
// renderer the team name to filter on — is exercised for real against a temp
// clodex home, because the source pin below is satisfied by `res.team` being
// forever undefined.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createEngine } = require('../engine');
const { createTeamManifest } = require('../team-manifest');
const { mkTmpRoot } = require('./lib/tmp-roots');

after(() => { setImmediate(() => process.exit(0)); });

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function openArgsDialogSrc() {
  const m = SRC.match(/async function openArgsDialog\([\s\S]*?\n\}\n/);
  return m ? m[0] : null;
}

test('openArgsDialog filters the seat team\'s append rows and passes them to the checklist', () => {
  const src = openArgsDialogSrc();
  assert.ok(src, 'ENTER: openArgsDialog is still found by this anchor');
  assert.ok(/res\.team\s*\n?\s*\?\s*\(promptLib \|\| \[\]\)/.test(src),
    'the rows are gated on res.team — a seat with no team must draw library-only');
  assert.ok(/p\.kind === 'append' && p\.team === res\.team/.test(src),
    'only the OWNING team\'s append rows; another team\'s stem resolves nowhere for this seat');
  assert.ok(/renderAppendChecklist\(argsAppendList,[^\n]*argsSeat\(\), argsTeamAppendRows\)/.test(src),
    'the rows actually reach the render call — the whole defect was the 4th argument missing');
  assert.ok(/argsAppendRendered = \[\.\.\.getPromptLibCache\(\)\.append\.map\([^\n]*argsTeamAppendRows\.map\(/.test(src),
    'the rendered set is library + team rows, so mergeUnrendered can tell a drawn untick from an undrawable stem');
});

test('the args-dialog save preserves append names the dialog never rendered', () => {
  assert.ok(/mergeUnrendered\(argsAppendPersisted, argsAppendRendered, collectAppendChecklist\(argsAppendList\)\)/.test(SRC),
    'the save routes through the merge, not collectAppendChecklist alone');
  assert.ok(/const appendPromptFiles = promptsHidden \? \[\]/.test(SRC),
    'a hidden prompts row still clears the list — a non-agent seat owns no append prompts');
});

function mkHome() {
  const tmp = mkTmpRoot('clx-t826-');
  const home = path.join(tmp, 'clodex-home');
  const eng = createEngine({
    userDataPath: tmp,
    seams: { registryDir: home },
    log: { info() {}, warn() {}, error() {} },
  });
  const { createTeam } = createTeamManifest({ fs, clodexHome: home });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  createTeam({ name: 't', root: repo, lead: 't-lead' });
  return { eng, tmp, repo };
}

test('readSessionArgs reports the team owning the seat\'s cwd', () => {
  const { eng, repo } = mkHome();
  eng.stores.persistence.upsert({ name: 'lead', type: 'claude', cwd: repo, appendPromptFiles: ['team-project'] });
  const res = eng.readSessionArgs('lead');
  assert.strictEqual(res.ok, true, 'ENTER: the entry must be readable, or `team` below is undefined for the wrong reason');
  assert.strictEqual(res.team, 't',
    'the dialog filters listPrompts on this name — without it no team row is ever drawn');
});

test('readSessionArgs reports null for a cwd outside every team root', () => {
  const { eng, tmp } = mkHome();
  const outside = path.join(tmp, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  eng.stores.persistence.upsert({ name: 'solo', type: 'claude', cwd: outside });
  const res = eng.readSessionArgs('solo');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.team, null,
    'null, not undefined and not a stray team — an unteamed seat must draw the library alone');
});
