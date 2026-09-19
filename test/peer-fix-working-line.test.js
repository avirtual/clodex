'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const rendererSrc = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');

function el(tag = 'div') {
  const node = {
    tagName: tag,
    className: '',
    type: '',
    textContent: '',
    _html: null,
    children: [],
    parentNode: null,
    listeners: new Map(),
    addEventListener(t, fn) {
      if (!node.listeners.has(t)) node.listeners.set(t, []);
      node.listeners.get(t).push(fn);
    },
    appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
    remove() {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter((c) => c !== node);
      node.parentNode = null;
    },
    querySelector(sel) {
      const want = sel.replace(/^\./, '');
      for (const c of node.children) {
        if (c.className.split(/\s+/).includes(want)) return c;
        const deep = c.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
    async press() {
      for (const fn of node.listeners.get('click') || []) await fn({});
    },
  };
  Object.defineProperty(node, 'innerHTML', {
    get: () => node._html,
    set: (v) => { node._html = v; node.children = []; },
  });
  return node;
}

function loadAppendDeployActions(stubs) {
  const m = rendererSrc.match(/^function appendDeployActions\([\s\S]*?^\}$/m);
  assert.ok(m, 'ENTER: appendDeployActions was found in renderer.js');
  const names = Object.keys(stubs);
  return new Function(...names, `${m[0]}\nreturn appendDeployActions;`)(...names.map((n) => stubs[n]));
}

function harness({ fixResult }) {
  const toasts = [];
  const calls = [];
  const stubs = {
    document: { createElement: (tag) => el(tag) },
    window: {
      api: {
        confirmDeployFix: async () => true,
        peerDeployFix: async (...a) => { calls.push(a); return fixResult; },
      },
    },
    showToast: (text, opts) => toasts.push([text, opts]),
    peerTestAndSetUp: () => {},
  };
  const appendDeployActions = loadAppendDeployActions(stubs);
  const tailBox = el();
  const labelInput = el('input');
  labelInput.className = 'peer-row-label';
  labelInput.value = 'box';
  const row = el();
  row.appendChild(labelInput);
  appendDeployActions(tailBox, row, {}, 'user@box', 7911, '::fail preflight node-not-found');
  return { tailBox, toasts, calls };
}

test('a successful fix mint replaces the button row with a line naming the session', async () => {
  const { tailBox, toasts } = harness({ fixResult: { ok: true, name: 'fix-x' } });

  const fix = tailBox.querySelector('.peer-fix-btn');
  assert.ok(fix, 'ENTER: the Fix button exists before the press');
  await fix.press();

  const line = tailBox.querySelector('.peer-fix-working');
  assert.ok(line, 'a persistent working line is left in the panel');
  assert.ok(line.textContent.includes('fix-x'), `the line names the session; got: ${JSON.stringify(line.textContent)}`);
  assert.match(line.textContent, /post to your inbox when done/, 'it says where the outcome will arrive');
  assert.match(line.textContent, /click Test & Set Up again/, 'it says what to do next');
  assert.strictEqual(line._html, null, 'the line was never built by assigning innerHTML');

  assert.strictEqual(tailBox.querySelector('.peer-fix-btn'), null, 'the Fix button is gone');
  assert.strictEqual(tailBox.querySelector('.peer-retest-btn'), null, 'the whole action row went with it');
  assert.strictEqual(toasts.length, 1, 'the toast still fires alongside the line');
});

test('a failed fix mint leaves the buttons in place and adds no working line', async () => {
  const { tailBox, toasts } = harness({ fixResult: { ok: false, error: 'no slot' } });

  await tailBox.querySelector('.peer-fix-btn').press();

  assert.strictEqual(tailBox.querySelector('.peer-fix-working'), null,
    'nothing claims an agent is working when none was opened');
  assert.ok(tailBox.querySelector('.peer-fix-btn'), 'the Fix button survives so it can be retried');
  assert.ok(tailBox.querySelector('.peer-retest-btn'), 'so does Re-test');
  assert.match(toasts[0][0], /no slot/, 'the failure is reported');
});
