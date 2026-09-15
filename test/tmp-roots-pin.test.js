'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const HELPER = path.join('lib', 'tmp-roots.js');
const RAW = `mkdtemp${'Sync'}`;
const CALL = new RegExp(`\\b${RAW}\\s*\\(`);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
}

test(`no test file outside ${HELPER} mints a scratch root with a raw ${RAW}`, () => {
  const files = walk(TEST_DIR);
  assert.ok(files.length > 300,
    `ENTER: the scan must actually visit the suite — it found ${files.length} .js files under ${TEST_DIR}, `
    + 'which means the walk is broken and every assertion below passes vacuously');

  const helper = files.filter((f) => path.relative(TEST_DIR, f) === HELPER);
  assert.strictEqual(helper.length, 1, `ENTER: ${HELPER} must exist for the conversion to have a target`);
  assert.ok(CALL.test(codeOnly(fs.readFileSync(helper[0], 'utf8'))),
    `ENTER: ${HELPER} is the one place that may call ${RAW}, and it no longer does — `
    + `the detector below matches nothing, so its green means nothing`);

  const offenders = [];
  for (const abs of files) {
    const rel = path.relative(TEST_DIR, abs);
    if (rel === HELPER) continue;
    const lines = codeOnly(fs.readFileSync(abs, 'utf8')).split('\n');
    lines.forEach((line, i) => { if (CALL.test(line)) offenders.push(`test/${rel}:${i + 1}`); });
  }

  assert.deepStrictEqual(offenders, [],
    `These call sites mint a scratch directory that NOTHING ever removes. A full suite run used to leave `
    + `thousands behind in $TMPDIR and they accumulated into the hundreds of thousands, pegging fseventsd at `
    + `100% CPU (t498, t927). Call mkTmpRoot('prefix') from test/lib/tmp-roots.js instead — it mints the same `
    + `directory and registers it for the top-level sweep. For a directory inside a root that is ALREADY `
    + `tracked, call mkTmpDirIn(parent, 'prefix'). Do NOT add an exemption here: an exempt file leaks exactly `
    + `as much as an unconverted one, and the next reader takes it as precedent.`);
});
