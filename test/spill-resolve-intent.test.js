'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { writeSpill, spillPathFor, pointerOf } = require('../intent-spill');
const { shadowIntentKey, parseIntent, looksLikeIntent } = require('../intent-scanner');
const { IntentDeduper } = require('../wire-intents');
const { SpillFilter } = require('../wire/spill');

const BIG = `spec line one\n${'z'.repeat(1200)}\nlast line`;

function mkH(overrides = {}) {
  const root = mkTmpRoot('clodex-spill-');
  const injected = [];
  const broadcasts = [];
  const errors = [];
  const notes = [];
  const tasks = [];
  const contexts = [];
  const dms = [];
  const reminds = [];
  const inbox = [];
  const entry = overrides.entry === undefined ? null : overrides.entry;
  delete overrides.entry;

  const m = mk({
    REGISTRY_DIR: root,
    MSG_DIR: path.join(root, 'messages'),
    PENDING_DIR: path.join(root, 'pending'),
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    getPersistence: () => ({ list: () => [], get: () => entry }),
    getNotifications: () => ({ add: (rec) => { inbox.push(rec); return { id: `n${inbox.length}`, ...rec }; } }),
    MSG_MAX_AGE: 1800,
    parseIntent,
    looksLikeIntent,
    execBodyCap: 64 * 1024,
    log: {
      info: () => {}, debug: () => {}, warn: () => {},
      error: (...a) => errors.push(a.join(' ')),
    },
    ...overrides,
  });
  m._injectText = (s, text, opts) => injected.push({ text, opts: opts || null });
  m._broadcast = (ch, msg) => broadcasts.push(msg);
  m._raiseNote = (from, body) => notes.push({ from, body });
  m._handleTask = (s, intent) => tasks.push(intent);
  m._handleContextIntent = (s, sub, body) => contexts.push({ sub, body });
  m._handleRemindIntent = (s, spec, body) => reminds.push({ spec, body });
  m._gatedDeliver = (to, from, body) => {
    dms.push({ to, from, body });
    return { parked: false, held: false, superseded: null };
  };
  m.sessions.set('lead', { name: 'lead', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('bob', { name: 'bob', agentType: 'claude', workspaceId: 'ws1' });
  return { m, root, injected, broadcasts, errors, notes, tasks, contexts, dms, reminds, inbox };
}

test('the REAL _handleIntent substitutes a whole-body pointer before dispatch, which is the only reason every dispatch path gets it', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  assert.ok(id, 'ENTER: the fixture must have written a spill file');

  await h.m._handleIntent('lead', { type: 'task', sub: 'add', body: `@spill:${id}` });

  assert.strictEqual(h.tasks.length, 1, 'the ticket still dispatched');
  assert.strictEqual(h.tasks[0].body, BIG,
    'and it carries the FILE body — wire, jsonl, recovery replay and the PTY scan all funnel through '
    + 'this one method, so a resolver anywhere else leaves three of the four carrying a 23-byte pointer');
  assert.deepStrictEqual(h.tasks[0].spill, { id, path: spillPathFor(h.root, 'lead', id) },
    'the provenance rides the intent so a consumer can say where the body came from');
});

test('a TITLED pointer resolves, and the title is discarded — the file is authoritative', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);

  await h.m._handleIntent('lead', {
    type: 'task', sub: 'add', body: `a title that does NOT match the file @spill:${id}`,
  });

  assert.strictEqual(h.tasks.length, 1);
  assert.strictEqual(h.tasks[0].body, BIG,
    'the transcript title is display only, so an edited or stale one cannot change one byte of the spec');
  assert.deepStrictEqual(h.tasks[0].spill, { id, path: spillPathFor(h.root, 'lead', id) });
});

test('a title over 80 chars is NOT a pointer, so a spec that happens to end in one is dispatched whole', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  const body = `${'t'.repeat(81)} @spill:${id}`;

  await h.m._handleIntent('lead', { type: 'task', sub: 'add', body });

  assert.strictEqual(h.tasks[0].body, body,
    'the tee never emits a title this long, so a line that carries one is prose the resolver must not eat');
  assert.deepStrictEqual(h.errors, []);
});

test('a pointer that is not the tail of a ONE-line body is prose, titled or not', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  for (const body of [`title @spill:${id}\nand more`, `first line\ntitle @spill:${id}`,
    `title @spill:${id} trailing`, `title  @spill:${id}`]) {
    h.tasks.length = 0;
    await h.m._handleIntent('lead', { type: 'task', sub: 'add', body });
    assert.strictEqual(h.tasks[0].body, body, `not a pointer line: ${JSON.stringify(body)}`);
  }
});

test('shout is a spill verb: the operator inbox gets the FILE body, never the pointer', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);

  await h.m._handleIntent('lead', {
    type: 'shout', body: `spec line one @spill:${id}`,
  });

  assert.deepStrictEqual(h.inbox.map((r) => r.body), [BIG],
    'an operator reads the note in the inbox, so a 23-byte pointer there is a note with no content');
  assert.strictEqual(h.inbox[0].from, 'lead');
  assert.deepStrictEqual(h.notes.map((n) => n.body), [BIG], 'and the OS notification previews the real text');
  assert.deepStrictEqual(h.injected, [],
    'nothing bounced back at the seat: the body was there, it just arrived as a pointer');
});

