'use strict';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!|<>&~"\'$%^:;,/?@='.split(''));
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})[ \t]*([^`~\s]*)[ \t]*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const MARKER = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])([ \t]+)(.*)$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const ANCHOR_TAG = /^<a[ \t]+name=["']([^"']+)["'][ \t]*>[ \t]*(?:<\/a>)?$/i;
const ANY_TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)(?:[ \t][^>]*?)?\/?>/g;
const STRUCTURAL_TAGS = new Set(['details', 'summary']);
const ENTITY = /&(amp|lt|gt|quot|apos);|&#(\d{1,7});/g;
const WORD = /[A-Za-z0-9]/;
const SNIPPET_MAX = 120;
const SNIPPET_LEAD = 40;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 20;
const TITLE_WEIGHT = 1000000;
const HEADING_WEIGHT = 1000;
const BODY_CAP = 999;

function normalize(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
}

function toLines(src) {
  return src.split('\n').map((s, i) => ({ n: i + 1, s }));
}

function leadIndent(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') n += 1;
    else if (s[i] === '\t') n += 4;
    else break;
  }
  return n;
}

function dedent(line, k) {
  let i = 0;
  let taken = 0;
  while (i < line.s.length && taken < k && (line.s[i] === ' ' || line.s[i] === '\t')) {
    taken += line.s[i] === '\t' ? 4 : 1;
    i += 1;
  }
  return { n: line.n, s: line.s.slice(i) };
}

function decodeEntities(s) {
  return s.replace(ENTITY, (whole, name, dec) => {
    if (name) return NAMED_ENTITIES[name];
    const code = Number(dec);
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(code);
    } catch (err) {
      return whole;
    }
  });
}

function readCode(src, at) {
  let n = 0;
  while (src[at + n] === '`') n += 1;
  let i = at + n;
  while (i < src.length) {
    if (src[i] !== '`') { i += 1; continue; }
    let run = 0;
    while (src[i + run] === '`') run += 1;
    if (run === n) {
      let body = src.slice(at + n, i).replace(/\n/g, ' ');
      if (body.length > 2 && body[0] === ' ' && body[body.length - 1] === ' ' && body.trim() !== '') {
        body = body.slice(1, -1);
      }
      return { text: body, end: i + n };
    }
    i += run;
  }
  return null;
}

function readLink(src, at) {
  let i = at + 1;
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { const sp = readCode(src, i); if (sp) { i = sp.end; continue; } }
    if (c === '[') depth += 1;
    if (c === ']') { depth -= 1; if (depth === 0) break; }
    i += 1;
  }
  if (depth !== 0 || src[i + 1] !== '(') return null;
  const label = src.slice(at + 1, i);
  let j = i + 2;
  let paren = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '(') paren += 1;
    if (c === ')') { paren -= 1; if (paren === 0) break; }
    j += 1;
  }
  if (paren !== 0) return null;
  return { label, href: src.slice(i + 2, j).trim(), end: j + 1 };
}

function readEmphasis(src, at) {
  const ch = src[at];
  const n = src[at + 1] === ch ? 2 : 1;
  const after = src[at + n];
  if (after === undefined || /\s/.test(after) || after === ch) return null;
  if (ch === '_' && at > 0 && WORD.test(src[at - 1])) return null;
  let i = at + n;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { const sp = readCode(src, i); if (sp) { i = sp.end; continue; } }
    if (c !== ch) { i += 1; continue; }
    let run = 0;
    while (src[i + run] === ch) run += 1;
    const prev = src[i - 1];
    const next = src[i + n];
    const closes = run >= n && prev !== undefined && !/\s/.test(prev)
      && !(ch === '_' && next !== undefined && WORD.test(next));
    if (closes) {
      return { strong: n === 2, inner: src.slice(at + n, i), end: i + n };
    }
    i += run;
  }
  return null;
}

