'use strict';

const fs = require('fs');

const MAX_ENTRIES = 200;
const INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];

function firstLine(s, max = 160) {
  const line = String(s == null ? '' : s).split('\n').find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolInputLine(input) {
  if (!input || typeof input !== 'object') return firstLine(input);
  for (const k of INPUT_KEYS) if (typeof input[k] === 'string' && input[k].trim()) return firstLine(input[k]);
  return firstLine(JSON.stringify(input));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function tagBody(text, tag) {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(`</${tag}>`, start + open.length);
  return (end < 0 ? text.slice(start + open.length) : text.slice(start + open.length, end)).trim();
}

function localCommandEntries(content) {
  if (typeof content !== 'string') return [];
  const name = tagBody(content, 'command-name');
  if (name) return [{ kind: 'command', name, args: tagBody(content, 'command-args') || '' }];
  const text = tagBody(content, 'local-command-stdout');
  if (text) return [{ kind: 'command-output', text }];
  return [];
}

function entriesOf(rec) {
  if (!rec || typeof rec !== 'object') return [];
  if (rec.type === 'system') return rec.subtype === 'local_command' ? localCommandEntries(rec.content) : [];
  if (!rec.message) return [];
  const content = rec.message.content;
  if (rec.type === 'user') {
    if (rec.isMeta || rec.isCompactSummary) return [];
    const text = textOf(content).trim();
    if (!text || text.startsWith('<')) return [];
    return [`❯ ${text}`];
  }
  if (rec.type === 'assistant' && Array.isArray(content)) {
    const out = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push(`⏺ ${b.text.trim()}`);
      else if (b.type === 'tool_use') out.push(`  → ${b.name || 'tool'}(${toolInputLine(b.input)})`);
    }
    return out;
  }
  return [];
}

function parseTranscript(text, max = MAX_ENTRIES) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    out.push(...entriesOf(rec));
  }
  return out.slice(-max);
}

function createTranscriptSpikeReader({ linkPathFor, watch = fs.watch }) {
  const cache = new Map();

  function drop(name) {
    const c = cache.get(name);
    if (c && c.watcher) { try { c.watcher.close(); } catch {} }
    cache.delete(name);
  }

  function pull(name) {
    let real;
    try { real = fs.realpathSync(linkPathFor(name)); } catch { drop(name); return { ok: false, reason: 'unavailable' }; }
    let c = cache.get(name);
    if (c && c.path !== real) { drop(name); c = null; }
    if (!c) {
      c = { path: real, rev: 0, dirty: true, lines: [], watcher: null };
      try {
        c.watcher = watch(real, () => { c.dirty = true; });
        if (c.watcher && typeof c.watcher.on === 'function') c.watcher.on('error', () => { c.dirty = true; });
      } catch {}
      cache.set(name, c);
    }
    if (c.dirty || !c.watcher) {
      let text;
      try { text = fs.readFileSync(real, 'utf8'); } catch { drop(name); return { ok: false, reason: 'unreadable' }; }
      c.lines = parseTranscript(text);
      c.dirty = false;
      c.rev += 1;
    }
    return { ok: true, rev: c.rev, lines: c.lines };
  }

  function dispose() { for (const name of [...cache.keys()]) drop(name); }

  return { pull, drop, dispose };
}

module.exports = { MAX_ENTRIES, parseTranscript, createTranscriptSpikeReader };
