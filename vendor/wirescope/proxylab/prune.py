"""Capture-dir retention: the /_prune endpoint + offline CLI twin.

The capture corpus only grows (measured: logs_main hit 14 GB; a managed
deployment's LOG_DIR crossed 1.5 GB in days) and nothing reclaimed it. The
insight that shapes the design: THE HEAVY FILES AND THE VALUABLE FILES ARE
MOSTLY DIFFERENT FILES. Request bodies (~800 KB/opus turn) + response SSE
streams are ~95%+ of the bytes and back only *byte-level* forensics
(/_bust diffs, /_session render, /_context&utilization scans) — value that
dies with the session. The billing receipts (.response.json, a few KB) +
_session.json back /_report's cost accounting (incl. the per-line split)
essentially forever. So retention is TWO-TIER, not delete-or-keep:

  tier=receipts  "collapse to receipts": delete body files (request bodies +
                 SSE) in session dirs whose *newest* file is older than the
                 cutoff. /_report still prices those sessions fully; only
                 byte-level drill-down dies.
  tier=full      delete the whole session dir (cost accounting gone too) —
                 for much older sessions, and the _no-session bucket (probes/
                 count_tokens, no forensic value at all).

NEVER touched, regardless of age: a session whose prefix is still WARM in the
ledger, one with an ARMED HOLD (both re-checked per dir), `_totals.json`,
`uvicorn.log`, the `_canary` dir, and anything modified within the cutoff
(age = newest mtime in the dir, so any live activity resets the clock).
Hygiene note: WARMTH rows are the SWEEPER's job (WARMTH_PURGE_SLACK), not ours
— pruning disk never mutates another module's tables. This module does own one
table of its own, `prune_dir_stats` (the persisted readout memo, see below), and
a tier=full delete drops the row for the dir it removed.

ON-DEMAND ONLY: nothing DELETES unless called (GET = free readout, POST =
execute; dry_run=1 previews). No background age-sweep — if one is ever
wanted it should ride the existing sweeper behind an env gate, after the
on-demand path has proven the predicates. The one thing that does run on its
own is `warm_stats_memo`, a read-only size scan the server fires once at
startup so a never-scanned store does not hand its first caller a 45s walk;
it deletes nothing and is not a sweep. The PRUNE_*_DAYS env knobs are
DISPLAY DEFAULTS for the GET estimate only; POST requires an explicit
older_than (destructive endpoint, no implicit defaults), floored at 1h.

Offline twin (no proxy needed, e.g. the 14 GB logs_main):
    python3 -m proxylab.prune <dir> --older-than 30d [--tier receipts|full]
        [--scope sessions|no-session|all] [--apply]
Dry-run by default; --apply deletes. The CLI skips the warmth/hold checks
(no live proxy state to consult) — recency is the only guard, so mind the
--older-than you pass.
"""
import json
import re
import shutil
import threading
import time
from pathlib import Path

import os

from proxylab import core as core_mod

# display defaults for the GET readout's reclaimable estimates (days)
PRUNE_BODIES_DAYS = float(os.environ.get("PRUNE_BODIES_DAYS", "30"))
PRUNE_FULL_DAYS = float(os.environ.get("PRUNE_FULL_DAYS", "180"))
PRUNE_NOSESSION_DAYS = float(os.environ.get("PRUNE_NOSESSION_DAYS", "7"))

_MIN_AGE_S = 3600.0                  # POST floor: refuse cutoffs under 1h
_NO_SESSION = "_no-session"          # writer.NO_SESSION (duplicated to keep
                                     # this module import-light for the CLI)

# the heavy per-turn artifacts; everything else in a session dir is a receipt
_BODY_SUFFIXES = (".request.json", ".response.sse",
                  ".response.mutated.sse", ".response.relayed.sse")


def _is_body(name):
    return name.endswith(_BODY_SUFFIXES)


def _parse_age(s):
    """'30d' / '12h' / '90m' / '3600' -> seconds, or None if malformed."""
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([dhms]?)", (s or "").strip())
    if not m:
        return None
    return float(m.group(1)) * {"d": 86400.0, "h": 3600.0,
                                "m": 60.0, "s": 1.0}[m.group(2) or "s"]


