// output.js — human vs --json rendering. Every read verb has a stable JSON
// mode (kubectl's -o json lesson): `--json` prints the raw wire payload (or a
// documented reshape) so the CLI is simultaneously the human tool and the
// machine binding. Human output is compact, no color, no emoji.
//
// Pure string builders + a thin print seam (injectable for tests).
'use strict';

function jsonLine(obj) { return JSON.stringify(obj); }

// Strip ANSI escape sequences from raw PTY output so piped `exec` text is clean.
// Reimplemented locally (no app require) and WIDER than intent-scanner's line
// regex, because real terminal bytes carry more than SGR: OSC (title/hyperlink,
// terminated by BEL / ESC-backslash / 0x9C) and CSI with private/intermediate
// params (cursor moves, `?`-mode sets). This is the canonical `ansi-regex`
// pattern (Sindre Sorhus, MIT) inlined to keep the CLI dependency-free — one
// shared-prefix alternation, so OSC vs CSI resolves correctly. Written with
// unicode escapes so the source stays plain ASCII.
const ANSI_RE = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*'
  + '(?:'
  +   '(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?'
  +   '(?:\\u0007|\\u001B\\u005C|\\u009C)'
  + '|'
  +   '(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]'
  + ')',
  'g');
function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

// sessions → a compact table. Columns: NAME TYPE ACTIVITY CWD.
function renderSessions(sessions) {
  const rows = (sessions || []).map((s) => [
    s.name || '',
    s.type || '',
    s.activity || '',
    s.cwd || '',
  ]);
  return table(['NAME', 'TYPE', 'ACTIVITY', 'CWD'], rows);
}

// transcript messages → role-prefixed lines, blank line between turns.
function renderTranscript(messages) {
  return (messages || [])
    .map((m) => `[${m.role}] ${m.text}`)
    .join('\n\n');
}

// hello identity → a few labeled lines.
function renderInfo(hello) {
  const lines = [
    `app       ${hello.app || ''}`,
    `host      ${hello.host || ''}`,
    `version   ${hello.version || ''}`,
    `platform  ${hello.platform || ''}`,
    `caps      ${(hello.caps || []).join(' ')}`,
  ];
  return lines.join('\n');
}

// Left-aligned monospace-ish table with two-space gutters.
function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] || '').length)));
  const fmt = (cols) => cols.map((c, i) => String(c || '').padEnd(i === cols.length - 1 ? 0 : widths[i])).join('  ').replace(/\s+$/, '');
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

// A print seam so tests can capture without touching real stdout.
function makePrinter(write = (s) => process.stdout.write(s)) {
  return {
    line(s) { write(s + '\n'); },
    json(obj) { write(jsonLine(obj) + '\n'); },
  };
}

module.exports = { jsonLine, stripAnsi, ANSI_RE, renderSessions, renderTranscript, renderInfo, table, makePrinter };
