// Run: node --test
// Covers cli-hooks' generated hook-script / settings strings against real temp
// dirs. The uiSettings + memoryStore deps are injected as minimal fakes (an
// empty statusline + an empty memory list), which is all the string generation
// touches.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createCliHooks } = require('../cli-hooks');
const { pathFor, runDirFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const HOOK_SPAWN = { timeout: 30000, killSignal: 'SIGKILL' };
function tmp() { return mkTmpRoot('clodex-hooks-'); }
function mk(REGISTRY_DIR) {
  return createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [] },     // empty digest
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    // The generated hooks shell out to `ELECTRON_RUN_AS_NODE=1 "<nodeInterp>"`;
    // under the test runner that's this node (the env var is a no-op for plain
    // node), so the SAME bytes the packaged app bakes with its Electron binary
    // run here and the end-to-end drain tests exercise the real ported JS.
    nodeInterp: process.execPath,
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
  const attnScript = pathFor(REGISTRY_DIR, 'agent1', 'attnScript');
  assert.deepStrictEqual(settings.hooks.Notification, [{ matcher: '', hooks: [{ type: 'command', command: attnScript }] }]);
  assert.deepStrictEqual(settings.hooks.PreCompact, [{ matcher: '', hooks: [{ type: 'command', command: attnScript }] }]);
  // PostToolUse drains parked DMs MID-LOOP (between tool calls). The
  // MATCHER-LESS entry must carry the pending drain ONLY — acks/ctxwarn are
  // turn-boundary bookkeeping and must not fire per-tool. Pin both facts: the
  // entry exists, and its single hook is the same pendingScriptPath the
  // UserPromptSubmit block's middle hook uses.
  //
  // Resolved by MATCHER, not by index: the Bash console (t645) registers a
  // SECOND PostToolUse entry under `matcher: 'Bash'`, and an index here would
  // make this assertion about whichever entry happened to be written first.
  assert.ok(Array.isArray(settings.hooks.PostToolUse));
  const anyToolEntry = settings.hooks.PostToolUse.find((x) => x.matcher === '');
  assert.ok(anyToolEntry, 'ENTER: the matcher-less (any-tool) entry must exist to be asserted about');
  const postCmds = anyToolEntry.hooks.map((h) => h.command);
  // Resolved BY NAME, not by index: this assertion is about which drain runs
  // per-tool, and the UserPromptSubmit ordering is a separate decision pinned in
  // ipc-prompt-cache-rework.test.js (the delta goes first). An index here silently
  // couples the two, which is how a deliberate reorder broke a test that has no
  // opinion about order.
  const submitCmds = settings.hooks.UserPromptSubmit[0].hooks.map((h) => h.command);
  const pendingCmd = submitCmds.find((c) => c.endsWith('pending.sh'));
  assert.ok(pendingCmd, 'the pending drain must be registered under UserPromptSubmit');
  assert.deepStrictEqual(postCmds, [pendingCmd, pendingCmd.replace(/pending\.sh$/, 'subq.sh')],
    'the matcher-less PostToolUse entry drains pending, then the subagent queue');
  assert.match(pendingCmd, /pending/); // the pending drain script, not acks/ctxwarn

  // The pending drain runs under BOTH events, so its output hookEventName must be
  // DERIVED from the firing event (stdin's hook_event_name), never hardcoded — a
  // PostToolUse hook returning "UserPromptSubmit" is an unsupported mismatch whose
  // additionalContext Claude Code may silently drop. Pin the derivation so a
  // regression back to a hardcoded event name is caught.
  const pendingBody = fs.readFileSync(pendingCmd, 'utf-8');
  assert.match(pendingBody, /JSON\.parse\(fs\.readFileSync\(0, 'utf8'\)\)/, 'pending drain must read the hook input off stdin');
  assert.match(pendingBody, /hook_event_name/, 'pending drain must derive the output event from stdin');
  assert.match(pendingBody, /hookEventName: ev/, 'output event name must be the derived variable, not a literal');
});

test('setupClaudeHook: proxyBase routes ANTHROPIC_BASE_URL through the per-agent path', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('a2', 'http://127.0.0.1:7800');
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'a2', 'settings'), 'utf-8'));
  assert.strictEqual(settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7800/agent/a2/anthropic');
  assert.strictEqual(settings.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, '1');
});

test('setupClaudeHook: wireBase opts in to gateway hint headers; a seat with no base has no env', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('w1', null, null, [], [], [], 'http://127.0.0.1:7900');
  const wired = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'w1', 'settings'), 'utf-8'));
  assert.strictEqual(wired.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7900/anthropic');
  assert.strictEqual(wired.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, '1');
  h.setupClaudeHook('bare1');
  const bare = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'bare1', 'settings'), 'utf-8'));
  assert.strictEqual(bare.env, undefined);
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

test('setupCodexHook: refuses to back up a hooks.json that is already OUR config', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  const hooksPath = path.join(cwd, '.codex', 'hooks.json');
  const backupPath = hooksPath + '.wb-wrap-backup';

  // The state a quit that skipped cleanup leaves behind: our hook on disk, no
  // backup slot. Produced by a real setup rather than hand-written bytes, so the
  // subject cannot drift away from what setupCodexHook actually writes.
  h.setupCodexHook('cx', cwd);
  fs.rmSync(backupPath, { force: true });
  const ours = fs.readFileSync(hooksPath, 'utf8');

  h.setupCodexHook('cx', cwd);

  assert.ok(!fs.existsSync(backupPath),
    'our own hook config must never be preserved as if it were the user\'s');
  assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), ours);
});

test('setupCodexHook: removes a backup slot that already holds our config', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  const hooksPath = path.join(cwd, '.codex', 'hooks.json');
  const backupPath = hooksPath + '.wb-wrap-backup';
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(hooksPath, '{"orig":true}');

  h.setupCodexHook('cx', cwd);
  // Poison the slot the way a second setup over an unbacked-up hook did: the
  // user's file is gone from it and ours sits there instead.
  fs.copyFileSync(hooksPath, backupPath);

  // ENTER: the poisoned state must really be poisoned — a backup slot holding
  // the user's '{"orig":true}' would make the removal below the wrong assertion.
  assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), fs.readFileSync(hooksPath, 'utf8'));

  h.setupCodexHook('cx', cwd);
  assert.ok(!fs.existsSync(backupPath), 'a backup slot holding our own bytes must be dropped');

  // The consequence the repair exists for: cleanup now removes our hook instead
  // of restoring it as the user's config.
  h.cleanupCodexHook('cx', cwd);
  assert.ok(!fs.existsSync(hooksPath), 'cleanup must not leave our hook behind as the user\'s config');
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
// script. A heredoc terminator became "  JSEOF" (never recognized, bash fed
// the rest of the script to the interpreter) and the interpreter's stdin
// program gained a leading indent on every top-level statement. A dedent-diff
// fidelity check is blind to this class by construction; these assertions pin
// the actual generated bytes. (Task 9: the drain heredocs now carry JS run by
// `ELECTRON_RUN_AS_NODE=1 "<nodeInterp>"`, so the framing is JSEOF and the
// top-level markers are JS, not python.)
test('generated scripts: heredoc terminators at column 0, interpreter body unindented', () => {
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
  // No script may reference an ambient python3 anymore — the whole point of the
  // port. Baked interpreter only (Task 9).
  for (const fp of scripts) {
    const body = fs.readFileSync(fp, 'utf-8');
    assert.ok(!/\bpython3\b/.test(body), `${path.basename(fp)}: must not shell out to python3`);
  }
  for (const fp of scripts) {
    const f = path.basename(fp);
    const lines = fs.readFileSync(fp, 'utf-8').split('\n');
    assert.strictEqual(lines[0], '#!/bin/bash', `${f}: shebang must be line 1, column 0`);
    let inHeredoc = false;
    for (const [i, ln] of lines.entries()) {
      if (/<<'JSEOF'/.test(ln)) {
        inHeredoc = true;
        // The first line of every generated interpreter body is a top-level
        // statement (`const fs = require(...)`), which MUST sit at column 0. The
        // M3 factory-indent leak pushed every body line (and the terminator)
        // right by a uniform 2 spaces; asserting the body's first line has no
        // leading whitespace catches that class directly, without tripping over
        // JS's legitimate 2-space nesting the way a `^ {1,3}` scan would.
        const first = lines[i + 1];
        assert.ok(first && !/^\s/.test(first),
          `${f}:${i + 2}: interpreter body first line indented (factory-indent leak?): ${JSON.stringify(first)}`);
        continue;
      }
      if (inHeredoc && ln === 'JSEOF') { inHeredoc = false; continue; }
      if (inHeredoc && ln.trim() === 'JSEOF') {
        assert.fail(`${f}:${i + 1}: heredoc terminator not at column 0: ${JSON.stringify(ln)}`);
      }
    }
    assert.ok(!inHeredoc, `${f}: heredoc never terminated (indented JSEOF?)`);
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
  const out = cp.execFileSync('bash', [pathFor(REGISTRY_DIR, name, 'pendingScript')], { ...HOOK_SPAWN, input: '' }).toString();
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
  return cp.execFileSync('bash', [pathFor(REGISTRY_DIR, name, 'pendingScript')], { ...HOOK_SPAWN, input }).toString();
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

// --- generation stamps in the GENERATED drain ---
//
// The hook is the SECOND drainer, out of process, and it must apply the same
// rule as pending-store.drainPending — the two are single-source-of-truth by
// convention, which means only a test can hold them together. The stamp is baked
// into the script's bytes at setup time (the hook cannot read sessions.json), so
// these exercise the generated bash+node end to end rather than the JS twin.
function parkFor(REGISTRY_DIR, name, files) {
  const pendDir = path.join(REGISTRY_DIR, 'pending', name);
  fs.rmSync(pendDir, { recursive: true, force: true });
  fs.mkdirSync(pendDir, { recursive: true });
  for (const [base, payload] of Object.entries(files)) {
    fs.writeFileSync(path.join(pendDir, base), JSON.stringify(payload));
  }
  return pendDir;
}
const MAIN = JSON.stringify({ hook_event_name: 'UserPromptSubmit' });

test('pending drain (hook): a predecessor\'s mail is discarded, this generation\'s is delivered', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('gen1', null, null, [], [], [], null, 2000);
  const pendDir = parkFor(REGISTRY_DIR, 'gen1', {
    '0001.json': { text: 'for the dead seat', born: 1000 },
    '0002.json': { text: 'for me', born: 2000 },
  });
  const ctx = JSON.parse(runPending(REGISTRY_DIR, 'gen1', MAIN)).hookSpecificOutput.additionalContext;
  assert.strictEqual(ctx, 'for me', 'a new seat must not inherit its predecessor\'s mail');
  // Discarded means GONE — a restore here would re-offer the stale mail on every
  // subsequent turn, forever. Nothing survives: the successor case below is what
  // proves this assertion isn't just "the drain destroys everything".
  assert.deepStrictEqual(fs.existsSync(pendDir) ? fs.readdirSync(pendDir) : [], []);
});

test('pending drain (hook): a successor\'s mail is PUT BACK — the claim already destroyed the original', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  // This hook was generated for the seat born at 2000; the parked entry is
  // addressed to the seat born at 3000 that has since taken the name. A hook
  // subprocess descheduled across its parent's death and the next create() is
  // the only way to get here — vanishingly rare, and the cost of getting it
  // wrong is a destroyed message, so it is handled rather than argued away.
  h.setupClaudeHook('gen2', null, null, [], [], [], null, 2000);
  const pendDir = parkFor(REGISTRY_DIR, 'gen2', {
    '1736900000000.000000001.ab12c.json': { text: 'for the seat that replaced me', id: 'ab12c', born: 3000 },
  });
  const out = runPending(REGISTRY_DIR, 'gen2', MAIN);
  assert.strictEqual(out.trim(), '', 'a stale hook must not deliver its successor\'s mail into a dead session');
  // The script's claim RENAMES THE WHOLE DIRECTORY before reading a byte, so an
  // entry it declines to return and declines to restore exists nowhere at all.
  // "Refuse non-matching" looks like the symmetric conservative choice and is
  // not: symmetric-looking guards are not symmetric when the operation they
  // guard is destructive.
  // readdir DEFENSIVELY: when the restore is missing the whole directory is gone
  // (the claim renamed it away and nothing put it back), and a bare readdirSync
  // would throw ENOENT — failing by a stack trace instead of by the sentence that
  // explains the branch. A revert must fail by MESSAGE.
  const survived = fs.existsSync(pendDir) ? fs.readdirSync(pendDir) : [];
  assert.deepStrictEqual(survived, ['1736900000000.000000001.ab12c.json'],
    'the successor\'s message must be back in the store UNDER ITS ORIGINAL NAME: the claim already destroyed the original, so declining to return it without restoring it loses the message outright — and a re-minted filename would strand the [agent:resend ab12c] handle the sender was given');
});

test('pending drain (hook): unstamped entries deliver, and an unstamped SETUP delivers everything', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  // Two windows in one test because they are the two halves of the same
  // compatibility promise: an old PARK draining through a new hook, and a new
  // park draining through a hook set up without a stamp (the bash arm, a
  // caller that omits it). Neither may drop mail.
  h.setupClaudeHook('gen3', null, null, [], [], [], null, 2000);
  parkFor(REGISTRY_DIR, 'gen3', { '0001.json': { text: 'parked before the stamp existed' } });
  assert.strictEqual(
    JSON.parse(runPending(REGISTRY_DIR, 'gen3', MAIN)).hookSpecificOutput.additionalContext,
    'parked before the stamp existed');

  h.setupClaudeHook('gen4');                       // no createdAt → no expectation
  parkFor(REGISTRY_DIR, 'gen4', {
    '0001.json': { text: 'one generation', born: 1000 },
    '0002.json': { text: 'another', born: 3000 },
  });
  assert.strictEqual(
    JSON.parse(runPending(REGISTRY_DIR, 'gen4', MAIN)).hookSpecificOutput.additionalContext,
    'one generation\n\nanother',
    'a hook with no baked stamp must never silently drop mail — the safe default, mirroring drainPending');
});

