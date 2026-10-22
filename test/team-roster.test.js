'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTeamManifest, ROSTER_FILE } = require('../team-manifest');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mkPark } = require('./lib/session-fixtures');

const ROLES = { lead: { brief: 'lead' }, hand: { brief: 'hand' }, scout: { brief: 'scout' } };

function mkHome(t) {
  const home = mkTmpRoot('clodex-roster-');
  const rootA = mkTmpRoot('clodex-roster-a-');
  const rootB = mkTmpRoot('clodex-roster-b-');
  t.after(() => { for (const d of [home, rootA, rootB]) fs.rmSync(d, { recursive: true, force: true }); });
  const logs = [];
  let clock = 1_000_000;
  const log = {
    info: (_tag, m) => logs.push(['info', m]),
    warn: (_tag, m) => logs.push(['warn', m]),
    error: (_tag, m) => logs.push(['error', m]),
  };
  const tm = createTeamManifest({ fs, clodexHome: home, log, now: () => clock });
  const records = new Map();
  const live = new Set();
  tm.setSeatLookup({ record: (n) => records.get(n) || null, live: (n) => live.has(n) });
  const writeTeam = (name, root, lead) => {
    fs.mkdirSync(path.join(home, 'teams', name), { recursive: true });
    fs.writeFileSync(path.join(home, 'teams', name, 'team.json'), JSON.stringify({ version: 3, lead, root, roles: ROLES }));
  };
  const writeRoster = (name, seats) => {
    fs.writeFileSync(path.join(home, 'teams', name, ROSTER_FILE), JSON.stringify({ version: 1, seats }));
  };
  const readRoster = (name) => JSON.parse(fs.readFileSync(path.join(home, 'teams', name, ROSTER_FILE), 'utf-8')).seats;
  return {
    tm, home, rootA, rootB, logs, records, live, writeTeam, writeRoster, readRoster,
    tick: (ms) => { clock += ms; }, now: () => clock,
  };
}

test('one claim: binding a seat another team holds is refused, naming the holder team and role', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', h.rootB, 'b-lead');
  h.records.set('x', { name: 'x', cwd: h.rootA, createdAt: 5 });
  assert.deepStrictEqual(await h.tm.bindSeat('a', 'x', 'hand', { by: 'a-lead' }), {
    ok: true, team: 'a', row: { seat: 'x', role: 'hand', gen: 5, since: h.now(), by: 'a-lead' },
  });
  const r = await h.tm.bindSeat('b', 'x', 'scout', { by: 'b-lead' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "x is on team a's roster (role hand) — unbind it there first");
  assert.ok(!fs.existsSync(path.join(h.home, 'teams', 'b', ROSTER_FILE)), 'nothing written for the refused team');
});

test('a stale row (no record, no session) is overwritten by a bind elsewhere, and the drop is logged', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', h.rootB, 'b-lead');
  h.writeRoster('a', [{ seat: 'x', role: 'hand', gen: 1, since: 1, by: 'ticket-loop' }]);
  const r = await h.tm.bindSeat('b', 'x', 'scout', { by: 'b-lead' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.readRoster('a'), []);
  assert.deepStrictEqual(h.readRoster('b').map((x) => [x.seat, x.role]), [['x', 'scout']]);
  assert.ok(h.logs.some(([lvl, m]) => lvl === 'info' && m === 'team a: stale row x (role hand) dropped — x now bound to b'),
    JSON.stringify(h.logs));
});

test('rename moves the row to the new name and carries its gen', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeRoster('a', [{ seat: 'old', role: 'scout', gen: 777, since: 1, by: 'a-lead' }]);
  const r = await h.tm.renameSeatRow('old', 'new');
  assert.deepStrictEqual(r, { ok: true, teams: ['a'] });
  assert.deepStrictEqual(h.readRoster('a'), [{ seat: 'new', role: 'scout', gen: 777, since: 1, by: 'a-lead' }]);
  h.records.set('new', { name: 'new', cwd: '/elsewhere', createdAt: 777 });
  const team = h.tm.teamOf({ name: 'new', cwd: '/elsewhere' });
  assert.strictEqual(team && team.name, 'a', 'the renamed seat keeps its team outside the root');
});

