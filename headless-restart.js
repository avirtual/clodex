'use strict';

const { createIdleWaiter, giveUpBody } = require('./restart-waiter');

const SUPERVISED_ENV = 'CLODEX_SUPERVISED';
const DECLINED = new Set(['0', 'false', 'no', 'off']);

function supervisorDeclared(env) {
  const raw = env ? env[SUPERVISED_ENV] : undefined;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return false;
  return !DECLINED.has(value.toLowerCase());
}

const UNSUPERVISED_REASON = 'no relaunch on this host: it restarts by exiting for a supervisor '
  + `to start it again, and ${SUPERVISED_ENV} is not set, so nothing would bring it back. `
  + `Run it under a supervisor that reruns it (systemd Restart=always, a docker restart policy, `
  + `a loop in the launcher) and set ${SUPERVISED_ENV}=1 there.`;

function createHeadlessRestart({
  env = process.env,
  log,
  getSessions,
  restart,
  lastInputAt,
  inFlightRuns,
  suiteJobs = () => [],
  fence = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  const supervised = supervisorDeclared(env);
  const waiter = createIdleWaiter({
    getSessions,
    now,
    setTimer,
    clearTimer,
    restart,
    lastInputAt,
    inFlightRuns,
    suiteJobs,
    fence,
    log,
    notify: (asked, why) => { try { log.warn('app', giveUpBody(asked, why)); } catch {} },
  });
  return {
    supervised,
    restartUnavailable: () => (supervised ? null : UNSUPERVISED_REASON),
    restartHostWhenIdle: (opts) => {
      waiter.arm({ onAbandon: opts && opts.onAbandon, requester: opts && opts.requester });
    },
    disarm: (opts) => waiter.disarm(opts),
    isArmed: () => waiter.isArmed(),
  };
}

function restartNowLine(cut) {
  const n = Number.isInteger(cut) && cut > 0 ? cut : 0;
  const base = 'restart requested — shutting down, exit 64 for supervisor relaunch';
  return n ? `${base}; cutting ${n} suite job${n === 1 ? '' : 's'} this machine is running for other teams` : base;
}

module.exports = {
  restartNowLine,
  SUPERVISED_ENV,
  UNSUPERVISED_REASON,
  supervisorDeclared,
  createHeadlessRestart,
};
