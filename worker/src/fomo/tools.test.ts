/**
 * THE TOOL REGISTRY'S CONTRACT: every planned call validates, nothing outside
 * the closed vocabulary does, schemas are closed and bounded, and a model loop
 * is never offered a mutation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { classifyFomoQuestion } from "./intent";
import { FOMO_TOOL_DEFS, MUTATION_TOOL_NAMES, READ_TOOL_NAMES, TOOL_NAMES, parseChain, parseTokenRef, parseTraderRef, toolSpecs } from "./tools";
import type { SubjectMemory } from "./subject-memory";

const NOW = 1_800_000_000_000;
const A = `0x${"a1".repeat(20)}`;
const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const USER = "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

const tokenMemory: SubjectMemory = {
  version: 1,
  subjects: [{ kind: "token", tokenKey: `eip155:4663:${A}`, address: A, chain: "robinhood", symbol: "AAA" }],
  window: null,
  side: null,
  lastIntent: "token-theses",
  dossierRevision: { dossierId: "dsr_1", revision: 4 },
  lastRequestId: "r1",
  updatedAt: NOW - 60_000,
  turn: 1,
};
const traderMemory: SubjectMemory = { ...tokenMemory, subjects: [{ kind: "trader", userId: USER, handle: "CryptoKaleo" }], lastIntent: "trader-holdings", dossierRevision: null };

/** Phrasings that exercise every tool and argument the planner can emit. */
const PHRASES: [string, SubjectMemory | null][] = [
  ["what are the theses on $PEPE", null],
  [`What are the theses on this coin ${A}?`, null],
  [`theses for ${MINT}`, null],
  ["what are the theses on $PEPE on solana", null],
  ["what is @CryptoKaleo holding?", null],
  ["what has trader laifu bought this week", null],
  ["how is @CryptoKaleo doing this month", null],
  ["did @CryptoKaleo sell $PEPE?", null],
  ["what did @CryptoKaleo say about $PEPE", null],
  ["show me the leading traders this week", null],
  ["top 10 traders on fomo today", null],
  ["trending coins on fomo", null],
  ["what are the most held tokens on fomo", null],
  ["any newly graduated coins on fomo?", null],
  ["find smaller coins getting attention", null],
  ["find small caps our traders are buying on solana", null],
  ["which traders are buying $PEPE right now", null],
  ["who is selling $WIF on fomo", null],
  ["what are our 150 traders buying today", null],
  ["what are traders on fomo buying right now", null],
  ["compare the theses on $PEPE and $WIF", null],
  ["analyse $BONK on fomo", null],
  ["deep dive on $BONK using fomo data", null],
  ["is fomo working", null],
  ["research status on fomo", null],
  [`what is user ${USER} holding on fomo`, null],
  ["keep an eye on $WIF for me on fomo", null],
  ["What about the sellers?", tokenMemory],
  ["which of our 150 traders bought this", tokenMemory],
  ["Does that contradict what those traders said?", tokenMemory],
  ["has anything changed since your last analysis", tokenMemory],
  ["compare this with yesterday", tokenMemory],
  ["should we follow this?", tokenMemory],
  ["why didn't you buy it?", tokenMemory],
  ["watch this coin", tokenMemory],
  ["stop watching this coin", tokenMemory],
  ["refresh it", tokenMemory],
  ["what's the status of your research on it", tokenMemory],
  ["what did this trader buy recently", traderMemory],
  ["what is he holding now?", traderMemory],
  ["what has he been saying", traderMemory],
];

describe("the registry", () => {
  it("defines every tool name exactly once, with mutations flagged and owner-only", () => {
    assert.deepEqual(Object.keys(FOMO_TOOL_DEFS).sort(), [...TOOL_NAMES].sort());
    for (const n of MUTATION_TOOL_NAMES) {
      assert.equal(FOMO_TOOL_DEFS[n].mutation, true);
      assert.equal(FOMO_TOOL_DEFS[n].ownerOnly, true);
    }
    for (const n of READ_TOOL_NAMES) assert.equal(FOMO_TOOL_DEFS[n].mutation, false);
    assert.equal(FOMO_TOOL_DEFS.fomo_get_research_status.ownerOnly, true);
  });

  it("every schema is closed, and every property is typed and bounded", () => {
    for (const [name, def] of Object.entries(FOMO_TOOL_DEFS)) {
      const s = def.schema as { type: string; additionalProperties: boolean; properties: Record<string, Record<string, unknown>>; required: string[] };
      assert.equal(s.type, "object", name);
      assert.equal(s.additionalProperties, false, name);
      for (const [p, spec] of Object.entries(s.properties)) {
        const t = spec.type;
        assert.ok(typeof t === "string", `${name}.${p} has no type`);
        if (t === "string") assert.ok(Array.isArray(spec.enum) || typeof spec.maxLength === "number", `${name}.${p} is unbounded`);
        if (t === "integer" || t === "number") assert.ok(typeof spec.maximum === "number" && (typeof spec.minimum === "number" || typeof spec.exclusiveMinimum === "number"), `${name}.${p} is unbounded`);
        assert.ok(!/tenant|url|host|path|key/i.test(p), `${name} declares a ${p} argument`);
      }
      for (const r of s.required) assert.ok(r in s.properties, `${name} requires an undeclared ${r}`);
      assert.ok(def.description.length > 20 && def.description.length < 400, `${name} description`);
    }
  });

  it("offers a model loop READ tools only, even when a mutation is asked for", () => {
    assert.deepEqual(toolSpecs().map((t) => t.name), [...READ_TOOL_NAMES]);
    const asked = toolSpecs(["fomo_watch_coin", "fomo_unwatch_coin", "fomo_get_token_theses"]);
    assert.deepEqual(asked.map((t) => t.name), ["fomo_get_token_theses"]);
    // Specs are copies: a caller mutating one cannot widen the registry.
    (asked[0]!.schema as { additionalProperties: boolean }).additionalProperties = true;
    assert.equal((FOMO_TOOL_DEFS.fomo_get_token_theses.schema as { additionalProperties: boolean }).additionalProperties, false);
  });
});

