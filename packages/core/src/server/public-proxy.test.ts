import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { createPublicProxy, resolveConnectTarget } from "./public-proxy";

test("CONNECT refuses local/encoded/credentialed destinations and non-HTTPS ports", async () => {
  for (const authority of ["127.0.0.1:443", "2130706433:443", "[::ffff:7f00:1]:443", "db.railway.internal:443", "public.example:80", "public.example:5432", "user@public.example:443", "public.example:443/path"]) {
    await assert.rejects(resolveConnectTarget(authority, async () => { throw new Error("DNS must not run"); }));
  }
  await assert.rejects(resolveConnectTarget("public.example:443", async () => [{ address: "192.168.0.1", family: 4 }]), /DNS answer/);
});

/** Local fixture only; the injected upstream never opens an external socket. */
async function request(proxyUrl: string, wire: string): Promise<string> {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(url.port) }, () => socket.write(wire));
    socket.once("data", (chunk) => { resolve(chunk.toString()); socket.destroy(); });
    socket.once("error", reject);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("fixture timed out")); });
  });
}

test("each browser tunnel independently resolves and pins its upstream destination", async () => {
  const connections: { host: string; port: number; family: number }[] = [];
  let answers = 0;
  const proxy = await createPublicProxy({
    lookup: async () => ++answers === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.5", family: 4 }],
    connect: (options, ready) => {
      connections.push(options);
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
      Object.assign(socket, { setTimeout() { return socket; } });
      queueMicrotask(ready);
      return socket as Socket;
    },
  });
  try {
    assert.match(await request(proxy.url, "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n"), /200 Connection Established/);
    // A new CONNECT (redirect, worker, subresource or rebind) cannot reuse the
    // fact that the initial hostname was approved.
    assert.match(await request(proxy.url, "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n"), /403 Forbidden/);
    assert.deepEqual(connections, [{ host: "93.184.216.34", port: 443, family: 4 }]);
    assert.match(await request(proxy.url, "GET http://127.0.0.1/admin HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"), /403/);
    assert.equal(connections.length, 1);
  } finally { await proxy.close(); }
});
