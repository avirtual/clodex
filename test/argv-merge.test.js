// Run: node --test
// Covers argv/prompt merging: Claude's append-channel prepend order + flag
// stripping, Codex's collapsed instructions, the MODEL_WINDOWS denominator
// override, and the statusline ctx side-channel parse.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  mergeClaudeSystemPrompt, mergeCodexInstructions,
  MODEL_WINDOWS, effectiveWindowSize, parseCtxFile,
} = require('../argv-merge');

test('mergeClaudeSystemPrompt: ipc leads, then appends, then inline', () => {
  const { cleaned, append } = mergeClaudeSystemPrompt([], 'IPC', {
    appendBodies: ['A', 'B'], inlineBody: 'INLINE',
  });
  assert.deepStrictEqual(cleaned, []);
  assert.strictEqual(append, 'IPC\n\nA\n\nB\n\nINLINE');
});

test('mergeClaudeSystemPrompt (T51): a falsy/empty ipcPrompt drops the protocol blob but keeps the appends', () => {
  // The lean-reviewer path (CLODEX_DISABLE_IPC_PROMPT=1) passes '' as ipcPrompt so
  // the IPC protocol vanishes while the role/library/inline appends still ride —
  // the filter(Boolean) at the seam is exactly what makes an empty ipcPrompt a no-op.
  const { append } = mergeClaudeSystemPrompt([], '', {
    appendBodies: ['ROLE'], inlineBody: 'INLINE',
  });
  assert.strictEqual(append, 'ROLE\n\nINLINE', 'no leading IPC block, appends intact');
  // Sanity: the SAME call with a real ipcPrompt DOES lead with it (the on/off contrast).
  const withIpc = mergeClaudeSystemPrompt([], 'IPC', { appendBodies: ['ROLE'], inlineBody: 'INLINE' });
  assert.strictEqual(withIpc.append, 'IPC\n\nROLE\n\nINLINE');
});

test('mergeClaudeSystemPrompt: --append-system-prompt is consumed into the blob', () => {
  const { cleaned, append } = mergeClaudeSystemPrompt(
    ['--model', 'opus', '--append-system-prompt', 'USER'], 'IPC', {});
  assert.deepStrictEqual(cleaned, ['--model', 'opus']);
  assert.strictEqual(append, 'IPC\n\nUSER');
});

test('mergeClaudeSystemPrompt: hasSystemFile drops a conflicting user --system-prompt', () => {
  const { cleaned } = mergeClaudeSystemPrompt(
    ['--system-prompt', 'REPLACED', '--model', 'x'], 'IPC', { hasSystemFile: true });
  assert.deepStrictEqual(cleaned, ['--model', 'x']);
});

test('mergeClaudeSystemPrompt: without hasSystemFile the user --system-prompt survives', () => {
  const { cleaned } = mergeClaudeSystemPrompt(
    ['--system-prompt', 'KEEP'], 'IPC', {});
  assert.deepStrictEqual(cleaned, ['--system-prompt', 'KEEP']);
});

test('mergeClaudeSystemPrompt: --append-system-prompt-file inlines the file, missing file swallowed', () => {
  const tmp = path.join(os.tmpdir(), `argv-merge-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'FROMFILE');
  try {
    const { append } = mergeClaudeSystemPrompt(
      ['--append-system-prompt-file', tmp], 'IPC', {});
    assert.strictEqual(append, 'IPC\n\nFROMFILE');
  } finally { fs.unlinkSync(tmp); }
  // a missing file throws no error; note the catch's `i++` double-advances past
  // the read (++i) AND the next token, so a trailing arg is also swallowed —
  // a latent quirk, preserved verbatim by the move-only extraction.
  const { cleaned, append } = mergeClaudeSystemPrompt(
    ['--append-system-prompt-file', '/no/such/file', '--foo'], 'IPC', {});
  assert.deepStrictEqual(cleaned, []);
  assert.strictEqual(append, 'IPC');
});

test('mergeCodexInstructions: system, ipc, appends, inline collapse in order', () => {
  const { cleaned, merged } = mergeCodexInstructions([], 'IPC', {
    systemBody: 'SYS', appendBodies: ['A'], inlineBody: 'IN',
  });
  assert.deepStrictEqual(cleaned, []);
  assert.strictEqual(merged, 'SYS\n\nIPC\n\nA\n\nIN');
});

test('mergeCodexInstructions: -c model_instructions_file is inlined and stripped', () => {
  const tmp = path.join(os.tmpdir(), `codex-instr-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'CFG');
  try {
    const { cleaned, merged } = mergeCodexInstructions(
      ['-c', `model_instructions_file=${tmp}`, '-c', 'other=1'], 'IPC', {});
    assert.deepStrictEqual(cleaned, ['-c', 'other=1']);
    assert.strictEqual(merged, 'IPC\n\nCFG');
  } finally { fs.unlinkSync(tmp); }
});

test('effectiveWindowSize: 1M-suffix and fable get bumped, never shrunk', () => {
  assert.strictEqual(effectiveWindowSize('claude-opus-4-8[1m]', 200_000), 1_000_000);
  assert.strictEqual(effectiveWindowSize('claude-fable-5', 200_000), 1_000_000);
  // never shrinks: a correctly-reported larger size passes through
  assert.strictEqual(effectiveWindowSize('claude-opus-4-8[1m]', 2_000_000), 2_000_000);
  // unknown model → reported value untouched
  assert.strictEqual(effectiveWindowSize('claude-sonnet-5', 200_000), 200_000);
  assert.strictEqual(effectiveWindowSize(null, 123), 123);
  assert.ok(Array.isArray(MODEL_WINDOWS));
});

test('parseCtxFile: legacy single-field stays parseable', () => {
  assert.deepStrictEqual(parseCtxFile('42'), { pct: 42, tok: null, size: null, cost: null, modelName: null });
});

test('parseCtxFile: full record recomputes pct against the corrected window', () => {
  // reported 200k but a 1M model → size bumps to 1M, pct recomputed off tok
  const r = parseCtxFile('20\t100000\t200000\tclaude-fable-5');
  assert.strictEqual(r.tok, 100000);
  assert.strictEqual(r.size, 1_000_000);
  assert.strictEqual(r.pct, 10); // 100000/1000000 = 10%, not the CLI's 20
});

test('parseCtxFile: no override keeps the reported pct/size (no cost/model → null)', () => {
  const r = parseCtxFile('35\t70000\t200000\tclaude-sonnet-5');
  assert.deepStrictEqual(r, { pct: 35, tok: 70000, size: 200000, cost: null, modelName: null });
});

test('parseCtxFile: trailing cost + model fields parse (wire-off cost/model)', () => {
  const r = parseCtxFile('7\t14497\t200000\tus.anthropic.claude-sonnet-4-6\t0.0342\tSonnet 4.6');
  assert.deepStrictEqual(r, { pct: 7, tok: 14497, size: 200000, cost: 0.0342, modelName: 'Sonnet 4.6' });
  // a zero cost round-trips as 0 (not null) so the UI can distinguish
  // "reported zero" from "field absent"
  assert.strictEqual(parseCtxFile('7\t14497\t200000\tmodel\t0').cost, 0);
});
