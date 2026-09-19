'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { costReportModel } = require('../renderer/lib/cost-report-view');

const FIXTURE = {
  verdict: {
    headline: 'Two thirds of spend is re-reading a context nobody trimmed.',
    reclaimable_usd_total: 41.22,
    reclaimable_pct: 63,
    rating: 'poor',
    score: 31,
  },
  cost_decomposition: {
    total_usd: 65.4,
    by_bucket: [
      { bucket: 'cache_read', usd: 44.1, tokens: 14700000, pct: 67 },
      { bucket: 'cache_write_initial', usd: 8.2, tokens: 660000, pct: 13 },
      { bucket: 'cache_write_rewrite', usd: 6.9, tokens: 550000, pct: 11 },
      { bucket: 'uncached_input', usd: 3.1, tokens: 1030000, pct: 5 },
      { bucket: 'output', usd: 3.1, tokens: 41000, pct: 5 },
    ],
  },
  waste: {
    by_type: [
      { type: 'subagent_inherited_context', usd: 28.0, lever: 'omit claudemd on spawn', confidence: 'high' },
      { type: 'idle_cache_expiry', usd: 9.4, lever: 'keep-warm holds', confidence: 'medium' },
      { type: 'unused_tools', usd: 3.82, lever: 'trim the tool roster', confidence: 'high' },
    ],
  },
  totals: { est_usd: 65.4, basis: 'on-disk capture' },
  series: { count: 6820 },
};

test('the full model off a report carrying every section', () => {
  assert.deepStrictEqual(costReportModel(FIXTURE), {
    headline: 'Two thirds of spend is re-reading a context nobody trimmed.',
    reclaimable: { usd: 41.22, pct: 63 },
    buckets: [
      { bucket: 'cache_read', usd: 44.1, tokens: 14700000, pct: 67 },
      { bucket: 'cache_write_initial', usd: 8.2, tokens: 660000, pct: 13 },
      { bucket: 'cache_write_rewrite', usd: 6.9, tokens: 550000, pct: 11 },
      { bucket: 'uncached_input', usd: 3.1, tokens: 1030000, pct: 5 },
      { bucket: 'output', usd: 3.1, tokens: 41000, pct: 5 },
    ],
    waste: [
      { type: 'subagent_inherited_context', usd: 28.0, lever: 'omit claudemd on spawn', confidence: 'high' },
      { type: 'idle_cache_expiry', usd: 9.4, lever: 'keep-warm holds', confidence: 'medium' },
      { type: 'unused_tools', usd: 3.82, lever: 'trim the tool roster', confidence: 'high' },
    ],
    allTime: { usd: 65.4, requests: 6820 },
  });
});

test('each section missing on its own is empty, not a throw', () => {
  for (const drop of ['verdict', 'cost_decomposition', 'waste', 'totals', 'series']) {
    const r = { ...FIXTURE };
    delete r[drop];
    assert.doesNotThrow(() => costReportModel(r), `dropping ${drop} must not throw`);
  }
  const bare = costReportModel({});
  assert.deepStrictEqual(bare, {
    headline: null, reclaimable: null, buckets: [], waste: [],
    allTime: { usd: null, requests: null },
  });
});

test('a null or non-object report is the empty model', () => {
  const empty = { headline: null, reclaimable: null, buckets: [], waste: [], allTime: { usd: null, requests: null } };
  assert.deepStrictEqual(costReportModel(null), empty);
  assert.deepStrictEqual(costReportModel(undefined), empty);
  assert.deepStrictEqual(costReportModel('nope'), empty);
});

test('requests falls back from series.count to totals.requests, else null', () => {
  const withSeries = costReportModel({ series: { count: 6820 }, totals: { requests: 11 } });
  assert.strictEqual(withSeries.allTime.requests, 6820, 'series.count wins when present');

  const noSeries = costReportModel({ totals: { est_usd: 1.5, requests: 8501 } });
  assert.strictEqual(noSeries.allTime.requests, 8501,
    'with no series the count must come from totals — the summary fetch never carries series');
  assert.strictEqual(noSeries.allTime.usd, 1.5);

  assert.strictEqual(costReportModel({ totals: { est_usd: 1.5 } }).allTime.requests, null,
    'neither source present is null, not 0 — "over 0 requests" is a claim the report never made');
});

test('a bucket or waste row missing its key is dropped, not rendered nameless', () => {
  const m = costReportModel({
    cost_decomposition: { by_bucket: [{ usd: 1 }, { bucket: 'output', usd: 2 }] },
    waste: { by_type: [{ usd: 3 }, { type: 'unused_tools', usd: 4 }] },
  });
  assert.deepStrictEqual(m.buckets, [{ bucket: 'output', usd: 2, tokens: null, pct: null }]);
  assert.deepStrictEqual(m.waste, [{ type: 'unused_tools', usd: 4, lever: null, confidence: null }]);
});

test('non-array by_bucket / by_type degrade to empty', () => {
  const m = costReportModel({ cost_decomposition: { by_bucket: 'nope' }, waste: { by_type: 7 } });
  assert.deepStrictEqual(m.buckets, []);
  assert.deepStrictEqual(m.waste, []);
});

test('a verdict with only a pct still yields a reclaimable block; neither yields null', () => {
  assert.deepStrictEqual(costReportModel({ verdict: { reclaimable_pct: 12 } }).reclaimable, { usd: null, pct: 12 });
  assert.strictEqual(costReportModel({ verdict: { rating: 'good' } }).reclaimable, null);
  assert.strictEqual(costReportModel({ verdict: { headline: '' } }).headline, null,
    'an empty headline is no headline — the popover must not paint a blank line for it');
});
