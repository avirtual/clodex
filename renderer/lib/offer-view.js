'use strict';

const OFFER_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const DAY_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const PEER_NOTE = 'This list decides which peers are shown this offer. It is not an access control, and nothing runs on this machine because of it yet.';

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

function peerChoices(configuredLabels, stored) {
  const out = [];
  for (const label of Array.isArray(configuredLabels) ? configuredLabels : []) {
    if (typeof label === 'string' && OFFER_NAME_RE.test(label) && !out.includes(label)) out.push(label);
  }
  const ticked = (stored && Array.isArray(stored.peers) ? stored.peers : []).map((p) => p && p.name).filter((n) => typeof n === 'string');
  for (const name of ticked) if (!out.includes(name)) out.push(name);
  return out.map((name) => ({ name, ticked: ticked.includes(name) }));
}

function offerRecordFromForm({ enabled, boxes, availability, schedule, peers }) {
  const rec = {
    scope: 'discovery',
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
  ownFactsLine,
  peerOfferLine,
  peerChoices,
  offerRecordFromForm,
  offerStatusText,
};