test('a record recreated under a bound name resolves to no team until bound again', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeRoster('a', [{ seat: 'a-hand-1', role: 'hand', gen: 100, since: 1, by: 'ticket-loop' }]);
  h.records.set('a-hand-1', { name: 'a-hand-1', cwd: h.rootA, createdAt: 100 });
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }).name, 'a', 'ENTER: the original seat resolves');
  h.records.set('a-hand-1', { name: 'a-hand-1', cwd: h.rootA, createdAt: 200 });
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null);
  assert.strictEqual(h.tm.teamOfSeat('a-hand-1'), null);
  assert.strictEqual(h.logs.filter(([, m]) => /a-hand-1 was recreated/.test(m)).length, 1, 'logged once');
});

test('a malformed roster is quarantined: renamed, every seat it named teamless, one error logged', (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.records.set('a-hand-1', { name: 'a-hand-1', cwd: h.rootA, createdAt: 1 });
  h.records.set('a-scout', { name: 'a-scout', cwd: h.rootA, createdAt: 1 });
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), '{"version":1,"seats":[{"seat":"a-hand-1","role":"hand"');
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null);
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null, 'still teamless on the next read');
  const dir = fs.readdirSync(path.join(h.home, 'teams', 'a'));
  assert.ok(!dir.includes(ROSTER_FILE), 'roster.json moved away');
  assert.deepStrictEqual(dir.filter((n) => n.startsWith(`${ROSTER_FILE}.bad-`)), [`${ROSTER_FILE}.bad-${h.now()}`]);
  const errors = h.logs.filter(([lvl]) => lvl === 'error');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0][1], new RegExp(`roster\\.json\\.bad-${h.now()}`));
  assert.strictEqual(h.tm.teamOf({ name: 'a-scout', cwd: h.rootA }).name, 'a', 'a seat the file never named still resolves');
});

test('a row naming a role team.json no longer has quarantines the roster instead of falling back to the name', (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.records.set('a-hand-1', { name: 'a-hand-1', cwd: h.rootA, createdAt: 1 });
  h.writeRoster('a', [{ seat: 'a-hand-1', role: 'ghost', gen: 1, since: 1, by: 'a-lead' }]);
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null, 'not the hand role its name matches');
  assert.ok(fs.readdirSync(path.join(h.home, 'teams', 'a')).some((n) => n.startsWith(`${ROSTER_FILE}.bad-`)));
  assert.match(h.logs.find(([lvl]) => lvl === 'error')[1], /role "ghost", which is not in team\.roles/);
  const r = h.tm.rosterOf('a');
  assert.deepStrictEqual(r.quarantine.seats, ['a-hand-1']);
});

test('two binds of one seat on two teams fired together: exactly one wins, the other gets the one-claim refusal', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', h.rootB, 'b-lead');
  h.records.set('x', { name: 'x', cwd: h.rootA, createdAt: 9 });
  const [ra, rb] = await Promise.all([
    h.tm.bindSeat('a', 'x', 'hand', { by: 'a-lead' }),
    h.tm.bindSeat('b', 'x', 'hand', { by: 'b-lead' }),
  ]);
  assert.deepStrictEqual([ra.ok, rb.ok], [true, false]);
  assert.strictEqual(rb.error, "x is on team a's roster (role hand) — unbind it there first");
});

test('the stale-row prune skips a row younger than 60 s, and drops a row only on its second stale sweep', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeRoster('a', [
    { seat: 'young', role: 'hand', gen: null, since: h.now() - 1000, by: 'ticket-loop' },
    { seat: 'old', role: 'hand', gen: null, since: h.now() - 61_000, by: 'ticket-loop' },
  ]);
  assert.deepStrictEqual(await h.tm.pruneStaleRows(), [], 'the first stale sighting prunes nothing');
  assert.deepStrictEqual(h.readRoster('a').map((r) => r.seat), ['young', 'old']);
  const pruned = await h.tm.pruneStaleRows();
  assert.deepStrictEqual(pruned, [{ team: 'a', seat: 'old' }]);
  assert.deepStrictEqual(h.readRoster('a').map((r) => r.seat), ['young']);
});

