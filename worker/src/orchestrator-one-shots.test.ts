/**
 * EVERY ORCHESTRATOR ONE-SHOT IS COUNTED FROM THE COMMIT THAT ADDS IT — the
 * half of the deploy guard's one-shot census that reads orchestrator.ts itself.
 *
 * deploy-guard-checks.ts counts operator one-shot variables (REPAIR_*,
 * ANNOUNCE_*, …) and the start guard refuses an orchestrator that boots with
 * one set while the rollout is not `all`. This file keeps that list honest:
 * every `run…IfAsked` body may name only counted one-shots and listed standing
 * configuration, a gate read by a helper is listed with it, and anything else
 * runOrchestrator runs is named below as a standing pass.
 *
 * It lives here, not in deploy-guard.test.ts, because naming every pass
 * runOrchestrator starts names the group chat's, and groupchat/boundary.test.ts
 * lets only the orchestrator's own files mention the room.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isOneShotVariable } from "./deploy-guard-checks";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("every orchestrator one-shot is counted from the commit that adds it", () => {
  const src = read("worker/src/orchestrator.ts");
  /** A top-level function's text: its header to its closing brace at column 0 — not to the end of the file. */
  const bodyAt = (text: string, index: number) => {
    const end = text.slice(index).search(/^}/m);
    assert.ok(end > 0, "a top-level function without a closing brace at column 0");
    return text.slice(index, index + end + 1);
  };
  const ONE_SHOT_FN = /^(?:export )?(?:async )?function (run\w+(?:IfAsked|OnBoot|Once))\(/gm;
  const oneShots = [...src.matchAll(ONE_SHOT_FN)].map((m) => ({ fn: m[1]!, body: bodyAt(src, m.index!) }));
  /** Standing configuration a one-shot may read beside its gate — never an action of its own. */
  const STANDING_READS = new Set(["MERRYMEN_RPC_MAINNET", "MERRYMEN_RPC_TESTNET", "MERRYMEN_CHAIN_ID", "MERRYMEN_STORE_DEK"]);
  /** One-shots whose gate a helper in another module reads: function → [module, helper, gate]. */
  const HELPER_GATES: Record<string, [string, string, string]> = {
    runRepairIfAsked: ["worker/src/accounting-repair.ts", "parseRepairOptions", "MERRYMEN_REPAIR"],
    runReceiptAttestationIfAsked: ["worker/src/receipt-attestation-controls.ts", "receiptAttestationRequest", "MERRYMEN_RECEIPT_ATTEST_ACCOUNT"],
  };
  /** What runOrchestrator runs that is NOT a one-shot, each for a reason. */
  const STANDING_PASSES = new Set([
    "runOrchestrator",
    "runRecoveryReportOnly", // MERRYMEN_FLEET_RECOVERY_REPORT_ONLY: a recovery mode, not an action
    "runAccountingReconstructionAtStartup", // runs runReconstructionDryRunIfAsked, which is held here
    "runHolderClaimsBackfill", "startHistoryRepair", // every boot or pass, on no variable
    "runBuilderPass", "runNewsPass", "startGroupChatPass", "startXPostPass", // every pass, standing features
    "startFleetHeartbeat", // every pass, halted or not, on no variable: the fleet_heartbeat row (fleet-heartbeat.ts)
    "startFomoPass", // every pass, a standing feature behind its own opt-in (MERRYMEN_FOMO_ENABLED, docs/fomo.md): research only, it places no order
    // MERRYMEN_RESUME_PREVIEW / _APPROVE / _REVOKE: the staged rollout's own admission controls (ledger-resume.ts,
    // docs/fleet-resume.md), idempotent per (tenant, evidence digest) and read every boot like MERRYMEN_FLEET_ROLLOUT.
    // Counted as one-shots, the guard would refuse the very boot that approves the first tenant.
    "runResumeAdmissionControls",
  ]);

  it("finds them where they are", () => {
    assert.ok(oneShots.length >= 17, `found only ${oneShots.length} one-shot functions — has the pattern changed?`);
  });

  it("each names, in its own body, only counted one-shots and listed standing configuration", () => {
    for (const { fn, body } of oneShots) {
      const names = [...new Set(body.match(/MERRYMEN_[A-Z0-9_]+/g) ?? [])];
      const unclassified = names.filter((n) => !isOneShotVariable(n) && !STANDING_READS.has(n));
      assert.deepEqual(unclassified, [], `${fn} reads ${unclassified.join(" ")}: count it in the census, or list it here as standing`);
      if (HELPER_GATES[fn]) continue;
      assert.ok(names.some(isOneShotVariable), `${fn} names no counted variable itself — if a helper reads its gate, list it in HELPER_GATES`);
    }
  });

  it("a gate read by a helper is counted, and still read there", () => {
    for (const [fn, [file, helper, gate]] of Object.entries(HELPER_GATES)) {
      const own = oneShots.find((o) => o.fn === fn);
      assert.ok(own, `${fn} is gone — drop it from HELPER_GATES`);
      assert.match(own.body, new RegExp(`\\b${helper}\\(`), `${fn} no longer gates through ${helper}`);
      const text = read(file), at = text.search(new RegExp(`^export function ${helper}\\(`, "m"));
      assert.ok(at >= 0, `${helper} is not in ${file}`);
      assert.match(bodyAt(text, at), new RegExp(`\\b${gate}\\b`), `${helper} no longer reads ${gate}`);
      assert.ok(isOneShotVariable(gate), `${gate}, ${fn}'s gate, is not counted`);
    }
  });

  it("everything runOrchestrator runs is a one-shot held above, or a standing pass named here", () => {
    const main = bodyAt(src, src.search(/^export async function runOrchestrator\(/m));
    const called = [...new Set(main.match(/\b(?:run|start)[A-Z]\w*\b/g) ?? [])];
    const held = new Set(oneShots.map((o) => o.fn));
    const neither = called.filter((fn) => !held.has(fn) && !STANDING_PASSES.has(fn));
    assert.deepEqual(neither, [], "a new pass in runOrchestrator: a one-shot is named run…IfAsked, anything else is listed as standing");
  });
});