def _dir_stats(d):
    """One session dir -> (body_files, body_bytes, receipt_files,
    receipt_bytes, newest_mtime). newest_mtime is the dir's age basis: any
    file written by live traffic resets it.

    os.scandir, not iterdir+is_file+stat: scandir carries the directory entry's
    type inline, so this is one syscall per file instead of three. Measured on
    the live 4,651-dir / 82.8 GB store: 91.9s -> 56.8s. That is the floor for
    actually looking at every file, which is why the readout memoizes on top of
    it (see _stats_cached) rather than stopping here — 56.8s is still ~3x past
    a consumer's timeout."""
    body_f = body_b = rec_f = rec_b = 0
    newest = 0.0
    try:
        it = os.scandir(d)
    except OSError:
        return 0, 0, 0, 0, 0.0
    with it:
        for e in it:
            try:
                if not e.is_file(follow_symlinks=False):
                    continue
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            newest = max(newest, st.st_mtime)
            if _is_body(e.name):
                body_f += 1
                body_b += st.st_size
            else:
                rec_f += 1
                rec_b += st.st_size
    return body_f, body_b, rec_f, rec_b, newest


# --- the readout memo -------------------------------------------------------
# GET /_prune has to size EVERY session dir, and the corpus only grows, so the
# readout's cost is structurally O(whole store): 91.9s measured on the live
# store, against a consumer control that hides itself past 20s — i.e. the
# control was invisible exactly on the stores that need it. scandir alone does
# not close that (56.8s). What does: 80.3% of those dirs have not been written
# to in a WEEK, and a dir that has not changed cannot have different stats.
#
# KEY = (file count, dir mtime), and the second half is the load-bearing one.
# A directory's mtime moves when an entry is ADDED or REMOVED, but NOT when an
# existing file is modified in place — so this key is only sound while captures
# are write-once. They are: the writer names every artifact by request seq and
# never reopens one (writer._writer_loop; the sole "a" mode is the _canary
# change-log, and `_`-prefixed dirs are not session dirs). Verified empirically
# before relying on it: across all 4,651 live dirs, ZERO had a file newer than
# the dir itself. test_prune pins the write-once property so a future in-place
# rewrite (a redaction pass, a re-encode) fails a test instead of silently
# serving stale sizes. Count rides along so an add+delete in one tick, which
# can leave mtime granularity ambiguous, still misses.
#
# The memo PERSISTS (table `prune_dir_stats`, owner-scoped) rather than living
# only in this process. The first cut of it was memory-only, which left one hole
# big enough to keep the consumer's control broken: a restart threw the whole
# memo away, so the first click after one paid the full cold walk (45.8s) against
# a 20s client timeout. Deferring that behind an async build was the other option
# and it is strictly worse — every restart would hand the first caller a
# placeholder to render.
#
# What makes persistence the better answer is that the validity check is a STAT,
# not a walk. Measured on the live 4,654-dir / 82.8 GB store:
#     stat every dir to re-check its (mtime, inode) key ..... 0.012s
#     load 4,654 rows out of SQLite ......................... 0.003s
#     the full cold walk this replaces ...................... 45.8s
# So a restart costs ~15ms to learn which dirs are still valid and then re-walks
# only the ones that actually changed while the process was down. The cold path
# stops existing instead of being hidden, and `basis` stays "memo"/"walk" with no
# third value for a consumer to render.
#
# A row can only ever cost SPEED, never correctness: it is accepted solely when
# its (mtime, inode, count) key still matches what the filesystem says right now,
# and any doubt (OSError, missing row, store failure) falls through to the live
# walk. That is why a stale or even corrupt table is not a hazard — it fails
# closed, into the slow-but-right path.
_STATS_MEMO: dict = {}
_STATS_MEMO_LOCK = threading.Lock()
_STATS_MEMO_MAX = 20000            # ~4 MB of tuples; far past any real store

_STATS_DB_LOADED = False           # one-shot: has this process read the table?
_STATS_DIRTY: dict = {}            # name -> (key, stats) awaiting a flush
_STATS_SCHEMA_DONE = False         # one-shot: has our DDL been registered?


