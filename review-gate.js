'use strict';

const NON_PLAIN = /[^\t\n\x20-\x7e]/;
const LETTER = /^\p{L}$/u;
const MARK = /^\p{M}$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;
const EMOJI = /^[\p{Emoji}\p{Extended_Pictographic}]$/u;
const EXT_PICT = /^\p{Extended_Pictographic}$/u;
const MATH_SYMBOL = /^\p{Sm}$/u;
const DECIMAL = /^\p{Nd}$/u;
const ASCII_DIGIT = /^[0-9]$/;

function scriptSet(prop, names) {
  return new RegExp(`^[${names.split(' ').map((n) => `\\p{${prop}=${n}}`).join('')}]$`, 'u');
}
function withMarks(names) { return { base: scriptSet('Script', names), mark: scriptSet('Script_Extensions', names) }; }
function same(re) { return { base: re, mark: re }; }

const RTL = scriptSet('Script', 'Arabic Hebrew Syriac Thaana Nko Samaritan Mandaic Adlam Hanifi_Rohingya Yezidi');
const ALM_RTL = scriptSet('Script', 'Arabic Syriac Thaana Hanifi_Rohingya');
const ZWNJ_SCRIPTS = withMarks('Arabic Syriac Nko Mongolian Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan');
const ZWJ_SCRIPTS = withMarks('Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan Arabic Syriac Tifinagh');
const ZWJ_NEXT_SCRIPTS = withMarks('Arabic Syriac Mongolian Nko');
const ZWSP_SCRIPT = scriptSet('Script', 'Khmer Thai Lao Myanmar');
const ZWSP_SCRIPTS = same(ZWSP_SCRIPT);
const MONGOLIAN = same(scriptSet('Script', 'Mongolian'));
const KHMER = same(scriptSet('Script', 'Khmer'));
const HIEROGLYPHS = same(scriptSet('Script', 'Egyptian_Hieroglyphs'));
const DUPLOYAN = same(scriptSet('Script', 'Duployan'));
const BRAHMI = scriptSet('Script', 'Brahmi');
const VS1_SCRIPTS = scriptSet('Script', 'Myanmar Phags_Pa Manichaean');
const FLAG_TAGS = ['gbeng', 'gbsct', 'gbwls'];
const FLAG_TAG_MAX = 5;
const RING = 16;

function gated(cp) {
  if (cp < 160) return (cp < 32 && cp !== 9 && cp !== 10) || cp >= 127;
  if (cp < 8192) return cp === 173 || cp === 847 || cp === 1564 || cp === 4447 || cp === 4448 || cp === 6068 || cp === 6069 || (cp >= 6155 && cp <= 6159);
  if (cp < 65536) {
    return (cp >= 8203 && cp <= 8207) || (cp >= 8232 && cp <= 8238) || (cp >= 8288 && cp <= 8303) || cp === 12644
      || (cp >= 65024 && cp <= 65039) || cp === 65279 || cp === 65440 || (cp >= 65520 && cp <= 65531);
  }
  return cp === 69759 || (cp >= 78896 && cp <= 78911) || cp === 94180 || (cp >= 113824 && cp <= 113827)
    || (cp >= 119155 && cp <= 119162) || (cp >= 917504 && cp <= 921599);
}

function lineBreak(cp) { return cp === 10 || cp === 11 || cp === 12 || cp === 13 || cp === 133 || cp === 8232 || cp === 8233; }
function is(re, cp) { return cp !== undefined && re.test(String.fromCodePoint(cp)); }
function letterOf(re, cp) { return is(LETTER, cp) && is(re, cp); }
function skinTone(cp) { return cp >= 127995 && cp <= 127999; }
function keycapBase(cp) { return (cp >= 48 && cp <= 57) || cp === 35 || cp === 42; }
function rtlLike(cp) { return cp === 1600 || is(RTL, cp); }

function flagTagEnd(cps, at) {
  let name = '';
  for (let t = at + 1; t <= at + FLAG_TAG_MAX + 1 && t < cps.length; t++) {
    const cp = cps[t].codePointAt(0);
    if (cp === 917631) return FLAG_TAGS.includes(name) ? t : -1;
    if (cp < 917601 || cp > 917626) return -1;
    name += String.fromCharCode(cp - 917504);
  }
  return -1;
}

