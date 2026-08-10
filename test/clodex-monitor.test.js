'use strict';

// clodex-monitor.js ↔ resources/library/exec/clodex-monitor.json: the payload
// contract between the exec gate and the script behind it (docs/exec-tools.md).
//
// The def gates payloads BEFORE they reach the script, so the two are halves of
// one contract: a verb the script dispatches but the enum omits is unreachable,
// and a verb the enum admits with nothing behind it dies at `unknown action`
// after the agent has already spent a turn. Nothing pinned either half until
// this file — exec-scripts-materialize.test.js reads this def only for its argv
// placeholder.
//
// Shaped after test/clodex-team.test.js's exec-def block (t101): read the
// SHIPPED def, validate through the REAL parseAndValidate, and compare SCRAPED
// sets rather than sampling hand-picked negatives.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseAndValidate } = require('../exec-schema');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'clodex-monitor.js');
// The SHIPPED def, not a copy of it (t101).
const EXEC_DEF_PATH = path.join(__dirname, '..', 'resources', 'library', 'exec', 'clodex-monitor.json');
const EXEC_DEF = JSON.parse(fs.readFileSync(EXEC_DEF_PATH, 'utf-8'));
const SRC = fs.readFileSync(SCRIPT, 'utf-8');

const ok = (payload) => parseAndValidate(EXEC_DEF, JSON.stringify(payload));

// ENTER CHECK. Every assertion in this file is only worth its salt if EXEC_DEF
// is the shipped def rather than a copy of it, so this pins PATH IDENTITY: the
// file read at module scope must be the seed root stores.js seedLibraryDefaults
// copies into the operator's library, addressed the same way — by relative path
// from the repo.
//
// Identity is the only property no copy can satisfy. Every content property
// can: a fresh `cp` is correct today and stale tomorrow, and each value-level
// assertion below stays green against it while the artifact that actually gates
// live payloads drifts away. That is the failure t101 exists to close.
test('exec-def source: these tests read the SHIPPED monitor def, not a copy of it', () => {
  const rel = path.relative(path.join(__dirname, '..'), EXEC_DEF_PATH);
  assert.strictEqual(rel, path.join('resources', 'library', 'exec', 'clodex-monitor.json'),
    'the def under test IS the seeded artifact — no copy, anywhere, under any name, can satisfy this');
});

test('exec-def schema accepts the payloads the script handles, via real parseAndValidate', () => {
  for (const payload of [
    { action: 'list', agent: 'clodex-hand' },
    { action: 'stop', agent: 'clodex-hand', id: 'm7' },
    { action: 'start', agent: 'clodex-hand', command: 'npm test' },
    { action: 'start', agent: 'clodex-hand', ws: { url: 'wss://example/feed' } },
    { action: 'start', agent: 'clodex-hand', ws: { url: 'wss://example/feed', protocols: 'a,b' } },
    { action: 'start', agent: 'clodex-hand', command: 'tail -f log', wake: true, persistent: true, description: 'log tail', timeout_ms: 600000 },
  ]) {
    const r = ok(payload);
    assert.strictEqual(r.ok, true, `should accept ${JSON.stringify(payload)}: ${r.error}`);
    assert.strictEqual(r.value.action, payload.action);
  }
});

