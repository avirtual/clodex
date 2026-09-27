'use strict';

const SEAT_VIEWS = ['conversation', 'internals', 'terminal'];

const paneMode = (mode) => (mode === 'internals' ? 'internals' : 'conversation');

function initialSeatView({ transcriptPane, transcriptPaneMode, io }) {
  if (io !== 'stream' && transcriptPane !== true) return 'terminal';
  return paneMode(transcriptPaneMode);
}

function rememberedSeatView(remembered, settings) {
  if (SEAT_VIEWS.includes(remembered) && !(remembered === 'terminal' && settings.io === 'stream')) return remembered;
  return initialSeatView(settings);
}

function seatViewSettings(view, currentMode) {
  if (view === 'terminal') return { transcriptPane: false, transcriptPaneMode: paneMode(currentMode) };
  return { transcriptPane: true, transcriptPaneMode: paneMode(view) };
}

function createSeatView(view) {
  const next = SEAT_VIEWS.includes(view) ? view : 'conversation';
  return { view: next, lastView: next === 'terminal' ? 'conversation' : next };
}

function applySeatView(entry, view) {
  if (!entry || !SEAT_VIEWS.includes(view)) return;
  if (view === 'terminal' && !entry.liveSplit) return;
  entry.view = view;
  if (view !== 'terminal') entry.lastView = view;
  if (typeof entry.onView === 'function') entry.onView(view);
  if (entry.liveSplit) {
    entry.liveSplit.setRaw(view === 'terminal');
    entry.liveSplit.refresh();
  }
  if (entry.stream) entry.stream.setMode(entry.lastView);
}

function toggleSeatTerminal(entry) {
  if (!entry) return;
  applySeatView(entry, entry.view === 'terminal' ? entry.lastView || 'conversation' : 'terminal');
}

function seatViewDeps(entry, { onHelp = null } = {}) {
  return {
    mode: () => entry.lastView,
    onMode: (next) => applySeatView(entry, next),
    onTerminal: () => toggleSeatTerminal(entry),
    onHelp,
  };
}

module.exports = { SEAT_VIEWS, initialSeatView, rememberedSeatView, seatViewSettings, createSeatView, applySeatView, toggleSeatTerminal, seatViewDeps };