// The SessionStart source branch. This was UNPINNED, which is how `compact`
// silently fell through to the name-only file: a compact keeps its sessionId,
// so nothing downstream re-delivered what the digest carries, and a seat ran
// on after a compact with neither memory digest nor team roster. The failure
// is invisible from inside the seat — an absent roster reads as a team of one.
function runSessionStart(REGISTRY_DIR, name, source) {
  const input = JSON.stringify({ transcript_path: path.join(REGISTRY_DIR, 't.jsonl'), source });
  return cp.execFileSync('bash', [pathFor(REGISTRY_DIR, name, 'hook')], { ...HOOK_SPAWN, input, encoding: 'utf-8' });
}

test('SessionStart: only a compact appends the compact-end line to the attention file', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  fs.writeFileSync(path.join(REGISTRY_DIR, 't.jsonl'), '');
  h.setupClaudeHook('agentC');
  const attn = pathFor(REGISTRY_DIR, 'agentC', 'attn');
  for (const source of ['startup', 'clear', 'resume']) runSessionStart(REGISTRY_DIR, 'agentC', source);
  assert.strictEqual(fs.readFileSync(attn, 'utf-8'), '', 'non-compact sources append nothing');
  runSessionStart(REGISTRY_DIR, 'agentC', 'compact');
  const lines = fs.readFileSync(attn, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines, [{ hook_event_name: 'SessionStart', source: 'compact' }]);
});

test('SessionStart: every context reset serves the DIGEST, an ordinary resume serves the name file', () => {
  const REGISTRY_DIR = tmp();
  const h = createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [{ id: 'mem-1-aa', scope: '', learned_at: '', source: 'x', pinned: true, body: 'PINNED-BODY' }] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
    composeRoster: () => '[team t] roster (lead: lead)\n- hand (session)',
  });
  fs.writeFileSync(path.join(REGISTRY_DIR, 't.jsonl'), '');
  h.setupClaudeHook('agentS');

  for (const source of ['startup', 'clear', 'compact']) {
    const ctx = JSON.parse(runSessionStart(REGISTRY_DIR, 'agentS', source)).hookSpecificOutput.additionalContext;
    assert.match(ctx, /PINNED-BODY/, `${source} must carry the memory digest`);
    assert.match(ctx, /\[team t\] roster/, `${source} must carry the team roster`);
  }

  // The contrast that makes the three above meaningful: a source that is NOT a
  // context reset still gets the cheap name-only file, so this is not "the
  // digest is served unconditionally".
  const resume = JSON.parse(runSessionStart(REGISTRY_DIR, 'agentS', 'resume')).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(resume, /PINNED-BODY/, 'a resume must NOT re-serve the digest');
  assert.doesNotMatch(resume, /\[team t\] roster/, 'a resume must NOT re-serve the roster');
});

test('writeClaudeDigestFile: the roster is a THIRD block, and a seat with no team still gets a valid digest', () => {
  const REGISTRY_DIR = tmp();
  const withTeam = createCliHooks({
    REGISTRY_DIR,
    memoryStore: { list: () => [] },        // no memories: the roster must not depend on them
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
    composeRoster: (n) => `[team t] roster for ${n}`,
  });
  withTeam.writeClaudeDigestFile('solo');
  const ctx = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'solo', 'hookDigest'), 'utf-8'))
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /clodex agent named 'solo'/);
  assert.match(ctx, /\[team t\] roster for solo/, 'an empty memory store must not suppress the roster');

  // A throwing composeRoster is the boot-order case: the digest is written
  // before the SessionManager exists, so reaching for it is a TDZ throw. The
  // seat must still get its name, not a crashed spawn.
  const R2 = tmp();
  const throwing = createCliHooks({
    REGISTRY_DIR: R2,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
    composeRoster: () => { throw new Error('manager not constructed yet'); },
  });
  throwing.writeClaudeDigestFile('early');
  const early = JSON.parse(fs.readFileSync(pathFor(R2, 'early', 'hookDigest'), 'utf-8'))
    .hookSpecificOutput.additionalContext;
  assert.match(early, /clodex agent named 'early'/);
  assert.doesNotMatch(early, /roster/);
});

// The drawer's Copy button writes JSONL into the seat's run dir; this script is
// what turns it into transcript content. It CONSUMES what it reads — unlike
// ctxwarn, which re-emits every turn — because a hard copy that re-delivered
// itself would stack duplicates of the same block forever.
test('the selection drain claims by rename, consumes, and emits UserPromptSubmit', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');

  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'selectionScript');
  const queuePath = pathFor(REGISTRY_DIR, 'agent1', 'selection');
  const body = fs.readFileSync(scriptPath, 'utf-8');
  assert.match(body, /renameSync/, 'the queue must be claimed by rename, not read in place');
  assert.match(body, /hookEventName: "UserPromptSubmit"/);

  // Registered, or it never runs.
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'settings'), 'utf-8'));
  const submitCmds = settings.hooks.UserPromptSubmit[0].hooks.map((x) => x.command);
  assert.ok(submitCmds.includes(scriptPath), 'the selection drain must be under UserPromptSubmit');
  // NOT under PostToolUse: an attachment is the operator's turn-boundary
  // gesture, and draining it mid-loop would land it between two tool calls.
  // Flattened across EVERY PostToolUse entry, not just the first: the claim is
  // that this drain fires per-tool NOWHERE, and reading one entry would leave it
  // true of that entry while the drain sat in another.
  const postCmds = settings.hooks.PostToolUse.flatMap((x) => x.hooks.map((h) => h.command));
  assert.ok(!postCmds.includes(scriptPath), 'the drain must not fire per-tool');

  // Two clicks between submits, as the queue is written.
  fs.writeFileSync(queuePath,
    `${JSON.stringify({ text: 'FIRST BLOCK' })}\n${JSON.stringify({ text: 'SECOND BLOCK' })}\n`);
  const out = cp.execFileSync('bash', [scriptPath], { ...HOOK_SPAWN, encoding: 'utf-8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /FIRST BLOCK/, 'ENTER: the first attachment was delivered');
  assert.match(ctx, /SECOND BLOCK/, 'both attachments ride one submit');
  assert.ok(ctx.indexOf('FIRST BLOCK') < ctx.indexOf('SECOND BLOCK'), 'in the order queued');

  // Consumed: a second submit with nothing new must deliver nothing, or the
  // same block accretes in the transcript every turn.
  assert.ok(!fs.existsSync(queuePath), 'the queue file is gone after the drain');
  assert.strictEqual(cp.execFileSync('bash', [scriptPath], { ...HOOK_SPAWN, encoding: 'utf-8' }), '',
    'an empty queue produces no output at all');
});

// A corrupt line must not cost the operator the attachments around it.
test('the selection drain skips an unparseable line and delivers the rest', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'selectionScript');
  fs.writeFileSync(pathFor(REGISTRY_DIR, 'agent1', 'selection'),
    `${JSON.stringify({ text: 'GOOD ONE' })}\n{ not json\n${JSON.stringify({ text: 'GOOD TWO' })}\n`);
  const ctx = JSON.parse(cp.execFileSync('bash', [scriptPath], { ...HOOK_SPAWN, encoding: 'utf-8' }))
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /GOOD ONE/, 'ENTER: the drain ran and delivered');
  assert.match(ctx, /GOOD TWO/, 'the line after the corrupt one still arrived');
});

// F010's second body. The module-side park/drain routes its restore through
// fs-util's atomicWriteFileSync, whose header names the load-bearing half: it
// fsyncs the temp file AND the parent dir, because a rename is only durable
// once the directory entry reaches disk. The GENERATED script reimplements the
// same protocol inline in a heredoc and got the rename without either fsync,
// so the fix landed in one copy of a two-copy protocol.
//
// Why it matters here specifically and not at the other write-then-rename sites
// in this file: restore_parked is the AT-MOST-ONCE path. The drain claims the
// whole directory by renaming it away before reading a byte, so a restore that
// is lost leaves the message nowhere at all. The delta/notified writes are
// deliberately at-least-once — a lost rename there re-delivers the same diff
// next turn, which is why they are left alone rather than fsynced for symmetry.
//
// Asserted against the generated SOURCE because an fsync has no observable
// behaviour: it cannot be detected from the outside without instrumenting fs,
// which is exactly why it went missing in one copy and stayed missing.
test('the generated pending script fsyncs its restore, like the store it mirrors', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('fsync1', null, null, [], [], [], null, 2000);
  const src = fs.readFileSync(pathFor(REGISTRY_DIR, 'fsync1', 'pendingScript'), 'utf-8');

  // ENTER: the restore must be present at all. Without this the two assertions
  // below hold vacuously over a script that no longer restores anything — the
  // failure mode that would silently destroy a successor's mail.
  assert.match(src, /function restore_parked/, 'ENTER: the generated script has no restore_parked');

  const body = src.slice(src.indexOf('function restore_parked'));
  const end = body.indexOf('\n}');
  const restore = body.slice(0, end);

  assert.match(restore, /fsyncSync/, 'the restore must fsync — an unsynced rename can be lost entirely');
  // The DIRECTORY fsync specifically: fsyncing only the temp file's contents
  // leaves the rename itself unflushed, which is the precise gap fs-util's
  // header calls out. Matching openSync on the DIR variable is what separates
  // the two.
  assert.match(restore, /openSync\(d\b/, 'the parent directory must be opened and fsynced, not just the temp file');
  const syncs = restore.match(/fsyncSync/g) || [];
  assert.strictEqual(syncs.length, 2, `expected both fsyncs (contents + parent dir), found ${syncs.length}`);
});

