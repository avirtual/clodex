'use strict';

const { bracketPaste } = require('./composer-voice');
const { fmtBytes } = require('./format');

const ATTACH_CHIP_RE = /\[(Image|File) #(\d+)\] ?/gu;
const CHIP_LABEL = { image: 'Image', file: 'File' };
const FILE_NAME_MAX = 24;

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

function fileChip(n) {
  return `[File #${n}] `;
}

function expandAttachChips(text, { images, files } = {}) {
  return String(text).replace(ATTACH_CHIP_RE, (chip, label, n) => {
    const map = (label === 'File' ? files : images) || {};
    if (!Object.hasOwn(map, n)) return chip;
    return map[n] ? `${label}: ${map[n]} ` : '';
  });
}

const STRIPPED_PASTE_NOTICE = 'Your browser did not hand over the clipboard image — use the paperclip to attach it.';

function pasteStripped(items, web) {
  return web && Array.from(items || []).length === 0;
}

async function attachImages({ images, upload, toast, nextImage, append, attached, drop }) {
  if (!images.length) {
    toast('No readable image.');
    return;
  }
  const added = images.map((image) => {
    const n = nextImage();
    return { n, chip: imageChip(n), path: null, image, pending: true };
  });
  append(added);
  const r = await Promise.resolve().then(() => upload(images)).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  if (!r || !r.ok) {
    drop(added);
    toast(String((r && r.error) || 'Image upload failed.'));
    return;
  }
  attached(added.map((a, i) => ({ ...a, path: (r.paths && r.paths[i]) || null, pending: false })));
}

async function attachFiles({ files, upload, toast, nextFile, append, attached, drop }) {
  if (!files.length) {
    toast('No readable file.');
    return;
  }
  const added = files.map((file) => {
    const n = nextFile();
    return { n, chip: fileChip(n), path: null, file, pending: true };
  });
  append(added);
  const r = await Promise.resolve().then(() => upload(files.map(({ name, data }) => ({ name, data })))).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  if (!r || !r.ok) {
    drop(added);
    toast(String((r && r.error) || 'File upload failed.'));
    return;
  }
  attached(added.map((a, i) => ({ ...a, path: (r.paths && r.paths[i]) || null, pending: false })));
}

function ptyImagePasteHandler({ isWeb, readImages, upload, toast, nextImage, append, attached, drop, writePty }) {
  return async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (pasteStripped(items, isWeb())) {
      toast(STRIPPED_PASTE_NOTICE);
      return;
    }
    if (pasteKind(items) !== 'image') return;
    e.preventDefault();
    const web = isWeb();
    let images;
    try { images = await readImages(items); } catch { images = []; }
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
    await attachImages({ images, upload, toast, nextImage, append, attached, drop });
  };
}

function removeChip(text, kind, n) {
  return String(text).replace(new RegExp(`\\[${CHIP_LABEL[kind]} #${Number(n)}\\] ?`, 'gu'), '');
}

function chippedAttachments(items, text) {
  const value = String(text);
  return (items || []).filter((it) => it && (it.image || it.file) && it.chip && value.includes(it.chip.trim()));
}

function midTruncate(name, max) {
  const s = String(name);
  if (s.length <= max) return s;
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, max - 1 - tail)}…${s.slice(s.length - tail)}`;
}

function fileTile(doc, it) {
  const tile = doc.createElement('div');
  tile.className = it.pending ? 'seat-attachment seat-attachment-file seat-attachment-pending' : 'seat-attachment seat-attachment-file';
  tile.title = it.pending ? 'Uploading…' : 'Remove file';
  const label = doc.createElement('span');
  label.className = 'seat-attachment-name';
  label.textContent = `📄 ${midTruncate(it.file.name, FILE_NAME_MAX)}`;
  label.title = it.file.name;
  const size = doc.createElement('span');
  size.className = 'seat-attachment-size';
  size.textContent = fmtBytes(it.file.size);
  tile.append(label, size);
  return tile;
}

function renderAttachStrip(el, items, onRemove) {
  const doc = el.ownerDocument;
  el.replaceChildren();
  el.hidden = items.length === 0;
  for (const it of items) {
    const rm = doc.createElement('button');
    rm.type = 'button';
    rm.className = 'seat-attachment-remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => onRemove(it));
    if (it.file) {
      const tile = fileTile(doc, it);
      tile.append(rm);
      el.appendChild(tile);
      continue;
    }
    const thumb = doc.createElement('div');
    thumb.className = it.pending ? 'seat-attachment seat-attachment-pending' : 'seat-attachment';
    thumb.title = it.pending ? 'Uploading…' : it.path ? 'Remove image' : 'Removes the mark; the CLI keeps the pasted image';
    const pic = doc.createElement('img');
    pic.src = `data:${it.image.mediaType};base64,${it.image.data}`;
    pic.alt = imageChip(it.n).trim();
    thumb.append(pic, rm);
    el.appendChild(thumb);
  }
}

module.exports = { ptyComposerWrites, pasteKind, imageChip, fileChip, expandAttachChips, ptyImagePasteHandler, attachImages, attachFiles, pasteStripped, STRIPPED_PASTE_NOTICE, removeChip, chippedAttachments, fileTile, renderAttachStrip };
