'use strict';

const SAFE_SCHEME = /^https?:\/\//i;
const MAX_QUOTE_DEPTH = 8;
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+([^\n]*)$/;
const QUOTE = /^ {0,3}> ?([^\n]*)$/;
const BULLET = /^ {0,3}[-*+][ \t]+([^\n]*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)][ \t]+([^\n]*)$/;
const LANG = /^[A-Za-z0-9_+#.-]{1,20}$/;
const WORD_CHAR = /\w/;
const BLANK = /\s/;
const INLINE = /`([^`\n]+)`|(!\[[^\]\n]*\]\([^)\s]*\))|\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;

function safeHref(raw) {
  const href = String(raw == null ? '' : raw).trim().replace(/^<+/, '').replace(/>+$/, '');
  return SAFE_SCHEME.test(href) ? href : null;
}

function isTableRule(line) {
  return typeof line === 'string'
    && /^[\s|:-]+$/.test(line)
    && line.includes('-')
    && line.includes('|');
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.replace(/\\\|/g, '\u0000').split('|').map((c) => c.replace(/\u0000/g, '|').trim());
}

function fenceOf(line) {
  const m = FENCE.exec(line);
  return m && !(m[1][0] === '`' && m[2].includes('`')) ? m : null;
}

function startsBlock(line) {
  return !line.trim()
    || fenceOf(line) !== null
    || HEADING.test(line)
    || QUOTE.test(line)
    || BULLET.test(line)
    || ORDERED.test(line);
}

function endsRun(lines, j) {
  return !lines[j].trim()
    || startsBlock(lines[j])
    || (lines[j].includes('|') && isTableRule(lines[j + 1]));
}

function intraword(s, m) {
  return (m[6] !== undefined || m[8] !== undefined)
    && (WORD_CHAR.test(s.charAt(m.index - 1)) || WORD_CHAR.test(s.charAt(INLINE.lastIndex)));
}

let hooks = null;

function appendText(parent, s, doc) {
  if (hooks && hooks.text) hooks.text(parent, s);
  else parent.appendChild(doc.createTextNode(s));
}

function appendInline(parent, text, doc) {
  const s = String(text == null ? '' : text);
  INLINE.lastIndex = 0;
  let at = 0;
  let m = INLINE.exec(s);
  while (m !== null) {
    if (intraword(s, m)) {
      INLINE.lastIndex = m.index + 1;
      m = INLINE.exec(s);
      continue;
    }
    if (m.index > at) appendText(parent, s.slice(at, m.index), doc);
    if (m[1] !== undefined) {
      const code = doc.createElement('code');
      code.textContent = m[1];
      parent.appendChild(code);
    } else if (m[2] !== undefined) {
      appendText(parent, m[2], doc);
    } else if (m[3] !== undefined) {
      const href = safeHref(m[4]);
      if (href && hooks && hooks.link) hooks.link(parent, m[3], href);
      else if (href) {
        const a = doc.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('rel', 'noreferrer noopener');
        a.setAttribute('target', '_blank');
        a.textContent = m[3];
        parent.appendChild(a);
      } else {
        appendText(parent, m[0], doc);
      }
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const strong = doc.createElement('strong');
      strong.textContent = m[5] !== undefined ? m[5] : m[6];
      parent.appendChild(strong);
    } else {
      const em = doc.createElement('em');
      em.textContent = m[7] !== undefined ? m[7] : m[8];
      parent.appendChild(em);
    }
    at = INLINE.lastIndex;
    m = INLINE.exec(s);
  }
  if (at < s.length) appendText(parent, s.slice(at), doc);
  return parent;
}

function trimClosingHashes(text) {
  let end = text.length;
  while (end > 0 && BLANK.test(text[end - 1])) end--;
  let hashes = end;
  while (hashes > 0 && text[hashes - 1] === '#') hashes--;
  let start = hashes;
  while (start > 0 && BLANK.test(text[start - 1])) start--;
  return hashes < end && start < hashes ? text.slice(0, start) : text;
}

function renderFence(lines, i, parent, doc) {
  const open = fenceOf(lines[i]);
  const marker = open[1][0];
  const body = [];
  let j = i + 1;
  while (j < lines.length) {
    const close = fenceOf(lines[j]);
    if (close && close[1][0] === marker && close[1].length >= open[1].length && close[2].trim() === '') break;
    body.push(lines[j]);
    j++;
  }
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  const lang = open[2].trim().split(/\s+/)[0];
  if (LANG.test(lang)) code.setAttribute('data-lang', lang);
  code.textContent = body.join('\n');
  pre.appendChild(code);
  parent.appendChild(pre);
  return j < lines.length ? j + 1 : j;
}

function renderQuote(lines, i, parent, doc, depth) {
  const body = [];
  let j = i;
  while (j < lines.length) {
    const q = QUOTE.exec(lines[j]);
    if (!q) break;
    body.push(q[1]);
    j++;
  }
  const quote = doc.createElement('blockquote');
  if (depth >= MAX_QUOTE_DEPTH) {
    const p = doc.createElement('p');
    appendInline(p, body.join(' '), doc);
    quote.appendChild(p);
  } else {
    renderBlocks(body, quote, doc, depth + 1);
  }
  parent.appendChild(quote);
  return j;
}

function renderList(lines, i, parent, doc) {
  const ordered = ORDERED.test(lines[i]);
  const item = ordered ? ORDERED : BULLET;
  const list = doc.createElement(ordered ? 'ol' : 'ul');
  if (ordered) {
    const first = ORDERED.exec(lines[i])[1];
    if (first !== '1') list.setAttribute('start', first);
  }
  const texts = [];
  let j = i;
  while (j < lines.length) {
    const m = item.exec(lines[j]);
    if (m) {
      texts.push(ordered ? m[2] : m[1]);
      j++;
      continue;
    }
    if (texts.length && !endsRun(lines, j)) {
      texts[texts.length - 1] += ` ${lines[j].trim()}`;
      j++;
      continue;
    }
    break;
  }
  for (const t of texts) {
    const li = doc.createElement('li');
    appendInline(li, t, doc);
    list.appendChild(li);
  }
  parent.appendChild(list);
  return j;
}

function renderTable(lines, i, parent, doc) {
  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const cell of splitRow(lines[i])) {
    const th = doc.createElement('th');
    appendInline(th, cell, doc);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  let j = i + 2;
  while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
    const tr = doc.createElement('tr');
    for (const cell of splitRow(lines[j])) {
      const td = doc.createElement('td');
      appendInline(td, cell, doc);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    j++;
  }
  table.appendChild(tbody);
  parent.appendChild(table);
  return j;
}

function renderParagraph(lines, i, parent, doc) {
  const body = [lines[i].trim()];
  let j = i + 1;
  while (j < lines.length && !endsRun(lines, j)) {
    body.push(lines[j].trim());
    j++;
  }
  const p = doc.createElement('p');
  appendInline(p, body.join(' '), doc);
  parent.appendChild(p);
  return j;
}

function renderBlocks(lines, parent, doc, depth = 0) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (fenceOf(line)) { i = renderFence(lines, i, parent, doc); continue; }
    const h = HEADING.exec(line);
    if (h) {
      const heading = doc.createElement(`h${h[1].length}`);
      appendInline(heading, trimClosingHashes(h[2]), doc);
      parent.appendChild(heading);
      i++;
      continue;
    }
    if (QUOTE.test(line)) { i = renderQuote(lines, i, parent, doc, depth); continue; }
    if (BULLET.test(line) || ORDERED.test(line)) { i = renderList(lines, i, parent, doc); continue; }
    if (line.includes('|') && isTableRule(lines[i + 1])) { i = renderTable(lines, i, parent, doc); continue; }
    i = renderParagraph(lines, i, parent, doc);
  }
  return parent;
}

function renderMarkdown(text, opts = null) {
  const doc = (opts && opts.doc) || document;
  const frag = doc.createDocumentFragment();
  const lines = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n');
  hooks = opts;
  try {
    return renderBlocks(lines, frag, doc);
  } finally {
    hooks = null;
  }
}

module.exports = { renderMarkdown };
