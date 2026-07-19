'use strict';
// tool-gate.test.js — the New Session dialog's Create-gate decision leaf (Task 12).
// Pure: given the selected type + the tools:check payload, decide ok/disabled +
// the inline notice. bash is never gated; a null check (pre-probe) never blocks.

const test = require('node:test');
const assert = require('node:assert');
const {
  newSessionToolGate, installSessionParams,
  newSessionOverlayPlan, shouldRaiseOverlay, agentInstallButtons,
} = require('../renderer/lib/tool-gate');

const check = {
  byTool: {
    claude: { present: false, notice: { kind: 'error', text: 'claude CLI not found on PATH — install: …' } },
    codex: { present: true, notice: { kind: 'ok', text: 'codex found' } },
  },
};

test('bash is NEVER gated', () => {
  const g = newSessionToolGate('bash', check);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.disabled, false);
  assert.strictEqual(g.notice, null);
});

test('an unknown type is not gated (defensive)', () => {
  assert.strictEqual(newSessionToolGate('mystery', check).disabled, false);
});

test('claude missing → gated, disabled, carries the tool notice', () => {
  const g = newSessionToolGate('claude', check);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.disabled, true);
  assert.strictEqual(g.notice.kind, 'error');
  assert.match(g.notice.text, /not found on PATH/);
});

test('codex present → allowed, no notice', () => {
  const g = newSessionToolGate('codex', check);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.disabled, false);
  assert.strictEqual(g.notice, null);
});

test('null check (before the probe resolves) → not blocked, re-gates when it lands', () => {
  const g = newSessionToolGate('claude', null);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.disabled, false);
  assert.strictEqual(g.notice, null);
});

test('a report with no notice still blocks with a sensible fallback', () => {
  const g = newSessionToolGate('claude', { byTool: { claude: { present: false } } });
  assert.strictEqual(g.disabled, true);
  assert.match(g.notice.text, /claude CLI not found on PATH/);
});

// ── Install button (Task 14) ─────────────────────────────────────────────────
const installCheck = {
  byTool: {
    claude: { present: false, notice: { kind: 'error', text: 'claude CLI not found on PATH — install: …' }, install: 'curl -fsSL https://claude.ai/install.sh | bash' },
    codex: { present: true, notice: { kind: 'ok', text: 'codex found' }, install: 'npm i -g @openai/codex' },
    git: { present: false, notice: { kind: 'error', text: 'git CLI not found on PATH' }, install: null },
  },
};

test('missing tool WITH an install remedy → gate carries an install button descriptor', () => {
  const g = newSessionToolGate('claude', installCheck);
  assert.ok(g.install, 'install descriptor present');
  assert.strictEqual(g.install.tool, 'claude');
  assert.strictEqual(g.install.label, 'Install claude…');
  assert.strictEqual(g.install.sessionName, 'install-claude');
  assert.match(g.install.command, /claude\.ai\/install\.sh/);
});

test('present tool → no install button (nothing to install)', () => {
  assert.strictEqual(newSessionToolGate('codex', installCheck).install, null);
});

test('missing tool WITHOUT an install line → no button, notice only', () => {
  const g = newSessionToolGate('git', installCheck);
  // git isn't a gated type (only claude/codex), so it's never disabled — but even
  // a gated type with install:null yields no button. Assert the null-install case
  // directly for a gated type:
  assert.strictEqual(newSessionToolGate('claude', { byTool: { claude: { present: false, install: null } } }).install, null);
  assert.strictEqual(g.install, null);
});

test('bash/null-check gates carry no install button', () => {
  assert.strictEqual(newSessionToolGate('bash', installCheck).install, null);
  assert.strictEqual(newSessionToolGate('claude', null).install, null);
});

test('installSessionParams: builds bash session params from a gate install descriptor + home', () => {
  const g = newSessionToolGate('claude', installCheck);
  const p = installSessionParams(g.install, '/Users/x');
  assert.deepStrictEqual(p, {
    name: 'install-claude', type: 'bash', cwd: '/Users/x',
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
  });
});

test('installSessionParams: null/empty install → null (nothing to spawn)', () => {
  assert.strictEqual(installSessionParams(null, '/Users/x'), null);
  assert.strictEqual(installSessionParams({ sessionName: 'install-x', command: '' }, '/Users/x'), null);
});

