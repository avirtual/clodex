'use strict';
// plugin-prompt-refs.js — resolving a `<plugin-id>:<stem>` prompt reference
// against the loaded plugins, and listing the templates a plugin ships.
//
// A pure leaf: fs and the bundle list arrive as arguments, so engine.js's four
// prompt seams are one-line delegates and this is what the tests drive. Homed
// out of engine.js for that reason alone — the logic is small, but it is the
// half that decides whether a seat boots with the prompt it was configured with
// or silently without it, and inside engine.js nothing could reach it.

const { seatHasPlugin } = require('./plugin-api');

// The FIRST colon splits, so a library prompt can never be mistaken for a
// namespaced one: a bare stem cannot contain a colon (the name regex forbids
// it), and a leading colon leaves an empty id and is therefore not a ref.
function splitPluginPromptRef(stem) {
  const s = String(stem || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { pluginId: s.slice(0, i), stem: s.slice(i + 1) };
}

// THROWS where the library path returns null, and the asymmetry is the point: a
// missing library prompt degrades to the CLI default, but a namespaced stem the
// seat cannot reach means the template that named it was resolved against the
// wrong seat — spawning anyway produces a seat silently missing the prompt it
// was configured with, which is exactly the failure a refusal makes visible.
function bundleForPromptRef(bundles, ref, seatPlugins) {
  const b = (bundles || []).find((x) => x && x.id === ref.pluginId) || null;
  if (!b) {
    throw new Error(`prompt "${ref.pluginId}:${ref.stem}" comes from the "${ref.pluginId}" plugin, which is not loaded`);
  }
  if (!seatHasPlugin(b.id, seatPlugins, b.shipped)) {
    throw new Error(`prompt "${ref.pluginId}:${ref.stem}" needs the "${ref.pluginId}" plugin, which this session does not hold`);
  }
  return b;
}

function bundlePrompt(bundle, kind, stem) {
  return (bundle.prompts || []).find((p) => p && p.kind === kind && p.name === stem) || null;
}

// The PATH of a plugin's system prompt, for the Claude arm's
// `--system-prompt-file`. Null when the plugin carries no such prompt or the
// file cannot be read — the same degradation the library path takes once the
// reach check has already passed.
function resolvePluginSystemPromptFile({ fs, path, bundles }, ref, seatPlugins) {
  const b = bundleForPromptRef(bundles, ref, seatPlugins);
  if (!bundlePrompt(b, 'system', ref.stem) || !b.dir) return null;
  const p = path.join(b.dir, 'prompts', 'system', `${ref.stem}.md`);
  try { fs.accessSync(p, fs.constants.R_OK); return p; }
  catch { return null; }
}

// The BODY, for the Codex arm, which merges instruction text rather than passing
// a path. Read off the bundle record the loader already populated, so it cannot
// disagree with what a rescan last saw.
function resolvePluginPromptBody({ bundles }, ref, kind, seatPlugins) {
  const b = bundleForPromptRef(bundles, ref, seatPlugins);
  const hit = bundlePrompt(b, kind, ref.stem);
  return hit ? hit.body : null;
}

// Every plugin template, namespaced, in the shape `templates.list()` returns so
// the pickers need no second code path. `plugins` is already merged by the
// loader's read, so a seat started from one holds the plugin that shipped it.
function pluginTemplateRows(bundles) {
  const out = [];
  for (const b of bundles || []) {
    for (const t of b.templates || []) {
      const id = `${b.id}:${t.name}`;
      out.push({ ...t.body, name: id, id, plugin: b.id, pluginName: b.name || b.id });
    }
  }
  return out;
}

module.exports = {
  splitPluginPromptRef,
  bundleForPromptRef,
  resolvePluginSystemPromptFile,
  resolvePluginPromptBody,
  pluginTemplateRows,
};
