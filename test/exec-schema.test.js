// Run: node --test
// Covers exec-schema.js — the [agent:exec] payload validator: the raw-body size
// cap (before JSON.parse), JSON parse errors, the type/required/maxLength/enum
// checks, and the load-bearing `filename` token guard (path-traversal defence).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_MAX_BYTES, FILENAME_RE, isFilenameToken,
  validateAgainstSchema, validateExecDef, parseAndValidate,
  typeToken, payloadForm, commandLines,
} = require('../exec-schema');

// A minimal well-formed def, cloned per test so mutations don't bleed.
const goodDef = () => ({
  argv: ['python3', '/x/writer.py', '/x/inbox'],
  cwd: '/x',
  timeoutMs: 10000,
  maxBytes: 65536,
  schema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'filename' } } },
});

test('validateExecDef: accepts a well-formed def', () => {
  assert.deepStrictEqual(validateExecDef(goodDef(), 'bridge-reply'), { ok: true });
  // name is optional (drawer validates it separately) — def-only check passes.
  assert.deepStrictEqual(validateExecDef(goodDef()), { ok: true });
});

test('validateExecDef: rejects a bad command name (same filename rule as dispatcher)', () => {
  assert.strictEqual(validateExecDef(goodDef(), '../evil').ok, false);
  assert.strictEqual(validateExecDef(goodDef(), '.hidden').ok, false);
  assert.strictEqual(validateExecDef(goodDef(), 'bad/name').ok, false);
});

test('validateExecDef: rejects non-object / missing argv / empty argv', () => {
  assert.strictEqual(validateExecDef(null, 'c').ok, false);
  assert.strictEqual(validateExecDef([1, 2], 'c').ok, false);
  const noArgv = goodDef(); delete noArgv.argv;
  assert.strictEqual(validateExecDef(noArgv, 'c').ok, false);
  const emptyArgv = goodDef(); emptyArgv.argv = [];
  assert.strictEqual(validateExecDef(emptyArgv, 'c').ok, false);
});

test('validateExecDef: rejects non-string / empty argv elements', () => {
  const d1 = goodDef(); d1.argv = ['python3', 42];
  assert.strictEqual(validateExecDef(d1, 'c').ok, false);
  const d2 = goodDef(); d2.argv = ['python3', ''];
  assert.strictEqual(validateExecDef(d2, 'c').ok, false);
});

test('validateExecDef: rejects bad optional field types', () => {
  const badCwd = goodDef(); badCwd.cwd = 5;
  assert.strictEqual(validateExecDef(badCwd, 'c').ok, false);
  const badTimeout = goodDef(); badTimeout.timeoutMs = 0;
  assert.strictEqual(validateExecDef(badTimeout, 'c').ok, false);
  const negTimeout = goodDef(); negTimeout.timeoutMs = -1;
  assert.strictEqual(validateExecDef(negTimeout, 'c').ok, false);
  const badMax = goodDef(); badMax.maxBytes = 'big';
  assert.strictEqual(validateExecDef(badMax, 'c').ok, false);
});

test('validateExecDef: replyStderr must be boolean if present (truthy strings rejected)', () => {
  const on = goodDef(); on.replyStderr = true;
  assert.deepStrictEqual(validateExecDef(on, 'c'), { ok: true });
  const off = goodDef(); off.replyStderr = false;
  assert.deepStrictEqual(validateExecDef(off, 'c'), { ok: true });
  const str = goodDef(); str.replyStderr = 'true';
  assert.strictEqual(validateExecDef(str, 'c').ok, false);
  const num = goodDef(); num.replyStderr = 1;
  assert.strictEqual(validateExecDef(num, 'c').ok, false);
});

test('validateExecDef: requires an object schema (type: object)', () => {
  const noSchema = goodDef(); delete noSchema.schema;
  assert.strictEqual(validateExecDef(noSchema, 'c').ok, false);
  const strSchema = goodDef(); strSchema.schema = { type: 'string' };
  assert.strictEqual(validateExecDef(strSchema, 'c').ok, false);
});

