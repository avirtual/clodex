'use strict';

// external-tap-trigger.test.js — the ensure-on tap an OUTSIDE script asks for,
// and the seat it lands on.
//
// Its own file rather than cases in voice-submit.test.js: the routing half needs
// a SessionManager and the decision half needs a fake terminal, and the two
// halves are what this feature is. The predicates they lean on are pinned where
// they live; nothing here re-asserts those.
//
// EVERY DECISION ASSERTION IS ON THE BYTES THAT REACHED THE PTY, never on a
// predicate's return. A gate can be deleted and leave every function in
// lib/voice-submit.js still answering correctly while the character goes out
// anyway — which is the failure this whole subsystem is shaped around.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { createVoiceSubmitWatcher } = require('../renderer/voice-submit-watcher');
const { API_CONTRACT } = require('../api-contract');

// Measured off a live seat 2026-08-31 (CLI 2.1.251), same literals as
// voice-submit.test.js: the separator is a NON-BREAKING space, and spelling it
// as an ASCII one is what once left a rule returning false on every real
// composer with the suite green. Duplicated rather than exported from that
// file — a shared fixture would let one edit move both sides of every
// assertion at once.
// Spelled as escapes so an editor cannot silently "fix" the separator: it is a
// NON-BREAKING space, and an ASCII one here makes every empty-composer fixture
// read as a draft — the feature dead and the suite green.
const EMPTY_COMPOSER = '\u276f\u00a0';
const REC_ROW = ' agents \u23faREC \u00b7 tap to send';
const IDLE_ROW = ' agents \u00b7 tap to talk';

// Cursor on the LAST row unless a row carries `cursor: true` — so a fixture
// that paints the composer with an indicator BELOW it must mark the composer
// row explicitly, or the cursor lands on the indicator and the composer read
// looks at the wrong line entirely.
//
// `indicatorUnreadable` throws from the ROW COUNT, which is the one thing the
// indicator scan reads and the composer read does not — the only way to put the
// watcher in "cannot see the recorder, can see the composer", which is the state
// the polarity rule is about.
function fakeTerminal({ rows = [''], type = 'normal', indicatorUnreadable = false } = {}) {
  const state = { rows: rows.map((r) => (typeof r === 'string' ? { text: r } : r)), type };
  const cursorIndex = () => {
    const marked = state.rows.findIndex((r) => r && r.cursor);
    return marked === -1 ? state.rows.length - 1 : marked;
  };
  return {
    get rows() {
      if (indicatorUnreadable) throw new Error('screen unreadable');
      return state.rows.length;
    },
    buffer: {
      get active() {
        return {
          type: state.type,
          baseY: 0,
          get cursorY() { return cursorIndex(); },
          get cursorX() {
            const r = state.rows[cursorIndex()];
            return typeof r.cursorX === 'number' ? r.cursorX : r.text.length;
          },
          getLine: (y) => {
            const r = state.rows[y];
            if (!r) return null;
            return {
              translateToString: (_trim, start, end) =>
                r.text.slice(start ?? 0, end ?? r.text.length),
            };
          },
        };
      },
    },
    onWriteParsed() { return { dispose() {} }; },
  };
}

// Every watcher holds the composition poll's setInterval, so an assertion that
// throws jumps over its own dispose() and the surviving interval would hang the
// run on a timeout instead of naming the failure.
const live = [];
afterEach(() => { while (live.length) live.pop().dispose(); });

