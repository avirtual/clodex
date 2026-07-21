import html
import json
import re
import time

from proxylab import billing as billing_mod
from proxylab import codex as codex_mod
from proxylab import core as core_mod
from proxylab import hold as hold_mod
from proxylab import meta as meta_mod
from proxylab import store as store_mod
from proxylab import writer as writer_mod

# --- /_admin: the /_status snapshot rendered for humans ------------------------
# Same read-only data, as a self-refreshing HTML page — JSON is for tools, this
# is for eyeballs. Server-rendered, zero JS, escapes everything (titles are
# model output). Lab-grade like the other endpoints: localhost, unauthenticated.

def _fmt_ago(ts, now=None):
    if not ts:
        return "—"
    d = max(0.0, (now or time.time()) - ts)
    if d < 60:
        return f"{int(d)}s ago"
    if d < 3600:
        return f"{int(d // 60)}m ago"
    if d < 86400:
        return f"{d / 3600:.1f}h ago"
    return f"{d / 86400:.1f}d ago"


def _fmt_dur(s):
    if s is None:
        return "?"
    s = max(0, int(s))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{(s % 3600) // 60:02d}m"


def _fmt_tok(n):
    n = n or 0
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


_ADMIN_CSS = """
body{background:#14161a;color:#cdd3dd;font:13px/1.5 ui-monospace,Menlo,monospace;
     margin:1.2em auto;max-width:1600px;padding:0 1.2em}
a{color:#6ab0de;text-decoration:none} a:hover{text-decoration:underline}
h1{font-size:16px;color:#e6ebf2} h1 small{color:#69707d;font-weight:normal}
table{border-collapse:collapse;width:100%;table-layout:fixed;margin:.8em 0}
th{color:#8a93a3;text-align:left;font-weight:normal;border-bottom:1px solid #2a2e36}
th,td{padding:.32em .6em;vertical-align:top}
/* Deliberate column proportions (sum 100%) via fixed layout — no single column
   greedily absorbs the slack, so the ratio is whatever we set here. */
td.scol{overflow-wrap:anywhere}     /* session: wrap long titles/paths in place */
td.nowrap{white-space:nowrap}       /* the narrow warmth columns don't wrap      */
th:nth-child(1),td:nth-child(1){width:8%}    /* time left */
th:nth-child(2),td:nth-child(2){width:6%}    /* ttl       */
th:nth-child(3),td:nth-child(3){width:7%}    /* tools     */
th:nth-child(4),td:nth-child(4){width:7%}    /* prompt    */
th:nth-child(5),td:nth-child(5){width:39%}   /* session   */
th:nth-child(6),td:nth-child(6){width:7%}    /* last seen */
th:nth-child(7),td:nth-child(7){width:9%}    /* hold      */
th:nth-child(8),td:nth-child(8){width:5%}    /* pingable  */
th:nth-child(9),td:nth-child(9){width:7%}    /* cost      */
th:nth-child(10),td:nth-child(10){width:5%}  /* ref       */
tr:nth-child(even) td{background:#191c21}
.kv span{margin-right:1.4em;white-space:nowrap}
.kv b{color:#e6ebf2;font-weight:600}
.warm{color:#7ec699}.cold{color:#6ab0de}.absent{color:#69707d}
.bad{color:#e06c75}.warn{color:#e5c07b}.dim{color:#69707d}
.badge{border:1px solid #2a2e36;border-radius:3px;padding:0 .35em;margin-right:.3em}
.on{color:#7ec699}.off{color:#69707d}
.subagent{color:#c8a0e0;font-size:12px}.subagent a{color:#c8a0e0;text-decoration:underline}
code{color:#9aa3b2}
"""


def _render_admin_html(snap, host="", show=60):
    e = html.escape
    p = snap["proxy"]
    t = p["totals"]
    s0 = p.get("totals_since_start") or {}
    now = time.time()
    flags = " ".join(
        f'<span class="badge {"on" if v else "off"}">{e(k)}</span>'
        for k, v in (p.get("flags") or {}).items())
    ref = t.get("refusals") or 0
    unp = t.get("unpriced_requests") or 0
    head = (
        f'<h1>wirescope <small>· {e(p.get("version") or "?")} '
        f'· {e(p["log_dir"])} @ {e(host or "localhost")} '
        f'&rarr; {e(p["upstream"])}</small></h1>'
        f'<p class="kv">'
        f'<span>up <b>{e(_fmt_dur(p["uptime_s"]))}</b></span>'
        f'<span>{flags}</span>'
        f'<span>holds <b>{p["holds_armed"]}</b></span>'
        f'<span>replayable <b>{p["tracked_last_requests"]}</b></span></p>'
        f'<p class="kv">'
        f'<span>requests <b>{t["requests"]}</b></span>'
        f'<span>in <b>{e(_fmt_tok(t["input_tokens"]))}</b></span>'
        f'<span>out <b>{e(_fmt_tok(t["output_tokens"]))}</b></span>'
        f'<span>cache r/w <b>{e(_fmt_tok(t["cache_read_tokens"]))}/'
        f'{e(_fmt_tok(t["cache_write_tokens"]))}</b></span>'
        f'<span>est <b>${t["est_usd"]:.4f}</b>'
        f'{f" <span class=warn>(+{unp} unpriced)</span>" if unp else ""}</span>'
        f'<span class="{"bad" if ref else "dim"}">refusals <b>{ref}</b></span>'
        f'<span class="dim">since restart: {s0.get("requests", 0):g} req / '
        f'${s0.get("est_usd", 0):.4f}</span></p>')
    def _row(s):
        w = s["warmth"]
        segs = w.get("segments") or {}
        # head warmth -> two columns: time-left (how long until cold) and ttl.
        if w["state"] == "warm":
            timeleft = (f'<span class="warm">&#128293; '
                        f'{e(_fmt_dur(w["remaining_s"]))}</span>')
            ttlc = f'<span class="dim">{e(_fmt_dur(w["ttl_s"]))}</span>'
        elif w["state"] == "cold":
            timeleft = '<span class="cold">&#10052;&#65039; cold</span>'
            ttlc = '<span class="dim">&mdash;</span>'
        else:
            timeleft = '<span class="absent">&empty;</span>'
            ttlc = '<span class="dim">&mdash;</span>'
        # leading-breakpoint segments, each in its OWN column: same short hash on
        # two rows = those sessions share that cache entry (a sibling's traffic
        # keeps it warm even when this row's own message tail has lapsed). The
        # hash is colour-coded by the segment's own warmth, independent of the
        # head. ⚙ tools = marker 1 (tools + 'you are Claude' preamble); 📜 prompt
        # = marker 2 (+ the full system prompt).
        def _segcell(label, ico, what):
            sg = segs.get(label)
            if not sg:
                return '<span class="dim">&mdash;</span>'
            cls = sg["state"] if sg["state"] in ("warm", "cold") else "absent"
            left = (f' · {_fmt_dur(sg["remaining_s"])} left'
                    if sg["state"] == "warm" and sg.get("remaining_s") else "")
            return (f'<span class="{cls}" title="marker {what} · {e(sg["hash"])}'
                    f' · {e(sg["state"])}{e(left)}">{ico}&#8239;{e(sg["hash"][:6])}</span>')
        toolsc = _segcell("tools", "&#9881;", "tools + preamble")
        promptc = _segcell("system", "&#128220;", "+ system prompt")
        h = s.get("hold")
        if h:
            hold = (f'until {time.strftime("%H:%M", time.localtime(h["until"]))} '
                    f'· {h["pings"]}/{h.get("expected_pings", hold_mod.WARMTH_HOLD_MAX_PINGS)} pings')
            if h.get("failures"):
                hold += f' <span class="bad">{h["failures"]} fail</span>'
            if h.get("last_result"):
                hold += f'<br><span class="dim">{e(str(h["last_result"]))}</span>'
        else:
            hold = '<span class="dim">—</span>'
        if s.get("pingable"):
            ping = '<span class="warm">yes</span>'
        elif s.get("awaiting_auth"):
            ping = '<span class="warn">awaiting auth</span>'
        else:
            ping = '<span class="dim">no</span>'
        c = s.get("cost")
        # whole-tree total; when subagents ran AND the by_line split is known,
        # show the main line's own share so the sub-row costs visibly sum up.
        cmain = (f'<br><span class="dim">main ${c["main_est_usd"]:.4f}</span>'
                 if c and c.get("main_est_usd") is not None
                 and s.get("sub_agents") else "")
        cost = (f'${c["est_usd"]:.4f}<br><span class="dim">{c["requests"]} req'
                f'</span>{cmain}') if c else '<span class="dim">—</span>'
        sref = s.get("refusals") or 0
        sid = s["session_id"]
        kindb = (f' <span class="badge off">&#129302; {e(s["kind"])}</span>'
                 if s.get("kind") else "")
        en = s.get("ended")
        if en:   # ended but resumable; debug state stays until the sweep
            kindb += (f' <span class="badge off">&#127937; ended'
                      f'{" · " + e(str(en["reason"])) if en.get("reason") else ""}'
                      f'</span>')
        # title is [agent] when routed; keep the learned summary visible too
        summ = s.get("summary")
        summ = (f' <span class="dim">{e(summ)}</span>'
                if summ and summ != s.get("title") else "")
        # Task-spawned subagents share this session_id; list them UNDER the main
        # agent (↳) so it's obvious which line is the parent and which are subs,
        # each with its own model + request count. The main row's model stays the
        # parent's (sub turns never overwrite it).
        subs = s.get("sub_agents") or []
        mainlbl = ' <span class="badge">main</span>' if subs else ""
        # real-bust chip: per-class cumulative count, each a write that landed
        # UPSTREAM of the prior cache end (a full/partial prefix re-write at the
        # premium). Tooltip breaks it down by class; supersedes the old
        # cold-resume badge (lapse is now just one of the five classes).
        bs = s.get("busts") or {}
        nb = bs.get("total") or 0
        _btip = "; ".join(f"{c['count']} {c['class']}" for c in (bs.get("classes") or []))
        resumeb = (f' <span class="badge warn" title="{e(_btip)} — each a prefix '
                   f're-write at the write premium">&#9889;{nb}</span>' if nb else "")
        # Link per-instance (sub=<agent-id|role>); prefer the author-declared
        # [agent: <name>] label, fall back to role; a short agent-id chip
        # disambiguates concurrent same-role subagents at a glance.
        subline = "".join(
            f'<br><span class="subagent">&#8627; '
            f'<a href="/_session?session={e(sid)}&amp;sub={e(sa.get("key") or sa.get("role"))}">'
            f'{e(sa.get("display_name") or sa.get("role"))}</a>'
            + (f' <span class="dim">{e(sa.get("role"))}</span>'
               if sa.get("display_name") and sa.get("role") != sa.get("display_name") else "")
            + (f' <span class="dim">#{e((sa.get("agent_id") or "")[:8])}</span>'
               if sa.get("agent_id") else "")
            + f' <span class="dim">{e(writer_mod._short_model(sa.get("model")))}'
            f' · {sa.get("requests", 0)} req · {e(_fmt_ago(sa.get("last_seen"), now))}'
            + (f' · ${sa["est_usd"]:.4f}' if sa.get("est_usd") is not None else "")
            + f'</span></span>' for sa in subs)
        return (
            f'<tr><td class="nowrap">{timeleft}</td>'
            f'<td class="nowrap">{ttlc}</td>'
            f'<td class="nowrap">{toolsc}</td>'
            f'<td class="nowrap">{promptc}</td>'
            f'<td class="scol"><b><a href="/_session?session={e(sid)}">'
            f'{e(s.get("title") or "(untitled)")}</a></b>{summ}{kindb}{resumeb} '
            f'<a href="/_status?session={e(sid)}"><code>{e(sid[:8])}…</code></a> '
            f'<span class="dim">{e(writer_mod._short_model(s.get("model")))}</span>{mainlbl}<br>'
            f'<span class="dim">{e(s.get("cwd") or "")}</span>{subline}</td>'
            f'<td>{e(_fmt_ago(s.get("last_seen"), now))}</td>'
            f'<td>{hold}</td><td>{ping}</td><td>{cost}</td>'
            # ref count links to the session page's refusal banner (wire
            # truth: category + stop_details the CLI never showed)
            f'<td class="{"bad" if sref else "dim"}">'
            + (f'<a class="bad" href="/_session?session={e(sid)}#refusals">'
               f'{sref}</a>' if sref else "—") + '</td></tr>')

    # Split by CACHE STATE, not recency: a warm 1h prefix that was idle 7m still
    # matters more than a 5m prefix that lapsed 6m ago. Within each, snapshot
    # order (most-recent-first) holds. Warm sessions are few (bounded by live
    # TTLs); the cold list is the 24h long tail that pagination caps.
    warm_s = [s for s in snap["sessions"] if s["warmth"]["state"] == "warm"]
    cold_s = [s for s in snap["sessions"] if s["warmth"]["state"] != "warm"]
    _hdr = ('<tr><th>time left</th><th>ttl</th><th>tools</th><th>prompt</th>'
            '<th>session</th><th>last seen</th>'
            '<th>hold</th><th>pingable</th><th>cost</th><th>ref</th></tr>')

    def _table(title, items):
        if not items:
            return f'<h2>{title} <small class="dim">0</small></h2><p class=dim>none</p>'
        return (f'<h2>{title} <small class="dim">{len(items)}</small></h2>'
                f'<table>{_hdr}{"".join(_row(s) for s in items)}</table>')

    if not snap["sessions"]:
        body = "<p class=dim>no sessions tracked</p>"
    else:
        body = (_table("&#128293; warm cache", warm_s)
                + _table("&#10052;&#65039; cold / expired", cold_s))

    # pagination: the snapshot caps how many sessions it enriches (`show`);
    # ?show=N raises the cap, ?all=1 lifts the 24h window + cap entirely. The
    # 10s meta-refresh reloads the SAME url, so the chosen page sticks.
    total = p.get("sessions_total")
    shown = len(snap["sessions"])
    more = ""
    if p.get("sessions_truncated"):
        more = (f' · <b>{shown}</b> of {total} (last 24h) · '
                f'<a href="/_admin?show={show + 60}">show 60 more</a> · '
                f'<a href="/_admin?all=1">show all</a>')
    foot = ('<p class="dim">auto-refresh 10s · <a href="/_admin">last 24h</a> · '
            '<a href="/_admin?all=1">all</a> · <a href="/_status">raw json</a>'
            f'{more}</p>')
    return ('<!doctype html><html><head><meta charset="utf-8">'
            '<meta http-equiv="refresh" content="10">'
            f'<title>wirescope · {e(p["log_dir"])}</title>'
            f'<style>{_ADMIN_CSS}</style></head><body>'
            + head + body + foot + "</body></html>")


# --- /_session: simplified view of a session's captured context ----------------
# Renders the session's REPLAYABLE LAST REQUEST — the post-transform body the
# pinger would replay, i.e. the exact context the model saw on the session's
# last turn (in-memory entry; SQLite `last_request` row after a restart) — as a
# human-readable inventory: tools / system blocks / message timeline with
# previews. BODY ONLY: headers (incl. auth) are never rendered. Static snapshot,
# no auto-refresh (pages can be large). Zero JS — expansion is <details>.

_SESSION_CSS = _ADMIN_CSS + """
.blk{border:1px solid #2a2e36;border-left-width:3px;border-radius:4px;
     margin:.45em 0;padding:.3em .6em}
.blk .sz{float:right;color:#69707d;margin-left:1em}
.user{border-left-color:#6ab0de}.assistant{border-left-color:#7ec699}
.tooluse{border-left-color:#e5c07b}.toolres{border-left-color:#c678dd}
.sysb{border-left-color:#e06c75}
pre{white-space:pre-wrap;word-break:break-word;color:#aab2c0;margin:.3em 0;
    background:#101317;padding:.5em;border-radius:4px;max-height:30em;overflow:auto}
details>summary{cursor:pointer;color:#6ab0de}
.turnhdr{margin:1.2em 0 .35em;padding-bottom:.15em;color:#9aa3b2;
         font-weight:bold;border-bottom:1px solid #2a2e36}
pre.pv{margin-bottom:0}
details.more>pre{margin-top:0}
details.more>summary{color:#69707d;font-size:12px}
.tline{margin:.15em 0 .15em .4em;padding:0 .6em;font-size:12px;color:#8a93a3;
       border-left:2px solid #2a2e36}
.tline.tooluse{border-left-color:#8a7635}
.tline.toolres{border-left-color:#6e5577}
.tline.assistant{border-left-color:#3f5c4a}
.tline summary{color:#8a93a3} .tline summary:hover{color:#cdd3dd}
.tline .sz{float:right;color:#4d535e;margin-left:1em}
.tline pre{max-height:20em}
.cmark{margin:.8em 0 .6em;border-top:2px dashed #b08a3e;color:#e5c07b;
       font-size:12px;padding-top:.15em}
.navbar{border:1px solid #2a2e36;border-radius:4px;padding:.3em .6em;
        background:#12151a}
.navbar a{color:#6ab0de;text-decoration:none} .navbar a:hover{text-decoration:underline}
.navbar a.bustjump{color:#e5c07b;font-weight:600}
.naventry{margin:.2em 0 .6em}
.naventry a{color:#e5c07b;text-decoration:none;border:1px solid #3a3320;
        border-radius:4px;padding:.15em .5em;background:#1a1710}
.naventry a:hover{text-decoration:underline}
.bustp{border-left-color:#e5c07b}
.bustp pre.diff{font-size:12px;max-height:14em}
.bustp pre.diff{color:#aab2c0}
"""

_MD_HEADING_RE = re.compile(r"(?m)^#{1,3} .+$")


def _load_last_request_row(session_id):
    """Read this proxy's persisted replayable request straight from SQLite —
    fallback for entries not in memory (e.g. evicted past the cap)."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            r = con.execute("SELECT path, ts, body FROM last_request "
                            "WHERE owner=? AND session_id=?",
                            (store_mod.OWNER, session_id)).fetchone()
        if r:
            body = json.loads(r[2])
            # openai rows never need auth — they exist for the view only
            return {"obj": body, "path": r[0], "ts": r[1],
                    "needs_auth": not codex_mod._is_openai_body(body)}
    except Exception as e:
        print(f"[session] last_request read failed for {session_id[:12]}…: {e}",
              flush=True)
    return None


def _load_last_request_disk(session_id, subkey=None):
    """VIEW-ONLY cold fallback: the newest captured request straight from the
    session's capture dir, for when the replayable entry is gone (swept past
    TTL+grace, or /_end'd). Replaying and viewing are distinct features — a
    cold prefix genuinely can't be pinged, but the bytes on disk are still the
    debugging record; without this the only ways to inspect a cold session
    were re-warming the whole prefix or losing it. Returns (entry, resp,
    usage); entry carries from_disk=True so the render badges it view-only
    (never handed to the pinger). Main line = parent/unknown role, preferring
    real turns (n_tools > 0) over title/probe side-calls; subkey = a subagent
    instance (agent_id, fallback role — same key the /_status rows use)."""
    d = core_mod._session_dir(session_id)
    try:
        files = sorted(d.glob("*.request.json"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        files = []
    pick = side_call = None
    for rf in files:
        try:
            rec = json.loads(rf.read_text())
        except Exception:
            continue
        obj = rec.get("body")
        if not isinstance(obj, dict) or not (obj.get("messages") or obj.get("input")):
            continue
        summ = rec.get("summary") or {}
        if subkey is not None:
            if subkey not in (summ.get("agent_id"), summ.get("role")):
                continue
        elif not codex_mod._is_openai_body(obj):  # codex: no roles/subagents
            if summ.get("role") not in ("parent", "unknown"):
                continue
            if not summ.get("n_tools"):
                # title/probe side-call shape — keep only as a last resort
                side_call = side_call or (rf, rec)
                continue
        pick = (rf, rec)
        break
    pick = pick or side_call
    if pick is None:
        return None, None, None
    rf, rec = pick
    return _entry_resp_usage(rf, rec)


def _entry_resp_usage(rf, rec):
    """Build the (entry, resp, usage) triple from a specific capture request file
    `rf` + its loaded record `rec` — the shared body of the cold disk view (used
    by both the newest-turn picker and the by-turn navigator). entry.from_disk
    badges it view-only; resp/usage are rebuilt from the paired .response.json,
    the same shapes the in-memory _LAST_RESPONSE/_LAST_USAGE would have had."""
    try:
        ts = time.mktime(time.strptime(rec.get("ts") or "", "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        try:
            ts = rf.stat().st_mtime
        except OSError:
            ts = None
    entry = {"obj": rec.get("body"), "path": rec.get("path"), "ts": ts,
             "from_disk": True}
    resp = usage = None
    rp = rf.with_name(rf.name[:-len(".request.json")] + ".response.json")
    try:
        rrec = json.loads(rp.read_text())
        rts = rp.stat().st_mtime
    except Exception:
        rrec, rts = None, None
    if isinstance(rrec, dict):
        m = rrec.get("meta") or {}
        if m.get("text"):
            resp = {"text": m["text"],
                    "truncated": len(m["text"]) >= billing_mod._META_TEXT_CAP,
                    "stop_reason": m.get("stop_reason"), "ts": rts or ts}
        tok = (rrec.get("billing") or {}).get("tokens")
        if tok:
            usage = {**tok, "est_usd": (rrec.get("billing") or {}).get("est_usd"),
                     "ts": rts or ts}
    return entry, resp, usage


def _main_line_turns(session_id):
    """Chronological (restart-stable ts order) list of this session's MAIN-line
    captured requests: [{stem, seq, ts}]. The spine for /_session turn navigation
    — every request is captured, so 'turns' here are just positions in that
    on-disk series (same ordering report.bust_series indexes by `i`)."""
    from proxylab import report as report_mod            # lazy: avoid import cycle
    out = []
    for p in report_mod._iter_pairs(session_id):
        if p["line"] != "main":
            continue
        out.append({"stem": p["stem"], "seq": report_mod._seq_of(p["stem"]),
                    "ts": report_mod._epoch(p["ts"])})
    return out


def _load_request_by_index(session_id, i):
    """Load the i-th MAIN-line captured turn (0-based, chronological) for the
    /_session navigator. Returns (entry, resp, usage, nav) where nav carries the
    prev/next indices + position for the arrow bar; (None, None, None, nav) when
    the index is out of range or the capture is unreadable. i is clamped."""
    turns = _main_line_turns(session_id)
    n = len(turns)
    nav = {"i": None, "n": n, "prev": None, "next": None, "seq": None, "ts": None}
    if not n:
        return None, None, None, nav
    if i < 0:                              # Python-style: -1 = latest turn
        i = n + i
    i = max(0, min(i, n - 1))
    t = turns[i]
    nav.update({"i": i, "seq": t["seq"], "ts": t["ts"],
                "prev": i - 1 if i > 0 else None,
                "next": i + 1 if i < n - 1 else None})
    d = core_mod._session_dir(session_id)
    rf = d / (t["stem"] + ".request.json")
    try:
        rec = json.loads(rf.read_text())
    except Exception:
        return None, None, None, nav
    entry, resp, usage = _entry_resp_usage(rf, rec)
    return entry, resp, usage, nav


def _flat_text(content):
    """All human-readable text under a content value (str | block list)."""
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if isinstance(b, dict):
            if b.get("type") == "text":
                out.append(b.get("text") or "")
            elif b.get("type") == "tool_result":
                out.append(_flat_text(b.get("content")))
    return "\n".join(x for x in out if x)


def _prevu(text, cap=350, full_cap=60000):
    """Escaped preview <pre> + a <details> holding the REMAINDER — expanding
    continues the text where the preview stopped, it never re-shows it."""
    t = text or ""
    if not t:
        return ""
    if len(t) <= cap:
        return f"<pre>{html.escape(t)}</pre>"
    more = "" if len(t) <= full_cap else f"\n… (+{len(t) - full_cap:,} more ch)"
    return (f'<pre class="pv">{html.escape(t[:cap])}</pre>'
            f'<details class="more"><summary>&hellip; show remaining '
            f'{len(t) - cap:,} of {len(t):,} ch</summary>'
            f"<pre>{html.escape(t[cap:full_cap])}{html.escape(more)}</pre></details>")


def _tline(cls, label, what, body, cap=2000):
    """A slim, collapsed one-liner for tool churn (tool_use / tool_result /
    thinking): the timeline reads as conversation; payloads are a click away."""
    t = body or ""
    snip = html.escape(t[:90].replace("\n", " ")) + ("…" if len(t) > 90 else "")
    if not t:
        return (f'<div class="tline {cls}"><span class="sz">0 ch</span>'
                f'{label} {what}</div>')
    return (f'<div class="tline {cls}"><details><summary>'
            f'<span class="sz">{len(t):,} ch</span>{label} {what} '
            f'<span class="dim">{snip}</span></summary>'
            f'{_prevu(t, cap=cap)}</details></div>')


def _cc_ttl(cc):
    return (cc.get("ttl") or "5m") if isinstance(cc, dict) else "5m"


def _cmark(n, cc, cum_ch):
    """The cache-boundary divider: everything ABOVE this line is one cached
    prefix unit (breakpoints cache cumulatively in canonical order
    tools -> system -> messages). cum_ch = canonical-order chars so far."""
    return (f'<div class="cmark">&#9986; cache breakpoint {n} · '
            f'ttl {html.escape(_cc_ttl(cc))} · prefix above '
            f'&approx;{html.escape(_fmt_tok(cum_ch // 4))} tok</div>')


def _render_session_openai_body(entry, resp=None):
    """The /_session body for a codex/openai-wire entry: Responses-API shape —
    instructions (one system-like block), tools (name OR built-in type), input
    items (message / function_call / function_call_output / reasoning). No
    cache badges: caching is server-side (prompt_cache_key shown instead)."""
    e = html.escape
    obj = entry.get("obj") or {}
    tools = obj.get("tools") or []
    instr = obj.get("instructions") or ""
    inp = [it for it in (obj.get("input") or []) if isinstance(it, dict)]
    t_ch = len(json.dumps(tools)) if tools else 0
    i_ch = len(json.dumps(inp)) if inp else 0
    n_turns = sum(1 for it in inp if codex_mod._is_prompt_item_openai(it))
    pck = obj.get("prompt_cache_key") or ""
    recon = (f'<span class="badge on">&#9881; reconstructed · '
             f'{entry.get("turns") or "?"} WS turns</span>'
             if entry.get("transport") == "websocket-reconstructed" else "")
    bar = (f'<p class="kv"><span>captured <b>{e(_fmt_ago(entry.get("ts")))}</b> '
           f'<span class="badge on">openai wire</span>{recon}</span>'
           f'<span>tools <b>{len(tools)}</b> &approx;{e(_fmt_tok(t_ch // 4))} tok</span>'
           f'<span>instructions <b>{len(instr):,}</b> ch</span>'
           f'<span>input <b>{len(inp)}</b> items &approx;{e(_fmt_tok(i_ch // 4))} tok</span>'
           f'{f"<span>turns <b><a href=#turn-{n_turns}>{n_turns}</a></b></span>" if n_turns else ""}'
           f'<span class="dim">server-side cache'
           f'{" · key " + e(pck[:13]) + "…" if pck else ""}</span></p>')
    if tools:
        trs = "".join(
            f'<tr><td><b>{e(t.get("name") or t.get("type") or "?")}</b></td>'
            f'<td class="dim">{len(json.dumps(t)):,} ch</td>'
            f'<td class="dim">{e((t.get("description") or "")[:120])}</td></tr>'
            for t in sorted(tools, key=lambda t: -len(json.dumps(t))))
        tools_html = (f'<details><summary>tools · {len(tools)} · '
                      f'&approx;{e(_fmt_tok(t_ch // 4))} tok</summary>'
                      f'<table>{trs}</table></details>')
    else:
        tools_html = '<p class="dim">no tools</p>'
    sb = ""
    if instr:
        heads = _MD_HEADING_RE.findall(instr)
        hl = " · ".join(e(h.lstrip("# ")) for h in heads[:12])
        sb = (f'<div class="blk sysb"><span class="sz">{len(instr):,} ch</span>'
              f'<span class="role">instructions</span> '
              f'<span class="dim">{hl}</span>{_prevu(instr, cap=160)}</div>')
    rows = []
    turn = 0
    for i, it in enumerate(inp):
        t = it.get("type")
        if codex_mod._is_prompt_item_openai(it):
            turn += 1
            cur = (' · <span class="warm">current</span>'
                   if turn == n_turns else '')
            rows.append(f'<div class="turnhdr" id="turn-{turn}">'
                        f'turn {turn}{cur}</div>')
        if t == "message":
            role = it.get("role", "?")
            for c in (it.get("content") or []):
                if not isinstance(c, dict):
                    continue
                txt = c.get("text") or ""
                machine = (' <span class="warn">[context]</span>'
                           if txt.lstrip().startswith("<") else "")
                cls = "assistant" if role == "assistant" else e(role)
                rows.append(f'<div class="blk {cls}">'
                            f'<span class="sz">{len(txt):,} ch</span>'
                            f'<span class="role">#{i} {e(role)}</span>'
                            f'{machine}{_prevu(txt)}</div>')
        elif t == "function_call":
            rows.append(_tline("tooluse", f'<span class="role">#{i} assistant</span>',
                               f'function_call <b>{e(it.get("name") or "?")}</b>',
                               it.get("arguments") or ""))
        elif t == "function_call_output":
            out = it.get("output")
            txt = out if isinstance(out, str) else json.dumps(out or "")
            rows.append(_tline("toolres", f'<span class="role">#{i} tool</span>',
                               "function_call_output", txt))
        elif t == "reasoning":
            enc = it.get("encrypted_content") or ""
            summ = "\n".join(s.get("text") or "" for s in (it.get("summary") or [])
                             if isinstance(s, dict))
            rows.append(_tline("assistant", f'<span class="role">#{i} assistant</span>',
                               f'reasoning <span class="dim">(encrypted, '
                               f'{len(enc):,} ch)</span>', summ))
        else:
            rows.append(f'<div class="blk"><span class="role">#{i}</span> '
                        f'<span class="dim">{e(str(t))}</span></div>')
    if (resp and resp.get("text")
            and (resp.get("ts") or 0) >= (entry.get("ts") or 0)):
        rtxt = resp["text"]
        trunc = (' <span class="dim">(preview capped)</span>'
                 if resp.get("truncated") else '')
        rows.append(f'<div class="turnhdr">answer · turn {turn or "?"} '
                    f'<span class="dim">from the wire response — not yet '
                    f'part of the next request</span></div>')
        rows.append(f'<div class="blk assistant">'
                    f'<span class="sz">{len(rtxt):,} ch</span>'
                    f'<span class="role">assistant (response)</span> '
                    f'<span class="dim">{e(str(resp.get("stop_reason") or ""))}'
                    f'</span>{trunc}{_prevu(rtxt)}</div>')
    return bar + tools_html + sb + "".join(rows)


def _session_boundary_note(obj):
    """If the displayed turn's messages[0] is led by a local-command boundary —
    a `/clear` or other slash command resets the conversation, so messages[0]
    becomes the `<local-command-caveat>`/`<command-name>` block rather than a
    substantive prompt — return a banner saying this view is the CURRENT
    post-reset request (prior work ran in an earlier context). '' otherwise.

    Why it matters most on the subagent view: subagents share the parent's
    session_id and keep a STABLE agent-id across a `/clear`, so a reset
    OVERWRITES the per-instance last-request in place — whereas the main line
    escapes via session_id rotation (the old work stays under the old id). Without
    this note a post-`/clear` subagent page reads like "I see instructions, not
    execution" and looks like a render bug when it's an accurate fresh snapshot."""
    msgs = obj.get("messages") or []
    if not msgs:
        return ""
    c = msgs[0].get("content")
    blocks = (c if isinstance(c, list)
              else [{"type": "text", "text": c}] if isinstance(c, str) else [])
    is_boundary = False
    cmd = None
    for b in blocks:
        if not (isinstance(b, dict) and b.get("type") == "text"
                and isinstance(b.get("text"), str)):
            continue
        txt = b["text"].lstrip()
        if txt.startswith("<system-reminder>"):
            continue
        # first NON-reminder block decides: a boundary marker => reset turn
        is_boundary = (txt.startswith("<local-command-caveat>")
                       or txt.startswith("<command-name>"))
        break
    if not is_boundary:
        return ""
    # the command name can live in a sibling block; scan messages[0] for it
    for b in blocks:
        if isinstance(b, dict) and isinstance(b.get("text"), str):
            m = re.search(r"<command-name>([^<]+)</command-name>", b["text"])
            if m:
                cmd = m.group(1).strip()
                break
    label = html.escape(cmd) if cmd else "a local command"
    return (f'<p class="warn">&#8635; This turn begins with <b>{label}</b> — the '
            f'conversation was reset, so this is the <b>current</b> post-reset '
            f'request. Earlier work for this instance ran in a prior context and '
            f'is not in this snapshot (a subagent keeps its id across a reset, so '
            f'the new turn overwrites the previous one here).</p>')


def _session_nav_html(sid, nav, bust_t):
    """The turn-navigation arrow bar + a 'vs previous turn' cache panel for the
    /_session navigator. `nav` = the _load_request_by_index position dict; `bust_t`
    = this turn's transition from report.bust_series (or None on turn 0 / no
    prior). The panel is the per-turn face of the bust locator: how this turn's
    cache did against the one before it, and — on a bust — WHERE it diverged."""
    e = html.escape
    i, n = nav.get("i"), nav.get("n") or 0
    if i is None:
        return ""
    def _lnk(j, label, cls=""):
        if j is None:
            return f'<span class="dim">{label}</span>'
        return f'<a class="{cls}" href="/_session?session={e(sid)}&turn={j}">{label}</a>'
    latest = ('' if nav.get("next") is None
              else f' · <a href="/_session?session={e(sid)}">latest &raquo;&raquo;</a>')
    seq = nav.get("seq")
    # Forensic jumps: skip the warm-append turns and land on the nearest
    # cache-BUST transition (populated by the server from report.bust_series).
    # These are the turns worth reading — a step-by-step walk mostly traverses
    # boring warm appends. None when there's no bust in that direction.
    pj, nj = nav.get("prev_bust"), nav.get("next_bust")
    nb = nav.get("n_busts") or 0
    bust_count = (f'<span class="dim">· <b class="warn">{nb}</b> '
                  f'bust{"s" if nb != 1 else ""}</span>' if nb else
                  '<span class="dim">· all warm</span>')
    arrows = (f'<p class="kv navbar"><span>{_lnk(nav.get("prev"), "&laquo; prev")}</span>'
              f'<span>{_lnk(pj, "&#9198; prev bust", "bustjump")}</span>'
              f'<span class="dim">turn <b>{i + 1}</b> of {n}'
              f'{f" · seq {seq}" if seq is not None else ""} {bust_count}</span>'
              f'<span>{_lnk(nj, "next bust &#9197;", "bustjump")}</span>'
              f'<span>{_lnk(nav.get("next"), "next &raquo;")}</span>'
              f'<span class="dim">{e(_fmt_ago(nav.get("ts")))}{latest}</span></p>')
    if not bust_t:
        return arrows + ('<p class="kv"><span class="dim">turn 1 — no prior turn '
                         'to diff against.</span></p>' if i == 0 else '')
    # cache verdict for this transition
    if not bust_t.get("bust"):
        verdict = '<span class="warm">&#10003; warm append</span>'
    elif bust_t.get("static_prefix_bust"):
        verdict = ('<span class="bad">&#9888; static-prefix bust</span> '
                   '<span class="dim">(the cached preamble changed — fixable)</span>')
    else:
        verdict = '<span class="warn">&#9889; history rewrite</span>'
    rd, wr = bust_t.get("read_tokens") or 0, bust_t.get("write_tokens") or 0
    wf = bust_t.get("write_frac")
    surv = (bust_t.get("survived_prefix") or {}).get("boundary")
    loc = bust_t.get("locus") or {}
    panel = (f'<div class="blk bustp"><p class="kv"><span>vs seq '
             f'{bust_t.get("from_seq")}:</span><span>{verdict}</span>'
             f'<span>read <b class="warm">{e(_fmt_tok(rd))}</b></span>'
             f'<span>written <b class="warn">{e(_fmt_tok(wr))}</b></span>'
             f'<span class="dim">write frac {wf}</span>'
             + (f'<span class="dim">cache held through <b>{e(str(surv))}</b></span>'
                if surv else '') + '</p>')
    if bust_t.get("bust") and loc:
        panel += (f'<p class="kv"><span class="dim">first byte-change:</span>'
                  f'<span><b>{e(str(loc.get("label")))}</b>'
                  + (f' @ char {loc.get("char_offset")}' if loc.get("char_offset") is not None else '')
                  + '</span></p>')
        if loc.get("old") is not None or loc.get("new") is not None:
            panel += (f'<pre class="diff">- {e(str(loc.get("old") or ""))}\n'
                      f'+ {e(str(loc.get("new") or ""))}</pre>')
    panel += '</div>'
    return arrows + panel


def _render_session_html(sid, entry, snap, resp=None, usage=None, subrole=None,
                         nav=None, bust_t=None):
    e = html.escape
    s = (snap.get("sessions") or [{}])[0]
    nav_html = _session_nav_html(sid, nav, bust_t) if nav else ""
    if subrole:
        # Per-role subagent view: same session_id as the parent, but its own
        # model/activity. The parent's warmth/cwd belong to the parent line, so
        # we show the subagent's stats + a link back up instead of the prefix
        # warmth (a subagent isn't independently pingable).
        # subrole is the instance key (agent-id or role); match on key, but
        # label by the human role (the raw key may be an opaque agent-id hex).
        sub = next((sa for sa in (s.get("sub_agents") or [])
                    if sa.get("key") == subrole or sa.get("role") == subrole), {})
        lbl = sub.get("display_name") or sub.get("role") or subrole
        aid = sub.get("agent_id")
        rolechip = (f' <small class="dim">{e(sub.get("role"))}</small>'
                    if sub.get("display_name") and sub.get("role") != sub.get("display_name") else "")
        lbl_html = e(lbl) + rolechip + (f' <small class="dim">#{e(aid[:8])}</small>' if aid else "")
        ptitle = s.get("title") or "(untitled)"
        head = (f'<h1>{e(ptitle)} <small>&#8627; <b>{lbl_html}</b></small> '
                f'<small>· <code>{e(sid)}</code></small></h1>'
                f'<p class="kv"><span class="dim">subagent of '
                f'<a href="/_session?session={e(sid)}">{e(ptitle)}</a></span>'
                f'<span>model <b>{e(writer_mod._short_model(sub.get("model") or s.get("model")))}</b></span>'
                f'<span><b>{sub.get("requests", 0)}</b> req</span>'
                f'<span class="dim">last seen {e(_fmt_ago(sub.get("last_seen")))}</span></p>')
    else:
        w = s.get("warmth") or {}
        warmth = {"warm": (f'<span class="warm">&#128293; '
                           f'{e(_fmt_dur(w.get("remaining_s")))} left</span>'),
                  "cold": '<span class="cold">&#10052;&#65039; cold</span>'
                  }.get(w.get("state"), '<span class="absent">&empty;</span>')
        head = (f'<h1>{e(s.get("title") or "(untitled)")} '
                f'<small>· <code>{e(sid)}</code></small></h1>'
                f'<p class="kv"><span>{warmth}</span>'
                f'<span>model <b>{e(writer_mod._short_model(s.get("model")))}</b></span>'
                f'<span>cwd <b>{e(s.get("cwd") or "?")}</b></span>'
                f'<span class="dim">last seen {e(_fmt_ago(s.get("last_seen")))}</span></p>')
    head += nav_html                       # turn navigator arrows + bust panel (nav mode)
    if not nav and not subrole:
        # TOP-of-page entry into the turn navigator, so the forensic controls
        # aren't buried in the footer (you'd have to scroll the whole transcript
        # to find them). turn=-1 = latest turn WITH the arrow bar + bust jumps.
        head += ('<p class="naventry">'
                 f'<a href="/_session?session={e(sid)}&turn=-1">'
                 '&#8635; step through turns &#183; jump to cache busts</a></p>')
    if usage:    # token receipts from the last response (in-memory; see
                 # meta._LAST_USAGE) — what actually got read vs (re)written
        rd = usage.get("cache_read_input_tokens") or 0
        wr = ((usage.get("cache_write_5m_tokens") or 0)
              + (usage.get("cache_write_1h_tokens") or 0)) \
            or usage.get("cache_write_flat_tokens") or 0
        inp = usage.get("input_tokens") or 0
        out = usage.get("output_tokens") or 0
        usd = usage.get("est_usd")
        ctx_tok = meta_mod._input_token_total(usage)   # == /_status context.input_tokens
        head += (f'<p class="kv"><span class="dim">last turn '
                 f'({e(_fmt_ago(usage.get("ts")))}):</span>'
                 f'<span>cache read <b class="warm">{e(_fmt_tok(rd))}</b></span>'
                 f'<span>cache written <b class="warn">{e(_fmt_tok(wr))}</b></span>'
                 f'<span>uncached in <b>{e(_fmt_tok(inp))}</b></span>'
                 f'<span>out <b>{e(_fmt_tok(out))}</b></span>'
                 f'<span class="dim">context = {e(_fmt_tok(ctx_tok))} tok'
                 f'{f" · ${usd:.4f}" if usd is not None else ""}</span></p>')
    revs = s.get("refusal_events") or []
    if revs:
        # server-side classifier hits: the model never ran, the CLI showed a
        # generic toast — the category + stop_details here are the only truth.
        # When the LAST refusal post-dates the captured request, the timeline
        # below is the exact context that got blocked.
        latest_at = revs[-1].get("at") or 0
        if latest_at and entry and latest_at >= (entry.get("ts") or 0):
            note = (' · <span class="warn">the captured request below IS the '
                    'context the classifier blocked</span>')
        elif latest_at:
            note = (' · a turn has succeeded since — the context below '
                    'post-dates the refusal')
        else:
            note = ''
        items = []
        for ev in reversed(revs):
            det = ev.get("stop_details")
            detv = (f'<details><summary>stop_details</summary>'
                    f'<pre>{e(json.dumps(det, indent=2, ensure_ascii=False))}'
                    f'</pre></details>' if det else "")
            items.append(
                f'<div class="blk sysb"><span class="sz">{e(str(ev.get("ts") or "?"))}</span>'
                f'<span class="bad">refusal</span> '
                f'<b>{e(str(ev.get("category") or "uncategorized"))}</b> '
                f'<span class="dim">{e(writer_mod._short_model(ev.get("model")))} · '
                f'reqid {e(str(ev.get("request_id") or "?"))}</span>{detv}</div>')
        head += (f'<div id="refusals"><p class="kv">'
                 f'<span class="bad">&#9940; {len(revs)} refusal'
                 f'{"s" if len(revs) != 1 else ""} this session</span>'
                 f'<span class="dim">server-side classifier (model never ran; '
                 f'CLI saw a generic toast){note}</span></p>'
                 + "".join(items) + "</div>")
    if entry and codex_mod._is_openai_body(entry.get("obj") or {}):
        body = _render_session_openai_body(entry, resp=resp)
        foot = (f'<p class="dim"><a href="/_admin">&larr; sessions</a> · '
                f'<a href="/_status?session={e(sid)}">raw json</a> · '
                f'static snapshot (reload to refresh)</p>')
        return ('<!doctype html><html><head><meta charset="utf-8">'
                f'<title>wirescope · {e((s.get("title") or sid)[:60])}</title>'
                f'<style>{_SESSION_CSS}</style></head><body>'
                + head + body + foot + "</body></html>")
    if not entry:
        body = ('<p class="warn">no request found for this session — nothing '
                'captured yet (in memory, SQLite, or the on-disk captures).</p>')
        obj = {}
    else:
        obj = entry.get("obj") or {}
        tools = obj.get("tools") or []
        sysv = obj.get("system")
        sysb = ([{"type": "text", "text": sysv}] if isinstance(sysv, str)
                else [b for b in (sysv or []) if isinstance(b, dict)])
        msgs = obj.get("messages") or []
        t_ch = len(json.dumps(tools)) if tools else 0
        s_ch = sum(len(b.get("text") or "") for b in sysb)
        m_ch = len(json.dumps(msgs)) if msgs else 0
        auth_badge = (' <span class="warn">awaiting auth (restored)</span>'
                      if entry.get("needs_auth") else "")
        if entry.get("from_disk"):
            # cold-session view: rebuilt from the capture files, not the
            # replayable in-memory/SQLite entry (swept once the prefix went
            # cold) — viewing is read-only, so cold is fine; pinging isn't.
            auth_badge = (' <span class="cold">&#10052;&#65039; from disk '
                          'capture (view-only, not replayable)</span>')
        n_turns = meta_mod._turn_stats(obj)["turns_in_context"]
        turns_link = (f'<span>turns <b><a href="#turn-{n_turns}">{n_turns}'
                      f'</a></b></span>' if n_turns else '')
        bar = (f'<p class="kv"><span>captured <b>{e(_fmt_ago(entry.get("ts")))}'
               f'</b>{auth_badge}</span>'
               f'<span>tools <b>{len(tools)}</b> &approx;{e(_fmt_tok(t_ch // 4))} tok</span>'
               f'<span>system <b>{len(sysb)}</b> blocks &approx;{e(_fmt_tok(s_ch // 4))} tok</span>'
               f'<span>messages <b>{len(msgs)}</b> &approx;{e(_fmt_tok(m_ch // 4))} tok</span>'
               f'{turns_link}'
               f'<span class="dim">sizes are chars; tok &approx; ch/4</span></p>')
        # post-reset (`/clear`/slash-command) snapshot note — keeps a fresh
        # boundary turn from reading as a render bug (esp. on the sub-view).
        bar += _session_boundary_note(obj)
        # cache breakpoints number through the CANONICAL prefix order
        # tools -> system -> messages; cum_ch tracks chars in that order so
        # each divider can price the prefix it closes (tok ≈ ch/4).
        mark_n = 0
        cum_ch = t_ch
        if tools:
            trs = "".join(
                f'<tr><td><b>{e(t.get("name", "?"))}</b></td>'
                f'<td class="dim">{len(json.dumps(t)):,} ch</td>'
                f'<td class="dim">{e((t.get("description") or "")[:120])}</td></tr>'
                for t in sorted(tools, key=lambda t: -len(json.dumps(t))))
            tools_html = (f'<details><summary>tools · {len(tools)} · '
                          f'&approx;{e(_fmt_tok(t_ch // 4))} tok</summary>'
                          f'<table>{trs}</table></details>')
            tcc = next((t.get("cache_control") for t in tools
                        if isinstance(t, dict) and t.get("cache_control")), None)
            if tcc:
                mark_n += 1
                tools_html += _cmark(mark_n, tcc, cum_ch)
        else:
            tools_html = '<p class="dim">no tools</p>'
        sb = []
        for i, b in enumerate(sysb):
            txt = b.get("text") or ""
            cum_ch += len(txt)
            cc = b.get("cache_control")
            badge = (f'<span class="badge on">cache {e(_cc_ttl(cc))}</span>'
                     if cc else "")
            heads = _MD_HEADING_RE.findall(txt)
            hl = " · ".join(e(h.lstrip("# ")) for h in heads[:12])
            sb.append(f'<div class="blk sysb"><span class="sz">{len(txt):,} ch</span>'
                      f'<span class="role">system[{i}]</span> {badge} '
                      f'<span class="dim">{hl}</span>{_prevu(txt, cap=160)}</div>')
            if cc:
                mark_n += 1
                sb.append(_cmark(mark_n, cc, cum_ch))
        rows = []
        turn = 0
        for i, mm in enumerate(msgs):
            # group the timeline by turn: a divider before each prompt-bearing
            # user message (same predicate as turns_in_context — one source)
            if meta_mod._is_prompt_msg(mm):
                turn += 1
                cur = (' · <span class="warm">current</span>'
                       if turn == n_turns else '')
                rows.append(f'<div class="turnhdr" id="turn-{turn}">'
                            f'turn {turn}{cur}</div>')
            cum_ch += len(json.dumps(mm)) if isinstance(mm, dict) else 0
            role = mm.get("role", "?")
            content = mm.get("content")
            blocks = (content if isinstance(content, list)
                      else [{"type": "text", "text": content or ""}])
            mcc = None
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                mcc = b.get("cache_control") or mcc
                pin = " &#128204;" if b.get("cache_control") else ""
                lbl = f'<span class="role">#{i} {e(role)}{pin}</span>'
                if bt == "text":
                    txt = b.get("text") or ""
                    rem = (' <span class="warn">[system-reminder]</span>'
                           if "<system-reminder" in txt else "")
                    rows.append(f'<div class="blk {e(role)}">'
                                f'<span class="sz">{len(txt):,} ch</span>'
                                f'{lbl}{rem}{_prevu(txt)}</div>')
                elif bt == "tool_use":
                    args = json.dumps(b.get("input") or {}, ensure_ascii=False)
                    rows.append(_tline("tooluse", lbl,
                                       f'tool_use <b>{e(b.get("name") or "?")}</b>',
                                       args))
                elif bt == "tool_result":
                    txt = _flat_text(b.get("content"))
                    err = (' <span class="bad">ERROR</span>'
                           if b.get("is_error") else "")
                    rows.append(_tline("toolres", lbl, f"tool_result{err}", txt))
                elif bt == "thinking":
                    rows.append(_tline("assistant", lbl, "thinking",
                                       b.get("thinking") or ""))
                else:
                    rows.append(f'<div class="blk">{lbl} '
                                f'<span class="dim">{e(str(bt))}</span></div>')
            if mcc:
                mark_n += 1
                rows.append(_cmark(mark_n, mcc, cum_ch))
        # The answer to the FINAL user message lives only in the response until
        # the next turn re-ships it as input — a request-only view always
        # lagged one answer. Append it when fresher than the captured request.
        if (resp and resp.get("text")
                and (resp.get("ts") or 0) >= (entry.get("ts") or 0)):
            rtxt = resp["text"]
            trunc = (' <span class="dim">(preview capped)</span>'
                     if resp.get("truncated") else '')
            rows.append(f'<div class="turnhdr">answer · turn {turn or "?"} '
                        f'<span class="dim">from the wire response — not yet '
                        f'part of the cached prefix</span></div>')
            rows.append(f'<div class="blk assistant">'
                        f'<span class="sz">{len(rtxt):,} ch</span>'
                        f'<span class="role">assistant (response)</span> '
                        f'<span class="dim">{e(str(resp.get("stop_reason") or ""))}'
                        f'</span>{trunc}{_prevu(rtxt)}</div>')
        body = (bar + tools_html + "".join(sb) + "".join(rows))
    # discovery link into the turn navigator (skip when already in nav mode — the
    # arrow bar is already up top). turn=-1 = latest, with the vs-previous panel.
    nav_link = ('' if nav else f' · <a href="/_session?session={e(sid)}&turn=-1">'
                f'&#8635; step through turns</a>')
    foot = (f'<p class="dim"><a href="/_admin">&larr; sessions</a> · '
            f'<a href="/_status?session={e(sid)}">raw json</a>{nav_link} · '
            f'static snapshot (reload to refresh)</p>')
    return ('<!doctype html><html><head><meta charset="utf-8">'
            f'<title>wirescope · {e((s.get("title") or sid)[:60])}</title>'
            f'<style>{_SESSION_CSS}</style></head><body>'
            + head + body + foot + "</body></html>")


# --- /_timeline: per-request cost evolution, rendered for humans ---------------
# The visual companion to /_report?detail=1 (same `series` data). Three exact
# cost buckets — READ (the model consuming the context window, cached 0.1× or
# uncached 1×: same activity, two prices), WRITE (the toll to cache so later
# reads are ~10× cheaper), GENERATION (output tokens) — as a pie + a cumulative
# line, plus an ESTIMATE drill-down of what content the read pays to re-carry.
# Self-contained SVG, zero JS, same dark lab-grade aesthetic as /_admin.
_TL_W, _TL_H, _TL_PAD = 920, 260, 46
_TL_SPINE = [("read", "#e0794b"), ("write", "#d4b14a"), ("generation", "#46c08a")]
_TL_CONTENT = [("conversation", "#46c08a"), ("preamble", "#5b8def"),
               ("thinking", "#b97fe0")]


def _tl_x(i, n):
    return _TL_PAD + (_TL_W - 2 * _TL_PAD) * (i / max(1, n - 1))


def _tl_y(v, ymax):
    return _TL_PAD + (_TL_H - 2 * _TL_PAD) * (1 - (v / ymax if ymax else 0))


def _tl_pie(cx, cy, r, slices, title):
    import math
    slices = sorted([s for s in slices if s[1] > 0], key=lambda s: s[1], reverse=True)
    total = sum(s[1] for s in slices) or 1
    g = [f'<text x="{cx}" y="{cy-r-26}" text-anchor="middle" class="t">'
         f'{html.escape(title)}</text>']
    halo = 'style="paint-order:stroke" stroke="#1b1e24" stroke-width="3"'
    a0 = -math.pi / 2
    for label, val, color in slices:
        frac = val / total
        a1 = a0 + 2 * math.pi * frac
        x0, y0 = cx + r * math.cos(a0), cy + r * math.sin(a0)
        x1, y1 = cx + r * math.cos(a1), cy + r * math.sin(a1)
        large = 1 if frac > 0.5 else 0
        g.append(f'<path d="M{cx},{cy} L{x0:.1f},{y0:.1f} A{r},{r} 0 {large} 1 '
                 f'{x1:.1f},{y1:.1f} Z" fill="{color}" stroke="#1b1e24" stroke-width="1.5"/>')
        if frac >= 0.02:
            am = (a0 + a1) / 2
            lx, ly = cx + (r + 16) * math.cos(am), cy + (r + 16) * math.sin(am)
            anchor = "start" if math.cos(am) >= 0 else "end"
            g.append(f'<text x="{lx:.1f}" y="{ly:.1f}" text-anchor="{anchor}" '
                     f'fill="{color}" font-size="11.5" font-weight="700" {halo}>'
                     f'{html.escape(label)} ${val:,.2f} · {frac*100:.0f}%</text>')
        a0 = a1
    g.append(f'<circle cx="{cx}" cy="{cy}" r="{r*0.52:.0f}" fill="#1b1e24"/>'
             f'<text x="{cx}" y="{cy-2}" text-anchor="middle" fill="#eee" '
             f'font-size="15" font-weight="700">${total:,.2f}</text>'
             f'<text x="{cx}" y="{cy+13}" text-anchor="middle" fill="#8a93a0" '
             f'font-size="10">total</text>')
    return "".join(g)


def _tl_axes(title, ymax, n, yfmt):
    g = [f'<text x="{_TL_PAD}" y="20" class="t">{html.escape(title)}</text>']
    for i in range(5):
        y = _TL_PAD + (_TL_H - 2 * _TL_PAD) * i / 4
        g.append(f'<line x1="{_TL_PAD}" y1="{y:.1f}" x2="{_TL_W-_TL_PAD}" y2="{y:.1f}" '
                 f'class="grid"/>')
        g.append(f'<text x="{_TL_PAD-6}" y="{y+3:.1f}" class="yl">{yfmt(ymax*(1-i/4))}</text>')
    g.append(f'<text x="{_TL_PAD}" y="{_TL_H-_TL_PAD+18}" class="xl2">req 1</text>'
             f'<text x="{_TL_W-_TL_PAD}" y="{_TL_H-_TL_PAD+18}" class="xl2">req {n}</text>')
    return "".join(g)


def _render_timeline_html(session, report):
    """Render report['series'] (from session_report(detail=True)) as the cost-
    evolution dashboard. `report` is the full /_report payload dict."""
    e = html.escape
    series = (report or {}).get("series") or {}
    reqs = series.get("requests") or []
    foot = (f'<p class="dim"><a href="/_admin">&larr; sessions</a> · '
            f'<a href="/_report?session={e(session)}&detail=1">raw json</a> · '
            f'<a href="/_session?session={e(session)}">context</a></p>')
    if not reqs:
        return ('<!doctype html><html><head><meta charset="utf-8">'
                f'<title>wirescope · timeline</title><style>{_TL_CSS}</style></head>'
                f'<body><h1>Cost over time · {e(session)}</h1>'
                '<p class="dim">No priced main-line requests captured for this '
                'session yet.</p>' + foot + '</body></html>')
    n = len(reqs)
    m = lambda v: f"${v:,.2f}"
    st = series.get("spine_totals", {})
    read, write, gen = st.get("read", 0), st.get("write", 0), st.get("generation", 0)
    cached, uncached = st.get("read_cached", 0), st.get("read_uncached", 0)
    total = read + write + gen
    ce = series.get("content_carriage_est", {})

    pie_spine = _tl_pie(250, 158, 104, [(k, st.get(k, 0), c) for k, c in _TL_SPINE],
                        "Cost by type (exact)")
    pie_content = _tl_pie(690, 158, 104, [(k, ce.get(k, 0), c) for k, c in _TL_CONTENT],
                          "What read pays to carry (est.)")

    # cumulative spine lines
    run = {k: 0.0 for k, _ in _TL_SPINE}
    cum = []
    for r in reqs:
        run["read"] += r["read_usd"]; run["write"] += r["write_usd"]
        run["generation"] += r["generation_usd"]
        cum.append(dict(run))
    cmax = max(max(c.values()) for c in cum) * 1.08 or 1
    parts, ends = [], []
    # de-collide end labels: stack them at least 14px apart, top-to-bottom.
    # last_pts is sorted ascending, so each label sits at max(its own y, the
    # previous label + 14). NOTE: a `while yy - placed[-1] < 14: yy = placed[-1]
    # + 14` here was an INFINITE LOOP — float rounding makes (x+14)-x evaluate to
    # 13.999999999999986 < 14 at non-round magnitudes, so the guard never clears
    # and the event loop pegs at 100% CPU. The branchless max() can't round-trap.
    last_pts = sorted(((_tl_y(cum[-1][k], cmax), k, c) for k, c in _TL_SPINE))
    placed = []
    for y, k, c in last_pts:
        yy = max(y, placed[-1] + 14) if placed else y
        placed.append(yy)
        ends.append((k, c, _tl_y(cum[-1][k], cmax), yy))
    for k, c in _TL_SPINE:
        pts = " ".join(f"{_tl_x(i,n):.1f},{_tl_y(cum[i][k],cmax):.1f}" for i in range(n))
        parts.append(f'<polyline points="{pts}" fill="none" stroke="{c}" stroke-width="2"/>')
    halo = 'style="paint-order:stroke" stroke="#14161a" stroke-width="3.5"'
    for k, c, ydot, ylbl in ends:
        parts.append(
            f'<circle cx="{_tl_x(n-1,n):.1f}" cy="{ydot:.1f}" r="3" fill="{c}"/>'
            f'<text x="{_tl_x(n-1,n)-7:.1f}" y="{ylbl+4:.1f}" text-anchor="end" '
            f'fill="{c}" font-size="11.5" font-weight="700" {halo}>{k} {m(cum[-1][k])}</text>')
    line = "".join(parts)

    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>wirescope · cost over time</title><style>{_TL_CSS}</style></head><body>
<h1>Where the money went · {e(session)}</h1>
<div class="sub">{n} main-line requests · total {m(total)} · main line only (subagents in /_report)</div>
<div class="card"><svg viewBox="0 0 940 320">{pie_spine}{pie_content}</svg>
<div class="cap"><b>Left (exact):</b> every billed dollar is <b>read</b> (consuming the window — {m(cached)} cached + {m(uncached)} uncached, both reading input), <b>write</b> (the toll to cache so later reads are ~10&times; cheaper), or <b>generation</b> (output tokens). <b>Right (estimate):</b> the read dollars apportioned to the content re-read, by token share.</div></div>
<div class="card"><svg viewBox="0 0 {_TL_W} {_TL_H}">{_tl_axes("Cumulative cost by type, turn 0 → last", cmax, n, m)}{line}</svg>
<div class="cap"><b>read</b> bends upward — each turn re-reads a bigger window — while <b>write</b> and <b>generation</b> stay nearly flat. The widening gap is the context-carriage tax growing with session depth.</div></div>
{foot}</body></html>"""


_TL_CSS = """
  body{background:#14161a;color:#d6d6d6;font:13px/1.5 -apple-system,Segoe UI,sans-serif;margin:0;padding:24px}
  h1{font-size:16px;font-weight:600;margin:0 0 4px}
  .sub{color:#8a93a0;margin-bottom:18px}
  .card{background:#1b1e24;border:1px solid #2a2f38;border-radius:8px;padding:14px 12px;margin:14px 0}
  svg{width:100%;height:auto}
  .t{fill:#cfd6df;font-size:13px;font-weight:600}
  .grid{stroke:#2a2f38;stroke-width:1}
  .yl{fill:#6b7480;font-size:10px;text-anchor:end}
  .xl2{fill:#6b7480;font-size:10px;text-anchor:middle}
  .cap{color:#8a93a0;font-size:12px;margin-top:10px}
  .cap b{color:#cfd6df;font-weight:600}
  a{color:#5b8def}
  .dim{color:#6b7480}
"""
