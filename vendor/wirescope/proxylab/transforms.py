import collections
import hashlib
import json
import os
import re
import time

from proxylab import store as store_mod
from proxylab import warmth as warmth_mod
from proxylab import writer as writer_mod

# --- MASTER PASSTHROUGH (A/B CONTROL ARM) ------------------------------------
# WIRESCOPE_PASSTHROUGH=1 turns this proxy into a provably byte-verbatim
# forwarder: the server skips the ENTIRE request-mutation chain (inject /
# shortcircuit / relocate / strip / wirescope omit+tools+hint / sort /
# compact-strip / hold-echo), so the forwarded bytes equal the received bytes.
# The RESPONSE side is covered too: _resp_mutating/_relay_active return False
# and the server's SHORTCIRCUIT local-answer path is skipped under this flag.
# Capture, billing, warmth-ledger and the subscriber feed still run (they read,
# never mutate). This is the CONTROL arm for measuring what wirescope's
# transforms actually buy vs a transparent logging proxy — one flag instead of
# a long list of per-feature 0s, so a new transform can't silently leak into
# the control. Read live (PEP 562 shim) so it can be flipped per process.
PASSTHROUGH = os.environ.get("WIRESCOPE_PASSTHROUGH", "") not in ("", "0", "false", "False")

# --- EXPERIMENTAL: payload injection (OFF by default; observer mode is default) -
# Two modes, both mutate the LAST user message of /v1/messages and forward the
# MODIFIED bytes (tail-only edit => the cached prefix still hits; we re-encode
# only when we actually change something):
#
#   1. UNCONDITIONAL (legacy): INJECT set -> append INJECT to every turn. The
#      original "piggyback" testbed (the 2+2 -> "and 3+3" probe).
#
#   2. MARKER-GATED (new): INJECT_MARKER set -> append INJECT_TEXT ONLY when the
#      user's prompt contains the marker substring (e.g. "Math:"). This lets the
#      HUMAN opt a turn into enhancement by typing a natural keyword, while
#      mundane turns pass through untouched. The injected text is phrased as a
#      natural continuation of the user's own message (NOT an "injection
#      protocol" banner) so the model complies without suspicion.
#
#      Env:
#        INJECT_MARKER  trigger substring, e.g. "Math:"  (case-sensitive)
#        INJECT_TEXT    what to append when the marker fires (default below)
#        INJECT_SEP     separator between original and injected text (default "\n\n")
INJECT = os.environ.get("INJECT")
INJECT_MARKER = os.environ.get("INJECT_MARKER")
# A natural-sounding second question; answer is 23*19 = 437 (easy to detect in
# the response, and clearly distinct from any plausible first-question answer).
_DEFAULT_INJECT_TEXT = "Also, what is 23 × 19?"
INJECT_TEXT = os.environ.get("INJECT_TEXT", _DEFAULT_INJECT_TEXT)
INJECT_SEP = os.environ.get("INJECT_SEP", "\n\n")

# "Volunteer context" mode: when INJECT_FILE points at a file, the proxy appends
# its CURRENT contents (read fresh from disk each turn) as an authoritative
# <system-reminder> on the last user message — the channel the model already
# trusts as ground truth. No marker, nothing for the agent to know about: it's
# the proxy proactively handing over context the agent would otherwise have to
# fetch with a Read tool call. The experiment then measures whether the agent
# skips its own Read (round trip collapsed) or fetches anyway (double ingestion).
INJECT_FILE = os.environ.get("INJECT_FILE")
_MAX_VOLUNTEER_BYTES = int(os.environ.get("INJECT_FILE_MAX_BYTES", "20000"))
# Optional operating instruction folded into the volunteered system-reminder.
# e.g. tell the agent it already has the exact bytes (so it needn't Read) and to
# apply changes via Bash/Write instead of Edit — routing AROUND FileEditTool's
# read-before-edit gate, which Bash/Write don't enforce. "Tools are just tools."
INJECT_FILE_NOTE = os.environ.get("INJECT_FILE_NOTE")

# --- RESPONSE-side mutation (experiment) --------------------------------------
# Everything above edits the REQUEST. This edits what comes BACK: can we alter
# what the model "said" before the CLI sees it, and does the client push back?
# The response is a streamed SSE; when either knob is set we buffer the full
# upstream response, rewrite it, and emit once (we lose streaming — fine for a
# test). Usage/billing is still parsed from the ORIGINAL bytes.
#   RESP_APPEND   — add a text_delta to the assistant's first text block.
#   RESP_REPLACE  — "old\x1fnew": swap text inside every text_delta.
RESP_APPEND = os.environ.get("RESP_APPEND")
RESP_REPLACE = os.environ.get("RESP_REPLACE")


def _resp_mutating():
    # PASSTHROUGH must silence the RESPONSE side too — a control arm with a
    # copied treatment env would otherwise still mutate what the client sees.
    return (not PASSTHROUGH) and bool(RESP_APPEND or RESP_REPLACE)

# --- SHORTCIRCUIT: elide the post-tool "wrap-up" round trip -------------------
# The Messages protocol forces a round trip after every tool_use: a response
# containing a tool_use always carries stop_reason "tool_use" (= "run this, I'll
# continue"), so even a SUCCESSFUL, TERMINAL edit still costs a whole extra turn
# just to hear the model say "Done." There is no way for the model to say "do
# this edit AND I'm finished" in one message — the protocol has no "last action"
# flag. That trailing turn re-ships the entire context (~one full cache_read
# carriage) to produce a ~20-token acknowledgment.
#
# We supply the missing affordance WITHOUT guessing: teach the model to mark a
# task-completing message with a sentinel (SHORTCIRCUIT_DONE, e.g. "<sc_done>") in
# the SAME message as its final tool call. Then, when the NEXT request is the
# tool_result continuation of a single SUCCESSFUL terminal tool_use whose
# assistant message carried the sentinel, the proxy SYNTHESIZES the end_turn
# response locally and NEVER forwards it upstream — saving that carriage. The
# terminality decision stays with the model (the only party that knows its plan);
# the proxy merely honors the signal the wire format can't otherwise carry.
#
# Safety: we refuse to short-circuit an ERROR tool_result (there the model must
# react), require exactly ONE tool_use of a known terminal tool, and require the
# result to be for THAT tool_use. Anything else falls through to a normal turn.
#   SHORTCIRCUIT_DONE   sentinel substring; its PRESENCE enables the mode
#   SHORTCIRCUIT_ACK    synthetic reply text (default "Done.")
#   SHORTCIRCUIT_TOOLS  comma-list of terminal tool names that may be elided
SHORTCIRCUIT_DONE = os.environ.get("SHORTCIRCUIT_DONE")
SHORTCIRCUIT_ACK = os.environ.get("SHORTCIRCUIT_ACK", "Done.")
# Default = the NATIVE authored-mutation tools only (their results are
# information-free: the model already knows the post-edit bytes, so the wrap-up is
# pure ceremony). To short-circuit a CUSTOM/MCP edit tool (e.g. the mutate-tool
# experiment's mcp__update__edit), opt it in explicitly:
#   SHORTCIRCUIT_TOOLS="Edit,Write,NotebookEdit,MultiEdit,mcp__update__edit"
# Don't bake experiment-specific names into the default — the syspatch prompt
# ENUMERATES this set into every session's system prompt, so stray names would
# reference tools not present in tools[].
SHORTCIRCUIT_TOOLS = set(filter(None, (os.environ.get(
    "SHORTCIRCUIT_TOOLS",
    "Edit,Write,NotebookEdit,MultiEdit"
).split(","))))

# RELAY mode: instead of a canned "Done.", the model pre-writes (in the SAME
# message as its terminal Edit) the summary it WOULD give after success. This is
# exact, not a guess: for an authored mutation like Edit the success result is
# information-free — it only confirms old_string matched; the model already knows
# the post-edit file byte-for-byte. We stash that prose keyed by tool_use_id at
# the edit turn AND blank it from the stream (so the success message isn't shown
# before the edit is confirmed), then REPLAY it as the synthetic wrap-up — but
# ONLY on a SUCCESS tool_result; on error we discard it and forward normally.
# This also lets us STRIP the sentinel cleanly (detection moves from "read it out
# of replayed history" to "match the tool_use_id we stashed"), so nothing leaks
# to the user. SHORTCIRCUIT_RELAY=1 enables it; without it we use SHORTCIRCUIT_ACK.
SHORTCIRCUIT_RELAY = os.environ.get("SHORTCIRCUIT_RELAY")
_PENDING_RELAY = collections.OrderedDict()   # tool_use_id -> pre-written prose
_PENDING_RELAY_CAP = 256

# IDEMPOTENCY GUARD for canned-ack SC. The gate is otherwise STATELESS: it
# re-evaluates history every request, so if the headless CLI ever RE-SENDS a
# continuation (it occasionally rejects/retries a synthetic end_turn in a long
# resumed session), a stateless gate would re-fire forever -> infinite loop
# (observed: 10x re-fire on one tf-build turn). We fire AT MOST ONCE per set of
# tool_use_ids; a re-send finds them already fired and falls through to a real
# upstream wrap-up (one extra turn, worst case — same bounded cost the relay
# path gets from its pop). Caps the blast radius of any CLI retry to 1, not N.
_SC_FIRED = collections.OrderedDict()         # frozenset(tool_use_ids) -> True
_SC_FIRED_CAP = 512


def _relay_active():
    # Gated off under PASSTHROUGH (same reason as _resp_mutating).
    return (not PASSTHROUGH) and bool(SHORTCIRCUIT_DONE and SHORTCIRCUIT_RELAY)


# STANDING PROTOCOL INSTRUCTION (UX): so the user types a NORMAL prompt and never
# sees the protocol. When set, the proxy tail-appends this to the last user
# message on genuine prompt turns (cache-safe; skipped on tool_result hops). This
# is the "client bakes it in" simulation — a real client would ship it in the
# system prompt / tool descriptions. SHORTCIRCUIT_INSTRUCT=1 uses the default
# below (sentinel kept in sync with SHORTCIRCUIT_DONE); or set custom text.
_DEFAULT_SC_INSTRUCT = (
    "Efficiency protocol: do NOT spend a separate follow-up message just to "
    "report that your final tool call succeeded. Instead, in the SAME message as "
    "your final tool call this turn, FIRST write the after-the-fact summary you "
    "would normally give once it succeeds — say what you changed, in your own "
    "words and in the past tense (e.g. \"Added ...\") — then end that text with "
    f"the token {SHORTCIRCUIT_DONE or '<sc_done>'}. Assume the tool call will "
    "succeed; do not wait for its result to write the summary.")
_sc_instruct_env = os.environ.get("SHORTCIRCUIT_INSTRUCT")
SHORTCIRCUIT_INSTRUCT = (_DEFAULT_SC_INSTRUCT
                         if _sc_instruct_env in ("1", "default", "yes", "on")
                         else _sc_instruct_env)

# BEST-PLACEMENT delivery: patch the TERMINAL TOOLS' own descriptions in the
# request's tools[]. A tool description is a prompt the client ships in the
# cached prefix; appending the protocol THERE binds it to the exact action and is
# read precisely when the model chooses to use the tool — the most authoritative
# spot for a wavering model. Cache-stable (same text every turn → re-caches once).
# SHORTCIRCUIT_TOOLPATCH=1 uses the default below; or set custom text.
# NOTE: phrasing is DISPATCH-IMPERATIVE, modeled on the CLI's own
# getPreReadInstruction ("- You must use your `Read` tool ... before editing.") —
# an unconditional precondition bullet the model reliably obeys. The earlier
# default used POST-CONDITIONAL phrasing ("when a call to this tool completes …")
# which the signal-timing finding showed makes the model DEFER the sentinel to the
# wrap-up turn. This version frames the summary as a same-message output rule, not
# a reaction to the tool returning.
_DEFAULT_SC_TOOLPATCH = (
    "\n- Whenever you use this tool, you MUST, in the SAME message as the tool "
    "call, also write a one-line past-tense summary of the change you are making "
    "(e.g. \"Added ...\") and end that text with the token "
    f"{SHORTCIRCUIT_DONE or '<sc_done>'}. Write this summary now, as you make the "
    "call; do NOT wait for the tool's result and do NOT put it in a later "
    "message. Assume the call will succeed.")
_sc_toolpatch_env = os.environ.get("SHORTCIRCUIT_TOOLPATCH")
SHORTCIRCUIT_TOOLPATCH = (_DEFAULT_SC_TOOLPATCH
                          if _sc_toolpatch_env in ("1", "default", "yes", "on")
                          else _sc_toolpatch_env)


# SYSTEM-PROMPT delivery: append the protocol to the system block, enumerating
# the terminal tools it applies to. The point (per the cache thesis): inject the
# SAME text in the SAME position every turn so it joins the cached prefix — one
# cold write, then `cache_read` forever, like all the other re-shipped carriage.
# Front-of-prefix and INVISIBLE to the user (unlike INSTRUCT, which pollutes the
# visible user msg). Open question it tests: does a STANDING system rule fire the
# same-message behavior, or defer like the tool description? SHORTCIRCUIT_SYSPATCH=1
# uses the default below; or set custom text.
_sc_done_tok = SHORTCIRCUIT_DONE or '<sc_done>'
_DEFAULT_SC_SYSPATCH = (
    "\n\nOUTPUT RULE for the tools " + ", ".join(sorted(SHORTCIRCUIT_TOOLS)) + ": "
    "every time you call one of these tools, the SAME assistant message MUST ALSO "
    "contain a text block with a one-line PAST-TENSE summary of the change you are "
    f"making, ending with the token {_sc_done_tok}. Write that text block in the "
    "same message as the tool call. NEVER send one of these tool calls in a message "
    "by itself, and NEVER put the summary in a later message. Do NOT wait for the "
    "tool result before writing it: these tools return only success or failure, "
    "which tells you nothing you don't already know, and a failure will surface as "
    "an error you can handle on your next turn. Do NOT write forward-looking "
    "narration like \"I'll add...\" or \"Now writing...\"; write ONLY the past-tense "
    "summary as if the change is already done, then make the call in the same "
    "message. Assume the call succeeds.\n"
    "Example of a correct assistant message (text block + tool call together):\n"
    f"  text: \"Added a module-level docstring to sample.py. {_sc_done_tok}\"\n"
    "  tool_use: Edit(file_path=\"sample.py\", ...)")
_sc_syspatch_env = os.environ.get("SHORTCIRCUIT_SYSPATCH")
SHORTCIRCUIT_SYSPATCH = (_DEFAULT_SC_SYSPATCH
                         if _sc_syspatch_env in ("1", "default", "yes", "on")
                         else _sc_syspatch_env)


def _patch_system(obj):
    """Append the shortcircuit protocol to the system prompt in a STABLE position
    (the last text block / end of the string), so it's identical every turn and
    rides the prefix cache (one cold write, then cache_read). Idempotent. Returns
    True if it patched."""
    if not SHORTCIRCUIT_SYSPATCH:
        return False
    sys = obj.get("system")
    if isinstance(sys, list) and sys:
        # append to the LAST text block so we stay under its cache_control breakpoint
        for b in reversed(sys):
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                if SHORTCIRCUIT_SYSPATCH not in b["text"]:
                    b["text"] += SHORTCIRCUIT_SYSPATCH
                    return True
                return False
        return False
    if isinstance(sys, str):
        if SHORTCIRCUIT_SYSPATCH not in sys:
            obj["system"] = sys + SHORTCIRCUIT_SYSPATCH
            return True
    return False


# ---- PROXY-SIDE `rest` SPLIT (experimental, off by default) ---------------
# Under org/proxy scope the CLI welds ALL static system prose + ALL dynamic
# `# Environment` (cwd/git/dirs/platform) into ONE cached block (sys[-1], the
# "rest" block). Any env change busts that block, so the ~2.9k-tok static prose
# is re-WRITTEN (1.25x/2x) every change instead of READ (0.10x). This relocates
# the static head (everything BEFORE `\n# Environment`) onto the END of the
# preceding MARKED preamble block (sys[-2], "You are Claude Code..."), so it
# rides a DURABLE, env-independent cache prefix. SAFE: the concatenated system
# TEXT the model sees is byte-IDENTICAL — only a cache_control boundary moves
# (no reorder, no behavioural change, breakpoint count unchanged). FRAGILE: the
# split point is the `# Environment` header heuristic — version-pin + monitor
# hit-rate per CLI bump. Fleet-local (non-vanilla layout shares only with our
# own proxied sessions). DON'T touch block0 (attribution).
SPLIT_SYSTEM_REST = os.environ.get("SPLIT_SYSTEM_REST") in ("1", "yes", "on", "true")
_REST_SPLIT_MARKER = os.environ.get("SPLIT_SYSTEM_REST_MARKER", "\n# Environment")


def _split_system_rest(obj):
    """Move the static prose at the head of the env-bearing `rest` block onto the
    end of the preceding marked block. Byte-identical model-visible text; only a
    cache boundary shifts. Idempotent (once split, the marker sits at offset 0 of
    the rest block → no-op). Returns a log dict, or None if it didn't apply."""
    if not SPLIT_SYSTEM_REST:
        return None
    sys = obj.get("system")
    if not isinstance(sys, list) or len(sys) < 2:
        return None
    # the `rest` block is the one carrying the env header; host = the block before
    ri = next((i for i, b in enumerate(sys)
               if isinstance(b, dict) and isinstance(b.get("text"), str)
               and _REST_SPLIT_MARKER in b["text"]), None)
    if not ri:  # None, or 0 (no preceding block to host the static prose)
        return None
    rest, prev = sys[ri], sys[ri - 1]
    pt = prev.get("text")
    rt = rest["text"]
    if not isinstance(pt, str):
        return None
    idx = rt.find(_REST_SPLIT_MARKER)
    if idx <= 0:                      # marker at very start → already split / nothing to move
        return None
    static = rt[:idx]
    prev["text"] = pt + static        # host block (keeps its cache_control marker)
    rest["text"] = rt[idx:]           # rest block now starts at "\n# Environment"
    return {"host_block": ri - 1, "rest_block": ri, "moved_chars": len(static),
            "static_tail": static[-48:], "dynamic_head": rest["text"][:48]}


# ---- DESIGN-2: relocate volatile bits to the tail + mark CLAUDE.md (experimental)
# The CLI assembles a per-request context bundle in messages[0] (the <system-reminder>
# wrapping the on-disk CLAUDE.md, plus CLI-injected # userEmail / # currentDate) and
# ships the volatile `# Environment` block (cwd/git-branch/commits) in `system`. Because
# the cache prefix is cumulative (tools -> system -> messages), env sits UPSTREAM of
# CLAUDE.md and POISONS it: a branch/commit/worktree change re-WRITES the (often large)
# CLAUDE.md segment every session. This transform moves the volatile, header-
# delimited pieces (`# Environment`, `# Scratchpad Directory` — a per-session UUID
# path, see RELOCATE_SCRATCHPAD_TO_TAIL below — and `# currentDate`) DOWN to a tail
# block right before the prompt, and gives the now-static CLAUDE.md bundle its OWN cache_control marker
# (the 4th breakpoint). Resulting layering:
#   M1 tools+preamble+static | M2 contextmgmt+append | M4 CLAUDE.md | M3 env+date+prompt
# so CLAUDE.md becomes an env-independent, project-shared cache segment.
# MODEL-VISIBLE (env now reads AFTER the project rules) -> behaviorally validate; this is
# NOT byte-identical like the rest-split. RELOCATE_CLAUDEMD_PATHSTAMP also strips the
# absolute "Contents of <path>/CLAUDE.md" stamp (cwd already lives in the relocated env)
# so the segment shares across WORKTREES too — that's dedupe, not forging a false path.
# ON BY DEFAULT (disable with RELOCATE_ENV_TO_TAIL=0 / RELOCATE_CLAUDEMD_PATHSTAMP=0).
# GENERALIZED: also fires when there is NO CLAUDE.md — it falls back to the
# userEmail/currentDate <system-reminder> bundle as the anchor, so env still leaves
# `system` (the big win: static system prefix becomes env-independent/shareable). A
# dedicated cache marker is only added for the LARGE claudeMd segment; without it we
# just relocate env and spend no extra marker. The injected marker mirrors the
# prevailing ttl (1h/5m) — a bare 5m marker before the CLI's 1h markers is a hard 400.
RELOCATE_ENV_TO_TAIL = os.environ.get("RELOCATE_ENV_TO_TAIL", "1") not in ("0", "no", "off", "false")
RELOCATE_CLAUDEMD_PATHSTAMP = os.environ.get("RELOCATE_CLAUDEMD_PATHSTAMP", "1") not in ("0", "no", "off", "false")
# `# Scratchpad Directory` (CLI ≥ ~2026-07) embeds a per-session UUID path MID-WAY
# through the big agent-prompt block (between `# Communicating with the user` and
# `# Context management`) — every fresh/cleared instance rotates the UUID and busts
# the whole block from that point. Same disease as `# Environment`, same cure: peel
# the section (header → next `\n# ` header) down to the relocated tail.
RELOCATE_SCRATCHPAD_TO_TAIL = os.environ.get("RELOCATE_SCRATCHPAD_TO_TAIL", "1") not in ("0", "no", "off", "false")
# The volatile date line rolls over at midnight → a byte change inside the cached
# claudeMd bundle → the whole message prefix busts on the next resume/turn that
# crosses midnight (measured live: read 26.6k / write 163.2k). Relocating it to a
# tail reminder does NOT help — the tail sits UPSTREAM of the last-message cache
# marker, so the history still busts. STRIP it out of the prefix entirely so the
# static bundle is date-independent (zero midnight bust); agents can infer the
# date without a hardcoded line. Set STRIP_CURRENT_DATE=0 to fall back to the old
# relocate-to-tail behavior (keeps the date visible, but only shields the bundle,
# not the history, from a midnight rollover).
STRIP_CURRENT_DATE = os.environ.get("STRIP_CURRENT_DATE", "1") not in ("0", "no", "off", "false")
_ENV_SECTION_HDR = "\n# Environment"
_SCRATCHPAD_SECTION_HDR = "\n# Scratchpad Directory"
_DATE_SECTION_HDR = "# currentDate"
# Match ONLY the GENUINE currentDate section: a column-0 `# currentDate` header
# line immediately followed by the `Today's date is …` line. Plain substring
# matching (`ct.find("# currentDate")`) mis-fires on CLAUDE.md PROSE that mentions
# `# currentDate` in backticks (this repo's own flag table does exactly that) —
# it hits an earlier, wrong occurrence, and because a markdown table row has no
# blank-line terminator it then sweeps ~18k chars into the tail while the REAL
# date section survives in the cached bundle and busts it at midnight. The `(?m)^`
# anchor requires the header at column 0, so a backtick-wrapped mid-line mention
# never matches.
_CURRENT_DATE_RE = re.compile(r"(?m)^# currentDate[ \t]*\r?\n(?:Today's date is[^\n]*\r?\n?)?")
_PATHSTAMP_RE = re.compile(r"Contents of /[^\n]*?CLAUDE\.md")


def _find_context_bundle(msgs):
    """(msg_index, block_index, block, has_claudemd) of the CLI's context bundle —
    a user text block carrying the <system-reminder> preamble. Prefers the block
    containing '# claudeMd' (the big static project segment); falls back to one
    with '# currentDate'/'# userEmail' so env-relocation ALSO works in repos with
    NO CLAUDE.md. (None, None, None, False) if no bundle block exists."""
    fallback = None
    for mi, m in enumerate(msgs):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if not isinstance(c, list):
            continue
        for bi, b in enumerate(c):
            if not (isinstance(b, dict) and b.get("type") == "text"):
                continue
            t = b.get("text") or ""
            if "# claudeMd" in t:
                return mi, bi, b, True
            if fallback is None and ("# currentDate" in t or "# userEmail" in t):
                fallback = (mi, bi, b, False)
    return fallback if fallback else (None, None, None, False)


