'use strict';

const AGENT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const ORIGIN_TAIL_RE = /^[^@\s]+$/;
const DEFAULT_LIMIT = 30;
const NOT_SHOWN = 'not shown: seats that are busy or idle (no claim is made about them), tickets owned by a lead, exec runs';

function noteKind(from) {
  const s = typeof from === 'string' ? from : '';
  const at = s.indexOf('@');
  if (at === -1) return AGENT_NAME_RE.test(s) ? 'shout' : 'other';
  return AGENT_NAME_RE.test(s.slice(0, at)) && ORIGIN_TAIL_RE.test(s.slice(at + 1)) ? 'shout' : 'other';
}

function isReplyable(from) {
  return typeof from === 'string' && AGENT_NAME_RE.test(from);
}

function annotate(note) {
  return { ...note, kind: noteKind(note && note.from), replyable: isReplyable(note && note.from) };
}

function newestFirst(a, b) {
  return (b.createdAt || 0) - (a.createdAt || 0);
}

function partitionNotes(notes) {
  const shouts = [];
  const other = [];
  const resolved = [];
  for (const raw of Array.isArray(notes) ? notes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const note = annotate(raw);
    if (note.readAt != null) resolved.push(note);
    else if (note.kind === 'shout') shouts.push(note);
    else other.push(note);
  }
  shouts.sort(newestFirst);
  other.sort(newestFirst);
  resolved.sort(newestFirst);
  return { shouts, other, resolved };
}

function hhmm(ts) {
  const d = new Date(Number(ts) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function coverageText({ open = 0, at = 0, blindSeats = [] } = {}) {
  const n = Number(open) || 0;
  const head = n > 0 ? `Showing ${n} open request${n === 1 ? '' : 's'}` : 'No open requests for you';
  const blind = Array.isArray(blindSeats) && blindSeats.length
    ? ` · approval prompts on ${blindSeats.join(', ')} (terminal-mode seats report none)`
    : '';
  return `${head} · last update ${hhmm(at)} · ${NOT_SHOWN}${blind}`;
}

function clampLimit(limit) {
  const raw = limit == null ? NaN : Number(limit);
  return Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : DEFAULT_LIMIT;
}

function createOpenRequests({ listSeatAttention, getNotifications, now = Date.now } = {}) {
  function seats() {
    try {
      const rows = typeof listSeatAttention === 'function' ? listSeatAttention() : [];
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch { return []; }
  }

  function notes() {
    const store = typeof getNotifications === 'function' ? getNotifications() : null;
    if (!store) return [];
    try {
      const all = store.list();
      return Array.isArray(all) ? all : [];
    } catch { return []; }
  }

  function assemble(workspaceId) {
    const at = now();
    const live = seats().filter((s) => workspaceId == null || s.workspaceId === workspaceId);
    const requests = live
      .filter((s) => s.attn && s.attn.kind === 'permission')
      .map((s) => ({
        name: s.name,
        workspaceId: s.workspaceId == null ? null : s.workspaceId,
        ts: s.attn.ts,
        message: s.attn.message,
        pending: s.pending || 0,
      }))
      .sort((a, b) => ((a.ts || 0) - (b.ts || 0)) || String(a.name).localeCompare(String(b.name)));
    const blindSeats = live.filter((s) => s.io !== 'stream' && s.agentType !== 'claude').map((s) => s.name);
    const parts = partitionNotes(notes());
    return { at, requests, blindSeats, open: requests.length + parts.shouts.length, parts };
  }

  function summary({ workspaceId = null } = {}) {
    const { at, requests, blindSeats, open } = assemble(workspaceId);
    return { at, requests, blindSeats, open };
  }

  function snapshot({ limit = DEFAULT_LIMIT, workspaceId = null } = {}) {
    const n = clampLimit(limit);
    const { at, requests, blindSeats, open, parts } = assemble(workspaceId);
    return {
      at, requests, blindSeats, open,
      shouts: parts.shouts,
      other: parts.other,
      resolved: { items: parts.resolved.slice(0, n), hasMore: parts.resolved.length > n },
    };
  }

  function count({ workspaceId = null } = {}) {
    const { open, parts } = assemble(workspaceId);
    return { open, unread: parts.shouts.length + parts.other.length };
  }

  return { summary, snapshot, count };
}

module.exports = { noteKind, isReplyable, annotate, partitionNotes, coverageText, hhmm, createOpenRequests };