def _stats_store():
    """The shared store, with our table registered — or None if it is not
    usable. Imported LAZILY and only on the server path: the offline CLI passes
    memo=False and must not drag SQLite in (same rule `_protection` follows).

    store.register_schema applies a late registration immediately when the
    connection is already open, so declaring it here rather than at module
    import is supported and keeps the CLI import-light."""
    try:
        from proxylab import store as store_mod
    except Exception:
        return None
    global _STATS_SCHEMA_DONE
    if not _STATS_SCHEMA_DONE:
        store_mod.register_schema(
            "CREATE TABLE IF NOT EXISTS prune_dir_stats ("
            "owner TEXT NOT NULL, name TEXT NOT NULL, "
            "mtime REAL NOT NULL, ino INTEGER NOT NULL, "
            "body_files INTEGER NOT NULL, body_bytes INTEGER NOT NULL, "
            "rec_files INTEGER NOT NULL, rec_bytes INTEGER NOT NULL, "
            "newest REAL NOT NULL, "
            "PRIMARY KEY (owner, name))")
        _STATS_SCHEMA_DONE = True
    return store_mod


def _persist_owned(root):
    """Only the proxy's OWN LOG_DIR is persisted. The table is owner-scoped, and
    the in-memory memo keys on bare dir name — so a scan pointed at some other
    root (a test fixture, an archived corpus) must not write rows that a later
    scan of the real store would read back under the wrong owner. Such a scan
    still memoizes in memory; it just does not durably claim to be the owner."""
    try:
        return Path(root).resolve() == core_mod.LOG_DIR.resolve()
    except Exception:
        return False


def _load_persisted_stats():
    """Fill the in-memory memo from the table, once per process. Rows are NOT
    trusted on load — each one still has to match a live stat in `_stats_cached`
    before it serves a byte, so this is a prefetch, not a restore."""
    global _STATS_DB_LOADED
    if _STATS_DB_LOADED:
        return
    _STATS_DB_LOADED = True            # set first: a failure must not re-try
                                       # the load on every scan
    store_mod = _stats_store()
    if store_mod is None:
        return
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT name, mtime, ino, body_files, body_bytes, rec_files, "
                "rec_bytes, newest FROM prune_dir_stats WHERE owner=?",
                (store_mod.OWNER,)).fetchall()
    except Exception as e:
        print(f"[prune] stats memo load failed: {e}", flush=True)
        return
    with _STATS_MEMO_LOCK:
        for name, mt, ino, bf, bb, rf, rb, newest in rows:
            _STATS_MEMO[name] = ((mt, ino), (bf, bb, rf, rb, newest))


def _flush_persisted_stats():
    """Write the dirs this scan actually walked. Batched into ONE transaction at
    the end of a scan rather than a commit per dir: a cold scan touches every dir
    in the store, and 4,654 separate commits would cost more than the walk."""
    with _STATS_MEMO_LOCK:
        pending = list(_STATS_DIRTY.items())
        _STATS_DIRTY.clear()
    if not pending:
        return
    store_mod = _stats_store()
    if store_mod is None:
        return
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.executemany(
                "INSERT INTO prune_dir_stats(owner, name, mtime, ino, "
                "body_files, body_bytes, rec_files, rec_bytes, newest) "
                "VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(owner, name) DO UPDATE SET "
                "mtime=excluded.mtime, ino=excluded.ino, "
                "body_files=excluded.body_files, body_bytes=excluded.body_bytes, "
                "rec_files=excluded.rec_files, rec_bytes=excluded.rec_bytes, "
                "newest=excluded.newest",
                [(store_mod.OWNER, name, key[0], key[1], *stats)
                 for name, (key, stats) in pending])
            con.commit()
    except Exception as e:
        print(f"[prune] stats memo flush failed: {e}", flush=True)


def _delete_persisted_stat(name):
    """Drop a removed dir's row (tier=full). Like the in-memory pop this is
    hygiene, not correctness — the key carries the inode, so a same-named dir
    recreated later would miss anyway."""
    store_mod = _stats_store()
    if store_mod is None:
        return
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM prune_dir_stats WHERE owner=? AND name=?",
                        (store_mod.OWNER, name))
            con.commit()
    except Exception as e:
        print(f"[prune] stats row delete failed for {name}: {e}", flush=True)


