'use strict';

const { NODE_NAME_RE, MAX_PEERS, MAX_BOXES } = require('../../box-offer');
const DAY_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const PEER_NOTE = 'This list decides which peers are shown this offer. It is not an access control. Nothing runs on this machine because of it yet. A node that dials this machine is named by its own label, which is its hostname unless it set one.';
const RUN_PEER_NOTE = 'The ticked peers may run test jobs here while the offer is on and open. A node that dials this machine is named by its own label, which is its hostname unless it set one.';

function osArch(facts) {
  if (!facts || (!facts.os && !facts.arch)) return 'unknown os';
  return `${facts.os || '?'}/${facts.arch || '?'}`;
}

function memoryText(memMb) {
  if (!Number.isInteger(memMb)) return '? memory';
  if (memMb < 1024) return `${memMb} MB memory`;
  return `${Math.round(memMb / 1024)} GB memory`;
}

function runtimeText(runtime) {
  const platforms = runtime && Array.isArray(runtime.platforms) ? runtime.platforms : [];
  return platforms.length ? `container runtime ${platforms.join(', ')}` : 'container runtime: none found';
}

function ownFactsLine(facts) {
  const f = facts || {};
  const cpus = Number.isInteger(f.cpus) ? `${f.cpus} cores` : '? cores';
  return `${osArch(f)} · ${cpus} · ${memoryText(f.memMb)} · ${runtimeText(f.runtime)}`;
}

function peerOfferLine(rows, peerLabel) {
  if (!Array.isArray(rows) || typeof peerLabel !== 'string' || !peerLabel) return null;
  const row = rows.find((r) => r && r.provenance === 'hello' && r.name === peerLabel && r.offer);
  if (!row) return null;
  const { boxes, open, facts } = row.offer;
  const count = `${boxes} box${boxes === 1 ? '' : 'es'}`;
  const runtime = facts && facts.runtime && Array.isArray(facts.runtime.platforms) && facts.runtime.platforms.length
    ? `runtime ${facts.runtime.platforms.join(', ')}`
    : 'no container runtime';
  return `${count} · ${open ? 'open now' : 'closed now'} · ${osArch(facts)} · ${runtime}`;
}

function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 60000) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function peerChoices(rows, stored, now = Date.now()) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = row && row.name;
    if (typeof name !== 'string' || !NODE_NAME_RE.test(name) || out.some((c) => c.name === name)) continue;
    const note = row.from === 'dialed' ? `dials this machine, seen ${agoText(now - row.seenAt)}` : null;
    out.push({ name, note });
  }
  const ticked = (stored && Array.isArray(stored.peers) ? stored.peers : []).map((p) => p && p.name).filter((n) => typeof n === 'string');
  for (const name of ticked) if (!out.some((c) => c.name === name)) out.push({ name, note: null });
  return out.map((c) => ({ ...c, ticked: ticked.includes(c.name) }));
}

function peerNameToAdd(text, existing) {
  const name = String(text || '').trim();
  if (!NODE_NAME_RE.test(name)) return { error: 'a name is 1-64 letters, digits, dot, dash or underscore' };
  if ((existing || []).includes(name)) return { name, duplicate: true };
  return { name };
}

function selfLabelLine(self) {
  if (typeof self !== 'string' || !self) return '';
  return `This machine's label is ${self}: a node it dials sees it by that name.`;
}

function offerFormProblem({ boxes, availability, schedule, peers }) {
  const n = Number(boxes);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BOXES) return `boxes must be a whole number from 1 to ${MAX_BOXES}`;
  if (availability === 'schedule') {
    for (const w of schedule || []) {
      if (!w.days || !w.days.length) return 'a schedule window has no day ticked';
      if (!w.from || !w.to) return 'a schedule window has an empty time';
      if (w.from === w.to) return 'a schedule window starts and ends at the same time';
    }
  }
  if ((peers || []).length > MAX_PEERS) return `more than ${MAX_PEERS} peers ticked`;
  return null;
}

function offerRunnerFrom(st) {
  if (!st || typeof st.status !== 'string') return null;
  return { status: st.status, isolation: st.effective ? st.effective.isolation : null };
}

function runIsolationLine(runner) {
  if (!runner || !['running', 'starting', 'pull-only'].includes(runner.status)) {
    return 'Test runner is off: nothing runs until it is turned on above.';
  }
  const line = runner.isolation === 'none'
    ? "Jobs run through this machine's test runner, isolation none: suites run as this user, unisolated."
    : "Jobs run through this machine's test runner, isolation user: suites run as a separate user account.";
  if (runner.status === 'pull-only') return `${line} Phone access is off: only leads this machine dials can reach the runner.`;
  return line;
}

function runConsentText(peers, runner) {
  const names = (peers || []).filter((n) => typeof n === 'string');
  const who = names.length
    ? `These peers may run their teams' test jobs on this machine:\n${names.map((n) => `  ${n}`).join('\n')}`
    : 'No peer is ticked: no one may run test jobs here until one is.';
  return `${who}\n\n${runIsolationLine(runner)}\n\nAllow?`;
}

function offerRecordFromForm({ scope, enabled, boxes, availability, schedule, peers }) {
  const rec = {
    scope: scope === 'run' ? 'run' : 'discovery',
    enabled: !!enabled,
    boxes: Number(boxes),
    availability,
  };
  if (availability === 'schedule') {
    rec.schedule = (schedule || []).map((w) => ({ days: [...w.days].sort((a, b) => a - b), from: w.from, to: w.to }));
  }
  rec.peers = (peers || []).map((name) => ({ name }));
  return rec;
}

function claimLines(claims, now = Date.now()) {
  return (Array.isArray(claims) ? claims : []).filter((c) => c && typeof c.name === 'string').map((c) => {
    if (c.state === 'runner-off') return `${c.name}: runner mode off`;
    if (c.state !== 'claiming') return `${c.name}: not connected`;
    return `${c.name}: claiming, last claim ${Number.isFinite(c.lastClaim) ? agoText(now - c.lastClaim) : 'not yet'}`;
  });
}

function offerStatusText(st) {
  if (!st) return '';
  if (st.forced) return 'Set by environment (CLODEX_BOX_OFFER); change it there.';
  if (st.warning) return `${st.warning[0].toUpperCase()}${st.warning.slice(1)}.`;
  const eff = st.effective;
  if (!eff || !eff.enabled) return 'Off.';
  return 'Announced to the ticked peers at the next hello.';
}

module.exports = {
  DAY_LETTERS,
  PEER_NOTE,
  RUN_PEER_NOTE,
  ownFactsLine,
  offerRunnerFrom,
  runIsolationLine,
  runConsentText,
  peerOfferLine,
  peerChoices,
  peerNameToAdd,
  selfLabelLine,
  offerFormProblem,
  offerRecordFromForm,
  offerStatusText,
  claimLines,
};