def _relocate_env_to_tail(obj):
    """Design-2 transform (see comment above). Returns a log dict, or None if it didn't
    apply (no CLAUDE.md bundle to protect / nothing volatile to move)."""
    if not RELOCATE_ENV_TO_TAIL:
        return None
    sysb = obj.get("system")
    msgs = obj.get("messages")
    if not isinstance(sysb, list) or not isinstance(msgs, list) or not msgs:
        return None
    mi, bi, cmd, has_claudemd = _find_context_bundle(msgs)
    if cmd is None:
        return None                          # no bundle block to anchor / pull date from
    moved = []

    def _peel_system_section(hdr):
        """Cut a header-delimited section (hdr → next top-level `\n# ` header) out of
        whichever system block carries it. Returns the section text ('' if absent)."""
        blk = next((b for b in sysb if isinstance(b, dict)
                    and isinstance(b.get("text"), str)
                    and hdr in b["text"]), None)
        if blk is None:
            return ""
        bt = blk["text"]
        i = bt.find(hdr)
        j = bt.find("\n# ", i + len(hdr))
        blk["text"] = bt[:i] + (bt[j:] if j != -1 else "")
        return (bt[i:j] if j != -1 else bt[i:]).strip()

    # 1) pull the `# Environment` section out of whichever system block carries it
    moved_env = _peel_system_section(_ENV_SECTION_HDR)
    if moved_env:
        moved.append("# Environment")
    # 1b) same for the per-session-UUID `# Scratchpad Directory` section
    moved_scratch = ""
    if RELOCATE_SCRATCHPAD_TO_TAIL:
        moved_scratch = _peel_system_section(_SCRATCHPAD_SECTION_HDR)
        if moved_scratch:
            moved.append("# Scratchpad Directory")
    # 2) handle the volatile `# currentDate` block in the claudeMd bundle (keep
    #    # userEmail). Match ONLY the genuine section (column-0 header + the
    #    `Today's date is …` line) — never a backtick prose mention in CLAUDE.md.
    #    STRIP_CURRENT_DATE (default) removes it from the cached prefix entirely;
    #    else fall back to relocating it into the tail reminder.
    ct = cmd["text"]
    moved_date = ""
    stripped_date = False
    m_date = _CURRENT_DATE_RE.search(ct)
    if m_date:
        cmd["text"] = ct[:m_date.start()].rstrip("\n") + "\n" + ct[m_date.end():].lstrip("\n")
        if STRIP_CURRENT_DATE:
            stripped_date = True                 # dropped from the prefix, not relocated
        else:
            moved_date = m_date.group(0).strip()  # legacy: relocate to the tail
        moved.append("# currentDate")
    # 2b) optional: dedupe the worktree-volatile absolute path stamp (only the
    #     claudeMd bundle carries a "Contents of <abspath>/CLAUDE.md" stamp)
    if RELOCATE_CLAUDEMD_PATHSTAMP and has_claudemd:
        new, n = _PATHSTAMP_RE.subn("Contents of CLAUDE.md", cmd["text"])
        if n:
            cmd["text"] = new
            moved.append("pathstamp")
    pieces = [p for p in (moved_env, moved_scratch, moved_date) if p]
    if not pieces and not stripped_date:
        return None
    # 3) assemble the relocated tail (if anything to relocate) and insert it right
    #    AFTER the bundle block (between the bundle and the prompt marker). A pure
    #    date STRIP relocates nothing — it just left the prefix date-independent —
    #    so there may be no tail to insert; still fall through to add the bundle's
    #    own cache marker below (the strip reshaped the bundle worth protecting).
    tail = None
    if pieces:
        tail = "<system-reminder>\n" + "\n\n".join(pieces) + "\n</system-reminder>"
        msgs[mi]["content"].insert(bi + 1, {"type": "text", "text": tail})
    # 4) give the bundle its OWN cache_control breakpoint ONLY when it's the large
    #    static CLAUDE.md segment worth protecting as a shareable unit. For a tiny
    #    userEmail-only bundle (no CLAUDE.md) a marker buys nothing and would just
    #    spend our 4-marker budget — skip it; the win there is purely env leaving
    #    `system` (now fully static/shareable). When we DO mark, it MUST mirror the
    #    prevailing ttl: cache order is tools->system->messages and the API forbids
    #    a ttl='1h' block AFTER a ttl='5m' one, so a bare {ephemeral}=5m marker here
    #    sitting before the CLI's 1h prompt/system markers -> 400. Copy the ttl from
    #    the nearest preceding (last system) marker.
    #    BUDGET-AWARE (the vendored-clodex 5-marker 400, 2026-07-19): the org-route
    #    CLI can legitimately ship 4 markers of its own (2 sys + 2 msg, or a tools
    #    marker) — blindly stamping a 5th is a hard API reject. At full budget,
    #    MIGRATE the earliest non-tail client MESSAGE marker onto the bundle
    #    (placement metadata — moving it earlier only narrows a boundary, never
    #    busts; pin re-anchors the settled region later in the chain anyway).
    #    No such donor -> skip the marker (the relocation itself is still the win).
    #    Never steal a system marker (cross-instance share anchors) or the
    #    rolling tail (live-loop chaining).
    claudemd_ttl = None
    bundle_marker = None
    if has_claudemd:
        if cmd.get("cache_control"):
            bundle_marker = "already_marked"
        else:
            markers = _cache_markers(obj)
            if len(markers) < _CACHE_BREAKPOINT_BUDGET:
                cc = {"type": "ephemeral"}
                last_sys_ttl = next((b["cache_control"].get("ttl")
                                     for b in reversed(sysb)
                                     if isinstance(b, dict) and isinstance(b.get("cache_control"), dict)
                                     and b["cache_control"].get("ttl")), None)
                if last_sys_ttl:
                    cc["ttl"] = last_sys_ttl
                cmd["cache_control"] = cc
                bundle_marker = "added"
            else:
                last_mi = len(msgs) - 1
                donor = next(((r, i, b) for r, i, b in markers
                              if r == "messages" and i != last_mi and b is not cmd),
                             None)
                if donor is not None:
                    cmd["cache_control"] = donor[2].pop("cache_control")
                    bundle_marker = "migrated"
                else:
                    bundle_marker = "skipped_budget_full"
        cc_now = cmd.get("cache_control")
        claudemd_ttl = cc_now.get("ttl") if isinstance(cc_now, dict) else None
    return {"moved": moved, "stripped_date": stripped_date, "has_claudemd": has_claudemd,
            "tail_chars": len(tail) if tail else 0, "bundle_marker": bundle_marker,
            "bundle_chars_after": len(cmd["text"]), "claudemd_ttl": claudemd_ttl}


# ---- SYSTEM-SECTION STRIP (experimental, off by default) ------------------
# Remove whole top-level `# Heading` sections from the system prompt by header.
# Unlike the rest-split (byte-identical, cache-only), this DELETES model-visible
# text — pure carriage reduction at the cost of dropping that instruction from
# the model's context. Use only for sections that are demonstrably irrelevant to
# the workload (e.g. `# Session-specific guidance` ultrareview prose ~520 chars).
# A section runs from its header line to the next column-0 `# ` header (or end of
# block). MODEL-VISIBLE + busts the system prefix once (the block's bytes change),
# then stable. ON BY DEFAULT, stripping the irrelevant `# Session-specific guidance`
# (ultrareview) prose. Config: STRIP_SYSTEM_SECTIONS = headers separated by `\x1f`.
#   - unset      -> default (strip `# Session-specific guidance`)
#   - custom     -> STRIP_SYSTEM_SECTIONS='# Foo\x1f# Bar'
#   - DISABLE    -> STRIP_SYSTEM_SECTIONS='' (empty)
_strip_env = os.environ.get("STRIP_SYSTEM_SECTIONS")
if _strip_env is None:
    _strip_env = "# Session-specific guidance"        # default-on
STRIP_SYSTEM_SECTIONS = [h for h in _strip_env.split("\x1f") if h.strip()]


def _strip_section_from_text(text, hdr):
    """Remove the `hdr` top-level section from text. Returns (new_text, chars_removed)."""
    m = re.search(r"(?m)^[ \t]*" + re.escape(hdr) + r"[ \t]*$", text)
    if not m:
        return text, 0
    start = m.start()
    nxt = re.search(r"(?m)^# ", text[m.end():])
    end = m.end() + nxt.start() if nxt else len(text)
    new = text[:start] + text[end:]
    # collapse a seam of 3+ newlines left behind to a single blank line
    new = re.sub(r"\n{3,}", "\n\n", new)
    return new, end - start


def _strip_system_sections(obj):
    """Delete configured `# Heading` sections from system text blocks. Returns a
    log dict, or None if nothing matched. Idempotent (gone → no further match)."""
    if not STRIP_SYSTEM_SECTIONS:
        return None
    sys = obj.get("system")
    removed = []
    if isinstance(sys, list):
        for bi, b in enumerate(sys):
            if not (isinstance(b, dict) and isinstance(b.get("text"), str)):
                continue
            for hdr in STRIP_SYSTEM_SECTIONS:
                new, n = _strip_section_from_text(b["text"], hdr)
                if n:
                    b["text"] = new
                    removed.append({"block": bi, "header": hdr, "chars": n})
    elif isinstance(sys, str):
        for hdr in STRIP_SYSTEM_SECTIONS:
            new, n = _strip_section_from_text(sys, hdr)
            if n:
                sys = new
                removed.append({"block": 0, "header": hdr, "chars": n})
        obj["system"] = sys
    return {"removed": removed} if removed else None


# ---- TASK-REMINDER STRIP (rides the L2 strip level) ------------------------
# The CLI nags "The task tools haven't been used recently..." (~421 ch ≈ 105
# tok) every few tool-heavy turns, and each nag lands in settled history — so
# they ACCRETE: a long clodex session carried 4+, re-shipped on every request,
# with zero Task* calls ever following (the nag only fires in sessions that
# don't use tasks). Skip the block entirely on encounter. Two wire shapes:
#   1. mid-conversation `role:"system"` message (opus-4.8/fable form) whose
#      text STARTS with the needle -> drop the whole message;
#   2. a `<system-reminder>`-wrapped text block inside a user message (classic
#      form) that is ENTIRELY the reminder -> drop just that block.
# The match is anchored to the block head on reminder-shaped content only — a
# bare substring test would eat conversation that merely QUOTES the text
# (live capture: a tool_result Reading a clodex message file contained the
# needle; deleting a tool_result also breaks tool_use pairing -> API 400).
#
# GATE = the per-session L2 strip level (>=2), same as the other content folds
# (fold_read_edits / edit-ack / tool-error stubbing) — NOT a process-global
# flag. So an L2 session strips the nags; L1/L0 leave them (an agent you WANT
# nudged toward the task list just stays below L2, or a whole-fleet run keeps
# the nudge with STRIP_TASK_REMINDERS=0 below). This deletes Anthropic's nudge,
# so it belongs with the other opt-in L2 simplifications, not always-on.
# Unlike the edit-ack/tool-error riders it needs NO `busted_from` gate: nags
# debut at the tail, so stripping-from-arrival can never ORIGINATE a warm-prefix
# bust (the reason those riders only fire inside a thinking-strip's bust region
# doesn't apply). Deterministic every turn -> byte-stable; no usage-gating (a
# gate that flipped when a session started using tasks would flip prefix bytes
# mid-session — the anti-flap trap the strip-guard latch exists for).
# STRIP_TASK_REMINDERS is a KILL-SWITCH (default ON): the real gate is L2, but
# set it to 0 to preserve the nudge even in L2 sessions (keep the other L2
# folds, lose only the nag strip).
STRIP_TASK_REMINDERS = os.environ.get("STRIP_TASK_REMINDERS", "1") not in (
    "0", "no", "off", "false")
_TASK_REMINDER_NEEDLE = "The task tools haven't been used recently"


def _is_task_reminder_text(text):
    """True iff `text` IS the task nag (anchored; optionally system-reminder-
    wrapped). Never matches mere quotation mid-content."""
    if not isinstance(text, str):
        return False
    t = text.strip()
    if t.startswith("<system-reminder>"):
        inner = t[len("<system-reminder>"):].strip()
        return inner.startswith(_TASK_REMINDER_NEEDLE) and t.endswith("</system-reminder>")
    return t.startswith(_TASK_REMINDER_NEEDLE)


def _strip_task_reminders(obj, agent_id=None):
    """Delete task-tool nag reminders wherever they appear in messages[]. Runs
    at the L2 strip level (rides `_strip_l2_enabled`, same as fold/edit-ack);
    the STRIP_TASK_REMINDERS kill-switch can force it off even at L2. Returns a
    log dict, or None if nothing matched / the gate is closed. Idempotent."""
    if not (STRIP_TASK_REMINDERS and _strip_l2_enabled(obj, agent_id)):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list):
        return None
    dropped_msgs = dropped_blocks = chars = 0
    keep = []
    for m in msgs:
        if not isinstance(m, dict):
            keep.append(m)
            continue
        c = m.get("content")
        # shape 1: mid-conversation system message, string (or single-text) body
        if m.get("role") == "system":
            txt = c if isinstance(c, str) else (
                c[0].get("text") if (isinstance(c, list) and len(c) == 1
                                     and isinstance(c[0], dict)
                                     and c[0].get("type") == "text") else None)
            if _is_task_reminder_text(txt):
                dropped_msgs += 1
                chars += len(txt)
                continue
        # shape 2: a wrapped text block inside a user message's block list
        if m.get("role") == "user" and isinstance(c, list):
            hits = [b for b in c
                    if isinstance(b, dict) and b.get("type") == "text"
                    and _is_task_reminder_text(b.get("text"))]
            # never empty a message (invalid wire) — sole-block nag stays put
            if hits and len(hits) < len(c):
                m["content"] = [b for b in c if b not in hits]
                dropped_blocks += len(hits)
                chars += sum(len(b.get("text") or "") for b in hits)
        keep.append(m)
    if not (dropped_msgs or dropped_blocks):
        return None
    obj["messages"] = keep
    return {"system_msgs": dropped_msgs, "user_blocks": dropped_blocks,
            "chars": chars}


# ---- STRIP FILE-MODIFIED DIFF PAYLOADS (part of STRIP LEVEL 2) ---------------
# When a file in the agent's cwd is changed out-of-band (by the user, a linter,
# or — the motivating case — ANOTHER agent sharing the cwd), the CLI injects a
# "Note: <path> was modified ... Here are the relevant changes:" block carrying
# the file's numbered diff. The CLI already caps it, but the cap is ~8 KB: median
# 8.2k ch (~2k tok) across the corpus, on 13% of all requests, and once injected
# it bakes into history and re-ships EVERY turn until the session ends/compacts.
# The diff is about a file this agent often never touched — pure carriage. We keep
# the NOTIFICATION (the model is still told the file changed and to take it into
# account) and excise only the numbered-diff PAYLOAD (from the "Here are the
# relevant changes" header through the last diff line); the model can Read the
# file if it ever needs the exact changes.
#
# Two wire dialects, same as the task-reminder strip:
#   1. a `<system-reminder>`-wrapped text block in a user message (classic form)
#      — the note is the whole block; the payload runs to `</system-reminder>`;
#   2. the opus-4.8/fable mid-conversation `role:"system"` string, where the note
#      is CONCATENATED with other ambient context (agent roster, skills roster) —
#      so we can't drop the message; we surgically excise the payload SUBSTRING,
#      leaving whatever ambient section follows it intact.
# One line-walk handles both: after the header, consume the contiguous run of
# numbered (`^\d+\t`) / truncation-marker lines, tolerating blank lines only
# BETWEEN diff lines, and stop at the first prose line (a following ambient
# section, or the closing `</system-reminder>`) — so the run never eats the
# separator + next section.
#
# GATE = the per-session L2 strip level (rides `_strip_l2_enabled`), same as the
# task-reminder strip and the other content folds — it REMOVES content, so it
# belongs in the opt-in L2 tier, not always-on. Kill-switch STRIP_FILEMOD_DIFFS
# (default ON) forces it off even at L2. Size gate STRIP_FILEMOD_MIN_CHARS
# (default 300): a tiny one-line diff is cheap + occasionally useful, so leave it;
# only excise payloads at/above the threshold. Like the task-reminder strip it
# needs NO `busted_from` gate: the note debuts at the tail, so stripping-from-
# arrival can never ORIGINATE a warm-prefix bust, and the excision is
# byte-deterministic (same note -> same bytes) + idempotent (the header is gone
# on a second pass, so re-running is a no-op). tool_result content is never
# touched (we only walk string content and `type:"text"` blocks) — a tool_result
# that Reads a file could legitimately quote the phrases, and the anchor is
# strict enough besides.
STRIP_FILEMOD_DIFFS = os.environ.get("STRIP_FILEMOD_DIFFS", "1") not in (
    "0", "no", "off", "false")
try:
    STRIP_FILEMOD_MIN_CHARS = int(os.environ.get("STRIP_FILEMOD_MIN_CHARS", "300"))
except ValueError:
    STRIP_FILEMOD_MIN_CHARS = 300
_FILEMOD_NOTE_RE = re.compile(
    r"Note: .*? was modified, either by the user or by a linter\.")
_FILEMOD_HDR_RE = re.compile(r"Here are the relevant changes[^\n]*:\n")
_FILEMOD_DIFF_LINE_RE = re.compile(r"^\d+\t")
_FILEMOD_TRUNC_RE = re.compile(r"^\.\.\. \[\d+ lines truncated\] \.\.\.[ \t]*$")


def _filemod_diff_spans(text):
    """For each file-modified note in `text`, yield (hdr_start, hdr_end, run_end):
    the char offsets of the "Here are the relevant changes" header and the end of
    its numbered-diff run. The excision span is [hdr_start, run_end) (header
    included, so what's left reads cleanly '...already aware.'); the PAYLOAD size
    to gate on is run_end - hdr_end. Diff run = contiguous numbered / truncation-
    marker lines; a blank line is tolerated only when a later diff line extends
    the run, so the trailing separator + any following ambient section survive."""
    if not isinstance(text, str):
        return
    n = len(text)
    for hm in _FILEMOD_HDR_RE.finditer(text):
        # Anchor: require the note preamble immediately before this header, so a
        # stray "Here are the relevant changes" quoted elsewhere never matches.
        pre = text[max(0, hm.start() - 400):hm.start()]
        if not _FILEMOD_NOTE_RE.search(pre):
            continue
        i = hm.end()
        run_end = hm.end()
        while i < n:
            j = text.find("\n", i)
            line = text[i:(j if j != -1 else n)]
            if _FILEMOD_DIFF_LINE_RE.match(line) or _FILEMOD_TRUNC_RE.match(line):
                run_end = (j if j != -1 else n)   # extend through this diff line
            elif line.strip() == "":
                pass                              # tentative blank — don't extend
            else:
                break                             # prose -> end of the note
            if j == -1:
                break
            i = j + 1
        yield hm.start(), hm.end(), run_end


def _excise_filemod_diffs(text, min_chars):
    """Return (new_text, chars_removed): drop every file-modified diff payload
    whose size >= `min_chars`, right-to-left so offsets stay valid."""
    spans = [(hs, re) for hs, he, re in _filemod_diff_spans(text)
             if (re - he) >= min_chars]
    if not spans:
        return text, 0
    removed = 0
    out = text
    for s, e in sorted(spans, reverse=True):
        removed += e - s
        out = out[:s] + out[e:]
    return out, removed


def _strip_filemod_diffs(obj, agent_id=None):
    """Excise the numbered-diff payloads from the CLI's out-of-band file-modified
    notes wherever they appear (string content + text blocks; never tool_result),
    keeping the notification. L2-gated + STRIP_FILEMOD_DIFFS kill-switch. Returns
    a log dict, or None if nothing matched / the gate is closed. Idempotent."""
    if not (STRIP_FILEMOD_DIFFS and _strip_l2_enabled(obj, agent_id)):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list):
        return None
    notes = chars = 0
    for m in msgs:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if isinstance(c, str):
            new, rm = _excise_filemod_diffs(c, STRIP_FILEMOD_MIN_CHARS)
            if rm:
                m["content"] = new
                chars += rm
                notes += 1
        elif isinstance(c, list):
            for b in c:
                if (isinstance(b, dict) and b.get("type") == "text"
                        and isinstance(b.get("text"), str)):
                    new, rm = _excise_filemod_diffs(b["text"], STRIP_FILEMOD_MIN_CHARS)
                    if rm:
                        b["text"] = new
                        chars += rm
                        notes += 1
    if not chars:
        return None
    return {"notes": notes, "chars": chars}


# ---- WIRESCOPE `[wirescope:omit ...]` — strip context sections from msgs[0] -
# Honors `[wirescope:omit claudemd,useremail]` (see WIRESCOPE.md): the proxy
# strips the named `# <Section>` blocks out of the <system-reminder> in the first
# user message before forwarding — the reconstruction of the CLI's internal
# omitClaudeMd, generalized (nothing native removes # userEmail). The directive
# may come from the agent BODY (per-type) or the SPAWN-prompt head (per-call,
# v1); a `keep` verb overrides per target (spawn > body). The strip rides
# system[2]/messages[0] cache-constant, fires every turn deterministically, and
# is idempotent. messages[0] sits AFTER the system/tools cache breakpoint, so the
# expensive prefix is untouched.
# Default ON: the `[wirescope:omit ...]` directive IS the opt-in (an author must
# write it; no directive -> no change), so the directive alone gates the
# behavior. WS_OMIT stays only as a deployment kill-switch (WS_OMIT=0 to refuse
# honoring omit directives entirely).
WS_OMIT = os.environ.get("WS_OMIT", "1") not in ("0", "no", "off", "false")
# Operator-level default OMIT policy (WIRESCOPE.md): a comma list of targets the
# operator wants stripped from EVERY subagent spawn with zero agent/spawner
# knowledge — the universal case (e.g. `WS_OMIT_DEFAULT=useremail` to keep the
# user's email out of every spawned helper). Applied as the LOWEST-precedence
# action layer (operator < body < spawn), so any `[wirescope:keep <t>]` directive
# overrides it. Empty/unset = off (no change). Still under the WS_OMIT master
# gate, and only on subagent turns (the main session is the user's own).
# UNCONDITIONAL-ONLY RULE (policy can be automated, strategy cannot): a target
# belongs here ONLY if no subagent would EVER want it kept — i.e. it's policy,
# not a task-dependent judgment. `useremail` qualifies; `claudemd` does NOT
# (whether a subagent needs project context is per-task = strategy → leave it to
# body/spawn directives). Rule of thumb: "if you'd ever want it kept, it doesn't
# belong in omit_default." (keep-override is the safety valve for rare misses,
# not a license to put strategic targets in the blanket default.)
WS_OMIT_DEFAULT = [t.lower() for t in
                   re.split(r"[,\s]+", os.environ.get("WS_OMIT_DEFAULT", "").strip())
                   if t]                          # liberal: commas and/or whitespace
# Spawner discovery hint (WIRESCOPE.md): the ONE place wirescope puts
# proxy-authored MODEL-VISIBLE text on the wire (everywhere else it strips its
# own directives). A small constant SELF-CONTAINED grammar block (the recipient
# lives in its own cwd and can't open the proxy-side WIRESCOPE.md, so the hint
# carries the usable syntax inline, not a file pointer), injected
# ONLY into a spawner's request — a main/parent line (not cc_is_subagent) that
# actually carries a subagent-spawn tool (Agent/Task) — so an agent that can't
# spawn never sees it and subagents stay pristine. Operator opt-in, default OFF.
WS_SPAWNER_HINT = os.environ.get("WS_SPAWNER_HINT", "") in (
    "1", "yes", "on", "true")
# tools[] names that mean "this agent can spawn subagents" (clodex: Agent;
# vanilla Claude Code: Task) — the hint is pointless without one of these.
_WS_SPAWN_TOOLS = {"Agent", "Task"}
# Self-contained: the agent that receives this lives in its OWN cwd and cannot
# open the proxy-side WIRESCOPE.md, so the hint carries the usable grammar inline
# (not a file pointer). Still one constant block -> re-anchors once, then rides
# the cache. Must start with "[wirescope] " (the idempotency guard keys on it).
# MIXED REGISTER (the proxy holds no per-task intent, so it must not push a
# stripping strategy): *recommend* agent-name (needs no task knowledge, no
# downside), only *surface* omit/keep/replace (strategy — the spawner decides).
_WS_HINT_TEXT = (
    "[wirescope] This agent can spawn subagents through the wirescope proxy, "
    "which can shape what each subagent inherits on the wire. The choice is "
    "yours per spawn — wirescope only carries it onto the wire, it doesn't "
    "decide. Directives go at the head of the spawn's prompt (one per line, "
    "before the task text) and are stripped before forwarding, so the subagent "
    "never sees them.\n"
    "\n"
    "Recommended for every spawn — name the subagent:\n"
    "  [wirescope:agent-name <label>]   improves traceability in logs and "
    "dashboards; costs nothing.\n"
    "\n"
    "Optional, apply per your own strategy — shape inherited context "
    "(targets/names are comma- or space-separated):\n"
    "  [wirescope:omit claudemd,useremail]   drop inherited context sections\n"
    "  [wirescope:keep claudemd]             cancel an omit (e.g. an operator "
    "default)\n"
    "  [wirescope:replace claudemd <text>]   keep the section, swap in a "
    "one-line body\n"
    "  [wirescope:tools Read,Grep,Glob]      forward only these tools "
    "(allowlist)\n"
    "  [wirescope:strip-tools Bash,WebFetch] forward all but these tools "
    "(denylist)\n"
    "  [wirescope:keep-tools Bash]           cancel a strip-tools\n"
    "Context targets: claudemd, useremail (some may already be stripped by an "
    "operator default). Tool names match the subagent's roster.")
# directive target token -> the `# <Section>` heading it removes
_WS_OMIT_TARGETS = {"claudemd": "# claudeMd", "useremail": "# userEmail"}

# PER-AGENT SPAWNER-HINT OVERRIDE (/_hint): agent ROUTE name (the <name> in
# /agent/<name>/…) -> 0/1, overriding WS_SPAWNER_HINT for just that agent's
# traffic. THE A/B INVISIBILITY GATE: the hint is the lone model-visible
# proxy-authored text in the whole protocol, so on=0 makes wirescope fully
# invisible to that agent's model while capture/billing/warmth observability
# still runs — the "clueless" control arm of an aware-vs-stock experiment
# (on=1 is the mirror: opt ONE agent in on a port whose global default is off).
# Keyed by ROUTE name, NOT session_id: the route exists BEFORE the first
# request (the consumer names it in the base URL, so the arm can be configured
# before launch) and survives /clear id-rotation — an arm keeps its identity
# for the whole experiment. Deliberately NOT dropped by the session sweeper
# (_ws_forget is session-keyed) for the same reason; persisted owner-scoped so
# a proxy restart can't flip an arm mid-experiment (same durability rationale
# as strip_override). Set it BEFORE the arm's first turn: flipping mid-session
# reshapes the marked system prefix -> one warm-prefix bust.
_HINT_OVERRIDE = {}

