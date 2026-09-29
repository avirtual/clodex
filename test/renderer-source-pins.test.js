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
    const rebuild = SRC.match(/\nfunction rebuildLiveRow\(name, snap, res = \{\}\) \{[\s\S]*?\n\}\n/);
    const body = !m[0].includes('createTerminal(') && m[0].includes('rebuildLiveRow(') && rebuild ? rebuild[0] : m[0];
    const at = body.indexOf('createTerminal(');
    assert.ok(at > 0, `ENTER: ${label} still calls createTerminal`);
    const mark = body.indexOf('markSeatIo(');
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
  const pane = SRC.match(/function createStreamSeatPane\(name, wrapperEl, seat\) \{[\s\S]*?\n\}\n/);
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
  const pane = SRC.match(/function createStreamSeatPane\(name, wrapperEl, seat\) \{[\s\S]*?\n\}\n/);
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

test('the activity and attention feeds both forward the seat state to the stream seat, the pty live split and the pty composer placeholder, attention winning', () => {
  const fwd = SRC.match(/function forwardSeatActivity\(seat, activity, since\) \{[\s\S]*?\n\}\n/);
  assert.ok(fwd, 'forwardSeatActivity found');
  assert.ok(fwd[0].includes('if (seat.stream) seat.stream.setTurnRunning(activity, since);'));
  assert.ok(fwd[0].includes('if (seat.liveSplit) seat.liveSplit.setTurnRunning(activity, since);'));
  assert.ok(fwd[0].includes("seat.composerEl.placeholder = activity === 'thinking' || activity === 'attention' ? COMPOSER_RUNNING_PLACEHOLDER : COMPOSER_PLACEHOLDER;"));
  const act = SRC.match(/window\.api\.onSessionActivity\(\(name, state\) => \{[\s\S]*?\n\}\);\n/)[0];
  assert.ok(act.includes("forwardSeatActivity(seat, el && el.dataset.attention ? 'attention' : state, since);"), 'an activity event during a prompt keeps the still row');
  assert.ok(act.indexOf('forwardSeatActivity') < act.indexOf('if (!el) return;'), 'a seat with no sidebar row is still told');
  const attn = SRC.match(/window\.api\.onSessionAttention\(\(name, attn\) => \{[\s\S]*?\n\}\);\n/)[0];
  assert.ok(attn.includes("const activity = attn ? 'attention' : (el && el.dataset.activity) || 'idle';"));
  assert.ok(attn.indexOf('forwardSeatActivity(sessions.get(name), activity,') >= 0 && attn.indexOf('forwardSeatActivity') < attn.indexOf('if (!el) return;'), 'a prompt forwards attention to the seat');
  assert.ok(SRC.includes("return row.dataset.attention ? 'attention' : row.dataset.activity || 'idle';"), 'a mount prefers attention over activity');
});

