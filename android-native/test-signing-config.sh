#!/usr/bin/env bash
# Exercise the real Gradle signing configuration with fake properties only.
set -euo pipefail
cd "$(dirname "$0")"
project_dir="$PWD"
fixture_dir="$(mktemp -d)"
relative_properties="$(mktemp "$project_dir/.signing-check-XXXXXX.properties")"
trap 'rm -rf "$fixture_dir"; rm -f "$relative_properties"' EXIT
mkdir -p "$fixture_dir/home"

cat > "$fixture_dir/assert-signing.gradle" <<'GROOVY'
gradle.projectsEvaluated {
    def signing = gradle.rootProject.project(':app').extensions.getByName('android').signingConfigs.findByName('release')
    def expected = System.getProperty('merrymen.test.store')
    if (expected == 'unsigned') {
        assert signing == null : 'Expected an unsigned release'
    } else {
        assert signing != null : 'Expected release signing'
        assert signing.storeFile.canonicalFile == new File(expected).canonicalFile : 'Wrong keystore selected'
    }
}
GROOVY

properties() {
  printf 'storeFile=%s\nstorePassword=test-only\nkeyAlias=test-only\nkeyPassword=test-only\n' "$2" > "$1"
}

gradle_check() {
  bash ./gradlew --no-daemon --max-workers=2 --console=plain \
    --gradle-user-home "${GRADLE_USER_HOME:-$HOME/.gradle}" \
    -Duser.home="$fixture_dir/home" \
    --init-script "$fixture_dir/assert-signing.gradle" "$@" help > "$fixture_dir/result.log" 2>&1
}

check() {
  if ! gradle_check "$@"; then cat "$fixture_dir/result.log"; return 1; fi
}

reject() {
  if gradle_check "$@"; then
    echo 'An invalid signing override unexpectedly succeeded'; return 1
  fi
  if ! grep -Eq 'requested signing-properties file does not exist|signing-properties path must not be blank' "$fixture_dir/result.log"; then
    cat "$fixture_dir/result.log"; return 1
  fi
}

unset MERRYMEN_SIGNING
check -Dmerrymen.test.store=unsigned
mkdir -p "$fixture_dir/home/.merrymen-release"
properties "$fixture_dir/home/.merrymen-release/keystore.properties" default.jks
check -Dmerrymen.test.store="$fixture_dir/home/.merrymen-release/default.jks"

# A bare filename must have a usable parent when resolving storeFile.
properties "$relative_properties" relative.jks
check "-Pmerrymen.signing=${relative_properties##*/}" -Dmerrymen.test.store="$project_dir/relative.jks"

properties "$fixture_dir/env.properties" env.jks
export MERRYMEN_SIGNING="$fixture_dir/env.properties"
check -Dmerrymen.test.store="$fixture_dir/env.jks"
check "-Pmerrymen.signing=${relative_properties##*/}" -Dmerrymen.test.store="$project_dir/relative.jks"

# Existing lower-priority files must never hide an invalid explicit selection.
reject -Pmerrymen.signing="$fixture_dir/missing.properties"
reject -Pmerrymen.signing=
export MERRYMEN_SIGNING="$fixture_dir/missing.properties"
reject
echo 'Signing configuration checks passed'
