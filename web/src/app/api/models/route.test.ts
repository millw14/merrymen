import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { POST } from "./route";

function useTempHome(settings: unknown): void {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-models-test-"));
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  process.env.MERRYMEN_HOME = dir;
}

function stubFetch(status: number, body: unknown) {
  (globalThis as Record<string, unknown>).fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  })) as unknown as typeof fetch;
}

const req = (body: unknown) =>
  new Request("http://localhost/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/models error classification", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const savedFetch = (globalThis as Record<string, unknown>).fetch;
  beforeEach(() => {
    savedEnv.MERRYMEN_HOME = process.env.MERRYMEN_HOME;
    savedEnv.GROQ_API_KEY = process.env.GROQ_API_KEY;
    delete process.env.MERRYMEN_HOME;
    delete process.env.GROQ_API_KEY;
  });
  afterEach(() => {
    // Restore everything this file borrows: a leaked fetch stub or settings
    // dir breaks unrelated suites that run in the same process.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it("missing_key when no key exists anywhere (nothing was attempted)", async () => {
    useTempHome({});
    stubFetch(200, { data: [] });
    const res = await POST(req({ provider: "groq" }));
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(j.code, "missing_key");
    assert.equal(j.keySource, "none");
  });

  it("key_rejected on provider 401 without leaking provider internals", async () => {
    useTempHome({ groqApiKey: "dead-key" });
    stubFetch(401, { error: { message: "Invalid API Key", type: "invalid_request_error" } });
    const res = await POST(req({ provider: "groq" }));
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.code, "key_rejected");
    assert.equal(j.keySource, "saved");
    assert.ok(!(j.error as string).includes("Invalid API Key"));
  });

  it("keySource is typed when the key comes from the request body", async () => {
    useTempHome({});
    stubFetch(401, { error: "nope" });
    const res = await POST(req({ provider: "groq", apiKey: "typed-key" }));
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.code, "key_rejected");
    assert.equal(j.keySource, "typed");
  });

  it("keySource is house when the shared key is used", async () => {
    useTempHome({});
    process.env.GROQ_API_KEY = "house-key";
    stubFetch(401, { error: "nope" });
    const res = await POST(req({ provider: "groq" }));
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.code, "key_rejected");
    assert.equal(j.keySource, "house");
  });

  it("provider_error on provider 500 and on network failure", async () => {
    useTempHome({ groqApiKey: "some-key" });
    stubFetch(500, { error: "boom" });
    const failed = (await (await POST(req({ provider: "groq" }))).json()) as Record<string, unknown>;
    assert.equal(failed.code, "provider_error");
    (globalThis as Record<string, unknown>).fetch = (() => {
      throw new Error("socket hangup");
    }) as unknown as typeof fetch;
    const threw = (await (await POST(req({ provider: "groq" }))).json()) as Record<string, unknown>;
    assert.equal(threw.code, "provider_error");
    assert.equal(threw.error, "provider unreachable");
  });

  it("happy path still returns sorted models", async () => {
    useTempHome({ groqApiKey: "live-key" });
    stubFetch(200, { data: [{ id: "zebra" }, { id: "apple" }, { noId: true }, { id: "has space" }] });
    const res = await POST(req({ provider: "groq" }));
    const j = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(j.models, ["apple", "zebra"]);
  });
});