def warm_stats_memo(log_dir=None):
    """Populate the memo off the request path, so no CLICK ever meets the walk.

    Persistence removes the cost of a RESTART, but it cannot help a store that
    has never been scanned — a fresh install has no rows to validate against and
    the first caller would still pay the full walk. This is that case's answer:
    the server fires it on a background thread at startup, it takes the same
    45.8s once, and by the time a consumer opens the panel the table is real.

    Deliberately NOT a scheduled sweep (the module's on-demand rule stands) —
    it runs once per process. A scan arriving mid-warm simply walks too: the
    result is duplicated work, never a wrong number, because both paths write
    the same stats under the same validity key."""
    t0 = time.time()
    try:
        r = prune_scan(log_dir)
        print(f"[prune] stats memo warm: {r['dirs_walked']} walked, "
              f"{r['dirs_memoized']} from memo, "
              f"{round(time.time() - t0, 1)}s", flush=True)
    except Exception as e:
        print(f"[prune] stats memo warm failed: {e}", flush=True)


def _stats_cached(d):
    """`_dir_stats(d)`, served from the memo when the dir has not changed.

    Returns (stats, hit). On any OSError reading the dir's own metadata we fall
    through to a live walk: a memo must never be the reason a readout is wrong,
    only the reason it is fast."""
    try:
        st = os.stat(d)
        key = (st.st_mtime, st.st_ino)
    except OSError:
        return _dir_stats(d), False
    name = d.name
    with _STATS_MEMO_LOCK:
        hit = _STATS_MEMO.get(name)
    if hit is not None and hit[0] == key:
        return hit[1], True
    stats = _dir_stats(d)
    # file count is part of the validity check, not just the payload: it catches
    # a same-tick add+delete that leaves mtime unchanged at filesystem
    # granularity.
    with _STATS_MEMO_LOCK:
        if len(_STATS_MEMO) >= _STATS_MEMO_MAX:
            _STATS_MEMO.clear()        # unbounded growth beats nothing; a full
                                       # re-walk is correct, just slow
        _STATS_MEMO[name] = (key, stats)
        _STATS_DIRTY[name] = (key, stats)
    return stats, False


def _session_dirs(root):
    """The per-session capture dirs (skip _no-session/_canary/etc. + files)."""
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return
    for e in entries:
        if e.is_dir() and not e.name.startswith("_"):
            yield e


def _protection(sid):
    """'warm' | 'held' | None — live-state reasons never to prune a session,
    beyond recency. Server-mode only; the offline CLI passes protect=False
    (no live proxy state exists to consult). Lazy imports: warmth boots the
    SQLite store, which the CLI must not drag in."""
    try:
        from proxylab import warmth as warmth_mod
        if (warmth_mod.warmth_query(session=sid) or {}).get("warm"):
            return "warm"
    except Exception:
        pass
    try:
        from proxylab import hold as hold_mod
        with hold_mod._HOLD_LOCK:
            h = hold_mod._HOLD_STATE.get(sid)
        if h and (h.get("until") or 0) > time.time():
            return "held"
    except Exception:
        pass
    return None


