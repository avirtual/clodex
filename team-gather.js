'use strict';

const path = require('path');
const { badStem } = require('./team-prompt-dir');

const PROMPT_KINDS = new Set(['system', 'append']);

const ACTION_LABELS = ['copied', 'kept', 'skipped', 'missing', 'failed'];

function teamPathFor(team, kind, stem) {
  const dir = team && typeof team.dir === 'string' ? team.dir : null;
  if (!dir) return null;
  try {
    if (PROMPT_KINDS.has(kind)) return path.join(dir, 'prompts', kind, `${stem}.md`);
    return path.join(dir, kind, `${stem}.json`);
  } catch { return null; }
}

function libraryPathFor(sources, kind, stem) {
  if (!sources || typeof sources.libraryPath !== 'function') return null;
  try { return sources.libraryPath(kind, stem) || null; } catch { return null; }
}

function probe(sources, name, args, fallback) {
  if (!sources || typeof sources[name] !== 'function') return fallback;
  try { return sources[name](...args); } catch { return fallback; }
}

function classify(team, sources, kind, stem, role, via) {
  if (badStem(stem)) {
    const reason = typeof stem === 'string' && stem.includes(':') ? 'plugin ref' : 'bad stem';
    return { kind, stem, role, via, action: 'skipped', reason, from: null, to: null };
  }
  const from = libraryPathFor(sources, kind, stem);
  const to = teamPathFor(team, kind, stem);
  if (probe(sources, 'teamHas', [kind, stem], false)) {
    return { kind, stem, role, via, action: 'kept', from, to };
  }
  const bytes = probe(sources, 'readLibrary', [kind, stem], null);
  if (bytes == null) return { kind, stem, role, via, action: 'missing', from, to };
  return { kind, stem, role, via, action: 'copy', from, to, bytes };
}

function stemsOf(value) {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((s) => typeof s === 'string' && s);
}

function planGather(team, sources) {
  const items = [];
  const seen = new Map();
  const add = (kind, stem, role, via) => {
    if (typeof stem !== 'string' || !stem) return null;
    const key = `${kind}\u0000${stem}`;
    const prior = seen.get(key);
    if (prior) {
      if (prior.role !== role && !(prior.also || []).some((a) => a.role === role)) {
        if (!prior.also) prior.also = [];
        prior.also.push({ role, via });
      }
      return null;
    }
    const item = classify(team, sources, kind, stem, role, via);
    seen.set(key, item);
    items.push(item);
    return item;
  };
  const roles = (team && team.roles && typeof team.roles === 'object' && !Array.isArray(team.roles))
    ? team.roles : {};
  for (const [role, def] of Object.entries(roles)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
    add('system', def.prompt, role, 'role.prompt');
    if (typeof def.template !== 'string' || !def.template) continue;
    const tplItem = add('templates', def.template, role, 'role.template');
    if (tplItem && tplItem.action === 'skipped') continue;
    const tpl = probe(sources, 'readTemplateForWalk', [def.template], null);
    if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) continue;
    for (const s of stemsOf(tpl.systemPromptFile)) add('system', s, role, 'template.systemPromptFile');
    for (const s of stemsOf(tpl.appendPromptFiles)) add('append', s, role, 'template.appendPromptFiles');
    for (const s of stemsOf(tpl.execCommands)) add('exec', s, role, 'template.execCommands');
  }
  return { items };
}

const WHERE_BY_ACTION = { kept: 'team', copy: 'library', missing: 'missing' };
const WHERE_BY_REASON = { 'plugin ref': 'plugin', 'bad stem': 'missing' };

function usesByRole(planItems, roleKeys) {
  const out = new Map();
  for (const role of (roleKeys && typeof roleKeys[Symbol.iterator] === 'function') ? roleKeys : []) {
    if (typeof role === 'string' && role && !out.has(role)) out.set(role, []);
  }
  for (const item of Array.isArray(planItems) ? planItems : []) {
    if (!item || typeof item !== 'object') continue;
    const role = typeof item.role === 'string' ? item.role : '';
    if (!role) continue;
    const where = item.action === 'skipped'
      ? (WHERE_BY_REASON[item.reason] || 'missing')
      : (WHERE_BY_ACTION[item.action] || 'missing');
    const push = (r, via) => {
      if (!out.has(r)) out.set(r, []);
      out.get(r).push({ kind: item.kind, stem: item.stem, via, where });
    };
    push(role, item.via);
    for (const a of Array.isArray(item.also) ? item.also : []) {
      if (a && typeof a.role === 'string' && a.role) push(a.role, a.via);
    }
  }
  return out;
}

function applyGather(plan, io) {
  const items = (plan && Array.isArray(plan.items)) ? plan.items : [];
  for (const item of items) {
    if (!item || item.action !== 'copy') continue;
    try {
      io.write(item.to, item.bytes);
      item.action = 'copied';
    } catch (err) {
      item.action = 'failed';
      item.error = err && err.message ? err.message : String(err);
    }
  }
  const by = (action) => items.filter((i) => i && i.action === action);
  return {
    copied: by('copied'),
    kept: by('kept'),
    skipped: by('skipped'),
    missing: by('missing'),
    failed: by('failed'),
  };
}

function itemsOf(result) {
  if (result && Array.isArray(result.items)) return result.items;
  const out = [];
  for (const label of ACTION_LABELS) {
    if (result && Array.isArray(result[label])) out.push(...result[label]);
  }
  return out;
}

function formatGatherReport(result, { dry = false } = {}) {
  const items = itemsOf(result);
  const count = (action) => items.filter((i) => i && i.action === action).length;
  const name = (result && result.team) || 'team';
  const failed = count('failed');
  const head = dry
    ? `gather plan for ${name}: ${count('copy')} to copy, ${count('kept')} kept, ${count('skipped')} skipped, ${count('missing')} missing`
    : `gathered ${name}: ${count('copied')} copied, ${count('kept')} kept, ${count('skipped')} skipped, ${count('missing')} missing`;
  const lines = [failed ? `${head}, ${failed} failed` : head];
  for (const item of items) {
    if (!item) continue;
    const why = item.error || item.reason;
    lines.push(`  ${item.action} ${item.kind}/${item.stem} (${item.via} of ${item.role})${why ? `: ${why}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { planGather, applyGather, formatGatherReport, usesByRole };
