'use strict';

const CATALOG_HEADING = '# Clodex skills';
const CATALOG_INTRO = 'Skills selected for this seat. Each line names a SKILL.md; read it with your file tools when a task matches its description, not up front.';
const NO_DESCRIPTION = '(no description)';

function sortedRecords(records) {
  return (records || [])
    .filter((r) => r && typeof r.name === 'string' && r.name)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function deliverClaude(deps, name, records) {
  const { fs, path, confine, ensureDir, SKILL_PLUGINS_DIR, SKILL_PLUGIN_NAME, buildSkillPlugin } = deps;
  const list = records || [];
  const plugin = buildSkillPlugin(list.map((s) => s.name), list, SKILL_PLUGIN_NAME);
  const dir = confine(SKILL_PLUGINS_DIR, name);
  if (dir === null) throw new Error(`invalid session name: ${name}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!plugin) return null;
  const manifestDir = path.join(dir, '.claude-plugin');
  ensureDir(manifestDir);
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify(plugin.manifest, null, 2), { mode: 0o600 });
  for (const s of plugin.skills) {
    const sdir = path.join(dir, 'skills', s.name);
    ensureDir(sdir);
    fs.writeFileSync(path.join(sdir, 'SKILL.md'), s.skillMd, { mode: 0o600 });
  }
  return { args: ['--plugin-dir', dir], instructions: null };
}

function deliverCodex(deps, name, records) {
  const { fs, path, confine, ensureDir, SKILL_PLUGINS_DIR, skillMd, parseSkillFrontmatter } = deps;
  const dir = confine(SKILL_PLUGINS_DIR, name);
  if (dir === null) throw new Error(`invalid session name: ${name}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const skillsRoot = path.join(dir, 'skills');
  const lines = [];
  for (const rec of sortedRecords(records)) {
    const sdir = confine(skillsRoot, rec.name);
    if (sdir === null) continue;
    ensureDir(sdir);
    const file = path.join(sdir, 'SKILL.md');
    fs.writeFileSync(file, skillMd(rec.name, rec.content || ''), { mode: 0o600 });
    const meta = parseSkillFrontmatter(rec.content || '').meta || {};
    lines.push(`- ${rec.name}: ${meta.description || NO_DESCRIPTION} — ${file}`);
  }
  if (!lines.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return null;
  }
  return { args: [], instructions: `${CATALOG_HEADING}\n\n${CATALOG_INTRO}\n\n${lines.join('\n')}` };
}

function cleanupSeatDir(deps, name) {
  const { fs, confine, SKILL_PLUGINS_DIR } = deps;
  const dir = confine(SKILL_PLUGINS_DIR, name);
  if (dir === null) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const ADAPTERS = { claude: deliverClaude, codex: deliverCodex };

function createSkillDelivery(deps) {
  return {
    providers: () => Object.keys(ADAPTERS),
    deliver(provider, name, records) {
      const adapter = ADAPTERS[provider];
      if (!adapter) return null;
      return adapter(deps, name, records);
    },
    cleanup(provider, name) {
      if (!ADAPTERS[provider]) return;
      cleanupSeatDir(deps, name);
    },
  };
}

module.exports = { createSkillDelivery, CATALOG_HEADING, CATALOG_INTRO, NO_DESCRIPTION };
