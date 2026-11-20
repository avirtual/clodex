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
  keep: 'you chose to keep it running',
  lead: 'leads a team',
  working: 'working',
  dialog: 'a dialog is open',
  pending: 'has messages waiting',
  inFlight: 'a reload or compact is in flight',
  ticket: 'holds an open ticket',
};
const EXEMPT_ORDER = ['bash', 'assistant', 'keep', 'lead', 'working', 'dialog', 'pending', 'inFlight', 'ticket'];

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
    out.push({
      name: row.name, type: row.type, idleMs, idle: idleSpan(idleMs), reason: key ? EXEMPT_REASONS[key] : null,
      ...(Number.isInteger(row.pid) ? { pid: row.pid } : {}),
    });
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

function sumMem(rows) {
  const known = rows.filter((r) => r.memBytes != null);
  return known.length ? known.reduce((t, r) => t + r.memBytes, 0) : null;
}

function createIdlePauseAsker({ survey, pause, keep, getSettings, saveSettings, broadcast, sample = () => new Map(), log = null, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let open = null;
  let seq = 0;
  let timer = null;
  let stopped = false;
  let autoRun = null;

  function withMemory(rows) {
    let bytes = null;
    try {
      bytes = sample(rows.map((r) => r.pid).filter((p) => Number.isInteger(p)));
    } catch (e) {
      if (log) log.warn('session', `idle pause: memory sample failed: ${e && e.message}`);
    }
    return rows.map(({ pid, ...r }) => {
      const b = bytes instanceof Map && Number.isInteger(pid) ? bytes.get(pid) : undefined;
      return { ...r, memBytes: b > 0 ? b : null };
    });
  }

  async function autoPause(rows, hours, thresholdMs) {
    const measured = withMemory(rows);
    const names = [];
    const freed = [];
    for (const r of measured) {
      const res = await pause([r.name], { thresholdMs });
      if (res && res.paused > 0) { names.push(r.name); freed.push(r); }
    }
    if (!names.length) return { names };
    if (log) log.info('session', `idle pause: paused ${names.length} sessions idle over ${hours}h automatically: ${names.join(', ')}`);
    broadcast('idle-pause:auto', { names, hours, memBytes: sumMem(freed) });
    return { names };
  }

  function check() {
    if (open) return open;
    if (autoRun) return autoRun;
    const settings = getSettings() || {};
    const hours = settings.idlePauseHours;
    const thresholdMs = hours * HOUR_MS;
    if (!(thresholdMs > 0)) return null;
    const at = now();
    const rows = survey(at, thresholdMs);
    const pausable = rows.filter((r) => !r.reason);
    if (settings.idlePauseAuto === true) {
      if (!pausable.length) return null;
      autoRun = autoPause(pausable, hours, thresholdMs).finally(() => { autoRun = null; });
      return autoRun;
    }
    if (!shouldAsk({ pausable: pausable.map((r) => r.name), thresholdMs, declined: settings.idlePauseDeclined || null, now: at })) return null;
    const measured = withMemory(rows);
    const asked = measured.filter((r) => !r.reason);
    open = { id: `idle-${at}-${++seq}`, hours, thresholdMs, pausable: asked, exempt: measured.filter((r) => r.reason), memBytesTotal: sumMem(asked) };
    if (log) log.info('session', `idle pause: asking about ${pausable.length} sessions idle over ${hours}h`);
    broadcast('idle-pause:ask', open);
    return open;
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      const fail = (e) => { if (log) log.warn('session', `idle pause check failed: ${e && e.message}`); };
      try { Promise.resolve(check()).catch(fail); } catch (e) { fail(e); }
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
    if (reply.auto === true) {
      saveSettings({ idlePauseAuto: true, idlePauseDeclined: null });
      if (unticked.length) await keep(unticked);
    } else {
      saveSettings({ idlePauseDeclined: unticked.length ? { at: now(), names: unticked } : null });
    }
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
