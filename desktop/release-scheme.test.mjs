import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Release tag-scheme regression test.
 *
 * The in-app updater (electron-updater GitHub provider) walks the releases
 * feed and silently SKIPS every tag that fails semver.valid() — then throws
 * "No published versions on GitHub" when nothing is left. Our old
 * `desktop-v*` / `desktop-beta-v*` scheme meant EVERY desktop tag was skipped
 * and update checks failed on all channels, on all builds, while the release
 * pages themselves looked perfectly healthy.
 *
 * So the scheme is load-bearing: tags MUST be bare semver (`v` + version,
 * optional `-beta.N`), and the workflow trigger patterns must only match
 * shapes that parse. This test pins both sides — the trigger globs from the
 * workflow file itself, and representative tags of each kind.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function semverValid(tag) {
  // Same verdict as the `semver` package's valid(): optional leading v,
  // then digits — a non-digit prefix disqualifies the whole string.
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return m ? m[1] : null;
}

function prereleaseChannel(tag) {
  const v = semverValid(tag);
  if (!v) return null;
  const m = /-([0-9A-Za-z.-]+?)(?:\+|$)|\.([0-9A-Za-z-]+)/.exec(v);
  const pre = v.split("-")[1];
  if (!pre) return null;
  return pre.split(".")[0];
}

function matchesGlob(tag, glob) {
  // Minimal glob: only the `*` and `?` forms the workflow uses.
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(tag);
}

describe("release tag scheme (updater-visible)", () => {
  const workflow = readFileSync(path.join(HERE, "..", ".github", "workflows", "desktop-release.yml"), "utf8");
  const triggers = [...workflow.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)]
    .map((m) => m[1])
    .filter((g) => g.includes("v") || g.includes("*"));

  it("workflow tag triggers only match semver-parseable shapes", () => {
    assert.ok(triggers.length > 0, "no tag triggers found in desktop-release.yml");
    const samples = [
      "v0.1.9",
      "v0.1.9-beta.1",
      "v10.20.30",
      "v0.1.9-beta.10",
      "desktop-v0.1.9",
      "desktop-beta-v0.1.9-dev.1",
      "mobile-v0.1.2",
      "not-a-version",
    ];
    for (const glob of triggers) {
      for (const s of samples) {
        if (matchesGlob(s, glob)) {
          assert.ok(
            semverValid(s),
            `trigger "${glob}" matches "${s}" but the updater would skip it (not semver)`,
          );
        }
      }
    }
  });

  it("beta releases use the beta prerelease identifier (alpha/beta/same-channel only)", () => {
    // The provider auto-follows alpha/beta/same-channel tags only: a `dev`
    // channel can never see stable releases again (one-way trap), while
    // `beta` flows beta→beta and beta→stable.
    assert.equal(prereleaseChannel("v0.1.9-beta.1"), "beta");
    assert.equal(prereleaseChannel("v0.1.9"), null);
  });

  it("channel detection matches the workflow: -beta.N and one-off -dev.N are prereleases", () => {
    // Mirrors the `if [[ $REF == ... ]]` in desktop-release.yml — if the
    // workflow gains a suffix, this list must gain it too (v0.1.9-dev.2
    // shipped as STABLE because -dev.* was missing; fixed the same day).
    const isBetaTag = (tag) => {
      const v = semverValid(tag);
      if (!v) return false;
      const pre = v.split("-")[1] ?? "";
      return pre.startsWith("beta.") || pre.startsWith("dev.");
    };
    assert.equal(isBetaTag("v0.1.9-beta.1"), true);
    assert.equal(isBetaTag("v0.1.9-dev.2"), true);
    assert.equal(isBetaTag("v0.1.9"), false);
    assert.equal(isBetaTag("desktop-beta-v0.1.8-dev.5"), false);
  });

  it("our historical tags would all have been skipped (documents the incident)", () => {
    for (const t of ["desktop-v0.1.7", "desktop-beta-v0.1.8-dev.5", "mobile-v0.1.2"]) {
      assert.equal(semverValid(t), null, `${t} must stay invisible — that was the bug`);
    }
    assert.ok(semverValid("v0.1.9-beta.1"), "new scheme parses");
    assert.ok(semverValid("v0.1.9"), "stable parses");
  });
});
