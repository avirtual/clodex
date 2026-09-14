'use strict';
// Run: node --test test/supervised-launchers.test.js
// t910 — every launcher THIS REPO ships restarts the headless host, so every one
// of them must DECLARE that it does. `[agent:reboot]` off Electron restarts by
// exiting 64 for a supervisor, and headless-restart.js refuses the intent unless
// CLODEX_SUPERVISED says a supervisor is there (it cannot be detected).
//
// The COUPLING is the fragile thing, not either line: a unit that restarts but
// does not declare it silently disables an intent on the whole deployed fleet,
// and nothing else in the tree notices. So the pairs are asserted TOGETHER —
// restart policy and declaration, per artifact, in one test each.
//
// Shape borrowed from test/host-log-parity.test.js: read the shipped artifact,
// assert the property.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { SUPERVISED_ENV, supervisorDeclared } = require('../headless-restart');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const UNIT = 'peering/clodex.service';
const WEB_DOCKERFILE = 'docker/web/Dockerfile';
const BOX_DOCKERFILE = 'docker/Dockerfile';

test(`${UNIT}: Restart=always and ${SUPERVISED_ENV} ship as a pair`, () => {
  const src = read(UNIT);

  // ENTER: if the unit stopped restarting, the declaration below would be a LIE
  // and this test should be deleted rather than kept passing.
  assert.match(src, /^Restart=always$/m,
    `ENTER: ${UNIT} restarts the host — that is what makes the exit-64 contract real`);

  const envs = src.split('\n').filter((l) => /^Environment=/.test(l));
  const declared = envs.find((l) => l.startsWith(`Environment=${SUPERVISED_ENV}=`));
  assert.ok(declared,
    `${UNIT} sets Restart=always but never declares ${SUPERVISED_ENV} — every spoke `
    + 'clodex-deploy.sh installs this unit on would then REFUSE [agent:reboot], a working '
    + 'intent going dark on the whole fleet');

  // Asserted through the real parser, not a regex: `Environment=CLODEX_SUPERVISED=0`
  // matches "is present" and means the opposite of what this test is for.
  const value = declared.slice(`Environment=${SUPERVISED_ENV}=`.length);
  assert.strictEqual(supervisorDeclared({ [SUPERVISED_ENV]: value }), true,
    `${UNIT} sets ${SUPERVISED_ENV}=${JSON.stringify(value)}, which headless-restart.js reads as `
    + 'a DECLINE — the var being present is not the same as the capability being declared');
});

test(`${WEB_DOCKERFILE}: the web image declares ${SUPERVISED_ENV}`, () => {
  const src = read(WEB_DOCKERFILE);

  // ENTER: this image is the headless host. If its CMD ever stopped being that,
  // the whole pairing argument moves elsewhere and this test is testing nothing.
  assert.match(src, /CMD\s*\[\s*"node"\s*,\s*"headless-main\.js"\s*\]/,
    `ENTER: ${WEB_DOCKERFILE} runs the headless host, which is the host that refuses`);

  const m = new RegExp(`${SUPERVISED_ENV}=(\\S+)`).exec(src);
  assert.ok(m,
    `${WEB_DOCKERFILE} never sets ${SUPERVISED_ENV}, but sandbox.js writes `
    + '`restart: always` into the compose that runs it — so every team sandbox box '
    + 'restarts and refuses to admit it');
  const value = m[1].replace(/\\$/, '');
  assert.strictEqual(supervisorDeclared({ [SUPERVISED_ENV]: value }), true,
    `${WEB_DOCKERFILE} sets ${SUPERVISED_ENV}=${JSON.stringify(value)}, which reads as a decline`);
});

test('sandbox.js writes the restart policy this image is declaring', () => {
  // The other half of the web pair, and it does not live in the Dockerfile: the
  // supervisor for that image is the compose file sandbox.js generates. Drop the
  // policy there and the Dockerfile's declaration becomes the lie — an agent told
  // its restart is coming when nothing will bring the box back.
  assert.match(read('sandbox.js'), /restart:\s*always/,
    `sandbox.js no longer writes a restart policy, so ${WEB_DOCKERFILE}'s ${SUPERVISED_ENV} `
    + 'now promises a relaunch nothing performs');
});

test(`${BOX_DOCKERFILE}: inherits the declaration from the unit, and does not set it twice`, () => {
  const src = read(BOX_DOCKERFILE);

  // The peer box pre-enables the SAME unit, copied with a sed that rewrites only
  // WorkingDirectory — so every other line, Restart and Environment alike, comes
  // across. A second definition here would be a second place to forget.
  assert.match(src, /peering\/clodex\.service/,
    `ENTER: ${BOX_DOCKERFILE} installs the shipped unit — that is what it inherits from`);
  const sed = /sed\s+-e\s+'s#\^WorkingDirectory=\.\*#([^#]*)#'/.exec(src);
  assert.ok(sed,
    `${BOX_DOCKERFILE} no longer rewrites ONLY WorkingDirectory when it copies the unit; `
    + `if it now filters or rewrites Environment lines, ${SUPERVISED_ENV} may not survive the copy `
    + 'and this box needs its own declaration');

  assert.doesNotMatch(src, new RegExp(`ENV[^\\n]*${SUPERVISED_ENV}|^${SUPERVISED_ENV}=`, 'm'),
    `${BOX_DOCKERFILE} sets ${SUPERVISED_ENV} itself as well as inheriting it from the unit — `
    + 'two sources for one capability, which disagree the first time only one is updated');
});
