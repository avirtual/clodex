// Prompt-channel merging + context-window math for CLI argv assembly. Given a
// session's extraArgs and the pieces to prepend (IPC protocol, library appends,
// system persona), produces the cleaned argv + the single merged instruction
// blob each CLI wants — Claude's append channel, Codex's collapsed instructions.
// Also owns the statusline ctx side-channel parse + the MODEL_WINDOWS
// denominator override the CLI under-reports for 1M-window models.
// Seam: pure functions over argv arrays + strings; only Node builtins (fs to
// inline a user-supplied prompt file, os for ~ expansion) — no main.js state.
// Gotcha: a missing --append/-c file is swallowed (best-effort inline), matching
// the CLI's own tolerance; effectiveWindowSize never SHRINKS a reported size.

const os = require('os');
const fs = require('fs');

// Build Claude's two prompt channels. The APPEND channel (returned as `append`,
// written to a generated file → --append-system-prompt-file) always leads with
// the IPC protocol, then the session's ordered library appends, then a legacy
// inline body, then any user --append-system-prompt(-file) from extraArgs. The
// SYSTEM channel (a replacement base persona) is a session-referenced library
// file pointed at DIRECTLY via --system-prompt-file by the caller — not merged
// here; when a session carries one, a conflicting user --system-prompt(-file)
// in extraArgs is dropped so the CLI never sees two. Returns cleaned argv +
// the append blob.
//   opts: { appendBodies: string[], inlineBody: string|null, hasSystemFile: bool }
function mergeClaudeSystemPrompt(extraArgs, ipcPrompt, opts = {}) {
  const { appendBodies = [], inlineBody = null, hasSystemFile = false } = opts;
  const parts = [ipcPrompt, ...appendBodies];
  if (inlineBody) parts.push(inlineBody);
  const cleaned = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (a === '--append-system-prompt' && i + 1 < extraArgs.length) {
      parts.push(extraArgs[++i]);
      continue;
    }
    if (a === '--append-system-prompt-file' && i + 1 < extraArgs.length) {
      try { parts.push(fs.readFileSync(extraArgs[++i], 'utf-8')); } catch { i++; }
      continue;
    }
    if (hasSystemFile && (a === '--system-prompt' || a === '--system-prompt-file')
        && i + 1 < extraArgs.length) {
      i++; // session's system ref wins — drop the user's conflicting flag
      continue;
    }
    cleaned.push(a);
  }
  return { cleaned, append: parts.filter(Boolean).join('\n\n') };
}

// Codex has a single instructions channel, so system + IPC + appends collapse
// into one model_instructions_file (in that order): the system base persona
// (which itself replaces Codex's default), then the IPC protocol, then the
// ordered library appends, then a legacy inline body, then any user-supplied
// model_instructions_file inlined from extraArgs.
//   opts: { systemBody: string|null, appendBodies: string[], inlineBody: string|null }
function mergeCodexInstructions(extraArgs, ipcPrompt, opts = {}) {
  const { systemBody = null, appendBodies = [], inlineBody = null } = opts;
  const parts = [];
  if (systemBody) parts.push(systemBody);
  parts.push(ipcPrompt, ...appendBodies);
  if (inlineBody) parts.push(inlineBody);
  const cleaned = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (a === '-c' && i + 1 < extraArgs.length && /^model_instructions_file=/.test(extraArgs[i + 1])) {
      const raw = extraArgs[++i].replace(/^model_instructions_file=/, '').replace(/^~/, os.homedir());
      try { parts.push(fs.readFileSync(raw, 'utf-8')); } catch {}
      continue;
    }
    cleaned.push(a);
  }
  return { cleaned, merged: parts.filter(Boolean).join('\n\n') };
}

// Context-window sizes the CLI statusline under-reports. The bar's denominator
// comes solely from statusline JSON `.context_window.context_window_size`, and
// for 1M-window models the CLI still reports 200k (observed: claude-fable-5
// showing "20% of 200k" on a 1M window). First matching rule wins; the override
// never SHRINKS a reported size, so a CLI that starts reporting correctly (or a
// future >1M window) passes through untouched.
const MODEL_WINDOWS = [
  [/\[1m\]$/, 1_000_000],        // CLI marks 1M-mode ids with a [1m] suffix
  [/^claude-fable-5/, 1_000_000], // 1M natively
];

function effectiveWindowSize(modelId, reported) {
  if (modelId) {
    for (const [re, size] of MODEL_WINDOWS) {
      if (re.test(modelId)) return Math.max(size, reported || 0);
    }
  }
  return reported;
}

// Parse the statusline ctx side-channel "<pct>\t<used_tokens>\t<window_size>
// \t<model_id>". pct is the first whitespace-delimited field, so callers that
// still parseInt the whole file keep working; tok/size/model are null on legacy
// shorter files. Applies the MODEL_WINDOWS denominator override here — the one
// choke point both the live fs.watch path and restore's readCtxFor go through —
// and recomputes pct against the corrected size (the CLI's used_percentage is
// computed off the same wrong denominator).
function parseCtxFile(raw) {
  const parts = String(raw).trim().split('\t');
  const num = (s) => { const n = parseInt(s, 10); return isNaN(n) ? null : n; };
  let pct = num(parts[0]);
  const tok = num(parts[1]);
  const reported = num(parts[2]);
  const model = (parts[3] || '').trim() || null;
  const size = effectiveWindowSize(model, reported);
  if (size !== reported && tok != null && size > 0) {
    pct = Math.round((tok / size) * 100);
  }
  return { pct, tok, size };
}

module.exports = {
  mergeClaudeSystemPrompt, mergeCodexInstructions,
  MODEL_WINDOWS, effectiveWindowSize, parseCtxFile,
};
