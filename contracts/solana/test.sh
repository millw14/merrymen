#!/usr/bin/env bash
# Native unit tests, the pinned SBF build (build.sh checks agave 2.3.13 / platform-tools
# v1.48 and compares with this host's build manifest), then every runtime test against
# that artifact: the custody suite, the owner recovery transactions and the Jupiter fork
# test (a real Jupiter v6 route through execute_swap, from committed mainnet fixtures).
#
# The Jupiter fork test also needs copies of the Jupiter v6 and Orca Whirlpool programs,
# which this public repository does not publish (runtime-tests/fixtures/jupiter/NOTICE.md).
# It runs when MERRYMEN_JUPITER_FORK_PROGRAMS names a directory holding all five program
# copies, or when both of those files sit in the fixture directory; otherwise test.sh
# prints one "jupiter_fork: skipped" line and still runs every other target. It is a
# release gate: run it with the copies before a vault release.
# Extra arguments go to cargo-build-sbf, for example --offline. CI passes none, so its
# build uses exactly build.sh's pinned flags, which scripts/ci/solana-ci.test.mjs holds
# equal to scripts/ci/solana-toolchain.env.
#
# The runtime tests are #[ignore]d so a plain `cargo test` without the artifact skips
# them. --include-ignored runs them whether or not they are marked, so a dropped
# #[ignore] can never make one skip; CI also counts that every one ran
# (scripts/ci/solana-runtime-tests.mjs).
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
mkdir -p "${CARGO_HOME:-$HOME/.cargo}"
CARGO_HOME="$(cd -- "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)"
export CARGO_HOME
offline=()
for arg in "$@"; do
  if [ "$arg" = "--offline" ]; then offline=(--offline); fi
done
cargo test --locked ${offline[@]+"${offline[@]}"} --manifest-path "$script_dir/Cargo.toml" --lib
"$script_dir/build.sh" "$@"
BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked ${offline[@]+"${offline[@]}"} --manifest-path "$script_dir/runtime-tests/Cargo.toml" --test custody --test recovery -- --include-ignored
jupiter_fixtures="$script_dir/runtime-tests/fixtures/jupiter"
if [ -n "${MERRYMEN_JUPITER_FORK_PROGRAMS:-}" ]; then
  # Absolute, and it must exist: the test runs from runtime-tests/, not from here.
  MERRYMEN_JUPITER_FORK_PROGRAMS="$(cd -- "$MERRYMEN_JUPITER_FORK_PROGRAMS" && pwd -P)"
  export MERRYMEN_JUPITER_FORK_PROGRAMS
fi
if [ -n "${MERRYMEN_JUPITER_FORK_PROGRAMS:-}" ] || { [ -f "$jupiter_fixtures/jupiter_v6.so" ] && [ -f "$jupiter_fixtures/whirlpool.so" ]; }; then
  BPF_OUT_DIR="$script_dir/target/deploy" CARGO_TARGET_DIR="$script_dir/target" cargo test --locked ${offline[@]+"${offline[@]}"} --manifest-path "$script_dir/runtime-tests/Cargo.toml" --test jupiter_fork -- --include-ignored
else
  echo "jupiter_fork: skipped, set MERRYMEN_JUPITER_FORK_PROGRAMS (release gate)"
fi
