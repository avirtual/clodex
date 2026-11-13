'use strict';

const MENU_JOB_ROWS = 8;
const KIND_LABELS = { verify: 'verify', 'post-merge': 'post-merge', hand: 'own run' };
const EMPTY_TEXT = 'No test jobs right now';
const OFF_TEXT = 'The test runner is off on this machine.';

function fmtSpan(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function jobHead(job) {
  return [
    job.team || '—',
    job.ticket || job.id,
    KIND_LABELS[job.kind] || job.kind,
    job.isolation === 'container' ? 'box' : 'native',
  ].join(' · ');
}

function liveLine(job, at) {
  if (job.startedAt != null) return `${jobHead(job)} · ${job.phase === 'setup' ? 'setting up' : 'running'} ${fmtSpan(at - job.startedAt)}`;
  return `${jobHead(job)} · ${job.phase === 'upload' ? 'uploading' : 'waiting'} ${fmtSpan(at - job.queuedAt)}`;
}

function outcomeText(job) {
  if (job.pass != null) return `${job.outcome} (${job.pass} pass, ${job.fail} fail)`;
  return job.outcome;
}

function recentLine(job) {
  const ran = job.runMs != null ? `ran ${fmtSpan(job.runMs)}` : 'did not start';
  return `${jobHead(job)} · ${outcomeText(job)} · waited ${fmtSpan(job.waitMs)} · ${ran}`;
}

function summaryLine(snap) {
  if (!snap || (!snap.running.length && !snap.waiting.length)) return 'idle';
  return `${snap.slots.inUse} of ${snap.slots.total} in use · ${snap.waiting.length} waiting`;
}

function boxText(box) {
  if (!box) return null;
  if (box.state === 'held') return `Box held: ${box.why}`;
  if (box.state === 'unavailable') return `Box unavailable: ${box.why}`;
  if (box.state === 'ready') return `Box image ${box.image}`;
  if (box.state === 'labels-only') return 'No default box image: only jobs naming a box definition run in a box';
  return 'No box configured: native jobs only';
}

function menuRows(state, at) {
  if (!state || !state.enabled) return [];
  const snap = state.snapshot;
  const rows = [{ kind: 'head', label: 'Test Boxes' }, { kind: 'info', label: summaryLine(snap) }];
  const jobs = snap ? [...snap.running, ...snap.waiting] : [];
  for (const job of jobs.slice(0, MENU_JOB_ROWS)) rows.push({ kind: 'info', label: liveLine(job, at) });
  if (jobs.length > MENU_JOB_ROWS) rows.push({ kind: 'info', label: `+${jobs.length - MENU_JOB_ROWS} more` });
  if (snap && snap.box && (snap.box.state === 'held' || snap.box.state === 'unavailable')) rows.push({ kind: 'info', label: boxText(snap.box) });
  rows.push({ kind: 'open', label: 'Test Box Activity…' });
  return rows;
}

function activityView(state, at) {
  if (!state || !state.enabled) return { summary: OFF_TEXT, box: null, running: [], waiting: [], empty: null, recent: [] };
  const snap = state.snapshot;
  const running = snap ? snap.running.map((j) => liveLine(j, at)) : [];
  const waiting = snap ? snap.waiting.map((j) => liveLine(j, at)) : [];
  return {
    summary: summaryLine(snap),
    box: snap ? boxText(snap.box) : null,
    running,
    waiting,
    empty: running.length || waiting.length ? null : EMPTY_TEXT,
    recent: snap ? snap.recent.map(recentLine) : [],
  };
}

module.exports = { menuRows, activityView, fmtSpan, MENU_JOB_ROWS };
