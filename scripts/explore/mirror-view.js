'use strict';

const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'cli-captures');
const TOOL_HEADER = /^⏺ [A-Za-z][\w.-]*(\(| - )/;
const VERBOSE = /Showing detailed transcript/;

function opts(argv) {
  const o = { view: 40, rows: 0, dynamic: 'auto', floor: 10, windowMs: 1500, settleMs: 8, out: '', quiet: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--view') o.view = +argv[++i];
    else if (a === '--rows') o.rows = +argv[++i];
    else if (a === '--dynamic') o.dynamic = argv[++i];
    else if (a === '--floor') o.floor = +argv[++i];
    else if (a === '--settle') o.settleMs = +argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else pos.push(a);
  }
  o.name = pos[0];
  return o;
}

function resolve(prefix) {
  const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.events.jsonl')).map((f) => f.slice(0, -13)).sort();
  const hit = all.find((n) => n === prefix) || all.find((n) => n.startsWith(prefix + '-'));
  if (!hit) throw new Error('no capture ' + prefix);
  return hit;
}

function lineText(buf, i) {
  const l = buf.getLine(i);
  return l ? l.translateToString(true) : '';
}

function collapse(buf, from, to) {
  const rows = [];
  let blocks = 0;
  let removed = 0;
  let i = from;
  while (i < to) {
    const t = lineText(buf, i);
    if (!TOOL_HEADER.test(t)) { rows.push({ src: i, text: t }); i++; continue; }
    rows.push({ src: i, text: t, header: true });
    i++;
    while (i < to && buf.getLine(i).isWrapped) { rows.push({ src: i, text: lineText(buf, i), header: true }); i++; }
    let j = i;
    while (j < to) {
      const u = lineText(buf, j);
      if (/^ {2}⎿/.test(u) || /^ {5}/.test(u) || (buf.getLine(j).isWrapped && j > i)) { j++; continue; }
      break;
    }
    if (j > i) { blocks++; removed += j - i; }
    i = j;
  }
  return { rows, blocks, removed };
}

function buildView(term, o, dyn) {
  const buf = term.buffer.active;
  const cursor = buf.baseY + buf.cursorY;
  let bottom = cursor;
  for (let i = buf.length - 1; i > cursor; i--) if (lineText(buf, i).trim()) { bottom = i; break; }
  let screenVerbose = false;
  for (let i = buf.baseY; i < buf.baseY + term.rows; i++) if (VERBOSE.test(lineText(buf, i))) { screenVerbose = true; break; }
  let D = o.dynamic === 'auto' ? Math.max(o.floor, bottom - dyn.reach + 1) : +o.dynamic;
  D = Math.max(D, bottom - cursor + 1);
  const dynTop = Math.max(0, bottom - D + 1);
  const dynRows = [];
  for (let i = dynTop; i <= bottom; i++) dynRows.push({ src: i, text: lineText(buf, i) });
  const room = o.view - dynRows.length;
  if (room <= 0) return { rows: dynRows.slice(-o.view), D, blocks: 0, removed: 0, verbose: screenVerbose, nativeTop: bottom - o.view + 1 };
  const c = screenVerbose ? { rows: [], blocks: 0, removed: 0 } : collapse(buf, 0, dynTop);
  if (screenVerbose) for (let i = 0; i < dynTop; i++) c.rows.push({ src: i, text: lineText(buf, i) });
  const above = c.rows.slice(-room);
  return { rows: above.concat(dynRows), D, blocks: c.blocks, removed: c.removed, verbose: screenVerbose, nativeTop: Math.max(0, bottom - o.view + 1) };
}

function check(view, buf) {
  const bad = [];
  let last = -1;
  const seen = new Set();
  for (const r of view.rows) {
    if (seen.has(r.src)) bad.push('dup src ' + r.src);
    if (r.src <= last) bad.push('order ' + r.src);
    seen.add(r.src);
    last = r.src;
    if (lineText(buf, r.src) !== r.text) bad.push('stale ' + r.src);
  }
  return bad;
}

function write(term, data) { return new Promise((r) => term.write(data, r)); }

async function main() {
  const o = opts(process.argv.slice(2));
  const name = resolve(o.name);
  const events = fs.readFileSync(path.join(DIR, name + '.events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sp = events.find((e) => e.mark && e.mark.startsWith('spawn:'));
  const [cols, capRows] = sp ? sp.mark.slice(6).split('x').map(Number) : [120, 40];
  const rows = o.rows || capRows;
  const fixedRows = Boolean(o.rows);
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  let hidden = false;
  let reachThisChunk = Infinity;
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (p) => { if (p[0] === 25) hidden = true; return false; });
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (p) => { if (p[0] === 25) hidden = false; return false; });
  const up = (n) => { const b = term.buffer.active; reachThisChunk = Math.min(reachThisChunk, b.baseY + b.cursorY - n); return false; };
  term.parser.registerCsiHandler({ final: 'A' }, (p) => up(p[0] || 1));
  term.parser.registerCsiHandler({ final: 'H' }, (p) => { const b = term.buffer.active; reachThisChunk = Math.min(reachThisChunk, b.baseY + (p[0] || 1) - 1); return false; });
  const reaches = [];
  const frames = [];
  const timings = [];
  let midFrame = 0;
  let chunks = 0;
  let violations = [];
  let maxBlocks = 0;
  let maxRemoved = 0;
  let maxReachGain = 0;
  let lastKey = '';
  let lastMark = '';
  let verboseFrames = 0;
  const data = events.filter((e) => e.bytes);
  const nextT = new Map(data.map((e, i) => [e, i + 1 < data.length ? data[i + 1].t : Infinity]));
  for (const e of events) {
    if (e.mark) {
      lastMark = e.mark;
      const r = /^resize:(\d+)x(\d+)/.exec(e.mark);
      if (r && !fixedRows) term.resize(+r[1], +r[2]);
      continue;
    }
    chunks++;
    reachThisChunk = Infinity;
    const t0 = process.hrtime.bigint();
    await write(term, Buffer.from(e.bytes, 'base64'));
    const t1 = process.hrtime.bigint();
    if (reachThisChunk !== Infinity) reaches.push({ t: e.t, row: reachThisChunk });
    while (reaches.length && reaches[0].t < e.t - o.windowMs) reaches.shift();
    const dyn = { reach: reaches.length ? Math.min(...reaches.map((r) => r.row)) : Infinity };
    if (hidden && nextT.get(e) - e.t <= o.settleMs) { midFrame++; timings.push({ parse: Number(t1 - t0) / 1e6, view: 0 }); continue; }
    const view = buildView(term, o, dyn);
    const t2 = process.hrtime.bigint();
    timings.push({ parse: Number(t1 - t0) / 1e6, view: Number(t2 - t1) / 1e6 });
    violations = violations.concat(check(view, term.buffer.active).map((v) => `${e.t}ms ${v}`));
    if (view.verbose) verboseFrames++;
    maxBlocks = Math.max(maxBlocks, view.blocks);
    maxRemoved = Math.max(maxRemoved, view.removed);
    if (view.rows.length) maxReachGain = Math.max(maxReachGain, view.nativeTop - view.rows[0].src);
    const text = view.rows.map((r) => r.text.replace(/\s+$/, '')).join('\n');
    if (text === lastKey) continue;
    lastKey = text;
    frames.push(`=== frame ${frames.length} t=${e.t}ms after [${lastMark}] D=${view.D} collapsedBlocks=${view.blocks} rowsFreed=${view.removed} verbose=${view.verbose}\n${text}`);
  }
  const out = o.out || path.join(DIR, `${name}.view${o.view}${fixedRows ? '.rows' + rows : ''}.frames`);
  fs.writeFileSync(out, frames.join('\n') + '\n');
  const views = timings.filter((t) => t.view > 0);
  const stat = (arr) => { const s = [...arr].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] || 0; return { mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), p50: q(0.5), p95: q(0.95), max: s[s.length - 1] || 0 }; };
  const bulk = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  const b0 = process.hrtime.bigint();
  for (const e of data.slice(0, -1)) bulk.write(Buffer.from(e.bytes, 'base64'));
  await write(bulk, Buffer.from(data[data.length - 1].bytes, 'base64'));
  const bulkMs = Number(process.hrtime.bigint() - b0) / 1e6;
  const res = {
    capture: name, headless: `${cols}x${rows}${fixedRows ? ' (fixed)' : ''}`, view: o.view, dynamic: o.dynamic,
    chunks, chunksEndingMidFrame: midFrame, framesWritten: frames.length, verboseFrames,
    maxCollapsedBlocks: maxBlocks, maxRowsFreed: maxRemoved, maxReachGainRows: maxReachGain,
    violations: violations.length, firstViolations: violations.slice(0, 5),
    bulkParseMsTotal: bulkMs, bulkParseMsPerChunk: bulkMs / data.length, bulkBytes: data.reduce((a, e) => a + Buffer.from(e.bytes, 'base64').length, 0),
    parseMs: stat(timings.map((t) => t.parse)), viewMs: stat(views.map((t) => t.view)), out: path.relative(process.cwd(), out),
  };
  process.stdout.write((o.quiet ? JSON.stringify(res) : JSON.stringify(res, null, 2)) + '\n');
}

main();
