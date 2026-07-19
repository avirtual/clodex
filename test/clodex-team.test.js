'use strict';

// clodex-team.js: teams control plane over the exec intent
// (docs/teams-design.md, docs/exec-tools.md). Roster derivation (registry cwd
// join + manifest under ~/.clodex/teams/<name>/, resolved by root-containment)
// and the retire envelope contract (target socket, from=requester,
// type=team-retire, byte-silent success; failures loud). Fake CLODEX_HOME;
// real unix sockets (peer/wire tests set the socket precedent).
//
// Ported from the pre-layout-flip scratchpad suite. The scratchpad's old #7
// check validated the operator-INSTALLED ~/.clodex/library/exec/
// clodex-team.json — not committed, so a hermetic suite can't read it. Instead
// this pins the script↔schema contract against a committed FIXTURE exec-def
// (test/fixtures/clodex-team.exec.json), validated through the real
// exec-schema.parseAndValidate — see the "exec-def schema" block at the end.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { parseAndValidate } = require('../exec-schema');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clodex-team.js');
const EXEC_DEF = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clodex-team.exec.json'), 'utf-8'));

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cteam-'));
}

function reg(home, name, cwd, socket) {
  const dir = path.join(home, 'run', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'),
    JSON.stringify({ name, socket: socket || path.join(dir, 'agent.sock'), pid: process.pid, ...(cwd ? { cwd } : {}) }));
  return path.join(dir, 'agent.sock');
}

// A team is teams/<name>/team.json with an absolute `root` (the project dir).
function mkTeam(home, name, root, manifest) {
  const dir = path.join(home, 'teams', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ root, ...manifest }));
}

function launch(home, payload) {
  return new Promise((resolve) => {
    const ch = cp.spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, CLODEX_HOME: home },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    ch.stderr.on('data', (d) => { err += d.toString(); });
    ch.on('exit', (code) => resolve({ code, err: err.trim() }));
    ch.stdin.end(JSON.stringify(payload));
  });
}

test('roster: resolves team by cwd, lists roles + live-in-project', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {}, dev: {}, reviewer: { instantiate: 'subagent' } } });
  reg(home, 'alead', path.join(proj, 'sub'));
  reg(home, 'adev', proj);
  reg(home, 'outsider', path.join(home, 'elsewhere'));

  const r1 = await launch(home, { action: 'roster', agent: 'alead' });
  assert.strictEqual(r1.code, 0, `roster exits 0: ${r1.err}`);
  assert.match(r1.err, /team proj \(root /, `names the team: ${r1.err}`);
  // Space-separated roles; lead starred; a bare session role is just its name; a
  // non-session role carries a parenthetical instantiate annotation.
  assert.match(r1.err, /roles: lead\* dev reviewer\(subagent\) \(\*=lead\)/, `roles annotated: ${r1.err}`);
  assert.match(r1.err, /live: adev,alead/, `live join by cwd (sorted, no outsider): ${r1.err}`);
});

test('roster: per-role template + instantiate annotations (spawn-by-template)', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  // A team a lead reads to resolve role → template for [agent:spawn template:Y]:
  //   lead      — session default, no template → bare name (starred)
  //   worker    — has a template, session → tmpl + instantiate both shown
  //   reviewer  — subagent, no template → just the instantiate
  //   runner    — template + subagent → both
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: {
    lead: {},
    worker: { template: 'hand', instantiate: 'session' },
    reviewer: { instantiate: 'subagent' },
    runner: { template: 'haiku-run', instantiate: 'subagent' },
  } });
  reg(home, 'alead', proj);
  const r = await launch(home, { action: 'roster', agent: 'alead' });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /roles: lead\* worker\(tmpl=hand,session\) reviewer\(subagent\) runner\(tmpl=haiku-run,subagent\) \(\*=lead\)/, r.err);
});

test('roster: no team containing cwd replies honestly, exit 0', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {} } });
  reg(home, 'outsider', path.join(home, 'elsewhere'));
  const r = await launch(home, { action: 'roster', agent: 'outsider' });
  assert.strictEqual(r.code, 0);
  assert.match(r.err, /no project/, r.err);
});

test('roster: unregistered agent with no cwd is loud', async () => {
  const home = mkHome();
  const r = await launch(home, { action: 'roster', agent: 'ghost' });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /cannot resolve your cwd/, r.err);
});

test('roster: payload cwd fallback works when registry lacks one', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {} } });
  const r = await launch(home, { action: 'roster', agent: 'ghost', cwd: proj });
  assert.strictEqual(r.code, 0);
  assert.match(r.err, /roles: lead\*/, r.err);
});