// The ACTION half. The script has no ACTIONS constant, so the verbs are scraped
// from the dispatch chain itself — the thing that actually decides what is
// handled — and cross-checked against the set the `unknown action` die names,
// which is what an agent reads when it guesses wrong. Three sources, one set:
// add a verb to the dispatch and forget either the enum or the die, and this
// fails here instead of at a live payload.
test('exec-def schema accepts every action the script dispatches, and no other', () => {
  const dispatched = [...SRC.matchAll(/if \(action === '(\w+)'\) \{/g)].map((m) => m[1]);
  // ENTER: a regex that stops matching scrapes an EMPTY set, and set equality
  // against an empty scrape passes while pinning nothing at all.
  assert.deepStrictEqual(dispatched.slice().sort(), ['list', 'start', 'stop'],
    'ENTER: scraped the three dispatched verbs from runLauncher()');

  const die = SRC.match(/unknown action "\$\{action\}" \(([a-z|]+)\)/);
  assert.ok(die, 'ENTER: found the unknown-action die that names the set for the agent');
  const named = die[1].split('|');

  const spec = EXEC_DEF.schema.properties.action;
  assert.ok(spec && Array.isArray(spec.enum), 'ENTER: the def constrains "action" by enum');

  assert.deepStrictEqual(spec.enum.slice().sort(), dispatched.slice().sort(),
    "the def's action enum and the script's dispatch disagree — a verb is gated out, or gated in with nothing behind it");
  assert.deepStrictEqual(named.slice().sort(), dispatched.slice().sort(),
    'the die names a different set than the script dispatches — the error message misdirects the agent that hit it');

  for (const action of dispatched) {
    const r = ok({ action, agent: 'a', id: 'x', command: 'c' });
    assert.strictEqual(r.ok, true, `should accept action "${action}": ${r.error}`);
  }
});

test('exec-def schema rejects payloads the script would refuse', () => {
  for (const [payload, why] of [
    [{ action: 'restart', agent: 'a' }, 'action not in enum'],
    [{ action: 'START', agent: 'a' }, 'enum is case-sensitive; the script compares exactly'],
    [{ agent: 'a' }, 'missing required action'],
    // The script checks agent BEFORE dispatching, so this bounces on both
    // sides; the gate is what saves the turn.
    [{ action: 'list' }, 'missing required agent'],
    [{ action: 'list', agent: 'a', bogus: 1 }, 'additionalProperties'],
    [{ action: 'start', agent: 'a', ws: { url: 'wss://x', bogus: 1 } }, 'additionalProperties inside ws'],
    [{ action: 'start', agent: 'a', ws: {} }, 'ws without its required url'],
    [{ action: 'start', agent: 'a', ws: 'wss://x' }, 'ws must be an object'],
    [{ action: 'list', agent: 1 }, 'agent must be a string'],
    [{ action: 'start', agent: 'a', wake: 'yes' }, 'wake must be a boolean'],
    [{ action: 'start', agent: 'a', persistent: 1 }, 'persistent must be a boolean'],
    [{ action: 'start', agent: 'a', command: 'c', timeout_ms: 999 }, 'below the minimum'],
    [{ action: 'start', agent: 'a', command: 'c', timeout_ms: 3600001 }, 'above the maximum'],
    [{ action: 'start', agent: 'a', command: 'c', timeout_ms: '60000' }, 'timeout_ms must be a number'],
  ]) {
    const r = parseAndValidate(EXEC_DEF, JSON.stringify(payload));
    assert.strictEqual(r.ok, false, `should reject (${why}): ${JSON.stringify(payload)}`);
  }
});

// The bounds are a pair, and a test that only probes outside them passes against
// a schema that rejects EVERYTHING. Both edges are inclusive on the validator's
// `minimum`/`maximum`, which is what makes the rejections above one step away.
test('exec-def schema admits timeout_ms at both its bounds', () => {
  const spec = EXEC_DEF.schema.properties.timeout_ms;
  assert.deepStrictEqual(spec, { type: 'number', minimum: 1000, maximum: 3600000 },
    'ENTER: the whole timeout_ms spec, so a dropped bound cannot hide behind a passing probe');
  for (const timeout_ms of [spec.minimum, spec.maximum]) {
    const r = ok({ action: 'start', agent: 'a', command: 'c', timeout_ms });
    assert.strictEqual(r.ok, true, `should accept timeout_ms ${timeout_ms}: ${r.error}`);
  }
});

// ws.protocols is a comma-separated STRING because the exec validator has no
// array type. Both halves of that encoding are pinned here: an innocent-looking
// "fix" to `type: array` in the def would pass the gate and then hit the
// script's `typeof === 'string'` branch, which silently drops it to undefined —
// a subprotocol list that vanishes rather than errors.
test('exec-def encodes ws.protocols as a comma-separated string, and the script splits it', () => {
  assert.deepStrictEqual(EXEC_DEF.schema.properties.ws.properties.protocols,
    { type: 'string', maxLength: 400 },
    'the whole protocols spec — the string type is the deliberate encoding, not an oversight');
  assert.match(SRC, /typeof p\.ws\.protocols === 'string'/,
    'the script reads protocols as a string; the def must not promise it an array');
  assert.match(SRC, /p\.ws\.protocols\.split\(','\)/,
    "and splits it on commas — that is what makes the string encoding lossless");

  const arr = ok({ action: 'start', agent: 'a', ws: { url: 'wss://x', protocols: ['a', 'b'] } });
  assert.strictEqual(arr.ok, false, 'an array must be refused at the gate, not dropped in the script');
});

// The division of labour, pinned deliberately rather than asserted as a gate
// that does not exist. exec-schema.js implements a small subset — type,
// required, additionalProperties, enum, minimum/maximum, maxLength — with no
// oneOf/anyOf/not/if-then and no conditional required. So `start`'s
// command-XOR-ws rule and `stop`'s need for an id are NOT expressible in the
// def, and the script's own die() is their only enforcement.
//
// This test exists to keep that fact true and visible: if the validator ever
// grows the vocabulary and the def starts gating these, the accepts below flip
// and this fails — which is the moment to move the rule forward, not a
// regression.
test('exec-def cannot express start XOR or stop-needs-id — the script is their only enforcement', () => {
  for (const [payload, why] of [
    [{ action: 'start', agent: 'a' }, 'neither command nor ws'],
    [{ action: 'start', agent: 'a', command: 'c', ws: { url: 'wss://x' } }, 'both command and ws'],
    [{ action: 'stop', agent: 'a' }, 'stop without an id'],
  ]) {
    const r = ok(payload);
    assert.strictEqual(r.ok, true,
      `the gate passes this through today (${why}) — if it now rejects, the rule moved into the def `
      + 'and this test should move with it');
  }
  // …and the script refuses each one, so nothing reaches the daemon spawn.
  assert.match(SRC, /if \(!hasCmd && !hasWs\) die\('start needs a command or a ws:\{url\}'\)/,
    'the script must refuse a start with neither, since the gate does not');
  assert.match(SRC, /if \(hasCmd && hasWs\) die\('start takes command OR ws, not both'\)/,
    'and refuse a start with both — silently preferring one would spawn a watcher on the wrong source');
  assert.match(SRC, /if \(!p\.id\) die\('stop needs an id'\)/,
    'and refuse a stop with no id, since `required` is a flat list and adding id there breaks list/start');
});

// TRAVERSAL. `agent` and `id` are both joined into paths (monitors/<agent>/,
// <id>.json, <id>.log) and cleanupState UNLINKS what they resolve to, so a
// payload that gets a `..` through chooses where this tool writes and deletes.
// The schema's maxLength constrains length, never characters — so the script's
// own guard is the enforcement, and it must hold when the script is run
// standalone as well as through the dispatcher.
const cpMon = require('child_process');
const launchMon = (home, payload) => new Promise((resolve) => {
  const ch = cpMon.spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, CLODEX_HOME: home },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let err = '';
  ch.stderr.on('data', (d) => { err += d.toString(); });
  ch.on('exit', (code) => resolve({ code, err: err.trim() }));
  ch.stdin.end(JSON.stringify(payload));
});

