/**
 * THE SERVICE NOTICE ROUTE, DRIVEN THROUGH ITS REAL HANDLER.
 *
 * Three properties a reviewer would otherwise have to remember:
 *
 *   - It reads the env var per request. A prerendered or memoised body would
 *     keep a banner up after the operator unset it.
 *   - It serves nothing it refused. A bad field, a foreign host, an http or a
 *     javascript: link turns the whole notice off — and is logged once, so the
 *     operator can see why, without a polled route flooding the log.
 *   - Its cache header is short and public: the body is the same for everyone.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { dynamic, GET } from "./route";

const CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=60";
const NOTICE = {
  title: "Trading is paused",
  body: "We are finishing a recovery.",
  updatedAt: "2026-10-05T18:00:00Z",
  tradingPaused: true,
  links: [{ label: "Your account", href: "https://app.merrymen.dev/you" }],
};

const saved = process.env.MERRYMEN_SERVICE_NOTICE;
let warnings: string[];

beforeEach(() => {
  warnings = [];
  mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
});
afterEach(() => {
  mock.restoreAll();
  if (saved === undefined) delete process.env.MERRYMEN_SERVICE_NOTICE;
  else process.env.MERRYMEN_SERVICE_NOTICE = saved;
});

async function read(value: string | undefined) {
  if (value === undefined) delete process.env.MERRYMEN_SERVICE_NOTICE;
  else process.env.MERRYMEN_SERVICE_NOTICE = value;
  const response = await GET();
  return { response, body: await response.json() as { notice: unknown } };
}

describe("GET /api/service-notice", () => {
  it("is never prerendered", () => {
    assert.equal(dynamic, "force-dynamic");
  });

  it("answers no notice when the variable is unset, with the same short public cache", async () => {
    const { response, body } = await read(undefined);
    assert.equal(response.status, 200);
    assert.deepEqual(body, { notice: null });
    assert.equal(response.headers.get("cache-control"), CACHE);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(warnings, [], "unset is the normal state, not something to log");
  });

  it("serves a valid notice, normalised, and nothing else", async () => {
    const { response, body } = await read(JSON.stringify(NOTICE));
    assert.equal(response.headers.get("cache-control"), CACHE);
    assert.deepEqual(Object.keys(body), ["notice"], "no session, tenant or diagnostic field rides along");
    assert.deepEqual(body.notice, { ...NOTICE, updatedAt: "2026-10-05T18:00:00.000Z" });
  });

  it("reads the variable per request, so unsetting it takes the banner down", async () => {
    assert.notEqual((await read(JSON.stringify(NOTICE))).body.notice, null);
    assert.equal((await read(undefined)).body.notice, null);
    assert.equal((await read("")).body.notice, null);
  });

  it("serves markup as the characters it is — rendering it is not the route's job", async () => {
    const { body } = await read(JSON.stringify({ ...NOTICE, title: "<script>alert(1)</script>" }));
    assert.equal((body.notice as { title: string }).title, "<script>alert(1)</script>");
  });

  for (const [name, notice, why] of [
    ["a bad field", { ...NOTICE, tradingpaused: true }, /unknown field "tradingpaused"/],
    ["a foreign host", { ...NOTICE, links: [{ label: "More", href: "https://evil.example/" }] }, /must point at/],
    ["an http link", { ...NOTICE, links: [{ label: "More", href: "http://app.merrymen.dev/you" }] }, /must use https/],
    ["a javascript: link", { ...NOTICE, links: [{ label: "More", href: "javascript:alert(1)" }] }, /must use https/],
  ] as const) {
    it(`serves no notice for ${name}, and logs why once`, async () => {
      const raw = JSON.stringify(notice);
      for (let i = 0; i < 3; i++) {
        const { response, body } = await read(raw);
        assert.equal(response.status, 200, "a refused notice is not an outage");
        assert.deepEqual(body, { notice: null });
        assert.equal(response.headers.get("cache-control"), CACHE);
      }
      assert.equal(warnings.length, 1, "a polled route logs a refused value once, not per request");
      assert.match(warnings[0]!, /MERRYMEN_SERVICE_NOTICE ignored/);
      assert.match(warnings[0]!, why);
    });
  }

  it("serves no notice for a value that is not JSON", async () => {
    const { body } = await read("Trading is paused");
    assert.deepEqual(body, { notice: null });
    assert.match(warnings.join("\n"), /not valid JSON/);
  });
});
