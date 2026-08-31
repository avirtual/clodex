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
// It also carries the OUTPUT half: whether Clodex reads the final reply
// aloud. Input and output are one popover because they are one conversation
// across the room, and because the two interlock — a narration is suppressed
// while the recorder is lit and killed when it lights.
//
// There is no muted-microphone codepoint in Unicode — 🎤 and 🎙 are the only
// two, neither has a struck-through variant, `🔇` is a SPEAKER (audio output,
// the wrong direction), and a combining slash composes only if the font agrees.
// So off is the SAME glyph dimmed by a class, and the word carries the precise
// state.
//
// The painters are DOM-bound, so no unit tests per the R1 rule; the
// subscriber's gate and latch are pinned by test/voice-popover-latch.test.js.

const { esc } = require('../lib/format');
const { VOICE_ITEMS } = require('../voice-control');

// Read on OPEN rather than cached at init: the file is the truth for the input
// half and must be for this half too, or a Preferences change would leave the
// checkbox asserting a value the store contradicts.
async function readSpeakSettings() {
  try {
    const s = await window.api.getSettings();
    return {
      on: s?.speakReplies === true,
      voice: typeof s?.speakVoice === 'string' ? s.speakVoice : '',
      voices: Array.isArray(s?.speakVoices) ? s.speakVoices : [],
    };
  } catch { return null; }
}

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
      + `<div class="cost-note">${note}</div>`
      + `<div class="speak-host">${speakHtml()}</div>`;
    // The settings read is async and the rows above are not: painting the shell
    // first and filling it on arrival keeps the picker instant, and a failed
    // read simply leaves the section absent rather than blocking the popover.
    refreshSpeakSection();
  }

  // The OUTPUT half. Rendered from the last read; empty until one lands.
  let speak = null;
  function speakHtml() {
    if (!speak) return '';
    const voices = speak.voices.length
      ? `<select class="speak-voice" ${speak.on ? '' : 'disabled'}>`
        + speak.voices.map((v) => `<option value="${esc(v.name)}"${v.name === speak.voice ? ' selected' : ''}>`
          + `${esc(v.name)} (${esc(v.locale)})</option>`).join('')
        + '</select>'
      // No enumerable voices means `say` did not answer. The name is still shown
      // and still saved: it is what the store holds and what would be spoken.
      : `<span class="speak-voice-fixed">${esc(speak.voice)}</span>`;
    return '<label class="speak-row" title="Synthesized on this machine by /usr/bin/say — no audio and no text leave the box">'
      + `<input type="checkbox" class="speak-toggle"${speak.on ? ' checked' : ''}> `
      + 'Speak the final reply aloud</label>'
      + `<div class="speak-sub">Local only — nothing leaves this machine. ${voices}</div>`;
  }

  async function refreshSpeakSection() {
    const next = await readSpeakSettings();
    if (!next) return;
    speak = next;
    const host = body.querySelector('.speak-host');
    if (host) host.innerHTML = speakHtml();
  }

  // Write-through, then re-read. The store sanitizes (a blank voice resolves to
  // the default), so echoing the local guess would show a value the file may
  // not hold.
  async function saveSpeak(partial) {
    try { await window.api.setSettings(partial); } catch { /* leave the read to correct it */ }
    await refreshSpeakSection();
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
  //
  // GATED ON AN ACTUAL CHANGE, and the gate must live HERE rather than in the
  // core. Emits arrive at >=1 Hz for the life of the window — the core's
  // sessionList observer is held open permanently by the bar, and the sidebar's
  // 1 s badge tick rewrites `textContent`, whose setter is replace-all and so
  // queues a childList record even when the string is identical. An
  // unconditional repaint here rebuilds #proxy-actions via innerHTML once a
  // second, which destroys every .px-action between a mousedown and its mouseup
  // and silently eats clicks across the whole bar — the same mechanism as the
  // "3 clicks to open" bug, five times faster.
  //
  // Not in `emit()`: only a SURFACE knows whether it declined to paint. The
  // Preferences row skips its `sel.value` write while the picker holds focus and
  // repaints on blur, so its DOM is stale while the snapshot key is unchanged —
  // a core-level gate would swallow that emit and leave the select showing a
  // value the file contradicts, which is the exact bug its blur listener exists
  // to fix.
  let lastKey = null;
  // Consecutive-failure latch. The subscriber has no try/catch of its own by
  // default: a throw from either painter escapes to the core's per-listener
  // guard, so `lastKey = key` is never reached and the gate above never closes.
  // On a painter that throws EVERY time, that turns the >=1 Hz emit stream into
  // a 1 Hz innerHTML rebuild of #proxy-actions — the click-eating mechanism the
  // gate exists to prevent, arrived at from the other side.
  let failedOnce = false;
  core.subscribe((snap) => {
    const key = `${snap.pending || ''}|${snap.mode || ''}|${snap.target || ''}|${snap.anyClaudeRow}`;
    if (key === lastKey) return;
    try {
      // Equally a no-op rebuild of a live picker: the rows are detached under the
      // pointer, so an ungated repaint swallows the pick it is meant to show.
      if (!pop.classList.contains('hidden')) renderRows();
      // `actionHtml()` is called synchronously by renderSessionActions on every
      // other rebuild path, so skipping a no-change repaint cannot leave the bar
      // stale.
      renderProxyBar();
    } catch (e) {
      // The FIRST failure leaves the key unlatched, exactly as before this catch
      // existed: the next identical emit retries and a transient throw heals
      // itself, which is what t519 moved the assignment down here for.
      if (!failedOnce) { failedOnce = true; throw e; }
      // The SECOND consecutive failure latches instead. Recovery does not need a
      // timer and must not rely on one: `PROXY_POLL_MS` builds no interval, and
      // the 5 s `session-proxy` emit that does exist is skipped for any session
      // without a wirescope proxy configured, so a timer-based recovery would
      // work on some boxes and not others.
      lastKey = key;
      // Re-thrown, not swallowed: the core's guard is the deliberate diagnostic
      // and dropping it would trade a visible bug for a surface that silently
      // stops updating. Bounded rather than silenced — the latch closes the gate
      // above, so identical emits stop arriving here and the log stops with them.
      throw e;
    }
    // After the paints, never before: a mid-paint throw must not leave the key
    // claiming a DOM that was not painted, which would skip every identical emit
    // until an unrelated change moved the key.
    lastKey = key;
    // A paint that worked ends the streak, so a later transient throw gets its
    // own free retry rather than latching on the strength of an old failure.
    failedOnce = false;
  });

  body.addEventListener('change', (e) => {
    const toggle = e.target.closest('.speak-toggle');
    if (toggle) { saveSpeak({ speakReplies: toggle.checked }); return; }
    const sel = e.target.closest('.speak-voice');
    if (sel) saveSpeak({ speakVoice: sel.value });
  });

  // The label wraps the checkbox, so a click inside this section must not fall
  // through to the mode picker below it — that would change the input mode on a
  // click aimed at the output half.
  body.addEventListener('click', (e) => {
    if (e.target.closest('.speak-host')) e.stopPropagation();
  }, true);

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