test('every spill verb resolves: task add/respec/reject/done, dm, shout; a context handoff is not one, so a pointer there is refused as typed', async () => {
  for (const [type, sub] of [['task', 'add'], ['task', 'respec'], ['task', 'reject'], ['task', 'done']]) {
    const h = mkH();
    const id = writeSpill(h.root, 'lead', BIG);
    await h.m._handleIntent('lead', { type, sub, body: `@spill:${id}` });
    assert.strictEqual(h.tasks.length, 1, `${type} ${sub} dispatched`);
    assert.strictEqual(h.tasks[0].body, BIG, `${type} ${sub} resolved`);
  }
  for (const sub of ['compact', 'clear', 'reload']) {
    const h = mkH();
    const id = writeSpill(h.root, 'lead', BIG);
    await h.m._handleIntent('lead', { type: 'context', sub, body: `@spill:${id}` });
    assert.deepStrictEqual(h.contexts, [],
      `context ${sub} is not a spill verb: the tee never files its body, so a pointer there can only have been typed`);
    assert.strictEqual(h.injected.length, 1);
    assert.ok(h.injected[0].text.startsWith(`[agent] Not executed: your \`context ${sub}\` ended in a pointer (@spill:${id})`));
  }
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  await h.m._handleIntent('lead', { type: 'shout', body: `@spill:${id}` });
  assert.deepStrictEqual(h.inbox.map((r) => r.body), [BIG], 'shout resolved');

  const d = mkH();
  const did = writeSpill(d.root, 'lead', BIG);
  await d.m._handleIntent('lead', { type: 'dm', target: 'bob', body: `@spill:${did}` });
  assert.deepStrictEqual(d.dms, [{ to: 'bob', from: 'lead', body: BIG }], 'dm resolved');
});

test('memory remember is not a spill verb, so a pointer in one is never resolved — even one naming a real file is refused as typed', async () => {
  const h = mkH();
  const memos = [];
  h.m._handleMemoryIntent = (s, sub, body) => memos.push({ sub, body });
  const id = writeSpill(h.root, 'lead', BIG);
  await h.m._handleIntent('lead', { type: 'memory', sub: 'remember', body: `@spill:${id}` });
  assert.deepStrictEqual(memos, [], 'a memo the seat cannot see is a memo it did not make, and a pointer is not a memo');
  assert.strictEqual(h.injected.length, 1);
  assert.ok(h.injected[0].text.startsWith('[agent] Not executed: your `memory remember` ended in a pointer'));
});

test('a non-spill verb never resolves, which is what makes a cross-seat read inexpressible; the shape alone is refused', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  await h.m._handleIntent('lead', { type: 'remind', spec: 'in 5m', body: `@spill:${id}` });
  assert.deepStrictEqual(h.reminds, [],
    "a peer's pointer pasted into an unheld verb is not read from disk at all — the receiver copying it "
    + "into its OWN intent would resolve against the RECEIVER's directory — and the tee never files this verb, so it was typed");
  assert.strictEqual(h.injected.length, 1);
  assert.ok(h.injected[0].text.startsWith('[agent] Not executed: your `remind` ended in a pointer'));
});

const TYPED = (label, id) => `[agent] Not executed: your \`${label}\` ended in a pointer (@spill:${id}) that you typed yourself — nothing was saved, sent or filed. `
  + 'A body you did not write does not exist; emit the complete intent with the full text and [agent:end].';

test('t1062: memory remember ending in a typed pointer is NOT saved, and the bounce names the verb and what did not happen', async () => {
  const h = mkH({ shadowIntentKey });
  const memos = [];
  h.m._handleMemoryIntent = (s, sub, body) => memos.push({ sub, body });
  const rows = [];
  h.m._shadowLog = (row) => rows.push(row);
  const body = 'scope=clodex The mid-turn strip\'s cost is ONE extra read of th… @spill:e1b9f4d5c3a27b08';
  await h.m._handleIntent('lead', { type: 'memory', sub: 'remember', body });
  assert.deepStrictEqual(memos, [], 'a dangling pointer is not a fact; the store is never written');
  assert.deepStrictEqual(h.injected.map((i) => i.text), [TYPED('memory remember', 'e1b9f4d5c3a27b08')]);
  assert.deepStrictEqual(h.injected[0].opts, { parkable: true });
  assert.deepStrictEqual(rows.filter((r) => r.type === 'spill-typed').map((r) => [r.verb, r.pointer]),
    [['memory.remember', '@spill:e1b9f4d5c3a27b08']]);
  assert.ok(h.broadcasts.some((b) => b.type === 'intent' && /memory\.remember dropped: its body was a pointer/.test(b.body)));
  assert.deepStrictEqual(h.notes, []);
  assert.deepStrictEqual(h.errors, []);
});

test('t1062: a fabricated title longer than 79 chars — past what pointerOf reads as titled — is still refused on a non-spill verb', async () => {
  const h = mkH();
  const memos = [];
  h.m._handleMemoryIntent = (s, sub, body) => memos.push({ sub, body });
  const body = 'scope=clodex The mid-turn thinking strip\'s cost is ONE extra uncached read of the whole context on every turn that carries it, measured at 41k @spill:e1b9f4d5c3a27b08';
  assert.ok(body.indexOf(' @spill:') > 79, 'ENTER: the title alone overruns TITLED_POINTER_RE');
  assert.strictEqual(pointerOf(body), null, 'ENTER: pointerOf does not see it, which is why the guard reads the tail itself');
  await h.m._handleIntent('lead', { type: 'memory', sub: 'remember', body });
  assert.deepStrictEqual(memos, []);
  assert.strictEqual(h.injected.length, 1);
  assert.ok(h.injected[0].text.startsWith('[agent] Not executed: your `memory remember` ended in a pointer (@spill:e1b9f4d5c3a27b08)'));
});

