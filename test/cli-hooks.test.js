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
const cp = require('child_process');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');

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
  assert.strictEqual(settingsPath, pathFor(REGISTRY_DIR, 'agent1', 'settings'));

  const script = fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'hook'), 'utf-8');
  assert.match(script, /ln -sf "\$TPATH" "\$TMPLINK"/); // repoints the transcript symlink
  assert.match(script, /run\/agent1\/transcript\.jsonl/); // into the per-agent run dir

  const out = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'hookOutput'), 'utf-8'));
  assert.match(out.hookSpecificOutput.additionalContext, /clodex agent named 'agent1'/);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  assert.ok(Array.isArray(settings.hooks.SessionStart));
  assert.ok(Array.isArray(settings.hooks.UserPromptSubmit));
  // PostToolUse drains parked DMs MID-LOOP (between tool calls). It must carry
  // the pending drain ONLY — acks/ctxwarn are turn-boundary bookkeeping and must
  // not fire per-tool. Pin both facts: PostToolUse exists, and its single hook is
  // the same pendingScriptPath the UserPromptSubmit block's middle hook uses.
  assert.ok(Array.isArray(settings.hooks.PostToolUse));
  const postCmds = settings.hooks.PostToolUse[0].hooks.map((h) => h.command);
  const pendingCmd = settings.hooks.UserPromptSubmit[0].hooks[1].command; // acks, PENDING, ctxwarn
  assert.deepStrictEqual(postCmds, [pendingCmd], 'PostToolUse must drain pending only');
  assert.match(pendingCmd, /pending/); // the pending drain script, not acks/ctxwarn

  // The pending drain runs under BOTH events, so its output hookEventName must be
  // DERIVED from the firing event (stdin's hook_event_name), never hardcoded — a
  // PostToolUse hook returning "UserPromptSubmit" is an unsupported mismatch whose
  // additionalContext Claude Code may silently drop. Pin the derivation so a
  // regression back to a hardcoded event name is caught.
  const pendingBody = fs.readFileSync(pendingCmd, 'utf-8');
  assert.match(pendingBody, /IN="\$\(cat\)"/, 'pending drain must read the hook input off stdin');
  assert.match(pendingBody, /hook_event_name/, 'pending drain must derive the output event from stdin');
  assert.match(pendingBody, /"hookEventName": ev/, 'output event name must be the derived variable, not a literal');
});

test('setupClaudeHook: proxyBase routes ANTHROPIC_BASE_URL through the per-agent path', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('a2', 'http://127.0.0.1:7800');
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'a2', 'settings'), 'utf-8'));
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

// Regression guard for the M3 template-indent bug: wrapping the moved
// functions in a factory added a uniform +2 indent, and template literal
// INTERIORS are byte-significant — the indent leaked into every generated
// script. Heredoc terminators became "  PYEOF" (never recognized, bash fed
// the rest of the script to python) and python stdin sources gained a
// leading indent → "IndentationError: File <stdin>, line 1" on every
// UserPromptSubmit. A dedent-diff fidelity check is blind to this class by
// construction; these assertions pin the actual generated bytes.
test('generated scripts: heredoc terminators at column 0, python unindented', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent9');
  h.setupCodexHook('agent9', tmp());
  // Per-agent scripts live under run/<name>/; the shared codex hook stays at the
  // root. Collect both so the byte-shape check covers every generated .sh.
  const runDir = runDirFor(REGISTRY_DIR, 'agent9');
  const scripts = [
    ...fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.sh')).map((f) => path.join(REGISTRY_DIR, f)),
    ...fs.readdirSync(runDir).filter((f) => f.endsWith('.sh')).map((f) => path.join(runDir, f)),
  ];
  assert.ok(scripts.length >= 4, `expected several generated scripts, got ${scripts}`);
  for (const fp of scripts) {
    const f = path.basename(fp);
    const lines = fs.readFileSync(fp, 'utf-8').split('\n');
    assert.strictEqual(lines[0], '#!/bin/bash', `${f}: shebang must be line 1, column 0`);
    let inHeredoc = false;
    for (const [i, ln] of lines.entries()) {
      if (/<<'PYEOF'/.test(ln)) { inHeredoc = true; continue; }
      if (inHeredoc && ln === 'PYEOF') { inHeredoc = false; continue; }
      if (inHeredoc && ln.trim() === 'PYEOF') {
        assert.fail(`${f}:${i + 1}: heredoc terminator not at column 0: ${JSON.stringify(ln)}`);
      }
    }
    assert.ok(!inHeredoc, `${f}: heredoc never terminated (indented PYEOF?)`);
    // Python top-level statements must start at column 0 (4-space nesting ok).
    for (const [i, ln] of lines.entries()) {
      assert.ok(!/^ {1,3}(import |if |try:|texts = |claim = |d = )/.test(ln),
        `${f}:${i + 1}: python top-level line indented: ${JSON.stringify(ln)}`);
    }
  }
});

// @-inline at hook drain: the parked '@<path>' spill pointer is a PTY-stdin
// affordance (Claude expands @ only when TYPED). When the same text drains as
// additionalContext the @ is inert, so the pending-drain python inlines small
// files under ~/.clodex/messages/ and downgrades large ones to a read-pointer.
// These run the GENERATED bash/python end to end against a real pending dir —
// the only faithful test of the drain-time transform. The idle-edge PTY path is
// untouched (not exercised here); codex hooks never get this transform.
function drainPending(REGISTRY_DIR, name, texts) {
  const pendDir = path.join(REGISTRY_DIR, 'pending', name);
  fs.rmSync(pendDir, { recursive: true, force: true });
  fs.mkdirSync(pendDir, { recursive: true });
  texts.forEach((t, i) => fs.writeFileSync(path.join(pendDir, `m${i}.json`), JSON.stringify({ text: t })));
  const out = cp.execFileSync('bash', [pathFor(REGISTRY_DIR, name, 'pendingScript')], { input: '' }).toString();
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}

