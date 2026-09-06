'use strict';
// plugin-tools-verify.test.js — what `plugins/tools/verify.js` grades as a
// registered surface.
//
// Run as a REAL child process over REAL plugin directories: verify.js is a
// script with no exports, so there is nothing a unit test could call, and what
// matters is the checklist an author reads on stdout plus the exit code.
//
// The defect pinned here was a disagreement inside one run: a plugin whose only
// surface is an intent verb FAILED 'registered at least one surface' and then
// printed its verb under 'note intent verbs' two checks later. The verbs were
// already registered at that point — the tool just did not count them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { mkTmpRoot } = require('./lib/tmp-roots');

const REPO = path.join(__dirname, '..');
const VERIFY = path.join(REPO, 'plugins', 'tools', 'verify.js');

// A non-zero exit is a normal outcome here — a failing checklist exits 1 — so
// the stdout is taken off the error too rather than letting the throw end the
// subject before anything is asserted.
function runVerify(dir) {
  try {
    const out = execFileSync(process.execPath, [VERIFY, dir], { encoding: 'utf8', cwd: REPO });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') };
  }
}

function mkPlugin(prefix, id, engineSrc) {
  const root = mkTmpRoot(prefix);
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine.js'), engineSrc);
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    id, name: id, hostApi: '1', version: '0.1.0', entry: { engine: 'engine.js' },
  }, null, 2)}\n`);
  return dir;
}

// The register call is shaped after plugins/git-branches/engine.js: a verb, a
// parse returning an object, and a handler. Nothing else is registered — no ipc
// method, no session hook, no bundle — so this plugin's ONLY surface is the verb.
const VERB_ONLY_ENGINE = `'use strict';
module.exports = {
  activate(host) {
    host.intents.register({
      verb: 'verbonly',
      parse(line) { return /^\\[agent:verbonly\\]/.test(String(line || '')) ? {} : null; },
      label: 'Verb-only fixture',
      handler() {},
    });
  },
  deactivate() {},
};
`;

const SILENT_ENGINE = `'use strict';
module.exports = {
  activate() {},
  deactivate() {},
};
`;

test('verify.js counts an intent verb as a registered surface', () => {
  const dir = mkPlugin('clx-t711-verb-', 'verb-only', VERB_ONLY_ENGINE);
  const r = runVerify(dir);

  // ENTER: the run must have reached activation. Everything below is about a
  // check that runs only after activate(), so a fixture that died in staging or
  // discovery would leave the assertions matching against a checklist that never
  // got there — and the FAIL-literal subject below would pass vacuously.
  assert.match(r.out, /PASS {2}activate\(\) succeeds/,
    `the fixture must activate before the surface check runs\n${r.out}`);

  assert.match(r.out, /PASS {2}registered at least one surface/,
    `a verb IS a surface — this plugin registers no ipc method, no hook, no bundle\n${r.out}`);
  assert.match(r.out, /verbs: verbonly/,
    `the detail line must name the verb it counted\n${r.out}`);
  assert.strictEqual(r.code, 0, `a verb-only plugin conforms; verify exited ${r.code}\n${r.out}`);
});

test('verify.js still fails a plugin that registers nothing at all', () => {
  const dir = mkPlugin('clx-t711-silent-', 'silent-plugin', SILENT_ENGINE);
  const r = runVerify(dir);

  assert.match(r.out, /PASS {2}activate\(\) succeeds/,
    `the fixture must activate before the surface check runs\n${r.out}`);

  assert.match(r.out, /FAIL {2}registered at least one surface/,
    `an engine that registers nothing has no surface — widening the check must not swallow this\n${r.out}`);
  assert.match(r.out, /verbs: none/, `and the detail says the verb count was zero\n${r.out}`);
  assert.strictEqual(r.code, 1, `a surfaceless plugin must exit non-zero, got ${r.code}\n${r.out}`);
});

test('verify.js computes newVerbs once, above the surface check that reads it', () => {
  // A source pin because the ordering is what makes the check able to see a
  // verb at all: the verbs are registered during activateById, but if the
  // computation sits below the record() call — where it used to — the check
  // grades a plugin the run has already observed a verb for. No fixture can
  // express that; the two orderings differ only in which line runs first.
  const src = fs.readFileSync(VERIFY, 'utf8');
  const decl = src.indexOf('const newVerbs');
  const check = src.indexOf("record('registered at least one surface'");

  // Both guards first: indexOf returns -1 for a string that moved or was
  // renamed, and -1 is below every real index, so the ordering assertion alone
  // would pass on a file that contains neither.
  assert.notStrictEqual(decl, -1, 'newVerbs is still computed in verify.js');
  assert.notStrictEqual(check, -1, "the 'registered at least one surface' record is still there");
  assert.ok(decl < check,
    'newVerbs must be computed above the surface check, or the check cannot count a verb');

  assert.strictEqual(src.split('const newVerbs').length - 1, 1,
    'computed once — the later note() reads the hoisted const rather than recomputing it');
});
