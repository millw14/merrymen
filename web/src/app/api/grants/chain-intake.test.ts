/**
 * POST /api/grants TAKES A GRANT FOR ROBINHOOD CHAIN OR ITS TESTNET, AND
 * NOTHING ELSE.
 *
 * Nothing checked chainId before, and what reads it downstream maps any id
 * but the testnet to mainnet, so a grant for chain 1, a Solana grant or one
 * with no chainId was stored and read as Robinhood Chain. Driven through the
 * real handler, self-hosted, against a real home: a refusal must leave
 * grant.json and the archive exactly as they were. The hosted refusal, with a
 * really signed claim, is in canonical-wall.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { CHAINS } from "@merrymen/core";

const A = "0xbC78E8b5d209Bf1D4706faEd06e155B5774275D7";
const B = "0x1111111111111111111111111111111111111111";

let home = "";
let POST: (req: Request) => Promise<Response>;
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, grant: process.env.MERRYMEN_GRANT_FILE };

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-chain-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_GRANT_FILE;
  // After the env: the route resolves its paths when it loads.
  ({ POST } = await import("./route"));
});
after(() => {
  for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["MERRYMEN_GRANT_FILE", saved.grant]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const grantFile = () => path.join(home, "grant.json");
const archiveDir = () => path.join(home, "grants");
const LIVE = `{\n  "smartAccount": "${A}",\n  "serialized": "0xserialized",\n  "chainId": 4663\n}\n`;

beforeEach(() => {
  rmSync(archiveDir(), { recursive: true, force: true });
  writeFileSync(grantFile(), LIVE);
});

async function post(grant: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(grant) }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; code?: string } };
}

describe("POST /api/grants, self-hosted — the chain id", () => {
  it("refuses every id that is not 4663 or 46630, and leaves grant.json and the archive alone", async () => {
    const refused: unknown[] = [1, 0, -1, 46631, 4663.5, 8453, "4663", "46630", null, true, [4663], { id: 4663 }, CHAINS.robinhood, CHAINS.solana];
    for (const chainId of refused) {
      const res = await post({ smartAccount: B, serialized: "0xserialized", chainId });
      assert.equal(res.status, 400, `${JSON.stringify(chainId)}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "unsupported_chain");
      assert.equal(
        res.body.error,
        `this grant is for chain ${JSON.stringify(chainId)}, and Merrymen only runs on Robinhood Chain (4663) and its testnet (46630). Nothing was saved.`,
      );
      assert.equal(readFileSync(grantFile(), "utf8"), LIVE, "the grant in place is untouched");
      assert.equal(existsSync(archiveDir()), false, "nothing was archived for a grant that was never taken");
    }
  });

  it("a grant with no chainId names no chain", async () => {
    const res = await post({ smartAccount: B, serialized: "0xserialized" });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "unsupported_chain");
    assert.match(res.body.error ?? "", /^this grant names no chain, and Merrymen only runs on Robinhood Chain \(4663\)/);
    assert.equal(readFileSync(grantFile(), "utf8"), LIVE);
  });

  it("keeps a long id out of the message past 64 characters", async () => {
    const res = await post({ smartAccount: B, serialized: "0xserialized", chainId: "9".repeat(500) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, `this grant is for chain "${"9".repeat(63)}, and Merrymen only runs on Robinhood Chain (4663) and its testnet (46630). Nothing was saved.`);
  });

  it("takes 4663 and 46630 exactly as before", async () => {
    for (const chainId of [4663, 46630]) {
      const res = await post({ smartAccount: B, serialized: "0xserialized", chainId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { ok: true });
      assert.deepEqual(JSON.parse(readFileSync(grantFile(), "utf8")), { smartAccount: B, serialized: "0xserialized", chainId });
    }
  });

  it("a malformed grant is still 'not a grant', whatever its chain", async () => {
    const res = await post({ serialized: "0xserialized", chainId: 1 });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "not a grant" });
  });
});
