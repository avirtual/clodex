// lib/path-scan.js — find path-like tokens (with an optional `:line`) in a line
// of plain text, as offsets. Pure leaf: no DOM, no fs, no resolution. It answers
// "what LOOKS like a path here", and nothing about whether that path exists —
// resolution is main-side (file-resolve.js), because only main can stat.
//
// Two callers with the same problem: the terminal's link provider (xterm hands
// us one buffer line) and the file peek's File tab (one source line). Sharing
// the pattern is the point — two copies would drift into two different ideas of
// what a path looks like, and the failure would be silent in both.
//
// WHY AN EXTENSION ALLOWLIST. A bare filename has to match (`renderer.js:71`
// with no directory at all), so a separator cannot be required. That leaves the
// extension carrying the entire burden of not claiming ordinary prose, and
// `\w+` there matches "Node.js", "e.g", "etc.md" in a sentence. An allowlist is
// the only version of this that stays quiet in running text; widening it is a
// deliberate act, not a convenience.
const EXTENSIONS = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'md', 'css', 'html',
  'sh', 'bash', 'zsh', 'py', 'rb', 'rs', 'go', 'java', 'c', 'h', 'cpp',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sql', 'txt', 'log',
];

// The `~` alternative must carry its slash. Written as a bare `~`, the group
// fails on `~/x/y.js` (the char class after it cannot match `/`) and the scan
// silently restarts at the slash — yielding `/x/y.js`, a WRONG absolute path
// rather than a miss.
const PATH_RE = new RegExp(
  String.raw`(?:~\/|\.{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:${EXTENSIONS.join('|')})\b(?::\d+)?`,
  'g',
);

// A URL's own path segments look exactly like a relative path, so a bare scan
// claims `example.com/app.js` out of `https://example.com/app.js` and opens a
// peek on a file that was never local. Matched separately and excluded.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

// Returns [{ start, end, text, path, line }] — half-open offsets into `text`,
// `path` without the `:line` suffix, `line` a number or null. Ordered by start.
function scanPaths(text) {
  if (typeof text !== 'string' || !text) return [];

  const urls = [];
  URL_RE.lastIndex = 0;
  for (let u = URL_RE.exec(text); u; u = URL_RE.exec(text)) {
    urls.push([u.index, u.index + u[0].length]);
  }
  const inUrl = (i) => urls.some(([a, b]) => i >= a && i < b);

  const out = [];
  PATH_RE.lastIndex = 0;
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
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

module.exports = { scanPaths, PATH_RE, EXTENSIONS };
