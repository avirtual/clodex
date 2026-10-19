#!/bin/sh

_ch_dir=${CLODEX_HOOKS_DIR:-/etc/clodex/bootstrap}
_ch_marks=${CLODEX_SETUP_MARKS:-/var/lib/clodex-setup}
_ch_data=${CLODEX_HOOKS_DATA:-/data}
_ch_timeout=${CLODEX_SETUP_TIMEOUT:-600}
_ch_healthz=${CLODEX_HEALTHZ:-http://127.0.0.1:${CLODEX_WEB_PORT:-8080}/healthz}
_ch_setup_out=$_ch_data/.clodex-setup
_ch_start_out=$_ch_data/.clodex-start

_ch_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

_ch_root() { [ "$(id -u)" = 0 ]; }

_ch_as_root() {
  if _ch_root; then "$@"; else sudo -n "$@"; fi
}

_ch_alive() { kill -0 "$1" 2>/dev/null || [ -d "/proc/$1" ]; }

_ch_own() {
  _ch_root || return 0
  [ -n "$CLODEX_HOST_UID" ] && [ -n "$CLODEX_HOST_GID" ] || return 0
  for _ch_p in "$@"; do
    [ -e "$_ch_p" ] && chown -R "$CLODEX_HOST_UID:$CLODEX_HOST_GID" "$_ch_p" 2>/dev/null || true
  done
}

_ch_setup() {
  if [ ! -f "$_ch_dir/setup.sh" ]; then
    rm -f "$_ch_setup_out/failed" 2>/dev/null || true
    return 0
  fi
  _ch_sha=$(sha256sum "$_ch_dir/setup.sh" | cut -d' ' -f1)
  _ch_sha8=$(printf '%s' "$_ch_sha" | cut -c1-8)
  if [ -n "$_ch_sha" ] && [ -e "$_ch_marks/$_ch_sha" ]; then
    echo "clodex: setup $_ch_sha8: already applied" >&2
    return 0
  fi
  mkdir -p "$_ch_marks" "$_ch_setup_out" || return 0
  echo "clodex: setup $_ch_sha8: running (timeout ${_ch_timeout}s)" >&2
  _ch_flag="$_ch_setup_out/.timed-out"
  rm -f "$_ch_flag"
  if _ch_root; then
    setsid sh "$_ch_dir/setup.sh" </dev/null >"$_ch_setup_out/last.log" 2>&1 &
  else
    setsid sudo -n sh "$_ch_dir/setup.sh" </dev/null >"$_ch_setup_out/last.log" 2>&1 &
  fi
  _ch_pid=$!
  (
    _ch_n=0
    while [ "$_ch_n" -lt "$_ch_timeout" ]; do
      sleep 1
      _ch_alive "$_ch_pid" || exit 0
      _ch_n=$((_ch_n + 1))
    done
    : > "$_ch_flag"
    _ch_as_root kill -s TERM -- "-$_ch_pid" 2>/dev/null || _ch_as_root kill -s TERM -- "$_ch_pid" 2>/dev/null
    _ch_n=0
    while [ "$_ch_n" -lt 10 ]; do
      sleep 1
      _ch_alive "$_ch_pid" || exit 0
      _ch_n=$((_ch_n + 1))
    done
    _ch_as_root kill -s KILL -- "-$_ch_pid" 2>/dev/null || _ch_as_root kill -s KILL -- "$_ch_pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  _ch_watchdog=$!
  if wait "$_ch_pid"; then _ch_rc=0; else _ch_rc=$?; fi
  kill -s TERM -- "$_ch_watchdog" 2>/dev/null || true
  wait "$_ch_watchdog" 2>/dev/null || true
  _ch_timed=false
  if [ -e "$_ch_flag" ]; then _ch_timed=true; _ch_rc=124; rm -f "$_ch_flag"; fi
  _ch_size=$(wc -c < "$_ch_setup_out/last.log" | tr -d ' ')
  if [ "${_ch_size:-0}" -gt 1048576 ]; then
    tail -c 1048576 "$_ch_setup_out/last.log" > "$_ch_setup_out/last.log.tmp" && mv "$_ch_setup_out/last.log.tmp" "$_ch_setup_out/last.log" || true
  fi
  _ch_json=$(printf '{"sha":"%s","exit":%s,"at":"%s","timedOut":%s}' "$_ch_sha" "$_ch_rc" "$(_ch_now)" "$_ch_timed")
  printf '%s\n' "$_ch_json" > "$_ch_setup_out/last.json"
  if [ "$_ch_rc" = 0 ]; then
    touch "$_ch_marks/$_ch_sha"
    rm -f "$_ch_setup_out/failed"
    echo "clodex: setup $_ch_sha8: ok" >&2
  else
    printf '%s\n' "$_ch_json" > "$_ch_setup_out/failed"
    CLODEX_SETUP_FAILED=1
    export CLODEX_SETUP_FAILED
    echo "clodex: setup $_ch_sha8: FAILED exit $_ch_rc — booting degraded, see $_ch_setup_out/last.log" >&2
  fi
  _ch_own "$_ch_setup_out"
}

_ch_start_watch() {
  _ch_n=0
  until wget -qO- --timeout=2 "$_ch_healthz" >/dev/null 2>&1; do
    _ch_n=$((_ch_n + 2))
    if [ "$_ch_n" -ge 120 ]; then
      echo "clodex: start hook: $_ch_healthz did not answer in 120s; launching anyway" >&2
      break
    fi
    sleep 2
  done
  if _ch_root && [ -n "$CLODEX_HOST_UID" ] && [ -n "$CLODEX_HOST_GID" ]; then
    setsid setpriv --reuid="$CLODEX_HOST_UID" --regid="$CLODEX_HOST_GID" --init-groups sh "$_ch_dir/start.sh" </dev/null >"$_ch_start_out/last.log" 2>&1 &
  else
    setsid sh "$_ch_dir/start.sh" </dev/null >"$_ch_start_out/last.log" 2>&1 &
  fi
  _ch_spid=$!
  _ch_at=$(_ch_now)
  printf '{"pid":%s,"at":"%s","exit":null}\n' "$_ch_spid" "$_ch_at" > "$_ch_start_out/last.json"
  _ch_own "$_ch_start_out"
  if wait "$_ch_spid"; then _ch_rc=0; else _ch_rc=$?; fi
  printf '{"pid":%s,"at":"%s","exit":%s}\n' "$_ch_spid" "$_ch_at" "$_ch_rc" > "$_ch_start_out/last.json"
  _ch_own "$_ch_start_out"
}

_ch_start() {
  [ -f "$_ch_dir/start.sh" ] || return 0
  if [ "${CLODEX_SETUP_FAILED:-0}" = 1 ]; then
    echo "clodex: start hook skipped: setup failed" >&2
    return 0
  fi
  mkdir -p "$_ch_start_out" || return 0
  _ch_own "$_ch_start_out"
  ( _ch_start_watch </dev/null >/dev/null 2>"$_ch_start_out/watch.log" & ) || true
}

if [ "${CLODEX_NO_HOOKS:-0}" = 1 ]; then
  echo "clodex: CLODEX_NO_HOOKS=1 — bootstrap setup and start hooks skipped" >&2
  rm -f "$_ch_setup_out/failed" 2>/dev/null || true
else
  _ch_setup
  _ch_start
fi