test('CONTROL: the at-least-once writes are deliberately NOT fsynced', () => {
  // Without this, the test above reads as "fsync everything", and the next
  // reader adds one to the delta advance — where a durable rename would convert
  // a re-delivered diff into a dropped one. The asymmetry IS the design.
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('fsync2');
  const delta = fs.readFileSync(pathFor(REGISTRY_DIR, 'fsync2', 'ipcdeltaScript'), 'utf-8');

  assert.match(delta, /renameSync/, 'ENTER: the delta script must still advance by rename');
  assert.ok(!/fsyncSync/.test(delta),
    'the baseline advance is at-least-once by design: a lost rename re-delivers the diff, a durable one cannot be undone');
});

// ─── The Bash console hook (t645) ──────────────────────────────────────────
// Three properties, each a defect if it flips:
//   1. it is registered under BOTH PostToolUse and PostToolUseFailure — a
//      failing Bash call fires ONLY the second, so the success-event-only
//      version omits exactly the commands worth reading;
//   2. both registrations carry `matcher: 'Bash'` — a matcher-less one would run
//      this append after every Read, Grep and Edit;
//   3. it spawns NO interpreter. This runs synchronously on the critical path of
//      every Bash call, so an INTERP here is latency added to the agent's work.
test('the console hook is registered under BOTH tool-result events, for Bash only', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'settings'), 'utf-8'));
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashConsoleScript');

  // The failure event is the one this ticket exists for, so it is asserted as a
  // WHOLE entry: a second hook quietly added to it, or a matcher widened to '',
  // would pass a mere `includes`.
  assert.deepStrictEqual(settings.hooks.PostToolUseFailure, [{
    matcher: 'Bash',
    hooks: [{ type: 'command', command: scriptPath }],
  }], 'a failing Bash call fires ONLY this event — no registration here means no failures shown');

  // Resolved by SCRIPT, not by matcher alone: the poll guard (t935) registers a
  // second `matcher: 'Bash'` PostToolUse entry, and a filter on the matcher
  // would make this assertion about both.
  const bashEntries = settings.hooks.PostToolUse.filter(
    (e) => e.matcher === 'Bash' && e.hooks.some((h) => h.command === scriptPath));
  assert.deepStrictEqual(bashEntries, [{
    matcher: 'Bash',
    hooks: [{ type: 'command', command: scriptPath }],
  }], 'the success event carries the same script under the same matcher');

  // The matcher-less entry must NOT have gained it: that entry fires for every
  // tool, and merging the two is the mistake the separate entry exists to avoid.
  const anyTool = settings.hooks.PostToolUse.find((e) => e.matcher === '');
  assert.ok(anyTool, 'ENTER: the matcher-less entry still exists');
  assert.ok(!anyTool.hooks.some((x) => x.command === scriptPath),
    'the console must not run after every tool — only after Bash');
});

test('the console hook spools raw hook JSON per record and spawns no interpreter', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashConsoleScript');
  const consolePath = pathFor(REGISTRY_DIR, 'agent1', 'bashConsole');

  const body = fs.readFileSync(scriptPath, 'utf-8');
  // The INTERP string is what every OTHER generated hook uses, so its absence
  // here is the load-bearing claim rather than a style note.
  assert.ok(!body.includes('ELECTRON_RUN_AS_NODE'),
    'no interpreter on the critical path of every Bash call');
  assert.match(body, /exit 0/, 'must exit 0 unconditionally — hooks are fail-open and must stay so');
  // The atomicity mechanism itself: written to a temp name, then RENAMED in. An
  // append (`>>`) here is the shape that lost records under concurrency.
  assert.match(body, /mv -f "\$T"/, 'a record must become visible by rename, never by append');
  assert.ok(!/>> *"/.test(body), 'no append to a shared file — that is the race');

  // Driven for real, both events, exactly as the CLI would pipe them.
  const ok = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { stdout: 'hi', stderr: '' }, tool_use_id: 'a', duration_ms: 5,
  });
  const bad = JSON.stringify({
    hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'false' }, tool_use_id: 'b',
    error: 'Exit code 1\n', is_interrupt: false, duration_ms: 3,
  });
  for (const payload of [ok, bad]) {
    const r = cp.spawnSync('bash', [scriptPath], { ...HOOK_SPAWN, input: payload, encoding: 'utf-8' });
    assert.ifError(r.error);
    assert.strictEqual(r.status, 0, `the hook must exit 0, got ${r.status}: ${r.stderr}`);
    assert.strictEqual(r.stdout, '', 'it returns nothing to the CLI — it is a writer, not a drain');
  }

  // ONE FILE PER RECORD, each holding the hook's JSON unmodified.
  const files = fs.readdirSync(consolePath).filter((n) => n.endsWith('.json')).sort();
  assert.strictEqual(files.length, 2, 'ENTER: both events spooled, so the parse below is real');
  const parsed = files.map((f) => JSON.parse(fs.readFileSync(path.join(consolePath, f), 'utf-8')));
  assert.deepStrictEqual(parsed.map((p) => p.hook_event_name).sort(),
    ['PostToolUse', 'PostToolUseFailure'], 'both shapes land, unmodified');
  // The reader is the thing that has to consume these bytes, so pin the round
  // trip rather than the files' shape alone: a hook whose output the reader
  // cannot parse is a green hook test over a broken feature.
  const { readBashConsole } = require('../bash-console');
  const recs = readBashConsole(REGISTRY_DIR, 'agent1', '').records;
  assert.deepStrictEqual(recs.map((r) => [r.command, r.failed]).sort(),
    [['echo hi', false], ['false', true]].sort(),
    'the reader turns the hook\'s own bytes into one ok block and one failed block');
});


// THE TEST THAT WOULD HAVE CAUGHT THE FIRST SHAPE OF THIS FEATURE. It appended
// each record to a shared JSONL in two writes (body, then newline), and the CLI
// fires Bash hooks CONCURRENTLY: measured, four simultaneous writers left 1/20
// records parseable at 400-BYTE payloads, so this is not a large-output edge
// case. The loss was SILENT — a damaged line fails JSON.parse and is skipped, so
// the symptom was a console quietly missing commands.
//
// Driven through the REAL generated script with real concurrent processes. A
// sequential version of this test passes under the broken shape, which is
// precisely why it has to spawn them at once.
test('the console hook loses nothing when Bash hooks fire concurrently', async () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashConsoleScript');
  const dir = pathFor(REGISTRY_DIR, 'agent1', 'bashConsole');

  // Payloads big enough that a shared append cannot be atomic, and DISTINCT so a
  // lost one is identifiable rather than merely a smaller count.
  const WRITERS = 6;
  const payloads = [];
  for (let i = 0; i < WRITERS; i++) {
    payloads.push(JSON.stringify({
      hook_event_name: i % 2 ? 'PostToolUse' : 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: `cmd-${i}` },
      tool_use_id: `t${i}`,
      duration_ms: i,
      ...(i % 2
        ? { tool_response: { stdout: `${'x'.repeat(20000)}-${i}`, stderr: '' } }
        : { error: `Exit code ${i + 1}\nboom-${i}`, is_interrupt: false }),
    }));
  }

  // All six started before any is waited on — spawnSync in a loop would
  // serialize them and prove nothing about the race.
  const kids = payloads.map(() => cp.spawn('bash', [scriptPath], { ...HOOK_SPAWN, stdio: ['pipe', 'ignore', 'ignore'] }));
  const closed = kids.map((k) => new Promise((res) => k.on('close', res)));
  kids.forEach((k, i) => { k.stdin.end(payloads[i]); });
  const codes = await Promise.all(closed);
  assert.deepStrictEqual(codes, payloads.map(() => 0),
    `every hook must exit 0, got ${codes.join(',')}`);

  // Every record recoverable, and recoverable AS ITS OWN SELF.
  const { readBashConsole } = require('../bash-console');
  const res = readBashConsole(REGISTRY_DIR, 'agent1', '');
  assert.strictEqual(res.records.length, WRITERS,
    `all ${WRITERS} concurrent records must survive, got ${res.records.length} — a shared append loses them here`);
  assert.deepStrictEqual(res.records.map((r) => r.command).sort(),
    payloads.map((_, i) => `cmd-${i}`).sort(),
    'and each is the record its own writer wrote, not a splice of two');

  // No writer left its scratch file behind.
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.tmp')), [],
    'the rename must consume every temp file');
});

// `date +%s%N` is a GNU/FreeBSD-14.1 EXTENSION, not POSIX. On a macOS old enough
// to predate it — the README declares the floor at 12, and no box either author
// can test on is one — `%N` comes back LITERALLY, so the name is
// `<secs>N-<pid>.json`. Unguarded, that name fails the reader's grammar and the
// cursor never advances: the same handful of calls repaints every 1.2s while real
// ones scroll out of the pane. The guard is pure builtins (no interpreter, no
// extra subprocess) and the fallback branch IS reachable here, with a stub `date`
// ahead of the script on PATH.
test('the console hook survives a `date` with no %N extension', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashConsoleScript');
  const dir = pathFor(REGISTRY_DIR, 'agent1', 'bashConsole');

  const stubDir = path.join(REGISTRY_DIR, 'stub-bin');
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, 'date');
  fs.writeFileSync(stub, [
    '#!/bin/bash',
    'case "$1" in',
    '  +%s%N) echo "1788481092N" ;;',
    '  +%s)   echo "1788481092" ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });

  const r = cp.spawnSync('bash', [scriptPath], {
    ...HOOK_SPAWN,
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo no-nanoseconds' },
      tool_response: { stdout: 'ok', stderr: '' }, tool_use_id: 'q', duration_ms: 1,
    }),
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0);

  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.strictEqual(names.length, 1, 'ENTER: the hook really did land a record under the stub');
  const { RECORD_NAME_RE, readBashConsole } = require('../bash-console');
  assert.match(names[0], RECORD_NAME_RE,
    `the fallback name must satisfy the grammar the cursor validator uses, got ${names[0]}`);
  assert.strictEqual(names[0].split('-')[0].length, 19,
    'and pad to the same width as a real nanosecond stamp, or the sort stops being chronological');

  // The whole failure was a cursor that could not advance: the name failed the
  // grammar, the cursor stayed empty, and every poll re-served the same calls as
  // NEW ones forever. The reader re-serves the cursor's own timestamp group by
  // design, so the check is that the cursor took the record and stayed there —
  // what comes back is that same record, keyed for the tenant to drop, and
  // nothing the pane has not already seen.
  const first = readBashConsole(REGISTRY_DIR, 'agent1', '');
  assert.strictEqual(first.records.length, 1, 'the record is readable');
  assert.strictEqual(first.cursor, names[0], 'and the cursor took the fallback-named record');
  const again = readBashConsole(REGISTRY_DIR, 'agent1', first.cursor);
  assert.deepStrictEqual(again.records.map((r) => r.key), [first.cursor],
    'a resume re-serves only the cursor record itself');
  assert.strictEqual(again.cursor, first.cursor,
    'and the cursor does not move — the duplicate-forever loop is closed');
});