test('migration synthesises rosters from every record, archived included, one log line per seat', (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', h.rootB, 'b-lead');
  const records = [
    { name: 'a-hand-3', cwd: h.rootA, createdAt: 11 },
    { name: 'b-scout', cwd: h.rootB, createdAt: 12, archivedAt: 99 },
    { name: 'b-hand', cwd: path.join(h.rootB, 'sub'), createdAt: 13 },
    { name: 'roleless', cwd: h.rootA, createdAt: 14 },
  ];
  const out = h.tm.synthesiseRosters(records);
  assert.deepStrictEqual(out.lines, [
    'team a: roster synthesised — a-lead as lead',
    'team b: roster synthesised — b-lead as lead',
    'team a: roster synthesised — a-hand-3 as hand',
    'team b: roster synthesised — b-scout as scout',
    'team b: roster synthesised — b-hand as hand',
  ]);
  assert.deepStrictEqual(h.logs.map(([, m]) => m), out.lines);
  assert.deepStrictEqual(h.readRoster('b'), [
    { seat: 'b-lead', role: 'lead', gen: null, since: h.now(), by: 'migration' },
    { seat: 'b-scout', role: 'scout', gen: 12, since: h.now(), by: 'migration' },
    { seat: 'b-hand', role: 'hand', gen: 13, since: h.now(), by: 'migration' },
  ]);
  assert.deepStrictEqual(h.tm.synthesiseRosters(records).lines, [], 'a team that has a roster is not re-synthesised');
});

test('teamOfCwd on a tie answers null and teamsOfCwd names both teams', (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', h.rootA, 'b-lead');
  assert.strictEqual(h.tm.teamOfCwd(h.rootA), null);
  assert.deepStrictEqual(h.tm.teamsOfCwd(h.rootA), ['a', 'b']);
  assert.strictEqual(h.tm.resolveTeam, h.tm.teamOfCwd, 'resolveTeam stays an alias for one release');
});

function mkSeats(t, { sharedRoot = false } = {}) {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', sharedRoot ? h.rootA : h.rootB, 'b-lead');
  const persistence = {
    list: () => [...h.records.values()],
    get: (n) => h.records.get(n) || null,
    upsert: (e) => h.records.set(e.name, { ...(h.records.get(e.name) || {}), ...e }),
  };
  const { m, injected } = mkPark({
    fs, path, os: require('node:os'), REGISTRY_DIR: h.home,
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/, DEFAULT_WORKSPACE_ID: 'default', ensureDir: () => {},
    getPersistence: () => persistence,
    resolveTeam: h.tm.resolveTeam, teamOf: h.tm.teamOf, teamsOfCwd: h.tm.teamsOfCwd,
    bindSeat: h.tm.bindSeat, unbindSeat: h.tm.unbindSeat, rosterOf: h.tm.rosterOf,
    loadManifest: h.tm.loadManifest, listTeams: h.tm.listTeams, teamOfSeat: h.tm.teamOfSeat,
  });
  m._sendToSession = () => {};
  const seat = (name, cwd, rec = {}) => {
    h.records.set(name, { name, cwd, createdAt: 1, ...rec });
    const s = { name, type: 'claude', agentType: 'claude', cwd, activityState: 'idle', workspaceId: 'default' };
    m.sessions.set(name, s);
    h.live.add(name);
    return s;
  };
  return { h, m, injected, seat };
}

test('on a shared root an unbound seat gets the labelled read-only list, and task start refuses naming both teams', (t) => {
  const { h, m, injected, seat } = mkSeats(t, { sharedRoot: true });
  const op = seat('op', h.rootA);
  m._handleTask(op, { type: 'task', sub: 'list' });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /^\[agent:task\] \[teams a, b share this board — read-only: op is on neither roster\]\nno tickets on a/);
  m._handleTask(op, { type: 'task', sub: 'start', id: 't1' });
  assert.strictEqual(injected[1],
    '[agent:task] error: teams a, b share this root and op is on neither roster — a lead binds it with [agent:team bind op <role>]');
});