function tapHarness({
  // `cursor: true` is REQUIRED on the composer row of any multi-row paint: the
  // fake puts the cursor on the LAST row, and the real footer paints the
  // indicator BELOW the composer. Without it the composer read reads the
  // indicator row and every case here passes for the wrong reason.
  rows = [{ text: EMPTY_COMPOSER, cursor: true }, IDLE_ROW],
  type = 'normal',
  attention = null,
  voiceMode = 'tap',
  trigger = ' ',
  indicatorUnreadable = false,
} = {}) {
  const writes = [];
  const env = { attention, voiceMode, trigger };
  const watcher = createVoiceSubmitWatcher(fakeTerminal({ rows, type, indicatorUnreadable }), {
    // The external tap is deliberately NOT gated on the hands-free-submit
    // config, so this returns one enabled: a harness that switched it off would
    // pass every silence assertion below for the wrong reason.
    getConfig: () => ({ enabled: true, rearm: true, phrase: 'over and out' }),
    getAttention: () => env.attention,
    getVoiceMode: () => env.voiceMode,
    getTriggerKey: () => env.trigger,
    write: (d) => writes.push(d),
  });
  live.push(watcher);
  return { watcher, writes, env };
}

// ---------------------------------------------------------------- the polarity

// THE TRAP THIS FEATURE WAS DESIGNED AROUND, and the reason it does not reuse
// `recordingObserved` as its gate.
//
// That predicate answers FALSE for an unreadable screen — right where it feeds
// the voice-origin marker, fatal here. The obvious `if (!recordingObserved(rows))
// tap()` therefore takes the WRITE branch on a screen nobody can read, and if
// the recorder was in fact lit that character STOPS it, mid-sentence.
//
// The errors are not symmetric, which is the whole argument: declining while
// the mic was dark costs one repeated wake word, writing while it was lit costs
// the sentence being spoken. So the null is tested here explicitly.
//
// REACHING THE STATE IT NAMES took a specific fixture, and the obvious one does
// not. On the ALTERNATE buffer both reads decline, so the composer gate blocks
// the write and the null branch is never consulted — that version of this test
// passed against the trap implementation, i.e. pinned nothing. This one fails
// the indicator read ALONE: `indicatorRows` walks `terminal.rows` inside its
// try/catch and `cursorRow` never touches it, so the composer still reads clean
// and empty. That is the only shape where the null branch is what decides.
test('THE POLARITY: an unreadable INDICATOR is never written to, even with a clean composer', () => {
  const h = tapHarness({ indicatorUnreadable: true });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, [],
    'a character written here would STOP a recording that may well be live');
  assert.strictEqual(h.watcher.externalTapCount(), 0);
});