test('launcher refuses a traversing agent or id before touching the filesystem', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-mon-'));
  // A file OUTSIDE the monitors tree that a traversal would reach. `list`
  // cleans up dead monitors, so it unlinks on the path it is handed.
  const outside = path.join(home, 'precious.json');
  fs.writeFileSync(outside, JSON.stringify({ pid: 999999 }));
  fs.mkdirSync(path.join(home, 'monitors', 'x'), { recursive: true });

  // Each row asserts the GUARD's own message, not just a nonzero exit. Several
  // of these exit 1 on the unguarded script too — via a downstream ENOENT after
  // the bad path was already built — so an exit-code-only assertion would pass
  // against the defect it exists to pin.
  const AGENT_DIE = /agent \(your own name\) is required/;
  const ID_DIE = /id must be a plain monitor id/;
  for (const [payload, expected, why] of [
    [{ action: 'list', agent: '../..' }, AGENT_DIE, 'agent escapes the monitors dir'],
    [{ action: 'list', agent: 'a/../../b' }, AGENT_DIE, 'agent carries a path separator'],
    [{ action: 'list', agent: '.' }, AGENT_DIE, 'a dot-only agent resolves to the parent dir'],
    [{ action: 'list', agent: 5 }, AGENT_DIE, 'a non-string agent coerces through .test()'],
    [{ action: 'stop', agent: 'x', id: '../../precious' }, ID_DIE, 'id escapes and cleanupState unlinks'],
    [{ action: 'stop', agent: 'x', id: '.' }, ID_DIE, 'a dot-only id'],
    [{ action: 'stop', agent: 'x', id: 7 }, ID_DIE, 'a non-string id'],
  ]) {
    const r = await launchMon(home, payload);
    assert.strictEqual(r.code, 1, `must refuse: ${why} — got exit ${r.code} (${r.err})`);
    assert.match(r.err, expected,
      `refusal must come from the guard, not a downstream ENOENT: ${why}`);
  }
  assert.strictEqual(fs.existsSync(outside), true, 'nothing outside the monitors tree was unlinked');

  // ENTER: the guard is not simply refusing everything — the legitimate shapes
  // still pass it. A seat may be named `.hidden` (the session-name rule admits a
  // leading dot), which is exactly why `agent` is NOT typed `filename`.
  for (const agent of ['clodex-hand', '.hidden', 'a.b_c-d']) {
    const r = await launchMon(home, { action: 'list', agent });
    assert.strictEqual(r.code, 0, `must accept the legitimate name ${agent}: ${r.err}`);
  }
});