// The prune must reap a spool orphaned by a killed hook, and must NOT touch one a
// LIVE writer is still filling. A bare `rm -f "$D"/.tmp.*` does the first and
// fails the second: measured on this box, 12 concurrent writers with the bare
// sweep lost 77 of 120 records — the round-1 defect reintroduced by its own fix.
// The pid is in the name, so `kill -0` tells the two apart.
test('the console hook reaps an ORPHANED spool but spares a live writer\'s', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashConsoleScript');
  const dir = pathFor(REGISTRY_DIR, 'agent1', 'bashConsole');
  fs.mkdirSync(dir, { recursive: true });

  // A pid nothing owns. Walk up until kill -0 fails, so the fixture cannot
  // accidentally name a live process and assert the opposite of what it means.
  let deadPid = 90000;
  for (;;) {
    try { process.kill(deadPid, 0); deadPid++; } catch (e) {
      if (e.code === 'ESRCH') break;
      deadPid++;
    }
  }
  const orphan = path.join(dir, `.tmp.${deadPid}`);
  const livePid = process.pid;          // this test runner is unambiguously alive
  const live = path.join(dir, `.tmp.${livePid}`);
  fs.writeFileSync(orphan, '{"half":');
  fs.writeFileSync(live, '{"still":');

  const r = cp.spawnSync('bash', [scriptPath], {
    ...HOOK_SPAWN,
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo sweep' },
      tool_response: { stdout: 'ok', stderr: '' }, tool_use_id: 'w', duration_ms: 1,
    }),
    encoding: 'utf-8',
  });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0);

  assert.ok(!fs.existsSync(orphan), 'the spool of a dead writer is reaped');
  assert.ok(fs.existsSync(live),
    'but a LIVE writer\'s spool is untouched — deleting it is the record loss this whole design prevents');
});

// The retention bound, and the reason it is a COUNT rather than the byte cap the
// first shape used: a byte cap over a shared file needed a rotation, and only
// the live generation was ever readable — so the second generation was written
// and never shown. One record per file makes the bound a file count and the
// oldest simply sort first.
test('the console hook prunes the OLDEST records past its cap', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashConsoleScript');
  const dir = pathFor(REGISTRY_DIR, 'agent1', 'bashConsole');
  const { CONSOLE_MAX_RECORDS } = require('../bash-console');

  assert.ok(fs.readFileSync(scriptPath, 'utf-8').includes(String(CONSOLE_MAX_RECORDS)),
    'the generated script must test against the module\'s own cap, not a second literal');

  // Seed one over the cap with names that sort oldest-first, then fire the hook
  // once so its prune runs. Seeding is far cheaper than 2000 hook spawns.
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i <= CONSOLE_MAX_RECORDS; i++) {
    fs.writeFileSync(path.join(dir, `${String(i).padStart(19, '0')}-1.json`), '{}');
  }
  const oldest = `${String(0).padStart(19, '0')}-1.json`;
  assert.ok(fs.existsSync(path.join(dir, oldest)), 'ENTER: the oldest record is present before the prune');

  const r = cp.spawnSync('bash', [scriptPath], {
    ...HOOK_SPAWN,
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'the newest' },
      tool_response: { stdout: 'ok', stderr: '' }, tool_use_id: 'z', duration_ms: 1,
    }),
    encoding: 'utf-8',
  });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0);

  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.ok(left.length <= CONSOLE_MAX_RECORDS,
    `the spool must stay at or under ${CONSOLE_MAX_RECORDS}, found ${left.length}`);
  assert.ok(!fs.existsSync(path.join(dir, oldest)), 'the OLDEST record is the one dropped');
  // The record that triggered the prune must not be what the prune ate.
  const { readBashConsole } = require('../bash-console');
  const cmds = readBashConsole(REGISTRY_DIR, 'agent1', '').records.map((x) => x.command);
  assert.ok(cmds.includes('the newest'), 'the call that triggered the prune is still recorded');
});

// ─── The live-console PreToolUse observer ─────────────────────────────────
// A PreToolUse hook sits in front of the tool call, so this one is only safe
// because it OBSERVES: it emits nothing on stdout and exits 0 on every path.
// A PreToolUse that emits `hookSpecificOutput.updatedInput` or exits 2 alters
// or blocks the Bash call, which is the difference between a broken preview and
// a broken agent. Measured against claude 2.1.260: with the hook script missing
// entirely the Bash call still ran and the model still got its output. These
// assertions keep THIS hook mute; bash-guard.sh, registered behind it, speaks by
// design and is pinned separately.
test('the live observer is registered for Bash only, ahead of the tool call', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'settings'), 'utf-8'));
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashLiveScript');

  const guardPath = pathFor(REGISTRY_DIR, 'agent1', 'bashGuardScript');

  // The ORDER is the assertion, not merely the membership: the observer records
  // what a seat TRIED, so a guard that denied first would drop the denied call
  // out of the live console and leave the deny unexplainable from the preview.
  const bashEntries = settings.hooks.PreToolUse.filter((e) => e.matcher === 'Bash');
  assert.deepStrictEqual(bashEntries, [{
    matcher: 'Bash',
    hooks: [
      { type: 'command', command: scriptPath },
      { type: 'command', command: guardPath },
      { type: 'command', command: pathFor(REGISTRY_DIR, 'agent1', 'identScript') },
    ],
  }], 'a matcher-less entry here would run this before EVERY tool call, not just Bash');

  // The poll guard (t935) is the one PreToolUse hook that MUST see every tool:
  // a non-Bash call between two Bash ones is what resets its count. It lives in
  // its own matcher-less entry, and nothing else may join it there.
  const anyTool = settings.hooks.PreToolUse.filter((e) => e.matcher === '');
  assert.deepStrictEqual(anyTool, [{
    matcher: '',
    hooks: [{ type: 'command', command: pathFor(REGISTRY_DIR, 'agent1', 'pollGuardScript') }],
  }], 'the matcher-less entry carries the poll guard alone');
  assert.deepStrictEqual(settings.hooks.PreToolUse.filter((e) => e.matcher === 'mcp__clodex__term_exec'), [{
    matcher: 'mcp__clodex__term_exec',
    hooks: [{ type: 'command', command: pathFor(REGISTRY_DIR, 'agent1', 'identScript') }],
  }]);
  assert.deepStrictEqual(settings.hooks.PreToolUse.map((e) => e.matcher), ['Bash', 'mcp__clodex__term_exec', '']);
});

// ─── The whole-tree `git add` guard ───────────────────────────
// The SECOND PreToolUse Bash hook, and the one that is allowed to speak: it
// returns a `permissionDecision: deny` for a whole-tree stage on a ticket seat.
// Hands 811 and 812 each swept a red-proof subagent's in-flight revert into a
// commit with `git add -A`; the hand prompt forbids it, this enforces it.
// The runtime table lives in test/bash-guard.test.js.
test('the guard is generated, runs on every seat, gates git-add on CLODEX_TICKET, and exits 0', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const guardPath = pathFor(REGISTRY_DIR, 'agent1', 'bashGuardScript');
  const body = fs.readFileSync(guardPath, 'utf-8');

  assert.ok(!/^\[ -n "\$CLODEX_TICKET" \] \|\| exit 0$/m.test(body),
    'no shell-head ticket gate: the kill rule must reach every seat, so the git-add gate lives in the JS body');
  assert.match(body, /exit 0\n$/, 'ends on exit 0 — a nonzero PreToolUse is a different, cruder refusal');
  assert.ok(!/require\('\.\//.test(body), 'no relative require inside a generated body');
  assert.match(body, /"permissionDecision": *"deny"|permissionDecision: "deny"/,
    'the deny shape is the contract with the CLI, not an exit code');

  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git add -A' },
  });
  const unticketed = cp.spawnSync('bash', [guardPath], {
    ...HOOK_SPAWN,
    input: payload, encoding: 'utf-8',
    env: { ...process.env, CLODEX_TICKET: '' },
  });
  assert.ifError(unticketed.error);
  assert.strictEqual(unticketed.status, 0);
  assert.strictEqual(unticketed.stdout, '',
    'a seat with no ticket marker gets NO deny, on the very command a ticket seat is refused');
});

test('the live observer emits nothing, exits 0, and records the call it is about to see', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashLiveScript');
  const livePath = pathFor(REGISTRY_DIR, 'agent1', 'bashLive');

  const body = fs.readFileSync(scriptPath, 'utf-8');
  assert.match(body, /exit 0/, 'must exit 0 unconditionally — a nonzero PreToolUse can block the call');
  // Every generated body is a self-contained heredoc; a `require('./…')` inside
  // one has no module to resolve from. The module path is interpolated at
  // GENERATION time and passed as argv, so the hook and bash-live.js cannot drift.
  assert.ok(!/require\('\.\//.test(body), 'no relative require inside a generated body');
  assert.match(body, /bash-live/, 'it reaches the module by an absolute path baked in at generation');

  const cwd = mkTmpRoot('clodex-live-cwd-');
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'sleep 5' }, tool_use_id: 'tu-live-1',
    cwd, session_id: 'sess-abc',
  });

  // NOBODY WATCHING: the gate must short-circuit BEFORE the interpreter spawn.
  // `bash-console.sh` is pinned to spawn no interpreter at all on the critical
  // path of every Bash call; this hook does spawn one, so it only earns that
  // cost while a pane is actually reading. Unwatched is the common case.
  fs.mkdirSync(livePath, { recursive: true });
  const cold = cp.spawnSync('bash', [scriptPath], { ...HOOK_SPAWN, input: payload, encoding: 'utf-8' });
  assert.ifError(cold.error);
  assert.strictEqual(cold.status, 0, 'still exits 0 when nothing is watching');
  assert.deepStrictEqual(fs.readdirSync(livePath), [],
    'no observer is written when no pane is reading — the spawn is skipped entirely');

  // WATCHING: the main side touches the sentinel while a pane reads.
  fs.writeFileSync(path.join(livePath, '.watching'), '');
  const r = cp.spawnSync('bash', [scriptPath], { ...HOOK_SPAWN, input: payload, encoding: 'utf-8' });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0, `the observer must exit 0, got ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout, '',
    'it returns NOTHING to the CLI — any output here is a chance to alter the command');

  const files = fs.readdirSync(livePath).filter((n) => n !== '.watching');
  assert.deepStrictEqual(files, ['tu-live-1.json'],
    'ENTER: the observer really wrote its record, so the fields below are the hook\'s own bytes');
  const rec = JSON.parse(fs.readFileSync(path.join(livePath, files[0]), 'utf-8'));
  assert.strictEqual(rec.command, 'sleep 5');
  assert.strictEqual(rec.id, 'tu-live-1');
  assert.ok(rec.tasksDir.endsWith(path.join('sess-abc', 'tasks')),
    `the tasks dir is derived from cwd + session_id, got ${rec.tasksDir}`);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a malformed hook payload leaves the observer silent and successful', () => {
  // The fail-open property under the input the CLI is least likely to send and
  // most damaging to get wrong: whatever happens in here, the Bash call must run.
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashLiveScript');
  // Armed deliberately: with the gate closed the script exits before it ever
  // parses anything, so every case below would pass without exercising the
  // fail-open path this test is about.
  const livePath = pathFor(REGISTRY_DIR, 'agent1', 'bashLive');
  fs.mkdirSync(livePath, { recursive: true });
  fs.writeFileSync(path.join(livePath, '.watching'), '');

  for (const input of ['', 'not json at all', '{"tool_name":"Bash"}', '{]']) {
    const r = cp.spawnSync('bash', [scriptPath], { ...HOOK_SPAWN, input, encoding: 'utf-8' });
    assert.ifError(r.error);
    assert.strictEqual(r.status, 0, `exit 0 on ${JSON.stringify(input)}, got ${r.status}`);
    assert.strictEqual(r.stdout, '', `silent on ${JSON.stringify(input)}`);
  }
});

// --- t673: permissions.deny, the wall a shell reviewer runs behind -----------
//
// deny is the only half that REFUSES: `permissions.allow` is a pre-approval
// list, so a command merely absent from it still runs. Measured on CLI 2.1.261,
// and deny holds even under --dangerously-skip-permissions, which is why the
// shell arm can inherit the lead's posture (pinned in resolve-seat-shape.test.js).
// This file owns the other half: that the extra rules reach the settings file,
// merged into the ONE deny block rather than a second key beside it.

const SHELL_DENY = ['Bash(rm:*)', 'Bash(touch:*)', 'Bash(git commit:*)'];

test('t673: extraDenyRules MERGE into the single permissions.deny block', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  // Tool denies AND shell denies in one call: they share one key, so an
  // implementation that wrote `permissions` twice, or emitted a second block,
  // would drop one set. Only a fixture carrying both can see that.
  h.setupClaudeHook('sh1', null, null, [], ['Edit', 'Write'], [], null, null, SHELL_DENY);
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'sh1', 'settings'), 'utf-8'));
  assert.deepStrictEqual(settings.permissions.deny, ['Edit', 'Write', ...SHELL_DENY]);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(settings.permissions, 'allow'), false,
    'an allow block would be pre-approval, not a wall — this mechanism must never write one');
});

test('t673: an empty extraDenyRules leaves the deny block exactly as it was', () => {
  // Every non-shell seat takes this path, which is why it is the default: the
  // shell rules must be additive, visible on the shell arm and absent everywhere
  // else.
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('sh2', null, null, [], ['Edit'], [], null, null, []);
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'sh2', 'settings'), 'utf-8'));
  assert.deepStrictEqual(settings.permissions.deny, ['Edit']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(settings.permissions, 'allow'), false);
});

test('t673: shell denies survive with no tool denies, and are deduped', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  // The duplicate rides INSIDE extraDenyRules, so the Set is what collapses it.
  // Put in disabledTools instead it never reaches the Set at all — the toolSet
  // filter drops it first, and the test would assert dedup while exercising none.
  h.setupClaudeHook('sh3', null, null, [], [], [], null, null, [...SHELL_DENY, 'Bash(rm:*)']);
  const withDeny = fs.readFileSync(pathFor(REGISTRY_DIR, 'sh3', 'hook'), 'utf-8');
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'sh3', 'settings'), 'utf-8'));
  assert.deepStrictEqual(settings.permissions.deny, SHELL_DENY);

  // The SAME registry dir and the same agent name, so the only difference
  // between the two runs is the deny list: the script bytes embed the registry
  // path in several forms, and a two-dir fixture would have to normalize each
  // one to compare — a normalization that is itself the thing most likely to be
  // wrong.
  h.setupClaudeHook('sh3', null, null, [], [], [], null, null, []);
  const without = fs.readFileSync(pathFor(REGISTRY_DIR, 'sh3', 'hook'), 'utf-8');
  assert.strictEqual(withDeny, without, 'the deny rules must not reach the generated script bytes');
});

test('stream seat: the tool-boundary PreToolUse script is byte-pinned, appends one attn line, and gates nothing', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('st1', null, null, [], [], [], null, null, [], true);
  const scriptPath = pathFor(REGISTRY_DIR, 'st1', 'toolBoundaryScript');
  const attn = pathFor(REGISTRY_DIR, 'st1', 'attn');
  assert.strictEqual(fs.readFileSync(scriptPath, 'utf-8'), `#!/bin/bash
