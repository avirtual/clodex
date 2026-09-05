'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_ROOT = path.join(os.homedir(), '.clodex', 'projects');
const DEFAULT_TEMPLATE = 'clodex-team-reviewer';
const UNKNOWN_MODEL = 'unknown-model';

function findCostFiles(root) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const tasks = path.join(root, p.name, 'tasks');
    let dirs = [];
    try { dirs = fs.readdirSync(tasks, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const f = path.join(tasks, d.name, 'REVIEW-COST.jsonl');
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

function readRows(files) {
  const rows = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { continue; }
    }
  }
  return rows;
}

function pct(values, p) {
  const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
}

function mean(values) {
  const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function fmt(n, digits) {
  return n == null ? '-' : n.toFixed(digits);
}

function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const template = (r && r.template) || DEFAULT_TEMPLATE;
    const model = (r && r.model) || UNKNOWN_MODEL;
    const key = `${template}\u0000${model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  const ordered = [...groups].map(([key, g]) => [key.split('\u0000'), g])
    .sort(([a], [b]) => (a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));
  for (const [[template, model], g] of ordered) {
    const mins = g.map((r) => (typeof r.wallMs === 'number' ? r.wallMs / 60000 : null));
    const verdicts = {};
    for (const r of g) {
      const v = (r && r.verdict) || 'unknown';
      verdicts[v] = (verdicts[v] || 0) + 1;
    }
    out.push({
      template,
      model,
      n: g.length,
      medianWallMin: pct(mins, 0.5),
      p90WallMin: pct(mins, 0.9),
      medianRequests: pct(g.map((r) => r.requests), 0.5),
      medianUsd: pct(g.map((r) => r.usd), 0.5),
      verdicts,
      meanMustFix: mean(g.map((r) => r.mustFix)),
    });
  }
  return out;
}

function render(summary) {
  return summary.map((s) => {
    const mix = Object.keys(s.verdicts).sort().map((k) => `${k}:${s.verdicts[k]}`).join(' ');
    return `${s.template}  ${s.model}  n=${s.n}  wall(med/p90)=${fmt(s.medianWallMin, 1)}/${fmt(s.p90WallMin, 1)}min`
      + `  req(med)=${fmt(s.medianRequests, 0)}  usd(med)=${fmt(s.medianUsd, 2)}`
      + `  verdicts[${mix}]  mustFix(mean)=${fmt(s.meanMustFix, 2)}`;
  });
}

if (require.main === module) {
  const root = process.argv[2] || DEFAULT_ROOT;
  const summary = summarize(readRows(findCostFiles(root)));
  if (!summary.length) process.stdout.write(`no REVIEW-COST.jsonl rows under ${root}\n`);
  else process.stdout.write(`${render(summary).join('\n')}\n`);
}

module.exports = { findCostFiles, readRows, summarize, render, DEFAULT_TEMPLATE };
