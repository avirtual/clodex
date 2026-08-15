"""Account quota: the `anthropic-ratelimit-unified-*` response headers.

The API tells every successful response how much of the plan's rolling windows
the ACCOUNT has burned (`...-5h-utilization`, `...-7d-utilization`, …). We have
been capturing those headers verbatim into `.response.json` since the beginning
and reading them nowhere — this module is the reader.

Three things make this unlike the rest of the proxy's state:

  * SCOPE IS THE ACCOUNT, NOT THE SESSION. Every session on the box, every
    agent, every subagent reports the same numbers, because they all spend the
    same plan. So it is keyed by organization id and surfaces ONCE at the top
    level of /_status, not per-session.
  * IT IS ONLY AS FRESH AS THE LAST FORWARDED TURN. Nothing here is polled; an
    idle proxy's numbers age. Hence `as_of`/`age_s` on every snapshot — a
    consumer that renders a percentage without the age is lying by omission.
  * A 429 CARRIES NO QUOTA HEADERS AT ALL (measured: 102/102 in a 4k-capture
    window). The rejection body is `{"type":"rate_limit_error"}` with no
    utilization, so the last good numbers stay the state and the 429 is tracked
    beside them as its own fact (`last_429`).

Parsing is DELIBERATELY GENERIC. Windows are discovered from the header names
rather than hardcoded, because they demonstrably appear without warning: a
`7d_oi` meter showed up in 256 of the same 4k captures. An unrecognized header
lands in `unmapped` instead of being dropped, so a new meter is visible the day
it ships rather than the day someone re-greps the captures.
"""
import os
import time

from proxylab import core as core_mod
from proxylab import store as store_mod

QUOTA_TRACK = os.environ.get("QUOTA_TRACK", "1") not in ("0", "off", "")

_PREFIX = "anthropic-ratelimit-unified-"
# suffixes that make the leading part a WINDOW name (5h / 7d / overage / …)
_WINDOW_FIELDS = ("surpassed-threshold", "disabled-reason", "utilization",
                  "status", "reset")
# names that are whole-account, not per-window
_TOP_FIELDS = {"status", "reset", "representative-claim",
               "fallback-percentage", "upgrade-paths"}
# The API's word for "this is the window that binds you" -> our window key.
# MEASURED, NOT GUESSED (98,456 captures, 2026-08-15): the only three claim
# strings the wire has ever sent are `five_hour` (76,784), `seven_day` (20,620)
# and `seven_day_overage_included` (1,052). An earlier version of this map
# invented `seven_day_oi` by analogy with the `7d_oi-*` header prefix — a string
# the wire never sends — which silently nulled `primary` on ~1% of turns. The
# header prefix and the claim word are DIFFERENT vocabularies; do not derive one
# from the other, and add a mapping here only after seeing it in captures.
_CLAIM_WINDOW = {"seven_day": "7d", "five_hour": "5h",
                 "seven_day_overage_included": "7d_oi",
                 "overage": "overage"}

_QUOTA = {}          # account key -> parsed snapshot (see _parse)
_LAST_ACCOUNT = None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse(headers):
    """Wire headers -> {top-level fields, windows{}, unmapped{}}. Returns None
    when the response carried no unified-ratelimit headers at all (models stub,
    count_tokens, codex, every 429)."""
    fields, windows, unmapped = {}, {}, {}
    for k, v in (headers or {}).items():
        k = k.lower()
        if not k.startswith(_PREFIX):
            continue
        rest = k[len(_PREFIX):]
        if rest in _TOP_FIELDS:
            fields[rest.replace("-", "_")] = v
            continue
        for f in _WINDOW_FIELDS:          # longest-first, see _WINDOW_FIELDS
            if rest.endswith("-" + f):
                windows.setdefault(rest[:-len(f) - 1], {})[
                    f.replace("-", "_")] = v
                break
        else:
            unmapped[k] = v               # a meter we have never seen
    if not fields and not windows and not unmapped:
        return None
    return {"fields": fields, "windows": windows, "unmapped": unmapped}


def note(headers, *, status_code=None, now=None):
    """Record the quota headers off a finished upstream response. Called from
    receipts for every anthropic-wire response; cheap and lock-free enough to
    sit on that path (a dict scan of ~30 headers)."""
    if not QUOTA_TRACK:
        return
    global _LAST_ACCOUNT
    now = now or time.time()
    # callers pass whatever their client handed them; normalize once so the
    # org lookup and _parse agree regardless of the wire library's casing.
    headers = {str(k).lower(): v for k, v in (headers or {}).items()}
    acct = (headers.get("anthropic-organization-id") or "default")
    parsed = _parse(headers)
    if parsed is None:
        if status_code == 429:
            # Quota rejection with no numbers on it. Keep it next to whatever
            # the last good reading was — never let it overwrite one.
            # ATTRIBUTION: a 429 need not carry the org header either, and
            # filing it under "default" would park it beside no reading at all
            # (the bar would show a stale percentage and no sign of the wall
            # being hit). Fall back to the account we last read from.
            key = acct if acct in _QUOTA else _LAST_ACCOUNT
            cur = _QUOTA.get(key)
            if cur is not None:
                cur["last_429"] = now
                _persist(key, cur)
        return
    entry = dict(parsed)
    entry["as_of"] = now
    entry["org_id"] = headers.get("anthropic-organization-id")
    entry["workspace_id"] = headers.get("anthropic-workspace-id")
    prev = _QUOTA.get(acct) or {}
    if prev.get("last_429"):
        entry["last_429"] = prev["last_429"]
    _QUOTA[acct] = entry
    _LAST_ACCOUNT = acct
    _persist(acct, entry)


