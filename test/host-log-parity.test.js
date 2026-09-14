const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOSTS = ['main.js', 'headless-main.js'];
const REQUIRED = ['info', 'warn', 'error', 'debug'];
const LEVEL_FOR = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };

function loadHostLog(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = src.indexOf('const log = {');
  assert.notStrictEqual(start, -1, `${file}: no \`const log = {\` literal found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notStrictEqual(end, -1, `${file}: unterminated \`const log\` literal`);
  const calls = [];
  const writeLog = (level, tag, message) => { calls.push({ level, tag, message }); };
  const obj = new Function('writeLog', `return ${src.slice(open, end + 1)};`)(writeLog);
  return { obj, calls };
}

for (const file of HOSTS) {
  test(`${file} exposes exactly the required log methods`, () => {
    const { obj } = loadHostLog(file);
    assert.deepStrictEqual(Object.keys(obj).sort(), [...REQUIRED].sort(),
      `${file}'s log object must expose exactly ${REQUIRED.join(', ')} — the engine calls all of them unguarded`);
  });

  test(`${file} routes every log method to its own level`, () => {
    for (const name of REQUIRED) {
      const { obj, calls } = loadHostLog(file);
      assert.strictEqual(typeof obj[name], 'function', `${file}: log.${name} is not a function`);
      obj[name]('t908', 'probe');
      assert.deepStrictEqual(calls, [{ level: LEVEL_FOR[name], tag: 't908', message: 'probe' }],
        `${file}: log.${name} must write at ${LEVEL_FOR[name]}`);
    }
  });
}

test('both hosts expose the same log surface', () => {
  const [desktop, headless] = HOSTS.map((f) => Object.keys(loadHostLog(f).obj).sort());
  assert.deepStrictEqual(desktop, headless,
    'main.js and headless-main.js log objects disagree — an engine call site that is a no-op on one host crashes the other');
});
