'use strict';

const { seatHasPlugin } = require('./plugin-api');

function splitPluginPromptRef(stem) {
  const s = String(stem || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { pluginId: s.slice(0, i), stem: s.slice(i + 1) };
}

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

function resolvePluginSystemPromptFile({ fs, path, bundles }, ref, seatPlugins) {
  const b = bundleForPromptRef(bundles, ref, seatPlugins);
  if (!bundlePrompt(b, 'system', ref.stem) || !b.dir) return null;
  const p = path.join(b.dir, 'prompts', 'system', `${ref.stem}.md`);
  try { fs.accessSync(p, fs.constants.R_OK); return p; }
  catch { return null; }
}

function resolvePluginPromptBody({ bundles }, ref, kind, seatPlugins) {
  const b = bundleForPromptRef(bundles, ref, seatPlugins);
  const hit = bundlePrompt(b, kind, ref.stem);
  return hit ? hit.body : null;
}

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
