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

function harness({ capable = true, cause = null, reading = 'off' } = {}) {
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
    isMode: (m) => ['off', 'tap', 'hold'].includes(m),
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

test('capable: the bar button carries no disabled attribute and the ordinary tip', () => {
  const h = harness({ capable: true });
  try {
    const html = h.api.actionHtml();
    assert.ok(!html.includes('disabled'), 'a machine that can record must not disable its own button');
    assert.ok(html.includes('click to change'), 'and keeps the tip that says the button does something');
  } finally { h.restore(); }
});

test('not capable: the bar button renders disabled and its tip names the cause', () => {
  const h = harness({ capable: false, cause: 'no audio capture device on this machine' });
  try {
    const html = h.api.actionHtml();
    assert.ok(/<button[^>]*\sdisabled/.test(html), 'the button must carry the disabled attribute');
    assert.ok(html.includes('Voice input is unavailable on this machine'), 'the tip must say the controls are dead');
    assert.ok(html.includes('no audio capture device on this machine'), 'and it must name the cause, not just the fact');
    assert.ok(!html.includes('click to change'), 'the tip that promises an action must be gone');
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