describe("validation", () => {
  it("accepts every argument the planner emits (intent.ts ARG CONVENTIONS)", () => {
    let calls = 0;
    for (const [text, memory] of PHRASES) {
      const plan = classifyFomoQuestion(text, { memory, now: NOW });
      assert.ok(plan, `${text} was not planned`);
      assert.equal(plan.clarification, null, `${text}: ${plan.clarification}`);
      for (const c of plan.toolCalls) {
        const v = FOMO_TOOL_DEFS[c.tool].validate(c.args);
        assert.ok(v.ok, `${text} → ${c.tool} ${JSON.stringify(c.args)}: ${v.ok ? "" : v.reason}`);
        calls++;
      }
    }
    assert.ok(calls >= PHRASES.length);
  });

  it("normalises subjects without ever turning a symbol into an identity", () => {
    assert.deepEqual(parseTokenRef(A.toUpperCase().replace("0X", "0x")), { kind: "address", value: A });
    assert.deepEqual(parseTokenRef(MINT), { kind: "address", value: MINT }, "a mint keeps its case");
    assert.deepEqual(parseTokenRef("$pepe"), { kind: "symbol", value: "PEPE" });
    assert.deepEqual(parseTraderRef("@CryptoKaleo"), { kind: "handle", value: "CryptoKaleo" });
    assert.deepEqual(parseTraderRef(USER.toUpperCase()), { kind: "user-id", value: USER });
    assert.equal(parseChain("Robinhood"), "robinhood");
    assert.equal(parseChain("sol"), "solana");
    assert.equal(parseChain("narnia"), null);
  });

  it("refuses unknown keys, tenants, URLs, hosts, paths and control characters", () => {
    const theses = FOMO_TOOL_DEFS.fomo_get_token_theses;
    const refused: [unknown, RegExp][] = [
      [{ token: "PEPE", tenant: "0xevil" }, /unknown-argument:tenant/],
      [{ token: "PEPE", url: "https://x" }, /unknown-argument/],
      [{ token: "https://evil.example/v2/trading" }, /token-invalid/],
      [{ token: "evil.example.com" }, /token-invalid/],
      [{ token: "../../pay/create" }, /token-invalid/],
      [{ trader: "evil.example.com" }, /trader-invalid/],
      [{ trader: "a/b" }, /trader-invalid/],
      [{ token: "PEPE‮" }, /control/],
      [{ token: "PE\nPE" }, /control/],
      [{ token: "PEPE", chain: "narnia" }, /chain-unknown/],
      [{ token: "PEPE", limit: 0 }, /limit/],
      [{ token: "PEPE", limit: 51 }, /limit/],
      [{ token: "PEPE", limit: 2.5 }, /limit/],
      [{ token: "PEPE", freshness: "always" }, /freshness/],
      [{}, /token-or-trader-required/],
      ["PEPE", /not-an-object/],
      [[{ token: "PEPE" }], /not-an-object/],
    ];
    for (const [raw, why] of refused) {
      const v = theses.validate(raw);
      assert.equal(v.ok, false, JSON.stringify(raw));
      if (!v.ok) assert.match(v.reason, why, JSON.stringify(raw));
    }
    const rank = FOMO_TOOL_DEFS.fomo_get_rankings.validate({ board: "traders", window: "1h" });
    assert.equal(rank.ok, false, "the provider has no 1h trader board");
    assert.equal(FOMO_TOOL_DEFS.fomo_research_coin.validate({ token: "PEPE", since_revision: 0 }).ok, false);
    assert.equal(FOMO_TOOL_DEFS.fomo_watch_coin.validate({ token: "PEPE", days: 31 }).ok, false);
    assert.equal(FOMO_TOOL_DEFS.fomo_find_opportunities.validate({ max_market_cap_usd: -1 }).ok, false);
    assert.equal(FOMO_TOOL_DEFS.fomo_get_research_status.validate({ request_id: "../x" }).ok, false);
  });

  it("fills defaults so the service never guesses", () => {
    const t = FOMO_TOOL_DEFS.fomo_get_token_theses.validate({ token: "PEPE" });
    assert.ok(t.ok);
    if (t.ok) assert.deepEqual(t.args, { token: { kind: "symbol", value: "PEPE" }, chain: null, trader: null, window: null, limit: 25, depth: "quick", freshness: "prefer-fresh" });
    const w = FOMO_TOOL_DEFS.fomo_watch_coin.validate({ token: A });
    assert.ok(w.ok && w.args.days === 7);
    const r = FOMO_TOOL_DEFS.fomo_resolve_subject.validate({ query: "@laifu" });
    assert.ok(r.ok && r.args.query.kind === "handle");
    const sym = FOMO_TOOL_DEFS.fomo_resolve_subject.validate({ query: "PONS" });
    assert.ok(sym.ok && sym.args.query.kind === "symbol");
    const handle = FOMO_TOOL_DEFS.fomo_resolve_subject.validate({ query: "frankdegods" });
    assert.ok(handle.ok && handle.args.query.kind === "handle");
  });

  it("the module reads no environment", () => {
    const src = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
    assert.ok(!/process\.env/.test(src));
  });
});