test('t1062: a context compact whose handoff is a typed pointer does not run, and the bounce names `context compact`', async () => {
  const h = mkH();
  await h.m._handleIntent('lead', { type: 'context', sub: 'compact', body: '@spill:0123456789abcdef' });
  assert.deepStrictEqual(h.contexts, [], 'the compact did not happen');
  assert.deepStrictEqual(h.injected.map((i) => i.text), [TYPED('context compact', '0123456789abcdef')]);
});

test('t1062: a pointer MENTIONED mid-body is prose — the refusal is on a trailing token only', async () => {
  const h = mkH();
  const memos = [];
  h.m._handleMemoryIntent = (s, sub, body) => memos.push({ sub, body });
  const body = 'scope=clodex the tee writes one file per body; see @spill:0123456789abcdef in the log for the shape, then the ack line';
  await h.m._handleIntent('lead', { type: 'memory', sub: 'remember', body });
  assert.deepStrictEqual(memos, [{ sub: 'remember', body }], 'saved as written');
  assert.deepStrictEqual(h.injected, []);
});

test('a dm resolves BEFORE routing, so the recipient is injected the full message', async () => {
  const h = mkH({ shouldHoldDm: require('../proxy-util').shouldHoldDm });
  delete h.m._gatedDeliver;
  const bob = h.m.sessions.get('bob');
  bob.activityState = 'thinking';
  const id = writeSpill(h.root, 'lead', BIG);

  await h.m._handleIntent('lead', { type: 'dm', target: 'bob', body: `first line @spill:${id}` });

  assert.strictEqual(h.injected.length, 1, 'exactly one delivery, and no bounce');
  assert.ok(h.injected[0].text.includes(BIG),
    'the REAL delivery path carries the file body: the resolve sits above `case \'dm\'`, so '
    + `_deliverMessage never sees a pointer. Got: ${JSON.stringify(h.injected[0].text.slice(0, 120))}`);
  assert.ok(!h.injected[0].text.includes(`@spill:${id}`),
    'and no pointer survives into the recipient\'s transcript — it would resolve in the wrong dir');
});

test('a task done report resolves before the ticket handler, which is what the lead reads', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);

  await h.m._handleIntent('lead', { type: 'task', sub: 'done', id: 't1', body: `@spill:${id}` });

  assert.strictEqual(h.tasks.length, 1, 'the close still dispatched');
  assert.strictEqual(h.tasks[0].body, BIG,
    'the report arrives whole at the ticket store; a 23-byte pointer there is a closed ticket '
    + 'whose report nobody can read');
  assert.deepStrictEqual(h.tasks[0].spill, { id, path: spillPathFor(h.root, 'lead', id) });
});

test('a dm whose pointer file is gone BOUNCES rather than delivering the pointer text', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  fs.rmSync(spillPathFor(h.root, 'lead', id));

  await h.m._handleIntent('lead', { type: 'dm', target: 'bob', body: `@spill:${id}` });

  assert.deepStrictEqual(h.dms, [], 'nothing was delivered');
  assert.strictEqual(h.injected.length, 1, 'exactly one bounce, at the sender');
  assert.match(h.injected[0].text, /^\[agent:dm\] error: your body arrived as a pointer that Clodex never wrote/);
  assert.strictEqual(h.errors.length, 1);
  assert.match(h.errors[0], /names no spill file Clodex wrote \(missing\)/);
  assert.strictEqual(h.notes.length, 1, 'and the operator is raised a note');
});

test('text AFTER the pointer is PROSE and is used verbatim; surrounding whitespace alone still resolves', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  for (const body of [`@spill:${id} plus`, `@spill:${id}\n\nmore`, `see @spill:${id} and more`]) {
    h.tasks.length = 0;
    await h.m._handleIntent('lead', { type: 'task', sub: 'add', body });
    assert.strictEqual(h.tasks[0].body, body,
      `the pointer must END the one line it sits on: ${JSON.stringify(body)}`);
  }
  h.tasks.length = 0;
  await h.m._handleIntent('lead', { type: 'task', sub: 'add', body: ` @spill:${id}\n` });
  assert.strictEqual(h.tasks[0].body, BIG,
    'the tee emits the pointer alone on the head line and a consumer may have trimmed it or not');
});

test('a malformed id never parses as a pointer, so it dispatches as prose rather than being dropped', async () => {
  const h = mkH();
  for (const body of ['@spill:0123456789abcde', '@spill:0123456789ABCDEF', '@spill:0123456789abcdef0']) {
    h.tasks.length = 0;
    h.errors.length = 0;
    await h.m._handleIntent('lead', { type: 'task', sub: 'add', body });
    assert.strictEqual(h.tasks.length, 1,
      `dispatched as the spec it is (${body}) — a 15-hex or uppercase spelling is a spec that mentions `
      + '@spill:, not a failed resolution, and dropping it would destroy a real ticket body');
    assert.strictEqual(h.tasks[0].body, body);
    assert.deepStrictEqual(h.errors, [], 'and nothing was logged as unresolvable');
  }
});

test('a DENIED spill verb with a broken pointer is told its BODY is gone, which only resolution above the gate can say', async () => {
  const h = mkH({ entry: { name: 'lead', intents: ['dm'] } });
  const id = writeSpill(h.root, 'lead', BIG);
  fs.rmSync(spillPathFor(h.root, 'lead', id));

  await h.m._handleIntent('lead', { type: 'shout', body: `@spill:${id}` });

  assert.deepStrictEqual(h.inbox, [], 'the denied verb still did not run');
  assert.strictEqual(h.injected.length, 1, 'exactly one bounce, not one of each');
  assert.match(h.injected[0].text, /your body arrived as a pointer that Clodex never wrote/, h.injected[0].text);
  assert.ok(!/is disabled for this session/.test(h.injected[0].text),
    'the disabled bounce is what the seat gets BELOW the gate, and it hides the lost body');
  assert.strictEqual(h.errors.length, 1);
  assert.strictEqual(h.notes.length, 1);
});

