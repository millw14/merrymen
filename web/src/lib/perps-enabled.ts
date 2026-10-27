/**
 * MAY THIS SERVER OFFER A PERPS WALLET, AND MAY IT MAKE ONE? SERVER-SIDE ONLY.
 *
 * Two questions, both answered from MERRYMEN_PERPS through the one parser the
 * worker and the orchestrator use (packages/core/src/perps-ceiling.ts), so the
 * web can never offer what the deployment's workers would refuse to run. The
 * web and the orchestrator must be given the same value (the Phase 3 deploy
 * checklist): a web that offers Perps beside an orchestrator that stands its
 * workers down would sell the owner a wallet that never trades.
 *
 * - OFFERED (ceiling is not off): Perps exists on this server at all — the
 *   desk, the Perps routes, and the Perps wallet's own reads and settings.
 * - CREATION ALLOWED (ceiling is paper): a Perps wallet may be made or renewed
 *   here, on paper.
 *
 * IN THIS BUILD THE TWO ARE THE SAME ANSWER, because the ceiling is only ever
 * off or paper: `live` is read as off (perpsCeilingOf). They are separate
 * because they part the day live exists, when an owner's live Perps wallet is
 * offered on a server that may still make only paper ones. A caller asks the
 * question it means, so that day changes this file and no route.
 *
 * Whatever either says, the kill, withdraw and recover paths do not ask it: a
 * gate that switches a capability off must never stand between an owner and
 * stopping, or getting their money out of, a wallet that already exists.
 *
 * SERVER-SIDE ONLY: it reads process.env, which Next does not inline into a
 * browser bundle (client-env.test.ts), so in a client module it would always
 * say off. perps-enabled.test.ts holds that no client module imports it.
 */
import { perpsCeilingOf } from "../../../packages/core/src/perps-ceiling";

type Env = Readonly<Record<string, string | undefined>>;

/** Perps exists on this server: MERRYMEN_PERPS is not off. */
export function perpsOffered(env: Env = process.env): boolean {
  return perpsCeilingOf(env.MERRYMEN_PERPS) !== "off";
}

/** A Perps wallet may be made or renewed on this server: MERRYMEN_PERPS is paper. */
export function perpsCreationAllowed(env: Env = process.env): boolean {
  return perpsCeilingOf(env.MERRYMEN_PERPS) === "paper";
}