test('the ALTERNATE buffer is not written to either', () => {
  // A full-screen program is up: neither read means anything. Blocked by the
  // composer gate rather than by the null branch above — kept as its own case
  // precisely so the two reasons stay distinguishable.
  const h = tapHarness({ type: 'alternate' });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('a recorder already LIT is left alone — ensure-on, never toggle', () => {
  const h = tapHarness({ rows: [{ text: EMPTY_COMPOSER, cursor: true }, REC_ROW] });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, [], 'the byte would STOP the live recording');
  assert.strictEqual(h.watcher.externalTapCount(), 0);
});

// Without this row the two above pass for a gate that blocks unconditionally:
// the feature would be dead and the suite green. It is the only case here that
// asserts a byte WAS written.
test('a DARK recorder and an empty composer gets the trigger character', () => {
  const h = tapHarness();
  assert.strictEqual(h.watcher.externalTap(), true);
  assert.deepStrictEqual(h.writes, [' ']);
  assert.strictEqual(h.watcher.externalTapCount(), 1);
});

test('the character written is the CONFIGURED one, not a hardcoded space', () => {
  const h = tapHarness({ trigger: 'k' });
  h.watcher.externalTap();
  assert.deepStrictEqual(h.writes, ['k']);
});

test('no single character is bound to push-to-talk: nothing is written', () => {
  // A modifier chord resolves to null upstream, and a space written in hope
  // would just type into the draft.
  const h = tapHarness({ trigger: null });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('HOLD mode is not tapped', () => {
  // The swallow-and-toggle measured in the CLI is the tap branch specifically;
  // in hold mode one written character cannot reach the auto-repeat threshold,
  // so it lands in the draft as a literal and arms nothing.
  const h = tapHarness({ voiceMode: 'hold' });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('a NON-EMPTY composer is not tapped', () => {
  // The CLI's tap handler bails on a non-empty composer BEFORE it swallows the
  // key, so the character would be inserted into the operator's draft — and the
  // now-non-empty composer blocks every later re-arm too.
  const h = tapHarness({ rows: [{ text: '❯ half a thought', cursor: true }, IDLE_ROW] });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('a seat showing a PERMISSION dialog is not tapped', () => {
  // Any byte written into an open dialog ANSWERS it. This gate cannot be
  // inherited from the re-arm's: that one additionally requires hands-free
  // submit to be switched on, and this feature is not that one.
  const h = tapHarness({ attention: 'permission' });
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

test('a disposed watcher writes nothing', () => {
  const h = tapHarness();
  h.watcher.dispose();
  assert.strictEqual(h.watcher.externalTap(), false);
  assert.deepStrictEqual(h.writes, []);
});

// ------------------------------------------------------------------ the routing

// The REAL manager, from the real factory, with the deps voiceTap's path
// touches. Source-shape assertions were the alternative and are strictly
// weaker: they pass for a method that reads the right fields and sends
// nothing.
function mk(overrides = {}) {
  const { createSessionManager } = require('../session-manager');
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    intentEnabled: require('../intent-catalog').intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    fencedLines: require('../intent-scanner').fencedLines,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: require('node:fs'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    ...overrides,
  });
  return new SessionManager();
}

function fakeWin() {
  const win = {
    sent: [],
    webContents: { send: (...a) => win.sent.push(a) },
    isDestroyed: () => false,
    isFocused: () => true,
    show() {}, focus() {},
  };
  return win;
}

// A claude seat with a window attached, which is the only shape a tap can land
// on. `workspaceId` is what windowForSession resolves through.
function seat(m, name, { agentType = 'claude', dead = false } = {}) {
  const win = fakeWin();
  m.registerWindow('ws1', win);
  m.sessions.set(name, { name, agentType, workspaceId: 'ws1', _dead: dead });
  return win;
}

test('an explicit target is preferred over the focused seat', () => {
  const m = mk();
  const win = fakeWin();
  m.registerWindow('ws1', win);
  m.sessions.set('watched', { name: 'watched', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('named', { name: 'named', agentType: 'claude', workspaceId: 'ws1' });
  m.noteFocusedSession('watched');

  assert.deepStrictEqual(m.voiceTap('named'), { ok: true, name: 'named' });
  // The whole frame: a tap that reached the right seat over the wrong channel
  // is as dead as one that reached nobody.
  assert.deepStrictEqual(win.sent, [['voice-tap', 'named']],
    'a script can address a seat the operator is not looking at');
});

test('no target falls back to the focused seat', () => {
  const m = mk();
  const win = seat(m, 'watched');
  m.noteFocusedSession('watched');
  assert.deepStrictEqual(m.voiceTap(), { ok: true, name: 'watched' });
  assert.deepStrictEqual(win.sent, [['voice-tap', 'watched']]);
});

test('no target and nothing focused declines rather than guessing a seat', () => {
  const m = mk();
  const win = seat(m, 'lonely');
  // The ONLY live seat is deliberately present: a fallback of "the only one" or
  // "the first one" would pass a test where the map was empty.
  const r = m.voiceTap();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(win.sent, [], 'no seat was reported focused, so none is tapped');
});

test('a cleared focus stops routing at the seat that went away', () => {
  const m = mk();
  const win = seat(m, 'watched');
  m.noteFocusedSession('watched');
  m.noteFocusedSession(null);
  assert.strictEqual(m.voiceTap().ok, false);
  assert.deepStrictEqual(win.sent, []);
});

test('a DEAD seat, a BASH seat and an UNKNOWN name are each declined', () => {
  for (const [label, setup] of [
    ['dead', (m) => { seat(m, 's', { dead: true }); return 's'; }],
    ['bash', (m) => { seat(m, 's', { agentType: null }); return 's'; }],
    ['unknown', (m) => { seat(m, 's'); return 'someone-else'; }],
  ]) {
    const m = mk();
    const target = setup(m);
    const win = m.windowForWorkspace('ws1');
    const r = m.voiceTap(target);
    assert.strictEqual(r.ok, false, `${label}: declined`);
    assert.deepStrictEqual(win.sent, [], `${label}: no frame sent`);
  }
});

test('a seat whose window is gone is declined', () => {
  const m = mk();
  m.sessions.set('detached', { name: 'detached', agentType: 'claude', workspaceId: 'ws-closed' });
  m.noteFocusedSession('detached');
  // The renderer owns the decision, so a seat with no renderer attached has
  // nobody to make it — routing there would drop the tap silently.
  assert.strictEqual(m.voiceTap().ok, false);
});

test('the socket arm dispatches voice-tap and delivers it to NO transcript', () => {
  const m = mk();
  const win = seat(m, 'watched');
  m.noteFocusedSession('watched');
  // Arrives on some agent's socket — `targetName` is whichever socket the
  // sender could reach, NOT the seat acted on. Asserting that distinction is
  // the point of routing to 'watched' from a message addressed to 'courier'.
  m.sessions.set('courier', { name: 'courier', agentType: 'claude', workspaceId: 'ws1' });
  m._onIncoming('courier', { type: 'voice-tap', from: 'voice-tap' });

  assert.deepStrictEqual(win.sent, [['voice-tap', 'watched']],
    'the socket it arrived on identifies the app, not the seat');
});

test('the socket arm honours an explicit target on the envelope', () => {
  const m = mk();
  const win = fakeWin();
  m.registerWindow('ws1', win);
  m.sessions.set('courier', { name: 'courier', agentType: 'claude', workspaceId: 'ws1' });
  m.sessions.set('named', { name: 'named', agentType: 'claude', workspaceId: 'ws1' });
  m.noteFocusedSession('courier');
  m._onIncoming('courier', { type: 'voice-tap', from: 'voice-tap', target: 'named' });
  assert.deepStrictEqual(win.sent, [['voice-tap', 'named']]);
});

// ----------------------------------------------------------------- the contract

test('the two contract rows exist with the kinds the halves rely on', () => {
  const rows = new Map(API_CONTRACT.map((r) => [r.name, r]));
  // The WHOLE row each time: a kind that silently became 'invoke' would put a
  // round trip in front of a focus report, and a channel rename would leave
  // both halves compiling and neither talking.
  assert.deepStrictEqual(rows.get('noteFocusedSession'),
    { name: 'noteFocusedSession', kind: 'send', channel: 'session:focused' });
  assert.deepStrictEqual(rows.get('onVoiceTap'),
    { name: 'onVoiceTap', kind: 'on', channel: 'voice-tap' });
});

test('the sender script speaks the envelope the socket arm decodes', () => {
  const fs = require('fs');
  const path = require('path');
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'clodex-voice-tap.js'), 'utf-8');
  const handler = fs.readFileSync(
    path.join(__dirname, '..', 'session-manager.js'), 'utf-8');

  // The one hop nothing else covers: the script BUILDS the envelope and the
  // manager DISPATCHES on its type, in two files that never import each other.
  // Spelling either side differently leaves both green in isolation and the
  // wake word silently dead.
  assert.match(script, /type: 'voice-tap'/, 'the script sends type voice-tap');
  assert.match(handler, /mtype === 'voice-tap'/, 'the manager dispatches on it');
  assert.match(script, /\.\.\.\(target \? \{ target \} : \{\}\)/,
    'an absent target is OMITTED, not sent as null — the manager reads a string or falls back to focus');
  assert.match(handler, /typeof msg\.target === 'string' \? msg\.target : null/,
    'the manager takes the target only when it is a string');

  // Node builtins only: this runs from a shortcut, with no install step and no
  // access to the app's node_modules.
  const requires = [...script.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires.filter((r) => r.startsWith('.')), [],
    'the sender script must not require anything from the app tree');
});
