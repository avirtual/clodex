'use strict';
// external-link.js — the scheme filter for "open this URL in the user's browser"
// (Task 16, GH#6). Pure leaf, shared by BOTH hosts: main.js's window-open /
// will-navigate guards and the renderer's xterm WebLinksAddon handler. Returns
// true ONLY for http/https URLs — the sole schemes we hand to shell.openExternal.
// Everything else (file:, javascript:, data:, blob:, vbscript:, chrome:, …) is
// denied WITHOUT opening: the renderer runs nodeIntegration:true, so a stray
// file:/javascript: navigation is a real hole, not a cosmetic one.
//
// Parsed via the WHATWG URL (present in both Node and the nodeIntegration
// renderer), so protocol casing and odd forms normalize before the check. A
// non-string or unparseable value is denied.
//
// NEW leaf (not a coordinator extraction) → per the sandbox-view.js / tool-doctor
// precedent, deliberately NOT added to free-identifier-leaks SCANNED lists.
function isExternallyOpenable(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function blobChildAllowed(url, openerUrl) {
  if (typeof url !== 'string' || typeof openerUrl !== 'string') return false;
  let blob, inner, opener;
  try {
    blob = new URL(url);
    if (blob.protocol !== 'blob:') return false;
    inner = new URL(blob.pathname);
    opener = new URL(openerUrl);
  } catch { return false; }
  if (inner.protocol !== 'http:' && inner.protocol !== 'https:') return false;
  return inner.origin === opener.origin;
}

module.exports = { isExternallyOpenable, blobChildAllowed };
