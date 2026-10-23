"""Durable cost history by agent name: the ledger behind GET /_costs.

WHY. The operator's question is "what did this category of seat cost over that
range" (one team's hands, every reviewer, a nightly job). The only durable cost
record was LOG_DIR/<sid>/_session.json plus one *.response.json receipt per
request: a full receipt scan takes minutes (never on a request path), and
/_prune tier=full deletes both. cost_rollup is an additive hourly rollup keyed
(hour, agent, session_id, provider, model, line, agent_type) that survives
pruning. The category is a caller-supplied regex over the route agent name,
applied at read time, so no application's naming grammar lives in the proxy.

FEED. receipts.anthropic/openai enqueue one row per finalized response right
after billing._accumulate (writer kind "cost"). The counters are produced by
billing._bump itself on the same bill and stop, so requests, turns, tokens and
est_usd agree with the session totals by construction.

THE BACKFILL INVARIANT. A cutoff is persisted once per owner and never moved,
by whichever comes first in a SERVING process: server._lifespan (start_backfill,
before the first request) or the first live row (_add_rows, which the writer
thread runs before that response's receipt file). So every receipt with mtime
>= cutoff has a live row, and the backfill counts only receipts with mtime <
cutoff. Not at import: offline tools import the whole proxy against a live
LOG_DIR and the shared store (analyze_busts.py), and a cutoff pinned there would
orphan every receipt the running deployment writes until the new one starts.
Each dir's rows commit together with its cost_backfill_dirs marker in ONE
transaction, so a restart mid-backfill resumes at the next undone dir and
nothing is counted twice or skipped.

BACKFILL FIDELITY. A receipt is mapped from its own fields only: agent (else
session_meta.agent), session_id, provider (absent = anthropic), billing, role,
sidecall, keepwarm, agent_type, and billing.endpoint + meta.stop_reason/status
for the turn rule of receipts.anthropic/openai. A receipt written before the
sidecall / keepwarm fields existed cannot tell a title side-call or a ping from
a main-line call: it lands on line "main", and a title side-call that ended
end_turn counts as a turn.

BASIS. est_usd is the STORED capture-time value of each bill (the same basis as
the session totals and /_status), never repriced at read time.

OWNER. Rows, cutoff and done-set are scoped by store.OWNER (the resolved
LOG_DIR), like every per-instance table: proxy ports share one store file, and
each LOG_DIR has its own receipts, its own cutoff and its own history.
"""
import contextlib
import datetime
import json
import math
import os
import re
import sqlite3
import threading
import time
import urllib.parse
from pathlib import Path

from proxylab import billing as billing_mod
from proxylab import core as core_mod
from proxylab import store as store_mod

KEYS = ("hour", "agent", "session_id", "provider", "model", "line", "agent_type")
COUNTERS = ("requests", "billed_requests", "turns", "input_tokens",
            "output_tokens", "cache_read_tokens", "cache_write_tokens",
            "unpriced_requests", "est_usd")
DIMENSIONS = ("agent", "line", "model", "provider", "agent_type")
SPLITS = ("line", "model", "provider", "agent_type")
BUCKETS = ("day", "week", "hour")
BASIS = "stored capture-time est_usd"
MAX_PATTERN = 500
DEFAULT_RANGE_S = 30 * 86400
SERIES_TOP = 8
TOP_AGENTS = 10
UNMATCHED = "(unmatched)"
SKIP_DIRS = ("_canary",)
BACKFILL_YIELD_S = 0.005
PARAM_KEYS = ("since", "until", "match", "group", "split", "bucket")
MAX_PRESET_NAME = 80
MAX_PRESET_PARAMS = 4096
WHEN_MIN = 0.0
WHEN_MAX = datetime.datetime(2100, 1, 1, tzinfo=datetime.timezone.utc).timestamp()

