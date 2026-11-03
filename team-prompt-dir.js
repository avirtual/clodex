'use strict';

const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { splitPrivilegedArgs } = require('./cli-adapters');

const KINDS = ['system', 'append'];
const JSON_KINDS = ['templates', 'exec'];
const TEAM_STEM_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

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

function teamOwnedDir(deps, team, ...segments) {
  const path = deps && deps.path;
  const teamsDir = deps && deps.teamsDir;
  const listTeams = deps && deps.listTeams;
  if (!path || typeof teamsDir !== 'string' || !teamsDir) return null;
  if (typeof team !== 'string' || !TEAM_STEM_RE.test(team)) return null;
  let names;
  try { names = listTeams(); } catch { return null; }
  if (!Array.isArray(names) || !names.includes(team)) return null;
  try { return path.join(teamsDir, team, ...segments); } catch { return null; }
}

function teamTemplatePath(deps, team, stem) {
  if (badStem(stem) || !TEAM_STEM_RE.test(stem)) return null;
  return teamOwnedDir(deps, team, 'templates', `${stem}.json`);
}

function teamPromptPath(deps, team, kind, stem) {
  if (!KINDS.includes(kind)) return null;
  if (badStem(stem) || !TEAM_STEM_RE.test(stem)) return null;
  return teamOwnedDir(deps, team, 'prompts', kind, `${stem}.md`);
}

function noTeamOrStem(team, stem, what) {
  return `no team "${team}" or bad ${what} name "${stem}"`;
}

function priorTemplate(deps, file) {
  try {
    const prior = JSON.parse(deps.fs.readFileSync(file, 'utf-8'));
    return prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
  } catch { return {}; }
}

function teamTemplateSave(deps, team, stem, body, opts = {}) {
  const file = teamTemplatePath(deps, team, stem);
  if (!file) return { ok: false, error: noTeamOrStem(team, stem, 'template') };
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string') {
    return { ok: false, error: 'a template body must be an object with a string type' };
  }
  let out = body;
  let mcpIgnored = false;
  const stripped = [];
  if (!(opts && opts.operator === true)) {
    const prior = priorTemplate(deps, file);
    const { mcpServers, ...rest } = body;
    mcpIgnored = mcpServers !== undefined;
    out = Array.isArray(prior.mcpServers) ? { ...rest, mcpServers: prior.mcpServers } : rest;
    if (!(opts && opts.derived === true)) {
      const { execCommands, ...noExec } = out;
      if (execCommands !== undefined) stripped.push('execCommands');
      out = Array.isArray(prior.execCommands) ? { ...noExec, execCommands: prior.execCommands } : noExec;
      if (out.extraArgs !== undefined && !Array.isArray(out.extraArgs)) {
        const { extraArgs, ...noArgs } = out;
        stripped.push('extraArgs');
        out = noArgs;
      }
      const { kept, flags } = splitPrivilegedArgs(out.extraArgs);
      const priorPrivileged = splitPrivilegedArgs(prior.extraArgs).privileged;
      stripped.push(...flags);
      if (flags.length || priorPrivileged.length) out = { ...out, extraArgs: [...kept, ...priorPrivileged] };
    }
  }
  try {
    ensureDir(deps.path.dirname(file));
    atomicWriteFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file, ...(mcpIgnored ? { mcpIgnored } : {}), ...(stripped.length ? { stripped } : {}) };
}

function teamTemplateRemove(deps, team, stem) {
  const file = teamTemplatePath(deps, team, stem);
  if (!file) return { ok: false, error: noTeamOrStem(team, stem, 'template') };
  try { deps.fs.unlinkSync(file); }
  catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file };
}

function teamPromptSave(deps, team, kind, stem, body) {
  if (!KINDS.includes(kind)) return { ok: false, error: `prompt kind must be ${KINDS.join(' or ')} (got "${kind}")` };
  const file = teamPromptPath(deps, team, kind, stem);
  if (!file) return { ok: false, error: noTeamOrStem(team, stem, 'prompt') };
  const text = String(body == null ? '' : body);
  if (!text.trim()) return { ok: false, error: 'a prompt body must not be empty' };
  try {
    ensureDir(deps.path.dirname(file));
    atomicWriteFileSync(file, text);
  } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file };
}

function teamPromptRemove(deps, team, kind, stem) {
  if (!KINDS.includes(kind)) return { ok: false, error: `prompt kind must be ${KINDS.join(' or ')} (got "${kind}")` };
  const file = teamPromptPath(deps, team, kind, stem);
  if (!file) return { ok: false, error: noTeamOrStem(team, stem, 'prompt') };
  try { deps.fs.unlinkSync(file); }
  catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file };
}

module.exports = {
  KINDS,
  badStem,
  teamPromptFile,
  teamJsonFile,
  readTeamJson,
  TEAM_STEM_RE,
  teamTemplatePath,
  teamPromptPath,
  teamTemplateSave,
  teamTemplateRemove,
  teamPromptSave,
  teamPromptRemove,
};