test('a denied spill verb with a GOOD pointer resolves first, then is refused by the gate', async () => {
  const h = mkH({ entry: { name: 'lead', intents: ['dm'] } });
  const id = writeSpill(h.root, 'lead', BIG);

  await h.m._handleIntent('lead', { type: 'shout', body: `@spill:${id}` });

  assert.deepStrictEqual(h.inbox, [], 'the gate still refuses it');
  assert.strictEqual(h.injected.length, 1);
  assert.match(h.injected[0].text, /the shout intent is disabled for this session/);
  assert.deepStrictEqual(h.errors, [], 'and a readable file is not reported as a failure');
});

test("another seat's file is not reachable — resolution is confined to the SENDER's own directory", async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'other', BIG);
  assert.ok(fs.existsSync(spillPathFor(h.root, 'other', id)),
    "ENTER: the other seat's file exists on disk, so `missing` below is confinement and not an empty dir");

  await h.m._handleIntent('lead', { type: 'task', sub: 'add', body: `@spill:${id}` });

  assert.deepStrictEqual(h.tasks, [], 'no ticket');
  assert.strictEqual(h.errors.length, 1);
  assert.match(h.errors[0], /names no spill file Clodex wrote \(missing\)/);
});

test('unresolvable: log.error + _raiseNote + a bounce to the sender, and the intent DROPPED', async () => {
  const cases = [
    ['missing', (root, id) => { fs.rmSync(spillPathFor(root, 'lead', id)); }],
    ['not-a-file', (root, id) => {
      const p = spillPathFor(root, 'lead', id);
      fs.rmSync(p);
      fs.symlinkSync('/etc/hosts', p);
    }],
    ['not-a-file', (root, id) => {
      const p = spillPathFor(root, 'lead', id);
      fs.rmSync(p);
      fs.mkdirSync(p);
    }],
    ['empty', (root, id) => { fs.writeFileSync(spillPathFor(root, 'lead', id), ''); }],
  ];
  for (const [reason, damage] of cases) {
    const h = mkH();
    const id = writeSpill(h.root, 'lead', BIG);
    damage(h.root, id);

    await h.m._handleIntent('lead', { type: 'task', sub: 'add', body: `@spill:${id}` });

    assert.deepStrictEqual(h.tasks, [],
      `${reason}: no ticket is minted from an unreadable body — an empty spec is worse than a stall`);
    assert.strictEqual(h.errors.length, 1, `${reason}: logged once`);
    assert.match(h.errors[0], new RegExp(`@spill:${id} names no spill file Clodex wrote \\(${reason}\\)`), h.errors[0]);
    assert.match(h.errors[0], /intent dropped/);
    assert.deepStrictEqual(h.notes.map((n) => n.from), ['lead'], `${reason}: the operator is raised a note`);
    assert.match(h.notes[0].body, new RegExp(`typed a spill pointer Clodex never wrote \\(@spill:${id}, ${reason}\\)`));
    assert.match(h.notes[0].body, /task\.add was not applied/);
    assert.ok(h.broadcasts.some((b) => b.type === 'intent' && /a pointer Clodex never wrote/.test(b.body)),
      `${reason}: surfaced in the IPC log`);
    assert.strictEqual(h.injected.length, 1, `${reason}: exactly one bounce`);
    assert.strictEqual(h.injected[0].text,
      '[agent:task] error: your body arrived as a pointer that Clodex never wrote — Clodex only replaces a body '
      + 'AFTER it has been delivered, so a pointer in your output means you typed it and no body exists. '
      + 'Re-emit the intent with the full text.',
      `${reason}: the bounce says what happened, not "file missing"`);
    assert.deepStrictEqual(h.injected[0].opts, { parkable: true });
  }
});

test('a symlinked spill file hands back NOTHING, not the link target', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  const p = spillPathFor(h.root, 'lead', id);
  fs.rmSync(p);
  fs.symlinkSync('/etc/hosts', p);
  assert.ok(fs.readFileSync(p, 'utf8').length > 0,
    'ENTER: the link target is readable THROUGH the link, so lstat + O_NOFOLLOW is what refuses it below');

  await h.m._handleIntent('lead', { type: 'task', sub: 'add', body: `@spill:${id}` });

  assert.deepStrictEqual(h.tasks, [], 'nothing dispatched');
  const said = JSON.stringify([h.errors, h.injected, h.broadcasts, h.notes]);
  assert.ok(!/localhost/.test(said),
    'and no byte of the link target reached the seat, the log or the operator');
});

test('a seat with no live session still logs, notes and drops — nothing is typed at a session that is not there', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'ghost', BIG);
  fs.rmSync(spillPathFor(h.root, 'ghost', id));

  await h.m._handleIntent('ghost', { type: 'task', sub: 'add', body: `@spill:${id}` });

  assert.deepStrictEqual(h.tasks, []);
  assert.strictEqual(h.errors.length, 1);
  assert.strictEqual(h.notes.length, 1);
  assert.deepStrictEqual(h.injected, []);
});

