'use strict';

const path = require('path');

const CHILD_FLAG = '--clodex-electron-child=';

function childScriptFromArgv(argv) {
  const hits = (Array.isArray(argv) ? argv : []).filter((a) => typeof a === 'string' && a.startsWith(CHILD_FLAG));
  if (hits.length === 0) return null;
  if (hits.length > 1) return { error: `${CHILD_FLAG} given ${hits.length} times` };
  const script = hits[0].slice(CHILD_FLAG.length);
  if (!script) return { error: `${CHILD_FLAG} has an empty value` };
  if (!path.isAbsolute(script)) return { error: `${CHILD_FLAG} needs an absolute path: ${script}` };
  if (!script.endsWith('.js')) return { error: `${CHILD_FLAG} needs a .js file: ${script}` };
  return { script };
}

function runChild(parsed, electron, argv) {
  if (!parsed || parsed.error || !parsed.script) {
    process.stderr.write(`clodex electron child: ${(parsed && parsed.error) || 'no child script'}\n`);
    process.exit(2);
    return;
  }
  try {
    require(parsed.script).run(electron, { argv });
  } catch (e) {
    process.stderr.write(`clodex electron child: ${parsed.script} failed: ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}

function childSpawnSpec({ execPath, isPackaged, appPath, script, extraArgs, env }) {
  const childEnv = { ...(env || {}) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return {
    command: execPath,
    args: [...(isPackaged ? [] : [appPath]), CHILD_FLAG + script, ...(extraArgs || [])],
    env: childEnv,
  };
}

module.exports = { CHILD_FLAG, childScriptFromArgv, runChild, childSpawnSpec };
