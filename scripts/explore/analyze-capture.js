'use strict';

const fs = require('fs');
const path = require('path');
const { Terminal } = require('@xterm/headless');

const DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'cli-captures');

function loadEvents(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function byteCounts(raw) {
  const s = raw.toString('latin1');
  const csi = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let maxUpParam = 0;
  let maxUpRun = 0;
  let run = 0;
  const re = /\x1b\[([?>=<]?)([0-9;:]*)([ -\/]*[@-~])|\x1b\]([0-9]*)[;]?[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b([^\[\]])|(\n)|([^\x1b\n]+)/g;
  const esc = new Map();
  const osc = new Map();
  let lf = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m[3] !== undefined) {
      const [, priv, args, fin] = m;
      const key = priv || !'ABCDEFGHJKLMPSTXdfrm'.includes(fin) ? priv + args + fin : fin;
      bump(csi, key);
      if (!priv && fin === 'J') bump(csi, (args || '0') + 'J');
      if (!priv && fin === 'A') {
        const n = parseInt(args || '1', 10);
        maxUpParam = Math.max(maxUpParam, n);
        run += n;
        maxUpRun = Math.max(maxUpRun, run);
      } else if (!priv && fin === 'F') {
        run += parseInt(args || '1', 10);
        maxUpRun = Math.max(maxUpRun, run);
      } else if (!priv && 'BEHf'.includes(fin)) {
        run = 0;
      }
    } else if (m[4] !== undefined) {
      bump(osc, 'OSC ' + m[4]);
    } else if (m[6] !== undefined) {
      bump(esc, 'ESC ' + m[6]);
    } else if (m[7] !== undefined) {
      lf++;
      run = 0;
    }
  }
  const get = (k) => csi.get(k) || 0;
  return {
    bytes: raw.length,
    altScreen1049h: get('?1049h'), altScreen47h: get('?47h') + get('?1047h'),
    sync2026h: get('?2026h'), sync2026l: get('?2026l'),
    cursorUp: get('A'), cursorDown: get('B'), maxCursorUpParam: maxUpParam, maxCumulativeUpRun: maxUpRun,
    cup: get('H') + get('f'), vpa: get('d'), cha: get('G'),
    eraseLineK: get('K'), eraseDisplayJ: get('J'), ed2: get('2J'), ed3: get('3J'),
    decstbm: get('r'), scrollUpS: get('S'), scrollDownT: get('T'),
    escIndexD: esc.get('ESC D') || 0, escNextLineE: esc.get('ESC E') || 0, escReverseIndexM: esc.get('ESC M') || 0,
    lineFeeds: lf,
    mouseOn: ['?1000h', '?1002h', '?1003h', '?1006h', '?1015h', '?1016h'].reduce((a, k) => a + get(k), 0),
    mouseOff: ['?1000l', '?1002l', '?1003l', '?1006l', '?1015l', '?1016l'].reduce((a, k) => a + get(k), 0),
    bracketedPasteOn: get('?2004h'), bracketedPasteOff: get('?2004l'),
    focusOn: get('?1004h'), colorSchemeNotify2031: get('?2031h'), kittyKbd: get('>1u') + get('?u') + get('<u'),
    csi: Object.fromEntries([...csi.entries()].sort((a, b) => b[1] - a[1])),
    esc: Object.fromEntries(esc), osc: Object.fromEntries(osc),
  };
}

function snapshot(term) {
  const b = term.buffer.active;
  const out = new Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.getLine(i).translateToString(true);
  return out;
}

function lastNonEmpty(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i;
  return 0;
}

function write(term, data) { return new Promise((r) => term.write(data, r)); }

