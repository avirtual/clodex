'use strict';

const DEFAULT_WIRESCOPE_PORT = 7800;
const DEFAULT_REMOTE_PORT = 7900;
const WIRESCOPE_PORT_ENV = 'CLODEX_WIRESCOPE_PORT';
const REMOTE_PORT_ENV = 'CLODEX_REMOTE_PORT';

const warned = new Set();

function coercePort(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^[0-9]{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

function resolveServicePort(key, envValue, persisted, fallback, warn) {
  const settled = coercePort(persisted) ?? fallback;
  if (envValue == null) return settled;
  const raw = String(envValue);
  if (!raw.trim()) return settled;
  const port = coercePort(raw);
  if (port != null) return port;
  const mark = `${key}=${raw}`;
  if (typeof warn === 'function' && !warned.has(mark)) {
    warned.add(mark);
    try { warn(`${key}="${raw}" is not a port in 1–65535 — keeping ${settled}`); } catch {}
  }
  return settled;
}

function resolveWirescopePort(settings, env = process.env, warn) {
  return resolveServicePort(
    WIRESCOPE_PORT_ENV, env ? env[WIRESCOPE_PORT_ENV] : null,
    settings ? settings.wirescopePort : null, DEFAULT_WIRESCOPE_PORT, warn,
  );
}

function resolveRemotePort(settings, env = process.env, warn) {
  return resolveServicePort(
    REMOTE_PORT_ENV, env ? env[REMOTE_PORT_ENV] : null,
    settings ? settings.remotePort : null, DEFAULT_REMOTE_PORT, warn,
  );
}

function resolveProxyUrl(settings, env = process.env, warn) {
  const url = settings && typeof settings.proxyUrl === 'string' ? settings.proxyUrl : '';
  const raw = env ? env[WIRESCOPE_PORT_ENV] : null;
  if (raw == null || !String(raw).trim()) return url;
  const port = resolveWirescopePort(settings, env, warn);
  let u;
  try { u = new URL(url); } catch { return url; }
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return url;
  const at = url.indexOf(u.host);
  if (at < 0) return url;
  return `${u.protocol}//${u.hostname}:${port}${url.slice(at + u.host.length)}`;
}

module.exports = {
  DEFAULT_WIRESCOPE_PORT, DEFAULT_REMOTE_PORT,
  WIRESCOPE_PORT_ENV, REMOTE_PORT_ENV,
  coercePort, resolveServicePort, resolveWirescopePort, resolveRemotePort,
  resolveProxyUrl,
};