test('isFilenameToken: accepts plain names', () => {
  assert.ok(isFilenameToken('reply-42.json'));
  assert.ok(isFilenameToken('a'));
  assert.ok(isFilenameToken('A_b-c.9'));
  assert.ok(isFilenameToken('x'.repeat(64)));
});

test('isFilenameToken: rejects traversal + dotfiles + slashes + overflow', () => {
  assert.ok(!isFilenameToken('..'));           // parent dir
  assert.ok(!isFilenameToken('.'));            // current dir
  assert.ok(!isFilenameToken('.hidden'));      // leading dot
  assert.ok(!isFilenameToken('../foo'));       // traversal (also has /)
  assert.ok(!isFilenameToken('a/b'));          // path segment
  assert.ok(!isFilenameToken('a\\b'));         // backslash not in class
  assert.ok(!isFilenameToken('x'.repeat(65))); // over 64
  assert.ok(!isFilenameToken(''));             // empty
  assert.ok(!isFilenameToken('a b'));          // space
  assert.ok(!isFilenameToken(42));             // non-string
  assert.ok(!isFilenameToken(null));
});

test('FILENAME_RE is exported and correct shape', () => {
  assert.ok(FILENAME_RE instanceof RegExp);
  assert.ok(FILENAME_RE.test('ok-name.json'));
  assert.ok(!FILENAME_RE.test('bad/name'));
});

test('validateAgainstSchema: object required + properties', () => {
  const schema = {
    type: 'object',
    required: ['id', 'body'],
    properties: {
      id: { type: 'filename' },
      body: { type: 'string', maxLength: 10 },
    },
  };
  assert.deepStrictEqual(validateAgainstSchema(schema, { id: 'r1.json', body: 'hi' }), { ok: true });
  // missing required
  assert.strictEqual(validateAgainstSchema(schema, { id: 'r1.json' }).ok, false);
  // bad filename token
  assert.strictEqual(validateAgainstSchema(schema, { id: '../x', body: 'hi' }).ok, false);
  // maxLength overflow
  assert.strictEqual(validateAgainstSchema(schema, { id: 'r1.json', body: 'way too long' }).ok, false);
});

test('validateAgainstSchema: string enum + number bounds + integer + boolean', () => {
  assert.strictEqual(validateAgainstSchema({ type: 'string', enum: ['a', 'b'] }, 'a').ok, true);
  assert.strictEqual(validateAgainstSchema({ type: 'string', enum: ['a', 'b'] }, 'c').ok, false);
  assert.strictEqual(validateAgainstSchema({ type: 'number', minimum: 0, maximum: 5 }, 3).ok, true);
  assert.strictEqual(validateAgainstSchema({ type: 'number', minimum: 0 }, -1).ok, false);
  assert.strictEqual(validateAgainstSchema({ type: 'integer' }, 2.5).ok, false);
  assert.strictEqual(validateAgainstSchema({ type: 'integer' }, 2).ok, true);
  assert.strictEqual(validateAgainstSchema({ type: 'boolean' }, true).ok, true);
  assert.strictEqual(validateAgainstSchema({ type: 'boolean' }, 'true').ok, false);
});

test('validateAgainstSchema: type mismatch + unknown type fail closed', () => {
  assert.strictEqual(validateAgainstSchema({ type: 'object' }, 'nope').ok, false);
  assert.strictEqual(validateAgainstSchema({ type: 'object' }, [1, 2]).ok, false); // array not object
  assert.strictEqual(validateAgainstSchema({ type: 'string' }, 5).ok, false);
  assert.strictEqual(validateAgainstSchema({ type: 'weird' }, 'x').ok, false);
  assert.strictEqual(validateAgainstSchema(null, 'x').ok, false);
});

