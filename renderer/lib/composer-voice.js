'use strict';

const { findSubmit, shouldFire } = require('./voice-submit');

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
  };
}

function attachTriggerSubmit(composer, {
  getConfig, markOrigin, send, hasImages = () => false, onVoiceFire = () => {},
  holdsFire = () => false, onVoiceStop = () => {}, quietMs = 0, timers = { set: setTimeout, clear: clearTimeout },
}) {
  const trigger = createComposerTrigger({ getConfig });
  let span = null;
  let quiet = null;
  let stopping = false;
  const fire = (fromVoice) => {
    const hit = trigger.check(composer.value);
    if (!hit) return;
    composer.value = hit.text;
    if (fromVoice) { try { onVoiceFire(); } catch {} }
    let images = false;
    try { images = hasImages() === true; } catch { images = false; }
    if (!hit.text.trim() && !images) return;
    try { markOrigin(); } catch {}
    send();
  };
  const voiceFire = () => {
    let open = false;
    try { open = holdsFire() === true; } catch { open = false; }
    if (!open) { stopping = false; fire(true); return; }
    if (stopping || !trigger.matches(composer.value)) return;
    stopping = true;
    try { onVoiceStop(); } catch {}
  };
  const onInput = () => fire(false);
  const cancelQuiet = () => { if (quiet !== null) { timers.clear(quiet); quiet = null; } };
  composer.addEventListener('input', onInput);
  return {
    check: onInput,
    draft(text) {
      const next = applyDraft(composer.value, span, text);
      composer.value = next.value;
      span = next.span;
      cancelQuiet();
      quiet = timers.set(() => { quiet = null; voiceFire(); }, quietMs);
    },
    released() {
      if (!stopping) return;
      stopping = false;
      cancelQuiet();
      fire(true);
    },
    resetSpan() { span = null; stopping = false; },
    dispose() {
      cancelQuiet();
      composer.removeEventListener('input', onInput);
    },
  };
}

module.exports = { applyDraft, createComposerTrigger, attachTriggerSubmit };
