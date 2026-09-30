'use strict';

const { ansiRuns } = require('./lib/ansi-html');
const { classifyRows } = require('./lib/intent-marks');
const { classifySender, initial, OPERATOR_GLYPH } = require('./lib/sender-class');
const { scanLinks } = require('./lib/path-scan');
const { rewriteEchoSgr } = require('./lib/prompt-echo');
const { isExternallyOpenable } = require('../external-link');
const { TURN_KINDS, isInternalRow } = require('../transcript-internal');
const { surfaceOf, segmentSurface, turnDriver, turnFolds, turnEndProse } = require('./lib/transcript-surface');

const OUTPUT_LINE_CAP = 400;
const CLAMP_LINES = 2;
const CLAMP_CHARS = 240;
const PREVIEW_CHARS = 120;
const INLINE_CHARS = 120;
const FOLD_CHARS = 80;
const SPILL_INLINE_BYTES = 16 * 1024;
const SPILL_CACHE_CAP = 32;
const spillCache = new Map();
const NOOP = () => {};
const MINUS = '−';
const TIMES = ' ×';
const PASTE_MARK_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;
const PROMPT_MARK_RE = /\[Pasted text #(\d+) \+\d+ lines\]|\[Image #(\d+)\]/g;

function toggleClass(node, cls, on) {
  const list = String(node.className || '').split(' ').filter((c) => c && c !== cls);
  if (on) list.push(cls);
  const next = list.join(' ');
  if (node.className !== next) node.className = next;
}

function recSig(r) {
  if (!r.images) return JSON.stringify(r);
  return JSON.stringify({ ...r, images: r.images.map((i) => i.n + ':' + (i.bytes || i.data.length)) });
}

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

function linkNode(doc, span, style, ctx, stop = false) {
  const a = doc.createElement('a');
  a.className = 'pane-link';
  a.href = '#';
  a.textContent = span.text;
  if (style) a.style.cssText = style;
  if (span.kind === 'path') {
    a.dataset.path = span.path;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (stop) e.stopPropagation();
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

function spillPeek(ctx, path) {
  const cached = spillCache.get(path);
  if (cached) return cached;
  const hit = { done: false, res: null, promise: null };
  hit.promise = Promise.resolve().then(() => ctx.peekFile(path)).catch(() => null).then((res) => {
    const ok = Boolean(res && res.ok && !res.binary && typeof res.content === 'string');
    hit.done = true;
    hit.res = ok ? { ok: true, size: typeof res.size === 'number' ? res.size : res.content.length, content: res.content.slice(0, SPILL_INLINE_BYTES) } : null;
    if (!ok && spillCache.get(path) === hit) spillCache.delete(path);
  });
  spillCache.set(path, hit);
  while (spillCache.size > SPILL_CACHE_CAP) spillCache.delete(spillCache.keys().next().value);
  return hit;
}

function fillSpill(doc, body, res, spill, name, ctx) {
  if (!res) {
    body.textContent = `Could not read ${name}`;
    return;
  }
  const size = res.size;
  const over = size > SPILL_INLINE_BYTES;
  body.textContent = res.content;
  if (!over) return;
  const foot = el(doc, 'div', 'tr-spill-more');
  foot.appendChild(linkNode(doc, { kind: 'path', text: `… ${bytesText(size - SPILL_INLINE_BYTES)} more — open the file`, path: spill.path }, '', ctx));
  body.appendChild(foot);
}

function filedFold(doc, spill, ctx, host) {
  const wrap = el(doc, 'span', 'intent-card-filed-link');
  const size = spill.bytes != null ? `${bytesText(spill.bytes)} ` : '';
  const name = spill.title || (spill.path ? baseName(spill.path) : 'filed body');
  if (!spill.path) {
    wrap.appendChild(doc.createTextNode(`▢ ${size}filed · `));
    wrap.appendChild(doc.createTextNode(name));
    return { head: wrap, mount: NOOP };
  }
  const key = `spill:${spill.path}`;
  const opened = ctx.opened;
  const label = el(doc, 'span', 'tr-spill-label');
  wrap.appendChild(label);
  wrap.appendChild(linkNode(doc, { kind: 'path', text: name, path: spill.path }, '', ctx, true));
  const body = el(doc, 'div', 'tr-spill-body');
  let filled = false;
  const paint = () => {
    const open = opened.has(key);
    label.textContent = `${open ? '▾' : '▸'} ▢ ${size}filed · `;
    toggleClass(wrap, 'tr-spill-open', open);
    if (!open) {
      if (body.parentNode) body.parentNode.removeChild(body);
      return;
    }
    if (!body.parentNode) host.appendChild(body);
    if (filled) return;
    const hit = spillPeek(ctx, spill.path);
    const fill = () => {
      filled = Boolean(hit.res);
      fillSpill(doc, body, hit.res, spill, name, ctx);
    };
    if (hit.done) fill();
    else {
      body.textContent = 'Loading…';
      hit.promise.then(fill);
    }
  };
  wrap.addEventListener('click', () => {
    if (opened.has(key)) opened.delete(key);
    else opened.add(key);
    paint();
  });
  return { head: wrap, mount: paint };
}

function inlineBody(seg) {
  if (seg.open) return null;
  if (seg.state === 'filed' && seg.spill) return true;
  if (!seg.body || seg.verb === 'exec') return null;
  if (!seg.body.includes('\n')) return seg.body.trim().length <= INLINE_CHARS ? seg.body : null;
  if (seg.verb !== 'task') return null;
  const lines = seg.body.split('\n');
  const at = lines.findIndex((l) => l.trim());
  return at < 0 ? null : previewText(lines[at], INLINE_CHARS);
}

function restBody(doc, seg, ctx) {
  const lines = seg.body.split('\n');
  const at = lines.findIndex((l) => l.trim());
  const rest = lines.slice(lines[at].length > INLINE_CHARS ? at : at + 1).join('\n');
  if (!rest.trim()) return [];
  const body = el(doc, 'div', 'intent-card-body intent-card-rest');
  appendPlain(doc, body, rest, ctx);
  const more = rest.split('\n').length;
  const foot = el(doc, 'div', 'intent-card-more', `+ ${countText(more, 'more line', 'more lines')}`);
  const expand = () => {
    body.className = 'intent-card-body';
    foot.hidden = true;
  };
  foot.addEventListener('click', expand);
  body.addEventListener('click', expand);
  return [body, foot];
}

function cardHead(doc, seg, ctx, inline, filed) {
  const head = el(doc, 'div', 'intent-card-head');
  const h = seg.head;
  head.appendChild(el(doc, 'span', 'intent-card-glyph', h.glyph));
  const label = el(doc, 'span', 'intent-card-label', h.label);
  if (seg.verb !== 'task') head.appendChild(label);
  if (h.target) {
    const target = el(doc, 'span', 'intent-card-target');
    if (seg.verb === 'file') target.appendChild(linkNode(doc, { kind: 'path', text: baseName(h.target), path: h.target }, '', ctx));
    else target.textContent = h.target;
    head.appendChild(target);
  }
  if (seg.verb === 'task') head.appendChild(label);
  if (inline) {
    const span = el(doc, 'span', 'intent-card-inline');
    if (filed) span.appendChild(filed);
    else {
      appendPlain(doc, span, inline, ctx);
      span.title = inline;
    }
    head.appendChild(span);
  }
  for (const chip of h.chips) head.appendChild(el(doc, 'span', 'intent-chip', chip));
  if (seg.open) {
    const warn = el(doc, 'span', 'intent-chip intent-chip-warn', 'unclosed');
    warn.title = 'no [agent:end]: only the first line was applied; the rest of the reply is prose';
    head.appendChild(warn);
  }
  return head;
}

function cardBody(doc, seg, ctx) {
  const lines = seg.body.split('\n');
  const body = el(doc, 'div', `intent-card-body${seg.verb === 'exec' ? ' intent-card-body-mono' : ''}`);
  appendPlain(doc, body, seg.body, ctx);
  const more = lines.length - CLAMP_LINES;
  if (seg.open || (more <= 0 && seg.body.length <= CLAMP_CHARS)) return [body];
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
  const card = el(doc, 'div', `intent-card${seg.state === 'filed' ? ' intent-card-filed' : ''}${seg.open ? ' intent-card-open' : ''}`);
  card.dataset.verb = seg.verb;
  const inline = inlineBody(seg);
  const fold = seg.state === 'filed' && seg.spill ? filedFold(doc, seg.spill, ctx, card) : null;
  card.appendChild(cardHead(doc, seg, ctx, inline, inline && fold ? fold.head : null));
  if (inline && seg.body && seg.body.includes('\n') && !(seg.state === 'filed' && seg.spill)) {
    for (const n of restBody(doc, seg, ctx)) card.appendChild(n);
  }
  if (inline) {
    if (fold) fold.mount();
    return card;
  }
  if (fold) {
    const row = el(doc, 'div', 'intent-card-body');
    row.appendChild(fold.head);
    card.appendChild(row);
    fold.mount();
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
    if (seg.spill) {
      const fold = filedFold(doc, seg.spill, ctx, prose);
      prose.appendChild(fold.head);
      fold.mount();
    } else appendPlain(doc, prose, seg.text, ctx);
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
  if (Math.round(n / 1000) >= 1000) return `${+(n / 1e6).toFixed(1)}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function durationText(ms) {
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
  const t = Math.round(ms / 1000);
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${t % 60}s`;
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

function imageNode(doc, image) {
  if (image.data == null) return el(doc, 'span', 'tr-image-chip', `Image #${image.n} · ${bytesText(image.bytes)}`);
  const img = el(doc, 'img', 'tr-image-thumb');
  img.src = `data:${image.mediaType};base64,${image.data}`;
  img.alt = `Image #${image.n}`;
  img.addEventListener('click', () => toggleClass(img, 'tr-image-open', !/\btr-image-open\b/.test(img.className)));
  return img;
}

function appendPrompt(doc, text, rec, ctx) {
  const byN = new Map((rec.pastes || []).map((p) => [p.n, p]));
  const imageByN = new Map((rec.images || []).map((i) => [i.n, i]));
  let at = 0;
  for (const m of rec.text.matchAll(PROMPT_MARK_RE)) {
    const end = m.index + m[0].length;
    if (m[2] != null) {
      const image = imageByN.get(Number(m[2]));
      if (!image) continue;
      if (m.index > at) appendProse(doc, text, rec.text.slice(at, m.index), ctx);
      text.appendChild(imageNode(doc, image));
      at = end;
      continue;
    }
    const paste = byN.get(Number(m[1]));
    if (!paste) continue;
    const before = rec.text.slice(at, m.index);
    const lead = m.index > 0 && !rec.text.slice(0, m.index).endsWith('\n') ? '\n' : '';
    const tail = end < rec.text.length && rec.text[end] !== '\n' ? '\n' : '';
    if (before || lead) appendProse(doc, text, before + lead, ctx);
    appendProse(doc, text, paste.text + tail, ctx);
    at = end;
  }
  if (at < rec.text.length || !at) appendProse(doc, text, rec.text.slice(at), ctx);
}

function cutMark(doc, text, rec) {
  if (rec.truncated) text.appendChild(el(doc, 'span', 'tr-cut', ' … cut at 4 KB'));
}

function promptRow(doc, rec, ctx) {
  const mid = rec.source === 'mid-turn';
  const row = headRow(doc, mid ? 'tr-prompt tr-prompt-mid' : 'tr-prompt', rec);
  if (mid) row.appendChild(el(doc, 'span', 'tr-mid', 'mid-turn'));
  row.appendChild(operatorBadge(doc, 'you', 'Typed in Clodex'));
  const text = el(doc, 'span', 'tr-head-text');
  if (rec.pastes || rec.images) appendPrompt(doc, text, rec, ctx);
  else appendProse(doc, text, rec.text, ctx);
  cutMark(doc, text, rec);
  row.appendChild(text);
  withTime(doc, row, rec);
  if (mid) {
    const word = rec.state === 'read' || rec.state === 'queued' ? rec.state : 'delivered';
    const state = el(doc, 'span', 'tr-mid-state', word === 'read' ? '✓ read' : word);
    state.dataset.state = word;
    row.appendChild(state);
  }
  return row;
}

function operatorBadge(doc, label, title) {
  const badge = el(doc, 'span', 'tr-sender tr-sender-operator');
  badge.title = title;
  badge.appendChild(el(doc, 'span', 'tr-sender-glyph', OPERATOR_GLYPH));
  badge.appendChild(el(doc, 'span', 'tr-sender-name', label));
  return badge;
}

function senderTitle(from, client) {
  if (from !== 'user') return String(from);
  return client === 'ios' ? 'Sent from the phone app' : 'Sent through the remote API';
}

function senderBadge(doc, from, client) {
  const { cls, label, glyph } = classifySender(from, client);
  const badge = el(doc, 'span', `tr-sender tr-sender-${cls}`);
  badge.title = senderTitle(from, client);
  badge.appendChild(el(doc, 'span', 'tr-sender-glyph', glyph));
  badge.appendChild(el(doc, 'span', 'tr-sender-name', label));
  return badge;
}

function inboundBadge(doc, rec) {
  if (rec.via !== 'subagent') return senderBadge(doc, rec.from, rec.client);
  const name = String(rec.from);
  const badge = el(doc, 'span', `tr-sender tr-sender-${classifySender(name).cls}`);
  badge.title = 'Report from a subagent of this seat — attached by the CLI, not typed';
  badge.appendChild(el(doc, 'span', 'tr-sender-glyph', initial(name)));
  badge.appendChild(el(doc, 'span', 'tr-sender-name', name));
  return badge;
}

function appBadge(doc, rec) {
  const badge = el(doc, 'span', 'tr-sender tr-sender-app');
  badge.title = 'Clodex runtime';
  badge.appendChild(el(doc, 'span', 'tr-sender-glyph', rec.glyph));
  badge.appendChild(el(doc, 'span', 'tr-sender-name', rec.label));
  return badge;
}

function replyRow(doc, rec, ctx, attached, boxed) {
  const row = headRow(doc, `tr-reply${attached ? ' tr-reply-attached' : ''}`, rec);
  const text = el(doc, 'span', 'tr-head-text');
  if (attached && !boxed) text.appendChild(el(doc, 'span', 'tr-reply-lead', '↳'));
  if (!boxed) text.appendChild(appBadge(doc, rec));
  appendPlain(doc, text, rec.text, ctx);
  row.appendChild(text);
  return withTime(doc, row, rec);
}

function attachedLead(rec) {
  const cut = rec.attached ? rec.text.indexOf('Message (') : -1;
  return cut < 0 ? rec.text : rec.text.slice(0, cut);
}

function inboundRow(doc, rec, ctx, boxed) {
  const row = headRow(doc, 'tr-inbound', rec);
  const text = el(doc, 'span', 'tr-head-text');
  if (rec.via === 'subagent') row.dataset.via = 'subagent';
  if (!boxed) text.appendChild(inboundBadge(doc, rec));
  if (rec.attached) {
    const lead = attachedLead(rec).trim();
    if (lead) appendProse(doc, text, `${lead} `, ctx);
    text.appendChild(el(doc, 'span', 'tr-dim', `${bytesText(rec.attached.bytes)} `));
    text.appendChild(linkNode(doc, { kind: 'path', text: baseName(rec.attached.path), path: rec.attached.path }, '', ctx));
  } else {
    appendProse(doc, text, rec.text, ctx);
    cutMark(doc, text, rec);
  }
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

function isLong(text) {
  const s = String(text == null ? '' : text);
  return s.split('\n').length > CLAMP_LINES || s.length > CLAMP_CHARS;
}

function previewText(text, max = PREVIEW_CHARS) {
  const line = String(text == null ? '' : text).split('\n').find((l) => l.trim()) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function restText(text) {
  const s = String(text == null ? '' : text);
  const lines = s.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0 || lines[i].length > PREVIEW_CHARS) return s;
  return lines.slice(i + 1).join('\n').replace(/^\s*\n/, '');
}

function previewSpan(doc, text) {
  const span = el(doc, 'span', 'tr-box-preview', previewText(text));
  const line = String(text == null ? '' : text).split('\n').find((l) => l.trim()) || '';
  if (line.length > PREVIEW_CHARS) span.title = line;
  return span;
}

function boxHead(doc, rec, att) {
  const head = el(doc, 'div', 'tr-box-head');
  if (att) head.appendChild(el(doc, 'span', 'tr-reply-lead', '↳'));
  if (rec.kind === 'inbound') head.appendChild(inboundBadge(doc, rec));
  else if (rec.kind === 'reply') head.appendChild(appBadge(doc, rec));
  else head.appendChild(el(doc, 'span', 'tr-mark'));
  head.appendChild(previewSpan(doc, rec.text));
  head.appendChild(el(doc, 'span', 'tr-box-chevron'));
  return head;
}

function selectedText(doc) {
  const sel = doc.getSelection && doc.getSelection();
  return sel && !sel.isCollapsed ? String(sel) : '';
}

function wireHead(doc, head, box, chevron, opened, id, lead = false) {
  const paint = () => {
    const open = opened.has(id) !== lead;
    toggleClass(box, 'tr-box-folded', !open);
    chevron.textContent = open ? '▾' : '▸';
  };
  let before = '';
  head.addEventListener('mousedown', () => { before = selectedText(doc); });
  head.addEventListener('click', () => {
    const now = selectedText(doc);
    if (now && now !== before) return;
    if (opened.has(id)) opened.delete(id);
    else opened.add(id);
    paint();
  });
  paint();
}

function internalBox(doc, rec, row, opened, att, opens, lead) {
  const box = el(doc, 'div', 'tr-box');
  box.dataset.id = rec.id;
  if (opens) {
    const head = boxHead(doc, rec, att);
    const chevron = head.childNodes[head.childNodes.length - 1];
    wireHead(doc, head, box, chevron, opened, rec.id, lead);
    box.appendChild(head);
  }
  const body = el(doc, 'div', 'tr-box-body');
  body.appendChild(row);
  box.appendChild(body);
  return box;
}

function ticketParts(rec) {
  const { id, tag } = rec.ticket;
  const text = attachedLead(rec);
  if (rec.kind !== 'reply') return { chip: tag ? `${id} ${tag}` : id, message: text.replace(/^\[ticket [^\]]*\]\s*/, '') };
  const m = /^ticket t\d+[ \t]*([^\s:]*):?[ \t]*/.exec(text);
  const state = m ? m[1] : '';
  const message = (m ? text.slice(m[0].length) : text).replace(/^[—–:-][ \t]*/, '');
  return { chip: state ? `${id} ${state}` : id, message };
}

function ticketOpens(rec, message) {
  if (rec.attached) return true;
  return Boolean((rec.text.trim().includes('\n') || isLong(rec.text) || message.trim().length > PREVIEW_CHARS) && restText(message.trim()));
}

function boxedView(rec) {
  if (rec.ticket && (rec.kind === 'inbound' || rec.kind === 'reply')) {
    const { message } = ticketParts(rec);
    return ticketOpens(rec, message) ? { ...rec, text: restText(message.trim()) } : null;
  }
  return isLong(rec.text) && restText(rec.text) ? { ...rec, text: restText(rec.text) } : null;
}

function ticketBox(doc, rec, row, opened, att, ctx, lead) {
  const box = el(doc, 'div', 'tr-box');
  box.dataset.id = rec.id;
  const { chip, message } = ticketParts(rec);
  const head = el(doc, 'div', 'tr-box-head');
  if (att) head.appendChild(el(doc, 'span', 'tr-reply-lead', '↳'));
  head.appendChild(el(doc, 'span', 'tr-ticket-chip', chip));
  head.appendChild(rec.kind === 'reply' ? appBadge(doc, rec) : inboundBadge(doc, rec));
  const opens = ticketOpens(rec, message);
  const preview = opens ? previewSpan(doc, message.trim()) : el(doc, 'span', 'tr-box-preview');
  if (!opens) appendLinked(doc, preview, message.trim(), '', ctx);
  head.appendChild(preview);
  box.appendChild(head);
  if (opens) {
    const chevron = el(doc, 'span', 'tr-box-chevron');
    head.appendChild(chevron);
    wireHead(doc, head, box, chevron, opened, rec.id, lead);
    const body = el(doc, 'div', 'tr-box-body');
    body.appendChild(row);
    box.appendChild(body);
  } else {
    withTime(doc, head, rec);
  }
  toggleClass(box, 'tr-ticket', true);
  return box;
}

function ticketChip(doc, node, ticket) {
  toggleClass(node, 'tr-ticket', true);
  const chip = el(doc, 'span', 'tr-ticket-chip', ticket.tag ? `${ticket.id} ${ticket.tag}` : ticket.id);
  const head = Array.from(node.childNodes).find((c) => c.className === 'tr-box-head');
  if (head) head.insertBefore(chip, Array.from(head.childNodes).find((c) => c.className === 'tr-box-preview') || null);
  else node.insertBefore(chip, node.firstChild);
  return node;
}

function foldHead(doc, driver, stats) {
  const head = el(doc, 'button', 'tr-row tr-turn-fold');
  head.type = 'button';
  head.appendChild(el(doc, 'span', 'tr-box-chevron'));
  if (driver.kind === 'inbound') head.appendChild(inboundBadge(doc, driver));
  else if (driver.kind === 'reply') head.appendChild(appBadge(doc, driver));
  else head.appendChild(el(doc, 'span', 'tr-mark'));
  const line = el(doc, 'span', 'tr-turn-fold-line');
  line.appendChild(el(doc, 'span', 'tr-turn-fold-text', previewText(driver.text, FOLD_CHARS)));
  if (driver.ticket) ticketChip(doc, line, driver.ticket);
  head.appendChild(line);
  head.appendChild(footerParts(doc, el(doc, 'span', 'tr-turn-fold-stats'), stats, null, false));
  return head;
}

function isTalk(r) {
  return r.kind !== 'turn-end' && surfaceOf(r) === 'conversation';
}

function hasInternalSeg(r) {
  return r.kind === 'assistant' && !r.apiError && Array.isArray(r.segments) && isTalk(r) && r.segments.some((s) => segmentSurface(s) !== 'conversation');
}

function buildRow(doc, rec, ctx, attached, boxed) {
  switch (rec.kind) {
    case 'prompt': return promptRow(doc, rec, ctx);
    case 'inbound': return inboundRow(doc, rec, ctx, boxed);
    case 'reply': return replyRow(doc, rec, ctx, attached, boxed);
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
        ? ['compacted', rec.preTokens != null && rec.postTokens != null ? `${tokensText(rec.preTokens)} → ${tokensText(rec.postTokens)} tokens` : null, rec.trigger, typeof rec.elapsedMs === 'number' ? elapsedText(rec.elapsedMs) : null].filter(Boolean).join(' · ')
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
  const last = records[records.length - 1];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r || r.turn !== last.turn) break;
    if (r.kind === 'tool' && r.state === 'pending') return r.name || null;
  }
  return null;
}

function filesOf(tools) {
  const files = new Map();
  for (const r of tools) {
    if (r.state !== 'ok' || !r.sum || !r.sum.file || r.sum.add == null) continue;
    const f = files.get(r.sum.file) || { file: r.sum.file, add: 0, del: 0 };
    f.add += r.sum.add;
    f.del += r.sum.del;
    files.set(r.sum.file, f);
  }
  return [...files.values()];
}

function footerOf(records) {
  const end = records.find((r) => r.kind === 'turn-end');
  if (!end) return null;
  const tools = records.filter((r) => r.kind === 'tool');
  return {
    durationMs: end.durationMs != null ? end.durationMs : null,
    tools: tools.length,
    errors: tools.filter((r) => r.state === 'error' || r.state === 'denied').length,
    files: filesOf(tools),
  };
}

function footerParts(doc, row, f, ctx, linked) {
  const parts = [];
  if (f.durationMs != null) parts.push(() => row.appendChild(doc.createTextNode(durationText(f.durationMs))));
  if (f.tools) parts.push(() => row.appendChild(doc.createTextNode(countText(f.tools, 'tool', 'tools'))));
  if (f.errors) parts.push(() => row.appendChild(el(doc, 'span', 'tr-err', countText(f.errors, 'error', 'errors'))));
  if (f.injected) parts.push(() => row.appendChild(doc.createTextNode(`${f.injected} injected`)));
  for (const file of f.files) {
    parts.push(() => {
      if (linked) row.appendChild(linkNode(doc, { kind: 'path', text: baseName(file.file), path: file.file }, '', ctx));
      else row.appendChild(doc.createTextNode(baseName(file.file)));
      row.appendChild(doc.createTextNode(` +${file.add} ${MINUS}${file.del}`));
    });
  }
  parts.forEach((add, i) => {
    if (i) row.appendChild(doc.createTextNode(' · '));
    add();
  });
  return row;
}

function buildFooter(doc, f, ctx) {
  return footerParts(doc, el(doc, 'div', 'tr-row tr-footer'), f, ctx, true);
}

function runStatsOf(records) {
  const ends = records.filter((r) => r.kind === 'turn-end');
  const timed = ends.filter((r) => r.durationMs != null);
  const tools = records.filter((r) => r.kind === 'tool');
  return {
    ended: ends.length > 0,
    durationMs: timed.length ? timed.reduce((n, r) => n + r.durationMs, 0) : null,
    tools: tools.length,
    errors: tools.filter((r) => r.state === 'error' || r.state === 'denied').length,
    injected: records.filter(isInternalRow).length,
    files: filesOf(tools),
  };
}

function suppressesClosed(records) {
  return records.some((r) => r.kind !== 'turn-end' && (!isTalk(r) || hasInternalSeg(r)));
}

function reconcile(parent, cache, items, lead = null) {
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
    const want = prev ? prev.nextSibling : lead && lead.parentNode === parent ? lead.nextSibling : parent.firstChild;
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

function logicalHead(t) {
  return t.records.find((r) => TURN_KINDS.has(r.kind)) || t.records[0];
}

function groupRuns(turns) {
  const runs = [];
  for (const t of turns) {
    const head = logicalHead(t);
    if (!runs.length || isTalk(head)) runs.push({ key: head.id, turns: [t] });
    else runs[runs.length - 1].turns.push(t);
  }
  for (const run of runs) {
    run.records = run.turns.flatMap((t) => t.records);
    run.hosted = run.turns.some((t) => t.records.some(isTalk));
  }
  return runs;
}

function createTranscriptRows(doc, paneEl, ctx = {}) {
  const deps = { lead: null, mode: 'internals', seatName: null, resolveFile: NOOP, openFilePeek: NOOP, peekFile: () => null, openExternal: NOOP, toast: NOOP, echoPalette: null, now: () => Date.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (t) => clearInterval(t), ...ctx };
  const turnCache = new Map();
  const opened = new Set();
  const shut = new Set();
  deps.opened = opened;
  const openRuns = new Set();
  const openTurns = new Set();
  let lastSource = null;
  let mode = deps.mode === 'conversation' ? 'conversation' : 'internals';
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

  function paintBlock(c) {
    const { key, tools } = c;
    const many = tools.length > 1;
    const open = !many || opened.has(key);
    c.el.className = `tr-row tr-tool-block${many ? ' tr-tool-many' : ''}${open ? '' : ' tr-tool-folded'}`;
    const items = [];
    if (many) {
      items.push({ key: 'head', sig: String(tools.length), build: () => {
        const head = el(doc, 'div', 'tr-tool-head');
        head.appendChild(el(doc, 'span', 'tr-tool-head-name', tools[0].name));
        head.appendChild(el(doc, 'span', 'tr-tool-count', `${TIMES}${tools.length}`));
        head.appendChild(el(doc, 'span', 'tr-box-chevron'));
        head.addEventListener('click', () => {
          if (opened.has(key)) opened.delete(key);
          else opened.add(key);
          paintBlock(c);
        });
        return head;
      } });
    }
    for (const r of open ? tools : tools.slice(-1)) items.push({ key: r.id, sig: JSON.stringify(r) + (many ? '' : '|named'), build: () => toolRow(doc, r, deps, !many) });
    reconcile(c.el, c.sub, items);
    if (many) {
      const head = c.sub.get('head').el;
      const chevron = head.childNodes[head.childNodes.length - 1];
      const glyph = open ? '▾' : '▸';
      if (chevron.textContent !== glyph) chevron.textContent = glyph;
    }
  }

  function toolBlockItem(tools, open, m, hideTools) {
    const key = `tools:${tools[0].id}`;
    return {
      key,
      sig: 'tools',
      build: () => {
        const block = el(doc, 'div', 'tr-row tr-tool-block');
        block.dataset.id = key;
        return block;
      },
      after: (c) => {
        if (!c.sub) c.sub = new Map();
        c.key = key;
        c.tools = tools;
        paintBlock(c);
        toggleClass(c.el, 'tr-hidden', hideTools || (m === 'conversation' && !open));
      },
    };
  }

  function runToggleOf(key) {
    for (const turn of paneEl.childNodes) {
      for (const n of turn.childNodes || []) if (n.dataset && n.dataset.run === key) return n;
    }
    return null;
  }

  function runToggleItem(run, open) {
    const stats = runStatsOf(run.records);
    if (suppressesClosed(run.records)) {
      return {
        key: 'run-toggle',
        sig: `${run.key}|${JSON.stringify(stats)}`,
        build: () => {
          const btn = el(doc, 'button', 'tr-row tr-footer tr-run-toggle');
          btn.type = 'button';
          btn.dataset.run = run.key;
          const glyph = btn.appendChild(el(doc, 'span', 'tr-run-glyph'));
          glyph.setAttribute('aria-hidden', 'true');
          footerParts(doc, btn, stats, deps, false);
          btn.title = 'Show or hide the steps behind this reply';
          if (btn.childNodes.length === 1) btn.setAttribute('aria-label', 'Show or hide this run\'s steps');
          btn.addEventListener('click', () => {
            const focused = doc.activeElement === btn;
            const anchor = anchorOf();
            if (openRuns.has(run.key)) openRuns.delete(run.key);
            else openRuns.add(run.key);
            render(lastRecords);
            restore(anchor);
            const next = focused ? runToggleOf(run.key) : null;
            if (next) next.focus({ preventScroll: true });
          });
          return btn;
        },
        after: (c) => {
          const want = open ? 'true' : 'false';
          if (c.el.getAttribute('aria-expanded') !== want) c.el.setAttribute('aria-expanded', want);
          const glyph = open ? '▾ ' : '▸ ';
          if (c.el.firstChild.textContent !== glyph) c.el.firstChild.textContent = glyph;
        },
      };
    }
    if (!stats.ended) return null;
    return { key: 'footer', sig: JSON.stringify(stats), build: () => buildFooter(doc, stats, deps) };
  }

  function rowItems(records, attached, open, tail, live, m, hideTools, end, driver) {
    const items = [];
    for (const run of toolRuns(records)) {
      if (run.tools) {
        live.add(`tools:${run.tools[0].id}`);
        items.push(toolBlockItem(run.tools, open, m, hideTools));
        continue;
      }
      const r = run.rec;
      if (r.kind === 'turn-end') continue;
      const att = attached.has(r.id);
      const extra = r.kind === 'command-output' ? JSON.stringify(resolvePalette(deps) || null) : att ? '|attached' : '';
      const hidden = m === 'conversation' && !open && !isTalk(r);
      const after = (c) => toggleClass(c.el, 'tr-hidden', hidden);
      if (isInternalRow(r)) {
        live.add(r.id);
        const lead = r === driver;
        const set = lead ? shut : opened;
        items.push({
          key: r.id,
          sig: recSig(r) + extra + (lead ? '|lead' : ''),
          build: () => {
            const view = r.kind === 'inbound' || r.kind === 'reply' ? boxedView(r) : null;
            const row = buildRow(doc, view || r, deps, att, Boolean(view)) || el(doc, 'div', 'tr-row');
            if (r.ticket && (r.kind === 'inbound' || r.kind === 'reply')) return ticketBox(doc, r, row, set, att, deps, lead);
            return internalBox(doc, r, row, set, att, r.kind === 'inbound' || r.kind === 'reply' ? Boolean(view) : isLong(r.text), lead);
          },
          after,
        });
        continue;
      }
      const rest = end && end.rec === r ? (r.segments || []).filter((s) => !end.segs.includes(s)) : null;
      if (rest && !rest.length) continue;
      const base = rest ? { ...r, segments: rest } : r;
      const full = m === 'internals' || open;
      const omit = !full && hasInternalSeg(base);
      const view = omit ? { ...base, segments: base.segments.filter((s) => segmentSurface(s) === 'conversation') } : base;
      const sig = recSig(r) + extra + (hasInternalSeg(base) ? (full ? '|full' : '|conv') : '') + (rest ? '|rest' : '');
      items.push({ key: r.id, sig, build: () => buildRow(doc, view, deps, att) || el(doc, 'div', 'tr-row'), after });
    }
    if (m === 'internals') {
      const footer = footerOf(records);
      if (footer) items.push({ key: 'footer', sig: JSON.stringify(footer), build: () => buildFooter(doc, footer, deps) });
    } else if (tail) items.push(tail);
    return items;
  }

  function endProseItem(end) {
    return {
      key: 'turn-end-prose',
      sig: `${end.rec.id}|${JSON.stringify(end.segs)}`,
      build: () => {
        const row = el(doc, 'div', 'tr-row tr-prose tr-segs tr-turn-end-prose');
        appendSegments(doc, row, end.segs, deps);
        return row;
      },
    };
  }

  function foldItem(t, unfolded) {
    const driver = turnDriver(t.records);
    const stats = runStatsOf(t.records);
    return {
      key: 'turn-fold',
      sig: `${driver.id}|${driver.text}|${JSON.stringify(driver.ticket || null)}|${JSON.stringify(stats)}`,
      build: () => {
        const head = foldHead(doc, driver, stats);
        head.addEventListener('click', () => {
          const anchor = anchorOf();
          if (openTurns.has(t.key)) openTurns.delete(t.key);
          else openTurns.add(t.key);
          render(lastRecords);
          restore(anchor);
        });
        return head;
      },
      after: (c) => {
        const glyph = unfolded ? '▾' : '▸';
        if (c.el.firstChild.textContent !== glyph) c.el.firstChild.textContent = glyph;
        const want = unfolded ? 'true' : 'false';
        if (c.el.getAttribute('aria-expanded') !== want) c.el.setAttribute('aria-expanded', want);
      },
    };
  }

  function render(records, source) {
    const list = Array.isArray(records) ? records : [];
    if (source != null) {
      if (lastSource != null && source !== lastSource) {
        for (const c of turnCache.values()) if (c.el.parentNode === paneEl) paneEl.removeChild(c.el);
        turnCache.clear();
        openRuns.clear();
        openTurns.clear();
        opened.clear();
        shut.clear();
      }
      lastSource = source;
    }
    lastRecords = list;
    const attached = attachedReplies(list);
    const runs = groupRuns(groupTurns(list));
    const keys = new Set(runs.filter((run) => run.hosted).map((run) => run.key));
    for (const k of [...openRuns]) if (!keys.has(k)) openRuns.delete(k);
    const turnKeys = new Set(runs.flatMap((run) => run.turns.map((t) => t.key)));
    for (const k of [...openTurns]) if (!turnKeys.has(k)) openTurns.delete(k);
    const live = new Set();
    const items = [];
    for (const run of runs) {
      const open = openRuns.has(run.key);
      const hostable = run.turns.filter((t) => open || !turnFolds(t.records, mode));
      const host = open ? hostable[hostable.length - 1] : run.hosted ? hostable.filter((t) => t.records.some(isTalk)).pop() : null;
      run.turns.forEach((t, i) => items.push({
        key: t.key,
        sig: '',
        build: () => {
          const block = el(doc, 'div', 'tr-turn');
          block.dataset.turn = t.key;
          return block;
        },
        after: (c) => {
          if (!c.sub) c.sub = new Map();
          const folds = turnFolds(t.records, mode) && !open;
          const unfolded = folds && openTurns.has(t.key);
          const m = unfolded ? 'internals' : mode;
          const tail = m === 'conversation' && t === host ? runToggleItem(run, open) : null;
          const end = folds ? turnEndProse(t.records) : null;
          const rows = rowItems(t.records, attached, open, tail, live, m, unfolded, end, unfolded ? turnDriver(t.records) : null);
          reconcile(c.el, c.sub, folds ? [foldItem(t, unfolded), ...(unfolded ? rows : []), ...(end ? [endProseItem(end)] : [])] : rows);
          toggleClass(c.el, 'tr-turn-folded', folds && !unfolded);
          toggleClass(c.el, 'tr-hidden', mode === 'conversation' && !open && !t.records.some(isTalk));
          toggleClass(c.el, 'tr-turn-cont', mode === 'conversation' && i > 0);
        },
      }));
    }
    reconcile(paneEl, turnCache, items, deps.lead);
    for (const r of list) for (const seg of r.segments || []) if (seg.spill && seg.spill.path) live.add(`spill:${seg.spill.path}`);
    for (const k of [...opened]) if (!live.has(k)) opened.delete(k);
    for (const k of [...shut]) if (!live.has(k)) shut.delete(k);
    if (working) paintWorking();
  }

  function visibleTurns() {
    return Array.from(paneEl.childNodes).filter((n) => /\btr-turn\b/.test(n.className) && !/\btr-hidden\b/.test(n.className));
  }

  function anchorOf() {
    const top = paneEl.scrollTop;
    if (typeof top !== 'number' || typeof paneEl.scrollHeight !== 'number') return null;
    if (top + (paneEl.clientHeight || 0) >= paneEl.scrollHeight - 4) return { bottom: true };
    const turns = Array.from(paneEl.childNodes).filter((n) => /\btr-turn\b/.test(n.className));
    const at = turns.find((n) => !/\btr-hidden\b/.test(n.className) && typeof n.offsetTop === 'number' && n.offsetTop + (n.offsetHeight || 0) > top);
    if (!at) return null;
    return { turns: turns.slice(turns.indexOf(at)), offset: at.offsetTop - top };
  }

  function restore(anchor) {
    if (!anchor) return;
    if (anchor.bottom) {
      paneEl.scrollTop = paneEl.scrollHeight;
      return;
    }
    const shown = new Set(visibleTurns());
    const next = anchor.turns.find((n) => shown.has(n));
    if (next && typeof next.offsetTop === 'number') paneEl.scrollTop = next.offsetTop - anchor.offset;
  }

  function setMode(next) {
    const want = next === 'conversation' ? 'conversation' : 'internals';
    if (mode === want) return;
    const anchor = anchorOf();
    mode = want;
    render(lastRecords);
    restore(anchor);
  }

  return { render, setWorking, setMode };
}

module.exports = { OUTPUT_LINE_CAP, summaryParts, footerOf, attachedReplies, createTranscriptRows, spillCache };
