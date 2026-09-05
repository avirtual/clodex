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
const { BUNDLE_PROMPT_KINDS } = require(path.join(REPO, 'plugin-loader.js'));

const argv = process.argv.slice(2);
const positional = [];
let skillName = null;
let promptRef = null;
let templateName = null;
// A flag with no value is REFUSED, never treated as absent: `--skill` swallowing
// the plugin id as its value is the mistake the refusal exists to catch, and it
// would otherwise scaffold a plugin named after nothing.
const takeValue = (flag, i) => {
  if (argv[i + 1] === undefined) {
    console.error(`refused: ${flag} needs a value`);
    process.exit(2);
  }
  return argv[i + 1];
};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--skill') { skillName = takeValue('--skill', i); i++; continue; }
  if (argv[i].startsWith('--skill=')) { skillName = argv[i].slice('--skill='.length); continue; }
  if (argv[i] === '--prompt') { promptRef = takeValue('--prompt', i); i++; continue; }
  if (argv[i].startsWith('--prompt=')) { promptRef = argv[i].slice('--prompt='.length); continue; }
  if (argv[i] === '--template') { templateName = takeValue('--template', i); i++; continue; }
  if (argv[i].startsWith('--template=')) { templateName = argv[i].slice('--template='.length); continue; }
  positional.push(argv[i]);
}

const id = positional[0];
if (!id) {
  console.error('usage: scaffold.js <plugin-id> [target-dir] [--skill <name>] [--prompt <kind>/<stem>] [--template <stem>]');
  console.error(`  id must match ${PLUGIN_ID_RE}`);
  console.error(`  skill, prompt and template names must match ${AGENT_NAME_RE}`);
  console.error('  prompt kind must be "system" or "append"');
  process.exit(2);
}
if (skillName != null && !AGENT_NAME_RE.test(skillName)) {
  console.error(`refused: "${skillName}" is not a usable skill name (${AGENT_NAME_RE})`);
  process.exit(2);
}
let promptKind = null;
let promptStem = null;
if (promptRef != null) {
  const slash = promptRef.indexOf('/');
  promptKind = slash < 0 ? '' : promptRef.slice(0, slash);
  promptStem = slash < 0 ? promptRef : promptRef.slice(slash + 1);
  if (!BUNDLE_PROMPT_KINDS.includes(promptKind)) {
    console.error(`refused: --prompt takes <kind>/<stem>, where kind is ${BUNDLE_PROMPT_KINDS.join(' or ')} (got ${JSON.stringify(promptRef)})`);
    process.exit(2);
  }
  if (!AGENT_NAME_RE.test(promptStem)) {
    console.error(`refused: "${promptStem}" is not a usable prompt name (${AGENT_NAME_RE})`);
    process.exit(2);
  }
}
if (templateName != null && !AGENT_NAME_RE.test(templateName)) {
  console.error(`refused: "${templateName}" is not a usable template name (${AGENT_NAME_RE})`);
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

if (promptStem) {
  const promptDir = path.join(dir, 'prompts', promptKind);
  fs.mkdirSync(promptDir, { recursive: true });
  const body = promptKind === 'system'
    ? `TODO: the whole system prompt this seat boots with. It REPLACES the CLI's own,\nso there is nothing to strip and nothing else is prepended.\n`
    : `TODO: instructions composed onto whatever system prompt the seat already has.\n`;
  fs.writeFileSync(path.join(promptDir, `${promptStem}.md`), body);
}

if (templateName) {
  const templateDir = path.join(dir, 'templates');
  fs.mkdirSync(templateDir, { recursive: true });
  // A bare stem here on purpose: the loader rewrites it to `${id}:${promptStem}`
  // on read, and writing the namespaced form by hand is what the rewrite exists
  // to make unnecessary. `plugins` is left out for the same reason — the read
  // merges this plugin's own id in.
  const template = {
    name: templateName,
    type: 'claude',
    cwd: '${TEAM_ROOT}',
    ...(promptStem && promptKind === 'system' ? { systemPromptFile: promptStem } : {}),
    ...(promptStem && promptKind === 'append' ? { appendPromptFiles: [promptStem] } : {}),
  };
  fs.writeFileSync(path.join(templateDir, `${templateName}.json`), `${JSON.stringify(template, null, 2)}\n`);
}

console.log(`created ${dir}`);
if (skillName) console.log(`  skill:      skills/${skillName}/SKILL.md  ->  /${id}:${skillName}`);
if (promptStem) console.log(`  prompt:     prompts/${promptKind}/${promptStem}.md  ->  ${id}:${promptStem}`);
if (templateName) console.log(`  template:   templates/${templateName}.json  ->  ${id}:${templateName}`);
const shown = dir.startsWith(REPO + path.sep) ? path.relative(REPO, dir) : dir;
console.log(`  verify it:  node plugins/tools/verify.js ${shown}`);