function lineHasRtl(re, text, from) {
  for (let i = from; i < text.length;) {
    const cp = text.codePointAt(i);
    if (lineBreak(cp)) return false;
    const rtlBlock = (cp >= 1424 && cp <= 2303) || (cp >= 64285 && cp <= 65023) || (cp >= 65136 && cp <= 65279)
      || (cp >= 67584 && cp <= 69631) || (cp >= 124928 && cp <= 126975);
    if (rtlBlock && letterOf(re, cp)) return true;
    i += cp > 65535 ? 2 : 1;
  }
  return false;
}

class Kept {
  constructor() { this.ring = Array(RING).fill(0); this.next = 0; this.size = 0; this.lastWasHidden = false; }
  push(cp, hidden) {
    this.ring[this.next] = cp;
    this.next = (this.next + 1) % RING;
    if (this.size < RING) this.size++;
    this.lastWasHidden = hidden;
  }
  back(n) { return n >= this.size ? undefined : this.ring[(this.next - 1 - n + 2 * RING) % RING]; }
  lastIs(re) { return this.size > 0 && !this.lastWasHidden && is(re, this.back(0)); }
  scriptBefore(set, anyBase) {
    if (this.lastWasHidden) return false;
    for (let i = 0; i < this.size; i++) {
      const cp = this.back(i);
      if (is(MARK, cp)) { if (!is(set.mark, cp)) return false; continue; }
      return anyBase ? is(set.base, cp) : letterOf(set.base, cp);
    }
    return false;
  }
  sameDirectionBefore(next) {
    const letter = is(LETTER, next);
    if (!letter && !is(DECIMAL, next)) return false;
    for (let i = 0; i < this.size; i++) {
      const cp = this.back(i);
      if (gated(cp)) return true;
      if (is(MARK, cp)) continue;
      return letter ? is(LETTER, cp) && rtlLike(cp) === rtlLike(next) : is(DECIMAL, cp);
    }
    return this.size >= RING;
  }
}

function nextIs(cp, re) { return cp !== undefined && !gated(cp) && is(re, cp); }
function nextLetterOf(cp, set) { return cp !== undefined && !gated(cp) && letterOf(set.base, cp); }

function keeps(cp, next, kept, line) {
  const last = kept.back(0);
  const hidden = kept.lastWasHidden;
  switch (cp) {
    case 8204:
    case 8205: {
      let keep = kept.scriptBefore(cp === 8204 ? ZWNJ_SCRIPTS : ZWJ_SCRIPTS, false);
      if (!keep && cp === 8205) {
        let base = last;
        if (base !== undefined && (base === 65039 || skinTone(base))) {
          base = kept.back(1);
          if (base !== undefined && (base === 65039 || skinTone(base))) base = kept.back(2);
        }
        keep = last !== undefined && last !== 8205 && is(EXT_PICT, base) && nextIs(next, EXT_PICT);
      }
      if (!keep && last !== undefined && !hidden) {
        keep = cp === 8204
          ? nextLetterOf(next, ZWNJ_SCRIPTS) && !is(WHITE_SPACE, last) && !is(MARK, last)
          : nextLetterOf(next, ZWJ_NEXT_SCRIPTS) && !is(LETTER, last) && !is(DECIMAL, last) && !is(MARK, last);
      }
      return keep;
    }
    case 8203: {
      const after = kept.scriptBefore(ZWSP_SCRIPTS, true);
      const before = nextIs(next, ZWSP_SCRIPT) && !is(MARK, next);
      return (after && (before || nextIs(next, ASCII_DIGIT))) || (before && kept.lastIs(ASCII_DIGIT));
    }
    case 65038:
    case 65039:
      return last !== undefined && !hidden && ((last >= 169 && is(EMOJI, last)) || (keycapBase(last) && next === 8419));
    case 65024:
    case 65025:
    case 65026:
      return last !== undefined && !hidden && (is(HIEROGLYPHS.base, last)
        || (cp === 65024 && ((last >= 8704 && last <= 11007 && is(MATH_SYMBOL, last)) || is(VS1_SCRIPTS, last))));
    case 8206:
    case 8207:
    case 1564: {
      const rtl = cp === 1564 ? line.alm() : line.rtl();
      return rtl && !hidden && (next === undefined || lineBreak(next) || (!gated(next) && !is(MARK, next)))
        && !kept.sameDirectionBefore(next);
    }
    case 847:
      return kept.lastIs(MARK) || (!hidden && nextIs(next, MARK));
    case 6068:
    case 6069:
      return kept.scriptBefore(KHMER, false);
    case 6155: case 6156: case 6157: case 6158: case 6159:
      return kept.scriptBefore(MONGOLIAN, false) || (!hidden && nextLetterOf(next, MONGOLIAN));
    case 69759:
      return kept.lastIs(BRAHMI) && nextIs(next, BRAHMI);
    default:
      if (cp >= 78896 && cp <= 78911) return kept.scriptBefore(HIEROGLYPHS, false) || (!hidden && nextLetterOf(next, HIEROGLYPHS));
      if (cp >= 113824 && cp <= 113827) return kept.scriptBefore(DUPLOYAN, false) || (!hidden && nextLetterOf(next, DUPLOYAN));
      return false;
  }
}

