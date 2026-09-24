'use strict';

const { ansiRuns } = require('./lib/ansi-html');
const { classifyRows } = require('./lib/intent-marks');
const { scanLinks } = require('./lib/path-scan');
const { rewriteEchoSgr } = require('./lib/prompt-echo');
const { isExternallyOpenable } = require('../external-link');

const OUTPUT_LINE_CAP = 400;
const NOOP = () => {};
const MINUS = '−';

function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function styled(doc, text, style) {
  if (!style) return doc.createTextNode(text);
  const span = doc.createElement('span');
  span.style.cssText = style;
  span.textContent = text;
  return span;
}

function linkNode(doc, span, style, ctx) {
  const a = doc.createElement('a');
  a.className = 'pane-link';
  a.href = '#';
  a.textContent = span.text;
  if (style) a.style.cssText = style;
  if (span.kind === 'path') {
    a.dataset.path = span.path;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      Promise.resolve().then(() => ctx.resolveFile(span.path))
        .catch((err) => ({ ok: false, error: String(err) }))
        .then((res) => {
          if (!res || !res.ok) {
            ctx.toast((res && res.error) || `Can't find "${span.path}"`, { kind: 'warn', duration: 4000 });
            return;
          }
          ctx.openFilePeek(ctx.seatName, res.path, 'file', span.line);
        });
    });
  } else {
    a.dataset.url = span.text;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (isExternallyOpenable(span.text)) ctx.openExternal(span.text);
    });
  }
  return a;
}

function appendLinked(doc, parent, text, style, ctx) {
  for (const span of scanLinks(text)) {
    parent.appendChild(span.kind === 'text' ? styled(doc, span.text, style) : linkNode(doc, span, style, ctx));
  }
}

function resolvePalette(ctx) {
  return typeof ctx.echoPalette === 'function' ? ctx.echoPalette() : ctx.echoPalette;
}

function appendOutput(doc, parent, text, ctx) {
  const palette = resolvePalette(ctx);
  if (palette) {
    const { out, state } = rewriteEchoSgr(text, palette);
    text = out + state.carry;
  }
  const lines = text.split('\n');
  const more = lines.length - OUTPUT_LINE_CAP;
  for (const run of ansiRuns(more > 0 ? lines.slice(0, OUTPUT_LINE_CAP).join('\n') : text)) {
    appendLinked(doc, parent, run.text, run.style, ctx);
  }
  if (more > 0) parent.appendChild(doc.createTextNode(`\n… ${more} more lines`));
}

function appendProse(doc, parent, text, ctx) {
  const lines = String(text).split('\n');
  const marks = new Map();
  for (const m of classifyRows(lines.map((t) => ({ text: t, isWrapped: false })))) {
    if (m.span) marks.set(m.start, m);
  }
  lines.forEach((line, k) => {
    if (k) parent.appendChild(doc.createTextNode('\n'));
    const m = marks.get(k);
    if (!m) { appendLinked(doc, parent, line, '', ctx); return; }
    const end = m.span.offset + m.span.length;
    appendLinked(doc, parent, line.slice(0, m.span.offset), '', ctx);
    parent.appendChild(el(doc, 'span', `intent-mark intent-mark-${m.kind}`, line.slice(m.span.offset, end)));
    appendLinked(doc, parent, line.slice(end), '', ctx);
  });
}

