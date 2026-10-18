// Run: node --test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'inbox-drawer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

function fnBody(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const next = SRC.indexOf('\n  function ', start + 1);
  const nextAsync = SRC.indexOf('\n  async function ', start + 1);
  const ends = [next, nextAsync].filter((i) => i > 0);
  return SRC.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('the drawer pulls one bounded open-requests snapshot, not the whole store', () => {
  assert.ok(/openRequests\(\{ limit/.test(SRC), 'renderList asks for a bounded window');
  assert.ok(!/listNotifications\(/.test(SRC), 'the unbounded listNotifications call is gone');
  assert.ok(!/pageNotifications\(/.test(SRC), 'the old notes-only page is gone');
});

test('the badge counts open requests', () => {
  assert.ok(/openRequestCount\(\)/.test(fnBody('refreshBadge')), 'refreshBadge reads openRequestCount');
  assert.ok(/\.open\b/.test(fnBody('refreshBadge')), 'and shows its open field');
  assert.ok(!/notificationUnreadCount/.test(SRC), 'the unread-notes count is gone');
});

test('the drawer offers a Load older row that grows the window by 30', () => {
  assert.ok(/Load older/.test(SRC), 'the row is labelled Load older');
  assert.ok(/inbox-load-older/.test(SRC), 'the row carries the class the stylesheet targets');
  assert.ok(/loaded \+= 30/.test(SRC), 'a click grows the window by 30');
});

test('each note has an × that removes it', () => {
  assert.ok(/inbox-delete/.test(SRC), 'the button carries the class the stylesheet targets');
  assert.ok(/removeNotification\(note\.id\)/.test(SRC), 'a click removes the note main-side');
  assert.ok(/stopPropagation\(\)/.test(SRC), 'no row handler fires under the ×');
  assert.ok(/createElement\('button'\)[\s\S]*?textContent = '×'/.test(SRC), 'the × is built as a DOM node');
  assert.ok(!/<button[^>]*inbox-delete/.test(SRC), 'the head innerHTML must not gain a button');
});

test('a permission row never renders its message through innerHTML', () => {
  const body = fnBody('renderRequest');
  assert.ok(/msg\.textContent = /.test(body), 'the message lands as text');
  assert.ok(!/innerHTML/.test(body), 'renderRequest writes no markup');
  assert.ok(!/innerHTML/.test(fnBody('rowHead')), 'nor does the row head it builds on');
});

test('Send posts the reply for this note', () => {
  const body = fnBody('renderReplyBox');
  assert.ok(/async function send\(\)[\s\S]*?replyNotification\(note\.id, text\)/.test(body), 'send() calls replyNotification(note.id, text)');
  assert.ok(/button\('inbox-reply-send', 'Send'[^\n]*send\(\)/.test(body), 'the Send button runs send()');
});

test('a permission-row click tries the local seat before asking main to reveal it', () => {
  const body = fnBody('revealRequest');
  const f = body.indexOf('focusSeat(req.name)');
  const r = body.indexOf('revealSession(req.name)');
  assert.ok(f >= 0 && r > f, 'focusSeat precedes revealSession');
});

test('the coverage line has a stable element', () => {
  assert.ok(/getElementById\('inbox-coverage'\)/.test(SRC), 'the drawer writes #inbox-coverage');
  assert.ok(/<div id="inbox-coverage"/.test(HTML), 'index.html carries #inbox-coverage');
});

test('attention:changed only triggers a re-pull; its payload is never read', () => {
  assert.ok(/onAttentionChanged\(\(\) => refreshFromEvent\(\)\)/.test(SRC), 'the handler takes no argument and refreshes');
  assert.ok(/addEventListener\('focus', refreshBadge\)/.test(SRC), 'window focus refreshes the badge');
});

test('the 30 s refresh runs only while the drawer is open', () => {
  assert.ok(/setInterval\(refreshFromEvent, REFRESH_MS\)/.test(fnBody('openDrawer')), 'opening starts it');
  assert.ok(/clearInterval\(tick\)/.test(fnBody('closeDrawer')), 'closing clears it');
  assert.ok(/REFRESH_MS = 30000/.test(SRC), 'every 30 s');
});

test('rows resolve only by an explicit action: no click-to-read is left', () => {
  assert.ok(!/el\.addEventListener\('click'[\s\S]{0,200}markNotificationRead/.test(SRC), 'a row click does not mark read');
  assert.ok(/'Done'/.test(fnBody('renderNote')), 'Done resolves a note');
});
