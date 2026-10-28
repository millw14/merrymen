#!/usr/bin/env node
// Ties a built vault artifact to the program ID its source declares, and
// records what was built.
//
//   node scripts/ci/solana-program-record.mjs <contracts/solana dir> <program .so> <record.json>
//   node scripts/ci/solana-program-record.mjs --runner-image
//
// --runner-image only names the runner image (runnerImageSection) on stdout
// and in the step summary. ci.yml runs it first in solana · test and solana ·
// rebuild, so a run that fails before any record is written still names the
// image it ran on. It never fails on what it finds.
//
// Refuses (exit 1) unless:
// - lib.rs declares exactly one program ID, a 32-byte base58 key;
// - Anchor.toml names that same ID for merrymen_vault in every [programs.*];
// - the .so is an ELF file that contains the ID's 32 bytes. A binary built for
//   another ID passes a hash check but fails every instruction with
//   DeclaredProgramIdMismatch (0x1004) once deployed, and an immutable deploy
//   cannot be fixed or refunded.
// Then it writes the record (ID, size, SHA-256, toolchain, the run that built
// it, and whether that run can be a release) to <record.json>, adds it to the
// GitHub step summary when there is one, and prints the SHA-256 on stdout.
// The record also names the local test program id (SOLANA_VAULT_LOCAL_TEST_PROGRAM
// in packages/core/src/solana-live.ts, read from this script's own checkout)
// and whether the build declares it: the live runtime refuses that id, so such
// a build is never a release, whatever its manifest says.
//
// A release artifact comes only from a CI run on refs/heads/main of
// millw14/merrymen (a push to main or a manual run on main) whose pinned
// Linux build matched the committed build manifest and whose app check passed
// (RELEASE_RULE). CI never runs on a tag push, and a manual run on a tag or
// another branch is not a candidate. This script cannot know the manifest
// outcome yet, so its record always says not-a-release; in solana · test,
// solana-linux-manifest.mjs report compares the manifest, rewrites the
// record's release with releaseStatus(run, outcome, record), and gives ci.yml
// the artifact name's label. The third argument is the build record itself
// (its programId and localTestId): a build that declares the local test
// program id is never a candidate, and a record that does not name both ids
// fails closed as not compared. That label is at most candidate-unconfirmed:
// the upload happens before app has compared the rebuild's hash, so only
// solana-release.mjs, in the job that runs after app passed, says release.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("empty base58 string");
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error(`not base58: ${JSON.stringify(text)}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.push(Number(n & 0xffn));
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

export function declaredProgramId(libRs) {
  const mentions = (libRs.match(/declare_id!/g) ?? []).length;
  const found = [...libRs.matchAll(/^[ \t]*declare_id!\s*\(\s*"([^"]*)"\s*\)\s*;/gm)];
  if (mentions !== 1 || found.length !== 1) {
    throw new Error(`lib.rs must declare exactly one program ID with declare_id!("..."); found ${mentions} mention(s)`);
  }
  return found[0][1];
}

/** Where SOLANA_VAULT_LOCAL_TEST_PROGRAM is declared, relative to the repository root. */
export const LOCAL_TEST_SOURCE = "packages/core/src/solana-live.ts";
/**
 * An assignment to SOLANA_VAULT_LOCAL_TEST_PROGRAM, compound ones (+=, ??=, ...) included,
 * never a comparison (==, ===, !=, !==, <=, >=) or an arrow (=>): code that only reads the
 * id is not a second assignment.
 */
const LOCAL_TEST_ASSIGNMENT = /\bSOLANA_VAULT_LOCAL_TEST_PROGRAM\s*(?:\*\*|<<|>>>|>>|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])/g;
/** The local test program id: the one string SOLANA_VAULT_LOCAL_TEST_PROGRAM is assigned in LOCAL_TEST_SOURCE. */
export function localTestProgramId(solanaLiveTs) {
  const assigned = (solanaLiveTs.match(LOCAL_TEST_ASSIGNMENT) ?? []).length;
  const found = [...solanaLiveTs.matchAll(/^export const SOLANA_VAULT_LOCAL_TEST_PROGRAM\s*=\s*"([^"]*)"\s*;/gm)];
  if (assigned !== 1 || found.length !== 1) {
    throw new Error(`${LOCAL_TEST_SOURCE} must assign SOLANA_VAULT_LOCAL_TEST_PROGRAM exactly once, to a string; found ${assigned} assignment(s)`);
  }
  const id = found[0][1];
  if (base58Decode(id).length !== 32) throw new Error(`SOLANA_VAULT_LOCAL_TEST_PROGRAM ${id} is not a 32-byte key`);
  return id;
}
/** The local test program id from the repository at `root` (default: this script's own checkout). */
export function readLocalTestProgramId(root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")) {
  return localTestProgramId(readFileSync(join(root, LOCAL_TEST_SOURCE), "utf8"));
}

export function anchorProgramIds(anchorToml, program) {
  const ids = [];
  let section = "";
  for (const raw of anchorToml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (!section.startsWith("programs.")) continue;
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (entry && entry[1] === program) ids.push({ cluster: section.slice("programs.".length), id: entry[2] });
  }
  return ids;
}

export function countOccurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

export function readToolchain(envText) {
  const pins = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(\S+)$/.exec(line.trim());
    if (m) pins[m[1]] = m[2];
  }
  return {
    agave: pins.AGAVE_VERSION ?? null,
    platformTools: pins.PLATFORM_TOOLS_VERSION ?? null,
    platformToolsRustc: pins.PLATFORM_TOOLS_RUSTC ?? null,
    arch: pins.SBF_ARCH ?? null,
    hostRust: pins.HOST_RUST ?? null,
  };
}

/** The repository whose main branch releases the vault. */
export const RELEASE_REPOSITORY = "millw14/merrymen";
/**
 * Only refs/heads/main. ci.yml runs on a push to main, on pull requests and on
 * a manual dispatch; it never runs on a tag push. A manual run can be
 * dispatched on a tag or any branch, and nothing ties that ref's commit to
 * main, so such a run is not a candidate either.
 */
export const RELEASE_REF = "refs/heads/main";
/**
 * solana · test's label for a run on main whose Linux build matched the
 * committed manifest. It uploads before app has compared the rebuild's hash
 * and before the rest of the run has passed, so the name cannot say more.
 */
export const CANDIDATE_LABEL = "candidate-unconfirmed";
/** The label of every other solana · test upload. */
export const NOT_A_RELEASE_LABEL = "not-a-release";
/** What solana · test names its upload, from the label and the run. */
export function candidateArtifactName(label, { commit, runId, runAttempt }) {
  return `merrymen-vault-sbf-${label}-${commit}-run${runId}.${runAttempt}`;
}
export const RELEASE_RULE = `A release artifact comes only from a CI run on ${RELEASE_REF} of ${RELEASE_REPOSITORY}: `
  + "a push to main, or a manual (workflow_dispatch) run on main, whose pinned Linux build matched the committed "
  + "contracts/solana/build-manifests/Linux-x86_64.json and whose app check passed, so solana · rebuild reproduced its hash. "
  + `solana · test uploads such a run's bytes as merrymen-vault-sbf-${CANDIDATE_LABEL}-<commit>-run<id>.<attempt>, before app has decided; `
  + "solana · release, which runs only after app passed, confirms them with merrymen-vault-release-<commit>-run<id>.<attempt>, "
  + "a record naming that artifact and its SHA-256. Without that record the run is not a release. "
  + "A build whose lib.rs declares the local test program id (SOLANA_VAULT_LOCAL_TEST_PROGRAM in packages/core/src/solana-live.ts) is never a release: "
  + "the live runtime refuses that id, so its Linux manifest is a reproducibility baseline only. "
  + "CI never runs on a tag push, and a manual run on a tag or another branch is not a release candidate. "
  + "Every other artifact, every pull request run's included, is not a release artifact. "
  + "Confirm the run on GitHub itself (event, branch, commit, and that app passed): this record and the artifact names are written by the run and prove nothing alone.";

/** The run that built an artifact, from the GitHub Actions environment. */
export function provenance(env) {
  let pullRequestHead = null;
  if (env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    const head = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))?.pull_request?.head?.sha;
    if (typeof head === "string" && /^[0-9a-f]{40}$/.test(head)) pullRequestHead = head;
  }
  const value = name => env[name] || null;
  return {
    repository: value("GITHUB_REPOSITORY"),
    event: value("GITHUB_EVENT_NAME"),
    ref: value("GITHUB_REF"),
    // The pushed commit, or a pull request's test merge commit.
    commit: value("GITHUB_SHA"),
    pullRequestHead,
    workflowSha: value("GITHUB_WORKFLOW_SHA"),
    runId: value("GITHUB_RUN_ID"),
    runAttempt: value("GITHUB_RUN_ATTEMPT"),
  };
}

