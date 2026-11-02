'use strict';

const KV_RE = /(?<![\w.-])([\w.-]+)(["']?\s*[=:]\s*)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|\S+)/gi;
const FLAG_RE = /(?:^|(?<=\s))(--?[\w.-]+)(\s+)(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|(?!-)\S+)/gi;
const KEY_WORD_RE = /(?:token|secret|password|authorization|bearer|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|passwd|auth)(?:[-_]|$)/i;
const URL_USERINFO_RE = /(:\/\/[^\s:/?#@]+):[^\s/?#@]*@/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const URL_QUERY_SECRET_RE = /([?&](?:token|key|sig|api[-_]?key|apikey|access_token|secret|password)=)[^&#\s]*/gi;

function isSecretName(name) {
  return KEY_WORD_RE.test(name.slice(name.lastIndexOf('.') + 1));
}

function maskNamed(text, re) {
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (isSecretName(m[1])) {
      out += text.slice(last, m.index) + m[1] + '=[redacted]';
      last = re.lastIndex;
    } else {
      re.lastIndex = m.index + m[1].length + m[2].length;
    }
  }
  return out + text.slice(last);
}

function maskSecrets(text) {
  return maskNamed(maskNamed(String(text), KV_RE), FLAG_RE)
    .replace(URL_USERINFO_RE, '$1:[redacted]@')
    .replace(URL_RE, (url) => url.replace(URL_QUERY_SECRET_RE, '$1[redacted]'));
}

module.exports = { maskSecrets };
