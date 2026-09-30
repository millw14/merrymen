export function PerpsRecoveryNotice({ status }: { status: unknown }) {
  if (!status || typeof status !== "object") return null;
  const state = (status as { state?: unknown }).state;
  if (state !== "paused" && state !== "unknown") return null;
  return <section className="desk-note" role="status" aria-label="Perpetual recovery status">
    <strong>Perpetuals · Lighter</strong>
    <p>{state === "paused"
      ? "Live perpetuals are paused because this account’s recovery history could not be verified. Spot and paper trading remain available."
      : "The live perpetual recovery status could not be checked. Spot and paper trading remain available."}</p>
  </section>;
}