function stripReviewGated(text) {
  if (typeof text !== 'string' || !NON_PLAIN.test(text)) return text;
  const out = [];
  const kept = new Kept();
  let from = 0;
  let lineStart = 0;
  let rtl;
  let alm;
  const line = {
    rtl: () => (rtl === undefined ? (rtl = lineHasRtl(RTL, text, lineStart)) : rtl),
    alm: () => (alm === undefined ? (alm = lineHasRtl(ALM_RTL, text, lineStart)) : alm),
  };
  for (let d = 0; d < text.length;) {
    const cp = text.codePointAt(d);
    const end = d + (cp > 65535 ? 2 : 1);
    if (!gated(cp)) {
      if (cp === 10) { lineStart = end; rtl = undefined; alm = undefined; } else if (cp === 127988) {
        const cps = Array.from(text.slice(d, d + 2 * (FLAG_TAG_MAX + 2)));
        const last = flagTagEnd(cps, 0);
        if (last !== -1) {
          kept.push(cp, false);
          d = end;
          for (let k = 1; k <= last; k++) { kept.push(cps[k].codePointAt(0), true); d += cps[k].length; }
          continue;
        }
      }
      kept.push(cp, false);
      d = end;
      continue;
    }
    if (lineBreak(cp)) {
      const crlf = cp === 13 && text.charCodeAt(end) === 10;
      if (d > from) out.push(text.slice(from, d));
      from = end;
      if (!crlf) { out.push('\n'); kept.push(10, false); lineStart = end; rtl = undefined; alm = undefined; }
      d = end;
      continue;
    }
    const next = end < text.length ? text.codePointAt(end) : undefined;
    if (keeps(cp, next, kept, line)) kept.push(cp, true);
    else { if (d > from) out.push(text.slice(from, d)); from = end; }
    d = end;
  }
  if (from === 0) return text;
  out.push(text.slice(from));
  return out.join('');
}

const LINE_BREAK = /(\r\n|[\n\v\f\r\x85\u2028\u2029])/;
const SENDER_LINE = /^\[agent:from\b/i;

function defuseSenderLines(text) {
  const parts = String(text).split(LINE_BREAK);
  for (let i = 0; i < parts.length; i += 2) {
    const bare = parts[i].replace(/[\p{C}\p{M}\p{Default_Ignorable_Code_Point}]/gu, '').replace(/^\s+/, '');
    if (SENDER_LINE.test(bare)) parts[i] = `> ${parts[i]}`;
  }
  return parts.join('');
}

function defangTeammateTag(text) {
  return String(text).replace(/<(\/?)(teammate)-(message)\b/gi, '<$1$2\u2011$3');
}

module.exports = { stripReviewGated, defuseSenderLines, defangTeammateTag };
