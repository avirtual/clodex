// popovers/voice-popover.js — the session bar's voice-mode button and its
// popover (off · tap · hold). The button label carries the CURRENT mode read
// from the settings file, so the mode is answerable at a glance without opening
// Preferences; the popover is the picker.
//
// Self-contained island: it owns its DOM handles and dismiss wiring, and gets
// every piece of voice state from the shared core in voice-control.js. It holds
// NO state of its own — a second copy of the box-wide mode is exactly what the
// core exists to prevent.
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
const { COMPOSITION_POLL_MS } = require('../voice-submit-watcher');

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
      rate: Number.isInteger(s?.speakRate) ? s.speakRate : null,
    };
  } catch { return null; }
}

// The rates offered, not a free-text field: this is a listening choice, and a
// slider invites tuning a number nobody can hear the difference in. 210 is the
// default because the operator compared all three aloud.
const SPEAK_RATES = [
  { rate: 150, label: '150 — slow' },
  { rate: 175, label: "175 — say's default" },
  { rate: 210, label: '210 — brisk' },
  { rate: 240, label: '240 — fast' },
];

// The fallback for a read that produced no rate. Named rather than inlined
// because it is the fourth copy of this number (stores.js, speaker.js and the
// <option> list in index.html hold the others) and was the only one no test
// could reach — the two main-process copies are pinned against each other.
const DEFAULT_SPEAK_RATE = 210;


// How often the open popover re-reads the recorder state. Matched to the
// watcher's own composition poll, which is what actually moves the value: a
// faster tick re-reads a getter that cannot have changed, a slower one shows a
// state the gates have already left.
//
// Only ever running while the popover is OPEN, and it writes a class and a
// string on ONE node — never innerHTML on the bar. An indicator on the session
// bar would repaint #proxy-actions on this timer, which is the measured
// click-eating rebuild that ate 10-15% of clicks; the popover placement is what
// makes a tick this fast affordable at all.
const RECORDER_TICK_MS = COMPOSITION_POLL_MS;

// What CLODEX believes, in the words of the predicate that produced it. THREE
// states rendered distinctly and not two — 'unreadable' is the one this whole
// surface exists for: it silently blocks every re-arm and is indistinguishable
// from 'off' on screen today, which is how a U+00A0-vs-U+0020 scrape mismatch
// once left the feature dead with a green suite.
//
// 'out' is not a recorder state and paints nothing: the scan does not run on a
// seat that is not the active Claude one, so there is no reading to report and
// claiming 'off' would be a measurement nobody took.
const RECORDER_STATES = {
  lit: { cls: 'rec-lit', text: 'Recording', hint: 'Clodex sees the recorder running — click to stop it (declines while a draft is in the composer, since the key would SEND it)' },
  busy: { cls: 'rec-busy', text: 'Processing', hint: 'The CLI is finishing the last utterance — Clodex will not write to it now' },
  unreadable: { cls: 'rec-unreadable', text: 'Cannot read the screen', hint: 'Clodex cannot see the indicator, so it will not write — a re-arm is blocked while this shows' },
  off: { cls: 'rec-off', text: 'Not recording', hint: 'Clodex sees no recorder running' },
};

