'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function realOsOffenders(src) {
  if (!/createSessionManager|require\(\s*['"]\.\.?\/(?:lib\/)?session-fixtures['"]\s*\)/.test(src)) return [];
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](?:node:)?os['"]\s*\)/g)) names.add(m[1]);
  const out = [];
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    let hit = /\bos\s*:\s*require\(\s*['"](?:node:)?os['"]\s*\)/.test(code);
    for (const n of names) {
      if (new RegExp(`(?<![\\w$.])os\\s*:\\s*${n.replace(/\$/g, '\\$')}\\s*(?:[,}]|$)`).test(code)) hit = true;
      if (n === 'os' && /(?:^|[{,])\s*os\s*(?:[,}]|$)/.test(code) && !/^\s*(?:const|let|var)\b/.test(code)) hit = true;
    }
    if (hit) out.push(i + 1);
  });
  return out;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('t2442: the scanner flags the real os as the two spawn-path files passed it before the fix', () => {
  const ticketReplay = [
    "const os = require('node:os');",
    'const SessionManager = createSessionManager({',
    '    fs, path, pathFor, runDirFor,',
    '    os,',
    '    notifyOS: () => {},',
    '});',
  ].join('\n');
  const streamOutboxPark = [
    "const os = require('node:os');",
    'const SessionManager = createSessionManager({',
    '    fs, path, pathFor, runDirFor, os,',
    '});',
  ].join('\n');
  assert.deepStrictEqual(realOsOffenders("const { mkPark } = require('./lib/session-fixtures');\nconst m = mkPark({ os: require('node:os') });"), [2]);
  assert.deepStrictEqual(realOsOffenders(ticketReplay), [4]);
  assert.deepStrictEqual(realOsOffenders(streamOutboxPark), [3]);
  assert.deepStrictEqual(realOsOffenders("const osReal = require('os');\ncreateSessionManager({ fs, os: osReal, path });"), [2]);
  assert.deepStrictEqual(realOsOffenders("createSessionManager({\n  os: require('node:os'),\n});"), [2]);
  assert.deepStrictEqual(realOsOffenders("const os = require('node:os');\ncreateSessionManager({ os: tmpHomeOs(), fs });"), []);
});

test('t2442: no file under test/ hands the session manager the real os without a home override', () => {
  const files = walk(__dirname).filter((f) => f !== __filename);
  assert.ok(files.some((f) => f.endsWith(path.join('test', 'ticket-replay.test.js'))), 'ENTER: the walk reaches the spawn-path files');
  const offenders = files
    .map((f) => [path.relative(__dirname, f), realOsOffenders(fs.readFileSync(f, 'utf8'))])
    .filter(([, lines]) => lines.length);
  assert.deepStrictEqual(offenders, []);
});

test('t2442: the runner drops CLAUDE_CONFIG_DIR from the env its test files inherit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');
  assert.match(src, /^const childEnv = \{ \.\.\.process\.env \};$/m, 'ENTER: the runner builds childEnv from process.env');
  assert.match(src, /^delete childEnv\.CLAUDE_CONFIG_DIR;$/m);
});
