'use strict';

const { SEAT_IMAGE_TYPES, SEAT_IMAGE_MAX } = require('../../seat-images');
const { fmtBytes } = require('./format');

const SEAT_FILE_MAX = 5;
const SEAT_FILE_MAX_BYTES = 10 * 1024 * 1024;

function splitAttachable(fileList) {
  const images = [];
  const files = [];
  const rejected = [];
  for (const file of Array.from(fileList || []).filter(Boolean)) {
    if (SEAT_IMAGE_TYPES.has(file.type)) {
      if (images.length < SEAT_IMAGE_MAX) images.push(file);
      else rejected.push({ file, reason: 'images' });
    } else if (file.size === 0) {
      rejected.push({ file, reason: 'empty' });
    } else if (file.size > SEAT_FILE_MAX_BYTES) {
      rejected.push({ file, reason: 'size' });
    } else if (files.length < SEAT_FILE_MAX) {
      files.push(file);
    } else {
      rejected.push({ file, reason: 'files' });
    }
  }
  return { images, files, rejected };
}

function rejectedNotice(rejected) {
  const notices = [];
  const count = { images: 0, files: 0 };
  for (const { file, reason } of rejected || []) {
    const name = (file && file.name) || 'file';
    if (reason === 'size') notices.push(`Not attached: ${name} (${fmtBytes(file.size)}) — files up to 10 MB.`);
    else if (reason === 'empty') notices.push(`Not attached: ${name} — empty file.`);
    else if (Object.hasOwn(count, reason)) count[reason] += 1;
  }
  if (count.images) notices.push(`${count.images} image(s) not attached — at most ${SEAT_IMAGE_MAX} per message.`);
  if (count.files) notices.push(`${count.files} file(s) not attached — at most ${SEAT_FILE_MAX} per message.`);
  return notices;
}

function attachPicker({ doc, parent, multiple = true, onFiles }) {
  const input = doc.createElement('input');
  input.type = 'file';
  input.className = 'seat-attach-input';
  input.multiple = !!multiple;
  input.hidden = true;
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) onFiles(files);
  });
  parent.appendChild(input);
  return { input, open: () => input.click() };
}

function attachButton(doc, onClick) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'seat-attach-btn';
  btn.title = 'Attach image or file (up to 5 each; images 5 MB, files 10 MB)';
  btn.setAttribute('aria-label', 'Attach image or file');
  btn.textContent = '📎';
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', onClick);
  return btn;
}

module.exports = { SEAT_FILE_MAX, SEAT_FILE_MAX_BYTES, splitAttachable, rejectedNotice, attachPicker, attachButton };
