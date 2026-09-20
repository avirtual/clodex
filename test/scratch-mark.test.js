'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpRoot } = require('./lib/tmp-roots');
const {
  ACK_PREFIX,
  nonce,
  parseTranscriptTail,
  boundaryAt,
  beginCutAt,
  classifyUserRecord,
  cutStats,
  validateScratchCut,
  scratchBriefing,
  scratchReArmLine,
  SCRATCH_NOTELESS_SENTENCE,
} = require('../scratch-mark');

const SID = '5196a6e4-1111-2222-3333-444455556666';
const ROOT = mkTmpRoot('scratch-mark-');

let uuidSeq = 0;
const uuid = () => `u${String(++uuidSeq).padStart(4, '0')}-0000-0000-0000-000000000000`;

class Tape {
  constructor() {
    this.lines = [];
    this.parent = null;
    this.t = 1789924812000;
  }

  push(obj) {
    this.lines.push(JSON.stringify(obj));
    return this;
  }

  conv(obj) {
    const u = uuid();
    this.push({ parentUuid: this.parent, sessionId: SID, uuid: u, timestamp: new Date(this.t += 1000).toISOString(), ...obj });
    this.parent = u;
    return u;
  }

  sidecar(type, extra = {}) {
    return this.push({ type, sessionId: SID, ...extra });
  }

  prompt(content, extra = {}) {
    return this.conv({ type: 'user', message: { role: 'user', content }, origin: { kind: 'human' }, promptSource: 'typed', ...extra });
  }

  assistantText(text, { stop = 'end_turn', usage = null, id = 'msg_01' } = {}) {
    return this.conv({ type: 'assistant', message: { role: 'assistant', id, stop_reason: stop, content: [{ type: 'text', text }], usage: usage || undefined } });
  }

  assistantToolUse(toolId, { id = 'msg_01' } = {}) {
    return this.conv({ type: 'assistant', message: { role: 'assistant', id, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: {} }] } });
  }

  toolResult(toolId, content = 'ok') {
    return this.conv({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] } });
  }

  turnEnd() {
    return this.conv({ type: 'system', subtype: 'turn_duration', durationMs: 4200 });
  }

  turn(text, { toolId = null, usage = null } = {}) {
    if (toolId) {
      this.assistantToolUse(toolId);
      this.toolResult(toolId);
    }
    this.assistantText(text, { usage });
    return this.turnEnd();
  }

  get bytes() {
    return Buffer.from(this.lines.map((l) => `${l}\n`).join(''), 'utf8');
  }

  get size() {
    return this.bytes.length;
  }
}

const USAGE = (read, write, input) => ({
  input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write,
});

function markFrom(tape, n, leafUuid, extra = {}) {
  const buf = tape.bytes;
  return {
    nonce: n,
    realpath: path.join(ROOT, `${SID}.jsonl`),
    sessionId: SID,
    sizeAtBegin: buf.length,
    tailBytes: buf.subarray(Math.max(0, buf.length - 512)),
    leafUuid,
    beganAt: 1789924812000,
    arrivals: [],
    dispatched: [],
    usageAtBegin: { cacheRead: 40000, cacheWrite: 1000, input: 20 },
    ...extra,
  };
}

function prefix() {
  const tape = new Tape();
  tape.prompt('find the bug');
  tape.turn('here is what I found', { toolId: 'toolu_a1', usage: USAGE(30000, 900, 12) });
  tape.prompt('keep going');
  const leaf = tape.turn('done', { toolId: 'toolu_a2', usage: USAGE(40000, 1000, 20) });
  return { tape, leaf };
}

function ack(tape, n) {
  return tape.prompt(`${ACK_PREFIX}${n}. Research now. Close with \`[agent:scratch end] <summary>\`.`);
}


test('parseTranscriptTail: offsets are absolute file offsets, sidecars are not conversation', () => {
  const tape = new Tape();
  tape.prompt('hi');
  tape.sidecar('file-history-snapshot', { snapshot: {} });
  tape.assistantText('hello');
  tape.turnEnd();

  const { records, undecodable, partialHead } = parseTranscriptTail(tape.bytes);
  assert.strictEqual(undecodable, 0);
  assert.strictEqual(partialHead, null);
  assert.deepStrictEqual(records.map((r) => r.type), ['user', 'file-history-snapshot', 'assistant', 'system']);
  assert.deepStrictEqual(records.map((r) => r.conversation), [true, false, true, true]);

  const buf = tape.bytes;
  for (const r of records) {
    assert.strictEqual(buf.subarray(r.offset, r.offset + r.byteLength).toString('utf8'), JSON.stringify(r.record),
      'the offset must name the first byte of that record\'s own line, or a cut at it lands mid-line');
  }
});

test('parseTranscriptTail: a baseOffset read reports a severed head line instead of counting it undecodable', () => {
  const tape = new Tape();
  tape.prompt('hi');
  tape.assistantText('hello');
  const buf = tape.bytes;
  const from = 10;

  const whole = parseTranscriptTail(buf.subarray(from), { baseOffset: from });
  assert.strictEqual(whole.undecodable, 0, 'a 64KB tail read almost always starts mid-line — that is not corruption');
  assert.ok(whole.partialHead, 'and the caller is told a record was severed');
  assert.strictEqual(whole.partialHead.offset, from);
  assert.deepStrictEqual(whole.records.map((r) => r.type), ['assistant']);
  assert.strictEqual(whole.records[0].offset, buf.indexOf('{"parentUuid":"u', 5),
    'the surviving record keeps its ABSOLUTE offset, not one relative to the slice');
});

