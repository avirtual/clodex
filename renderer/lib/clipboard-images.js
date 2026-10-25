'use strict';

function dataUrlImage(url) {
  const m = /^data:([^;,]+);base64,(.*)$/u.exec(String(url || ''));
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function readImageFile(file, Reader) {
  return new Promise((resolve) => {
    const reader = new Reader();
    reader.onload = () => resolve(dataUrlImage(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function readAttachFile(file, Reader) {
  return new Promise((resolve) => {
    const reader = new Reader();
    reader.onload = () => {
      const m = /^data:([^,]*?);base64,(.*)$/su.exec(String(reader.result || ''));
      resolve(m ? { name: file.name, size: file.size, mediaType: m[1] || file.type || 'application/octet-stream', data: m[2] } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function clipboardImages(items, Reader) {
  const files = Array.from(items || [])
    .filter((it) => it && it.kind === 'file' && /^image\//u.test(String(it.type)))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  const read = await Promise.all(files.map((f) => readImageFile(f, Reader)));
  return read.filter(Boolean);
}

module.exports = { dataUrlImage, readImageFile, readAttachFile, clipboardImages };
