'use strict';

const KV_SECRET_RE = /([\w.-]*(?:token|secret|password|authorization|bearer))\b["']?\s*[=:]\s*(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|\S+)/gi;
const FLAG_SECRET_RE = /(?:^|(?<=\s))(--?[\w.-]*(?:token|secret|password|authorization|bearer))\b\s+(?:(?:bearer|basic)\s+)?(?:"[^"]*"|'[^']*'|(?!-)\S+)/gi;
const URL_USERINFO_RE = /(:\/\/[^\s:/?#@]+):[^\s/?#@]*@/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const URL_QUERY_SECRET_RE = /([?&](?:token|key|sig)=)[^&#\s]*/gi;

function maskSecrets(text) {
  return String(text)
    .replace(KV_SECRET_RE, '$1=[redacted]')
    .replace(FLAG_SECRET_RE, '$1=[redacted]')
    .replace(URL_USERINFO_RE, '$1:[redacted]@')
    .replace(URL_RE, (url) => url.replace(URL_QUERY_SECRET_RE, '$1[redacted]'));
}

module.exports = { maskSecrets };
