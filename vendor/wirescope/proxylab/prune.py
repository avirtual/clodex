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
Hygiene note: warmth.sqlite rows are the SWEEPER's job (WARMTH_PURGE_SLACK),
not ours — pruning disk never mutates the store.

ON-DEMAND ONLY: nothing runs unless called (GET = free readout, POST =
execute; dry_run=1 previews). No background age-sweep — if one is ever
wanted it should ride the existing sweeper behind an env gate, after the
on-demand path has proven the predicates. The PRUNE_*_DAYS env knobs are
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
    file written by live traffic resets it."""
    body_f = body_b = rec_f = rec_b = 0
    newest = 0.0
    for f in d.iterdir():
        if not f.is_file():
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        newest = max(newest, st.st_mtime)
        if _is_body(f.name):
            body_f += 1
            body_b += st.st_size
        else:
            rec_f += 1
            rec_b += st.st_size
    return body_f, body_b, rec_f, rec_b, newest


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


def prune_scan(log_dir=None):
    """The GET /_prune readout: where the disk went + what the default-cutoff
    prunes would reclaim. One filesystem walk, no deletion, no store access."""
    root = Path(log_dir) if log_dir else core_mod.LOG_DIR
    now = time.time()
    cut_bodies = now - PRUNE_BODIES_DAYS * 86400
    cut_full = now - PRUNE_FULL_DAYS * 86400
    cut_nosess = now - PRUNE_NOSESSION_DAYS * 86400
    sess = {"count": 0, "bytes": 0, "body_bytes": 0, "receipt_bytes": 0}
    rec_bodies = {"sessions": 0, "bytes": 0}
    rec_full = {"sessions": 0, "bytes": 0}
    for d in _session_dirs(root):
        bf, bb, rf, rb, newest = _dir_stats(d)
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
    return {
        "ok": True, "log_dir": str(root),
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
