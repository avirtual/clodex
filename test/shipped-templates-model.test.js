'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'resources', 'library');

const KNOWN = [
  'kits/clodex/templates/clodex-team-hand.json',
  'kits/clodex/templates/clodex-team-lead.json',
  'kits/clodex/templates/clodex-team-reviewer.json',
  'kits/default/templates/hand.json',
  'kits/default/templates/lead.json',
  'templates/clodex-team-hand.json',
  'templates/clodex-team-lead.json',
  'templates/clodex-team-reviewer-shell.json',
  'templates/clodex-team-reviewer.json',
];

function walk() {
  const out = [];
  const dirs = [path.join(LIB, 'templates')];
  const kits = path.join(LIB, 'kits');
  if (fs.existsSync(kits)) {
    for (const kit of fs.readdirSync(kits)) {
      const d = path.join(kits, kit, 'templates');
      if (fs.existsSync(d)) dirs.push(d);
    }
  }
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const abs = path.join(d, f);
      out.push({ rel: path.relative(LIB, abs).split(path.sep).join('/'), abs });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function modelToken(extraArgs) {
  const a = Array.isArray(extraArgs) ? extraArgs : [];
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (typeof tok !== 'string') continue;
    if (tok === '--model' || tok === '-m') return a[i + 1];
    if (tok.startsWith('--model=')) return tok.slice('--model='.length);
  }
  return undefined;
}

test('every shipped claude-type library template pins a 1M-context model', () => {
  const all = walk();
  const claudeOnes = all.filter(({ abs }) => {
    const tpl = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    return (tpl.type || 'claude') === 'claude';
  });
  const found = claudeOnes.map((t) => t.rel);

  for (const rel of KNOWN) {
    assert.ok(
      found.includes(rel),
      `ENTER: the walk must reach ${rel} — it is a shipped claude-type seat template, and a walk that misses it makes every assertion below vacuous`,
    );
  }
  for (const { rel, abs } of claudeOnes) {
    const tpl = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    const model = modelToken(tpl.extraArgs);
    assert.ok(
      typeof model === 'string' && model.length > 0,
      `resources/library/${rel} carries no --model in extraArgs. type is ${JSON.stringify(tpl.type)} and absent means claude (team-tickets.js: tpl.type || 'claude'), so this file boots a real seat. The ruling is 1M everywhere: without a --model the CLI default applies, which is the 200k window.`,
    );
    assert.match(
      model,
      /\[1m\]$/,
      `resources/library/${rel} pins --model ${model}, which is not a 1M-context id. A bare alias like opus or sonnet resolves to the 200k window; the ruling is 1M everywhere, so the id must carry the [1m] suffix.`,
    );
  }
});
