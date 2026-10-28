import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { after, before, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "../../../../lib/solana-api";
import * as auth from "../../../../lib/solana-auth";
import * as bindings from "../../../../lib/solana-binding-store";
import { CHAINS } from "../../../../../../packages/core/src/ids";
import { SOLANA_INTENT_PACE, takeSolanaIntentToken } from "./throttle";

test("one tenant looping previews or trades is paced per action; other tenants and the other action are not", () => {
  const a = `0x${"a1".repeat(20)}`, b = `0x${"b2".repeat(20)}`, t = 1_000_000;
  for (const action of ["preview", "trade"] as const) {
    const { burst, refillMs } = SOLANA_INTENT_PACE[action];
    for (let i = 0; i < burst; i++) assert.equal(takeSolanaIntentToken(a, action, t), null, `${action} burst ${i + 1}`);
    assert.equal(takeSolanaIntentToken(a, action, t), Math.ceil(refillMs / 1000), `${action}: the next waits for one refill`);
    assert.notEqual(takeSolanaIntentToken(`0x${"A1".repeat(20)}`, action, t), null, "the tenant key ignores case");
    assert.equal(takeSolanaIntentToken(b, action, t), null, "another tenant keeps its own burst");
    assert.equal(takeSolanaIntentToken(a, action, t + refillMs), null, "a refill allows one more");
    assert.notEqual(takeSolanaIntentToken(a, action, t + refillMs), null);
  }
  // Spent previews never cost a trade, and the reverse: an exit stays placeable while previews are paced.
  const c = `0x${"c3".repeat(20)}`;
  for (let i = 0; i < SOLANA_INTENT_PACE.preview.burst; i++) takeSolanaIntentToken(c, "preview", t);
  assert.notEqual(takeSolanaIntentToken(c, "preview", t), null);
  assert.equal(takeSolanaIntentToken(c, "trade", t), null);
});

// The real route, with sign-in, the binding and the runtime stood in.
const tenant = `0x${"d4".repeat(20)}` as const, owner = "So11111111111111111111111111111111111111112";
const ran: string[] = [];
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
      if (id === "@/lib/solana-api") return { ...api, solanaContext: async () => ({ principal: { tenant, did: "did:privy:looper" }, scope: { tenant, owner },
        binding: { tenant, did: "did:privy:looper", owner, chain: CHAINS.solana, requestedMode: "paper", limits: null, strategy: null, revision: 1, createdAtMs: 1, updatedAtMs: 1 } satisfies bindings.SolanaBinding }) };
      if (id.endsWith("worker/src/solana-app-runtime")) return { getSolanaAppRuntime: () => ({
        preview: async () => { ran.push("preview"); return { fixture: true }; }, trade: async () => { ran.push("trade"); return { fixture: true }; } }) };
    }
    return original.call(this, id, parent, isMain);
  });
  try { POST = (createRequire(import.meta.url)(`${directory}route.ts`) as { POST: typeof POST }).POST; }
  finally { interception.mock.restore(); }
});
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });
beforeEach(() => { ran.length = 0; });
const post = (action: string, mode = "paper") => POST(new Request("https://app.example.test/api/solana/intent", { method: "POST", body: JSON.stringify({ mode, action, intent: { requestId: "x" } }) }));

test("POST /api/solana/intent in a tight loop reaches the runtime only for each action's burst, and a paced trade speaks only for its own request", async () => {
  const { preview, trade } = SOLANA_INTENT_PACE;
  const codes: number[] = [];
  for (let i = 0; i < preview.burst + 5; i++) codes.push((await post("preview")).status);
  assert.deepEqual(codes, [...Array(preview.burst).fill(200), ...Array(5).fill(429)]);
  const paced = await post("preview");
  assert.equal(paced.status, 429); assert.match((await paced.json() as { error: string }).error, /^Too many Solana previews\. Try again in \d+ seconds?\.$/);
  // Previews are spent, but trades have their own bucket.
  const trades: number[] = [];
  for (let i = 0; i < trade.burst + 3; i++) trades.push((await post("trade")).status);
  assert.deepEqual(trades, [...Array(trade.burst).fill(200), ...Array(3).fill(429)]);
  // A retry of an earlier trade keeps its request id, and that attempt may have been sent: the answer speaks only for this request.
  const pacedTrade = (await (await post("trade")).json() as { error: string }).error;
  assert.match(pacedTrade, /^Too many Solana trade requests\. This request was not processed; a trade you already placed is unaffected\. Refresh to check it, then try again in \d+ seconds?\.$/);
  assert.doesNotMatch(pacedTrade, /nothing was sent/i);
  assert.deepEqual(ran, [...Array(preview.burst).fill("preview"), ...Array(trade.burst).fill("trade")]);
  // A request refused for its mode is answered for its mode before pacing, and never reaches the runtime.
  assert.equal((await post("trade", "live")).status, 409);
  assert.deepEqual(ran, [...Array(preview.burst).fill("preview"), ...Array(trade.burst).fill("trade")]);
});