store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS hint_override ("
    "owner TEXT NOT NULL, agent TEXT NOT NULL, "
    "enabled INTEGER NOT NULL, set_at REAL NOT NULL, "
    "PRIMARY KEY (owner, agent))")


def _hint_set_override(agent, on):
    """Set (0/1) or clear (None) the per-agent spawner-hint override, mirrored
    to SQLite (reload lives in restore._restore_hint_overrides). Returns the
    new override value (None = cleared -> global default applies). A store
    failure degrades to in-memory-only, same as the strip-override twins."""
    if on is None:
        _HINT_OVERRIDE.pop(agent, None)
        try:
            con = store_mod.db()
            with store_mod.LOCK:
                con.execute("DELETE FROM hint_override WHERE owner=? AND agent=?",
                            (store_mod.OWNER, agent))
                con.commit()
        except Exception as e:
            print(f"[hint] row delete failed for {agent}: {e}", flush=True)
        return None
    val = 1 if on else 0
    _HINT_OVERRIDE[agent] = val
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO hint_override(owner, agent, enabled, set_at) "
                "VALUES(?,?,?,?) ON CONFLICT(owner, agent) DO UPDATE SET "
                "enabled=excluded.enabled, set_at=excluded.set_at",
                (store_mod.OWNER, agent, val, time.time()))
            con.commit()
    except Exception as e:
        print(f"[hint] persist failed for {agent}: {e}", flush=True)
    return val


# A reminder SECTION header is `# ` + a lowercase camelCase key (claudeMd,
# userEmail, currentDate, … — the CLI generates them from internal camelCase
# keys) on its own line. NOT an arbitrary markdown heading: CLAUDE.md CONTENT
# routinely leads with `# Title` / `## Sub` headings, and a naive `^# ` boundary
# stopped at the FIRST of those, leaving the whole doc un-stripped (the
# 2026-06-14 leak: a `# claudeMd` body began `# Spatiul lui Adam`, so omit cut
# only the ~280-char preamble and the project doc survived on the wire).
# Calibrated against 400 real captures: every CLI reminder header is lowercase
# camelCase (claudeMd/userEmail/currentDate); content headings are Title-Case or
# multi-word and never match — so a section ends only at the NEXT such header or
# the closing tag. (An unknown future section is still camelCase → respected, no
# over-strip; the rare lowercase-single-word CONTENT heading would under-strip,
# same fail-safe class as before, never a leak of MORE than asked.)
_WS_SECTION_HDR_RE = r"(?m)^# [a-z][A-Za-z0-9]*[ \t]*$"


def _ws_section_end(rest):
    """Offset into `rest` where the current reminder section ends: the next
    reminder-section header or </system-reminder>, whichever is first; len(rest)
    if neither (defensive — strips to end)."""
    bounds = [c.start() for c in (re.search(_WS_SECTION_HDR_RE, rest),
                                  re.search(r"</system-reminder>", rest)) if c]
    return min(bounds) if bounds else len(rest)


def _ws_strip_reminder_section(text, hdr):
    """Strip the `hdr` section from a <system-reminder> text — the heading and its
    whole body up to the next reminder-section header (see _WS_SECTION_HDR_RE) or
    the closing </system-reminder>, so internal markdown headings inside the body
    don't truncate it and a sibling section (e.g. userEmail) after it is kept.
    Returns (new_text, chars_removed)."""
    m = re.search(r"(?m)^[ \t]*" + re.escape(hdr) + r"[ \t]*$", text)
    if not m:
        return text, 0
    start = m.start()
    end = m.end() + _ws_section_end(text[m.end():])
    new = text[:start] + text[end:]
    new = re.sub(r"\n{3,}", "\n\n", new)
    return new, end - start


def _ws_replace_reminder_section(text, hdr, new_body):
    """Replace the BODY of the `hdr` section (keep the `# <Section>` heading,
    swap its content) with `new_body`. Same section boundary as the strip helper
    (next reminder-section header or the closing </system-reminder>). Returns
    (new_text, 1) on a hit, (text, 0) on a miss (fail-safe, never invents a
    section)."""
    m = re.search(r"(?m)^[ \t]*" + re.escape(hdr) + r"[ \t]*$", text)
    if not m:
        return text, 0
    end = m.end() + _ws_section_end(text[m.end():])
    body = new_body.strip("\n")
    new = text[:m.end()] + "\n" + body + "\n" + text[end:]
    return new, 1


def _ws_omit_target_list(value):
    """Parse an `omit`/`keep` value into a lowercased token list. LIBERAL
    separator (Postel's law): commas and/or whitespace, so `claudemd,useremail`,
    `claudemd, useremail`, and `claudemd useremail` are all equivalent. An agent
    that discovered the syntax from the spawner hint tends to write
    space-separated targets — the most natural naive form must parse, or a
    correctly-intentioned omit silently no-ops (real catch, 2026-06-14)."""
    return [t.lower() for t in re.split(r"[,\s]+", (value or "").strip()) if t]


def _ws_resolve_actions(pairs):
    """Resolve ordered [(directive, value)] into a per-target action map
    {target: ('omit', None) | ('replace', text)}. `omit` adds each listed target;
    `replace <target> <text>` sets one target to substitute that text; `keep`
    cancels a target. Later directives override earlier for the same target, so
    feeding body pairs THEN spawn pairs makes spawn win (precedence spawn > body),
    in either direction. The verb vocabulary lives here — new section verbs slot
    in as one more branch."""
    actions = {}
    for name, value in pairs:
        if name == "omit":
            for t in _ws_omit_target_list(value):
                actions[t] = ("omit", None)
        elif name == "replace":
            parts = value.split(None, 1)            # "<target> <inline text>"
            if parts:
                actions[parts[0].lower()] = (
                    "replace", parts[1] if len(parts) > 1 else "")
        elif name == "keep":
            for t in _ws_omit_target_list(value):
                actions.pop(t, None)
    return actions


# STICKY PER-INSTANCE SPAWN MEMORY: spawn-position directives only sit at the
# strict HEAD of messages[0] on a subagent's FIRST turn; on any continuation turn
# that block is a follow-up / <local-command-caveat> / compaction summary, so
# _ws_spawn_pairs sees nothing and the omitted sections (esp. # claudeMd) RETURN.
# We remember the resolved spawn pairs by the stable per-instance key
# (x-claude-code-agent-id, present iff subagent) and RE-APPLY them on later turns
# of the same instance. A later directive-bearing turn UPDATES the memory (a
# fresh `keep` can still cancel). Keyed session_id -> {agent_id: pairs} so the
# pinger sweep drops it with the session's other instance state; transforms OWNS
# + mutates this (no gate but omit reads it). See _ws_forget.
_WS_SPAWN_MEMORY = {}


def _ws_forget(session_id):
    """Drop the sticky spawn memory + strip-thinking override for a session
    (called by the pinger sweep alongside the other per-session instance state).
    No-op if absent."""
    _WS_SPAWN_MEMORY.pop(session_id, None)
    if _STRIP_OVERRIDE.pop(session_id, None) is not None:
        _delete_strip_override(session_id)
    if _STRIP_GUARD_LATCH.pop(session_id, None) is not None:
        _delete_strip_guard_latch(session_id)
    if _RIDER_LATCH.pop(session_id, None) is not None:
        _delete_rider_latch(session_id)


def _ws_merged_pairs(obj, agent_id=None):
    """Ordered (directive, value) pairs after merging the operator default policy
    + body + spawn layers (precedence operator < body < spawn, by feed order),
    with the spawn layer made STICKY per instance. BOTH verb families consume this
    one stream — section verbs via _ws_resolve_actions, tool verbs via
    _ws_resolve_tools — so precedence + stickiness live in exactly one place.

    `agent_id` (the x-claude-code-agent-id request header) makes the spawn layer
    sticky: on a directive-bearing turn we remember the spawn pairs under that id;
    on a later directive-less turn of the same instance we re-feed the remembered
    pairs so the directives persist past turn 1. Only ever remembered/replayed for
    a real subagent instance (the main line has no agent_id, so it is never
    sticky; a non-subagent is never touched even if some header leaked through)."""
    pairs = []
    # Fingerprint-backed subagent check (NOT the raw billing flag): a parent turn
    # that leaked cc_is_subagent=true + a stale agent-id must NOT pick up the
    # subagent operator-default NOR replay another instance's sticky directives.
    is_sub = writer_mod._genuine_subagent(obj)
    if WS_OMIT_DEFAULT and is_sub:
        pairs.append(("omit", ",".join(WS_OMIT_DEFAULT)))   # lowest precedence
    pairs += writer_mod._ws_body_pairs(obj)
    spawn = writer_mod._ws_spawn_pairs(obj)
    if agent_id and is_sub:
        sid = writer_mod._session_ids(obj)[0]
        fp = writer_mod._billing_fingerprint(obj)      # this turn's lineage hash
        mem = _WS_SPAWN_MEMORY.setdefault(sid, {})
        if spawn:                                  # turn-1 (or any directive turn)
            mem[agent_id] = (fp, spawn)            # bind the directives to the lineage
        else:                                      # continuation turn: replay
            # Defense-in-depth (caching's spec): only replay if the remembered
            # lineage fingerprint matches THIS turn's. `_genuine_subagent` already
            # blocks leaked-parent turns; this additionally fails closed on a
            # genuine in-lineage agent-id REUSE (a different sub recycling the id),
            # where the fingerprints diverge -> no replay, no cross-instance trim.
            remembered = mem.get(agent_id)
            spawn = remembered[1] if (remembered and remembered[0] == fp) else []
    pairs += spawn                                 # highest precedence
    return pairs


def _ws_effective_actions(obj, agent_id=None):
    """The per-target SECTION action map (omit/keep/replace) after merging the
    operator default + body + spawn directives (see _ws_merged_pairs for the
    precedence + stickiness). See _ws_resolve_actions. {} when nothing applies."""
    return _ws_resolve_actions(_ws_merged_pairs(obj, agent_id))


def _ws_effective_omit_targets(obj):
    """Just the targets resolved to a strip (`omit`) — convenience for callers /
    tests that only care about deletions, not replacements."""
    return {t for t, (act, _) in _ws_effective_actions(obj).items()
            if act == "omit"}


# ---- WIRESCOPE tool-set trim (`tools` / `strip-tools` / `keep-tools`) -------
# Let a SPAWNER trim a subagent's tool roster on the wire, customizing a
# predefined agent (whose toolset is frozen in its `.claude/agents/<name>.md`
# frontmatter) WITHOUT editing its file. This is the biggest token lever we have
# (default ~33 tools ≈ 24k tok every turn, typical use ~4); native `--tools`
# trims only the MAIN agent, so per-spawn subagent trimming is a real gap.
#   `[wirescope:tools Read,Edit,Grep]` — ALLOWLIST: keep ONLY these (mirrors
#       native --tools; last one wins so spawn overrides body).
#   `[wirescope:strip-tools Bash,WebFetch]` — DENYLIST: remove these, keep the
#       rest (safe surgical removal; no need to know the agent's full roster).
#   `[wirescope:keep-tools Bash]` — cancel a drop / re-admit to the allowlist
#       (precedence override, e.g. a spawn keep over a body strip).
# Matching is case-insensitive + liberal-separator (a naive agent writes
# `strip-tools bash`). tools[] sits IN FRONT of the first cache breakpoint, so a
# consistent per-instance trim (sticky via _ws_merged_pairs) reshapes the cached
# prefix to the SMALLER set once, then rides it — a net cache WIN, not a per-turn
# bust. Forgeable only by system body / spawn-prompt head (never message content,
# same as omit). Sharp edge (spawner's call, like --tools): if the agent's prompt
# expects a stripped tool and the model emits it, upstream 400s.
WS_STRIP_TOOLS = os.environ.get("WS_STRIP_TOOLS", "1") not in (
    "0", "no", "off", "false")


def _ws_resolve_tools(pairs):
    """Resolve ordered pairs into a tool filter spec {'allow': set|None,
    'drop': set} (lowercased names). `tools` SETS the allowlist (last wins);
    `strip-tools` adds to the drop set; `keep-tools` removes from drop AND
    re-admits to an active allowlist. Non-tool verbs ignored."""
    allow = None
    drop = set()
    for name, value in pairs:
        if name == "tools":
            allow = set(_ws_omit_target_list(value))
        elif name == "strip-tools":
            drop.update(_ws_omit_target_list(value))
        elif name == "keep-tools":
            for t in _ws_omit_target_list(value):
                drop.discard(t)
                if allow is not None:
                    allow.add(t)
    return {"allow": allow, "drop": drop}


def _ws_strip_tools(obj, agent_id=None):
    """Apply the wirescope tool-trim directives to obj['tools']. Returns a log
    dict {removed, kept, allow, drop[, miss]} or None (gate off / no tools / no
    directive). A directive that matches NOTHING is a fail-safe MISS (logged,
    never over-strips). WS_STRIP_TOOLS=0 is the deployment kill-switch."""
    if not WS_STRIP_TOOLS:
        return None
    tools = obj.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    spec = _ws_resolve_tools(_ws_merged_pairs(obj, agent_id))
    allow, drop = spec["allow"], spec["drop"]
    if allow is None and not drop:
        return None                          # no tool directive in play
    kept, removed = [], []
    for t in tools:
        nm = t.get("name") if isinstance(t, dict) else None
        low = (nm or "").lower()
        if allow is not None and low not in allow:
            removed.append(nm)
        elif low in drop:
            removed.append(nm)
        else:
            kept.append(t)
    log = {"allow": sorted(allow) if allow is not None else None,
           "drop": sorted(drop)}
    if not removed:
        log["removed"] = []
        log["miss"] = True                   # directive present, matched nothing
        return log
    obj["tools"] = kept
    log["removed"] = removed
    log["kept"] = [t.get("name") for t in kept]
    return log


# ---- MCP SERVER TOOL STRIP (surgical, deployment-level) -------------------
# Drop the tool schemas of named MCP servers from tools[] on the wire, keyed by
# SERVER PREFIX (`mcp__<server>__*`) rather than exact name. This is the
# SURGICAL alternative to the CLI's all-or-nothing `--strict-mcp-config`: it
# removes exactly one server's tool family (present AND future tools) while
# leaving every real project/user MCP untouched, for EVERY CLI routed through
# the proxy, with zero ~/.claude.json edits. Motivating case: the claude.ai
# `claude_design` connector auto-injects 20 tools (~3.5k tok schema/turn) a
# coding agent never calls, and LATE-ATTACHES on GUI restart -> busts the tools
# segment 9->29 each relaunch. tools[] is logically FIRST in cache order, so a
# CONSTANT strip set reshapes the cached prefix to the smaller roster ONCE
# (one downstream bust at adoption), then rides byte-stable -> net cache WIN +
# the connector can no longer move the hash restart-to-restart. Determinism: the
# match is by SET membership on the server prefix, so the client's tool order is
# irrelevant; SORT_TOOLS (downstream) re-alphabetizes the output anyway, so the
# forwarded tools[] is byte-identical every turn. Per-agent escape hatch:
# `[wirescope:keep-mcp claude_design]` re-admits the server for a genuine design
# session (body/spawn directive, same forge-safety as omit/strip-tools).
# Default OFF in CODE (library/test embeddings unaffected); start_proxy.sh turns
# it ON for the lab via STRIP_MCP_SERVERS=claude_design. Kill switch:
# STRIP_MCP_SERVERS="" (or =off).
STRIP_MCP_SERVERS = frozenset(
    s for s in re.split(r"[,\s]+",
                        os.environ.get("STRIP_MCP_SERVERS", "").strip().lower())
    if s and s not in ("0", "no", "off", "false"))


def _strip_mcp_tools(obj, agent_id=None):
    """Drop tools[] whose name matches `mcp__<server>__*` for each configured
    server, minus any the agent re-admits via `[wirescope:keep-mcp <server>]`.
    Returns a log dict {removed, kept, servers[, miss]} or None (gate off / no
    tools / no server left to strip). Migrates a cache_control off a stripped
    tool onto the new last tool if one ever rides it — on the org-scope wire the
    proxy serves, NO breakpoint marks tools[] (the first marker sits on the
    system blocks, whose cached prefix still includes tools cumulatively), so
    this never fires here; it's defensive for a first-party path where the M1
    tools+preamble breakpoint rides the last tool."""
    if not STRIP_MCP_SERVERS:
        return None
    tools = obj.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    keep = set()
    for name, value in _ws_merged_pairs(obj, agent_id):
        if name == "keep-mcp":
            keep.update(_ws_omit_target_list(value))
    servers = STRIP_MCP_SERVERS - keep
    if not servers:
        return None                          # every configured server re-admitted
    prefixes = tuple("mcp__%s__" % s for s in servers)
    kept, removed, lost_cc = [], [], None
    for t in tools:
        nm = t.get("name") if isinstance(t, dict) else None
        if nm and nm.lower().startswith(prefixes):
            removed.append(nm)
            if isinstance(t, dict) and t.get("cache_control") and lost_cc is None:
                lost_cc = t["cache_control"]
        else:
            kept.append(t)
    log = {"servers": sorted(servers)}
    if not removed:
        log["removed"] = []
        log["miss"] = True                   # configured but this req carried none
        return log
    # Re-anchor a dropped breakpoint onto the new last tool (defensive; see above).
    if (lost_cc and kept and isinstance(kept[-1], dict)
            and not any(isinstance(t, dict) and t.get("cache_control")
                        for t in kept)):
        kept[-1]["cache_control"] = lost_cc
    obj["tools"] = kept
    log["removed"] = removed
    log["kept"] = [t.get("name") for t in kept]
    return log


# ---- GLOBAL EXACT-NAME TOOL STRIP (deployment-level) ----------------------
# Drop named tools[] entries by EXACT name for every routed CLI, keyed on a
# constant set. This is the sibling of STRIP_MCP_SERVERS (which keys on the
# `mcp__<server>__*` prefix) for tools the CLI PINS into the outbound roster
# past every native filter. Motivating case: EndConversation — a mandatory
# safety tool the CLI force-includes even under a strict `--tools bash`
# allowlist AND leaves on the wire under settings `permissions.deny`
# (wire-proven 2026-07-18: --tools bash -> [Bash, EndConversation]; deny of
# [Artifact, EndConversation] strips Artifact, keeps EndConversation). Its
# entry is ~4.7k ch / ~1.7k tok of pure abuse-policy prose (empty
# input_schema) a coding fleet never invokes, cached every turn. No native
# means removes it; the proxy is the only lever.
#
# Same cache math as STRIP_MCP: tools[] is FIRST in cache order, so a CONSTANT
# strip set reshapes the cached prefix to the smaller roster ONCE (one
# downstream bust at adoption), then rides byte-stable (SORT_TOOLS downstream
# re-alphabetizes, so the forwarded tools[] is identical every turn). Match is
# by SET membership (case-insensitive), order-independent. Default OFF in code
# (STRIP_TOOLS_GLOBAL="") so library/test embeddings are unaffected; a
# deployment turns it on via STRIP_TOOLS_GLOBAL="EndConversation[,…]".
# Per-agent re-admit: `[wirescope:keep-tools <name>]` (shares the resolver the
# wirescope tool directives use). Kill switch: STRIP_TOOLS_GLOBAL="" (or =off).
STRIP_TOOLS_GLOBAL = frozenset(
    s.lower() for s in re.split(r"[,\s]+",
                                os.environ.get("STRIP_TOOLS_GLOBAL", "").strip())
    if s and s.lower() not in ("0", "no", "off", "false"))


def _strip_tools_global(obj, agent_id=None):
    """Drop tools[] whose name is in STRIP_TOOLS_GLOBAL (minus any the agent
    re-admits via `[wirescope:keep-tools <name>]`). Returns a log dict
    {removed, kept, targets[, miss]} or None (gate off / no tools / nothing to
    strip). Mirrors _strip_mcp_tools including the defensive cache_control
    migration onto the new last tool (never fires on the org-scope wire, where
    tools carry no breakpoint)."""
    if not STRIP_TOOLS_GLOBAL:
        return None
    tools = obj.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    keep = set()
    for name, value in _ws_merged_pairs(obj, agent_id):
        if name == "keep-tools":
            keep.update(t.lower() for t in _ws_omit_target_list(value))
    targets = STRIP_TOOLS_GLOBAL - keep
    if not targets:
        return None                          # every configured tool re-admitted
    kept, removed, lost_cc = [], [], None
    for t in tools:
        nm = t.get("name") if isinstance(t, dict) else None
        if nm and nm.lower() in targets:
            removed.append(nm)
            if isinstance(t, dict) and t.get("cache_control") and lost_cc is None:
                lost_cc = t["cache_control"]
        else:
            kept.append(t)
    log = {"targets": sorted(targets)}
    if not removed:
        log["removed"] = []
        log["miss"] = True                   # configured but this req carried none
        return log
    if (lost_cc and kept and isinstance(kept[-1], dict)
            and not any(isinstance(t, dict) and t.get("cache_control")
                        for t in kept)):
        kept[-1]["cache_control"] = lost_cc
    obj["tools"] = kept
    log["removed"] = removed
    log["kept"] = [t.get("name") for t in kept]
    return log


# ---- SIDE-CALL MODEL DOWNSHIFT (WebFetch/WebSearch utility calls) ----------
# The CLI dispatches two kinds of one-shot UTILITY side-calls on the SESSION'S
# MAIN MODEL, ignoring both the invoking subagent's model and WebFetch's own
# "small fast model" contract (wire-proven 2026-07-07: sonnet+haiku subagents'
# WebFetch summarize calls both arrived as fable-5; a fable research session's
# 75 side-calls = $13.92 of a $19.93 run — repriced at haiku: $1.39):
#   - WebFetch summarize: 0 tools, 1 user msg starting "Web page content:",
#     SDK preamble system block. The full fetched page rides as UNCACHED input.
#   - WebSearch: exactly 1 server tool (web_search), 1 user msg starting
#     "Perform a web search for the query:", dedicated system marker block.
# Both are single-shot and carry ZERO cache_control -> rewriting `model` is
# cache-safe (no prefix lineage) and history-safe (the CLI consumes only the
# response text; nothing re-enters the transcript under the wrong model).
# DEFAULT ON -> claude-sonnet-5 (operator decision 2026-07-07: sonnet keeps
# digest quality for research-critical searches at 1/3 fable input price;
# a fable-capability digester is never warranted for page summarization).
# Only fires when the incoming model is MORE expensive than everything cheap —
# i.e. it never UPSHIFTS: a session already on haiku/sonnet is left alone
# (model == target short-circuits; _MODEL_RANK guards the haiku case).
# Override with SIDECALL_MODEL=<model-id>; kill with SIDECALL_MODEL=off.
# `output_config` (fable-only effort key) is dropped alongside; the server
# strips `context-1m-2025-08-07` from the forwarded anthropic-beta header
# (SIDECALL_BETA_STRIP) since the target model may not support the 1M beta.
# Decline-on-doubt: any thinking key, >1 message, any cache_control, or an
# unrecognized shape -> untouched.
SIDECALL_MODEL = os.environ.get("SIDECALL_MODEL", "claude-sonnet-5").strip()
if SIDECALL_MODEL.lower() in ("0", "no", "off", "false"):
    SIDECALL_MODEL = ""
# Cheaper-than ordering so the downshift never upshifts a cheap session's
# side-call (haiku session + sonnet target would be a price INCREASE).
# Unlisted models (incl. dated variants) rank as expensive -> eligible;
# matching is by substring on the family name.
_SIDECALL_RANK = ("haiku", "sonnet", "opus", "fable")
# beta tokens to drop from the forwarded header when the downshift fired
SIDECALL_BETA_STRIP = frozenset(
    t for t in re.split(r"[,\s]+", os.environ.get(
        "SIDECALL_BETA_STRIP", "context-1m-2025-08-07").strip())
    if t and t not in ("0", "no", "off", "false"))
_SIDECALL_WEBSEARCH_SYS = "You are an assistant for performing a web search tool use"
_SIDECALL_WEBFETCH_SYS = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
_SIDECALL_WEBFETCH_MSG = "Web page content:"
_SIDECALL_WEBSEARCH_MSG = "Perform a web search for the query:"