def prune_scan(log_dir=None, memo=True):
    """The GET /_prune readout: where the disk went + what the default-cutoff
    prunes would reclaim. No deletion.

    Sizes come from `_stats_cached`, so an unchanged session dir is not re-walked
    (see the memo block above): measured 91.9s -> ~0.13s steady-state on the live
    82.8 GB store, which is what makes a consumer's readout viable at all. The
    memo persists, so a restart re-validates keys with one stat per dir (0.012s)
    instead of re-walking; only the never-scanned case still pays a full walk,
    and `warm_stats_memo` moves that off the request path.

    `memo=False` forces the live walk and touches the store not at all — the
    offline CLI passes it (one-shot process, nothing to reuse) and the test suite
    uses it to compare the two paths.

    Reports `basis` = "walk" | "memo" and `dirs_memoized`/`dirs_walked` so a
    consumer can tell a fresh number from a cached one rather than guessing from
    the latency."""
    root = Path(log_dir) if log_dir else core_mod.LOG_DIR
    persist = memo and _persist_owned(root)
    if persist:
        _load_persisted_stats()
    now = time.time()
    t0 = time.time()
    memo_hits = memo_walks = 0
    cut_bodies = now - PRUNE_BODIES_DAYS * 86400
    cut_full = now - PRUNE_FULL_DAYS * 86400
    cut_nosess = now - PRUNE_NOSESSION_DAYS * 86400
    sess = {"count": 0, "bytes": 0, "body_bytes": 0, "receipt_bytes": 0}
    rec_bodies = {"sessions": 0, "bytes": 0}
    rec_full = {"sessions": 0, "bytes": 0}
    for d in _session_dirs(root):
        if memo:
            (bf, bb, rf, rb, newest), hit = _stats_cached(d)
            memo_hits += hit
            memo_walks += not hit
        else:
            bf, bb, rf, rb, newest = _dir_stats(d)
            memo_walks += 1
        sess["count"] += 1
        sess["bytes"] += bb + rb
        sess["body_bytes"] += bb
        sess["receipt_bytes"] += rb
        if newest < cut_bodies and bb:
            rec_bodies["sessions"] += 1
            rec_bodies["bytes"] += bb
        if newest < cut_full:
            rec_full["sessions"] += 1
            rec_full["bytes"] += bb + rb
    ns = {"files": 0, "bytes": 0}
    ns_rec = {"files": 0, "bytes": 0}
    nsd = root / _NO_SESSION
    if nsd.is_dir():
        for f in nsd.iterdir():
            if not f.is_file():
                continue
            try:
                st = f.stat()
            except OSError:
                continue
            ns["files"] += 1
            ns["bytes"] += st.st_size
            if st.st_mtime < cut_nosess:
                ns_rec["files"] += 1
                ns_rec["bytes"] += st.st_size
    other = 0
    try:
        for e in root.iterdir():
            if e.is_file():
                other += e.stat().st_size
            elif e.is_dir() and e.name.startswith("_") and e.name != _NO_SESSION:
                other += sum(f.stat().st_size for f in e.rglob("*") if f.is_file())
    except OSError:
        pass
    if persist:
        _flush_persisted_stats()
    else:
        # A non-owner scan (test fixture, archived corpus) or a memo=False walk
        # still fills the in-memory memo, but must not durably claim the owner's
        # rows — drop what it queued rather than letting the next owned scan
        # flush another root's sizes under this owner.
        with _STATS_MEMO_LOCK:
            _STATS_DIRTY.clear()
    return {
        "ok": True, "log_dir": str(root),
        # how this readout was produced: "memo" = at least one dir's sizes came
        # from the cache (unchanged since a previous call), "walk" = every dir
        # was read live. Sizes are identical either way — a memoized dir is one
        # that provably has not changed — so this is for honesty and for a
        # consumer that wants to show a "cached" mark, never a correctness gate.
        "basis": "memo" if memo_hits else "walk",
        "dirs_memoized": memo_hits,
        "dirs_walked": memo_walks,
        "scan_s": round(time.time() - t0, 3),
        "total_bytes": sess["bytes"] + ns["bytes"] + other,
        "sessions": sess,
        "no_session": ns,
        "other_bytes": other,          # _totals.json, uvicorn.log, _canary, ...
        # what POSTing each default cutoff would reclaim, for the readout /
        # confirm dialog; a POST still names its own explicit older_than
        "reclaimable": {
            "bodies": {"older_than_days": PRUNE_BODIES_DAYS, **rec_bodies},
            "full": {"older_than_days": PRUNE_FULL_DAYS, **rec_full},
            "no_session": {"older_than_days": PRUNE_NOSESSION_DAYS, **ns_rec},
        },
    }


