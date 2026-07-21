import json
import os
import re
import threading
import time
from pathlib import Path

from proxylab import core as core_mod
from proxylab import writer as writer_mod

# ---- VERSION-DRIFT CANARY (read-only; on by default) ----------------------
# Borrowed from claude-code-cache-fix's upstream-change-detection: every lever in
# this proxy is version-fragile (split byte-offsets, the `# Environment` header,
# tool names, cache_control marker COUNT/positions). A silent CLI wire-shape
# change makes a transform no-op with zero signal. This builds a content-light
# STRUCTURAL fingerprint per (model, anthropic-beta) namespace, persists a
# baseline, and logs+prints a `structural_change` whenever the shape drifts.
# It is the early-warning system for "Anthropic shipped a CLI update that may have
# broken our transforms" — and, specifically, it tracks the total cache_control
# MARKER COUNT, so the day the CLI starts emitting a 4th marker (which it does NOT
# today) the canary fires immediately. Read-only: never mutates the request, runs
# on the ORIGINAL body before our transforms. Disable with CANARY=0.
CANARY_ENABLED = os.environ.get("CANARY", "1") not in ("0", "no", "off", "false")
_CANARY_DIR = Path(os.environ.get("CANARY_DIR", str(core_mod.LOG_DIR / "_canary")))
_CANARY_BASELINES = {}                    # namespace -> compared-fingerprint dict
_CANARY_LOCK = threading.Lock()
_CANARY_LOADED = False

def _size_bucket(n):
    """Coarse log2 bucket so benign size jitter doesn't fire the canary."""
    b = 0
    while n > 1:
        n >>= 1
        b += 1
    return b


def _count_markers(blocks):
    return sum(1 for b in blocks
               if isinstance(b, dict) and b.get("cache_control")) \
        if isinstance(blocks, list) else 0


def _request_fingerprint(obj, headers):
    """Content-light structural shape of a /v1/messages request. Stable across
    normal conversation growth (message COUNT/content excluded from the diff);
    fires on tool-set, system-block-shape, or cache_control-marker changes."""
    tools = obj.get("tools") or []
    sys = obj.get("system")
    sys_blocks = sys if isinstance(sys, list) else ([{"text": sys}] if sys else [])
    msgs = obj.get("messages") or []
    msg_markers = sum(_count_markers(m.get("content")) for m in msgs
                      if isinstance(m, dict))
    tool_markers = _count_markers(tools)
    sys_markers = _count_markers(sys_blocks)
    sys_sig = []
    for b in sys_blocks:
        t = b.get("text", "") if isinstance(b, dict) else (b if isinstance(b, str) else "")
        cc = b.get("cache_control") if isinstance(b, dict) else None
        sys_sig.append({
            "hdr": (t or "")[:48],
            "size_bucket": _size_bucket(len(t or "")),
            "cc": cc.get("type") if isinstance(cc, dict) else None,
            "ttl": cc.get("ttl") if isinstance(cc, dict) else None,
        })
    beta = sorted(h.strip() for h in (headers.get("anthropic-beta", "") or "").split(",") if h.strip())
    return {
        "model": obj.get("model"),
        "beta": beta,
        "n_tools": len(tools),
        "tool_names": sorted(t.get("name") for t in tools
                             if isinstance(t, dict) and t.get("name")),
        "n_sys_blocks": len(sys_blocks),
        "sys_sig": sys_sig,
        "markers": {"tools": tool_markers, "system": sys_markers,
                    "messages": msg_markers,
                    "total": tool_markers + sys_markers + msg_markers},
    }


def _fp_diff(old, new):
    """Human-readable list of structural differences between two fingerprints."""
    diffs = []
    for k in ("n_tools", "n_sys_blocks"):
        if old.get(k) != new.get(k):
            diffs.append(f"{k}: {old.get(k)} -> {new.get(k)}")
    if old.get("tool_names") != new.get("tool_names"):
        o, n = set(old.get("tool_names") or []), set(new.get("tool_names") or [])
        if n - o:
            diffs.append(f"tools added: {sorted(n - o)}")
        if o - n:
            diffs.append(f"tools removed: {sorted(o - n)}")
    if old.get("beta") != new.get("beta"):
        diffs.append(f"beta: {old.get('beta')} -> {new.get('beta')}")
    om, nm = old.get("markers") or {}, new.get("markers") or {}
    for k in ("tools", "system", "messages", "total"):
        if om.get(k) != nm.get(k):
            diffs.append(f"markers.{k}: {om.get(k)} -> {nm.get(k)}")
    if old.get("sys_sig") != new.get("sys_sig"):
        os_, ns = old.get("sys_sig") or [], new.get("sys_sig") or []
        for i in range(max(len(os_), len(ns))):
            a = os_[i] if i < len(os_) else None
            b = ns[i] if i < len(ns) else None
            if a != b:
                diffs.append(f"sys_block[{i}]: {a} -> {b}")
    return diffs


def _canary_check(obj, headers, seq):
    """Compare this request's structural fingerprint to the persisted baseline for
    its (model, beta) namespace; on drift, log + print a structural_change. Returns
    a small dict for the request record. Read-only, fail-open."""
    if not CANARY_ENABLED:
        return None
    global _CANARY_LOADED
    try:
        fp = _request_fingerprint(obj, headers)
    except Exception:
        return None
    ns = f"{fp.get('model')}|{','.join(fp.get('beta') or [])}"
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", ns)[:120] or "default"
    with _CANARY_LOCK:
        if not _CANARY_LOADED:
            try:
                for p in _CANARY_DIR.glob("baseline-*.json"):
                    d = json.loads(p.read_text())
                    _CANARY_BASELINES[d.get("_ns", p.stem)] = d.get("fingerprint", d)
            except Exception:
                pass
            _CANARY_LOADED = True
        old = _CANARY_BASELINES.get(ns)
        if old is None:
            _CANARY_BASELINES[ns] = fp
            writer_mod._enqueue_json(_CANARY_DIR / f"baseline-{safe}.json",
                          {"_ns": ns, "first_seq": seq, "fingerprint": fp})
            print(f"[canary] #{seq} new namespace baseline {ns!r}: "
                  f"{fp['n_tools']} tools, {fp['n_sys_blocks']} sys-blocks, "
                  f"{fp['markers']['total']} markers", flush=True)
            return {"namespace": ns, "event": "baseline", "markers": fp["markers"]}
        diffs = _fp_diff(old, fp)
        if not diffs:
            return {"namespace": ns, "event": "match", "markers": fp["markers"]}
        # drift: record, persist the new baseline, shout
        _CANARY_BASELINES[ns] = fp
        event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "seq": seq,
                 "namespace": ns, "diffs": diffs, "old": old, "new": fp}
        writer_mod._enqueue_append(_CANARY_DIR / "changes.jsonl", event)
        writer_mod._enqueue_json(_CANARY_DIR / f"baseline-{safe}.json",
                      {"_ns": ns, "first_seq": seq, "fingerprint": fp})
        marker_moved = old.get("markers", {}).get("total") != fp["markers"]["total"]
        bang = "  *** CACHE-MARKER COUNT CHANGED ***" if marker_moved else ""
        print(f"[canary] #{seq} STRUCTURAL CHANGE {ns!r}: {'; '.join(diffs)}{bang}",
              flush=True)
        return {"namespace": ns, "event": "structural_change", "diffs": diffs,
                "marker_count_changed": marker_moved, "markers": fp["markers"]}