def _sidecall_first_text(obj):
    """First text-block string of messages[0] iff it is the ONLY message and a
    user turn; else None."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or len(msgs) != 1:
        return None
    m0 = msgs[0]
    if not isinstance(m0, dict) or m0.get("role") != "user":
        return None
    c = m0.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                return b.get("text") or ""
    return None


def _sidecall_sys_texts(obj):
    sysl = obj.get("system")
    if isinstance(sysl, str):
        return [sysl]
    if isinstance(sysl, list):
        return [b.get("text") or "" for b in sysl if isinstance(b, dict)]
    return []


def _sidecall_kind(obj):
    """'webfetch' | 'websearch' | None — strict shape match on the two known
    utility-call families (see block comment above). Cheapest rejects first:
    this runs on EVERY main-line request (downshift is first in the chain),
    and the one-message check kills ~all of them before any deep look. The
    marker check walks the structure (_cache_markers) instead of substring-
    probing a full json.dumps of a 100k-token body."""
    first = _sidecall_first_text(obj)
    if first is None:
        return None
    if "thinking" in obj or _cache_markers(obj):
        return None
    tools = obj.get("tools") or []
    sys_texts = _sidecall_sys_texts(obj)
    if (not tools
            and first.lstrip().startswith(_SIDECALL_WEBFETCH_MSG)
            and any(t.strip() == _SIDECALL_WEBFETCH_SYS for t in sys_texts)):
        return "webfetch"
    if (len(tools) == 1 and isinstance(tools[0], dict)
            and (tools[0].get("name") == "web_search"
                 or str(tools[0].get("type", "")).startswith("web_search"))
            and first.lstrip().startswith(_SIDECALL_WEBSEARCH_MSG)
            and any(t.strip().startswith(_SIDECALL_WEBSEARCH_SYS)
                    for t in sys_texts)):
        return "websearch"
    return None


def _sidecall_rank(model):
    """Price-family rank of a model id (higher = pricier); unknown families
    rank above everything listed so they stay downshift-eligible."""
    low = (model or "").lower()
    for i, fam in enumerate(_SIDECALL_RANK):
        if fam in low:
            return i
    return len(_SIDECALL_RANK)


def _sidecall_downshift(obj):
    """Rewrite the model of a recognized WebFetch/WebSearch utility side-call
    to SIDECALL_MODEL. Returns a log dict {kind, from_model, to_model,
    dropped} or None (gate off / not a side-call / already at target /
    would not be a downshift)."""
    if not SIDECALL_MODEL or not isinstance(obj, dict):
        return None
    model = obj.get("model")
    if not model or model == SIDECALL_MODEL:
        return None
    if _sidecall_rank(model) <= _sidecall_rank(SIDECALL_MODEL):
        return None                     # never upshift (e.g. haiku session)
    kind = _sidecall_kind(obj)
    if kind is None:
        return None
    obj["model"] = SIDECALL_MODEL
    dropped = []
    if "output_config" in obj:          # fable-only effort key; target model
        del obj["output_config"]        # may reject it -> drop, never remap
        dropped.append("output_config")
    return {"kind": kind, "from_model": model, "to_model": SIDECALL_MODEL,
            "dropped": dropped}


def _ws_reminder_is_empty(text):
    """True if `text` is a <system-reminder> whose every `# Section` was stripped,
    leaving only the wrapper + the "you can use the following context:" intro with
    NOTHING after it. Detected as: a system-reminder with no remaining column-0
    `# ` heading of any kind (a kept section — currentDate, Environment, … — keeps
    a heading, so this is conservative: never drops a block that still has real
    content)."""
    return ("<system-reminder>" in text
            and re.search(r"(?m)^# ", text) is None)


def _ws_omit(obj, agent_id=None):
    """Apply the effective wirescope context-section actions (omit / replace,
    body + spawn, with the `keep` override) to messages[0]. Returns a log dict
    {omitted, replaced, missed, chars_removed, requested, dropped_blocks} or None
    when nothing was requested / the flag is off. A requested target not found
    (unknown token or format drift) is a logged MISS, never an over-strip
    (fail-safe). A reminder block emptied of ALL its sections is dropped whole
    rather than forwarded as a dangling 'here's the context:' shell.

    `agent_id` threads the per-instance key so a continuation turn re-applies the
    spawn directive remembered from turn 1 (see _ws_effective_actions)."""
    if not WS_OMIT:
        return None
    actions = _ws_effective_actions(obj, agent_id=agent_id)
    if not actions:
        return None
    requested = sorted(actions)
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    omitted, replaced, chars, dropped = set(), set(), 0, 0
    for m in msgs:                       # in practice only messages[0] carries it
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if not isinstance(c, list):
            continue
        drop_idx = []
        for bi, b in enumerate(c):
            if not (isinstance(b, dict) and b.get("type") == "text"
                    and isinstance(b.get("text"), str)):
                continue
            touched = False
            for tgt, (act, payload) in actions.items():
                hdr = _WS_OMIT_TARGETS.get(tgt)
                if not hdr or hdr not in b["text"]:
                    continue
                if act == "replace":
                    new, n = _ws_replace_reminder_section(b["text"], hdr, payload)
                    if n:
                        b["text"] = new
                        replaced.add(tgt)
                        touched = True
                else:                                # "omit"
                    new, n = _ws_strip_reminder_section(b["text"], hdr)
                    if n:
                        b["text"] = new
                        omitted.add(tgt)
                        chars += n
                        touched = True
            if touched and _ws_reminder_is_empty(b["text"]):
                drop_idx.append(bi)
        if drop_idx:
            drop = set(drop_idx)
            kept = [b for i, b in enumerate(c) if i not in drop]
            if not kept:
                continue                     # never nuke a message's whole content
            # If a dropped block carried the message-level cache breakpoint,
            # re-anchor it on the new first block so we don't lose the breakpoint.
            lost_cc = next((c[i]["cache_control"] for i in drop
                            if isinstance(c[i], dict) and c[i].get("cache_control")),
                           None)
            if (lost_cc and isinstance(kept[0], dict)
                    and not any(isinstance(b, dict) and b.get("cache_control")
                                for b in kept)):
                kept[0]["cache_control"] = lost_cc
            m["content"] = kept
            dropped += len(drop)
    done = omitted | replaced
    missed = [t for t in requested if t not in done]
    if not done and not missed:
        return None
    return {"omitted": sorted(omitted), "replaced": sorted(replaced),
            "missed": missed, "chars_removed": chars, "requested": requested,
            "dropped_blocks": dropped}


def _ws_strip_lines(text):
    """Remove exactly the WHOLE-LINE column-1 `[wirescope:...]` directive lines
    from `text` — the same set _ws_directive_pairs honors, so strip == parse by
    construction (a mention the parser treats as content stays on the wire).
    Returns (new_text, n_removed)."""
    lines = text.split("\n")
    kept = [l for l in lines
            if not writer_mod._WS_LINE_RE.match(l.rstrip())]
    return "\n".join(kept), len(lines) - len(kept)


def _ws_strip_directives(obj):
    """Remove every honored `[wirescope:...]` directive LINE from the system text
    blocks before forwarding. The proxy has already READ and ACTED on them
    (agent-name captured for display, omit applied to messages[0]); they are proxy
    control lines, so the MODEL must never see them and they shouldn't cost prefix
    tokens. WHOLE-LINE only, mirroring the parse: an inline/indented/backticked
    mention was never a directive, so it is real content and STAYS on the wire
    (the old unanchored subn deleted quoted examples from prose). Always runs
    (not WS_OMIT-gated) — the proxy consumes its own directives regardless of
    whether a given verb is honored. Deterministic per agent type, so the stripped
    system prefix stays cache-constant (and equals the no-directive body). Returns
    {stripped, blocks} or None. Whitespace left behind is lightly tidied."""
    sys = obj.get("system")
    total, blocks = 0, []
    if isinstance(sys, list):
        for bi, b in enumerate(sys):
            if not (isinstance(b, dict) and isinstance(b.get("text"), str)
                    and "[wirescope:" in b["text"]):
                continue
            new, n = _ws_strip_lines(b["text"])
            if n:
                b["text"] = re.sub(r"[ \t]*\n{3,}", "\n\n", new)
                total += n
                blocks.append(bi)
    elif isinstance(sys, str) and "[wirescope:" in sys:
        new, n = _ws_strip_lines(sys)
        if n:
            obj["system"] = re.sub(r"[ \t]*\n{3,}", "\n\n", new)
            total, blocks = n, [0]
    return {"stripped": total, "blocks": blocks} if total else None


def _ws_strip_spawn_directives(obj):
    """Strip the strict-head spawn directives from messages[0]'s prompt block
    before forwarding — the proxy has already READ and ACTED on them (omit/keep
    merged into the effective target set, agent-name captured for display), so
    the model must never see our control lines and they cost zero tokens. Gated
    by WS_SPAWN_DIRECTIVES. Unlike the system strip, this removes ONLY the leading
    consumed directive lines — never a `[wirescope:...]` that appears later in
    prompt prose or a quoted transcript (which was never a directive). Returns
    {stripped} or None. Deterministic per spawn, so messages[0] stays byte-stable
    across the instance's turns (cache-coherent, no transcript desync)."""
    if not writer_mod.WS_SPAWN_DIRECTIVES:
        return None
    b = writer_mod._ws_prompt_block(obj)
    if b is None:
        return None
    new, n = writer_mod._ws_strip_leading_directives(b["text"])
    if not n:
        return None
    b["text"] = new
    return {"stripped": n}


def _hint_enabled(agent):
    """Effective spawner-hint state for an agent route: the per-agent /_hint
    override wins; no override -> the global WS_SPAWNER_HINT default. `agent`
    None (unroutable/ext traffic) can't carry an override -> global."""
    if agent is not None and agent in _HINT_OVERRIDE:
        return bool(_HINT_OVERRIDE[agent])
    return WS_SPAWNER_HINT


def _ws_spawner_hint(obj, agent=None):
    """Inject the constant spawner discovery hint (WS_SPAWNER_HINT, see
    above) as a TRAILING system block, then MIGRATE the last system cache
    marker onto it — so the hint rides INSIDE the marked system prefix (the
    fleet-shared segment: same model+tools = same bytes across projects)
    instead of the msg0-bounded per-project segment it'd land in past the
    breakpoint. Marker MOVE, not add (4-breakpoint budget intact); the hint
    stays its own block (clean proxy-authored attribution, canary sees a
    distinct block, CLI text never mutated) — same marker-migration pattern
    as STRIP_MCP's tools[-1]. Gated to spawner requests only (not a
    subagent; carries a spawn tool). Idempotent (won't double-inject). Returns
    {injected:True, marker_moved:bool} or None. Default OFF — this is the lone
    wire-visible proxy-authored text in the whole protocol. `agent` = the
    ROUTE name; a per-agent /_hint override beats the global (the A/B
    invisibility gate — see _HINT_OVERRIDE above)."""
    if not _hint_enabled(agent):
        return None
    if writer_mod._genuine_subagent(obj):          # never teach a real subagent
        return None                                # (a leaked parent turn IS a spawner)
    tools = obj.get("tools")
    if not isinstance(tools, list):
        return None
    names = {t.get("name") for t in tools if isinstance(t, dict)}
    if not (names & _WS_SPAWN_TOOLS):              # can't spawn -> hint is noise
        return None
    sys = obj.get("system")
    if not isinstance(sys, list):                  # only the list-form system
        return None
    if any(isinstance(b, dict) and isinstance(b.get("text"), str)
           and "[wirescope] " in b["text"] for b in sys):
        return None                                # already present (idempotent)
    hint = {"type": "text", "text": _WS_HINT_TEXT}
    # migrate the LAST system cache marker onto the hint block (move, never
    # add: the 4-breakpoint budget is the CLI's). If no system block carries
    # a marker (org-scope oddity / stream shapes), inject unmarked — the old
    # trailing-tail behavior, still correct.
    donor = next((b for b in reversed(sys)
                  if isinstance(b, dict) and b.get("cache_control")), None)
    if donor is not None:
        hint["cache_control"] = donor.pop("cache_control")
    sys.append(hint)
    return {"injected": True, "marker_moved": donor is not None}


# ---- TOOL SORT (experimental, off by default) -----------------------------
# Alphabetically sort body.tools by name. Tools are logically FIRST in the cache
# order (cached under MARKER 1), so a STABLE order makes that segment byte-stable
# if the CLI ever emits tools in nondeterministic (readdir) order. Idempotent: if
# already sorted it's a no-op (no cache bust). The first re-ordering busts marker1
# once, then stable. Value is purely predictability. ON BY DEFAULT; disable with
# SORT_TOOLS=0. (Note we usually TRIM tools via native --tools rather than rely on
# a sorted full roster.)
SORT_TOOLS = os.environ.get("SORT_TOOLS", "1") not in ("0", "no", "off", "false")


def _sort_tools(obj):
    """Sort obj['tools'] by name. Returns log dict or None (no-op / already sorted)."""
    if not SORT_TOOLS:
        return None
    tools = obj.get("tools")
    if not isinstance(tools, list) or len(tools) < 2:
        return None
    names = [t.get("name") if isinstance(t, dict) else None for t in tools]
    if any(n is None for n in names):
        return None                      # can't safely sort an unnamed entry
    after = sorted(tools, key=lambda t: t.get("name", ""))
    after_names = [t.get("name") for t in after]
    if after_names == names:
        return None                      # already sorted → don't bust the cache
    obj["tools"] = after
    return {"before": names, "after": after_names}


# ---- STRIP COMPACT CACHE MARKER (experimental; off by default) -------------
# A `/compact` request re-ships the ENTIRE conversation history so the model can
# summarize it, and the CLI stamps its usual ROLLING message-level cache_control
# breakpoint on that history. But compaction REPLACES the history with the
# summary, so the cache written for that history is DISCARDED — never read again
# (measured: the next turn read 0 of it). On a BUSTED cache that marker therefore
# only forces a wasteful COLD WRITE at the 1.25x/2x premium; dropping it ships the
# history as plain 1.0x input instead, reclaiming the write premium (~25% of that
# chunk) for zero downside (the write was orphaned anyway).
#
# *** SAFE ONLY WHEN THE CACHE IS NOT WARM. *** On a WARM cache that same history
# is served as a 0.10x cache_read; stripping the marker would force a 1.0x input
# re-ship (~10x WORSE on that chunk). The strip is gated on the WARMTH LEDGER —
# now DURABLE (SQLite) and TWO-STATE (2026-06-09): 'warm' keeps the marker;
# NOT-warm ('cold' lapsed row, or 'absent') strips. With a durable store that
# receipt-stamps every confirmed cache event, absence ≈ expiry, so acting on it
# is sound: the residual loss case (absent-but-actually-warm: pre-store sessions,
# bypassed traffic) is one bounded ~0.9x overpay on a one-shot compact. Ledger
# 'off' or store 'error' still DECLINE — can't judge. A fork keep-warm ping keeps
# the entry warm, so an actively-pinged session won't get its compact stripped.
#
# We strip ONLY the MESSAGE-level marker(s) (the discarded history breakpoint) and
# KEEP the system markers (tools+system is legitimately reused by the post-compact
# turns and the fleet). Enable with STRIP_COMPACT_CACHE=1; force the decision either
# way with STRIP_COMPACT_FORCE=0/1 (experiments / the warm decline-to-strip control).
STRIP_COMPACT_CACHE = os.environ.get("STRIP_COMPACT_CACHE") in ("1", "yes", "on", "true")

# Stable anchors from the Claude Code compaction prompt (require >=2 -> ~0 FPs).
# Version-fragile by nature; the canary tracks wire shape, but if the CLI rewords
# this prompt the match silently stops — re-verify per CLI bump.
_COMPACT_ANCHORS = (
    "create a detailed summary of the conversation so far",
    "wrap your analysis in <analysis> tags",
    "an <analysis> block followed by a <summary> block",
    "Please provide your summary based on the conversation so far",
    "Primary Request and Intent",
)


def _is_compact_request(obj):
    """True iff the last user message is the Claude Code compaction prompt."""
    txt = _last_user_text(obj) or ""
    return sum(1 for a in _COMPACT_ANCHORS if a in txt) >= 2


def _prefix_hashes(obj):
    """Cumulative prefix hash at every message boundary. Returns {depth: hash}
    where depth = number of messages included (1..len). One forward pass; the
    hasher is copied at each boundary so old message bodies are hashed once."""
    h = hashlib.blake2b(digest_size=20)
    h.update(warmth_mod._sys_tools_fingerprint(obj))
    out = {}
    for i, m in enumerate(obj.get("messages") or []):
        h.update(b"\x1e")
        h.update(warmth_mod._canon_message(m))
        out[i + 1] = h.copy().hexdigest()
    return out


def _compact_history_warmth(obj):
    """(state, hash, depth) for the HISTORY prefix a /compact would read-or-rewrite.
    The reused cache segment is the LAST MARKED breakpoint, which sits some messages
    back from the tail (the compaction prompt, plus the assistant reply that grew the
    history since the previous request, are NOT yet a recorded breakpoint). So we
    check EVERY cumulative prefix below the compaction prompt against the store in
    one batched query: any WARM depth -> 'warm' (the backend can still serve that
    prefix as a 0.10x read; keep the marker). No warm depth -> not-warm, reported
    as 'cold' (deepest lapsed row, observability) or 'absent'. 'off'/'error' when
    the ledger can't judge (gates decline)."""
    if not warmth_mod.WARMTH_LEDGER:
        return "off", None, 0
    msgs = obj.get("messages") or []
    if len(msgs) < 2:
        return "absent", None, 0
    hashes = _prefix_hashes(obj)
    depths = list(range(len(msgs) - 1, 0, -1))   # exclude the trailing compact prompt
    try:
        rows = warmth_mod._warmth_rows([hashes[d] for d in depths])
    except Exception:
        return "error", hashes.get(len(msgs) - 1), len(msgs) - 1
    now = time.time()
    lapsed = None
    for d in depths:
        r = rows.get(hashes[d])
        if r:
            if r[2] > now:
                return "warm", hashes[d], d
            if lapsed is None:
                lapsed = (hashes[d], d)
    if lapsed:
        return "cold", lapsed[0], lapsed[1]
    return "absent", hashes.get(len(msgs) - 1), len(msgs) - 1


def _strip_compact_cache(obj):
    """If this is a compaction request AND the history prefix is NOT warm, remove
    cache_control from MESSAGE blocks only (keep system markers). Returns a log dict
    or None (not a compact request / declined / nothing to strip). Two-state gate:
    'warm' keeps the marker; 'cold'/'absent' strip; 'off'/'error' decline.
    WHY not-warm only: on a warm cache that history is a 0.10x cache READ and
    stripping forces a 1.0x re-ship (~10x worse on that chunk); on cold/absent
    the marker only buys an orphaned write at the premium (absence ≈ expiry
    with a durable receipt-stamped store). 'off'/'error' decline: absence is
    evidence, a disabled or broken store is not. STRIP_COMPACT_FORCE=0/1
    overrides for experiments."""
    if not STRIP_COMPACT_CACHE or not isinstance(obj, dict):
        return None
    if not _is_compact_request(obj):
        return None
    state, hhash, depth = _compact_history_warmth(obj)
    force = os.environ.get("STRIP_COMPACT_FORCE")
    condition = ((force in ("1", "yes", "on", "true")) if force is not None
                 else state in ("cold", "absent"))
    if not condition:
        return {"compact": True, "condition_met": False, "removed": 0,
                "warmth_state": state, "history_hash": hhash, "history_depth": depth,
                "forced": force is not None,
                "note": "declined to strip (strip only when the history prefix is "
                        f"not warm and the store can judge; history is {state})"}
    removed = []
    for mi, m in enumerate(obj.get("messages") or []):
        c = m.get("content")
        if isinstance(c, list):
            for bi, blk in enumerate(c):
                if isinstance(blk, dict) and blk.get("cache_control"):
                    cc = blk.pop("cache_control")
                    removed.append({"msg": mi, "block": bi, "type": blk.get("type"),
                                    "cache_control": cc})
    sys_markers = sum(1 for b in (obj.get("system") or [])
                      if isinstance(b, dict) and b.get("cache_control"))
    return {"compact": True, "condition_met": True,
            "warmth_state": state, "history_hash": hhash, "history_depth": depth,
            "forced": force is not None,
            "removed_message_markers": len(removed), "removed": removed,
            "kept_system_markers": sys_markers}


# ---- STRIP PRIOR-TURN THINKING (experimental, off by default) -------------
# Remove `thinking`/`redacted_thinking` blocks from COMPLETED prior turns —
# every assistant message BEFORE the last real user-turn boundary. The CURRENT
# turn (everything at/after the last user TEXT message, including an in-flight
# tool-use loop) is left untouched: the API requires the signed thinking chain
# within the active tool cycle, but completed prior turns may legally omit it
# (the conclusion survives in the kept `text`/`tool_use` blocks). Wholesale
# REMOVAL (not in-place mutation) leaves no signature to verify, so it's clean.
# This changes the message prefix -> BUSTS the message cache from the first
# strip point (one-time per-turn re-cache, recouped by the perpetual cheaper
# reads). MONSTER GUARD: tool-output-dominated histories (body >> thinking) are
# the only money-losers — there the re-cache toll on the busted body outweighs
# the thinking-read reclaim. We skip those via a body/thinking ratio gate
# (STRIP_THINK_MAX_BODY_RATIO). Validated on captured opus sessions: large
# winners sit at body/thinking <= ~1; the single losing session sat at ~7.
STRIP_PRIOR_THINKING = os.environ.get("STRIP_PRIOR_THINKING", "0") not in ("0", "no", "off", "false")
# Skip stripping when prior body/thinking exceeds this. 0 / negative disables
# the gate (always strip).
try:
    STRIP_THINK_MAX_BODY_RATIO = float(os.environ.get("STRIP_THINK_MAX_BODY_RATIO", "4.0"))
except ValueError:
    STRIP_THINK_MAX_BODY_RATIO = 4.0

# STRIP LEVELS (per-session, consumer-tiered — mirrors clodex's Off / L1 / L2 / L3):
#   0 = off, 1 = L1 (prior-turn thinking only — the conservative, defensible tier
#   clodex already opts sessions into), 2 = L2 = L1 PLUS the shadier bust-RIDING
#   strips (failed-call stubbing + edit-ack collapse) PLUS READ+EDIT FOLD (apply
#   same-turn edits onto the Read buffer, stub the redundant edit; proxylab/
#   fold.py). L2 strictly contains L1 (the riders gate on busted_from); fold is
#   independent of the thinking bust but rides the SAME consumer opt-in channel,
#   so it's part of the L2 bundle, not a separate flag/table/directive. STRIP_L2
#   is the deployment default-level knob; per-session it's
#   `[wirescope:strip-thinking l2]` / `/_strip?level=2`. (L3 is RETIRED — fold
#   folded into L2 2026-06-20; `l3`/`level=3` inputs clamp to 2 for back-compat.)
STRIP_L2 = os.environ.get("STRIP_L2", "0") not in ("0", "no", "off", "false")

# COLLAPSE PRIOR-TURN EDIT/WRITE SUCCESS ACKS. An Edit/Write tool_result on
# success is fixed boilerplate (~155 ch) carrying ONE bit, "it succeeded", plus a
# "(file state is current… no need to Read it back)" nudge. That nudge is LIVE in
# the current turn but pure ballast in every COMPLETED prior turn. Collapsing it
# to "ok" reclaims the success bit (the file path is redundant — it's in the
# paired Edit tool_use). The content removal is deductively safe (no reuse bet, no
# reconstruction, no anchor), with two guards: (1) is_error FAILURES keep their
# text verbatim; (2) collapse ONLY a result whose tool_use was an edit tool AND
# whose body matches a known ack fragment (a wording change is a safe no-op).
#
# BUT the ECONOMICS are not free-standing. Collapsing an ack changes the message
# prefix at its position -> BUSTS the cache from there -> the whole downstream
# suffix re-writes at write-premium ONCE. That bust is ~$1 on a big window to
# reclaim only ~1.4k tok/turn of ack carriage -> breakeven ~1400 turns: a LOSS if
# the ack strip ORIGINATES the bust. It only pays as a FREE-RIDER: collapse acks
# ONLY inside a region the thinking-strip ALREADY busted this turn (at/after its
# earliest stripped index). There the suffix re-writes anyway, so the marginal
# invalidation is ZERO and the reclaim (smaller rewrite now + cheaper reads
# forever) is pure gain. So this is GATED on _strip_prior_thinking having fired,
# and confined to its busted region — never invalidates the current-turn cache on
# its own. (Measured live: on a thinking-OFF session it wrongly busted 174k to
# save ~1.4k — the exact loss this gate prevents.)
STRIP_PRIOR_EDIT_ACKS = os.environ.get("STRIP_PRIOR_EDIT_ACKS", "0") not in ("0", "no", "off", "false")
EDIT_ACK_MARKER = "ok"
# Tool names whose results are Edit/Write success acks across wire dialects.
_EDIT_TOOL_NAMES = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit",
                              "FileWrite", "FileEdit"})
# Distinctive fragments of the CLI's success boilerplate (path-independent). A
# result is an ack only if it CONTAINS one of these — defensive against a stray
# non-edit body that mentions the phrase, and forward-safe if wording changes.
_EDIT_ACK_FRAGMENTS = (
    "has been updated successfully",
    "File created successfully at:",
    "All occurrences were successfully replaced",
)

# STRIP PRIOR-TURN TOOL ERRORS (experimental, scratch-port A/B; OFF on :7800).
# A failed tool call (e.g. an Edit whose old_string didn't match) re-rides the
# wire forever as TWO fat paired blocks: the assistant `tool_use` (its `input`
# carries the whole old_string + new_string the model tried) and the user
# `tool_result` (`is_error`, echoing old_string back + a hint paragraph). In the
# turn it happened the error is load-bearing — it's how the model knows to
# re-Read and retry. But in a COMPLETED prior turn the recovery (read + corrected
# edit + its success ack) is already recorded downstream, so the failed call is a
# breadcrumb to a destination the transcript already reached: pure deadweight.
# We stub BOTH sides (paired by tool_use_id) — the model's framing ("the failed
# edit is discardable later") taken to its conclusion, since the assistant-side
# input is the larger half. Class+position only (any is_error before the
# boundary), never relational — byte-stable as the boundary advances, like the
# read/thinking strips. SAME economics as the edit-ack strip: stubbing busts the
# message cache from the strip point, so it pays ONLY as a FREE-RIDER inside the
# region the thinking-strip ALREADY busted this turn (busted_from..last_user);
# originating its own bust to reclaim bursty error text is the ~1400-turn loss.
STRIP_PRIOR_TOOL_ERRORS = os.environ.get("STRIP_PRIOR_TOOL_ERRORS", "0") not in ("0", "no", "off", "false")
ERROR_ELIDED_MARKER = "[Tool error elided: resolved in a later turn]"
# Constant stub for a failed call's assistant-side `input` (envelope id/type/name
# kept for pairing + API validity; only the args object is replaced). Byte-stable.
ERROR_CALL_STUB = {"_elided": "prior failed call, superseded"}

