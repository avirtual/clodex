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

const ENTRYPOINT = fs.readFileSync(path.join(__dirname, '..', 'docker', 'web', 'entrypoint.sh'), 'utf8');

test('docker/web/Dockerfile installs docker/web/entrypoint.sh as the ENTRYPOINT and the context ships it', () => {
  const all = instructions(DOCKERFILE);
  assert.ok(all.includes('COPY docker/web/entrypoint.sh /usr/local/bin/clodex-entrypoint'));
  assert.ok(all.includes('ENTRYPOINT ["/usr/local/bin/clodex-entrypoint"]'));
  assert.ok(all.includes('USER clodex'));
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8').split('\n');
  assert.ok(ignore.indexOf('!docker/web/entrypoint.sh') > ignore.indexOf('docker'));
});

test('entrypoint: not root or no host ids → execs the command unchanged, before touching anything', () => {
  const lines = ENTRYPOINT.split('\n');
  const guard = lines.indexOf('if [ "$(id -u)" != 0 ] || [ -z "$CLODEX_HOST_UID" ] || [ -z "$CLODEX_HOST_GID" ]; then');
  assert.ok(guard >= 0);
  assert.strictEqual(lines[guard + 1].trim(), 'exec "$@"');
  assert.match(ENTRYPOINT, /case "\$CLODEX_HOST_UID\$CLODEX_HOST_GID" in\n {2}\*\[!0-9\]\*\) exec "\$@" ;;\nesac/);
  const firstMutation = Math.min(...['groupmod', 'sed -i', 'chown', 'setpriv'].map((w) => ENTRYPOINT.indexOf(w)));
  assert.ok(ENTRYPOINT.indexOf('exec "$@"') < firstMutation);
});

test('entrypoint: remaps clodex to the host gid and uid, idempotently', () => {
  assert.match(ENTRYPOINT, /if \[ "\$\(getent group clodex \| cut -d: -f3\)" != "\$CLODEX_HOST_GID" \]; then\n {2}groupmod -o -g "\$CLODEX_HOST_GID" clodex\nfi/);
  assert.match(ENTRYPOINT, /if \[ "\$\(id -u clodex\)" != "\$CLODEX_HOST_UID" \] \|\| \[ "\$\(id -g clodex\)" != "\$CLODEX_HOST_GID" \]; then\n {2}sed -i "s\/\^clodex:\\\(\[\^:\]\*\\\):\[0-9\]\*:\[0-9\]\*:\/clodex:\\1:\$CLODEX_HOST_UID:\$CLODEX_HOST_GID:\/" \/etc\/passwd\nfi/);
  assert.doesNotMatch(ENTRYPOINT, /usermod/);
});

test('entrypoint: chowns only image-owned top-level paths, non-recursively, after an owner check', () => {
  assert.match(ENTRYPOINT, /IMAGE_UID=\$\(stat -c %u \/app\)/);
  assert.match(ENTRYPOINT, /for p in \/data \/home\/clodex \/home\/clodex\/work \/home\/clodex\/\.\[!\.\]\* \/home\/clodex\/\*; do/);
  assert.match(ENTRYPOINT, /owner=\$\(stat -c %u "\$p"\)\n {2}if \[ "\$owner" = "\$IMAGE_UID" \] && \[ "\$owner" != "\$CLODEX_HOST_UID" \]; then\n {4}chown -h "\$CLODEX_HOST_UID:\$CLODEX_HOST_GID" "\$p"\n {2}fi/);
  assert.strictEqual((ENTRYPOINT.match(/chown/g) || []).length, 1);
  assert.doesNotMatch(ENTRYPOINT, /chown -R|\/app\b[^)]*chown/);
});

test('entrypoint: drops to the remapped user with setpriv as its last step', () => {
  const last = ENTRYPOINT.trimEnd().split('\n').pop();
  assert.strictEqual(last, 'exec setpriv --reuid="$CLODEX_HOST_UID" --regid="$CLODEX_HOST_GID" --init-groups "$@"');
  assert.doesNotMatch(ENTRYPOINT, /gosu|su-exec/);
});
