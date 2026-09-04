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
const { mkTmpRoot } = require('./lib/tmp-roots');

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
  assert.deepStrictEqual(postCmds, [pendingCmd],
    'the matcher-less PostToolUse entry must drain pending only');
  assert.match(pendingCmd, /pending/); // the pending drain script, not acks/ctxwarn

  // The pending drain runs under BOTH events, so its output hookEventName must be
  // DERIVED from the firing event (stdin's hook_event_name), never hardcoded — a
  // PostToolUse hook returning "UserPromptSubmit" is an unsupported mismatch whose
  // additionalContext Claude Code may silently drop. Pin the derivation so a
  // regression back to a hardcoded event name is caught.
  const pendingBody = fs.readFileSync(pendingCmd, 'utf-8');
  assert.match(pendingBody, /IN="\$\(cat\)"/, 'pending drain must read the hook input off stdin');
  assert.match(pendingBody, /hook_event_name/, 'pending drain must derive the output event from stdin');
  assert.match(pendingBody, /hookEventName: ev/, 'output event name must be the derived variable, not a literal');
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
  return cp.execFileSync('bash', [pathFor(REGISTRY_DIR, name, 'hook')], { input, encoding: 'utf-8' });
}

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
  const out = cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /FIRST BLOCK/, 'ENTER: the first attachment was delivered');
  assert.match(ctx, /SECOND BLOCK/, 'both attachments ride one submit');
  assert.ok(ctx.indexOf('FIRST BLOCK') < ctx.indexOf('SECOND BLOCK'), 'in the order queued');

  // Consumed: a second submit with nothing new must deliver nothing, or the
  // same block accretes in the transcript every turn.
  assert.ok(!fs.existsSync(queuePath), 'the queue file is gone after the drain');
  assert.strictEqual(cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' }), '',
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
  const ctx = JSON.parse(cp.execFileSync('bash', [scriptPath], { encoding: 'utf-8' }))
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

  const bashEntries = settings.hooks.PostToolUse.filter((e) => e.matcher === 'Bash');
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
    const r = cp.spawnSync('bash', [scriptPath], { input: payload, encoding: 'utf-8' });
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
  const kids = payloads.map(() => cp.spawn('bash', [scriptPath], { stdio: ['pipe', 'ignore', 'ignore'] }));
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
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo no-nanoseconds' },
      tool_response: { stdout: 'ok', stderr: '' }, tool_use_id: 'q', duration_ms: 1,
    }),
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
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
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo sweep' },
      tool_response: { stdout: 'ok', stderr: '' }, tool_use_id: 'w', duration_ms: 1,
    }),
    encoding: 'utf-8',
  });
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
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_input: { command: 'the newest' },
      tool_response: { stdout: 'ok', stderr: '' }, tool_use_id: 'z', duration_ms: 1,
    }),
    encoding: 'utf-8',
  });
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

// ─── The live-console PreToolUse observer (t649) ───────────────────────────
// A PreToolUse hook sits in front of the tool call, so this one is only safe
// because it OBSERVES: it emits nothing on stdout and exits 0 on every path.
// A PreToolUse that emits `hookSpecificOutput.updatedInput` or exits 2 alters
// or blocks the Bash call, which is the difference between a broken preview and
// a broken agent. Measured against claude 2.1.260: with the hook script missing
// entirely the Bash call still ran and the model still got its output, so the
// risk is never absence — it is a hook that SPEAKS. These assertions keep it mute.
test('the live observer is registered for Bash only, ahead of the tool call', () => {
  const REGISTRY_DIR = tmp();
  const h = mk(REGISTRY_DIR);
  h.setupClaudeHook('agent1');
  const settings = JSON.parse(fs.readFileSync(pathFor(REGISTRY_DIR, 'agent1', 'settings'), 'utf-8'));
  const scriptPath = pathFor(REGISTRY_DIR, 'agent1', 'bashLiveScript');

  assert.deepStrictEqual(settings.hooks.PreToolUse, [{
    matcher: 'Bash',
    hooks: [{ type: 'command', command: scriptPath }],
  }], 'a matcher-less entry here would run this before EVERY tool call, not just Bash');
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

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-live-cwd-'));
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'sleep 5' }, tool_use_id: 'tu-live-1',
    cwd, session_id: 'sess-abc',
  });
  const r = cp.spawnSync('bash', [scriptPath], { input: payload, encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, `the observer must exit 0, got ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout, '',
    'it returns NOTHING to the CLI — any output here is a chance to alter the command');

  const files = fs.readdirSync(livePath);
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

  for (const input of ['', 'not json at all', '{"tool_name":"Bash"}', '{]']) {
    const r = cp.spawnSync('bash', [scriptPath], { input, encoding: 'utf-8' });
    assert.strictEqual(r.status, 0, `exit 0 on ${JSON.stringify(input)}, got ${r.status}`);
    assert.strictEqual(r.stdout, '', `silent on ${JSON.stringify(input)}`);
  }
});