/**
 * Why a GitHub-hosted image is recorded rather than pinned. Exported for the
 * tests and the step summary.
 */
export const RUNNER_IMAGE_NOTE = "GitHub-hosted runner image, named by release (ubuntu-24.04) but not digest-pinned: GitHub updates it in place. "
  + "If the pinned Linux build stops matching the committed manifest while the program source and scripts/ci/solana-toolchain.env did not change, "
  + "compare this image version with the one in the Vault-Linux-Manifest line of the commit that added the committed manifest "
  + "(git log -1 -- contracts/solana/build-manifests/Linux-x86_64.json; the producing run's own artifact and summary expire) "
  + "and investigate the toolchain and image; never commit a new manifest just to make the comparison pass.";

/**
 * The runner image that built an artifact: ImageOS and ImageVersion, which
 * GitHub sets on its hosted runners (null elsewhere, or when malformed).
 * ci.yml runs the vault jobs on ubuntu-24.04, a named image release with no
 * digest to pin, so the record names the exact image version instead.
 */
export function runnerImage(env) {
  const value = name => (typeof env?.[name] === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(env[name]) ? env[name] : null);
  return { os: value("ImageOS"), version: value("ImageVersion"), digestPinned: false, note: RUNNER_IMAGE_NOTE };
}
/** The step summary's runner image line. */
export function runnerImageLine(image) {
  const named = image?.os || image?.version ? `\`${image.os ?? "unknown"}\` version \`${image.version ?? "unknown"}\`` : "unknown (no ImageOS or ImageVersion: not a GitHub-hosted runner)";
  return `- runner image: ${named}, not digest-pinned. ${RUNNER_IMAGE_NOTE}`;
}

