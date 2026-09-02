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
];

function openOverlayIds(byId) {
  const open = [];
  for (const id of MODAL_OVERLAY_IDS) {
    const el = byId(id);
    if (el && el.classList && !el.classList.contains('hidden')) open.push(id);
  }
  return open;
}

function anyOverlayOpen(byId) {
  return openOverlayIds(byId).length > 0;
}

function performCloseChord({ byId, activeSession, peerOf }, { closeNewSessionDialog, hidePeerRow, archiveSession }) {
  const open = openOverlayIds(byId);
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

module.exports = { MODAL_OVERLAY_IDS, openOverlayIds, anyOverlayOpen, performCloseChord };
