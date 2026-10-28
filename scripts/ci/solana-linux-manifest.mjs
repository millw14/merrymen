#!/usr/bin/env node
// Checks the Linux build manifest CI just recorded: it must describe the
// artifact the tests ran against, and match the committed one if there is one.
//
//   node scripts/ci/solana-linux-manifest.mjs verify <contracts/solana dir> <tested sha256>
//   node scripts/ci/solana-linux-manifest.mjs report <contracts/solana dir> <record.json>
//   node scripts/ci/solana-linux-manifest.mjs compare <contracts/solana dir>
//
// `solana · test` runs verify right after `build.sh --record`, which built the
// source a second time from a copy in another directory, required identical
// bytes, and wrote build-manifests/Linux-x86_64.json for the pinned Linux
// build. The release artifact comes from that build (build.sh: platform-tools
// embeds its own paths, so a macOS manifest never describes it). verify
// refuses (exit 1) a manifest that is missing, unreadable, for another host,
// or not for the tested artifact: its artifact.sha256 must equal
// <tested sha256>, and target/deploy/merrymen_vault.so must still hash to it,
// so --record's in-place build left the bytes the runtime tests ran against
// untouched.
//
// report runs next, before the upload, and fails only on an error, never on
// what it finds. It compares the recorded manifest with the committed one
// (the outcomes below: matches, uncommitted, differs, removed), writes the
// outcome and the release decision into <record.json> (the build record
// solana-program-record.mjs wrote), adds both to the step summary, and prints
// the artifact's release label on stdout for the upload's name. Only a run on
// main whose build matches the committed manifest, and whose record says it
// does not declare the local test program id, is candidate-unconfirmed
// (solana-program-record.mjs releaseStatus); every other artifact, one whose
// manifest differs, was deleted or was never committed included, is uploaded
// as not-a-release. So bytes that fail the comparison still reach the owner,
// but never under a candidate's name. No label here says release: the upload
// comes before app has compared the rebuild's hash, so the release verdict is
// solana · release's, after app passed (solana-release.mjs).
//
// compare is the job's last step, after the upload. It fails (exit 1) when a
// Linux manifest is committed at HEAD and differs from the recorded one in
// any field (a stale one included: packages/core's manifest test fails on it
// too), and when HEAD has none but its first parent (a pull request's base,
// or the commit before a push) has one: once committed, the manifest is
// replaced by the next reviewed one, never deleted, so deleting it cannot
// turn the comparison off. The job checks out with fetch-depth: 2 for that
// parent, and a checkout that lacks it fails rather than skipping the check.
// With none committed on either side it passes: report has already said (a
// notice and the step summary) that the uploaded artifact carries the
// manifest for the owner to review and commit. Committing it is what turns
// the comparison on, and what lets a run on main be a release candidate.
//
// A manifest's own commit names the run and runner image it came from. The
// manifest is image-free (differences() compares every field, and an image
// update alone must not change it), and the run's artifact and summary
// expire, so for an outcome where the owner may commit the uploaded manifest
// (uncommitted, differs) report gives a Vault-Linux-Manifest line
// (manifestTrailer) in the log, the step summary and the record, to end that
// commit's message with. A later mismatch is then compared with the image
// that built the committed manifest (RUNNER_IMAGE_NOTE).
//
// One case never gets this far: a committed manifest with the same source
// digest as this build but another artifact. build.sh, run by test.sh in the
// Test step, refuses it ("same source, different artifact"), so the job fails
// before report and the upload, and hands over no new manifest. The reviewed
// source did not change, so the toolchain or the build environment did; the
// owner investigates that rather than committing a new manifest. The job's
// first step (solana-program-record.mjs --runner-image) has already named the
// runner image in the log and step summary, since no build record exists.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { provenance, releaseLine, releaseStatus } from "./solana-program-record.mjs";

