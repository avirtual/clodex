'use strict';
// team-file-intents.test.js — t753: `[agent:team template-save|template-rm|
// prompt-save|prompt-rm]` write and delete inside the LEAD'S OWN team directory,
// through the same writer `templates:saveTeam` uses.
//
// The manager is assembled from createTicketMethods directly rather than through
// a whole SessionManager: `_handleTeam` needs only `this._injectText` plus the
// three helpers this ticket added, and every dependency that decides a refusal
// (resolveTeam, listTeams, teamsDir, fs) is real here — the teams dir is real
// bytes under a temp root, so what the assertions read back is what a lead's
// intent would really have written.
//
// Refusals are asserted against the DISK, not the reply line, for the reason
// team-template-save-ipc.test.js states: a handler that answered `error:` while
// having already created the file would pass an envelope-only test, and "a
// refused verb writes nothing" is the property that keeps a typo from minting a
// stray template.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTicketMethods } = require('../team-tickets');
const { registerIpcHandlers } = require('../ipc-handlers');
const { mkTmpRoot } = require('./lib/tmp-roots');

// `roles` is the manifest half every -rm guard reads; the fixture's default names
// `hand-seat` as a template and `lead-prompt` as a system prompt, so both refusal
// arms have a real dependency to find and the "succeeds after role-set cleared
// it" subjects have something to clear.
function mkBox({ roles, teams = ['clodex'] } = {}) {
  const home = mkTmpRoot('t753-');
  const teamsDir = path.join(home, 'teams');
  for (const t of teams) fs.mkdirSync(path.join(teamsDir, t), { recursive: true });
  const team = {
    name: 'clodex',
    root: '/proj',
    lead: 'lead',
    file: path.join(teamsDir, 'clodex', 'team.json'),
    dir: path.join(teamsDir, 'clodex'),
    roles: roles || {
      lead: { prompt: 'lead-prompt', brief: 'the lead' },
      hand: { template: 'hand-seat', brief: 'the hand' },
    },
  };
  let refreshes = 0;
  const methods = createTicketMethods({
    fs,
    path,
    teamsDir,
    listTeams: () => fs.readdirSync(teamsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    resolveTeam: (cwd) => (cwd === '/proj' ? team : null),
    refreshAppMenu: () => { refreshes++; },
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  const lead = { name: 'lead', agentType: 'claude', cwd: '/proj' };
  const hand = { name: 'hand', agentType: 'claude', cwd: '/proj' };
  return {
    m, team, teamsDir, injected, lead, hand,
    refreshCount: () => refreshes,
    last: () => injected[injected.length - 1] || '',
    tplFile: (stem) => path.join(teamsDir, 'clodex', 'templates', `${stem}.json`),
    promptFile: (kind, stem) => path.join(teamsDir, 'clodex', 'prompts', kind, `${stem}.md`),
  };
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// ── template-save ────────────────────────────────────────────────────────────

test('template-save writes the parsed body into the team templates dir', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, {
    type: 'team', sub: 'template-save', stem: 'runner',
    body: '{"type":"claude","cwd":"${TEAM_ROOT}","agents":["Explore"]}',
  });
  const file = b.tplFile('runner');
  assert.ok(exists(file), 'the template landed');
  // Whole-object compare, not a field probe: a writer that dropped or renamed a
  // key would satisfy any partial match while shipping a template that spawns a
  // different seat than the lead authored.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')),
    { type: 'claude', cwd: '${TEAM_ROOT}', agents: ['Explore'] });
  assert.match(b.last(), /template "runner" saved to /);
});

test('template-save refuses a body that is not JSON, and writes nothing', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'runner', body: '{type: claude}' });
  assert.match(b.last(), /^\[agent:team\] error: template body is not JSON \(/);
  assert.ok(!exists(b.tplFile('runner')), 'nothing was written');
});

test('template-save refuses a body with no string type, and writes nothing', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'runner', body: '{"cwd":"/proj"}' });
  assert.match(b.last(), /a template body must be an object with a string type/);
  assert.ok(!exists(b.tplFile('runner')), 'nothing was written');
});

