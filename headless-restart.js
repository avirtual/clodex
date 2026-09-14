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
    notify: (asked) => { try { log.warn('app', giveUpBody(asked)); } catch {} },
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

module.exports = {
  SUPERVISED_ENV,
  UNSUPERVISED_REASON,
  supervisorDeclared,
  createHeadlessRestart,
};
