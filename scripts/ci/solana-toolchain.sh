#!/usr/bin/env bash
# Installs and checks the pinned Solana SBF toolchain on a CI runner.
#
#   solana-toolchain.sh install <dir>
#     Downloads agave's release (it carries cargo-build-sbf) and the
#     platform-tools it compiles with, checks each against the pins in
#     solana-toolchain.env before unpacking, and unpacks agave into <dir> and
#     platform-tools and the Criterion library where cargo-build-sbf looks for
#     them (~/.cache/solana/<version>/platform-tools and
#     ~/.cache/solana/<criterion version>/criterion). cargo-build-sbf therefore
#     downloads neither itself; its own downloads are checked against nothing. Then installs the pinned host Rust for test.sh's cargo test runs.
#     On GitHub Actions it puts cargo-build-sbf on PATH and selects that Rust
#     for the steps that follow.
#
#   solana-toolchain.sh check
#     After a build: ~/.cache/solana still holds exactly the verified
#     platform-tools and Criterion, so nothing fetched or reinstalled an
#     unchecked toolchain (another --tools-version, --force-tools-install,
#     another Criterion).
#
# Linux x86_64 only, because those are the assets the pins describe. It
# refuses to run where ~/.cache/solana already exists: it cannot vouch for a
# toolchain it did not unpack, and it does not delete what it did not create.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=solana-toolchain.env
. "$here/solana-toolchain.env"

cache_root="$HOME/.cache/solana"
tools_dir="$cache_root/$PLATFORM_TOOLS_VERSION/platform-tools"
marker="$tools_dir/.merrymen-ci-verified-sha256"
criterion_dir="$cache_root/$CRITERION_VERSION/criterion"
criterion_marker="$criterion_dir/.merrymen-ci-verified-sha256"

die() { echo "::error::$*" >&2; exit 1; }

install() {
  [ ! -e "$cache_root" ] || die "$cache_root already exists; refusing to trust a toolchain this script did not verify"
  [ "$(uname -s)/$(uname -m)" = Linux/x86_64 ] || die "the pinned assets are for Linux/x86_64, not $(uname -s)/$(uname -m)"

  mkdir -p -- "$1"
  local dest
  dest="$(cd -- "$1" && pwd -P)"
  [ ! -e "$dest/solana-release" ] || die "$dest/solana-release already exists"
  local downloads="$dest/downloads"
  mkdir -p -- "$downloads"

  "$here/fetch-verified.sh" \
    "https://github.com/anza-xyz/agave/releases/download/$AGAVE_VERSION/$AGAVE_ASSET" \
    "$AGAVE_BYTES" "$AGAVE_SHA256" "$downloads/$AGAVE_ASSET"
  "$here/fetch-verified.sh" \
    "https://github.com/anza-xyz/platform-tools/releases/download/$PLATFORM_TOOLS_VERSION/$PLATFORM_TOOLS_ASSET" \
    "$PLATFORM_TOOLS_BYTES" "$PLATFORM_TOOLS_SHA256" "$downloads/$PLATFORM_TOOLS_ASSET"
  "$here/fetch-verified.sh" \
    "https://github.com/Snaipe/Criterion/releases/download/$CRITERION_VERSION/$CRITERION_ASSET" \
    "$CRITERION_BYTES" "$CRITERION_SHA256" "$downloads/$CRITERION_ASSET"

  tar -xjf "$downloads/$AGAVE_ASSET" -C "$dest"
  # The layout cargo-build-sbf itself unpacks to: llvm/, rust/, version.md.
  mkdir -p -- "$tools_dir"
  tar -xjf "$downloads/$PLATFORM_TOOLS_ASSET" -C "$tools_dir"
  printf '%s\n' "$PLATFORM_TOOLS_SHA256" > "$marker"
  # The layout cargo-build-sbf unpacks Criterion to: include/, lib/, share/
  # directly under criterion/, without the archive's top directory.
  mkdir -p -- "$criterion_dir"
  tar -xjf "$downloads/$CRITERION_ASSET" -C "$criterion_dir" --strip-components=1
  printf '%s\n' "$CRITERION_SHA256" > "$criterion_marker"
  rm -rf -- "$downloads"

  local bin="$dest/solana-release/bin"
  [ -x "$bin/cargo-build-sbf" ] || die "the agave release has no bin/cargo-build-sbf"
  # Expected shape: "solana-cargo-build-sbf 2.3.13", "platform-tools v1.48",
  # "rustc 1.84.1". The rustc line is read from the unpacked platform-tools.
  local version first
  version="$("$bin/cargo-build-sbf" --version)"
  printf '%s\n' "$version"
  first="${version%%$'\n'*}"
  [[ "$first " == *" ${AGAVE_VERSION#v} "* ]] || die "cargo-build-sbf is not ${AGAVE_VERSION#v}: $first"
  grep -Fxq "platform-tools $PLATFORM_TOOLS_VERSION" <<<"$version" || die "cargo-build-sbf does not default to platform-tools $PLATFORM_TOOLS_VERSION"
  grep -Fxq "rustc $PLATFORM_TOOLS_RUSTC" <<<"$version" || die "platform-tools $PLATFORM_TOOLS_VERSION does not report rustc $PLATFORM_TOOLS_RUSTC"

  rustup toolchain install "$HOST_RUST" --profile minimal --no-self-update
  rustup run "$HOST_RUST" rustc --version

  if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$bin" >> "$GITHUB_PATH"; fi
  if [ -n "${GITHUB_ENV:-}" ]; then printf 'RUSTUP_TOOLCHAIN=%s\n' "$HOST_RUST" >> "$GITHUB_ENV"; fi
}

check() {
  [ -f "$marker" ] && [ "$(cat -- "$marker")" = "$PLATFORM_TOOLS_SHA256" ] \
    || die "the verified platform-tools at $tools_dir were removed or reinstalled"
  [ -f "$criterion_marker" ] && [ "$(cat -- "$criterion_marker")" = "$CRITERION_SHA256" ] \
    || die "the verified Criterion at $criterion_dir was removed or reinstalled"
  local found expected
  found="$(cd -- "$cache_root" && find . -mindepth 1 -maxdepth 2 | LC_ALL=C sort | tr '\n' ' ')"
  expected="$(printf '%s\n' "./$PLATFORM_TOOLS_VERSION" "./$PLATFORM_TOOLS_VERSION/platform-tools" "./$CRITERION_VERSION" "./$CRITERION_VERSION/criterion" | LC_ALL=C sort -u | tr '\n' ' ')"
  [ "$found" = "$expected" ] \
    || die "$cache_root holds downloads this script did not verify: $found"
  echo "only the verified platform-tools $PLATFORM_TOOLS_VERSION and Criterion $CRITERION_VERSION are in $cache_root"
}

case "${1:-}" in
  install) [ $# -eq 2 ] || die "usage: solana-toolchain.sh install <dir>"; install "$2" ;;
  check) [ $# -eq 1 ] || die "usage: solana-toolchain.sh check"; check ;;
  *) die "usage: solana-toolchain.sh install <dir> | check" ;;
esac
