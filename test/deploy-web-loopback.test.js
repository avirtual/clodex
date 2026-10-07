'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const chartDir = path.join(root, 'cli/deploy/helm/clodex');

function renderStatefulSet() {
  const r = spawnSync('helm', ['template', 't', chartDir, '--show-only', 'templates/statefulset.yaml'], { encoding: 'utf8' });
  if (!r.error && r.status === 0) return r.stdout;
  return fs.readFileSync(path.join(chartDir, 'templates/statefulset.yaml'), 'utf8');
}

test('helm statefulset pins the web host to loopback', () => {
  const text = renderStatefulSet();
  assert.match(text, /- name: CLODEX_WEB_HOST\s*\n\s*value: "127\.0\.0\.1"/);
});

test('fargate task env pins the web host to loopback in both Environment arms', () => {
  const text = fs.readFileSync(path.join(root, 'cli/deploy/clodex-fargate.yaml'), 'utf8');
  const env = /Environment: !If\n([\s\S]*?)\n\s*Secrets:/.exec(text);
  assert.ok(env, 'Environment: !If block not found');
  const hits = env[1].match(/\{ Name: CLODEX_WEB_HOST, Value: '127\.0\.0\.1' \}/g) || [];
  assert.equal(hits.length, 2);
});
