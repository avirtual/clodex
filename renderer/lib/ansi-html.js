'use strict';

const BASIC = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
  [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
  [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];

const ESCAPE_RE = /\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[P^_][\s\S]*?(?:\x1b\\|$)|\x1b[ -/]*[0-~]?|\x9b[0-?]*[ -/]*[@-~]/g;

function rgb([r, g, b]) { return `rgb(${r},${g},${b})`; }

function color256(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return rgb(BASIC[n]);
  if (n < 232) {
    const i = n - 16;
    return rgb([CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]]);
  }
  const v = 8 + (n - 232) * 10;
  return rgb([v, v, v]);
}

function byte(n) { return Number.isInteger(n) && n >= 0 && n <= 255; }

function initialState() {
  return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };
}

function extendedColor(params, i) {
  const mode = params[i + 1];
  if (mode === 5) return { color: color256(params[i + 2]), skip: 2 };
  if (mode === 2) {
    const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
    return { color: byte(r) && byte(g) && byte(b) ? rgb([r, g, b]) : null, skip: 4 };
  }
  return { color: null, skip: params.length };
}

function applySgr(state, paramText) {
  const params = paramText === '' ? [0] : paramText.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(state, initialState());
    else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 22) { state.bold = false; state.dim = false; }
    else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p >= 30 && p <= 37) state.fg = rgb(BASIC[p - 30]);
    else if (p >= 90 && p <= 97) state.fg = rgb(BASIC[p - 90 + 8]);
    else if (p === 39) state.fg = null;
    else if (p >= 40 && p <= 47) state.bg = rgb(BASIC[p - 40]);
    else if (p >= 100 && p <= 107) state.bg = rgb(BASIC[p - 100 + 8]);
    else if (p === 49) state.bg = null;
    else if (p === 38 || p === 48) {
      const { color, skip } = extendedColor(params, i);
      if (p === 38) state.fg = color;
      else state.bg = color;
      i += skip;
    }
  }
}

function styleOf(state) {
  const parts = [];
  if (state.bold) parts.push('font-weight:bold');
  if (state.dim) parts.push('opacity:0.6');
  if (state.italic) parts.push('font-style:italic');
  if (state.underline) parts.push('text-decoration:underline');
  if (state.fg) parts.push(`color:${state.fg}`);
  if (state.bg) parts.push(`background-color:${state.bg}`);
  return parts.join(';');
}

function ansiRuns(input) {
  const text = String(input == null ? '' : input);
  const runs = [];
  const state = initialState();
  const push = (chunk) => {
    const clean = chunk.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!clean) return;
    const style = styleOf(state);
    const last = runs[runs.length - 1];
    if (last && last.style === style) last.text += clean;
    else runs.push({ text: clean, style });
  };
  let at = 0;
  ESCAPE_RE.lastIndex = 0;
  let m;
  while ((m = ESCAPE_RE.exec(text))) {
    push(text.slice(at, m.index));
    at = ESCAPE_RE.lastIndex;
    if (m[3] === 'm' && !m[2] && /^[0-9;:]*$/.test(m[1])) applySgr(state, m[1]);
  }
  push(text.slice(at));
  return runs;
}

module.exports = { ansiRuns, color256 };
