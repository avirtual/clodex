"""pot — standing per-file redundant-read aggregation ("boiling pot" tier 2).

The live, rolling promotion of the one-off `grok_ceiling.md` classification:
for every main-line Read, decide whether it was REDUNDANT (its content already
sat in the caller's context window) and accumulate per-file daily counters that
`GET /_pot` serves back, ranked by wasted tokens. The consumer (clodex) joins
these onto its own tier-1 in-app heat counts; our columns are the enrichment
only request-body reconstruction can compute. Contract + frozen shape:
`~/.clodex/messages/clodex/pot_contract.md` (boiling-pot-plan.md §Tier 2).

REDUNDANT definition (FROZEN — stability > precision; it is the kill-criteria
denominator for the read-once hook + grok skill, so it must not silently drift):
a Read is redundant iff, within the current COMPACTION WINDOW,
  1. >=80% of its requested line-span was already delivered by prior Read(s) of
     the same normalized abs path, AND
  2. no intervening edit (Edit/Write/MultiEdit/NotebookEdit) to that path since
     those prior reads (an edit REFRESHES the file -> the next read is genuinely
     new content, never redundant).
Full-file read (no offset/limit) spans [0, FULL_READ_LINES) for the overlap
denominator. redundant_tokens = the read's tool_result size in chars / 4,
first-ship. Window resets at every detected /compact boundary (post-compact the
content genuinely left context — the same signal since_compact uses).

SOURCE: request-body message history alone — the assistant `tool_use` blocks
carry full Read inputs (path/offset/limit) and the paired user `tool_result`
blocks carry the returned content whose length is the token weight. No
response-stream tee. Ingestion is INCREMENTAL per turn: an in-memory cursor
tracks how far into a session's history we've read, so each turn processes only
newly-appended messages (O(new), not O(history)). The cursor persists (one int
per session) so a proxy restart resumes without re-ingesting -> no double-count;
the in-memory span state is NOT persisted, so reads in the first window after a
restart lose redundancy-vs-pre-restart-reads (a small, CONSERVATIVE under-count
of the share — never an over-claim — that self-heals next compact). Main-line
only (subagents share the parent's session_id and never advance its head).
"""
import datetime

from . import core as core_mod
from . import store as store_mod

# ---- frozen constants (the contract; a retune is a shape-version bump) --------
OVERLAP_THRESHOLD = 0.80    # >= this fraction already-in-context => redundant
FULL_READ_LINES = 5000      # a full-file read's span for the overlap denominator
DEFAULT_LIMIT = 2000        # CLI Read default line count when limit is omitted
CHARS_PER_TOKEN = 4         # first-ship token estimate
RETENTION_DAYS = 14         # default trailing window + prune horizon
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}

store_mod.register_schema(
    # per-(deployment, file, day) rolling counters. owner = LOG_DIR so a scratch
    # port never mixes into the managed deployment's heat. Daily buckets so a
    # `?days=N` trailing window is a WHERE day >= cutoff sum, matching tier-1's
    # N-day retention. reads = the classified denominator (redundant SHARE is
    # self-consistent from tier-2 alone, never mixed with tier-1's tool_use count).
    "CREATE TABLE IF NOT EXISTS file_heat ("
    "owner TEXT NOT NULL, file TEXT NOT NULL, day TEXT NOT NULL, "
    "reads INTEGER NOT NULL DEFAULT 0, "
    "redundant_reads INTEGER NOT NULL DEFAULT 0, "
    "redundant_tokens INTEGER NOT NULL DEFAULT 0, "
    "PRIMARY KEY (owner, file, day))",
    # one integer per session: how many history messages we've ingested. Persists
    # so a restart resumes incrementally instead of re-scanning a live window into
    # the accumulator (which would double-count). Span state stays in memory.
    "CREATE TABLE IF NOT EXISTS file_heat_cursor ("
    "owner TEXT NOT NULL, session_id TEXT NOT NULL, "
    "ingested INTEGER NOT NULL DEFAULT 0, "
    "PRIMARY KEY (owner, session_id))")