test('team bind needs the team-create grant, and binding leaves the seat\'s exec grants byte-identical', async (t) => {
  const { h, m, injected, seat } = mkSeats(t);
  h.writeRoster('a', [{ seat: 'a-lead', role: 'lead', gen: 1, since: 1, by: 'create' }]);
  const lead = seat('a-lead', h.rootA, { intents: ['spawn'] });
  seat('helper', '/somewhere', { execCommands: ['clodex-run-tests', 'clodex-monitor'] });
  m._handleTeam(lead, { type: 'team', sub: 'bind', name: 'helper', role: 'scout' });
  await new Promise((r) => setImmediate(r));
  assert.match(injected[0], /^\[agent:team\] error: bind needs the operator's team-create grant on a-lead/);
  assert.deepStrictEqual(h.readRoster('a').map((r) => r.seat), ['a-lead']);
  const before = JSON.stringify(h.records.get('helper').execCommands);
  h.records.get('a-lead').intents = ['spawn', 'team-create'];
  m._handleTeam(lead, { type: 'team', sub: 'bind', name: 'helper', role: 'scout' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(injected[1], '[agent:team] bound helper to team a as scout — its exec grants, template and credentials are unchanged');
  assert.deepStrictEqual(h.readRoster('a').map((r) => [r.seat, r.role]), [['a-lead', 'lead'], ['helper', 'scout']]);
  assert.strictEqual(JSON.stringify(h.records.get('helper').execCommands), before);
  assert.strictEqual(m._teamOf(m.sessions.get('helper')).name, 'a', 'the bound seat is on the team from outside its root');
});

test('a quarantine survives the next bind: inferred binds are refused, and a lead bind keeps the other named seats teamless', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  for (const n of ['a-hand-1', 'a-scout']) h.records.set(n, { name: n, cwd: h.rootA, createdAt: 1 });
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), '{"seats":[{"seat":"a-hand-1","role":"hand"},{"seat":"a-scout"');
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null, 'ENTER: quarantined');
  const inferred = await h.tm.bindSeat('a', 'a-scout', 'scout', { by: 'inferred' });
  assert.strictEqual(inferred.ok, false);
  assert.match(inferred.error, /roster is quarantined/);
  assert.strictEqual((await h.tm.bindSeat('a', 'a-scout', 'scout', { by: 'a-lead' })).ok, true);
  assert.strictEqual(h.tm.teamOf({ name: 'a-scout', cwd: h.rootA }).name, 'a', 'the bound seat is back');
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null, 'the other named seat stays teamless');
  assert.deepStrictEqual(h.tm.rosterOf('a').quarantine.seats, ['a-hand-1']);
});

test('the lead resolves to its team through a quarantine and through a recreated record, and its row gen is re-stamped', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeRoster('a', [{ seat: 'a-lead', role: 'lead', gen: 100, since: 1, by: 'create' }]);
  h.records.set('a-lead', { name: 'a-lead', cwd: '/elsewhere', createdAt: 200 });
  assert.strictEqual(h.tm.teamOf({ name: 'a-lead', cwd: '/elsewhere' }).name, 'a', 'a recreated lead record keeps the team');
  await h.tm.pruneStaleRows();
  assert.strictEqual(h.readRoster('a')[0].gen, 200, 'the lead row follows the new record');
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), '{"seats":[{"seat":"a-lead","role":"lead"');
  assert.strictEqual(h.tm.teamOf({ name: 'a-lead', cwd: '/elsewhere' }).name, 'a', 'a quarantine naming the lead does not unseat it');
});

test('a quarantined team\'s lead can still run [agent:team roster], which shows the quarantine', (t) => {
  const { h, m, injected, seat } = mkSeats(t);
  const lead = seat('a-lead', h.rootA);
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), '{"seats":[{"seat":"a-lead","role":"lead"},{"seat":"a-hand-1"');
  m._handleTeam(lead, { type: 'team', sub: 'roster' });
  assert.strictEqual(injected.length, 1);
  assert.match(injected[0], /^\[agent:team\] \[team a\] roster\.json — 0 rows\nQUARANTINED: .*roster\.json\.bad-\d+ — on no team until a lead binds them: a-hand-1$/);
});

test('respawning a seat whose row went stale rebinds it to the spawner\'s team', async (t) => {
  const { h, m, seat } = mkSeats(t);
  h.writeRoster('a', [
    { seat: 'a-lead', role: 'lead', gen: 1, since: 1, by: 'create' },
    { seat: 'a-scout', role: 'scout', gen: 7, since: 1, by: 'old-binder' },
  ]);
  const lead = seat('a-lead', h.rootA);
  m.create = async (name, type, cwd) => {
    h.records.set(name, { name, cwd, createdAt: 900 });
    m.sessions.set(name, { name, type, agentType: type, cwd });
    return {};
  };
  m._handleSpawnIntent(lead, { type: 'spawn', name: 'a-scout', cwd: h.rootA });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const row = h.readRoster('a').find((r) => r.seat === 'a-scout');
  assert.strictEqual(row.by, 'a-lead', 'the stale row was overwritten by the spawner\'s bind');
  assert.strictEqual(m._teamOf(m.sessions.get('a-scout')).name, 'a', 'and the respawned seat is on the team');
});