test('template-save refuses a body over the transport cap, naming the size', () => {
  const b = mkBox();
  const body = `{"type":"claude","pad":"${'x'.repeat(70000)}"}`;
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'runner', body });
  assert.match(b.last(), new RegExp(`template body too long \\(${body.length} > 65536 bytes\\)`));
  assert.ok(!exists(b.tplFile('runner')), 'nothing was written');
});

for (const bad of ['..', '.', 'a/b', 'p:x', '', 'x'.repeat(65)]) {
  test(`template-save refuses the stem ${JSON.stringify(bad)} and writes nothing`, () => {
    const b = mkBox();
    b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: bad || null, body: '{"type":"claude"}' });
    assert.match(b.last(), /error: /);
    assert.ok(!exists(path.join(b.teamsDir, 'clodex', 'templates')),
      'a refused stem does not even create the templates dir');
  });
}

test('a NON-lead is refused every one of the four verbs, and writes nothing', () => {
  const b = mkBox();
  for (const intent of [
    { type: 'team', sub: 'template-save', stem: 'runner', body: '{"type":"claude"}' },
    { type: 'team', sub: 'prompt-save', kind: 'system', stem: 'p', body: 'hi' },
    { type: 'team', sub: 'template-rm', stem: 'hand-seat' },
    { type: 'team', sub: 'prompt-rm', kind: 'system', stem: 'lead-prompt' },
  ]) {
    b.m._handleTeam(b.hand, intent);
    assert.match(b.last(), /only the team lead \(lead\) can edit team metadata/, intent.sub);
  }
  assert.ok(!exists(path.join(b.teamsDir, 'clodex', 'templates')), 'no templates dir');
  assert.ok(!exists(path.join(b.teamsDir, 'clodex', 'prompts')), 'no prompts dir');
});

// ── prompt-save ──────────────────────────────────────────────────────────────

for (const kind of ['system', 'append']) {
  test(`prompt-save writes a ${kind} prompt, into a 0700 directory`, () => {
    const b = mkBox();
    b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind, stem: 'brief', body: '# Brief\n\nbody\n' });
    const file = b.promptFile(kind, 'brief');
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '# Brief\n\nbody\n',
      'the body is written verbatim — no trailing-newline normalization');
    // The umask-default mkdir was the t748 nit this ticket fixes: ~/.clodex is
    // 0700 throughout, and a prompt dir that widens to 0755 puts a team's own
    // prompts under a mode the rest of the tree does not use.
    assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700,
      `prompts/${kind} is 0700`);
    assert.match(b.last(), new RegExp(`prompt ${kind}/brief saved to `));
  });
}

test('prompt-save refuses a kind that is neither system nor append, naming both', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind: 'apend', stem: 'brief', body: 'x' });
  assert.match(b.last(), /prompt kind must be system or append \(got "apend"\)/);
  assert.ok(!exists(path.join(b.teamsDir, 'clodex', 'prompts')), 'nothing was written');
});

test('prompt-save refuses an empty body', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind: 'system', stem: 'brief', body: '   \n ' });
  assert.match(b.last(), /a prompt body must not be empty/);
  assert.ok(!exists(b.promptFile('system', 'brief')), 'nothing was written');
});

test('prompt-save refuses a body over the transport cap, naming the size', () => {
  const b = mkBox();
  const body = 'x'.repeat(65537);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind: 'system', stem: 'brief', body });
  assert.match(b.last(), /prompt body too long \(65537 > 65536 bytes\)/);
  assert.ok(!exists(b.promptFile('system', 'brief')), 'nothing was written');
});

// The cap is stated in BYTES and a prompt is prose, so it must be measured in
// bytes: 40000 em-dashes are 40000 string units and 120000 UTF-8 bytes, so a
// `.length` check would write a file the transport could not have carried.
test('the cap counts UTF-8 bytes, not string units', () => {
  const b = mkBox();
  const body = '—'.repeat(40000);
  assert.ok(body.length < 65536, 'ENTER: this body is UNDER the cap by string length');
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind: 'system', stem: 'brief', body });
  assert.match(b.last(), /prompt body too long \(120000 > 65536 bytes\)/);
  assert.ok(!exists(b.promptFile('system', 'brief')), 'nothing was written');
});

