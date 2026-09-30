/**
 * WHAT TO TELL THE OWNER WHEN THE MODEL CALL FAILED.
 *
 * ── THE MESSAGE THIS REPLACES ────────────────────────────────────────────
 *
 *     couldn't reach my brain right now (groq 401: {"error":{"message":
 *     "Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}
 *     ). Try a slash command like /status.
 *
 * Seen in a live owner chat. It is three things wrong at once. It is provider
 * JSON pasted into a conversation; it says "reach", which is false — the
 * provider was reached and it answered; and it hides the one fact the owner
 * could act on, which is that THEIR key was refused and there is a house key
 * that would have worked. `settings.ts` resolves `groqApiKey` file-first, env
 * second, so a key pasted into Settings overrides the fleet key even when it is
 * wrong. The owner cannot know that from a 401.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────
 *
 * `providerError` in llm.ts already builds a safe string — status, provider,
 * the provider's own code and message, secrets redacted, capped. That is the
 * right thing to LOG. It is the wrong thing to SAY. Telegram is the owner's
 * channel, so unlike the public feed a remedy is exactly what belongs here —
 * but it has to be a sentence about their situation, not a transcript of an
 * HTTP exchange. This module maps the safe string onto the handful of situations
 * an owner can actually do something about, and gives each one its sentence.
 *
 * PURE. Takes the message a failed call threw and nothing else — no fetch, no
 * settings, no env — so it is testable as a table and cannot itself fail.
 *
 * NOT FOR THE PUBLIC FEED. Every sentence here names a remedy or a provider;
 * `thesis-policy.ts` keeps both off the public row on purpose.
 */

export type LlmFailureKind =
  | "key-rejected"
  | "rate-limited"
  | "provider-down"
  | "unreachable"
  | "model-missing"
  | "other";

export interface LlmFailure {
  kind: LlmFailureKind;
  /** Owner-facing, one or two sentences, no JSON, no HTTP status. */
  text: string;
}

/**
 * A provider error line: "<provider> <status> — <code>: <message>", which is
 * `providerError`'s shape — OR "<provider> <status>: <raw body>", which is what
 * `llmToolCall` used to throw and what the live owner chat actually showed.
 * Both separators are accepted so a message from either era classifies; the
 * tool-call path now uses `providerError` too, so the colon form is legacy.
 */
const PROVIDER_LINE = /^(\w[\w-]*)\s+(\d{3})(?:\s*[—:]\s*(.*))?$/s;

/**
 * Did this error come back from a model provider?
 *
 * For the catch blocks that answer the owner about a COMMAND — "/why failed",
 * "agent task failed" — where the cause may be anything at all. Only a message
 * in `providerError`'s shape is rewritten; "insufficient balance" or a stack
 * from a tool must keep its own words, because replacing those with a sentence
 * about model providers would be wrong in the other direction.
 */
export function isLlmProviderFailure(message: string): boolean {
  return PROVIDER_LINE.test((message ?? "").trim());
}

/**
 * Turn a failed call's message into what the owner should hear.
 *
 * The provider name is carried into the sentence because the owner may have
 * several keys in Settings and "your key" alone does not say which one.
 */
export function describeLlmFailure(message: string): LlmFailure {
  const msg = (message ?? "").trim();

  // No HTTP status at all: the request never completed. undici says "fetch
  // failed"; a timeout or a DNS miss reads similarly. This is the ONE case
  // where "couldn't reach" is true.
  if (!PROVIDER_LINE.test(msg)) {
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed? ?out|network/i.test(msg)) {
      return { kind: "unreachable", text: "I couldn't reach my model provider just now — the network, not your key. Try again in a minute." };
    }
    return { kind: "other", text: "my model call failed for a reason I don't recognise. Try again, or use a slash command like /status." };
  }

  const m = PROVIDER_LINE.exec(msg)!;
  const provider = m[1] ?? "provider";
  const status = Number(m[2] ?? "0");
  const detail = m[3] ?? "";
  const name = provider.charAt(0).toUpperCase() + provider.slice(1);

  if (status === 401 || status === 403 || /invalid_api_key|invalid api key|unauthori[sz]ed/i.test(detail)) {
    return {
      kind: "key-rejected",
      // THE FACT THE OWNER CANNOT SEE FROM A 401. A key in Settings overrides
      // the house key even when it is wrong, so the fix is not only "get a
      // valid key" — clearing the bad one is enough when a house key exists.
      text:
        `${name} rejected the API key I'm using. That is the ${name} key saved in this agent's Settings — ` +
        `it overrides the house key, so either replace it with a valid one or clear it and I'll fall back to the house key.`,
    };
  }
  if (status === 429 || /rate.?limit|quota|too many requests/i.test(detail)) {
    return { kind: "rate-limited", text: `${name} is rate-limiting me right now. Nothing is wrong with the key — try again shortly.` };
  }
  if (status === 404 || /model_not_found|does not exist/i.test(detail)) {
    return {
      kind: "model-missing",
      text: `${name} says the model this agent is set to use doesn't exist or isn't available on this key. Check the model name in Settings.`,
    };
  }
  if (status >= 500) {
    return { kind: "provider-down", text: `${name} is having trouble on its side (a server error). Not your key and not your settings — try again in a few minutes.` };
  }
  return {
    kind: "other",
    text: `${name} refused the request (${status}). Try again, or use a slash command like /status.`,
  };
}
