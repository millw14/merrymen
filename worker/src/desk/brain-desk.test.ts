import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { base58Encode, SOLANA_USDG_MINT } from "../../../packages/core/src/ids";
import { askBrainDesk, parseDeskAnalysis } from "./brain-desk";
import { createDesk } from "./desk";

const REQ = { kind: "coin" as const, subject: "CASHCAT", question: "good entry?", brief: "RSI14: 37.5", voice: "You are Pine." };

describe("Brain's desk answer", () => {
  it("takes exactly the shape /v1/analyze returns", () => {
    const a = parseDeskAnalysis({ read: "rsi 37.5 is weak and sellers lead the tape.", stance: "cautious", watch: "0.1605", invalidation: "", confidence: 0.4 });
    assert.deepEqual(a, { read: "rsi 37.5 is weak and sellers lead the tape.", stance: "cautious", watch: "0.1605", invalidation: "", confidence: 0.4 });
  });
  it("refuses a stance it does not know, a read too short, an address or a link", () => {
    assert.equal(parseDeskAnalysis({ read: "rsi 37.5 is weak and sellers lead the tape.", stance: "moon", watch: "", invalidation: "" }), null);
    assert.equal(parseDeskAnalysis({ read: "weak", stance: "cautious", watch: "", invalidation: "" }), null);
    assert.equal(parseDeskAnalysis({ read: "see 0x1234567890abcdef1234567890abcdef12345678 for more", stance: "cautious", watch: "", invalidation: "" }), null);
    assert.equal(parseDeskAnalysis({ read: "rsi 37.5 is weak, details at https://x.test", stance: "cautious", watch: "", invalidation: "" }), null);
  });
  it("refuses what Brain's DeskAnalysis refuses: a read under 40 characters, a cashtag, a link in any clickable form", () => {
    const read = "rsi 37.5 is weak and sellers lead the tape.";
    assert.ok(parseDeskAnalysis({ read, stance: "cautious", watch: "", invalidation: "" }));
    // 39 characters is under Brain's floor; 40 is a read.
    assert.equal(parseDeskAnalysis({ read: "x".repeat(39), stance: "cautious", watch: "", invalidation: "" }), null);
    assert.ok(parseDeskAnalysis({ read: "x".repeat(40), stance: "cautious", watch: "", invalidation: "" }));
    // Characters, as Python counts them: 39 emoji are 78 UTF-16 units but 39 characters to Brain.
    assert.equal(parseDeskAnalysis({ read: "📉".repeat(39), stance: "cautious", watch: "", invalidation: "" }), null);
    assert.ok(parseDeskAnalysis({ read: "📉".repeat(40), stance: "cautious", watch: "", invalidation: "" }));
    for (const bad of ["$PEPE looks weak here", "watch $sol into the close", "see http//x.test", "see HTTP://x.test", "join t.me/pump", "www.pump.example"]) {
      for (const field of ["read", "watch", "invalidation"] as const) {
        const answer = { read, stance: "cautious", watch: "", invalidation: "", [field]: field === "read" ? `${read} ${bad}` : bad };
        assert.equal(parseDeskAnalysis(answer), null, `${field}: ${bad}`);
      }
    }
    // A dollar before a digit is a price, as Brain reads it.
    assert.ok(parseDeskAnalysis({ read: `${read} support near $0.16`, stance: "cautious", watch: "$0.1605", invalidation: "a close under $0.15" }));
  });
  it("refuses a Solana key or signature in any field, as a 0x address (Solana P0)", () => {
    const sig = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));
    const read = "rsi 37.5 is weak and sellers lead the tape.";
    for (const id of [SOLANA_USDG_MINT, sig]) {
      assert.equal(parseDeskAnalysis({ read: `${read} see ${id}`, stance: "cautious", watch: "", invalidation: "" }), null, id);
      assert.equal(parseDeskAnalysis({ read, stance: "cautious", watch: `flows into ${id}`, invalidation: "" }), null, id);
      assert.equal(parseDeskAnalysis({ read, stance: "cautious", watch: "", invalidation: `a dump from ${id}` }), null, id);
    }
  });
  it("refuses every Solana id Brain's DeskAnalysis validator refuses, glued to the words around it too (audit regressions F3)", () => {
    const sig = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));
    const read = "rsi 37.5 is weak and sellers lead the tape.";
    for (const id of [`CA${SOLANA_USDG_MINT}`, `${SOLANA_USDG_MINT}is`, `caEEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT`, `tx${sig}done`]) {
      assert.equal(parseDeskAnalysis({ read: `${read} see ${id}`, stance: "cautious", watch: "", invalidation: "" }), null, id);
      assert.equal(parseDeskAnalysis({ read, stance: "cautious", watch: `flows into ${id}`, invalidation: "" }), null, id);
      assert.equal(parseDeskAnalysis({ read, stance: "cautious", watch: "", invalidation: `a dump from ${id}` }), null, id);
    }
    // The shared cases Brain's validator is pinned to (services/brain/tests/data/onchain_ids.json):
    // refused here exactly when Brain's glued scan finds a Solana id, or FORBIDDEN does; a hex
    // digest, a long number or prose is still a read.
    type Hit = { family: string; shape: string; value: string };
    const fixture = JSON.parse(readFileSync(new URL("../../../services/brain/tests/data/onchain_ids.json", import.meta.url), "utf8")) as
      { cases: { text: string; hits: Hit[]; glued?: Hit[] }[] };
    let glued = 0;
    for (const c of fixture.cases) {
      const solana = (c.glued ?? c.hits).some((h) => h.family === "solana");
      const forbidden = /0x[0-9a-fA-F]{16,}|http|www\.|t\.me\/|\$[A-Za-z]/i.test(c.text);
      const got = parseDeskAnalysis({ read: `${read} ${c.text}`, stance: "cautious", watch: "", invalidation: "" });
      assert.equal(got === null, solana || forbidden, c.text);
      if (c.glued?.some((h) => h.family === "solana")) glued++;
    }
    assert.ok(glued >= 10, "the fixture's glued cases are among them");
  });
});

