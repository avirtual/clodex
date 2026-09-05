'use strict';

const SAFE_SCHEME = /^https?:\/\//i;
const MAX_QUOTE_DEPTH = 8;
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const LANG = /^[A-Za-z0-9_+#.-]{1,20}$/;
const INLINE = /`([^`\n]+)`|(!\[[^\]\n]*\]\([^)\s]*\))|\[([^\]\n]*)\]\(([^)\s]*)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;

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

function startsBlock(line) {
  return !line.trim()
    || FENCE.test(line)
    || HEADING.test(line)
    || QUOTE.test(line)
    || BULLET.test(line)
    || ORDERED.test(line);
}

function appendInline(parent, text, doc) {
  const s = String(text == null ? '' : text);
  INLINE.lastIndex = 0;
  let at = 0;
  let m = INLINE.exec(s);
  while (m !== null) {
    if (m.index > at) parent.appendChild(doc.createTextNode(s.slice(at, m.index)));
    if (m[1] !== undefined) {
      const code = doc.createElement('code');
      code.textContent = m[1];
      parent.appendChild(code);
    } else if (m[2] !== undefined) {
      parent.appendChild(doc.createTextNode(m[2]));
    } else if (m[3] !== undefined) {
      const href = safeHref(m[4]);
      if (href) {
        const a = doc.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('rel', 'noreferrer noopener');
        a.setAttribute('target', '_blank');
        a.textContent = m[3];
        parent.appendChild(a);
      } else {
        parent.appendChild(doc.createTextNode(m[0]));
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
  if (at < s.length) parent.appendChild(doc.createTextNode(s.slice(at)));
  return parent;
}

function renderFence(lines, i, parent, doc) {
  const open = FENCE.exec(lines[i]);
  const marker = open[1][0];
  const body = [];
  let j = i + 1;
  while (j < lines.length) {
    const close = FENCE.exec(lines[j]);
    if (close && close[1][0] === marker && close[2] === '') break;
    body.push(lines[j]);
    j++;
  }
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  if (LANG.test(open[2])) code.setAttribute('data-lang', open[2]);
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
    if (texts.length && lines[j].trim() && !startsBlock(lines[j])) {
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
  while (j < lines.length && lines[j].trim() && !startsBlock(lines[j])
    && !(lines[j].includes('|') && isTableRule(lines[j + 1]))) {
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
    if (FENCE.test(line)) { i = renderFence(lines, i, parent, doc); continue; }
    const h = HEADING.exec(line);
    if (h) {
      const heading = doc.createElement(`h${h[1].length}`);
      appendInline(heading, h[2].replace(/\s+#+\s*$/, ''), doc);
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

function renderMarkdown(text) {
  const doc = document;
  const frag = doc.createDocumentFragment();
  const lines = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n');
  return renderBlocks(lines, frag, doc);
}

module.exports = { renderMarkdown };