test('parseTranscriptTail: a corrupt line MID-buffer is counted, not silently dropped', () => {
  const buf = Buffer.from(`${JSON.stringify({ type: 'user', message: { content: 'a' } })}\nnot json\n${JSON.stringify({ type: 'assistant' })}\n`, 'utf8');
  const { records, undecodable, partialHead } = parseTranscriptTail(buf);
  assert.strictEqual(undecodable, 1);
  assert.strictEqual(partialHead, null, 'only the FIRST line of a baseOffset read is forgiven');
  assert.strictEqual(records.length, 2);
});

test('parseTranscriptTail: a JSON scalar or array is not a record', () => {
  const buf = Buffer.from('42\n["a"]\n"str"\n', 'utf8');
  const { records, undecodable } = parseTranscriptTail(buf);
  assert.deepStrictEqual(records, []);
  assert.strictEqual(undecodable, 3, 'a bare scalar parses as JSON but has no type — treating it as a record would give it offset authority');
});


test('boundaryAt: turn_duration is a boundary, and sidecars after it do not hide it', () => {
  const tape = new Tape();
  tape.turn('done');
  tape.sidecar('last-prompt', { content: 'x' });
  tape.sidecar('cost-state', {});
  tape.sidecar('file-history-snapshot', { snapshot: {} });

  const b = boundaryAt(parseTranscriptTail(tape.bytes).records);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.entry.type, 'system');
  assert.strictEqual(b.entry.record.subtype, 'turn_duration');
});

test('boundaryAt: a bare end_turn assistant (turn_duration not yet written) is a boundary', () => {
  const tape = new Tape();
  tape.assistantText('the reply', { stop: 'end_turn' });
  assert.strictEqual(boundaryAt(parseTranscriptTail(tape.bytes).records).ok, true);
});

test('boundaryAt: an end_turn assistant that ALSO carries a tool_use is not a boundary', () => {
  const tape = new Tape();
  tape.conv({
    type: 'assistant',
    message: { role: 'assistant', id: 'msg_01', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }] },
  });
  const b = boundaryAt(parseTranscriptTail(tape.bytes).records);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'not-a-boundary');
});

test('boundaryAt: the SPLIT text+tool_use pair — the text half alone is not the end of the turn', () => {
  const tape = new Tape();
  tape.assistantText('[agent:scratch begin]', { stop: 'tool_use', id: 'msg_split' });
  const afterText = boundaryAt(parseTranscriptTail(tape.bytes).records);
  assert.strictEqual(afterText.ok, false,
    '2.1.278 writes one API message with text + tool_use as TWO assistant records sharing a message.id, '
    + 'both stop_reason tool_use. The scanner saw the intent in the first one, so reading "the record the '
    + 'scanner saw" as the end of the turn is exactly the mis-cut this case pins');
  assert.strictEqual(afterText.reason, 'not-a-boundary');
  assert.strictEqual(afterText.entry.record.message.stop_reason, 'tool_use');

  tape.assistantToolUse('toolu_split', { id: 'msg_split' });
  assert.strictEqual(boundaryAt(parseTranscriptTail(tape.bytes).records).ok, false,
    'and its tool_use twin is no more a boundary than the text half');
});

test('boundaryAt: a tool_result user record is not a boundary; an empty set is refused with its own reason', () => {
  const tape = new Tape();
  tape.assistantToolUse('toolu_z');
  tape.toolResult('toolu_z');
  const b = boundaryAt(parseTranscriptTail(tape.bytes).records);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'not-a-boundary');

  const empty = boundaryAt(parseTranscriptTail(Buffer.from('')).records);
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'no-conversation-record');
  assert.strictEqual(empty.entry, null);
});


test('classifyUserRecord: the five user shapes', () => {
  const user = (message, extra = {}) => ({ type: 'user', message, ...extra });

  assert.strictEqual(classifyUserRecord(user({ content: 'do the thing' }, { origin: { kind: 'human' }, promptSource: 'typed' })), 'arrival',
    'an operator-typed prompt is an arrival — it is the message the cut would destroy without consent');
  assert.strictEqual(classifyUserRecord(user({ content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] })), 'tool_result');
  assert.strictEqual(classifyUserRecord(user({ content: [{ type: 'text', text: 'image attached' }] }, { isMeta: true, turnCompanion: true })), 'meta');
  assert.strictEqual(classifyUserRecord(user({ content: '<task-notification>\n<task-id>a1</task-id>\n' }, { origin: { kind: 'task-notification' }, promptSource: 'system' })), 'task-notification');
  assert.strictEqual(classifyUserRecord(user({ content: '[agent:exec] clodex-run-tests: own: 5064 pass' }, { origin: { kind: 'human' } })), 'notice',
    'a Clodex bounce about the model\'s OWN intent is droppable');
});

