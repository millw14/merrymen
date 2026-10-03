import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { askBrainDesk, parseDeskAnalysis } from "./brain-desk";
import { createDesk } from "./desk";

const REQ = { kind: "coin" as const, subject: "CASHCAT", question: "good entry?", brief: "RSI14: 37.5", voice: "You are Pine." };

describe("Brain's desk answer", () => {
  it("takes exactly the shape /v1/analyze returns", () => {
    const a = parseDeskAnalysis({ read: "rsi 37.5 is weak and sellers lead.", stance: "cautious", watch: "0.1605", invalidation: "", confidence: 0.4 });
    assert.deepEqual(a, { read: "rsi 37.5 is weak and sellers lead.", stance: "cautious", watch: "0.1605", invalidation: "", confidence: 0.4 });
  });
  it("refuses a stance it does not know, a read too short, an address or a link", () => {
    assert.equal(parseDeskAnalysis({ read: "rsi 37.5 is weak and sellers lead.", stance: "moon", watch: "", invalidation: "" }), null);
    assert.equal(parseDeskAnalysis({ read: "weak", stance: "cautious", watch: "", invalidation: "" }), null);
    assert.equal(parseDeskAnalysis({ read: "see 0x1234567890abcdef1234567890abcdef12345678 for more", stance: "cautious", watch: "", invalidation: "" }), null);
    assert.equal(parseDeskAnalysis({ read: "rsi 37.5 is weak, details at https://x.test", stance: "cautious", watch: "", invalidation: "" }), null);
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
    reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, analysis: { read: "rsi 37.5 is weak and sellers lead.", stance: "cautious", watch: "0.1605", invalidation: "", confidence: 0.5 }, cost: {}, seconds: 1.2 }));
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