test('rework r1: the tee\'s stub, replayed by recovery, keys EQUAL to the original the wire claimed — so the cross-path claim rejects it', async () => {
  const h = mkH();
  const original = `Working.\n[agent:dm bob] ${BIG}\n[agent:end]\nDone.\n`;
  const f = new SpillFilter({ agent: 'lead', root: h.root, verbs: ['dm'] });
  const stub = f.feed(original) + f.close();
  const id = /@spill:([0-9a-f]{16})/.exec(stub)[1];
  assert.strictEqual(stub, `Working.\n[agent:dm bob] spec line one @spill:${id}\n[agent:end]\nDone.\n`, 'ENTER: the transcript carries the stub');

  const wire = h.m._extractIntents(original);
  const replay = h.m._extractIntents(stub, { receiptsFor: 'lead' });
  assert.strictEqual(replay.length, 1);
  assert.strictEqual(replay[0].body, wire[0].body, 'the file is the body before anything keys it');
  assert.deepStrictEqual(replay[0].spill, { id, path: spillPathFor(h.root, 'lead', id) });
  const key = shadowIntentKey('lead', wire[0]);
  assert.strictEqual(shadowIntentKey('lead', replay[0]), key,
    'keyed on the pointer, the replay would be a fresh emission and the dm would go out twice');
  assert.notStrictEqual(key, shadowIntentKey('lead', h.m._extractIntents(stub)[0]), 'the wire scan alone still sees the pointer');

  const d = new IntentDeduper();
  assert.strictEqual(d.claim('lead', key, 'wire').ok, true);
  const second = d.claim('lead', shadowIntentKey('lead', replay[0]), 'recovery');
  assert.strictEqual(second.ok, false, 'the recovery replay of the tee-stubbed turn is rejected');
  assert.match(second.reason, /cross-path overlap \(wire→recovery\)/);

  await h.m._handleIntent('lead', replay[0]);
  assert.strictEqual(h.dms.length, 1);
  assert.strictEqual(h.dms[0].body, BIG, 'and when recovery does dispatch (no wire claim), the body is whole');
});

test('rework r1: a stub whose file is gone stays a pointer for _handleIntent to bounce; a stub closed by the NEXT head, a titled task stub, and a fenced stub', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  const gone = '0123456789abcdef';
  const text = `[agent:dm bob] @spill:${gone}\n[agent:end]\n[agent:task add hand start] spec line one @spill:${id}\n[agent:shout] fine\n[agent:end]\n`;
  const intents = h.m._extractIntents(text, { receiptsFor: 'lead' });
  assert.deepStrictEqual(intents.map((i) => [i.type, i.sub || null]), [['dm', null], ['task', 'add'], ['shout', null]]);
  assert.strictEqual(intents[0].body, `@spill:${gone}`);
  assert.strictEqual(intents[0].spill, undefined);
  assert.strictEqual(intents[1].body, BIG, 'the title is discarded, the file is the body');
  assert.strictEqual(intents[1].start, true);
  assert.strictEqual(intents[1].who, 'hand');
  assert.strictEqual(intents[2].body, 'fine', 'the reconstructed terminator does not swallow the head that closed the stub');

  const fenced = `\`\`\`\n[agent:dm bob] @spill:${id}\n[agent:end]\n\`\`\`\n`;
  assert.deepStrictEqual(h.m._extractIntents(fenced, { receiptsFor: 'lead' }), [], 'a fenced stub is a quote');
  await h.m._handleIntent('lead', intents[0]);
  assert.deepStrictEqual(h.dms, [], 'the missing file bounces as before');
  assert.strictEqual(h.errors.length, 1);
});

function receiptLine(words, body, filePath, title) {
  const t = title === undefined ? '' : ` — "${title}"`;
  return `(I sent ${words}${t} in full, ${Buffer.byteLength(body, 'utf8')} B; Clodex kept my text at ${filePath}.)`;
}

test('recovery (3a): a receipt line on a non-wire scan is expanded back into the intent from the file', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  const filePath = spillPathFor(h.root, 'lead', id);
  const text = `On it.\n${receiptLine('task add hand start', BIG, filePath, 'spec line one')}\nDone.\n`;

  assert.deepStrictEqual(h.m._extractIntents(text), [],
    'the wire scan never expands a receipt: the tee reads the unspilled stream, so a receipt there is typed');
  const intents = h.m._extractIntents(text, { receiptsFor: 'lead' });
  assert.strictEqual(intents.length, 1);
  assert.strictEqual(intents[0].type, 'task');
  assert.strictEqual(intents[0].sub, 'add');
  assert.strictEqual(intents[0].body.replace(/^\n/, ''), BIG, 'the FILE is the body, the title is discarded');
  assert.deepStrictEqual(intents[0].spill, { id, path: filePath }, 'provenance rides the intent, as a pointer\'s did');
  assert.strictEqual(intents[0].bodyOpen, undefined, 'the reconstructed body is closed');

  const original = h.m._extractIntents(`On it.\n[agent:task add hand start] ${BIG}\n[agent:end]\nDone.\n`);
  assert.strictEqual(shadowIntentKey('lead', intents[0]), shadowIntentKey('lead', original[0]),
    'the same dedupe key as the wire path claimed for the original, so an overlap replay is swallowed');
  assert.strictEqual(original[0].start, intents[0].start);
  assert.strictEqual(original[0].who, intents[0].who);

  await h.m._handleIntent('lead', intents[0]);
  assert.strictEqual(h.tasks.length, 1, 'and it dispatches');
  assert.strictEqual(h.tasks[0].body.replace(/^\n/, ''), BIG);
});

