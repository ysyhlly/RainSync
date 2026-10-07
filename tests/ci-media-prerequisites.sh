#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$repo_dir/scripts/ci-media-prerequisites.sh"
test_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/rainsync-apt-contract.XXXXXX")
trap 'rm -rf -- "$test_dir"' EXIT
RUNNER_TEMP=$test_dir

default_config=$(apt-config shell SOURCE Dir::Etc::sourcelist/f PARTS Dir::Etc::sourceparts/d LISTS Dir::State::lists/d ARCHIVES Dir::Cache::archives/d STATUS Dir::State::status/f MAIN Dir::Etc::main/f CONFIG_PARTS Dir::Etc::parts/d)
security_config=$(apt-config shell PROXY Acquire::http::Proxy HTTPS_PROXY Acquire::https::Proxy VERIFY_PEER Acquire::https::Verify-Peer VERIFY_HOST Acquire::https::Verify-Host INSECURE Acquire::AllowInsecureRepositories WEAK Acquire::AllowWeakRepositories UNAUTHENTICATED APT::Get::AllowUnauthenticated)
configure_ci_apt
eval "$(apt-config "${ci_apt_options[@]}" shell SOURCE Dir::Etc::sourcelist/f PARTS Dir::Etc::sourceparts/d LISTS Dir::State::lists/d ARCHIVES Dir::Cache::archives/d PKGCACHE Dir::Cache::pkgcache/f SRCPKGCACHE Dir::Cache::srcpkgcache/f STATUS Dir::State::status/f MAIN Dir::Etc::main/f CONFIG_PARTS Dir::Etc::parts/d)"
test "$SOURCE" = "$ci_apt_dir/sources.list"
test "$PARTS" = "$ci_apt_dir/sourceparts/"
test "$LISTS" = "$ci_apt_dir/lists/"
test "$ARCHIVES" = "$ci_apt_dir/cache/archives/"
test "$PKGCACHE" = "$ci_apt_dir/cache/pkgcache.bin"
test "$SRCPKGCACHE" = "$ci_apt_dir/cache/srcpkgcache.bin"
test "$STATUS" = /var/lib/dpkg/status
test "$MAIN" = /etc/apt/apt.conf
test "$CONFIG_PARTS" = /etc/apt/apt.conf.d/
test "$security_config" = "$(apt-config "${ci_apt_options[@]}" shell PROXY Acquire::http::Proxy HTTPS_PROXY Acquire::https::Proxy VERIFY_PEER Acquire::https::Verify-Peer VERIFY_HOST Acquire::https::Verify-Host INSECURE Acquire::AllowInsecureRepositories WEAK Acquire::AllowWeakRepositories UNAUTHENTICATED APT::Get::AllowUnauthenticated)"

# Ask APT itself to resolve the sources without fetching or installing anything.
# Default Azure/file/third-party sources would appear here if isolation failed.
apt-get "${ci_apt_options[@]}" --print-uris update > "$test_dir/uris.txt"
releases=0
while read -r uri _; do
  uri=${uri#\'}
  uri=${uri%\'}
  case "$uri" in
    https://archive.ubuntu.com/ubuntu/dists/*|https://security.ubuntu.com/ubuntu/dists/*) ;;
    *) printf 'APT resolved an unexpected prerequisite source.\n' >&2; exit 1 ;;
  esac
  if [[ $uri == */InRelease ]]; then ((releases+=1)); fi
done < "$test_dir/uris.txt"
test "$releases" = 3
test "$default_config" = "$(apt-config shell SOURCE Dir::Etc::sourcelist/f PARTS Dir::Etc::sourceparts/d LISTS Dir::State::lists/d ARCHIVES Dir::Cache::archives/d STATUS Dir::State::status/f MAIN Dir::Etc::main/f CONFIG_PARTS Dir::Etc::parts/d)"
printf 'PASS: APT resolves only scoped official HTTPS sources; global configuration and dpkg status remain unchanged.\n'
