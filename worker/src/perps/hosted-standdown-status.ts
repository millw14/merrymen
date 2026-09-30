/** Owner copy is based on custody evidence; mirror completion is never custody evidence. */
export function hostedStanddownConfirmation(job: { state: string; resultJson: string | null }): string {
 const prefix = "Your stored trading grant is deleted. ";
 if (job.state === "pending" || job.state === "running") return prefix + "A temporary venue-only shutdown is queued or running for up to 15 minutes. Positions and collateral may still be on Lighter; resting stops stay until each position reads flat. Check Withdraw / Recover for the result.";
 let result: Record<string, unknown> | null = null;
 try { result = job.resultJson ? JSON.parse(job.resultJson) as Record<string, unknown> : null; } catch {}
 if (job.state === "expired" || !result || result.outcome === "unreachable" || result.ingested !== true) {
  return prefix + "The shutdown has no fully recorded completion. Lighter custody is unknown; positions or collateral may remain there. Check Withdraw / Recover and any pending withdrawal claim.";
 }
 if (result.outcome === "residual" || (typeof result.otherAccounts === "number" && result.otherAccounts > 0)) {
  return prefix + "The shutdown worker finished with residual or inaccessible venue custody. Positions or collateral may remain on Lighter. Check Withdraw / Recover and any pending withdrawal claim.";
 }
 return prefix + "The shutdown worker finished. Its completion does not confirm that a withdrawal has arrived home. Check Withdraw / Recover for venue custody and any pending claim.";
}
