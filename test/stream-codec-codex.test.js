'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { create } = require('../stream-codec-codex');

const FIX = path.join(__dirname, 'fixtures', 'stream-codex');
const lines = (name) => fs.readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const wire = (name, d = 'in') => lines(name).filter((l) => l.d === d).map((l) => l.m);
const rolloutId = (thread) => path.basename(thread.path, '.jsonl');

const opened = (ctx = {}) => {
  const warns = [];
  const codec = create({ cwd: '/w', log: { warn: (tag, msg) => warns.push([tag, msg]) }, ...ctx });
  const open = codec.open();
  return { codec, open, warns };
};

const started = (ctx = {}) => {
  const h = opened(ctx);
  const [threadStart] = wire('thread-start');
  h.init = h.codec.decode({ ...threadStart, id: h.open[2].id });
  return h;
};

test('open() sends initialize, initialized and thread/start in the captured shape, in order', () => {
  const [init, initialized, threadStart] = wire('handshake', 'out');
  const { open } = opened();
  assert.deepStrictEqual(open.map((o) => o.method), [init.method, initialized.method, threadStart.method]);
  assert.deepStrictEqual(open[0].params.capabilities, { experimentalApi: true });
  assert.deepStrictEqual(open[1], initialized);
  assert.strictEqual(typeof open[0].id, 'number');
  assert.notStrictEqual(open[0].id, open[2].id);
  assert.strictEqual(open[2].params.cwd, '/w');
});

