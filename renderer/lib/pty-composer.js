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

function ptyImagePasteHandler({ isWeb, readImages, upload, toast, nextImage, append, attached, drop, writePty }) {
  return async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (pasteKind(items) !== 'image') return;
    e.preventDefault();
    const web = isWeb();
    const images = await Promise.resolve().then(() => readImages(items)).catch(() => []);
    if (!web) {
      const n = nextImage();
      append([{ n, chip: imageChip(n), path: null, image: images[0] || null }]);
      writePty('\x16');
      return;
    }
    if (!images.length) {
      toast('No readable image on the clipboard.');
      return;
    }
    const added = images.map((image) => {
      const n = nextImage();
      return { n, chip: imageChip(n), path: null, image, pending: true };
    });
    append(added);
    const r = await Promise.resolve().then(() => upload(images)).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    if (!r || !r.ok) {
      drop(added.map((a) => a.n));
      toast(String((r && r.error) || 'Image upload failed.'));
      return;
    }
    attached(added.map((a, i) => ({ ...a, path: (r.paths && r.paths[i]) || null, pending: false })));
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
    thumb.className = it.pending ? 'seat-attachment seat-attachment-pending' : 'seat-attachment';
    thumb.title = it.pending ? 'Uploading…' : it.path ? 'Remove image' : 'Removes the mark; the CLI keeps the pasted image';
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
