'use strict';

const ECHO_BG = [240, 240, 240];
const ECHO_TEXT = [0, 0, 0];
const ECHO_PROMPT = [175, 175, 175];

const MATCHED_TRIPLETS = [ECHO_BG, ECHO_TEXT, ECHO_PROMPT];

const MAX_CARRY = 24;

const PARTIAL_CSI = /\x1b(?:\[[0-9;:]*)?$/;

function parseHex(v) {
  if (Array.isArray(v)) return v.length === 3 ? v.map(Number) : null;
  if (typeof v !== 'string') return null;
  let h = v.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function sameTriplet(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function isBgParam(p) {
  if (p === '49' || p === '48') return true;
  const n = Number(p);
  if (!Number.isInteger(n)) return false;
  return (n >= 40 && n <= 47) || (n >= 100 && n <= 107);
}

function readColonSpec(part) {
  const sub = part.split(':');
  if (sub.length < 2) return null;
  const lead = sub[0];
  if (lead !== '38' && lead !== '48') return null;
  if (sub[1] !== '2') return null;
  const rest = sub.slice(2).filter((s, i) => !(i === 0 && s === ''));
  if (rest.length !== 3) return null;
  const rgb = rest.map(Number);
  if (rgb.some((n) => !Number.isInteger(n))) return null;
  return { lead, rgb, spaced: sub[2] === '' };
}

function colonOut(lead, rgb, spaced) {
  return spaced ? `${lead}:2::${rgb.join(':')}` : `${lead}:2:${rgb.join(':')}`;
}

function rewriteBody(body, palette, state) {
  const parts = body.split(';');
  const out = [];
  let changed = false;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    const colon = p.indexOf(':') !== -1 ? readColonSpec(p) : null;
    if (colon) {
      const sub = substitute(colon.lead, colon.rgb, palette, state);
      if (sub) { out.push(colonOut(colon.lead, sub, colon.spaced)); changed = true; }
      else out.push(p);
      i += 1;
      continue;
    }
    if ((p === '38' || p === '48') && parts[i + 1] === '2' && parts.length >= i + 5) {
      const rgb = [Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4])];
      if (rgb.every((n) => Number.isInteger(n))) {
        const sub = substitute(p, rgb, palette, state);
        if (sub) { out.push(p, '2', String(sub[0]), String(sub[1]), String(sub[2])); changed = true; }
        else out.push(p, '2', parts[i + 2], parts[i + 3], parts[i + 4]);
        i += 5;
        continue;
      }
    }
    if ((p === '38' || p === '48' || p === '58') && parts[i + 1] === '5' && parts.length >= i + 3
        && Number.isInteger(Number(parts[i + 2]))) {
      if (p === '48') state.echo = false;
      out.push(p, '5', parts[i + 2]);
      i += 3;
      continue;
    }
    if (p === '58' && parts[i + 1] === '2' && parts.length >= i + 5
        && [parts[i + 2], parts[i + 3], parts[i + 4]].every((n) => Number.isInteger(Number(n)))) {
      out.push(p, '2', parts[i + 2], parts[i + 3], parts[i + 4]);
      i += 5;
      continue;
    }
    if (p === '' || p === '0' || isBgParam(p)) state.echo = false;
    out.push(p);
    i += 1;
  }
  return changed ? out.join(';') : null;
}

function substitute(lead, rgb, palette, state) {
  if (lead === '48') {
    if (sameTriplet(rgb, ECHO_BG)) {
      state.echo = true;
      return parseHex(palette && palette.bg);
    }
    state.echo = false;
    return null;
  }
  if (!state.echo) return null;
  if (sameTriplet(rgb, ECHO_TEXT)) return parseHex(palette && palette.fg);
  if (sameTriplet(rgb, ECHO_PROMPT)) return parseHex(palette && palette.prompt);
  return null;
}

function rewriteEchoSgr(chunk, palette, state) {
  const st = state || { echo: false, carry: '' };
  if (typeof chunk !== 'string') return { out: chunk, state: st };
  const input = (st.carry || '') + chunk;
  st.carry = '';
  const m = PARTIAL_CSI.exec(input);
  let body = input;
  if (m && m[0].length <= MAX_CARRY) {
    st.carry = m[0];
    body = input.slice(0, input.length - m[0].length);
  }
  if (!palette || !parseHex(palette.bg)) return { out: body, state: st };
  const out = body.replace(/\x1b\[([0-9;:]*)m/g, (whole, params) => {
    const next = rewriteBody(params, palette, st);
    return next === null ? whole : `\x1b[${next}m`;
  });
  return { out, state: st };
}

function createEchoRewriter(getPalette) {
  const state = { echo: false, carry: '' };
  return (chunk) => rewriteEchoSgr(chunk, getPalette(), state).out;
}

module.exports = { rewriteEchoSgr, createEchoRewriter, MATCHED_TRIPLETS, MAX_CARRY };