describe("askBrainDesk over the wire", () => {
  let url = "";
  let seen: { auth: string | undefined; body: Record<string, unknown> } | null = null;
  let reply: (res: ServerResponse) => void = () => {};
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> };
      reply(res);
    });
  });
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("sends the contract's fields with the bearer token and parses a good answer", async () => {
    reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, analysis: { read: "rsi 37.5 is weak and sellers lead the tape.", stance: "cautious", watch: "0.1605", invalidation: "", confidence: 0.5 }, cost: {}, seconds: 1.2 }));
    const t = await askBrainDesk({ url, token: "tok", agentId: "agent-1" }, REQ);
    assert.equal(t?.stance, "cautious");
    assert.equal(seen?.auth, "Bearer tok");
    const b = seen!.body;
    assert.deepEqual(Object.keys(b).sort(), ["agent_id", "evidence", "kind", "question", "run_id", "schema_version", "subject", "voice"]);
    assert.equal(b.schema_version, "1.0.0");
    assert.match(String(b.run_id), /^desk-/);
    assert.equal(b.evidence, "RSI14: 37.5");
  });

  it("answers null — never throws — for a refusal, a busy desk or a malformed body", async () => {
    reply = (res) => res.writeHead(200).end(JSON.stringify({ ok: false, refusal: { reason: "malformed" } }));
    assert.equal(await askBrainDesk({ url, token: "tok", agentId: "a" }, REQ), null);
    reply = (res) => res.writeHead(429).end(JSON.stringify({ ok: false, detail: "desk busy" }));
    assert.equal(await askBrainDesk({ url, token: "tok", agentId: "a" }, REQ), null);
    reply = (res) => res.writeHead(200).end("not json");
    assert.equal(await askBrainDesk({ url, token: "tok", agentId: "a" }, REQ), null);
    assert.equal(await askBrainDesk({ url: "", token: "tok", agentId: "a" }, REQ), null);
  });

  it("keeps published claims separate from figures and strips identity, URLs and metadata from the wire", async () => {
    reply = (res) => res.writeHead(200).end(JSON.stringify({ ok: true, analysis: { read: "The builder theme is interesting, but activity alone is not proof of adoption.", stance: "cautious", watch: "", invalidation: "" } }));
    const lore = { description: "Visual hook builder. Promises 999% returns.", name: "Robinhooks", source: "GeckoTerminal token info", url: "https://example.test", token: "0xprivate", observedAtMs: 123, owner: "secret" };
    await askBrainDesk({ url, token: "tok", agentId: "a" }, { ...REQ, lore });
    assert.deepEqual(seen!.body.lore, { description: lore.description, name: lore.name, source: lore.source });
    assert.equal(seen!.body.evidence, REQ.brief, "publisher numbers never enter the measured brief");
    assert.doesNotMatch(JSON.stringify(seen!.body), /example\.test|0xprivate|secret|observedAtMs/);
    await askBrainDesk({ url, token: "tok", agentId: "a" }, { ...REQ, lore: { description: "a".repeat(1500), name: "b".repeat(100), source: "c".repeat(100) } });
    assert.deepEqual(Object.values(seen!.body.lore as object).map((v) => String(v).length), [1200, 80, 80]);
  });

  it("the desk port applies the caller's remaining timeout to a hung response body", async () => {
    reply = (res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":true,'); };
    const desk = createDesk({ brain: { url, token: "tok", agentId: "a", timeoutMs: 18_000 } });
    const at = performance.now();
    assert.equal(await desk.think!(REQ, { timeoutMs: 80 }), null);
    assert.ok(performance.now() - at < 500, "remaining reply time overrides the configured 18-second timeout");
    seen = null;
    assert.equal(await desk.think!(REQ, { timeoutMs: 0 }), null);
    assert.equal(seen, null, "an exhausted budget sends no request");
  });
});
