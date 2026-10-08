'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const COST = read('renderer', 'popovers', 'cost-popover.js');
const CTX = read('renderer', 'popovers', 'context-popover.js');
const RENDERER = read('renderer', 'renderer.js');
const RENDER_HTML = read('renderer', 'lib', 'render-html.js');
const INDEX = read('renderer', 'index.html');

test('the cost popover asks for no detail and draws no series chart', () => {
  assert.ok(/popoverApi\(name\)\.report\(/.test(COST),
    'ENTER: the report fetch must still be in this file, or the pins below hold over a moved call');
  assert.ok(!/detail:\s*true/.test(COST),
    'the cost popover must not request detail=1: it is 3.07MB / 49.5s on a long session and always blew the 20s budget');
  assert.ok(/report\(\{\s*detail:\s*false\s*\}\)/.test(COST),
    'the summary fetch must ask detail:false explicitly, so a default flip cannot quietly restore the heavy payload');
  assert.ok(!/svgCostChart/.test(COST),
    'the cumulative-cost chart is gone with the series it drew — the per-request timeline is the dashboard link now');
  assert.ok(!/svgCostChart/.test(RENDER_HTML) && !/svgCostChart/.test(RENDERER),
    'and with no caller left anywhere, the helper, its export and its import go too rather than sitting dead in a shared leaf');
  assert.ok(/px-link-ext[\s\S]{0,200}_timeline/.test(COST),
    'and that dashboard link must remain: it is the ONLY route left to the per-request timeline');
});

test('the cost popover renders the report summary sections', () => {
  assert.ok(/costReportModel/.test(COST), 'the popover renders from the tested model, not from raw report fields');
  assert.ok(/COST_BUCKETS/.test(COST),
    'cost_decomposition.by_bucket goes through its own defs — COST_SPINE keys (read/write/generation) do not match bucket names');
  assert.ok(!/COST_SPINE/.test(COST), 'and the spine defs, which keyed the deleted series render, go with it');
  assert.ok(/all-time/.test(COST) && /scoped separately/.test(COST),
    "the head line must name the report's own scope AND say the chip it was opened from is not the same number — costSeg renders since-compact, this-run or all-time depending on the payload, so the popover may not claim a specific one for it");
  assert.ok(/res\.stale/.test(COST), 'a stale (cached) report must be labelled as one');
  assert.ok(/known\.has\(b\.bucket\)/.test(COST),
    'the header total must sum only the buckets COST_BUCKETS can DRAW — a bucket a newer wirescope adds would otherwise inflate the total while rendering no segment, and the legend percentages would stop summing to 100');
  assert.ok(/if \(m\.reclaimable\) \{/.test(COST),
    'the reclaimable line must not be gated on usd alone: costReportModel returns {usd:null,pct:N} for a report carrying only a percentage, and that case must still print');
});

test('the context popover splits the plain read from the utilization scan', () => {
  assert.ok(/ctx\(\{\s*utilization:\s*false\s*\}\)/.test(CTX),
    'the first fetch must be the plain 13ms read, so composition paints before any scan');
  assert.ok(/ctx\(\{\s*utilization:\s*true\s*\}\)/.test(CTX),
    'and the scan must still be a second, separate fetch — dropping it would lose the utilization column outright');
  assert.ok(/wantUtil/.test(CTX) && /context_utilization[\s\S]{0,80}context_skills/.test(CTX),
    'the scan stays capability-gated: a proxy that advertises neither must not be asked to run one');
  assert.ok(/utilization: scanning…/.test(CTX), 'the right column says a scan is in flight rather than sitting blank');
  assert.ok(/utilization unavailable \(/.test(CTX),
    'and a failed scan replaces that line only — naming the error');
  assert.ok(/ctx-util-col/.test(CTX),
    'the scan result must fill a column IN PLACE; a whole-body repaint would let a failed scan take the composition down with it');
});

test('the right column is built from the plain read, not gated on the scan', () => {
  const fn = CTX.match(/async function fetchAndPaint\([\s\S]*?\n  }\n/);
  assert.ok(fn, 'ENTER: the fetch-and-paint body must still be found by this anchor');
  const src = fn[0];
  const noScan = src.match(/if \(!wantUtil\) \{[\s\S]{0,400}?\n    \}/);
  assert.ok(noScan, 'ENTER: the no-scan arm must still be an early return on !wantUtil');
  assert.ok(/plainCol/.test(noScan[0]),
    'the NO-SCAN arm must still build the right column: peerProxyView withholds capabilities, so every peer session has wantUtil false while the owner side answers with tools.per_tool and often utilization anyway — gating the column on the scan silently dropped the MCP block for all of them');
  assert.ok(/const plainCol = renderUtilHalf\(agents\);/.test(src),
    'and it comes from the plain response both paths share, built once rather than re-derived per arm');
  assert.ok(/\$\{plainCol\}\$\{scanning\}/.test(src),
    'and the scanning placeholder must sit BELOW what the 13ms read already paid for, not replace it');
  const failArm = src.match(/if \(!ures \|\| !ures\.ok\) \{[\s\S]{0,400}?\n    \}/);
  assert.ok(failArm, 'ENTER: the scan-failure arm must still be found');
  assert.ok(/plainCol/.test(failArm[0]),
    'a failed scan costs only what the scan would have ADDED — on the measured 20.1s-vs-20s timeout the MCP block, free from the plain read, must survive');
});

test('a re-click for the same session joins the in-flight fetch instead of issuing another', () => {
  assert.ok(/const ctxPending = new Map\(\);/.test(CTX),
    'the in-flight guard is a per-name Map of pending promises');
  const opener = CTX.match(/async function openContextPopover\([\s\S]*?\n  }\n/);
  assert.ok(opener, 'ENTER: openContextPopover must still be found by this anchor');
  assert.ok(/if \(ctxPending\.has\(name\)\) \{[\s\S]*?return ctxPending\.get\(name\);/.test(opener[0]),
    'a second click for the SAME session must return the pending run rather than start a second pair of fetches — the scan alone is a 20.1s disk walk');
  assert.ok(/if \(ctxPending\.has\(name\)\) \{[\s\S]{0,160}?ctxBodyName !== name[\s\S]{0,80}?paintCtxBody\(/.test(opener[0]),
    'and it must repaint the pending note first when the body still holds ANOTHER session — joining without repainting shows that session\'s tokens under this name');
  assert.ok(/ctxPending\.set\(name, run\)/.test(opener[0]) && /finally \{ ctxPending\.delete\(name\); \}/.test(opener[0]),
    'and the entry must clear in a finally, or one rejected fetch wedges that session\'s popover for the life of the window');

  const body = CTX.match(/async function fetchAndPaint\([\s\S]*?\n  }\n/);
  assert.ok(body, 'ENTER: the guarded body must still be found');
  const calls = body[0].match(/popoverApi\(name\)\.ctx\(/g) || [];
  assert.strictEqual(calls.length, 2,
    'BOTH fetches (plain and scan) must sit inside the guarded body — a ctx( call left in the opener would escape the guard entirely');
  assert.ok(!/popoverApi\(name\)\.ctx\(/.test(opener[0].replace(body[0], '')),
    'and the opener itself must issue none');
  assert.ok(/ctxPopover\.dataset\.name !== name/.test(body[0]),
    'a click for a DIFFERENT session still supersedes: each paint step re-checks dataset.name and discards itself');
});

test('the Preferences capture-logs block is never hidden by a failed pruneInfo', () => {
  const fn = RENDERER.match(/async function refreshWsLogs\(\)[\s\S]{0,1400}?\n}\n/);
  assert.ok(fn, 'ENTER: refreshWsLogs must still be found by this anchor');
  const src = fn[0];
  assert.ok(/wirescopePruneInfo/.test(src), 'ENTER: and it must still be the function that calls pruneInfo');
  assert.ok(!/style\.display\s*=\s*'none'/.test(src),
    'a failed /_prune must not hide the block: the call takes 51s on a large store, which is exactly when the Clear button is wanted');
  assert.ok(/size unavailable \(/.test(src),
    'the failure belongs in the size line — a number we could not measure, not a control that vanished');
  assert.ok(/wsLogsClearBtn\.disabled\s*=\s*false/.test(src),
    'and Clear stays usable: its own dry-run preview and confirm are the real guard (renderer.js wsLogsClearBtn click)');
  assert.ok(!/id="ws-logs-block"[^>]*display:\s*none/.test(INDEX),
    'the markup must not ship it hidden either, or it stays invisible until the first successful refresh');
});

test('a failed preview disables only Clear, and the age change re-runs it', () => {
  const fn = RENDERER.match(/async function previewWsLogs\(\)[\s\S]{0,1400}?\n}\n/);
  assert.ok(fn, 'ENTER: previewWsLogs must still be found by this anchor');
  assert.ok(/dryRun:\s*true/.test(fn[0]), 'ENTER: and it must still be the dry-run preview call');
  assert.ok(!/style\.display/.test(fn[0]), 'a failed preview touches no visibility — only the button');
  assert.ok(/wsLogsAge\.addEventListener\('change', previewWsLogs\)/.test(RENDERER),
    're-enabling the button has to be reachable: changing the age re-runs the preview');
});

test('Clear is usable again after the operator cancels the confirm', async () => {
  const vm = require('node:vm');
  const head = "wsLogsClearBtn.addEventListener('click', async () => {";
  const start = RENDERER.indexOf(head);
  assert.ok(start > 0, 'ENTER: the Clear click handler was located');
  const block = RENDERER.slice(start, RENDERER.indexOf('\n});\n', start) + 4);
  let listener = null;
  let refreshes = 0;
  const wsLogsClearBtn = { disabled: false, addEventListener: (t, cb) => { listener = cb; } };
  const ctx = {
    wsLogsClearBtn, wsLogsClearBusy: false, wsLogsSize: { textContent: '' },
    wsSelectedAge: () => '7d', wsAgeLabel: () => '7 days', fmtBytes: (n) => `${n} B`, wsLogsSizeText: () => 'Capture logs',
    previewWsLogs: async () => {}, confirm: () => false,
    refreshWsLogs: async () => { refreshes++; wsLogsClearBtn.disabled = false; },
    window: { api: { wirescopePrune: async () => ({ ok: true, data: { bytes_reclaimed: 5, files_deleted: 1, sessions_pruned: 1 } }) } },
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  assert.ok(listener, 'ENTER: the handler was registered');
  await listener();
  assert.strictEqual(wsLogsClearBtn.disabled, false);
  assert.strictEqual(refreshes, 1, 'the re-enable came through the finally refresh');
});

test('a failed Clear still tells the operator why, after the refresh repaints the size line', async () => {
  const vm = require('node:vm');
  const head = "wsLogsClearBtn.addEventListener('click', async () => {";
  const start = RENDERER.indexOf(head);
  assert.ok(start > 0, 'ENTER: the Clear click handler was located');
  const block = RENDERER.slice(start, RENDERER.indexOf('\n});\n', start) + 4);
  for (const failure of [async () => ({ ok: false, error: 'boom' }), async () => { throw new Error('boom'); }]) {
    let listener = null;
    const toasts = [];
    const wsLogsClearBtn = { disabled: false, addEventListener: (t, cb) => { listener = cb; } };
    const wsLogsSize = { textContent: '' };
    const ctx = {
      wsLogsClearBtn, wsLogsClearBusy: false, wsLogsSize,
      wsSelectedAge: () => '7d', wsAgeLabel: () => '7 days', fmtBytes: (n) => `${n} B`, wsLogsSizeText: () => 'Capture logs',
      previewWsLogs: async () => {}, confirm: () => true, showToast: (m) => toasts.push(String(m)),
      refreshWsLogs: async () => { wsLogsSize.textContent = 'Capture logs: measuring…'; wsLogsClearBtn.disabled = false; },
      window: { api: { wirescopePrune: async (o) => (o.dryRun
        ? { ok: true, data: { bytes_reclaimed: 5, files_deleted: 1, sessions_pruned: 1 } }
        : failure()) } },
    };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    await listener();
    assert.ok(toasts.some((t) => t.includes('boom')), `a toast carries the failure; got ${JSON.stringify(toasts)}`);
    assert.strictEqual(wsLogsClearBtn.disabled, false);
  }
});

function reportRig(report) {
  const mkEl = () => {
    const cls = new Set();
    return {
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
      dataset: {}, innerHTML: '', textContent: '', addEventListener: () => {},
    };
  };
  const els = new Map();
  global.document = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); },
    addEventListener: () => {},
    createElement: () => {
      let text = '';
      return {
        set textContent(v) { text = String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
    },
  };
  const modPath = require.resolve('../renderer/popovers/report-panel.js');
  delete require.cache[modPath];
  const { initReportPanel } = require(modPath);
  const { openReportPanel } = initReportPanel({ popoverApi: () => ({ report }), ctxCatLabel: (c) => c });
  return { open: openReportPanel, body: els.get('report-body') };
}

test('the session report panel escapes every report field it interpolates, so a hostile peer\'s report cannot inject markup', async () => {
  const X = '<img src=x onerror=1>';
  const PAYLOAD = {
    report_version: 4,
    scope: { requests: X, turns: X },
    waste: { by_type: [{ type: 'cold_cache', items: X }] },
    cost_decomposition: { by_bucket: [{ bucket: 'input', usd: 1, pct: X }] },
    token_decomposition: { preamble: { tokens_per_request: 10, requests_resent: X } },
  };
  const { open, body } = reportRig(async () => ({ ok: true, data: PAYLOAD }));
  await open('s');
  assert.ok(body.innerHTML.includes('rep-verdict'), 'ENTER: the report rendered rather than the catch arm');
  assert.ok(!body.innerHTML.includes('<img'), 'no report field reaches the markup raw');
});

test('the session report panel labels a stale cached report and shows the error that caused the fallback', async () => {
  const { open, body } = reportRig(async () => ({ ok: true, stale: true, at: Date.now() - 600000, error: 'proxy returned 503 <b>', data: { report_version: 4 } }));
  await open('s');
  assert.ok(body.innerHTML.includes('rep-verdict'), 'ENTER: the report rendered');
  assert.match(body.innerHTML, /proxy returned 503 &lt;b&gt;/);
  assert.match(body.innerHTML, /last successful report \(10m ago\)/);
});

test('a report fetch superseded by a newer open of the same session does not overwrite the newer render', async () => {
  const pending = [];
  const { open, body } = reportRig(() => new Promise((resolve) => pending.push(resolve)));
  const first = open('s');
  const second = open('s');
  assert.strictEqual(pending.length, 2, 'ENTER: two fetches in flight');
  pending[1]({ ok: true, data: { report_version: 4, verdict: { headline: 'NEW' } } });
  await second;
  assert.ok(body.innerHTML.includes('NEW'), 'ENTER: the newer fetch rendered');
  pending[0]({ ok: true, data: { report_version: 4, verdict: { headline: 'OLD' } } });
  await first;
  assert.ok(body.innerHTML.includes('NEW') && !body.innerHTML.includes('OLD'));
});

test('a v5 session report shows the summed per-line side-calls beside the unsubtracted request total', async () => {
  const { open, body } = reportRig(async () => ({ ok: true, data: { report_version: 5, scope: { requests: 19, turns: 4, agents: [{ line: 'main', requests: 12, sidecalls: 3, est_usd: 1 }, { line: 'subagent', requests: 3, sidecalls: 1, est_usd: 0.2 }] } } }));
  await open('s');
  assert.ok(body.innerHTML.includes('rep-verdict'), 'ENTER: the report rendered rather than the catch arm');
  assert.ok(body.innerHTML.includes('<div class="rep-scope">19 requests (4 side-calls) · 4 turns · 1 subagent line</div>'), body.innerHTML);
});

test('a v4 session report without sidecalls renders its scope line as before', async () => {
  const { open, body } = reportRig(async () => ({ ok: true, data: { report_version: 4, scope: { requests: 19, turns: 4, agents: [{ line: 'main', requests: 19, est_usd: 1 }] } } }));
  await open('s');
  assert.ok(body.innerHTML.includes('rep-verdict'), 'ENTER: the report rendered rather than the catch arm');
  assert.ok(body.innerHTML.includes('<div class="rep-scope">19 requests · 4 turns</div>'), body.innerHTML);
});

test('only numeric sidecalls fields count toward the side-call total', async () => {
  const { open, body } = reportRig(async () => ({ ok: true, data: { report_version: 5, scope: { agents: [{ line: 'main', sidecalls: 2 }, { line: 'subagent' }, { line: 'subagent', sidecalls: '7' }] } } }));
  await open('s');
  assert.ok(body.innerHTML.includes('rep-verdict'), 'ENTER: the report rendered rather than the catch arm');
  assert.ok(body.innerHTML.includes('<div class="rep-scope">0 requests (2 side-calls) · 0 turns · 2 subagent lines</div>'), body.innerHTML);
});
