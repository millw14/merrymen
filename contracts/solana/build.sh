#!/usr/bin/env bash
# Pinned, reproducible SBF build of the custody program (audit GAP4-2).
#
#   build.sh                 check the toolchain, build target/deploy/merrymen_vault.so and
#                            compare it with this host's build manifest
#   build.sh --record        build again from a copy of the source in a clean directory,
#                            require identical bytes, then write this host's manifest
#   build.sh --source-digest print the digest of the reviewed source inputs (no toolchain)
#
# Manifests live in build-manifests/<uname -s>-<uname -m>.json: platform-tools embeds its
# own build paths, so a macOS and a Linux build of the same source differ. Release
# artifacts come from the pinned Linux CI build. Extra arguments after the mode go to
# cargo-build-sbf, for example --offline. CARGO_BUILD_SBF overrides the binary.
set -euo pipefail

AGAVE_VERSION="2.3.13"
PLATFORM_TOOLS_VERSION="v1.48"
SBF_ARCH="v0"
# rustc inside platform-tools v1.48. Its version.md names the anza-xyz/rust source commit,
# which is the same on every host (rustc -vV itself reports "commit-hash: unknown").
RUSTC_VERSION="rustc 1.84.1-dev"
LLVM_VERSION="19.1.7"
RUST_SOURCE_COMMIT="293a1b6c60a0b8d92593843c373539e21e3ba087"

# Physical paths: rustc runs in the canonical directory, and cargo-build-sbf's
# -Zremap-cwd-prefix only strips paths that match it. A symlinked CARGO_HOME (macOS /tmp)
# leaves absolute registry paths in the binary and changes its hash.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
host="$(uname -s)-$(uname -m)"
manifest="$script_dir/build-manifests/$host.json"
program_manifest="$script_dir/programs/merrymen-vault/Cargo.toml"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# The reviewed inputs to the artifact: workspace and program manifests, the lockfile,
# every program source file and this recipe. Lines are "<sha256>  <path>", sorted.
source_files() {
  (
    cd "$script_dir"
    {
      printf '%s\n' Cargo.toml Cargo.lock build.sh programs/merrymen-vault/Cargo.toml
      find programs/merrymen-vault/src -type f -name '*.rs'
    } | LC_ALL=C sort
  )
}
source_digest() {
  local files
  files="$(source_files)"
  # shellcheck disable=SC2086
  (cd "$script_dir" && sha256 $files) | sha256 | cut -d' ' -f1
}
manifest_field() {
  # Reads "key": "value" or "key": number from the manifest written below.
  [ -f "$manifest" ] || return 0
  sed -n "s/^ *\"$1\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$manifest" | head -n 1
}

mode="build"
case "${1:-}" in
  --record) mode="record"; shift ;;
  --source-digest) source_digest; exit 0 ;;
  -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
esac

# cargo never runs LTO on a cdylib/rlib pair, so the setting would silently do nothing (GAP4-5).
if grep -Eq '^[[:space:]]*lto[[:space:]]*=' "$script_dir/Cargo.toml" "$program_manifest"; then
  echo "error: remove the lto setting; crate-type [\"cdylib\", \"lib\"] cannot use LTO" >&2
  exit 1
fi
# Ambient compiler flags would change the artifact without changing the reviewed source.
for name in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS CARGO_BUILD_TARGET_DIR; do
  if [ -n "${!name:-}" ]; then
    echo "error: unset $name for a reproducible build" >&2
    exit 1
  fi
done
if env | grep -Eq '^CARGO_(PROFILE|TARGET)_[A-Z0-9_]+='; then
  echo "error: unset CARGO_PROFILE_* and CARGO_TARGET_* overrides for a reproducible build" >&2
  exit 1
fi
unset CARGO_TARGET_DIR

mkdir -p "${CARGO_HOME:-$HOME/.cargo}"
CARGO_HOME="$(cd -- "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
export CARGO_HOME

# Cargo reads .cargo/config.toml (and the legacy .cargo/config) in the directory it runs in
# and in every parent, and cargo-build-sbf runs cargo in the program's directory. A
# [profile.release] or [build] table in any of them (overflow-checks, opt-level, rustflags)
# changes the artifact without changing the reviewed source, which the source digest does
# not cover. Only $CARGO_HOME's own config.toml may apply; CI's is empty.
refuse_cargo_config_above() {
  local dir="$1" found
  while :; do
    for found in "$dir/.cargo/config.toml" "$dir/.cargo/config"; do
      if { [ -e "$found" ] || [ -L "$found" ]; } && [ "$(cd -- "$dir/.cargo" && pwd -P)" != "$CARGO_HOME" ]; then
        echo "error: remove $found for a reproducible build: cargo applies it to the vault build, and the source digest does not cover it" >&2
        exit 1
      fi
    done
    [ "$dir" != / ] || return 0
    dir="$(dirname -- "$dir")"
  done
}
refuse_cargo_config_above "$script_dir/programs/merrymen-vault"
refuse_cargo_config_above "$(pwd -P)"

build_sbf="${CARGO_BUILD_SBF:-cargo-build-sbf}"
if ! command -v "$build_sbf" >/dev/null 2>&1; then
  echo "error: cargo-build-sbf $AGAVE_VERSION not found (install agave $AGAVE_VERSION and put its bin on PATH)" >&2
  exit 1
fi
reported="$("$build_sbf" --version 2>&1 | head -n 1)"
if ! printf '%s\n' "$reported" | grep -Eq "(^| )$(printf '%s' "$AGAVE_VERSION" | sed 's/\./\\./g')( |$)"; then
  echo "error: need cargo-build-sbf $AGAVE_VERSION, found: $reported" >&2
  exit 1
