'use strict';

const EXEMPT_RE = /^\s*\/\/\s*(eslint|@ts|prettier)/;

const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'instanceof',
  'new', 'delete', 'void', 'throw', 'yield', 'await',
]);

const REGEX_PRECEDING_PUNCT = /^[(,=:[!&|?{};+\-*%<>~^]$/;

function lineStartBefore(src, index) {
  let start = index;
  while (start > 0 && src[start - 1] !== '\n') start--;
  return start;
}

function countCommentLines(src) {
  const commentLines = new Set();
  const frames = [{ template: false, braces: 0 }];
  const n = src.length;
  let i = 0;
  let line = 1;
  let last = '';

  const regexAllowed = () => last === ''
    || REGEX_PRECEDING_PUNCT.test(last)
    || REGEX_PRECEDING_WORDS.has(last);

  while (i < n) {
    const frame = frames[frames.length - 1];
    const c = src[i];

    if (frame.template) {
      if (c === '\\') {
        if (src[i + 1] === '\n') line++;
        i += 2;
      } else if (c === '\n') {
        line++;
        i++;
      } else if (c === '`') {
        frames.pop();
        last = 'x';
        i++;
      } else if (c === '$' && src[i + 1] === '{') {
        frames.push({ template: false, braces: 0 });
        last = '';
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    const d = src[i + 1];

    if (c === '\n') { line++; i++; continue; }

    if (c === '/' && d === '/') {
      const from = i;
      while (i < n && src[i] !== '\n') i++;
      if (!EXEMPT_RE.test(src.slice(lineStartBefore(src, from), i))) commentLines.add(line);
      continue;
    }

    if (c === '/' && d === '*') {
      commentLines.add(line);
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        commentLines.add(line);
        i++;
      }
      i += 2;
      continue;
    }

    if (c === '"' || c === "'") {
      i++;
      while (i < n) {
        const s = src[i];
        if (s === '\\') {
          if (src[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (s === c) { i++; break; }
        if (s === '\n') { line++; i++; break; }
        i++;
      }
      last = 'x';
      continue;
    }

    if (c === '`') {
      frames.push({ template: true, braces: 0 });
      i++;
      continue;
    }

    if (c === '{') { frame.braces++; last = '{'; i++; continue; }

    if (c === '}') {
      if (frame.braces === 0 && frames.length > 1) {
        frames.pop();
        last = 'x';
      } else {
        frame.braces--;
        last = '}';
      }
      i++;
      continue;
    }

    if (c === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') break;
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      last = 'x';
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      last = src.slice(i, j);
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(src[i])) i++;
      last = 'x';
      continue;
    }

    if (!/\s/.test(c)) last = c;
    i++;
  }

  return commentLines.size;
}

module.exports = { countCommentLines };