/**
 * The step summary's runner image section, written by ci.yml's first vault
 * step (--runner-image) before anything is built. When a committed manifest
 * has this build's source digest but another artifact, build.sh fails the
 * Test step ("same source, different artifact") before the build record or
 * its summary exist: the toolchain or the image changed, and this section is
 * then the run's only record of the image.
 */
export function runnerImageSection(env) {
  return ["### Runner image", "", runnerImageLine(runnerImage(env)), ""].join("\n");
}

/** Why releaseStatus decided as it did, by the run and the Linux manifest outcome. */
const RELEASE_REASONS = {
  matches: "a run on main whose pinned Linux build matched the committed manifest",
  uncommitted: "no Linux build manifest is committed yet",
  differs: "its pinned Linux build differs from the committed manifest",
  removed: "the committed Linux build manifest was deleted",
};

/** Whether a build record's program declares the local test id: true, false, or null when either id is missing. */
export function declaresLocalTestId(program) {
  const id = typeof program?.programId === "string" && program.programId ? program.programId : null;
  const local = typeof program?.localTestId === "string" && program.localTestId ? program.localTestId : null;
  return id === null || local === null ? null : id === local;
}

/** A push or manual run on refs/heads/main of RELEASE_REPOSITORY. */
export function fromMain(p) {
  return p?.repository === RELEASE_REPOSITORY
    && (p.event === "push" || p.event === "workflow_dispatch")
    && p.ref === RELEASE_REF;
}

/**
 * Whether a run's artifact is a release candidate (RELEASE_RULE): a push or
 * manual run on refs/heads/main of RELEASE_REPOSITORY, and `linuxManifest`,
 * the outcome of solana-linux-manifest.mjs's comparison, is "matches", and
 * `program` (the build record: programId, localTestId) declares another id
 * than the local test program. Any other outcome, or none yet (null), a build
 * of the local test id, and a record that does not name both ids, are
 * not-a-release. ci.yml names the uploaded artifact with `label`, which is
 * never more than candidate-unconfirmed: whether the run is a release is
 * decided after app passed (solana-release.mjs).
 */
export function releaseStatus(p, linuxManifest = null, program = null) {
  const main = fromMain(p);
  const local = declaresLocalTestId(program);
  const candidate = main && local === false && linuxManifest === "matches";
  const reason = !main
    ? `not a push or manual run on ${RELEASE_REF} of ${RELEASE_REPOSITORY}`
    : local === true
      ? "it declares the local test program id, which the live runtime refuses"
      : local === null
        ? "its program id was not compared with the local test program id"
        : linuxManifest === null
          ? "its Linux build manifest has not been compared yet"
          : RELEASE_REASONS[linuxManifest] ?? `an unknown Linux manifest outcome ${JSON.stringify(linuxManifest)}`;
  return { candidate, label: candidate ? CANDIDATE_LABEL : NOT_A_RELEASE_LABEL, reason, rule: RELEASE_RULE };
}

/** The step summary's release line. */
export function releaseLine(release) {
  const verdict = release.confirmed
    ? "**release**"
    : release.candidate ? "**release candidate, unconfirmed until app passes**" : "**not a release artifact**";
  return `- release: ${verdict} (${release.reason}). ${release.rule}`;
}

