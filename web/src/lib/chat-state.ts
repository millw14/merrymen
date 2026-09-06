/**
 * THE STATE THE AGENT ANSWERS FROM MUST PARSE.
 *
 * The chat is deliberately stateless on the server: the browser holds the book
 * and sends it, because a hosted web service cannot read a worker child's
 * ledger. So `state` is a JSON blob assembled in the client, and the system
 * prompt tells the model to ground every number in it.
 *
 * It was clamped with `body.state.slice(0, 6000)`, which cuts wherever 6,000
 * characters happens to land — mid-object, mid-string, mid-number. The model
 * then received malformed JSON with no marker that anything had been dropped,
 * and answered from it anyway, because a model asked to ground itself in a
 * document does not refuse a document that fails to parse. It reads what it can
 * and fills the rest.
 *
 * A tester's agent consequently reported months-old `no-gas` and
 * `per-trade-cap` refusals in the present tense, having read half a trade
 * record. Both halves of that were bugs — the tape had no time window either —
 * but this is the half that turns a stale answer into an unpredictable one.
 *
 * So: drop WHOLE entries, oldest first, and say that you did.
 */

/** How much of the prompt the book may occupy. Unchanged from the old slice. */
export const STATE_BUDGET = 6000;

/**
 * Fit a client-supplied state blob into the budget without corrupting it.
 *
 * Returns "" for anything that will not parse. A malformed STATE is worse than
 * no STATE: with none, the prompt's own rule ("say you do not know") applies
 * and the agent says so; with a fragment, it answers confidently from wreckage.
 */
export function fitChatState(raw: unknown, budget = STATE_BUDGET): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  if (raw.length <= budget) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // It arrived broken. Forwarding a prefix of broken JSON is strictly worse.
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";

  const obj = parsed as Record<string, unknown>;
  const moves = Array.isArray(obj.moves) ? [...(obj.moves as unknown[])] : null;

  // THE TAPE IS THE ONLY UNBOUNDED FIELD, and its oldest end is the least
  // useful — a refusal from last month explains nothing about today. Everything
  // else in the state is one value per key and is kept whole.
  if (moves) {
    while (moves.length > 0) {
      const candidate = JSON.stringify({ ...obj, moves, truncated: true });
      if (candidate.length <= budget) return candidate;
      moves.shift();
    }
  }

  // Even with no tape at all it does not fit. Say so rather than cut: the
  // remaining fields are single values, and half of one is not a smaller
  // version of it.
  const bare = JSON.stringify({ ...obj, moves: [], truncated: true });
  return bare.length <= budget ? bare : "";
}
