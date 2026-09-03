'use strict';

const MODAL_OVERLAY_IDS = [
  'dialog-overlay',
  'peer-session-overlay',
  'discovery-overlay',
  'args-overlay',
  'prefs-overlay',
  'plugins-overlay',
  'peers-overlay',
  'sandbox-overlay',
  'file-peek-overlay',
  'report-overlay',
  'prompt-editor',
  'agent-editor',
  'skill-editor',
  'exec-editor',
];

const MODAL_OVERLAY_CLASSES = [
  'prompt-modal-overlay',
  'plugin-overlay',
  'clx-modal-bg',
];

function openOverlayIds({ byId, byClass }) {
  const open = [];
  for (const id of MODAL_OVERLAY_IDS) {
    const el = byId(id);
    if (el && el.classList && !el.classList.contains('hidden')) open.push(id);
  }
  for (const cls of MODAL_OVERLAY_CLASSES) {
    const els = (byClass && byClass(cls)) || [];
    if (Array.prototype.some.call(els, (el) => el && el.classList && !el.classList.contains('hidden'))) open.push(cls);
  }
  return open;
}

function anyOverlayOpen(probes) {
  return openOverlayIds(probes).length > 0;
}

function performCloseChord({ byId, byClass, activeSession, peerOf }, { closeNewSessionDialog, hidePeerRow, archiveSession }) {
  const open = openOverlayIds({ byId, byClass });
  if (open.length === 1 && open[0] === 'dialog-overlay') {
    closeNewSessionDialog();
    return 'closed-new-session-dialog';
  }
  if (open.length > 0) return 'overlay-open-nothing-closed';
  if (!activeSession) return 'no-active-session';
  const peer = peerOf(activeSession);
  if (peer) {
    hidePeerRow(peer);
    return 'hid-peer-row';
  }
  archiveSession(activeSession);
  return 'archived-active-session';
}

module.exports = { MODAL_OVERLAY_IDS, MODAL_OVERLAY_CLASSES, openOverlayIds, anyOverlayOpen, performCloseChord };
