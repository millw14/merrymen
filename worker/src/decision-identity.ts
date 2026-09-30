import { addTrade, decisionAgent, lifecycleOf } from "./store";

export function verifyDecisionOwner(owner: string | null | undefined, agentId: string): { ok: true } | { ok: false; why: string } {
  if (owner === undefined) return { ok: false, why: "could not verify the decision this trade belongs to" };
  if (owner === null) return { ok: false, why: "that decision does not exist" };
  if (owner.toLowerCase() !== agentId.toLowerCase()) return { ok: false, why: "that decision belongs to another agent" };
  return { ok: true };
}

/** Record a preflight refusal only when execution has not already recorded an outcome. */
export async function recordDecisionRefusal(decisionId: string, agentId: string, reason: string): Promise<boolean> {
  if (!verifyDecisionOwner(await decisionAgent(decisionId), agentId).ok) return false;
  const life = await lifecycleOf(decisionId);
  if (!life || life.trades.length) return false;
  const size = life.decision.size_usdg;
  return addTrade({
    agent_id: agentId,
    decision_id: decisionId,
    // No executable intent was built, so there is no router, transaction or fill.
    kind: "decision-preflight",
    target: "",
    amount_usdg: size !== null && Number.isFinite(size) ? Math.max(0, size) : 0,
    status: "rejected",
    reject_rule: `preflight: ${reason}`,
  });
}

export async function withDecisionOutcome<T extends { ok: boolean; line: string }>(
  agentId: string | undefined,
  decisionId: string | undefined,
  submit: () => Promise<T>,
): Promise<T> {
  const reply = await submit();
  if (!reply.ok && agentId && decisionId) await recordDecisionRefusal(decisionId, agentId, reply.line);
  return reply;
}
