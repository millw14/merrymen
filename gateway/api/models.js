// GET /v1/models — the one model this gateway forces, as a list.
//
// Unauthenticated, like /healthz: it discloses the brand name a caller must
// send back, which already ships in llm-providers.ts and on the claim page.
// It exists because every OpenAI-compatible client asks before showing a model
// picker, and the catch-all 404 made merrymen's settings page tell holders
// their key was bad.
import { getGateway, sendResult, fail } from "../lib/instance.mjs";

export default function handler(req, res) {
  try {
    sendResult(res, getGateway().models());
  } catch (e) {
    fail(res, e);
  }
}
