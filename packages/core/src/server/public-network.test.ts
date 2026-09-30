import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { isPrivateHost, isPublicAddress, safeFetchUrl } from "../safe-url";
import { fetchPublicHttps, type PublicFetchDependencies } from "./public-network";

const publicIp = { address: "93.184.216.34", family: 4 };
const options = { maxBytes: 8, timeoutMs: 1000 };

function response(status = 200, headers: Record<string, string> = {}, chunks = [Buffer.from("image")]) {
  let consumed = 0;
  const stream = Readable.from((function* () {
    for (const chunk of chunks) { consumed++; yield chunk; }
  })(), { objectMode: false, highWaterMark: 1 }) as IncomingMessage;
  stream.statusCode = status;
  stream.headers = headers;
  return { stream, consumed: () => consumed };
}

function transport(replies: IncomingMessage[]) {
  const calls: RequestOptions[] = [];
  const request = ((opts: RequestOptions, ready: (response: IncomingMessage) => void) => {
    calls.push(opts);
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => queueMicrotask(() => {
      const next = replies.shift();
      if (next) ready(next); else req.emit("error", new Error("unexpected outbound request"));
    });
    return req;
  }) as PublicFetchDependencies["request"];
  return { calls, request };
}

test("canonicalized numeric hosts and IPv6 special-use forms are refused", () => {
  for (const host of [
    "0.0.0.0", "127.0.0.1", "2130706433", "0177.0.0.1", "0x7f000001", "10.0.0.1",
    "100.64.0.1", "169.254.169.254", "172.31.0.1", "192.168.1.1", "198.18.0.1",
    "192.0.2.1", "224.0.0.1", "255.255.255.255", "[::]", "[::1]", "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]", "[64:ff9b::a00:1]", "[fe80::1]", "[fc00::1]", "[ff02::1]",
    "[2001:db8::1]", "[2002:7f00:1::]", "localhost.", "db.railway.internal.", "metadata",
  ]) assert.equal(safeFetchUrl(`https://${host}/`), null, host);
  assert.equal(isPrivateHost("fc-news.example"), false, "a public hostname is not an IPv6 prefix");
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("a private or mixed DNS answer never reaches the HTTP transport", async () => {
  for (const answers of [[], [{ address: "10.0.0.1", family: 4 }], [publicIp, { address: "fe80::1", family: 6 }]]) {
    const mock = transport([]);
    await assert.rejects(fetchPublicHttps("https://image.example/a", options, { request: mock.request, lookup: async () => answers }), /DNS answer/);
    assert.equal(mock.calls.length, 0);
  }
});

test("the socket uses the inspected IP and preserves TLS/Host identity without a second DNS lookup", async () => {
  const mock = transport([response().stream]);
  let lookups = 0;
  const result = await fetchPublicHttps("https://image.example/a?q=1", options, {
    request: mock.request,
    lookup: async () => ++lookups === 1 ? [publicIp] : [{ address: "127.0.0.1", family: 4 }],
  });
  assert.equal(result.body.toString(), "image");
  assert.equal(lookups, 1);
  assert.equal(mock.calls[0]!.hostname, publicIp.address);
  assert.equal(mock.calls[0]!.servername, "image.example");
  assert.equal((mock.calls[0]!.headers as Record<string, string>).host, "image.example");
  assert.equal(mock.calls[0]!.path, "/a?q=1");
  assert.equal(mock.calls[0]!.agent, false);
  assert.equal(mock.calls[0]!.rejectUnauthorized, true);
});

test("redirects are validated before the next socket, including a rebinding hostname", async () => {
  for (const target of ["https://127.0.0.1/admin", "https://[::ffff:127.0.0.1]/", "http://image.example/a", "https://user:pass@image.example/a", "https://private.example/a"]) {
    const redirect = response(302, { location: target });
    const mock = transport([redirect.stream]);
    await assert.rejects(fetchPublicHttps("https://image.example/a", options, {
      request: mock.request,
      lookup: async (host) => host === "image.example" ? [publicIp] : [{ address: "10.0.0.1", family: 4 }],
    }), /refused/);
    assert.equal(mock.calls.length, 1);
    assert.equal(redirect.stream.destroyed, true);
  }
  const mock = transport([response(302, { location: "/next" }).stream]);
  let lookups = 0;
  await assert.rejects(fetchPublicHttps("https://image.example/a", options, {
    request: mock.request,
    lookup: async () => ++lookups === 1 ? [publicIp] : [{ address: "127.0.0.1", family: 4 }],
  }), /DNS answer/);
  assert.equal(mock.calls.length, 1);
});

test("a public relative redirect succeeds and redirect loops are bounded", async () => {
  const mock = transport([response(302, { location: "/next" }).stream, response().stream]);
  const result = await fetchPublicHttps("https://image.example/a", options, { request: mock.request, lookup: async () => [publicIp] });
  assert.equal(result.url.href, "https://image.example/next");
  const loop = transport(Array.from({ length: 3 }, () => response(302, { location: "/again" }).stream));
  await assert.rejects(fetchPublicHttps("https://image.example/a", { ...options, maxRedirects: 2 }, { request: loop.request, lookup: async () => [publicIp] }), /redirect/);
  assert.equal(loop.calls.length, 3);
});

test("an unbounded chunked body is destroyed as soon as it exceeds the cap", async () => {
  const large = response(200, {}, Array.from({ length: 100 }, () => Buffer.alloc(4)));
  const mock = transport([large.stream]);
  await assert.rejects(fetchPublicHttps("https://image.example/a", options, { request: mock.request, lookup: async () => [publicIp] }), /too large/);
  assert.equal(large.stream.destroyed, true);
  assert.ok(large.consumed() <= 4, `consumed ${large.consumed()} chunks`);
});

test("oversize Content-Length, compressed data and unsuitable MIME are rejected before reading", async () => {
  const cases: Record<string, string>[] = [{ "content-length": "99999" }, { "content-encoding": "gzip" }, { "content-type": "text/html" }];
  for (const headers of cases) {
    const rejected = response(200, headers);
    const mock = transport([rejected.stream]);
    await assert.rejects(fetchPublicHttps("https://image.example/a", {
      ...options, accept: (res) => res.headers["content-type"] !== "text/html",
    }, { request: mock.request, lookup: async () => [publicIp] }));
    assert.equal(rejected.consumed(), 0);
    assert.equal(rejected.stream.destroyed, true);
  }
});

test("a slow resolver times out without opening a socket after it eventually resolves", async () => {
  const mock = transport([]);
  let finish!: (value: typeof publicIp[]) => void;
  await assert.rejects(fetchPublicHttps("https://image.example/a", { ...options, timeoutMs: 10 }, {
    request: mock.request, lookup: () => new Promise((resolve) => { finish = resolve; }),
  }), /timed out/);
  finish([publicIp]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.calls.length, 0);
});
