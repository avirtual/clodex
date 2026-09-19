'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  shellHostOf, programOf, tokenize, isShellName, HOST_TABLE, SHELL_NAMES, MOSH_EXCLUDED_REASON,
} = require('../term-host');

const RECOGNISED = [
  ['ssh host', 'ssh host'],
  ['ssh user@box.example.com', 'ssh user@box.example.com'],
  ['ssh -p 2222 -o StrictHostKeyChecking=no host', 'ssh host'],
  ['ssh -i ~/.ssh/id_ed25519 host', 'ssh host'],
  ['ssh host bash', 'ssh host'],
  ['ssh host /bin/zsh', 'ssh host'],
  ['su', 'su root'],
  ['su -', 'su root'],
  ['su - postgres', 'su postgres'],
  ['su --login deploy', 'su deploy'],
  ['sudo -i', 'sudo'],
  ['sudo -s', 'sudo'],
  ['sudo --login', 'sudo'],
  ['sudo bash', 'sudo'],
  ['sudo su -', 'sudo'],
  ['doas -s', 'doas'],
  ['docker exec -it api bash', 'docker api'],
  ['docker exec -ti api sh', 'docker api'],
  ['docker exec --interactive --tty api bash', 'docker api'],
  ['docker run -it alpine sh', 'docker alpine'],
  ['podman exec -it web bash', 'podman web'],
  ['nerdctl exec -it web sh', 'nerdctl web'],
  ['kubectl exec -it mypod -- bash', 'kubectl mypod'],
  ['kubectl exec -it mypod -n prod -- sh', 'kubectl mypod'],
  ['oc exec -it mypod -- bash', 'oc mypod'],
  ['lxc exec c1 -- bash', 'lxc c1'],
  ['incus exec c1 -- sh', 'incus c1'],
  ['chroot /mnt/root /bin/bash', 'chroot /mnt/root'],
  ['nsenter -t 1 -m -u -i -n /bin/sh', 'nsenter 1'],
  ['nsenter -m -u /bin/sh', 'nsenter /bin/sh'],
  ['sh', 'sh'],
  ['bash', 'bash'],
  ['zsh', 'zsh'],
  ['dash', 'dash'],
  ['ash', 'ash'],
  ['ksh', 'ksh'],
  ['/bin/bash', 'bash'],
  ['fish', 'fish'],
];

for (const [line, host] of RECOGNISED) {
  test(`shellHostOf recognises ${JSON.stringify(line)} as ${JSON.stringify(host)}`, () => {
    assert.deepStrictEqual(shellHostOf(line), { host, shell: 'posix' });
  });
}

const REFUSED = [
  'ssh host tail -f /var/log/syslog',
  'ssh -N -L 8080:localhost:80 host',
  'ssh -W other:22 host',
  'ssh host uptime',
  'su -c whoami',
  'su --command whoami',
  'sudo apt update',
  'sudo -u deploy rsync -a . there:/srv',
  'docker exec api ls',
  'docker exec -i api bash',
  'docker exec -t api bash',
  'docker exec -it api ls -la',
  'docker ps',
  'kubectl exec -it mypod -- ls',
  'kubectl get pods',
  'kubectl exec mypod -- bash',
  'lxc exec c1 -- ls',
  'lxc list',
  'bash -c "echo hi"',
  'bash deploy.sh',
  'sh -c true',
  'zsh script.zsh',
];

for (const line of REFUSED) {
  test(`shellHostOf refuses ${JSON.stringify(line)}`, () => {
    assert.strictEqual(shellHostOf(line), null);
  });
}

const NOT_A_SHELL = ['vim notes.txt', 'less /var/log/syslog', 'claude', 'python3', 'top', 'mysql -u root', 'vim', 'nano', 'man ssh'];

for (const line of NOT_A_SHELL) {
  test(`shellHostOf refuses the non-shell foreground ${JSON.stringify(line)}`, () => {
    assert.strictEqual(shellHostOf(line), null);
  });
}