test('classifyUserRecord: `[agent:from ` is an arrival, not a notice — the one prefix that separates them', () => {
  const dm = { type: 'user', message: { content: '[agent:from Codex] the far cwd is wrong' }, origin: { kind: 'human' } };
  assert.strictEqual(classifyUserRecord(dm), 'arrival');
  const bounce = { type: 'user', message: { content: '[agent:scratch] end refused: no episode is open' }, origin: { kind: 'human' } };
  assert.strictEqual(classifyUserRecord(bounce), 'notice');
  assert.strictEqual(classifyUserRecord({ type: 'user', message: { content: 'talking about [agent:from bob] in prose' } }), 'arrival',
    'the prefix is anchored: an intent NAMED mid-prose is operator text');
});

test('classifyUserRecord: promptSource system alone classifies, and a non-user record is null', () => {
  assert.strictEqual(classifyUserRecord({ type: 'user', message: { content: 'x' }, promptSource: 'system' }), 'task-notification',
    'the CLI writes some internal prompts with promptSource system and no origin.kind');
  assert.strictEqual(classifyUserRecord({ type: 'assistant', message: { content: [] } }), null);
  assert.strictEqual(classifyUserRecord(null), null);
  assert.strictEqual(classifyUserRecord({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] }, isMeta: true }), 'tool_result',
    'a tool_result wins over isMeta: it is structurally paired and must never read as an arrival');
});


function beginTurn(tape, text = '[agent:scratch begin]', { id = 'msg_begin' } = {}) {
  tape.prompt('[agent:from lead] find out where the parser lives');
  const cut = tape.assistantText(text, { id });
  tape.turnEnd();
  return cut;
}

function markAtBegin(tape, n, extra = {}) {
  const parsed = parseTranscriptTail(tape.bytes).records;
  const cut = beginCutAt(parsed);
  const buf = tape.bytes;
  return markFrom(tape, n, cut.leaf ? cut.leaf.record.uuid : null, {
    sizeAtBegin: cut.offset,
    tailBytes: buf.subarray(Math.max(0, cut.offset - 512), cut.offset),
    ...extra,
  });
}

test('beginCutAt: the cut starts at the last assistant message, and the leaf is the record before it', () => {
  const { tape } = prefix();
  const promptUuid = tape.prompt('[agent:from lead] go');
  const beginUuid = tape.assistantText('[agent:scratch begin]', { id: 'msg_begin' });
  tape.turnEnd();
  const parsed = parseTranscriptTail(tape.bytes).records;
  const cut = beginCutAt(parsed);
  assert.strictEqual(JSON.parse(tape.bytes.subarray(cut.offset, tape.bytes.indexOf(0x0a, cut.offset)).toString('utf8')).uuid, beginUuid,
    'the first dropped byte is the first byte of the begin reply, not of the ack Clodex wrote a turn later');
  assert.strictEqual(cut.leaf.record.uuid, promptUuid, 'the leaf is the prompt the begin answered — a user record');
});

