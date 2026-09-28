// format.js — pure string formatters for the renderer. Small, dependency-free
// value->string helpers used across the sidebar, status bar, popovers, and
// report/cost panels.
//
// esc() uses the global `document` (HTML-escape via a detached node); it
// works at renderer runtime but must not be CALLED under node --test (no
// document). Requiring the module is fine; the tests exercise the others.
// textContent→innerHTML escapes & < > but NOT quotes, so esc() ALSO escapes
// " and ' explicitly — quote-escaping is safe in both text and attribute
// contexts, closing attribute-injection for any interpolation into value="…".

const homeDir = require('os').homedir();

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Last path segment for the sidebar's second line ("~" for home itself);
// the full path stays in the tooltip.
function baseName(p) {
  if (!p) return '';
  if (p === homeDir || p === '~') return '~';
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// Warmth pill text: whole minutes remaining ("59m"), never "0m" while warm.
function fmtMinutes(remaining_s) {
  return `${Math.max(1, Math.ceil(remaining_s / 60))}m`;
}

// Compact token count: 201234 -> "201k", 1000000 -> "1M".
// The type guard is a SECURITY boundary, not tidiness: callers interpolate the
// result straight into innerHTML without esc(), and peer-supplied JSON reaches
// here unvalidated.
// Anything not a finite number formats as '0' — never as itself.
function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  if (Math.round(n / 1000) >= 1000) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function fmtCountdown(remaining_s) {
  const s = Math.max(0, Math.round(remaining_s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(s / 3600);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtUsd(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '$0';
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(n >= 0.1 ? 3 : 4);
}
function fmtDur(s) {
  if (!s) return '';
  if (Math.round(s / 60) >= 60) return (s / 3600).toFixed(1) + 'h';
  if (Math.round(s) >= 60) return Math.round(s / 60) + 'm';
  return Math.round(s) + 's';
}
function shortTs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1] || m[2];
  return `${mon} ${+m[3]} ${m[4]}:${m[5]}`;
}

// Same unescaped-innerHTML boundary as fmtTokens — see the note there.
function fmtBustTokens(n) {
  if (!n) return '0';
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  if (n >= 1000) { const k = n / 1000; return `${k.toFixed(+k.toFixed(1) >= 10 ? 0 : 1)}k`; }
  return String(n);
}

function fmtBytes(n) {
  if (!(n > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (Math.round(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

module.exports = {
  esc, baseName, fmtTokens, fmtCountdown, fmtMinutes, fmtAgo,
  fmtUsd, fmtDur, shortTs, fmtBustTokens, fmtBytes,
};