export const LINUX_HOST = "Linux-x86_64";
export const LINUX_MANIFEST = `build-manifests/${LINUX_HOST}.json`;
export const ARTIFACT = "target/deploy/merrymen_vault.so";

const HEX64 = /^[0-9a-f]{64}$/;

/** Every leaf where two parsed manifests differ, as "<path>: committed <a>, recorded <b>". */
export function differences(committed, recorded, path = "") {
  const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObject(committed) && isObject(recorded)) {
    const keys = [...new Set([...Object.keys(committed), ...Object.keys(recorded)])].sort();
    return keys.flatMap(k => differences(committed[k], recorded[k], path ? `${path}.${k}` : k));
  }
  if (JSON.stringify(committed) === JSON.stringify(recorded)) return [];
  const show = v => (v === undefined ? "(absent)" : JSON.stringify(v));
  return [`${path || "(manifest)"}: committed ${show(committed)}, recorded ${show(recorded)}`];
}

/** The recorded manifest, parsed and checked to be for this host and the tested artifact. */
export function verifyRecorded({ recorded, testedSha256, artifact }) {
  if (!HEX64.test(testedSha256 ?? "")) throw new Error(`no tested artifact SHA-256 to check the manifest against (${JSON.stringify(testedSha256)})`);
  const manifest = parseRecorded(recorded);
  if (manifest.artifact.sha256 !== testedSha256) {
    throw new Error(`the recorded manifest is for artifact ${manifest.artifact.sha256}, not the tested ${testedSha256}`);
  }
  const onDisk = createHash("sha256").update(artifact).digest("hex");
  if (onDisk !== testedSha256 || manifest.artifact.bytes !== artifact.length) {
    throw new Error(`${ARTIFACT} changed after the tests ran: now ${onDisk} (${artifact.length} bytes), tested ${testedSha256}`);
  }
  return manifest;
}

/**
 * The recorded manifest against the committed one: `committed` is HEAD's,
 * `parent` HEAD's first parent's (each null when that commit has none).
 * Never throws for what it finds, only for a recorded manifest that is not
 * this host's build; `problem` says why any outcome but matches or
 * uncommitted fails the job.
 * @returns {{ status: "matches" | "uncommitted" | "differs" | "removed", manifest: any, problem: string | null }}
 */
export function assess({ recorded, committed, parent = null }) {
  const manifest = parseRecorded(recorded);
  if (committed === null) {
    if (parent === null) return { status: "uncommitted", manifest, problem: null };
    return {
      status: "removed",
      manifest,
      problem: `HEAD has no ${LINUX_MANIFEST}, but its first parent (a pull request's base, or the commit before a push) has one. `
        + "A committed Linux manifest is replaced by the next reviewed one, never deleted: restore it, "
        + "or review the manifest this run uploaded and commit it unchanged.",
    };
  }
  let ours;
  try {
    ours = JSON.parse(committed);
  } catch {
    return { status: "differs", manifest, problem: `the committed ${LINUX_MANIFEST} is not JSON` };
  }
  const diff = differences(ours, manifest);
  if (diff.length > 0) {
    const shown = diff.slice(0, 12);
    if (diff.length > shown.length) shown.push(`and ${diff.length - shown.length} more`);
    return {
      status: "differs",
      manifest,
      problem: `this pinned Linux build differs from the committed ${LINUX_MANIFEST}: ${shown.join("; ")}. `
        + "If the program or its toolchain changed on purpose, review the manifest this run uploaded and commit it unchanged; "
        + "the next run must then reproduce it.",
    };
  }
  return { status: "matches", manifest, problem: null };
}

/**
 * assess, failing on any outcome but matches or uncommitted.
 * @returns {{ status: "matches" | "uncommitted", manifest: any }}
 */
export function compareCommitted(input) {
  const { status, manifest, problem } = assess(input);
  if (problem !== null) throw new Error(problem);
  return { status, manifest };
}

