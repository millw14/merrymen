import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "../../../../lib/solana-api";
import * as auth from "../../../../lib/solana-auth";
import * as bindings from "../../../../lib/solana-binding-store";
import { CHAINS } from "../../../../../../packages/core/src/ids";
import { SOLANA_OWNER_PACE, takeSolanaOwnerToken } from "./throttle";

test("one tenant looping owner requests is paced per bucket; other tenants and the other buckets are not", () => {
  const a = `0x${"a1".repeat(20)}`, b = `0x${"b2".repeat(20)}`, t = 1_000_000;
  for (const bucket of ["revoke", "prepare", "submit"] as const) {
    const { burst, refillMs } = SOLANA_OWNER_PACE[bucket];
    for (let i = 0; i < burst; i++) assert.equal(takeSolanaOwnerToken(a, bucket, t), null, `${bucket} burst ${i + 1}`);
    assert.equal(takeSolanaOwnerToken(a, bucket, t), Math.ceil(refillMs / 1000), `${bucket}: the next waits for one refill`);
    assert.notEqual(takeSolanaOwnerToken(`0x${"A1".repeat(20)}`, bucket, t), null, "the tenant key ignores case");
    assert.equal(takeSolanaOwnerToken(b, bucket, t), null, "another tenant keeps its own burst");
    assert.equal(takeSolanaOwnerToken(a, bucket, t + refillMs), null, "a refill allows one more");
    assert.notEqual(takeSolanaOwnerToken(a, bucket, t + refillMs), null);
  }
  // Spent prepares never cost the emergency revoke, nor a resubmission of signed bytes.
  const c = `0x${"c3".repeat(20)}`;
  for (let i = 0; i < SOLANA_OWNER_PACE.prepare.burst; i++) takeSolanaOwnerToken(c, "prepare", t);
  assert.notEqual(takeSolanaOwnerToken(c, "prepare", t), null);
  assert.equal(takeSolanaOwnerToken(c, "revoke", t), null);
  assert.equal(takeSolanaOwnerToken(c, "submit", t), null);
});

// The real owner and setup routes, with sign-in, the binding and the runtime stood in.
const tenant = `0x${"d4".repeat(20)}` as const, owner = "So11111111111111111111111111111111111111112";
const ran: string[] = [];
const routes: Record<string, (req: Request) => Promise<Response>> = {};
const flag = process.env.MERRYMEN_SOLANA;
before(() => {
  process.env.MERRYMEN_SOLANA = "1";
  const base = fileURLToPath(new URL("../", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename?.startsWith(base) && !parent.filename.endsWith("throttle.ts")) {
      if (id === "@/lib/solana-auth") return auth;
      if (id === "@/lib/solana-api") return { ...api, solanaContext: async () => ({ principal: { tenant, did: "did:privy:looper" }, scope: { tenant, owner },
        binding: { tenant, did: "did:privy:looper", owner, chain: CHAINS.solana, requestedMode: "live",
          limits: { perTradeUsdg: "1", dailyUsdg: "1", maxOpsPerDay: 1, maxDrawdownBps: 1, expiresAtMs: 1 }, strategy: null, revision: 1, createdAtMs: 1, updatedAtMs: 1 } satisfies bindings.SolanaBinding }) };
      if (id.endsWith("worker/src/solana-app-runtime")) return { getSolanaAppRuntime: () => Object.fromEntries(
        ["prepareOwnerAction", "submitOwnerAction", "prepareLive", "submitSetup", "activateLive"].map(method => [method, async (...args: unknown[]) => {
          ran.push(method === "prepareOwnerAction" ? `prepare:${(args[1] as { action: string }).action}` : method); return { fixture: true };
        }])) };
    }
    return original.call(this, id, parent, isMain);
  });
  try {
    for (const route of ["owner", "setup"]) routes[route] = (createRequire(import.meta.url)(`${base}${route}/route.ts`) as { POST: (req: Request) => Promise<Response> }).POST;
  } finally { interception.mock.restore(); }
});
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });
beforeEach(() => { ran.length = 0; });
const post = (route: string, body: unknown) => routes[route]!(new Request(`https://app.example.test/api/solana/${route}`, { method: "POST", body: JSON.stringify(body) }));
const statuses = async (route: string, body: unknown, times: number) => { const codes: number[] = []; for (let i = 0; i < times; i++) codes.push((await post(route, body)).status); return codes; };

test("owner and permission prepares in a tight loop reach the runtime only for the burst; a paced one runs nothing, and the revoke keeps its own bucket", async () => {
  const { prepare, revoke, submit } = SOLANA_OWNER_PACE;
  // A malformed request is refused before pacing and costs no token.
  assert.equal((await post("owner", { stage: "prepare", action: "withdraw" })).status, 400);
  // Withdrawals and permissions share the prepare bucket: one owner, one saved owner transaction.
  const withdraw = { stage: "prepare", action: "withdraw", mint: owner, amountRaw: "1" };
  assert.deepEqual(await statuses("owner", withdraw, prepare.burst - 1), Array(prepare.burst - 1).fill(200));
  assert.deepEqual(await statuses("setup", { stage: "prepare", sessionPublicKey: owner }, 2), [200, 429]);
  const paced = await post("owner", { stage: "prepare", action: "resume-buys" });
  assert.equal(paced.status, 429);
  assert.match((await paced.json() as { error: string }).error, /^Too many Solana owner requests\. Nothing was prepared\. Try again in \d+ seconds?\.$/);
  assert.deepEqual(ran, [...Array(prepare.burst - 1).fill("prepare:withdraw"), "prepareLive"], "a paced prepare reaches no runtime");
  // The emergency revoke is not delayed by spent prepares.
  ran.length = 0;
  assert.deepEqual(await statuses("owner", { stage: "prepare", action: "revoke" }, revoke.burst + 2), [...Array(revoke.burst).fill(200), 429, 429]);
  assert.deepEqual(ran, Array(revoke.burst).fill("prepare:revoke"));
  // Submitting and activating share the submit bucket, untouched by the prepares; a paced submission speaks only for itself.
  ran.length = 0;
  assert.deepEqual(await statuses("owner", { stage: "submit", signedTransactionBase64: "AQID" }, submit.burst - 1), Array(submit.burst - 1).fill(200));
  assert.equal((await post("setup", { stage: "activate", signature: "s", sessionSecretKey: "k" })).status, 200);
  const pacedSubmit = await post("setup", { stage: "submit", signedTransactionBase64: "AQID" });
  assert.equal(pacedSubmit.status, 429);
  const message = (await pacedSubmit.json() as { error: string }).error;
  assert.match(message, /^Too many Solana owner requests\. This request was not processed; a transaction you already signed and submitted is unaffected\. Refresh to check it, then try again in \d+ seconds?\.$/);
  assert.doesNotMatch(message, /nothing was (sent|prepared)/i);
  assert.deepEqual(ran, [...Array(submit.burst - 1).fill("submitOwnerAction"), "activateLive"]);
});
