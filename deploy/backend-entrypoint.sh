#!/bin/sh
# Release startup cannot prove persisted redirect identities are absent. Check
# both co-delivered readers offline before exposing any application settings.
set -eu
if [ "$#" -eq 0 ]; then set -- rainsync-server; fi
case "$1" in
  rainsync-server|*/rainsync-server|rainsync-media-worker|*/rainsync-media-worker)
    binary=$(command -v "$1") || exit 78
    case "$binary" in /*) ;; *) binary="$(pwd)/$binary" ;; esac
    bin_dir=$(dirname "$binary")
    directory=$(mktemp -d)
    trap 'rmdir "$directory"' EXIT HUP INT TERM
    probe() {
      target=$1 flag=$2 expected=$3
      if ! actual=$(cd "$directory" && env -i PATH="${PATH:-/usr/bin:/bin}" LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" timeout --kill-after=1s 5s "$target" "$flag" 2>/dev/null); then
        echo 'Unsafe Server cutover: required offline contract probe failed' >&2
        exit 78
      fi
      if [ "$actual" != "$expected" ]; then
        echo 'Unsafe Server cutover: incompatible reader contract' >&2
        exit 78
      fi
    }
    probe "$bin_dir/rainsync-server" --media-authorization-contract '{"schema_version":1,"contract":"media-login-binding-v1","migration":41,"legacy":"fixed-expiry","caller":"exact-login"}'
    probe "$bin_dir/rainsync-server" --source-access-contract '{"schema_version":1,"contract":"controlled-media-redirects-v1","identity":"final-target-sha256-v1","credential_origin":"configured-origin","methods":["GET","HEAD"],"default":"no-follow","role":"server"}'
    probe "$bin_dir/rainsync-media-worker" --source-access-contract '{"schema_version":1,"contract":"controlled-media-redirects-v1","identity":"final-target-sha256-v1","credential_origin":"configured-origin","methods":["GET","HEAD"],"default":"no-follow","role":"worker"}'
    rmdir "$directory"
    trap - EXIT HUP INT TERM
    ;;
  rainsync-nas-agent|*/rainsync-nas-agent) ;;
  *) echo 'Unsupported backend executable' >&2; exit 64 ;;
esac
exec "$@"
