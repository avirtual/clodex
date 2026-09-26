'use strict';

const SEAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SEAT_IMAGE_MAX = 5;
const SEAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SEAT_IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function validateSeatImages(images) {
  if (images === undefined || images === null) return { ok: true, images: [] };
  if (!Array.isArray(images)) return { ok: false, error: 'images must be an array' };
  if (images.length > SEAT_IMAGE_MAX) return { ok: false, error: `at most ${SEAT_IMAGE_MAX} images per message` };
  const out = [];
  for (const img of images) {
    if (!img || typeof img !== 'object') return { ok: false, error: 'image must be { mediaType, data }' };
    if (!SEAT_IMAGE_TYPES.has(img.mediaType)) return { ok: false, error: `unsupported image type: ${String(img.mediaType)}` };
    if (typeof img.data !== 'string' || !img.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(img.data)) return { ok: false, error: 'image data must be base64' };
    const padding = img.data.endsWith('==') ? 2 : img.data.endsWith('=') ? 1 : 0;
    if (Math.floor(img.data.length * 3 / 4) - padding > SEAT_IMAGE_MAX_BYTES) return { ok: false, error: 'image larger than 5 MB' };
    out.push({ mediaType: img.mediaType, data: img.data });
  }
  return { ok: true, images: out };
}

module.exports = { validateSeatImages, SEAT_IMAGE_TYPES, SEAT_IMAGE_MAX, SEAT_IMAGE_MAX_BYTES, SEAT_IMAGE_EXT };
