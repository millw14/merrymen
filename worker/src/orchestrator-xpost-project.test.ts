import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicClient } from "viem";
import { readPublicProjectDescription } from "./orchestrator-xpost-project";
import type { TokenMeta } from "./venues/pons-meta";

const TOKEN = `0x${"ab".repeat(20)}` as const;
const OTHER = `0x${"cd".repeat(20)}` as const;
const client = { getChainId: async () => 4663 } as unknown as PublicClient;
const meta = { token: TOKEN, description: "A community tool for sharing local art." } as TokenMeta;

test("public project source binds both the RPC chain and exact token; only a bounded description leaves the reader", async () => {
  const readMeta = async (_client: PublicClient, tokens: readonly `0x${string}`[]) => {
    assert.deepEqual(tokens, [TOKEN]);
    return new Map([[TOKEN, { ...meta, website: "https://private-not-read.example", description: "  Art\u202e sharing\n" + "x".repeat(300) }]]);
  };
  const source = await readPublicProjectDescription(TOKEN.toUpperCase().replace("0X", "0x"), 4663, { client, readMeta });
  assert.equal(source?.token, TOKEN);
  assert.equal(source?.chainId, 4663);
  assert.ok(source!.description.length <= 180);
  assert.doesNotMatch(source!.description, /\u202e|\n|private/);
  assert.deepEqual(Object.keys(source!).sort(), ["chainId", "description", "token"]);
  let calls = 0;
  const never = async () => { calls++; return new Map([[TOKEN, meta]]); };
  assert.equal(await readPublicProjectDescription(TOKEN, 46630, { client, readMeta: never }), null);
  assert.equal(await readPublicProjectDescription("pepe", 4663, { client, readMeta: never }), null);
  assert.equal(await readPublicProjectDescription(TOKEN, 4663, { client: { getChainId: async () => 46630 } as unknown as PublicClient, readMeta: never }), null);
  assert.equal(calls, 0);
  assert.equal(await readPublicProjectDescription(TOKEN, 4663, { client, readMeta: async () => new Map([[TOKEN, { ...meta, token: OTHER }]]) }), null);
});

test("public description is absent on missing, failed, slow or figure-bearing metadata", async () => {
  for (const description of ["", "earn 100x", "visit https://example.com", "contact @owner"]) {
    assert.equal(await readPublicProjectDescription(TOKEN, 4663, { client, readMeta: async () => new Map([[TOKEN, { ...meta, description }]]) }), null);
  }
  assert.equal(await readPublicProjectDescription(TOKEN, 4663, { client, readMeta: async () => new Map() }), null);
  assert.equal(await readPublicProjectDescription(TOKEN, 4663, { client, readMeta: async () => { throw new Error("RPC unavailable"); } }), null);
  assert.equal(await readPublicProjectDescription(TOKEN, 4663, { client, readMeta: async () => new Promise(() => {}), budgetMs: 5 }), null);
});
