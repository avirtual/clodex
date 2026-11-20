'use strict';

const { execFileSync } = require('child_process');

const PS_TIMEOUT_MS = 2000;

function parsePs(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(rss)) rows.push({ pid, ppid, rssKb: rss });
  }
  return rows;
}

function treeRssBytes(psRows, rootPids) {
  const rssKb = new Map();
  const children = new Map();
  for (const r of psRows || []) {
    rssKb.set(r.pid, r.rssKb);
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r.pid);
  }
  const out = new Map();
  for (const root of rootPids || []) {
    const seen = new Set();
    const stack = [root];
    let kb = 0;
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      kb += rssKb.get(pid) || 0;
      for (const c of children.get(pid) || []) stack.push(c);
    }
    out.set(root, kb * 1024);
  }
  return out;
}

function sample(rootPids, { platform = process.platform, exec = execFileSync } = {}) {
  if (platform === 'win32') return new Map();
  const roots = (rootPids || []).filter((p) => Number.isInteger(p) && p > 0);
  if (!roots.length) return new Map();
  try {
    const text = exec('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    return treeRssBytes(parsePs(text), roots);
  } catch {
    return new Map();
  }
}

module.exports = { PS_TIMEOUT_MS, parsePs, treeRssBytes, sample };