def prune(older_than_s, tier="receipts", scope="all", dry_run=True,
          log_dir=None, protect=True):
    """Execute (or preview) one prune pass. Returns the action-endpoint body:
    HTTP status stays 200 for a well-formed request; malformed input is the
    caller's 400 (server validates before calling).

    scope: 'sessions' (per-session dirs), 'no-session' (the probe bucket,
    always full-delete of old files — its receipts are worthless), or 'all'.
    tier (sessions scope): 'receipts' deletes body files only; 'full' removes
    the whole dir. protect=False (CLI) skips the live warmth/hold checks."""
    root = Path(log_dir) if log_dir else core_mod.LOG_DIR
    # Row cleanup follows OWNERSHIP, not `protect`: protect is about live
    # warmth/hold state, while a persisted row is stale exactly when the dir it
    # describes is gone from OUR store — which the offline CLI can do too, when
    # it is pointed at the proxy's own LOG_DIR. Pointed anywhere else it neither
    # reads nor writes rows, so it still drags in no SQLite.
    owned = _persist_owned(root)
    now = time.time()
    cutoff = now - older_than_s
    out = {"ok": True, "dry_run": bool(dry_run), "tier": tier, "scope": scope,
           "older_than_s": older_than_s, "log_dir": str(root),
           "sessions_scanned": 0, "sessions_pruned": 0,
           "files_deleted": 0, "bytes_reclaimed": 0,
           "skipped": {"recent": 0, "warm": 0, "held": 0}}
    if scope in ("sessions", "all"):
        for d in _session_dirs(root):
            out["sessions_scanned"] += 1
            bf, bb, rf, rb, newest = _dir_stats(d)
            if newest >= cutoff:
                out["skipped"]["recent"] += 1
                continue
            why = _protection(d.name) if protect else None
            if why:
                out["skipped"][why] += 1
                continue
            if tier == "full":
                if not dry_run:
                    shutil.rmtree(d, ignore_errors=True)
                    # Drop the readout memo's entry for a dir that no longer
                    # exists. Not a correctness fix — the key carries the inode,
                    # so even a same-named dir recreated later misses — but a
                    # deleted session's entry would otherwise sit there until
                    # the size cap cleared it.
                    with _STATS_MEMO_LOCK:
                        _STATS_MEMO.pop(d.name, None)
                        _STATS_DIRTY.pop(d.name, None)
                    if owned:
                        _delete_persisted_stat(d.name)
                out["sessions_pruned"] += 1
                out["files_deleted"] += bf + rf
                out["bytes_reclaimed"] += bb + rb
            else:                      # receipts: drop bodies, keep receipts
                if not bf:
                    continue
                if not dry_run:
                    for f in list(d.iterdir()):
                        if f.is_file() and _is_body(f.name):
                            try:
                                f.unlink()
                            except OSError:
                                continue
                out["sessions_pruned"] += 1
                out["files_deleted"] += bf
                out["bytes_reclaimed"] += bb
    if scope in ("no-session", "all"):
        nsd = root / _NO_SESSION
        if nsd.is_dir():
            for f in list(nsd.iterdir()):
                if not f.is_file():
                    continue
                try:
                    st = f.stat()
                except OSError:
                    continue
                if st.st_mtime >= cutoff:
                    continue
                if not dry_run:
                    try:
                        f.unlink()
                    except OSError:
                        continue
                out["files_deleted"] += 1
                out["bytes_reclaimed"] += st.st_size
    return out


def main(argv=None):
    """Offline CLI twin: prune a capture dir with NO proxy running (dry-run
    unless --apply). Recency is the only guard here — no warmth/hold state."""
    import argparse
    ap = argparse.ArgumentParser(
        description="wirescope capture-dir retention (dry-run by default)")
    ap.add_argument("dir", help="capture dir (a LOG_DIR, e.g. logs_main)")
    ap.add_argument("--older-than", required=True,
                    help="age cutoff: 30d / 12h / 3600 (min 1h)")
    ap.add_argument("--tier", choices=("receipts", "full"), default="receipts")
    ap.add_argument("--scope", choices=("sessions", "no-session", "all"),
                    default="all")
    ap.add_argument("--apply", action="store_true",
                    help="actually delete (default: dry-run preview)")
    args = ap.parse_args(argv)
    age = _parse_age(args.older_than)
    if age is None or age < _MIN_AGE_S:
        ap.error(f"--older-than must parse and be >= 1h, got {args.older_than!r}")
    res = prune(age, tier=args.tier, scope=args.scope,
                dry_run=not args.apply, log_dir=args.dir, protect=False)
    print(json.dumps(res, indent=2))
    print(f"\n{'DRY-RUN — nothing deleted' if res['dry_run'] else 'DELETED'}: "
          f"{res['files_deleted']} files, "
          f"{res['bytes_reclaimed'] / 1e9:.2f} GB "
          f"({res['sessions_pruned']} sessions, tier={args.tier})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