test('createTeam and setLead refuse a lead another team holds, before writing anything', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.records.set('x', { name: 'x', cwd: h.rootA, createdAt: 1 });
  assert.strictEqual((await h.tm.bindSeat('a', 'x', 'hand', { by: 'a-lead' })).ok, true);
  assert.throws(() => h.tm.createTeam({ name: 'c', root: h.rootB, lead: 'x' }), /x is on team a's roster \(role hand\)/);
  assert.ok(!fs.existsSync(path.join(h.home, 'teams', 'c', 'team.json')));
  h.writeTeam('b', h.rootB, 'b-lead');
  assert.throws(() => h.tm.setLead('b', 'x'), /x is on team a's roster \(role hand\)/);
  assert.strictEqual(h.tm.loadManifest('b').lead, 'b-lead');
});

test('a second quarantine keeps the seats the first one still held', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  for (const n of ['a-hand-1', 'a-scout']) h.records.set(n, { name: n, cwd: h.rootA, createdAt: 1 });
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), '{"seats":[{"seat":"a-hand-1","role":"hand"},{"seat":"a-scout"');
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null, 'ENTER: quarantined');
  assert.strictEqual((await h.tm.bindSeat('a', 'a-scout', 'scout', { by: 'a-lead' })).ok, true);
  h.tick(1000);
  const carried = fs.readFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), 'utf-8');
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), carried.slice(0, -3));
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-1', cwd: h.rootA }), null, 'the held seat stays teamless');
  assert.ok(h.tm.rosterOf('a').quarantine.seats.includes('a-hand-1'));
});

test('a quarantine that named only the lead and seats since bound clears, so inferred binds work again', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  for (const n of ['a-hand-1', 'a-scout']) h.records.set(n, { name: n, cwd: h.rootA, createdAt: 1 });
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), '{"seats":[{"seat":"a-lead","role":"lead"},{"seat":"a-hand-1"');
  assert.deepStrictEqual(h.tm.rosterOf('a').quarantine.seats, ['a-hand-1'], 'ENTER: the lead is not held');
  assert.strictEqual((await h.tm.bindSeat('a', 'a-hand-1', 'hand', { by: 'a-lead' })).ok, true);
  assert.strictEqual(h.tm.rosterOf('a').quarantine, null);
  assert.strictEqual((await h.tm.bindSeat('a', 'a-scout', 'scout', { by: 'inferred' })).ok, true);
});

test('bind refuses another team\'s lead, and renaming a quarantined seat keeps the new name held', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', h.rootB, 'b-lead');
  const r = await h.tm.bindSeat('b', 'a-lead', 'hand', { by: 'b-lead' });
  assert.deepStrictEqual([r.ok, r.error], [false, "a-lead is team a's lead — set another lead there first"]);
  fs.writeFileSync(path.join(h.home, 'teams', 'a', ROSTER_FILE), '{"seats":[{"seat":"a-hand-1"');
  assert.deepStrictEqual(h.tm.rosterOf('a').quarantine.seats, ['a-hand-1'], 'ENTER: held');
  await h.tm.renameSeatRow('a-hand-1', 'a-hand-9');
  assert.deepStrictEqual(h.tm.rosterOf('a').quarantine.seats, ['a-hand-9']);
  assert.strictEqual(h.tm.teamOf({ name: 'a-hand-9', cwd: h.rootA }), null);
});

test('setLead is undone when a bind queued ahead of it claimed the seat first', async (t) => {
  const h = mkHome(t);
  h.writeTeam('a', h.rootA, 'a-lead');
  h.writeTeam('b', h.rootB, 'b-lead');
  h.records.set('x', { name: 'x', cwd: h.rootA, createdAt: 1 });
  const queued = h.tm.bindSeat('a', 'x', 'hand', { by: 'a-lead' });
  h.tm.setLead('b', 'x');
  assert.strictEqual((await queued).ok, true);
  await h.tm.pruneStaleRows();
  assert.strictEqual(h.tm.loadManifest('b').lead, 'b-lead');
  assert.ok(h.logs.some(([lvl, m]) => lvl === 'warn' && /set-lead x undone, lead is b-lead again/.test(m)), JSON.stringify(h.logs));
});
