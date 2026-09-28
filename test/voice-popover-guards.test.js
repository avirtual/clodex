'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { initVoicePopover } = require('../renderer/popovers/voice-popover');

function fakeEl(classes = [], host = null) {
  const set = new Set(classes);
  return {
    _html: '',
    style: {},
    offsetWidth: 200,
    offsetHeight: 200,
    classList: { contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c), toggle() {} },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 100, top: 400 }),
    querySelector: (sel) => (sel === '.speak-host' ? host : null),
  };
}

function harness(settings) {
  const prev = { document: global.document, window: global.window };
  const host = fakeEl();
  const pop = fakeEl(['hidden']);
  const body = fakeEl([], host);
  const ids = { 'voice-popover': pop, 'voice-popover-body': body, 'voice-popover-close': fakeEl() };
  global.document = {
    getElementById: (id) => {
      if (!(id in ids)) throw new Error(`fakeDocument: unhandled id ${id}`);
      return ids[id];
    },
    createElement: () => {
      let text = '';
      return {
        set textContent(v) { text = String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      };
    },
    addEventListener() {},
  };
  global.window = { innerWidth: 1200, innerHeight: 800, api: { getSettings: async () => settings } };
  let subscriber = null;
  let paints = 0;
  const core = {
    subscribe(fn) { subscriber = fn; return () => {}; },
    snapshot: () => ({ state: null, pending: null, mode: 'tap', capable: true, cause: null, force: false }),
    isMode: (m) => ['off', 'tap'].includes(m),
    choose() {},
  };
  const api = initVoicePopover({
    core,
    renderProxyBar: () => { paints += 1; },
    getRecorderReading: () => 'off',
    getRecorderCause: () => null,
    tapOffRecorder: () => true,
    isRecording: () => false,
  });
  return {
    api,
    host,
    emit: (s) => subscriber(s),
    paints: () => paints,
    restore() { global.document = prev.document; global.window = prev.window; },
  };
}

test('the voice picker keeps a stored voice that is not in the enumerated list, selected, as its own option', async () => {
  const h = harness({
    speakReplies: true,
    speakVoice: 'Zarvox',
    speakVoices: [{ name: 'Daniel', locale: 'en_GB' }, { name: 'Samantha', locale: 'en_US' }],
    speakRate: 210,
  });
  try {
    h.api.openVoicePopover(fakeEl());
    await new Promise(setImmediate);
    const html = h.host.innerHTML;
    assert.ok(html.includes('class="speak-voice"'), `ENTER: the select branch was reached: ${html}`);
    assert.match(html, /<option value="Zarvox" selected>Zarvox \(set elsewhere\)<\/option>/);
    assert.ok(html.indexOf('value="Zarvox"') < html.indexOf('value="Daniel"'), 'the stored voice leads the list');
  } finally { h.api.closeVoicePopover(); h.restore(); }
});

test('a listed stored voice is selected in place and gets no extra option', async () => {
  const h = harness({
    speakReplies: true,
    speakVoice: 'Samantha',
    speakVoices: [{ name: 'Daniel', locale: 'en_GB' }, { name: 'Samantha', locale: 'en_US' }],
  });
  try {
    h.api.openVoicePopover(fakeEl());
    await new Promise(setImmediate);
    const html = h.host.innerHTML;
    assert.ok(html.includes('class="speak-voice"'), 'ENTER: the select branch was reached');
    assert.strictEqual((html.match(/<option value="Samantha"/g) || []).length, 1);
    assert.ok(!html.includes('set elsewhere'));
  } finally { h.api.closeVoicePopover(); h.restore(); }
});

test('a cause change on a not-capable seat is a real change: the subscriber repaints the bar', () => {
  const h = harness(null);
  try {
    h.emit({ pending: null, mode: 'tap', capable: false, cause: 'sox missing' });
    assert.strictEqual(h.paints(), 1, 'ENTER: the first emit paints');
    h.emit({ pending: null, mode: 'tap', capable: false, cause: 'no capture device' });
    assert.strictEqual(h.paints(), 2);
    h.emit({ pending: null, mode: 'tap', capable: false, cause: 'no capture device' });
    assert.strictEqual(h.paints(), 2, 'an identical emit is still gated');
    h.emit({ pending: null, mode: 'tap', capable: true, cause: 'stale' });
    h.emit({ pending: null, mode: 'tap', capable: true, cause: 'other' });
    assert.strictEqual(h.paints(), 3, 'a capable seat does not key on cause');
  } finally { h.restore(); }
});
