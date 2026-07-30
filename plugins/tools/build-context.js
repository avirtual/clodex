#!/usr/bin/env node
// Assemble the plugin-authoring context pack, fresh, from this repo.
//
// WHY IT GENERATES INSTEAD OF SHIPPING A FILE: a committed pack is a second copy
// of the docs and drifts the moment either doc is edited — and a drifted pack is
// worse than none, because a plugin built against it fails for reasons the author
// cannot see. Generating on demand means there is no second copy to go stale, so
// there is no staleness check to forget to run. The output is a build artifact:
// never commit it.
//
// The FACTS block is extracted from the modules that own each value, never
// retyped here. plugins/plugin-api.md:143 already restates PLUGIN_ID_RE and
// :1068 restates the verb regex; both happen to be correct today, and nothing
// pins them. Anything this tool prints comes from the source of truth, so the
// pack cannot contradict the host even when the prose does.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PLUGINS = path.join(REPO, 'plugins');

const api = require(path.join(REPO, 'plugin-api.js'));
const intents = require(path.join(REPO, 'intent-registry.js'));

// Full pack by default. plugin-sources.md is mostly distribution — precedence,
// shadowing, trust, install flow — and only three of its sections bear on
// AUTHORING, so a leaner pack is plausible. It stays opt-in (--lean) because the
// full pack is the only composition a real trial has produced a working plugin
// from: trimming it is a hypothesis, and verify.js is how it gets tested.
const LEAN = process.argv.includes('--lean');
const PARTS = LEAN
  ? ['README.md', 'plugin-api.md', 'tools/README.md']
  : ['README.md', 'plugin-api.md', 'plugin-sources.md', 'tools/README.md'];

// The example plugin an author is told to copy. git-branches is the reference:
// it uses both halves, a settings section, a session hook and an intent verb.
const EXAMPLE = 'git-branches';
const EXAMPLE_FILES = ['manifest.json', 'engine.js', 'renderer.js'];

function facts() {
  const verbs = intents.CORE_TYPES ? [...intents.CORE_TYPES] : [];
  // RESERVED_TYPES is a superset of CORE_TYPES; listing the overlap twice reads
  // as two separate prohibitions and hides the few names that are ONLY reserved.
  const core = new Set(verbs);
  const reserved = [...intents.RESERVED_TYPES || []].filter((t) => !core.has(t));
  return `## Host facts (generated from source — authoritative over any prose below)

| Fact | Value | Owner |
|---|---|---|
| \`hostApi\` (exact string) | \`"${api.HOST_API_VERSION}"\` | plugin-api.js |
| Plugin id regex | \`${api.PLUGIN_ID_RE}\` | plugin-api.js |
| Reserved plugin ids | ${[...api.RESERVED_PLUGIN_IDS].map((s) => `\`${s}\``).join(', ') || '(none)'} | plugin-api.js |
| Intent verb regex | \`${intents.PLUGIN_VERB_RE}\` | intent-registry.js |
| Verbs already taken by core | ${verbs.map((s) => `\`${s}\``).join(', ')} | intent-registry.js |
| Additionally reserved verbs | ${reserved.map((s) => `\`${s}\``).join(', ')} | intent-registry.js |

Your plugin's directory name MUST equal its manifest \`id\` — the loader matches
them and refuses a mismatch. Verbs live in ONE global namespace shared with core
and every other plugin; picking one already listed above means yours never fires.
`;
}

function read(rel) {
  const p = path.join(PLUGINS, rel);
  return `<!-- ${path.relative(REPO, p)} -->\n\n${fs.readFileSync(p, 'utf8')}`;
}

function example() {
  const dir = path.join(PLUGINS, EXAMPLE);
  const langOf = (f) => (f.endsWith('.json') ? 'json' : 'js');
  const blocks = EXAMPLE_FILES.map((f) => {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    return `### \`${EXAMPLE}/${f}\`\n\n\`\`\`${langOf(f)}\n${body}\n\`\`\``;
  });
  return `## A complete, shipped, working plugin\n\nThis is the real ${EXAMPLE} plugin, verbatim. It passes `
    + `\`node plugins/tools/verify.js plugins/${EXAMPLE}\`.\n\n${blocks.join('\n\n')}`;
}

const out = [facts(), ...PARTS.map(read), example()].join('\n\n---\n\n');

const dest = process.argv.filter((a) => !a.startsWith('--'))[2]
  || path.join(REPO, `plugin-context${LEAN ? '.lean' : ''}.md`);
fs.writeFileSync(dest, out);

const bytes = Buffer.byteLength(out);
console.log(`wrote ${dest}`);
console.log(`  ${bytes} bytes, ~${Math.round(bytes / 4000)}k tokens, ${out.split('\n').length} lines`);
console.log(`  facts extracted from plugin-api.js + intent-registry.js`);
console.log(`  parts: ${PARTS.join(', ')}, example ${EXAMPLE}`);
