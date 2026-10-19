'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'headless-main.js'), 'utf8');

test('headless-main: CLODEX_SETUP_FAILED=1 warns and returns before the restore loop', () => {
  const guard = SRC.indexOf("if (process.env.CLODEX_SETUP_FAILED === '1') {");
  const warn = SRC.indexOf("log.warn('app', 'environment degraded: setup failed — fix the bootstrap script and run sandbox rebuild; seats not restored');");
  const restore = SRC.indexOf('engine.restoreSessionsForWorkspace(');
  assert.ok(restore > 0, 'ENTER: the restore loop is in headless-main.js');
  assert.ok(guard > 0 && guard < warn && warn < restore, 'guard, then warn, then the restore call');
  assert.match(SRC.slice(warn, restore), /^[^\n]*\n\s*return;\n\s*\}\n\s*for \(const wsId of workspaceIds\) \{/);
  assert.strictEqual(SRC.split('engine.restoreSessionsForWorkspace(').length, 2, 'one restore call site, behind the guard');
});