def _window_view(name, raw, now):
    util = _num(raw.get("utilization"))
    reset = _num(raw.get("reset"))
    out = {"window": name,
           "utilization": util,
           # both directions spelled out: a status bar wants "7% left", a
           # gauge wants "93% used", and neither should do float math on a
           # string it parsed out of a percentage it rendered itself.
           "used_pct": round(util * 100, 1) if util is not None else None,
           "remaining_pct": round(100 - util * 100, 1) if util is not None else None,
           "status": raw.get("status"),
           "reset": int(reset) if reset is not None else None,
           "resets_in_s": (max(0, int(reset - now)) if reset is not None else None)}
    if raw.get("surpassed_threshold") is not None:
        out["surpassed_threshold"] = _num(raw["surpassed_threshold"])
    if raw.get("disabled_reason") is not None:
        out["disabled_reason"] = raw["disabled_reason"]
    return out


def snapshot(now=None):
    """The /_status `quota` block: the most recently seen account's numbers,
    display-ready. None when nothing has been observed yet (fresh proxy that
    has not forwarded a successful turn)."""
    if not QUOTA_TRACK or not _QUOTA:
        return None
    now = now or time.time()
    acct = _LAST_ACCOUNT if _LAST_ACCOUNT in _QUOTA else max(
        _QUOTA, key=lambda a: _QUOTA[a].get("as_of") or 0)
    e = _QUOTA[acct]
    f = e.get("fields") or {}
    windows = {k: _window_view(k, v, now)
               for k, v in (e.get("windows") or {}).items()}
    claim = f.get("representative_claim")
    rep = _CLAIM_WINDOW.get(claim)
    if rep not in windows:
        rep = None
    reset = _num(f.get("reset"))
    out = {
        "as_of": e["as_of"],
        # freshness is part of the reading, not metadata about it — these
        # numbers move only when a turn is forwarded.
        "age_s": round(now - e["as_of"], 1),
        "source": "response_headers",
        "status": f.get("status"),
        "reset": int(reset) if reset is not None else None,
        "resets_in_s": max(0, int(reset - now)) if reset is not None else None,
        # which window the API itself says is the binding one — this is the
        # number to put on a status bar when there is room for exactly one.
        "representative_claim": claim,
        "representative_window": rep,
        "primary": windows.get(rep) if rep else None,
        "windows": windows,
        "org_id": e.get("org_id"),
        "workspace_id": e.get("workspace_id"),
        "accounts": len(_QUOTA),
    }
    if f.get("fallback_percentage") is not None:
        out["fallback_percentage"] = _num(f["fallback_percentage"])
    if f.get("upgrade_paths"):
        out["upgrade_paths"] = [p.strip() for p in f["upgrade_paths"].split(",")
                                if p.strip()]
    if e.get("last_429"):
        out["last_429"] = e["last_429"]
        out["last_429_age_s"] = round(now - e["last_429"], 1)
    if e.get("unmapped"):
        # a meter we do not model yet: surfaced raw rather than swallowed
        out["unmapped"] = e["unmapped"]
    return out


def receipt_view(now=None):
    """The compact form for a per-turn subscriber receipt: the binding window
    plus each window's used/remaining, no ids or plumbing. Kept small because
    this rides EVERY turn.completed — a consumer wanting the full picture polls
    /_status. On a turn that carried headers this is fresh by construction
    (age_s ~0); on one that did not (a 429) it is the last good reading, which
    is exactly when a consumer most wants to see it."""
    snap = snapshot(now)
    if not snap:
        return None
    return {"status": snap.get("status"),
            "representative_window": snap.get("representative_window"),
            "primary": snap.get("primary"),
            "used_pct": {k: v.get("used_pct")
                         for k, v in (snap.get("windows") or {}).items()},
            "resets_in_s": snap.get("resets_in_s"),
            "age_s": snap.get("age_s")}


# --- persistence ------------------------------------------------------------
# Owner-scoped like the other runtime tables. A restart otherwise shows no
# quota at all until the next forwarded turn, which for an idle fleet can be
# a long time — and a stale-but-stamped reading beats a blank one, because
# `age_s` makes the staleness legible.
store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS quota_state ("
    "owner TEXT NOT NULL, account TEXT NOT NULL, as_of REAL NOT NULL, "
    "payload TEXT NOT NULL, PRIMARY KEY (owner, account))")


def _persist(acct, entry):
    try:
        import json
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT OR REPLACE INTO quota_state "
                "(owner, account, as_of, payload) VALUES (?,?,?,?)",
                (store_mod.OWNER, acct, entry["as_of"], json.dumps(entry)))
            con.commit()
    except Exception as e:
        core_mod.ERROR_COUNTS["quota_errors"] = (
            core_mod.ERROR_COUNTS.get("quota_errors", 0) + 1)
        print(f"[quota] persist failed: {e}", flush=True)


def restore():
    """Reload the last known reading per account at startup. Returns the number
    of accounts restored."""
    global _LAST_ACCOUNT
    if not QUOTA_TRACK:
        return 0
    try:
        import json
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT account, as_of, payload FROM quota_state WHERE owner=?",
                (store_mod.OWNER,)).fetchall()
    except Exception as e:
        print(f"[quota] restore failed: {e}", flush=True)
        return 0
    best, best_ts = None, 0
    for acct, as_of, payload in rows:
        try:
            _QUOTA[acct] = json.loads(payload)
        except Exception:
            continue
        if as_of > best_ts:
            best, best_ts = acct, as_of
    if best:
        _LAST_ACCOUNT = best
    return len(_QUOTA)
