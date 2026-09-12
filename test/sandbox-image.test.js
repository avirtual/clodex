'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DOCKERFILE = fs.readFileSync(path.join(__dirname, '..', 'docker', 'web', 'Dockerfile'), 'utf8');

function instructions(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (cur === null && (/^\s*#/.test(line) || line.trim() === '')) continue;
    cur = cur === null ? line : cur + '\n' + line;
    if (/\\$/.test(line.trimEnd())) continue;
    out.push(cur);
    cur = null;
  }
  if (cur !== null) out.push(cur);
  return out;
}

test('the image bakes /home/clodex/.gitconfig trusting every repo in the box', () => {
  const writes = instructions(DOCKERFILE).filter((i) => i.includes('/home/clodex/.gitconfig'));
  assert.strictEqual(writes.length, 1, 'exactly one instruction should write /home/clodex/.gitconfig');
  const instr = writes[0];
  assert.match(instr, /^(RUN|COPY)\b/);
  assert.match(
    instr,
    /\[safe\](?:\\n|\n)(?:\\t|\t| +)directory = \*(?:\\n|\n|'|"|$)/,
    'the baked gitconfig needs a [safe] section whose next entry is exactly `directory = *`',
  );
});
