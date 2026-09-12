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

test('the image bakes /home/clodex/.gitconfig trusting the work dir and worktrees under it', () => {
  const writes = instructions(DOCKERFILE).filter((i) => i.includes('/home/clodex/.gitconfig'));
  assert.strictEqual(writes.length, 1, 'exactly one instruction should write /home/clodex/.gitconfig');
  const instr = writes[0];
  assert.match(instr, /^(RUN|COPY)\b/);
  assert.ok(instr.includes('[safe]'), 'the baked gitconfig needs a [safe] section');
  assert.ok(instr.includes('directory = /home/clodex/work'), 'missing the work-dir safe.directory');
  assert.ok(instr.includes('directory = /home/clodex/work/*'), 'missing the worktree glob safe.directory');
  assert.strictEqual(
    instr.split('directory = /home/clodex/work').length - 1,
    2,
    'both the work dir and its worktree glob must be listed',
  );
});
