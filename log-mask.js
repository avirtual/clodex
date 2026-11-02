'use strict';

const KV_NAME_RE = /(?<![\w.-])([\w.-]+)(["']?\s*[=:]\s*)/g;
const KV_VALUE_RE = /(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|\S+)/iy;
const FLAG_NAME_RE = /(?:^|(?<=\s))(--?[\w.-]+)(\s+)/g;
const FLAG_VALUE_RE = /(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|(?!-)\S+)/iy;
const KEY_WORD_RE = /(?:token|secret|password|authorization|bearer|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|passwd|auth)(?:[-_]|$)/i;
const URL_USERINFO_RE = /(:\/\/[^\s:/?#@]+):[^\s/?#@]*@/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const URL_QUERY_SECRET_RE = /([?&](?:token|key|sig|api[-_]?key)=)[^&#\s]*/gi;

function isSecretName(name) {
  return KEY_WORD_RE.test(name.slice(name.lastIndexOf('.') + 1));
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

function maskSecrets(text) {
  return maskNamed(maskNamed(String(text), KV_NAME_RE, KV_VALUE_RE), FLAG_NAME_RE, FLAG_VALUE_RE)
    .replace(URL_USERINFO_RE, '$1:[redacted]@')
    .replace(URL_RE, (url) => url.replace(URL_QUERY_SECRET_RE, '$1[redacted]'));
}

module.exports = { maskSecrets };