# PER-SESSION OVERRIDE of the global STRIP_PRIOR_THINKING flag, so a CONSUMER app
# (clodex) can opt INDIVIDUAL agents in (or out) while the proxy ships the flag
# globally OFF — the "marketing trick": stock proxy is conservative, the app
# turns the optimization on per session. Set via the `[wirescope:strip-thinking
# on|off]` directive (rides the same per-agent body/spawn channel as omit/tools)
# OR the POST /_strip endpoint. STICKY per session_id: once a directive is seen
# we remember it so it persists across the session's later (directive-less) turns.
# transforms OWNS + mutates this; the pinger sweep drops it via _ws_forget.
# NOT in-memory-only: mirrored to the strip_override table below and reloaded
# at boot (restore._restore_strip_overrides) — a restart dropping it would flip
# strip against a warm cache (the 95k–261k-tok bust). session_id -> int LEVEL
# (0/1/2; see STRIP LEVELS above). Legacy bool rows read back as 0/1.
_STRIP_OVERRIDE = {}

# PERSISTENCE (restart-amnesia / anti-flap): the per-session strip decision is
# mirrored to SQLite so a proxy restart RELOADS it BEFORE the first post-restart
# turn — otherwise the in-memory override is dropped, strip silently flips OFF,
# and the next request mismatches the still-warm stripped prefix -> a full-window
# premium re-write (measured: the single biggest cost driver — 95k–261k tok per
# involuntary flip). The cache only stays cheap if our control state is as durable
# as the cache it must agree with. Pure intent, nothing secret (same rationale as
# hold_state). Owner-scoped; reload lives in restore._restore_strip_overrides.
store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS strip_override ("
    "owner TEXT NOT NULL, session_id TEXT NOT NULL, "
    "enabled INTEGER NOT NULL, set_at REAL NOT NULL, "
    "PRIMARY KEY (owner, session_id))")


def _persist_strip_override(session_id, level):
    """Mirror a strip override LEVEL (0/1/2) to SQLite so a restart can't drop it
    (which would flip strip state against a warm cache and force a full re-write).
    The `enabled` column now stores the int level; legacy 0/1 rows still mean
    off/L1. A store failure degrades to the old in-memory-only behavior."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO strip_override(owner, session_id, enabled, set_at) "
                "VALUES(?,?,?,?) ON CONFLICT(owner, session_id) DO UPDATE SET "
                "enabled=excluded.enabled, set_at=excluded.set_at",
                (store_mod.OWNER, session_id, int(level), time.time()))
            con.commit()
    except Exception as e:
        print(f"[strip] persist failed for {session_id[:12]}…: {e}", flush=True)


def _delete_strip_override(session_id):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM strip_override WHERE owner=? AND session_id=?",
                        (store_mod.OWNER, session_id))
            con.commit()
    except Exception as e:
        print(f"[strip] row delete failed for {session_id[:12]}…: {e}", flush=True)


# STRIP-GUARD LATCH (anti-flap, v0.4.35): the monster guard used to recompute
# `prior_body / prior_think` EVERY turn and strip iff ratio <= MAX. On a session
# whose ratio wobbles across the threshold (thinking-sparse, tool-output-heavy —
# the ratio drifts as each turn adds body vs thinking) the decision FLIPPED turn
# to turn, and every flip changed the forwarded bytes -> busted the warm prefix
# from the first thinking position -> full-suffix re-write (measured live on
# clodex session ef043611: 4 mid-session busts, 42k/49k-tok floor-collapses).
# FIX: decide strip/no-strip ONCE per session and LATCH it (sticky), so it can't
# flip. COLD-GATE: the latch is only ESTABLISHED when the incoming thinking-prefix
# is NOT warm — so the first decision rides an unavoidable cold write and never
# ORIGINATES a warm bust (a latch that first-fired mid-warm-lineage would just
# relocate the bust). On a warm prefix with no latch we decline WITHOUT latching,
# leaving a later cold moment to make the durable call. Persisted like
# strip_override (a restart must not drop it and re-flip). Keyed by session_id;
# a CLI reload rotates the id -> fresh cold decision (correct).
_STRIP_GUARD_LATCH = {}

# Experimental kill knob (default OFF = Decision B: always strip from cold). When
# set, restores the old monster-ratio tiebreaker AT THE COLD DECISION ONLY (latch
# no-strip if ratio > MAX). For one-off A-vs-B experiments; NOT for production
# economics (cold-gating already removed the bust the ratio guarded against).
STRIP_GUARD_COLD_RATIO = os.environ.get("STRIP_GUARD_COLD_RATIO", "0") not in ("0", "no", "off", "false")

store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS strip_guard_latch ("
    "owner TEXT NOT NULL, session_id TEXT NOT NULL, "
    "strip INTEGER NOT NULL, set_at REAL NOT NULL, "
    "PRIMARY KEY (owner, session_id))")


def _persist_strip_guard_latch(session_id, strip):
    """Mirror a guard latch to SQLite so a restart reloads it BEFORE the first
    post-restart turn (else the latch drops, the guard recomputes, and it can
    re-flip against a still-warm prefix). Degrades to in-memory-only on failure."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO strip_guard_latch(owner, session_id, strip, set_at) "
                "VALUES(?,?,?,?) ON CONFLICT(owner, session_id) DO UPDATE SET "
                "strip=excluded.strip, set_at=excluded.set_at",
                (store_mod.OWNER, session_id, 1 if strip else 0, time.time()))
            con.commit()
    except Exception as e:
        print(f"[strip] guard-latch persist failed for {session_id[:12]}…: {e}", flush=True)


def _delete_strip_guard_latch(session_id):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM strip_guard_latch WHERE owner=? AND session_id=?",
                        (store_mod.OWNER, session_id))
            con.commit()
    except Exception as e:
        print(f"[strip] guard-latch delete failed for {session_id[:12]}…: {e}", flush=True)


def _strip_guard_set_latch(session_id, strip):
    """Latch the strip/no-strip decision for a session (in-memory + persisted)."""
    if not session_id:
        return
    _STRIP_GUARD_LATCH[session_id] = bool(strip)
    _persist_strip_guard_latch(session_id, bool(strip))


# ---- RIDER LATCH (L2 riders go full-range, v0.6.26) -------------------------
# The edit-ack collapse + tool-error stubs originally fired ONLY inside the
# region the thinking-strip busted in the SAME request (busted_from) — "never
# originate a bust, only ride one". A working /_compact bake broke that gate's
# premise (2026-07-08, first .25 restart): the bake (correctly thinking-only;
# stub/fold bake = durable-mutation risk class, folds_deferred) leaves acks RAW
# on disk while the live riders had stubbed them into the warm prefix; the
# resumed request then has NO prior thinking -> strip no-ops -> busted_from=None
# -> riders skip -> raw acks ship against the stub-carrying warm lineage ->
# conversation-class bust on EVERY L2 session at EVERY restart (measured:
# write 117,758/read 20,301 on e3a2b94f; twin bust on 27de24b2 — the two L2
# sessions; L1 sessions immune, bake⊆live-strip holds for thinking). The gate
# inverted its own purpose: with history arriving pre-thinned, RE-APPLYING the
# stubs is what KEEPS bytes identical to the warm prefix, and skipping is what
# originates the bust.
# FIX: once a session's riders have gone FULL-RANGE (latched, persisted,
# restored at boot), they fire on every request like fold does — a
# deterministic replay of the same decision, so live turns, restarts and baked
# resumes all produce identical bytes. ESTABLISHMENT is cold-gated (the same
# anti-flap pattern as the strip guard latch): full-range stubbing first
# changes bytes in regions a thinking bust never touched (raw acks in the warm
# lineage — including post-incident sessions whose bust re-wrote everything
# raw), so we expand only when no incoming prefix containing the first
# would-be-stubbed block is warm — the expansion then rides a write that was
# happening anyway. Until latched, the old free-rider behavior continues
# unchanged. Converges at each session's next cold moment; a consumer
# re-enables bake-on-resume only after its sessions carry the latch.
_RIDER_LATCH = {}

store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS rider_latch ("
    " owner TEXT NOT NULL, session_id TEXT NOT NULL,"
    " set_at REAL NOT NULL, PRIMARY KEY (owner, session_id))")


def _persist_rider_latch(session_id):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO rider_latch(owner, session_id, set_at) "
                "VALUES(?,?,?) ON CONFLICT(owner, session_id) DO NOTHING",
                (store_mod.OWNER, session_id, time.time()))
            con.commit()
    except Exception as e:
        print(f"[strip] rider-latch persist failed for {session_id[:12]}…: {e}", flush=True)


def _delete_rider_latch(session_id):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM rider_latch WHERE owner=? AND session_id=?",
                        (store_mod.OWNER, session_id))
            con.commit()
    except Exception as e:
        print(f"[strip] rider-latch delete failed for {session_id[:12]}…: {e}", flush=True)


def _first_rider_target_idx(msgs, last_user):
    """Index of the first message a FULL-RANGE rider pass would mutate: a user
    message with a raw (un-stubbed) edit-success ack, or either half of a raw
    failed call, strictly below last_user. None when history is already fully
    stubbed (or has nothing stubbable) — then expansion is a byte-neutral no-op."""
    edit_ids = _edit_result_ids(msgs)
    error_ids = {blk.get("tool_use_id")
                 for m in msgs[:last_user] if m.get("role") == "user"
                 and isinstance(m.get("content"), list)
                 for blk in m["content"]
                 if isinstance(blk, dict) and blk.get("type") == "tool_result"
                 and blk.get("is_error")}
    for i, m in enumerate(msgs[:last_user]):
        c = m.get("content")
        if not isinstance(c, list):
            continue
        if m.get("role") == "user":
            for blk in c:
                if not (isinstance(blk, dict) and blk.get("type") == "tool_result"):
                    continue
                body = blk.get("content")
                if blk.get("is_error"):
                    n = len(body) if isinstance(body, str) else len(json.dumps(body, default=str))
                    if body != ERROR_ELIDED_MARKER and n > len(ERROR_ELIDED_MARKER):
                        return i
                elif (blk.get("tool_use_id") in edit_ids
                        and isinstance(body, str) and body != EDIT_ACK_MARKER
                        and any(f in body for f in _EDIT_ACK_FRAGMENTS)
                        and len(body) > len(EDIT_ACK_MARKER)):
                    return i
        elif m.get("role") == "assistant":
            stub_len = len(json.dumps(ERROR_CALL_STUB, default=str))
            for blk in c:
                if (isinstance(blk, dict) and blk.get("type") == "tool_use"
                        and blk.get("id") in error_ids
                        and blk.get("input") != ERROR_CALL_STUB
                        and len(json.dumps(blk.get("input") or {}, default=str)) > stub_len):
                    return i
    return None


def _rider_full_range(obj, sid, agent_id=None):
    """(busted_from_for_riders, log_reason). Latched -> 0 (full range). Not
    latched: try to ESTABLISH — only for an L2 session whose thinking decision
    is already latched-strip (the stubs in its warm lineage are what full-range
    replays), and only when no incoming prefix containing the first
    would-be-stubbed block is warm (cold-gate: expansion rides an unavoidable
    write, never originates one). Anything else -> None (keep free-rider
    behavior; the caller may still pass the thinking-strip's busted_from)."""
    if sid is not None and sid in _RIDER_LATCH:
        return 0, "rider_latched"
    if sid is None or not _strip_l2_enabled(obj, agent_id):
        return None, None
    if not _STRIP_GUARD_LATCH.get(sid):
        return None, "no_strip_latch"      # thinking not latched-strip -> no stub lineage
    msgs = obj.get("messages") or []
    last_user = _settled_boundary(msgs)
    if last_user <= 0:
        return None, None
    first = _first_rider_target_idx(msgs, last_user)
    if first is None:
        # nothing a full-range pass would change: latch NOW for free (byte-
        # neutral) so future turns/restarts are covered before raw acks appear.
        _RIDER_LATCH[sid] = True
        _persist_rider_latch(sid)
        return 0, "rider_latched_neutral"
    warm = _incoming_thinking_prefix_warm(obj, first)
    if warm is None:
        return None, "rider_warmth_unknown"
    if warm:
        return None, "rider_warm_no_latch"
    _RIDER_LATCH[sid] = True
    _persist_rider_latch(sid)
    return 0, "rider_cold_latch"


def _incoming_thinking_prefix_warm(obj, earliest):
    """True iff some INCOMING (as-received, pre-strip) prefix that INCLUDES the
    first prior thinking block (depth > earliest) is warm — i.e. this exact
    unstripped byte-lineage carrying the thinking is already cached, so a strip
    would BUST it. Only depths > earliest differ between the stripped/unstripped
    forms; shallower prefixes (before any thinking) are byte-identical either way
    and MUST be excluded — counting them would misread an established STRIPPED
    lineage (whose shallow prefixes are warm too) as warm-unstripped and stop us
    stripping it, re-introducing the flap. Returns False on cold/absent (safe to
    strip: fresh, or an established stripped lineage whose unstripped bytes were
    never sent), None when the ledger can't judge. Batched query, mirrors
    _compact_history_warmth."""
    if not warmth_mod.WARMTH_LEDGER:
        return None
    msgs = obj.get("messages") or []
    depths = list(range(len(msgs) - 1, earliest, -1))   # prefixes that contain msg[earliest]
    if not depths:
        return False
    hashes = _prefix_hashes(obj)
    try:
        rows = warmth_mod._warmth_rows([hashes[d] for d in depths])
    except Exception:
        return None
    now = time.time()
    for d in depths:
        r = rows.get(hashes[d])
        if r and r[2] > now:
            return True
    return False


def _strip_thinking_guard_decision(obj, sid, ratio, earliest):
    """Sticky, cold-gated strip/no-strip decision (anti-flap). Returns
    (should_strip: bool, reason: str). Once latched per session the latch is
    reused verbatim, so the decision cannot flip turn-to-turn. The latch is only
    ESTABLISHED on a cold/absent incoming thinking-prefix (the first decision then
    rides an unavoidable cold write); on a warm prefix with no latch we decline
    without latching (don't bust; a later cold moment latches). The cold decision
    preserves the validated monster-ratio stance (ratio > MAX -> no-strip) — it
    just makes it sticky."""
    if sid is not None and sid in _STRIP_GUARD_LATCH:
        latched = _STRIP_GUARD_LATCH[sid]
        return latched, ("latched_strip" if latched else "latched_no_strip")
    # EXPLICIT PER-SESSION OVERRIDE = deliberate intent -> establish the latch NOW,
    # even on a warm prefix. An override is a sticky human/consumer choice; it does
    # NOT flap turn-to-turn like the automatic global ratio decision the cold-gate
    # guards, so honoring it immediately is safe and is exactly what the consumer
    # asked for. This is also the ONLY path that catches a session ALREADY at a
    # strip level before a latch existed (a deploy/restart reload, or a consumer
    # that asserts the level idempotently) — there's no "change" event to ride, so
    # without this it would decline warm_no_latch forever (the bug bogdan hit on a
    # warm L2 session post-v0.6.1). If we reach here the effective level is >=1, and
    # since an override is present that override is >=1 -> strip.
    if sid is not None and sid in _STRIP_OVERRIDE:
        _strip_guard_set_latch(sid, True)
        return True, "override_latch_strip"
    warm = _incoming_thinking_prefix_warm(obj, earliest)
    if warm is None:            # ledger can't judge -> conservative: don't strip, don't latch
        return False, "warmth_unknown"
    if warm:                    # established warm (unstripped) lineage -> don't originate a bust
        return False, "warm_no_latch"
    # COLD/ABSENT: make the durable decision now (rides the cold write) + latch it.
    # DECISION B (clodex, v0.4.35): always strip from cold. The old monster-ratio
    # tiebreaker (ratio > MAX -> no-strip) existed SOLELY to avoid a warm re-cache
    # bust; cold-gating already eliminates that bust, so the ratio is vestigial at
    # the cold decision point. Stripping from cold is free reclaim even on
    # tool-heavy (thinking-sparse) sessions — small-but-positive, never a loss —
    # and it makes a consumer's explicit L1 opt-in actually take effect everywhere
    # instead of silently no-op'ing on the heavy sessions they'd most want it on.
    # `ratio` is still recorded for observability. (If the strip on/off QUALITY
    # A/B ever shows stripping hurts tool-heavy sessions, that's a quality
    # special-case on quality evidence — NOT a reason to revive the economics
    # ratio.) STRIP_THINK_MAX_BODY_RATIO is retained only as the ratio>0 legacy
    # kill knob below for one-off experiments; default path always strips.
    decision = True
    if STRIP_GUARD_COLD_RATIO and STRIP_THINK_MAX_BODY_RATIO > 0 and ratio > STRIP_THINK_MAX_BODY_RATIO:
        decision = False        # experimental opt-in only (default off): old A behavior
    _strip_guard_set_latch(sid, decision)
    return decision, ("cold_latch_strip" if decision else "cold_latch_no_strip")


def _ws_resolve_strip_thinking(pairs):
    """Last `strip-thinking <off|on|l1|l2>` directive in the merged pair stream
    wins -> an int LEVEL (0/1/2), or None if none present. `on`/`l1`/`1` = L1
    (thinking only, the back-compat value clodex emits today); `l2`/`2` = L2
    (L1 + the bust-riders + read/edit fold); `off`/`0` = level 0; bare directive
    = L1. `l3`/`3` is accepted as a back-compat ALIAS for L2 (fold moved into L2
    2026-06-20; L3 retired). Vocabulary lives here next to the resolvers."""
    val = None
    for name, value in pairs:
        if name == "strip-thinking":
            v = (value or "").strip().lower()
            if v in ("", "on", "1", "true", "yes", "l1"):
                val = 1
            elif v in ("off", "0", "false", "no"):
                val = 0
            elif v in ("l2", "2", "l3", "3"):   # l3/3 = back-compat alias for L2
                val = 2
    return val


def _global_strip_level():
    """Deployment default level when a session has no override: 2 if STRIP_L2
    (L1 thinking + the bust-riders + read/edit fold), else 1 if
    STRIP_PRIOR_THINKING, else 0."""
    return 2 if STRIP_L2 else (1 if STRIP_PRIOR_THINKING else 0)


def _strip_thinking_set_override(session_id, level):
    """Endpoint/programmatic setter for the per-session override LEVEL: an int
    0/1/2 (or True/False = 1/0 for the legacy `on=` API), or None to clear ->
    fall back to the global default. Returns the effective stored value (None when
    cleared). Level is clamped to 0..2 (L2 = bust-riders + read/edit fold; a
    legacy 3 clamps to 2 — L3 retired 2026-06-20).

    DELIBERATE-FLIP -> ESTABLISH THE GUARD LATCH NOW. An explicit per-session
    level CHANGE (this endpoint / a directive) is the "flip once on purpose" case
    the cold-gate was NEVER meant to block: cold-gating exists to stop the
    AUTOMATIC ratio decision from surprise-busting a warm prefix, not to veto user
    intent. So on a genuine change we set the guard latch immediately (enable>=1 ->
    strip; disable 0 -> no-strip) so the new level takes effect on the very next
    turn even on a WARM prefix — eating the one-time re-cache the user asked for,
    instead of silently no-op'ing until the cache happens to go cold. A clear drops
    the latch too, so the global-default cold-gated decision re-decides fresh. The
    automatic/global path never routes through here, so its cold-gate is untouched."""
    if not session_id:
        return None
    if level is None:
        _STRIP_OVERRIDE.pop(session_id, None)
        _delete_strip_override(session_id)
        _STRIP_GUARD_LATCH.pop(session_id, None)
        _delete_strip_guard_latch(session_id)
        _RIDER_LATCH.pop(session_id, None)
        _delete_rider_latch(session_id)
        return None
    prev = _STRIP_OVERRIDE.get(session_id)
    lvl = max(0, min(2, int(level)))     # True->1, False->0 via int(); 3->2
    _STRIP_OVERRIDE[session_id] = lvl
    _persist_strip_override(session_id, lvl)
    if prev != lvl:                      # genuine deliberate change -> latch now
        _strip_guard_set_latch(session_id, lvl >= 1)
        # Any level CHANGE drops the rider latch: a demoted-then-repromoted
        # session accumulates raw acks in its warm lineage while below L2, so
        # a stale full-range latch would bust on re-promotion. Cold-gated
        # establishment re-decides at the session's next cold moment.
        if _RIDER_LATCH.pop(session_id, None) is not None:
            _delete_rider_latch(session_id)
    return lvl


def _strip_level(obj, agent_id=None):
    """Resolve the effective strip LEVEL (0/1/2) for THIS request: a
    `[wirescope:strip-thinking <off|on|l2>]` directive (body+spawn, sticky per
    session) or a /_strip override takes precedence; otherwise the global default
    level. A seen directive updates the sticky store (on CHANGE only — this runs
    several times per request). Reads body+spawn pairs directly so it never
    perturbs _WS_SPAWN_MEMORY."""
    sid = (writer_mod._session_ids(obj) or [None])[0] if isinstance(obj, dict) else None
    if isinstance(obj, dict):
        pairs = writer_mod._ws_body_pairs(obj) + writer_mod._ws_spawn_pairs(obj)
        directive = _ws_resolve_strip_thinking(pairs)
        if sid and directive is not None and _STRIP_OVERRIDE.get(sid) != directive:
            _strip_thinking_set_override(sid, directive)
    if sid is not None and sid in _STRIP_OVERRIDE:
        return _STRIP_OVERRIDE[sid]
    return _global_strip_level()


def _strip_thinking_enabled(obj, agent_id=None):
    """L1+ gate: prior-thinking stripping is ON when the effective level >= 1.
    (Kept as the public name; the chain calls this both to decide and to persist
    the resolved directive before the line is stripped from the wire.)"""
    return _strip_level(obj, agent_id) >= 1


def _strip_l2_enabled(obj, agent_id=None):
    """L2 gate: the bust-riding tool-result strips (failed-call stubbing, edit-ack
    collapse) AND the READ+EDIT FOLD all run when the effective level >= 2 (or
    their own scratch-A/B global flag is set — checked by the callers). Fold's
    ONLY gate (no separate flag/table/directive). Because _strip_level resolves
    the per-session directive/override EARLY in the chain (via
    _strip_thinking_enabled, before _ws_strip_directives removes the line), fold
    sees the resolved level by the time it runs — the directive-before-strip race
    that bit fold's old standalone gate cannot recur."""
    return _strip_level(obj, agent_id) >= 2


def _is_real_user_turn(m):
    """A genuine user-turn boundary: role=user carrying actual text (NOT a
    message that is solely tool_result blocks — that's mid-turn tool-loop
    plumbing, part of the CURRENT turn)."""
    if not isinstance(m, dict) or m.get("role") != "user":
        return False
    c = m.get("content")
    if isinstance(c, str):
        return bool(c.strip())
    if isinstance(c, list):
        return any(isinstance(b, dict) and b.get("type") == "text" for b in c)
    return False


def _settled_boundary(msgs, upto=None):
    """THE settled/current-turn boundary: index of the last real user turn
    (everything strictly before it is completed prior history; everything at/
    after it is the CURRENT turn). Single source of truth shared by every
    prior-turn strip AND the settled-breakpoint pin (which anchors one boundary
    EARLIER via `upto` — the last real user turn of the settled region) — they
    MUST agree, or the pin lands inside the volatile region and silently
    reverts resume anchoring to the msg0 collapse. Never inline this
    computation. `upto`: consider only indices strictly below it."""
    it = enumerate(msgs) if upto is None else enumerate(msgs[:upto])
    return max((i for i, m in it if _is_real_user_turn(m)), default=-1)


def _msg_thinking_chars(m):
    """Thinking-block chars (text/redacted-data + signature) in a message — the
    full wire footprint a strip removes."""
    c = m.get("content")
    t = 0
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") in ("thinking", "redacted_thinking"):
                t += (len(b.get("thinking") or "") + len(b.get("data") or "")
                      + len(b.get("signature") or ""))
    return t


def _msg_nonthinking_chars(m):
    """Surviving 'body' chars: text + tool_use input + tool_result content —
    everything a strip leaves behind (and that a bust would re-cache)."""
    c = m.get("content")
    if isinstance(c, str):
        return len(c)
    t = 0
    if isinstance(c, list):
        for b in c:
            if not isinstance(b, dict):
                continue
            ty = b.get("type")
            if ty in ("thinking", "redacted_thinking"):
                continue
            if ty == "text":
                t += len(b.get("text") or "")
            elif ty == "tool_use":
                try:
                    t += len(json.dumps(b.get("input") or {}))
                except (TypeError, ValueError):
                    pass
            elif ty == "tool_result":
                cc = b.get("content")
                t += len(cc) if isinstance(cc, str) else len(json.dumps(cc, default=str))
    return t