# in-memory per-session window state (rebuilt from live traffic after a restart):
#   cursor  = messages ingested (mirrors the persisted row, avoids a read per turn)
#   spans   = {norm_path: [(start,end), ...]} line-ranges seen this window
#   dirty   = {norm_path} edited since their last read (next read = not redundant)
#   pending = {tool_use_id: (norm_path, (start,end))} reads awaiting their result
_STATE: dict = {}


def _norm(fp):
    import os
    return os.path.normpath(fp) if fp else fp


def _span(inp):
    """(start, end) line range for a Read input; full-file -> [0, FULL_READ_LINES)."""
    off = inp.get("offset")
    lim = inp.get("limit")
    if off is None and lim is None:
        return (0, FULL_READ_LINES)
    start = off or 0
    return (start, start + (lim or DEFAULT_LIMIT))


def _covered(span, prior):
    """Fraction of `span`'s lines already covered by the union of `prior` spans."""
    s, e = span
    e = min(e, s + FULL_READ_LINES)      # cap unbounded for the % math
    if e <= s:
        return 1.0
    clipped = []
    for a, b in prior:
        a, b = max(a, s), min(b, e)
        if b > a:
            clipped.append((a, b))
    if not clipped:
        return 0.0
    clipped.sort()
    cov = 0
    cur_s, cur_e = clipped[0]
    for a, b in clipped[1:]:
        if a <= cur_e:
            cur_e = max(cur_e, b)
        else:
            cov += cur_e - cur_s
            cur_s, cur_e = a, b
    cov += cur_e - cur_s
    return cov / (e - s)


def _result_chars(block):
    """char length of a tool_result block's content (string or block list)."""
    c = block.get("content")
    if isinstance(c, str):
        return len(c)
    if isinstance(c, list):
        return sum(len(x.get("text", "")) for x in c if isinstance(x, dict))
    return 0


def _blocks(msg):
    c = msg.get("content")
    return c if isinstance(c, list) else []


def _upsert(deltas, day):
    """Apply {file: [dreads, dred, dtok]} into the daily bucket in one txn."""
    if not deltas:
        return
    con = store_mod.db()
    with store_mod.LOCK:
        for f, (dr, drd, dt) in deltas.items():
            con.execute(
                "INSERT INTO file_heat(owner, file, day, reads, redundant_reads, "
                "redundant_tokens) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(owner, file, day) DO UPDATE SET "
                "reads = reads + excluded.reads, "
                "redundant_reads = redundant_reads + excluded.redundant_reads, "
                "redundant_tokens = redundant_tokens + excluded.redundant_tokens",
                (store_mod.OWNER, f, day, dr, drd, dt))
        con.commit()


def _save_cursor(session_id, ingested):
    con = store_mod.db()
    with store_mod.LOCK:
        con.execute(
            "INSERT INTO file_heat_cursor(owner, session_id, ingested) VALUES(?,?,?) "
            "ON CONFLICT(owner, session_id) DO UPDATE SET ingested = excluded.ingested",
            (store_mod.OWNER, session_id, ingested))
        con.commit()


def _load_cursor(session_id):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            r = con.execute(
                "SELECT ingested FROM file_heat_cursor WHERE owner=? AND session_id=?",
                (store_mod.OWNER, session_id)).fetchone()
        return int(r[0]) if r else 0
    except Exception:
        return 0


