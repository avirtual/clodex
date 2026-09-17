'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { maskSecrets } = require('../log-mask');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const HOSTS = ['main.js', 'headless-main.js'];

function loadWriteLog(file, logFile) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = src.indexOf('function writeLog(');
  assert.notStrictEqual(start, -1, `${file}: no \`function writeLog(\` found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notStrictEqual(end, -1, `${file}: unterminated writeLog body`);
  const body = src.slice(start, end + 1);
  const stdout = [];
  const fake = { write: (s) => { stdout.push(s); } };
  const fn = new Function(
    'fs', 'LOG_FILE', 'REGISTRY_DIR', 'ensureDir', 'maskSecrets', 'process',
    `${body}; return writeLog;`,
  )(fs, logFile, path.dirname(logFile), () => {}, maskSecrets,
    { stdout: fake, stderr: fake });
  return { fn, stdout };
}

const SECRET = 'abc123';
const CASES = [
  ['a key/value credential', `remote token=${SECRET} accepted`],
  ['an Authorization header', `Authorization: Bearer ${SECRET}`],
  ['a URL password', `dialling postgres://u:${SECRET}@db.example.com/main`],
  ['a credential query parameter', `fetching https://api.example.com/x?sig=${SECRET}`],
];

for (const host of HOSTS) {
  test(`${host}: writeLog masks the message before it reaches the log file`, () => {
    const dir = mkTmpRoot('t959-hostlog-');
    const logFile = path.join(dir, 'clodex.log');
    const { fn, stdout } = loadWriteLog(host, logFile);
    for (const [, message] of CASES) fn('INFO', 'probe', message);

    const written = fs.readFileSync(logFile, 'utf8');
    assert.ok(!written.includes(SECRET),
      `${host}: the raw value reached clodex.log — the mask is not at the write boundary`);
    const lines = written.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, CASES.length, `${host}: one line per call`);
    for (const line of lines) assert.ok(line.includes('[redacted]'), `${host}: ${line} carries no marker`);
    assert.ok(lines[0].includes('INFO') && lines[0].includes('[probe]'),
      `${host}: level and tag still reach the line — masking must not eat the frame`);
    if (stdout.length) {
      assert.ok(!stdout.join('').includes(SECRET),
        `${host}: the value reached the mirrored stdout/stderr stream`);
    }
  });

  test(`${host}: a message with no credential is written verbatim`, () => {
    const dir = mkTmpRoot('t959-hostlog-clean-');
    const logFile = path.join(dir, 'clodex.log');
    const { fn } = loadWriteLog(host, logFile);
    fn('WARN', 'peer', 'handshake retried');
    const line = fs.readFileSync(logFile, 'utf8').trim();
    assert.ok(line.endsWith('WARN  [peer]  handshake retried'),
      `${host}: an ordinary message must survive byte for byte, got ${JSON.stringify(line)}`);
  });
}

test('t959 an agent-written term command reaches the log file masked, with no mask in session-manager', () => {
  const { mk } = require('./lib/session-fixtures');
  const dir = mkTmpRoot('t959-term-');
  const logFile = path.join(dir, 'clodex.log');
  const { fn } = loadWriteLog('headless-main.js', logFile);
  const log = {
    info: (tag, message) => fn('INFO', tag, message),
    warn: (tag, message) => fn('WARN', tag, message),
    error: () => {}, debug: () => {},
  };
  const command = `curl -H 'Authorization: Bearer ${SECRET}' postgres://u:${SECRET}@db.example.com/main`;
  const m = mk({ log, termExec: () => ({ ok: true, command }) });
  m._injectText = () => {};
  m._broadcast = () => {};

  m._handleTermIntent({ name: 'seat', type: 'claude', agentType: 'claude', workspaceId: 'ws' }, 'exec', command);

  const written = fs.readFileSync(logFile, 'utf8');
  assert.ok(written.includes('term exec by seat'), 'ENTER: the intent handler did log the command');
  assert.ok(!written.includes(SECRET),
    'the agent-supplied credential reached clodex.log — the write boundary did not mask it');
  assert.ok(written.includes('[redacted]'), 'and the marker says what was removed');
});

test('both hosts call maskSecrets before appendFileSync, and require the leaf', () => {
  for (const host of HOSTS) {
    const src = fs.readFileSync(path.join(ROOT, host), 'utf8');
    assert.match(src, /require\('\.\/log-mask'\)/,
      `${host}: does not require the mask leaf at all`);
    const start = src.indexOf('function writeLog(');
    const chunk = src.slice(start, src.indexOf('\nconst log = {', start));
    const maskAt = chunk.indexOf('maskSecrets(');
    const appendAt = chunk.indexOf('appendFileSync');
    assert.ok(maskAt !== -1, `${host}: writeLog does not call maskSecrets`);
    assert.ok(maskAt < appendAt,
      `${host}: maskSecrets must run BEFORE the first appendFileSync — masking after the write is no mask`);
  }
});

test('t959 the default openExternal seam logs no query string', () => {
  const src = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  const head = 'const openExternalSeam = seams.openExternal || ';
  const at = src.indexOf(head);
  assert.notStrictEqual(at, -1, 'engine.js: the default openExternal seam was not found');
  const open = at + head.length;
  assert.strictEqual(src[open], '(', 'the default is expected to be a parenthesised arrow');
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notStrictEqual(end, -1, 'engine.js: unterminated openExternal default');
  const lines = [];
  const seam = new Function('log', `return ${src.slice(open, end + 1)};`)({
    info: (tag, message) => lines.push(`${tag}: ${message}`),
  });

  seam('https://files.example.com/report.pdf?X-Amz-Signature=abc123&expires=99');
  assert.strictEqual(lines.length, 1, 'ENTER: the seam logged');
  assert.ok(!lines[0].includes('abc123'), 'the signature must not reach the log');
  assert.ok(!lines[0].includes('?'), 'the whole query goes — the mask enumerates names, this cannot');
  assert.ok(lines[0].includes('https://files.example.com/report.pdf'),
    'the origin and path survive — an operator must still see WHICH link the host could not open');

  lines.length = 0;
  seam('https://example.com/docs');
  assert.ok(lines[0].endsWith('https://example.com/docs'),
    'a URL with no query is logged whole, unchanged');
});
