'use strict';

const SKILL_PLUGIN_NAME = 'clodex-skills';

function expandSkillsOff(disabledSkills, { known = [], injectSkills = [] } = {}) {
  if (!Array.isArray(disabledSkills) || !disabledSkills.includes('*')) return disabledSkills;
  const injected = new Set();
  for (const n of Array.isArray(injectSkills) ? injectSkills : []) {
    if (typeof n !== 'string' || !n) continue;
    injected.add(n);
    injected.add(`${SKILL_PLUGIN_NAME}:${n}`);
  }
  const out = new Set();
  for (const n of [...disabledSkills, ...(Array.isArray(known) ? known : [])]) {
    if (typeof n !== 'string' || !n || n === '*') continue;
    if (injected.has(n)) continue;
    out.add(n);
  }
  return [...out].sort();
}

module.exports = { expandSkillsOff };
