// lib/path-scan.js — find path-like tokens (with an optional `:line`) in a line
// of plain text, as offsets. Pure leaf: no DOM, no fs, no resolution. It answers
// "what LOOKS like a path here", and nothing about whether that path exists —
// resolution is main-side (file-resolve.js), because only main can stat.
//
// Three callers with the same problem: the terminal's link provider (xterm
// hands us one buffer line), the file peek's File tab (one source line), and
// the inbox drawer (one note body). Sharing the pattern is the point — separate
// copies would drift into different ideas of what a path looks like, and the
// failure would be silent in all of them.
//
// WHY AN EXTENSION ALLOWLIST. A bare filename has to match (`renderer.js:71`
// with no directory at all), so a separator cannot be required. That leaves the
// extension carrying the entire burden of not claiming ordinary prose, and
// `\w+` there matches "Node.js", "e.g", "etc.md" in a sentence. An allowlist is
// the only version of this that stays quiet in running text; widening it is a
// deliberate act, not a convenience.
const { isExternallyOpenable } = require('../../external-link');

const EXTENSIONS = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'md', 'css', 'html',
  'sh', 'bash', 'zsh', 'py', 'rb', 'rs', 'go', 'java', 'c', 'h', 'cpp',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sql', 'txt', 'log',
  'tf', 'tfvars', 'tfstate', 'hcl',
];

// The `~` alternative must carry its slash. Written as a bare `~`, the group
// fails on `~/x/y.js` (the char class after it cannot match `/`) and the scan
// silently restarts at the slash — yielding `/x/y.js`, a WRONG absolute path
// rather than a miss.
const PATH_RE = new RegExp(
  String.raw`(?:~\/|\.{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:${EXTENSIONS.join('|')})(?![\w@+-]|\.[\w@+-])(?::\d+)?`,
  'y',
);
const PATH_CHAR = /[\w.@+-]/;

// A URL's own path segments look exactly like a relative path, so a bare scan
// claims `example.com/app.js` out of `https://example.com/app.js` and opens a
// peek on a file that was never local. Matched separately and excluded.
const URL_RE = /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/\S+)/gi;

function trimUrl(url) {
  const opens = url.split('(').length;
  let closes = url.split(')').length;
  let end = url.length;
  for (;;) {
    const c = url[end - 1];
    if (c !== undefined && `.,;:!?'"`.includes(c)) end -= 1;
    else if (c === ')' && closes > opens) { end -= 1; closes -= 1; }
    else break;
  }
  return url.slice(0, end);
}

function urlMatches(text) {
  const out = [];
  URL_RE.lastIndex = 0;
  for (let u = URL_RE.exec(text); u; u = URL_RE.exec(text)) {
    const url = trimUrl(u[2]);
    const start = u.index + u[1].length;
    out.push({ start, end: start + url.length, text: url });
  }
  return out;
}

function mayStartPath(text, i) {
  const c = text[i];
  if (c === '~' || i === 0) return true;
  const prev = text[i - 1];
  if (prev === '/') return c === '/';
  return !PATH_CHAR.test(prev);
}

// Returns [{ start, end, text, path, line }] — half-open offsets into `text`,
// `path` without the `:line` suffix, `line` a number or null. Ordered by start.
function scanPaths(text) {
  if (typeof text !== 'string' || !text) return [];

  const urls = urlMatches(text);
  const inUrl = (i) => urls.some((u) => i >= u.start && i < u.end);

  const out = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (i !== from && !mayStartPath(text, i)) continue;
    PATH_RE.lastIndex = i;
    const m = PATH_RE.exec(text);
    if (!m) continue;
    from = i + m[0].length;
    i = from - 1;
    if (inUrl(m.index)) continue;
    const hit = m[0];
    const colon = hit.lastIndexOf(':');
    const hasLine = colon > 0 && /^\d+$/.test(hit.slice(colon + 1));
    out.push({
      start: m.index,
      end: m.index + hit.length,
      text: hit,
      path: hasLine ? hit.slice(0, colon) : hit,
      line: hasLine ? Number(hit.slice(colon + 1)) : null,
    });
  }
  return out;
}

// Returns the WHOLE text as an ordered, gapless, non-overlapping span list
// covering [0, text.length): { kind: 'text' | 'url' | 'path', text, ... }, where
// a `path` span also carries `path`/`line` as scanPaths yields them. The third
// caller (the inbox drawer) needs the runs BETWEEN the hits too, because it
// builds the note body out of DOM nodes rather than markup.
//
// A URL span is emitted only when isExternallyOpenable accepts it. A denied
// scheme (file:, data:) must degrade to 'text', never to a link that does
// nothing when clicked — and because scanPaths excludes every URL range
// regardless of scheme, the path segments inside `file:///etc/app.js` stay
// plain text rather than becoming a local file peek.
function scanLinks(text) {
  if (typeof text !== 'string' || !text) return [];

  const marks = [];
  for (const u of urlMatches(text)) {
    if (!isExternallyOpenable(u.text)) continue;
    marks.push({ start: u.start, end: u.end, span: { kind: 'url', text: u.text } });
  }
  for (const h of scanPaths(text)) {
    marks.push({
      start: h.start,
      end: h.end,
      span: { kind: 'path', text: h.text, path: h.path, line: h.line },
    });
  }
  marks.sort((a, b) => a.start - b.start);

  const out = [];
  let at = 0;
  for (const m of marks) {
    // Source-agnostic overlap drop: a mark starting inside one already emitted
    // would push text already consumed, corrupting the body instead of failing.
    if (m.start < at) continue;
    if (m.start > at) out.push({ kind: 'text', text: text.slice(at, m.start) });
    out.push(m.span);
    at = m.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

module.exports = { scanPaths, scanLinks, PATH_RE, EXTENSIONS };
