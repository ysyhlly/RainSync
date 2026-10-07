#!/usr/bin/env bash
set -euo pipefail

cleanup_ci_apt() {
  # Only this invocation's mktemp leaf is eligible for recursive removal.
  if [[ ${ci_apt_dir:-} =~ ^/tmp/rainsync-apt\.[[:alnum:]]{6}$ ]]; then
    sudo rm -rf -- "$ci_apt_dir"
    ci_apt_dir=''
  fi
}

configure_ci_apt() {
  local ID VERSION_CODENAME UBUNTU_CODENAME codename architecture keyring
  # The runner's trusted OS metadata determines the suite; never mix releases.
  source /etc/os-release
  codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
  architecture=$(dpkg --print-architecture)
  if [[ ${ID:-} != ubuntu || ! $codename =~ ^[a-z][a-z0-9]*$ || $architecture != amd64 ]]; then
    printf 'Media validation prerequisites require an Ubuntu amd64 runner.\n' >&2
    return 1
  fi
  keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
  test -r "$keyring"
  # Runner home/temp ancestors may deny traversal to _apt. This directory holds
  # only public package indexes/archives; validation artifacts stay in RUNNER_TEMP.
  ci_apt_dir=$(mktemp -d /tmp/rainsync-apt.XXXXXX)
  # APT's _apt sandbox must be able to read sources and reach partial downloads.
  chmod 755 "$ci_apt_dir"
  mkdir -p "$ci_apt_dir/sourceparts" "$ci_apt_dir/lists/partial" "$ci_apt_dir/cache/archives/partial"
  cat > "$ci_apt_dir/sources.list" <<EOF
deb [arch=$architecture signed-by=$keyring] https://archive.ubuntu.com/ubuntu $codename main universe
deb [arch=$architecture signed-by=$keyring] https://archive.ubuntu.com/ubuntu $codename-updates main universe
deb [arch=$architecture signed-by=$keyring] https://security.ubuntu.com/ubuntu $codename-security main universe
EOF
  chmod 644 "$ci_apt_dir/sources.list"
  chmod 755 "$ci_apt_dir/sourceparts" "$ci_apt_dir/lists" "$ci_apt_dir/cache" "$ci_apt_dir/cache/archives"
  ci_apt_options=(
    -o "Dir::Etc::sourcelist=$ci_apt_dir/sources.list"
    -o "Dir::Etc::sourceparts=$ci_apt_dir/sourceparts"
    -o "Dir::State::lists=$ci_apt_dir/lists"
    -o "Dir::Cache=$ci_apt_dir/cache"
    -o "Dir::Cache::archives=$ci_apt_dir/cache/archives"
    -o "Dir::Cache::pkgcache=$ci_apt_dir/cache/pkgcache.bin"
    -o "Dir::Cache::srcpkgcache=$ci_apt_dir/cache/srcpkgcache.bin"
    -o Acquire::Retries=2
    -o Acquire::http::Timeout=30
    -o Acquire::https::Timeout=30
  )
}

prepare_ci_apt_sandbox() {
  local partial probe
  for partial in "$ci_apt_dir/lists/partial" "$ci_apt_dir/cache/archives/partial"; do
    sudo chown _apt:root "$partial"
    sudo chmod 700 "$partial"
    probe=$(sudo -u _apt -- mktemp "$partial/.sandbox-write.XXXXXX")
    sudo -u _apt -- rm -- "$probe"
  done
}

verify_media_prerequisites() {
  local packages=()
  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then packages+=(ffmpeg); fi
  if ! command -v pg_config >/dev/null || ! test -x "$(pg_config --bindir)/initdb"; then packages+=(postgresql); fi
  if ((${#packages[@]})); then
    configure_ci_apt
    prepare_ci_apt_sandbox
    sudo timeout --kill-after=15s 180s apt-get "${ci_apt_options[@]}" update
    sudo timeout --kill-after=15s 900s apt-get "${ci_apt_options[@]}" install -y --no-install-recommends "${packages[@]}"
  fi
  ffmpeg -version
  ffprobe -version
  test -x "$(pg_config --bindir)/initdb"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  trap cleanup_ci_apt EXIT
  verify_media_prerequisites
fi
