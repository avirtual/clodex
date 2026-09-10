// Run: node --test
// Source pins for renderer/inbox-drawer.js: the drawer is DOM-bound, so the
// paging window and its "Load older" row are pinned by shape here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'inbox-drawer.js'), 'utf8');

test('the drawer fetches a page, not the whole store', () => {
  assert.ok(/pageNotifications\(\{ limit/.test(SRC), 'renderList asks for a bounded window');
  assert.ok(!/listNotifications\(/.test(SRC), 'the unbounded listNotifications call is gone');
});

test('the drawer offers a Load older row that grows the window by 30', () => {
  assert.ok(/Load older/.test(SRC), 'the row is labelled Load older');
  assert.ok(/inbox-load-older/.test(SRC), 'the row carries the class the stylesheet targets');
  assert.ok(/loaded \+= 30/.test(SRC), 'a click grows the window by 30');
});