test('the traversal guard is DECLARED for id and hand-written for agent, deliberately', () => {
  // `id` is a plain token with no session-name exception, so it rides the
  // declarative `filename` type — the whole point of that type existing.
  assert.deepStrictEqual(EXEC_DEF.schema.properties.id, { type: 'filename' },
    'id must be gated by the schema, not only by the script');
  // `agent` cannot: `filename` rejects a leading dot and `.hidden` is a legal
  // session name, so typing it filename would lock that seat out of the tool.
  assert.strictEqual(EXEC_DEF.schema.properties.agent.type, 'string');
  assert.match(SRC, /\/\^\(\?!\\\.\+\$\)\[a-zA-Z0-9\._-\]\{1,64\}\$\/\.test\(agent\)/,
    'the script carries the session-name literal for agent — the only guard that field gets');
});

// The def's own envelope, asserted whole. These four are read by the dispatcher
// rather than by the schema walker, so a value-level test of the properties
// above would not notice any of them changing.
test('exec-def envelope: the dispatcher-level fields the schema walker never sees', () => {
  const { argv, timeoutMs, maxBytes, replyStderr } = EXEC_DEF;
  assert.deepStrictEqual({ argv, timeoutMs, maxBytes, replyStderr }, {
    argv: ['/usr/bin/env', 'node', '${CLODEX_BIN}/clodex-monitor.js'],
    timeoutMs: 15000,
    maxBytes: 8192,
    replyStderr: true,
  }, 'the launcher exits immediately and the watcher is detached, so this timeout gates the LAUNCH only; '
    + 'replyStderr is how die()/say() reach the agent at all');
});
