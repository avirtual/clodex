'use strict';

const FAR_HOME_ROOT = { linux: '/home', darwin: '/Users' };

function farCwdGuess({ cwd, farPlatform, platform, homedir, username } = {}) {
  const local = typeof cwd === 'string' ? cwd : '';
  if (!local || !farPlatform || !platform || farPlatform === platform) {
    return { cwd: local, note: null };
  }
  const root = FAR_HOME_ROOT[farPlatform];
  const home = typeof homedir === 'string' ? homedir : '';
  const note = `The peer runs ${farPlatform}; the folder was guessed from yours — check it exists there.`;
  if (!root || !home || !username) return { cwd: local, note };
  const prefix = home.endsWith('/') ? home : `${home}/`;
  if (local !== home && !local.startsWith(prefix)) return { cwd: local, note };
  const rest = local === home ? '' : local.slice(prefix.length);
  const farHome = `${root}/${username}`;
  return { cwd: rest ? `${farHome}/${rest}` : farHome, note };
}

module.exports = { farCwdGuess };
