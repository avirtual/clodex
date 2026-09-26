'use strict';

const { ansiRuns } = require('./lib/ansi-html');
const { classifyRows } = require('./lib/intent-marks');
const { classifySender } = require('./lib/sender-class');
const { scanLinks } = require('./lib/path-scan');
const { rewriteEchoSgr } = require('./lib/prompt-echo');
const { isExternallyOpenable } = require('../external-link');

const OUTPUT_LINE_CAP = 400;
const CLAMP_LINES = 2;
const CLAMP_CHARS = 240;
const NOOP = () => {};
const MINUS = '−';
const TIMES = ' ×';
const PASTE_MARK_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;

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

function appendPlain(doc, parent, text, ctx) {
  String(text).split('\n').forEach((line, k) => {
    if (k) parent.appendChild(doc.createTextNode('\n'));
    appendLinked(doc, parent, line, '', ctx);
  });
}

function filedLink(doc, spill, ctx) {
  const wrap = el(doc, 'span', 'intent-card-filed-link');
  const size = spill.bytes != null ? `${bytesText(spill.bytes)} ` : '';
  wrap.appendChild(doc.createTextNode(`▢ ${size}filed · `));
  const name = spill.title || (spill.path ? baseName(spill.path) : 'filed body');
  if (spill.path) wrap.appendChild(linkNode(doc, { kind: 'path', text: name, path: spill.path }, '', ctx));
  else wrap.appendChild(doc.createTextNode(name));
  return wrap;
}

function cardHead(doc, seg, ctx) {
  const head = el(doc, 'div', 'intent-card-head');
  const h = seg.head;
  head.appendChild(el(doc, 'span', 'intent-card-glyph', h.glyph));
  head.appendChild(el(doc, 'span', 'intent-card-label', h.label));
  if (h.target) {
    const target = el(doc, 'span', 'intent-card-target');
    if (seg.verb === 'file') target.appendChild(linkNode(doc, { kind: 'path', text: baseName(h.target), path: h.target }, '', ctx));
    else target.textContent = h.target;
    head.appendChild(target);
  }
  for (const chip of h.chips) head.appendChild(el(doc, 'span', 'intent-chip', chip));
  return head;
}

function cardBody(doc, seg, ctx) {
  const lines = seg.body.split('\n');
  const body = el(doc, 'div', `intent-card-body${seg.verb === 'exec' ? ' intent-card-body-mono' : ''}`);
  appendPlain(doc, body, seg.body, ctx);
  const more = lines.length - CLAMP_LINES;
  if (more <= 0 && seg.body.length <= CLAMP_CHARS) return [body];
  body.className += ' intent-card-clamped';
  const foot = el(doc, 'div', 'intent-card-more', more > 0 ? `+ ${countText(more, 'more line', 'more lines')}` : '+ more');
  const expand = () => {
    body.className = body.className.replace(' intent-card-clamped', '');
    foot.hidden = true;
  };
  foot.addEventListener('click', expand);
  body.addEventListener('click', expand);
  return [body, foot];
}

function intentCard(doc, seg, ctx) {
  if (seg.kind === 'inert') {
    const card = el(doc, 'div', 'intent-card intent-card-inert');
    const head = el(doc, 'div', 'intent-card-head');
    head.appendChild(el(doc, 'span', 'intent-card-state', "⊘ won't fire"));
    card.appendChild(head);
    card.appendChild(el(doc, 'div', 'intent-card-raw', seg.text));
    return card;
  }
  const card = el(doc, 'div', `intent-card${seg.state === 'filed' ? ' intent-card-filed' : ''}`);
  card.dataset.verb = seg.verb;
  card.appendChild(cardHead(doc, seg, ctx));
  if (seg.state === 'filed' && seg.spill) {
    const row = el(doc, 'div', 'intent-card-body');
    row.appendChild(filedLink(doc, seg.spill, ctx));
    card.appendChild(row);
  } else if (seg.body) {
    for (const n of cardBody(doc, seg, ctx)) card.appendChild(n);
  }
  return card;
}