test('beginCutAt: a reply the CLI split into several assistant records sharing message.id is cut as ONE', () => {
  const { tape } = prefix();
  const promptUuid = tape.prompt('go');
  const thinking = tape.conv({ type: 'assistant', message: { role: 'assistant', id: 'msg_split', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hm' }] } });
  tape.sidecar('file-history-snapshot', { snapshot: {} });
  tape.assistantText('[agent:scratch begin]', { id: 'msg_split' });
  tape.turnEnd();
  const cut = beginCutAt(parseTranscriptTail(tape.bytes).records);
  assert.strictEqual(JSON.parse(tape.bytes.subarray(cut.offset, tape.bytes.indexOf(0x0a, cut.offset)).toString('utf8')).uuid, thinking,
    'a kept thinking-only half would be an assistant turn with no text');
  assert.strictEqual(cut.leaf.record.uuid, promptUuid);
  assert.strictEqual(beginCutAt(parseTranscriptTail(Buffer.from('')).records), null);
});

test('validateScratchCut: a clean episode cuts at the FIRST BYTE of the begin reply, and the ack is inside the dropped range', () => {
  const { tape } = prefix();
  const n = 's7f3a1';
  tape.prompt('[agent:from lead] find out where the parser lives');
  const keptBytes = tape.bytes;
  const beginUuid = tape.assistantText('[agent:scratch begin]', { id: 'msg_begin' });
  tape.turnEnd();
  const mark = markAtBegin(tape, n);

  const ackUuid = ack(tape, n);
  tape.turn('read three files', { toolId: 'toolu_b1', usage: USAGE(61000, 4000, 30) });
  tape.prompt('[agent:scratch end] summary');

  const buf = tape.bytes;
  const res = validateScratchCut(mark, buf, { realpath: mark.realpath, body: 'summary' });
  assert.strictEqual(res.ok, true, res.detail);
  assert.strictEqual(res.reason, null);
  assert.strictEqual(res.cutOffset, mark.sizeAtBegin, 'the cut point is the offset the mark recorded');

  const cutLine = JSON.parse(buf.subarray(res.cutOffset, buf.indexOf(0x0a, res.cutOffset)).toString('utf8'));
  assert.strictEqual(cutLine.uuid, beginUuid, 'the first DROPPED byte is the first byte of the reply that carried begin');
  assert.strictEqual(buf[res.cutOffset - 1], 0x0a, 'and the byte before it is a newline — the kept prefix ends whole');
  const kept = buf.subarray(0, res.cutOffset).toString('utf8');
  assert.ok(!kept.includes('[agent:scratch begin]'), 'the begin reply is gone');
  assert.ok(!kept.includes(ACK_PREFIX), 'and so is the ack');
  assert.ok(kept.includes('find out where the parser lives'), 'while the prompt that begin answered is kept');
  assert.strictEqual(kept, keptBytes.toString('utf8'), 'the kept set is byte-exact the file up to the begin reply');
  assert.ok(buf.subarray(res.cutOffset).toString('utf8').includes(`${ACK_PREFIX}${n}`),
    'the ack is found in the DROPPED range — it proves the episode opened, it is not the cut point');
  assert.strictEqual(JSON.parse(kept.trim().split('\n').pop()).message.content, '[agent:from lead] find out where the parser lives',
    'the kept file ends on the user record the begin answered');
  assert.deepStrictEqual(res.arrivals, [], 'that prompt, being kept, is not an arrival');
  assert.ok(ackUuid);
});

test('validateScratchCut: sidecars between the begin reply and the ack are dropped with it — the cut is one offset', () => {
  const { tape } = prefix();
  const n = 'sid001';
  beginTurn(tape);
  const mark = markAtBegin(tape, n);

  tape.sidecar('file-history-snapshot', { snapshot: {} });
  tape.sidecar('queue-operation', { operation: 'enqueue', content: 'x' });
  tape.sidecar('cost-state', { cost: 1 });
  tape.sidecar('last-prompt', { content: 'x' });
  ack(tape, n);
  tape.turn('research');
  tape.sidecar('cost-state', { cost: 2 });

  const buf = tape.bytes;
  const res = validateScratchCut(mark, buf, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, true, res.detail);
  assert.strictEqual(res.cutOffset, mark.sizeAtBegin);
  assert.strictEqual(res.stats.records.byType.sidecar, 5,
    'the four sidecars the CLI wrote between the begin reply and the ack sit past sizeAtBegin, so they go '
    + 'with the episode; they are latest-state records with no uuid, so dropping them costs nothing');
  assert.strictEqual(res.stats.records.byType.assistant, 2, 'the begin reply and the research reply');
});

test('validateScratchCut: the kept set may end on a tool_result — the reply that carried begin came after tool calls', () => {
  const { tape } = prefix();
  tape.prompt('go');
  tape.assistantToolUse('toolu_pre', { id: 'msg_pre' });
  const resultUuid = tape.toolResult('toolu_pre');
  tape.assistantText('[agent:scratch begin]', { id: 'msg_begin' });
  tape.turnEnd();
  const n = 'res001';
  const mark = markAtBegin(tape, n);
  assert.strictEqual(mark.leafUuid, resultUuid);
  ack(tape, n);
  tape.turn('research');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, true, res.detail);
  assert.strictEqual(boundaryAt(parseTranscriptTail(tape.bytes).records.filter((e) => e.offset < res.cutOffset)).ok, false,
    'boundaryAt alone would refuse a user leaf: the cut accepts one because its tool pairing was checked and the '
    + 'next record appended is a user turn anyway');
});


test('validateScratchCut REFUSES a split text+tool_use pair at the boundary', () => {
  const tape = new Tape();
  tape.prompt('go');
  tape.turn('done');
  const leaf = tape.assistantText('[agent:scratch begin]', { stop: 'tool_use', id: 'msg_split' });
  const n = 'spl001';
  const mark = markFrom(tape, n, leaf);
  tape.assistantToolUse('toolu_split', { id: 'msg_split' });
  tape.toolResult('toolu_split');
  ack(tape, n);
  tape.turn('research');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not-a-boundary');
  assert.match(res.detail, /not a turn boundary/);
  assert.strictEqual(res.cutOffset, null, 'a refusal hands back no offset — there is nothing safe to write');
});

test('validateScratchCut REFUSES an orphaned tool_use in the kept set — the silent-repair case', () => {
  const tape = new Tape();
  tape.prompt('go');
  tape.assistantToolUse('toolu_orphan');
  tape.assistantText('interrupted, moving on', { stop: 'end_turn' });
  const leaf = tape.turnEnd();
  const n = 'orp001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.turn('research');

  assert.strictEqual(boundaryAt(parseTranscriptTail(tape.bytes).records.filter((e) => e.offset < mark.sizeAtBegin)).ok, true,
    'ENTER: the kept set IS a turn boundary, so the refusal below can only come from the pairing scan');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, false,
    'the CLI does not complain on resume: it re-parents the orphan and fabricates a `No response requested.` '
    + 'assistant turn, which nothing downstream can see. This refusal is the reason the module exists');
  assert.strictEqual(res.reason, 'orphaned-tool-use');
  assert.match(res.detail, /toolu_orphan/, 'the refusal names the block, so the bounce can say which call it was');
  assert.strictEqual(res.cutOffset, null);
});

test('validateScratchCut: a tool_use whose RESULT is also kept is not an orphan', () => {
  const { tape, leaf } = prefix();
  const n = 'pai001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.assistantToolUse('toolu_inside');
  tape.toolResult('toolu_inside');
  tape.turn('research');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, true,
    `both halves sit INSIDE the episode and are dropped together, so the pairing scan must run over the KEPT `
    + `set and not the whole file — a whole-file scan sees the pair and a kept-set scan sees neither: ${res.detail}`);
});