async function replay(events, cols, rows) {
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  let chunkMinTarget = Infinity;
  let clearedInChunk = false;
  const track = (n) => { const b = term.buffer.active; chunkMinTarget = Math.min(chunkMinTarget, b.baseY + b.cursorY - n); return false; };
  term.parser.registerCsiHandler({ final: 'A' }, (p) => track(p[0] || 1));
  term.parser.registerCsiHandler({ final: 'F' }, (p) => track(p[0] || 1));
  term.parser.registerCsiHandler({ final: 'H' }, (p) => { const b = term.buffer.active; chunkMinTarget = Math.min(chunkMinTarget, b.baseY + ((p[0] || 1) - 1)); return false; });
  term.parser.registerCsiHandler({ final: 'J' }, (p) => { if (p[0] === 2 || p[0] === 3) clearedInChunk = true; return false; });
  let prev = snapshot(term);
  let maxUpDepth = 0;
  let maxChangeDepth = 0;
  let changeOutsideUpReach = 0;
  const clears = [];
  const deep = [];
  let lastMark = '';
  let chunks = 0;
  for (const e of events) {
    if (e.mark) {
      lastMark = e.mark;
      const r = /^resize:(\d+)x(\d+)/.exec(e.mark);
      if (r && (+r[1] !== term.cols || +r[2] !== term.rows)) { term.resize(+r[1], +r[2]); prev = snapshot(term); }
      continue;
    }
    chunks++;
    const cursorBefore = term.buffer.active.baseY + term.buffer.active.cursorY;
    const hwBefore = Math.max(lastNonEmpty(prev), cursorBefore);
    chunkMinTarget = Infinity;
    clearedInChunk = false;
    await write(term, Buffer.from(e.bytes, 'base64'));
    const cur = snapshot(term);
    if (clearedInChunk) { clears.push({ t: e.t, after: lastMark }); prev = cur; continue; }
    if (chunkMinTarget !== Infinity) maxUpDepth = Math.max(maxUpDepth, hwBefore - chunkMinTarget);
    const reach = Math.min(chunkMinTarget, cursorBefore);
    for (let i = 0; i < Math.min(prev.length, cur.length); i++) {
      if (prev[i] === cur[i]) continue;
      if (!prev[i].trim()) continue;
      const depth = hwBefore - i;
      maxChangeDepth = Math.max(maxChangeDepth, depth);
      if (i < reach) { changeOutsideUpReach++; if (deep.length < 5) deep.push({ t: e.t, line: i, depth, was: prev[i].slice(0, 60), now: cur[i].slice(0, 60) }); }
    }
    prev = cur;
  }
  return { chunks, maxUpDepthFromBottom: maxUpDepth, maxRewriteDepthFromBottom: maxChangeDepth, rewritesAboveCursorReach: changeOutsideUpReach, examples: deep, fullClears: clears, finalScrollback: term.buffer.active.baseY };
}

async function analyze(name) {
  const raw = fs.readFileSync(path.join(DIR, name + '.raw'));
  const events = loadEvents(path.join(DIR, name + '.events.jsonl'));
  const sp = events.find((e) => e.mark && e.mark.startsWith('spawn:'));
  const [cols, rows] = sp ? sp.mark.slice(6).split('x').map(Number) : [120, 40];
  return { name, size: cols + 'x' + rows, ...byteCounts(raw), replay: await replay(events, cols, rows) };
}

(async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const names = args.filter((a) => !a.startsWith('--'));
  const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.raw')).map((f) => f.slice(0, -4)).sort();
  const list = names.length ? all.filter((n) => names.some((p) => n === p || n.startsWith(p + '-'))) : all;
  const results = [];
  for (const n of list) results.push(await analyze(n));
  if (json) { process.stdout.write(JSON.stringify(results, null, 2) + '\n'); return; }
  const keys = ['size', 'bytes', 'altScreen1049h', 'altScreen47h', 'sync2026h', 'cursorUp', 'maxCursorUpParam', 'maxCumulativeUpRun', 'cup', 'eraseLineK', 'eraseDisplayJ', 'ed2', 'ed3', 'decstbm', 'scrollUpS', 'escIndexD', 'escReverseIndexM', 'lineFeeds', 'mouseOn', 'mouseOff', 'bracketedPasteOn', 'focusOn', 'kittyKbd'];
  process.stdout.write(['metric', ...results.map((r) => r.name.split('-')[0] + (r.size.endsWith('x40') ? '' : r.size.split('x')[1]) + (r.name.endsWith('-replies') ? 'R' : ''))].join('\t') + '\n');
  for (const k of keys) process.stdout.write([k, ...results.map((r) => r[k])].join('\t') + '\n');
  for (const k of ['chunks', 'maxUpDepthFromBottom', 'maxRewriteDepthFromBottom', 'rewritesAboveCursorReach', 'finalScrollback']) process.stdout.write([k, ...results.map((r) => r.replay[k])].join('\t') + '\n');
  process.stdout.write(['fullClears', ...results.map((r) => r.replay.fullClears.length)].join('\t') + '\n');
  for (const r of results) {
    for (const c of r.replay.fullClears) process.stdout.write(`${r.name}: full clear at ${c.t}ms after [${c.after}]\n`);
    for (const x of r.replay.examples) process.stdout.write(`${r.name}: rewrite above reach at ${x.t}ms line ${x.line} depth ${x.depth}: ${JSON.stringify(x.was)} -> ${JSON.stringify(x.now)}\n`);
  }
  const maxUp = Math.max(...results.map((r) => r.replay.maxUpDepthFromBottom));
  process.stdout.write(`maxCursorUp (deepest row any cursor-up reached, from the bottom of drawn content, across captures): ${maxUp}\n`);
})();
