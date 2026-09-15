'use strict';

function directWebUrl(peerUrl, port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let u;
  try { u = new URL(String(peerUrl)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return `${u.protocol}//${u.hostname}:${port}`;
}

module.exports = { directWebUrl };
