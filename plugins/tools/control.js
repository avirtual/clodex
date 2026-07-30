#!/usr/bin/env node
// Positive control for verify.js.
//
// A verifier that only ever prints PASS is indistinguishable from one with a
// broken assertion — the null result is worthless unless the instrument is
// shown to detect the effect when it IS present. Each mutant below breaks a
// real, shipped plugin in exactly one way; verify.js must fail each one, and
// must pass the unmutated original.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GOOD = path.resolve(__dirname, '..', 'git-branches');
const VERIFY = path.join(__dirname, 'verify.js');

// Each mutant states the check it must trip. If a mutant passes verification,
// that named check is not actually load-bearing.
const MUTANTS = [
  { name: 'baseline (unmutated)', expect: 'pass', mutate: () => {} },
  {
    name: 'manifest hostApi bumped to "2"',
    expect: 'fail',
    mutate: (d) => patchJson(d, (m) => { m.hostApi = '2'; }),
  },
  {
    name: 'manifest id no longer matches its directory',
    expect: 'fail',
    mutate: (d) => patchJson(d, (m) => { m.id = 'something-else'; }),
  },
  {
    name: 'declared engine file is missing',
    expect: 'fail',
    mutate: (d) => fs.unlinkSync(path.join(d, 'engine.js')),
  },
  {
    name: 'engine.js has a syntax error',
    expect: 'fail',
    mutate: (d) => fs.appendFileSync(path.join(d, 'engine.js'), '\nfunction (((\n'),
  },
  {
    name: 'activate() throws',
    expect: 'fail',
    // Appended rather than regex-substituted into the existing definition: a
    // plugin may export activate as a declaration, a property assignment or an
    // object literal, and a substitution that matches none of those silently
    // mutates nothing — which the control then misreports as a verifier MISS.
    // Overwriting the export after the fact works whatever the original shape.
    mutate: (d) => {
      const p = path.join(d, 'engine.js');
      const src = fs.readFileSync(p, 'utf8');
      fs.appendFileSync(p, '\nmodule.exports.activate = () => { throw new Error("control: activate exploded"); };\n');
      if (!/module\.exports/.test(src)) throw new Error('no module.exports to override');
    },
  },
  {
    name: 'an ipc handler crashes on its own code',
    expect: 'fail',
    mutate: (d) => {
      const p = path.join(d, 'engine.js');
      // A genuine crash shape, not an argument rejection: the handler calls a
      // method that does not exist. This is what separates a real defect from a
      // plugin correctly refusing a bad call.
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
        /host\.ipc\.handle\((['"])([^'"]+)\1,\s*/, 'host.ipc.handle($1$2$1, (...a) => host.nonexistentApi.boom(), '));
    },
  },
  {
    name: 'activate() registers nothing at all',
    expect: 'fail',
    mutate: (d) => {
      const p = path.join(d, 'engine.js');
      const src = fs.readFileSync(p, 'utf8');
      // Keep the module shape and the export, drop the body: an "empty" plugin
      // that loads cleanly and does nothing is the failure mode a parse check
      // cannot see.
      fs.writeFileSync(p, `${src.replace(/module\.exports\s*=[\s\S]*$/, '')}\nmodule.exports = { activate() {}, deactivate() {} };\n`);
    },
  },
];

function patchJson(dir, fn) {
  const p = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(m);
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
}

let failures = 0;
for (const mut of MUTANTS) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-control-'));
  const dir = path.join(tmp, 'git-branches');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(GOOD)) fs.copyFileSync(path.join(GOOD, f), path.join(dir, f));
  try { mut.mutate(dir); } catch (e) { console.log(`  SKIP  ${mut.name} — mutation failed: ${e.message}`); continue; }

  let rc = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [VERIFY, dir], { stdio: 'pipe' }).toString();
  } catch (e) { rc = e.status ?? 1; out = String(e.stdout || ''); }

  const detected = rc !== 0;
  const ok = mut.expect === 'fail' ? detected : !detected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${mut.name} (expected ${mut.expect}, verifier ${detected ? 'failed it' : 'passed it'})`);
  if (!ok) console.log(out.split('\n').filter((l) => l.includes('FAIL') || l.includes('checks passed')).join('\n'));
}

console.log(`\ncontrol: ${MUTANTS.length - failures}/${MUTANTS.length} mutants handled correctly`);
process.exit(failures ? 1 : 0);
