'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function notifySeam() {
  const start = SRC.indexOf('notifyOS: (opts) => {');
  assert.ok(start >= 0, 'main.js still defines the notifyOS seam');
  const end = SRC.indexOf('setAppQuitting:', start);
  assert.ok(end > start, 'the seam is followed by setAppQuitting');
  return SRC.slice(start, end);
}

test('every operator OS notification click shows a window and opens the Requests list', () => {
  const seam = notifySeam();
  assert.match(seam, /const n = new Notification\(opts\);/);
  const click = seam.indexOf("n.on('click', () => {");
  const show = seam.search(/^\s*n\.show\(\);/m);
  assert.ok(click >= 0, 'a click handler is attached');
  assert.ok(show > click, 'the handler is attached before the notification is shown');
  const handler = seam.slice(click, show);
  assert.match(handler, /const win = BrowserWindow\.getFocusedWindow\(\) \|\| BrowserWindow\.getAllWindows\(\)\[0\];/);
  assert.match(handler, /if \(win\) \{ win\.show\(\); win\.focus\(\); \}/, 'no window means no show/focus call, not a throw');
  assert.match(handler, /sendToFocused\('request-open-inbox-drawer'\);/);
});
