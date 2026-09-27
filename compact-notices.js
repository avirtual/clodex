'use strict';

const COMPACTING_VALVE_MS = 5 * 60 * 1000;
const COMPACT_NOTICE_CAP = 20;

function elapsedText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

function noticeTextFor(outcome, ms) {
  if (outcome === 'done') return `Compacted in ${elapsedText(ms)}`;
  return 'Compact did not report back';
}

function mergeCompactNotices(records, notices) {
  const out = Array.isArray(records) ? records.slice() : [];
  const folded = new Set();
  for (const n of notices) {
    if (typeof n.ms === 'number' && n.outcome === 'done') {
      const b = out.findIndex((r, i) => !folded.has(i) && r.kind === 'boundary' && r.what === 'compact' && r.ts != null && r.ts >= n.ts);
      if (b >= 0) {
        out[b] = { ...out[b], elapsedMs: n.ms };
        folded.add(b);
        continue;
      }
    }
    let at = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].ts != null && out[i].ts <= n.ts) { at = i + 1; break; }
    }
    const turn = at > 0 ? out[at - 1].turn : (out.length ? out[0].turn : 0);
    out.splice(at, 0, { id: n.id, kind: 'notice', level: 'info', ts: n.ts, turn, text: n.text });
  }
  return out;
}

module.exports = { COMPACTING_VALVE_MS, COMPACT_NOTICE_CAP, elapsedText, noticeTextFor, mergeCompactNotices };
