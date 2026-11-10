'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../session-manager');
const { createTicketMethods } = require('../team-tickets');
const { teamTemplateSave, mayGrantOf } = require('../team-prompt-dir');
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
    [['avh-chat'], ['--model', 'opus'], ['dm'], ['avh-warden', '--dangerously-skip-permissions', 'avh-select', 'avh-ops']],
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

test('ticket dispatch from a lead without bypass keeps plan mode and a tool denylist, dropping nothing', () => {
  const tpl = { name: 'hand-tpl', type: 'claude', extraArgs: ['--permission-mode', 'plan', '--disallowedTools', 'WebFetch'] };
  const shape = shapeManager({ name: 'lead', extraArgs: [] }, [tpl]).resolveSeatShape(CREW, 'hand', 'ticket', OPENER('lead'));
  assert.deepStrictEqual([shape.extraArgs, shape.grantDropped], [['--permission-mode', 'plan', '--disallowedTools', 'WebFetch'], []]);
});

test('ticket dispatch from a --yolo lead keeps the bypass and the tool denylist beside it', () => {
  const tpl = { name: 'hand-tpl', type: 'claude', extraArgs: ['--dangerously-skip-permissions', '--disallowedTools', 'WebFetch'] };
  const shape = shapeManager({ name: 'lead', extraArgs: ['--yolo'] }, [tpl]).resolveSeatShape(CREW, 'hand', 'ticket', OPENER('lead'));
  assert.deepStrictEqual([shape.extraArgs, shape.grantDropped], [['--dangerously-skip-permissions', '--disallowedTools', 'WebFetch'], []]);
});

test('ticket dispatch of a codex hand keeps its read-only sandbox cap under a lead that holds neither flag', () => {
  const tpl = { name: 'hand-tpl', type: 'codex', extraArgs: ['--sandbox', 'read-only', '--ask-for-approval', 'never'] };
  const shape = shapeManager({ name: 'lead', extraArgs: [] }, [tpl]).resolveSeatShape(CREW, 'hand', 'ticket', OPENER('lead'));
  assert.deepStrictEqual([shape.extraArgs, shape.grantDropped], [['--sandbox', 'read-only', '--ask-for-approval', 'never'], []]);
});

test('a lead\'s template-save names a malformed extraArgs as a type error, not as an ungranted item', () => {
  const b = handlerBox(GRANT_ONLY_CHAT, { lead: { prompt: 'p' } });
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'runner', body: '{"type":"claude","extraArgs":"--yolo"}' });
  const last = b.injected[b.injected.length - 1];
  assert.match(last, /extraArgs was ignored: it must be an array of strings/);
  assert.doesNotMatch(last, /stripped/);
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

test('a lead without bypass keeps plan mode and a tool denylist at template-save, and still loses a widening flag', () => {
  const { deps, file } = saveDeps();
  const body = { type: 'claude', extraArgs: ['--permission-mode', 'plan', '--disallowedTools', 'WebFetch', '--dangerously-skip-permissions'] };
  const res = teamTemplateSave(deps, 'core', 'pm', body, LEAD_SAVER({ extraArgs: [] }));
  assert.deepStrictEqual(res, { ok: true, file, stripped: ['--dangerously-skip-permissions'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
    { type: 'claude', extraArgs: ['--permission-mode', 'plan', '--disallowedTools', 'WebFetch'] });
});

test('a lead without the flag keeps a codex read-only sandbox at template-save', () => {
  const { deps, file } = saveDeps();
  const res = teamTemplateSave(deps, 'core', 'pm', { type: 'codex', extraArgs: ['--sandbox', 'read-only'] }, LEAD_SAVER({ extraArgs: [] }));
  assert.deepStrictEqual(res, { ok: true, file });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'codex', extraArgs: ['--sandbox', 'read-only'] });
});

function teamsWithExec() {
  const teamsDir = mkTmpRoot('clx-grant-team-exec-');
  for (const [team, cmd] of [['core', 'avh-chat'], ['other', 'u-cmd']]) {
    fs.mkdirSync(path.join(teamsDir, team, 'exec'), { recursive: true });
    fs.writeFileSync(path.join(teamsDir, team, 'exec', `${cmd}.json`), JSON.stringify({ description: cmd, argv: ['true'] }));
  }
  return teamsDir;
}

const TEAM_EXEC_TPL = { name: 'hand-tpl', type: 'claude', execCommands: ['avh-chat', 'u-cmd', 'lib-cmd'] };
const BYPASS_LEAD = () => ({ name: 'lead', type: 'claude', extraArgs: ['--dangerously-skip-permissions'], execCommands: [] });

function teamExecDispatch(leadRec, tpl = TEAM_EXEC_TPL) {
  const teamsDir = teamsWithExec();
  const team = { ...CREW, dir: path.join(teamsDir, 'core') };
  return shapeManager(leadRec, [tpl]).resolveSeatShape(team, 'hand', 'ticket', OPENER('lead'));
}