// ── the -rm guard: a stem a role still names ─────────────────────────────────

test('template-rm is refused while a role names the stem, and succeeds once it does not', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'hand-seat', body: '{"type":"claude"}' });
  assert.ok(exists(b.tplFile('hand-seat')), 'ENTER: the file the guard is protecting exists');

  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-rm', stem: 'hand-seat' });
  assert.match(b.last(), /template "hand-seat" is still named by role\(s\): hand —/);
  assert.ok(exists(b.tplFile('hand-seat')), 'the refusal did not delete it');

  // What a real `[agent:team role-set hand template:other]` leaves behind. The
  // manifest is the guard's whole input, so clearing it here is the same state
  // the mutator would produce.
  delete b.team.roles.hand.template;
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-rm', stem: 'hand-seat' });
  assert.match(b.last(), /template "hand-seat" removed from /);
  assert.ok(!exists(b.tplFile('hand-seat')), 'and now it is gone');
});

test('prompt-rm system is refused while a role names the stem, and succeeds once it does not', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind: 'system', stem: 'lead-prompt', body: 'x' });
  assert.ok(exists(b.promptFile('system', 'lead-prompt')), 'ENTER: the file the guard is protecting exists');

  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-rm', kind: 'system', stem: 'lead-prompt' });
  assert.match(b.last(), /prompt system\/lead-prompt is still named by role\(s\): lead —/);
  assert.ok(exists(b.promptFile('system', 'lead-prompt')), 'the refusal did not delete it');

  delete b.team.roles.lead.prompt;
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-rm', kind: 'system', stem: 'lead-prompt' });
  assert.match(b.last(), /prompt system\/lead-prompt removed from /);
  assert.ok(!exists(b.promptFile('system', 'lead-prompt')), 'and now it is gone');
});

// A role's `prompt` field names a SYSTEM stem. An append stem of the same name is
// a different file that no role can reference, so guarding it would refuse on a
// dependency that does not exist — and the lead would have no way to delete it.
test('prompt-rm append is NOT guarded by a role naming the same stem as a system prompt', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind: 'append', stem: 'lead-prompt', body: 'x' });
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-rm', kind: 'append', stem: 'lead-prompt' });
  assert.match(b.last(), /prompt append\/lead-prompt removed from /);
  assert.ok(!exists(b.promptFile('append', 'lead-prompt')), 'the append copy is gone');
  assert.strictEqual(b.team.roles.lead.prompt, 'lead-prompt',
    'ENTER: the role still names the SYSTEM stem — the case the guard would have fired on');
});

test('every role naming the stem is listed, sorted, not just the first', () => {
  const b = mkBox({
    roles: {
      zeta: { template: 'shared' },
      alpha: { template: 'shared' },
      other: { template: 'unrelated' },
    },
  });
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-rm', stem: 'shared' });
  assert.match(b.last(), /named by role\(s\): alpha, zeta —/);
});

// ── refreshAppMenu ───────────────────────────────────────────────────────────

test('refreshAppMenu fires once per landed write and NOT on a refusal', () => {
  const b = mkBox();
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'a', body: '{"type":"claude"}' });
  assert.strictEqual(b.refreshCount(), 1, 'one write, one refresh');
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-save', stem: 'b', body: 'not json' });
  assert.strictEqual(b.refreshCount(), 1, 'a refusal changes nothing, so it refreshes nothing');
  b.m._handleTeam(b.lead, { type: 'team', sub: 'prompt-save', kind: 'append', stem: 'c', body: 'x' });
  assert.strictEqual(b.refreshCount(), 2);
  b.m._handleTeam(b.lead, { type: 'team', sub: 'template-rm', stem: 'a' });
  assert.strictEqual(b.refreshCount(), 3, 'a landed remove refreshes too');
});

