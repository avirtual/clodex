'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const IDLE_PAUSE_MIN_COUNT = 5;
const IDLE_PAUSE_REASK_MS = 7 * DAY_MS;
const IDLE_PAUSE_FIRST_CHECK_MS = 5 * MINUTE_MS;
const IDLE_PAUSE_CHECK_MS = HOUR_MS;

const EXEMPT_REASONS = {
  bash: 'a shell session cannot be resumed',
  assistant: 'an assistant sleeps on its own',
  lead: 'leads a team',
  working: 'working',
  dialog: 'a dialog is open',
  pending: 'has messages waiting',
  inFlight: 'a reload or compact is in flight',
  ticket: 'holds an open ticket',
};
const EXEMPT_ORDER = ['bash', 'assistant', 'lead', 'working', 'dialog', 'pending', 'inFlight', 'ticket'];

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function idleSpan(ms) {
  if (ms >= DAY_MS) return plural(Math.floor(ms / DAY_MS), 'day');
  if (ms >= HOUR_MS) return plural(Math.floor(ms / HOUR_MS), 'hour');
  return plural(Math.max(0, Math.floor(ms / MINUTE_MS)), 'minute');
}

function idleSince(row) {
  return Math.max(Number(row.activityTs) || 0, Number(row.operatorInputAt) || 0);
}

function idleCandidates({ sessions, now, thresholdMs }) {
  if (!(thresholdMs > 0)) return [];
  const out = [];
  for (const row of sessions || []) {
    if (!row || row.archived || row.exited || row.failed) continue;
    const idleMs = now - idleSince(row);
    if (idleMs < thresholdMs) continue;
    const key = EXEMPT_ORDER.find((k) => row[k]);
    out.push({ name: row.name, type: row.type, idleMs, idle: idleSpan(idleMs), reason: key ? EXEMPT_REASONS[key] : null });
  }
  return out.sort((a, b) => b.idleMs - a.idleMs || (a.name < b.name ? -1 : 1));
}

function shouldAsk({ pausable, thresholdMs, declined, now }) {
  if (!(thresholdMs > 0) || pausable.length < IDLE_PAUSE_MIN_COUNT) return false;
  if (!declined) return true;
  if (now - declined.at >= IDLE_PAUSE_REASK_MS) return true;
  const seen = new Set(declined.names);
  return pausable.filter((n) => !seen.has(n)).length >= IDLE_PAUSE_MIN_COUNT;
}

function createIdlePauseAsker({ survey, pause, getSettings, saveSettings, broadcast, log = null, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let open = null;
  let seq = 0;
  let timer = null;
  let stopped = false;

  function check() {
    if (open) return open;
    const settings = getSettings() || {};
    const hours = settings.idlePauseHours;
    const thresholdMs = hours * HOUR_MS;
    if (!(thresholdMs > 0)) return null;
    const at = now();
    const rows = survey(at, thresholdMs);
    const pausable = rows.filter((r) => !r.reason);
    if (!shouldAsk({ pausable: pausable.map((r) => r.name), thresholdMs, declined: settings.idlePauseDeclined || null, now: at })) return null;
    open = { id: `idle-${at}-${++seq}`, hours, thresholdMs, pausable, exempt: rows.filter((r) => r.reason) };
    if (log) log.info('session', `idle pause: asking about ${pausable.length} sessions idle over ${hours}h`);
    broadcast('idle-pause:ask', open);
    return open;
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      try { check(); } catch (e) { if (log) log.warn('session', `idle pause check failed: ${e && e.message}`); }
      schedule(IDLE_PAUSE_CHECK_MS);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function answer(id, reply) {
    if (!open || open.id !== id) return { ok: false, error: 'this question was already answered' };
    const asked = open;
    open = null;
    broadcast('idle-pause:closed', { id });
    const offered = asked.pausable.map((r) => r.name);
    if (!reply || !Array.isArray(reply.pause)) {
      saveSettings({ idlePauseDeclined: { at: now(), names: offered } });
      return { ok: true, paused: 0, skipped: 0 };
    }
    const chosen = offered.filter((n) => reply.pause.includes(n));
    const unticked = offered.filter((n) => !chosen.includes(n));
    saveSettings({ idlePauseDeclined: unticked.length ? { at: now(), names: unticked } : null });
    const res = await pause(chosen, { thresholdMs: asked.thresholdMs });
    return { ok: true, paused: res.paused, skipped: res.skipped };
  }

  return {
    start() { stopped = false; if (!timer) schedule(IDLE_PAUSE_FIRST_CHECK_MS); },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; },
    check,
    current: () => open,
    answer,
  };
}

module.exports = {
  EXEMPT_REASONS, IDLE_PAUSE_MIN_COUNT, IDLE_PAUSE_REASK_MS, IDLE_PAUSE_FIRST_CHECK_MS, IDLE_PAUSE_CHECK_MS, HOUR_MS,
  idleSpan, idleCandidates, shouldAsk, createIdlePauseAsker,
};
