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
const { seatHasPlugin } = require('./plugin-api');

// The exec-intent helper scripts. These are dependency-free
// (node builtins only), so a flat copy by relative path is
// sufficient — there is no require-closure to walk. test/exec-scripts-materialize.test.js
// pins that property: add a local require() to one of them and the test fails
// rather than the flat copy silently stranding it at runtime.
const EXEC_SCRIPTS = ['scripts/clodex-team.js', 'scripts/clodex-monitor.js', 'scripts/clodex-run-tests.js', 'scripts/clodex-ctl-admin.js'];

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

const SEAT_VERB_SRC = 'cli/bin/clodex.js';
const SEAT_VERB_NAME = 'clodex-send';

function materializeSeatVerb({ root, srcDir = __dirname, log } = {}) {
  const binDir = path.join(root, 'bin');
  const dest = path.join(binDir, SEAT_VERB_NAME);
  try {
    fs.mkdirSync(binDir, { recursive: true });
    const bytes = fs.readFileSync(path.join(srcDir, SEAT_VERB_SRC));
    fs.writeFileSync(dest, bytes);
    fs.chmodSync(dest, 0o755);
    try { fs.rmSync(path.join(binDir, 'clodex'), { force: true }); } catch {}
    return { binDir, path: dest };
  } catch (e) {
    if (log) log.info('bin', `seat verb materialize skipped (${e && e.message})`);
    return { binDir, path: null };
  }
}

const SEAT_BIN_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

function seatBinsFor({ bins, intents, plugins }) {
  if (!Array.isArray(bins) || !Array.isArray(intents)) return [];
  return bins.filter((b) => b && typeof b.verb === 'string' && intents.includes(b.verb)
    && seatHasPlugin(b.id, Array.isArray(plugins) ? plugins : null, b.shipped)
    && typeof b.name === 'string' && SEAT_BIN_NAME_RE.test(b.name));
}

function materializeSeatBins({ binDir, bins, log }) {
  const installed = [];
  for (const b of bins) {
    const dir = path.resolve(b.dir);
    const src = path.resolve(dir, String(b.src));
    if (!src.startsWith(dir + path.sep)) continue;
    const dest = path.join(binDir, b.name);
    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(src));
      fs.chmodSync(dest, 0o755);
      installed.push({ name: b.name, path: dest, env: Array.isArray(b.env) ? b.env : [] });
    } catch (e) {
      if (log) log.info('bin', `seat bin ${b.id}/${b.name} skipped (${e && e.message})`);
    }
  }
  return installed;
}

function seatBinEnv({ installed, explicit = {} }) {
  const out = {};
  for (const b of installed) {
    for (const k of b.env) if (!Object.prototype.hasOwnProperty.call(explicit, k)) out[k] = b.path;
  }
  return out;
}

module.exports = {
  EXEC_SCRIPTS, SEAT_VERB_SRC, SEAT_VERB_NAME, SEAT_BIN_NAME_RE,
  materializeExecScripts, materializeSeatVerb, seatBinsFor, materializeSeatBins, seatBinEnv,
};