function initVoicePopover({ core, renderProxyBar, getRecorderReading, tapOffRecorder }) {
  const pop = document.getElementById('voice-popover');
  const body = document.getElementById('voice-popover-body');
  if (!pop || !body) return { actionHtml: () => '', closeVoicePopover() {}, openVoicePopover() {} };

  // Read through the injected getter, never scraped here. This surface reports
  // the gates' own reading and must never be able to disagree with it — a
  // second detector that said "off" while the gate said "blocked" would make
  // the operator trust the wrong one at exactly the moment the scrape is broken.
  function reading() {
    try { return getRecorderReading(); } catch { return 'out'; }
  }

  function recorderHtml() {
    const st = RECORDER_STATES[reading()];
    if (!st) return '';
    return `<div class="rec-state ${st.cls}" data-rec title="${esc(st.hint)}">`
      + '<span class="rec-dot"></span>'
      + `<span class="rec-text">${esc(st.text)}</span></div>`;
  }

  // Repaints the ONE node, and only when the state actually moved. Not a
  // renderRows() call: that rebuilds the picker's innerHTML, which detaches the
  // rows under the pointer and eats the click it was meant to show — the same
  // mechanism the subscriber's gate below exists to prevent, arrived at from a
  // timer instead of an emit.
  let recTimer = null;
  let lastReading = null;
  function paintRecorder() {
    const now = reading();
    if (now === lastReading) return;
    lastReading = now;
    const host = body.querySelector('.rec-host');
    if (host) host.innerHTML = recorderHtml();
  }

  function stopRecorderTick() {
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    lastReading = null;
  }

  function closeVoicePopover() {
    stopRecorderTick();
    pop.classList.add('hidden');
  }

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
      ? `Voice input: switching to ${snap.pending}`
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
    const note = snap.pending
      ? `Switching to ${esc(snap.pending)}…`
      : 'One setting for every Claude session on this machine.';
    // The reading rides in its own host node so the tick can replace it without
    // touching the picker rows around it.
    body.innerHTML = `<div class="voice-rows">${rows}</div>`
      + `<div class="rec-host">${recorderHtml()}</div>`
      + `<div class="cost-note">${note}</div>`
      + `<div class="speak-host">${speakHtml()}</div>`;
    lastReading = reading();
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
    // Falls back to the default when the read produced nothing rather than
    // leaving every option unselected, which would show a picker asserting a
    // rate the store does not hold.
    const want = speak.rate === null ? DEFAULT_SPEAK_RATE : speak.rate;
    // A STORED value that is not on the list gets its own option, the same way
    // setSpeakSettings does for voices. The store accepts the whole 80-400 band,
    // so a rate set from anywhere else — a hand-edited settings file, a future
    // surface — would otherwise leave every option unselected, and a browser
    // renders that as the FIRST one: the picker would claim 150 while the store
    // held 190, which is precisely what the note above says it prevents.
    const offered = SPEAK_RATES.some((r) => r.rate === want)
      ? SPEAK_RATES
      : [{ rate: want, label: `${want} — set elsewhere` }, ...SPEAK_RATES];
    const rates = `<select class="speak-rate" ${speak.on ? '' : 'disabled'}>`
      + offered.map((r) => `<option value="${r.rate}"${r.rate === want ? ' selected' : ''}>`
        + `${esc(r.label)}</option>`).join('')
      + '</select>';
    return '<label class="speak-row" title="Synthesized on this machine by /usr/bin/say — no audio and no text leave the box">'
      + `<input type="checkbox" class="speak-toggle"${speak.on ? ' checked' : ''}> `
      + 'Speak the final reply aloud</label>'
      + `<div class="speak-sub">Local only — nothing leaves this machine. ${voices} ${rates}</div>`;
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
    // Only while open. The core's own emits are driven by mode changes and the
    // session list, neither of which moves when the microphone does, so the
    // reading needs a tick of its own — and closing must take it back, or a
    // dismissed popover keeps polling for the life of the window.
    stopRecorderTick();
    lastReading = reading();
    recTimer = setInterval(paintRecorder, RECORDER_TICK_MS);
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }

  body.addEventListener('click', (e) => {
    // The indicator is a control only where there is something to stop. The
    // watcher decides that for itself — this must not pre-judge it from the
    // painted state, which is one tick old and would let a click through into a
    // recorder that stopped in the meantime.
    if (e.target.closest('[data-rec]')) {
      let stopped = false;
      try { stopped = tapOffRecorder() === true; } catch {}
      // Left OPEN, deliberately: the operator asked for a state change and the
      // indicator is where he watches it land. Closing would hide the one
      // surface that says whether the click did anything.
      paintRecorder();
      // A decline is SHOWN, not merely not-done. The watcher declines silently
      // (a draft in the composer, a screen it cannot read), and paintRecorder
      // alone renders nothing new in that case because the reading has not
      // moved — so a click that did nothing would be indistinguishable from one
      // that worked. The class is transient and self-clearing: it must not
      // survive into the next reading, which the tick would then contradict.
      if (!stopped) {
        const host = body.querySelector('[data-rec]');
        if (host) {
          host.classList.add('rec-declined');
          setTimeout(() => { try { host.classList.remove('rec-declined'); } catch {} }, 600);
        }
      }
      return;
    }
    const row = e.target.closest('.voice-row');
    if (!row || !row.dataset.mode) return;
    core.choose(row.dataset.mode);
    closeVoicePopover();
  });

  // Repaint the open list and the bar label together: a pick lands as `pending`
  // and the operator must see it queued rather than see nothing happen.
  //
  // GATED ON AN ACTUAL CHANGE, and the gate must live HERE rather than in the
  // core. The poll and every window focus emit whether or not the file moved, so
  // an unconditional repaint rebuilds #proxy-actions via innerHTML on emits that
  // change nothing, destroying every .px-action between a mousedown and its
  // mouseup and silently eating clicks across the bar — the "3 clicks to open"
  // mechanism. Do not relax this gate by making the key coarser.
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
  // On a painter that throws EVERY time, that leaves every emit rebuilding
  // #proxy-actions — the click-eating mechanism the gate exists to prevent,
  // arrived at from the other side.
  let failedOnce = false;
  core.subscribe((snap) => {
    const key = `${snap.pending || ''}|${snap.mode || ''}`;
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
    if (sel) { saveSpeak({ speakVoice: sel.value }); return; }
    const rate = e.target.closest('.speak-rate');
    if (rate) saveSpeak({ speakRate: Number(rate.value) });
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
