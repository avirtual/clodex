'use strict';

function serverTranscriptPage(all, reqUrl) {
  const q = new URL(reqUrl, 'http://x').searchParams;
  const limit = Math.min(parseInt(q.get('limit'), 10) || 100, 500);
  const sinceRaw = q.get('since');
  const since = sinceRaw == null ? null : Math.max(parseInt(sinceRaw, 10) || 0, 0);
  const afterRaw = q.get('after');
  const floor = afterRaw == null ? NaN : Date.parse(afterRaw);
  const seqd = (all || []).map((m, i) => ({ ...m, seq: i }));
  let rows = since == null ? seqd : seqd.filter((m) => m.seq >= since);
  if (Number.isFinite(floor)) {
    rows = rows.filter((m) => m.ts == null || !Number.isFinite(Date.parse(m.ts)) || Date.parse(m.ts) >= floor);
  }
  const page = rows.slice(-limit);
  return { ok: true, messages: page, cursor: 0, complete: true };
}

module.exports = { serverTranscriptPage };