def ingest(session_id, obj, is_compact):
    """Classify the newly-appended Reads in this main-line request and roll the
    per-file counters. Called from the server main-line hook (guarded parent/
    unknown, not side_call). Best-effort: any failure is swallowed so heat
    instrumentation never perturbs the forward path."""
    try:
        if not session_id or not isinstance(obj, dict):
            return
        msgs = obj.get("messages")
        if not isinstance(msgs, list):
            return
        st = _STATE.get(session_id)
        if st is None:
            # first sight this process: resume from the persisted cursor (0 for a
            # genuinely new session -> full backfill of its short history; a live
            # value after a restart -> ingest only the un-seen tail, no re-count).
            st = _STATE[session_id] = {"cursor": _load_cursor(session_id),
                                       "spans": {}, "dirty": set(), "pending": {}}
        if is_compact:
            # window boundary: content left context. Fresh span state; re-anchor
            # the cursor to the (now short) post-compact history so the next tail
            # is measured from here (the summary carries no tool_use to lose).
            st["spans"], st["dirty"], st["pending"] = {}, set(), {}
            st["cursor"] = 0
        cursor = st["cursor"]
        if cursor > len(msgs):        # history contracted without a flagged compact
            cursor = 0                # (defensive) -> re-anchor rather than skip
            st["spans"], st["dirty"], st["pending"] = {}, set(), {}
        spans, dirty, pending = st["spans"], st["dirty"], st["pending"]
        deltas = {}                   # file -> [dreads, dredundant, dtokens]

        def bump(f, red, tok):
            d = deltas.setdefault(f, [0, 0, 0])
            d[0] += 1
            if red:
                d[1] += 1
                d[2] += tok

        for msg in msgs[cursor:]:
            role = msg.get("role")
            for blk in _blocks(msg):
                if not isinstance(blk, dict):
                    continue
                t = blk.get("type")
                if t == "tool_use":
                    name = blk.get("name")
                    inp = blk.get("input") or {}
                    fp = _norm(inp.get("file_path"))
                    if name in EDIT_TOOLS:
                        if fp and fp in spans:
                            dirty.add(fp)
                    elif name == "Read" and fp:
                        tid = blk.get("id")
                        if tid:
                            pending[tid] = (fp, _span(inp))
                elif t == "tool_result":
                    tid = blk.get("tool_use_id")
                    hit = pending.pop(tid, None)
                    if not hit:
                        continue
                    fp, sp = hit
                    tok = _result_chars(blk) // CHARS_PER_TOKEN
                    prior = spans.get(fp)
                    if prior is None:
                        bump(fp, False, tok)          # first read of the path
                        spans[fp] = [sp]
                    elif fp in dirty:
                        bump(fp, False, tok)          # read after own edit (changed)
                        dirty.discard(fp)
                        spans[fp] = [sp]              # edit reset the known content
                    else:
                        red = _covered(sp, prior) >= OVERLAP_THRESHOLD
                        bump(fp, red, tok)
                        prior.append(sp)

        st["cursor"] = len(msgs)
        _upsert(deltas, datetime.date.today().isoformat())
        _save_cursor(session_id, st["cursor"])
    except Exception:
        pass


def snapshot(days=RETENTION_DAYS):
    """Build the GET /_pot payload: per-file rolling counters over the trailing
    `days`-day window, files[] ranked by redundant_tokens desc, plus window-wide
    totals (the kill-criteria number). Frozen shape (pot_contract.md); files=[]
    + zero totals when nothing is classified yet (linked-but-empty != null)."""
    try:
        days = max(1, int(days))
    except (TypeError, ValueError):
        days = RETENTION_DAYS
    cutoff = (datetime.date.today() - datetime.timedelta(days=days - 1)).isoformat()
    files, totals = [], {"reads": 0, "redundant_reads": 0, "redundant_tokens": 0}
    frm = None
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT file, SUM(reads), SUM(redundant_reads), SUM(redundant_tokens), "
                "MIN(day) FROM file_heat WHERE owner=? AND day>=? GROUP BY file",
                (store_mod.OWNER, cutoff)).fetchall()
    except Exception:
        rows = []
    for f, r, rr, rt, mn in rows:
        r, rr, rt = int(r or 0), int(rr or 0), int(rt or 0)
        files.append({"file": f, "reads": r,
                      "redundant_reads": rr, "redundant_tokens": rt})
        totals["reads"] += r
        totals["redundant_reads"] += rr
        totals["redundant_tokens"] += rt
        frm = mn if frm is None else min(frm, mn)
    files.sort(key=lambda x: -x["redundant_tokens"])
    # "wirescope" since 2026-07-19, matching /_identity (was "logproxy" from
    # before the rename; clodex confirmed its consumer keys only on files[]).
    return {"product": "wirescope", "version": core_mod.VERSION,
            "window": {"from": frm, "to": datetime.date.today().isoformat(),
                       "days": days},
            "totals": totals, "files": files}
