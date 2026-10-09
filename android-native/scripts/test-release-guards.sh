#!/usr/bin/env bash
# Exercise the real Gradle release configuration without a keystore or build.
set -euo pipefail

cd "$(dirname "$0")/.."
unset MERRYMEN_ANDROID_KEYSTORE MERRYMEN_ANDROID_STORE_PASSWORD
unset MERRYMEN_ANDROID_KEY_ALIAS MERRYMEN_ANDROID_KEY_PASSWORD

scratch=$(mktemp -d "${TMPDIR:-/tmp}/merrymen-release-guards.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
gradle=(./gradlew --no-daemon --max-workers=2 --no-configuration-cache --console=plain)
passed=0

check_case() {
  local name=$1 expected_status=$2 expected_text=$3
  shift 3
  local status=0
  "$@" >"$scratch/$name.log" 2>&1 || status=$?
  if [[ "$status" != "$expected_status" ]] || ! grep -Fq "$expected_text" "$scratch/$name.log"; then
    printf 'FAIL %s (exit %s; expected %s)\n' "$name" "$status" "$expected_status" >&2
    # No real signing inputs reach these commands. Keep enough diagnostics to
    # distinguish a broken guard from missing Java or dependency downloads.
    tail -n 50 "$scratch/$name.log" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
  passed=$((passed + 1))
}

check_case unsigned-release 1 'Release packaging requires all four' \
  "${gradle[@]}" :app:validatePlayRelease
check_case partial-signing 1 'Android signing is incomplete' \
  env MERRYMEN_ANDROID_KEY_ALIAS=test-only "${gradle[@]}" help
check_case credential-origin 1 'without credentials' \
  "${gradle[@]}" help -Pmerrymen.origin=https://test-user:test-password@example.com
check_case path-origin 1 'without credentials' \
  "${gradle[@]}" help -Pmerrymen.origin=https://example.com/home
check_case external-http 1 'Plain HTTP is allowed only' \
  "${gradle[@]}" help -Pmerrymen.origin=http://example.com
check_case debug-emulator 0 'BUILD SUCCESSFUL' \
  "${gradle[@]}" help -Pmerrymen.origin=http://10.0.2.2:3100
check_case local-release 1 'A release requires an HTTPS server origin' \
  "${gradle[@]}" :app:validatePlayRelease -Pmerrymen.origin=https://localhost
check_case missing-key-file 1 'must point to a readable upload keystore' \
  env MERRYMEN_ANDROID_KEYSTORE="$scratch/does-not-exist.jks" \
    MERRYMEN_ANDROID_STORE_PASSWORD=test-only MERRYMEN_ANDROID_KEY_ALIAS=test-only \
    MERRYMEN_ANDROID_KEY_PASSWORD=test-only "${gradle[@]}" :app:validatePlayRelease

# Inspect AGP's actual generated tasks so a dependency change cannot leave the
# check passing while an APK/AAB packaging task silently skips it.
cat >"$scratch/wiring.gradle" <<'GRADLE'
gradle.projectsEvaluated {
  def app = gradle.rootProject.project(':app')
  ['packageRelease', 'packageReleaseBundle', 'signReleaseBundle', 'bundleRelease', 'assembleRelease'].each { name ->
    def task = app.tasks.findByName(name)
    assert task != null : 'Missing release task: ' + name
    assert task.dependsOn.any { it instanceof org.gradle.api.tasks.TaskProvider && it.name == 'validatePlayRelease' } : 'Release guard missing from ' + name
  }
  println('All release packaging tasks have the guard')
}
GRADLE
check_case packaging-wiring 0 'All release packaging tasks have the guard' \
  "${gradle[@]}" --init-script "$scratch/wiring.gradle" help

printf '%s release guard checks passed. No signing key or release artifact was created.\n' "$passed"
