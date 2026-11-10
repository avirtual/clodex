'use strict';

const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { splitPrivilegedArgs, privilegedGroups, canonicalBypassFlag } = require('./cli-adapters');

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

function listTeamJson(deps, team, kind) {
  const io = teamDir(deps, team);
  if (!io || !JSON_KINDS.includes(kind)) return [];
  let files;
  try { files = io.fs.readdirSync(io.path.join(team.dir, kind)); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (typeof f !== 'string' || !f.endsWith('.json')) continue;
    const stem = f.slice(0, -'.json'.length);
    if (!TEAM_STEM_RE.test(stem)) continue;
    const obj = readTeamJson(deps, team, kind, stem);
    if (obj) out.push({ stem, obj });
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem));
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

function saverHolding(saver) {
  if (!saver || typeof saver !== 'object' || typeof saver.name !== 'string' || saver.name !== saver.lead) return null;
  const rec = saver.record;
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  return mayGrantOf(saver.holdOnly === true ? { ...rec, grantable: null } : rec);
}

function mayGrantOf(rec) {
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const g = rec.grantable && typeof rec.grantable === 'object' && !Array.isArray(rec.grantable) ? rec.grantable : {};
  return {
    execCommands: [...new Set([...list(rec.execCommands), ...list(g.execCommands)])],
    intents: list(g.intents),
    extraArgs: [...list(rec.extraArgs), ...list(g.flags)],
  };
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
    const { mcpServers, grantable, ...rest } = body;
    mcpIgnored = mcpServers !== undefined;
    if (grantable !== undefined) stripped.push('grantable');
    out = Array.isArray(prior.mcpServers) ? { ...rest, mcpServers: prior.mcpServers } : rest;
    if (!(opts && opts.derived === true)) {
      const holder = saverHolding(opts && opts.saver);
      const { execCommands, ...noExec } = out;
      const keptExec = [];
      if (holder && Array.isArray(execCommands)) {
        const held = Array.isArray(holder.execCommands) ? holder.execCommands.map(String) : [];
        for (const c of execCommands) {
          if (typeof c === 'string' && held.includes(c)) { if (!keptExec.includes(c)) keptExec.push(c); }
          else if (!stripped.includes(String(c))) stripped.push(String(c));
        }
      } else if (execCommands !== undefined) stripped.push('execCommands');
      const priorExec = Array.isArray(prior.execCommands) ? prior.execCommands : null;
      if (keptExec.length) out = { ...noExec, execCommands: [...keptExec, ...(priorExec || []).filter((c) => !keptExec.includes(c))] };
      else out = priorExec ? { ...noExec, execCommands: priorExec } : noExec;
      if (out.extraArgs !== undefined && !(Array.isArray(out.extraArgs) && out.extraArgs.every((t) => typeof t === 'string'))) {
        const { extraArgs, ...noArgs } = out;
        stripped.push('extraArgs');
        out = noArgs;
      }
      const flagKey = ([f, v]) => `${canonicalBypassFlag(f)}\0${v}`;
      const heldFlags = new Set(holder ? splitPrivilegedArgs(holder.extraArgs).pairs.map(flagKey) : []);
      const kept = [];
      const keptPrivileged = [];
      let privilegedSeen = false;
      for (const g of privilegedGroups(out.extraArgs)) {
        if (g.name === null) { kept.push(...g.tokens); continue; }
        privilegedSeen = true;
        if (g.pairs.every((p) => heldFlags.has(flagKey(p)))) keptPrivileged.push(g.tokens);
        else if (!stripped.includes(g.name)) stripped.push(g.name);
      }
      const keptJson = keptPrivileged.map((t) => JSON.stringify(t));
      const priorPrivileged = privilegedGroups(prior.extraArgs)
        .filter((g) => g.name !== null && !keptJson.includes(JSON.stringify(g.tokens)));
      if (privilegedSeen || priorPrivileged.length) {
        out = { ...out, extraArgs: [...kept, ...keptPrivileged.flat(), ...priorPrivileged.flatMap((g) => g.tokens)] };
      }
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
  listTeamJson,
  TEAM_STEM_RE,
  teamTemplatePath,
  teamPromptPath,
  teamTemplateSave,
  mayGrantOf,
  teamTemplateRemove,
  teamPromptSave,
  teamPromptRemove,
};
