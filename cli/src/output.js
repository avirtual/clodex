// output.js — Human output is compact, no color, no emoji.
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

function renderSessionsWide(sessions) {
  const rows = (sessions || []).map((s) => [
    s.name || '',
    s.type || '',
    s.activity || '',
    s.cwd || '',
    s.workspace || '',
  ]);
  return table(['NAME', 'TYPE', 'ACTIVITY', 'CWD', 'WORKSPACE'], rows);
}

function renderNames(type, items) {
  return (items || []).map((it) => `${type}/${it.name || it.id || ''}`).join('\n');
}

function renderWorkspaces(workspaces) {
  const rows = (workspaces || []).map((w) => [w.id || '', w.name || '']);
  return table(['ID', 'NAME'], rows);
}

function renderPeers(peers) {
  const rows = (peers || []).map((p) => [
    p.id || '',
    p.label || '',
    p.online ? 'true' : 'false',
    p.host || '',
    p.version || '',
  ]);
  return table(['ID', 'LABEL', 'ONLINE', 'HOST', 'VERSION'], rows);
}

function renderPeersWide(peers) {
  const rows = (peers || []).map((p) => [
    p.id || '',
    p.label || '',
    p.online ? 'true' : 'false',
    p.host || '',
    p.version || '',
    p.url || '',
    p.platform || '',
  ]);
  return table(['ID', 'LABEL', 'ONLINE', 'HOST', 'VERSION', 'URL', 'PLATFORM'], rows);
}

function renderTeams(teams) {
  return table(['NAME'], (teams || []).map((t) => [t.name || '']));
}

function renderTickets(tickets) {
  const rows = (tickets || []).map((t) => [t.id || '', t.team || '', t.state || '', t.title || '']);
  return table(['ID', 'TEAM', 'STATE', 'TITLE'], rows);
}

function renderTicketsWide(tickets) {
  const rows = (tickets || []).map((t) => [
    t.id || '', t.team || '', t.state || '', t.title || '', t.assignee || '',
    (t.worktree && t.worktree.branch) || '',
  ]);
  return table(['ID', 'TEAM', 'STATE', 'TITLE', 'ASSIGNEE', 'BRANCH'], rows);
}

function renderSandboxes(sandboxes) {
  return table(['ID', 'LABEL'], (sandboxes || []).map((s) => [s.id || '', s.label || '']));
}

function renderAgents(agents) {
  const rows = (agents || []).map((a) => [a.name || '', a.model || '', a.description || '']);
  return table(['NAME', 'MODEL', 'DESCRIPTION'], rows);
}

function renderAgentsWide(agents) {
  const rows = (agents || []).map((a) => [a.name || '', a.model || '', a.description || '', a.tools || '']);
  return table(['NAME', 'MODEL', 'DESCRIPTION', 'TOOLS'], rows);
}

function renderResources(resources) {
  const rows = (resources || []).map((r) => [
    r.name || '',
    r.singular || '',
    r.scope || '',
    (r.verbs || []).join(','),
  ]);
  return table(['NAME', 'SINGULAR', 'SCOPE', 'VERBS'], rows);
}

function renderDescribe(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '';
  const w = Math.max(...entries.map(([k]) => k.length));
  return entries
    .map(([k, v]) => `${(k + ':').padEnd(w + 1)} ${describeValue(v)}`)
    .join('\n');
}

function describePeer(peer) {
  const { sessions, ...rest } = peer || {};
  const lines = [renderDescribe(rest), 'sessions:'];
  for (const s of sessions || []) lines.push(`  ${(s && (s.name || s.id)) || ''}`);
  return lines.join('\n');
}

function describeTeam(team) {
  const { roles, activity, ...rest } = team || {};
  const lines = [renderDescribe(rest), 'roles:'];
  for (const [name, def] of Object.entries(roles || {})) lines.push(`  ${name}  ${describeValue(def)}`);
  lines.push('activity:');
  for (const [key, value] of Object.entries(activity || {})) {
    if (key !== 'roles') { lines.push(`  ${key}  ${describeValue(value)}`); continue; }
    lines.push('  roles:');
    for (const [name, def] of Object.entries(value || {})) lines.push(`    ${name}  ${describeValue(def)}`);
  }
  return lines.join('\n');
}

function describeSandbox(sandbox) {
  const { ports, ...rest } = sandbox || {};
  const lines = [renderDescribe(rest), 'ports:'];
  for (const [name, port] of Object.entries(ports || {})) lines.push(`  ${name}  ${describeValue(port)}`);
  return lines.join('\n');
}

function describeAgent(agent) {
  const { content, ...rest } = agent || {};
  return `${renderDescribe(rest)}\n\n${content == null ? '' : String(content)}`;
}

function describeValue(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
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

module.exports = {
  jsonLine, stripAnsi, ANSI_RE, renderSessions, renderSessionsWide, renderNames, renderWorkspaces,
  renderPeers, renderPeersWide, renderTeams, renderTickets, renderTicketsWide, renderSandboxes,
  renderAgents, renderAgentsWide, renderResources, renderDescribe,
  describePeer, describeTeam, describeSandbox, describeAgent,
  renderTranscript, renderInfo, table, makePrinter,
};
