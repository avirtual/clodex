'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { createTicketMethods } = require('../team-tickets');
const { teamTemplateSave } = require('../team-prompt-dir');
const registry = require('../intent-registry');
const { mkTmpRoot } = require('./lib/tmp-roots');

registry.registerIntent({ verb: 'avh-select', label: 'AVH select', parse: () => null }, 'avh-ops');
after(() => registry.unregisterSource('avh-ops'));

function saveDeps() {
  const teamsDir = mkTmpRoot('clx-grant-save-');
  fs.mkdirSync(path.join(teamsDir, 'core'), { recursive: true });
  return { deps: { fs, path, teamsDir, listTeams: () => ['core'] }, file: path.join(teamsDir, 'core', 'templates', 'pm.json') };
}

const LEAD_SAVER = (record) => ({ saver: { name: 'lead', lead: 'lead', record } });
const SELECT_BODY = { type: 'clodent', plugins: ['avh-ops'], intents: ['dm', 'avh-select'] };

test('a lead that neither holds nor may grant a plugin intent has it stripped at template-save', () => {
  const { deps, file } = saveDeps();
  const res = teamTemplateSave(deps, 'core', 'pm', SELECT_BODY, LEAD_SAVER({ execCommands: [], intents: ['dm'] }));
  assert.deepStrictEqual(res, { ok: true, file, stripped: ['avh-select'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'clodent', plugins: ['avh-ops'], intents: ['dm'] });
});

test('a lead holding a plugin intent, or holding it only in grantable, keeps it at template-save', () => {
  for (const rec of [
    { plugins: ['avh-ops'], intents: ['dm', 'avh-select'] },
    { intents: ['dm'], grantable: { execCommands: [], intents: ['avh-select'], flags: [] } },
  ]) {
    const { deps, file } = saveDeps();
    assert.deepStrictEqual(teamTemplateSave(deps, 'core', 'pm', SELECT_BODY, LEAD_SAVER(rec)), { ok: true, file });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), SELECT_BODY);
  }
});

test('a plugin intent the operator stored stays on the template when a lead without it re-saves', () => {
  const { deps, file } = saveDeps();
  teamTemplateSave(deps, 'core', 'pm', SELECT_BODY, { operator: true });
  const res = teamTemplateSave(deps, 'core', 'pm', { type: 'clodent', plugins: ['avh-ops'], intents: ['dm'] }, LEAD_SAVER({ intents: ['dm'] }));
  assert.deepStrictEqual(res, { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), SELECT_BODY);
});

function shapeManager(leadRec, templatesList) {
  const SessionManager = createSessionManager({
    knownSkillNames: () => [], os, fs, path,
    resolveTeam: () => null,
    log: { warn() {}, info() {}, error() {} },
    getPersistence: () => ({ get: (n) => (n === 'lead' ? leadRec : null), setStripLevel() {}, setAutoCompact() {} }),
    getTemplates: () => ({ list: () => templatesList }),
    withoutPrivilegedIntentsFor: (x) => x,
    ensureDir: () => {},
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    DEFAULT_WORKSPACE_ID: 'default',
  });
  const m = new SessionManager();
  m.sessions = new Map();
  return m;
}

const HAND_TPL = {
  name: 'hand-tpl', type: 'claude', plugins: ['avh-ops'],
  execCommands: ['avh-chat', 'avh-warden'],
  extraArgs: ['--model', 'opus', '--dangerously-skip-permissions'],
  intents: ['dm', 'avh-select'],
};
const CREW = { name: 'crew', lead: 'lead', root: '/repo', roles: { hand: { template: 'hand-tpl' } } };
const OPENER = (name) => ({ name, cwd: '/repo', workspaceId: 'ws-7', type: 'claude', proxy: null });

test('ticket dispatch from the team lead keeps only what the lead holds or may grant, and names the rest', () => {
  const lead = { name: 'lead', extraArgs: [], execCommands: [], grantable: { execCommands: ['avh-chat'], intents: [], flags: [] } };
  const shape = shapeManager(lead, [HAND_TPL]).resolveSeatShape(CREW, 'hand', 'ticket', OPENER('lead'));
  assert.deepStrictEqual(
    [shape.execCommands, shape.extraArgs, shape.intents, shape.grantDropped],
    [['avh-chat'], ['--model', 'opus'], ['dm'], ['avh-warden', '--dangerously-skip-permissions', 'avh-select']],
  );
});

