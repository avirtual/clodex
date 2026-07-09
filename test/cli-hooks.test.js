// Run: node --test
// Covers cli-hooks' generated hook-script / settings strings against real temp
// dirs. The uiSettings + memoryStore deps are injected as minimal fakes (an
// empty statusline + an empty memory list), which is all the string generation
// touches. No PTY / CLI is spawned — only the files the setup functions write.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCliHooks } = require('../cli-hooks');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-hooks-')); }
function mk(REGISTRY_DIR) {
  return createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [] },     // empty digest
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
  });
}

test('setupClaudeHook: writes the transcript-symlink script + name-only output + settings', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  const settingsPath = h.setupClaudeHook('agent1');
  assert.strictEqual(settingsPath, path.join(REGISTRY_DIR, 'agent1-hook.json'));

  const script = fs.readFileSync(path.join(REGISTRY_DIR, 'agent1-hook.sh'), 'utf-8');
  assert.match(script, /ln -sf "\$TPATH" "\$TMPLINK"/); // repoints the transcript symlink
  assert.match(script, /agent1\.jsonl/);

  const out = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, 'agent1-hook-output.json'), 'utf-8'));
  assert.match(out.hookSpecificOutput.additionalContext, /clodex agent named 'agent1'/);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  assert.ok(Array.isArray(settings.hooks.SessionStart));
  assert.ok(Array.isArray(settings.hooks.UserPromptSubmit));
});

test('setupClaudeHook: proxyBase routes ANTHROPIC_BASE_URL through the per-agent path', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('a2', 'http://127.0.0.1:7800');
  const settings = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, 'a2-hook.json'), 'utf-8'));
  assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7800/agent/a2/anthropic');
});

test('setupCodexHook: writes a WB_WRAP_NAME-routed script + project hooks.json, backing up an existing one', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.codex', 'hooks.json'), '{"orig":true}');

  h.setupCodexHook('cx', cwd);
  const script = fs.readFileSync(path.join(REGISTRY_DIR, 'codex-session-hook.sh'), 'utf-8');
  assert.match(script, /WB_WRAP_NAME/);

  const hooks = JSON.parse(fs.readFileSync(path.join(cwd, '.codex', 'hooks.json'), 'utf-8'));
  assert.ok(Array.isArray(hooks.hooks.SessionStart));
  const backup = JSON.parse(fs.readFileSync(path.join(cwd, '.codex', 'hooks.json.wb-wrap-backup'), 'utf-8'));
  assert.strictEqual(backup.orig, true);
});

test('cleanupCodexHook: restores the backed-up hooks.json', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.codex', 'hooks.json'), '{"orig":true}');

  h.setupCodexHook('cx', cwd);
  h.cleanupCodexHook('cx', cwd);
  const restored = JSON.parse(fs.readFileSync(path.join(cwd, '.codex', 'hooks.json'), 'utf-8'));
  assert.strictEqual(restored.orig, true);
  assert.ok(!fs.existsSync(path.join(cwd, '.codex', 'hooks.json.wb-wrap-backup')));
});
