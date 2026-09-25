'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { create, uuidv7 } = require('../stream-codec-muse');

const FIX = path.join(__dirname, 'fixtures', 'stream-muse');
const lines = (name) => fs.readFileSync(path.join(FIX, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const wire = (name, d = 'in') => lines(name).filter((l) => l.d === d).map((l) => l.m);
const response = (name) => wire(name).find((m) => m.id !== undefined);
const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const homePath = (session) => `/H${session.path.slice(1)}`;
const RESULT = (isError) => ({ kind: 'result', durationMs: null, costUsd: null, isError });

const opened = (ctx = {}) => {
  const warns = [];
  const codec = create({ cwd: '/w', home: '/H', log: { warn: (tag, msg) => warns.push([tag, msg]) }, ...ctx });
  const open = codec.open();
  return { codec, open, warns };
};

const started = (ctx = {}) => {
  const h = opened(ctx);
  h.init = h.codec.decode({ ...response('handshake'), id: h.open[2].id });
  return h;
};

const running = (ctx = {}) => {
  const h = started(ctx);
  h.turn = h.codec.encodeUser('Reply with exactly: ONE', []);
  h.ack = h.codec.decode({ ...response('turn'), id: h.turn.id });
  return h;
};

test('open() sends initialize, initialized and session/start in the captured order and shape', () => {
  const out = wire('handshake', 'out');
  const { open } = opened({ model: 'muse-spark-1.2' });
  assert.deepStrictEqual(open.map((o) => o.method), out.map((o) => o.method));
  assert.ok(open.every((o) => o.jsonrpc === '2.0'));
  assert.deepStrictEqual(open[1], out[1]);
  assert.deepStrictEqual(open[0].params.capabilities, { userInputDialogs: false });
  assert.strictEqual(typeof open[0].id, 'number');
  assert.notStrictEqual(open[0].id, open[2].id);
  assert.deepStrictEqual(Object.keys(open[2].params).sort(), Object.keys(out[2].params).sort());
  assert.strictEqual(open[2].params.workspaceRoot, '/w');
  assert.strictEqual(open[2].params.modelId, 'muse-spark-1.2');
  assert.ok(!('modelId' in opened().open[2].params));
});

test('session/start approval mode per (bypass, readOnly)', () => {
  const rows = [
    [{ bypass: false, readOnly: false }, 'promptUnmatched'],
    [{ bypass: true, readOnly: false }, 'allowAll'],
    [{ bypass: false, readOnly: true }, 'denyUnmatched'],
    [{ bypass: true, readOnly: true }, 'allowAll'],
  ];
  for (const [ctx, want] of rows) assert.strictEqual(opened(ctx).open[2].params.approvalMode, want, JSON.stringify(ctx));
});

test('every command carries a fresh UUIDv7 commandId; uuidv7 stamps the time, version and variant', () => {
  const { codec, open } = running();
  const cmds = [open[2], codec.encodeUser('x', []), codec.encodeContext('compact'), codec.encodeContext('clear'), codec.encodeInterrupt()];
  const ids = cmds.map((c) => c.params.commandId);
  for (const id of ids) assert.match(id, V7_RE);
  assert.strictEqual(new Set(ids).size, ids.length);
  const id = uuidv7(0x0123456789ab, Buffer.alloc(16, 0xff));
  assert.strictEqual(id, '01234567-89ab-7fff-bfff-ffffffffffff');
  assert.strictEqual(open[0].params.commandId, undefined);
});

test('the session/start result decodes to init with the session id, the expanded transcript path and turnEnd', () => {
  const { init } = started();
  const { session } = response('handshake').result;
  assert.deepStrictEqual(init, { kind: 'init', sessionId: session.sessionId, model: session.modelId, slashCommands: [], turnEnd: true, transcriptPath: homePath(session) });
  const { codec, open } = opened();
  const abs = { ...response('handshake'), id: open[2].id, result: { ...response('handshake').result, session: { ...session, path: '/abs/session.jsonl' } } };
  assert.strictEqual(codec.decode(abs).transcriptPath, '/abs/session.jsonl');
  assert.deepStrictEqual(codec.decode(wire('handshake').find((m) => m.method === 'session/started')), { kind: 'other' });
});

test('a resume opens with session/resume on the id; fork warns once and resumes; the result is init', () => {
  const [sent] = wire('resume', 'out');
  const { open, warns } = opened({ resumeId: sent.params.sessionId, fork: true });
  assert.strictEqual(open[2].method, 'session/resume');
  assert.deepStrictEqual({ ...open[2].params, commandId: null }, { ...sent.params, commandId: null });
  assert.strictEqual(warns.length, 1);
  const { codec, open: o2 } = opened({ resumeId: sent.params.sessionId });
  const res = response('resume');
  assert.deepStrictEqual(codec.decode({ ...res, id: o2[2].id }), { kind: 'init', sessionId: sent.params.sessionId, model: res.result.session.modelId, slashCommands: [], turnEnd: true, transcriptPath: homePath(res.result.session) });
});

test('the resume_reconcile cancel before the resume ack is other, so nothing drains before the session exists; the ack ends in init', () => {
  const [sent] = wire('resume-reconcile', 'out');
  const { codec, open } = opened({ resumeId: sent.params.sessionId });
  const [reconcile, ack] = wire('resume-reconcile');
  assert.deepStrictEqual(codec.decode(reconcile), { kind: 'other' });
  assert.strictEqual(codec.decode({ ...ack, id: open[2].id }).kind, 'init');
});

test('a failed session/resume warns once and sends a fresh session/start; its result ends the handshake', () => {
  const [, rejected] = lines('rejected').map((l) => l.m);
  const { codec, open, warns } = opened({ resumeId: '01a0d3f2-659a-75d2-ad3e-1deb2086fe29' });
  const rec = codec.decode({ ...rejected, id: open[2].id });
  assert.strictEqual(rec.kind, 'other');
  assert.strictEqual(rec.send.length, 1);
  assert.strictEqual(rec.send[0].method, 'session/start');
  assert.strictEqual(rec.send[0].params.approvalMode, 'promptUnmatched');
  assert.strictEqual(warns.length, 1);
  assert.strictEqual(codec.decode({ ...response('handshake'), id: rec.send[0].id }).kind, 'init');
});

test('turn/start carries the session id and text; its ack is status running; turn/completed is a result, failed only on terminal failed', () => {
  const [sent] = wire('turn', 'out');
  const { codec, turn, ack, init } = running();
  assert.strictEqual(turn.method, 'turn/start');
  assert.deepStrictEqual(turn.params.input, sent.params.input);
  assert.strictEqual(turn.params.sessionId, init.sessionId);
  assert.ok(!('ifBusy' in turn.params));
  assert.deepStrictEqual(ack, { kind: 'status', status: 'running' });
  const done = wire('turn').find((m) => m.method === 'turn/completed');
  assert.deepStrictEqual(codec.decode(done), RESULT(false));
  assert.deepStrictEqual(codec.decode(wire('interrupt').find((m) => m.method === 'turn/completed')), RESULT(false));
  assert.deepStrictEqual(codec.decode({ ...done, params: { ...done.params, terminal: 'failed' } }), RESULT(true));
  assert.deepStrictEqual(codec.decode(wire('turn').find((m) => m.method === 'turn/started')), { kind: 'other' });
});

test('images ride turn/start as schema image parts ahead of the text', () => {
  const { codec } = started();
  const obj = codec.encodeUser('look', [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.deepStrictEqual(obj.params.input, [{ type: 'image', mediaType: 'image/png', base64Data: 'AAAA' }, { type: 'text', text: 'look' }]);
  assert.strictEqual(codec.encodeUser('   ', []), null);
});

test('/compact and /clear as text return null with one warning and never reach the wire', () => {
  const { codec, warns } = started();
  assert.strictEqual(codec.encodeUser('/compact', []), null);
  assert.strictEqual(codec.encodeUser(' /clear ', []), null);
  assert.strictEqual(warns.length, 1);
});

test('item/completed compaction decodes to compact with the token counts and turnEnd; item/started does not', () => {
  const [sent] = wire('compact', 'out');
  const { codec, init } = started();
  const obj = codec.encodeContext('compact');
  assert.strictEqual(obj.method, sent.method);
  assert.deepStrictEqual(Object.keys(obj.params).sort(), Object.keys(sent.params).sort());
  assert.strictEqual(obj.params.sessionId, init.sessionId);
  const [ack, itemStarted, itemDone] = wire('compact');
  assert.deepStrictEqual(codec.decode({ ...ack, id: obj.id }), { kind: 'other' });
  assert.deepStrictEqual(codec.decode(itemStarted), { kind: 'other' });
  assert.deepStrictEqual(codec.decode(itemDone), { kind: 'compact', pre: itemDone.params.item.tokensBefore, post: itemDone.params.item.tokensAfter, turnEnd: true });
});

test('a compaction before any init decodes to other; after init the same item is compact', () => {
  const { codec, open } = opened();
  const itemDone = wire('compact').find((m) => m.method === 'item/completed');
  assert.deepStrictEqual(codec.decode(itemDone), { kind: 'other' });
  assert.strictEqual(codec.decode({ ...response('handshake'), id: open[2].id }).kind, 'init');
  assert.strictEqual(codec.decode(itemDone).kind, 'compact');
});

test('a compaction inside a running turn does not end the turn; after turn/completed it does', () => {
  const { codec } = running();
  const itemDone = wire('compact').find((m) => m.method === 'item/completed');
  assert.strictEqual(codec.decode(itemDone).turnEnd, false);
  codec.decode(wire('turn').find((m) => m.method === 'turn/completed'));
  assert.strictEqual(codec.decode(itemDone).turnEnd, true);
});

test('encodeContext clear is a fresh session/start in the same approval mode whose result repoints to the new id and path', () => {
  const [sent] = wire('clear', 'out');
  const { codec, open, init } = started({ readOnly: true });
  const obj = codec.encodeContext('clear');
  assert.strictEqual(obj.method, sent.method);
  assert.strictEqual(obj.params.approvalMode, open[2].params.approvalMode);
  assert.notStrictEqual(obj.params.commandId, open[2].params.commandId);
  const next = codec.decode({ ...response('clear'), id: obj.id });
  const { session } = response('clear').result;
  assert.deepStrictEqual(next, { kind: 'init', sessionId: session.sessionId, model: session.modelId, slashCommands: [], turnEnd: true, transcriptPath: homePath(session) });
  assert.notStrictEqual(next.sessionId, init.sessionId);
  assert.strictEqual(codec.encodeContext('reload'), null);
  assert.strictEqual(opened().codec.encodeContext('compact'), null);
});

test('approval/requested decodes to a permission-request with the offered choices mapped 1:1, and no send', () => {
  const { codec } = started();
  const [req] = wire('approvals');
  assert.deepStrictEqual(codec.decode(req), {
    kind: 'permission-request',
    id: '01a0d3ef-2e97-78f3-8f30-6ed16946292c',
    toolName: 'bash',
    displayName: 'bash',
    description: 'in /private/tmp/t8-muse/work/D-approvals',
    preview: 'touch cmd-b.txt',
    input: { command: 'touch cmd-b.txt', description: 'Run touch cmd-b' },
    choices: [
      { id: 'allow_once', label: 'Allow once', kind: 'allow' },
      { id: 'allow_local_prefix', label: 'Always allow in this workspace: touch ...', kind: 'allow-always' },
      { id: 'abort', label: 'Reject', kind: 'deny' },
    ],
  });
});

test('rawArgs that do not parse as JSON ride input as { rawArgs }', () => {
  const { codec } = started();
  const [req] = wire('approvals');
  const rec = codec.decode({ ...req, params: { ...req.params, rawArgs: 'not json' } });
  assert.deepStrictEqual(rec.input, { rawArgs: 'not json' });
});

test('encodePermission sends approval/decide with the chosen choice and the requirement id as received, once', () => {
  const [req] = wire('approvals');
  const [captured] = wire('approvals', 'out');
  for (const choiceId of ['allow_once', 'allow_local_prefix', 'abort']) {
    const { codec } = started();
    codec.decode(req);
    const out = codec.encodePermission(req.params.approvalId, choiceId);
    assert.strictEqual(out.method, 'approval/decide');
    assert.match(out.params.commandId, V7_RE);
    assert.deepStrictEqual({ ...out.params, commandId: null }, { ...captured.params, commandId: null, choiceId });
    assert.strictEqual(codec.encodePermission(req.params.approvalId, choiceId), null, 'an answered id is no longer pending');
  }
  const { codec } = started();
  codec.decode(req);
  assert.strictEqual(codec.encodePermission('nope', 'abort'), null, 'an unknown id');
  assert.strictEqual(codec.encodePermission(req.params.approvalId, 'allow_forever'), null, 'a choice the request did not offer');
});

test('a turn result or an init drops pending approvals without answering them', () => {
  const [req] = wire('approvals');
  const h = running();
  h.codec.decode(req);
  assert.deepStrictEqual(h.codec.decode({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId: null, terminal: 'completed' } }), RESULT(false));
  assert.strictEqual(h.codec.encodePermission(req.params.approvalId, 'abort'), null);
  const { codec, open } = opened();
  codec.decode(req);
  assert.strictEqual(codec.decode({ ...response('handshake'), id: open[2].id }).kind, 'init');
  assert.strictEqual(codec.encodePermission(req.params.approvalId, 'abort'), null);
});

test('under bypass an approval is other, but the abort still rides send', () => {
  const { codec } = started({ bypass: true });
  const rec = codec.decode(wire('approvals')[0]);
  assert.strictEqual(rec.kind, 'other');
  assert.strictEqual(rec.send[0].params.choiceId, 'abort');
  assert.strictEqual(codec.encodePermission(wire('approvals')[0].params.approvalId, 'abort'), null);
});

test('-32051 approvalAlreadyResolved on a decide is other with no warning', () => {
  const { codec, warns } = started({ readOnly: true });
  const [req, err] = wire('approval-policy');
  const rec = codec.decode(req);
  const decide = codec.encodePermission(rec.id, 'abort');
  assert.deepStrictEqual(codec.decode({ ...err, id: decide.id }), { kind: 'other' });
  assert.strictEqual(warns.length, 0);
});

test('an error for session/start, turn/start or session/compact is an error result with one warning; anything else is other', () => {
  const [, rejected] = lines('rejected').map((l) => l.m);
  const { codec, warns } = started();
  const turn = codec.encodeUser('hi', []);
  assert.deepStrictEqual(codec.decode({ ...rejected, id: turn.id }), RESULT(true));
  const again = codec.encodeUser('hi', []);
  assert.deepStrictEqual(codec.decode({ ...rejected, id: again.id }), RESULT(true));
  assert.strictEqual(warns.length, 1);
  const compact = codec.encodeContext('compact');
  assert.deepStrictEqual(codec.decode({ ...rejected, id: compact.id }), RESULT(true));
  assert.strictEqual(warns.length, 2);
  const h = opened();
  assert.deepStrictEqual(h.codec.decode({ ...rejected, id: h.open[2].id }), RESULT(true));
  assert.deepStrictEqual(h.codec.decode({ ...rejected, id: h.open[0].id }), { kind: 'other' });
  assert.strictEqual(h.warns.length, 2);
});

test('encodeInterrupt is turn/interrupt for the acked turn, and null with no turn or after it completed', () => {
  const [sent] = wire('interrupt', 'out');
  assert.strictEqual(started().codec.encodeInterrupt(), null);
  const { codec, turn } = running();
  const obj = codec.encodeInterrupt();
  assert.strictEqual(obj.method, sent.method);
  assert.deepStrictEqual(Object.keys(obj.params).sort(), Object.keys(sent.params).sort());
  assert.strictEqual(obj.params.turnId, response('turn').result.turnId);
  assert.notStrictEqual(obj.params.commandId, turn.params.commandId);
  codec.decode(wire('turn').find((m) => m.method === 'turn/completed'));
  assert.strictEqual(codec.encodeInterrupt(), null);
});

test('decode tolerates junk', () => {
  const { codec } = started();
  for (const junk of [null, 'x', [], {}, { id: 99, result: {} }, { id: 5, method: 'approval/request', params: {} }]) {
    assert.deepStrictEqual(codec.decode(junk), { kind: 'other' });
  }
});

test('the turn/completed an interrupt produces drops a pending approval', () => {
  const [req] = wire('approvals');
  const h = running();
  h.codec.decode(req);
  assert.deepStrictEqual(h.codec.decode(wire('interrupt').find((m) => m.method === 'turn/completed')), RESULT(false));
  assert.strictEqual(h.codec.encodePermission(req.params.approvalId, 'abort'), null);
});
