// cli-hooks.js — per-session CLI hook wiring for Claude and Codex sessions.
// Claude: writeClaudeDigestFile renders the SessionStart digest file;
// setupClaudeHook writes the transcript-symlink script, the statusline script,
// the attn/acks/pending/ctxwarn drain scripts, and the --settings JSON (proxy
// env routing, deny rules, skill overrides). Codex: setupCodexHook installs the
// project .codex/hooks.json (backing up any existing one) pointing at a shared
// WB_WRAP_NAME-routed script. cleanupClaudeHook / cleanupCodexHook remove it all
// on session exit.
//
// FACTORY (M3 DI): the bodies read three main.js singletons/globals —
// REGISTRY_DIR (runtime dir) and memoryStore (digest source), injected by value,
// and uiSettings, which is only assigned in app.whenReady() (after this module
// is required), so it is injected as a getUiSettings() getter. That getter is
// the single non-identical seam line (the renderClaudeStatusScript call);
// everything else is byte-identical modulo the +2 factory indent.
//
// The hook bodies are all filesystem writes, so they are left to integration;
// the generated script strings have a shape unit test alongside.

const fs = require('fs');
const path = require('path');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { pathFor, runDirFor } = require('./clodex-paths');
const { composeDigest } = require('./memory-store');
const { renderClaudeStatusScript } = require('./statusline');
const { CLAUDE_TOOLS } = require('./catalogs');
const { denyAgentRules } = require('./agents-util');

