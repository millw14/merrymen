// GET /healthz — liveness. Also surfaces a 500 if the project env is misconfigured.
import { getGateway, sendResult, fail } from "../lib/instance.mjs";

export default function handler(req, res) {
  try {
    sendResult(res, getGateway().health());
  } catch (e) {
    fail(res, e);
  }
}