test('validateScratchCut REFUSES a compact summary after the mark', () => {
  const { tape, leaf } = prefix();
  const n = 'cmp001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.turn('research');
  tape.conv({ type: 'user', message: { role: 'user', content: 'summary of the conversation' }, isCompactSummary: true });
  tape.turn('post-compact');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'compacted');
  assert.match(res.detail, /compact landed inside the episode/);
});

test('validateScratchCut REFUSES a realpath that moved — the /clear case', () => {
  const { tape, leaf } = prefix();
  const n = 'clr001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.turn('research');

  const res = validateScratchCut(mark, tape.bytes, { realpath: path.join(ROOT, 'a-different-session.jsonl'), body: 's' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'cleared');
  assert.match(res.detail, /a-different-session\.jsonl/);

  assert.strictEqual(validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' }).ok, true,
    'ENTER: the same tape passes when the realpath still matches, so the refusal above is the realpath and nothing else');
});

test('validateScratchCut REFUSES a sessionId that changed under the same path', () => {
  const { tape, leaf } = prefix();
  const n = 'sess01';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.conv({ type: 'assistant', sessionId: 'ffffffff-0000-0000-0000-000000000000', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } });

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'cleared');
  assert.match(res.detail, /ffffffff/);
});

test('validateScratchCut REFUSES a tailBytes mismatch — the prefix was rewritten under us', () => {
  const { tape, leaf } = prefix();
  const n = 'tai001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.turn('research');

  const buf = tape.bytes;
  const tampered = Buffer.from(buf);
  tampered[mark.sizeAtBegin - 40] = 0x20;

  const res = validateScratchCut(mark, tampered, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'rewritten');
  assert.match(res.detail, /no longer starts with what was marked/);

  const shrunk = validateScratchCut(mark, buf.subarray(0, mark.sizeAtBegin - 10), { realpath: mark.realpath, body: 's' });
  assert.strictEqual(shrunk.reason, 'rewritten', 'a file SHORTER than the mark is the same class and must not index off the end');
});

test('validateScratchCut REFUSES when the ack never landed, and when two acks did', () => {
  const { tape, leaf } = prefix();
  const n = 'ack001';
  const mark = markFrom(tape, n, leaf);
  tape.turn('the seat kept working, the ack was parked');

  const missing = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, 'ack-missing');
  assert.match(missing.detail, /ack001/);

  ack(tape, n);
  tape.turn('research');
  ack(tape, n);
  const dupe = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(dupe.reason, 'ack-duplicate');
  assert.match(dupe.detail, /2 acks/);
});

test('validateScratchCut: an ack for a DIFFERENT nonce does not close this episode', () => {
  const { tape, leaf } = prefix();
  const mark = markFrom(tape, 'mine01', leaf);
  ack(tape, 'other1');
  tape.turn('research');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.reason, 'ack-missing',
    'the nonce is what makes the cut point self-describing; matching on the prefix alone would cut at a re-opened episode');
});

test('validateScratchCut REFUSES when the last kept record is not the marked leaf', () => {
  const { tape, leaf } = prefix();
  const mark = markFrom(tape, 'lea001', leaf, { leafUuid: 'u9999-0000-0000-0000-000000000000' });
  ack(tape, 'lea001');
  tape.turn('research');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'leaf-mismatch');
  assert.match(res.detail, /u9999/);
  assert.notStrictEqual(leaf, 'u9999-0000-0000-0000-000000000000');
});


test('validateScratchCut REFUSES on arrivals, reports them, and proceeds under replay', () => {
  const { tape, leaf } = prefix();
  const n = 'arr001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.prompt('[agent:from Codex] the far cwd is wrong');
  tape.turn('research', { toolId: 'toolu_c1' });
  tape.prompt('[agent:exec] clodex-run-tests: own: 5064 pass');
  tape.prompt('<task-notification>\n<task-id>a1</task-id>', { origin: { kind: 'task-notification' }, promptSource: 'system' });
  tape.prompt('also check the other branch');
  tape.turn('more research');

  const refused = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'arrivals');
  assert.strictEqual(refused.arrivals.length, 2, 'the exec bounce and the task-notification are droppable; the dm and the operator line are not');
  assert.deepStrictEqual(refused.arrivals.map((a) => a.text), ['[agent:from Codex] the far cwd is wrong', 'also check the other branch']);
  assert.ok(refused.arrivals.every((a) => a.at), 'each arrival carries its timestamp, so the bounce can say when it came');
  assert.ok(refused.arrivals[0].offset < refused.arrivals[1].offset, 'in transcript order — replay re-delivers them in it');
  assert.strictEqual(refused.cutOffset, null,
    'refused means refused: a caller that read cutOffset off an arrivals refusal would cut the operator\'s message away');
  assert.ok(refused.stats, 'but the stats ride along, so the bounce can say what the cut WOULD have dropped');

  const replayed = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's', replay: true });
  assert.strictEqual(replayed.ok, true, replayed.detail);
  assert.deepStrictEqual(replayed.arrivals.map((a) => a.text), refused.arrivals.map((a) => a.text));
});

