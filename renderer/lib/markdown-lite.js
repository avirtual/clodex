'use strict';

const FENCE_OPEN_RE = /^\s{0,3}```\s*([^\s`]*)\s*$/;
const FENCE_CLOSE_RE = /^\s{0,3}```\s*$/;
const HEADING_RE = /^(#{1,3})[ \t]+(\S.*?)[ \t]*$/;
const SEP_CELL_RE = /^:?-+:?$/;
const LINK_RE = /^\[([^\]\n]+)\]\(([^()\s]+)\)/;
const SAFE_HREF_RE = /^https?:\/\/\S+$/i;
const WORD_RE = /[\p{L}\p{N}_]/u;

function pipeAt(line) {
  const at = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') at.push(i);
  }
  return at;
}

function splitRow(line) {
  const s = line.trim();
  const pipes = pipeAt(s);
  if (!pipes.length) return null;
  const cuts = [-1, ...pipes, s.length];
  const cells = [];
  for (let k = 0; k + 1 < cuts.length; k++) cells.push(s.slice(cuts[k] + 1, cuts[k + 1]));
  if (pipes[0] === 0) cells.shift();
  if (pipes[pipes.length - 1] === s.length - 1) cells.pop();
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

function alignOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function separatorFor(line, width) {
  const cells = splitRow(line);
  if (!cells || cells.length !== width) return null;
  if (!cells.every((c) => SEP_CELL_RE.test(c))) return null;
  return cells.map(alignOf);
}

function fit(cells, width) {
  const out = cells.slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

function parseBlocks(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let buf = null;
  const flush = () => {
    if (buf) blocks.push({ kind: 'text', text: buf.join('\n') });
    buf = null;
  };
  const literal = (line) => { (buf || (buf = [])).push(line); };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      let j = i + 1;
      while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j])) j++;
      if (j < lines.length) {
        flush();
        blocks.push({ kind: 'fence', lang: open[1], text: lines.slice(i + 1, j).join('\n') });
        i = j + 1;
        continue;
      }
      literal(line);
      i++;
      continue;
    }
    const head = HEADING_RE.exec(line);
    if (head) {
      flush();
      blocks.push({ kind: 'heading', level: head[1].length, text: head[2] });
      i++;
      continue;
    }
    const header = splitRow(line);
    const align = header && i + 1 < lines.length ? separatorFor(lines[i + 1], header.length) : null;
    if (align) {
      flush();
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim()) {
        const cells = splitRow(lines[j]);
        if (!cells) break;
        rows.push(fit(cells, header.length));
        j++;
      }
      blocks.push({ kind: 'table', header, align, rows });
      i = j;
      continue;
    }
    literal(line);
    i++;
  }
  flush();
  return blocks;
}

const isWord = (ch) => ch != null && WORD_RE.test(ch);
const isSpace = (ch) => ch == null || /\s/.test(ch);

function closeItalic(text, mark, from) {
  for (let j = from; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] !== mark) continue;
    if (mark === '*' && (text[j + 1] === '*' || text[j - 1] === '*')) continue;
    if (isSpace(text[j - 1]) || isWord(text[j + 1])) continue;
    return j;
  }
  return -1;
}

function closeBold(text, from) {
  for (let j = from; j + 1 < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text[j] === '*' && text[j + 1] === '*' && !isSpace(text[j - 1])) return j;
  }
  return -1;
}

function parseInline(text) {
  const s = String(text);
  const out = [];
  let buf = '';
  const push = (tok) => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
    out.push(tok);
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      buf += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        push({ kind: 'code', text: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    } else if (ch === '*' && s[i + 1] === '*') {
      const j = isSpace(s[i + 2]) ? -1 : closeBold(s, i + 3);
      if (j > 0) {
        push({ kind: 'bold', text: s.slice(i + 2, j) });
        i = j + 2;
        continue;
      }
      buf += '**';
      i += 2;
      continue;
    } else if ((ch === '*' || ch === '_') && !isWord(s[i - 1]) && !isSpace(s[i + 1]) && s[i + 1] !== ch) {
      const j = closeItalic(s, ch, i + 2);
      if (j > 0) {
        push({ kind: 'italic', text: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    } else if (ch === '[') {
      const m = LINK_RE.exec(s.slice(i));
      if (m && SAFE_HREF_RE.test(m[2])) {
        push({ kind: 'link', text: m[1], href: m[2] });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf) out.push({ kind: 'text', text: buf });
  return out;
}

module.exports = { parseBlocks, parseInline };
