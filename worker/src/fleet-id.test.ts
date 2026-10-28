/**
 * THE ONE FLEET-ID PARSER (fleet-id.ts): what it accepts, what it calls
 * unsupported, and that every orchestrator read of an operator variable
 * naming tenants or accounts goes through it.
 *
 * Each caller's own unsupported branch is tested beside that caller:
 * fleet-rollout.test.ts, accounting-maintenance.test.ts,
 * new-tenant-admission.test.ts, ledger-resume.test.ts, and through the real
 * orchestrator in orchestrator-fleet-id.integration.test.ts and
 * orchestrator-drain.integration.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evmFleetId, fleetIdScope, fleetIdTarget, parseFleetId, unsupportedFleetIdLabel } from "./fleet-id";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";

const A = "0x1111111111111111111111111111111111111111";
const MIXED = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
/** A real 32-byte Solana key (the USDG mint): case-sensitive, never folded. */
const SOL = SOLANA_USDG_MINT;
const SOL_AGENT = `sol:${SOL}`;
/** The shape the parser had to agree with, in every caller that checked an id itself. */
const OLD_EVM = /^0x[0-9a-fA-F]{40}$/;

describe("parseFleetId", () => {
  it("reads a 0x address, any case, as its lowercase id", () => {
    assert.deepEqual(parseFleetId(A), { kind: "evm", id: A });
    assert.deepEqual(parseFleetId(MIXED), { kind: "evm", id: MIXED.toLowerCase() });
    assert.equal(evmFleetId(MIXED), MIXED.toLowerCase());
  });

  it("calls every other id unsupported, kept exactly as written", () => {
    for (const raw of [SOL_AGENT, SOL, "rh:ABC-123", "0x123", `0X${A.slice(2)}`, ` ${A}`, `${A} `, `${A}\n`, `0x${"ab".repeat(32)}`, "everyone", "0x"]) {
      assert.deepEqual(parseFleetId(raw), { kind: "unsupported", raw }, JSON.stringify(raw));
      assert.equal(evmFleetId(raw), null);
    }
    // Never case-folded: a lowercased Solana key is a different key.
    assert.equal((parseFleetId(SOL_AGENT) as { raw: string }).raw, SOL_AGENT);
  });

  it("is null for what is no id at all", () => {
    for (const raw of ["", undefined, null, 42, {}, ["0x"]]) assert.equal(parseFleetId(raw), null, String(raw));
  });

  it("accepts exactly what the callers' own checks accepted", () => {
    const corpus = [A, MIXED, A.toUpperCase(), `0X${A.slice(2)}`, `${A}0`, A.slice(0, -1), `0x${"g".repeat(40)}`, ` ${A}`, `${A}\t`, SOL, SOL_AGENT, "", "0x"];
    for (const raw of corpus) assert.equal(parseFleetId(raw)?.kind === "evm", OLD_EVM.test(raw), JSON.stringify(raw));
  });
});

describe("unsupportedFleetIdLabel", () => {
  it("names a Solana id as one, bare or as an agent id", () => {
    assert.equal(unsupportedFleetIdLabel(SOL_AGENT), `Solana id ${JSON.stringify(SOL_AGENT)}`);
    assert.equal(unsupportedFleetIdLabel(SOL), `Solana id ${JSON.stringify(SOL)}`);
    assert.equal(unsupportedFleetIdLabel("rh:ABC"), 'id "rh:ABC"');
    assert.equal(unsupportedFleetIdLabel("sol:not-base58!"), 'id "sol:not-base58!"');
  });

  it("is quoted and cut, so a stray name can never forge a log line", () => {
    const label = unsupportedFleetIdLabel(`x\n[alert] forged ${"y".repeat(200)}`);
    assert.ok(!label.includes("\n"), label);
    assert.ok(label.length < 100, label);
  });
});

