#!/bin/sh
set -e

if [ "$(id -u)" != 0 ] || [ -z "$CLODEX_HOST_UID" ] || [ -z "$CLODEX_HOST_GID" ]; then
  exec "$@"
fi
case "$CLODEX_HOST_UID$CLODEX_HOST_GID" in
  *[!0-9]*) exec "$@" ;;
esac

IMAGE_UID=$(stat -c %u /app)

if [ "$(getent group clodex | cut -d: -f3)" != "$CLODEX_HOST_GID" ]; then
  groupmod -o -g "$CLODEX_HOST_GID" clodex
fi
if [ "$(id -u clodex)" != "$CLODEX_HOST_UID" ] || [ "$(id -g clodex)" != "$CLODEX_HOST_GID" ]; then
  sed -i "s/^clodex:\([^:]*\):[0-9]*:[0-9]*:/clodex:\1:$CLODEX_HOST_UID:$CLODEX_HOST_GID:/" /etc/passwd
fi

IMAGE_DEV=$(stat -c %d /app)
for p in /data /home/clodex /home/clodex/work /home/clodex/.[!.]* /home/clodex/*; do
  [ -e "$p" ] || continue
  if [ "$(stat -c %d "$p")" != "$IMAGE_DEV" ]; then
    [ "$p" = /home/clodex/work ] && [ "$CLODEX_WORK_VOLUME" = 1 ] || continue
  fi
  owner=$(stat -c %u "$p")
  if [ "$owner" = "$IMAGE_UID" ] && [ "$owner" != "$CLODEX_HOST_UID" ]; then
    if [ "$p" = /home/clodex/work ] && [ "$CLODEX_WORK_VOLUME" = 1 ]; then
      chown -R "$CLODEX_HOST_UID:$CLODEX_HOST_GID" "$p"
    else
      chown -h "$CLODEX_HOST_UID:$CLODEX_HOST_GID" "$p"
    fi
  fi
done

exec setpriv --reuid="$CLODEX_HOST_UID" --regid="$CLODEX_HOST_GID" --init-groups "$@"