test('roster: deepest root wins on nested teams', async () => {
  const home = mkHome();
  const outer = path.join(home, 'mono');
  const inner = path.join(outer, 'packages', 'app');
  mkTeam(home, 'mono', outer, { lead: 'lead', roles: { lead: {} } });
  mkTeam(home, 'app', inner, { lead: 'boss', roles: { boss: {} } });
  reg(home, 'aworker', path.join(inner, 'src'));
  const r = await launch(home, { action: 'roster', agent: 'aworker' });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /team app \(/, `deepest team chosen: ${r.err}`);
  assert.match(r.err, /roles: boss\*/, r.err);
});

test('retire: envelope lands on the target socket with the contract shape', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {}, dev: {} } });
  reg(home, 'alead', path.join(proj, 'sub'));
  const devSock = reg(home, 'adev', proj);

  const envelopes = [];
  const server = net.createServer((conn) => {
    const chunks = [];
    conn.on('data', (c) => chunks.push(c));
    conn.on('end', () => { try { envelopes.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* torn */ } });
  });
  await new Promise((r) => server.listen(devSock, r));
  const r4 = await launch(home, { action: 'retire', agent: 'alead', target: 'adev' });
  await new Promise((r) => setTimeout(r, 200));
  server.close();

  assert.strictEqual(r4.code, 0, `retire code: ${r4.code}`);
  assert.strictEqual(r4.err, '', `retire success is byte-silent: "${r4.err}"`);
  assert.strictEqual(envelopes.length, 1, 'exactly one envelope delivered');
  assert.strictEqual(envelopes[0].from, 'alead');
  assert.strictEqual(envelopes[0].type, 'team-retire');
});

test('retire: failures are loud (unknown target, dead socket, missing target)', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {} } });
  reg(home, 'alead', path.join(proj, 'sub'));
  reg(home, 'outsider', path.join(home, 'elsewhere')); // registered, socket never bound

  const r5 = await launch(home, { action: 'retire', agent: 'alead', target: 'nosuch' });
  assert.strictEqual(r5.code, 1);
  assert.match(r5.err, /no live registration/, r5.err);

  const r6 = await launch(home, { action: 'retire', agent: 'alead', target: 'outsider' });
  assert.strictEqual(r6.code, 1);
  assert.match(r6.err, /could not reach/, r6.err);

  const r7 = await launch(home, { action: 'retire', agent: 'alead' });
  assert.strictEqual(r7.code, 1);
  assert.match(r7.err, /needs "target"/, r7.err);
});

test('bad payloads are loud (unknown action, missing agent)', async () => {
  const home = mkHome();
  const r8 = await launch(home, { action: 'nope', agent: 'alead' });
  assert.strictEqual(r8.code, 1);
  assert.match(r8.err, /unknown action/, r8.err);

  const r9 = await launch(home, { action: 'roster' });
  assert.strictEqual(r9.code, 1);
  assert.match(r9.err, /needs "agent"/, r9.err);
});

// The exec-def gates payloads BEFORE they reach the script; pin that the
// committed schema accepts exactly what clodex-team.js handles and rejects the
// rest, via the real exec-schema validator (hermetic replacement for the
// scratchpad's operator-home #7 check).
test('exec-def schema accepts valid payloads via real parseAndValidate', () => {
  for (const payload of [
    { action: 'roster', agent: 'clodex' },
    { action: 'retire', agent: 'clodex', target: 'clodex-hand' },
    { action: 'roster', agent: 'ghost', cwd: '/some/project' }, // payload-cwd fallback
  ]) {
    const r = parseAndValidate(EXEC_DEF, JSON.stringify(payload));
    assert.strictEqual(r.ok, true, `should accept ${JSON.stringify(payload)}: ${r.error}`);
    assert.strictEqual(r.value.action, payload.action);
  }
});

test('exec-def schema rejects payloads the script would refuse', () => {
  for (const [payload, why] of [
    [{ action: 'destroy', agent: 'a' }, 'action not in enum'],
    [{ agent: 'a' }, 'missing required action'],
    [{ action: 'roster' }, 'missing required agent'],
    [{ action: 'roster', agent: 'a', bogus: 1 }, 'additionalProperties'],
  ]) {
    const r = parseAndValidate(EXEC_DEF, JSON.stringify(payload));
    assert.strictEqual(r.ok, false, `should reject (${why}): ${JSON.stringify(payload)}`);
  }
});
