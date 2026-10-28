#!/usr/bin/env node
// The release verdict for the vault artifact, made after `app` passed.
//
//   node scripts/ci/solana-release.mjs <release.json> [<repository root>]
//
// `solana · test` uploads the vault before `app` has compared its hash with
// `solana · rebuild`'s, before app · tests and the Postgres suites have
// finished, and before a newer push to main can cancel the run. So the most
// its artifact's name can say is candidate-unconfirmed (a run on main whose
// pinned Linux build matched the committed manifest). `solana · release`
// needs app and runs only when it passed; for such a candidate it runs this
// script, then uploads <release.json> as
// merrymen-vault-release-<commit>-run<id>.<attempt>. That record is the
// release verdict: it names the candidate artifact holding the bytes and the
// SHA-256 they must hash to, which solana · test tested and solana · rebuild
// reproduced. No other step writes a name that says release.
//
// Reads, from the environment (job outputs passed through env, never pasted
// into the script):
//   VAULT_RELEASE_LABEL   solana · test's label: must be candidate-unconfirmed
//   VAULT_ARTIFACT        the name solana · test uploaded under
//   VAULT_TESTED_SHA256   solana · test's artifact hash
//   VAULT_REBUILT_SHA256  solana · rebuild's artifact hash
// and the run's own GITHUB_* variables. Refuses (exit 1, nothing written)
// unless the run is a push or manual run on refs/heads/main of
// millw14/merrymen, the label is candidate-unconfirmed, the artifact name is
// that label's for this commit and run (an earlier attempt of the run
// included: a re-run of app keeps solana · test's upload), and the two hashes
// are equal SHA-256s. app has already checked the hashes; checking them again
// here keeps a record from naming bytes nobody reproduced if the jobs ever
// change. It also refuses a source whose lib.rs declares the local test
// program id (SOLANA_VAULT_LOCAL_TEST_PROGRAM in packages/core/src/solana-live.ts),
// read from the checkout of this same commit (by default this script's own
// repository): the live runtime refuses that id, so its build is never a
// release, even if a run on main labelled it a candidate.
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_LABEL, candidateArtifactName, declaredProgramId, fromMain, provenance, readLocalTestProgramId, RELEASE_REF, RELEASE_REPOSITORY,
  RELEASE_RULE, releaseLine,
} from "./solana-program-record.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const POSITIVE = /^[1-9][0-9]{0,8}$/;

/** What solana · release uploads its record as. */
export function releaseArtifactName({ commit, runId, runAttempt }) {
  return `merrymen-vault-release-${commit}-run${runId}.${runAttempt}`;
}

/** The program a checkout declares and the local test program id, from the repository at `root`. */
export function releaseSource(root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")) {
  return {
    programId: declaredProgramId(readFileSync(join(root, "contracts/solana/programs/merrymen-vault/src/lib.rs"), "utf8")),
    localTestId: readLocalTestProgramId(root),
  };
}

/**
 * The release record for a run whose app check passed. Throws, saying why,
 * for a run that is not a release. `env` is the job's environment; `source`
 * is releaseSource() of the commit the run built.
 */
export function releaseRecord(env, source) {
  const run = provenance(env);
  if (!fromMain(run)) {
    throw new Error(`not a push or manual run on ${RELEASE_REF} of ${RELEASE_REPOSITORY} (${run.event ?? "no event"} on ${run.ref ?? "no ref"} of ${run.repository ?? "no repository"})`);
  }
  if (!/^[0-9a-f]{40}$/.test(run.commit ?? "") || !POSITIVE.test(run.runId ?? "") || !POSITIVE.test(run.runAttempt ?? "")) {
    throw new Error("the run has no commit, run id or attempt");
  }
  const programId = typeof source?.programId === "string" ? source.programId : "";
  const localTestId = typeof source?.localTestId === "string" ? source.localTestId : "";
  if (!programId || !localTestId) throw new Error("the program ID was not compared with the local test program ID");
  if (programId === localTestId) {
    throw new Error(`lib.rs declares the local test program ID ${programId} (SOLANA_VAULT_LOCAL_TEST_PROGRAM), which the live runtime refuses: its build is never a release`);
  }
  const label = env.VAULT_RELEASE_LABEL ?? "";
  if (label !== CANDIDATE_LABEL) {
    throw new Error(`solana · test labelled this run's artifact ${JSON.stringify(label)}, not ${CANDIDATE_LABEL}`);
  }
  const artifact = env.VAULT_ARTIFACT ?? "";
  const attempt = /\.([1-9][0-9]{0,8})$/.exec(artifact)?.[1];
  if (!attempt || Number(attempt) > Number(run.runAttempt) || artifact !== candidateArtifactName(label, { ...run, runAttempt: attempt })) {
    throw new Error(`the candidate artifact ${JSON.stringify(artifact)} is not ${candidateArtifactName(label, { ...run, runAttempt: "<attempt>" })} of this run`);
  }
  const tested = env.VAULT_TESTED_SHA256 ?? "";
  const rebuilt = env.VAULT_REBUILT_SHA256 ?? "";
  if (!HEX64.test(tested)) throw new Error("no vault artifact hash from solana · test");
  if (tested !== rebuilt) throw new Error(`the rebuilt vault artifact ${JSON.stringify(rebuilt)} differs from the tested one ${tested}`);
  return {
    program: "merrymen_vault",
    // lib.rs's declare_id! at this commit: not the local test program ID.
    programId,
    sha256: tested,
    // The bytes are in this artifact of the same run, at
    // target/deploy/merrymen_vault.so beside their build record and the
    // Linux manifest; they must hash to sha256.
    artifact,
    commit: run.commit,
    provenance: run,
    release: {
      candidate: true,
      confirmed: true,
      label: "release",
      reason: "a run on main whose pinned Linux build matched the committed manifest and whose app check passed: solana · rebuild reproduced the tested SHA-256",
      rule: RELEASE_RULE,
    },
  };
}

function main(argv) {
  if (argv.length !== 1 && argv.length !== 2) {
    console.error("usage: solana-release.mjs <release.json> [<repository root>]");
    process.exit(2);
  }
  const record = releaseRecord(process.env, releaseSource(...argv.slice(1)));
  writeFileSync(argv[0], `${JSON.stringify(record, null, 2)}\n`);
  const name = releaseArtifactName(record.provenance);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "### merrymen_vault release",
      "",
      `- record: \`${name}\``,
      `- program ID: \`${record.programId}\` (not the local test program ID)`,
      `- bytes: \`${record.artifact}\` (target/deploy/merrymen_vault.so)`,
      `- SHA-256: \`${record.sha256}\` (tested and rebuilt)`,
      releaseLine(record.release),
      "",
    ].join("\n"));
  }
  console.log(`${name}: ${record.artifact} holds the release, SHA-256 ${record.sha256}`);
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
