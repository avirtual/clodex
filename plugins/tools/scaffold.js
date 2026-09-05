#!/usr/bin/env node
// Create an empty, VALID plugin directory.
//
// Exists because the id rule is unenforceable by prose: the loader refuses a
// plugin whose directory name differs from its manifest `id`, and a documented
// hazard is still a hazard — a clean-room trial read the rule, tried to honour
// it, and still produced a directory the loader would have refused. Generating
// the pair from one argument removes the mismatch as a possibility instead of
// warning about it.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const { HOST_API_VERSION, isValidPluginId, PLUGIN_ID_RE } = require(path.join(REPO, 'plugin-api.js'));
const { AGENT_NAME_RE } = require(path.join(REPO, 'catalogs.js'));

const argv = process.argv.slice(2);
const positional = [];
let skillName = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--skill') { skillName = argv[++i]; continue; }
  if (argv[i].startsWith('--skill=')) { skillName = argv[i].slice('--skill='.length); continue; }
  positional.push(argv[i]);
}

const id = positional[0];
if (!id) {
  console.error('usage: scaffold.js <plugin-id> [target-dir] [--skill <name>]');
  console.error(`  id must match ${PLUGIN_ID_RE}`);
  console.error(`  skill name must match ${AGENT_NAME_RE}`);
  process.exit(2);
}
if (skillName != null && !AGENT_NAME_RE.test(skillName)) {
  console.error(`refused: "${skillName}" is not a usable skill name (${AGENT_NAME_RE})`);
  process.exit(2);
}
// Validated by the host's own predicate, not a copy of its regex: this refuses
// the reserved ids too, which a bare regex test would let through.
if (!isValidPluginId(id)) {
  console.error(`refused: "${id}" is not a usable plugin id (${PLUGIN_ID_RE}, and not a reserved name)`);
  process.exit(2);
}

const parent = positional[1] || path.join(REPO, 'plugins');
const dir = path.join(parent, id);
if (fs.existsSync(dir)) { console.error(`refused: ${dir} already exists`); process.exit(2); }

const manifest = {
  id,
  name: id,
  hostApi: HOST_API_VERSION,
  version: '0.1.0',
  entry: { engine: 'engine.js', renderer: 'renderer.js' },
  announce: `TODO: one sentence an agent reads to decide whether to use ${id}.`,
};

const engine = `'use strict';
// Engine half: plain Node, no Electron, no DOM. One instance per app.
module.exports = {
  activate(host) {
    host.log.info('${id} engine up');

    // Answers renderer-half invoke('${id}', 'ping', …). Returning a value is
    // enough; a thrown error reaches the caller as a rejection.
    host.ipc.handle('ping', () => ({ ok: true, at: Date.now() }));
  },

  deactivate() {},
};
`;

const renderer = `'use strict';
// Renderer half: DOM, one instance per window. Everything registered here must
// be released when the returned disposer runs, or a disable leaves it on screen.
module.exports = {
  activate(rhost) {
    const off = rhost.statusBar.addAction({
      id: 'ping',
      label: '${id}',
      async onClick() {
        const r = await rhost.invoke('ping');
        rhost.log.info('ping -> ' + JSON.stringify(r));
      },
    });
    return () => { off(); };
  },
};
`;

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(dir, 'engine.js'), engine);
fs.writeFileSync(path.join(dir, 'renderer.js'), renderer);

if (skillName) {
  const skillDir = path.join(dir, 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  const skill = `---
name: ${skillName}
description: TODO: one sentence telling an agent when to invoke /${id}:${skillName}.
---
TODO: the instructions the agent follows once it invokes this skill.
Only a seat that has the ${id} plugin can see it, and it arrives as /${id}:${skillName}.
`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill);
}

console.log(`created ${dir}`);
if (skillName) console.log(`  skill:      skills/${skillName}/SKILL.md  ->  /${id}:${skillName}`);
const shown = dir.startsWith(REPO + path.sep) ? path.relative(REPO, dir) : dir;
console.log(`  verify it:  node plugins/tools/verify.js ${shown}`);
