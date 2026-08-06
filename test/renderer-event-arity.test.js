'use strict';
// renderer-event-arity.test.js — every `kind: 'on'` binding delivers the PAYLOAD
// as the first callback argument. Both transports strip the event object before
// invoking the subscriber (preload.js's `callback(...args)`, api-shim.js's
// `set.add(cb)` fed from the frame's args), so a consumer written in the Electron
// `(event, data)` idiom shifts every byte into an ignored parameter.
//
// This shipped once: term-tab.js subscribed as `onWtermData((_e, data) => ...)`,
// so the drawer terminal spawned a shell, received its output, and wrote
// `undefined` to xterm — an empty pane indistinguishable from a shell that never
// started. Nothing else caught it: the main side was correct and unit-tested, the
// contract row was correct, and the renderer is DOM-bound so it has no unit tests
// of its own. The defect lives entirely in a parameter name.
//
// A textual scan is the right shape here precisely BECAUSE the consumers are
// untestable DOM code — the alternative is no coverage at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { API_CONTRACT } = require('../api-contract');

const RENDERER = path.join(__dirname, '..', 'renderer');

// `renderer/web/` is the browser transport itself, not a consumer of it.
function rendererFiles(dir = RENDERER, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'web') continue;
      rendererFiles(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const EVENTISH = /^_?(e|ev|evt|event)$/;

// Only inline arrow/function subscribers are legible to a scan; a consumer that
// passes a named function is skipped rather than guessed at.
function scan(src, onNames) {
  const sites = [];
  for (const name of onNames) {
    const re = new RegExp(`window\\.api\\.${name}\\(\\s*(?:function\\s*)?\\(([^)]*)\\)`, 'g');
    let m;
    while ((m = re.exec(src))) {
      const first = (m[1].split(',')[0] || '').trim();
      sites.push({ name, first });
    }
  }
  return sites;
}

const ON_NAMES = API_CONTRACT.filter((r) => r.kind === 'on').map((r) => r.name);

test('the contract actually has on-rows to scan for', () => {
  assert.ok(ON_NAMES.length > 10, `expected many on-rows, got ${ON_NAMES.length}`);
});

test('both transports hand the payload to the subscriber as arg 0', () => {
  // The property under test, read off the transports rather than assumed. If a
  // transport ever starts forwarding the event, this test is measuring the wrong
  // invariant and must fail loudly rather than keep policing consumers.
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /kind === 'on'[\s\S]{0,200}callback\(\.\.\.args\)/,
    'preload no longer strips the IpcRendererEvent — the consumer rule below changed');

  const shim = fs.readFileSync(path.join(RENDERER, 'web', 'api-shim.js'), 'utf8');
  assert.match(shim, /for \(const cb of \[\.\.\.set\]\) \{ try \{ cb\(\.\.\.args\)/,
    'api-shim no longer fans out raw payload args — the consumer rule below changed');
});

test('no renderer on-subscriber names its first parameter like an event object', () => {
  const offenders = [];
  let scanned = 0;

  for (const file of rendererFiles()) {
    const sites = scan(fs.readFileSync(file, 'utf8'), ON_NAMES);
    scanned += sites.length;
    for (const s of sites) {
      if (EVENTISH.test(s.first)) {
        offenders.push(`${path.relative(RENDERER, file)}: ${s.name}((${s.first}, …)`);
      }
    }
  }

  // ENTER: the reduction above must have found real subscribers. An empty scan
  // makes the assertion below vacuously true, which is exactly how a regex that
  // stops matching would hide every offender at once.
  assert.ok(scanned >= 20, `ENTER: expected 20+ on-subscriber call sites, scanned ${scanned}`);
  assert.deepStrictEqual(offenders, []);
});

test('the scan catches the shape it exists to catch', () => {
  // Without this, a regex that matches nothing passes the test above forever.
  const sites = scan('window.api.onWtermData((_e, data) => { terminal.write(data); });', ['onWtermData']);
  assert.strictEqual(sites.length, 1);
  assert.ok(EVENTISH.test(sites[0].first), 'the scanner no longer recognises the (_e, data) idiom');

  const ok = scan('window.api.onWtermData((data) => { terminal.write(data); });', ['onWtermData']);
  assert.strictEqual(ok.length, 1);
  assert.ok(!EVENTISH.test(ok[0].first), 'the scanner flags the CORRECT idiom');
});
