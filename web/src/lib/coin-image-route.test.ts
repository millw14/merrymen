import assert from "node:assert/strict";
import { test, mock } from "node:test";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

test("the image route preserves an SVG logo but sandboxes its active document content", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:green}</style><script>parent.document.cookie</script><rect width="10" height="10"/></svg>';
  let requests = 0;
  const request = mock.method(https, "request", ((_options: unknown, ready: (response: IncomingMessage) => void) => {
    requests++;
    const response = Readable.from([Buffer.from(svg)]) as IncomingMessage;
    response.statusCode = 200;
    response.headers = { "content-type": "image/svg+xml" };
    const outgoing = new EventEmitter() as EventEmitter & { end(): void };
    outgoing.end = () => queueMicrotask(() => ready(response));
    return outgoing;
  }) as typeof https.request);
  syncBuiltinESMExports();
  try {
    const { GET } = await import("../app/api/coin-image/route");
    // An explicit public literal needs no DNS. The mocked HTTPS request is the
    // only transport; no public or private network probe is made by this test.
    const response = await GET(new Request("https://app.example/api/coin-image?uri=https%3A%2F%2F93.184.216.34%2Flogo.svg"));
    assert.equal(requests, 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/svg+xml");
    assert.equal(await response.text(), svg, "ordinary SVG artwork remains supported");
    const policy = new Map((response.headers.get("content-security-policy") ?? "").split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values] as const;
    }));
    assert.deepEqual(policy.get("sandbox"), [], "scripts and same-origin privileges must not be enabled");
    assert.deepEqual(policy.get("default-src"), ["'none'"], "the SVG cannot load external active content");
    assert.deepEqual(policy.get("style-src"), ["'unsafe-inline'"], "inline logo styling remains available");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    request.mock.restore();
    syncBuiltinESMExports();
  }
});
