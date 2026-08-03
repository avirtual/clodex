'use strict';
// session-info-view.js — the ⓘ panel's rows, as data. Pure leaf: no DOM, so the
// three cost scopes and their labels are unit-testable (they were the subject of
// the 07-15 three-scopes ruling; a wrong label here is worse than a missing row).
//
// Each section is { title, rows: [{ k, v, tip? }] } and a section with no
// resolvable rows is dropped by the caller rather than rendered empty.

function fmtUsd(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  if (v >= 100) return `$${v.toFixed(0)}`;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

function fmtInt(v) {
  return typeof v === 'number' && isFinite(v) ? v.toLocaleString('en-US') : null;
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1000) return `${Math.round(n / 1000)} KB`;
  return `${n} B`;
}

function fmtAge(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function row(k, v, tip) { return v == null ? null : { k, v, tip }; }

// Identity + provenance.
function aboutSection(info, now) {
  const rows = [
    row('type', info.type ? `${info.type}${info.backend ? ` · ${info.backend}` : ''}` : null),
    row('model', info.model),
    row('team', info.team),
    row('created', info.createdAt ? `${fmtAge(now - info.createdAt)} ago` : null,
      info.createdAt ? new Date(info.createdAt).toLocaleString() : null),
    row('conversation', info.sessionId ? info.sessionId.slice(0, 8) : null, info.sessionId),
    // The count of session_ids this seat has held. Every /clear mints a new one,
    // so this is "how many times has this seat started over" — the natural
    // companion to the compact count below.
    row('conversations', info.sessionCount > 1 ? `${info.sessionCount} (this seat)` : null,
      'Each /clear mints a new conversation id; this seat has held that many'),
  ].filter(Boolean);
  return { title: 'Session', rows };
}

// Compacts + what they cost, all scoped to the CURRENT conversation because a
// transcript IS one session_id. `dropped` is the CLI's own running total, not a
// sum of pre−post (which would double-count).
function compactSection(info) {
  const c = info.compact || { count: 0 };
  const rows = [
    row('compacted', c.count === 0 ? 'never' : `${c.count}×`,
      'Compactions on the current conversation (a /clear starts a fresh count)'),
    row('auto vs manual', c.count > 0 && c.autoCount > 0 ? `${c.autoCount} auto · ${c.count - c.autoCount} manual` : null),
    row('tokens dropped', fmtTokens(c.dropped), 'Cumulative context discarded by every compact, per the CLI'),
    row('last compact', c.last && c.last.pre != null && c.last.post != null
      ? `${fmtTokens(c.last.pre)} → ${fmtTokens(c.last.post)}` : null,
      'Context size immediately before and after the most recent compact'),
  ].filter(Boolean);
  return { title: 'Compaction', rows };
}

// The three scopes, always labelled, never merged. Ordered narrow→wide so the
// number that grows fastest is read last.
function costSection(info) {
  const rows = [];
  const sc = info.sinceCompact;
  if (sc && typeof sc.estUsd === 'number') {
    rows.push({
      k: sc.compacted ? 'since last compact' : 'since start',
      v: fmtUsd(sc.estUsd),
      tip: sc.compacted ? 'Spend since the most recent compact boundary' : 'This conversation has never compacted',
    });
  }
  if (info.run) rows.push({ k: 'this run', v: fmtUsd(info.run.usd), tip: "Since the agent's CLI process started (resets when the seat respawns)" });
  if (info.session) {
    rows.push({ k: 'this conversation', v: fmtUsd(info.session.usd), tip: 'Whole current conversation, across app restarts. Reset by /clear.' });
  }
  const a = info.agent;
  if (a && a.total > 0) {
    // The monotonic one. `known < total` is surfaced rather than hidden: the
    // ledger keeps only the newest 500 conversations, so an old seat's earliest
    // spend is genuinely gone and a bare total would read as complete.
    const partial = a.known < a.total;
    rows.push({
      k: 'this agent, all time',
      v: fmtUsd(a.usd),
      tip: partial
        ? `Every conversation this seat has held. ${a.known} of ${a.total} are still in the ledger — older ones have been pruned, so the real figure is higher.`
        : `Every conversation this seat has held (${a.total}), summed. Never resets.`,
    });
    if (partial) rows.push({ k: '', v: `${a.known}/${a.total} conversations in the ledger`, tip: null });
  }
  return { title: 'Cost', rows };
}

// Volume. `requests` is API roundtrips (tool loops included), not prompts.
function activitySection(info) {
  const a = info.agent || {};
  const s = info.session || {};
  const rows = [
    row('turns', fmtInt(s.turns), 'Completed turns on this conversation'),
    row('requests', fmtInt(s.requests), 'API roundtrips on this conversation — tool-loop calls, not just your prompts'),
    row('turns, all time', a.total > 1 ? fmtInt(a.turns) : null, 'Across every conversation this seat has held'),
    row('requests, all time', a.total > 1 ? fmtInt(a.requests) : null),
    row('refusals', a.refusals > 0 ? fmtInt(a.refusals) : null, 'API refusals across this seat'),
    row('subagents', info.subagents ? fmtInt(info.subagents) : null, 'Subagent lines wirescope is currently tracking'),
  ].filter(Boolean);
  return { title: 'Activity', rows };
}

function contextSection(info, now) {
  const ctx = info.context || {};
  const t = info.transcript;
  const rows = [
    row('in context', fmtTokens(ctx.inputTokens), 'Input tokens on the last main-line turn'),
    row('messages', fmtInt(ctx.messages)),
    row('strip level', info.stripLevel ? `L${info.stripLevel}` : null, 'Thinking-block stripping configured for this session'),
    row('transcript', t ? fmtBytes(t.bytes) : null, t && t.lines ? `${fmtInt(t.lines)} records on disk` : null),
    row('last write', t && t.lastTs ? `${fmtAge(now - Date.parse(t.lastTs))} ago` : null),
  ].filter(Boolean);
  return { title: 'Context', rows };
}

// Sections in display order, empties dropped.
function buildSections(info, now = Date.now()) {
  if (!info) return [];
  return [aboutSection(info, now), costSection(info), compactSection(info), activitySection(info), contextSection(info, now)]
    .filter((s) => s.rows.length);
}

module.exports = { buildSections, fmtUsd, fmtInt, fmtTokens, fmtBytes, fmtAge };
