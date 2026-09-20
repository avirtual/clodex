'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { writeSpill, spillPathFor } = require('../intent-spill');
const { shadowIntentKey } = require('../intent-scanner');
const { IntentDeduper } = require('../wire-intents');

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

test('every spill verb resolves: task add/respec/reject/done, dm, shout and context compact/clear/reload', async () => {
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
    assert.deepStrictEqual(h.contexts, [{ sub, body: BIG }], `context ${sub} resolved`);
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

test('memory remember is not a spill verb, so a pointer in one is the text it is', async () => {
  const h = mkH();
  const memos = [];
  h.m._handleMemoryIntent = (s, sub, body) => memos.push({ sub, body });
  const id = writeSpill(h.root, 'lead', BIG);
  await h.m._handleIntent('lead', { type: 'memory', sub: 'remember', body: `@spill:${id}` });
  assert.strictEqual(memos[0].body, `@spill:${id}`,
    'a memo the seat cannot see is a memo it did not make');
});

test('a non-spill verb is never inspected, which is what makes a cross-seat read inexpressible', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  await h.m._handleIntent('lead', { type: 'remind', spec: 'in 5m', body: `@spill:${id}` });
  assert.deepStrictEqual(h.reminds, [{ spec: 'in 5m', body: `@spill:${id}` }],
    "a peer's pointer pasted into an unheld verb is used as the text it is; the receiver copying it "
    + "into its OWN intent would resolve against the RECEIVER's directory and miss");
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
  assert.match(h.injected[0].text, /^\[agent:dm\] error: your body arrived as @spill:/);
  assert.strictEqual(h.errors.length, 1);
  assert.match(h.errors[0], /dm was not applied|did not resolve \(missing\)/);
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

  await h.m._handleIntent('lead', { type: 'context', sub: 'compact', body: `@spill:${id}` });

  assert.deepStrictEqual(h.contexts, [], 'the denied verb still did not run');
  assert.strictEqual(h.injected.length, 1, 'exactly one bounce, not one of each');
  assert.match(h.injected[0].text, /your body arrived as @spill:/, h.injected[0].text);
  assert.ok(!/is disabled for this session/.test(h.injected[0].text),
    'the disabled bounce is what the seat gets BELOW the gate, and it hides the lost body. '
    + "(_deniedIntentPayload's byte-size sentence cannot be the subject here: `task` is not a gateable "
    + "type and `context`'s denied disposition is deliberately 'none'.)");
  assert.strictEqual(h.errors.length, 1);
  assert.strictEqual(h.notes.length, 1);
});

test('a denied spill verb with a GOOD pointer resolves first, then is refused by the gate', async () => {
  const h = mkH({ entry: { name: 'lead', intents: ['dm'] } });
  const id = writeSpill(h.root, 'lead', BIG);

  await h.m._handleIntent('lead', { type: 'context', sub: 'compact', body: `@spill:${id}` });

  assert.deepStrictEqual(h.contexts, [], 'the gate still refuses it');
  assert.strictEqual(h.injected.length, 1);
  assert.match(h.injected[0].text, /the context intent is disabled for this session/);
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
  assert.match(h.errors[0], /did not resolve \(missing\)/);
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
    assert.match(h.errors[0], new RegExp(`@spill:${id} did not resolve \\(${reason}\\)`), h.errors[0]);
    assert.match(h.errors[0], /intent dropped/);
    assert.deepStrictEqual(h.notes.map((n) => n.from), ['lead'], `${reason}: the operator is raised a note`);
    assert.match(h.notes[0].body, new RegExp(`did not resolve \\(${reason}\\)`));
    assert.match(h.notes[0].body, /task\.add was not applied/);
    assert.ok(h.broadcasts.some((b) => b.type === 'intent' && /unresolvable/.test(b.body)),
      `${reason}: surfaced in the IPC log`);
    assert.strictEqual(h.injected.length, 1, `${reason}: exactly one bounce`);
    assert.match(h.injected[0].text, /^\[agent:task\] error: your body arrived as @spill:/);
    assert.match(h.injected[0].text, /re-emit the intent with the full body/);
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

test('the dedupe key is computed on the POINTER form at both dispatch sites, and resolution is what changes it', async () => {
  const h = mkH();
  const id = writeSpill(h.root, 'lead', BIG);
  const intent = { type: 'task', sub: 'add', body: `@spill:${id}` };
  const before = shadowIntentKey('lead', intent);

  await h.m._handleIntent('lead', intent);

  assert.notStrictEqual(shadowIntentKey('lead', intent), before,
    'the chokepoint MUTATES the body, so the key is only stable if both sites take it before dispatch — '
    + 'a key taken after would be the 1.2 KB body on one path and the pointer on the other, and one '
    + 'emission recovered after a tee failure would fire twice');

  const d = new IntentDeduper();
  assert.strictEqual(d.claim('lead', before, 'wire').ok, true);
  const second = d.claim('lead', before, 'recovery');
  assert.strictEqual(second.ok, false, 'the recovery replay of the same pointer turn is rejected');
  assert.match(second.reason, /cross-path overlap/);
});
