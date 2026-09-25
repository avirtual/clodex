'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { initVoicePopover } = require('../renderer/popovers/voice-popover');

function fakeEl(classes = []) {
  const set = new Set(classes);
  const el = {
    _html: '',
    style: {},
    offsetWidth: 200,
    classList: { contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c) },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 100, top: 400 }),
    querySelector: () => null,
  };
  return el;
}

function harness({ capable = true, cause = null, reading = 'off', recording = false } = {}) {
  const prevDoc = global.document;
  const prevWin = global.window;

  const pop = fakeEl(['hidden']);
  const body = fakeEl();
  const ids = { 'voice-popover': pop, 'voice-popover-body': body, 'voice-popover-close': fakeEl() };
  global.document = {
    getElementById: (id) => {
      if (!(id in ids)) throw new Error(`fakeDocument: unhandled id ${id}`);
      return ids[id];
    },
    createElement: () => ({ textContent: '', get innerHTML() { return String(this.textContent); } }),
    addEventListener() {},
  };
  global.window = {
    innerWidth: 1200,
    innerHeight: 800,
    api: { getSettings: async () => { throw new Error('no settings in this fixture'); } },
  };

  const core = {
    subscribe() { return () => {}; },
    snapshot: () => ({ state: null, pending: null, mode: 'tap', capable, cause, force: false }),
    isMode: (m) => ['off', 'tap'].includes(m),
    choose() {},
  };

  let api;
  try {
    api = initVoicePopover({
      core,
      renderProxyBar: () => {},
      getRecorderReading: () => reading,
      getRecorderCause: () => null,
      tapOffRecorder: () => true,
      isRecording: () => recording,
    });
  } catch (e) {
    global.document = prevDoc; global.window = prevWin;
    throw e;
  }

  return {
    api, pop, body,
    rowsHtml() {
      api.openVoicePopover(fakeEl());
      const html = body.innerHTML;
      api.closeVoicePopover();
      return html;
    },
    restore() { global.document = prevDoc; global.window = prevWin; },
  };
}

test('capable: the bar button reads as live — no aria-disabled, no dead class, the ordinary tip', () => {
  const h = harness({ capable: true });
  try {
    const html = h.api.actionHtml();
    assert.ok(!html.includes('aria-disabled'), 'a machine that can record must not mark its own button dead');
    assert.ok(!html.includes('px-voice-dead'));
    assert.ok(html.includes('click to change'), 'and keeps the tip that says the button does something');
  } finally { h.restore(); }
});