export function programRecord({ libRs, anchorToml, so, localTestId = null, toolchain = null, commit = null, run = null, image = null }) {
  const programId = declaredProgramId(libRs);
  const key = base58Decode(programId);
  if (key.length !== 32) throw new Error(`declared program ID ${programId} is ${key.length} bytes, not 32`);

  const named = anchorProgramIds(anchorToml, "merrymen_vault");
  if (named.length === 0) throw new Error("Anchor.toml names no merrymen_vault program ID");
  for (const { cluster, id } of named) {
    if (id !== programId) throw new Error(`Anchor.toml [programs.${cluster}] names ${id}, but lib.rs declares ${programId}`);
  }

  if (so.length < 4 || so.readUInt32BE(0) !== 0x7f454c46) throw new Error("the artifact is not an ELF file");
  const programIdOccurrences = countOccurrences(so, key);
  if (programIdOccurrences === 0) throw new Error(`the artifact does not contain the declared program ID ${programId}`);

  if (localTestId !== null && (typeof localTestId !== "string" || base58Decode(localTestId).length !== 32)) {
    throw new Error(`the local test program ID ${JSON.stringify(localTestId)} is not a 32-byte key`);
  }
  return {
    program: "merrymen_vault",
    programId,
    programIdOccurrences,
    // SOLANA_VAULT_LOCAL_TEST_PROGRAM: a build that declares it is never a release.
    localTestId,
    declaresLocalTestId: declaresLocalTestId({ programId, localTestId }),
    bytes: so.length,
    sha256: createHash("sha256").update(so).digest("hex"),
    // The deployed ProgramData region is the artifact followed by zero
    // padding up to max-len, so its hash equals sha256 only when max-len
    // equals bytes (the CLI default). Otherwise hash the artifact plus
    // (max-len - bytes) zero bytes.
    regionNote: "ProgramData region SHA-256 equals sha256 only for max-len == bytes",
    toolchain,
    // The runner image (ImageOS, ImageVersion): named, not digest-pinned.
    runnerImage: image,
    // GITHUB_SHA: the pushed commit, or a pull request's test merge commit.
    commit,
    provenance: run,
    release: releaseStatus(run, null, { programId, localTestId }),
  };
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--runner-image") {
    const section = runnerImageSection(process.env);
    process.stdout.write(`${runnerImageLine(runnerImage(process.env))}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, section);
    return;
  }
  if (argv.length !== 3) {
    console.error("usage: solana-program-record.mjs <contracts/solana dir> <program .so> <record.json> | --runner-image");
    process.exit(2);
  }
  const [programRoot, soPath, outPath] = argv;
  const here = dirname(fileURLToPath(import.meta.url));
  const run = provenance(process.env);
  const record = programRecord({
    libRs: readFileSync(join(programRoot, "programs/merrymen-vault/src/lib.rs"), "utf8"),
    anchorToml: readFileSync(join(programRoot, "Anchor.toml"), "utf8"),
    so: readFileSync(soPath),
    localTestId: readLocalTestProgramId(join(here, "..", "..")),
    toolchain: readToolchain(readFileSync(join(here, "solana-toolchain.env"), "utf8")),
    commit: run.commit,
    run,
    image: runnerImage(process.env),
  });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const t = record.toolchain;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "### merrymen_vault SBF artifact",
      "",
      `- program ID: \`${record.programId}\` (its 32 bytes appear ${record.programIdOccurrences} time(s) in the binary)`,
      record.declaresLocalTestId
        ? "- **the local test program ID** (SOLANA_VAULT_LOCAL_TEST_PROGRAM), which the live runtime refuses: never a release; its Linux manifest is a reproducibility baseline only"
        : `- not the local test program ID \`${record.localTestId}\``,
      `- size: ${record.bytes} bytes`,
      `- SHA-256: \`${record.sha256}\``,
      `- toolchain: agave ${t.agave}, platform-tools ${t.platformTools} (rustc ${t.platformToolsRustc}), arch ${t.arch}`,
      runnerImageLine(record.runnerImage),
      `- commit: ${record.commit ?? "unknown"}${run.pullRequestHead ? ` (test merge of pull request head ${run.pullRequestHead})` : ""}`,
      `- run: ${run.runId ?? "unknown"} attempt ${run.runAttempt ?? "?"}, ${run.event ?? "unknown event"} on ${run.ref ?? "unknown ref"} of ${run.repository ?? "unknown repository"}`,
      releaseLine(record.release),
      "",
    ].join("\n"));
  }
  process.stdout.write(`${record.sha256}\n`);
}

// Real paths on both sides: run through a symlink (macOS /tmp), the plain
// comparison would skip main and exit 0 having checked nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
