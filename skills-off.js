'use strict';

const SKILL_PLUGIN_NAME = 'clodex-skills';

function isSkillDenyDirective(name) {
  return typeof name === 'string' && (name === '*' || name.startsWith('!'));
}

function skillDenyIsDeferred(disabledSkills) {
  const list = Array.isArray(disabledSkills) ? disabledSkills : [...(disabledSkills || [])];
  return list.includes('*');
}

function deferredSkillDeny(keep) {
  const names = [...new Set((Array.isArray(keep) ? keep : [])
    .filter((n) => typeof n === 'string' && n && !isSkillDenyDirective(n)))];
  return ['*', ...names.map((n) => `!${n}`)];
}

function skillDenyKeepList(disabledSkills) {
  const list = Array.isArray(disabledSkills) ? disabledSkills : [...(disabledSkills || [])];
  return list
    .filter((n) => typeof n === 'string' && n.startsWith('!') && n.length > 1)
    .map((n) => n.slice(1));
}

function skillOffSetFor(names, disabledSkills) {
  const list = Array.isArray(disabledSkills) ? disabledSkills : [...(disabledSkills || [])];
  if (!list.includes('*')) {
    return new Set(list.filter((n) => typeof n === 'string' && n && !isSkillDenyDirective(n)));
  }
  const keep = new Set(skillDenyKeepList(list));
  return new Set((Array.isArray(names) ? names : []).filter((n) => !keep.has(n)));
}

function expandSkillsOff(disabledSkills, { known = [], injectSkills = [] } = {}) {
  if (!Array.isArray(disabledSkills)) return disabledSkills;
  const deferred = disabledSkills.includes('*');
  const keep = skillDenyKeepList(disabledSkills);
  if (!deferred && !keep.length) return disabledSkills;
  const exempt = new Set();
  for (const n of [...(Array.isArray(injectSkills) ? injectSkills : []), ...keep]) {
    if (typeof n !== 'string' || !n) continue;
    exempt.add(n);
    exempt.add(`${SKILL_PLUGIN_NAME}:${n}`);
  }
  const out = new Set();
  for (const n of [...disabledSkills, ...(deferred && Array.isArray(known) ? known : [])]) {
    if (typeof n !== 'string' || !n || isSkillDenyDirective(n)) continue;
    if (exempt.has(n)) continue;
    out.add(n);
  }
  return [...out].sort();
}

module.exports = {
  expandSkillsOff, deferredSkillDeny, skillOffSetFor,
  skillDenyKeepList, skillDenyIsDeferred, isSkillDenyDirective,
};
