
const fs = require('fs');
const path = require('path');
const { ensureDir, atomicWriteFileSync } = require('./fs-util');
const { pathFor, runDirFor } = require('./clodex-paths');
const { composeDigest } = require('./memory-store');
const { renderClaudeStatusScript } = require('./statusline');
const { CLAUDE_TOOLS } = require('./catalogs');
const { denyAgentRules } = require('./agents-util');

function createCliHooks({ REGISTRY_DIR, memoryStore, getUiSettings, nodeInterp }) {
  // The interpreter every generated hook shells out to: the app's own Electron
  // binary run as Node (`ELECTRON_RUN_AS_NODE=1 "<nodeInterp>"`), baked absolute
  // so a Finder/Dock-launched packaged .app never depends on an ambient python3
  // or on launchd's stripped PATH (Task 9). Electron honors the env var;
  // plain node ignores it, so the same bytes run under node in tests.
  const INTERP = `ELECTRON_RUN_AS_NODE=1 "${nodeInterp}"`;
  function writeClaudeDigestFile(name) {
    ensureDir(runDirFor(REGISTRY_DIR, name));
    const digest = composeDigest(memoryStore.list(name));
    const ctx = `You are the clodex agent named '${name}'.` + (digest ? `\n\n${digest}` : '');
    atomicWriteFileSync(pathFor(REGISTRY_DIR, name, 'hookDigest'), JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx }
    }) + '\n');
    return !!digest;
  }

  function setupClaudeHook(name, proxyBase = null, proxyAgent = null, denyBuiltins = [], disabledTools = [], disabledSkills = [], wireBase = null, createdAt = null) {
    ensureDir(runDirFor(REGISTRY_DIR, name));
    const linkPath = pathFor(REGISTRY_DIR, name, 'transcript');
    const scriptPath = pathFor(REGISTRY_DIR, name, 'hook');
    const settingsPath = pathFor(REGISTRY_DIR, name, 'settings');
    const outputPath = pathFor(REGISTRY_DIR, name, 'hookOutput');
    const digestPath = pathFor(REGISTRY_DIR, name, 'hookDigest');
    const statusPath = pathFor(REGISTRY_DIR, name, 'statusline');
    const msgDir = path.join(REGISTRY_DIR, 'messages');
    // Shared root, NOT run/<name>/ — it must outlive the run dir this function's
    // cleanup rm -rf's. Read by the SessionStart script (context-reset baseline
    // reset) and the UserPromptSubmit drain below.
    const promptCacheDir = path.join(REGISTRY_DIR, 'promptcache', name);

    const hookOutput = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `You are the clodex agent named '${name}'.`,
      }
    });
    fs.writeFileSync(outputPath, hookOutput + '\n');
    writeClaudeDigestFile(name);

    // The CLI RE-FIRES SessionStart with source=compact, so this hook's
    // additionalContext is re-emitted, not preserved across compaction — which is
    // why the baseline reset below hangs off this event. Digest ships only to
    // conversations being born (startup/clear); anything else gets name-only.
    const script = `#!/bin/bash
set -euo pipefail
INPUT="$(cat)"
TPATH="$(echo "$INPUT" | ${INTERP} -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).transcript_path||""))}catch(e){process.stdout.write("")}})' 2>/dev/null || true)"
[ -z "$TPATH" ] && exit 0
TMPLINK="${linkPath}.tmp.$$"
ln -sf "$TPATH" "$TMPLINK"
mv -f "$TMPLINK" "${linkPath}"
SRC="$(echo "$INPUT" | ${INTERP} -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).source||""))}catch(e){process.stdout.write("")}})' 2>/dev/null || true)"
if [ "$SRC" = "clear" ] || [ "$SRC" = "compact" ]; then
  ${INTERP} - "${promptCacheDir}" <<'RESETEOF' || true
const fs = require('fs'), path = require('path');
const d = process.argv[2];
// Context reset: everything delivered through UserPromptSubmit is gone (cleared
// outright, or summarized away by the compact). The system prompt survives, and
// it holds session.md — so that, and only that, is what this agent has been
// told. Reset the baseline to it and let the normal stage/drain regenerate.
let session = null;
try { session = fs.readFileSync(path.join(d, 'session.md'), 'utf8'); } catch (e) { process.exit(0); }
// Invalidate the staged pair FIRST: it was computed against the OLD baseline, so
// draining it after the reset would advance notified.md past a delta this reset
// just made wrong. Unlink-then-write means a torn run leaves no pair and an old
// baseline, which the next spawn simply re-stages.
try { fs.unlinkSync(path.join(d, 'delta.md')); } catch (e) {}
try { fs.unlinkSync(path.join(d, 'next.md')); } catch (e) {}
const tmp = path.join(d, 'notified.md.tmp.reset.' + process.pid + '.' + Date.now());
try {
  fs.writeFileSync(tmp, session, { mode: 0o600 });
  fs.renameSync(tmp, path.join(d, 'notified.md'));
} catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} }
RESETEOF
fi
if [ "$SRC" = "startup" ] || [ "$SRC" = "clear" ]; then
  cat "${digestPath}"
else
  cat "${outputPath}"
fi
`;
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });

    fs.writeFileSync(statusPath, renderClaudeStatusScript(name, !!proxyBase, getUiSettings(), REGISTRY_DIR), { mode: 0o700 });

    const attnPath = pathFor(REGISTRY_DIR, name, 'attn');
    const attnScriptPath = pathFor(REGISTRY_DIR, name, 'attnScript');
    fs.writeFileSync(attnPath, '');
    fs.writeFileSync(attnScriptPath, `#!/bin/bash
IN="$(cat)"
printf '%s\\n' "$IN" >> "${attnPath}"
`, { mode: 0o700 });

    const ackPath = pathFor(REGISTRY_DIR, name, 'acks');
    const ackScriptPath = pathFor(REGISTRY_DIR, name, 'acksScript');
    fs.writeFileSync(ackScriptPath, `#!/bin/bash
[ -s "${ackPath}" ] || exit 0
${INTERP} - "${ackPath}" <<'JSEOF'
const fs = require('fs');
const p = process.argv[2];
const body = fs.readFileSync(p, 'utf8').trim();
fs.truncateSync(p, 0);
if (body) {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: body } }));
}
JSEOF
`, { mode: 0o700 });

    // Zero-loss channel (unlike acks): the drain is an atomic whole-dir
    // rename-claim, mirroring pending-store.drainPending. pendingDir stays at the
    // shared ~/.clodex/pending/<name> root so it survives the run-dir rm -rf on
    // session exit; only the drain SCRIPT lives under run/<name>/.
    const pendingDir = path.join(REGISTRY_DIR, 'pending', name);
    const pendingScriptPath = pathFor(REGISTRY_DIR, name, 'pendingScript');
    // This script is registered under BOTH UserPromptSubmit and PostToolUse, so it
    // must NOT hardcode the output hookEventName: Claude Code's docs pair the
    // returned hookEventName with the event that actually fired, and a mismatch is
    // undocumented/unsupported (the additionalContext may be silently dropped). So
    // read the firing event's `hook_event_name` off stdin (the hook input JSON,
    // same as the attn script's `$(cat)`) and echo it back, defaulting to
    // UserPromptSubmit if stdin is absent/unparseable. Read stdin only AFTER the
    // dir guard so the empty case stays a stat-and-exit with no python spawn.
    fs.writeFileSync(pendingScriptPath, `#!/bin/bash
[ -d "${pendingDir}" ] || exit 0
IN="$(cat)"
${INTERP} - "${pendingDir}" "$IN" "${msgDir}" "${typeof createdAt === 'number' ? createdAt : ''}" <<'JSEOF'
const fs = require('fs'), path = require('path');
const d = process.argv[2];
let ev = 'UserPromptSubmit';
try {
  const _in = JSON.parse(process.argv[3]);
  ev = _in.hook_event_name || ev;
  // A subagent's tool calls fire the PARENT session's PostToolUse hook, but the
  // additionalContext returned lands in the SUBAGENT's context, not the main
  // agent's — so a consuming rename-claim here would deliver the parked DM into
  // the subagent and lose it on exit. Subagent hook inputs carry agent_id; a
  // main-agent call never does. Bail before the claim so the messages drain at
  // the next main-context event instead (deferred, never lost).
  if (_in.agent_id) process.exit(0);
} catch (e) {}                    // stdin absent/unparseable => safe default
// Inline a spilled-message @-pointer at drain time. The '@\${path}' form in a
// parked delivery is a PTY-stdin affordance (Claude expands @ only when TYPED
// into the prompt); arriving here as additionalContext it is inert text and the
// recipient burns a Read call per message. So when the SAME text drains through
// the hook, inline small files and downgrade large ones to a plain read-pointer.
// The idle-edge PTY drain keeps the @ form untouched (expansion works there).
// Fail-open: any stat/read/containment problem leaves the text byte-unchanged.
// os.path.realpath never throws on a missing path; fs.realpathSync does, so this
// helper preserves the non-throwing contract for the top-level msgroot compute.
function realpath(p) { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } }
const msgroot = process.argv[4] ? realpath(process.argv[4]) : '';
function inline_spill(t) {
  const m = t.match(/attached: @(\\S+)/);
  if (!m) return t;               // no spill pointer => nothing to inline
  const p = m[1];
  try {
    const rp = fs.realpathSync(p);
    // containment: only ever inline files under ~/.clodex/messages/ — never
    // an arbitrary path that happens to follow an @.
    if (!msgroot || (rp !== msgroot && !rp.startsWith(msgroot + path.sep))) return t;
    if (fs.statSync(rp).size <= 10240) {
      const body = fs.readFileSync(rp, { encoding: 'utf8' }).replace(/\\n+$/, '');
      const head = t.slice(0, m.index).replace(/\\s+$/, '');
      const trailer = t.slice(m.index + m[0].length).trim();
      const out = head + '\\n--- attached file: ' + p + ' ---\\n' + body + '\\n--- end attached file ---';
      return out + (trailer ? '\\n' + trailer : '');
    }
    // too large to inline: strip the @, reword to the plain read-pointer form
    return t.slice(0, m.index) + 'saved to ' + p + ' — read it with your Read tool.' + t.slice(m.index + m[0].length);
  } catch (e) {
    return t;                     // fail-open: recipient can still Read the file
  }
}
// This session's birth stamp, baked in at hook-setup time — the hook cannot read
// sessions.json (it lives in userData, which this script has no path to, and
// giving it one is a worse coupling than the problem). Mirrors drainPending's
// expectedBorn exactly; the two drainers stay single-source-of-truth. Empty =>
// no expectation => deliver everything, the safe direction.
const born_self = process.argv[5] ? Number(process.argv[5]) : null;
// Put a claimed entry back under its original basename (seq order + resend id
// survive), write-then-rename like parkDelivery. Best-effort: a failed restore
// must not abort the drain and lose the rest of the batch.
function restore_parked(base, raw) {
  const tmp = path.join(d, '.' + base + '.tmp');
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, path.join(d, base));
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) {}
  }
}
const claim = d + '.draining.hook.' + process.pid;
try {
  fs.renameSync(d, claim);        // atomic claim; ENOENT => nothing to drain / lost the race
} catch (e) {
  process.exit(0);
}
const texts = [];
for (const f of fs.readdirSync(claim).filter(function (n) { return n.endsWith('.json'); }).sort()) {
  try {
    const raw = fs.readFileSync(path.join(claim, f), 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.text !== 'string') continue;
    // Generation check, DIRECTIONAL — see drainPending's comment in
    // pending-store.js for the full table. Older = a dead predecessor's mail,
    // discard. Newer = a successor's, and *I* am the stale drainer, so put it
    // back: the claim above already renamed the dir away, so an entry we neither
    // return nor restore is DESTROYED, and destroyed in exactly the race this
    // stamp exists to fix. Symmetric-looking guards are not symmetric when the
    // operation they guard is. Unstamped entries (parked before the stamp
    // existed) deliver.
    if (born_self !== null && typeof obj.born === 'number' && obj.born !== born_self) {
      if (obj.born > born_self) restore_parked(f, raw);
      continue;
    }
    texts.push(inline_spill(obj.text));
  } catch (e) {}                  // skip a corrupt entry, never abort the drain
}
fs.rmSync(claim, { recursive: true, force: true });
if (texts.length) {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: ev,
    additionalContext: texts.join('\\n\\n') } }));
}
JSEOF
`, { mode: 0o700 });

    // This hook only READS the file — it never consumes it, so the reminder
    // recurs on every submit while over threshold. Deliberate.
    const ctxwarnPath = pathFor(REGISTRY_DIR, name, 'ctxwarn');
    const ctxwarnScriptPath = pathFor(REGISTRY_DIR, name, 'ctxwarnScript');
    fs.writeFileSync(ctxwarnScriptPath, `#!/bin/bash
[ -s "${ctxwarnPath}" ] || exit 0
${INTERP} - "${ctxwarnPath}" <<'JSEOF'
const fs = require('fs');
const body = fs.readFileSync(process.argv[2], 'utf8').trim();
if (body) {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: body } }));
}
JSEOF
`, { mode: 0o700 });

    // ORDER IS THE MECHANISM: emit delta.md, THEN rename next.md over
    // notified.md, then drop delta.md. The baseline advance is last, so a crash
    // re-delivers the same diff next turn; at-least-once is deliberate.
    // The DATA sits at the shared ~/.clodex/promptcache/<name>/ root, not under
    // run/<name>/, because cleanup rm -rf's the run dir on every exit —
    // including the one before the resume this cache exists to serve.
    const ipcdeltaScriptPath = pathFor(REGISTRY_DIR, name, 'ipcdeltaScript');
    fs.writeFileSync(ipcdeltaScriptPath, `#!/bin/bash
[ -s "${promptCacheDir}/delta.md" ] || exit 0
${INTERP} - "${promptCacheDir}" <<'JSEOF'
const fs = require('fs'), path = require('path');
const d = process.argv[2];
let body = '';
try { body = fs.readFileSync(path.join(d, 'delta.md'), 'utf8').trim(); } catch (e) { process.exit(0); }
if (!body) process.exit(0);
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "UserPromptSubmit", additionalContext: body } }));
// Only NOW advance last_ipc, and only by atomic rename.
try { fs.renameSync(path.join(d, 'next.md'), path.join(d, 'notified.md')); } catch (e) {}
try { fs.unlinkSync(path.join(d, 'delta.md')); } catch (e) {}
JSEOF
`, { mode: 0o700 });

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
          hooks: [
            { type: 'command', command: ipcdeltaScriptPath },
            { type: 'command', command: ackScriptPath },
            { type: 'command', command: pendingScriptPath },
            { type: 'command', command: ctxwarnScriptPath },
          ]
        }],
        PostToolUse: [{
          matcher: '',
          hooks: [
            { type: 'command', command: pendingScriptPath },
          ]
        }]
      }
    };
    // The --settings env block outranks the project's .claude/settings.json, so
    // this wins even in repos that set their own ANTHROPIC_BASE_URL. wireBase
    // (shadow tee) sits in front and chains to any external proxy upstream.
    if (wireBase) {
      settings.env = { ANTHROPIC_BASE_URL: `${wireBase}/anthropic` };
    } else if (proxyBase) {
      settings.env = { ANTHROPIC_BASE_URL: `${proxyBase}/agent/${proxyAgent || name}/anthropic` };
    }
    // --agents is additive: built-in subagents stay registered unless denied
    // here. Tool names are filtered against the catalog because a stale name
    // makes the CLI warn "matches no known tool" on every startup.
    const toolSet = new Set(CLAUDE_TOOLS);
    const denyRules = [...new Set([
      ...denyAgentRules(denyBuiltins),
      ...(Array.isArray(disabledTools) ? disabledTools : []).filter((t) => toolSet.has(t)),
    ])];
    if (denyRules.length) settings.permissions = { deny: denyRules };
    // skillOverrides:{name:"off"} REMOVES the skill from the injected roster,
    // reclaiming its per-turn tokens; a Skill(name) deny still pays the listing.
    const skillsOff = [...new Set((Array.isArray(disabledSkills) ? disabledSkills : []).filter(Boolean))];
    if (skillsOff.length) {
      settings.skillOverrides = Object.fromEntries(skillsOff.map((s) => [s, 'off']));
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    return settingsPath;
  }

  function setupCodexHook(name, cwd) {
    ensureDir(runDirFor(REGISTRY_DIR, name));
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

    // $NAME resolves at RUNTIME, so the run/<name>/ paths are rebuilt here in
    // bash — keep in lockstep with clodex-paths.js (transcript.jsonl,
    // hook-output.json).
    const script = `#!/bin/bash
set -euo pipefail
NAME="\${WB_WRAP_NAME:-}"
[ -z "$NAME" ] && exit 0
INPUT="$(cat)"
TPATH="$(echo "$INPUT" | ${INTERP} -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).transcript_path||""))}catch(e){process.stdout.write("")}})' 2>/dev/null || true)"
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

  // Both cleanups drop the whole per-agent run/<name>/ dir. The SHARED
  // pending/<name>/ parked-DM dir is deliberately untouched, as is the shared
  // codex-session-hook.sh.
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
