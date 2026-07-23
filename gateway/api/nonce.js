// GET /nonce?address=0x… — mint a single-use, domain-bound challenge to sign.
import { getGateway, clientIp, sendResult, fail } from "../lib/instance.mjs";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.statusCode = 405;
      return res.end();
    }
    const gw = getGateway();
    const ip = clientIp(req.headers["x-forwarded-for"], req.socket && req.socket.remoteAddress);
    const address = (req.query && req.query.address) || new URL(req.url, "http://x").searchParams.get("address");
    sendResult(res, await gw.nonce({ address, ip }));
  } catch (e) {
    fail(res, e);
  }
}
