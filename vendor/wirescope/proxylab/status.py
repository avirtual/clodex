import collections
import fnmatch
import json
import re
import threading
import time

from proxylab import accounts as accounts_mod
from proxylab import billing as billing_mod
from proxylab import codex as codex_mod
from proxylab import muse as muse_mod
from proxylab import core as core_mod
from proxylab import hints as hints_mod
from proxylab import hints_native as hints_native_mod
from proxylab import hold as hold_mod
from proxylab import meta as meta_mod
from proxylab import pinger as pinger_mod
from proxylab import quota as quota_mod
from proxylab import restore as restore_mod
from proxylab import subs as subs_mod
from proxylab import store as store_mod
from proxylab import transforms as transforms_mod
from proxylab import warmth as warmth_mod
from proxylab import writer as writer_mod

# Stable product marker. Many proxies can sit on ANTHROPIC_BASE_URL in front of
# the model backend; a subscriber needs a cheap, unauthenticated way to tell
# OURS apart from a generic forwarder before it tries to register, pull stats,
# or warm the cache. /_identity is that handshake: a consumer confirms
# `product == "wirescope"`, reads `protocols`/`capabilities` to decide what it
# may use, and `endpoints` for where. Additive-only (mirror SUBSCRIBERS.md's
# versioning rule): never remove a field, bump `protocols.<name>` on a break.
# (identity protocol 2: renamed product logproxy -> wirescope, 2026-06-13.)
PRODUCT = "wirescope"
IDENTITY_PROTOCOL = 2


def _identity():
    """The 'is this our proxy?' handshake — see PRODUCT above. Read-only,
    spends nothing; capabilities reflect LIVE flags so a consumer integrates
    conditionally (e.g. only attempt /_ping when ping is actually enabled)."""
    return {
        "wirescope": True,                # quick boolean for the lazy check
        "product": PRODUCT,               # the authoritative discriminator
        "vendor": "proxy-lab",
        "version": core_mod.VERSION,      # release tag or git-describe (dev tree)
        "protocols": {
            # protocol/contract versions a consumer can branch on
            "identity": IDENTITY_PROTOCOL,
            "subscribers": 1,             # SUBSCRIBERS.md envelope "v"
            "wirescope": 1,               # WIRESCOPE.md [wirescope:...] spec (v1:
            #                               renamed ws:->wirescope:, spawn + keep)
        },
        # what THIS process can actually do right now (env flags can disable
        # subsystems) — a subscriber should gate features on these, not assume
        "capabilities": {
            # A/B control arm: when true this port is a byte-verbatim forwarder
            # (whole mutation chain skipped) — the experiment's CONTROL. Analyzers
            # read this to label an arm without guessing from the env.
            "passthrough": transforms_mod.PASSTHROUGH,
            # Control-plane auth: true = this deployment requires ENDPOINT_TOKEN
            # on every /_ endpoint except this handshake (send Bearer or ?token=).
            "endpoint_token": bool(core_mod.ENDPOINT_TOKEN),
            # Honesty panel: the proxy HAS first-party content-mutation
            # facilities (request injection, response mutation, short-circuit) —
            # all default-off experiment flags, but a consumer integrating with
            # an unknown deployment deserves to SEE whether they're armed rather
            # than trust the default. Same discipline as `passthrough` (which,
            # when true, keeps all of these inert regardless of arming).
            "mutation_armed": {
                "inject": bool(transforms_mod.INJECT
                               or transforms_mod.INJECT_FILE),
                "resp_mutate": bool(transforms_mod.RESP_APPEND
                                    or transforms_mod.RESP_REPLACE),
                "shortcircuit": bool(transforms_mod.SHORTCIRCUIT_DONE),
            },
            "subscribers": subs_mod.SUBSCRIBERS,
            "warmth": warmth_mod.WARMTH_LEDGER,
            "ping": pinger_mod.WARMTH_PINGER,
            "hold": hold_mod.WARMTH_HOLD,
            # proactive CLI OAuth refresh: the proxy spends a bootstrap turn
            # once the access token lapses so consumer-side holds (which
            # decline a dead bearer) keep pinging through idle nights. Account
            # scoped; readout on /_status proxy.auth_refresh.
            "auth_refresh": hold_mod.WARMTH_AUTH_REFRESH and hold_mod.WARMTH_AUTH_BOOTSTRAP,
            # per-account credential stores: /_accounts registers a seat's
            # CLAUDE_CONFIG_DIR so the refresh covers that subscription's token
            # too, and /_status sessions[].account names the account a session
            # runs on. Without it a second-subscription seat's token lapses
            # unrefreshed and its restored stash never re-auths.
            "accounts": True,
            "stats": True,                # /_status is always served
            # /_status + /_admin `agent=`/`hide=` globs and `ended=0`, plus the
            # `proxy.session_families` rollup the globs come from. Must be
            # feature-detected: an older proxy IGNORES the params and returns
            # the unfiltered list, which a consumer would render as "these are
            # all the sessions matching your filter" — wrong, and silently so.
            "session_filters": True,
            "session_view": True,         # /_session HTML
            "context_view": True,         # /_context tool-roster JSON
            "context_composition": True,  # /_context per-category token breakdown
            "context_utilization": True,  # /_context?...&utilization=1 used/deadweight
            "context_skills": True,       # /_context per-skill roster + utilization
            "context_report": True,       # /_report?session= cost/efficiency report
            "context_timeline": True,     # /_report?...&detail=1 series + /_timeline HTML
            "bust_locator": True,         # /_bust?session= cache-divergence forensics
            "prune": True,                # /_prune capture-dir retention (GET readout
                                          # + POST two-tier prune; see INTEGRATION.md)
            "cost_by_line": True,         # per-agent-line cost split: cost.main_est_usd
                                          # + sub_agents[].est_usd (+ /_report scope.agents)
            # ACCOUNT plan quota (5h/7d rolling-window utilization) on
            # /_status `quota`, parsed from the API's own response headers.
            # Account-scoped, not per-session; only as fresh as the last
            # forwarded turn (every reading carries `age_s`).
            "quota": quota_mod.QUOTA_TRACK,
            "since_compact": True,        # /_status session.since_compact rollup
                                          # {turns,requests,est_usd,boundary_ts,compacted}
                                          # from the last /compact boundary (or start)
            # prior-turn thinking strip: per-session consumer opt-in via /_strip
            # or [wirescope:strip-thinking on]. `default` = the global flag (what
            # `effective` is when no per-session override is set). When the proxy
            # ships globally off (the consumer-opt-in stance), default is false but
            # the capability is True (the lever exists) — gate on this, not version.
            # L2 is NOT a separate capability: they're levels of THIS mechanism.
            # L1 = prior-turn thinking only; L2 = L1 PLUS the bust-riding
            # tool-result strips (edit-ack collapse + failed-call stubbing) PLUS
            # read+edit FOLD (apply same-turn edits onto the Read buffer). Each
            # level contains the lower. Gate a level on `max_level >= N`, NOT a
            # per-feature key. Set per session via /_strip?level=N or
            # [wirescope:strip-thinking l2]. (L3 retired 2026-06-20: fold folded
            # into L2; a legacy l3/level=3 input clamps to 2.)
            "strip_thinking": {"available": True,
                               "default": transforms_mod.STRIP_PRIOR_THINKING,
                               "max_body_ratio": transforms_mod.STRIP_THINK_MAX_BODY_RATIO,
                               "levels": [0, 1, 2], "max_level": 2,
                               "default_level": transforms_mod._global_strip_level()},
            "codex": True,                # /agent/<name>/openai HTTP routing
            "codex_websocket": codex_mod._websocket_available(),
            # Meta's muse CLI: /agent/<name>/meta routing + root /muse-code/*
            # product passthrough (catalog-learned prices, reminder side-calls
            # priced apart). Same Responses-API wire as codex, `wire:"meta"`
            # on /_context and `provider:"meta"` on receipts.
            "muse": True,
            # wirescope directives (WIRESCOPE.md): agent-name always honored,
            # omit/replace gated by WS_OMIT, keep always honored; `spawn` =
            # whether spawn-position (messages[0] head) directives are read at
            # all; `omit_default` = operator policy already stripped from every
            # subagent spawn (so a spawner needs no knowledge for that case)
            "wirescope": {"agent_name": True, "omit": transforms_mod.WS_OMIT,
                          "replace": transforms_mod.WS_OMIT, "keep": True,
                          "spawn": writer_mod.WS_SPAWN_DIRECTIVES,
                          "omit_default": transforms_mod.WS_OMIT_DEFAULT,
                          "spawner_hint": transforms_mod.WS_SPAWNER_HINT,
                          # per-agent /_hint override of spawner_hint (keyed by
                          # route name; on=0 = wirescope invisible to that
                          # agent's model while observability still runs).
                          "hint_override": True,
                          # tool-roster trim: `tools` (allowlist), `strip-tools`
                          # (denylist), `keep-tools` (override); gated by
                          # WS_STRIP_TOOLS, same spawn/body/sticky plumbing.
                          "strip_tools": transforms_mod.WS_STRIP_TOOLS,
                          # `[wirescope:strip-thinking on|off]` per-session opt-in
                          # (twin of the /_strip endpoint); always parsed.
                          "strip_thinking": True,
                          # `[wirescope:keep-mcp <server>]` per-agent re-admit of
                          # a STRIP_MCP_SERVERS-filtered family; always parsed.
                          "keep_mcp": True},
            # tail hints (hints_contract.md): the uncached trailing-block channel.
            # `available` = the code is present; `enabled` = the live kill switch.
            # A consumer MUST gate on this rather than sniffing `version` — same
            # rule as strip_thinking above. Note the registry is empty at rest, so
            # this says the SLOT exists, never that anything is registered (read
            # /_hints?agent= for that). `system_tail_fallback` matters because it
            # is the ONLY path for a consumer whose SessionStart hook emits the
            # trailing role:"system" roster message: with it off, those requests
            # decline as `marker_downstream` and no hint is ever delivered.
            "hints": {"available": True,
                      "enabled": hints_mod.HINTS,
                      "system_tail_fallback": hints_mod.SYSTEM_TAIL_FALLBACK,
                      # per-hint `turn_start_only`: ride only the FIRST request of
                      # a turn. Hint tokens are uncached (1x on EVERY request), and
                      # a turn is N requests — so a hint answering "what did the
                      # user just type" is carriage by round 14. Feature-detectable
                      # because a consumer posting the field to an older proxy
                      # would get silent per-request billing instead.
                      "turn_start_gate": True,
                      # one-shot payloads: `once` + `main_line_only` +
                      # `expect_session`, popped on a CONFIRMED 200 (reserve at
                      # injection, commit at the receipt, roll back otherwise).
                      # MUST be feature-detected: a proxy without it accepts the
                      # keys silently and ignores them, so the payload would ride
                      # EVERY request forever instead of once — the expensive
                      # failure, and invisible from the consumer side.
                      "pop": True,
                      "native": sorted(hints_native_mod.PROVIDERS),
                      "caps": {"total_chars": hints_mod.HINTS_MAX_CHARS,
                               "per_hint_chars": hints_mod.HINTS_MAX_ONE,
                               "per_scope": hints_mod.HINTS_MAX_PER_SCOPE}},
            # MCP-server tool strip (STRIP_MCP_SERVERS): the LIVE configured set
            # of server prefixes this port surgically drops from tools[]. A
            # consumer gating its own --strict-mcp-config should check the actual
            # server is in `servers` here, NOT just that traffic is routed — a
            # routed port with strip OFF (empty servers) still ships those tools,
            # so "routed" alone is the wrong contract boundary. Empty list = the
            # feature is off on this port (kill switch or unconfigured).
            "strip_mcp": {"available": True,
                          "servers": sorted(transforms_mod.STRIP_MCP_SERVERS)},
        },
        "endpoints": {
            "identity": "/_identity",
            "status": "/_status",
            "subscribe": "/_subscribe",
            "warm": "/_warm",
            "ping": "/_ping",
            "hold": "/_hold",
            "accounts": "/_accounts",
            "end": "/_end",
            "admin": "/_admin",
            "session": "/_session",
            "context": "/_context",
            "report": "/_report",
            "timeline": "/_timeline",
            "bust": "/_bust",
            "strip": "/_strip",
            "hint": "/_hint",             # per-agent spawner-hint override (NOT
            #                               tail hints — different feature, and the
            #                               one-letter gap is a trap; see below)
            "hints": "/_hints",           # tail-hint registry (hints_contract.md)
            "prune": "/_prune",
        },
        "docs": "INTEGRATION.md",         # front-door contract; push deep-dive = SUBSCRIBERS.md
    }


