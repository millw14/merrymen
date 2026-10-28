import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { after, before, test, mock } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "../../../../lib/solana-api";
import * as auth from "../../../../lib/solana-auth";
import * as bindings from "../../../../lib/solana-binding-store";
import { SOLANA_STATUS_BURST, SOLANA_STATUS_REFILL_MS, takeSolanaStatusToken } from "./throttle";

test("one tenant looping its Solana status is paced; others are not", () => {
  const a = `0x${"a1".repeat(20)}`, b = `0x${"b2".repeat(20)}`, t = 1_000_000;
  for (let i = 0; i < SOLANA_STATUS_BURST; i++) assert.equal(takeSolanaStatusToken(a, t), null, `burst read ${i + 1}`);
  assert.equal(takeSolanaStatusToken(a, t), Math.ceil(SOLANA_STATUS_REFILL_MS / 1000), "the next read waits for one refill");
  assert.notEqual(takeSolanaStatusToken(`0x${"A1".repeat(20)}`, t), null, "the tenant key ignores case");
  assert.equal(takeSolanaStatusToken(b, t), null, "another tenant keeps its own burst");
  assert.equal(takeSolanaStatusToken(a, t + SOLANA_STATUS_REFILL_MS), null, "a refill allows one more read");
  assert.notEqual(takeSolanaStatusToken(a, t + SOLANA_STATUS_REFILL_MS), null);
});

// The real route, with sign-in, the binding store and the runtime stood in.
const tenant = `0x${"c3".repeat(20)}`, did = "did:privy:looper";
let statusCalls = 0;
let GET: (req: Request) => Promise<Response>;
const flag = process.env.MERRYMEN_SOLANA;
before(() => {
  process.env.MERRYMEN_SOLANA = "1";
  const directory = fileURLToPath(new URL("./", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const interception = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename?.startsWith(directory)) {
      if (id === "@/lib/solana-auth") return { ...auth, authenticateSolana: async () => ({ tenant, did }) };
      if (id === "@/lib/solana-binding-store") return { ...bindings, getSolanaBindingStore: () => ({ get: async () => ({ tenant, did, owner: "So11111111111111111111111111111111111111112" }) }) };
      if (id === "@/lib/solana-api") return api;
      if (id.endsWith("worker/src/solana-app-runtime")) return { getSolanaAppRuntime: () => ({ status: async () => { statusCalls++; return { fixture: true }; } }) };
    }
    return original.call(this, id, parent, isMain);
  });
  try { GET = (createRequire(import.meta.url)(`${directory}route.ts`) as { GET: typeof GET }).GET; }
  finally { interception.mock.restore(); }
});
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });

test("GET /api/solana/status in a tight loop reaches the runtime only for the burst (audit web-auth F1)", async () => {
  const codes: number[] = [];
  for (let i = 0; i < SOLANA_STATUS_BURST + 15; i++) codes.push((await GET(new Request("https://app.example.test/api/solana/status"))).status);
  assert.equal(statusCalls, SOLANA_STATUS_BURST, "RPC-backed status runs at most a burst's worth");
  assert.deepEqual(codes.slice(0, SOLANA_STATUS_BURST), Array(SOLANA_STATUS_BURST).fill(200));
  assert.ok(codes.slice(SOLANA_STATUS_BURST).every(code => code === 429), codes.join(","));
});
