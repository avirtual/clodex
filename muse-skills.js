'use strict';

const { isSkillDenyDirective, skillDenyKeepList } = require('./skills-off');

const EMITTED_SCOPES = ['bundled', 'plugin', 'user'];
const LIST_TIMEOUT_MS = 30000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;
const STDERR_CAP = 200;

function parseSkillsList(json) {
  let doc = json;
  if (typeof json === 'string') {
    try { doc = JSON.parse(json); } catch { return []; }
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.skills)) return [];
  const out = [];
  for (const s of doc.skills) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.id !== 'string' || !s.id || typeof s.path !== 'string' || !s.path) continue;
    out.push({
      id: s.id,
      scope: typeof s.scope === 'string' ? s.scope : '',
      path: s.path,
      activation: typeof s.activation === 'string' ? s.activation : '',
    });
  }
  return out;
}

function skillDirName(p) {
  const parts = String(p).split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return parts[parts.length - 2];
}

function matchKeys(skill) {
  const keys = new Set([skill.id]);
  const dir = skillDirName(skill.path);
  if (dir) keys.add(dir);
  return keys;
}

function skillAliases(skills) {
  const aliases = {};
  for (const skill of Array.isArray(skills) ? skills : []) {
    for (const key of matchKeys(skill)) {
      if (key !== skill.id && !Object.hasOwn(aliases, key)) aliases[key] = skill.id;
    }
  }
  return aliases;
}

function nameSet(list) {
  return new Set((Array.isArray(list) ? list : []).filter((n) => typeof n === 'string' && n));
}

function resolveOffSkills(skills, disabledSkills, { injectSkills = [] } = {}) {
  const list = Array.isArray(disabledSkills) ? disabledSkills : [];
  const roster = Array.isArray(skills) ? skills : [];
  const sweep = list.includes('*');
  const exempt = new Set([...nameSet(injectSkills), ...skillDenyKeepList(list)]);
  const explicit = nameSet(list.filter((n) => !isSkillDenyDirective(n)));
  const out = [];
  for (const skill of roster) {
    const keys = matchKeys(skill);
    const hit = [...keys].some((k) => explicit.has(k));
    const swept = sweep && ![...keys].some((k) => exempt.has(k));
    if (hit || swept) out.push(skill);
  }
  return out;
}

function activationBlock(skills, offNames, { off = 'off' } = {}) {
  const wanted = nameSet(offNames);
  const block = {};
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!EMITTED_SCOPES.includes(skill.scope)) continue;
    if (![...matchKeys(skill)].some((k) => wanted.has(k))) continue;
    if (!block[skill.scope]) block[skill.scope] = {};
    block[skill.scope][skill.path] = off;
  }
  return Object.keys(block).length ? block : null;
}

function nestUnder(key, value) {
  const parts = String(key).split('.').filter(Boolean);
  let out = value;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i]]: out };
  return out;
}

function activationSettings(adapterSkills, skills, disabledSkills, { injectSkills = [] } = {}) {
  if (!adapterSkills || !adapterSkills.activation) return null;
  const off = resolveOffSkills(skills, disabledSkills, { injectSkills });
  const block = activationBlock(off, off.map((s) => s.id), { off: adapterSkills.activation.off });
  if (!block) return null;
  return nestUnder(adapterSkills.activation.key, block);
}

function createSkillLister({ execFileSync, scratchDir, env = {}, log = null }) {
  const cache = new Map();
  function list(adapter, { configDir } = {}) {
    const spec = adapter && adapter.skills && adapter.skills.list;
    if (!spec || !configDir) return [];
    const key = `${adapter.id}\0${configDir}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const runEnv = { ...env, ...(spec.extraEnv || {}), [spec.env]: configDir };
      if (spec.scratchEnv && scratchDir) runEnv[spec.scratchEnv] = scratchDir;
      const out = execFileSync(adapter.cmd, spec.args, {
        env: runEnv, encoding: 'utf8', timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const skills = parseSkillsList(out);
      cache.set(key, skills);
      return skills;
    } catch (e) {
      if (log && typeof log.warn === 'function') {
        const stderr = e && typeof e.stderr === 'string' ? e.stderr.trim().slice(0, STDERR_CAP) : '';
        const head = String((e && e.message) || e).split('\n')[0];
        const cause = `${head}${stderr ? `: ${stderr}` : ''}`;
        log.warn('skills', `${adapter.cmd} ${spec.args.join(' ')} failed for ${configDir}: ${cause}`);
      }
      return [];
    }
  }
  return { list, clear: () => cache.clear() };
}

module.exports = {
  parseSkillsList, resolveOffSkills, skillAliases, activationBlock, activationSettings, createSkillLister,
  skillDirName, EMITTED_SCOPES, LIST_TIMEOUT_MS,
};