function createCliHooks({ REGISTRY_DIR, memoryStore, getUiSettings }) {
  function writeClaudeDigestFile(name) {
    ensureDir(runDirFor(REGISTRY_DIR, name));
    const digest = composeDigest(memoryStore.list(name));
    const ctx = `You are the clodex agent named '${name}'.` + (digest ? `\n\n${digest}` : '');
    // Atomic: a mid-session store mutation rewrites this file while a /clear
    // could be cat-ing it from the hook at the same instant.
    atomicWriteFileSync(pathFor(REGISTRY_DIR, name, 'hookDigest'), JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx }
    }) + '\n');
    return !!digest;
  }

  function setupClaudeHook(name, proxyBase = null, proxyAgent = null, denyBuiltins = [], disabledTools = [], disabledSkills = [], wireBase = null) {
    ensureDir(runDirFor(REGISTRY_DIR, name));
    const linkPath = pathFor(REGISTRY_DIR, name, 'transcript');
    const scriptPath = pathFor(REGISTRY_DIR, name, 'hook');
    const settingsPath = pathFor(REGISTRY_DIR, name, 'settings');
    const outputPath = pathFor(REGISTRY_DIR, name, 'hookOutput');
    const digestPath = pathFor(REGISTRY_DIR, name, 'hookDigest');
    const statusPath = pathFor(REGISTRY_DIR, name, 'statusline');
    const msgDir = path.join(REGISTRY_DIR, 'messages');

    // Pre-render hook output: the agent NAME only. The protocol prompt itself
    // ships via --append-system-prompt-file (settled position) and is static, so
    // the system-prompt bytes are identical across agents and share the provider
    // prefix cache; the per-agent name rides this channel into the first user
    // turn instead, where bytes diverge per session anyway. Re-fires on
    // resume/clear, so identity survives both.
    const hookOutput = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `You are the clodex agent named '${name}'.`,
      }
    });
    fs.writeFileSync(outputPath, hookOutput + '\n');
    writeClaudeDigestFile(name);

    // Hook script: repoint the transcript symlink, then emit additionalContext.
    // The digest-bearing output goes ONLY to conversations being BORN (source
    // startup/clear) — a resume already carries the digest in its history (and
    // additionalContext survives /compact verbatim, settled position #2), so
    // re-emitting it would duplicate KBs into context on every GUI restart.
    // Unknown/missing source falls to name-only: fails toward a missed digest
    // (the append-once ledger path rescues), never a duplicated one.
    const script = `#!/bin/bash
set -euo pipefail
INPUT="$(cat)"
TPATH="$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || true)"
[ -z "$TPATH" ] && exit 0
TMPLINK="${linkPath}.tmp.$$"
ln -sf "$TPATH" "$TMPLINK"
mv -f "$TMPLINK" "${linkPath}"
SRC="$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('source',''))" 2>/dev/null || true)"
if [ "$SRC" = "startup" ] || [ "$SRC" = "clear" ]; then
  cat "${digestPath}"
else
  cat "${outputPath}"
fi
`;
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    fs.writeFileSync(statusPath, renderClaudeStatusScript(name, !!proxyBase, getUiSettings(), REGISTRY_DIR), { mode: 0o700 });

    // Needs-attention channel: the CLI's Notification hook fires when a
    // permission dialog opens (or the CLI otherwise wants the human). The script
    // just appends the raw hook JSON to a per-session file; classification and
    // policy live in JS (attention.js / SessionManager). Truncated at setup so
    // a resume never replays last run's stale dialogs.
    const attnPath = pathFor(REGISTRY_DIR, name, 'attn');
    const attnScriptPath = pathFor(REGISTRY_DIR, name, 'attnScript');
    fs.writeFileSync(attnPath, '');
    fs.writeFileSync(attnScriptPath, `#!/bin/bash
IN="$(cat)"
printf '%s\\n' "$IN" >> "${attnPath}"
`, { mode: 0o700 });

    // Deferred memory-mutation acks (_memoryAck): drain {name}-acks into the
    // next turn's context via UserPromptSubmit additionalContext. Read+truncate
    // isn't atomic against a concurrent append — an ack landing in that window
    // is lost, which the channel tolerates (success acks are bookkeeping).
    // The file is left alone at setup: acks queued just before a quit are still
    // valid on resume (the mutations they confirm persisted).
    const ackPath = pathFor(REGISTRY_DIR, name, 'acks');
    const ackScriptPath = pathFor(REGISTRY_DIR, name, 'acksScript');
    fs.writeFileSync(ackScriptPath, `#!/bin/bash
[ -s "${ackPath}" ] || exit 0
python3 - "${ackPath}" <<'PYEOF'
import json, sys
with open(sys.argv[1], 'r+') as f:
    body = f.read().strip()
    f.seek(0); f.truncate()
if body:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit", "additionalContext": body}}))
PYEOF
`, { mode: 0o700 });

    // Layer-3 delivery parking drain (see pending-store.js). Deliveries parked
    // while the operator was composing land here as UserPromptSubmit
    // additionalContext, so they arrive WITH the prompt instead of splicing the
    // draft. Unlike the ack channel this must NOT lose messages, so the drain is
    // an atomic whole-dir rename-claim (mirrors pending-store.drainPending
    // exactly, keeping the hook and the Node cap-fire drain single-source-of-
    // truth): whoever renames the dir first owns every message then present; a
    // delivery parked after the claim lands in a fresh dir and drains next turn.
    // pendingDir stays at the SHARED ~/.clodex/pending/<name> root (parked DMs
    // are not per-run state); only the drain SCRIPT relocates into run/<name>/.
    const pendingDir = path.join(REGISTRY_DIR, 'pending', name);
    const pendingScriptPath = pathFor(REGISTRY_DIR, name, 'pendingScript');
    fs.writeFileSync(pendingScriptPath, `#!/bin/bash
[ -d "${pendingDir}" ] || exit 0
python3 - "${pendingDir}" <<'PYEOF'
import json, os, sys, glob, shutil
d = sys.argv[1]
claim = d + '.draining.hook.' + str(os.getpid())
try:
    os.rename(d, claim)          # atomic claim; ENOENT => nothing to drain / lost the race
except OSError:
    sys.exit(0)
texts = []
for fp in sorted(glob.glob(os.path.join(claim, '*.json'))):
    try:
        with open(fp) as f:
            obj = json.load(f)
        if isinstance(obj.get('text'), str):
            texts.append(obj['text'])
    except Exception:
        pass                      # skip a corrupt entry, never abort the drain
shutil.rmtree(claim, ignore_errors=True)
if texts:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "\\n\\n".join(texts)}}))
PYEOF
`, { mode: 0o700 });

    // High-context reminder drain (see ctx-reminder.js). main.js writes a
    // {name}-ctxwarn file (the reminder text) while the session's absolute token
    // count is over threshold, removes it once it drops back. Unlike acks/pending
    // this hook only READS — it never consumes the file, so the reminder recurs on
    // every submit while over (deliberate; the escalation wording counters
    // habituation). Silent when the file is absent.
    const ctxwarnPath = pathFor(REGISTRY_DIR, name, 'ctxwarn');
    const ctxwarnScriptPath = pathFor(REGISTRY_DIR, name, 'ctxwarnScript');
    fs.writeFileSync(ctxwarnScriptPath, `#!/bin/bash
[ -s "${ctxwarnPath}" ] || exit 0
python3 - "${ctxwarnPath}" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    body = f.read().strip()
if body:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit", "additionalContext": body}}))
PYEOF
`, { mode: 0o700 });

    // Settings JSON
    const settings = {
      trustedDirectories: [msgDir],
      statusLine: { type: 'command', command: statusPath },
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: scriptPath }]
        }],
        Notification: [{
          matcher: '',
          hooks: [{ type: 'command', command: attnScriptPath }]
        }],
        UserPromptSubmit: [{
          matcher: '',
          // Both drains run on submit; Claude concatenates their additionalContext.
          // acks = bookkeeping (lossy-tolerant), pending = parked DMs (zero-loss).
          hooks: [
            { type: 'command', command: ackScriptPath },
            { type: 'command', command: pendingScriptPath },
            { type: 'command', command: ctxwarnScriptPath },
          ]
        }]
      }
    };
    // Optional API proxy routing. The --settings env block outranks the
    // project's .claude/settings.json, so this wins even in repos that set
    // their own ANTHROPIC_BASE_URL. /agent/<name>/ is the proxy's per-agent
    // addressing scheme (session name = agent name).
    // wireBase (shadow mode) wins: the in-process tee sits in front, and when
    // the session also has an external proxy the tee chains to it upstream —
    // the external proxy still sees its own /agent/<proxyAgent>/ route.
    if (wireBase) {
      settings.env = { ANTHROPIC_BASE_URL: `${wireBase}/anthropic` };
    } else if (proxyBase) {
      settings.env = { ANTHROPIC_BASE_URL: `${proxyBase}/agent/${proxyAgent || name}/anthropic` };
    }
    // permissions.deny serves two features:
    //  - subagent suppression: deny built-in general-purpose so the model can't
    //    fall back to the heavy default instead of an enabled lean custom agent
    //    (--agents is additive — built-ins stay registered unless denied here);
    //  - per-session tool gating: each disabled tool name is a bare deny entry.
    // Both are plain deny rules, so they concatenate. Deduped to keep the array
    // tidy if a tool is named twice.
    // Filter disabled tools to the known catalog: a stale name (e.g. a tool
    // removed from CLAUDE_TOOLS, or a typo persisted before our time) would make
    // the CLI emit "matches no known tool" warnings on every startup. The catalog
    // is authoritative, so anything not in it is silently dropped from the deny.
    const toolSet = new Set(CLAUDE_TOOLS);
    const denyRules = [...new Set([
      ...denyAgentRules(denyBuiltins),
      ...(Array.isArray(disabledTools) ? disabledTools : []).filter((t) => toolSet.has(t)),
    ])];
    if (denyRules.length) settings.permissions = { deny: denyRules };
    // Per-session skill gating. skillOverrides:{name:"off"} REMOVES the skill from
    // the injected roster, reclaiming its per-turn tokens — distinct from a deny
    // rule (Skill(name)), which only blocks invocation while still paying for the
    // listing. Unlike tools there's no static catalog (skills are project/plugin-
    // defined and discovered at runtime), so the persisted names are trusted as-is.
    const skillsOff = [...new Set((Array.isArray(disabledSkills) ? disabledSkills : []).filter(Boolean))];
    if (skillsOff.length) {
      settings.skillOverrides = Object.fromEntries(skillsOff.map((s) => [s, 'off']));
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    return settingsPath;
  }

  function setupCodexHook(name, cwd) {
    ensureDir(runDirFor(REGISTRY_DIR, name));
    // codex-session-hook.sh is SHARED (one script for all Codex agents, routed
    // by $WB_WRAP_NAME), so it stays at the ~/.clodex root, not under run/.
    const scriptPath = path.join(REGISTRY_DIR, 'codex-session-hook.sh');
    const outputPath = pathFor(REGISTRY_DIR, name, 'hookOutput');

    // Pre-render hook output: the agent NAME only. The protocol prompt ships via
    // model_instructions_file and is static across agents (prefix-cache sharing);
    // only the name rides additionalContext. Codex flattens additionalContext to
    // a wall of text — unacceptable for the full protocol, fine for one line.
    const hookOutput = JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `You are the clodex agent named '${name}'.`,
      }
    });
    fs.writeFileSync(outputPath, hookOutput + '\n');

    // Generic hook script: repoint the transcript symlink, then emit the
    // name-only additionalContext (per-name output file, routed by WB_WRAP_NAME).
    // GRAMMAR MIRROR: $NAME is resolved at RUNTIME, so the run/<name>/ paths are
    // rebuilt here in bash — keep in lockstep with clodex-paths.js (transcript =
    // run/$NAME/transcript.jsonl, hookOutput = run/$NAME/hook-output.json). The
    // byte-pinned cli-hooks test enforces this mirror.
    const script = `#!/bin/bash
set -euo pipefail
NAME="\${WB_WRAP_NAME:-}"
[ -z "$NAME" ] && exit 0
INPUT="$(cat)"
TPATH="$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || true)"
[ -z "$TPATH" ] && exit 0
RUNDIR="${REGISTRY_DIR}/run/\${NAME}"
mkdir -p "$RUNDIR"
LINK="\${RUNDIR}/transcript.jsonl"
TMPLINK="\${LINK}.tmp.$$"
ln -sf "$TPATH" "$TMPLINK"
mv -f "$TMPLINK" "$LINK"
OUTPUT="\${RUNDIR}/hook-output.json"
[ -f "$OUTPUT" ] && cat "$OUTPUT" || exit 0
`;
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    // Write .codex/hooks.json in project dir
    const codexDir = path.join(cwd, '.codex');
    const hooksPath = path.join(codexDir, 'hooks.json');
    const backupPath = hooksPath + '.wb-wrap-backup';

    const hooksConfig = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: scriptPath }]
        }]
      }
    };

    fs.mkdirSync(codexDir, { recursive: true });
    if (fs.existsSync(hooksPath) && !fs.existsSync(backupPath)) {
      fs.copyFileSync(hooksPath, backupPath);
    }
    fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig));
  }

  // Both cleanups drop the whole per-agent run/<name>/ dir — every hook/status/
  // side-channel artifact lives there now. The socket + registry entry share the
  // dir but are torn down separately by agent-transport (registry.unregister +
  // socket unlink in SessionManager._cleanup); rmSync here is idempotent against
  // that. The SHARED pending/<name>/ parked-DM dir is untouched (gated on
  // _userKilled elsewhere), as is the shared codex-session-hook.sh.
  function cleanupClaudeHook(name) {
    try { fs.rmSync(runDirFor(REGISTRY_DIR, name), { recursive: true, force: true }); } catch {}
  }

  function cleanupCodexHook(name, cwd) {
    try { fs.rmSync(runDirFor(REGISTRY_DIR, name), { recursive: true, force: true }); } catch {}
    const codexDir = path.join(cwd, '.codex');
    const hooksPath = path.join(codexDir, 'hooks.json');
    const backupPath = hooksPath + '.wb-wrap-backup';
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, hooksPath);
    } else if (fs.existsSync(hooksPath)) {
      try { fs.unlinkSync(hooksPath); } catch {}
      try { fs.rmdirSync(codexDir); } catch {}
    }
  }

  return {
    writeClaudeDigestFile, setupClaudeHook, setupCodexHook,
    cleanupClaudeHook, cleanupCodexHook,
  };
}

module.exports = { createCliHooks };