test('validateAgainstSchema: additionalProperties false rejects extras', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.strictEqual(validateAgainstSchema(schema, { a: 'x' }).ok, true);
  assert.strictEqual(validateAgainstSchema(schema, { a: 'x', b: 'y' }).ok, false);
});

test('validateAgainstSchema: nested object recurses', () => {
  const schema = {
    type: 'object',
    required: ['meta'],
    properties: {
      meta: { type: 'object', required: ['name'], properties: { name: { type: 'filename' } } },
    },
  };
  assert.strictEqual(validateAgainstSchema(schema, { meta: { name: 'ok.json' } }).ok, true);
  assert.strictEqual(validateAgainstSchema(schema, { meta: { name: '../bad' } }).ok, false);
  assert.strictEqual(validateAgainstSchema(schema, { meta: {} }).ok, false);
});

test('parseAndValidate: happy path returns parsed value', () => {
  const entry = { maxBytes: 4096, schema: { type: 'object', required: ['id'], properties: { id: { type: 'filename' } } } };
  const r = parseAndValidate(entry, '{"id":"r1.json"}');
  assert.deepStrictEqual(r, { ok: true, value: { id: 'r1.json' } });
});

test('parseAndValidate: size cap enforced on RAW body before parse', () => {
  const entry = { maxBytes: 8, schema: { type: 'object' } };
  const r = parseAndValidate(entry, '{"id":"aaaaaaaaaaaa"}'); // > 8 bytes
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /too large/);
});

test('parseAndValidate: default cap when entry omits maxBytes', () => {
  const entry = { schema: { type: 'object' } };
  // A tiny payload always passes the default cap.
  assert.strictEqual(parseAndValidate(entry, '{}').ok, true);
  assert.strictEqual(DEFAULT_MAX_BYTES, 64 * 1024);
});

test('parseAndValidate: invalid JSON is a loud failure', () => {
  const entry = { maxBytes: 4096, schema: { type: 'object' } };
  const r = parseAndValidate(entry, '{not json');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /invalid JSON/);
});

test('parseAndValidate: empty body rejected', () => {
  const entry = { maxBytes: 4096, schema: { type: 'object' } };
  assert.strictEqual(parseAndValidate(entry, '   ').ok, false);
});

test('parseAndValidate: missing schema fails closed', () => {
  const r = parseAndValidate({ maxBytes: 4096 }, '{"id":"x"}');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no schema/);
});

test('parseAndValidate: schema failure surfaces the field error', () => {
  const entry = { maxBytes: 4096, schema: { type: 'object', required: ['id'], properties: { id: { type: 'filename' } } } };
  const r = parseAndValidate(entry, '{"id":"../escape"}');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /filename token/);
});

// ── t81: prompt rendering (typeToken / payloadForm / commandLines) ────────────
// The invariant that matters is not "some text comes out" but that what comes
// out is a payload the VALIDATOR IN THIS FILE actually accepts — so the round-
// trip tests below fill the rendered form in and push it through
// parseAndValidate rather than pattern-matching the string.

test('t81 payloadForm: a fieldless schema renders {} — NOT "no payload"', () => {
  // Load-bearing: parseAndValidate rejects an empty body before it ever looks at
  // the schema, so a no-required-props command is still not callable bare.
  const schema = { type: 'object', additionalProperties: false };
  assert.strictEqual(payloadForm(schema), '{}');
  // and the thing we rendered is exactly the thing that passes:
  assert.strictEqual(parseAndValidate({ schema }, payloadForm(schema)).ok, true);
  assert.strictEqual(parseAndValidate({ schema }, '').ok, false);
});

test('t81 payloadForm: required props render in schema order with typed tokens', () => {
  const schema = {
    type: 'object',
    required: ['action', 'agent'],
    properties: {
      action: { type: 'string', enum: ['roster', 'retire'] },
      agent: { type: 'string' },
    },
  };
  assert.strictEqual(payloadForm(schema), '{"action":"roster|retire","agent":"<string>"}');
});

