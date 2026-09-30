/** A CONNECT-only browser proxy. Every tunnel dials one validated, pinned IP. */
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { abortable, resolvePublicAddress, type Lookup } from "./public-network";

export async function resolveConnectTarget(authority: string, lookup?: Lookup) {
  // Accept authority-form only. No credentials, path, plaintext or arbitrary
  // service ports; Chromium's public HTTPS requests use CONNECT host:443.
  if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):443$/i.test(authority)) throw new Error("refused CONNECT authority");
  const url = new URL(`https://${authority}/`);
  return resolvePublicAddress(url, lookup);
}

type Connect = (options: { host: string; port: number; family: number }, ready: () => void) => Socket;
/** Dependencies exist only for offline tests and cannot be supplied over HTTP. */
export async function createPublicProxy(deps: { lookup?: Lookup; connect?: Connect } = {}) {
  const sockets = new Set<Duplex>();
  const server = createServer((_req, res) => {
    res.writeHead(403, { connection: "close" });
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (req, client, head) => {
    const controller = new AbortController();
    let upstream: Socket | undefined;
    const finish = () => { controller.abort(); client.destroy(); upstream?.destroy(); clearTimeout(timer); };
    const timer = setTimeout(finish, 25_000);
    client.once("close", finish);
    if (sockets.size > 64) { finish(); return; }
    void (async () => {
      try {
        const address = await abortable(resolveConnectTarget(req.url ?? "", deps.lookup), controller.signal);
        controller.signal.throwIfAborted();
        upstream = (deps.connect ?? connect)({ host: address.address, family: address.family, port: 443 }, () => {
          if (client.destroyed) { finish(); return; }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream!.write(head);
          upstream!.pipe(client);
          client.pipe(upstream!);
        });
        sockets.add(upstream);
        upstream.once("close", () => { sockets.delete(upstream!); finish(); });
        upstream.once("error", finish);
        upstream.setTimeout(10_000, finish);
        // Bound bytes without accumulating them. Backpressure is provided by pipe.
        let bytes = head.length;
        const count = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 32_000_000) finish(); };
        upstream.on("data", count);
        client.on("data", count);
      } catch {
        if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        controller.abort();
        clearTimeout(timer);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
