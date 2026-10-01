/** Stop the service without signing, deleting browser keys, or claiming on-chain revocation. */
export async function stopAgent(expectedTenant?: string | null): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/grants", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedTenant: expectedTenant ?? undefined }),
    });
  } catch {
    throw new Error("The service did not confirm the stop request. Your wallet and recovery access were kept; try again.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `The service did not confirm the stop request (${response.status}). Your wallet was kept.`);
  }
}