function parseInline(src) {
  const text = String(src == null ? '' : src);
  const nodes = [];
  let buf = [];

  function flush() {
    if (!buf.length) return;
    let out = '';
    let run = '';
    for (const part of buf) {
      if (part.raw) { out += decodeEntities(run) + part.s; run = ''; continue; }
      run += part.s;
    }
    out += decodeEntities(run);
    buf = [];
    if (out !== '') nodes.push({ type: 'text', text: out });
  }

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && ESCAPABLE.has(text[i + 1])) {
      buf.push({ raw: true, s: text[i + 1] });
      i += 2;
      continue;
    }
    if (c === '`') {
      const span = readCode(text, i);
      if (span) { flush(); nodes.push({ type: 'code', text: span.text }); i = span.end; continue; }
    }
    if (c === '[') {
      const link = readLink(text, i);
      if (link) {
        flush();
        nodes.push({ type: 'link', href: link.href, children: parseInline(link.label) });
        i = link.end;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const em = readEmphasis(text, i);
      if (em) {
        flush();
        nodes.push({ type: em.strong ? 'strong' : 'em', children: parseInline(em.inner) });
        i = em.end;
        continue;
      }
    }
    buf.push({ raw: false, s: c });
    i += 1;
  }
  flush();
  return nodes;
}

function plainInline(nodes) {
  let out = '';
  for (const node of nodes || []) {
    if (node.type === 'text' || node.type === 'code') out += node.text;
    else if (node.children) out += plainInline(node.children);
  }
  return out;
}

function htmlLine(s) {
  const t = s.trim();
  if (t[0] !== '<') return null;
  const anchor = ANCHOR_TAG.exec(t);
  if (anchor) return { anchor: anchor[1] };
  const names = [];
  ANY_TAG.lastIndex = 0;
  const rest = t.replace(ANY_TAG, (whole, name) => { names.push(name.toLowerCase()); return ''; });
  if (!names.length) return null;
  if (names.every((name) => STRUCTURAL_TAGS.has(name))) return { drop: true };
  return rest.trim() === '' ? { drop: true } : null;
}

function splitRow(line) {
  let t = line.trim();
  if (t[0] === '|') t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const out = [];
  let cur = '';
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '\\' && i + 1 < t.length) { cur += c + t[i + 1]; i += 2; continue; }
    if (c === '`') { const sp = readCode(t, i); if (sp) { cur += t.slice(i, sp.end); i = sp.end; continue; } }
    if (c === '|') { out.push(cur.trim()); cur = ''; i += 1; continue; }
    cur += c;
    i += 1;
  }
  out.push(cur.trim());
  return out;
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  return lines[i].s.includes('|') && lines[i + 1].s.includes('|') && TABLE_RULE.test(lines[i + 1].s);
}

function parseTable(lines, i) {
  const header = splitRow(lines[i].s);
  const rule = splitRow(lines[i + 1].s);
  if (!header.length || rule.length !== header.length) return null;
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].s.trim() && lines[j].s.includes('|')) {
    rows.push(splitRow(lines[j].s).map((cell) => parseInline(cell)));
    j += 1;
  }
  return {
    block: { type: 'table', header: header.map((cell) => parseInline(cell)), rows },
    next: j,
  };
}

function breaksParagraph(lines, j) {
  const t = lines[j].s;
  return ATX.test(t) || HR.test(t) || FENCE_OPEN.test(t) || QUOTE.test(t)
    || MARKER.test(t) || !!htmlLine(t) || isTableStart(lines, j);
}