test('ticket dispatch from a lead holding every item passes the template through', () => {
  const lead = { name: 'lead', extraArgs: ['--yolo'], execCommands: ['avh-chat'], plugins: ['avh-ops'], intents: ['avh-select'], grantable: { execCommands: ['avh-warden'], intents: [], flags: [] } };
  const shape = shapeManager(lead, [HAND_TPL]).resolveSeatShape(CREW, 'hand', 'ticket', OPENER('lead'));
  assert.deepStrictEqual(
    [shape.execCommands, shape.extraArgs, shape.intents, shape.grantDropped],
    [['avh-chat', 'avh-warden'], ['--model', 'opus', '--dangerously-skip-permissions'], ['dm', 'avh-select'], []],
  );
});

test('a review spawn from the lead drops a plugin intent the lead neither holds nor may grant', () => {
  const team = { ...CREW, roles: { reviewer: { template: 'rv' } } };
  const rv = { name: 'rv', type: 'claude', plugins: ['avh-ops'], intents: ['dm', 'avh-select'], execCommands: ['avh-chat'] };
  const shape = shapeManager({ name: 'lead', extraArgs: [] }, [rv]).resolveSeatShape(team, 'reviewer', 'review', OPENER('lead'));
  assert.deepStrictEqual([shape.intents, shape.grantDropped], [['dm'], ['avh-select']]);
});

function handlerBox(leadRec, roles) {
  const home = mkTmpRoot('clx-grant-handler-');
  const teamsDir = path.join(home, 'teams');
  fs.mkdirSync(path.join(teamsDir, 'clodex'), { recursive: true });
  const team = { name: 'clodex', root: '/proj', lead: 'lead', file: path.join(teamsDir, 'clodex', 'team.json'), dir: path.join(teamsDir, 'clodex'), roles };
  const methods = createTicketMethods({
    fs, path, teamsDir,
    listTeams: () => ['clodex'],
    resolveTeam: (cwd) => (cwd === '/proj' ? team : null),
    refreshAppMenu: () => {},
    getPersistence: () => ({ get: (n) => (n === 'lead' ? leadRec : null) }),
    withoutPrivilegedIntentsFor: (x) => x,
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  m.recordMisfire = () => true;
  return {
    m, injected,
    lead: { name: 'lead', agentType: 'claude', cwd: '/proj' },
    tplFile: (stem) => path.join(teamsDir, 'clodex', 'templates', `${stem}.json`),
  };
}

const GRANT_ONLY_CHAT = { name: 'lead', execCommands: [], grantable: { execCommands: ['avh-chat'], intents: [], flags: [] } };

test('template-save through the handler holds the lead role template to what the lead holds, and other stems to what it may grant', () => {
  const b = handlerBox(GRANT_ONLY_CHAT, { lead: { template: 'pm' }, hand: { template: 'runner' } });
  const body = '{"type":"claude","execCommands":["avh-chat"]}';
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'pm', body });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.tplFile('pm'), 'utf8')), { type: 'claude' });
  assert.match(b.injected[b.injected.length - 1], /stripped avh-chat, which lead neither holds nor may grant/);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'runner', body });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.tplFile('runner'), 'utf8')), { type: 'claude', execCommands: ['avh-chat'] });
});

test('template-save names a grantable key as operator-only, not as something the lead lacks', () => {
  const b = handlerBox(GRANT_ONLY_CHAT, { lead: { prompt: 'p' } });
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'runner', body: '{"type":"claude","grantable":{"execCommands":["avh-chat"]}}' });
  const last = b.injected[b.injected.length - 1];
  assert.match(last, /grantable is operator-only and was ignored/);
  assert.doesNotMatch(last, /stripped/);
});

test('role-set refuses a lead role template granting more than the lead seat holds', () => {
  const b = handlerBox(GRANT_ONLY_CHAT, { lead: { prompt: 'p' } });
  fs.mkdirSync(path.dirname(b.tplFile('big')), { recursive: true });
  fs.writeFileSync(b.tplFile('big'), JSON.stringify({ type: 'claude', execCommands: ['avh-chat'] }));
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'lead', template: 'big', body: '' });
  assert.match(b.injected[b.injected.length - 1], /error: template "big" grants avh-chat, which lead does not hold/);
});