function parseRecorded(recorded) {
  let manifest;
  try {
    manifest = JSON.parse(recorded);
  } catch {
    throw new Error(`the recorded ${LINUX_MANIFEST} is not JSON`);
  }
  if (manifest?.toolchain?.host !== LINUX_HOST) {
    throw new Error(`the recorded manifest is for host ${JSON.stringify(manifest?.toolchain?.host)}, not ${LINUX_HOST}`);
  }
  if (!HEX64.test(manifest?.source?.digest ?? "")) throw new Error("the recorded manifest has no source digest");
  if (manifest?.artifact?.file !== ARTIFACT) throw new Error(`the recorded manifest names ${JSON.stringify(manifest?.artifact?.file)}, not ${ARTIFACT}`);
  if (!HEX64.test(manifest.artifact.sha256 ?? "") || !Number.isSafeInteger(manifest.artifact.bytes) || manifest.artifact.bytes <= 0) {
    throw new Error("the recorded manifest has no artifact SHA-256 and size");
  }
  return manifest;
}

/**
 * The manifest committed at HEAD and at HEAD's first parent, each null when
 * that commit has none (parent also when HEAD has no parent). Fails outside
 * a git checkout, and when HEAD names a parent the checkout does not have (a
 * depth-1 clone): without it a deletion would pass unseen.
 */
export function committedManifests(dir) {
  const git = args => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).trim();
  // ls-tree and ./ paths are relative to -C's directory.
  const at = commit => (git(["ls-tree", "--name-only", commit, "--", LINUX_MANIFEST]).trim()
    ? git(["show", `${commit}:./${LINUX_MANIFEST}`])
    : null);
  // The commit object names its parents even where a shallow clone left them out.
  const headers = git(["cat-file", "commit", head]).split("\n\n")[0];
  const first = /^parent ([0-9a-f]{40,64})$/m.exec(headers)?.[1] ?? null;
  if (first === null) return { committed: at(head), parent: null };
  try {
    git(["cat-file", "-e", `${first}^{commit}`]);
  } catch {
    throw new Error(`HEAD's first parent ${first} is not in this checkout, so a deleted ${LINUX_MANIFEST} would go unseen; check out with fetch-depth: 2`);
  }
  return { committed: at(head), parent: at(first) };
}

/** The git trailer token naming the run and runner image that built a committed Linux manifest. */
export const MANIFEST_TRAILER = "Vault-Linux-Manifest";
/**
 * The line that ends the message of the commit adding `manifest`: the run
 * (`run`, solana-program-record.mjs provenance) and runner image (`image`,
 * the build record's runnerImage) that built it, and its artifact. Unknown
 * parts say unknown.
 */
export function manifestTrailer({ manifest, run = null, image = null }) {
  const v = value => (typeof value === "string" && value ? value : "unknown");
  return `${MANIFEST_TRAILER}: run ${v(run?.runId)}.${v(run?.runAttempt)} of ${v(run?.repository)} `
    + `(${v(run?.event)} on ${v(run?.ref)} at ${v(run?.commit)}), runner image ${v(image?.os)} ${v(image?.version)}, `
    + `artifact ${manifest.artifact.sha256} (${manifest.artifact.bytes} bytes), source digest ${manifest.source.digest}`;
}

const USAGE = "usage: solana-linux-manifest.mjs verify <contracts/solana dir> <tested sha256> | "
  + "report <contracts/solana dir> <record.json> | compare <contracts/solana dir>";

/** One outcome of assess, for the log and the step summary. */
export function outcomeLine({ status, manifest, problem = null }) {
  const built = `source digest ${manifest.source.digest}, artifact ${manifest.artifact.sha256} (${manifest.artifact.bytes} bytes)`;
  if (status === "matches") return `The pinned Linux build matches the committed ${LINUX_MANIFEST}: ${built}.`;
  if (status === "uncommitted") {
    return `No ${LINUX_MANIFEST} is committed, so nothing was compared. This run recorded ${built}; `
      + "the manifest is in the uploaded vault artifact. Review it and commit it from a run whose app check passed: "
      + "from then on CI fails whenever the pinned Linux build differs from it, and a run on main that matches it and passes app is a release, "
      + "unless its program declares the local test program id: that build's manifest is a reproducibility baseline only.";
  }
  return `${problem} This run recorded ${built}.`;
}