test('thread/start posture per (bypass, readOnly)', () => {
  const rows = [
    [{ bypass: false, readOnly: false }, { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }],
    [{ bypass: true, readOnly: false }, { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
    [{ bypass: false, readOnly: true }, { approvalPolicy: 'never', sandbox: 'read-only' }],
    [{ bypass: true, readOnly: true }, { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
  ];
  for (const [ctx, want] of rows) {
    const { open } = opened(ctx);
    const { approvalPolicy, sandbox } = open[2].params;
    assert.deepStrictEqual({ approvalPolicy, sandbox }, want, JSON.stringify(ctx));
  }
});

test('a resume opens with thread/resume on the uuid; fork warns once and resumes', () => {
  const { open, warns } = opened({ resumeId: 'rollout-2026-09-24T15-54-33-01a0d36f-d6a5-7371-8d9b-774875de6de3', fork: true });
  assert.strictEqual(open[2].method, 'thread/resume');
  assert.strictEqual(open[2].params.threadId, '01a0d36f-d6a5-7371-8d9b-774875de6de3');
  assert.strictEqual(warns.length, 1);
  const [resumed] = wire('thread-resume');
  const { codec } = opened({ resumeId: resumed.result.thread.id });
  const rec = codec.decode(resumed);
  assert.deepStrictEqual(rec, { kind: 'init', sessionId: rolloutId(resumed.result.thread), model: resumed.result.model, slashCommands: [], turnEnd: true });
});

test('the thread/start result decodes to init with the rollout-name id the transcript watcher reports, and turnEnd', () => {
  const [threadStart] = wire('thread-start');
  const { init } = started();
  assert.deepStrictEqual(init, { kind: 'init', sessionId: rolloutId(threadStart.result.thread), model: threadStart.result.model, slashCommands: [], turnEnd: true });
});

test('turn/started is status running; turn/completed is a result, failed only when the turn failed', () => {
  const { codec } = started();
  const [turnStarted, turnCompleted] = wire('turn');
  assert.deepStrictEqual(codec.decode(turnStarted), { kind: 'status', status: 'running' });
  assert.deepStrictEqual(codec.decode(turnCompleted), { kind: 'result', durationMs: null, costUsd: null, isError: false });
  assert.deepStrictEqual(codec.decode(wire('turn-interrupted')[0]), { kind: 'result', durationMs: null, costUsd: null, isError: false });
  assert.deepStrictEqual(codec.decode(wire('turn-failed')[0]), { kind: 'result', durationMs: null, costUsd: null, isError: true });
});

test('item/completed contextCompaction decodes to compact with null token counts; item/started does not', () => {
  const { codec } = started();
  const got = wire('compact').map((m) => codec.decode(m).kind);
  assert.deepStrictEqual(got, ['other', 'other', 'compact', 'result']);
  const done = wire('compact').find((m) => m.method === 'item/completed');
  assert.deepStrictEqual(codec.decode(done), { kind: 'compact', pre: null, post: null });
});

test('approval requests decode to permission-denied with a decline reply carrying the server id', () => {
  const { codec } = started();
  const reqs = wire('approvals');
  const recs = reqs.map((r) => codec.decode(r));
  assert.deepStrictEqual(recs.map((r) => [r.kind, r.toolName]), [
    ['permission-denied', 'commandExecution'], ['permission-denied', 'commandExecution'],
    ['permission-denied', 'fileChange'], ['permission-denied', 'fileChange'],
  ]);
  assert.deepStrictEqual(recs.map((r) => r.send), reqs.map((r) => [{ id: r.id, result: { decision: 'decline' } }]));
});

test('under bypass an approval request is other, but the decline still rides send', () => {
  const { codec } = started({ bypass: true });
  const [req] = wire('approvals');
  assert.deepStrictEqual(codec.decode(req), { kind: 'other', toolName: 'commandExecution', send: [{ id: req.id, result: { decision: 'decline' } }] });
});

test('an error for turn/start or compact is an error result; for anything else it is other with one warning', () => {
  const [err] = wire('error');
  const { codec, warns } = started();
  const turn = codec.encodeUser('hi', []);
  assert.deepStrictEqual(codec.decode({ ...err, id: turn.id }), { kind: 'result', durationMs: null, costUsd: null, isError: true });
  const compact = codec.encodeContext('compact');
  assert.deepStrictEqual(codec.decode({ ...err, id: compact.id }), { kind: 'result', durationMs: null, costUsd: null, isError: true });
  assert.strictEqual(warns.length, 0);
  const h = opened();
  assert.deepStrictEqual(h.codec.decode({ ...err, id: h.open[2].id }), { kind: 'other' });
  assert.strictEqual(h.warns.length, 1);
});

test('a non-object line and an unknown notification are other', () => {
  const { codec } = started();
  for (const v of [null, 'x', 3, [], { method: 'thread/tokenUsage/updated', params: {} }, {}]) {
    assert.deepStrictEqual(codec.decode(v), { kind: 'other' }, JSON.stringify(v));
  }
});

test('encodeUser is a turn/start on the thread in the captured input shape; images are dropped with one warning', () => {
  const { codec, warns } = started();
  const [threadStart] = wire('thread-start');
  const msg = codec.encodeUser('Reply with exactly: ONE', []);
  assert.strictEqual(msg.method, 'turn/start');
  assert.deepStrictEqual(msg.params, { threadId: threadStart.result.thread.id, input: [{ type: 'text', text: 'Reply with exactly: ONE', text_elements: [] }] });
  const img = { mediaType: 'image/png', data: 'AAAA' };
  codec.encodeUser('a', [img]);
  codec.encodeUser('b', [img]);
  assert.strictEqual(warns.length, 1);
  assert.strictEqual(codec.encodeUser('', [img]), null);
});

test('encodeUser carries the model on every turn/start when one was resolved', () => {
  const { codec } = started({ model: 'gpt-6-luna' });
  assert.strictEqual(codec.encodeUser('x', []).params.model, 'gpt-6-luna');
  assert.strictEqual(codec.encodeUser('y', []).params.model, 'gpt-6-luna');
});

test('encodeUser swallows the context-command texts', () => {
  const { codec } = started();
  assert.strictEqual(codec.encodeUser('/compact', []), null);
  assert.strictEqual(codec.encodeUser(' /clear\n', []), null);
});

test('encodeContext: compact is thread/compact/start on the thread, clear a fresh thread/start whose result is init turnEnd', () => {
  const { codec } = started({ readOnly: true });
  const [threadStart] = wire('thread-start');
  const compact = codec.encodeContext('compact');
  const [capturedCompact] = wire('compact', 'out');
  assert.strictEqual(compact.method, capturedCompact.method);
  assert.deepStrictEqual(compact.params, { threadId: threadStart.result.thread.id });
  const clear = codec.encodeContext('clear');
  assert.deepStrictEqual({ method: clear.method, params: clear.params }, { method: 'thread/start', params: { cwd: '/w', approvalPolicy: 'never', sandbox: 'read-only' } });
  const fresh = { ...threadStart, id: clear.id, result: { ...threadStart.result, thread: { ...threadStart.result.thread, id: 'new-thread', path: undefined } } };
  assert.deepStrictEqual(codec.decode(fresh), { kind: 'init', sessionId: 'new-thread', model: threadStart.result.model, slashCommands: [], turnEnd: true });
  assert.strictEqual(codec.encodeUser('x', []).params.threadId, 'new-thread');
  assert.strictEqual(codec.encodeContext('reload'), null);
});

test('encodeInterrupt is turn/interrupt for the running turn, null with no turn', () => {
  const { codec } = started();
  assert.strictEqual(codec.encodeInterrupt(), null);
  const [turnStarted, turnCompleted] = wire('turn');
  codec.decode(turnStarted);
  const intr = codec.encodeInterrupt();
  assert.deepStrictEqual({ method: intr.method, params: intr.params }, {
    method: 'turn/interrupt', params: { threadId: wire('thread-start')[0].result.thread.id, turnId: turnStarted.params.turn.id },
  });
  codec.decode(turnCompleted);
  assert.strictEqual(codec.encodeInterrupt(), null);
});
