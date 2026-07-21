#!/usr/bin/env node
// clodexctl — thin process shim over src/main.js:run. run() returns an exit
// code (never exits itself) so it stays testable; this file owns the one
// process.exit and the top-level catch.
'use strict';

const { run } = require('../src/main');

run(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    // run() catches CliErrors internally; anything here is a bug. Scrub nothing
    // specific (no token in scope) but keep it terse.
    process.stderr.write(`clodexctl: fatal: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
