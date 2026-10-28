/**
 * WHETHER THIS DEPLOYMENT OFFERS SOLANA AT ALL. Off unless MERRYMEN_SOLANA=1.
 *
 * One server-side switch, read per request. The (app) layout hands it to the
 * terminal, which drops the network switch and the /solana screen; the /solana
 * page answers 404; and every /api/solana route refuses before it signs anyone
 * in or reads the database (solanaResponse). Hiding the screen alone would
 * still let a signed-in user bind a wallet and write solana_* rows.
 */
export function solanaEnabled(): boolean {
  return process.env.MERRYMEN_SOLANA?.trim() === "1";
}