_HEXID_RE = re.compile(r"-[0-9a-f]{6,}$")
_TICKET_RE = re.compile(r"\.t\d+\.")


def _agent_family(agent):
    """Collapse an agent route name to a GLOB that matches its whole family.

    A family is returned as a glob (not a prefix) deliberately: the chips the
    admin page renders ARE the `agent=`/`hide=` query values, so what a human
    clicks and what a consumer passes are the same string, and there is no
    second syntax to keep in sync. Three collapses, in order — a per-seat hex
    suffix (`clodex-wirescope-46e6794f`), a ticket number (`…t978.hand`), and
    finally a trailing non-hex segment, which is what makes 40 one-shot
    `brief-zbcn`/`brief-well` seats read as one `brief-*` row.
    """
    if not agent:
        return None
    fam, n = _HEXID_RE.subn("-*", agent)
    fam = _TICKET_RE.sub(".t*.", fam)
    if not n and "-" in fam:
        fam = fam.rsplit("-", 1)[0] + "-*"
    return fam


def _session_families(meta_rows, sids):
    """Family rollup over the FULL windowed universe, before any filter or the
    `limit` cut — so the counts a human filters against don't themselves move
    as they filter. Biggest first; unrouted sessions are not a family."""
    fams = collections.Counter()
    for sid in sids:
        r = meta_rows.get(sid)
        fam = _agent_family(r[9] if r else None)
        if fam:
            fams[fam] += 1
    return [{"family": f, "sessions": n} for f, n in fams.most_common()]


def _match_globs(agent, globs):
    return any(fnmatch.fnmatchcase(agent or "", g) for g in globs)


