'use strict';

const { SEAT_IMAGE_TYPES } = require('../../seat-images');

const ATTACH_ACCEPT = [...SEAT_IMAGE_TYPES].join(',');

function imageFilesOf(fileList, types = SEAT_IMAGE_TYPES) {
  const files = Array.from(fileList || []).filter(Boolean);
  const images = files.filter((f) => types.has(f.type));
  const rejected = files.filter((f) => !types.has(f.type));
  return { images, rejected };
}

function rejectedNotice(rejected) {
  const named = rejected.map((f) => `${f.name || 'file'} (${f.type || 'unknown type'})`).join(', ');
  return `Not attached: ${named} — png, jpeg, gif or webp only.`;
}

function attachPicker({ doc, parent, accept = ATTACH_ACCEPT, multiple = true, onFiles, toast, types = SEAT_IMAGE_TYPES }) {
  const input = doc.createElement('input');
  input.type = 'file';
  input.className = 'seat-attach-input';
  input.accept = accept;
  input.multiple = !!multiple;
  input.hidden = true;
  input.addEventListener('change', () => {
    const { images, rejected } = imageFilesOf(input.files, types);
    input.value = '';
    if (rejected.length) toast(rejectedNotice(rejected));
    if (images.length) onFiles(images);
  });
  parent.appendChild(input);
  return { input, open: () => input.click() };
}

function attachButton(doc, onClick) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'seat-attach-btn';
  btn.title = 'Attach image (png, jpeg, gif, webp; up to 5, 5 MB each)';
  btn.setAttribute('aria-label', 'Attach image');
  btn.textContent = '📎';
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', onClick);
  return btn;
}

module.exports = { ATTACH_ACCEPT, imageFilesOf, rejectedNotice, attachPicker, attachButton };