def _strip_prior_thinking(obj, agent_id=None):
    """Drop thinking blocks from assistant messages in COMPLETED prior turns
    (strictly before the last real user-turn boundary), unless the monster guard
    declines. Gated by the PER-SESSION decision (directive/endpoint override else
    the global flag — see _strip_thinking_enabled). Returns a log dict (`stripped`
    True/False) or None (disabled / no prior history / no prior thinking)."""
    if not isinstance(obj, dict) or not _strip_thinking_enabled(obj, agent_id):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_user = _settled_boundary(msgs)
    if last_user <= 0:
        return None                       # no prior turn before the current one
    prior = msgs[:last_user]
    prior_think = sum(_msg_thinking_chars(m) for m in prior if m.get("role") == "assistant")
    if not prior_think:
        return None                       # no prior thinking to strip
    prior_body = sum(_msg_nonthinking_chars(m) for m in prior)
    ratio = round(prior_body / prior_think, 2)
    # First prior thinking index = where a strip would first change bytes (the
    # bust point). Needed for the cold-gate warmth check below + edit-ack riding.
    first_think = next((i for i, m in enumerate(prior)
                        if m.get("role") == "assistant" and _msg_thinking_chars(m)), None)
    # STICKY COLD-GATED GUARD (anti-flap): decide once per session, latch it, and
    # only establish the latch on a cold prefix (so it never originates a warm
    # bust). Replaces the per-turn ratio recompute that flapped across the
    # threshold and busted warm prefixes.
    sid = (writer_mod._session_ids(obj) or [None])[0]
    should_strip, decision_reason = _strip_thinking_guard_decision(
        obj, sid, ratio, first_think if first_think is not None else 0)
    if not should_strip:
        return {"stripped": False, "skipped_reason": decision_reason,
                "body_thinking_ratio": ratio, "max_body_ratio": STRIP_THINK_MAX_BODY_RATIO,
                "guard_latch": _STRIP_GUARD_LATCH.get(sid),
                "prior_thinking_chars": prior_think, "prior_body_chars": prior_body,
                "boundary_idx": last_user, "total_messages": len(msgs)}
    removed = stripped_chars = touched_msgs = 0
    earliest = None                       # first message index busted -> the
                                          # already-invalidated region edit-acks ride
    for i, m in enumerate(msgs):
        if i >= last_user or m.get("role") != "assistant":
            continue
        c = m.get("content")
        if not isinstance(c, list):
            continue
        kept, msg_removed, msg_chars = [], 0, 0
        for blk in c:
            if isinstance(blk, dict) and blk.get("type") in ("thinking", "redacted_thinking"):
                msg_chars += len(blk.get("thinking") or "") + len(blk.get("signature") or "")
                msg_removed += 1
                continue
            kept.append(blk)
        if msg_removed and kept:          # never leave an empty content array (would 400)
            m["content"] = kept
            removed += msg_removed
            stripped_chars += msg_chars
            touched_msgs += 1
            if earliest is None:
                earliest = i
    if not removed:
        return None
    return {"stripped": True, "removed_thinking_blocks": removed, "touched_messages": touched_msgs,
            "stripped_chars": stripped_chars, "body_thinking_ratio": ratio,
            "guard_latch": _STRIP_GUARD_LATCH.get(sid), "guard_reason": decision_reason,
            "earliest_idx": earliest,     # edit-ack strip rides this bust point
            "boundary_idx": last_user, "total_messages": len(msgs)}


# MID-TURN THINKING STRIP — part of how the L-levels WORK (no separate tier):
# an L1+ session strips thinking inside the current turn too, one round after
# each block is CONSUMED (the API's signature requirement binds on the LAST
# assistant message only — wire-proven 2026-07-20 on sonnet-5/opus-4-8/
# fable-5 incl. interleaved-thinking; the moment a later assistant message
# exists, a block is deletable). Deletion only, never signature edits.
# Paired with the MARKER GATE below (Bogdan's placement rule, 2026-07-20,
# REPLACING the op-1 pin): doomed thinking is never cached in the first
# place, so stripping it never invalidates anything — which also retires the
# sparse-texture ROI gate (the 30x-negative case only existed because the
# doomed block had been written at premium before the strip busted it).
# `STRIP_MIDTURN_THINKING` is a KILL SWITCH (default on; real gate = the
# per-session strip level, same as the settled-region strip): set =0 to
# revert L-level sessions to settled-only stripping.
STRIP_MIDTURN_THINKING = os.environ.get("STRIP_MIDTURN_THINKING", "1") not in ("0", "no", "off", "false")


def _midturn_strip_active(obj, agent_id=None):
    """ONE gate for the mid-turn strip AND its pin (they must agree): kill
    switch on, session at L1+, and not durably latched no-strip (a latched
    no-strip session keeps its unstripped lineage everywhere — mid-turn
    deletions would desync the current turn from the settled region's
    decision). No latch yet (fresh/cold session) does not block: the current
    turn's rounds are the freshest bytes on the wire."""
    if not STRIP_MIDTURN_THINKING or not isinstance(obj, dict):
        return False
    if not _strip_thinking_enabled(obj, agent_id):
        return False
    sid = (writer_mod._session_ids(obj) or [None])[0]
    if sid and _STRIP_GUARD_LATCH.get(sid) is False:
        return False
    return True

# MID-TURN MARKER GATE — Bogdan's placement rule (2026-07-20), REPLACING the
# op-1 pin and its whole donor/ladder apparatus. The insight: the CLI's own
# rolling tail marker is the only mobile marker the turn needs; the proxy's
# job is a single per-request placement decision, not marker management.
#   - Last assistant message carries thinking (a DOOMED block — it is
#     stripped the moment it stops being last): letting the tail marker
#     stand would cache that block at write premium one round before we
#     delete it, and the deletion then invalidates the entry and re-writes
#     the span (the AB2 churn: T4 reqs 056-059 carried the kept block at 5m
#     for three rounds, then re-wrote 34..39 when the strip fired). Instead
#     RELOCATE the tail marker to the last STABLE message, just below the
#     doomed block: the skeleton delta is written once at 5m, the doomed
#     thinking is read exactly once at 1x, and nothing is ever invalidated.
#   - Last assistant message clean: everything below the tail is post-strip
#     skeleton, byte-stable next round -> the CLI's marker stands untouched
#     (byte-stock wire).
# No second marker, no donors, no TTL ladder: the budget can only shrink, so
# the anchor-steal / budget_full / 1h-after-5m defect class is structurally
# unreachable. The relocated marker KEEPS the CLI's own ttl (2026-07-20
# correction: no 5m anywhere — scrap pricing only made sense when the old
# cross-turn strip discarded the whole frontier; in-turn stripping discards
# nothing, the span below the marker is durable, so the marker is simply the
# CLI's 1h marker advanced or held back a step — the no-strip layout).
# Skeleton entries survive INTO the turn transition:
# the final doomed block was never cached, so the transition request hits the
# last relocated entry exactly. Gate predicate depends only on the LAST
# assistant message, which the strip never touches -> strip/gate ordering
# cannot desync (the 4a0521e bug class needs no strip_rec plumbing here).
MIDTURN_MARKER_GATE = os.environ.get("MIDTURN_MARKER_GATE", "1") not in (
    "0", "no", "off", "false")
# Sub-switch (default on) for the CLI-omitted-tail FALLBACK only — the rest of
# the gate (relocate/drop) is unaffected. `=0` isolates the fallback for the A/B
# control arm (860b059 gate WITH vs WITHOUT the seq092 fix, single variable).
MIDTURN_TAIL_FALLBACK = os.environ.get("MIDTURN_TAIL_FALLBACK", "1") not in (
    "0", "no", "off", "false")
# OWNED MOBILE MARKER (2026-07-21, Bogdan's "the marker position should be a
# wirescope decision, not an accident of what the CLI sent"). When on, REPLACES
# the reactive _midturn_marker_gate: wirescope computes the mobile marker's
# position itself (deepest safe frontier), PERSISTS it per session in SQLite, and
# re-places it at the same content-anchor next request / after a restart — so the
# still-warm API entry is an EXACT re-hit instead of a cold read of content we
# could have kept cached. Default OFF so the reactive gate stays the A/B control.
# See scratchpad_marker_design.md for the full rationale.
OWN_MOBILE_MARKER = os.environ.get("OWN_MOBILE_MARKER", "0") not in (
    "0", "no", "off", "false")


def _last_assistant_idx(msgs):
    """Index of the LAST assistant message (or None). The 'live frontier' pivot
    shared by the current-turn strips + the marker gate: thinking is LIVE only
    at this index (the API signature requirement binds here and only here); an
    error is LIVE only AFTER this index (a frontier tool_result the model hasn't
    reacted to yet). Everything below it is CONSUMED — a later assistant message
    exists, so it has already had its reaction and is deletable/stubbable. Shared
    helper (no inline `max((i for` recompute) so the strips and the gate agree on
    the frontier by construction."""
    return max((i for i in range(len(msgs))
                if isinstance(msgs[i], dict) and msgs[i].get("role") == "assistant"),
               default=None)


def _midturn_targets(msgs, boundary):
    """(targets, protected_idx, think_idx) for the current turn. think_idx =
    thinking-bearing assistant messages after the settled boundary;
    protected_idx = the LAST assistant message of the turn iff it carries
    thinking (the API's signature requirement binds there and ONLY there —
    wire-proven 2026-07-20); targets = every other thinking-bearing message:
    consumed the moment a later assistant message exists, deletable one round
    after they were paid for. No texture gate (2026-07-20 redesign): the
    marker gate keeps doomed thinking out of cache entirely, so a strip never
    invalidates a cached span and sparse-texture ROI cannot go negative.
    Eligibility 'no longer the last assistant message' is monotone (once
    outrun, forever outrun) -> deterministic re-strip across rounds."""
    last_asst = max((i for i in range(boundary + 1, len(msgs))
                     if msgs[i].get("role") == "assistant"), default=None)
    think_idx = [i for i in range(boundary + 1, len(msgs))
                 if msgs[i].get("role") == "assistant" and _msg_thinking_chars(msgs[i])]
    protected = last_asst if last_asst in think_idx else None
    targets = [i for i in think_idx if i != last_asst]
    return targets, protected, think_idx


def _strip_midturn_thinking(obj, agent_id=None):
    """Inside the CURRENT turn (at/after the settled boundary), delete
    thinking blocks from every consumed thinking-bearing assistant message —
    everything except the last assistant message (_midturn_targets). Prior
    turns untouched (that's _strip_prior_thinking's region). Whole-block
    deletion only — signatures never edited. Gated per-session via
    _midturn_strip_active (L1+, same channel as the settled strip). Returns a
    log dict or None."""
    if not _midturn_strip_active(obj, agent_id):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    boundary = _settled_boundary(msgs)
    targets, protected, think_idx = _midturn_targets(msgs, boundary)
    if not targets:
        return None                       # nothing consumed yet
    removed = stripped_chars = touched = 0
    for i in targets:
        c = msgs[i].get("content")
        if not isinstance(c, list):
            continue
        kept = [b for b in c if not (isinstance(b, dict)
                and b.get("type") in ("thinking", "redacted_thinking"))]
        if kept and len(kept) < len(c):   # never leave an empty content array
            stripped_chars += _msg_thinking_chars(msgs[i])
            removed += len(c) - len(kept)
            msgs[i]["content"] = kept
            touched += 1
    if not removed:
        return None
    return {"stripped": True, "removed_thinking_blocks": removed,
            "touched_messages": touched, "stripped_chars": stripped_chars,
            "protected_idx": protected, "boundary_idx": boundary,
            "current_turn_thinking_msgs": len(think_idx),
            "total_messages": len(msgs)}


def _plant_fallback_marker(obj, msgs, target_idx, boundary):
    """Place a cache_control marker on msgs[target_idx]'s last block — used when
    the CLI OMITTED its rolling tail marker (both the clean-tail and live-tail
    fallbacks share this). `target_idx` is the last STABLE / byte-final message
    the marker should ride (the frontier on a clean tail; halt = just below the
    lowest live block on a live tail). At full budget, FREE a slot by migrating
    the shallowest MESSAGE marker strictly ABOVE the settled boundary (the msg0
    bundle / cross-instance anchor — redundant here since the pin anchor at the
    boundary is a deeper superset for THIS session's reads; "#3 should follow #4
    or not be there", Bogdan 2026-07-21). Never touches a system marker (share
    anchors) or the pin anchor (idx == boundary, the resume entry). Returns
    (placed_bool, info) — info carries ttl/donor_idx/converted_string on success
    or {reason} on decline. Idempotent envelope: ttl mirrors the deepest existing
    marker (cache order forbids 1h after 5m and ours is the deepest block)."""
    tgt = msgs[target_idx]
    c = tgt.get("content")
    needs_convert = isinstance(c, str) and bool(c)
    markable = needs_convert or (
        isinstance(c, list) and c and isinstance(c[-1], dict)
        and not c[-1].get("cache_control"))
    if not markable:
        return False, {"reason": "unmarkable"}
    all_markers = _cache_markers(obj)
    ttl = "5m"
    if all_markers:
        lastcc = all_markers[-1][2].get("cache_control")
        if isinstance(lastcc, dict) and lastcc.get("ttl"):
            ttl = lastcc["ttl"]
    donor_idx = None
    if len(all_markers) >= _CACHE_BREAKPOINT_BUDGET:
        # Free a slot from a MESSAGE marker strictly ABOVE the settled boundary
        # (never a system marker = cross-instance share anchor; never the pin,
        # which sits AT the boundary). The msg0 bundle IS the cross-instance
        # CLAUDE.md share anchor, so make it the LAST RESORT (clodex 2026-07-21):
        # prefer any OTHER below-boundary message marker; only sacrifice msg0 when
        # it is the sole donor. In today's layout (2 sys + msg0 + pin) msg0 is the
        # only candidate, so this is future-proofing — but it guarantees we never
        # drop the share anchor while a redundant donor exists.
        cands = [i for r, i, blk in all_markers if r == "messages" and i < boundary]
        donor_idx = next((i for i in cands if i != 0), None)
        if donor_idx is None:
            donor_idx = next((i for i in cands if i == 0), None)
        if donor_idx is None:
            return False, {"reason": "budget_full_no_donor"}
        donor_blk = next(blk for r, i, blk in all_markers
                         if r == "messages" and i == donor_idx)
        donor_blk.pop("cache_control", None)
    if needs_convert:
        tgt["content"] = [{"type": "text", "text": c}]
    tgt["content"][-1]["cache_control"] = {"type": "ephemeral", "ttl": ttl}
    return True, {"ttl": ttl, "donor_idx": donor_idx,
                  "converted_string": needs_convert}


def _live_blocks(obj, msgs, boundary, agent_id):
    """The CURRENT turn's LIVE block indices — blocks the model still owes a
    reaction to, which a later turn will delete or stub, so a cache marker must
    never anchor them. Single source of truth shared by _midturn_marker_gate AND
    _own_mobile_marker (they MUST agree — a mismatch is exactly how a raw block
    gets marker-anchored then busted). Three classes (2026-07-20 generalization):
    (a) THINKING in the last assistant message; (b) the lowest frontier is_error
    tool_result after it (only when the error strip is active); (c) the lowest
    frontier EDIT-ACK tool_result after it that _strip_consumed_edit_acks will
    collapse (SAME predicate as the strip). Returns
    (last_asst_idx | None, live_sorted, live_err_idx | None, live_ack_idx | None);
    live is lowest-first."""
    last_asst = max((i for i in range(boundary + 1, len(msgs))
                     if msgs[i].get("role") == "assistant"), default=None)
    if last_asst is None:
        return None, [], None, None       # transition / turn-first: stock wire
    live = []
    live_err_idx = live_ack_idx = None
    if _msg_thinking_chars(msgs[last_asst]):
        live.append(last_asst)            # (a) protected thinking
    if STRIP_PRIOR_TOOL_ERRORS or _strip_l2_enabled(obj, agent_id):
        # (b) frontier error: the lowest user tool_result AFTER last_asst that
        # carries an is_error (only meaningful when the error strip is active —
        # otherwise nothing will stub it, so there is nothing to protect).
        for j in range(last_asst + 1, len(msgs)):
            m = msgs[j]
            if (isinstance(m, dict) and m.get("role") == "user"
                    and isinstance(m.get("content"), list)
                    and any(isinstance(b, dict) and b.get("type") == "tool_result"
                            and b.get("is_error") for b in m["content"])):
                live.append(j)
                live_err_idx = j
                break
    if STRIP_PRIOR_EDIT_ACKS or _strip_l2_enabled(obj, agent_id):
        # (c) frontier EDIT-ACK: the lowest user tool_result AFTER last_asst that
        # _strip_consumed_edit_acks WILL collapse to "ok" once it is consumed.
        # SAME predicate as the strip (edit_ids pairing + fragment match) so gate
        # and strip never disagree — a mismatch is exactly how the raw ack gets
        # marker-anchored then busted. Only meaningful when the ack strip is active.
        _eids = _edit_result_ids(msgs)
        if _eids:
            for j in range(last_asst + 1, len(msgs)):
                m = msgs[j]
                if not (isinstance(m, dict) and m.get("role") == "user"
                        and isinstance(m.get("content"), list)):
                    continue
                if any(isinstance(b, dict) and b.get("type") == "tool_result"
                       and b.get("tool_use_id") in _eids
                       and not b.get("is_error")
                       and isinstance(b.get("content"), str)
                       and b["content"] != EDIT_ACK_MARKER
                       and any(f in b["content"] for f in _EDIT_ACK_FRAGMENTS)
                       for b in m["content"]):
                    live.append(j)
                    live_ack_idx = j
                    break
    return last_asst, sorted(live), live_err_idx, live_ack_idx


def _midturn_marker_gate(obj, agent_id=None):
    """The placement decision (see block comment above): never let the CLI's
    rolling tail marker cache a LIVE block — one the model still owes a reaction
    to and that a later turn will therefore delete or stub. Three live classes
    (2026-07-20 generalization, Bogdan): (a) THINKING in the last assistant
    message (stripped the moment it stops being last), (b) a frontier ERROR
    tool_result AFTER the last assistant message (stubbed the moment the model
    reacts to it), and (c) a frontier EDIT-ACK tool_result after the last
    assistant message (collapsed to "ok" the moment it is consumed) —
    'if current_block is thinking or error or edit-ack, don't write marker'.
    (c) added 2026-07-20 after a live read-drop trace: the CLI's rolling marker
    lands on the fresh frontier ack, caches it RAW, and the next turn's collapse
    mutates the block that marker anchors -> the whole segment behind it busts
    (seq10->11: msg17 ack, read 46,191->38,980, 7.2k tok lost).
    Pull the tail marker back to the last stable message below the LOWEST live
    block (or drop it on the turn's first round, where the boundary anchor
    already covers everything stable). Clean-tail rounds and transition requests
    return None — byte-stock. Every message marker ABOVE the halt point is
    removed (any would cache a doomed byte). Returns a log dict or None."""
    if not MIDTURN_MARKER_GATE or not _midturn_strip_active(obj, agent_id):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    boundary = _settled_boundary(msgs)
    last_asst, live, live_err_idx, live_ack_idx = _live_blocks(
        obj, msgs, boundary, agent_id)
    if last_asst is None:
        return None                       # transition / turn-first: stock wire
    if not live:
        # CLEAN TAIL: normally the CLI's rolling marker sits on the last message
        # and we leave it (byte-stock). But the CLI sometimes OMITS its rolling
        # tail marker on a clean tail too (seen live 2026-07-21, arm-a seq26/seq39:
        # full budget = 2 sys + msg0 bundle + pin@boundary, NO rolling tail -> the
        # consumed in-turn rounds ABOVE the settled boundary re-read UNCACHED,
        # in=3354/5775). Same class as the live-tail fallback below, clean variant.
        # Fix (Bogdan 2026-07-21, "#3 should follow #4 inside the current turn or
        # not be there"): plant a marker on the last message = where the CLI's
        # rolling marker would have gone. The whole tail is consumed/byte-final on
        # a clean tail (no live thinking/error/ack by construction), so it never
        # mutates-after-caching. When full budget, SACRIFICE the msg0 bundle marker
        # (the cross-instance share anchor -> redundant here: the pin anchor at the
        # boundary is a deeper superset for THIS session's reads) by migrating it
        # forward. Never steal a system marker or the pin anchor.
        if not MIDTURN_TAIL_FALLBACK:
            return None
        msg_mark_idxs = [i for r, i, b in _cache_markers(obj) if r == "messages"]
        deepest = max(msg_mark_idxs) if msg_mark_idxs else -1
        if deepest > boundary:
            return None                   # CLI's rolling tail is present -> stands
        tail_idx = len(msgs) - 1
        if tail_idx <= boundary:
            return None                   # settled anchor already covers everything
        ok, info = _plant_fallback_marker(obj, msgs, tail_idx, boundary)
        if not ok:
            return {"acted": False, "reason": "clean_tail_" + info["reason"],
                    "last_asst_idx": last_asst, "boundary_idx": boundary}
        return {"acted": True, "mode": "clean_tail_fallback", "tail_idx": tail_idx,
                "last_asst_idx": last_asst, "boundary_idx": boundary,
                "total_messages": len(msgs), **info}
    lowest_live = min(live)
    marked = [(i, blk) for i, m in enumerate(msgs) if isinstance(m, dict)
              for blk in (m.get("content") if isinstance(m.get("content"), list) else [])
              if isinstance(blk, dict) and blk.get("cache_control")]
    halt = lowest_live - 1                # >= boundary by construction
    if not marked or marked[-1][0] <= boundary:
        # The CLI shipped NO rolling tail marker in the current turn (seen live
        # 2026-07-21: ~1/32 turns the CLI just omits it, for whatever reason).
        # With pin_settled also declined (boundary at msg0, still one user-turn),
        # nothing anchors the turn's STABLE consumed prefix -> the cache floor
        # collapses to msg0 and the whole in-turn tail re-reads cold (seq092:
        # read 44.5k->37.5k, 8.2k tail uncached, self-heals next turn when the
        # CLI resumes marking). FALLBACK (Bogdan 2026-07-21, "if the CLI omits
        # it, for whatever reason, we shouldn't [leave the tail uncached]"): if
        # there IS a stable message below the lowest live block, PLACE our own
        # marker there (halt) -- exactly where the CLI marker would have sat.
        # halt is consumed + byte-final (the consumed strips ran before us) so it
        # never mutates-after-caching = no bust. When budget is full (env's msg0
        # bundle + a pin anchor both present, e.g. arm-a seq46 in=4796), free a
        # slot by migrating the msg0 bundle forward (see _plant_fallback_marker).
        # Decline when halt is at/below the boundary anchor (already covered),
        # unmarkable, or no donor at full budget.
        if MIDTURN_TAIL_FALLBACK and halt > boundary:
            ok, info = _plant_fallback_marker(obj, msgs, halt, boundary)
            if ok:
                return {"acted": True, "mode": "tail_fallback", "halt_idx": halt,
                        "protected_idx": last_asst, "lowest_live_idx": lowest_live,
                        "boundary_idx": boundary,
                        "live_error": live_err_idx is not None,
                        "live_edit_ack": live_ack_idx is not None,
                        "total_messages": len(msgs), **info}
        return {"acted": False, "reason": "no_inturn_tail_marker",
                "protected_idx": last_asst, "lowest_live_idx": lowest_live,
                "boundary_idx": boundary}
    if marked[-1][0] <= halt:
        # marker already sits below the lowest live block — nothing live is
        # cached; leave placement alone.
        return {"acted": False, "reason": "tail_below_protected",
                "tail_idx": marked[-1][0], "protected_idx": last_asst,
                "lowest_live_idx": lowest_live}
    tail_ttl = (marked[-1][1].get("cache_control") or {}).get("ttl") or "5m"
    dropped = 0
    for i, blk in marked:
        if i > halt:
            blk.pop("cache_control", None)
            dropped += 1
    log = {"acted": True, "tail_idx": marked[-1][0], "halt_idx": halt,
           "protected_idx": last_asst, "lowest_live_idx": lowest_live,
           "live_error": live_err_idx is not None,
           "live_edit_ack": live_ack_idx is not None, "boundary_idx": boundary,
           "markers_dropped": dropped, "total_messages": len(msgs)}
    if halt <= boundary:
        # first round of the turn: the boundary anchor (settled pin, advanced)
        # already covers the stable prefix — dropping the tail is the whole job.
        log["mode"] = "dropped"
        return log
    tgt = msgs[halt]
    c = tgt.get("content")
    needs_convert = isinstance(c, str) and bool(c)
    if not needs_convert and (
            not isinstance(c, list) or not c or not isinstance(c[-1], dict)):
        log["mode"], log["reason"] = "dropped", "unmarkable_halt"
        return log
    if not needs_convert and c[-1].get("cache_control"):
        log["mode"], log["reason"] = "dropped", "halt_already_marked"
        return log
    if needs_convert:
        tgt["content"] = [{"type": "text", "text": c}]
    # the CLI's own marker, moved — its ttl travels with it (no 5m of ours)
    tgt["content"][-1]["cache_control"] = {"type": "ephemeral", "ttl": tail_ttl}
    log["mode"], log["ttl"] = "relocated", tail_ttl
    log["converted_string"] = needs_convert
    return log