test('recovery (3a): a receipt whose path is outside the sender\'s spill dir is refused before any stat', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'other', BIG);
  const foreign = spillPathFor(h.root, 'other', id);
  assert.ok(fs.existsSync(foreign), 'ENTER: the file exists, so the refusal below is confinement');
  const cases = [
    ['another seat', foreign],
    ['a traversal', path.join(h.root, 'spill', 'lead', '..', 'other', `${id}.md`)],
    ['a foreign tree', `/etc/${id}.md`],
    ['a non-id name', path.join(h.root, 'spill', 'lead', 'notes.md')],
  ];
  for (const [label, p] of cases) {
    const hh = mkH();
    const intents = hh.m._extractIntents(receiptLine('dm bob', BIG, p), { receiptsFor: 'lead' });
    assert.strictEqual(intents.length, 1, label);
    assert.deepStrictEqual(intents[0].receipt, { path: p, reason: 'outside' }, label);
    await hh.m._handleIntent('lead', intents[0]);
    assert.deepStrictEqual(hh.dms, [], `${label}: nothing delivered`);
    assert.strictEqual(hh.injected.length, 1, `${label}: one bounce`);
    assert.match(hh.injected[0].text, /^\[agent:dm\] error: your body arrived as a pointer that Clodex never wrote/);
    assert.strictEqual(hh.notes.length, 1, `${label}: operator note`);
    assert.match(hh.errors[0], /names no spill file Clodex wrote \(outside\)/, label);
  }
});

test('recovery (3a): a receipt naming a missing file bounces like a typed pointer', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  const filePath = spillPathFor(h.root, 'lead', id);
  fs.rmSync(filePath);
  const intents = h.m._extractIntents(receiptLine('shout', BIG, filePath), { receiptsFor: 'lead' });
  assert.strictEqual(intents.length, 1);
  assert.deepStrictEqual(intents[0].receipt, { path: filePath, reason: 'missing' });
  await h.m._handleIntent('lead', intents[0]);
  assert.deepStrictEqual(h.inbox, [], 'no operator note is minted from a body that does not exist');
  assert.strictEqual(h.injected.length, 1);
  assert.match(h.injected[0].text, /^\[agent:shout\] error: your body arrived as a pointer that Clodex never wrote/);
  assert.match(h.errors[0], /names no spill file Clodex wrote \(missing\)/);
});

test('recovery (3a): two unresolved receipts in one turn carry distinct dedupe keys, so the second bounces too', () => {
  const h = mkH();
  const a = spillPathFor(h.root, 'lead', '0123456789abcdef');
  const b = spillPathFor(h.root, 'lead', 'fedcba9876543210');
  const intents = h.m._extractIntents(`${receiptLine('dm bob', BIG, a)}\n${receiptLine('dm bob', BIG, b)}\n`, { receiptsFor: 'lead' });
  assert.strictEqual(intents.length, 2);
  assert.notStrictEqual(shadowIntentKey('lead', intents[0]), shadowIntentKey('lead', intents[1]),
    'the empty body alone would collapse both to `lead|dm||` and the scan would swallow the second as an intra-turn dup');
});

test('recovery (3a): a receipt naming a non-spill verb, or sitting in a fence, is prose', () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  const filePath = spillPathFor(h.root, 'lead', id);
  assert.deepStrictEqual(h.m._extractIntents(receiptLine('exec run-tests', BIG, filePath), { receiptsFor: 'lead' }), [],
    'only a verb the filter could have spilled is a receipt');
  assert.deepStrictEqual(h.m._extractIntents(receiptLine('remind in 5m', BIG, filePath), { receiptsFor: 'lead' }), []);
  const fenced = '```\n' + receiptLine('dm bob', BIG, filePath) + '\n```\n';
  assert.deepStrictEqual(h.m._extractIntents(fenced, { receiptsFor: 'lead' }), [], 'a fenced receipt is a quote');
});

test('spill-mimic (item 8): the wire event is answered with a wire-spill-mimic row and one parkable advisory', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const arm = src.match(/wire\.on\('spill-mimic', \(ev\) => \{[\s\S]{0,700}?\n\s*\}\);/);
  assert.ok(arm, 'the spill-mimic event has a consumer beside the spill/spill-bail rows');
  assert.match(arm[0], /this\._shadowLog\(\{ type: 'wire-spill-mimic', \.\.\.ev \}\)/, 'the diag row');
  assert.match(arm[0], /this\._injectText\(s, SPILL_MIMIC_BOUNCE, \{ parkable: true \}\)/, 'parkable, like the other advisory bounces');
  assert.match(arm[0], /if \(s && s\.agentType\)/, 'and only at a live session');
  const bounce = src.match(/const SPILL_MIMIC_BOUNCE = '([^']+)';/);
  assert.ok(bounce, 'the advisory is one constant');
  assert.strictEqual(bounce[1],
    '[agent] Not executed: that line was a receipt, filler or pointer, not an intent, and nothing was sent or filed. '
    + 'Emit the complete intent — head line, full body, [agent:end].');
  assert.ok(!bounce[1].includes('@spill:'), 'the bounce never spells the pointer shape either');
  assert.ok(!bounce[1].includes('[Runtime note: action text omitted from retained history.]'),
    'the bounce never echoes the filler: an echo is one more copyable line in the record');
});

test('t1052: a copied `[Runtime note: action text omitted from retained history.]` is mimic kind filler, and the spill-mimic arm bounces every kind — no kind filter', () => {
  const { mimicKindOf } = require('../intent-spill');
  assert.strictEqual(mimicKindOf('[Runtime note: action text omitted from retained history.]'), 'filler');
  assert.strictEqual(mimicKindOf('   [Runtime note: action text omitted from retained history.]'), 'filler');
  assert.strictEqual(mimicKindOf('[Runtime note: action text omitted from retained history.] — the dm went out'), null, 'only a lone filler line is the copied shape');
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const arm = src.match(/wire\.on\('spill-mimic', \(ev\) => \{[\s\S]{0,700}?\n\s*\}\);/);
  assert.ok(arm);
  assert.ok(!/ev\.kind\s*[!=]=/.test(arm[0]),
    'the bounce is not gated on kind: a filler copied from the record costs one bounce and fabricates nothing');
});

