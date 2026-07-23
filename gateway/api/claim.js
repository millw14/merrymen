// GET /  and  GET /claim  → the static claim page (no config needed).
// POST /claim → verify a signature over a fresh single-use nonce + holdings, issue a token.
import { getGateway, clientIp, jsonBody, sendResult, fail } from "../lib/instance.mjs";
import { CLAIM_HTML } from "../lib/claimPage.mjs";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return sendResult(res, { status: 200, html: CLAIM_HTML });
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end();
    }
    const gw = getGateway();
    const ip = clientIp(req.headers["x-forwarded-for"], req.socket && req.socket.remoteAddress);
    sendResult(res, await gw.claim({ body: jsonBody(req), ip }));
  } catch (e) {
    fail(res, e);
  }
}
