'use strict';

function serverTranscriptPage(all, reqUrl) {
  const q = new URL(reqUrl, 'http://x').searchParams;
  const limit = Math.min(parseInt(q.get('limit'), 10) || 100, 500);
  const sinceRaw = q.get('since');
  const since = sinceRaw == null ? null : Math.max(parseInt(sinceRaw, 10) || 0, 0);
  const seqd = (all || []).map((m, i) => ({ ...m, seq: i }));
  const page = since == null ? seqd.slice(-limit) : seqd.filter((m) => m.seq >= since).slice(-limit);
  return { ok: true, messages: page, cursor: 0, complete: true };
}

module.exports = { serverTranscriptPage };