# ---- OWNED MOBILE MARKER (2026-07-21) --------------------------------------
# Placement of the mobile message-tier marker becomes a WIRESCOPE decision, not
# a per-request read of where the CLI happened to put its rolling marker (which
# it sometimes omits -> the read collapses up to the msg0 bundle, sometimes 18k
# deep = "an accident, not a strategy", Bogdan). We compute the deepest SAFE
# frontier ourselves (deepest consumed block that survives our own strips = just
# above the lowest live block; the whole tail on a clean round), strip every CLI
# message marker in the volatile region, and place OUR marker there.
#
# PLACEMENT IS A PURE FUNCTION of the request bytes (frontier = just above the
# lowest live block; live/consumed is monotone within a lineage) -> it is
# deterministic, so a restart re-places the marker at the SAME spot with no
# persistence needed, and cache_control is not hashed so a marker move never
# busts. That means persistence is NOT a placement input (contrarian #1,
# 2026-07-21: an "advance-or-hold ratchet" that holds an anchor DEEPER than the
# fresh frontier would by definition cache a block the fresh computation just
# judged live -> unsafe; there is no safe hold, and consumed-monotonicity already
# gives "never retreat within a lineage" for free). What persistence DOES buy:
# (a) HONEST cold-read accounting — a partial compact can preserve the anchored
# message verbatim while rewriting earlier messages, so anchor identity matches
# but the warm entry behind it is cold; a persisted PREFIX FINGERPRINT tells
# "same lineage, entry survived" from "prefix changed, it did not" (contrarian
# #3); and (b) the seed for the future session-cloning role Bogdan flagged for
# the demoted msg0 bundle. Lineage classes: same (fingerprint matches) / changed
# (compact/edit rewrote the prefix) / new (no row: /clear rotated the id).
_MARKER_STATE = {}                       # (owner, session_id) -> state dict
_MARKER_STATE_MAX = 4096

store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS marker_state ("
    "owner TEXT NOT NULL, session_id TEXT NOT NULL, "
    "sig TEXT NOT NULL, idx INTEGER NOT NULL, ttl TEXT, "
    "msgs INTEGER NOT NULL, pfp TEXT, set_at REAL NOT NULL, "
    "PRIMARY KEY (owner, session_id))",
    "ALTER TABLE marker_state ADD COLUMN pfp TEXT")


def _msg_identity(m):
    """A stable content signature for a message, IGNORING cache_control (which we
    move around freely) AND representation-invariant across the CLI's own
    string<->text-block rewrite. Used to re-find a remembered anchor after
    indices renumber (strips delete blocks/messages) and across a restart.
    CRITICAL (contrarian #2, 2026-07-21): the CLI ships a user prompt as a marked
    text BLOCK while it is the tail, then rewrites it to a bare STRING once it is
    history (wire-proven, our own hard facts: string ≡ [{type:text}] for cache
    identity). We convert bare strings to a text block before placing our marker,
    so if identity hashed the raw representation the SAME semantic message would
    hash differently turn-to-turn and look like anchor_gone — exactly where we
    need it stable. So canonicalize: a bare string and a singleton text block
    both reduce to their text payload (matching the API's own canonicalization).
    Role + canonical content hash."""
    if not isinstance(m, dict):
        return None
    try:
        c = m.get("content")
        if isinstance(c, str):
            payload = "text\x00" + c            # bare string
        elif (isinstance(c, list) and len(c) == 1 and isinstance(c[0], dict)
              and c[0].get("type") == "text"):
            payload = "text\x00" + (c[0].get("text") or "")   # singleton text block
        elif isinstance(c, list):
            blocks = [{k: v for k, v in b.items() if k != "cache_control"}
                      if isinstance(b, dict) else b for b in c]
            payload = json.dumps(blocks, sort_keys=True, default=str)
        else:
            payload = json.dumps(c, sort_keys=True, default=str)
        return hashlib.sha1(
            (str(m.get("role")) + "\x00" + payload).encode("utf-8", "replace")
        ).hexdigest()
    except Exception:
        return None


def _prefix_fingerprint(msgs, upto):
    """A lightweight fingerprint of the message identities AT AND BELOW `upto` —
    the cumulative prefix our anchor's cache entry actually depends on (contrarian
    #3, 2026-07-21). A partial compact/edit can preserve the anchored message
    byte-for-byte while rewriting EARLIER messages, so anchor identity alone can
    match while the warm entry behind it is cold. Comparing this fingerprint tells
    an honest 'same lineage' from a 'prefix changed, warm entry did not survive'."""
    h = hashlib.sha1()
    for i in range(min(upto + 1, len(msgs))):
        sig = _msg_identity(msgs[i]) or ""
        h.update(sig.encode("ascii", "replace"))
        h.update(b"\x00")
    return h.hexdigest()


def _marker_state_load(session_id):
    """The remembered anchor for a session: in-memory hot, SQLite on a cold miss
    (survives restart). Never a DB hit once cached. Keyed by (OWNER, session_id)
    in memory too (contrarian #4) so the hot cache can't alias across owners
    (residual today — one process = one OWNER — but free and matches the DB key).
    Returns the state dict or None."""
    if not session_id:
        return None
    key = (store_mod.OWNER, session_id)
    st = _MARKER_STATE.get(key)
    if st is not None:
        return st
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            row = con.execute(
                "SELECT sig, idx, ttl, msgs, pfp FROM marker_state "
                "WHERE owner=? AND session_id=?",
                (store_mod.OWNER, session_id)).fetchone()
        if row:
            st = {"sig": row[0], "idx": row[1], "ttl": row[2], "msgs": row[3],
                  "pfp": row[4]}
            _MARKER_STATE[key] = st
            return st
    except Exception as e:
        print(f"[marker] load failed for {str(session_id)[:12]}…: {e}", flush=True)
    return None


def _marker_state_save(session_id, sig, idx, ttl, msgs_len, pfp):
    """Write-through the placed anchor + prefix fingerprint (memory + SQLite). A
    store failure degrades to in-memory-only, same as the strip/hint override
    twins."""
    if not session_id:
        return
    key = (store_mod.OWNER, session_id)
    st = {"sig": sig, "idx": idx, "ttl": ttl, "msgs": msgs_len, "pfp": pfp}
    _MARKER_STATE[key] = st
    if len(_MARKER_STATE) > _MARKER_STATE_MAX:
        # evict the oldest by nothing-more-precise-than insertion order (dict)
        _MARKER_STATE.pop(next(iter(_MARKER_STATE)), None)
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT INTO marker_state(owner, session_id, sig, idx, ttl, "
                "msgs, pfp, set_at) VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(owner, session_id) DO UPDATE SET "
                "sig=excluded.sig, idx=excluded.idx, ttl=excluded.ttl, "
                "msgs=excluded.msgs, pfp=excluded.pfp, set_at=excluded.set_at",
                (store_mod.OWNER, session_id, sig, idx, ttl, msgs_len, pfp,
                 time.time()))
            con.commit()
    except Exception as e:
        print(f"[marker] persist failed for {str(session_id)[:12]}…: {e}", flush=True)


def _marker_state_forget(session_id):
    """Drop remembered anchor (memory + SQLite) — session end / lineage break."""
    if not session_id:
        return
    _MARKER_STATE.pop((store_mod.OWNER, session_id), None)
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM marker_state WHERE owner=? AND session_id=?",
                        (store_mod.OWNER, session_id))
            con.commit()
    except Exception as e:
        print(f"[marker] forget failed for {str(session_id)[:12]}…: {e}", flush=True)


def _own_mobile_marker(obj, agent_id=None, session_id=None):
    """Wirescope-OWNED mobile marker (OWN_MOBILE_MARKER; REPLACES the reactive
    _midturn_marker_gate when on). Placement is a PURE FUNCTION of the request
    bytes: strip every CLI message marker in the volatile region, then plant OUR
    marker at the deepest SAFE frontier (just above the lowest live block; the
    whole tail on a clean round). The FLOOR marker (pin@settled boundary) is
    placed upstream by _pin_settled_breakpoint and is never touched; the msg0
    bundle is demoted. This transform is BUDGET-AWARE ON ITS OWN (contrarian #5):
    after placing, if >budget, it drops the lowest-value message marker ITSELF
    (msg0 bundle / a stray CLI marker below the boundary), NEVER the floor pin or
    our mobile marker — it does not lean on the final clamp to pick correctly.
    Persistence is observational only (lineage class via prefix fingerprint), not
    a placement input. Returns a log dict or None."""
    if not OWN_MOBILE_MARKER or not _midturn_strip_active(obj, agent_id):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    boundary = _settled_boundary(msgs)
    last_asst, live, live_err_idx, live_ack_idx = _live_blocks(
        obj, msgs, boundary, agent_id)
    if last_asst is None:
        return None                       # transition / turn-first: pin covers it
    lowest_live = min(live) if live else None
    # frontier = deepest consumed + strip-final message (never a live block)
    frontier = (lowest_live - 1) if lowest_live is not None else len(msgs) - 1
    # LINEAGE CLASS (observational; NOT a placement input — placement is pure).
    # The question is "did the warm entry behind the PREVIOUS anchor survive?", so
    # compare the remembered fingerprint to the prefix AT THE SAME DEPTH — re-find
    # the remembered anchor by sig and fingerprint up to IT, NOT up to the new
    # frontier (contrarian #2: a legitimate frontier advance grows the prefix, so
    # comparing at the new frontier would false-alarm `changed` every time the
    # frontier moves). Classes: new (no row) / anchor_gone (remembered anchor no
    # longer present = compact summarized it away or /clear) / prefix_changed
    # (anchor present but earlier context rewritten = partial compact, old entry
    # cold) / same (prefix intact; +advanced flag if the frontier moved deeper).
    st = _marker_state_load(session_id)
    lineage = "new"
    advanced = False
    if st:
        want_sig = st.get("sig")
        want_pfp = st.get("pfp")
        remembered = st.get("idx", -1)
        found = None
        for i, m in enumerate(msgs):
            if _msg_identity(m) == want_sig:
                if found is None or abs(i - remembered) < abs(found - remembered):
                    found = i
        if found is None:
            lineage = "anchor_gone"
        elif not want_pfp:
            # a legacy row (persisted before the pfp column) has no fingerprint to
            # compare — don't mis-report the first post-migration request as
            # prefix_changed (contrarian, msg-154 #1); classify legacy_unknown and
            # the save below overwrites it with a real fingerprint.
            lineage = "legacy_unknown"
        else:
            now_pfp = _prefix_fingerprint(msgs, found)
            if want_pfp == now_pfp:
                lineage = "same"
                advanced = frontier > found
            else:
                lineage = "prefix_changed"
    # Capture the CLI's rolling tail ttl BEFORE we strip it, so our marker keeps
    # the SAME ttl the CLI chose (cost-neutral vs the reactive relocate — no
    # silent upgrade to a deeper 1h system marker's ttl, contrarian open-Q).
    cli_tail_ttl = None
    for r, i, blk in _cache_markers(obj):
        if r == "messages" and i > boundary:
            cc = blk.get("cache_control")
            if isinstance(cc, dict) and cc.get("ttl"):
                cli_tail_ttl = cc["ttl"]
    # Strip every CLI message marker STRICTLY ABOVE the settled boundary (the
    # rolling tail + any live-block marker); the pin (<= boundary) and the msg0
    # bundle (idx 0) are left in place. Then plant ours at the frontier.
    stripped = 0
    for i, m in enumerate(msgs):
        if i <= boundary:
            continue                      # protect pin anchor + msg0 bundle region
        c = m.get("content") if isinstance(m, dict) else None
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.pop("cache_control", None) is not None:
                    stripped += 1
    log = {"mode": None, "frontier_idx": frontier, "boundary_idx": boundary,
           "last_asst_idx": last_asst, "lowest_live_idx": lowest_live,
           "live_error": live_err_idx is not None,
           "live_edit_ack": live_ack_idx is not None,
           "cli_markers_stripped": stripped, "lineage": lineage,
           "advanced": advanced, "total_messages": len(msgs)}
    if frontier <= boundary:
        # nothing consumed beyond the pin -> the floor already covers everything.
        # Record state (fingerprint at the boundary) so a later real placement can
        # still classify lineage; no message marker of ours to place.
        log["mode"] = "floor_only"
        _marker_state_save(
            session_id,
            _msg_identity(msgs[boundary]) if boundary >= 0 else None,
            boundary, None, len(msgs),
            _prefix_fingerprint(msgs, boundary) if boundary >= 0 else None)
        return log
    tgt = msgs[frontier]
    c = tgt.get("content")
    needs_convert = isinstance(c, str) and bool(c)
    if not needs_convert and (
            not isinstance(c, list) or not c or not isinstance(c[-1], dict)):
        # can't mark the frontier -> discard any stale row so we don't repeat a
        # dead lookup every request (contrarian #6), then decline.
        _marker_state_forget(session_id)
        log["mode"], log["reason"] = "declined", "unmarkable_frontier"
        return log
    # ttl: keep the CLI tail's own ttl if we saw one; else mirror the deepest
    # surviving marker (ordering-legal — our frontier is the deepest block, and
    # cache order forbids a longer ttl after a shorter one upstream).
    ttl = cli_tail_ttl or "5m"
    if not cli_tail_ttl:
        existing = _cache_markers(obj)
        if existing:
            lastcc = existing[-1][2].get("cache_control")
            if isinstance(lastcc, dict) and lastcc.get("ttl"):
                ttl = lastcc["ttl"]
    if needs_convert:
        tgt["content"] = [{"type": "text", "text": c}]
    tgt["content"][-1]["cache_control"] = {"type": "ephemeral", "ttl": ttl}
    log["mode"], log["ttl"] = "placed", ttl
    log["converted_string"] = needs_convert
    # SELF BUDGET-AWARENESS (contrarian #5): with 2 sys + msg0 bundle + pin +
    # our mobile = 5, free a slot by dropping the LOWEST-value MESSAGE marker
    # ourselves — msg0 (the demoted bundle) or a stray CLI marker at/below the
    # boundary — NEVER the floor pin (at boundary) or our mobile (at frontier,
    # the two deepest). Repeat until within budget; the final clamp becomes a
    # pure backstop, not the thing that decides which marker dies.
    demoted = []
    markers = _cache_markers(obj)
    while len(markers) > _CACHE_BREAKPOINT_BUDGET:
        # droppable = message markers strictly below the pin boundary (msg0 +
        # any stray CLI marker), lowest index first. pin (==boundary) and mobile
        # (==frontier) are never in this set.
        cand = next(((r, i, b) for r, i, b in markers
                     if r == "messages" and i < boundary), None)
        if cand is None:
            break                         # only pin+mobile+system left — clamp handles it
        cand[2].pop("cache_control", None)
        demoted.append(cand[1])
        markers = _cache_markers(obj)
    if demoted:
        log["demoted_msg_markers"] = demoted
    if len(markers) > _CACHE_BREAKPOINT_BUDGET:
        # Self-demotion couldn't get under budget from message markers below the
        # boundary (contrarian #4): the layout has an unexpected marker between
        # boundary and frontier that stripping missed, or more system markers than
        # assumed. The final clamp (drops non-tail message markers, which includes
        # our pin) is then NOT a pure backstop for the floor. Flag it loudly so the
        # A/B surfaces the layout instead of silently sacrificing the floor.
        log["budget_overflow"] = len(markers)
        print(f"[marker] OWN_MOBILE over budget after self-demote: "
              f"{len(markers)} markers, boundary={boundary} frontier={frontier} "
              f"— final clamp may drop the floor pin", flush=True)
    _marker_state_save(session_id, _msg_identity(msgs[frontier]), frontier, ttl,
                       len(msgs), _prefix_fingerprint(msgs, frontier))
    return log


def _edit_result_ids(msgs):
    """tool_use_ids whose assistant tool_use was an Edit/Write tool (any wire
    dialect) — so we can identify which user-side tool_result blocks are edit
    success acks (paired by id, never by content alone)."""
    ids = set()
    for m in msgs:
        if m.get("role") != "assistant":
            continue
        c = m.get("content")
        if not isinstance(c, list):
            continue
        for b in c:
            if (isinstance(b, dict) and b.get("type") == "tool_use"
                    and b.get("name") in _EDIT_TOOL_NAMES):
                ids.add(b.get("id"))
    return ids


def _strip_consumed_edit_acks(obj, agent_id=None):
    """Collapse Edit/Write SUCCESS acks to "ok" once they have been CONSUMED —
    an edit ack sitting BELOW the last assistant message (`idx < last_asst`), i.e.
    the model has already produced its next action after the edit. The LIVE
    frontier ack (in a user message after last_asst, no reaction yet) is kept: it
    carries the CLI's "no need to Read it back" nudge that steers the very next
    step. A result is collapsed only when ALL hold: its tool_use was an edit tool,
    is_error is falsy, the string body matches a known ack fragment, and it is
    consumed.

    NEW MODEL (2026-07-20, Bogdan): CONSUMED vs LIVE, not prior vs current turn —
    the same rewrite the failed-call strip got, for the same reason. The old
    `busted_from` gate rode the thinking-strip bust "for free"; under the mid-turn
    strip that bust is PHANTOM (thinking is pre-stripped in-turn, byte-neutral at
    the transition), so the rider ORIGINATED the bust — wire-proven in the AB3
    multi-turn rerun: the rider cold-latched at a task transition and collapsed
    two ALREADY-CACHED task-1 acks, busting ~8.7k tok to reclaim 296 chars (~30:1
    loss). Fix: collapse CONSUMED acks DETERMINISTICALLY every turn (no
    busted_from, no rider latch). The marker "ok" is a constant + consumed is
    monotone, so the first prefix that caches a collapsed span caches it
    already-final and it never mutates-after-caching → the strip never originates
    a bust. Byte-stable envelope (tool_use_id + type kept). Gated by the
    per-session L2 level (or the STRIP_PRIOR_EDIT_ACKS scratch-A/B flag). Returns
    a log dict or None."""
    if not isinstance(obj, dict):
        return None
    if not (STRIP_PRIOR_EDIT_ACKS or _strip_l2_enabled(obj, agent_id)):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_asst = _last_assistant_idx(msgs)
    if not last_asst:                     # None or 0: nothing consumed below it
        return None
    edit_ids = _edit_result_ids(msgs)
    if not edit_ids:
        return None
    collapsed = stripped_chars = touched_msgs = 0
    for i in range(last_asst):
        m = msgs[i]
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        c = m.get("content")
        if not isinstance(c, list):
            continue
        touched = False
        for blk in c:
            if not (isinstance(blk, dict) and blk.get("type") == "tool_result"
                    and blk.get("tool_use_id") in edit_ids):
                continue
            if blk.get("is_error"):                # failed edit -> keep diagnostic
                continue
            body = blk.get("content")
            if not isinstance(body, str):          # only plain-string acks (skip lists)
                continue
            if body == EDIT_ACK_MARKER:            # idempotent: already collapsed
                continue
            if not any(frag in body for frag in _EDIT_ACK_FRAGMENTS):
                continue                           # not a known ack -> leave it
            if len(body) <= len(EDIT_ACK_MARKER):
                continue
            blk["content"] = EDIT_ACK_MARKER
            stripped_chars += len(body) - len(EDIT_ACK_MARKER)
            collapsed += 1
            touched = True
        if touched:
            touched_msgs += 1
    if not collapsed:
        return None
    return {"stripped": True, "collapsed_edit_acks": collapsed,
            "touched_messages": touched_msgs, "stripped_chars": stripped_chars,
            "last_asst_idx": last_asst, "total_messages": len(msgs)}


def _strip_consumed_tool_errors(obj, agent_id=None):
    """Stub both halves of a FAILED tool call once it has been CONSUMED — the
    assistant `tool_use.input` (the fat old/new string the model tried) AND its
    paired error `tool_result.content`, matched by tool_use_id. A call is
    "failed" iff its result carries a truthy `is_error`; it is "consumed" iff its
    error result sits BELOW the last assistant message (`idx < last_asst`), i.e.
    the model has already produced its reaction to that error. Envelopes
    preserved (tool_use id/type/name; result tool_use_id/type/is_error) — only
    the args object / body string are replaced with byte-stable constants, so
    the API pairing holds and the stripped bytes stay stable turn to turn.

    NEW MODEL (2026-07-20, Bogdan): the axis is CONSUMED vs LIVE, not prior vs
    current turn. The LIVE frontier error (in a user message AFTER last_asst, no
    reaction yet) is untouched — it is the model's working retry signal, treated
    exactly like current-turn thinking. Everything consumed is stubbed
    DETERMINISTICALLY every turn (no `busted_from`, no free-rider premise): the
    stub is a constant and "consumed" is monotone (once a later assistant exists,
    it exists forever), so the first prefix that caches a stubbed span caches it
    ALREADY-FINAL and it can never mutate-after-caching → the strip never
    originates a bust (that phantom bust was the AB3 leak). Paired with the marker
    gate, which keeps the LIVE error out of cache so its later stubbing is
    bust-free too. Gated by the per-session L2 level (or the
    STRIP_PRIOR_TOOL_ERRORS scratch-A/B flag). Returns a log dict or None."""
    if not isinstance(obj, dict):
        return None
    if not (STRIP_PRIOR_TOOL_ERRORS or _strip_l2_enabled(obj, agent_id)):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_asst = _last_assistant_idx(msgs)
    if not last_asst:                     # None or 0: nothing consumed below it
        return None
    # Pass 1 (user side): stub CONSUMED error result bodies (idx < last_asst);
    # collect their tool_use_ids so pass 2 can find the matching failed calls.
    error_ids = set()
    stripped_chars = stubbed_results = stubbed_calls = touched_msgs = 0
    for i in range(last_asst):
        m = msgs[i]
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        c = m.get("content")
        if not isinstance(c, list):
            continue
        touched = False
        for blk in c:
            if not (isinstance(blk, dict) and blk.get("type") == "tool_result"
                    and blk.get("is_error")):
                continue
            tuid = blk.get("tool_use_id")
            if tuid is not None:
                error_ids.add(tuid)
            body = blk.get("content")
            if body == ERROR_ELIDED_MARKER:        # idempotent: already stubbed
                continue
            n = len(body) if isinstance(body, str) else len(json.dumps(body, default=str))
            if n <= len(ERROR_ELIDED_MARKER):       # nothing to reclaim
                continue
            blk["content"] = ERROR_ELIDED_MARKER
            stripped_chars += n - len(ERROR_ELIDED_MARKER)
            stubbed_results += 1
            touched = True
        if touched:
            touched_msgs += 1
    if not error_ids:
        return None
    # Pass 2 (assistant side): stub the input of each failed tool_use below
    # last_asst whose id matched a consumed error result (the larger half).
    stub_len = len(json.dumps(ERROR_CALL_STUB, default=str))
    for i in range(last_asst):
        m = msgs[i]
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        c = m.get("content")
        if not isinstance(c, list):
            continue
        touched = False
        for blk in c:
            if not (isinstance(blk, dict) and blk.get("type") == "tool_use"
                    and blk.get("id") in error_ids):
                continue
            inp = blk.get("input")
            if inp == ERROR_CALL_STUB:             # idempotent: already stubbed
                continue
            n = len(json.dumps(inp, default=str)) if inp is not None else 0
            if n <= stub_len:                       # nothing to reclaim
                continue
            blk["input"] = dict(ERROR_CALL_STUB)
            stripped_chars += n - stub_len
            stubbed_calls += 1
            touched = True
        if touched:
            touched_msgs += 1
    if not (stubbed_results or stubbed_calls):
        return None
    return {"stripped": True, "stubbed_error_results": stubbed_results,
            "stubbed_failed_calls": stubbed_calls, "touched_messages": touched_msgs,
            "stripped_chars": stripped_chars, "last_asst_idx": last_asst,
            "total_messages": len(msgs)}


# ---- PIN SETTLED BREAKPOINT (cache-anchor placement, default ON) -----------
# The CLI's message-region breakpoints are msg0 + the rolling tail. When the
# suffix diverges >~hit-check-window blocks past the last still-valid entry
# (turn-boundary thinking shed on a long tool loop, or a resume whose transcript
# sheds the in-flight loop), the API's automatic hit-check behind each marker
# can't reach the still-warm settled prefix and the read collapses to msg0
# (measured: 18k anchored vs 127k available, clodex d51a-class resume bust).
# Fix is pure MARKER PLACEMENT: pin a breakpoint on the ANCHOR message = the
# last real user turn of the SETTLED region — i.e. one real-user boundary
# BEFORE the current turn's (both derived from the shared `_settled_boundary`
# detector the prior-turn strips use, so pin and strips cannot disagree). Why
# the PENULTIMATE boundary and not the last: at a turn transition (and on
# resume) the last real user turn IS the fresh tail — the CLI's rolling marker
# already sits there, but the request then carries NO breakpoint at the
# previous turn's boundary, which is exactly where the still-valid entry sits:
# every turn's FIRST request ends at its user prompt, so its rolling tail
# marker cached prefix[..u_k] — the maximal prefix that stays byte-valid after
# the loop's thinking is shed. Pinning u_k on every turn-(k+1) request makes
# that an EXACT entry match (no hit-check window needed), turn after turn,
# regardless of loop length. Within a turn the anchor is fixed (byte-stable);
# strips only touch assistant blocks above it, never the user message itself.
# cache_control is placement METADATA, not hashed content (warmth's
# _canon_message strips it too) — moving a marker never busts anything; only
# content edits do. Zero-risk in a way the strips never were.
# BUDGET (<=4): with relocate's CLAUDE.md-bundle marker the wire often runs
# 4/4 (sys x2 + msg0 bundle + tail) — then MIGRATE the earliest prior-history
# message marker (the msg0/bundle anchor) instead of adding: the pin's
# cumulative prefix covers everything that marker covered, and the worst-case
# fallback merely shifts from the msg0 entry to the system[2] entry (~3k less)
# while the common case gains the full settled read. Never steals a system
# marker (cross-instance sharing anchors) or the rolling tail (live-loop
# chaining). Declines: string-content anchor (rewriting the shape isn't
# byte-neutral), zero client markers (don't originate caching the client chose
# not to have), budget full with no message donor below the anchor.
PIN_SETTLED_BREAKPOINT = os.environ.get("PIN_SETTLED_BREAKPOINT", "1") not in (
    "0", "no", "off", "false")
