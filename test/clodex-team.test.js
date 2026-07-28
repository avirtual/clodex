'use strict';

// clodex-team.js: teams control plane over the exec intent
// (teams-design.md [internal design doc, not in this repo], docs/exec-tools.md). Roster derivation (registry cwd
// join + manifest under ~/.clodex/teams/<name>/, resolved by root-containment)
// and the retire envelope contract (target socket, from=requester,
// type=team-retire, byte-silent success; failures loud). Fake CLODEX_HOME;
// real unix sockets (peer/wire tests set the socket precedent).
//
// Ported from the pre-layout-flip scratchpad suite. The scratchpad's old #7
// check validated the operator-INSTALLED ~/.clodex/library/exec/
// clodex-team.json, which is not committed and so cannot be read hermetically.
// This suite pins the script↔schema contract against the REPO SEED that copy is
// installed FROM — resources/library/exec/clodex-team.json, which is committed,
// in-repo and therefore fully hermetic — validated through the real
// exec-schema.parseAndValidate. See the "exec-def schema" block at the end.
//
// It read a hand-copied fixture until t101. That copy did not follow t80's
// update to the seed, so for one release these tests pinned a schema that would
// have REJECTED action:"tickets" — the verb the 300 lines above exercise — and
// stayed green throughout. A test that validates a copy of the shipped artifact
// is testing the copy. Read the artifact.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { parseAndValidate } = require('../exec-schema');
const { createSessionManager } = require('../session-manager');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clodex-team.js');
// The SHIPPED def, not a copy of it (t101).
const EXEC_DEF_PATH = path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-team.json');
const EXEC_DEF = JSON.parse(fs.readFileSync(EXEC_DEF_PATH, 'utf-8'));

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

// ── The listing parity pin (t100) ───────────────────────────────────────────
// scripts/clodex-team.js doTickets DUPLICATES session-manager.js _taskList,
// for the same flat-copy reason TICKET_FILTERS and the digest grammar are
// duplicated. The comment in both files says "change both together", and the
// next person to touch one will not read the other — so this runs BOTH over the
// SAME ticket registry and demands the same answer.
//
// It compares CONTENT, not bytes, and that is deliberate rather than a
// weakening: the two tails name the query in their own caller's vocabulary
// (intent syntax there, payload syntax here) and the head differs likewise.
// Byte equality would therefore fail today, on correct code, which would make
// the pin worthless. What must never differ is WHICH tickets appear, in WHICH
// section, in what order, and the counts.
//
// WHAT THIS DOES NOT CLAIM. Parity is over the two RENDERINGS. It is not a
// claim that an agent sees either of them: the exec dispatcher delivers only
// the LAST stderr line, then slices it to 200 chars, so `{"action":"tickets"}`
// returns the tail and nothing more. True since t80, measured under t100's
// rework. The tests below therefore pin that the two functions agree — a real
// property, since the intent path renders in full — and deliberately not that
// the exec surface delivers a board.
//
// The last-line rule is pinned by the test named
//   _handleExecIntent: replyStderr:true → clean exit + stderr injects the tail back
// in test/session-manager.test.js. THE 200-CHAR SLICE IS PINNED BY NOTHING: that
// test's stderr is far under the limit and nothing in the suite feeds the
// dispatcher a line long enough to cut. Half this sentence is guarded and half
// is not, so it says which half.
//
// Cited by NAME, not by line — a line range here survived exactly one commit
// before it pointed at unrelated code (t105).