test('t81 payloadForm: the rendered enum form is COPYABLE — it parses and validates', () => {
  // The first implementation emitted `"action":roster|retire` unquoted, which is
  // not JSON: an agent copying it earns "payload: invalid JSON", the exact
  // failure this ticket exists to stop. This pins the quoting.
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['action', 'agent'],
    properties: {
      action: { type: 'string', enum: ['roster', 'retire', 'tickets'] },
      agent: { type: 'string', maxLength: 64 },
    },
  };
  const filled = payloadForm(schema).replace('"roster|retire|tickets"', '"roster"').replace('"<string>"', '"me"');
  const r = parseAndValidate({ schema }, filled);
  assert.strictEqual(r.ok, true, `rendered form must validate, got: ${r.error}`);
  assert.deepStrictEqual(r.value, { action: 'roster', agent: 'me' });
});

test('t81 payloadForm: optional props are listed by NAME only, after the form', () => {
  const schema = {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string' },
      target: { type: 'string' },
      cwd: { type: 'string' },
    },
  };
  assert.strictEqual(payloadForm(schema), '{"action":"<string>"} optional: target, cwd');
});

test('t81 typeToken: every leaf type the validator supports has a token', () => {
  // Guards the drift this file exists to prevent: a type validateAgainstSchema
  // accepts but typeToken does not know renders as an unhelpful <value>.
  assert.strictEqual(typeToken({ type: 'string' }), '"<string>"');
  assert.strictEqual(typeToken({ type: 'filename' }), '"<filename>"');
  assert.strictEqual(typeToken({ type: 'number' }), '<number>');
  assert.strictEqual(typeToken({ type: 'integer' }), '<int>');
  assert.strictEqual(typeToken({ type: 'boolean' }), '<bool>');
  assert.strictEqual(typeToken({ type: 'object' }), '{...}');
  // enum wins over type, and carries its own quotes
  assert.strictEqual(typeToken({ type: 'string', enum: ['a', 'b'] }), '"a|b"');
});

test('t81 commandLines: a bare id string degrades to the id-only line', () => {
  // session-manager passes resolved summaries, but a def that cannot be read
  // falls back to the string — the grant is real, so the command must still list.
  assert.strictEqual(commandLines('clodex-run-tests'), '  [agent:exec clodex-run-tests]');
});

test('t81 commandLines: a description renders on its own line; absent = no line', () => {
  const schema = { type: 'object' };
  const withDesc = commandLines({ name: 'c', schema, description: 'Does a thing.' });
  assert.strictEqual(withDesc, '  [agent:exec c] {}\n      Does a thing.');
  // No description => exactly one line. Descriptions are operator-authored; an
  // invented one would be worse than silence.
  assert.strictEqual(commandLines({ name: 'c', schema }), '  [agent:exec c] {}');
  assert.strictEqual(commandLines({ name: 'c', schema, description: '   ' }), '  [agent:exec c] {}');
});

test('t81 commandLines: argv and cwd NEVER reach the rendered line', () => {
  // Defs carry absolute paths; the prompt is not a place for them.
  const line = commandLines({
    name: 'c', schema: { type: 'object' }, description: 'ok',
    argv: ['/usr/bin/env', 'node', '/Users/someone/secret/path.js'], cwd: '/Users/someone/secret',
  });
  assert.ok(!line.includes('/Users/someone'), 'no filesystem path in the prompt line');
  assert.ok(!line.includes('argv'), 'no argv in the prompt line');
});

test('t81 validateExecDef: description is optional, string, and length-capped', () => {
  const d = goodDef();
  assert.strictEqual(validateExecDef(d).ok, true, 'absent description stays valid');
  d.description = 'A short line.';
  assert.strictEqual(validateExecDef(d).ok, true);
  d.description = 12345;
  const bad = validateExecDef(d);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /description/);
  d.description = 'x'.repeat(201);
  assert.strictEqual(validateExecDef(d).ok, false, 'over-long description rejected (prompt bytes are forever)');
});
