/** Explicitly discard the server permission and agent memory; preserve browser recovery keys. */
export async function deleteAgent(expectedTenant?: string | null): Promise<void> {
  return requestStop({ purpose: "delete-agent", expectedTenant: expectedTenant ?? undefined });
}

/** Retire the old permission while retaining the agent's home and Telegram memory. */
export async function stopAgentForReplacement(
  expectedTenant: string | null | undefined,
  expectedAccount: string,
  expectedSession?: string,
): Promise<void> {
  return requestStop({
    purpose: "permission-replacement",
    expectedTenant: expectedTenant ?? undefined,
    expectedAccount,
    expectedSession,
  });
}

async function requestStop(body: Record<string, string | undefined>): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/grants", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("The service did not confirm the stop request. Your wallet and recovery access were kept; try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `The service did not confirm the stop request (${response.status}). Your wallet was kept.`);
  }
}
