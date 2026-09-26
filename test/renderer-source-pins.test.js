// Run: node --test
// Source pins for renderer/renderer.js chrome that no headless harness reaches:
// the sidebar ✉ badge's click handler runs against a real DOM row and a live IPC
// bridge, so its behaviour is pinned by shape here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const MENUS_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'session-menus.js'), 'utf8');

// flushPending refuses with reason `busy` / `compact-window` / `dialog-blocked`
// (session-manager.js flushPending, via _injectHoldReason). A refusal the badge
// does not explain is the defect this pins: the click cleared nothing, said
// nothing, and looked broken.
test('the ✉ badge click handler carries a tip for every reason flushPending can refuse with', () => {
  const handler = SRC.match(/const pendingEl = item\.querySelector[\s\S]{0,1200}?\n  }\n/);
  assert.ok(handler, 'ENTER: the badge click handler is still found by this anchor');
  const src = handler[0];

  for (const RE of [
    /'dialog-blocked':\s*'Blocked on a permission dialog — answer it first, then flush'/,
    /busy:\s*'Seat is mid-turn — parked messages ride its next prompt; flush again when it is idle'/,
    /'compact-window':\s*'Seat is compacting — flush again once it settles'/,
  ]) {
    assert.ok(RE.test(src), `badge tip missing for ${RE}`);
  }

  assert.ok(/r\.ok === false/.test(src), 'the tip is set on the refusal verdict, not unconditionally');
});

for (const [label, anchor, src = SRC] of [
  ['restartSessionWithReattach', /function restartSessionWithReattach\(name\) \{[\s\S]*?\n\}\n/],
  ['moveSessionWithPicker', /function moveSessionWithPicker\(name\) \{[\s\S]*?\n\}\n/],
  ['moveSessionToPeerWithDialog respawn', /if \(res\.respawned\) \{[\s\S]*?switchSession\(name\);/],
  ['Edit Session save restart', /if \(res\.restarted\) \{\n    if \(source\) source\.onRestarted\(\);[\s\S]*?switchSession\(name\);/],
  ['failed-row retry', /function addFailedSessionToSidebar\(entry\) \{[\s\S]*?\n\}\n/],
  ['archived-row unarchive', /function addArchivedSessionToSidebar\(entry\) \{[\s\S]*?\n\}\n/],
  ['session-menu fresh restart', /async function doHardRestart\(name\) \{[\s\S]*?\n  \}\n/, MENUS_SRC],
  ['session-menu history resume', /historyMenu\.addEventListener\('click', async \(e\) => \{[\s\S]*?switchSession\(name\); \}\n    \}\);/, MENUS_SRC],
]) {
  test(`${label} marks the seat's io before createTerminal, so a stream seat is not rebuilt as an xterm`, () => {
    const m = src.match(anchor);
    assert.ok(m, `ENTER: ${label} is still found by this anchor`);
    const at = m[0].indexOf('createTerminal(');
    assert.ok(at > 0, `ENTER: ${label} still calls createTerminal`);
    const mark = m[0].indexOf('markSeatIo(');
    assert.ok(mark >= 0 && mark < at, `${label} must call markSeatIo before createTerminal`);
  });
}

test('session:retrySpawn returns the seat io, so a row built without one is still re-marked a stream seat', () => {
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'ipc-handlers.js'), 'utf8');
  const m = ipc.match(/handle\('session:retrySpawn'[\s\S]*?\n  \}\);\n/);
  assert.ok(m, 'ENTER: the retrySpawn handler is still found by this anchor');
  assert.ok(/return \{ ok: true, io: entry\.io \|\| 'pty' \};/.test(m[0]), 'retrySpawn reports the io it spawned with');
});

test('the stream seat pane mounts its permission cards before the composer and renders them from every pull', () => {
  const pane = SRC.match(/function createStreamSeatPane\(name, wrapperEl\) \{[\s\S]*?\n\}\n/);
  assert.ok(pane, 'ENTER: createStreamSeatPane is still found by this anchor');
  const src = pane[0];
  const permAt = src.indexOf('wrapperEl.appendChild(permEl);');
  const composerAt = src.indexOf('wrapperEl.appendChild(composer);');
  assert.ok(permAt > 0 && composerAt > permAt, '.seat-permissions is appended before the composer');
  assert.ok(/permEl\.className = 'seat-permissions';/.test(src));
  assert.ok(/const nextPermKey = Array\.isArray\(res\.permissions\) \? res\.permissions\.map\(\(i\) => i\.id\)\.join\('\\n'\) : permKey;/.test(src), 'the pull callback keys the pending prompts by id');
  assert.ok(/if \(nextPermKey !== permKey\) \{ permKey = nextPermKey; renderPermissions\(res\.permissions\); \}/.test(src), 'the cards rebuild only when the set of pending ids changes');
  assert.strictEqual(src.match(/renderPermissions\(/g).length, 1, 'renderPermissions is called only behind the key guard');
  assert.ok(/window\.api\.seatPermission\(name, item\.id, choice\.id\)/.test(src), 'a choice answers through the seat:permission bridge');
});

test('t1199: Escape in the stream composer interrupts the seat before any other key handling, and the turn state drives the placeholder', () => {
  const pane = SRC.match(/function createStreamSeatPane\(name, wrapperEl\) \{[\s\S]*?\n\}\n/);
  assert.ok(pane, 'ENTER: createStreamSeatPane is still found by this anchor');
  const src = pane[0];
  const kit = SRC.match(/function attachComposer\(composer, \{[^\n]*\) \{[\s\S]*?\n\}\n/);
  assert.ok(kit, 'ENTER: attachComposer is still found by this anchor');
  const keydown = kit[0].indexOf('const onKeydown = (e) => {');
  const esc = kit[0].indexOf("if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {");
  const call = kit[0].indexOf('onEscape();');
  const readline = kit[0].indexOf('composerReadlineEdit({');
  assert.ok(keydown > 0 && esc > keydown && call > esc && readline > call, 'Escape is handled before the readline edits in the shared composer keydown');
  assert.ok(/attachComposer\(composer, \{[\s\S]*?onEscape: \(\) => \{ Promise\.resolve\(window\.api\.seatInterrupt\(name\)\)/.test(src), 'the stream composer escapes into seatInterrupt');
  assert.ok(src.includes('? COMPOSER_RUNNING_PLACEHOLDER'), 'a running turn names Esc in the placeholder');
  assert.ok(SRC.includes("const COMPOSER_RUNNING_PLACEHOLDER = 'Message — Enter sends, Esc interrupts the turn';"));
});

test('the activity feed forwards the turn state and its start to both the stream seat and the pty seat\'s live split, and sets the pty composer placeholder', () => {
  const handler = SRC.match(/window\.api\.onSessionActivity\(\(name, state\) => \{[\s\S]*?\n\}\);\n/);
  assert.ok(handler, 'onSessionActivity handler found');
  const src = handler[0];
  assert.ok(src.includes('if (seat && seat.stream) seat.stream.setTurnRunning(state, since);'));
  assert.ok(src.includes('if (seat && seat.liveSplit) seat.liveSplit.setTurnRunning(state, since);'));
  assert.ok(src.includes("seat.composerEl.placeholder = state === 'thinking' ? COMPOSER_RUNNING_PLACEHOLDER : COMPOSER_PLACEHOLDER;"));
  assert.ok(src.indexOf('setTurnRunning') < src.indexOf('if (!el) return;'), 'a seat with no sidebar row is still told');
});