test('t1052: the wire spill event enqueues a Clodex-voiced ack in the USER role, exact texts, "filed" never "delivered"', () => {
  const { spillAckLine } = require('../session-manager');
  const { enqueueNotice, parseNotices } = require('../notice-queue');
  const root = mkTmpRoot('clodex-spill-');
  const intentPath = spillPathFor(root, 'lead', '0123456789abcdef');
  const prosePath = spillPathFor(root, 'lead', 'fedcba9876543210');

  const dm = spillAckLine({ verb: 'dm', head: 'dm nobody', bytes: 901, id: '0123456789abcdef' }, intentPath);
  assert.strictEqual(dm, `[clodex] your dm nobody (901 B) was read in full and filed at ${intentPath}.`);
  const add = spillAckLine({ verb: 'task.add', head: 'task add hand start', bytes: 6664 }, intentPath);
  assert.strictEqual(add, `[clodex] your task add hand start (6664 B) was read in full and filed at ${intentPath}.`);
  const prose = spillAckLine({ verb: 'prose', head: null, bytes: 1200, id: 'fedcba9876543210' }, prosePath);
  assert.strictEqual(prose,
    `[clodex] the 1200 B of prose after your last intent reached the operator's log and were filed at ${prosePath}.`);
  for (const line of [dm, add, prose]) {
    assert.ok(!/deliver/.test(line), 'delivery failures have their own bounces; the ack says filed');
    assert.ok(!/\(I sent|@spill:|\[agent:/.test(line), 'the ack carries no copyable emission shape');
  }

  assert.strictEqual(enqueueNotice(root, 'lead', dm), true);
  assert.strictEqual(enqueueNotice(root, 'lead', prose), true);
  assert.deepStrictEqual(parseNotices(root, 'lead').map((n) => n.text), [dm, prose],
    'the queue carries both texts byte-for-byte, so the UserPromptSubmit drain hands the seat exactly these lines');

  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const arm = src.match(/wire\.on\('spill', \(ev\) => \{[\s\S]{0,1200}?wire-spill-ack-error[\s\S]{0,200}?\n\s*\}\);/);
  assert.ok(arm, 'the spill event has a consumer');
  assert.match(arm[0], /const filePath = spillPathFor\(REGISTRY_DIR, ev\.agent, ev\.id\);[\s\S]*enqueueNotice\(REGISTRY_DIR, ev\.agent, spillAckLine\(ev, filePath\)\)/,
    'the ack goes through notice-queue.js — the USER role, where nothing is imitated — never through _injectText into the pane');
  assert.ok(!/_injectText/.test(arm[0]));
});

test('t1059: a wire spill broadcasts one ipc-message row of type spill — head form — with the filed path on it', async () => {
  const h = mkH({ getUserDataPath: () => h.root, shadowIntentKey });
  const rig = await wireRig(h);
  try {
    rig.wire.emit('spill', { agent: 'a', verb: 'task', head: 'task add hand', id: 'deadbeef00000000', bytes: 1234 });
    const rows = h.broadcasts.filter((b) => b.type === 'spill');
    assert.strictEqual(rows.length, 1, 'ENTER: exactly one spill row');
    const expectedPath = path.join(h.root, 'spill', 'a', 'deadbeef00000000.md');
    assert.deepStrictEqual(rows[0], {
      type: 'spill', from: 'clodex', to: 'a',
      body: `task add hand (1234 B) filed at ${expectedPath}`,
      path: expectedPath,
    });
    assert.deepStrictEqual(h.errors, []);
  } finally {
    await rig.close();
  }
});

test('t1059: a prose spill broadcasts the prose body form', async () => {
  const h = mkH({ getUserDataPath: () => h.root, shadowIntentKey });
  const rig = await wireRig(h);
  try {
    rig.wire.emit('spill', { agent: 'a', verb: 'prose', head: null, id: 'deadbeef00000000', bytes: 1234 });
    const rows = h.broadcasts.filter((b) => b.type === 'spill');
    assert.strictEqual(rows.length, 1, 'ENTER: exactly one spill row');
    const expectedPath = path.join(h.root, 'spill', 'a', 'deadbeef00000000.md');
    assert.deepStrictEqual(rows[0], {
      type: 'spill', from: 'clodex', to: 'a',
      body: `prose after your last intent (1234 B) filed at ${expectedPath}`,
      path: expectedPath,
    });
  } finally {
    await rig.close();
  }
});

test('t1059: the spill row is broadcast even when the ack enqueue throws — the two are independent', async () => {
  const shadow = [];
  const h = mkH({
    getUserDataPath: () => h.root, shadowIntentKey,
    enqueueNotice: () => { throw new Error('queue on fire'); },
  });
  h.m._shadowLog = (row) => shadow.push(row);
  const rig = await wireRig(h);
  try {
    rig.wire.emit('spill', { agent: 'a', verb: 'task', head: 'task add hand', id: 'deadbeef00000000', bytes: 1234 });
    assert.deepStrictEqual(shadow.filter((r) => r.type === 'wire-spill-ack-error'),
      [{ type: 'wire-spill-ack-error', agent: 'a', error: 'queue on fire' }], 'ENTER: the enqueue really threw');
    const rows = h.broadcasts.filter((b) => b.type === 'spill');
    assert.strictEqual(rows.length, 1, 'the row does not ride inside the ack try/catch');
    assert.strictEqual(rows[0].path, path.join(h.root, 'spill', 'a', 'deadbeef00000000.md'));
  } finally {
    await rig.close();
  }
});

async function wireRig(h) {
  h.m._publishAgentText = () => {};
  h.m._maybeSpeak = () => {};
  h.m._maybeDeliverDigest = () => {};
  h.m._maybeRearmHold = () => {};
  h.m._maybeFireCompactLatch = () => {};
  h.m._fireScratchClose = () => {};
  const wire = await h.m._ensureWire();
  h.m.sessions.set('lead', { name: 'lead', agentType: 'claude', workspaceId: 'ws1', intentSource: 'wire', sessionId: 'sid-1' });
  const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r)); };
  const turn = async (text, reqId) => {
    wire.emit('turn.completed', { agent: 'lead', text, reqId, sessionId: 'sid-1', stop: { is_turn: true } });
    await settle();
  };
  const close = async () => { await wire.close(); if (h.m._holdKeeper) h.m._holdKeeper.stop(); };
  return { wire, turn, settle, close };
}