function clock(ts) {
  if (typeof ts !== 'number') return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function bytesText(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function countText(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function tokensText(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function durationText(ms) {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function baseName(p) {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || String(p);
}

function diffParts(add, del) {
  return [[`+${add}`, 'tr-add'], [' ', ''], [`${MINUS}${del}`, 'tr-del']];
}

function bashParts(s) {
  if (s.interrupted) return [['interrupted', 'tr-warn']];
  if (s.background) return [['background', '']];
  if (s.persisted != null) return [[bytesText(s.persisted), '']];
  if (s.only) return [[s.only, '']];
  return [[s.lines ? countText(s.lines, 'line', 'lines') : 'no output', '']];
}

function summaryParts(rec) {
  const s = rec.sum || {};
  if (rec.state === 'pending') return [['running', '']];
  if (rec.state === 'denied') return [['denied', 'tr-err']];
  if (rec.state === 'error') {
    if (s.message != null) return [[s.message, 'tr-err']];
    const exit = `exit ${s.exit == null ? '?' : s.exit}`;
    return [[s.lines ? `${exit} · ${countText(s.lines, 'line', 'lines')}` : exit, 'tr-err']];
  }
  if (rec.state === 'interrupted') return [['interrupted', 'tr-warn']];
  switch (rec.name) {
    case 'Bash': return bashParts(s);
    case 'Edit':
    case 'MultiEdit': return diffParts(s.add, s.del);
    case 'Write': return s.created ? [[`new · ${countText(s.add, 'line', 'lines')}`, '']] : diffParts(s.add, s.del);
    case 'Read': return s.from == null ? [] : [[`${s.from}–${s.to} of ${s.total}`, '']];
    case 'Grep': return [[s.lines == null ? countText(s.files, 'file', 'files') : `${countText(s.lines, 'line', 'lines')} in ${countText(s.files, 'file', 'files')}`, '']];
    case 'Glob': return [[countText(s.files, 'file', 'files'), '']];
    case 'WebFetch': return [[[s.code, s.bytes != null ? bytesText(s.bytes) : null].filter((x) => x != null).join(' · '), '']];
    case 'WebSearch': return [[countText(s.results, 'result', 'results'), '']];
    case 'Agent':
    case 'Task': return [[s.description || '', ''], ...(s.model ? [[` ${s.model}`, 'tr-dim']] : [])];
    default:
      if (s.total != null) return [[`${s.done}/${s.total} done`, '']];
      return s.lines != null ? [[countText(s.lines, 'line', 'lines'), '']] : [];
  }
}

function toolRow(doc, rec, ctx) {
  const row = el(doc, 'div', `tr-row tr-tool tr-state-${rec.state}`);
  row.dataset.id = rec.id;
  row.appendChild(el(doc, 'span', 'tr-mark'));
  row.appendChild(el(doc, 'span', 'tr-tool-name', rec.name));
  const arg = el(doc, 'span', 'tr-tool-arg');
  arg.title = rec.arg;
  appendLinked(doc, arg, rec.arg, '', ctx);
  row.appendChild(arg);
  const sum = el(doc, 'span', 'tr-tool-sum');
  for (const [text, cls] of summaryParts(rec)) sum.appendChild(cls ? el(doc, 'span', cls, text) : doc.createTextNode(text));
  row.appendChild(sum);
  return row;
}

function headRow(doc, cls, rec) {
  const row = el(doc, 'div', `tr-row tr-head ${cls}`);
  row.dataset.id = rec.id;
  return row;
}

function withTime(doc, row, rec) {
  const t = clock(rec.ts);
  if (t) row.appendChild(el(doc, 'span', 'tr-time', t));
  return row;
}

function promptRow(doc, rec, ctx) {
  const row = headRow(doc, 'tr-prompt', rec);
  const text = el(doc, 'span', 'tr-head-text');
  appendProse(doc, text, rec.text, ctx);
  row.appendChild(text);
  return withTime(doc, row, rec);
}

function inboundRow(doc, rec, ctx) {
  const row = headRow(doc, 'tr-inbound', rec);
  row.appendChild(el(doc, 'span', 'tr-from', `from ${rec.from}`));
  const text = el(doc, 'span', 'tr-head-text');
  if (rec.attached) {
    const lead = rec.text.slice(0, rec.text.indexOf('Message (')).trim();
    if (lead) appendProse(doc, text, `${lead} `, ctx);
    text.appendChild(el(doc, 'span', 'tr-dim', `${bytesText(rec.attached.bytes)} `));
    text.appendChild(linkNode(doc, { kind: 'path', text: baseName(rec.attached.path), path: rec.attached.path }, '', ctx));
  } else appendProse(doc, text, rec.text, ctx);
  row.appendChild(text);
  return withTime(doc, row, rec);
}

function noticeRow(doc, rec, level, text) {
  const row = el(doc, 'div', `tr-row tr-notice tr-notice-${level}`);
  row.dataset.id = rec.id;
  row.appendChild(el(doc, 'span', 'tr-mark'));
  row.appendChild(doc.createTextNode(text));
  return row;
}

function buildRow(doc, rec, ctx) {
  switch (rec.kind) {
    case 'prompt': return promptRow(doc, rec, ctx);
    case 'inbound': return inboundRow(doc, rec, ctx);
    case 'notification': {
      const row = headRow(doc, 'tr-notification', rec);
      row.appendChild(el(doc, 'span', 'tr-head-text', rec.text));
      return withTime(doc, row, rec);
    }
    case 'command': {
      const row = headRow(doc, 'tr-command', rec);
      row.appendChild(el(doc, 'span', 'tr-head-text', `❯ ${rec.name}${rec.args ? ` ${rec.args}` : ''}`));
      return withTime(doc, row, rec);
    }
    case 'command-output': {
      const pre = el(doc, 'pre', 'tr-row tr-output');
      pre.dataset.id = rec.id;
      appendOutput(doc, pre, String(rec.text), ctx);
      return pre;
    }
    case 'assistant': {
      if (rec.apiError) return noticeRow(doc, rec, 'error', rec.text);
      const row = el(doc, 'div', 'tr-row tr-prose');
      row.dataset.id = rec.id;
      appendProse(doc, row, rec.text, ctx);
      return row;
    }
    case 'tool': return toolRow(doc, rec, ctx);
    case 'notice': return noticeRow(doc, rec, rec.level, rec.text);
    case 'boundary': {
      const row = el(doc, 'div', 'tr-row tr-boundary');
      row.dataset.id = rec.id;
      const label = rec.what === 'compact'
        ? ['compacted', rec.preTokens != null && rec.postTokens != null ? `${tokensText(rec.preTokens)} → ${tokensText(rec.postTokens)} tokens` : null, rec.trigger].filter(Boolean).join(' · ')
        : 'cleared';
      row.appendChild(el(doc, 'span', 'tr-boundary-label', label));
      return row;
    }
    default: return null;
  }
}

function footerOf(records) {
  const end = records.find((r) => r.kind === 'turn-end');
  const boundary = records.find((r) => r.kind === 'boundary' && r.what === 'compact' && r.preTokens != null && r.postTokens != null);
  if (!end && !boundary) return null;
  const tools = records.filter((r) => r.kind === 'tool');
  const files = new Map();
  for (const r of tools) {
    if (r.state !== 'ok' || !r.sum || !r.sum.file || r.sum.add == null) continue;
    const f = files.get(r.sum.file) || { file: r.sum.file, add: 0, del: 0 };
    f.add += r.sum.add;
    f.del += r.sum.del;
    files.set(r.sum.file, f);
  }
  return {
    durationMs: end && end.durationMs != null ? end.durationMs : null,
    tools: tools.length,
    errors: tools.filter((r) => r.state === 'error' || r.state === 'denied').length,
    files: [...files.values()],
    compacted: boundary ? [boundary.preTokens, boundary.postTokens] : null,
  };
}

function buildFooter(doc, f, ctx) {
  const row = el(doc, 'div', 'tr-row tr-footer');
  const parts = [];
  if (f.durationMs != null) parts.push(() => row.appendChild(doc.createTextNode(durationText(f.durationMs))));
  if (f.tools) parts.push(() => row.appendChild(doc.createTextNode(countText(f.tools, 'tool', 'tools'))));
  if (f.errors) parts.push(() => row.appendChild(el(doc, 'span', 'tr-err', countText(f.errors, 'error', 'errors'))));
  for (const file of f.files) {
    parts.push(() => {
      row.appendChild(linkNode(doc, { kind: 'path', text: baseName(file.file), path: file.file }, '', ctx));
      row.appendChild(doc.createTextNode(` +${file.add} ${MINUS}${file.del}`));
    });
  }
  if (f.compacted) parts.push(() => row.appendChild(doc.createTextNode(`compacted ${tokensText(f.compacted[0])} → ${tokensText(f.compacted[1])}`)));
  parts.forEach((add, i) => {
    if (i) row.appendChild(doc.createTextNode(' · '));
    add();
  });
  return row;
}

function reconcile(parent, cache, items) {
  const seen = new Set();
  let prev = null;
  for (const it of items) {
    seen.add(it.key);
    let c = cache.get(it.key);
    if (!c || c.sig !== it.sig) {
      const node = it.build();
      if (c && c.el.parentNode === parent) parent.replaceChild(node, c.el);
      c = { sig: it.sig, el: node, sub: c ? c.sub : null };
      cache.set(it.key, c);
    }
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (want !== c.el) parent.insertBefore(c.el, want || null);
    prev = c.el;
    if (it.after) it.after(c);
  }
  for (const [key, c] of cache) {
    if (seen.has(key)) continue;
    if (c.el.parentNode === parent) parent.removeChild(c.el);
    cache.delete(key);
  }
}

function groupTurns(records) {
  const turns = [];
  for (const r of records) {
    const last = turns[turns.length - 1];
    if (last && last.turn === r.turn) last.records.push(r);
    else turns.push({ turn: r.turn, key: r.id, records: [r] });
  }
  return turns;
}

function createTranscriptRows(doc, paneEl, ctx = {}) {
  const deps = { seatName: null, resolveFile: NOOP, openFilePeek: NOOP, openExternal: NOOP, toast: NOOP, echoPalette: null, ...ctx };
  const turnCache = new Map();

  function rowItems(records) {
    const items = [];
    for (const r of records) {
      if (r.kind === 'turn-end') continue;
      items.push({ key: r.id, sig: JSON.stringify(r) + (r.kind === 'command-output' ? JSON.stringify(resolvePalette(deps) || null) : ''), build: () => buildRow(doc, r, deps) || el(doc, 'div', 'tr-row') });
    }
    const footer = footerOf(records);
    if (footer) items.push({ key: 'footer', sig: JSON.stringify(footer), build: () => buildFooter(doc, footer, deps) });
    return items;
  }

  function render(records) {
    const items = groupTurns(Array.isArray(records) ? records : []).map((t) => ({
      key: t.key,
      sig: '',
      build: () => {
        const block = el(doc, 'div', 'tr-turn');
        block.dataset.turn = t.key;
        return block;
      },
      after: (c) => {
        if (!c.sub) c.sub = new Map();
        reconcile(c.el, c.sub, rowItems(t.records));
      },
    }));
    reconcile(paneEl, turnCache, items);
  }

  return { render };
}

module.exports = { OUTPUT_LINE_CAP, summaryParts, footerOf, createTranscriptRows };