test('validateScratchCut: the dispatch-token check — end is refused until the summary names what was dispatched', () => {
  const { tape, leaf } = prefix();
  const n = 'dsp001';
  const mark = markFrom(tape, n, leaf, {
    dispatched: [{ type: 'task', sub: 'add', token: 't1041', at: 1 }, { type: 'spawn', sub: null, token: 'scout-2', at: 2 }],
  });
  ack(tape, n);
  tape.turn('research');

  const half = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 'I dispatched scout-2 to survey the tree.' });
  assert.strictEqual(half.ok, false);
  assert.strictEqual(half.reason, 'dispatch-unmentioned');
  assert.match(half.detail, /t1041/);
  assert.ok(!half.detail.includes('scout-2'), 'only the UNMENTIONED tokens are named — the model is told what is missing, not what it did');

  const full = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 'What I did: opened t1041 for the fix, spawned scout-2 to survey.' });
  assert.strictEqual(full.ok, true, full.detail);

  const none = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: '' });
  assert.strictEqual(none.reason, 'dispatch-unmentioned', 'an empty body mentions nothing');
  assert.match(none.detail, /t1041, scout-2/);
});


test('cutStats: tokens come from message.usage, atBegin from the mark', () => {
  const { tape, leaf } = prefix();
  const n = 'tok001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.turn('read a lot', { toolId: 'toolu_d1', usage: USAGE(61000, 4000, 30) });
  tape.turn('read more', { toolId: 'toolu_d2', usage: USAGE(98000, 2000, 40) });

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.ok, true, res.detail);
  assert.strictEqual(res.stats.tokens.atBegin, 41020, 'cacheRead + cacheWrite + input off the mark');
  assert.strictEqual(res.stats.tokens.atCut, 100040, 'the last assistant usage in the file');
  assert.strictEqual(res.stats.tokens.dropped, 59020);

  const buf = tape.bytes;
  assert.strictEqual(res.stats.bytes.before, buf.length);
  assert.strictEqual(res.stats.bytes.kept, res.cutOffset);
  assert.strictEqual(res.stats.bytes.dropped, buf.length - res.cutOffset);
  assert.strictEqual(res.stats.records.byType.assistant, 4, 'two tool_use records and two replies inside the episode');
  assert.strictEqual(res.stats.records.toolResults, 2);
  assert.ok(res.stats.records.toolResultBytes > 0);
});

test('cutStats: with no mark usage it falls back to the last KEPT assistant record', () => {
  const { tape, leaf } = prefix();
  const mark = markFrom(tape, 'fbk001', leaf, { usageAtBegin: null });
  ack(tape, 'fbk001');
  tape.turn('research', { usage: USAGE(70000, 1000, 5) });

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's' });
  assert.strictEqual(res.stats.tokens.atBegin, 41020, 'prefix()\'s last pre-mark assistant usage — 40000 + 1000 + 20');
  assert.strictEqual(res.stats.tokens.atCut, 71005);
});

test('cutStats: tokens are NULL, never zero, when no usage can be read', () => {
  const stats = cutStats({ parsed: [], cutOffset: 0, size: 0, mark: null });
  assert.deepStrictEqual(stats.tokens, { atBegin: null, atCut: null, dropped: null },
    'a zero here would read as "nothing was dropped" in the measurement row, which is a claim the data does not support');
  assert.deepStrictEqual(stats.bytes, { before: 0, kept: 0, dropped: 0 });
});

test('cutStats: a mark with an EMPTY usageAtBegin gives null tokens, not zero', () => {
  const stats = cutStats({ parsed: [], cutOffset: 0, size: 0, mark: { usageAtBegin: {} } });
  assert.strictEqual(stats.tokens.atBegin, null,
    'the `mark: null` case above returns null through a different door — markUsageTotal bails on '
    + 'the absent object — so it stays green against a markUsageTotal that sums an empty usage to '
    + '0. This is the case that reds: a 0 here means "the episode began at zero context", which no '
    + 'episode ever does');
  assert.strictEqual(stats.tokens.dropped, null, 'and dropped stays null rather than becoming atCut');

  const partial = cutStats({ parsed: [], cutOffset: 0, size: 0, mark: { usageAtBegin: { cacheRead: 40000 } } });
  assert.strictEqual(partial.tokens.atBegin, 40000,
    'while ONE finite field is enough to resolve the total — the absent siblings count as zero, '
    + 'which is what an absent usage field means');
});

