// notice-queue.js — a per-session queue of one-off advisories, drained into the
// next prompt by the UserPromptSubmit hook.
//
// Why this exists: a session's system prompt is frozen at spawn
// (ipc-prompt-cache.js), so anything a resumed conversation needs to be told
// AFTER it started has to arrive as conversation content. The prompt delta
// already carries changes to the prompt BYTES. This carries everything else —
// facts about the world the conversation was not born knowing. Producers
// append; the drain pops the lot.
//
// NOT THE SAME RELIABILITY TIER AS THE PROMPT DELTA, and the two must not be
// merged into one mechanism. The delta is AT-LEAST-ONCE: dropping one means an
// agent emitting a verb that no longer exists, which is why stageDelta never
// advances notified.md and the drain advances it only after emitting. This
// queue is AT-MOST-ONCE — claim by rename, consume on read, same as the
// `selection` drain in cli-hooks.js. Dropping a notice is a shrug. A refactor
// that unifies them to share a drain silently downgrades the delta to this
// tier, which is the one change here that cannot be noticed from the outside.
//
// WHERE THE FILE LIVES, and why not under run/<name>/. cleanupClaudeHook rm
// -rf's that dir and _cleanup calls it on EVERY exit path, so a notice enqueued
// at shutdown would be deleted by the exit immediately preceding the resume it
// exists to serve. So this mirrors promptcache/ and pending/ exactly: the DATA
// sits at ~/.clodex/notices/<name>/queue.jsonl, only the drain SCRIPT is
// per-run. clodex-paths.js's header carries the same list.
//
// The cost of sitting outside run/<name>/ is that nothing sweeps this dir: a
// drain killed between its claim rename and its unlink leaves a
// queue.jsonl.<pid> that the run-dir rm -rf would have collected for the
// identical `selection` residue, and legacy-sweep.js is marker-gated and never
// looks here. clearNotices removes the whole dir rather than the queue file so
// a conversation boundary collects it; short of that it is inert and tiny.
//
// Pure fs + string helpers, dependency-free (no electron), like ctx-reminder.js
// and ipc-prompt-cache.js, so the decision is unit-testable without a live CLI.

'use strict';

const fs = require('fs');
const path = require('path');

// TWO CAPS, and they are enforced at opposite ends because they answer
// different questions.
//
// DEPTH is the producer's, checked on append: a seat that is respawned over and
// over without ever taking a prompt would otherwise accrete a line per spawn
// with nothing ever reading them. Oldest goes, because a notice queue that
// dropped the NEWEST would discard the only entry still describing the world
// the agent is about to wake into. 20 is roughly a screen of one-liners — large
// enough that no real run of un-drained spawns hits it, small enough that
// hitting it costs a few hundred tokens rather than a context.
//
// AGE is the drain's, checked on read, and it cannot be the producer's: the
// queue's whole purpose is to sit unread until a resume, so at append time
// nothing is stale and at read time the producer is long gone. Two weeks
// because a notice is only worth delivering while it still describes the step
// the agent missed — a seat dormant across a fortnight of releases is better
// told nothing than told about the third-to-last one, and the current producer
// re-enqueues a correct line at that resume anyway.
const NOTICE_MAX_DEPTH = 20;
const NOTICE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function noticeDir(root, name) { return path.join(root, 'notices', name); }
function noticePath(root, name) { return path.join(noticeDir(root, name), 'queue.jsonl'); }

// Line-delimited, appended: two producers between one pair of submits both
// land. The file is a QUEUE, not a slot — the same reason `selection` is JSONL.
//
// Append-then-trim rather than read-modify-write: the append is the durable
// part and a crash before the trim leaves an over-long queue the drain still
// reads correctly, whereas a rewrite that tears loses entries outright.
function enqueueNotice(root, name, text, now = Date.now()) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return false;
  const dest = noticePath(root, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // The newline is what makes a torn concurrent append recoverable as a whole
  // number of lines; the drain skips whatever fragment is left over.
  fs.appendFileSync(dest, `${JSON.stringify({ text: body, at: now })}\n`, { mode: 0o600 });
  trimNotices(root, name);
  return true;
}