function parseList(lines, start) {
  const first = MARKER.exec(lines[start].s);
  const indent = leadIndent(lines[start].s);
  const ordered = !!first[3];
  const listStart = ordered ? parseInt(first[3], 10) : 1;
  const items = [];
  let j = start;
  while (j < lines.length) {
    const m = MARKER.exec(lines[j].s);
    if (!m) break;
    const ind = leadIndent(lines[j].s);
    if (ind < indent || ind > indent + 1 || !!m[3] !== ordered) break;
    const markerWidth = m[2] ? m[2].length : m[3].length + 1;
    const contentIndent = ind + markerWidth + m[4].length;
    const body = [{ n: lines[j].n, s: m[5] }];
    let k = j + 1;
    while (k < lines.length) {
      const t = lines[k].s;
      if (t.trim()) {
        if (leadIndent(t) >= indent + 2) { body.push(dedent(lines[k], contentIndent)); k += 1; continue; }
        break;
      }
      let look = k;
      while (look < lines.length && !lines[look].s.trim()) look += 1;
      if (look < lines.length && leadIndent(lines[look].s) >= indent + 2) {
        while (k < look) { body.push({ n: lines[k].n, s: '' }); k += 1; }
        continue;
      }
      break;
    }
    items.push({ children: parseBlocks(body) });
    let look = k;
    while (look < lines.length && !lines[look].s.trim()) look += 1;
    if (look > k) {
      const nm = look < lines.length ? MARKER.exec(lines[look].s) : null;
      const nind = look < lines.length ? leadIndent(lines[look].s) : -1;
      if (nm && nind >= indent && nind <= indent + 1 && !!nm[3] === ordered) { j = look; continue; }
      j = k;
      break;
    }
    j = k;
  }
  return { block: { type: 'list', ordered, start: listStart, items }, next: j };
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const s = line.s;
    if (!s.trim()) { i += 1; continue; }

    const fence = FENCE_OPEN.exec(s);
    if (fence) {
      const pad = fence[1].length;
      const mark = fence[2];
      const closer = new RegExp(`^[ \\t]*\\${mark[0]}{${mark.length},}[ \\t]*$`);
      const body = [];
      let j = i + 1;
      while (j < lines.length && !closer.test(lines[j].s)) { body.push(dedent(lines[j], pad).s); j += 1; }
      blocks.push({ type: 'code', lang: fence[3] || '', text: body.join('\n') });
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    const heading = ATX.exec(s);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: parseInline(heading[2]),
        slug: '',
        line: line.n,
      });
      i += 1;
      continue;
    }

    if (HR.test(s)) { blocks.push({ type: 'hr' }); i += 1; continue; }

    const html = htmlLine(s);
    if (html) {
      if (html.anchor) blocks.push({ type: 'anchor', id: html.anchor });
      i += 1;
      continue;
    }

    if (QUOTE.test(s)) {
      const body = [];
      let j = i;
      while (j < lines.length && QUOTE.test(lines[j].s)) {
        body.push({ n: lines[j].n, s: QUOTE.exec(lines[j].s)[1] });
        j += 1;
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(body) });
      i = j;
      continue;
    }

    if (MARKER.test(s)) {
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i);
      if (table) { blocks.push(table.block); i = table.next; continue; }
    }

    const para = [];
    let j = i;
    while (j < lines.length && lines[j].s.trim()) {
      if (j > i && breaksParagraph(lines, j)) break;
      para.push(lines[j].s.trim());
      j += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
    i = j;
  }
  return blocks;
}

