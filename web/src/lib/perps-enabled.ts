/**
 * MAY THIS SERVER OFFER A PERPS WALLET, MAY IT MAKE ONE, AND DOES ONE RUN
 * HERE? SERVER-SIDE ONLY.
 *
 * Three questions, all answered from MERRYMEN_PERPS through the one parser the
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
 * - WORKERS RUN (ceiling is paper): a Perps wallet's worker runs here, so its
 *   practice book takes the owner's orders and resets. Under any other ceiling
 *   the orchestrator starts none (orchestrator.ts perpsSpawnable) and a
 *   self-hosted one claims nothing (worker settings.ts perpsWorkerStoodDown):
 *   the wallet's practice positions are FROZEN, and a command queued for them
 *   would wait, unseen, to run whenever perps came back (D1, D19).
 *
 * IN THIS BUILD THE THREE ARE THE SAME ANSWER, because the ceiling is only ever
 * off or paper: `live` is read as off (perpsCeilingOf). They are separate
 * because they part the day live exists, when an owner's live Perps wallet is
 * offered on a server that may still make only paper ones, and its worker runs
 * there to close what is held at the venue. A caller asks the question it
 * means, so that day changes this file and no route.
 *
 * Whatever any of them says, the kill, withdraw and recover paths do not ask:
 * a gate that switches a capability off must never stand between an owner and
 * stopping, or getting their money out of, a wallet that already exists. Nor
 * does turning perps OFF in a Perps wallet's settings (api/settings): only
 * what would turn something on is refused there.
 *
 * SERVER-SIDE ONLY: it reads process.env, which Next does not inline into a
 * browser bundle (client-env.test.ts), so in a client module it would always
 * say off. perps-enabled.test.ts holds that no client module imports it.
 */
import { NextResponse } from "next/server";
import { perpsCeilingOf } from "../../../packages/core/src/perps-ceiling";
import { NO_STORE_HEADERS } from "./route-guard";

type Env = Readonly<Record<string, string | undefined>>;

/** Perps exists on this server: MERRYMEN_PERPS is not off. */
export function perpsOffered(env: Env = process.env): boolean {
  return perpsCeilingOf(env.MERRYMEN_PERPS) !== "off";
}

/** A Perps wallet may be made or renewed on this server: MERRYMEN_PERPS is paper. */
export function perpsCreationAllowed(env: Env = process.env): boolean {
  return perpsCeilingOf(env.MERRYMEN_PERPS) === "paper";
}

/** A Perps wallet's worker runs on this server, and takes its owner's orders and resets: MERRYMEN_PERPS is paper. */
export function perpsWorkersRun(env: Env = process.env): boolean {
  return perpsCeilingOf(env.MERRYMEN_PERPS) === "paper";
}

/**
 * THE ONE REFUSAL A PERPS ROUTE GIVES WHEN ONE OF THE QUESTIONS ABOVE SAYS NO:
 * 403 `perps-wallet-not-offered`, the code the grants route answers with, so a
 * client reads one code for "not on this server" wherever it asks. `sentence`
 * says what was not done and what still works; it is the owner's to read.
 * Never stored by anything in between.
 */
export function perpsWalletRefused(sentence: string): NextResponse {
  return NextResponse.json(
    { error: `Perps wallets are not offered on this server yet. ${sentence}`, code: "perps-wallet-not-offered", ownerFacing: true },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}
