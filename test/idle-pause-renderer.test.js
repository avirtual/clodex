'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

function idlePauseBlock() {
  const m = rendererSrc.match(/^const idlePauseOverlay = [\s\S]*?^\}$/m);
  assert.ok(m, 'ENTER: no idle-pause dialog block in renderer.js');
  const block = rendererSrc.slice(m.index, rendererSrc.indexOf('window.api.idlePauseCurrent()', m.index) + 1);
  assert.match(block, /^async function answerIdlePause\(pause\) \{$/m, 'ENTER: the block holds the answer path');
  return block;
}

test('the dialog pause path answers main and never goes through the per-archive confirm', () => {
  const block = idlePauseBlock();
  assert.match(block, /window\.api\.idlePauseAnswer\(ask\.id, reply\)/);
  for (const banned of [/guardedArchive/, /requestArchiveRow/, /archiveSessionRow/, /window\.api\.archiveSession/, /\bconfirm\(/]) {
    assert.doesNotMatch(block, banned, `idle-pause block must not use ${banned}`);
  }
});

test('another window answering drops this window\'s dialog', () => {
  const block = idlePauseBlock();
  assert.match(block, /window\.api\.onIdlePauseClosed\(\(msg\) => \{ if \(idlePauseShown && msg && msg\.id === idlePauseShown\.id\) hideIdlePause\(\); \}\);/);
});

test('the dialog copy and the Preferences control', () => {
  assert.ok(htmlSrc.includes("Pausing stops a session's process and keeps its conversation. It stays in the sidebar and resumes when you click it."));
  assert.match(htmlSrc, /<button id="idle-pause-later" class="secondary" type="button">Not now<\/button>/);
  assert.match(htmlSrc, /<input type="number" id="prefs-idle-pause-hours" min="0" max="8760" step="1" value="48"/);
  assert.match(rendererSrc, /idlePauseGo\.textContent = `Pause \$\{n\} session\$\{n === 1 \? '' : 's'\}`;/);
});