// The menu rebuild is instrumentation hanging off the write; a throwing one must
// not turn a file that IS on disk into an error line, which would send the lead
// to re-save it over its own good copy.
test('a throwing refreshAppMenu is swallowed: the write still reports success', () => {
  const home = mkTmpRoot('t753-throw-');
  const teamsDir = path.join(home, 'teams');
  fs.mkdirSync(path.join(teamsDir, 'clodex'), { recursive: true });
  const team = { name: 'clodex', lead: 'lead', roles: {}, dir: path.join(teamsDir, 'clodex') };
  const methods = createTicketMethods({
    fs,
    path,
    teamsDir,
    listTeams: () => ['clodex'],
    resolveTeam: () => team,
    refreshAppMenu: () => { throw new Error('menu is on fire'); },
    log: { info() {}, warn() {}, error() {} },
  }, {});
  const injected = [];
  const m = Object.create(methods);
  m._injectText = (_s, text) => { injected.push(text); };
  m._handleTeam({ name: 'lead', agentType: 'claude', cwd: '/proj' },
    { type: 'team', sub: 'template-save', stem: 'runner', body: '{"type":"claude"}' });
  assert.match(injected[injected.length - 1], /template "runner" saved to /,
    'the throw did not become the reply');
  assert.ok(exists(path.join(teamsDir, 'clodex', 'templates', 'runner.json')));
});

// ── drawer parity: ONE writer, byte-identical output ──────────────────────────

// The drawer and the intent reach `teamTemplateSave` by different routes — an IPC
// handler with a renderer's parsed object, and a verb with an agent's text. If
// they ever grow separate writers, the divergence shows up here as bytes rather
// than as a template that loads in one surface and not the other.
test('templates:saveTeam and template-save produce byte-identical files', () => {
  const home = mkTmpRoot('t753-parity-');
  const teamsDir = path.join(home, 'teams');
  for (const t of ['viaDrawer', 'viaIntent']) fs.mkdirSync(path.join(teamsDir, t), { recursive: true });
  const listTeams = () => ['viaDrawer', 'viaIntent'];

  const handlers = {};
  const stub = () => () => {};
  registerIpcHandlers(new Proxy({
    handle: (ch, fn) => { handlers[ch] = fn; },
    on: (ch, fn) => { handlers[ch] = fn; },
    fs, path, teamsDir, listTeams,
    listAllTemplates: () => [],
    templates: { list: () => [] },
    refreshAppMenu: () => {},
    log: { info() {}, warn() {}, error() {} },
  }, { get: (t, p) => (p in t ? t[p] : stub()) }));

  const team = { name: 'viaIntent', lead: 'lead', roles: {}, dir: path.join(teamsDir, 'viaIntent') };
  const methods = createTicketMethods({
    fs, path, teamsDir, listTeams, resolveTeam: () => team,
    refreshAppMenu: () => {}, log: { info() {}, warn() {}, error() {} },
  }, {});
  const m = Object.create(methods);
  m._injectText = () => {};

  const bodyText = '{"type":"claude","cwd":"${TEAM_ROOT}","agents":["Explore"],"noWire":true}';
  const res = handlers['templates:saveTeam']({}, 'viaDrawer', 'seat', JSON.parse(bodyText));
  assert.strictEqual(res.ok, true, 'ENTER: the drawer half actually wrote');
  m._handleTeam({ name: 'lead', agentType: 'claude', cwd: '/proj' },
    { type: 'team', sub: 'template-save', stem: 'seat', body: bodyText });

  const drawerBytes = fs.readFileSync(path.join(teamsDir, 'viaDrawer', 'templates', 'seat.json'));
  const intentBytes = fs.readFileSync(path.join(teamsDir, 'viaIntent', 'templates', 'seat.json'));
  assert.strictEqual(intentBytes.toString(), drawerBytes.toString());
  assert.strictEqual(drawerBytes.toString(),
    `${JSON.stringify(JSON.parse(bodyText), null, 2)}\n`,
    'and both carry the pretty-printed form with the trailing newline the library uses');
});
