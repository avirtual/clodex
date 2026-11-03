'use strict';

const KV_NAME_RE = /(?<![\w.-])([\w.-]+)(["']?\s*[=:]\s*)/g;
const KV_VALUE_RE = /(?:(?:bearer|basic)\s+)?(?:(?:"[^"]*"|'[^']*')[^\s&#,;}\])]*|\S+)/iy;
const FLAG_NAME_RE = /(?:^|(?<=\s))(--?[\w.-]+)(\s+)/g;
const FLAG_VALUE_RE = /(?:(?:bearer|basic)\s+)?(?:(?:"[^"]*"|'[^']*')[^\s&#,;}\])]*|(?!-)\S+)/iy;
const KEY_WORD_RE = /(?:token|secret|password|authorization|bearer|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|passwd|auth)(?:[-_]|$)/i;
const URL_USERINFO_RE = /(:\/\/[^\s:/?#@]+):[^\s/?#@]*@/g;
const URL_CANDIDATE_RE = /(?<![a-z0-9+.-])([a-z0-9+.-]+):\/\//gi;
const URL_TAIL_RE = /\S*/y;
const ASCII_LETTER_RE = /[a-z]/i;
const WORD_CHAR_RE = /\w/;
const URL_QUERY_PARAM_RE = /([?&]([\w.-]+)=)[^&#\s]*/g;
const URL_KEY_SIG_RE = /(?:^|[-_.])(?:key|sig)$/i;

function isSecretName(name) {
  return KEY_WORD_RE.test(name.slice(name.lastIndexOf('.') + 1));
}

function maskQueryParam(param, head, name) {
  return isSecretName(name) || URL_KEY_SIG_RE.test(name) ? head + '[redacted]' : param;
}

function maskNamed(text, nameRe, valueRe) {
  nameRe.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = nameRe.exec(text)) !== null) {
    if (!isSecretName(m[1])) continue;
    valueRe.lastIndex = nameRe.lastIndex;
    if (valueRe.exec(text) === null) continue;
    out += text.slice(last, m.index) + m[1] + '=[redacted]';
    last = nameRe.lastIndex = valueRe.lastIndex;
  }
  return out + text.slice(last);
}

function schemeStart(text, at, run) {
  for (let i = 0; i < run.length; i++) {
    const prev = i === 0 ? text[at - 1] : run[i - 1];
    if (ASCII_LETTER_RE.test(run[i]) && (prev === undefined || !WORD_CHAR_RE.test(prev))) return i;
  }
  return -1;
}

function maskUrls(text) {
  URL_CANDIDATE_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = URL_CANDIDATE_RE.exec(text)) !== null) {
    const start = schemeStart(text, m.index, m[1]);
    if (start < 0) {
      URL_CANDIDATE_RE.lastIndex = m.index + m[1].length + 1;
      continue;
    }
    URL_TAIL_RE.lastIndex = URL_CANDIDATE_RE.lastIndex;
    const url = m[0].slice(start) + URL_TAIL_RE.exec(text)[0];
    out += text.slice(last, m.index + start) + url.replace(URL_QUERY_PARAM_RE, maskQueryParam);
    last = URL_CANDIDATE_RE.lastIndex = URL_TAIL_RE.lastIndex;
  }
  return out + text.slice(last);
}

function maskSecrets(text) {
  const masked = maskNamed(maskNamed(String(text), KV_NAME_RE, KV_VALUE_RE), FLAG_NAME_RE, FLAG_VALUE_RE)
    .replace(URL_USERINFO_RE, '$1:[redacted]@');
  return maskUrls(masked);
}

module.exports = { maskSecrets };