const MIMIC_BOUNCE = '[agent] Not executed: that line was a receipt, filler or pointer, not an intent, and nothing was sent or filed. '
  + 'Emit the complete intent — head line, full body, [agent:end].';

test('T11: a pointer body on the WIRE path is bounced as typed and never resolved, even when it names a real file; the jsonl path still resolves it', async () => {
  const h = mkH({ getUserDataPath: () => h.root, shadowIntentKey });
  const id = writeSpill(h.root, 'lead', BIG);
  assert.ok(id, 'ENTER: a real file exists, so a resolver that ran WOULD succeed');
  const rig = await wireRig(h);
  try {
    await rig.turn(`[agent:task add t] @spill:${id}\n[agent:end]\n`, 'r1');
    assert.deepStrictEqual(h.tasks, [], 'the model never receives a real stub, so a pointer it emits is typed from memory: dropped, not resolved');
    assert.deepStrictEqual(h.injected.map((i) => i.text), [MIMIC_BOUNCE], 'one advisory, the same one the mimic detector uses');
    assert.deepStrictEqual(h.injected[0].opts, { parkable: true });
    assert.ok(h.broadcasts.some((b) => b.type === 'intent' && /task\.add dropped: its body was a pointer/.test(b.body)), 'surfaced in the IPC log');
    assert.deepStrictEqual(h.notes, [], 'no operator note: a typed pointer is a model slip, not an incident');
    assert.deepStrictEqual(h.errors, []);

    await h.m._handleIntent('lead', { type: 'task', sub: 'add', body: `@spill:${id}` });
    assert.strictEqual(h.tasks.length, 1, 'the jsonl / recovery path carries no fromWire flag and still resolves');
    assert.strictEqual(h.tasks[0].body, BIG, 'a sentinel replay of the transcript tail recovers the real body from Clodex\'s own stub');
    assert.strictEqual(h.injected.length, 1, 'and bounces nothing');
  } finally {
    await rig.close();
  }
});

test('T11: a titled pointer and a dm pointer bounce on the wire path too; a pointer INSIDE a longer body is prose and dispatches', async () => {
  const h = mkH({ getUserDataPath: () => h.root, shadowIntentKey });
  const id = writeSpill(h.root, 'lead', BIG);
  const rig = await wireRig(h);
  try {
    await rig.turn(`[agent:task add t] spec line one @spill:${id}\n[agent:end]\n`, 'r1');
    await rig.turn(`[agent:dm bob] @spill:${id}\n[agent:end]\n`, 'r2');
    assert.deepStrictEqual(h.tasks, []);
    assert.deepStrictEqual(h.dms, []);
    assert.deepStrictEqual(h.injected.map((i) => i.text), [MIMIC_BOUNCE, MIMIC_BOUNCE], 'one bounce per turn');
    await rig.turn(`[agent:dm bob] see @spill:${id} for the body\n[agent:end]\n`, 'r3');
    assert.strictEqual(h.dms.length, 1, 'not a pointer body, so the dm goes out as written');
    assert.strictEqual(h.dms[0].body, `see @spill:${id} for the body`);
  } finally {
    await rig.close();
  }
});

test('T12: the intent-shaped pointer is bounced ONCE per turn — the mimic detector\'s bounce and the intent path\'s bounce collapse on the reqId', async () => {
  const h = mkH({ getUserDataPath: () => h.root, shadowIntentKey });
  const id = writeSpill(h.root, 'lead', BIG);
  const rig = await wireRig(h);
  try {
    rig.wire.emit('spill-mimic', { agent: 'lead', reqId: 'r1', kind: 'pointer' });
    await rig.settle();
    assert.deepStrictEqual(h.injected.map((i) => i.text), [MIMIC_BOUNCE], 'ENTER: the detector bounced the head line during the stream');
    await rig.turn(`[agent:task add t] @spill:${id}\n[agent:end]\n`, 'r1');
    assert.deepStrictEqual(h.tasks, [], 'still dropped');
    assert.strictEqual(h.injected.length, 1, 'the intent path saw the same reqId already bounced and stayed silent');

    await rig.turn(`[agent:task add t] @spill:${id}\n[agent:end]\n`, 'r2');
    assert.strictEqual(h.injected.length, 2, 'a later turn with no detector bounce (the tee unarmed, the pref off) is bounced by the intent path');
    rig.wire.emit('spill-mimic', { agent: 'lead', reqId: 'r3', kind: 'pointer' });
    await rig.settle();
    assert.strictEqual(h.injected.length, 3, 'and the detector is not silenced by the intent path\'s earlier bounce');
  } finally {
    await rig.close();
  }
});
