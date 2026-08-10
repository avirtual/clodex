// bin-materialize.js — stamps the exec helper scripts into ~/.clodex/bin/ at launch.
//
// WHY copy at all: the seeded exec-defs invoke `node "${CLODEX_BIN}/clodex-team.js"`,
// but in the packaged app the source lives sealed inside app.asar — not a path an
// external `node` can require across. So we stamp the scripts onto a stable,
// always-present path at every launch. Overwrite-always kills version drift: the
// bin/ copy can never lag the app that wrote it.
//
// Electron-free leaf (fs/path only) so it's unit-testable and can run headless.
'use strict';

const fs = require('fs');
const path = require('path');

// The exec-intent helper scripts (clodex-team roster, clodex-monitor). These are
// dependency-free (node builtins only), so a flat copy by relative path is
// sufficient — there is no require-closure to walk. test/exec-scripts-materialize.js
// pins that property: add a local require() to one of them and the test fails
// rather than the flat copy silently stranding it at runtime.
const EXEC_SCRIPTS = ['scripts/clodex-team.js', 'scripts/clodex-monitor.js'];

// Materialize the exec helper scripts into <root>/bin/, overwriting every launch.
// Copied by BASENAME into bin/ (flat, matching the ${CLODEX_BIN} argv the defs
// carry). No chmod: they're invoked via `/usr/bin/env node`, not executed
// directly. Best-effort per file — a copy failure is logged and skipped, never
// thrown, so a launch is never blocked by a missing helper.
function materializeExecScripts({ root, srcDir = __dirname, files = EXEC_SCRIPTS, log } = {}) {
  const binDir = path.join(root, 'bin');
  try { fs.mkdirSync(binDir, { recursive: true }); } catch {}
  let copied = 0;
  for (const f of files) {
    try {
      fs.copyFileSync(path.join(srcDir, f), path.join(binDir, path.basename(f)));
      copied += 1;
    } catch (e) {
      if (log) log.info('bin', `exec-script materialize skipped ${f} (${e && e.message})`);
    }
  }
  return { binDir, copied };
}

module.exports = { EXEC_SCRIPTS, materializeExecScripts };