// ── Prominence overlay plan (Task 18) ────────────────────────────────────────
const claudeCmd = 'curl -fsSL https://claude.ai/install.sh | bash';
const codexCmd = 'npm i -g @openai/codex';
const bothMissing = {
  byTool: {
    claude: { present: false, install: claudeCmd },
    codex: { present: false, install: codexCmd },
  },
};
const onlyClaudeMissing = {
  byTool: {
    claude: { present: false, install: claudeCmd },
    codex: { present: true, install: codexCmd },
  },
};

test('overlay: selected type missing (other present) → show, single tool, tool-specific headline', () => {
  const p = newSessionOverlayPlan('claude', onlyClaudeMissing);
  assert.strictEqual(p.show, true);
  assert.match(p.headline, /claude CLI isn't installed/);
  assert.strictEqual(p.tools.length, 1);
  assert.strictEqual(p.tools[0].tool, 'claude');
  assert.strictEqual(p.tools[0].install.sessionName, 'install-claude');
  assert.strictEqual(p.tools[0].install.label, 'Install claude…');
});

test('overlay: BOTH missing → show, both tools, both-missing headline', () => {
  const p = newSessionOverlayPlan('claude', bothMissing);
  assert.strictEqual(p.show, true);
  assert.match(p.headline, /No agent CLI is installed/);
  assert.deepStrictEqual(p.tools.map((t) => t.tool), ['claude', 'codex']);
  assert.ok(p.tools.every((t) => t.install));
  // Same both-missing overlay regardless of which missing type is selected.
  assert.deepStrictEqual(newSessionOverlayPlan('codex', bothMissing).tools.map((t) => t.tool), ['claude', 'codex']);
});

test('overlay: selected type PRESENT → never show (even if the other is missing)', () => {
  assert.strictEqual(newSessionOverlayPlan('codex', onlyClaudeMissing).show, false);
});

test('overlay: null / unknown check → never show (unknown is not missing)', () => {
  assert.strictEqual(newSessionOverlayPlan('claude', null).show, false);
  assert.strictEqual(newSessionOverlayPlan('claude', { byTool: {} }).show, false);
  assert.strictEqual(newSessionOverlayPlan('claude', { byTool: { claude: { present: true } } }).show, false);
});

test('overlay: bash / template(bash) / unknown type → never show', () => {
  assert.strictEqual(newSessionOverlayPlan('bash', bothMissing).show, false);
  assert.strictEqual(newSessionOverlayPlan('mystery', bothMissing).show, false);
});

test('overlay: missing tool WITHOUT an install line → shown but install null', () => {
  const p = newSessionOverlayPlan('claude', { byTool: { claude: { present: false } } });
  assert.strictEqual(p.show, true);
  assert.strictEqual(p.tools[0].install, null);
});

// ── Dismiss / re-raise policy (Task 18) ──────────────────────────────────────
test('shouldRaiseOverlay: raises when plan.show and not dismissed', () => {
  assert.strictEqual(shouldRaiseOverlay({ show: true }, false), true);
});
test('shouldRaiseOverlay: suppressed once dismissed (no re-pop within an open)', () => {
  assert.strictEqual(shouldRaiseOverlay({ show: true }, true), false);
});
test('shouldRaiseOverlay: never raises a non-showing plan, or a null plan', () => {
  assert.strictEqual(shouldRaiseOverlay({ show: false }, false), false);
  assert.strictEqual(shouldRaiseOverlay(null, false), false);
});

// ── Diag banner install buttons (Task 18) ────────────────────────────────────
test('agentInstallButtons: both missing → both descriptors, in claude/codex order', () => {
  const btns = agentInstallButtons(bothMissing);
  assert.deepStrictEqual(btns.map((b) => b.tool), ['claude', 'codex']);
  assert.deepStrictEqual(btns.map((b) => b.sessionName), ['install-claude', 'install-codex']);
});
test('agentInstallButtons: only the missing agent CLI (present one excluded)', () => {
  assert.deepStrictEqual(agentInstallButtons(onlyClaudeMissing).map((b) => b.tool), ['claude']);
});
test('agentInstallButtons: null check / no byTool → empty', () => {
  assert.deepStrictEqual(agentInstallButtons(null), []);
  assert.deepStrictEqual(agentInstallButtons({}), []);
});
test('agentInstallButtons: missing but no install line → excluded', () => {
  assert.deepStrictEqual(agentInstallButtons({ byTool: { claude: { present: false } } }), []);
});
