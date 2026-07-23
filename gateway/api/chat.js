// POST /v1/chat/completions (and /chat/completions) — OpenAI-compatible endpoint
// the merrymen client calls with `Authorization: Bearer <token>`.
import { getGateway, clientIp, jsonBody, sendResult, fail } from "../lib/instance.mjs";

export default async function handler(req, res) {
  try {
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
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    sendResult(res, await gw.chat({ token, body: jsonBody(req), ip }));
  } catch (e) {
    fail(res, e);
  }
}