// Reduce a rendering to the facts both implementations must agree on: the
// ticket rows, the section header that separates them, and the tail's numbers.
// Everything vocabulary-specific is dropped ON PURPOSE — see above.
function listingFacts(text) {
  const facts = [];
  for (const line of text.split('\n')) {
    if (/^recently closed:$/.test(line)) { facts.push('SECTION'); continue; }
    const row = line.match(/^(t\d+) \[(\w+)\] (\S+) (closed )?(\S+)( ago)? — (.*)$/);
    if (row) { facts.push(`${row[1]}|${row[2]}|${row[3]}|${row[4] ? 'closed' : 'open-age'}|${row[7]}`); continue; }
    // The window is CAPTURED, not just matched past. Matching `\d+h` and
    // discarding it made a leaf at 20h and an intent at 24h reduce to identical
    // facts, so parity stayed green over two boards that were not the same.
    const tail = line.match(/\((?:\+(\d+) more done in the last (\d+h); )?(\d+) done, (\d+) cancelled/);
    if (tail) {
      facts.push(`TAIL|over=${tail[1] || 0}|window=${tail[2] || '-'}|done=${tail[3]}|cancelled=${tail[4]}`);
      continue;
    }
    if (/no open tickets/.test(line)) { facts.push('NO-OPEN'); continue; }
    // Lines dropped ON PURPOSE, because the two implementations are REQUIRED to
    // differ here: the head names the team in each caller's own phrasing, and
    // the stale notice has no counterpart on the intent path at all.
    // Heads: `team <name> tickets[ [filter]]:` (leaf) and
    // `tickets on <name>[ [filter]]:` (intent). Both named explicitly rather
    // than by a loose /tickets/ match, so a head that changes SHAPE surfaces as
    // OTHER instead of being swallowed by a pattern that was too generous.
    if (/^team \S+ tickets( \[\w+\])?:$/.test(line)) continue;
    if (/^tickets on \S+( \[\w+\])?:$/.test(line)) continue;
    // The no-open sentences and the zero-ticket ones are DIFFERENT branches:
    // `no open tickets` above is the board-has-closed-work case, while these
    // are "this team has no tickets at all". Named separately so an
    // implementation taking the wrong branch surfaces instead of matching a
    // pattern broad enough to cover both.
    if (/^team \S+: no \w+ tickets$/.test(line)) continue;   // leaf, no-open / none
    if (/^no \w+ tickets on \S+$/.test(line)) continue;      // intent, same
    if (/^team \S+: no tickets$/.test(line)) continue;       // leaf, empty registry
    if (/^no tickets on \S+$/.test(line)) continue;          // intent, same
    if (/^\(STALE HOST|^\(HOST /.test(line)) continue;
    // A blank line is NOT dropped silently: both implementations build one
    // string with no blank separators, so a blank means someone introduced a
    // separator on one side only. The sole exception is the trailing newline
    // every reply ends with, which split() yields as a final empty element.
    if (line === '') { facts.push('BLANK'); continue; }
    // Anything else is surfaced rather than swallowed. A reducer that silently
    // ignores what it does not recognize cannot see an EXTRA line in one
    // implementation — it would compare equal while the two rendered
    // differently, which is the exact drift these tests exist to catch.
    facts.push(`OTHER|${line}`);
  }
  return facts;
}

function mkTicketRegistry(home, teamName, tickets) {
  fs.writeFileSync(path.join(home, 'teams', teamName, 'tickets.json'), JSON.stringify(tickets));
}

// The intent-path rendering of the same registry, driven directly: _taskList
// reads nothing off `session` and takes teamDir as an argument, so it needs no
// PTY and no team resolution.
function intentListing(teamDir, teamName, filter) {
  const SM = createSessionManager({ fs, path });
  let out = '';
  new SM()._taskList({ name: 'lead' }, { name: teamName, lead: 'lead' }, teamDir,
    { filter }, (s) => { out = s; });
  return out;
}

const HOUR = 60 * 60 * 1000;

// A board built to exercise every branch the two must agree on at once: an
// open ticket, closes inside and outside the 24h window, a cancellation of the
// same age as a recent done (so age cannot explain its exclusion), and more
// recent closes than the cap.
function parityBoard() {
  const now = Date.now();
  const rows = [
    { id: 't1', title: 'still going', assignee: 'hand', state: 'open', openedAt: now - 40 * HOUR, closedAt: null },
    { id: 't2', title: 'old close', assignee: 'hand', state: 'done', openedAt: now - 40 * HOUR, closedAt: now - 30 * HOUR },
    { id: 't3', title: 'dropped', assignee: 'hand', state: 'cancelled', openedAt: now - 40 * HOUR, closedAt: now - 2 * HOUR },
  ];
  for (let i = 0; i < 12; i++) {
    rows.push({
      id: `t${i + 4}`, title: `recent ${i}`, assignee: 'hand', state: 'done',
      openedAt: now - 40 * HOUR, closedAt: now - (i + 1) * HOUR,
    });
  }
  return rows;
}

test('listing parity: the two implementations RENDER the same board (t100 — not what an exec caller receives)', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {}, hand: {} } });
  reg(home, 'alead', proj);
  const rows = parityBoard();
  mkTicketRegistry(home, 'proj', rows);
  const teamDir = path.join(home, 'teams', 'proj');

  const r = await launch(home, { action: 'tickets', agent: 'alead' });
  assert.strictEqual(r.code, 0, `tickets exits 0: ${r.err}`);
  const theirs = listingFacts(r.err);
  const mine = listingFacts(intentListing(teamDir, 'proj', null));

  // ENTER: the fixture must actually reach the interesting branches, or this
  // test would pass on two implementations that both render nothing.
  assert.ok(mine.includes('SECTION'), 'ENTER: the default view has a recent section');
  assert.ok(mine.some((f) => /^TAIL\|over=2\|window=\d+h\|done=13\|cancelled=1$/.test(f)),
    `ENTER: cap overflow and both counts are live in the fixture: ${mine.join(' / ')}`);
  assert.strictEqual(mine.filter((f) => /\|closed\|/.test(f)).length, 10, 'ENTER: the cap is in play');

  assert.deepStrictEqual(theirs, mine,
    'the two listing implementations drifted — the exec pull and [agent:task list] now disagree about the board');
});

