'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { boxArgRefusal, boxArgsRefusal, boxArgsLabelRefusal, boxArgsFingerprint, boxCustom, cleanCustom } = require('../box-args');

const ARG_ROWS = [
  ['ubuntu', 'must be an option starting with - (a bare word would end Docker\'s options and replace the image)'],
  ['/dev/dri', 'must be an option starting with - (a bare word would end Docker\'s options and replace the image)'],
  ['-', 'must be an option starting with - (a bare word would end Docker\'s options and replace the image)'],
  ['--', '-- would end Docker\'s options'],
  ['', 'must be text of 1 to 512 characters'],
  [`--env=${'x'.repeat(507)}`, 'must be text of 1 to 512 characters'],
  [`--env=${'x'.repeat(506)}`, null],
  ['--env=A\nB', 'must not contain a NUL or a line break'],
  ['--env=A\0B', 'must not contain a NUL or a line break'],
  ['--name=x', '--name is reserved by Clodex'],
  ['--name', '--name is reserved by Clodex'],
  ['--rm', '--rm is reserved by Clodex'],
  ['--detach', '--detach is reserved by Clodex'],
  ['--detach=true', '--detach is reserved by Clodex'],
  ['-d', '-d (--detach) is reserved by Clodex'],
  ['--entrypoint=/bin/bash', '--entrypoint is reserved by Clodex'],
  ['--cidfile=/tmp/c', '--cidfile is reserved by Clodex'],
  ['--interactive', '--interactive is reserved by Clodex'],
  ['-i', '-i (--interactive) is reserved by Clodex'],
  ['--tty', '--tty is reserved by Clodex'],
  ['-t', '-t (--tty) is reserved by Clodex'],
  ['-it', '-i (--interactive) is reserved by Clodex'],
  ['-Pt', '-t (--tty) is reserved by Clodex'],
  ['--restart=always', '--restart is reserved by Clodex'],
  ['--workdir=/x', '--workdir is reserved by Clodex'],
  ['-w=/x', '-w (--workdir) is reserved by Clodex'],
  ['--platform=linux/amd64', '--platform is reserved by Clodex'],
  ['--pull=always', '--pull is reserved by Clodex'],
  ['--init', '--init is reserved by Clodex'],
  ['--log-driver=json-file', '--log-driver is reserved by Clodex'],
  ['--log-opt=max-size=1m', '--log-opt is reserved by Clodex'],
  ['--label=clodex.suite=1', '--label is reserved by Clodex'],
  ['--label=mine=1', '--label is reserved by Clodex'],
  ['-l=mine=1', '-l (--label) is reserved by Clodex'],
  ['--label-file=/x', '--label-file is reserved by Clodex'],
  ['--device', '--device needs its value attached with = (for example --device=/dev/dri)'],
  ['-v', '-v needs its value attached with = (for example --device=/dev/dri)'],
  ['-Pe', '-e needs its value attached with = (for example --device=/dev/dri)'],
  ['--device=/dev/dri', null],
  ['--group-add=993', null],
  ['--privileged', null],
  ['--mount=type=bind,src=/x,dst=/job/tree', null],
  ['-v=/a:/b', null],
  ['--volume=/a:/b', null],
  ['--gpus=all', null],
  ['--runtime=nvidia', null],
  ['--network=host', null],
  ['--user=0:0', null],
  ['--cap-add=SYS_ADMIN', null],
  ['--security-opt=seccomp=unconfined', null],
  ['--env=SECRET_TOKEN=zzz', null],
  ['-eFOO=1', null],
  ['-P', null],
];

test('boxArgRefusal gives each literal argument its literal verdict', () => {
  assert.deepStrictEqual(ARG_ROWS.map(([arg]) => [arg, boxArgRefusal(arg)]), ARG_ROWS);
});

test('boxArgsRefusal names the first offending element by its 1-based index and rule, and bounds the list', () => {
  assert.strictEqual(boxArgsRefusal([]), null);
  assert.strictEqual(boxArgsRefusal(['--device=/dev/dri', '--group-add=993']), null);
  assert.strictEqual(boxArgsRefusal(['--device=/dev/dri', 'ubuntu', '--name=x']), 'box option 2 must be an option starting with - (a bare word would end Docker\'s options and replace the image)');
  assert.strictEqual(boxArgsRefusal(['--device=/dev/dri', '--group-add=993', '-it']), 'box option 3 -i (--interactive) is reserved by Clodex');
  assert.strictEqual(boxArgsRefusal(['--device=/dev/dri', 7]), 'box option 2 must be text of 1 to 512 characters');
  assert.strictEqual(boxArgsRefusal(Array(32).fill('--privileged')), null);
  assert.strictEqual(boxArgsRefusal(Array(33).fill('--privileged')), 'at most 32 box options, not 33');
  assert.strictEqual(boxArgsRefusal('--privileged'), 'box options must be a list');
});

test('boxArgsLabelRefusal takes at most 32 of [A-Za-z0-9._-] and treats blank as absent', () => {
  const why = 'the box options label must be at most 32 letters, digits, dot, dash or underscore';
  const rows = [[null, null], ['', null], ['gpu', null], ['old-card_1.2', null], ['x'.repeat(32), null], ['x'.repeat(33), why], ['a b', why], ['gpu!', why], [7, why]];
  assert.deepStrictEqual(rows.map(([label]) => [label, boxArgsLabelRefusal(label)]), rows);
});

test('the fingerprint is the first 12 hex of sha256 over the JSON list, and an empty list has none', () => {
  assert.strictEqual(boxArgsFingerprint(['--device=/dev/dri', '--group-add=993']), '0b334ad4c4a0');
  assert.strictEqual(boxArgsFingerprint(['--group-add=993', '--device=/dev/dri']), 'cd0f9ca52dd6');
  assert.strictEqual(boxArgsFingerprint([]), null);
  assert.deepStrictEqual(boxCustom(['--device=/dev/dri', '--group-add=993'], 'gpu'), { fingerprint: '0b334ad4c4a0', label: 'gpu' });
  assert.deepStrictEqual(boxCustom(['--device=/dev/dri', '--group-add=993']), { fingerprint: '0b334ad4c4a0', label: null });
  assert.strictEqual(boxCustom([], 'gpu'), null);
});

test('cleanCustom keeps only a 12-hex fingerprint and a valid label', () => {
  assert.deepStrictEqual(cleanCustom({ fingerprint: '0b334ad4c4a0', label: 'gpu', args: ['--env=SECRET_TOKEN=zzz'] }), { fingerprint: '0b334ad4c4a0', label: 'gpu' });
  assert.deepStrictEqual(cleanCustom({ fingerprint: '0b334ad4c4a0', label: 'a b' }), { fingerprint: '0b334ad4c4a0', label: null });
  for (const bad of [null, [], 'x', { fingerprint: 'XYZ' }, { fingerprint: '0b334ad4c4a00' }]) assert.strictEqual(cleanCustom(bad), null, JSON.stringify(bad));
});
