#!/bin/sh
set -e

# Started as root: make the data folder (often a fresh bind mount owned by root) writable,
# then continue as the unprivileged "node" user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${CACHE_DIR:-/data/cache}"
  chown node:node /data "${CACHE_DIR:-/data/cache}" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
fi

if [ "${YTDLP_AUTO_UPDATE:-1}" = "1" ]; then
  echo "Updating yt-dlp..."
  "$YTDLP_VENV/bin/pip" install --no-cache-dir -q -U "yt-dlp[default,curl-cffi]" || echo "yt-dlp update failed, using the installed version"
fi
echo "yt-dlp $(yt-dlp --version)"
exec "$@"
