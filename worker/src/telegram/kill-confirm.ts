/**
 * THE KILL SWITCH AS A CHAT SEES IT: the question, and the answer.
 *
 * Two processes answer a hosted owner's bot: the trading child (executor.ts)
 * and, while trading is held, the hold process (hold.ts). Both must ask the
 * same question before a kill and say exactly what a kill did, and the hold
 * process may not import the executor, which pulls in the model and the
 * ledger. So the words live here, and import nothing.
 */

/** How long a parked action waits for /confirm (executor.ts re-exports it). */
export const CONFIRM_TTL_SEC = 90;

/**
 * What a kill actually did, so the reply can say exactly that.
 *
 * `revocation` is present only for a HOSTED kill (kill-request.ts). There the
 * grant lives in the tenant store and this agent only holds a copy of it.
 * `queued`: the copy is gone and the server will remove the stored grant.
 * `failed`: the copy is gone, but the request that stops the server restoring
 * it could not be written.
 */
export interface KillResult {
  ok: boolean;
  reason?: string;
  archived?: string | null;
  revocation?: "queued" | "failed";
}

/** The question /kill asks before anything happens. */
export function killPromptText(hosted: boolean, ttlSec = CONFIRM_TTL_SEC): string {
  if (hosted) {
    // Hosted there is no owner key on the server (the grant store refuses
    // one) and no `merrymen recover` to run on it.
    return (
      `⚠️ <b>confirm kill</b> — this revokes my trading permission and stands the band down.\n` +
      `Your funds stay in your smart account; the server never held your owner key.\n\n` +
      `/confirm to kill (${ttlSec}s) or /cancel.`
    );
  }
  return (
    `⚠️ <b>confirm kill</b> — this destroys the grant and stands the band down.\n` +
    `Your owner key is archived to <code>~/.merrymen/grants/</code> first, so ` +
    `<code>merrymen recover</code> can still sweep the funds.\n\n` +
    `/confirm to kill (${ttlSec}s) or /cancel.`
  );
}

/** The answer once /confirm has run the kill. */
export function killDoneText(r: KillResult): string {
  if (!r.ok) return `nothing to kill: ${r.reason ?? "no grant"}`;
  // HOSTED: say only what THIS agent did. Nothing was archived. The
  // stored grant is deleted by the server a few seconds later, and the
  // server confirms that itself, because only it knows (KILL_DONE_TEXT,
  // kill-request.ts). The request waits in a home a redeploy would
  // discard, so a missing ✅ has to mean something the owner can act on.
  if (r.revocation === "queued") {
    return (
      `🛑 KILL SWITCH — this agent's copy of the key is gone, and the band stands down on the next tick. ` +
      `The server is deleting your stored grant now; you'll get a ✅ in the owner chat when it's done.\n` +
      `No ✅ within a few minutes? Revoke it in the dashboard: You → Wallet &amp; permissions → discard &amp; start over. ` +
      `Your funds stay in your smart account.`
    );
  }
  if (r.revocation === "failed") {
    return (
      `⚠️ KILL SWITCH — only half done. This agent's copy of the key is gone, but I could not record the kill, ` +
      `so the server may hand the key back on its next pass.\n` +
      `Revoke it for good in the dashboard: You → Wallet &amp; permissions → discard &amp; start over.`
    );
  }
  return (
    `🛑 KILL SWITCH — grant destroyed, the band stands down on the next tick.\n` +
    (r.archived
      ? `Owner key archived to <code>~/.merrymen/grants/</code> — <code>merrymen recover</code> can still sweep the funds.`
      : `⚠️ nothing could be archived — if this account held funds, check ~/.merrymen/grants/ before re-granting.`) +
    `\nRe-grant in the dashboard to ride again.`
  );
}