printf '{"hook_event_name":"PreToolUse","ts":%s000}\\n' "$(date +%s)" >> "${attn}" 2>/dev/null || true
exit 0
`);
  const out = cp.execFileSync('bash', [scriptPath], { ...HOOK_SPAWN, input: JSON.stringify({ tool_name: 'Bash' }), encoding: 'utf-8' });
  assert.strictEqual(out, '', 'no stdout: the hook never returns a permission decision');
  const lines = fs.readFileSync(attn, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].hook_event_name, 'PreToolUse');
  assert.ok(Number.isInteger(lines[0].ts) && lines[0].ts > 1e12);
});

test('stream seat: hook.json runs the tool-boundary script on every tool and keeps every UserPromptSubmit drain; a pty seat has neither the script nor the entry', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('st2', null, null, [], [], [], null, null, [], true);
  h.setupClaudeHook('pt2');
  const p = (n, k) => pathFor(REGISTRY_DIR, n, k);
  const stream = JSON.parse(fs.readFileSync(p('st2', 'settings'), 'utf-8'));
  assert.deepStrictEqual(stream.hooks.PreToolUse.filter((e) => e.matcher === ''), [{
    matcher: '',
    hooks: [
      { type: 'command', command: p('st2', 'pollGuardScript') },
      { type: 'command', command: p('st2', 'toolBoundaryScript') },
    ],
  }]);
  const drains = stream.hooks.UserPromptSubmit[0].hooks.map((x) => x.command);
  for (const k of ['ipcdeltaScript', 'acksScript', 'pendingScript', 'noticeScript']) {
    assert.ok(drains.includes(p('st2', k)), `${k} still drains under -p`);
  }
  const pty = JSON.parse(fs.readFileSync(p('pt2', 'settings'), 'utf-8'));
  assert.ok(!JSON.stringify(pty.hooks).includes('tool-boundary'));
  assert.strictEqual(fs.existsSync(p('pt2', 'toolBoundaryScript')), false);
});

test('every claude seat settings turn the CLI recorder off so a user-level voice block cannot arm a second recorder', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('vs1', null, null, [], [], [], null, null, [], true);
  h.setupClaudeHook('vp1');
  for (const n of ['vs1', 'vp1']) {
    const s = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, n, 'settings'), 'utf-8'));
    assert.deepStrictEqual(s.voice, { enabled: false }, n);
    assert.strictEqual(s.voiceEnabled, false, n);
  }
});

test('cleanupCodexHook: a hooks.json that no longer holds our bytes is never overwritten by the backup', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  const hooksPath = path.join(cwd, '.codex', 'hooks.json');
  const backup = hooksPath + '.wb-wrap-backup';
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(hooksPath, '{"v":1}');
  h.setupCodexHook('cx', cwd);
  fs.writeFileSync(hooksPath, '{"v":2}');
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), '{"v":1}');
  h.cleanupCodexHook('cx', cwd);
  assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), '{"v":2}');
  assert.ok(!fs.existsSync(backup));

  fs.writeFileSync(hooksPath, '{"v":1}');
  h.setupCodexHook('cx', cwd);
  fs.writeFileSync(hooksPath, '{"v":2}');
  h.setupCodexHook('cx', cwd);
  h.cleanupCodexHook('cx', cwd);
  assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), '{"v":2}');

  fs.writeFileSync(hooksPath, '{"v":1}');
  h.setupCodexHook('cx', cwd);
  fs.unlinkSync(hooksPath);
  h.cleanupCodexHook('cx', cwd);
  assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), '{"v":1}');
});

test('setupCodexHook: a crash-left Clodex body from another build never overwrites the user backup', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  const hooksPath = path.join(cwd, '.codex', 'hooks.json');
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(hooksPath, '{"v":1}');
  h.setupCodexHook('cx', cwd);
  const foreign = JSON.stringify({ hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: '/elsewhere/codex-session-hook.sh' }] }] } });
  fs.writeFileSync(hooksPath, foreign);
  h.setupCodexHook('cx', cwd);
  assert.strictEqual(fs.readFileSync(hooksPath + '.wb-wrap-backup', 'utf8'), '{"v":1}');
  h.cleanupCodexHook('cx', cwd);
  assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), '{"v":1}');
});

test('cleanupCodexHook: a failing backup restore does not throw out of the teardown', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupCodexHook('cy', cwd);
  const backup = path.join(cwd, '.codex', 'hooks.json.wb-wrap-backup');
  fs.mkdirSync(path.join(backup, 'x'), { recursive: true });
  assert.ok(fs.statSync(backup).isDirectory());
  assert.doesNotThrow(() => h.cleanupCodexHook('cy', cwd));
});

test('pending drain: an orphaned claim dir left by a dead drainer is delivered, not stranded', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('orph');
  const orphan = path.join(REGISTRY_DIR, 'pending', 'orph.draining.hook.999999');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'm0.json'), JSON.stringify({ text: 'stranded' }));
  assert.throws(() => process.kill(999999, 0));
  const out = runPending(REGISTRY_DIR, 'orph', JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /stranded/);
  assert.ok(!fs.existsSync(orphan));
});

test("pending drain: a LIVE drainer's claim dir is left alone", () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('busy');
  const claim = path.join(REGISTRY_DIR, 'pending', 'busy.draining.idle.' + process.pid);
  fs.mkdirSync(claim, { recursive: true });
  fs.writeFileSync(path.join(claim, 'm0.json'), JSON.stringify({ text: 'mid-drain' }));
  const out = runPending(REGISTRY_DIR, 'busy', JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
  assert.strictEqual(out.trim(), '');
  assert.deepStrictEqual(fs.readdirSync(claim), ['m0.json']);
  assert.ok(!fs.existsSync(path.join(REGISTRY_DIR, 'pending', 'busy')));
});

test('pending drain: a hook input larger than ARG_MAX still drains the parked message', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('big');
  parkFor(REGISTRY_DIR, 'big', { 'm0.json': { text: 'hello parked' } });
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { content: 'x'.repeat(2 * 1024 * 1024) } });
  assert.ok(input.length > 1048576);
  const r = cp.spawnSync('bash', [pathFor(REGISTRY_DIR, 'big', 'pendingScript')], { ...HOOK_SPAWN, input, encoding: 'utf-8' });
  assert.ifError(r.error);
  assert.strictEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /hello parked/);
});

test('SessionStart hook: the digest is emitted even when the input carries no transcript_path', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('nt');
  assert.match(fs.readFileSync(pathFor(REGISTRY_DIR, 'nt', 'hookDigest'), 'utf-8'), /named 'nt'/);
  const out = cp.execFileSync('bash', [pathFor(REGISTRY_DIR, 'nt', 'hook')],
    { ...HOOK_SPAWN, input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }), encoding: 'utf-8' });
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /named 'nt'/);
});

test('SessionStart hook: the digest is emitted even when the transcript relink fails', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('rl');
  const runDir = path.dirname(pathFor(REGISTRY_DIR, 'rl', 'transcript'));
  fs.chmodSync(runDir, 0o500);
  let out;
  try {
    assert.throws(() => fs.writeFileSync(path.join(runDir, 'probe'), ''));
    out = cp.execFileSync('bash', [pathFor(REGISTRY_DIR, 'rl', 'hook')], {
      ...HOOK_SPAWN,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(REGISTRY_DIR, 't.jsonl') }),
      encoding: 'utf-8',
    });
  } finally {
    fs.chmodSync(runDir, 0o700);
  }
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /named 'rl'/);
});

function runCodexHook(REGISTRY_DIR, name, input) {
  return cp.execFileSync('bash', [path.join(REGISTRY_DIR, 'codex-session-hook.sh')], {
    ...HOOK_SPAWN,
    input, encoding: 'utf-8', env: { ...process.env, WB_WRAP_NAME: name },
  });
}

test('Codex SessionStart hook: the output is emitted even when the input carries no transcript_path', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupCodexHook('cnt', cwd);
  const out = runCodexHook(REGISTRY_DIR, 'cnt', JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /named 'cnt'/);
});

test('Codex SessionStart hook: the output is emitted even when the transcript relink fails', () => {
  const REGISTRY_DIR = tmp();
  const cwd = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupCodexHook('crl', cwd);
  const runDir = path.dirname(pathFor(REGISTRY_DIR, 'crl', 'transcript'));
  fs.chmodSync(runDir, 0o500);
  let out;
  try {
    assert.throws(() => fs.writeFileSync(path.join(runDir, 'probe'), ''));
    out = runCodexHook(REGISTRY_DIR, 'crl',
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(REGISTRY_DIR, 't.jsonl') }));
  } finally {
    fs.chmodSync(runDir, 0o700);
  }
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /named 'crl'/);
});

test('cleanupCodexHook: a Clodex body from another registry dir is ours, so the user backup is restored over it', () => {
  const cwd = tmp();
  const h1 = mk(tmp());
  const h2 = mk(tmp());
  const hooksPath = path.join(cwd, '.codex', 'hooks.json');
  const backup = hooksPath + '.wb-wrap-backup';
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(hooksPath, '{"v":1}');
  h1.setupCodexHook('cx', cwd);
  h2.setupCodexHook('cy', cwd);
  assert.match(fs.readFileSync(hooksPath, 'utf8'), /codex-session-hook\.sh/);
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), '{"v":1}');
  h1.cleanupCodexHook('cx', cwd);
  assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), '{"v":1}');
  assert.ok(!fs.existsSync(backup));
  h2.cleanupCodexHook('cy', cwd);
  assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), '{"v":1}');
});

test('every bash hook spawn in this file carries HOOK_SPAWN, so a stalled child fails its test instead of wedging the suite', () => {
  const src = fs.readFileSync(__filename, 'utf8');
  const calls = src.match(/(?:spawn|spawnSync|execFileSync)\('bash'/g) || [];
  const guarded = src.match(/(?:spawn|spawnSync|execFileSync)\('bash',[^{]*\{\s*\.\.\.HOOK_SPAWN\b/g) || [];
  assert.strictEqual(calls.length, 22);
  assert.strictEqual(guarded.length, calls.length);
  assert.deepStrictEqual(HOOK_SPAWN, { timeout: 30000, killSignal: 'SIGKILL' });
});

test('pending drain (hook): each handed-over entry spools one delivered.jsonl line, in claim order', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('dlv1');
  const long = 'x'.repeat(150) + '\nline two\r\n' + 'y'.repeat(100);
  parkFor(REGISTRY_DIR, 'dlv1', {
    '0002.json': { text: long },
    '0001.json': { text: 'first\nsecond' },
  });
  const out = runPending(REGISTRY_DIR, 'dlv1', JSON.stringify({ hook_event_name: 'PostToolUse' }));
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /first/);
  const lines = fs.readFileSync(pathFor(REGISTRY_DIR, 'dlv1', 'delivered'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((e) => e.file), ['0001.json', '0002.json']);
  assert.ok(lines.every((e) => e.ev === 'PostToolUse' && typeof e.ts === 'number'));
  assert.strictEqual(lines[0].head, 'first second');
  assert.strictEqual(lines[1].head, long.slice(0, 200).replace(/[\r\n]/g, ' '));
  assert.strictEqual(lines[1].head.length, 200);
});

test('pending drain (hook): a subagent input spools no delivered.jsonl line', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('dlv2');
  parkFor(REGISTRY_DIR, 'dlv2', { '0001.json': { text: 'held for main' } });
  runPending(REGISTRY_DIR, 'dlv2', JSON.stringify({ hook_event_name: 'PostToolUse', agent_id: 'sub' }));
  assert.ok(!fs.existsSync(pathFor(REGISTRY_DIR, 'dlv2', 'delivered')));
});

test('pending drain (hook): an unwritable spool still delivers and consumes — the spool append never aborts the drain', { skip: process.getuid && process.getuid() === 0 }, () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('dlv3');
  const pendDir = parkFor(REGISTRY_DIR, 'dlv3', { '0001.json': { text: 'still arrives' } });
  const runDir = path.dirname(pathFor(REGISTRY_DIR, 'dlv3', 'delivered'));
  fs.chmodSync(runDir, 0o500);
  let out;
  try {
    out = runPending(REGISTRY_DIR, 'dlv3', MAIN);
  } finally {
    fs.chmodSync(runDir, 0o700);
  }
  assert.strictEqual(JSON.parse(out).hookSpecificOutput.additionalContext, 'still arrives');
  assert.ok(!fs.existsSync(pendDir));
  assert.ok(!fs.existsSync(pathFor(REGISTRY_DIR, 'dlv3', 'delivered')));
});

const crypto = require('crypto');
const { identToken, identIsMain } = require('../intent-socket');
const ICRED = 'f'.repeat(64);

function runIdent(REGISTRY_DIR, payload, env = { CLODEX_INTENT_CRED: ICRED }) {
  const base = { ...process.env };
  delete base.CLODEX_INTENT_CRED;
  const r = cp.spawnSync('bash', [pathFor(REGISTRY_DIR, 'agent1', 'identScript')], {
    ...HOOK_SPAWN, input: JSON.stringify(payload), encoding: 'utf-8', env: { ...base, ...env },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

function identSeat() {
  const REGISTRY_DIR = tmp();
  mk(REGISTRY_DIR).setupClaudeHook('agent1');
  return REGISTRY_DIR;
}

const bashCall = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sess-1', tool_input: { command, timeout: 300000 }, ...extra,
});

const mcpCall = (tool_input = { command: 'ls' }, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'mcp__clodex__term_exec', session_id: 'sess-1', tool_input, ...extra,
});

const identDirOf = (R) => path.join(path.dirname(pathFor(R, 'agent1', 'intentSocket')), 'ident');

function stamped(R, command) {
  const nonces = [...command.matchAll(/CLODEX_HOOK_IDENT=@([0-9a-f]{16}) /g)].map((m) => m[1]);
  const stamps = nonces.map((n) => fs.readFileSync(path.join(identDirOf(R), n), 'utf8'));
  return { shape: command.replace(/CLODEX_HOOK_IDENT=@[0-9a-f]{16} /g, 'CLODEX_HOOK_IDENT=@N '), nonces, stamps };
}

test('ident hook: a main-agent clodex call is stamped @<nonce>; the file holds main.<nonce>.<hmac> that verifies', () => {
  const REGISTRY_DIR = identSeat();
  const out = JSON.parse(runIdent(REGISTRY_DIR, bashCall("clodex '[agent:browser release wiki]'")));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  const { command, timeout } = out.hookSpecificOutput.updatedInput;
  assert.strictEqual(timeout, 300000);
  const st = stamped(REGISTRY_DIR, command);
  assert.strictEqual(st.shape, "CLODEX_HOOK_IDENT=@N clodex '[agent:browser release wiki]'");
  assert.doesNotMatch(command, /main\.|[0-9a-f]{16}\.[0-9a-f]{16}/, 'no mac on the command line');
  assert.match(st.stamps[0], new RegExp(`^main\\.${st.nonces[0]}\\.[0-9a-f]{16}$`));
  assert.strictEqual(st.stamps[0], identToken(crypto, ICRED, null, null, 'sess-1', st.nonces[0]));
  assert.strictEqual(fs.statSync(path.join(identDirOf(REGISTRY_DIR), st.nonces[0])).mode & 0o777, 0o600);
  assert.strictEqual(identIsMain(crypto, ICRED, st.stamps[0], 'sess-1'), true);
});

test('ident hook: two rewrites of the same command produce different stamps', () => {
  const REGISTRY_DIR = identSeat();
  const one = stamped(REGISTRY_DIR, JSON.parse(runIdent(REGISTRY_DIR, bashCall('clodex x'))).hookSpecificOutput.updatedInput.command);
  const two = stamped(REGISTRY_DIR, JSON.parse(runIdent(REGISTRY_DIR, bashCall('clodex x'))).hookSpecificOutput.updatedInput.command);
  assert.notStrictEqual(one.nonces[0], two.nonces[0]);
  assert.notStrictEqual(one.stamps[0], two.stamps[0]);
});

test('ident hook: with no credential in env it reads run/<name>/intent.cred', () => {
  const REGISTRY_DIR = identSeat();
  fs.writeFileSync(pathFor(REGISTRY_DIR, 'agent1', 'intentCred'), ICRED, { mode: 0o600 });
  const out = JSON.parse(runIdent(REGISTRY_DIR, bashCall('clodex x'), {}));
  const st = stamped(REGISTRY_DIR, out.hookSpecificOutput.updatedInput.command);
  assert.strictEqual(st.shape, 'CLODEX_HOOK_IDENT=@N clodex x');
  assert.strictEqual(st.stamps[0], identToken(crypto, ICRED, null, null, 'sess-1', st.nonces[0]));
});

test('ident hook: a subagent call is stamped sub.<agent_id>.<agent_type>.<nonce>.<hmac>', () => {
  const REGISTRY_DIR = identSeat();
  const out = JSON.parse(runIdent(REGISTRY_DIR, bashCall('clodex x', { agent_id: 'a1b2', agent_type: 'general-purpose' })));
  const st = stamped(REGISTRY_DIR, out.hookSpecificOutput.updatedInput.command);
  assert.strictEqual(st.shape, 'CLODEX_HOOK_IDENT=@N clodex x');
  assert.match(st.stamps[0], /^sub\.a1b2\.general-purpose\.[0-9a-f]{16}\.[0-9a-f]{16}$/);
  assert.strictEqual(st.stamps[0], identToken(crypto, ICRED, 'a1b2', 'general-purpose', 'sess-1', st.nonces[0]));
});

test('ident hook: a non-clodex command gets no output and exit 0', () => {
  const REGISTRY_DIR = identSeat();
  for (const c of ['ls -la', 'echo clodex', "grep clodex file | head", 'clodexify x']) {
    assert.strictEqual(runIdent(REGISTRY_DIR, bashCall(c)), '', c);
  }
  assert.strictEqual(fs.existsSync(identDirOf(REGISTRY_DIR)), false, 'no stamp file written');
});

test('ident hook: a stamped call sweeps stamp files older than IDENT_SEEN_MS and keeps younger ones', () => {
  const REGISTRY_DIR = identSeat();
  const dir = identDirOf(REGISTRY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'aaaaaaaaaaaaaaaa');
  const young = path.join(dir, 'bbbbbbbbbbbbbbbb');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(young, 'y');
  const t = Date.now() / 1000;
  fs.utimesSync(old, t - 11 * 60, t - 11 * 60);
  fs.utimesSync(young, t - 60, t - 60);
  runIdent(REGISTRY_DIR, bashCall('ls'));
  assert.ok(fs.existsSync(old), 'a non-clodex call sweeps nothing');
  const st = stamped(REGISTRY_DIR, JSON.parse(runIdent(REGISTRY_DIR, bashCall('clodex x'))).hookSpecificOutput.updatedInput.command);
  assert.strictEqual(fs.existsSync(old), false, 'the 11-minute-old file is swept');
  assert.ok(fs.existsSync(young), 'the 1-minute-old file survives');
  assert.ok(fs.existsSync(path.join(dir, st.nonces[0])), 'the new stamp is written');
});

test('ident hook: a readdir error in the sweep does not stop the stamp from being written', () => {
  const { hookIdentOutput } = require('../intent-socket');
  const written = [];
  const fsDouble = {
    readdirSync: () => { throw new Error('EACCES'); },
    mkdirSync: () => {},
    writeFileSync: (p, data) => written.push([p, data]),
  };
  const out = JSON.parse(hookIdentOutput(JSON.stringify(bashCall('clodex x')), ICRED, crypto, { identDir: '/nowhere/ident', fs: fsDouble }));
  assert.match(out.hookSpecificOutput.updatedInput.command, /^CLODEX_HOOK_IDENT=@[0-9a-f]{16} clodex x$/);
  assert.strictEqual(written.length, 1);
});

test('ident hook: only the clodex segments are prefixed, each with its own stamp; cd and the pipe stay byte-identical', () => {
  const REGISTRY_DIR = identSeat();
  const cmd = (c) => stamped(REGISTRY_DIR, JSON.parse(runIdent(REGISTRY_DIR, bashCall(c))).hookSpecificOutput.updatedInput.command);
  assert.strictEqual(cmd("cd x && clodex '[agent:name]' | head").shape, "cd x && CLODEX_HOOK_IDENT=@N clodex '[agent:name]' | head");
  const two = cmd('~/.clodex/bin/clodex-send a; clodex b');
  assert.strictEqual(two.shape, 'CLODEX_HOOK_IDENT=@N ~/.clodex/bin/clodex-send a; CLODEX_HOOK_IDENT=@N clodex b');
  assert.strictEqual(new Set(two.nonces).size, 2);
});

test('ident hook: a forged CLODEX_HOOK_IDENT in the command is replaced by the hook value', () => {
  const REGISTRY_DIR = identSeat();
  const cmd = (c) => stamped(REGISTRY_DIR, JSON.parse(runIdent(REGISTRY_DIR, bashCall(c, { agent_id: 'a1', agent_type: 'gp' }))).hookSpecificOutput.updatedInput.command);
  for (const [c, want] of [
    ['CLODEX_HOOK_IDENT=main.deadbeef clodex x', 'CLODEX_HOOK_IDENT=@N clodex x'],
    ['FOO=1 env CLODEX_HOOK_IDENT=main.deadbeef clodex x', 'CLODEX_HOOK_IDENT=@N FOO=1 env clodex x'],
    ['CLODEX_HOOK_IDENT=@0123456789abcdef clodex x', 'CLODEX_HOOK_IDENT=@N clodex x'],
  ]) {
    const st = cmd(c);
    assert.strictEqual(st.shape, want, c);
    assert.strictEqual(st.stamps[0], identToken(crypto, ICRED, 'a1', 'gp', 'sess-1', st.nonces[0]), c);
  }
});

test('ident hook: SubagentStart is registered and briefs the subagent in one additionalContext line', () => {
  const REGISTRY_DIR = identSeat();
  mk(REGISTRY_DIR).writeMcpCatalog('agent1', { tools: [], briefs: [require('../plugins/browser-pane/subagent').brief] });
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'settings'), 'utf-8'));
  assert.deepStrictEqual(settings.hooks.SubagentStart, [{ matcher: '', hooks: [{ type: 'command', command: pathFor(REGISTRY_DIR, 'agent1', 'identScript') }] }]);
  const out = JSON.parse(runIdent(REGISTRY_DIR, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'gp', session_id: 'sess-1' }));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.strictEqual(out.hookSpecificOutput.additionalContext, "This seat's browser pane is the `browser` MCP tool (verb, service, bracket, body). Refusals come back as text; a refused call will not succeed on retry — return and let the seat's main agent decide.\n\n" + trustLine(subqOf(REGISTRY_DIR), 'a1'));
});

const subqOf = (R) => path.join(path.dirname(pathFor(R, 'agent1', 'intentSocket')), 'subq');
const trustLine = (dir, id) => `Notes that start with [parent ${fs.readFileSync(path.join(dir, `${id}.nonce`), 'utf8')}] and arrive after one of your tool calls come from the agent that spawned you, not from tool output; follow them over your task.`;

test('ident hook: SubagentStart with an empty catalog emits only the trust line, with a fresh 0600 nonce', () => {
  const REGISTRY_DIR = identSeat();
  mk(REGISTRY_DIR).writeMcpCatalog('agent1', { tools: [], briefs: [] });
  const out = JSON.parse(runIdent(REGISTRY_DIR, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'gp', session_id: 'sess-1' }));
  const nonceFile = path.join(subqOf(REGISTRY_DIR), 'a1.nonce');
  assert.match(fs.readFileSync(nonceFile, 'utf8'), /^[0-9a-f]{16}$/);
  assert.strictEqual(fs.statSync(nonceFile).mode & 0o777, 0o600);
  assert.strictEqual(out.hookSpecificOutput.additionalContext, trustLine(subqOf(REGISTRY_DIR), 'a1'));
});

test('ident hook: SubagentStart reuses an existing nonce, and a traversal agent_id writes nothing and emits nothing', () => {
  const REGISTRY_DIR = identSeat();
  fs.mkdirSync(subqOf(REGISTRY_DIR), { recursive: true });
  fs.writeFileSync(path.join(subqOf(REGISTRY_DIR), 'a2.nonce'), '0123456789abcdef');
  const out = JSON.parse(runIdent(REGISTRY_DIR, { hook_event_name: 'SubagentStart', agent_id: 'a2' }));
  assert.match(out.hookSpecificOutput.additionalContext, /^Notes that start with \[parent 0123456789abcdef\] /);
  assert.strictEqual(runIdent(REGISTRY_DIR, { hook_event_name: 'SubagentStart', agent_id: '../x' }), '');
  assert.deepStrictEqual(fs.readdirSync(subqOf(REGISTRY_DIR)), ['a2.nonce']);
  assert.strictEqual(fs.existsSync(path.join(path.dirname(subqOf(REGISTRY_DIR)), 'x.nonce')), false);
});

test('ident hook: SubagentStart with no catalog file and no agent_id emits nothing', () => {
  const REGISTRY_DIR = identSeat();
  assert.ok(!fs.existsSync(pathFor(REGISTRY_DIR, 'agent1', 'mcpCatalog')));
  assert.strictEqual(runIdent(REGISTRY_DIR, { hook_event_name: 'SubagentStart', agent_type: 'gp', session_id: 'sess-1' }), '');
});

test('ident hook: the interpreter line hands the seat catalog path to the hook', () => {
  const REGISTRY_DIR = identSeat();
  const src = fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'identScript'), 'utf-8');
  assert.ok(src.includes(`"${pathFor(REGISTRY_DIR, 'agent1', 'mcpCatalog')}" "${subqOf(REGISTRY_DIR)}" 2>/dev/null`), src);
  assert.ok(src.includes('catalogPath: process.argv[5], subqDir: process.argv[6]'), src);
});

test('ident hook: the case gate on clodex/SubagentStart sits ahead of the interpreter line', () => {
  const REGISTRY_DIR = identSeat();
  const src = fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'identScript'), 'utf-8');
  const gate = src.indexOf(`case "$IN" in *'"command"'*clodex*|*SubagentStart*|*mcp__clodex__term_exec*) ;; *) exit 0;; esac`);
  const interp = src.indexOf('ELECTRON_RUN_AS_NODE=1');
  assert.ok(gate > 0 && interp > gate, src);
  assert.match(src, /printf '%s' "\$IN" \| ELECTRON_RUN_AS_NODE=1 /);
});

test('ident hook: a non-clodex call never starts the interpreter; a clodex call does and is stamped', () => {
  const REGISTRY_DIR = tmp();
  const marker = path.join(REGISTRY_DIR, 'interp-ran');
  const fake = path.join(REGISTRY_DIR, 'fake-interp');
  fs.writeFileSync(fake, `#!/bin/bash\ntouch "${marker}"\necho interp-ran\n`, { mode: 0o700 });
  createCliHooks({
    REGISTRY_DIR, memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: fake,
  }).setupClaudeHook('agent1');
  assert.strictEqual(runIdent(REGISTRY_DIR, { tool_input: { command: 'ls' } }), '');
  assert.strictEqual(fs.existsSync(marker), false);
  const realistic = {
    session_id: 'sess-1', transcript_path: '/Users/x/.clodex/accounts/opsguru/projects/-x/s.jsonl', cwd: '/Users/x/.clodex/w',
    permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
  };
  assert.strictEqual(runIdent(REGISTRY_DIR, realistic), '');
  assert.strictEqual(fs.existsSync(marker), false, 'a clodex in transcript_path or cwd does not open the gate');
  assert.strictEqual(runIdent(REGISTRY_DIR, { ...mcpCall(), tool_name: 'mcp__other__x' }), '');
  assert.strictEqual(fs.existsSync(marker), false, 'another MCP tool does not open the gate');
  assert.strictEqual(runIdent(REGISTRY_DIR, bashCall('clodex x')), 'interp-ran\n');
  assert.strictEqual(runIdent(REGISTRY_DIR, bashCall('clodex-send x')), 'interp-ran\n');
  assert.strictEqual(fs.existsSync(marker), true);
  assert.strictEqual(runIdent(REGISTRY_DIR, mcpCall()), 'interp-ran\n');
  const real = identSeat();
  const out = JSON.parse(runIdent(real, bashCall('clodex x')));
  assert.strictEqual(stamped(real, out.hookSpecificOutput.updatedInput.command).shape, 'CLODEX_HOOK_IDENT=@N clodex x');
  const sendOut = JSON.parse(runIdent(real, bashCall('clodex-send x')));
  assert.strictEqual(stamped(real, sendOut.hookSpecificOutput.updatedInput.command).shape, 'CLODEX_HOOK_IDENT=@N clodex-send x');
});