fi

# Builds the program at $1 into target dir $2 and deploy dir $3 with the pinned recipe.
build_into() {
  CARGO_TARGET_DIR="$2" "$build_sbf" \
    --tools-version "$PLATFORM_TOOLS_VERSION" \
    --arch "$SBF_ARCH" \
    --manifest-path "$1" \
    --sbf-out-dir "$3" \
    ${extra_args[@]+"${extra_args[@]}"} \
    -- --locked
}
extra_args=("$@")

build_into "$program_manifest" "$script_dir/target" "$script_dir/target/deploy"
artifact="$script_dir/target/deploy/merrymen_vault.so"

# cargo-build-sbf links the "solana" rustup toolchain to the platform-tools it used.
rustc_info="$(rustc +solana -vV)"
rustc_line="$(printf '%s\n' "$rustc_info" | head -n 1)"
llvm_version="$(printf '%s\n' "$rustc_info" | sed -n 's/^LLVM version: //p')"
tools_dir="$(cd -- "$(rustc +solana --print sysroot)/.." && pwd -P)"
rust_commit="$(sed -n 's|^\([0-9a-f]\{40\}\)  https://github.com/anza-xyz/rust.git$|\1|p' "$tools_dir/version.md" 2>/dev/null || true)"
if [ "${rustc_line%% (*}" != "$RUSTC_VERSION" ] || [ "$llvm_version" != "$LLVM_VERSION" ] ||
  [ "$rust_commit" != "$RUST_SOURCE_COMMIT" ]; then
  echo "error: need platform-tools $PLATFORM_TOOLS_VERSION ($RUSTC_VERSION, LLVM $LLVM_VERSION, rust $RUST_SOURCE_COMMIT)," >&2
  echo "       found $rustc_line, LLVM $llvm_version, rust ${rust_commit:-unknown} in $tools_dir" >&2
  exit 1
fi

digest="$(source_digest)"
artifact_sha="$(sha256 "$artifact" | cut -d' ' -f1)"
artifact_bytes="$(wc -c < "$artifact" | tr -d ' ')"
declared_id="$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");$/\1/p' "$script_dir/programs/merrymen-vault/src/lib.rs")"
echo "merrymen_vault.so  sha256 $artifact_sha  bytes $artifact_bytes  program $declared_id"
echo "source digest $digest"

if [ "$mode" = "build" ]; then
  if [ "$(manifest_field digest)" != "$digest" ]; then
    echo "note: no $host build manifest for this source; run build.sh --record after review" >&2
  elif [ "$(manifest_field sha256)" != "$artifact_sha" ]; then
    echo "error: same source, different artifact: manifest $(manifest_field sha256), built $artifact_sha" >&2
    exit 1
  else
    echo "matches build-manifests/$host.json"
  fi
  exit 0
fi

# --record: a copy of the source in another directory, built into a clean target
# directory, must give identical bytes.
second="$(cd -- "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$second"' EXIT
mkdir "$second/src"
(cd "$script_dir" && tar --exclude=./target --exclude=./runtime-tests/target -cf - .) |
  (cd "$second/src" && tar -xf -)
refuse_cargo_config_above "$second/src/programs/merrymen-vault"
build_into "$second/src/programs/merrymen-vault/Cargo.toml" "$second/target" "$second/deploy"
if ! cmp "$artifact" "$second/deploy/merrymen_vault.so"; then
  echo "error: two clean builds of the same source differ; nothing recorded" >&2
  exit 1
fi
rm -f "$second/deploy/merrymen_vault-keypair.json"

mkdir -p "$(dirname "$manifest")"
{
  printf '{\n'
  printf '  "about": "Reviewed SBF build of merrymen_vault. Written by contracts/solana/build.sh --record; checked by packages/core/src/solana-live.test.ts.",\n'
  printf '  "source": {\n'
  printf '    "digest": "%s",\n' "$digest"
  printf '    "rule": "sha256 of the sorted lines <sha256>  <path> for Cargo.toml, Cargo.lock, build.sh, programs/merrymen-vault/Cargo.toml and programs/merrymen-vault/src/**/*.rs, relative to contracts/solana"\n'
  printf '  },\n'
  printf '  "program": {\n'
  printf '    "declaredId": "%s"\n' "$declared_id"
  printf '  },\n'
  printf '  "toolchain": {\n'
  printf '    "agave": "%s",\n' "$AGAVE_VERSION"
  printf '    "cargoBuildSbf": "%s",\n' "$reported"
  printf '    "platformTools": "%s",\n' "$PLATFORM_TOOLS_VERSION"
  printf '    "rustc": "%s",\n' "$rustc_line"
  printf '    "llvm": "%s",\n' "$llvm_version"
  printf '    "rustSourceCommit": "%s",\n' "$rust_commit"
  printf '    "arch": "%s",\n' "$SBF_ARCH"
  printf '    "command": "cargo-build-sbf --tools-version %s --arch %s -- --locked",\n' "$PLATFORM_TOOLS_VERSION" "$SBF_ARCH"
  printf '    "lto": "none (crate-type cdylib+lib)",\n'
  printf '    "host": "%s"\n' "$host"
  printf '  },\n'
  printf '  "artifact": {\n'
  printf '    "file": "target/deploy/merrymen_vault.so",\n'
  printf '    "bytes": %s,\n' "$artifact_bytes"
  printf '    "sha256": "%s",\n' "$artifact_sha"
  printf '    "reproduced": "a second build from a copy in another directory, identical bytes"\n'
  printf '  }\n'
  printf '}\n'
} > "$manifest"
echo "recorded $manifest"