/**
 * The outcome and the release decision, written into the build record; the
 * label goes to stdout for the artifact's name. Throws only on an error.
 */
function report(dir, recorded, recordPath) {
  const result = assess({ recorded, ...committedManifests(dir) });
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the build record ${recordPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (record?.sha256 !== result.manifest.artifact.sha256) {
    throw new Error(`the build record ${recordPath} is for artifact ${JSON.stringify(record?.sha256)}, the Linux manifest for ${result.manifest.artifact.sha256}`);
  }
  // The record names the program and the local test id: a build of that id is never a candidate.
  const run = provenance(process.env);
  const release = releaseStatus(run, result.status, record);
  // Only where the owner may commit the uploaded manifest: none committed, or this one differs.
  const trailer = result.status === "uncommitted" || result.status === "differs"
    ? manifestTrailer({ manifest: result.manifest, run, image: record.runnerImage })
    : null;
  record.linuxManifest = { file: LINUX_MANIFEST, status: result.status, problem: result.problem, commitTrailer: trailer };
  record.release = release;
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const line = outcomeLine(result);
  const named = `The artifact is uploaded as ${release.label} (${release.reason}).`
    + (result.status === "differs" && record.runnerImage
      ? ` This run's runner image: ${record.runnerImage.os ?? "unknown"} ${record.runnerImage.version ?? "unknown"} (not digest-pinned); `
        + "if the program source and toolchain pins did not change, the image may have: investigate before committing anything."
      : "");
  // stdout is the label alone; Actions reads workflow commands on stderr too.
  if (result.status === "matches") console.error(`${line} ${named}`);
  else if (result.status === "uncommitted") console.error(`::notice title=Linux build manifest::${line} ${named}`);
  else console.error(`::warning title=Linux build manifest::${line} ${named} The job's last step fails on this.`);
  const commitWith = "If this manifest is committed (after review, never just to make the comparison pass), end that commit's message with this line, "
    + "so a later mismatch can be compared with the run and runner image that built it:";
  if (trailer !== null) console.error(`${commitWith} ${trailer}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### Linux build manifest", "", line, "", releaseLine(release), "",
      ...(trailer !== null ? [commitWith, "", `    ${trailer}`, ""] : [])].join("\n"));
  }
  process.stdout.write(`${release.label}\n`);
}

function main(argv) {
  const [command, dir, third] = argv;
  if (!(command === "verify" && argv.length === 3) && !(command === "report" && argv.length === 3) && !(command === "compare" && argv.length === 2)) {
    console.error(USAGE);
    process.exit(2);
  }
  const path = join(dir, LINUX_MANIFEST);
  if (!existsSync(path)) throw new Error(`no ${LINUX_MANIFEST}: build.sh --record did not write one for this host`);
  const recorded = readFileSync(path, "utf8");
  if (command === "verify") {
    const m = verifyRecorded({ recorded, testedSha256: third, artifact: readFileSync(join(dir, ARTIFACT)) });
    console.log(`${LINUX_MANIFEST} is for the tested artifact: source digest ${m.source.digest}, artifact ${m.artifact.sha256} (${m.artifact.bytes} bytes).`);
    return;
  }
  if (command === "report") {
    report(dir, recorded, third);
    return;
  }
  // compare: report has already annotated and summarised the outcome.
  console.log(outcomeLine(compareCommitted({ recorded, ...committedManifests(dir) })));
}

// Real paths on both sides, as in solana-program-record.mjs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
