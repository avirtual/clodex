"""proxylab — the wirescope implementation (split from the monolith 2026-06-11,
made lazily importable 2026-06-12).

THE PACKAGE IS LAZY (PEP 562): `from proxylab import billing` boots only
billing's own dependency chain (core, writer) — no sweeper thread, no state
restore, no server app. The parts are importable as a library by other
projects; each module's import-time side effects live with their owner:

  core   env/LOG_DIR/version + shared httpx client
  writer the background disk-writer thread
  pinger the staleness sweeper thread
  server _restore_state() + the Starlette app  (importing server IS the boot)

THE LAB BOOT is the repo-root `logproxy.py` shim (uvicorn logproxy:app,
`import logproxy as lp` in tests/drivers): it imports every module eagerly in
the original monolith order, so the full proxy behaves exactly as before.

Dependency rules that keep growth sane (enforce in review):
  * core and store import nothing from the package (writer: lazy refs only).
  * A module CREATES ONLY ITS OWN TABLES (see proxylab.store) and mutates
    only its own globals; cross-module access goes through functions.
  * server/receipts may know everyone; nobody (but the shim) knows server.
"""
import importlib

_MODULES = ("core", "store", "codex", "transforms", "canary", "writer",
            "warmth", "subs", "meta", "pinger", "hold", "billing",
            "receipts", "report", "prune", "restore", "status", "views",
            "server")


def __getattr__(name):
    if name in _MODULES:
        return importlib.import_module(f"proxylab.{name}")
    raise AttributeError(f"module 'proxylab' has no attribute {name!r}")


def __dir__():
    return sorted(set(globals()) | set(_MODULES))