function appendSegments(doc, row, segs, ctx) {
  let stack = null;
  for (const seg of segs) {
    if (seg.kind === 'intent' || seg.kind === 'inert') {
      if (!stack) {
        stack = el(doc, 'div', 'intent-stack');
        row.appendChild(stack);
      }
      stack.appendChild(intentCard(doc, seg, ctx));
      continue;
    }
    stack = null;
    const prose = el(doc, 'div', 'tr-seg-prose');
    if (seg.spill) prose.appendChild(filedLink(doc, seg.spill, ctx));
    else appendPlain(doc, prose, seg.text, ctx);
    row.appendChild(prose);
  }
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
  if (rec.state === 'pending') return [[rec.desc || 'running', '']];
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

function toolRow(doc, rec, ctx, named = true) {
  const row = el(doc, 'div', `${named ? 'tr-row tr-tool' : 'tr-tool tr-tool-line'} tr-state-${rec.state}`);
  row.dataset.id = rec.id;
  row.appendChild(el(doc, 'span', 'tr-mark'));
  if (named) row.appendChild(el(doc, 'span', 'tr-tool-name', rec.name));
  const arg = el(doc, 'span', 'tr-tool-arg');
  arg.title = rec.arg;
  appendLinked(doc, arg, rec.argShown || rec.arg, '', ctx);
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

function appendPrompt(doc, text, rec, ctx) {
  const byN = new Map((rec.pastes || []).map((p) => [p.n, p]));
  let at = 0;
  for (const m of rec.text.matchAll(PASTE_MARK_RE)) {
    const paste = byN.get(Number(m[1]));
    if (!paste) continue;
    const before = rec.text.slice(at, m.index);
    const end = m.index + m[0].length;
    const lead = m.index > 0 && !rec.text.slice(0, m.index).endsWith('\n') ? '\n' : '';
    const tail = end < rec.text.length && rec.text[end] !== '\n' ? '\n' : '';
    if (before || lead) appendProse(doc, text, before + lead, ctx);
    appendProse(doc, text, paste.text + tail, ctx);
    at = end;
  }
  if (at < rec.text.length || !at) appendProse(doc, text, rec.text.slice(at), ctx);
}

function promptRow(doc, rec, ctx) {
  const row = headRow(doc, 'tr-prompt', rec);
  const text = el(doc, 'span', 'tr-head-text');
  if (rec.pastes) appendPrompt(doc, text, rec, ctx);
  else appendProse(doc, text, rec.text, ctx);
  row.appendChild(text);
  return withTime(doc, row, rec);
}

function senderBadge(doc, from) {
  const { cls, label, glyph } = classifySender(from);
  const badge = el(doc, 'span', `tr-sender tr-sender-${cls}`);
  badge.title = String(from);
  badge.appendChild(el(doc, 'span', 'tr-sender-glyph', glyph));
  badge.appendChild(el(doc, 'span', 'tr-sender-name', label));
  return badge;
}

function replyRow(doc, rec, ctx, attached) {
  const row = headRow(doc, `tr-reply${attached ? ' tr-reply-attached' : ''}`, rec);
  const text = el(doc, 'span', 'tr-head-text');
  if (attached) text.appendChild(el(doc, 'span', 'tr-reply-lead', '↳'));
  const badge = el(doc, 'span', 'tr-sender tr-sender-app');
  badge.title = 'Clodex runtime';
  badge.appendChild(el(doc, 'span', 'tr-sender-glyph', rec.glyph));
  badge.appendChild(el(doc, 'span', 'tr-sender-name', rec.label));
  text.appendChild(badge);
  appendPlain(doc, text, rec.text, ctx);
  row.appendChild(text);
  return withTime(doc, row, rec);
}

function inboundRow(doc, rec, ctx) {
  const row = headRow(doc, 'tr-inbound', rec);
  const text = el(doc, 'span', 'tr-head-text');
  text.appendChild(senderBadge(doc, rec.from));
  if (rec.attached) {
    const lead = rec.text.slice(0, rec.text.indexOf('Message (')).trim();
    if (lead) appendProse(doc, text, `${lead} `, ctx);
    text.appendChild(el(doc, 'span', 'tr-dim', `${bytesText(rec.attached.bytes)} `));
    text.appendChild(linkNode(doc, { kind: 'path', text: baseName(rec.attached.path), path: rec.attached.path }, '', ctx));
  } else appendProse(doc, text, rec.text, ctx);
  row.appendChild(text);
  return withTime(doc, row, rec);
}

function noticeRow(doc, rec, level, text, ctx) {
  const row = el(doc, 'div', `tr-row tr-notice tr-notice-${level}`);
  row.dataset.id = rec.id;
  row.appendChild(el(doc, 'span', 'tr-mark'));
  const span = el(doc, 'span', 'tr-notice-text');
  appendLinked(doc, span, text, '', ctx);
  row.appendChild(span);
  return row;
}

function buildRow(doc, rec, ctx, attached) {
  switch (rec.kind) {
    case 'prompt': return promptRow(doc, rec, ctx);
    case 'inbound': return inboundRow(doc, rec, ctx);
    case 'reply': return replyRow(doc, rec, ctx, attached);
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
      if (rec.apiError) return noticeRow(doc, rec, 'error', rec.text, ctx);
      const row = el(doc, 'div', `tr-row tr-prose${rec.segments ? ' tr-segs' : ''}`);
      row.dataset.id = rec.id;
      if (rec.segments) appendSegments(doc, row, rec.segments, ctx);
      else appendProse(doc, row, rec.text, ctx);
      return row;
    }
    case 'notice': return noticeRow(doc, rec, rec.level, rec.text, ctx);
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

function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function pendingToolName(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r && r.kind === 'tool' && r.state === 'pending') return r.name || null;
  }
  return null;
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

function tally(verbs) {
  const m = new Map();
  for (const v of verbs) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

function attachedReplies(records) {
  const out = new Set();
  let cards = null;
  let replies = [];
  const settle = () => {
    if (cards && replies.length) {
      const want = tally(cards.verbs);
      const got = tally(replies.map((r) => r.verb));
      for (const r of replies) if (want.get(r.verb) === got.get(r.verb)) out.add(r.id);
    }
    cards = null;
    replies = [];
  };
  for (const r of records) {
    if (r.kind === 'tool' || r.kind === 'turn-end') continue;
    if (r.kind === 'reply') {
      if (cards) replies.push(r);
      continue;
    }
    if (replies.length) settle();
    if (r.kind === 'assistant' && Array.isArray(r.segments)) {
      const verbs = r.segments.filter((s) => s.kind === 'intent').map((s) => s.verb);
      cards = cards && cards.turn === r.turn ? { turn: r.turn, verbs: cards.verbs.concat(verbs) } : { turn: r.turn, verbs };
      continue;
    }
    cards = null;
  }
  settle();
  return out;
}

function toolRuns(records) {
  const out = [];
  for (const r of records) {
    const last = out[out.length - 1];
    if (r.kind === 'tool' && last && last.tools && last.tools[0].name === r.name) last.tools.push(r);
    else out.push(r.kind === 'tool' ? { tools: [r] } : { rec: r });
  }
  return out;
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
  const deps = { seatName: null, resolveFile: NOOP, openFilePeek: NOOP, openExternal: NOOP, toast: NOOP, echoPalette: null, now: () => Date.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t), ...ctx };
  const turnCache = new Map();
  let lastRecords = [];
  let working = null;
  let workingEl = null;
  let workingTimer = null;

  function stopTick() {
    if (workingTimer != null) deps.clearInterval(workingTimer);
    workingTimer = null;
  }

  function setPart(i, text) {
    const node = workingEl.childNodes[i];
    if (node.textContent !== text) node.textContent = text;
  }

  function paintWorking() {
    if (!working) {
      stopTick();
      if (workingEl && workingEl.parentNode) workingEl.parentNode.removeChild(workingEl);
      workingEl = null;
      return;
    }
    const waiting = working.state === 'attention';
    if (!workingEl) {
      workingEl = el(doc, 'div', '');
      workingEl.appendChild(el(doc, 'span', 'tr-mark'));
      workingEl.appendChild(el(doc, 'span', 'tr-working-text', ''));
      workingEl.appendChild(el(doc, 'span', 'tr-working-elapsed', ''));
    }
    const cls = `tr-row tr-working ${waiting ? 'tr-working-still' : 'tr-working-pulse'}`;
    if (workingEl.className !== cls) workingEl.className = cls;
    const tool = pendingToolName(lastRecords);
    setPart(1, waiting ? 'Waiting for you' : working.text || (tool ? `Working · ${tool}` : 'Working'));
    const since = Number(working.since);
    setPart(2, !waiting && since > 0 ? elapsedText(deps.now() - since) : '');
    if (workingEl.parentNode !== paneEl || workingEl.nextSibling) paneEl.appendChild(workingEl);
    if (waiting) stopTick();
    else if (workingTimer == null) workingTimer = deps.setInterval(paintWorking, 1000);
  }

  function setWorking(w) {
    const state = w && w.state;
    working = state === 'thinking' || state === 'attention' ? { state, since: w.since, text: w.text || null } : null;
    paintWorking();
  }

  function toolBlockItem(tools) {
    const many = tools.length > 1;
    return {
      key: `tools:${tools[0].id}`,
      sig: 'tools',
      build: () => {
        const block = el(doc, 'div', 'tr-row tr-tool-block');
        block.dataset.id = `tools:${tools[0].id}`;
        return block;
      },
      after: (c) => {
        if (!c.sub) c.sub = new Map();
        c.el.className = `tr-row tr-tool-block${many ? ' tr-tool-many' : ''}`;
        const items = [];
        if (many) {
          items.push({ key: 'head', sig: String(tools.length), build: () => {
            const head = el(doc, 'div', 'tr-tool-head');
            head.appendChild(el(doc, 'span', 'tr-tool-head-name', tools[0].name));
            head.appendChild(el(doc, 'span', 'tr-tool-count', `${TIMES}${tools.length}`));
            return head;
          } });
        }
        for (const r of tools) items.push({ key: r.id, sig: JSON.stringify(r) + (many ? '' : '|named'), build: () => toolRow(doc, r, deps, !many) });
        reconcile(c.el, c.sub, items);
      },
    };
  }

  function rowItems(records, attached) {
    const items = [];
    for (const run of toolRuns(records)) {
      if (run.tools) {
        items.push(toolBlockItem(run.tools));
        continue;
      }
      const r = run.rec;
      if (r.kind === 'turn-end') continue;
      const att = attached.has(r.id);
      const extra = r.kind === 'command-output' ? JSON.stringify(resolvePalette(deps) || null) : att ? '|attached' : '';
      items.push({ key: r.id, sig: JSON.stringify(r) + extra, build: () => buildRow(doc, r, deps, att) || el(doc, 'div', 'tr-row') });
    }
    const footer = footerOf(records);
    if (footer) items.push({ key: 'footer', sig: JSON.stringify(footer), build: () => buildFooter(doc, footer, deps) });
    return items;
  }

  function render(records) {
    const list = Array.isArray(records) ? records : [];
    const attached = attachedReplies(list);
    const items = groupTurns(list).map((t) => ({
      key: t.key,
      sig: '',
      build: () => {
        const block = el(doc, 'div', 'tr-turn');
        block.dataset.turn = t.key;
        return block;
      },
      after: (c) => {
        if (!c.sub) c.sub = new Map();
        reconcile(c.el, c.sub, rowItems(t.records, attached));
      },
    }));
    reconcile(paneEl, turnCache, items);
    lastRecords = list;
    if (working) paintWorking();
  }

  return { render, setWorking };
}

module.exports = { OUTPUT_LINE_CAP, summaryParts, footerOf, attachedReplies, createTranscriptRows };
