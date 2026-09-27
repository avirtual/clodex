'use strict';

const { PASTE_OPEN, PASTE_CLOSE } = require('./composer-voice');

const IMAGE_CHIP_RE = /\[Image #(\d+)\] ?/gu;

function ptyComposerWrites(text) {
  return [`${PASTE_OPEN}${String(text)}${PASTE_CLOSE}`, '\r'];
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
  return String(text).replace(IMAGE_CHIP_RE, (chip, n) => (map[n] ? `Image #${n}: ${map[n]} ` : ''));
}

function ptyImagePasteHandler({ isWeb, readImages, upload, toast, nextImage, append, writePty }) {
  return async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (pasteKind(items) !== 'image') return;
    e.preventDefault();
    const web = isWeb();
    let paths = [null];
    if (web) {
      const images = await readImages(items);
      const r = images.length ? await upload(images) : { ok: false, error: 'No readable image on the clipboard.' };
      if (!r || !r.ok) {
        toast(String((r && r.error) || 'Image upload failed.'));
        return;
      }
      paths = r.paths;
    }
    append(paths.map((p) => {
      const n = nextImage();
      return { n, chip: imageChip(n), path: p };
    }));
    if (!web) writePty('\x16');
  };
}

module.exports = { ptyComposerWrites, pasteKind, imageChip, expandImageChips, ptyImagePasteHandler };
