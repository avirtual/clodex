'use strict';

const KINDS = ['system', 'append'];
const JSON_KINDS = ['templates', 'exec'];

function badStem(stem) {
  if (typeof stem !== 'string' || !stem) return true;
  if (stem.includes(':')) return true;
  if (stem.includes('/') || stem.includes('\\')) return true;
  if (stem === '.' || stem === '..' || stem.startsWith('..')) return true;
  return false;
}

function teamDir(deps, team) {
  const fs = deps && deps.fs;
  const path = deps && deps.path;
  if (!fs || !path) return null;
  if (!team || typeof team !== 'object' || typeof team.dir !== 'string' || !team.dir) return null;
  return { fs, path };
}

function teamPromptFile(deps, team, kind, stem) {
  const io = teamDir(deps, team);
  if (!io) return null;
  if (!KINDS.includes(kind)) return null;
  if (badStem(stem)) return null;
  let p;
  try {
    p = io.path.join(team.dir, 'prompts', kind, `${stem}.md`);
  } catch { return null; }
  try {
    io.fs.accessSync(p, io.fs.constants.R_OK);
    return p;
  } catch { return null; }
}

function teamJsonFile(deps, team, kind, stem) {
  const io = teamDir(deps, team);
  if (!io) return null;
  if (!JSON_KINDS.includes(kind)) return null;
  if (badStem(stem)) return null;
  let p;
  try {
    p = io.path.join(team.dir, kind, `${stem}.json`);
  } catch { return null; }
  try {
    io.fs.accessSync(p, io.fs.constants.R_OK);
    return p;
  } catch { return null; }
}

function readTeamJson(deps, team, kind, stem) {
  const p = teamJsonFile(deps, team, kind, stem);
  if (!p) return null;
  try {
    const obj = JSON.parse(deps.fs.readFileSync(p, 'utf-8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch { return null; }
}

module.exports = { badStem, teamPromptFile, teamJsonFile, readTeamJson };
