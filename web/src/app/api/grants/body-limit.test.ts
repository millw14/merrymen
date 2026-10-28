/**
 * POST /api/grants READS AT MOST 256 KiB, AND REFUSES MORE BEFORE PARSING IT.
 *
 * Every grant check parses or scans the whole payload (JSON, the duplicate
 * permission walk, the hosted owner-key scan), so an unbounded body was held
 * and worked through whole. The limit matches partner activation, which
 * carries the same grant (lib/partner-enrollment.ts). Driven through the real
 * handler against a real home: a refusal leaves grant.json as it was.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const B = "0x1111111111111111111111111111111111111111";
const LIMIT = 256 * 1024;

let home = "";
let POST: (req: Request) => Promise<Response>;
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, grant: process.env.MERRYMEN_GRANT_FILE };

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-body-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_GRANT_FILE;
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
const LIVE = `{\n  "smartAccount": "${B}",\n  "serialized": "0xserialized",\n  "chainId": 4663\n}\n`;
beforeEach(() => {
  delete process.env.MERRYMEN_HOSTED;
  writeFileSync(grantFile(), LIVE);
});

/** A grant the chain check refuses, padded to exactly `bytes` of JSON. */
function padded(bytes: number): string {
  const base = JSON.stringify({ smartAccount: B, serialized: "0xserialized", chainId: 1, pad: "" });
  return JSON.stringify({ smartAccount: B, serialized: "0xserialized", chainId: 1, pad: "x".repeat(bytes - base.length) });
}
const request = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/grants", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body, duplex: "half" } as RequestInit);

describe("POST /api/grants — request size", { timeout: 20_000 }, () => {
  it("a grant at the limit still reaches the grant checks", async () => {
    const body = padded(LIMIT);
    assert.equal(Buffer.byteLength(body), LIMIT);
    const res = await POST(request(body));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "unsupported_chain", "the size gate let it through to the chain check");
  });

  it("one byte over the limit is refused with 413 before it is parsed, and nothing is saved", async () => {
    const res = await POST(request(padded(LIMIT + 1)));
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { error: string }).error, /too large\. Nothing was saved/);
    assert.equal(readFileSync(grantFile(), "utf8"), LIVE);
  });

  it("a declared length over the limit is refused without reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (++pulled > 1024) return controller.close();
      controller.enqueue(new Uint8Array(1024).fill(0x20));
    } });
    const res = await POST(request(stream, { "content-length": String(LIMIT + 1) }));
    assert.equal(res.status, 413);
    assert.ok(pulled <= 1, `the body was read (${pulled} chunks) although its declared length was over the limit`);
    for (const declared of ["NaN", "-1x", "1e9"]) {
      assert.equal((await POST(request(padded(1024), { "content-length": declared }))).status, 413, `declared ${declared}`);
    }
  });

  it("a long body with no declared length is cut off once it passes the limit", async () => {
    let sent = 0;
    let cancelled = false;
    // 4 MiB of JSON whitespace, streamed in 16 KiB chunks with no declared length.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4 * 1024 * 1024) return controller.close();
        sent += 16 * 1024; controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
      },
      cancel() { cancelled = true; },
    });
    const res = await POST(request(stream));
    assert.equal(res.status, 413);
    assert.equal(cancelled, true, "the oversized stream was not cancelled");
    assert.ok(sent <= LIMIT + 64 * 1024, `read ${sent} bytes of an oversized body`);
    assert.equal(readFileSync(grantFile(), "utf8"), LIVE);
  });

  it("hosted, an oversized body is refused before authentication or the owner-key scan", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const res = await POST(request(padded(LIMIT + 1)));
    assert.equal(res.status, 413, "signed out would be 401; the size refusal comes first");
  });

  it("a body that is not JSON is refused as not a grant, not a server error", async () => {
    for (const body of ["{", "not json", ""]) {
      const res = await POST(request(body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(((await res.json()) as { error: string }).error, "not a grant");
    }
    assert.equal(readFileSync(grantFile(), "utf8"), LIVE);
  });
});
