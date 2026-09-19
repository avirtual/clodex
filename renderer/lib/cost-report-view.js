'use strict';

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === 'string' && v ? v : null; }

function costReportModel(report) {
  const d = (report && typeof report === 'object') ? report : {};
  const v = (d.verdict && typeof d.verdict === 'object') ? d.verdict : {};
  const headline = str(v.headline);
  const rUsd = num(v.reclaimable_usd_total);
  const rPct = num(v.reclaimable_pct);
  const reclaimable = (rUsd == null && rPct == null) ? null : { usd: rUsd, pct: rPct };

  const cd = (d.cost_decomposition && typeof d.cost_decomposition === 'object') ? d.cost_decomposition : {};
  const buckets = (Array.isArray(cd.by_bucket) ? cd.by_bucket : [])
    .filter((b) => b && str(b.bucket))
    .map((b) => ({ bucket: b.bucket, usd: num(b.usd), tokens: num(b.tokens), pct: num(b.pct) }));

  const w = (d.waste && typeof d.waste === 'object') ? d.waste : {};
  const waste = (Array.isArray(w.by_type) ? w.by_type : [])
    .filter((t) => t && str(t.type))
    .map((t) => ({ type: t.type, usd: num(t.usd), lever: str(t.lever), confidence: str(t.confidence) }));

  const totals = (d.totals && typeof d.totals === 'object') ? d.totals : {};
  const series = (d.series && typeof d.series === 'object') ? d.series : {};
  const requests = num(series.count) != null ? num(series.count) : num(totals.requests);

  return { headline, reclaimable, buckets, waste, allTime: { usd: num(totals.est_usd), requests } };
}

module.exports = { costReportModel };