test('capable tap seat: the button reads on, its tip says it opens the settings, and the rows are Off and On', () => {
  const h = harness({ capable: true });
  try {
    const html = h.api.actionHtml();
    assert.ok(html.includes('>🎤 on</button>'), html);
    assert.ok(html.includes('data-tip="click to change voice settings"'), html);
    assert.ok(!html.includes('right-click'));
    const rows = h.rowsHtml();
    assert.deepStrictEqual([...rows.matchAll(/data-mode="(\w+)"/g)].map((m) => m[1]), ['off', 'tap']);
    assert.deepStrictEqual([...rows.matchAll(/voice-row-name">([^<]+)</g)].map((m) => m[1]), ['Off', 'On']);
    assert.ok(rows.includes('No voice input on this seat'));
    assert.ok(rows.includes('Press space on an empty prompt to dictate; say the trigger word to send'));
  } finally { h.restore(); }
});

test('recording: the bar button lights live and reads listening', () => {
  const h = harness({ capable: true, recording: true });
  try {
    const html = h.api.actionHtml();
    assert.ok(html.includes('px-voice-live'), html);
    assert.ok(html.includes('🎤 listening'), html);
  } finally { h.restore(); }
});

test('not recording on a tap seat: the bar button reads on and is not live', () => {
  const h = harness({ capable: true, recording: false });
  try {
    const html = h.api.actionHtml();
    assert.ok(html.includes('🎤 on'), html);
    assert.ok(!html.includes('px-voice-live'), html);
  } finally { h.restore(); }
});

test('not capable: the bar button reads disabled to a11y and CSS, stays clickable, and its tip names the cause', () => {
  const h = harness({ capable: false, cause: 'no audio capture device on this machine' });
  try {
    const html = h.api.actionHtml();
    assert.ok(!/<button[^>]*\sdisabled[\s=>]/.test(html),
      'the button must NOT carry the disabled attribute — it would swallow the click that opens the explanation');
    assert.ok(html.includes('aria-disabled="true"'), 'it must still read as disabled to assistive tech');
    assert.ok(html.includes('px-voice-dead'), 'and carry the class that dims it');
    assert.ok(html.includes('Voice input is unavailable on this machine'), 'the tip must say the controls are dead');
    assert.ok(html.includes('no audio capture device on this machine'), 'and it must name the cause, not just the fact');
    assert.ok(html.includes('data-act="voice"'), 'the opener must survive: this button is the popover\u2019s only entry point');
    assert.ok(!html.includes('click to change'), 'the tip that promises a mode change must be gone');
  } finally { h.restore(); }
});

test('the cause is escaped into the tip attribute', () => {
  const h = harness({ capable: false, cause: 'sox "missing" <here>' });
  try {
    const html = h.api.actionHtml();
    assert.ok(!html.includes('"missing"'), 'a raw quote in the cause would close the attribute');
    assert.ok(html.includes('&quot;missing&quot;'), 'the quote must arrive escaped');
  } finally { h.restore(); }
});

test('not capable: the indicator is a reading only, with no data-rec for the click handler', () => {
  const h = harness({ capable: false, cause: 'SoX is not installed on this machine' });
  try {
    const html = h.rowsHtml();
    assert.ok(html.includes('rec-unavailable'));
    assert.ok(!html.includes('data-rec'), 'the unavailable indicator must not be clickable');
  } finally { h.restore(); }
});

test('capable: the indicator keeps data-rec, so the tap-off click still works', () => {
  const h = harness({ capable: true, reading: 'lit' });
  try {
    const html = h.rowsHtml();
    assert.ok(html.includes('data-rec'), 'nothing changes for a machine that can record');
  } finally { h.restore(); }
});

test('not capable beats a LIT recorder reading: the indicator says no microphone', () => {
  const h = harness({ capable: false, cause: 'SoX is not installed on this machine', reading: 'lit' });
  try {
    const html = h.rowsHtml();
    assert.ok(html.includes('rec-unavailable'), 'the unavailable state must be the one painted');
    assert.ok(html.includes('No microphone on this machine'), 'and it must say so in words');
    assert.ok(!html.includes('rec-lit'), 'the lit state must not win over a machine that cannot record');
    assert.ok(html.includes('SoX is not installed on this machine'), 'the hint must carry the capability cause');
  } finally { h.restore(); }
});

test('capable: the same lit reading paints the recording state as before', () => {
  const h = harness({ capable: true, reading: 'lit' });
  try {
    const html = h.rowsHtml();
    assert.ok(html.includes('rec-lit'), 'nothing changes for a machine that can record');
    assert.ok(!html.includes('rec-unavailable'), 'and the new state must not leak onto it');
  } finally { h.restore(); }
});

test('not capable: the mode rows render dead and carry no data-mode for the click handler to pick up', () => {
  const h = harness({ capable: false, cause: 'no audio capture device on this machine' });
  try {
    const html = h.rowsHtml();
    assert.ok(html.includes('voice-row-dead'), 'the picker rows must read as disabled');
    assert.ok(!html.includes('data-mode='), 'and must carry no data-mode — the click handler picks the row off that attribute');
    assert.ok(html.includes('no audio capture device on this machine'), 'the note under the rows must say why');
  } finally { h.restore(); }
});

test('capable: the mode rows still carry data-mode, so the picker works', () => {
  const h = harness({ capable: true });
  try {
    const html = h.rowsHtml();
    assert.ok(html.includes('data-mode="tap"'), 'the rows are pickable on a machine that can record');
    assert.ok(!html.includes('voice-row-dead'));
  } finally { h.restore(); }
});
