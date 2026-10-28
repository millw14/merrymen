#!/usr/bin/env bash
# Rebuilds the vault program from the committed source somewhere else, so CI
# can show the tested artifact depends only on the source and the pinned
# toolchain, not on where or by whom it was built.
#
#   solana-rebuild.sh <empty-work-dir>
#
# The source is `git archive HEAD contracts/solana`: tracked files only, so no
# target/ and nothing untracked. It is unpacked at a different absolute path and
# built with a fresh CARGO_HOME by the same cargo-build-sbf, platform-tools
# and arch. CARGO_HOME is a canonical path, because under a symlinked one rustc
# cannot shorten registry paths and the binary embeds them.
#
# Prints the built .so's path on stdout (build output goes to stderr). The
# caller compares its bytes with test.sh's artifact. If test.sh's own
# cargo-build-sbf flags ever differ from these, the two artifacts differ and
# that comparison fails, so a mismatch shows up rather than passing quietly.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=solana-toolchain.env
. "$here/solana-toolchain.env"

die() { echo "::error::$*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: solana-rebuild.sh <empty-work-dir>"
mkdir -p -- "$1"
work="$(cd -- "$1" && pwd -P)"
[ -z "$(ls -A -- "$work")" ] || die "$work is not empty"

repo="$(git -C "$here" rev-parse --show-toplevel)"
mkdir -- "$work/src" "$work/cargo-home"
git -C "$repo" archive --format=tar HEAD contracts/solana | tar -xf - -C "$work/src"
src="$work/src/contracts/solana"
[ -f "$src/programs/merrymen-vault/Cargo.toml" ] || die "HEAD has no contracts/solana/programs/merrymen-vault"

CARGO_HOME="$work/cargo-home" cargo-build-sbf \
  --tools-version "$PLATFORM_TOOLS_VERSION" --arch "$SBF_ARCH" \
  --manifest-path "$src/programs/merrymen-vault/Cargo.toml" \
  --sbf-out-dir "$src/target/deploy" -- --locked >&2

so="$src/target/deploy/merrymen_vault.so"
[ -s "$so" ] || die "the rebuild produced no $so"
printf '%s\n' "$so"
