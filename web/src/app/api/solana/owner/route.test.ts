import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "../../../../lib/solana-api";
import * as auth from "../../../../lib/solana-auth";
import * as bindings from "../../../../lib/solana-binding-store";

// The real owner route, with the authenticated context and the runtime stood in.
const tenant = `0x${"11".repeat(20)}`, owner = "So11111111111111111111111111111111111111112", scope = { tenant, owner };
let calls: Array<{ method: string; args: unknown[] }> = [];
let POST: (req: Request) => Promise<Response>;
const flag = process.env.MERRYMEN_SOLANA;
before(() => {
  process.env.MERRYMEN_SOLANA = "1";
  const directory = fileURLToPath(new URL("./", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename?.startsWith(directory)) {
      if (id === "@/lib/solana-auth") return auth;
      if (id === "@/lib/solana-binding-store") return bindings;
      if (id === "@/lib/solana-api") return { ...api, solanaContext: async () => ({ principal: { tenant, did: "did:privy:owner" }, binding: {}, scope, store: {} }) };
      if (id.endsWith("worker/src/solana-app-runtime")) return { getSolanaAppRuntime: () => Object.fromEntries(["prepareOwnerAction", "submitOwnerAction", "recordExternalWithdrawals"].map(method =>
        [method, async (...args: unknown[]) => { calls.push({ method, args }); return { fixture: true }; }])) };
    }
    return original.call(this, id, parent, isMain);
  });
  try { POST = (createRequire(import.meta.url)(`${directory}route.ts`) as { POST: typeof POST }).POST; }
  finally { interception.mock.restore(); }
});
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });
beforeEach(() => { calls = []; });
const post = (body: unknown) => POST(new Request("https://app.example.test/api/solana/owner", { method: "POST", body: JSON.stringify(body) }));

test("the owner route prepares a native SOL withdrawal for the authenticated owner (audit G1-4)", async () => {
  const response = await post({ stage: "prepare", action: "withdraw-sol", amountRaw: "100" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { prepared: { fixture: true } });
  assert.deepEqual(calls, [{ method: "prepareOwnerAction", args: [scope, { action: "withdraw-sol", amountRaw: "100" }] }]);
});

test("a native SOL withdrawal takes a lamport amount and no token mint", async () => {
  for (const body of [{ stage: "prepare", action: "withdraw-sol" }, { stage: "prepare", action: "withdraw-sol", amountRaw: 100 },
    { stage: "prepare", action: "withdraw-sol", mint: owner, amountRaw: "100" }, { stage: "prepare", action: "withdraw-sol", amountRaw: "100", owner }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test("withdrawals made outside Merrymen are recorded for the authenticated owner by their signatures alone", async () => {
  const response = await post({ stage: "record", action: "external-withdrawals", signatures: ["a", "b"] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { recorded: { fixture: true } });
  assert.deepEqual(calls, [{ method: "recordExternalWithdrawals", args: [scope, { signatures: ["a", "b"] }] }]);
  calls = [];
  for (const body of [{ stage: "record", action: "external-withdrawals" }, { stage: "record", action: "external-withdrawals", signatures: "a" },
    { stage: "record", action: "external-withdrawals", signatures: ["a"], mint: owner }, { stage: "record", action: "withdraw", signatures: ["a"] },
    { stage: "record", action: "external-withdrawals", signatures: ["a"], owner }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});