test('createTerminal gives every local pty seat its per-seat view without reading the sidebar row, which is added after it', () => {
  const body = SRC.match(/\nfunction createTerminal\(name, peer = null\) \{[\s\S]*?\n\}\n/);
  assert.ok(body, 'ENTER: createTerminal is still found by this anchor');
  const src = body[0];
  assert.ok(src.includes('  const agentSeat = !peer;\n'), 'agentSeat is decided from the peer alone');
  assert.ok(src.includes("  const seat = agentSeat ? createSeatView(initialViewFor(name)) : {};\n"));
  assert.ok(!/const agentSeat = [^\n]*sessionTypeOf\(/.test(src), 'no eager sessionTypeOf for agentSeat');
  assert.ok(src.includes("if (seat.view === 'terminal' && liveSplit) liveSplit.setRaw(true);"));
});

test('a seat view choice is kept per name across a rebuild, and a delete or a rename drops it', () => {
  const body = SRC.match(/\nfunction createTerminal\(name, peer = null\) \{[\s\S]*?\n\}\n/);
  assert.ok(body, 'ENTER: createTerminal is still found by this anchor');
  assert.ok(SRC.includes('const initialViewFor = (name) => rememberedSeatView(seatViewMemory.get(name), seatViewPrefs(name));'));
  assert.strictEqual(body[0].split('.onView = (v) => seatViewMemory.set(name, v);').length - 1, 2, 'both the stream and the pty seat record their view');
  const refresh = SRC.match(/\nfunction refreshTranscriptPanes\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(refresh && refresh[0].includes('applySeatView(entry, initialSeatView(seatViewPrefs(name)))'), 'a Prefs change applies the Prefs view, not the remembered one');
  const del = SRC.match(/\nasync function deleteSessionRow\(name\) \{[\s\S]*?\n\}\n/);
  assert.ok(del && del[0].includes('seatViewMemory.delete(name);'));
  assert.ok(/streamSeatNames\.delete\(sessionName\);\n\s*seatViewMemory\.delete\(sessionName\);\n\s*rebuildLiveRow\(res\.name, /.test(SRC), 'a rename drops the old name');
});

test('running a control command from a line below other text keeps the other text', () => {
  const start = SRC.indexOf('  const pickSlash = (run) => {');
  assert.ok(start > 0, 'ENTER: pickSlash is still found by this anchor');
  const end = SRC.indexOf('\n  };\n', start);
  assert.ok(end > start, 'ENTER: the end of pickSlash was found');
  const body = SRC.slice(start, end + 5);
  const composer = { value: 'keep this\n/comp', dispatchEvent() {}, setSelectionRange() {} };
  const env = {
    slashItems: [{ kind: 'control', name: '/compact' }],
    slashIndex: 0,
    slashRange: { start: 10, end: 15 },
    composer,
    closeSlash() {},
    window: { api: { seatControl: () => Promise.resolve({ ok: true }) } },
    pull() {},
    showToast() {},
    sendComposer() {},
    name: 's',
  };
  const names = Object.keys(env);
  const pickSlash = new Function(...names, `${body}\nreturn pickSlash;`)(...names.map((n) => env[n]));
  pickSlash(true);
  assert.strictEqual(composer.value, 'keep this\n');
});

function slashFixture(seatControl) {
  const start = SRC.indexOf('  const pickSlash = (run) => {');
  assert.ok(start > 0, 'ENTER: pickSlash is still found by this anchor');
  const end = SRC.indexOf('\n  };\n', start);
  assert.ok(end > start, 'ENTER: the end of pickSlash was found');
  const body = SRC.slice(start, end + 5);
  const composer = { value: 'keep this\n/comp', dispatchEvent() {}, setSelectionRange() {} };
  const toasts = [];
  const env = {
    slashItems: [{ kind: 'control', name: '/compact' }],
    slashIndex: 0,
    slashRange: { start: 10, end: 15 },
    composer,
    closeSlash() {},
    window: { api: { seatControl } },
    pull() {},
    showToast(msg) { toasts.push(msg); },
    sendComposer() {},
    name: 's',
  };
  const names = Object.keys(env);
  const pickSlash = new Function(...names, `${body}\nreturn pickSlash;`)(...names.map((n) => env[n]));
  return { pickSlash, composer, toasts };
}

test('a control command the seat refuses puts the slash line back', async () => {
  const { pickSlash, composer, toasts } = slashFixture(() => Promise.resolve({ ok: false, error: 'busy' }));
  pickSlash(true);
  assert.strictEqual(composer.value, 'keep this\n', 'ENTER: the slash line was cut before the seat answered');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(composer.value, 'keep this\n/comp');
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /\/compact failed: busy/);
});

test('a control command whose IPC throws puts the slash line back', async () => {
  const { pickSlash, composer, toasts } = slashFixture(() => Promise.reject(new Error('gone')));
  pickSlash(true);
  assert.strictEqual(composer.value, 'keep this\n', 'ENTER: the slash line was cut before the IPC settled');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(composer.value, 'keep this\n/comp');
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /failed: gone/);
});

test('put-back is skipped when the operator typed meanwhile', async () => {
  const { pickSlash, composer, toasts } = slashFixture(() => Promise.resolve({ ok: false, error: 'busy' }));
  pickSlash(true);
  assert.strictEqual(composer.value, 'keep this\n', 'ENTER: the slash line was cut before the seat answered');
  composer.value = 'edited';
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(composer.value, 'edited');
  assert.strictEqual(toasts.length, 1, 'ENTER: the refusal path ran');
});

test('a proxy payload is aged by the host-relative ageMs, on seat switch, on emit and on a restored mount', () => {
  const { classifySubagent } = require('../renderer/lib/subagent-policy');
  const { proxyReceivedAt } = require('../proxy-util');
  const snapAt = SRC.indexOf('window.api.getProxySnapshot(name).then(');
  assert.ok(snapAt > 0, 'ENTER: the seat-switch snapshot handler is found by this anchor');
  const snapSrc = SRC.slice(SRC.indexOf('(p) => {', snapAt), SRC.indexOf('\n    }).catch(', snapAt) + 6);
  const emitAt = SRC.indexOf('window.api.onSessionProxy(');
  assert.ok(emitAt > 0, 'ENTER: the onSessionProxy handler is found by this anchor');
  const emitSrc = SRC.slice(emitAt + 'window.api.onSessionProxy('.length, SRC.indexOf('\n});\n', emitAt) + 2);
  const mountAt = SRC.indexOf('  if (entry.proxy) { proxyState.set(');
  assert.ok(mountAt > 0, 'ENTER: the restored-mount proxy line is found by this anchor');
  const mountSrc = `(entry) => {\n${SRC.slice(mountAt, SRC.indexOf('\n', mountAt))}\n}`;
  const noop = () => {};
  const env = {
    applyWarmBadge: noop, applySubagents: noop, refreshQuotaChip: noop, refreshActivityChips: noop,
    renderProxyBar: noop, activeSession: 'other', name: 's', proxyReceivedAt,
  };
  const receive = (label, fnSrc, p) => {
    const proxyState = new Map();
    const names = ['proxyState', ...Object.keys(env)];
    const handler = new Function(...names, `return ${fnSrc};`)(proxyState, ...Object.values(env));
    if (label === 'emit') handler('s', p);
    else if (label === 'restored mount') handler({ name: 's', proxy: p });
    else handler(p);
    const st = proxyState.get('s');
    assert.ok(st, `ENTER: the ${label} handler stored the payload`);
    return (Date.now() - st.at) / 1000;
  };
  const hostAheadMs = 60000;
  for (const [label, fnSrc] of [['seat switch', snapSrc], ['emit', emitSrc], ['restored mount', mountSrc]]) {
    const skewed = receive(label, fnSrc, { linked: true, ts: Date.now() + hostAheadMs - 2000, ageMs: 2000 });
    assert.ok(skewed >= 1.9 && skewed < 3, `${label}: a host 60s ahead serving a 2s-old payload reads ${skewed}s`);
    const older = receive(label, fnSrc, { linked: true, ts: Date.now() - 15000 });
    assert.ok(older >= 0 && older < 1, `${label}: an older host's payload with no ageMs is fresh at receipt, read ${older}s`);
    const p = { linked: true, ts: Date.now() + hostAheadMs, ageMs: 15000, subagents: [{ key: 'k', lastActiveS: 25 }] };
    const ageS = receive(label, fnSrc, p);
    assert.strictEqual(classifySubagent(p.subagents[0], ageS), 'done', `${label}: age ${ageS}s`);
  }
});

test('the 1 s tick re-classifies subagent rows', () => {
  const { fakeDocument } = require('./lib/fake-dom');
  const { classifySubagent } = require('../renderer/lib/subagent-policy');
  const fnStart = SRC.indexOf('function applySubagents(name) {');
  assert.ok(fnStart > 0, 'ENTER: applySubagents is still found by this anchor');
  const fnEnd = SRC.indexOf('\n}\n', fnStart);
  const rowsAt = SRC.indexOf('function subagentRows(name) {');
  assert.ok(rowsAt > 0, 'ENTER: subagentRows is still found by this anchor');
  const fnBody = SRC.slice(rowsAt, SRC.indexOf('\n}\n', rowsAt) + 2) + SRC.slice(fnStart, fnEnd + 2);
  const document = fakeDocument();
  const root = document.createElement('div');
  const item = document.createElement('div');
  item.className = 'session-item';
  item.dataset.name = 's';
  const child = document.createElement('div');
  child.className = 'session-child';
  child.dataset.parent = 's';
  child.dataset.key = 'k';
  child.dataset.state = 'active';
  root.appendChild(item);
  root.appendChild(child);
  const sessionList = {
    querySelector: (sel) => root.childNodes.find((n) => sel === `[data-name="${n.dataset.name}"]`) || null,
    querySelectorAll: (sel) => root.childNodes.filter((n) => n.className === 'session-child'
      && sel === `.session-child[data-parent="${n.dataset.parent}"]`),
  };
  const proxyState = new Map([['s', {
    payload: { linked: true, subagents: [{ key: 'k', label: 'k', lastActiveS: 0 }] },
    at: Date.now() - 400000,
  }]]);
  const env = {
    sessionList, proxyState, classifySubagent, document,
    CSS: { escape: (s) => s }, PROXY_POLL_MS: 5000,
    openActivityFeed() {}, fmtUsd: (n) => String(n),
  };
  const names = Object.keys(env);
  const applySubagents = new Function(...names, `${fnBody}\nreturn applySubagents;`)(...names.map((n) => env[n]));
  applySubagents('s');
  assert.deepStrictEqual(root.childNodes.map((n) => n.className), ['session-item'],
    'ENTER: applySubagents drops a child whose payload is 400 s old');

  const ticks = SRC.split('\nsetInterval(() => {').slice(1)
    .filter((s) => s.indexOf('\n}, 1000);') >= 0)
    .map((s) => s.slice(0, s.indexOf('\n}, 1000);')));
  assert.ok(ticks.length >= 1, 'ENTER: at least one 1 s interval block was cut');
  const tick = ticks.find((s) => s.includes('tickProxyBar()'));
  assert.ok(tick, 'ENTER: the 1 s interval that runs tickProxyBar is found');
  assert.ok(tick.includes('refreshQuotaChip()'), 'ENTER: it is the block that refreshes the quota chip');
  assert.match(tick, /applySubagents\(/);
});