// Depth only. Age is the drain's, per the constants above.
//
// The inode check before the rename is what keeps a trim from RESURRECTING a
// delivered batch: the drain claims by renaming queue.jsonl away, so a trim
// that read 25 lines, then lost the file to a drain mid-write, would otherwise
// land its rewrite as a fresh queue.jsonl holding 20 notices that were just
// consumed — a duplicate delivery, i.e. this tier's one contract broken. It
// narrows the window rather than closing it (a drain landing between the stat
// and the rename still loses), which is why the rewrite goes through a tmp
// file: the failure that remains is at worst the same duplicate, never a torn
// queue. Closing it outright needs a lock, and the precondition is 21 undrained
// spawns under changed versions.
//
// UNTESTED, deliberately and not by oversight: this function is synchronous
// end to end, so there is no point at which a test can land a drain between
// the stat and the rename. Removing the check leaves every test green. Stated
// here rather than pinned by a test whose message would claim a guard it does
// not exercise.
function trimNotices(root, name) {
  const dest = noticePath(root, name);
  let lines;
  let ino;
  try {
    ino = fs.statSync(dest).ino;
    lines = fs.readFileSync(dest, 'utf8').split('\n').filter((l) => l.trim());
  } catch { return; }
  if (lines.length <= NOTICE_MAX_DEPTH) return;
  const kept = lines.slice(lines.length - NOTICE_MAX_DEPTH);
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
    if (fs.statSync(dest).ino !== ino) throw new Error('claimed');
    fs.renameSync(tmp, dest);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

// Boundary side, and the mirror of bakePrompt's clearCache calls: a genuine
// conversation boundary must not inherit the previous occupant's undrained
// notices. The producer already refuses to enqueue for a mint ("the adopted
// record is a stranger's"), but that guard sits on the PRODUCER while the
// leftover sits on the CONSUMER — without this, a mint of a name whose dead
// namesake enqueued and died before its first submit is still handed that
// notice. Removing the whole dir rather than the queue file also sweeps any
// `queue.jsonl.<pid>` claim orphaned by a drain killed mid-consume; nothing
// else ever visits this path (it is at the shared root, so the run-dir rm -rf
// that sweeps `selection`'s identical residue does not reach it).
function clearNotices(root, name) {
  try { fs.rmSync(noticeDir(root, name), { recursive: true, force: true }); } catch {}
}

// The queue as it sits on disk, oldest first. PARSING ONLY, deliberately: the
// horizon is NOT applied here. The generated drain (cli-hooks.js) is the one
// process that reads this queue for delivery, and a second copy of the
// drop-if-stale rule on this side would be a policy that can drift from the one
// that actually runs while every test using it still passes. A corrupt line is
// skipped, never fatal: one bad append must not cost the notices around it.
//
// Inspection surface with no production caller, deliberately kept: the drain is
// a shell script, so without a reader on this side the queue's own bank has no
// way to assert what an append actually wrote.
function parseNotices(root, name) {
  let raw;
  try { raw = fs.readFileSync(noticePath(root, name), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj.text !== 'string' || !obj.text) continue;
    out.push(obj);
  }
  return out;
}

// --- first producer: the app version this conversation was born under -------
//
// The queue is the feature; this is the first thing put on it. The gap it
// covers: ipc-prompt-cache delivers a diff when the prompt BYTES change, and
// does nothing when the app changes underneath a conversation and the prompt
// does not — which is most releases. An unchanged verb whose SEMANTICS changed
// is still accepted, wrongly, and nothing else in the system says so.
//
// ONE FACTUAL LINE, deliberately. DELTA_HEADER's comment is binding here too:
// a prose renderer drifts from the bytes it describes. Rendering CHANGELOG.md
// into this would be worse than useless — the changelog is written for people
// running Clodex, not for a seat auditing its own grammar, and it is exactly
// the "friendlier rendering an agent reads past" that header rejects. State the
// fact; the agent can ask.
//
// `lastVersion` is the version of this conversation's PREVIOUS spawn, not the
// one it was originally born under, and the wording says so. The producer
// advances the recorded version on every spawn, so the comparison is
// EDGE-triggered: without the advance, every resume of a conversation older
// than the host would re-enqueue the same line forever. The cost of the advance
// is that a dropped notice is gone (this queue is at-most-once by design), and
// the cost of naming the birth version instead would be a claim that goes false
// at the second upgrade.
function versionNoticeFor(lastVersion, hostVersion) {
  const last = String(lastVersion == null ? '' : lastVersion).trim();
  const host = String(hostVersion == null ? '' : hostVersion).trim();
  if (!last || !host || last === host) return null;
  return '<system-reminder>'
    + `Clodex was upgraded underneath this conversation: it was last running under ${last}, and the host now running it is ${host}. `
    + 'Your system prompt still shows the text you were spawned with (rewriting it mid-conversation would re-bill your entire context), '
    + 'and a capability can change without its name changing — an intent you know may now take different arguments, and one added since '
    + `${last} is absent from your prompt entirely. Where behaviour surprises you, the running host is authoritative over your prompt.`
    + '</system-reminder>';
}

module.exports = {
  NOTICE_MAX_DEPTH, NOTICE_MAX_AGE_MS,
  noticeDir, noticePath,
  enqueueNotice, trimNotices, parseNotices, clearNotices,
  versionNoticeFor,
};
