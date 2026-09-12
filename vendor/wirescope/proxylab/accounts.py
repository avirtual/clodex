"""Credential stores: which CLI config dir holds which account's OAuth token.

WHY THIS EXISTS (2026-09-12). Clodex grew the ability to run a seat under a
different `CLAUDE_CONFIG_DIR` (a second subscription), and keep-warm died on
every seat it moved. Two defects, one root: everything that touched the CLI's
credential store assumed there was exactly one, at `~/.claude`.

  * Consumer side (clodex's hold port): the ping re-read the bearer from the
    default store, so an opsguru seat was pinged with the gmail account's
    token. 30 pings over 14 hours, every one a 429 on the gmail org's quota
    wall (the response carried the OTHER account's organization id), zero
    warmed. Fixed on clodex's side by reading the seat's own store.
  * Proxy side (this package): the proactive refresh (hold.py) read `expiresAt`
    off the default store only, so a non-default account's token lapses on an
    idle night with nobody to refresh it; and the bootstrap turn spawned
    `claude` under the proxy's own env, i.e. the default store, so it could
    only ever donate the default account's headers — a restored stash for any
    other account stayed `awaiting_auth` forever.

The proxy's own replay path was never wrong: `pinger._ACCOUNT_AUTH` is keyed
by the `account_uuid` the CLI puts in `metadata.user_id`, so a replay always
carries the headers that very account sent. The gap was in what the proxy does
when it has to go to the CLI, which is what this module locates.

WHAT IT KNOWS. A registry of config dirs, each resolving to one account:

  * `config_dir` — the seat's `CLAUDE_CONFIG_DIR` (None = the default store).
  * `account_uuid` / `email` / `org` — read from `<dir>/.claude.json`
    `oauthAccount` (never secret; the CLI writes it on login).
  * `keychain_service` — the macOS keychain item the CLI writes the token to.
    Read off the 2.1.269 binary, not inferred: `Claude Code-credentials` for
    the default store, `Claude Code-credentials-<sha256(dir)[:8]>` when
    CLAUDE_CONFIG_DIR is set (hash over the path string as the CLI sees it).
    Verified against this box's keychain: `~/.claude` → 2358b87d (the CLI
    also writes that item when CLAUDE_CONFIG_DIR points at the default path),
    `~/.clodex/accounts/opsguru` → 6f0dcb4b.
  * Plaintext fallback: `<dir>/.credentials.json` (Linux, or a CLI that
    could not use the keychain) — same order the CLI reads them in.

What it NEVER holds: the token. `read_expiry()` returns the `expiresAt`
epoch and drops the rest on the floor, same discipline as hold.py's reader.

HOW IT IS FED. `POST /_accounts?config_dir=<abs path>` from the consumer that
launches seats (it is the one thing on the box that knows which dir a seat
runs under). The default store is always present and needs no registration.
Absence of a registration degrades to today's behaviour exactly: default
store only. Persisted owner-scoped (a restart must not forget which
subscriptions to keep alive); `DELETE` unregisters.

Registration is by DIRECTORY, not by account_uuid, on purpose: the dir is what
the consumer has at spawn time, and the account behind it can change (a
re-login) without the consumer noticing — the registry re-reads `.claude.json`
on every readout so the mapping follows the login.
"""
import hashlib
import json
import os
import subprocess
import threading
import time

from proxylab import store as store_mod

_KEYCHAIN_BASE = "Claude Code-credentials"
_CRED_FILE = ".credentials.json"
_DEFAULT_DIR = os.path.join(os.path.expanduser("~"), ".claude")

_REGISTRY = {}       # config_dir (abs, as registered) -> {"added_at": ts}
_LOCK = threading.Lock()

store_mod.register_schema(
    "CREATE TABLE IF NOT EXISTS credential_store ("
    "owner TEXT NOT NULL, config_dir TEXT NOT NULL, added_at REAL NOT NULL, "
    "PRIMARY KEY (owner, config_dir))")


def keychain_service(config_dir):
    """The keychain item the CLI writes this store's OAuth token to. The
    suffix rule is the CLI's (`iH()` in the 2.1.269 binary): no suffix when
    CLAUDE_CONFIG_DIR is unset, else `-` + the first 8 hex of sha256 over the
    dir string. The CLI hashes the env value as given, so a registered dir is
    hashed as registered (callers normalize before registering)."""
    if config_dir is None:
        return _KEYCHAIN_BASE
    h = hashlib.sha256(config_dir.encode("utf-8")).hexdigest()[:8]
    return f"{_KEYCHAIN_BASE}-{h}"


def normalize_dir(config_dir):
    """Absolute, trailing-slash-free form — the one the consumer passes in the
    seat's env and therefore the one the CLI hashes. Returns None for the
    default store (unset, empty, or the literal `~/.claude`)."""
    if config_dir is None:
        return None
    d = str(config_dir).strip()
    if not d:
        return None
    d = os.path.expanduser(d)
    if not os.path.isabs(d):
        raise ValueError("config_dir must be an absolute path")
    d = d.rstrip("/") or "/"
    if d == _DEFAULT_DIR:
        return None
    return d


def _dir_path(config_dir):
    return _DEFAULT_DIR if config_dir is None else config_dir


def account_of(config_dir):
    """(account_uuid, email, org_uuid) from `<dir>/.claude.json` oauthAccount,
    or (None, None, None). Not secret; the CLI writes it at login."""
    try:
        with open(os.path.join(_dir_path(config_dir), ".claude.json"),
                  encoding="utf-8") as f:
            o = (json.load(f) or {}).get("oauthAccount") or {}
        return o.get("accountUuid"), o.get("emailAddress"), o.get("organizationUuid")
    except Exception:
        return None, None, None


