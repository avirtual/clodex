'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const NATIVES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'queueMicrotask', 'fetch', 'structuredClone', 'atob', 'btoa'];
const SHORTHAND = new RegExp(`[{,]\\s*(?:${NATIVES.join('|')})\\s*(?=[,}])|:\\s*(?:window\\.|globalThis\\.)?(?:${NATIVES.join('|')})\\s*(?=[,}])`, 'g');
const ALLOWED = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function windowFiles() {
  const plugins = fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => path.join(root, 'plugins', e.name, 'renderer.js')).filter((p) => fs.existsSync(p));
  return [...walk(path.join(root, 'renderer')), ...plugins, path.join(root, 'preload.js')];
}

function hits(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  return [...code.matchAll(SHORTHAND)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

test('the gate catches a window native stored in an object literal', () => {
  assert.deepStrictEqual(hits('const t = { setTimeout, clearTimeout };'), ['{ setTimeout', ', clearTimeout']);
  assert.deepStrictEqual(hits('f({ raf: requestAnimationFrame })'), [': requestAnimationFrame']);
  assert.deepStrictEqual(hits('const t = { setTimeout: (fn, ms) => setTimeout(fn, ms) };'), []);
});

test('no window-loaded file stores a window native in an object, where calling it as a method throws Illegal invocation', () => {
  const files = windowFiles();
  assert.ok(files.some((f) => f.endsWith(path.join('renderer', 'lib', 'testjob-output.js'))), 'ENTER: the scan covers renderer/lib');
  const found = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    for (const h of hits(fs.readFileSync(file, 'utf8'))) if (!ALLOWED.includes(`${rel}: ${h}`)) found.push(`${rel}: ${h}`);
  }
  assert.deepStrictEqual(found, []);
});