describe("fleetIdTarget: an operator variable naming one tenant", () => {
  it("unset or blank names nobody", () => {
    assert.equal(fleetIdTarget("MERRYMEN_X_FOR", undefined), null);
    assert.equal(fleetIdTarget("MERRYMEN_X_FOR", "  "), null);
  });

  it("trims and lowercases first, as those variables always did", () => {
    assert.deepEqual(fleetIdTarget("MERRYMEN_X_FOR", ` ${MIXED} `), { id: MIXED.toLowerCase() });
    assert.deepEqual(fleetIdTarget("MERRYMEN_X_FOR", `0X${A.slice(2)}`), { id: A }, "lowercased before the check, as before");
  });

  it("refuses anything else, naming the variable and never the value", () => {
    for (const raw of [SOL_AGENT, SOL, "0x123", "all"]) {
      const target = fleetIdTarget("MERRYMEN_X_FOR", raw);
      assert.ok(target && "refused" in target, raw);
      assert.match(target.refused, /^MERRYMEN_X_FOR is not a Robinhood Chain tenant address .*refusing to guess/);
      assert.ok(!target.refused.toLowerCase().includes(raw.toLowerCase()), "the value is not echoed");
    }
  });
});

describe("fleetIdScope: an operator variable naming some tenants or accounts", () => {
  it("unset, blank or only commas names nobody, as before", () => {
    for (const raw of [undefined, "", " ", ",", " , ,"]) assert.deepEqual(fleetIdScope("MERRYMEN_X_ONLY", raw), { ids: new Set() }, String(raw));
  });

  it("names exactly the ids the old filter kept, whenever every entry is an address", () => {
    const raw = ` ${A}, ${MIXED} ,${A},, `;
    const old = new Set(raw.split(",").map((t) => t.trim().toLowerCase()).filter((t) => t.startsWith("0x")));
    assert.deepEqual(fleetIdScope("MERRYMEN_X_ONLY", raw), { ids: old });
  });

  it("refuses the whole list on any entry that is not 0x, by position, never echoing it", () => {
    for (const [raw, at] of [[SOL_AGENT, 1], [`${A},${SOL}`, 2], [`${A},,0x123`, 3], [`${A},everyone`, 2]] as const) {
      const scope = fleetIdScope("MERRYMEN_X_ONLY", raw);
      assert.ok("refused" in scope, raw);
      assert.match(scope.refused, new RegExp(`^MERRYMEN_X_ONLY entry ${at} is not a Robinhood Chain address .*refusing the whole list`));
      assert.ok(!scope.refused.includes(SOL) && !scope.refused.includes("everyone"));
    }
  });

  it("the case it exists for: a value naming one Solana tenant is not the whole fleet", () => {
    // The old filter's answer, which every repair read as "no scope given".
    const old = new Set([SOL_AGENT].map((t) => t.trim().toLowerCase()).filter((t) => t.startsWith("0x")));
    assert.equal(old.size, 0);
    assert.ok("refused" in fleetIdScope("MERRYMEN_REPAIR_HWM_ONLY", SOL_AGENT));
  });
});

describe("every orchestrator read of an operator variable naming tenants goes through the parser", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "orchestrator.ts"), "utf8");
  const SCOPES = ["MERRYMEN_REPAIR_HWM_ONLY", "MERRYMEN_REPAIR_HWM_PHANTOM_PROFIT", "MERRYMEN_REPAIR_CLASS_PNL_ONLY", "MERRYMEN_REPAIR_CLASS_CASH_ROW_ONLY", "MERRYMEN_REPAIR_ACCOUNT"];
  const TARGETS = ["MERRYMEN_RESUME_CLASS_ENTRIES_FOR", "MERRYMEN_ENABLE_CLASS_FOR", "MERRYMEN_HALT_CLASS_ENTRIES_FOR", "MERRYMEN_INSPECT_TENANT"];

  for (const [names, parser] of [[SCOPES, "fleetIdScope"], [TARGETS, "fleetIdTarget"]] as const) {
    for (const name of names) {
      it(`${name} is read only by ${parser}`, () => {
        const reads = [...src.matchAll(new RegExp(`process\\.env\\.${name}\\b`, "g"))];
        assert.ok(reads.length > 0, `${name} is no longer read here: drop it from this list`);
        for (const read of reads) {
          const before = src.slice(Math.max(0, read.index! - 80), read.index!);
          assert.match(before, new RegExp(`${parser}\\("${name}", $`), `a read of ${name} that is not ${parser}("${name}", process.env.${name})`);
        }
      });
    }
  }

  it("and no home listing filters tenants by a 0x pattern of its own", () => {
    const at = src.search(/^function childHomeTenants\(/m);
    const body = src.slice(at, at + src.slice(at).search(/^}/m));
    assert.doesNotMatch(body, /\^0x\[0-9a-f\]/);
    assert.match(body, /sayUnsupportedHome\(/);
  });
});