def read_expiry(config_dir, timeout=5):
    """`expiresAt` (epoch SECONDS) of this store's OAuth access token, or None
    when the store has no oauth block. Plaintext file first, then the store's
    keychain item — the CLI's own order. Raises RuntimeError when neither is
    readable (a locked keychain blocks on a GUI dialog, hence the timeout).
    Only the expiry leaves this function."""
    raw = None
    path = os.path.join(_dir_path(config_dir), _CRED_FILE)
    try:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
    except Exception:
        raw = None
    if raw is None:
        try:
            out = subprocess.run(
                ["/usr/bin/security", "find-generic-password",
                 "-s", keychain_service(config_dir), "-w"],
                capture_output=True, text=True, timeout=timeout, check=True)
            raw = json.loads(out.stdout)
        except Exception as e:
            raise RuntimeError(
                f"credential store unreadable: {type(e).__name__}") from e
    exp = ((raw or {}).get("claudeAiOauth") or {}).get("expiresAt")
    if not isinstance(exp, (int, float)):
        return None
    return exp / 1000.0    # the CLI writes epoch milliseconds


def spawn_env(config_dir, base=None):
    """Env for a `claude` the proxy spawns so it runs under THIS store: the
    default store must NOT inherit a CLAUDE_CONFIG_DIR the proxy's own process
    happened to be launched with (a managed proxy can be spawned from a seat's
    env), or the bootstrap turn donates the wrong account's headers."""
    env = dict(os.environ if base is None else base)
    env.pop("CLAUDE_CONFIG_DIR", None)
    if config_dir is not None:
        env["CLAUDE_CONFIG_DIR"] = config_dir
    return env


# ---- registry -----------------------------------------------------------------

def stores():
    """Every known store, default first, each `{config_dir, default, account_uuid,
    email, org, keychain_service}`. Account fields re-read from disk on every
    call (cheap: one small JSON) so a re-login is reflected without a
    re-registration."""
    with _LOCK:
        dirs = sorted(_REGISTRY, key=lambda d: _REGISTRY[d]["added_at"])
    out = []
    for d in [None] + dirs:
        acct, email, org = account_of(d)
        out.append({"config_dir": d, "default": d is None,
                    "account_uuid": acct, "email": email, "org": org,
                    "keychain_service": keychain_service(d)})
    return out


def store_for_account(account_uuid):
    """The store whose `.claude.json` names this account, else None (an
    unregistered account falls back to the default store — which is exactly
    today's behaviour, so nothing regresses for a single-account box)."""
    if not account_uuid:
        return None
    for s in stores():
        if s["account_uuid"] == account_uuid:
            return s["config_dir"]
    return None


def label_for_account(account_uuid):
    """Display-grade: the email behind an account_uuid when a store names it."""
    if not account_uuid:
        return None
    for s in stores():
        if s["account_uuid"] == account_uuid:
            return s["email"]
    return None


def register(config_dir, now=None):
    """Add a store. Validates: absolute path, an existing directory. The default
    store registers as a no-op (`registered:false, default:true`). Returns the
    store's readout."""
    d = normalize_dir(config_dir)
    if d is None:
        return {"ok": True, "registered": False, "default": True,
                **_one(None)}
    if not os.path.isdir(d):
        raise ValueError(f"config_dir is not a directory: {d}")
    now = now or time.time()
    with _LOCK:
        fresh = d not in _REGISTRY
        _REGISTRY.setdefault(d, {"added_at": now})
    if fresh:
        _persist(d, now)
    return {"ok": True, "registered": fresh, **_one(d)}


def unregister(config_dir):
    d = normalize_dir(config_dir)
    if d is None:
        return {"ok": True, "removed": False, "default": True,
                "reason": "the default store is always present"}
    with _LOCK:
        removed = _REGISTRY.pop(d, None) is not None
    if removed:
        _delete(d)
    return {"ok": True, "removed": removed, "config_dir": d}


def _one(config_dir):
    for s in stores():
        if s["config_dir"] == config_dir:
            return s
    acct, email, org = account_of(config_dir)
    return {"config_dir": config_dir, "default": config_dir is None,
            "account_uuid": acct, "email": email, "org": org,
            "keychain_service": keychain_service(config_dir)}


def _persist(config_dir, added_at):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute(
                "INSERT OR IGNORE INTO credential_store(owner, config_dir, added_at) "
                "VALUES(?,?,?)", (store_mod.OWNER, config_dir, added_at))
            con.commit()
    except Exception as e:
        print(f"[accounts] persist failed for {config_dir}: {e}", flush=True)


def _delete(config_dir):
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            con.execute("DELETE FROM credential_store WHERE owner=? AND config_dir=?",
                        (store_mod.OWNER, config_dir))
            con.commit()
    except Exception as e:
        print(f"[accounts] delete failed for {config_dir}: {e}", flush=True)


def load():
    """Reload registered stores at boot (restore.py). A dir that vanished is
    dropped rather than restored — a store that cannot be read cannot be
    refreshed, and keeping it would only add a permanent read_error."""
    try:
        con = store_mod.db()
        with store_mod.LOCK:
            rows = con.execute(
                "SELECT config_dir, added_at FROM credential_store WHERE owner=?",
                (store_mod.OWNER,)).fetchall()
    except Exception as e:
        print(f"[accounts] load failed: {e}", flush=True)
        return 0
    n = 0
    for d, added in rows:
        if not os.path.isdir(d):
            _delete(d)
            continue
        with _LOCK:
            _REGISTRY.setdefault(d, {"added_at": added})
        n += 1
    if n:
        print(f"[accounts] restored {n} credential store(s) beyond the default",
              flush=True)
    return n


def _reset_for_tests():
    with _LOCK:
        _REGISTRY.clear()
