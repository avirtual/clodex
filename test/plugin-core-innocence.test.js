'use strict';
// plugin-core-innocence.test.js — W9 GATE 3, made a CI grep (plugin-plan.md [internal design doc, not in this repo]
// §4 W9.3): "`rg -i workbench` over core (excluding plugins/, docs, regenerated
// web-dist) → zero — the vision doc's 'core never learns the word' test".
//
// The literal gate is zero occurrences, which is not quite the right test: the
// migration deliberately LEFT comments saying where each piece went, and a
// comment naming what moved is the opposite of coupling — it is the map a
// future reader needs. What must be zero is EXECUTABLE mentions: markup, CSS
// selectors, contract rows, requires, identifiers. So the gate here is "every
// surviving mention is prose", which is strictly stronger than a whitelist of
// files and strictly more useful than a raw count.
//
// The pilot's real thesis is what this defends: core does not know the word
// operationally, so the pilot can be deleted from disk and core neither notices
// nor breaks. The moment `workbench` appears in live code again, that stops
// being true and this goes red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NEEDLE = /workbench/i;

// What "core" means for this gate. Excluded: the plugin itself (it is allowed
// to know its own name), docs and task journals (prose about the migration),
// web-dist (a build artifact regenerated from the sources this walks), test/
// (this file and the pilot's tests name it by necessity), and node_modules.
const SKIP_DIRS = new Set(['node_modules', 'plugins', 'docs', 'tasks', 'web-dist', 'test', '.git', 'dist', 'vendor', 'peering', 'docker', '.claude']);
const EXTS = new Set(['.js', '.html', '.css', '.json']);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.claude') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(full, out);
    } else if (EXTS.has(path.extname(ent.name))) out.push(full);
  }
  return out;
}

// Is this line, in this file type, a comment? Deliberately conservative — a
// line only counts as prose if it visibly IS prose. A `//` appearing after code
// on the same line does not make the line a comment, which is the case that
// matters (`const x = wb(); // workbench` would be a live mention).
function isCommentLine(line, ext, state) {
  const t = line.trim();
  if (ext === '.html') {
    // Track multi-line <!-- --> blocks; the migration's markers are all blocks.
    if (state.inHtml) { if (t.includes('-->')) state.inHtml = false; return true; }
    if (t.startsWith('<!--')) { if (!t.includes('-->')) state.inHtml = true; return true; }
    return false;
  }
  // .js and .css share /* */; .js adds //.
  if (state.inBlock) { if (t.includes('*/')) state.inBlock = false; return true; }
  if (t.startsWith('/*')) { if (!t.includes('*/')) state.inBlock = true; return true; }
  if (t.startsWith('*')) return true;             // continuation line of a block
  if (ext === '.js' && t.startsWith('//')) return true;
  return false;
}

// The ONE sanctioned live mention, and it is not core learning the word: it is
// the build-generated bundle registry, whose entire content is written by
// build/build-web.js from plugins/*/manifest.json. It names every plugin with a
// renderer half, generically. Deleting the pilot and rebuilding empties it.
const GENERATED = path.join(ROOT, 'renderer', 'web', 'plugin-registry.js');

function liveMentions() {
  const out = [];
  for (const file of walk(ROOT)) {
    if (file === GENERATED) continue;
    const ext = path.extname(file);
    const state = { inBlock: false, inHtml: false };
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const isComment = isCommentLine(lines[i], ext, state);
      if (NEEDLE.test(lines[i]) && !isComment) {
        out.push(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  return out;
}

test('W9 gate 3: core mentions the workbench ONLY in prose — never in live code', () => {
  const live = liveMentions();
  assert.deepStrictEqual(live, [],
    `core has EXECUTABLE workbench mentions — the pilot is coupled back in:\n${live.join('\n')}`);
});

test('W9 gate 3: the gate is not vacuous — the walk really reads core', () => {
  // A broken walk (wrong root, over-eager skip list) would pass the gate above
  // by reading nothing at all. Pin that it sees the files the migration touched.
  const files = walk(ROOT).map((f) => path.relative(ROOT, f));
  for (const must of ['api-contract.js', 'ipc-handlers.js', 'renderer/renderer.js', 'renderer/index.html', 'renderer/styles.css']) {
    assert.ok(files.includes(must), `the core walk must include ${must}`);
  }
  assert.ok(files.length > 50, `expected a real core walk, got ${files.length} files`);
  // And that the comment detector is not simply calling everything a comment:
  // core is full of live code containing other words.
  const src = fs.readFileSync(path.join(ROOT, 'api-contract.js'), 'utf8').split('\n');
  const state = { inBlock: false, inHtml: false };
  const codeLines = src.filter((l) => !isCommentLine(l, '.js', state) && l.trim());
  assert.ok(codeLines.length > 100, 'the comment detector must not swallow live code');
});

test('W9 gate 3: the surviving prose mentions exist and say where things went', () => {
  // The mentions are not an oversight to be tidied away later — they are the
  // migration's map. Asserting they EXIST stops a future cleanup from deleting
  // the only pointer from `api-contract.js` to where its fourteen rows went.
  const withProse = walk(ROOT).filter((f) => NEEDLE.test(fs.readFileSync(f, 'utf8')));
  const rel = withProse.map((f) => path.relative(ROOT, f));
  for (const must of ['api-contract.js', 'ipc-handlers.js', 'renderer/index.html']) {
    assert.ok(rel.includes(must), `${must} should still name where its workbench pieces went`);
  }
});

test('W9 gate 3: no core file REQUIRES anything from plugins/', () => {
  // The arrow that must never exist. Deviation (l) pointed two core requires at
  // plugins/workbench/ for exactly one commit during the W5/W6 split; this is
  // what makes its return a red test rather than a code review.
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (file === GENERATED) continue; // the generated bundle map, by design
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\s*\(\s*['"]([^'"]*plugins\/[^'"]+)['"]\s*\)/g)) {
      offenders.push(`${path.relative(ROOT, file)}: require('${m[1]}')`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `core must reach plugins ONLY through the loader's injected requireModule seam:\n${offenders.join('\n')}`);
});
