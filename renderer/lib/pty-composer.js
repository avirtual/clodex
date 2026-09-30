'use strict';

const { bracketPaste } = require('./composer-voice');

const IMAGE_CHIP_RE = /\[Image #(\d+)\] ?/gu;

function ptyComposerWrites(text) {
  return [bracketPaste(text), '\r'];
}

function pasteKind(items) {
  const list = Array.from(items || []);
  if (list.some((it) => it && it.kind === 'string' && it.type === 'text/plain')) return 'text';
  if (list.some((it) => it && it.kind === 'file' && /^image\//u.test(String(it.type)))) return 'image';
  return 'none';
}

function imageChip(n) {
  return `[Image #${n}] `;
}

function expandImageChips(text, paths) {
  const map = paths || {};
  return String(text).replace(IMAGE_CHIP_RE, (chip, n) => {
    if (!Object.hasOwn(map, n)) return chip;
    return map[n] ? `Image #${n}: ${map[n]} ` : '';
  });
}

function ptyImagePasteHandler({ isWeb, readImages, upload, toast, nextImage, append, writePty }) {
  return async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (pasteKind(items) !== 'image') return;
    e.preventDefault();
    const web = isWeb();
    const images = await Promise.resolve().then(() => readImages(items)).catch(() => []);
    let paths = [null];
    if (web) {
      const r = images.length ? await Promise.resolve().then(() => upload(images)).catch((err) => ({ ok: false, error: String((err && err.message) || err) })) : { ok: false, error: 'No readable image on the clipboard.' };
      if (!r || !r.ok) {
        toast(String((r && r.error) || 'Image upload failed.'));
        return;
      }
      paths = r.paths;
    }
    append(paths.map((p, i) => {
      const n = nextImage();
      return { n, chip: imageChip(n), path: p, image: images[i] || null };
    }));
    if (!web) writePty('\x16');
  };
}

function removeImageChip(text, n) {
  return String(text).replace(new RegExp(`\\[Image #${Number(n)}\\] ?`, 'gu'), '');
}

function chippedImages(items, text) {
  const value = String(text);
  return (items || []).filter((it) => it && it.image && value.includes(imageChip(it.n).trim()));
}

function renderImageStrip(el, items, onRemove) {
  const doc = el.ownerDocument;
  el.replaceChildren();
  el.hidden = items.length === 0;
  for (const it of items) {
    const thumb = doc.createElement('div');
    thumb.className = 'seat-attachment';
    thumb.title = it.path ? 'Remove image' : 'Removes the mark; the CLI keeps the pasted image';
    const pic = doc.createElement('img');
    pic.src = `data:${it.image.mediaType};base64,${it.image.data}`;
    pic.alt = imageChip(it.n).trim();
    const rm = doc.createElement('button');
    rm.type = 'button';
    rm.className = 'seat-attachment-remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => onRemove(it.n));
    thumb.append(pic, rm);
    el.appendChild(thumb);
  }
}

module.exports = { ptyComposerWrites, pasteKind, imageChip, expandImageChips, ptyImagePasteHandler, removeImageChip, chippedImages, renderImageStrip };
