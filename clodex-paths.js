// clodex-paths.js — the single source of truth for the per-agent runtime path
// grammar under ~/.clodex. Pure leaf (like scope-util): no electron, no I/O,
// just string math over an injected root. NOT in the leak-scanner SCANNED
// lists.
//
// LAYOUT. Everything generated for ONE agent lives in a per-agent runtime dir
// with UNSUFFIXED names:
//
//   ~/.clodex/run/<name>/
//     transcript.jsonl   symlink → the CLI's live transcript (was {name}.jsonl)
//     agent.json         socket registry entry           (was {name}.json)
//     agent.sock         per-agent Unix socket            (was {name}.sock)
//     hook.sh            Claude SessionStart hook          (was {name}-hook.sh)
//     hook.json          --settings payload               (was {name}-hook.json)
//     hook-output.json   name-only SessionStart output    (was {name}-hook-output.json)
//     hook-digest.json   memory-digest SessionStart output(was {name}-hook-digest.json)
//     statusline.sh      statusline script                (was {name}-statusline.sh)
//     append-prompt.md   Claude --append-system-prompt-file(was {name}-append-prompt.md)
//     instructions.md    Codex model_instructions_file    (was {name}-instructions.md)
//     ctx                statusline-written ctx numbers    (was {name}-ctx)
//     ctxwarn            high-context reminder text        (was {name}-ctxwarn)
//     ctxwarn.sh         ctxwarn drain hook                (was {name}-ctxwarn.sh)
//     attn.jsonl         Notification-hook attention tail  (was {name}-attn.jsonl)
//     attn.sh            attention append hook             (was {name}-attn.sh)
//     acks               memory-mutation ack queue         (was {name}-acks)
//     acks.sh            ack drain hook                    (was {name}-acks.sh)
//     pending.sh         parked-DM drain hook              (was {name}-pending.sh)
//
// 18 per-agent artifacts. SHARED dirs stay at the ~/.clodex ROOT and never
// move: messages/ (HARD — --add-dir scope + IPC_PROMPT teaching + historical
// spill pointers), pending/ (parked DMs — pending.sh RELOCATES but its BODY
// still targets ~/.clodex/pending/<name>/), agents/, skills/, library/,
// clodex.log, wire-shadow.jsonl (global wire log), codex-session-hook.sh (the
// one shared Codex hook, routed by $WB_WRAP_NAME).
//
// BASH-MIRRORED GRAMMAR. Two generated scripts resolve the agent name at
// RUNTIME ($WB_WRAP_NAME / $NAME) and so must rebuild these paths in bash — the
// module can't be required from a shell script. Those sites carry a cross-ref
// comment; the byte-pinned hook test enforces the mirror mechanically:
//   - cli-hooks.js setupCodexHook  (LINK / OUTPUT: run/$NAME/{transcript.jsonl,hook-output.json})
//   - statusline.js is JS-interpolated (name known at generation) so it uses
//     pathFor directly — no runtime bash mirror needed.
// If the grammar below changes, update the Codex hook template in cli-hooks.js.

const path = require('path');

// kind → the unsuffixed basename inside run/<name>/.
const KINDS = {
  transcript: 'transcript.jsonl',
  registry: 'agent.json',
  socket: 'agent.sock',
  hook: 'hook.sh',
  settings: 'hook.json',
  hookOutput: 'hook-output.json',
  hookDigest: 'hook-digest.json',
  statusline: 'statusline.sh',
  appendPrompt: 'append-prompt.md',
  instructions: 'instructions.md',
  ctx: 'ctx',
  ctxwarn: 'ctxwarn',
  ctxwarnScript: 'ctxwarn.sh',
  attn: 'attn.jsonl',
  attnScript: 'attn.sh',
  acks: 'acks',
  acksScript: 'acks.sh',
  pendingScript: 'pending.sh',
};

// The OLD flat-grammar suffixes, per kind — what the one-time legacy sweep
// deletes as `{name}{suffix}` at the ~/.clodex root. Name-DRIVEN: the sweep
// only ever builds `{knownName}{suffix}`, never parses arbitrary filenames, so
// the shared collisions (wire-shadow.jsonl, codex-session-hook.sh) can never be
// misattributed to an agent.
const LEGACY_SUFFIXES = {
  transcript: '.jsonl',
  registry: '.json',
  socket: '.sock',
  hook: '-hook.sh',
  settings: '-hook.json',
  hookOutput: '-hook-output.json',
  hookDigest: '-hook-digest.json',
  statusline: '-statusline.sh',
  appendPrompt: '-append-prompt.md',
  instructions: '-instructions.md',
  ctx: '-ctx',
  ctxwarn: '-ctxwarn',
  ctxwarnScript: '-ctxwarn.sh',
  attn: '-attn.jsonl',
  attnScript: '-attn.sh',
  acks: '-acks',
  acksScript: '-acks.sh',
  pendingScript: '-pending.sh',
};

// The per-agent runtime dir: ~/.clodex/run/<name>/.
function runDirFor(root, name) {
  return path.join(root, 'run', name);
}

// The absolute path to one per-agent artifact. Throws on an unknown kind so a
// typo fails loud at the call site rather than minting a stray file.
function pathFor(root, name, kind) {
  const base = KINDS[kind];
  if (!base) throw new Error(`clodex-paths: unknown kind '${kind}'`);
  return path.join(runDirFor(root, name), base);
}

// Every legacy flat path for one name, for the one-time sweep. Order-stable.
function legacyPathsFor(root, name) {
  return Object.values(LEGACY_SUFFIXES).map((suffix) => path.join(root, `${name}${suffix}`));
}

// The suffix set the orphan pass uses to recognize a stray root-level flat file
// (log-only). Returned longest-first so a reverse match prefers `-hook.sh` over
// a bare `.sh`-less form when deriving the would-be owner name.
function legacySuffixes() {
  return Object.values(LEGACY_SUFFIXES).slice().sort((a, b) => b.length - a.length);
}

module.exports = { KINDS, LEGACY_SUFFIXES, runDirFor, pathFor, legacyPathsFor, legacySuffixes };