// The duplicated constants, compared at source. The behavioural parity tests
// cannot see a window divergence: parityBoard's closes sit at 1-12h and 30h, so
// ANY leaf window in roughly [13h, 29h] renders byte-identically. The cap is
// different — F1 caught a cap divergence, because the fixture straddles it.
// This is the scrape-and-compare idiom already used for the digest grammar and
// for TICKET_FILTERS.
test('listing parity: the duplicated window and cap constants agree at source', () => {
  const scrape = (file, name) => {
    const src = fs.readFileSync(file, 'utf-8');
    const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(m, `ENTER: found ${name} in ${path.basename(file)}`);
    return Function(`return (${m[1]})`)();
  };
  const CORE = path.join(__dirname, '..', 'session-manager.js');
  for (const name of ['RECENT_DONE_MS', 'RECENT_DONE_CAP']) {
    const core = scrape(CORE, name);
    assert.ok(core > 0, `ENTER: ${name} scraped to a real value (${core})`);
    assert.strictEqual(scrape(SCRIPT, name), core,
      `${name} drifted between the two implementations — they would render different boards from the same registry`);
  }
});

test('listing parity: holds on each explicit filter too', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {} } });
  reg(home, 'alead', proj);
  mkTicketRegistry(home, 'proj', parityBoard());
  const teamDir = path.join(home, 'teams', 'proj');

  for (const filter of ['done', 'cancelled', 'all']) {
    const r = await launch(home, { action: 'tickets', agent: 'alead', filter });
    assert.strictEqual(r.code, 0, `${filter}: exits 0: ${r.err}`);
    const mine = listingFacts(intentListing(teamDir, 'proj', filter));
    assert.ok(mine.length, `ENTER: ${filter} renders something`);
    // The chosen-slice rule is half of what parity means here: neither side may
    // grow a recent section or a count tail on an explicit filter.
    assert.ok(!mine.includes('SECTION'), `${filter}: no section on the intent path`);
    assert.ok(!mine.some((f) => f.startsWith('TAIL')), `${filter}: no count tail on the intent path`);
    assert.deepStrictEqual(listingFacts(r.err), mine, `${filter}: the two implementations disagree`);
  }
});