store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS cost_rollup ("
    "owner TEXT NOT NULL, hour INTEGER NOT NULL, agent TEXT NOT NULL, "
    "session_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, "
    "line TEXT NOT NULL, agent_type TEXT NOT NULL, "
    "requests INTEGER NOT NULL DEFAULT 0, "
    "billed_requests INTEGER NOT NULL DEFAULT 0, "
    "turns INTEGER NOT NULL DEFAULT 0, "
    "input_tokens INTEGER NOT NULL DEFAULT 0, "
    "output_tokens INTEGER NOT NULL DEFAULT 0, "
    "cache_read_tokens INTEGER NOT NULL DEFAULT 0, "
    "cache_write_tokens INTEGER NOT NULL DEFAULT 0, "
    "unpriced_requests INTEGER NOT NULL DEFAULT 0, "
    "est_usd REAL NOT NULL DEFAULT 0, "
    "PRIMARY KEY (owner, hour, agent, session_id, provider, model, line, "
    "agent_type))",
    "CREATE TABLE IF NOT EXISTS cost_backfill ("
    "owner TEXT PRIMARY KEY, cutoff REAL NOT NULL, state TEXT NOT NULL, "
    "files_total INTEGER NOT NULL DEFAULT 0, "
    "files_done INTEGER NOT NULL DEFAULT 0, "
    "files_counted INTEGER NOT NULL DEFAULT 0, "
    "files_skipped INTEGER NOT NULL DEFAULT 0, "
    "files_bad INTEGER NOT NULL DEFAULT 0, "
    "dirs_total INTEGER NOT NULL DEFAULT 0, "
    "dirs_done INTEGER NOT NULL DEFAULT 0, "
    "started_at REAL, finished_at REAL)",
    "CREATE TABLE IF NOT EXISTS cost_backfill_dirs ("
    "owner TEXT NOT NULL, dir TEXT NOT NULL, PRIMARY KEY (owner, dir))",
    "CREATE TABLE IF NOT EXISTS cost_presets ("
    "owner TEXT NOT NULL, name TEXT NOT NULL, params TEXT NOT NULL, "
    "created REAL NOT NULL, PRIMARY KEY (owner, name))")

_UPSERT = (
    "INSERT INTO cost_rollup(owner, " + ", ".join(KEYS + COUNTERS) + ") "
    "VALUES(" + ", ".join("?" * (1 + len(KEYS) + len(COUNTERS))) + ") "
    "ON CONFLICT(owner, " + ", ".join(KEYS) + ") DO UPDATE SET "
    + ", ".join(f"{c}={c}+excluded.{c}" for c in COUNTERS))

_CUTOFF = None
_BACKFILL_LOCK = threading.Lock()


def _cutoff():
    global _CUTOFF
    if _CUTOFF is None:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("INSERT OR IGNORE INTO cost_backfill(owner, cutoff, state) "
                        "VALUES(?,?,?)", (store_mod.OWNER, time.time(), "pending"))
            con.commit()
            row = con.execute("SELECT cutoff FROM cost_backfill WHERE owner=?",
                              (store_mod.OWNER,)).fetchone()
        _CUTOFF = row[0]
    return _CUTOFF


def _line(rec):
    if rec.get("keepwarm"):
        return "keepwarm"
    if rec.get("sidecall"):
        return f"sidecall:{rec['sidecall']}"
    return "main" if rec.get("role") in ("parent", "unknown", None) else "subagent"


def _key(rec, hour, agents=None):
    bill = rec.get("billing") or {}
    sid = rec.get("session_id") or ""
    agent = rec.get("agent") or ((agents or {}).get(sid) if sid else None)
    if agent == "ext":
        agent = None
    return (int(hour), str(agent or ""), str(sid),
            str(rec.get("provider") or "anthropic"),
            str(bill.get("model") or rec.get("model") or ""),
            _line(rec), str(rec.get("agent_type") or ""))


def _counts(bill, is_turn):
    t = billing_mod._new_totals()
    billing_mod._bump(t, bill, {"is_turn": bool(is_turn)})
    return tuple(t[c] for c in COUNTERS)


def _merge(agg, key, counts):
    have = agg.get(key)
    agg[key] = counts if have is None else tuple(a + b for a, b in zip(have, counts))


def _write(con, agg):
    con.executemany(_UPSERT, [(store_mod.OWNER, *k, *v) for k, v in agg.items()])