test('pending drain @-inline: small file under messages/ is inlined, prefix + trailer preserved', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('inl1');
  const msgFile = path.join(REGISTRY_DIR, 'messages', 'clodex', 'msg-1.txt');
  fs.mkdirSync(path.dirname(msgFile), { recursive: true });
  fs.writeFileSync(msgFile, 'line one\nline two\n');
  const ctx = drainPending(REGISTRY_DIR, 'inl1',
    [`[agent:from clodex] Message (17 bytes) attached: @${msgFile} (reply: start a line with [agent:dm clodex])`]);
  assert.match(ctx, /^\[agent:from clodex\] Message \(17 bytes\)/); // prefix preserved
  assert.match(ctx, /--- attached file: /);                        // delimited inline
  assert.match(ctx, /line one\nline two/);                         // body inlined verbatim
  assert.match(ctx, /--- end attached file ---/);
  assert.match(ctx, /\(reply: start a line with \[agent:dm clodex\]\)$/); // trailer preserved
  assert.ok(!ctx.includes('@' + msgFile), 'the @-pointer must be gone once inlined');
});

test('pending drain @-inline: file over ~10KB is stripped to a read-pointer, not inlined', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('inl2');
  const msgFile = path.join(REGISTRY_DIR, 'messages', 'clodex', 'msg-big.txt');
  fs.mkdirSync(path.dirname(msgFile), { recursive: true });
  fs.writeFileSync(msgFile, 'X'.repeat(11000));
  const ctx = drainPending(REGISTRY_DIR, 'inl2',
    [`[agent:from clodex] Message (11000 bytes) attached: @${msgFile} (reply: start a line with [agent:dm clodex])`]);
  assert.match(ctx, new RegExp(`saved to ${msgFile.replace(/[.]/g, '\\.')} — read it with your Read tool\\.`));
  assert.ok(!ctx.includes('@' + msgFile), 'the @ must be stripped so the CLI does not attach it');
  assert.ok(!ctx.includes('XXXX'), 'a large file must NOT be inlined');
  assert.match(ctx, /\(reply: start a line with \[agent:dm clodex\]\)/); // trailer preserved
});

test('pending drain @-inline: a path OUTSIDE messages/ is left byte-unchanged (containment)', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('inl3');
  const text = `[agent:from clodex] Message (10 bytes) attached: @/etc/hosts (reply: x)`;
  assert.strictEqual(drainPending(REGISTRY_DIR, 'inl3', [text]), text);
});

test('pending drain @-inline: a missing file is left byte-unchanged (fail-open)', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('inl4');
  const gone = path.join(REGISTRY_DIR, 'messages', 'clodex', 'nope.txt');
  const text = `[agent:from clodex] Message (10 bytes) attached: @${gone} (reply: x)`;
  assert.strictEqual(drainPending(REGISTRY_DIR, 'inl4', [text]), text);
});

test('pending drain @-inline: text without a spill pointer is untouched', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('inl5');
  const text = `[agent:from clodex] short inline body\n(reply: start a line with [agent:dm clodex])`;
  assert.strictEqual(drainPending(REGISTRY_DIR, 'inl5', [text]), text);
});

// Subagent theft guard: a subagent's tool calls fire the PARENT's PostToolUse
// hook, but the returned additionalContext lands in the subagent's context and
// is lost on exit. Subagent inputs carry agent_id; the drain must bail (defer)
// rather than consume the pending dir. Run the GENERATED script directly so the
// bash+python agent_id check is what's exercised.
function runPending(REGISTRY_DIR, name, input) {
  return cp.execFileSync('bash', [pathFor(REGISTRY_DIR, name, 'pendingScript')], { input }).toString();
}
test('pending drain: a subagent PostToolUse (agent_id present) defers — pending dir survives', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('sub1');
  const pendDir = path.join(REGISTRY_DIR, 'pending', 'sub1');
  fs.mkdirSync(pendDir, { recursive: true });
  fs.writeFileSync(path.join(pendDir, 'm0.json'), JSON.stringify({ text: 'parked while subagent ran' }));

  const subInput = JSON.stringify({ hook_event_name: 'PostToolUse', agent_id: 'abc123', agent_type: 'general-purpose' });
  const out = runPending(REGISTRY_DIR, 'sub1', subInput);
  assert.strictEqual(out.trim(), '', 'subagent event must produce no additionalContext');
  assert.ok(fs.existsSync(path.join(pendDir, 'm0.json')), 'the parked message must remain unclaimed');

  // A subsequent main-agent event (no agent_id) drains it normally.
  const mainInput = JSON.stringify({ hook_event_name: 'PostToolUse' });
  const out2 = runPending(REGISTRY_DIR, 'sub1', mainInput);
  assert.match(JSON.parse(out2).hookSpecificOutput.additionalContext, /parked while subagent ran/);
  assert.ok(!fs.existsSync(path.join(pendDir, 'm0.json')), 'main-agent drain must consume the pending dir');
});