const COMPOUND = [
  'ssh host && echo done',
  'ssh host; echo done',
  'ssh host || true',
  'ssh host | tee log',
  'ssh host &',
  'ssh $(cat host.txt)',
  'ssh `cat host.txt`',
  'ssh host > out.log',
  'ssh host < in.txt',
  'echo hi && ssh host',
];

for (const line of COMPOUND) {
  test(`shellHostOf refuses the compound line ${JSON.stringify(line)}`, () => {
    assert.strictEqual(shellHostOf(line), null);
  });
}

test('mosh is refused, and the reason is one exported constant', () => {
  assert.strictEqual(shellHostOf('mosh host'), null);
  assert.strictEqual(shellHostOf('mosh user@host'), null);
  assert.ok(!HOST_TABLE.some((r) => r.program === 'mosh'), 'mosh is not a table row');
  assert.match(MOSH_EXCLUDED_REASON, /mosh cannot carry terminal marks/);
});

test('leading assignments and command prefixes are skipped before argv[0] decides', () => {
  assert.deepStrictEqual(shellHostOf('FOO=1 ssh host'), { host: 'ssh host', shell: 'posix' });
  assert.deepStrictEqual(shellHostOf('FOO=1 BAR=2 ssh host'), { host: 'ssh host', shell: 'posix' });
  assert.deepStrictEqual(shellHostOf('env ssh host'), { host: 'ssh host', shell: 'posix' });
  assert.deepStrictEqual(shellHostOf('exec ssh host'), { host: 'ssh host', shell: 'posix' });
  assert.deepStrictEqual(shellHostOf('nohup ssh host'), { host: 'ssh host', shell: 'posix' });
  assert.deepStrictEqual(shellHostOf('command ssh host'), { host: 'ssh host', shell: 'posix' });
});

test('quoted words are one word, and quoting does not smuggle a compound line through', () => {
  assert.deepStrictEqual(tokenize('ssh "my host"'), ['ssh', 'my host']);
  assert.deepStrictEqual(tokenize("ssh 'my host'"), ['ssh', 'my host']);
  assert.deepStrictEqual(tokenize('ssh my\\ host'), ['ssh', 'my host']);
  assert.deepStrictEqual(shellHostOf("ssh 'ho;st'"), { host: 'ssh ho;st', shell: 'posix' });
  assert.strictEqual(tokenize('ssh "$(cat h)"'), null);
  assert.strictEqual(tokenize("ssh 'unterminated"), null);
});

test('an empty or blank line is not a host', () => {
  for (const line of ['', '   ', null, undefined]) {
    assert.strictEqual(shellHostOf(line), null, `${JSON.stringify(line)} is not a host`);
  }
});

test('programOf names argv[0] for any simple line, recognised or not', () => {
  assert.strictEqual(programOf('ssh host'), 'ssh');
  assert.strictEqual(programOf('vim notes.txt'), 'vim');
  assert.strictEqual(programOf('mysql -u root -pS3cret'), 'mysql');
  assert.strictEqual(programOf('/usr/bin/vim notes.txt'), 'vim');
  assert.strictEqual(programOf('FOO=1 env vim x'), 'vim');
  assert.strictEqual(programOf('a && b'), null);
});

test('the shell-name set is what both the table and isShellName read', () => {
  assert.deepStrictEqual(SHELL_NAMES, ['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish']);
  assert.ok(isShellName('bash'));
  assert.ok(isShellName('/bin/zsh'));
  assert.ok(!isShellName('vim'));
  assert.ok(!isShellName('bashfoo'));
});

test('every table row is reachable through shellHostOf', () => {
  const programs = HOST_TABLE.map((r) => r.program);
  assert.deepStrictEqual(programs, [...new Set(programs)], 'no program is listed twice');
  const reached = new Set(RECOGNISED.map(([line]) => programOf(line)));
  for (const p of programs) {
    assert.ok(reached.has(p), `${p} has a literal pin above`);
  }
});