_CACHE_BREAKPOINT_BUDGET = 4


def _cache_markers(obj):
    """Every cache_control-marked block in the request as (region, index,
    block) tuples, in canonical cache order tools -> system -> messages."""
    out = []
    for region in ("tools", "system"):
        seq = obj.get(region)
        if isinstance(seq, list):
            for i, b in enumerate(seq):
                if isinstance(b, dict) and b.get("cache_control"):
                    out.append((region, i, b))
    msgs = obj.get("messages")
    if isinstance(msgs, list):
        for i, m in enumerate(msgs):
            c = m.get("content") if isinstance(m, dict) else None
            if isinstance(c, list):
                for blk in c:
                    if isinstance(blk, dict) and blk.get("cache_control"):
                        out.append(("messages", i, blk))
    return out


def _pin_settled_breakpoint(obj, agent_id=None):
    """Pin a cache_control breakpoint on the last content block of the ANCHOR
    message — the last real user turn of the settled region, one boundary
    before the current turn's (see block comment above). Runs LAST among the
    message transforms so the anchor is computed on the final message list (the
    task-reminder strip deletes whole messages -> indices shift). Returns a log
    dict (`pinned` True/False + reason) or None (disabled / nothing settled)."""
    if not PIN_SETTLED_BREAKPOINT or not isinstance(obj, dict):
        return None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    boundary = _settled_boundary(msgs)
    if boundary <= 0:
        return None                       # single-turn: nothing settled to anchor
    # ANCHOR-ADVANCE (2026-07-20, Bogdan's lag find; AB2v2 expiry probe priced
    # the lag at ~25-29k tok x 2x premium per >5m pause): the penultimate
    # anchor is only NEEDED on the turn's FIRST request, where the boundary
    # message is the fresh tail (the CLI's rolling marker sits on it — pinning
    # would collide, and the penultimate entry is the exact-match transition
    # anchor). From request 2+ (an assistant message exists past the boundary)
    # the boundary has settled and everything above it is byte-stable for the
    # rest of the turn (settle strips ran at the transition; mid-turn strips
    # only touch later messages) -> anchor the CURRENT turn's opening. Costs
    # the same 1h write the next transition would pay, just a turn earlier;
    # the entry it writes then IS the next transition's exact-match anchor.
    advanced = any(m.get("role") == "assistant" for m in msgs[boundary + 1:])
    if advanced:
        # request 2+ — anchor the boundary itself; if it already carries a
        # marker (org-route second rolling marker) the already_marked decline
        # below is the right outcome: coverage is already there.
        anchor = boundary
    else:
        anchor = _settled_boundary(msgs, upto=boundary)
        if anchor < 0:
            return None                   # first turn after msg0: msg0 markers cover it
    tgt = msgs[anchor]
    c = tgt.get("content")
    # THE COMMON CASE is a bare-STRING anchor: the CLI sends a user prompt as
    # a marked text BLOCK while it's the tail, then rewrites it to a string
    # once it's history (wire-proven T2/T3, 2026-07-07). cache_control needs
    # block form, so we convert (below, only once the pin is certain — decline
    # paths must not mutate). Safe in BOTH canonicalization worlds: if the API
    # hashes string == [{type:text}] the conversion is identity-neutral; if it
    # doesn't, the CLI's own block->string rewrite busted at the anchor every
    # turn anyway and the conversion RESTORES byte-identity with the entry the
    # turn-start request wrote (tail block; cache_control is stripped from the
    # canonical form). Deterministic every request -> shape stable across our
    # forwarded stream.
    needs_convert = isinstance(c, str) and bool(c)
    if not needs_convert and (
            not isinstance(c, list) or not c or not isinstance(c[-1], dict)):
        return {"pinned": False, "reason": "unmarkable_content",
                "anchor_idx": anchor, "boundary_idx": boundary,
                "total_messages": len(msgs)}
    if not needs_convert and c[-1].get("cache_control"):
        # anchor already carries a marker (a client that rolls TWO message
        # markers, or msg0-as-anchor with the CLI/relocate marker on it)
        return {"pinned": False, "reason": "already_marked",
                "anchor_idx": anchor, "boundary_idx": boundary,
                "total_messages": len(msgs)}
    markers = _cache_markers(obj)
    if not markers:
        return {"pinned": False, "reason": "no_client_markers",
                "anchor_idx": anchor, "boundary_idx": boundary,
                "total_messages": len(msgs)}
    donor_idx = None
    if len(markers) >= _CACHE_BREAKPOINT_BUDGET:
        donor = next(((r, i, b) for r, i, b in markers
                      if r == "messages" and i < anchor), None)
        if donor is None:
            return {"pinned": False, "reason": "budget_full_no_donor",
                    "anchor_idx": anchor, "boundary_idx": boundary,
                    "markers_total": len(markers), "total_messages": len(msgs)}
        cc = donor[2].pop("cache_control")   # migrate: same count, better placement
        donor_idx = donor[1]
        mode = "migrated"
    else:
        # fresh slot: mirror the ttl of the last marker BEFORE the anchor in
        # canonical order — always ordering-legal (never longer than its
        # predecessor; API forbids 1h AFTER 5m). In practice that is a 1h
        # system/bundle marker, so the anchor goes durable even when
        # scrap-tail has already downshifted the rolling tail to 5m (copying
        # markers[-1] there would hand the anchor a 5m ttl = re-creating the
        # expiry lag the advance exists to close).
        prior = [b for r, i, b in markers
                 if r in ("tools", "system") or (r == "messages" and i < anchor)]
        src = prior[-1] if prior else markers[-1][2]
        cc = dict(src["cache_control"])
        mode = "added"
    if needs_convert:
        tgt["content"] = [{"type": "text", "text": c}]
    tgt["content"][-1]["cache_control"] = cc
    return {"pinned": True, "mode": mode, "anchor_idx": anchor,
            "boundary_idx": boundary, "advanced": advanced,
            "donor_msg_idx": donor_idx,
            "ttl": cc.get("ttl"), "converted_string": needs_convert,
            "markers_total": len(markers) + (1 if mode == "added" else 0),
            "total_messages": len(msgs)}


# ---- MARKER-BUDGET INVARIANT (hard rule, 2026-07-19) -----------------------
# NEVER forward more than 4 cache_control markers, period. The API hard-400s a
# 5th and the whole user turn dies — the worst possible failure for a proxy
# whose contract is "non-intrusive". Every marker-adding transform is budget-
# aware on its own (relocate migrates-or-skips, pin migrates), but this final
# clamp makes the invariant unconditional: any future transform bug or client
# layout we haven't seen degrades to a slightly worse cache boundary (marker
# removal is placement metadata, never a bust), not a rejected request.
# Drop preference (lowest-value first): earliest non-tail MESSAGE markers
# (their prefixes are re-anchored by pin / covered by deeper markers), then
# TOOLS markers (the first system marker's cumulative prefix covers tools[]),
# then earliest SYSTEM markers (keep the last — the full-prompt anchor).
# The rolling tail (last message) is never dropped by preference; a final
# unconditional pass guarantees <=4 even in pathological layouts.


def _enforce_marker_budget(obj, agent_id=None):
    """Final-chain clamp: forwarded requests carry at most
    _CACHE_BREAKPOINT_BUDGET cache_control markers. Returns a log dict
    {dropped:[{region,index}], markers_before} when it fired, else None."""
    if not isinstance(obj, dict):
        return None
    markers = _cache_markers(obj)
    over = len(markers) - _CACHE_BREAKPOINT_BUDGET
    if over <= 0:
        return None
    msgs = obj.get("messages") or []
    last_mi = len(msgs) - 1
    dropped = []

    def _drop(cand):
        nonlocal over
        cand[2].pop("cache_control", None)
        dropped.append({"region": cand[0], "index": cand[1]})
        over -= 1

    msg_markers = [m for m in markers if m[0] == "messages" and m[1] != last_mi]
    tool_markers = [m for m in markers if m[0] == "tools"]
    sys_markers = [m for m in markers if m[0] == "system"]
    for cand in msg_markers + tool_markers + sys_markers[:-1]:
        if over <= 0:
            break
        _drop(cand)
    if over > 0:                      # pathological (e.g. many tail-message blocks)
        for cand in _cache_markers(obj)[:-1]:
            if over <= 0:
                break
            _drop(cand)
    return {"dropped": dropped, "markers_before": len(markers)}


# SCRAP_TAIL_5M / _downshift_scrap_tail REMOVED (2026-07-20 correction): the
# 1h->5m tail downshift priced the frontier as doomed scrap, which was only
# true under the old cross-turn strip (whole turn discarded + rewritten next
# turn). In-turn stripping discards nothing — the span the tail marker covers
# is durable — so the CLI's own ttl is simply correct and we don't touch it.


def _patch_tool_descriptions(obj):
    """Append the shortcircuit protocol to each terminal tool's description in
    the request's tools[] (idempotent + cache-stable). Returns the list of tool
    names patched (empty if none)."""
    if not SHORTCIRCUIT_TOOLPATCH:
        return []
    tools = obj.get("tools")
    if not isinstance(tools, list):
        return []
    patched = []
    for t in tools:
        if isinstance(t, dict) and t.get("name") in SHORTCIRCUIT_TOOLS:
            d = t.get("description")
            if isinstance(d, str) and SHORTCIRCUIT_TOOLPATCH not in d:
                t["description"] = d + SHORTCIRCUIT_TOOLPATCH
                patched.append(t.get("name"))
    return patched


def _last_assistant_block(obj):
    """The most-recent role==assistant message dict, or None."""
    msgs = obj.get("messages") or []
    return next((m for m in reversed(msgs) if m.get("role") == "assistant"), None)


def _shortcircuit_decision(obj):
    """Return a dict describing why the wrap-up turn can be elided, or None.

    Fires only when ALL hold:
      * the last message is a USER turn carrying tool_result(s), none an error;
      * the most-recent ASSISTANT message contains the SHORTCIRCUIT_DONE sentinel
        in its text AND >=1 tool_use, where EVERY tool_use is a known terminal/
        info-free tool (SHORTCIRCUIT_TOOLS) whose id matches a tool_result here.
    Count is NOT the criterion — TOOL TYPE is. An authored mutation's result is
    information-free (the model already knows the post-edit bytes; the result is
    just a pass/fail bit we gate on), so N parallel Writes are as elidable as one.
    But if ANY tool in the batch returns information the model would act on (a
    Read/Bash/Grep mixed in), we must NOT elide — the model needs to see it — so
    the all-in-allowlist check is the real safety boundary, not the cardinality.
    The continuation already carries the REAL results (the CLI ran the tools
    before sending), so we are not assuming success — we verify every result and
    bail on any error."""
    if not SHORTCIRCUIT_DONE:
        return None
    msgs = obj.get("messages") or []
    if not msgs:
        return None
    last = msgs[-1]
    if last.get("role") != "user":
        return None
    lc = last.get("content")
    if not isinstance(lc, list):
        return None
    results = [b for b in lc if isinstance(b, dict) and b.get("type") == "tool_result"]
    if not results or any(b.get("is_error") for b in results):
        return None  # need success result(s); never elide an error
    asst = _last_assistant_block(obj)
    ac = asst.get("content") if asst else None
    if not isinstance(ac, list):
        return None
    text = " ".join(b.get("text", "") for b in ac
                    if isinstance(b, dict) and b.get("type") == "text")
    if SHORTCIRCUIT_DONE not in text:
        return None
    tool_uses = [b for b in ac if isinstance(b, dict) and b.get("type") == "tool_use"]
    if not tool_uses:
        return None
    # EVERY tool_use must be an info-free terminal mutation (so its result carries
    # nothing the model would act on) AND have a matching successful result here.
    if any(tu.get("name") not in SHORTCIRCUIT_TOOLS for tu in tool_uses):
        return None
    result_ids = {b.get("tool_use_id") for b in results}
    if any(tu.get("id") not in result_ids for tu in tool_uses):
        return None
    ids = [tu.get("id") for tu in tool_uses]
    key = frozenset(ids)
    if key in _SC_FIRED:
        return None  # already short-circuited this exact turn — a CLI retry; let it go upstream
    if len(_SC_FIRED) >= _SC_FIRED_CAP:
        _SC_FIRED.clear()
    _SC_FIRED[key] = True
    return {"tools": [tu.get("name") for tu in tool_uses], "tool_use_ids": ids,
            "sentinel": SHORTCIRCUIT_DONE, "ack": SHORTCIRCUIT_ACK}


def _synth_end_turn_sse(model, ack, msg_id):
    """Build a minimal, VALID Anthropic streaming response: one text block = ack,
    stop_reason end_turn, zeroed usage (we ran no inference). Same event grammar
    the CLI parses from a real stream, so it's accepted transparently."""
    def ev(name, data):
        return f"event: {name}\ndata: {json.dumps(data)}\n\n"
    return "".join([
        ev("message_start", {"type": "message_start", "message": {
            "id": msg_id, "type": "message", "role": "assistant",
            "model": model or "claude", "content": [], "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0,
                      "cache_read_input_tokens": 0,
                      "cache_creation_input_tokens": 0}}}),
        ev("content_block_start", {"type": "content_block_start", "index": 0,
            "content_block": {"type": "text", "text": ""}}),
        ev("content_block_delta", {"type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": ack}}),
        ev("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ev("message_delta", {"type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 0}}),
        ev("message_stop", {"type": "message_stop"}),
    ]).encode("utf-8")


def _relay_capture_and_strip(blob: bytes) -> bytes:
    """RELAY edit-turn handler. If this response carries exactly one terminal
    tool_use plus a text block containing the sentinel, STASH the cleaned prose
    keyed by the tool_use_id and BLANK that text block in the stream (so the
    pre-written success message is NOT shown before the edit is confirmed).
    Returns the rewritten SSE, or the blob unchanged if it doesn't qualify.
    Every other event (incl. thinking + its signature) is byte-preserved."""
    events = blob.decode("utf-8", "replace").split("\n\n")
    tool_uses = []                                  # (index, id, name)
    text_by_idx = collections.defaultdict(list)     # index -> [text...]
    for ev in events:
        d = _data_of(ev)
        if not d:
            continue
        t = d.get("type")
        if t == "content_block_start":
            cb = d.get("content_block") or {}
            if cb.get("type") == "tool_use":
                tool_uses.append((d.get("index"), cb.get("id"), cb.get("name")))
        elif t == "content_block_delta" and (d.get("delta") or {}).get("type") == "text_delta":
            text_by_idx[d.get("index")].append(d["delta"].get("text", ""))
    if not tool_uses:
        return blob
    # Same info-free criterion as _shortcircuit_decision: EVERY tool_use must be a
    # terminal mutation; count is irrelevant (N parallel Writes are still elidable).
    if any((not tid) or tname not in SHORTCIRCUIT_TOOLS
           for _idx, tid, tname in tool_uses):
        return blob
    sent_idx = next((i for i, parts in text_by_idx.items()
                     if SHORTCIRCUIT_DONE in "".join(parts)), None)
    if sent_idx is None:
        return blob
    prose = "".join(text_by_idx[sent_idx]).replace(SHORTCIRCUIT_DONE, "").strip()
    if len(_PENDING_RELAY) >= _PENDING_RELAY_CAP:
        _PENDING_RELAY.clear()
    # Stash the one combined summary under EVERY tool_use_id in the batch; the
    # wrap-up handler pops them all and replays the prose once.
    for _idx, tid, _tname in tool_uses:
        _PENDING_RELAY[tid] = prose or SHORTCIRCUIT_ACK
    # REMOVE the sentinel-bearing text block entirely (an EMPTY text block is
    # rejected by the API when the message is replayed in history) and shift
    # later blocks down so indices stay contiguous. Thinking blocks and their
    # signatures (before sent_idx) are byte-preserved.
    rebuilt = []
    for ev in events:
        d = _data_of(ev)
        if d is None:
            rebuilt.append(ev)                       # blank separators / non-JSON
            continue
        idx = d.get("index")
        if idx == sent_idx:
            continue                                 # drop every event of that block
        if isinstance(idx, int) and idx > sent_idx:
            d["index"] = idx - 1                     # keep block indices contiguous
            rebuilt.append(f"event: {d.get('type')}\ndata: " + json.dumps(d))
        else:
            rebuilt.append(ev)                       # unchanged (byte-preserved)
    return "\n\n".join(rebuilt).encode("utf-8")


def _shortcircuit_relay_decision(obj):
    """RELAY wrap-up handler: fire when the request's last user message carries a
    SUCCESS tool_result whose tool_use_id we stashed prose for at the edit turn.
    The ack is the model's own pre-written summary (popped from _PENDING_RELAY)."""
    if not _relay_active():
        return None
    msgs = obj.get("messages") or []
    if not msgs or msgs[-1].get("role") != "user":
        return None
    lc = msgs[-1].get("content")
    if not isinstance(lc, list):
        return None
    if any(isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error")
           for b in lc):
        return None  # any error in the batch -> let the model react, don't relay
    matched = [b.get("tool_use_id") for b in lc
               if isinstance(b, dict) and b.get("type") == "tool_result"
               and b.get("tool_use_id") in _PENDING_RELAY]
    if not matched:
        return None
    ack = _PENDING_RELAY.pop(matched[0])          # the one combined summary
    for tid in matched[1:]:
        _PENDING_RELAY.pop(tid, None)             # drain the rest of the batch
    return {"tool_use_ids": matched, "ack": ack,
            "sentinel": SHORTCIRCUIT_DONE, "relayed": True}


def _data_of(ev_text):
    """The parsed `data:` JSON of one SSE event block, or None."""
    for ln in ev_text.split("\n"):
        if ln.startswith("data:"):
            try:
                return json.loads(ln[5:].strip())
            except Exception:
                return None
    return None


def _mutate_sse(blob: bytes) -> bytes:
    """Rewrite a captured SSE stream (event-granular, events split on blank line):
      * RESP_REPLACE swaps text inside every text_delta.
      * RESP_APPEND adds a text_delta into the LAST text block (so it concatenates
        onto the model's visible answer; we target a text block, never thinking).
    Every other event is preserved."""
    old = new = None
    if RESP_REPLACE and "\x1f" in RESP_REPLACE:
        old, new = RESP_REPLACE.split("\x1f", 1)
    events = blob.decode("utf-8", "replace").split("\n\n")

    if old is not None:
        for i, ev in enumerate(events):
            d = _data_of(ev)
            if d and d.get("type") == "content_block_delta" \
                    and (d.get("delta") or {}).get("type") == "text_delta":
                d["delta"]["text"] = d["delta"].get("text", "").replace(old, new)
                events[i] = "event: content_block_delta\ndata: " + json.dumps(d)

    if RESP_APPEND:
        text_idx = None
        for ev in events:          # last content_block_start whose block is text
            d = _data_of(ev)
            if d and d.get("type") == "content_block_start" \
                    and (d.get("content_block") or {}).get("type") == "text":
                text_idx = d.get("index")
        if text_idx is not None:
            for i, ev in enumerate(events):   # insert before that block's stop
                d = _data_of(ev)
                if d and d.get("type") == "content_block_stop" and d.get("index") == text_idx:
                    inj = "event: content_block_delta\ndata: " + json.dumps(
                        {"type": "content_block_delta", "index": text_idx,
                         "delta": {"type": "text_delta", "text": RESP_APPEND}})
                    events.insert(i, inj)
                    break
    return "\n\n".join(events).encode("utf-8")


def _guess_lang(path):
    return {"py": "python", "js": "javascript", "ts": "typescript", "json": "json",
            "sh": "bash", "go": "go", "rs": "rust", "md": "markdown"}.get(
        path.rsplit(".", 1)[-1].lower(), "")


def _file_volunteer_text(path):
    """Read `path` fresh and wrap it as an authoritative system-reminder. Returns
    None if unreadable (so we forward the request untouched)."""
    try:
        data = open(path, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return None
    if len(data) > _MAX_VOLUNTEER_BYTES:
        data = data[:_MAX_VOLUNTEER_BYTES] + "\n…(truncated)…"
    lang = _guess_lang(path)
    note = f"\n\n{INJECT_FILE_NOTE}" if INJECT_FILE_NOTE else ""
    return (f"<system-reminder>\nFor reference, the current contents of {path} "
            f"are shown below.\n\n```{lang}\n{data}\n```{note}\n</system-reminder>")


def _last_user_block(obj):
    """Return the last role==user message dict, or None.

    Scans backward: the CLI appends a trailing role==system catalog block after
    the user's turn, so messages[-1] is often NOT the user's prompt."""
    msgs = obj.get("messages")
    if not msgs:
        return None
    return next((m for m in reversed(msgs) if m.get("role") == "user"), None)


def _last_user_text(obj):
    """Flatten the last user message's text (str content or text blocks)."""
    last = _last_user_block(obj)
    if last is None:
        return None
    c = last.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c
                         if isinstance(b, dict) and b.get("type") == "text")
    return None


def _inject_into_last_user(obj, text, sep="\n\n"):
    """Append `text` to the last USER message's text. Returns the original text
    if a change was made, else None (so the caller can skip re-encoding)."""
    last = _last_user_block(obj)
    if last is None:
        return None
    c = last.get("content")
    if isinstance(c, str):
        last["content"] = c + sep + text
        return c
    if isinstance(c, list):
        for blk in reversed(c):
            if isinstance(blk, dict) and blk.get("type") == "text":
                orig = blk.get("text", "")
                blk["text"] = orig + sep + text
                return orig
        c.append({"type": "text", "text": text})
        return ""
    return None


# ---- THROWAWAY PROTOTYPE: mid-flight DM delivery (scratch port ONLY) ---------
# Gates the wire-delivery feature's ONE open risk: does the model double-react
# when it sees DM content injected on the wire THIS turn AND a slim durable
# record next turn? This is deliberately minimal — NO delivery.rode receipt, NO
# ack, NO dedup, NO leak-guard (those are the real build, spec'd-but-uncoded
# until this test clears). Off by default (DELIVER_PROTOTYPE unset) → inert on
# :7800; only the scratch experiment port sets it. In-memory, non-durable,
# fire-once: an enqueued item rides the NEXT request for its session then clears
# (a throwaway approximation of the real transient tail-copy). The proxy never
# parses `text` — it's opaque; clodex frames it.
DELIVER_PROTOTYPE = os.environ.get("DELIVER_PROTOTYPE", "0") not in (
    "0", "no", "off", "false")
_DELIVER_QUEUE = {}          # session_id -> list[str]  (throwaway, in-memory)


def _deliver_enqueue(session_id, text):
    """Queue `text` for injection into `session_id`'s next request. Returns the
    resulting queue depth. Throwaway prototype only."""
    _DELIVER_QUEUE.setdefault(session_id, []).append(text)
    return len(_DELIVER_QUEUE[session_id])


def _deliver_tail_inject(obj):
    """THROWAWAY: append any pending delivery text for this request's session as
    a TRAILING text block on the last user message (tail-only → cache-safe;
    appended AFTER any tool_result blocks, so tool_use pairing is untouched —
    the exact shape the CLI itself uses for out-of-band notes). Fire-once: clears
    the queue after injecting. Returns a log dict, or None if nothing pending /
    the flag is off. NOT the real mechanism — no receipt/ack/dedup here."""
    if not DELIVER_PROTOTYPE:
        return None
    sid = (writer_mod._session_ids(obj) or [None])[0]
    if not sid:
        return None
    pending = _DELIVER_QUEUE.get(sid)
    if not pending:
        return None
    text = "\n\n".join(pending)
    orig = _inject_into_last_user(obj, text, sep="\n\n")
    if orig is None:                 # no user message to ride (shouldn't happen)
        return None
    _DELIVER_QUEUE.pop(sid, None)    # fire-once
    return {"session": sid, "items": len(pending), "chars": len(text)}


def _decide_injection(obj):
    """Return (text_to_append, reason) for this request, or (None, None).

    Priority: file-volunteer > marker-gated > unconditional.
      * INJECT_FILE   — append the file's current contents as a system-reminder,
        but ONLY on a genuine prompt turn (the last user message has text). We
        skip tool_result continuations inside a tool loop (their last 'user'
        message carries no prompt text), so we volunteer the context once per
        user turn rather than on every hop.
      * INJECT_MARKER — append INJECT_TEXT only when the prompt contains the marker.
      * INJECT        — unconditional append."""
    if INJECT_FILE:
        if _last_user_text(obj):  # genuine prompt turn, not a tool_result hop
            txt = _file_volunteer_text(INJECT_FILE)
            if txt:
                return (txt, f"file_volunteer:{INJECT_FILE}")
        return (None, None)
    if INJECT_MARKER:
        lut = _last_user_text(obj) or ""
        if INJECT_MARKER in lut:
            return (INJECT_TEXT, f"marker:{INJECT_MARKER!r}")
        return (None, None)
    if INJECT:
        return (INJECT, "unconditional")
    return (None, None)