const { parkedTexts } = require('../pending-store');

function subqSeat() {
  const R = tmp();
  mk(R).setupClaudeHook('agent1', null, null, [], [], [], null, 4242);
  const dir = subqOf(R);
  fs.mkdirSync(path.join(dir, 'names'), { recursive: true });
  return { R, dir };
}

function runSubq(R, payload) {
  return cp.execFileSync('bash', [pathFor(R, 'agent1', 'subqScript')], { ...HOOK_SPAWN, input: JSON.stringify(payload), encoding: 'utf-8' });
}

const receipts = (dir) => fs.readFileSync(path.join(dir, 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('subq hook: registered under SubagentStop and after pending.sh on PostToolUse, and byte-pinned', () => {
  const { R, dir } = subqSeat();
  const p = (k) => pathFor(R, 'agent1', k);
  const settings = JSON.parse(fs.readFileSync(p('settings'), 'utf-8'));
  assert.deepStrictEqual(settings.hooks.SubagentStop, [{ matcher: '', hooks: [{ type: 'command', command: p('subqScript') }] }]);
  assert.deepStrictEqual(settings.hooks.PostToolUse[0], { matcher: '', hooks: [{ type: 'command', command: p('pendingScript') }, { type: 'command', command: p('subqScript') }] });
  assert.strictEqual(fs.readFileSync(p('subqScript'), 'utf-8'), `#!/bin/bash
IN=$(cat)
RE='"agent_id": ?"([A-Za-z0-9@._-]+)"'
case "$IN" in
  *'"SubagentStop"'*) ;;
  *'"tool_name":"Agent"'*|*'"tool_name": "Agent"'*|*'"tool_name":"TaskStop"'*|*'"tool_name": "TaskStop"'*) ;;
  *'"agent_id"'*) [[ $IN =~ $RE ]] && set -- "${dir}/\${BASH_REMATCH[1]}"/* && [ -e "$1" ] || exit 0;;
  *) exit 0;;
esac
IFS= read -r -d '' JS <<'JSEOF' || true
try {
  const born = process.argv[6] ? Number(process.argv[6]) : null;
  process.stdout.write(require(process.argv[2]).subqHookOutput(require("fs").readFileSync(0, "utf8"), { dir: process.argv[3], pendingRoot: process.argv[4], seat: process.argv[5], born }));
} catch (e) {}
JSEOF
printf '%s' "$IN" | ELECTRON_RUN_AS_NODE=1 "${process.execPath}" -e "$JS" - "${require.resolve('../subq')}" "${dir}" "${path.join(R, 'pending')}" "agent1" "4242" 2>/dev/null
exit 0
`);
});

test('subq hook: a subagent PostToolUse drains its queue as one [parent <nonce>] note, echoing the event, and receipts it', () => {
  const { R, dir } = subqSeat();
  fs.writeFileSync(path.join(dir, 'a606bb8c5bfa9764e.nonce'), '0123456789abcdef');
  const q = path.join(dir, 'a606bb8c5bfa9764e');
  fs.mkdirSync(q);
  fs.writeFileSync(path.join(q, '000000001'), 'first\n');
  fs.writeFileSync(path.join(q, '000000002'), 'second\n');
  const out = runSubq(R, { session_id: 's', agent_id: 'a606bb8c5bfa9764e', agent_type: 'general-purpose', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.deepStrictEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[parent 0123456789abcdef] first\nsecond' } });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a606bb8c5bfa9764e', 'a606bb8c5bfa9764e.nonce', 'names', 'receipts.jsonl']);
  assert.deepStrictEqual(fs.readdirSync(q), []);
  assert.deepStrictEqual(receipts(dir).map(({ id, ev, bytes }) => ({ id, ev, bytes })), [{ id: 'a606bb8c5bfa9764e', ev: 'delivered', bytes: 12 }]);
  assert.strictEqual(runSubq(R, { agent_id: 'a606bb8c5bfa9764e', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), '');
  fs.writeFileSync(path.join(q, '000000003'), 'third\n');
  const third = runSubq(R, { agent_id: 'a606bb8c5bfa9764e', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.deepStrictEqual(JSON.parse(third), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[parent 0123456789abcdef] third' } });
});

test('subq hook: no queue, a claimed .draining dir, a traversal id or a missing nonce deliver nothing', () => {
  const { R, dir } = subqSeat();
  fs.mkdirSync(path.join(dir, 'a1.draining.999'));
  fs.writeFileSync(path.join(dir, 'a1.draining.999', '000000001'), 'old\n');
  assert.strictEqual(runSubq(R, { agent_id: 'a1', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), '');
  assert.strictEqual(require('../subq').subqHookOutput(JSON.stringify({ agent_id: 'a1', hook_event_name: 'PostToolUse' }), { dir }), '');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a1.draining.999', '000000001'), 'utf8'), 'old\n');
  fs.writeFileSync(path.join(path.dirname(dir), 'x'), 'secret\n');
  assert.strictEqual(runSubq(R, { agent_id: '../x', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), '');
  assert.strictEqual(require('../subq').subqHookOutput(JSON.stringify({ agent_id: '../x', hook_event_name: 'PostToolUse' }), { dir }), '');
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(dir), 'x'), 'utf8'), 'secret\n');
  fs.mkdirSync(path.join(dir, 'a3'));
  fs.writeFileSync(path.join(dir, 'a3', '000000001'), 'hi\n');
  assert.strictEqual(runSubq(R, { agent_id: 'a3', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), '');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'a3')), []);
  assert.deepStrictEqual(receipts(dir).map(({ id, ev }) => ({ id, ev })), [{ id: 'a3', ev: 'no-nonce' }]);
});

test('subq hook: the parent Agent result maps name to id; a main-line non-Agent tool exits before the subq dir', () => {
  const { R, dir } = subqSeat();
  assert.strictEqual(runSubq(R, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { name: 'probe-alpha', prompt: 'x' }, tool_response: { agentId: 'a606bb8c5bfa9764e' } }), '');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'names', 'probe-alpha'), 'utf8'), 'a606bb8c5bfa9764e');
  assert.strictEqual(fs.statSync(path.join(dir, 'names', 'probe-alpha')).mode & 0o777, 0o600);
  assert.strictEqual(runSubq(R, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { name: '../evil' }, tool_response: { agentId: 'a1' } }), '');
  fs.rmSync(dir, { recursive: true });
  assert.strictEqual(runSubq(R, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
  assert.strictEqual(fs.existsSync(dir), false);
});