function slugify(text) {
  return String(text == null ? '' : text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}

function uniqueSlug(base, seen) {
  const used = seen.get(base) || 0;
  seen.set(base, used + 1);
  return used === 0 ? base : `${base}-${used}`;
}

function collectHeadings(blocks, out, seen) {
  for (const block of blocks) {
    if (block.type === 'heading') {
      const text = plainInline(block.text);
      block.slug = uniqueSlug(slugify(text), seen);
      out.push({ level: block.level, text, slug: block.slug, line: block.line });
    } else if (block.type === 'list') {
      for (const item of block.items) collectHeadings(item.children, out, seen);
    } else if (block.type === 'blockquote') {
      collectHeadings(block.children, out, seen);
    }
  }
}

function parseDoc(text) {
  const src = normalize(text);
  const blocks = parseBlocks(toLines(src));
  const headings = [];
  collectHeadings(blocks, headings, new Map());
  const h1 = headings.find((h) => h.level === 1);
  return { blocks, headings, title: h1 ? h1.text : (headings.length ? headings[0].text : '') };
}

function plainText(blocks) {
  const parts = [];
  emitPlain(blocks || [], parts);
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function emitPlain(blocks, parts) {
  for (const block of blocks) {
    if (block.type === 'heading') parts.push(plainInline(block.text), '');
    else if (block.type === 'paragraph') parts.push(plainInline(block.children), '');
    else if (block.type === 'code') parts.push(block.text, '');
    else if (block.type === 'blockquote') { emitPlain(block.children, parts); parts.push(''); } else if (block.type === 'list') {
      for (const item of block.items) emitPlain(item.children, parts);
    } else if (block.type === 'table') {
      parts.push(block.header.map((cell) => plainInline(cell)).join(' '));
      for (const row of block.rows) parts.push(row.map((cell) => plainInline(cell)).join(' '));
      parts.push('');
    }
  }
}

function sectionBounds(headings, at, lineCount) {
  for (let k = at + 1; k < headings.length; k++) {
    if (headings[k].level <= headings[at].level) return headings[k].line - 1;
  }
  return lineCount;
}

function sectionSlice(text, slug) {
  const src = normalize(text);
  const lines = src.split('\n');
  const { headings } = parseDoc(src);
  const at = headings.findIndex((h) => h.slug === slug);
  if (at < 0) return null;
  const end = sectionBounds(headings, at, lines.length);
  return lines.slice(headings[at].line - 1, end).join('\n').replace(/\s+$/, '');
}

function buildSearchIndex(pages) {
  const out = [];
  for (const page of pages || []) {
    const src = normalize(page && page.text);
    const lines = src.split('\n');
    const parsed = parseDoc(src);
    for (let i = 0; i < parsed.headings.length; i++) {
      const h = parsed.headings[i];
      const end = sectionBounds(parsed.headings, i, lines.length);
      const slice = lines.slice(h.line - 1, end).join('\n');
      out.push({
        name: page && page.name,
        title: parsed.title,
        slug: h.slug,
        heading: h.text,
        text: plainText(parseDoc(slice).blocks),
      });
    }
  }
  return out;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let at = hay.indexOf(needle);
  while (at >= 0) { n += 1; at = hay.indexOf(needle, at + needle.length); }
  return n;
}

function makeSnippet(text, terms) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const k = low.indexOf(term);
    if (k >= 0 && (at < 0 || k < at)) at = k;
  }
  if (at < 0) return s.slice(0, SNIPPET_MAX);
  const from = Math.max(0, at - SNIPPET_LEAD);
  let out = s.slice(from, from + SNIPPET_MAX);
  if (from > 0) out = `\u2026${out.slice(1)}`;
  if (from + SNIPPET_MAX < s.length) out = `${out.slice(0, -1)}\u2026`;
  return out;
}

function clampLimit(value) {
  if (value === undefined || value === null) return LIMIT_DEFAULT;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return LIMIT_DEFAULT;
  return Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, n));
}

function compareHits(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return 0;
}

function search(index, q, options) {
  const limit = clampLimit(options && options.limit);
  const terms = String(q == null ? '' : q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits = [];
  for (const entry of index || []) {
    const title = String(entry.title == null ? '' : entry.title).toLowerCase();
    const heading = String(entry.heading == null ? '' : entry.heading).toLowerCase();
    const body = String(entry.text == null ? '' : entry.text).toLowerCase();
    let matched = true;
    let inTitle = 0;
    let inHeading = 0;
    let inBody = 0;
    for (const term of terms) {
      const hitsTitle = title.includes(term);
      const hitsHeading = heading.includes(term);
      const bodyCount = countOccurrences(body, term);
      if (!hitsTitle && !hitsHeading && !bodyCount) { matched = false; break; }
      if (hitsTitle) inTitle += 1;
      if (hitsHeading) inHeading += 1;
      inBody += bodyCount;
    }
    if (!matched) continue;
    hits.push({
      name: entry.name,
      title: entry.title,
      heading: entry.heading,
      slug: entry.slug,
      snippet: makeSnippet(entry.text, terms),
      score: inTitle * TITLE_WEIGHT + inHeading * HEADING_WEIGHT + Math.min(inBody, BODY_CAP),
    });
  }
  hits.sort(compareHits);
  return hits.slice(0, limit);
}

module.exports = {
  parseDoc,
  parseInline,
  plainInline,
  plainText,
  slugify,
  sectionSlice,
  buildSearchIndex,
  search,
};