test('cutStats: turns.dropped counts string-content prompts only, and background tasks are logged', () => {
  const { tape, leaf } = prefix();
  const n = 'cnt001';
  const mark = markFrom(tape, n, leaf);
  ack(tape, n);
  tape.turn('research', { toolId: 'toolu_e1' });
  tape.prompt('[agent:from bob] a dm');
  tape.prompt('<task-notification>\n<task-id>a1</task-id>', { origin: { kind: 'task-notification' }, promptSource: 'system' });
  tape.prompt('an image rode along', { isMeta: true, turnCompanion: true });
  tape.sidecar('queue-operation', { operation: 'enqueue', content: '<task-notification>\n<task-id>bg1</task-id>' });
  tape.sidecar('queue-operation', { operation: 'dequeue', content: 'plain' });
  tape.turn('more');

  const res = validateScratchCut(mark, tape.bytes, { realpath: mark.realpath, body: 's', replay: true });
  assert.strictEqual(res.ok, true, res.detail);
  assert.strictEqual(res.stats.turns.dropped, 3, 'the ack, the dm and the task-notification — not the tool_result, not the isMeta attachment');
  assert.strictEqual(res.stats.records.backgroundTasksDropped, 1, 'only the ENQUEUE of a task-notification counts');
  assert.strictEqual(res.stats.records.byType.sidecar, 2);
});


test('scratchBriefing: real numbers, the operator framing, and the body verbatim', () => {
  const mark = { nonce: 's7f3a1', beganAt: Date.UTC(2026, 8, 20, 18, 24) };
  const stats = { turns: { dropped: 14 }, bytes: { dropped: 212 * 1024 } };
  const body = 'What I now know: the bail moved to format.js:41.\nWhat I did: opened t1041.';

  const out = scratchBriefing(mark, stats, body, {
    endedAt: Date.UTC(2026, 8, 20, 18, 31),
    formatTime: (ms) => new Date(ms).toISOString().slice(11, 16),
  });

  assert.ok(out.includes('mark s7f3a1'));
  assert.ok(out.includes('opened this episode at 18:24 and closed it at 18:31'));
  assert.ok(out.includes('14 turns / 212 KB'), 'the numbers are computed, not a template placeholder');
  assert.ok(out.includes('delivered as given facts: what it does not state, you have not verified'),
    'the operator-side framing is the whole point — "as you recall" invites the model to remember what the summary does not carry');
  assert.ok(out.endsWith(`\n\n${body}`), 'the body is last and verbatim, so a spill pointer can be sliced off the header');
});

test('scratchBriefing: an empty or missing body still produces a header', () => {
  const mark = { nonce: 'x1', beganAt: 0 };
  for (const body of [null, undefined, '']) {
    const out = scratchBriefing(mark, { turns: { dropped: 0 }, bytes: { dropped: 0 } }, body, { endedAt: 0 });
    assert.ok(out.includes('mark x1'));
    assert.ok(out.endsWith('\n\n'), 'never the string "null" pasted under the header');
  }
});

const ISO_CLOCK = (ms) => new Date(ms).toISOString().slice(11, 16);

test('t1044 scratchBriefing: a labelled mark gets the rewind header, earlier notes, and this note last', () => {
  const mark = { nonce: 's7f3a1', beganAt: Date.UTC(2026, 8, 20, 18, 24), label: 'before-survey' };
  const stats = { turns: { dropped: 14 }, bytes: { dropped: 212 * 1024 } };
  const body = 'What I now know: the bail moved to format.js:41.';
  const notes = [{ at: Date.UTC(2026, 8, 20, 18, 27), body: 'first pass: dead end in the scanner' }];

  const out = scratchBriefing(mark, stats, body, { endedAt: Date.UTC(2026, 8, 20, 18, 31), formatTime: ISO_CLOCK, notes });
  assert.ok(out.startsWith('Scratch rewind result · mark s7f3a1 · label before-survey (delivered by Clodex). '));
  assert.ok(out.includes('You set this mark at 18:24 and rewound to it at 18:31'));
  assert.ok(out.includes('14 turns / 212 KB'));
  assert.ok(out.includes('only the note(s) below survive. They are your own conclusions, delivered as given facts: '
    + 'what they do not state, you have not verified. Continue from them.'));
  assert.ok(out.includes('\n\n[18:27] first pass: dead end in the scanner\n\n'), 'earlier notes carry their own clock');
  assert.ok(out.endsWith(`\n\n[18:31] ${body}`), 'this note is last, stamped with the rewind time');
  assert.ok(!out.includes(SCRATCH_NOTELESS_SENTENCE));
  assert.ok(!out.includes('Notes left at this mark earlier'));

  const first = scratchBriefing(mark, stats, body, { endedAt: Date.UTC(2026, 8, 20, 18, 31), formatTime: ISO_CLOCK });
  assert.ok(first.endsWith(`\n\n[18:31] ${body}`));
  assert.ok(!first.includes('[18:27]'), 'a first rewind has no earlier notes to print');

  const anon = scratchBriefing({ nonce: 's7f3a1', beganAt: mark.beganAt }, stats, body,
    { endedAt: Date.UTC(2026, 8, 20, 18, 31), formatTime: ISO_CLOCK, notes });
  assert.ok(anon.startsWith('Scratch episode result · mark s7f3a1 (delivered by Clodex). '),
    'no label on the mark → the anonymous text, whatever opts carry');
  assert.ok(anon.endsWith(`\n\n${body}`));
});