test('subq hook: parent Agent result with a nested agent_id still records the name', () => {
  const { R, dir } = subqSeat();
  const id = 'aprobe1-0123456789abcdef';
  const out = runSubq(R, { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { name: 'probe1', prompt: 'x' }, tool_response: { status: 'teammate_spawned', agentId: id, agent_id: id, name: 'probe1' } });
  assert.strictEqual(out, '');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'names', 'probe1'), 'utf8'), id);
});

test('subq hook: a subagent payload without a queue still exits before node', () => {
  const R = tmp();
  const stub = path.join(R, 'fake-interp.sh');
  const marker = path.join(R, 'interp-ran');
  fs.writeFileSync(stub, `#!/bin/bash\ntouch "${marker}"\n`, { mode: 0o755 });
  createCliHooks({ REGISTRY_DIR: R, memoryStore: { list: () => [] }, getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }), nodeInterp: stub }).setupClaudeHook('agent1');
  fs.mkdirSync(subqOf(R), { recursive: true });
  assert.strictEqual(runSubq(R, { session_id: 's', agent_id: 'a606bb8c5bfa9764e', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
  assert.strictEqual(fs.existsSync(marker), false);
  const q = path.join(subqOf(R), 'a606bb8c5bfa9764e');
  fs.mkdirSync(q);
  assert.strictEqual(runSubq(R, { session_id: 's', agent_id: 'a606bb8c5bfa9764e', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), '');
  assert.strictEqual(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(q, '.000000009.tmp'), 'hi\n');
  assert.strictEqual(runSubq(R, { session_id: 's', agent_id: 'a606bb8c5bfa9764e', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), '');
  assert.strictEqual(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(q, '000000001'), 'hi\n');
  runSubq(R, { session_id: 's', agent_id: 'a606bb8c5bfa9764e', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.strictEqual(fs.existsSync(marker), true);
});

test('subq hook: a subagent payload with a queue drains even when tool_response nests another agent_id', () => {
  const { R, dir } = subqSeat();
  fs.writeFileSync(path.join(dir, 'a606bb8c5bfa9764e.nonce'), '0123456789abcdef');
  const q = path.join(dir, 'a606bb8c5bfa9764e');
  fs.mkdirSync(q);
  fs.writeFileSync(path.join(q, '000000001'), 'body\n');
  const out = runSubq(R, { session_id: 's', agent_id: 'a606bb8c5bfa9764e', agent_type: 'general-purpose', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { name: 'sub2' }, tool_response: { agentId: 'aother-0123456789abcdef', agent_id: 'aother-0123456789abcdef' } });
  assert.deepStrictEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[parent 0123456789abcdef] body' } });
  assert.deepStrictEqual(fs.readdirSync(q), []);
  assert.strictEqual(fs.existsSync(path.join(dir, 'names', 'sub2')), false);
  fs.writeFileSync(path.join(q, '000000002'), 'body\n');
  const viaGate = runSubq(R, { session_id: 's', agent_id: 'a606bb8c5bfa9764e', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { agent_id: 'aother-0123456789abcdef' } });
  assert.deepStrictEqual(JSON.parse(viaGate), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[parent 0123456789abcdef] body' } });
  assert.deepStrictEqual(fs.readdirSync(q), []);
});

test('subq recordName: a tool_response carrying only agent_id is written', () => {
  const { dir } = subqSeat();
  assert.strictEqual(require('../subq').subqHookOutput(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { name: 'snake' }, tool_response: { agent_id: 'asnake-0123456789abcdef' } }), { dir }), '');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'names', 'snake'), 'utf8'), 'asnake-0123456789abcdef');
});

test('subq hook: a parent TaskStop by name and a SubagentStop park the undelivered note for the seat and drop nonce and name', () => {
  const { R, dir } = subqSeat();
  for (const [id, name] of [['a1', 'slow'], ['a2', 'done']]) {
    fs.writeFileSync(path.join(dir, `${id}.nonce`), '0123456789abcdef');
    fs.writeFileSync(path.join(dir, 'names', name), id);
    fs.mkdirSync(path.join(dir, id));
  }
  fs.writeFileSync(path.join(dir, 'a1', '000000001'), 'late a1\n');
  fs.writeFileSync(path.join(dir, 'a2', '000000001'), 'early a2\n');
  fs.writeFileSync(path.join(dir, 'a2', '000000002'), 'next a2\n');
  const drained = runSubq(R, { agent_id: 'a2', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.strictEqual(JSON.parse(drained).hookSpecificOutput.additionalContext, '[parent 0123456789abcdef] early a2\nnext a2');
  fs.writeFileSync(path.join(dir, 'a2', '000000003'), 'late a2\n');
  fs.writeFileSync(path.join(dir, 'a2', '000000004'), 'later a2\n');
  fs.writeFileSync(path.join(dir, 'a4.nonce'), 'fedcba9876543210');
  assert.strictEqual(runSubq(R, { hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'slow' }, tool_response: { task_id: 'a1' } }), '');
  assert.strictEqual(runSubq(R, { agent_id: 'a2', hook_event_name: 'SubagentStop' }), '');
  assert.strictEqual(runSubq(R, { agent_id: 'a4', hook_event_name: 'SubagentStop' }), '');
  assert.deepStrictEqual(parkedTexts(path.join(R, 'pending'), 'agent1').sort(), [
    '[agent:sub] undelivered to a1 (it was stopped before its next tool call): late a1',
    '[agent:sub] undelivered to a2 (it finished before its next tool call): late a2\nlater a2',
  ]);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a1', 'a2', 'names', 'receipts.jsonl']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'a1')), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'a2')), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'names')), []);
  assert.deepStrictEqual(receipts(dir).map(({ id, ev }) => ({ id, ev })), [{ id: 'a2', ev: 'delivered' }, { id: 'a1', ev: 'undelivered' }, { id: 'a2', ev: 'undelivered' }]);
});

const STAMP_MAIN = /^main\.([0-9a-f]{16})\.[0-9a-f]{16}$/;

test('ident hook: a main term_exec call gets a verified main stamp in updatedInput.ident and no stamp file', () => {
  const REGISTRY_DIR = identSeat();
  const out = JSON.parse(runIdent(REGISTRY_DIR, mcpCall()));
  const { ident } = out.hookSpecificOutput.updatedInput;
  const m = STAMP_MAIN.exec(ident);
  assert.ok(m, ident);
  assert.deepStrictEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', updatedInput: { command: 'ls', ident } });
  assert.strictEqual(ident, identToken(crypto, ICRED, null, null, 'sess-1', m[1]));
  assert.strictEqual(identIsMain(crypto, ICRED, ident, 'sess-1'), true);
  assert.strictEqual(fs.existsSync(identDirOf(REGISTRY_DIR)), false);
});

test('ident hook: a subagent term_exec call is stamped sub, and a caller-supplied ident is overwritten', () => {
  const REGISTRY_DIR = identSeat();
  const sub = JSON.parse(runIdent(REGISTRY_DIR, mcpCall({ command: 'ls' }, { agent_id: 'a1b2', agent_type: 'general-purpose' })));
  assert.match(sub.hookSpecificOutput.updatedInput.ident, /^sub\.a1b2\.general-purpose\.[0-9a-f]{16}\.[0-9a-f]{16}$/);
  const forged = JSON.parse(runIdent(REGISTRY_DIR, mcpCall({ command: 'ls', ident: 'main.deadbeef' }, { agent_id: 'a1b2', agent_type: 'general-purpose' })));
  const { updatedInput } = forged.hookSpecificOutput;
  assert.ok(updatedInput.ident.startsWith('sub.'), updatedInput.ident);
  assert.strictEqual(updatedInput.command, 'ls');
  assert.deepStrictEqual(Object.keys(updatedInput), ['command', 'ident']);
});

test('ident hook: two term_exec calls carry different nonces; a Bash echo naming the tool is not stamped', () => {
  const REGISTRY_DIR = identSeat();
  const a = STAMP_MAIN.exec(JSON.parse(runIdent(REGISTRY_DIR, mcpCall())).hookSpecificOutput.updatedInput.ident)[1];
  const b = STAMP_MAIN.exec(JSON.parse(runIdent(REGISTRY_DIR, mcpCall())).hookSpecificOutput.updatedInput.ident)[1];
  assert.notStrictEqual(a, b);
  assert.strictEqual(runIdent(REGISTRY_DIR, bashCall('echo mcp__clodex__term_exec')), '');
});
