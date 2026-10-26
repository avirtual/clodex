'use strict';

const { after } = require('node:test');
const os = require('node:os');

const built = [];
after(shutdownAll);

const { mkTmpRoot } = require('./tmp-roots');

const REAL_HOME = os.homedir();
const ISOLATED_ENV = { CLODEX_WIRESCOPE: 'off', HOME: mkTmpRoot('engine-home-') };
Object.assign(process.env, ISOLATED_ENV);

const engineModule = require('../../engine');

function createEngine(opts) {
  const engine = engineModule.createEngine(opts);
  built.push(engine);
  return engine;
}

function shutdownAll() {
  for (const engine of built.splice(0)) {
    try { engine.shutdown(); } catch {}
    try { clearInterval(engine.manager._pendingPollTimer); } catch {}
  }
}

module.exports = { ...engineModule, createEngine, shutdownAll, built, ISOLATED_ENV, REAL_HOME };
