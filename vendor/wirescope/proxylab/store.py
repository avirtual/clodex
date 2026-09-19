"""The shared SQLite store: ONE file, ONE connection per process, owner scope.

Split out of warmth.py (2026-06-12) when "the warmth ledger's database" had
quietly become the persistence layer for five other modules. The rule now:

  THE STORE OWNS THE CONNECTION; EACH MODULE OWNS ITS TABLES.

A module declares its schema once at import time with `register_schema(...)`;
the store applies every registered schema when the connection first opens, and
applies late registrations immediately if it is already open — so module
import order never matters here, and no module ever creates another module's
tables. ALTER statements are treated as additive column migrations (failure =
column exists = fine); everything else must be IF-NOT-EXISTS-idempotent.

Current tenants (owner module -> tables):
  warmth -> warmth, session_head     meta -> session_meta
  hold   -> hold_state               pinger -> last_request
  subs   -> subscribers              prune -> prune_dir_stats

WHY SQLite over Redis (2026-06-09, unchanged): stdlib + no daemon to babysit;
durable per-commit by default; no "store unreachable" runtime state to
mishandle now that ABSENCE TRIGGERS ACTION in the warmth gates. WAL +
busy_timeout make the one file safely shareable across proxy processes.
CREDENTIALS NEVER LAND HERE (standing rule) — bodies/hashes/timestamps only.

Two scopes live in the same file:
  * GLOBAL rows (warmth): keyed by content-addressed prefix hash, shared by
    every proxy port on the box by design — one ledger, not eight blind ones.
  * OWNER rows (holds, last-requests, subscribers, …): runtime state that
    belongs to THE proxy instance serving the session. Scoped by
    `owner = resolved LOG_DIR` so a scratch port never resurrects (or
    double-pings) the main proxy's sessions after a restart.
"""
import os
import sqlite3
import threading
from pathlib import Path

from proxylab import core as core_mod

# Env name stays WARMTH_DB for history (warmth was the first tenant) and so
# every existing launch script / release.env keeps working unchanged.
DB_PATH = os.environ.get(
    "WARMTH_DB",
    # repo root (next to the logproxy.py shim), NOT inside proxylab/
    str(Path(__file__).resolve().parent.parent / "warmth.sqlite"))
OWNER = str(core_mod.LOG_DIR.resolve())
LOCK = threading.Lock()
_DB = None
_SCHEMAS: list = []      # flat list of DDL statements, in registration order


def _apply(con, statements):
    for stmt in statements:
        try:
            con.execute(stmt)
        except sqlite3.OperationalError:
            if not stmt.lstrip().upper().startswith("ALTER "):
                raise        # only ALTER means "additive migration, may exist"


def register_schema(*statements):
    """Declare table ownership: the calling module's CREATE TABLE IF NOT
    EXISTS statements plus any ALTER TABLE column migrations, applied in
    order. Call once at module import."""
    _SCHEMAS.extend(statements)
    with LOCK:
        if _DB is not None:        # late registration on an open connection
            _apply(_DB, statements)
            _DB.commit()


def db():
    """Lazily open the shared store. One connection per process, serialized by
    LOCK (write volume is a few rows/sec at peak). Callers hold LOCK around
    their execute()+commit() — the connection is shared, the transactions are
    not."""
    global _DB
    with LOCK:
        if _DB is None:
            con = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=5.0)
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA synchronous=NORMAL")
            con.execute("PRAGMA busy_timeout=5000")
            _apply(con, _SCHEMAS)
            con.commit()
            _DB = con
    return _DB
