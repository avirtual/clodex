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

const BOX_DOCKERFILE = fs.readFileSync(path.join(__dirname, '..', 'docker', 'Dockerfile'), 'utf8');

for (const [name, text] of [['docker/web/Dockerfile', DOCKERFILE], ['docker/Dockerfile', BOX_DOCKERFILE]]) {
  test(`${name} exports the muse file credential backend and XDG data home`, () => {
    const envs = instructions(text).filter((i) => /^ENV\b/.test(i)).join('\n');
    assert.match(envs, /\bTBH_CREDENTIAL_BACKEND=file\b/);
    assert.match(envs, /\bXDG_DATA_HOME=\/home\/clodex\/\.local\/share\b/);
  });

  test(`${name} pre-creates the muse data dir so a fresh volume inherits clodex ownership`, () => {
    const mk = instructions(text).filter((i) => /^RUN mkdir -p [^\n]*\/home\/clodex\/\.config\/muse/.test(i));
    assert.strictEqual(mk.length, 1);
    assert.match(mk[0], /^RUN mkdir -p [^\n&]*\/home\/clodex\/\.local\/share(\s|$)/);
  });
}

test('docker/web/Dockerfile links clodexctl onto PATH as root, before USER clodex', () => {
  const all = instructions(DOCKERFILE);
  const link = all.findIndex((i) => /^RUN ln -sf? \/app\/cli\/bin\/clodexctl\.js \/usr\/local\/bin\/clodexctl$/.test(i));
  const user = all.findIndex((i) => /^USER clodex\b/.test(i));
  assert.ok(link >= 0, 'a RUN ln links /app/cli/bin/clodexctl.js to /usr/local/bin/clodexctl');
  assert.ok(user >= 0, 'ENTER: the USER clodex instruction exists');
  assert.ok(link < user, 'the link runs as root, before USER clodex');
});
