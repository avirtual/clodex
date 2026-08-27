// popovers/voice-popover.js — the session bar's voice-mode button and its
// popover (off · tap · hold). The button label carries the CURRENT mode read
// from the settings file, so the mode is answerable at a glance without opening
// Preferences; the popover is the picker.
//
// Self-contained island: it owns its DOM handles and dismiss wiring, and gets
// every piece of voice state from the shared core in voice-control.js. It holds
// NO state of its own — a second copy of the pending/quiet-gate reconciliation
// is exactly what the core exists to prevent.
//
// Claude only. Codex has no `/voice`, so a button on a Codex seat's bar would
// name a setting that seat cannot have.
//
// There is no muted-microphone codepoint in Unicode — 🎤 and 🎙 are the only
// two, neither has a struck-through variant, `🔇` is a SPEAKER (audio output,
// the wrong direction), and a combining slash composes only if the font agrees.
// So off is the SAME glyph dimmed by a class, and the word carries the precise
// state.
//
// DOM-bound, so no unit tests per the R1 rule.

const { esc } = require('../lib/format');
const { VOICE_ITEMS } = require('../voice-control');

function initVoicePopover({ core, renderProxyBar }) {
  const pop = document.getElementById('voice-popover');
  const body = document.getElementById('voice-popover-body');
  if (!pop || !body) return { actionHtml: () => '', closeVoicePopover() {}, openVoicePopover() {} };

  function closeVoicePopover() { pop.classList.add('hidden'); }

  // Built synchronously inside renderSessionActions, so it reads the core rather
  // than waiting for a subscription tick — a button that painted a mode one
  // frame late would flicker on every bar rebuild (5s poll).
  function actionHtml() {
    const snap = core.snapshot();
    const mode = snap.pending || snap.mode;
    // Unknown is not a mode: before the first read lands there is nothing to
    // claim, and guessing "off" would name a state the file may contradict.
    const known = core.isMode(mode);
    const label = known ? mode : 'voice';
    const dim = known && mode === 'off' ? ' px-voice-off' : '';
    const tip = snap.pending
      ? `Voice input: switching to ${snap.pending}, queued until ${snap.target} is between turns`
      : 'Voice input mode for every Claude session on this machine — click to change';
    return `<button class="px-action${dim}" data-act="voice" data-tip="${esc(tip)}">🎤 ${esc(label)}</button>`;
  }

  function renderRows() {
    const snap = core.snapshot();
    const mode = snap.pending || snap.mode;
    const rows = VOICE_ITEMS.map((i) => {
      const on = i.mode === mode ? ' voice-row-on' : '';
      const mark = i.mode === mode ? '●' : '○';
      return `<div class="voice-row${on}" data-mode="${i.mode}">`
        + `<span class="voice-row-mark">${mark}</span>`
        + `<span class="voice-row-main"><span class="voice-row-name">${esc(i.name)}</span>`
        + `<span class="voice-row-desc">${esc(i.desc)}</span></span></div>`;
    }).join('');
    // The same two unreachable cases Preferences distinguishes, for the same
    // reason: the remedy differs (start a Claude session vs wait for the one you
    // have), and a picker that just did nothing would read as broken.
    let note = '';
    if (!snap.target) {
      note = snap.anyClaudeRow
        ? 'No Claude session can be reached right now — the mode is read from the settings file but cannot be changed from here.'
        : 'No Claude session on this machine — start one to change the mode.';
    } else if (snap.pending) {
      note = `Switching to ${esc(snap.pending)} — queued until ${esc(snap.target)} is between turns.`;
    } else {
      note = 'One setting for every Claude session on this machine. Sessions already running keep the mode they started with until they restart.';
    }
    body.innerHTML = `<div class="voice-rows${snap.target ? '' : ' voice-rows-off'}">${rows}</div>`
      + `<div class="cost-note">${note}</div>`;
  }

  function openVoicePopover(anchor) {
    if (!pop.classList.contains('hidden')) return closeVoicePopover();
    // Anchor geometry FIRST. Any repaint below rebuilds the bar and DETACHES the
    // clicked button, and a detached node's rect is all zeros — which positions
    // the popover above the viewport top (the "3 clicks to open" bug this
    // codebase already shipped once on the files button).
    const r = anchor.getBoundingClientRect();
    renderRows();
    pop.classList.remove('hidden');
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  body.addEventListener('click', (e) => {
    const row = e.target.closest('.voice-row');
    if (!row || !row.dataset.mode) return;
    core.choose(row.dataset.mode);
    closeVoicePopover();
  });

  // Repaint the open list and the bar label together: a pick lands as `pending`
  // and the operator must see it queued rather than see nothing happen.
  core.subscribe(() => {
    if (!pop.classList.contains('hidden')) renderRows();
    renderProxyBar();
  });

  document.addEventListener('mousedown', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (pop.contains(e.target)) return;
    if (e.target.closest('[data-act="voice"]')) return; // toggle handled by the bar
    closeVoicePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) closeVoicePopover();
  });
  document.getElementById('voice-popover-close').addEventListener('click', closeVoicePopover);

  return { actionHtml, openVoicePopover, closeVoicePopover };
}

module.exports = { initVoicePopover };