def _add_rows(rows):
    try:
        _cutoff()
        agg = {}
        for r in rows:
            if not isinstance(r.get("billing"), dict):
                continue
            at = r.get("at") or time.time()
            _merge(agg, _key(r, at // 3600), _counts(r["billing"], r.get("is_turn")))
        if not agg:
            return
        con = store_mod.db()
        with store_mod.LOCK:
            try:
                _write(con, agg)
                con.commit()
            except Exception:
                con.rollback()
                raise
    except Exception as e:
        print(f"[costs] ledger write failed: {e!r}", flush=True)


def live_row(*, agent, session_id, provider, bill, stop, role=None,
             sidecall=None, keepwarm=False, agent_type=None, model=None):
    return {"agent": agent, "session_id": session_id, "provider": provider,
            "billing": bill, "role": role, "sidecall": sidecall,
            "keepwarm": bool(keepwarm), "agent_type": agent_type,
            "model": model, "is_turn": bool((stop or {}).get("is_turn")),
            "at": time.time()}


def _receipt_is_turn(rec):
    meta = rec.get("meta") if isinstance(rec.get("meta"), dict) else {}
    endpoint = (rec.get("billing") or {}).get("endpoint")
    if endpoint == "responses":
        return bool(meta.get("status") == "completed" and meta.get("text")
                    and not rec.get("sidecall"))
    return bool(endpoint == "messages"
                and not rec.get("sidecall") and not rec.get("keepwarm")
                and rec.get("role") in ("parent", "unknown")
                and meta.get("stop_reason") not in (None, "tool_use"))


def _ro():
    if store_mod._DB is None:
        store_mod.db()
    uri = Path(store_mod.DB_PATH).absolute().as_uri() + "?mode=ro"
    return contextlib.closing(sqlite3.connect(uri, uri=True, timeout=5.0))


def _backfill_status(con):
    cur = con.execute("SELECT * FROM cost_backfill WHERE owner=?",
                      (store_mod.OWNER,))
    row = cur.fetchone()
    names = [d[0] for d in cur.description]
    if row is None:
        return {"state": "absent"}
    out = dict(zip(names, row))
    out.pop("owner", None)
    return out


def backfill_status():
    con = store_mod.db()
    with store_mod.LOCK:
        return _backfill_status(con)


def _session_agents():
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            return dict(con.execute("SELECT session_id, agent FROM session_meta "
                                    "WHERE agent IS NOT NULL").fetchall())
    except sqlite3.Error:
        return {}


def _receipts(d):
    try:
        with os.scandir(d) as it:
            return [e for e in it if e.name.endswith(".response.json") and e.is_file()]
    except OSError:
        return []


def _pending_dirs(root, done):
    try:
        with os.scandir(root) as it:
            names = [e.name for e in it if e.is_dir()]
    except OSError:
        return []
    return sorted(n for n in names if n not in SKIP_DIRS and n not in done)


def _scan_dir(d, cutoff, agents):
    agg = {}
    stats = {"done": 0, "counted": 0, "skipped": 0, "bad": 0}
    for e in _receipts(d):
        stats["done"] += 1
        try:
            mtime = e.stat().st_mtime
            if mtime >= cutoff:
                stats["skipped"] += 1
                continue
            with open(e.path, "rb") as fh:
                rec = json.loads(fh.read())
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            stats["bad"] += 1
            continue
        if not isinstance(rec, dict):
            stats["bad"] += 1
            continue
        if not isinstance(rec.get("billing"), dict):
            continue
        try:
            _merge(agg, _key(rec, mtime // 3600, agents),
                   _counts(rec["billing"], _receipt_is_turn(rec)))
        except (TypeError, ValueError, AttributeError):
            stats["bad"] += 1
            continue
        stats["counted"] += 1
    return agg, stats


def _commit_dir(name, agg, stats):
    con = store_mod.db()
    with store_mod.LOCK:
        try:
            con.execute("INSERT INTO cost_backfill_dirs(owner, dir) VALUES(?,?)",
                        (store_mod.OWNER, name))
            _write(con, agg)
            con.execute(
                "UPDATE cost_backfill SET files_done=files_done+?, "
                "files_counted=files_counted+?, files_skipped=files_skipped+?, "
                "files_bad=files_bad+?, dirs_done=dirs_done+1, "
                "files_total=MAX(files_total, files_done+?) WHERE owner=?",
                (stats["done"], stats["counted"], stats["skipped"], stats["bad"],
                 stats["done"], store_mod.OWNER))
            con.commit()
        except sqlite3.IntegrityError:
            con.rollback()
            return False
        except Exception:
            con.rollback()
            raise
    return True


def _set_state(sql, args):
    con = store_mod.db()
    with store_mod.LOCK:
        con.execute(sql, (*args, store_mod.OWNER))
        con.commit()


def _backfill(root, sleep_fn, yield_s):
    cutoff = _cutoff()
    if backfill_status().get("state") == "done":
        return backfill_status()
    con = store_mod.db()
    with store_mod.LOCK:
        done = {r[0] for r in con.execute(
            "SELECT dir FROM cost_backfill_dirs WHERE owner=?", (store_mod.OWNER,))}
    pending = _pending_dirs(root, done)
    remaining = sum(len(_receipts(root / n)) for n in pending)
    t0 = time.monotonic()
    _set_state("UPDATE cost_backfill SET state='running', "
               "started_at=COALESCE(started_at, ?), files_total=files_done+?, "
               "dirs_total=dirs_done+? WHERE owner=?",
               (time.time(), remaining, len(pending)))
    print(f"[costs] backfill start: {len(pending)} dirs, {remaining} receipts, "
          f"cutoff {_iso(cutoff)} ({len(done)} dirs already done)", flush=True)
    agents = _session_agents()
    for name in pending:
        agg, stats = _scan_dir(root / name, cutoff, agents)
        _commit_dir(name, agg, stats)
        sleep_fn(yield_s)
    _set_state("UPDATE cost_backfill SET state='done', finished_at=? WHERE owner=?",
               (time.time(),))
    st = backfill_status()
    print(f"[costs] backfill done: {len(pending)} dirs, {st['files_counted']} "
          f"counted, {st['files_skipped']} at/after cutoff, {st['files_bad']} bad, "
          f"{time.monotonic() - t0:.1f}s", flush=True)
    return st


def start_backfill():
    try:
        _cutoff()
    except sqlite3.Error as e:
        print(f"[costs] cutoff not persisted, no backfill: {e!r}", flush=True)
        return None
    t = threading.Thread(target=backfill, name="costs-backfill", daemon=True)
    t.start()
    return t


def backfill(sleep_fn=time.sleep, yield_s=None):
    if not _BACKFILL_LOCK.acquire(blocking=False):
        return None
    try:
        return _backfill(core_mod.LOG_DIR, sleep_fn,
                         BACKFILL_YIELD_S if yield_s is None else yield_s)
    except Exception as e:
        print(f"[costs] backfill stopped: {e!r}", flush=True)
        return None
    finally:
        _BACKFILL_LOCK.release()


def _iso(ts, fmt="%Y-%m-%dT%H:%M:%S"):
    return None if ts is None else time.strftime(fmt, time.localtime(ts))


_REL = re.compile(r"(\d+(?:\.\d+)?)([wdh])")
_REL_S = {"w": 7 * 86400, "d": 86400, "h": 3600}


def _parse_when(s, now, name):
    s = (s or "").strip()
    if not s:
        return None
    m = _REL.fullmatch(s)
    if m:
        ts = now - float(m.group(1)) * _REL_S[m.group(2)]
    elif re.fullmatch(r"\d+(?:\.\d+)?", s):
        ts = float(s)
    else:
        try:
            ts = datetime.datetime.fromisoformat(s).timestamp()
        except (ValueError, OverflowError, OSError):
            raise ValueError(f"{name}: expected ISO date/datetime, epoch seconds "
                             f"or a relative 7d / 24h / 2w, got {s!r}") from None
    if not WHEN_MIN <= ts <= WHEN_MAX:
        raise ValueError(f"{name}: {s!r} is outside 1970-01-01 .. 2100-01-01")
    return ts


def _compile(pattern, name):
    if len(pattern) > MAX_PATTERN:
        raise ValueError(f"{name}: pattern over {MAX_PATTERN} chars")
    try:
        return re.compile(pattern)
    except re.error as e:
        raise ValueError(f"{name}: {e}") from None


def _grouper(spec):
    if not spec or spec == "@agent":
        return "agent", ["agent"], None, None
    if spec.startswith("@"):
        dim = spec[1:]
        if dim not in DIMENSIONS:
            raise ValueError(f"group: unknown dimension {spec!r}; one of "
                             + ", ".join("@" + d for d in DIMENSIONS))
        return dim, [dim], None, None
    rx = _compile(spec, "group")
    if rx.groupindex:
        names = sorted(rx.groupindex, key=rx.groupindex.get)
        return None, names, rx, lambda m: tuple(m.group(n) for n in names)
    if rx.groups:
        return (None, [f"g{i}" for i in range(1, rx.groups + 1)], rx,
                lambda m: m.groups())
    return None, ["g0"], rx, lambda m: (m.group(0),)


def _label(gk):
    if gk is None:
        return UNMATCHED
    return " / ".join("—" if v is None else (v or "(none)") for v in gk)


def _bucket_start(ts, bucket):
    if bucket == "hour":
        return int(ts // 3600 * 3600)
    lt = time.localtime(ts)
    d = datetime.date(lt.tm_year, lt.tm_mon, lt.tm_mday)
    if bucket == "week":
        d -= datetime.timedelta(days=lt.tm_wday)
    return int(time.mktime(d.timetuple()))


def _bucket_next(start, bucket):
    if bucket == "hour":
        return start + 3600
    lt = time.localtime(start)
    d = datetime.date(lt.tm_year, lt.tm_mon, lt.tm_mday) + datetime.timedelta(
        days=7 if bucket == "week" else 1)
    return int(time.mktime(d.timetuple()))


def _counter_dict(c):
    d = dict(zip(COUNTERS, c))
    d["est_usd"] = round(d["est_usd"], 6)
    return d


def _preset_params(params):
    if params is None:
        params = ""
    if not isinstance(params, str):
        raise ValueError("params: expected the query string, e.g. group=@line&split=model")
    params = params.strip().lstrip("?")
    if len(params) > MAX_PRESET_PARAMS:
        raise ValueError(f"params: over {MAX_PRESET_PARAMS} chars")
    kept = {k: v for k, v in urllib.parse.parse_qsl(params) if k in PARAM_KEYS and v}
    _parse_params(kept, time.time())
    return urllib.parse.urlencode([(k, kept[k]) for k in PARAM_KEYS if k in kept])


def _preset_name(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name: required, a non-empty string")
    name = name.strip()
    if len(name) > MAX_PRESET_NAME:
        raise ValueError(f"name: over {MAX_PRESET_NAME} chars")
    return name


def save_preset(name, params):
    row = {"name": _preset_name(name), "params": _preset_params(params),
           "created": time.time()}
    con = store_mod.db()
    with store_mod.LOCK:
        con.execute("INSERT INTO cost_presets(owner, name, params, created) "
                    "VALUES(?,?,?,?) ON CONFLICT(owner, name) DO UPDATE SET "
                    "params=excluded.params, created=excluded.created",
                    (store_mod.OWNER, row["name"], row["params"], row["created"]))
        con.commit()
    return row


def delete_preset(name):
    name = _preset_name(name)
    con = store_mod.db()
    with store_mod.LOCK:
        n = con.execute("DELETE FROM cost_presets WHERE owner=? AND name=?",
                        (store_mod.OWNER, name)).rowcount
        con.commit()
    return n > 0


def _presets(con):
    rs = con.execute("SELECT name, params, created FROM cost_presets "
                     "WHERE owner=? ORDER BY name", (store_mod.OWNER,)).fetchall()
    return [{"name": n, "params": p, "created": c} for n, p, c in rs]


def presets():
    with _ro() as con:
        return _presets(con)


def _new_acc():
    return {"c": [0] * len(COUNTERS), "sessions": set(), "agents": {},
            "split": {}}


def _parse_params(params, now):
    since = _parse_when(params.get("since"), now, "since")
    until = _parse_when(params.get("until"), now, "until")
    until = now if until is None else until
    since = until - DEFAULT_RANGE_S if since is None else since
    if until <= since:
        raise ValueError("until must be after since")
    match = params.get("match") or None
    match_rx = _compile(match, "match") if match else None
    group = params.get("group") or None
    dim, columns, group_rx, extract = _grouper(group)
    split = params.get("split") or None
    if split is not None and split not in SPLITS:
        raise ValueError("split: one of " + ", ".join(SPLITS))
    bucket = params.get("bucket") or "day"
    if bucket not in BUCKETS:
        raise ValueError("bucket: one of " + ", ".join(BUCKETS))
    return (since, until, match, match_rx, group, dim, columns, group_rx, extract,
            split, bucket)


def query(params, now=None):
    now = time.time() if now is None else now
    (since, until, match, match_rx, group, dim, columns, group_rx, extract,
     split, bucket) = _parse_params(params, now)
    lo, hi = int(since // 3600), int(math.ceil(until / 3600))
    with _ro() as con:
        rows = con.execute(
            "SELECT " + ", ".join(KEYS + COUNTERS) + " FROM cost_rollup "
            "WHERE owner=? AND hour>=? AND hour<?",
            (store_mod.OWNER, lo, hi)).fetchall()
        cov = con.execute("SELECT MIN(hour), MAX(hour) FROM cost_rollup "
                          "WHERE owner=?", (store_mod.OWNER,)).fetchone()
        bf = _backfill_status(con)
        saved = _presets(con)
    dim_at = {d: KEYS.index(d) for d in DIMENSIONS}
    nk = len(KEYS)
    usd_at = nk + COUNTERS.index("est_usd")
    matched, keymemo, bmemo = {}, {}, {}
    total = _new_acc()
    groups, series = {}, {}
    for r in rows:
        agent, sid = r[1], r[2]
        if match_rx is not None:
            ok = matched.get(agent)
            if ok is None:
                ok = matched[agent] = match_rx.search(agent) is not None
            if not ok:
                continue
        if dim is not None:
            gk = (r[dim_at[dim]],)
        else:
            if agent not in keymemo:
                m = group_rx.search(agent)
                keymemo[agent] = None if m is None else tuple(extract(m))
            gk = keymemo[agent]
        g = groups.get(gk)
        if g is None:
            g = groups[gk] = _new_acc()
        usd = r[usd_at]
        for acc in (total, g):
            c = acc["c"]
            for i in range(len(COUNTERS)):
                c[i] += r[nk + i]
            if sid:
                acc["sessions"].add(sid)
        total["agents"][agent] = True
        a = g["agents"].get(agent)
        if a is None:
            a = g["agents"][agent] = [0.0, set()]
        a[0] += usd
        if sid:
            a[1].add(sid)
        if split is not None:
            sv = r[dim_at[split]]
            g["split"][sv] = g["split"].get(sv, 0.0) + usd
        b = bmemo.get(r[0])
        if b is None:
            b = bmemo[r[0]] = _bucket_start(r[0] * 3600, bucket)
        sb = series.setdefault(b, {})
        sb[gk] = sb.get(gk, 0.0) + usd
    total_usd = total["c"][COUNTERS.index("est_usd")]
    ordered = sorted(groups, key=lambda k: (-groups[k]["c"][-1], _label(k)))
    out_groups = []
    for gk in ordered:
        g = groups[gk]
        usd = g["c"][-1]
        if gk is None:
            key = {c: None for c in columns}
            key[columns[0]] = UNMATCHED
        else:
            key = dict(zip(columns, gk))
        entry = {"key": key, "label": _label(gk), **_counter_dict(g["c"]),
                 "pct": round(100.0 * usd / total_usd, 2) if total_usd else 0.0,
                 "sessions": len(g["sessions"]), "agents": len(g["agents"]),
                 "usd_per_session": (round(usd / len(g["sessions"]), 6)
                                     if g["sessions"] else None),
                 "top_agents": [
                     {"agent": ag, "est_usd": round(v[0], 6), "sessions": len(v[1])}
                     for ag, v in sorted(g["agents"].items(),
                                         key=lambda kv: (-kv[1][0], kv[0]))[:TOP_AGENTS]]}
        if gk is None:
            entry["unmatched"] = True
        if split is not None:
            entry["split"] = {v: round(u, 6) for v, u in sorted(
                g["split"].items(), key=lambda kv: (-kv[1], kv[0]))}
        out_groups.append(entry)
    top = ordered[:SERIES_TOP]
    top_set = set(top)
    labels = [_label(gk) for gk in top]
    points = []
    for b in sorted(series):
        vals = series[b]
        est = [round(vals.get(gk, 0.0), 6) for gk in top]
        est.append(round(sum(u for gk, u in vals.items() if gk not in top_set), 6))
        points.append({"start": b, "label": _iso(b, "%Y-%m-%dT%H:%M" if bucket == "hour"
                                                  else "%Y-%m-%d"),
                       "est_usd": est})
    return {
        "costs_version": 1,
        "basis": BASIS,
        "range": {"since": since, "until": until, "since_local": _iso(since),
                  "until_local": _iso(until), "hour_from": lo * 3600,
                  "hour_to": hi * 3600},
        "match": match,
        "group": {"pattern": group, "columns": columns,
                  "dimension": f"@{dim}" if dim is not None else None},
        "split": split,
        "bucket": bucket,
        "totals": {**_counter_dict(total["c"]),
                   "sessions": len(total["sessions"]),
                   "agents": len(total["agents"])},
        "groups": out_groups,
        "series": {"bucket": bucket, "groups": labels + ["other"], "points": points},
        "backfill": {k: bf.get(k) for k in (
            "state", "cutoff", "files_done", "files_total", "files_counted",
            "files_skipped", "files_bad", "dirs_done", "dirs_total",
            "started_at", "finished_at")},
        "coverage": {"first_hour": None if cov[0] is None else cov[0] * 3600,
                     "last_hour": None if cov[1] is None else cov[1] * 3600,
                     "first_local": None if cov[0] is None else _iso(cov[0] * 3600),
                     "last_local": None if cov[1] is None else _iso(cov[1] * 3600)},
        "presets": saved,
    }

