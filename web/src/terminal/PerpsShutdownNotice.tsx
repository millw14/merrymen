/** A deleted grant never proves that venue custody has ended. */
export function perpsShutdownLines(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { state?: unknown; result?: unknown };
  const lines = [s.state === "queued" || s.state === "pending" ? "Perpetual shutdown is queued; positions may still be open at Lighter."
    : s.state === "running" ? "Perpetual shutdown is running; closes and withdrawals are not yet confirmed."
    : s.state === "done" ? "The perpetual shutdown worker has finished. Its result does not by itself prove that funds have arrived home."
    : "Perpetual shutdown has no confirmed completion. Positions or collateral may remain at Lighter."];
  if (s.result && typeof s.result === "object") {
    const r = s.result as Record<string, unknown>;
    for (const [key, label] of [["openPositions", "Open positions at the shutdown reading"], ["ordersLeft", "Resting orders at that reading"]]) {
      const value = r[key!];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) lines.push(`${label}: ${value}.`);
    }
    if (typeof r.collateralMicro === "string" && /^\d{1,40}$/.test(r.collateralMicro)) {
      const value = BigInt(r.collateralMicro);
      lines.push(`Collateral at that reading: ${value / 1_000_000n}.${((value % 1_000_000n) / 10_000n).toString().padStart(2, "0")} USDG.`);
    }
    if (r.outcome === "unreachable") lines.push("Lighter could not be reached; its current balances are unknown.");
    if (r.ingested === false) lines.push("The shutdown history has not yet been fully recorded in your ledger.");
  } else lines.push("The venue result has not been read. Unknown is not an empty account.");
  lines.push("Check the venue custody and any pending withdrawal claim in Withdraw / Recover, even after the agent is removed.");
  return lines;
}
export function PerpsShutdownNotice({ status }: { status: unknown }) {
  const lines = perpsShutdownLines(status);
  if (!lines) return null;
  return <section className="desk-note perps-shutdown" role="status" aria-label="Perpetual shutdown custody">
    <strong>Perpetuals · Lighter</strong>
    {lines.map((line) => <p key={line}>{line}</p>)}
    <a href="/withdraw">Check venue custody →</a>
  </section>;
}
