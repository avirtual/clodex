'use strict';

const KINDS = ['system', 'append'];

function teamPromptFile(deps, team, kind, stem) {
  const fs = deps && deps.fs;
  const path = deps && deps.path;
  if (!fs || !path) return null;
  if (!team || typeof team !== 'object' || typeof team.dir !== 'string' || !team.dir) return null;
  if (!KINDS.includes(kind)) return null;
  if (typeof stem !== 'string' || !stem) return null;
  if (stem.includes('/') || stem.includes('\\')) return null;
  if (stem === '.' || stem === '..' || stem.startsWith('..')) return null;
  let p;
  try {
    p = path.join(team.dir, 'prompts', kind, `${stem}.md`);
  } catch { return null; }
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return p;
  } catch { return null; }
}

module.exports = { teamPromptFile };