test('ticket dispatch from a bypass lead keeps its own team\'s exec command, dropping another team\'s and an unheld library command', () => {
  const lead = BYPASS_LEAD();
  const shape = teamExecDispatch(lead);
  assert.deepStrictEqual([shape.execCommands, shape.grantDropped], [['avh-chat'], ['u-cmd', 'lib-cmd']]);
  assert.deepStrictEqual(lead, { name: 'lead', type: 'claude', extraArgs: ['--dangerously-skip-permissions'], execCommands: [] });
});

test('ticket dispatch drops the team exec command from a lead without bypass, or with a credential sandbox or shell denylist', () => {
  for (const lead of [
    { name: 'lead', type: 'claude', extraArgs: [], execCommands: [] },
    { ...BYPASS_LEAD(), protectCredentials: [] },
    { ...BYPASS_LEAD(), shellDeny: ['curl'] },
  ]) {
    const shape = teamExecDispatch(lead);
    assert.deepStrictEqual([shape.execCommands, shape.grantDropped], [[], ['avh-chat', 'u-cmd', 'lib-cmd']]);
  }
});

test('a bypass lead with an empty shellDeny still grants its team exec command', () => {
  const shape = teamExecDispatch({ ...BYPASS_LEAD(), shellDeny: [] });
  assert.deepStrictEqual(shape.execCommands, ['avh-chat']);
});

test('a template asking bypass for the child does not make a non-bypass lead eligible for its team exec command', () => {
  const tpl = { ...TEAM_EXEC_TPL, extraArgs: ['--dangerously-skip-permissions'] };
  const shape = teamExecDispatch({ name: 'lead', type: 'claude', extraArgs: [], execCommands: [] }, tpl);
  assert.deepStrictEqual([shape.execCommands, shape.extraArgs, shape.grantDropped],
    [[], [], ['avh-chat', 'u-cmd', 'lib-cmd', '--dangerously-skip-permissions']]);
});

test('a template saved by a bypass lead loses the team exec command at dispatch once the lead loses bypass', () => {
  const teamsDir = teamsWithExec();
  const deps = { fs, path, teamsDir, listTeams: () => ['core', 'other'] };
  const lead = BYPASS_LEAD();
  const res = teamTemplateSave(deps, 'core', 'hand-tpl', { type: 'claude', execCommands: ['avh-chat', 'u-cmd', 'lib-cmd'] }, LEAD_SAVER(lead));
  const file = path.join(teamsDir, 'core', 'templates', 'hand-tpl.json');
  assert.deepStrictEqual(res, { ok: true, file, stripped: ['u-cmd', 'lib-cmd'] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'claude', execCommands: ['avh-chat'] });
  assert.deepStrictEqual(lead, { name: 'lead', type: 'claude', extraArgs: ['--dangerously-skip-permissions'], execCommands: [] });
  lead.extraArgs = [];
  const team = { ...CREW, dir: path.join(teamsDir, 'core') };
  const shape = shapeManager(lead, [{ name: 'hand-tpl', type: 'claude', execCommands: ['avh-chat'] }]).resolveSeatShape(team, 'hand', 'ticket', OPENER('lead'));
  assert.deepStrictEqual([shape.execCommands, shape.grantDropped], [[], ['avh-chat']]);
});

test('template-save by a lead without bypass strips its team exec command and names it', () => {
  const teamsDir = teamsWithExec();
  const deps = { fs, path, teamsDir, listTeams: () => ['core', 'other'] };
  const res = teamTemplateSave(deps, 'core', 'pm', { type: 'claude', execCommands: ['avh-chat'] }, LEAD_SAVER({ type: 'claude', extraArgs: [] }));
  assert.deepStrictEqual(res, { ok: true, file: path.join(teamsDir, 'core', 'templates', 'pm.json'), stripped: ['avh-chat'] });
});

test('a bypass lead\'s own role template and exec catalog never gain its team exec command', () => {
  const lead = { ...BYPASS_LEAD(), name: 'lead' };
  const b = handlerBox(lead, { lead: { template: 'pm' } });
  const teamDir = path.dirname(path.dirname(b.tplFile('x')));
  fs.mkdirSync(path.join(teamDir, 'exec'), { recursive: true });
  fs.writeFileSync(path.join(teamDir, 'exec', 'avh-chat.json'), JSON.stringify({ description: 'chat', argv: ['true'] }));
  const body = '{"type":"claude","execCommands":["avh-chat"]}';
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'pm', body });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.tplFile('pm'), 'utf8')), { type: 'claude' });
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'runner', body });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(b.tplFile('runner'), 'utf8')), { type: 'claude', execCommands: ['avh-chat'] });
  b.m._handleTeam(b.lead, { type: 'team', sub: 'role-set', name: 'lead', template: 'runner', body: '' });
  assert.match(b.injected[b.injected.length - 1], /error: template "runner" grants avh-chat, which lead does not hold/);
  assert.deepStrictEqual(lead, { name: 'lead', type: 'claude', extraArgs: ['--dangerously-skip-permissions'], execCommands: [] });
  assert.deepStrictEqual(mayGrantOf(lead).execCommands, []);
});