def _status_snapshot(session=None, all_sessions=False, limit=None,
                     agent_globs=(), hide_globs=(), hide_ended=False):
    """Everything a human (or the statusline) wants to know about the sessions
    this proxy tracks, one read-only JSON. Universe = in-memory pingable
    sessions ∪ armed holds ∪ durable session_meta rows (last 24h unless all=1).
    Identity (title/cwd/model) is SQLite-durable; pingability/hold/cost are
    in-memory by design (nothing replayable survives a restart anyway).

    `limit` (used by /_admin) caps the most-recently-active N sessions BEFORE
    the per-session warmth/segment enrichment, so a 24h window with hundreds/
    thousands of sessions doesn't query + render them all every refresh. Armed
    holds are never dropped; `session`/`all_sessions` bypass the cap. The cut is
    by last_seen, and a warm prefix implies recent activity, so warm sessions
    survive the cap in practice. Reports proxy.sessions_total/truncated.

    `agent_globs`/`hide_globs` (fnmatch on the agent route name) and
    `hide_ended` filter the universe BEFORE that cut, so a burst of one-shot
    seats can be excluded from the enrichment budget rather than merely from
    the rendered table. proxy.session_families lists the candidate globs."""
    now = time.time()
    with pinger_mod._LAST_REQUEST_LOCK:
        last_real = {sid: (e["ts"], bool(e.get("needs_auth")),
                           codex_mod._is_openai_body(e.get("obj")),
                           e.get("account"),
                           # codex "openai" / muse "meta"; anthropic entries
                           # carry no provider
                           e.get("provider") if codex_mod._is_openai_body(e.get("obj"))
                           else None)
                     for sid, e in pinger_mod._LAST_REQUEST.items()}
    # account_uuid -> email, one pass over the (tiny) store registry per call
    acct_labels = {s["account_uuid"]: s["email"] for s in accounts_mod.stores()
                   if s["account_uuid"]}
    holds = hold_mod._hold_snapshot()
    meta_rows, meta_err = {}, None
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            q = ("SELECT session_id, title, cwd, model, first_seen, last_seen, "
                 "kind, ended_at, end_reason, agent FROM session_meta")
            if session:
                cur = con.execute(q + " WHERE session_id=?", (session,))
            elif all_sessions:
                cur = con.execute(q)
            else:
                cur = con.execute(q + " WHERE last_seen > ?", (now - 86400,))
            meta_rows = {r[0]: r for r in cur.fetchall()}
    except Exception as e:
        meta_err = f"store: {e}"
    sids = set(meta_rows) | set(last_real) | set(holds)
    if session:
        sids &= {session}
    # Family rollup is computed over the UNFILTERED universe (see
    # _session_families) so the chip counts stay put while a human filters.
    families = _session_families(meta_rows, sids)
    # Agent filters run BEFORE the `limit` cut, not at render time: the cut is
    # what decides which sessions get the expensive per-session enrichment, so
    # filtering downstream of it would hide rows without buying back a single
    # page-one slot — the whole point when 40 one-shot `brief-*` seats have
    # displaced the real ones. An armed hold is never dropped by the cap, but
    # IS subject to an explicit filter (the human asked).
    if agent_globs or hide_globs or hide_ended:
        def _keep(sid):
            r = meta_rows.get(sid)
            ag = (r[9] if r else None) or ""
            if agent_globs and not _match_globs(ag, agent_globs):
                return False
            if hide_globs and _match_globs(ag, hide_globs):
                return False
            if hide_ended and r and r[7]:
                return False
            return True
        sids = {sid for sid in sids if _keep(sid)}
    sessions_total = len(sids)
    truncated = False
    if (limit is not None and not session and not all_sessions
            and sessions_total > limit):
        # rank by best-known last activity (meta last_seen ∪ last real turn),
        # keep the top `limit`, but never drop an armed hold.
        def _activity(sid):
            r = meta_rows.get(sid)
            lr = last_real.get(sid)
            return max((r[5] if r else 0) or 0, lr[0] if lr else 0)
        keep = set(holds)
        ranked = sorted(sids - keep, key=_activity, reverse=True)
        sids = keep | set(ranked[:max(0, limit - len(keep))])
        truncated = True
    sessions = []
    for sid in sids:
        r = meta_rows.get(sid)
        kind = r[6] if r else None
        if kind and not (session or all_sessions):
            continue  # proxy-spawned utility session (auth bootstrap) — not
                      # the human's; visible via ?all=1 or direct ?session=
        wq = warmth_mod.warmth_query(session=sid)
        tot = billing_mod._SESSION_TOTALS.get(sid)        # .get: never create via defaultdict
        lr = last_real.get(sid)               # (ts, needs_auth) | None
        hold = holds.get(sid)
        if hold:
            # what THIS hold should still need: idle span / ttl, anchored at
            # the LAST REAL TURN (an organic turn re-warms for free and resets
            # the ping counter, so both sides of n/expected restart together).
            # The global ping cap is only the safety bound.
            hold = dict(hold)
            ttl = wq.get("ttl_s") or 3600
            ref = max(hold["armed_at"], (lr[0] if lr else 0))
            hold["expected_pings"] = min(
                hold_mod.WARMTH_HOLD_MAX_PINGS,
                max(1, int((hold["until"] - ref) // ttl)))
        ended = meta_mod._ENDED.get(sid)
        if not ended and r and r[7]:
            ended = {"ts": r[7], "reason": r[8] or "unspecified"}
        # The route agent name IS the session name when present — it's the
        # operator's own label, stabler than a generated summary (and SDK/
        # headless sessions never make the title side-call at all). Bracketed
        # so a label reads as a label. Consumers wanting the raw learned
        # title have the `summary` field. Last resort, for an un-routed session
        # that never made the title side-call either (e.g. a headless run
        # pointed straight at the port): name it after the session_id's first
        # segment (~8 hex) so it's still uniquely identifiable rather than
        # nameless. `~`-marked to read distinctly from a [route] label, and it
        # ranks BELOW the learned title so a plain interactive CLI keeps its
        # real title.
        agent_name = r[9] if r else None
        sessions.append({
            "session_id": sid,
            "kind": kind,
            "ended": ended,
            "agent": agent_name,
            "summary": r[1] if r else None,
            "title": (f"[{agent_name}]" if agent_name else None) or
                     (r[1] if r else None) or
                     (f"~{sid.split('-')[0]}" if sid else None),
            "cwd": r[2] if r else None,
            "model": r[3] if r else None,
            "first_seen": r[4] if r else None,
            "last_seen": (r[5] if r else None) or (lr[0] if lr else None),
            "last_real_turn_ts": lr[0] if lr else None,
            # openai-wire entries are view-only — never pingable, never
            # awaiting auth (nothing is ever replayed on that wire)
            "pingable": bool(lr and not lr[1] and not lr[2]),
            "awaiting_auth": bool(lr and lr[1] and not lr[2]),
            # which subscription this session's requests carry (the CLI's
            # metadata account_uuid); `email` only when a registered store
            # names it. A consumer pinging from its own port must use THIS
            # account's credential store, not the box default.
            "account": ({"uuid": lr[3], "email": acct_labels.get(lr[3])}
                        if lr and lr[3] else None),
            # which wire the session's last request spoke: anthropic (the
            # default, and every restored/cold row), openai (codex) or meta
            # (muse). The two Responses-API wires cache SERVER-SIDE with no
            # TTL, so their warmth block is structurally absent — a consumer
            # deciding "is this session alive" on that wire must key on
            # last_seen, not on warmth.state (`/_admin` files them warm while
            # active in the last hour).
            "wire": (lr[4] or "openai") if lr and lr[2] else "anthropic",
            "warmth": {"state": ("warm" if wq.get("warm")
                                 else "cold" if wq.get("found") else "absent"),
                       "remaining_s": wq.get("remaining_s"),
                       "ttl_s": wq.get("ttl_s"),
                       # leading-breakpoint segments (tools / tools+system),
                       # content-addressed → shared across sessions with
                       # identical layouts; display-grade only
                       "segments": warmth_mod.warmth_segments(sid)},
            # REAL-BUST rollup (2026-07-06): per-class cumulative counts + the
            # last bust, each class carrying its own fault + fix_hint so a chip
            # renders severity/tooltip from the payload. Supersedes the old
            # `cold_resumes` scalar (which counted ONLY the `lapse` class and
            # missed every warm content-divergence bust); lapse now lives in
            # busts.by_class.lapse. None when the session never had a real bust.
            "busts": warmth_mod.bust_summary(sid),
            "hold": hold,
            # est_usd/requests = the WHOLE tree (subagents share the parent's
            # session_id, so every line under it rolls in); main_est_usd = the
            # main line's own share (by_line decomposition; sub shares ride
            # sub_agents[].est_usd). None for pre-feature sessions.
            "cost": ({"est_usd": tot["est_usd"], "requests": tot["requests"],
                      "unpriced_requests": tot["unpriced_requests"],
                      "main_est_usd": (round(tot["by_line"]["main"]["est_usd"], 6)
                                       if (tot.get("by_line") or {}).get("main")
                                       else None),
                      # keep-warm pings INSIDE est_usd/requests, priced apart:
                      # {requests, est_usd, cache_read_tokens, input_tokens,
                      # write_tokens}; write_tokens > 0 = a ping re-wrote the
                      # prefix. None for pre-feature sessions.
                      "keepwarm": tot.get("keepwarm"),
                      # the auto-mode permission classifier's side-calls, same
                      # shape, also INSIDE est_usd/requests. None pre-feature.
                      "classifier": tot.get("classifier")}
                     if tot else None),
            # per-window rollup from the last detected /compact boundary (or
            # session start): {turns, requests, est_usd, boundary_ts, compacted}.
            # Cumulative cost/turns_completed answer "how big is the whole
            # session"; this answers "where is THIS context at" (clodex). null
            # for pre-feature/no-traffic sessions; absent on pre-release payloads.
            "since_compact": billing_mod.since_compact(tot),
            "refusals": (tot or {}).get("refusals", 0),
            # last ≤20 classifier hits, wire-truth detail (full stop_details);
            # the CLI only ever showed a generic toast
            "refusal_events": (tot or {}).get("refusal_events") or None,
            # receipt-counted completed turns + the latest request-derived
            # heaviness snapshot (turns_in_context resets at /compact)
            "turns_completed": (tot or {}).get("turns"),
            "context": meta_mod._context_stats(sid),
            # per-session thinking-strip state, so a consumer can RECONCILE its
            # configured intent against proxy-truth (closes the fire-once-and-
            # forget desync) — reconcile against `configured_level`, never the
            # guard. See _strip_state.
            "strip": _strip_state(sid),
            # Task-spawned subagents that share this session_id (each with its
            # own model + request count) — shown under the main agent so the two
            # are obviously distinct and neither overwrites the other.
            # `last_active_s` (server-computed now - last_seen) is folded in so a
            # consumer derives running/idle/done off a skew-free fact (clodex
            # subagent child rows; policy/aging stay client-side).
            "sub_agents": _subagents_with_active(sid, now),
        })
    sessions.sort(key=lambda s: s.get("last_seen") or 0, reverse=True)
    res = {"proxy": {"version": core_mod.VERSION,
                     "log_dir": str(core_mod.LOG_DIR), "upstream": core_mod.UPSTREAM,
                     "upstream_openai": codex_mod.UPSTREAM_OPENAI,
                     "upstream_meta": muse_mod.UPSTREAM_META,
                     "uptime_s": round(now - core_mod._START_TS, 1),
                     "flags": {"hold": hold_mod.WARMTH_HOLD, "pinger": pinger_mod.WARMTH_PINGER,
                               "ledger": warmth_mod.WARMTH_LEDGER,
                               "block_cold_ping": warmth_mod.WARMTH_BLOCK_COLD_PING},
                     "subscribers": subs_mod._stats(),
                     "codex": dict(codex_mod._CODEX_STATS),
                     "muse": dict(muse_mod._MUSE_STATS),
                     "hold_config": {"margin_s": hold_mod.WARMTH_HOLD_MARGIN,
                                     "interval_s": hold_mod.WARMTH_HOLD_INTERVAL,
                                     "max_hours": hold_mod.WARMTH_HOLD_MAX_HOURS,
                                     "max_pings": hold_mod.WARMTH_HOLD_MAX_PINGS},
                     # a hold can read `armed:true` while the bootstrap that
                     # would revive its stale auth is spent — surface that
                     "auth_bootstrap": hold_mod._bootstrap_snapshot(now),
                     # proactive OAuth refresh: `stalled` = lapsed token that
                     # no bootstrap could move → a human login is owed
                     "auth_refresh": hold_mod._auth_refresh_snapshot(now),
                     "tracked_last_requests": len(last_real),
                     "holds_armed": len(holds),
                     "sessions_total": sessions_total,
                     "sessions_shown": len(sessions),
                     "sessions_truncated": truncated,
                     # agent-route families in the window (biggest first),
                     # counted BEFORE filters — the admin page renders these as
                     # one-click chips, and each `family` string is itself a
                     # valid `agent=`/`hide=` glob, so UI and API share one
                     # vocabulary. `filters` echoes what was applied.
                     "session_families": families,
                     "filters": {"agent": list(agent_globs),
                                 "hide": list(hide_globs),
                                 "hide_ended": bool(hide_ended)},
                     "error_counts": dict(core_mod.ERROR_COUNTS),
                     "restored_at_start": dict(restore_mod._RESTORED),
                     "totals": dict(billing_mod._TOTALS),
                     "totals_since_start": billing_mod._since_start()},
           # ACCOUNT-scoped plan quota (5h / 7d rolling windows), read off the
           # response headers of the last forwarded turn. Top-level, NOT
           # per-session: every agent on this box spends the same plan, so a
           # consumer renders it once (a statusbar chip) rather than per row.
           # Carries its own `age_s` — it moves only when a turn is forwarded.
           "quota": quota_mod.snapshot(now),
           "sessions": sessions}
    if meta_err:
        res["proxy"]["session_meta_error"] = meta_err
    return res


def _strip_state(sid):
    """Per-session thinking-strip state for /_status — the proxy-truth a consumer
    (clodex) reconciles its configured intent against, killing the fire-once-and-
    forget desync (a /_strip POST that silently didn't land left the consumer
    believing L2 while the wire shipped L0).

    RECONCILE AGAINST `configured_level` (+ check `source=="override"`): it is the
    level the proxy WILL apply going forward = the per-session override if one is
    recorded, else the deployment global default. When a consumer's POST /_strip
    landed, the override is recorded and `configured_level` reflects it on the very
    next poll; when it didn't land, `configured_level` falls back to the global
    default (here 0) and `source` stays "global_default" — that mismatch is the
    re-POST signal. An explicit override IMMEDIATELY forces the guard latch (the
    setter eats the one-time warm re-cache the consumer asked for), so for an
    override-set session there is NO cold-gated holding-off to fight.

    Do NOT reconcile against the guard: `guard.latched` is the cold-gated
    strip/no-strip DECISION and is only ever held off (`latched:null`) on the
    AUTOMATIC/global path (sessions with no override). Re-POSTing because the guard
    reads null would fight a legitimate cold-gate — and is unnecessary, since
    setting an override resolves the guard immediately. Guard fields are for
    DIAGNOSIS only. `riders_available` = the L2 bundle (read/edit fold + edit-ack/
    tool-error free-rider stubs) is in the configured level; those riders fire
    CONDITIONALLY per turn (only inside a region the thinking-strip already busted),
    so this is "in the ceiling," not "fired this turn"."""
    override = transforms_mod._STRIP_OVERRIDE.get(sid)
    global_default = transforms_mod._global_strip_level()
    configured = override if override is not None else global_default
    latched = transforms_mod._STRIP_GUARD_LATCH.get(sid)   # bool | None (not yet decided)
    return {
        "configured_level": configured,
        "source": "override" if override is not None else "global_default",
        "global_default_level": global_default,
        "riders_available": configured >= 2,
        "guard": {"latched": latched,
                  "decision": (None if latched is None
                               else "strip" if latched else "no_strip")},
    }


def _subagents_with_active(sid, now):
    """The session's `sub_agents[]` for /_status, each augmented with the one
    server-computed FACT a consumer can't compute skew-free on its own:
    `last_active_s` = now - last_seen (float secs) — plus the instance's own
    cost share (`est_usd`, from billing's per-line by_line bucket, keyed by
    the same instance key; None for pre-feature traffic). Policy (running/
    idle/done) and aging stay the consumer's — we emit no `status`. Snapshot
    entries are fresh dict copies (meta clones them), so mutating is safe.
    None passthrough."""
    subs = meta_mod._subagents_snapshot(sid)
    if not subs:
        return subs
    by_line = (billing_mod._SESSION_TOTALS.get(sid) or {}).get("by_line") or {}
    for s in subs:
        ls = s.get("last_seen")
        s["last_active_s"] = round(now - ls, 1) if ls else None
        b = by_line.get(s.get("key"))
        s["est_usd"] = round(b["est_usd"], 6) if b else None
    return subs


def _last_assistant_activity(obj):
    """(last_text, last_tool, last_tool_input) from the LATEST assistant message
    in a forwarded request body. text = that message's text blocks joined; tool =
    its last tool_use (name + verbatim `input`). This is one-turn-stale by
    construction — the request body holds the transcript up to the last COMPLETED
    turn, never the in-flight response. All None when there's no assistant turn."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list):
        return None, None, None
    for m in reversed(msgs):
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        c = m.get("content")
        blocks = (c if isinstance(c, list)
                  else [{"type": "text", "text": c}] if isinstance(c, str) else [])
        texts, tool, tin = [], None, None
        for b in blocks:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                texts.append(b.get("text") or "")
            elif bt == "tool_use":
                tool = b.get("name")          # last one wins = most recent in turn
                tin = b.get("input")
        return ("\n".join(t for t in texts if t).strip() or None), tool, tin
    return None, None, None


def _clamp_strings(val, maxlen):
    """Clamp every string VALUE nested in val to maxlen chars, preserving the JSON
    STRUCTURE (never truncating keys or the shape — only leaf string values), so a
    popover can preview multi-arg tool inputs without pulling full file bodies.
    Returns (clamped_copy, any_truncated)."""
    truncated = False

    def go(v):
        nonlocal truncated
        if isinstance(v, str):
            if len(v) > maxlen:
                truncated = True
                return v[:maxlen]
            return v
        if isinstance(v, list):
            return [go(x) for x in v]
        if isinstance(v, dict):
            return {k: go(x) for k, x in v.items()}
        return v

    return go(val), truncated


def _subagent_detail(session, child, maxlen=None):
    """On-demand detail for ONE subagent instance (clodex popover): the latest
    assistant text + tool from its last forwarded request body. `child` is the
    instance key from `sub_agents[].key` (agent-id when present, else role).
    Facts-only, in-memory, off the poll path. `found:false` + `reason` (200, never
    4xx — action-endpoint convention) for the absent cases:
      unknown_child   — no such instance key under this (live) session
      no_request_body — instance is in sub_agents[] but no body was ever captured
      session_cold    — session swept/ended/restored, in-memory bodies gone
    `maxlen` clamps string values in last_text/last_tool_input in place; `truncated`
    is true iff any clamp fired."""
    snap = meta_mod._subagents_snapshot(session) or []
    match = next((s for s in snap if s.get("key") == child), None)
    entry = meta_mod._subagent_request(session, child)   # {"obj","ts",...} | None
    if entry is None:
        reason = ("no_request_body" if match else
                  "unknown_child" if snap else "session_cold")
        return {"session": session, "child": child, "found": False,
                "reason": reason}
    obj = entry.get("obj") or {}
    last_text, last_tool, last_tool_input = _last_assistant_activity(obj)
    truncated = False
    if maxlen and maxlen > 0:
        if isinstance(last_text, str) and len(last_text) > maxlen:
            last_text, truncated = last_text[:maxlen], True
        if last_tool_input is not None:
            last_tool_input, ti_trunc = _clamp_strings(last_tool_input, maxlen)
            truncated = truncated or ti_trunc
    return {"session": session, "child": child, "found": True,
            "role": (match or {}).get("role"),
            "model": (match or {}).get("model") or obj.get("model"),
            "display_name": (match or {}).get("display_name"),
            "turn_ts": entry.get("ts"),
            "last_text": last_text or None,
            "last_tool": last_tool,
            "last_tool_input": last_tool_input,
            "truncated": truncated}


# Chars -> tokens divisors. PROSE (system text, messages, thinking) tokenizes at
# ~4 ch/tok. Dense JSON tool SCHEMAS (short keys, punctuation, enum literals)
# tokenize ~40% denser: wire-calibrated 2026-07-18 against a session's own
# `/context` — 90,812 ch of tools[] reported as 32.7k tokens = 2.78 ch/tok, where
# the /4 estimate lowballed it to 23.3k (~30% under). So tool schemas get their
# own divisor; prose keeps /4. analyze_tools.py mirrors _SCHEMA_CHARS_PER_TOK at
# its tool-schema call sites. Ranking (what to trim) is robust to the exact ratio;
# the divisor split only matters for the absolute est_tokens shown next to /context.
_CHARS_PER_TOK = 4
_SCHEMA_CHARS_PER_TOK = 2.8


def _wire_of(obj):
    """/_context `wire` vocabulary: anthropic | openai (codex) | meta (muse)."""
    if muse_mod._is_muse_body(obj):
        return "meta"
    return "openai" if codex_mod._is_openai_body(obj) else "anthropic"


def _tool_roster(obj):
    """The tool composition of ONE forwarded request body (the post-transform
    obj — i.e. what actually reached the model, reflecting any wirescope
    tool-trim/sort). Returns {count, names, total_schema_chars, est_tokens,
    per_tool:[{name, schema_chars, est_tokens}]} with per_tool biggest-first
    (the 'what to trim' view). None for a codex body (different wire,
    server-side caching, no anthropic tools[]) or when there are no tools.
    A muse body IS rostered: its one namespace wrapper is unwrapped to the
    nested function list (the lever there is the CLI's own tool config)."""
    if not isinstance(obj, dict):
        return None
    if muse_mod._is_muse_body(obj):
        tools = muse_mod._flatten_namespace_tools(obj.get("tools"))
    elif codex_mod._is_openai_body(obj):
        return None
    else:
        tools = obj.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    per = []
    for t in tools:
        if not isinstance(t, dict):
            continue
        chars = len(json.dumps(t, ensure_ascii=False))
        per.append({"name": t.get("name"), "schema_chars": chars,
                    "est_tokens": int(chars / _SCHEMA_CHARS_PER_TOK)})
    per.sort(key=lambda x: x["schema_chars"], reverse=True)
    total = sum(p["schema_chars"] for p in per)
    return {"count": len(per), "names": [p["name"] for p in per],
            "total_schema_chars": total,
            "est_tokens": int(total / _SCHEMA_CHARS_PER_TOK),
            "per_tool": per}


def _is_injected_reminder(text):
    """A user-role text block that is harness-injected context, NOT genuine user
    prompt: the `<system-reminder>` bundle (carries # claudeMd / # userEmail /
    # currentDate, plus our relocated env tail) and <command-*>/<local-command-*>
    expansions. Bucketed apart from real `user` text so the composition reflects
    what's actually a person's words vs auto-loaded context."""
    t = (text or "").lstrip()
    return (t.startswith("<system-reminder>") or t.startswith("<command-")
            or t.startswith("<local-command-"))


def _reminder_section_chars(text, hdr):
    """Char span of one CLI reminder section (# claudeMd / # userEmail /
    # currentDate) for COMPOSITION SIZING — from its header to the NEXT reminder
    header, else the LAST </system-reminder> (the structural close), else end.

    Distinct from the forward-path strip helper on purpose: that one fail-safe
    stops at the FIRST </system-reminder> so an `omit` never over-strips. But a
    memory file (this very CLAUDE.md / HANDOFF) routinely QUOTES </system-reminder>
    in its prose — the strip extent then truncates mid-content and the rest of the
    block lands in the `system` bucket (the "system prompt 51k" miscount). Sizing
    instead spans by reminder HEADERS (calibrated lowercase-camelCase, never a
    Title-Case content heading) and falls back to the LAST close tag (rfind), so a
    quoted </system-reminder> inside the body can't truncate the measurement. 0 if
    the header is absent."""
    m = re.search(r"(?m)^[ \t]*" + re.escape(hdr) + r"[ \t]*$", text)
    if not m:
        return 0
    rest = text[m.end():]
    nxt = re.search(transforms_mod._WS_SECTION_HDR_RE, rest)
    if nxt:
        return (m.end() + nxt.start()) - m.start()
    close = rest.rfind("</system-reminder>")
    end = m.end() + (close if close != -1 else len(rest))
    return end - m.start()


# The CLI injects the agent roster and the skills list as fixed-opener blocks,
# detected by their canonical lead line (tool word is Agent in clodex / Task in
# vanilla CC, hence the \w+). TWO wire shapes seen, BOTH must match:
#   (old/sonnet) a <system-reminder>-wrapped block inside messages[0]
#   (opus-4-8 mid-conversation-system beta) a trailing role:"system" message,
#     UNWRAPPED — text starts directly with the opener, no <system-reminder>.
# Hence the optional wrapper prefix. The match is ANCHORED to the block start
# (^) on purpose: these exact strings also appear mid-text in tool-results and
# assistant turns when an agent is *discussing* them — a substring match would
# false-positive, the anchor won't. Detecting them lets composition attribute
# their carriage (~1k tok/turn) apart from the agent system prompt, and a
# consumer can attach a trim lever (deny built-in agents / skillOverrides off).
# Whole-block categories: the entire block is the roster/list.
_RE_REMINDER_AGENTS = re.compile(
    r"^(?:<system-reminder>\s*)?Available agent types for the \w+ tool:")
_RE_REMINDER_SKILLS = re.compile(
    r"^(?:<system-reminder>\s*)?The following skills are available for use with the \w+ tool:")
# The opus-4-8 wire CONCATENATES the roster + skills list into ONE role:"system"
# message (agents first, then the skills opener on its own line). This finds that
# inner boundary so a combined block splits agents|skills (line-anchored: only a
# real list opener, never a mid-sentence mention).
_RE_SKILLS_LINE = re.compile(
    r"(?m)^The following skills are available for use with the \w+ tool:")


def _reminder_kind(text):
    """Classify a context block by its anchored opener: 'agents' (CLI agent
    roster), 'skills' (CLI skills list), or None (the # claudeMd/# userEmail
    context bundle, any other reminder/command expansion, or genuine
    conversation — all handled elsewhere). Matches both the <system-reminder>-
    wrapped form (old wire, messages[0]) and the unwrapped trailing role:"system"
    form (opus-4-8 mid-conversation-system beta)."""
    t = (text or "").lstrip()
    if _RE_REMINDER_AGENTS.match(t):
        return "agents"
    if _RE_REMINDER_SKILLS.match(t):
        return "skills"
    return None


# A skills-block entry: a column-0 `- <name>:` line (the CLI formats each skill
# as `- skill-name: <description>`). Same shape as the agent-roster entries, so
# we only ever scan it on the slice that starts AT the skills opener (agents that
# precede it in the opus-4-8 combined block are excluded by construction).
_RE_SKILL_ENTRY = re.compile(r"(?m)^- ([a-z0-9][\w.-]*):")


def _iter_body_texts(obj):
    """Yield every text string in a request body: system[] blocks (or a string
    system), then each message's text blocks. The home of the injected skills
    list on both wires (system[] / messages[0] reminder / trailing role:system)."""
    sysf = obj.get("system")
    if isinstance(sysf, list):
        for b in sysf:
            if isinstance(b, dict) and isinstance(b.get("text"), str):
                yield b["text"]
    elif isinstance(sysf, str):
        yield sysf
    for m in obj.get("messages") or []:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if isinstance(c, str):
            yield c
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text" \
                        and isinstance(b.get("text"), str):
                    yield b["text"]


def _find_skills_block(obj):
    """The CLI skills list as a raw substring (opener through end of its block),
    found wherever it rides — own <system-reminder>, messages[0], or the opus-4-8
    combined trailing role:system message (slice from the skills opener so the
    agent roster ahead of it is dropped). None if no skills are loaded."""
    for t in _iter_body_texts(obj):
        m = _RE_SKILLS_LINE.search(t)
        if m:
            block = t[m.start():]
            end = block.find("</system-reminder>")
            return block[:end] if end != -1 else block
    return None


def _skill_roster(obj):
    """The skills composition of ONE forwarded body — the per-skill twin of
    _tool_roster. Returns {count, names, total_schema_chars, est_tokens,
    per_skill:[{name, schema_chars, est_tokens}]} biggest-first ('what to trim';
    the lever is skillOverrides:{name:off}, which actually reclaims the tokens —
    permissions.deny only gates invocation). Each skill's size = chars from its
    `- name:` line to the next entry (last entry → end of block). None for a
    codex body or when no skills block is present."""
    if not isinstance(obj, dict) or codex_mod._is_openai_body(obj):
        return None
    block = _find_skills_block(obj)
    if not block:
        return None
    entries = list(_RE_SKILL_ENTRY.finditer(block))
    if not entries:
        return None
    per = []
    for i, e in enumerate(entries):
        start = e.start()
        end = entries[i + 1].start() if i + 1 < len(entries) else len(block)
        chars = end - start
        per.append({"name": e.group(1), "schema_chars": chars,
                    "est_tokens": chars // _CHARS_PER_TOK})
    per.sort(key=lambda x: x["schema_chars"], reverse=True)
    total = sum(p["schema_chars"] for p in per)
    return {"count": len(per), "names": [p["name"] for p in per],
            "total_schema_chars": total, "est_tokens": total // _CHARS_PER_TOK,
            "per_skill": per}


def _composition(obj, total_tokens=None):
    """Token composition of ONE forwarded body, by category — 'what is taking up
    the context window'. Generic vocabulary any consumer can render:
    system / claudemd / useremail / agents / skills / tools / user / assistant /
    thinking / tool_calls / tool_results (file reads & command output land in
    tool_results, usually the bulk). claudemd & useremail are split out of the
    system-reminder so a consumer can attach a real trim lever (the wirescope
    omit directives); agents (the CLI agent roster) & skills (the CLI skills
    list) are likewise split out of their own system-reminder blocks — each
    ~hundreds of tok/turn that would otherwise hide inside 'system', and each
    has its own trim lever (deny built-in agents / deny skills in settings).

    Sizing is char-based (len, /4 — same basis as _tool_roster/analyze_tools.py);
    this is a READ-only endpoint computation, never on the forward path. When a
    real receipt `total_tokens` is given (main line), categories are scaled to
    sum to it (basis 'receipt') so the breakdown agrees with the wire-measured
    window total; otherwise raw char-estimate (basis 'estimate'). A
    Responses-API body (codex/muse) goes through _composition_openai — same
    output shape, that wire's item vocabulary. None for an empty body."""
    if not isinstance(obj, dict):
        return None
    if codex_mod._is_openai_body(obj):
        return _composition_openai(obj, total_tokens)
    chars = collections.defaultdict(int)
    sysf = obj.get("system")
    if isinstance(sysf, list):
        for b in sysf:
            if isinstance(b, dict):
                chars["system"] += len(b.get("text") or "")
    elif isinstance(sysf, str):
        chars["system"] += len(sysf)
    for t in (obj.get("tools") or []):
        if isinstance(t, dict):
            chars["tools"] += len(json.dumps(t, ensure_ascii=False))
    for m in (obj.get("messages") or []):
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        c = m.get("content")
        blocks = (c if isinstance(c, list)
                  else [{"type": "text", "text": c}] if isinstance(c, str) else [])
        for b in blocks:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                text = b.get("text") or ""
                kind = _reminder_kind(text)        # agents/skills, any wire shape
                if kind == "agents":               # checked FIRST: the opus-4-8
                    #  roster arrives unwrapped (not an injected-reminder) AND may
                    #  carry the skills list appended in the same block -> split.
                    m = _RE_SKILLS_LINE.search(text)
                    if m:
                        chars["agents"] += m.start()
                        chars["skills"] += len(text) - m.start()
                    else:
                        chars["agents"] += len(text)
                elif kind == "skills":
                    chars["skills"] += len(text)
                elif _is_injected_reminder(text):
                    cm = _reminder_section_chars(text, "# claudeMd")
                    ue = _reminder_section_chars(text, "# userEmail")
                    chars["claudemd"] += cm
                    chars["useremail"] += ue
                    chars["system"] += max(0, len(text) - cm - ue)
                else:
                    chars["assistant" if role == "assistant" else "user"] += len(text)
            elif bt in ("thinking", "redacted_thinking"):
                # signature + redacted data ship on the wire (and a strip removes
                # them) -> count them, so this agrees with _strip_thinking_panel.
                body = (b.get("thinking") or "") + (b.get("data") or "")
                sig = b.get("signature") or ""
                chars["thinking"] += (len(body) + len(sig) if (body or sig)
                                      else len(json.dumps(b, ensure_ascii=False)))
            elif bt == "tool_use":
                chars["tool_calls"] += len(json.dumps(b, ensure_ascii=False))
            elif bt == "tool_result":
                bc = b.get("content")
                ln = (len(bc) if isinstance(bc, str)
                      else sum(len(x.get("text") or "") for x in bc
                               if isinstance(x, dict)) if isinstance(bc, list)
                      else len(json.dumps(bc, ensure_ascii=False)) if bc is not None
                      else 0)
                chars["tool_results"] += ln
    # tools[] is dense JSON schema -> its own divisor; every other category is
    # prose. Matters for the tools-vs-rest split before the receipt rescale.
    raw = {k: (int(v / _SCHEMA_CHARS_PER_TOK) if k == "tools" else v // _CHARS_PER_TOK)
           for k, v in chars.items() if v > 0}
    raw_total = sum(raw.values())
    if not raw_total:
        return None
    if total_tokens and total_tokens > 0:
        basis, total = "receipt", total_tokens
        scale = total_tokens / raw_total
        cats = [{"category": k, "tokens": round(v * scale)} for k, v in raw.items()]
    else:
        basis, total, scale = "estimate", raw_total, 1.0
        cats = [{"category": k, "tokens": v} for k, v in raw.items()]
    for c in cats:
        c["pct"] = round(100.0 * c["tokens"] / total, 1) if total else 0.0
    cats.sort(key=lambda x: x["tokens"], reverse=True)
    out = {"total_tokens": total, "basis": basis, "by_category": cats}
    spt = _strip_thinking_panel(obj, scale, total)
    if spt:
        out["strip_prior_thinking"] = spt
    ste = _strip_tool_errors_panel(obj, scale, total)
    if ste:
        out["strip_prior_tool_errors"] = ste
    sea = _strip_edit_acks_panel(obj, scale, total)
    if sea:
        out["strip_prior_edit_acks"] = sea
    return out


def _composition_openai(obj, total_tokens=None):
    """_composition for the Responses-API wire (codex, muse). Same output
    shape and the same char->tok divisors, mapped onto that wire's items:
    `instructions` -> system; a `developer` message -> developer (codex's
    permissions block, muse's `Workspace root:` framing); user / assistant
    messages by role (either content dialect — muse ships bare strings);
    `reasoning` items -> reasoning (the encrypted payload ships back on the
    wire every turn, so it is counted at its shipped length); `function_call`
    -> tool_calls; `function_call_output` -> tool_results; `tools[]` -> tools
    (muse's one namespace wrapper counted whole: that IS the schema shipped).
    Was None for this wire until 2026-09-22, which left /_context with no
    'what is taking up the window' view for a muse seat."""
    chars = collections.defaultdict(int)
    instr = obj.get("instructions")
    if isinstance(instr, str):
        chars["system"] += len(instr)
    for t in (obj.get("tools") or []):
        if isinstance(t, dict):
            chars["tools"] += len(json.dumps(t, ensure_ascii=False))
    for it in (obj.get("input") or []):
        if not isinstance(it, dict):
            continue
        t = it.get("type")
        if t == "message":
            role = it.get("role")
            cat = ("developer" if role == "developer"
                   else "assistant" if role == "assistant" else "user")
            chars[cat] += sum(len(x) for x in codex_mod._item_texts(it))
        elif t == "reasoning":
            chars["reasoning"] += len(json.dumps(it, ensure_ascii=False))
        elif t == "function_call":
            chars["tool_calls"] += len(json.dumps(it, ensure_ascii=False))
        elif t == "function_call_output":
            out = it.get("output")
            chars["tool_results"] += (len(out) if isinstance(out, str)
                                      else len(json.dumps(out, ensure_ascii=False))
                                      if out is not None else 0)
    raw = {k: (int(v / _SCHEMA_CHARS_PER_TOK) if k == "tools" else v // _CHARS_PER_TOK)
           for k, v in chars.items() if v > 0}
    raw_total = sum(raw.values())
    if not raw_total:
        return None
    if total_tokens and total_tokens > 0:
        basis, total = "receipt", total_tokens
        scale = total_tokens / raw_total
        cats = [{"category": k, "tokens": round(v * scale)} for k, v in raw.items()]
    else:
        basis, total = "estimate", raw_total
        cats = [{"category": k, "tokens": v} for k, v in raw.items()]
    for c in cats:
        c["pct"] = round(100.0 * c["tokens"] / total, 1) if total else 0.0
    cats.sort(key=lambda x: x["tokens"], reverse=True)
    return {"total_tokens": total, "basis": basis, "by_category": cats}


def _strip_thinking_panel(obj, scale, total):
    """Decision panel for STRIP_PRIOR_THINKING: how much of the window is
    PRIOR-turn thinking (the strippable, reclaimable slice) vs current-turn
    thinking (signed, untouchable), the body/thinking ratio the monster guard
    gates on, the live would-strip verdict, and the per-turn read reclaim. Reuses
    the transform's own helpers so `would_strip`/`body_thinking_ratio` match the
    real gate exactly (no drift). None when there is no prior thinking to strip."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_user = max((i for i, m in enumerate(msgs)
                     if transforms_mod._is_real_user_turn(m)), default=-1)
    if last_user <= 0:
        return None
    prior = msgs[:last_user]
    pt_ch = sum(transforms_mod._msg_thinking_chars(m) for m in prior
                if isinstance(m, dict) and m.get("role") == "assistant")
    if not pt_ch:
        return None
    pb_ch = sum(transforms_mod._msg_nonthinking_chars(m) for m in prior
                if isinstance(m, dict))
    cur_ch = sum(transforms_mod._msg_thinking_chars(m) for m in msgs[last_user:]
                 if isinstance(m, dict) and m.get("role") == "assistant")
    ratio = round(pb_ch / pt_ch, 2)
    mbr = transforms_mod.STRIP_THINK_MAX_BODY_RATIO
    prior_tok = round((pt_ch // _CHARS_PER_TOK) * scale)
    p = billing_mod._price_for(obj.get("model"))
    est_usd = round(prior_tok / 1e6 * p["cache_read"], 4) if p else None
    return {"prior_thinking_tokens": prior_tok,
            "current_thinking_tokens": round((cur_ch // _CHARS_PER_TOK) * scale),
            "prior_body_tokens": round((pb_ch // _CHARS_PER_TOK) * scale),
            "body_thinking_ratio": ratio, "max_body_ratio": mbr,
            "would_strip": (mbr <= 0 or ratio <= mbr),
            "pct_of_window": round(100.0 * prior_tok / total, 1) if total else 0.0,
            "read_reclaim_tokens_per_turn": prior_tok,
            "est_read_reclaim_usd_per_turn": est_usd}


def _strip_tool_errors_panel(obj, scale, total):
    """Decision panel for the consumed failed-call strip: how much of the window
    is CONSUMED failed-call carriage — both halves the strip reclaims, the fat
    assistant `tool_use.input` (old/new string the model tried) plus its paired
    `is_error` result — counted over the CONSUMED region (below the last
    assistant message; the LIVE frontier error the model hasn't reacted to yet is
    never counted). Reuses the transform's id-pairing so the figures match the
    real strip. 2026-07-20 consumed-vs-live model: the strip is deterministic and
    bust-free (no thinking-bust free-ride), so `would_strip` is gated only on L2
    being enabled. None when there are no consumed errors."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_asst = transforms_mod._last_assistant_idx(msgs)
    if not last_asst:
        return None
    prior = msgs[:last_asst]
    # Pass 1: error result ids + their reclaimable body chars (minus the marker).
    error_ids, result_ch, n_results = set(), 0, 0
    mk = len(transforms_mod.ERROR_ELIDED_MARKER)
    for m in prior:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        for b in (m.get("content") or []):
            if not (isinstance(b, dict) and b.get("type") == "tool_result"
                    and b.get("is_error")):
                continue
            tuid = b.get("tool_use_id")
            if tuid is not None:
                error_ids.add(tuid)
            body = b.get("content")
            n = len(body) if isinstance(body, str) else len(json.dumps(body, default=str))
            if n > mk:
                result_ch += n - mk
                n_results += 1
    if not error_ids:
        return None
    # Pass 2: the matching failed-call inputs (the larger half), minus the stub.
    call_ch, n_calls = 0, 0
    sk = len(json.dumps(transforms_mod.ERROR_CALL_STUB, default=str))
    for m in prior:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        for b in (m.get("content") or []):
            if not (isinstance(b, dict) and b.get("type") == "tool_use"
                    and b.get("id") in error_ids):
                continue
            inp = b.get("input")
            n = len(json.dumps(inp, default=str)) if inp is not None else 0
            if n > sk:
                call_ch += n - sk
                n_calls += 1
    reclaim_ch = result_ch + call_ch
    if reclaim_ch <= 0:
        return None
    reclaim_tok = round((reclaim_ch // _CHARS_PER_TOK) * scale)
    p = billing_mod._price_for(obj.get("model"))
    est_usd = round(reclaim_tok / 1e6 * p["cache_read"], 4) if p else None
    return {"failed_calls": n_calls, "error_results": n_results,
            "failed_call_tokens": round((call_ch // _CHARS_PER_TOK) * scale),
            "error_result_tokens": round((result_ch // _CHARS_PER_TOK) * scale),
            # consumed-vs-live model: deterministic + bust-free, no thinking-bust
            # free-ride -> fires whenever L2 (or the scratch-A/B flag) is enabled.
            "would_strip": bool(transforms_mod.STRIP_PRIOR_TOOL_ERRORS
                                or transforms_mod._strip_l2_enabled(obj)),
            "pct_of_window": round(100.0 * reclaim_tok / total, 1) if total else 0.0,
            "read_reclaim_tokens_per_turn": reclaim_tok,
            "est_read_reclaim_usd_per_turn": est_usd}


def _strip_edit_acks_panel(obj, scale, total):
    """Decision panel for the L2 edit-ack collapse: how much of the window is
    CONSUMED Edit/Write SUCCESS-ack boilerplate that L2 collapses to "ok" — the
    OTHER half of L2 (the failed-call panel above is the first half). Counted over
    the CONSUMED region (below the last assistant message; the LIVE frontier ack
    carries the 'no need to Read it back' nudge, never counted). Reuses the
    transform's edit-id pairing + ack fragments so the figures match the real
    strip. 2026-07-20 consumed-vs-live model: deterministic + bust-free (no
    thinking-bust free-ride), so `would_strip` is gated only on L2. None when
    there are no collapsible consumed acks."""
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    last_asst = transforms_mod._last_assistant_idx(msgs)
    if not last_asst:
        return None
    prior = msgs[:last_asst]
    edit_ids = transforms_mod._edit_result_ids(prior)
    if not edit_ids:
        return None
    mk = len(transforms_mod.EDIT_ACK_MARKER)
    ack_ch, n_acks = 0, 0
    for m in prior:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        for b in (m.get("content") or []):
            if not (isinstance(b, dict) and b.get("type") == "tool_result"
                    and b.get("tool_use_id") in edit_ids):
                continue
            if b.get("is_error"):
                continue
            body = b.get("content")
            if not isinstance(body, str) or body == transforms_mod.EDIT_ACK_MARKER:
                continue
            if not any(frag in body for frag in transforms_mod._EDIT_ACK_FRAGMENTS):
                continue
            if len(body) <= mk:
                continue
            ack_ch += len(body) - mk
            n_acks += 1
    if ack_ch <= 0:
        return None
    reclaim_tok = round((ack_ch // _CHARS_PER_TOK) * scale)
    p = billing_mod._price_for(obj.get("model"))
    est_usd = round(reclaim_tok / 1e6 * p["cache_read"], 4) if p else None
    return {"collapsed_acks": n_acks,
            "edit_ack_tokens": reclaim_tok,
            # consumed-vs-live model: deterministic + bust-free, no thinking-bust
            # free-ride -> fires whenever L2 (or the scratch-A/B flag) is enabled.
            "would_strip": bool(transforms_mod.STRIP_PRIOR_EDIT_ACKS
                                or transforms_mod._strip_l2_enabled(obj)),
            "pct_of_window": round(100.0 * reclaim_tok / total, 1) if total else 0.0,
            "read_reclaim_tokens_per_turn": reclaim_tok,
            "est_read_reclaim_usd_per_turn": est_usd}


# The injected skills list's anchored opener, as raw bytes — lets _capture_scan
# ask "did this turn carry a skills roster?" without parsing the body. Must stay
# the byte twin of _RE_SKILLS_LINE above; verified equal on 3,000 captures.
_SKILLS_NEEDLE = b"The following skills are available for use with the"


def _file_contains(path, needle, chunk=1 << 20):
    """Does this file contain `needle`? Streamed, stopping at the first hit, so a
    match costs only the bytes up to it — measured 0.59 GB instead of 0.97 GB
    over one session's requests, which is what the page cache feels on a
    multi-GB capture dir. Carries `len(needle)-1` bytes across the chunk seam so
    a needle straddling it is still found."""
    keep = len(needle) - 1
    tail = b""
    try:
        with open(path, "rb") as fh:
            while True:
                block = fh.read(chunk)
                if not block:
                    return False
                if needle in tail + block:
                    return True
                tail = block[-keep:] if keep else b""
    except OSError:
        return False


def _sse_skill_names(path):
    """The skill names a turn INVOKED, read off its response SSE.

    The Skill tool_use streams as content_block_start(name="Skill") followed by
    input_json_delta fragments carrying `{"skill": ..., "args": ...}`, so the
    name is on the ISSUING turn's own receipt. That matters for more than speed:
    reading it here means the tally never has to walk re-shipped history looking
    for the same tool_use id, and so needs no cross-turn dedup set to stay
    correct. Yields nothing for a turn with no Skill block, an absent/unreadable
    SSE, or a fragment that doesn't parse — a skill we cannot name is not
    counted, never guessed."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    if '"name":"Skill"' not in raw and '"name": "Skill"' not in raw:
        return                       # cheap reject: no Skill block on this turn
    idx, buf = None, []
    for line in raw.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            ev = json.loads(line[6:])
        except Exception:
            continue
        kind = ev.get("type")
        if kind == "content_block_start":
            block = ev.get("content_block") or {}
            idx = ev.get("index") if block.get("name") == "Skill" else None
            buf = []
        elif kind == "content_block_delta" and idx is not None \
                and ev.get("index") == idx:
            delta = ev.get("delta") or {}
            if delta.get("type") == "input_json_delta":
                buf.append(delta.get("partial_json") or "")
        elif kind == "content_block_stop" and idx is not None \
                and ev.get("index") == idx:
            try:
                name = json.loads("".join(buf)).get("skill")
            except Exception:
                name = None
            if name:
                yield name
            idx, buf = None, []


def _capture_scan(session, since_ts=None, _only_stems=None):
    """Tool-USE and skill-INVOCATION tallies for a session, from ONE body-free
    pass over its capture dir (LOG_DIR/<session>/). Answers 'of the tools and
    skills loaded every turn, which ever got exercised?' — the deadweight
    question, made per-session and live.

    `since_ts` (epoch) counts only turns at or after it — the CURRENT context
    window, when passed the compact boundary. This is the honest denominator for
    a roster that describes the window: "never used" measured over turns the
    model can no longer see says nothing about the tools it is carrying NOW.
    None = lifetime, which is the right basis for the different question of
    whether a tool should stay loaded at all. Both are cheap enough to compute
    together, so callers get both rather than choosing (clodex: window for the
    popover's 'did it pay off', lifetime for the trim labels).

    Turn time comes from the head-read `ts` (core._head_ts, ISO-8601 local, the
    writer's own stamp) — the file mtime would be the WRITER thread's flush, not
    the turn's, and drifts under a backlog.

    **NEVER json.loads a request record here.** A request holds that turn's whole
    `messages` array (measured 347 KB/turn, 2.9 GB over one clodex session), and
    the two tallies this replaces each parsed every one of them — 23s for a
    single /_context call, past the consumer's own 20s timeout, i.e. a view that
    could not load at all on the sessions it most needed to describe. Same
    lesson, same fix as report._bust_scan: decide from the cheap reads.
      * `summary`      — tail-read (core._tail_summary) for role/agent_id/n_tools.
      * skills ROSTER  — a byte needle for the injected list's anchored opener,
        checked against the parsed-body regex on 3,000 captures: 0 disagreements.
      * skills USED    — the response SSE (_sse_skill_names), not request history.
      * tools USED     — response meta.tool_uses, as before (receipts are small).
    A tail-read that misses degrades to a full parse of that ONE file, so a
    writer format change costs speed, never correctness.

    On-demand only: callers gate it behind `/_context?...&utilization=1` so the
    10s poll / admin path never pays for it. Scoped to the ONE session dir =>
    naturally bounded to the live session_id (a /clear mints a fresh id => fresh
    dir => the tally never spans the boundary).

    Only turns that LOADED tools (resp. carried a skills roster) AND actually RAN
    (200) count as a 'chance to use' — a no-tools title side-call or an errored
    turn is not evidence of waste. `used` is the RAW invocation count (3 Reads in
    one turn = 3), per clodex's contract.

    Returns (tools, skills), each {key -> {evaluable_turns, by_tool|by_skill}},
    keyed by agent line: 'main' for routed parent/unknown-role turns, else the
    subagent INSTANCE's x-claude-code-agent-id (fallback role) — the same key
    _context_snapshot resolves per agent, so the merge lines up. Empty maps for a
    cold/absent dir.

    The dir is LIVE: a long session writes captures while this runs, so both
    tallies are a smear over the scan window rather than an instant — two
    back-to-back calls on an active seat differ (measured 6,730 vs 6,732
    evaluable turns). That is inherent to scanning a directory being written to,
    not a defect to fix here; treat `evaluable_turns` as 'as of roughly now'."""
    tools, skills = {}, {}
    d = core_mod._session_dir(session)
    if not d.is_dir():
        return tools, skills
    for f in sorted(d.glob("*.request.json")):
        # `_only_stems` (internal, from _lifetime_scan) folds just the captures
        # written since the last call. Captures are write-once, so a turn's
        # contribution never changes and the partial fold is EXACT.
        if _only_stems is not None \
                and f.name[:-len(".request.json")] not in _only_stems:
            continue
        if since_ts is not None:
            ts = core_mod._epoch_ts(core_mod._head_ts(f))
            # A turn we cannot time is KEPT: dropping it would silently shrink
            # the denominator and inflate every "used" rate, which reads as a
            # cleaner roster than the wire supports.
            if ts is not None and ts < since_ts:
                continue
        summ = core_mod._tail_summary(f)
        if summ is None:                   # cheap read missed -> pay for one parse
            try:
                summ = (json.loads(f.read_text()) or {}).get("summary") or {}
            except Exception:
                continue
        role = summ.get("role")
        key = "main" if role in ("parent", "unknown", None) \
            else (summ.get("agent_id") or role)
        rp = f.with_name(f.name.replace(".request.json", ".response.json"))
        receipt = None

        def _resp():
            """The turn's receipt, read at most once even though both tallies
            ask whether it ran."""
            nonlocal receipt
            if receipt is None:
                try:
                    r = json.loads(rp.read_text())
                    receipt = (r.get("status_code") == 200,
                               (r.get("meta") or {}).get("tool_uses") or [])
                except Exception:
                    receipt = (False, [])
            return receipt

        if summ.get("n_tools") or 0:       # no tools loaded => not a use-chance
            g = tools.setdefault(key, {"evaluable_turns": 0,
                                       "by_tool": collections.Counter()})
            ok, called = _resp()
            if ok:
                g["evaluable_turns"] += 1
                for name in called:
                    if name:
                        g["by_tool"][name] += 1

        g = skills.setdefault(key, {"evaluable_turns": 0,
                                    "by_skill": collections.Counter()})
        if _file_contains(f, _SKILLS_NEEDLE) and _resp()[0]:
            g["evaluable_turns"] += 1
        for name in _sse_skill_names(
                f.with_name(f.name.replace(".request.json", ".response.sse"))):
            g["by_skill"][name] += 1
    return tools, skills


# --- the lifetime memo ------------------------------------------------------
# The WINDOW pass is cheap by construction (it reads only turns after the
# compact boundary — 40 of 8,647 files on the session that prompted all this).
# The LIFETIME pass is not: it walks the whole dir, and the dir only grows.
# Measured on the live coordinator seat: 7.35s at 3.08 GB, growing 0.31 GB/day
# = +0.74s/day, which re-enters a 20s consumer timeout in ~17 days. So the
# v0.6.68 fix bought time, not a fix, and this is the fix.
#
# It is an APPEND-ONLY FOLD, not a cache with an invalidation rule: a capture is
# write-once (same premise the prune memo rests on, pinned by the same test), so
# a turn's contribution to the tally never changes once written. Keep the
# running counters plus the SET of stems already folded, and a later call folds
# exactly the stems not in it. That is exact — not an approximation of a walk.
#
# The set is deliberate; a high-water MARK would be wrong here. Capture seq
# numbers are not zero-padded ("001-…" through "20322-…"), so lexical order is
# not write order — `9998-…` sorts above `20322-…`, and a lexical high-water
# mark silently stops folding new turns forever, undercounting without ever
# erroring. (Found by the incremental test below, which is why it appends a turn
# and re-compares against a full walk rather than just checking it is fast.)
# Sorting numerically instead would trade one parsing assumption about the
# writer's naming for another; a set assumes nothing about the name at all.
# Cost is ~1.4 MB for the largest session on this box, which is why the memo
# holds few sessions — only those someone actually opens a popover on.
#
# PRUNE is the interesting case, and the reason this is not keyed on a file
# count. `tier=receipts` deletes exactly what this scan reads (.request.json +
# .response.sse are prune._BODY_SUFFIXES), so a pruned session re-walks to a
# near-empty tally: evaluable_turns collapses, every tool reads as deadweight,
# and a consumer renders confident trim advice from data that no longer exists.
# A count-keyed memo would notice the drop and "recover" by rescanning INTO that
# wrong answer. So instead: retain the pre-prune tally (it is the best available
# number, and the turns really did happen) and SAY SO on the wire via
# `basis: "memo-pre-prune"`. Clodex renders that as "counts predate a prune of
# this session" and gates nothing on it.
#
# basis vocabulary (clodex's, a string not a boolean so the taxonomy can grow —
# its popover already switches on basis strings):
#   "walk"            fresh full scan, what every call did before this
#   "memo"            served from the fold, exact
#   "memo-pre-prune"  served from the fold, and the dir has since been pruned
_LIFETIME_MEMO: dict = {}
_LIFETIME_MEMO_LOCK = threading.Lock()
# Each entry holds the folded stem set (~1.4 MB on this box's largest session),
# so this is capped by MEMORY, not by session count. Only sessions someone
# actually requests utilization for are ever in here.
_LIFETIME_MEMO_MAX = 32


def _merge_tally(dst, src, kind):
    """Fold one scan's tally into a running one, in place."""
    for key, g in src.items():
        d = dst.setdefault(key, {"evaluable_turns": 0,
                                 kind: collections.Counter()})
        d["evaluable_turns"] += g["evaluable_turns"]
        d[kind].update(g[kind])
    return dst


def _copy_tally(t, kind):
    """A deep-enough copy that a caller mutating the result (the _apply_*
    functions sort and stamp in place) cannot corrupt the memo."""
    return {k: {"evaluable_turns": g["evaluable_turns"],
                kind: collections.Counter(g[kind])} for k, g in t.items()}


def _lifetime_scan(session, memo=True):
    """The LIFETIME tallies for a session -> (tools, skills, basis).

    Folds only the captures written since the last call (see the memo block
    above). `memo=False` forces a full walk — the equivalence test uses it, and
    it is the escape hatch if a fold is ever suspect."""
    d = core_mod._session_dir(session)
    if not memo or not d.is_dir():
        t, s = _capture_scan(session)
        return t, s, "walk"
    stems = {f.name[:-len(".request.json")]
             for f in d.glob("*.request.json")}
    with _LIFETIME_MEMO_LOCK:
        m = _LIFETIME_MEMO.get(session)
    if m is None:
        tools, skills = _capture_scan(session)
        entry = {"folded": stems, "tools": tools, "skills": skills,
                 "pruned": False}
        with _LIFETIME_MEMO_LOCK:
            if len(_LIFETIME_MEMO) >= _LIFETIME_MEMO_MAX:
                _LIFETIME_MEMO.clear()
            _LIFETIME_MEMO[session] = entry
        return (_copy_tally(tools, "by_tool"),
                _copy_tally(skills, "by_skill"), "walk")
    fresh = stems - m["folded"]
    # A stem we folded that is no longer on disk = a prune took the body. The
    # tally keeps counting it (the turn really happened, and it is the best
    # number available), and says so via the basis. Sticky: once pruned, this
    # tally permanently predates that prune.
    pruned = m["pruned"] or bool(m["folded"] - stems)
    if fresh:
        ft, fs = _capture_scan(session, _only_stems=fresh)
        _merge_tally(m["tools"], ft, "by_tool")
        _merge_tally(m["skills"], fs, "by_skill")
        m["folded"] |= fresh
    m["pruned"] = pruned
    return (_copy_tally(m["tools"], "by_tool"),
            _copy_tally(m["skills"], "by_skill"),
            "memo-pre-prune" if pruned else "memo")


def _apply_utilization(tools, ustats):
    """Fold one agent line's lifetime tally (from _capture_scan) into its tools
    roster IN PLACE: stamp per_tool[].used, re-sort deadweight-first (never-used
    first, then biggest schema = the 'trim me' order clodex renders), and return
    a rollup {basis, evaluable_turns, loaded, used_distinct, deadweight_tokens}.
    deadweight_tokens = per-turn schema carriage of the currently-loaded tools
    that were never called — the concrete 'free up ~N tokens' payoff. None when
    there is no roster (codex / no tools)."""
    if not tools:
        return None
    by_tool = (ustats or {}).get("by_tool") or {}
    evaluable = (ustats or {}).get("evaluable_turns", 0)
    for p in tools["per_tool"]:
        p["used"] = int(by_tool.get(p["name"], 0))
    tools["per_tool"].sort(key=lambda x: (x["used"] > 0, -x["est_tokens"]))
    used_distinct = sum(1 for p in tools["per_tool"] if p["used"] > 0)
    deadweight = sum(p["est_tokens"] for p in tools["per_tool"] if p["used"] == 0)
    return {"basis": "capture-scan", "evaluable_turns": evaluable,
            "loaded": tools["count"], "used_distinct": used_distinct,
            "deadweight_tokens": deadweight}


def _apply_skill_utilization(skills, ustats):
    """Fold a session's skill-invocation tally into its skill roster IN PLACE:
    stamp per_skill[].used, re-sort deadweight-first, and return a rollup
    {basis, evaluable_turns, loaded, used_distinct, deadweight_tokens} — the
    per-skill twin of _apply_utilization. deadweight_tokens = per-turn carriage of
    loaded-but-never-invoked skills (the skillOverrides:off reclaim payoff). None
    when there is no roster."""
    if not skills:
        return None
    by_skill = (ustats or {}).get("by_skill") or {}
    evaluable = (ustats or {}).get("evaluable_turns", 0)
    for p in skills["per_skill"]:
        p["used"] = int(by_skill.get(p["name"], 0))
    skills["per_skill"].sort(key=lambda x: (x["used"] > 0, -x["est_tokens"]))
    used_distinct = sum(1 for p in skills["per_skill"] if p["used"] > 0)
    deadweight = sum(p["est_tokens"] for p in skills["per_skill"] if p["used"] == 0)
    return {"basis": "capture-scan", "evaluable_turns": evaluable,
            "loaded": skills["count"], "used_distinct": used_distinct,
            "deadweight_tokens": deadweight}


def _attach_lifetime(entry, tstats, sstats):
    """Hang the LIFETIME counters off an entry's window rollups, as
    `utilization.lifetime` / `skills_utilization.lifetime`.

    Deliberately narrow: `evaluable_turns` + `used_distinct` only, never
    per-tool `used`. Two `used` numbers on the same tool row is an invitation to
    render the wrong one, and the lifetime question a consumer actually asks
    ('has this tool EVER paid for itself on this seat?') is answered by the
    distinct count. Absent rollup (codex / no roster) => nothing to attach."""
    for field, stats, kind in (("utilization", tstats, "by_tool"),
                               ("skills_utilization", sstats, "by_skill")):
        roll = entry.get(field)
        if not roll or stats is None:
            continue
        roll["lifetime"] = {
            "evaluable_turns": stats.get("evaluable_turns", 0),
            "used_distinct": sum(1 for v in (stats.get(kind) or {}).values()
                                 if v > 0)}


def _context_snapshot(session, utilization=False):
    """`GET /_context?session=<id>`: the tool rosters loaded for a session,
    main/parent line and each subagent INSTANCE reported separately (they carry
    distinct, possibly wirescope-trimmed sets). Read-only over the in-memory
    last forwarded request bodies (parent in pinger._LAST_REQUEST, subagents in
    meta._SUBAGENT_LAST_REQ) — so it answers 'what tools are enabled for session
    X right now'. No disk lookup: an ended/restored/cold session with nothing in
    memory returns agents=[] plus an explanatory note.

    When `utilization=True` each agent's tools roster is additionally enriched
    with per-tool `used` counts + a `utilization` rollup (deadweight pricing)
    via a disk scan of the session's capture dir (_capture_scan) — the 'did the
    loaded tools pay off?' view. Off by default so the cheap in-memory path is
    unchanged for the poll/admin callers.

    `used` counts the CURRENT context window (since the last compact boundary),
    because the roster being decorated is the current window: a tool called only
    in turns the model can no longer see is deadweight NOW, whatever it did
    before. The lifetime figures answer the different question of whether a tool
    should stay loaded at all, so they ride alongside under
    `utilization.lifetime` rather than replacing it (clodex renders the window
    number on the popover and reads lifetime for its trim labels).

    The boundary is billing's `since_compact.boundary_ts` — stamped on the
    request path from a turns-in-context DECREASE and persisted in _session.json,
    so it survives a restart and is exact. No baseline (pre-feature, or a session
    that never compacted) => the window IS the lifetime, and both bases report
    the same numbers rather than one going silently empty."""
    agents = []
    with pinger_mod._LAST_REQUEST_LOCK:
        main = pinger_mod._LAST_REQUEST.get(session)
        main = dict(main) if main else None     # shallow copy; obj read outside lock
    subs = meta_mod._subagent_request_objs(session)
    # The scan DECORATES rosters, so it is worthless without one: an ended or
    # restored session holds nothing in memory and returns agents=[] whatever the
    # scan finds. Gating on that first is what makes the pathological case cheap
    # — the sessions with the biggest capture dirs are exactly the long-lived
    # ones most likely to have just rotated their id, and they used to pay a
    # full-dir scan to be told there was nothing to report.
    util, skutil, lifetime, lskutil = ({}, {}, {}, {})
    scan_window = None
    life_basis = "walk"
    if utilization and (main or subs):
        t0 = time.time()
        boundary = (billing_mod.since_compact(
            billing_mod._SESSION_TOTALS.get(session)) or {}).get("boundary_ts")
        # The lifetime pass is the expensive one (it walks the whole dir, which
        # only grows), so it folds incrementally; the window pass stays a live
        # scan because it reads only the small tail after the boundary and must
        # move the moment a turn lands.
        lifetime, lskutil, life_basis = _lifetime_scan(session)
        # One extra pass, not two: the windowed pass re-walks only the turns
        # after the boundary, which on a compacted session is a small tail of
        # the dir. A session that never compacted shares the lifetime result
        # outright rather than scanning the same files twice for equal answers.
        util, skutil = ((_capture_scan(session, since_ts=boundary), )[0]
                        if boundary else (lifetime, lskutil))
        scan_window = {"basis": "live-scan",
                       "scan_s": round(time.time() - t0, 3),
                       "compact_boundary_ts": boundary,
                       # how the LIFETIME half was produced: walk | memo |
                       # memo-pre-prune. Separate from `basis` above, which
                       # describes the window half — they genuinely differ.
                       "lifetime_basis": life_basis,
                       # the dir is written to WHILE this runs, so the counts are
                       # a smear across scan_s, not an instant (measured: two
                       # back-to-back calls differed by 2 evaluable turns)
                       "note": "counts scanned from a live capture dir"}
    if main:
        obj = main.get("obj")
        # main line carries a real usage receipt -> anchor the composition total
        # to the wire-measured window size so it agrees with /_status.input_tokens
        total = meta_mod._input_token_total(meta_mod._LAST_USAGE.get(session))
        roster = _tool_roster(obj)
        entry = {
            "line": "main", "role": "parent", "agent_id": None,
            "display_name": None,
            "model": (obj or {}).get("model") if isinstance(obj, dict) else None,
            "wire": _wire_of(obj),
            "last_seen": main.get("ts"),
            "tools": roster,
            "skills": _skill_roster(obj),
            "composition": _composition(obj, total)}
        if utilization:
            entry["utilization"] = _apply_utilization(roster, util.get("main"))
            entry["skills_utilization"] = _apply_skill_utilization(
                entry["skills"], skutil.get("main"))
            _attach_lifetime(entry, lifetime.get("main"), lskutil.get("main"))
        agents.append(entry)
    for s in subs:
        obj = s.get("obj")
        roster = _tool_roster(obj)
        entry = {
            "line": "subagent", "role": s.get("role"),
            "agent_id": s.get("agent_id"), "display_name": s.get("display_name"),
            "model": s.get("model"),
            "wire": _wire_of(obj),
            "last_seen": s.get("last_seen"),
            "tools": roster,
            "skills": _skill_roster(obj),
            "composition": _composition(obj)}    # no sub receipt -> estimate
        if utilization:
            ukey = s.get("agent_id") or s.get("role")
            entry["utilization"] = _apply_utilization(roster, util.get(ukey))
            entry["skills_utilization"] = _apply_skill_utilization(
                entry["skills"], skutil.get(ukey))
            _attach_lifetime(entry, lifetime.get(ukey), lskutil.get(ukey))
        agents.append(entry)
    note = None
    if not agents:
        note = ("no in-memory request for this session "
                "(cold/restored/ended); query while it is active")
    out = {"session_id": session, "agents": agents, "note": note}
    if scan_window:
        out["scan"] = scan_window
    return out
