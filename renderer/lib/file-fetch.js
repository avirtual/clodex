'use strict';

const FETCH_MAX = 64 * 1024 * 1024;
const FETCH_CHUNK = 1024 * 1024;

function decodeBase64(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const tooLarge = (size) => ({ ok: false, error: `File is ${Math.round(size / (1024 * 1024))} MB — larger than the ${FETCH_MAX / (1024 * 1024)} MB fetch limit` });

async function fetchWhole(peek, filePath, size) {
  if (Number(size) > FETCH_MAX) return tooLarge(Number(size));
  const parts = [];
  let total = 0;
  let image = null;
  for (;;) {
    const r = await Promise.resolve(peek(filePath, { raw: true, offset: total, length: FETCH_CHUNK }))
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'fetch failed' };
    if (r.size > FETCH_MAX) return tooLarge(r.size);
    if (total === 0) image = r.image || null;
    const chunk = decodeBase64(r.content);
    parts.push(chunk);
    total += chunk.length;
    if (!r.truncated || chunk.length === 0) break;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { ok: true, bytes, image };
}

module.exports = { fetchWhole, FETCH_MAX, FETCH_CHUNK };
