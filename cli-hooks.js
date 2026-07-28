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
    // Atomic: a mid-session store mutation rewrites this file while a /clear
    // could be cat-ing it from the hook at the same instant.
    atomicWriteFileSync(pathFor(REGISTRY_DIR, name, 'hookDigest'), JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx }
    }) + '\n');
    return !!digest;
  }

  // `createdAt` is the spawning session's birth stamp, baked into the pending-drain
  // script below so the hook can tell its own generation's mail from a
  // predecessor's. It is PASSED IN, never recomputed here: SessionManager's create
  // method owns the one `(existing && existing.createdAt) || Date.now()`
  // expression, and a second copy would drift the first time either was touched.
  // (That phrasing avoids writing the call form literally: test/create-mint-census
  // matches `<word>.create(` with a regex that is not comment-aware, so the prose
  // would register as a 12th call site. Flagged there, not worked around silently.)
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

    // Hook script: repoint the transcript symlink, reset the IPC-delta baseline
    // on a context reset, then emit additionalContext.
    //
    // The digest-bearing output goes ONLY to conversations being BORN (source
    // startup/clear); a resume gets name-only, so a GUI restart doesn't duplicate
    // KBs into context. Unknown/missing source falls to name-only: fails toward a
    // missed digest (the append-once ledger path rescues), never a duplicated one.
    //
    // CORRECTED MECHANISM (t63; retires settled position #2, which claimed
    // additionalContext "survives /compact verbatim" — measured false against
    // captured wire traffic). What actually happens: the CLI RE-FIRES SessionStart
    // with source=compact, so this hook's additionalContext is re-emitted, not
    // preserved. It is SELF-HEALING. Compaction replaces the messages array with a
    // generated summary, so channels that do NOT re-fire — UserPromptSubmit, and
    // therefore the ipcdelta drain below — have their delivered content summarized
    // away like any other message. That is why the reset exists.
    // A consequence of the SRC gate under this corrected mechanism (a compact
    // re-fire takes the else branch, so a long-lived session loses its digest at
    // the first compact) is tracked as its own ticket; the gate is deliberately
    // unchanged here — re-emitting KBs of digest after every compact is a
    // context-cost decision of its own.
    //
    // THE RESET RULE. The system prompt survives compaction (it is the system
    // block, not a member of the messages array), so after a clear or a compact
    // the ONLY Clodex instruction text the agent still holds is session.md.
    // notified.md means "what this agent has been told BEYOND its system prompt",
    // and after a context reset that is nothing — so the correct action at either
    // edge is `notified.md := session.md`, NOT re-delivering the last delta. The
    // existing edge-triggered machinery then regenerates precisely the delta the
    // agent is now missing, which may be larger than the one that was lost, and
    // should be.
    //
    // WHY THE RACE WITH THE DRAIN'S RENAME IS UNREACHABLE, not merely unlikely.
    // Both write notified.md, but they run on different CLI events that cannot
    // overlap for one session: this is SessionStart, which fires while the
    // conversation is being (re)established, and the drain is UserPromptSubmit,
    // which fires on a submitted turn. The CLI runs one session's hooks serially,
    // and there is no turn to submit until SessionStart has returned. The
    // interleaving chosen inside this script matters for the same reason and is
    // stated there: the reset unlinks delta.md/next.md BEFORE writing
    // notified.md, so even a torn execution can only leave a staged pair absent
    // and the baseline old — the re-stage-on-next-spawn case, which is correct —
    // and never a drained pair advancing the baseline past a delta the reset just
    // invalidated.
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
${INTERP} - "${ctxwarnPath}" <<'JSEOF'
const fs = require('fs');
const body = fs.readFileSync(process.argv[2], 'utf8').trim();
if (body) {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: body } }));
}
JSEOF
`, { mode: 0o700 });

    // IPC-prompt delta drain (see ipc-prompt-cache.js). A resumed session keeps
    // the system prompt it was born with — rewriting it would re-bill the whole
    // context — so protocol changes ride here as a diff instead.
    //
    // ORDER IS THE WHOLE MECHANISM, do not "simplify" it: emit delta.md FIRST,
    // then atomically rename next.md over notified.md (= advance last_ipc), then
    // drop delta.md. Because the advance is the LAST step, it cannot happen
    // before delivery — a crash anywhere in between re-delivers the same diff
    // next turn. At-least-once is deliberate: a repeated diff is noise, a
    // dropped one leaves an agent emitting a verb that no longer exists.
    //
    // The DATA is at the shared ~/.clodex/promptcache/<name>/ root, not under
    // run/<name>/, because cleanupClaudeHook rm -rf's this run dir on every exit
    // — including the one right before the resume this cache exists to serve.
    // Same split as pending/: shared data, per-run script.
    const ipcdeltaScriptPath = pathFor(REGISTRY_DIR, name, 'ipcdeltaScript');
    // (promptCacheDir is defined above, next to the SessionStart script that
    // performs the context-reset baseline reset into the same directory.)
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
          // All drains run on submit; Claude concatenates their additionalContext
          // in registration order. acks = bookkeeping (lossy-tolerant),
          // pending = parked DMs (zero-loss).
          // ipcdelta goes FIRST, deliberately: it is a protocol change — it can
          // alter what the intents in the messages BELOW it even mean — and it
          // fires rarely, so burying it under parked DMs and a context warning
          // makes the one thing that reframes everything else the easiest to read
          // past.
          hooks: [
            { type: 'command', command: ipcdeltaScriptPath },
            { type: 'command', command: ackScriptPath },
            { type: 'command', command: pendingScriptPath },
            { type: 'command', command: ctxwarnScriptPath },
          ]
        }],
        // Parked-DM drain ONLY (not acks/ctxwarn — those are turn-boundary
        // bookkeeping that shouldn't fire per-tool). PostToolUse fires between an
        // agent's tool calls, so a DM parked while the agent is mid-turn/busy is
        // delivered MID-LOOP as additionalContext next to the tool result — and
        // Claude Code saves it to the transcript, so it survives into later
        // requests (the ghost-history defect the wire approach couldn't avoid).
        // Same pendingScriptPath, same atomic rename-claim as the UserPromptSubmit
        // drain: whichever event fires first delivers, the other emits nothing.
        // Cheap on the empty case — the script stats the pending dir and exits
        // before spawning python when nothing is parked.
        PostToolUse: [{
          matcher: '',
          hooks: [
            { type: 'command', command: pendingScriptPath },
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
