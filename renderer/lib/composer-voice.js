'use strict';

const { findSubmit, shouldFire } = require('./voice-submit');

const VOICE_QUIET_MS = 1200;
const VOICE_RELEASE_MS = 2500;
const VOICE_STOP_TRIES = 2;
const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

const PASTE_MARK = /\x1b\[20[01]~/gu;

function bracketPaste(text) {
  let body = String(text);
  for (let prev; prev !== body;) { prev = body; body = body.replace(PASTE_MARK, ''); }
  return `${PASTE_OPEN}${body}${PASTE_CLOSE}`;
}

function applyDraft(value, span, text) {
  const v = typeof value === 'string' ? value : '';
  let start = -1;
  let end = -1;
  if (span && typeof span.text === 'string' && span.text) {
    if (v.slice(span.start, span.end) === span.text) {
      start = span.start;
      end = span.end;
    } else {
      const at = v.lastIndexOf(span.text);
      if (at !== -1) { start = at; end = at + span.text.length; }
    }
  }
  if (start === -1) {
    const lead = v && !/\s$/.test(v) ? ' ' : '';
    const s = v.length + lead.length;
    return { value: v + lead + text, span: { start: s, end: s + text.length, text } };
  }
  return {
    value: v.slice(0, start) + text + v.slice(end),
    span: { start, end: start + text.length, text },
  };
}

function createComposerTrigger({ getConfig }) {
  let fired = null;
  const match = (value) => {
    let cfg = null;
    try { cfg = getConfig(); } catch { cfg = null; }
    if (!cfg || !shouldFire({ enabled: cfg.enabled })) return null;
    if (typeof value !== 'string') return null;
    return findSubmit(value, cfg.phrase);
  };
  return {
    matches(value) {
      const hit = match(value);
      return !!(hit && hit.erase);
    },
    check(value) {
      if (typeof value !== 'string') return null;
      if (value === fired) return null;
      const hit = match(value);
      if (!hit || !hit.erase) { fired = null; return null; }
      fired = value;
      return { text: value.slice(0, value.length - hit.erase) };
    },
    reset() { fired = null; },
  };
}

function attachTriggerSubmit(composer, {
  getConfig, markOrigin, send, hasImages = () => false, onVoiceFire = () => {},
  holdsFire = () => false, onVoiceStop = () => {}, quietMs = 0, releaseMs = 0, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
  trace = () => {},
}) {
  const trigger = createComposerTrigger({ getConfig });
  let span = null;
  let quiet = null;
  let release = null;
  let stopping = false;
  let stopFails = 0;
  const note = (line) => { try { trace(line); } catch {} };
  const fire = (fromVoice) => {
    const traced = fromVoice || stopping || span !== null;
    const how = fromVoice ? 'voice' : 'key';
    const hit = trigger.check(composer.value);
    if (!hit) { if (traced) note(`fire ${how}: no match ${JSON.stringify(composer.value)}`); return; }
    composer.value = hit.text;
    if (fromVoice) { try { onVoiceFire(); } catch {} }
    let images = false;
    try { images = hasImages() === true; } catch { images = false; }
    if (!hit.text.trim() && !images) { if (traced) note(`fire ${how}: empty`); return; }
    if (traced) note(`fire ${how}: sent ${JSON.stringify(hit.text)}`);
    try { markOrigin(); } catch {}
    send();
  };
  const timerSet = (fn, ms) => {
    try { return timers.set(fn, ms); } catch (e) { note(`timer failed: ${e && e.message}`); throw e; }
  };
  const timerClear = (id) => {
    try { timers.clear(id); } catch (e) { note(`timer failed: ${e && e.message}`); throw e; }
  };
  const cancelQuiet = () => { if (quiet !== null) { timerClear(quiet); quiet = null; } };
  const armQuiet = () => {
    cancelQuiet();
    quiet = timerSet(() => { quiet = null; voiceFire(); }, quietMs);
  };
  const cancelRelease = () => { if (release !== null) { timerClear(release); release = null; } };
  const settle = () => { stopping = false; cancelRelease(); };
  const armRelease = () => {
    cancelRelease();
    if (!(releaseMs > 0)) return;
    note(`release deadline armed ${releaseMs}ms`);
    release = timerSet(() => {
      release = null;
      note(`release deadline fired stopping=${stopping}`);
      if (!stopping) return;
      stopping = false;
      cancelQuiet();
      fire(true);
    }, releaseMs);
  };
  const stopFailed = () => {
    if (!stopping) return;
    stopping = false;
    stopFails++;
    if (stopFails < VOICE_STOP_TRIES) { note(`stop failed ${stopFails}/${VOICE_STOP_TRIES}, retrying`); armQuiet(); return; }
    note(`stop failed ${stopFails}/${VOICE_STOP_TRIES}, sending anyway`);
    stopFails = 0;
    cancelQuiet();
    fire(true);
  };
  const voiceFire = () => {
    let open = false;
    try { open = holdsFire() === true; } catch { open = false; }
    const matched = trigger.matches(composer.value);
    note(`quiet fire holdsFire=${open} matches=${matched} stopping=${stopping} ${JSON.stringify(composer.value)}`);
    if (!open) { settle(); fire(true); return; }
    if (stopping || !matched) return;
    cancelRelease();
    stopping = true;
    note('onVoiceStop called');
    let stopped;
    try { stopped = onVoiceStop(); } catch { stopFailed(); return; }
    if (stopped && typeof stopped.then === 'function') {
      stopped.then((ok) => {
        note(`onVoiceStop resolved ${ok}`);
        if (ok === false) stopFailed();
        else if (ok === true && stopping) { stopFails = 0; armRelease(); }
      }, stopFailed);
    }
  };
  const onInput = () => {
    let open = stopping || span !== null;
    if (!open) { try { open = holdsFire() === true; } catch { open = false; } }
    if (stopping && trigger.matches(composer.value)) settle();
    if (open) fire(false);
  };
  composer.addEventListener('input', onInput);
  return {
    check: () => fire(false),
    draft(text) {
      const next = applyDraft(composer.value, span, text);
      composer.value = next.value;
      span = next.span;
      armQuiet();
    },
    released() {
      note(`released stopping=${stopping}`);
      if (stopping) {
        settle();
        cancelQuiet();
        fire(true);
      }
      span = null;
    },
    resetSpan() { span = null; stopping = false; stopFails = 0; trigger.reset(); },
    dispose() {
      cancelQuiet();
      cancelRelease();
      composer.removeEventListener('input', onInput);
    },
  };
}

function createPtyVoiceDraft({
  getConfig, write, markOrigin = () => {}, onVoiceFire = () => {}, holdsFire = () => false, onVoiceStop = () => {},
  quietMs = 0, releaseMs = 0, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }, trace = () => {},
}) {
  let value = '';
  let written = '';
  let frozen = false;
  const note = (line) => { try { trace(line); } catch {} };
  const composer = {
    get value() { return value; },
    set value(v) { value = typeof v === 'string' ? v : ''; },
    addEventListener() {},
    removeEventListener() {},
  };
  const syncRow = () => {
    if (frozen) return;
    const had = Array.from(written);
    const want = Array.from(value);
    let prefix = 0;
    while (prefix < had.length && prefix < want.length && had[prefix] === want[prefix]) prefix++;
    const erase = had.length - prefix;
    const suffix = want.slice(prefix).join('');
    if (!erase && !suffix) return;
    note(`pty row sync -${erase} +${JSON.stringify(want.slice(prefix, prefix + 40).join(''))}`);
    write('\x7f'.repeat(erase) + suffix);
    written = value;
  };
  const clear = () => { value = ''; written = ''; };
  const paste = () => {
    const text = value.trim();
    value = '';
    if (!text) return;
    try { markOrigin(); } catch {}
    write(bracketPaste(text));
    write('\r');
  };
  const submit = () => {
    if (frozen) { clear(); return; }
    if (!written) { paste(); return; }
    syncRow();
    try { markOrigin(); } catch {}
    write('\r');
    clear();
  };
  const trigger = attachTriggerSubmit(composer, {
    getConfig, markOrigin: () => {}, send: submit, onVoiceFire, holdsFire, onVoiceStop, quietMs, releaseMs, timers, trace,
  });
  return {
    draft(text) {
      trigger.draft(text);
      syncRow();
    },
    released() {
      trigger.released();
      trigger.check();
      if (frozen) { clear(); return; }
      if (written) { syncRow(); return; }
      paste();
    },
    userTyped() {
      if (frozen) return;
      frozen = true;
      note('pty row frozen by keystroke');
    },
    resetSpan() {
      trigger.resetSpan();
      clear();
      frozen = false;
    },
    pending: () => value,
    dispose() { clear(); trigger.dispose(); },
  };
}

module.exports = {
  applyDraft, createComposerTrigger, attachTriggerSubmit, createPtyVoiceDraft,
  VOICE_QUIET_MS, VOICE_RELEASE_MS, PASTE_OPEN, PASTE_CLOSE, bracketPaste,
};