// The exec dispatcher delivers only the LAST stderr line, so whatever ends this
// string is the whole reply. Appending the stale notice after the tail meant a
// stale host cost the caller the counts — the one thing the listing still
// delivers over exec. Ordering is therefore a delivery property, not cosmetics.
test('tickets: the stale-host notice does not displace the tail as the delivered line', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {} } });
  reg(home, 'alead', proj);
  const now = Date.now();
  mkTicketRegistry(home, 'proj', [
    { id: 't1', title: 'open one', assignee: 'hand', state: 'open', openedAt: now - 40 * HOUR, closedAt: null },
    { id: 't2', title: 'shipped', assignee: 'hand', state: 'done', openedAt: now - 40 * HOUR, closedAt: now - HOUR },
  ]);
  // A stamp whose digest cannot match the tree it names — the proven-stale path.
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(home, 'run', '.host.json'), JSON.stringify({
    pid: 999, bootedAt: now - 7_200_000,
    dir: path.join(__dirname, '..'), digest: 'stale-digest-from-boot',
  }));

  const r = await launch(home, { action: 'tickets', agent: 'alead' });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.err, /STALE HOST/, 'ENTER: the fixture really is on the stale path');

  // Reproduce the dispatcher's discipline exactly.
  const delivered = (r.err.trim().split('\n').pop() || '').slice(0, 200);
  assert.match(delivered, /1 done, 0 cancelled/,
    'the counts survive as the delivered line — they are all an exec caller gets');
  assert.ok(!/STALE HOST/.test(delivered),
    'and the notice is the line that yields, since one line cannot carry both');
});

test('listing parity: holds on a board with nothing open', async () => {
  const home = mkHome();
  const proj = path.join(home, 'proj');
  mkTeam(home, 'proj', proj, { lead: 'lead', roles: { lead: {} } });
  reg(home, 'alead', proj);
  // The no-open branch is a SEPARATE reply path in both files — the one place
  // the two could most easily drift, since each writes its own sentence there.
  const now = Date.now();
  mkTicketRegistry(home, 'proj', [
    { id: 't1', title: 'shipped', assignee: 'hand', state: 'done', openedAt: now - 40 * HOUR, closedAt: now - HOUR },
    { id: 't2', title: 'dropped', assignee: 'hand', state: 'cancelled', openedAt: now - 40 * HOUR, closedAt: now - HOUR },
  ]);
  const mine = listingFacts(intentListing(path.join(home, 'teams', 'proj'), 'proj', null));
  assert.ok(mine.includes('NO-OPEN'), 'ENTER: the no-open branch is the one under test');
  assert.ok(mine.includes('SECTION'), 'ENTER: and it still carries the recent section');
  const r = await launch(home, { action: 'tickets', agent: 'alead' });
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(listingFacts(r.err), mine, 'the no-open reply paths drifted');
});

// The exec-def gates payloads BEFORE they reach the script; pin that the
// SHIPPED schema accepts exactly what clodex-team.js handles and rejects the
// rest, via the real exec-schema validator.
//
// This block reads resources/library/exec/clodex-team.json, so the schema under
// test is the one that will actually gate a live payload. Do not reintroduce a
// fixture copy here: the copy is what silently went stale (t101).

// ENTER CHECK. Every assertion below is only worth its salt if EXEC_DEF is the
// shipped def rather than a copy of it, so this pins PATH IDENTITY: the file
// read at module scope must be the seed root stores.js seedLibraryDefaults
// copies into the operator's library, addressed the same way — by relative path
// from the repo.
//
// Identity is the only property no copy can satisfy. Every content property
// can: a fresh `cp` carries the ${CLODEX_BIN} placeholder verbatim, and any
// value-level assertion is satisfied by a copy that is correct today and stale
// tomorrow — which is precisely the failure t101 exists to close. An earlier
// version of this test asserted the placeholder and the absence of ONE exact
// filename; a copy at clodex-team.exec.v2.json satisfies both.
test('exec-def source: the schema tests read the SHIPPED def itself, not a copy of it', () => {
  const rel = path.relative(path.join(__dirname, '..'), EXEC_DEF_PATH);
  assert.strictEqual(rel, path.join('resources', 'library', 'exec', 'clodex-team.json'),
    'the def under test IS the seeded artifact — no copy, anywhere, under any name, can satisfy this');
});

