"""Compat shim over the `proxylab` package (mechanical split, 2026-06-11).

The implementation that used to live in this one ~4700-line file is now the
`proxylab/` package, cut along the original section banners (see
proxylab/__init__.py for the module list + import order). This shim keeps both
historical consumers working unchanged:

  * uvicorn logproxy:app            (start_proxy.sh)
  * import logproxy as lp           (test_warmth_store.py, ad-hoc drivers)

Attribute access is forwarded LAZILY (PEP 562 module __getattr__) to the
owning submodule, so globals that are REBOUND at runtime (_DB, _CANARY_LOADED,
_TOTALS_AT_START, env flags the tests flip) are always read live — they are
never copied into this namespace.

NOTE: ASSIGNING through the shim (`lp.X = v`) does NOT propagate to the
owning module — it would just shadow the lazy lookup here. Assign on the
owning module instead, e.g. `lp.warmth.WARMTH_LEDGER = False`.
"""
from proxylab.server import app  # noqa: F401  (eager: uvicorn logproxy:app)
from proxylab import (core, store, codex, transforms, canary, writer, warmth,  # noqa: F401
                      subs, meta, pinger, hold, billing, quota, receipts, report,
                      prune, restore, status, views, server,
                      fold, hints, hints_native, tokest, bake_session)

# Fixed search order for __getattr__ (original file order; server last). Names
# duplicated across modules are only by-name imports of the same object, so any
# hit is the right object and the order rarely matters.
#
# EVERY module in the package must be here, or this shim silently under-resolves:
# a name living only in an unlisted module raises AttributeError, and a REBINDABLE
# GLOBAL there reads as missing rather than live — which is how `lp.HINTS` and
# `lp.FOLD_EXPERIMENTAL` returned False while `lp.SORT_TOOLS` worked (2026-08-11).
# test_registry.py asserts the SET against the directory listing; per-name checks
# are what let this drift in the first place.
_SUBMODULES = (core, store, codex, transforms, canary, writer, warmth, subs,
               meta, pinger, hold, billing, quota, receipts, report, prune,
               restore, status, views, server,
               fold, hints, hints_native, tokest, bake_session)


def __getattr__(name):
    for _m in _SUBMODULES:
        try:
            return getattr(_m, name)
        except AttributeError:
            continue
    raise AttributeError(f"module 'logproxy' has no attribute {name!r}")


def __dir__():
    names = set(globals())
    for _m in _SUBMODULES:
        names.update(n for n in dir(_m) if not n.startswith("__"))
    return sorted(names)