test('t1044 scratchBriefing: noteless carries the negative-result sentence verbatim and no empty note', () => {
  const mark = { nonce: 'n0te00', beganAt: 0, label: 'L' };
  const stats = { turns: { dropped: 2 }, bytes: { dropped: 3 * 1024 } };
  const out = scratchBriefing(mark, stats, '', { endedAt: 60000, formatTime: ISO_CLOCK, noteless: true });
  assert.strictEqual(out,
    'Scratch rewind result · mark n0te00 · label L (delivered by Clodex). You set this mark at 00:00 and rewound to it '
    + `at 00:01; the 2 turns / 3 KB between them are no longer in your transcript. ${SCRATCH_NOTELESS_SENTENCE}`);
  assert.strictEqual(SCRATCH_NOTELESS_SENTENCE,
    'You left no note: you recorded that stretch as a negative result — nothing in it was worth keeping. '
    + 'Do not repeat it; take a different approach or report the dead end.');
  assert.ok(!out.includes('only the note(s) below survive'));

  const withEarlier = scratchBriefing(mark, stats, '', {
    endedAt: 60000, formatTime: ISO_CLOCK, noteless: true, notes: [{ at: 30000, body: 'earlier note' }],
  });
  assert.ok(withEarlier.endsWith('\n\nNotes left at this mark earlier:\n[00:00] earlier note'),
    'earlier notes still print, under their own heading, when this rewind left none');

  for (const body of [null, undefined, '', '   ']) {
    assert.strictEqual(scratchBriefing(mark, stats, body, { endedAt: 60000, formatTime: ISO_CLOCK }), out,
      `an empty body on a labelled mark is noteless without the flag (${JSON.stringify(body)})`);
  }
});

test('t1044 scratchReArmLine: starts with ACK_PREFIX + nonce, names the label, and stays under 200 bytes', () => {
  const line = scratchReArmLine({ nonce: 'r3arm1', label: 'before-survey' });
  assert.ok(line.startsWith(`${ACK_PREFIX}r3arm1`), 'the validator finds the re-arm by this exact needle');
  assert.ok(line.includes('label before-survey'));
  assert.ok(line.includes('[agent:scratch rewind before-survey] <note>'), 'the only place the agent learns the rewind syntax again');
  assert.ok(!line.includes('\n'), 'one record, one line');
  const longest = scratchReArmLine({ nonce: 'r3arm1', label: 'a'.repeat(32) });
  assert.ok(Buffer.byteLength(longest) <= 200, `${Buffer.byteLength(longest)} bytes`);
});

test('t1044 validateScratchCut: a mark carrying label/notes/operator validates byte-identically to the same mark without them', () => {
  const runs = [];
  for (const extra of [{}, { label: 'before-survey', notes: [{ at: 1, body: 'x' }], operator: false }]) {
    uuidSeq = 0;
    const { tape } = prefix();
    const n = 'lbl001';
    tape.prompt('[agent:from lead] find out where the parser lives');
    tape.assistantText('[agent:scratch mark before-survey]', { id: 'msg_begin' });
    tape.turnEnd();
    const mark = markAtBegin(tape, n, extra);
    ack(tape, n);
    tape.turn('read three files', { toolId: 'toolu_b1', usage: USAGE(61000, 4000, 30) });
    const buf = tape.bytes;
    const ok = validateScratchCut(mark, buf, { realpath: mark.realpath, body: 'note' });
    assert.strictEqual(ok.ok, true, ok.detail);
    const missing = validateScratchCut({ ...mark, nonce: 'other1' }, buf, { realpath: mark.realpath, body: 'note' });
    assert.strictEqual(missing.reason, 'ack-missing');
    const dispatched = validateScratchCut({ ...mark, dispatched: [{ type: 'task', sub: 'add', token: 't1', at: 1 }] },
      buf, { realpath: mark.realpath, body: '' });
    assert.strictEqual(dispatched.reason, 'dispatch-unmentioned', 'an empty note still cannot hide a dispatch');
    runs.push(JSON.stringify([ok, missing, dispatched]));
  }
  assert.strictEqual(runs[0], runs[1], 'the validator never reads label, notes or operator');
});

test('t1044: validateScratchCut is byte-identical to the base — named marks changed nothing inside it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scratch-mark.js'), 'utf8');
  const fn = src.slice(src.indexOf('function validateScratchCut('), src.indexOf('function defaultFormatTime('));
  assert.ok(!/label|notes|operator/.test(fn), 'the validator names none of the fields a named mark adds');
});


test('nonce: six base36 chars, from the injected source', () => {
  for (const r of [() => 0, () => 0.999999, Math.random]) {
    const n = nonce(r);
    assert.strictEqual(n.length, 6, `nonce(${r()}) must be six chars — it is searched for verbatim in the ack line`);
    assert.match(n, /^[0-9a-z]{6}$/);
  }
  const many = new Set(Array.from({ length: 200 }, () => nonce()));
  assert.ok(many.size > 190, 'collisions would make two episodes indistinguishable in the same transcript');
});


test('scratch-mark.js requires nothing — fs, paths and the clock are all injected', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scratch-mark.js'), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, [],
    'the validator is fed a Buffer and a realpath by its caller; a require here is the seam that makes it untestable');
});