test('exec-def schema accepts valid payloads via real parseAndValidate', () => {
  for (const payload of [
    { action: 'roster', agent: 'clodex' },
    { action: 'retire', agent: 'clodex', target: 'clodex-hand' },
    { action: 'roster', agent: 'ghost', cwd: '/some/project' }, // payload-cwd fallback
    // t101: `tickets` and `filter` are what the stale copy could not accept.
    // The rest of this file spends 300 lines exercising the verb the schema
    // under test would have rejected.
    { action: 'tickets', agent: 'clodex' },
  ]) {
    const r = parseAndValidate(EXEC_DEF, JSON.stringify(payload));
    assert.strictEqual(r.ok, true, `should accept ${JSON.stringify(payload)}: ${r.error}`);
    assert.strictEqual(r.value.action, payload.action);
  }
});

// The seed's enums are the schema's half of a contract whose other half lives
// in the script. Both halves are SCRAPED from the script rather than written as
// literals here, so adding a verb or a filter in one place and forgetting the
// other fails at this test instead of at an agent's payload.
//
// Each is pinned by set equality, not by sampling. "Accepts every X and no
// other" is a claim in BOTH directions, and a loop of hand-picked negatives
// only ever tests the values someone thought of: widen the seed with `blocked`
// and a negative list of `rejected`/`OPEN`/`''` stays green while the gate
// admits a payload the script dies on. deepStrictEqual over sorted sets makes
// the title true; the negative loops below it survive as intent documentation
// of WHICH wrong values were expected and why.
const scrapeList = (src, name) => {
  const decl = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(decl, `ENTER: found ${name} in the script`);
  return decl[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
};
const enumOf = (prop) => {
  const spec = EXEC_DEF.schema.properties[prop];
  assert.ok(spec && Array.isArray(spec.enum), `ENTER: the seed constrains "${prop}" by enum`);
  return spec.enum;
};

test('exec-def schema accepts every filter the script implements, and no other', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const filters = scrapeList(src, 'TICKET_FILTERS');
  assert.deepStrictEqual(filters, ['open', 'done', 'cancelled', 'all'], 'ENTER: the four real filters');

  // The both-directions pin. Sorted, because agreement is about the SET; the
  // order a literal happens to be written in is not part of the contract.
  assert.deepStrictEqual(enumOf('filter').slice().sort(), filters.slice().sort(),
    'the seed\'s filter enum and the script\'s TICKET_FILTERS disagree — one side would accept or refuse a filter the other does not');

  for (const filter of filters) {
    const r = parseAndValidate(EXEC_DEF, JSON.stringify({ action: 'tickets', agent: 'clodex', filter }));
    assert.strictEqual(r.ok, true, `should accept filter "${filter}": ${r.error}`);
    assert.strictEqual(r.value.filter, filter);
  }
  // `rejected` is the likeliest typo (reject is a verb) and is deliberately not
  // a state — the script bounces it, and so must the gate in front of it.
  for (const filter of ['rejected', 'OPEN', '']) {
    const r = parseAndValidate(EXEC_DEF, JSON.stringify({ action: 'tickets', agent: 'clodex', filter }));
    assert.strictEqual(r.ok, false, `should reject filter "${filter}"`);
  }
});

// The ACTION half, which the first pass left as a hardcoded list while deriving
// the filter half — the same asymmetry one level up: add a verb to the script's
// dispatch, forget the seed, and nothing failed. The script has no ACTIONS
// constant, so the verbs are scraped from the dispatch chain itself, which is
// the thing that actually decides what is handled.
test('exec-def schema accepts every action the script dispatches, and no other', () => {
  const src = fs.readFileSync(SCRIPT, 'utf-8');
  const actions = [...src.matchAll(/if \(action === '(\w+)'\) return do\w+\(payload\);/g)].map((m) => m[1]);
  assert.deepStrictEqual(actions.slice().sort(), ['retire', 'roster', 'tickets'],
    'ENTER: scraped the three dispatched verbs from the main() chain');

  assert.deepStrictEqual(enumOf('action').slice().sort(), actions.slice().sort(),
    'the seed\'s action enum and the script\'s dispatch disagree — a verb is gated out, or gated in with nothing behind it');
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
