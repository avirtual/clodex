'use strict';

function processStubs() {
  const killed = [];
  const psCalls = [];
  const psOnly = (file) => {
    if (file !== 'ps') throw new Error(`process-stubs: ${file} is not stubbed`);
    psCalls.push(file);
  };
  return {
    killed,
    psCalls,
    killPid: (pid, sig) => { killed.push({ pid, sig }); },
    childProcess: {
      execFile(file, _args, _opts, cb) { psOnly(file); cb(null, ''); },
      execFileSync(file) { psOnly(file); return ''; },
    },
  };
}

module.exports = { processStubs };
