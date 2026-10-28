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
 *   self-hosted one claims no command (worker settings.ts
 *   perpsWorkerStoodDown), so a command queued for the book would only wait,
 *   unclaimed, inside the window every Perps exit and reset carries
 *   (`expiresAt`): run if perps came back inside it, answered expired with
 *   nothing done once it has passed (D1, D19). The owner would be told
 *   "queued" for something nothing is doing, so it is refused. Hosted, the
 *   practice positions stay frozen meanwhile; self-hosted, a worker started by
 *   hand still keeps their stops (perpsStoodDownBook below says which, to the
 *   owner).
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
 * WHAT BECOMES OF THE PERPS WALLET'S PRACTICE POSITIONS WHILE NO PERPS WORKER
 * RUNS HERE, in the owner's words, for the refusal of an exit (api/orders) or
 * a practice reset (api/paper-reset). Two different truths, so two sentences,
 * and the route says which deployment it is (`hosted`: this module reads no
 * mode, see the header).
 *
 * - HOSTED, NOTHING MOVES THEM. The orchestrator starts no Perps worker under
 *   any ceiling but paper (orchestrator.ts perpsSpawnable), given the same
 *   MERRYMEN_PERPS as this web, which the Phase 3 deploy checklist holds
 *   (D18). With no child, no stop, take-profit, liquidation or funding is
 *   booked against what is held: the positions stay exactly as they were.
 * - SELF-HOSTED, A WORKER MAY STILL BE RUNNING, and this server cannot see
 *   whether one is. Nothing here starts one under any ceiling but paper, but
 *   one started by hand keeps running, and D19 stands it down from the
 *   owner's COMMANDS only (settings.ts perpsWorkerStoodDown). Its protective
 *   loop goes on, on purpose: it starts with every arm, and a held position
 *   keeps the lane active whatever the switch says (lane.ts armed, the
 *   review's S3-02), so what that worker holds keeps its stops and closes on
 *   its own rules. Switching those off to make "frozen" true would leave a
 *   running book with no stop; so the sentence says what is true instead.
 *   It used to say "stay exactly as they are" here too, while that worker's
 *   stop closed the position the owner had just been refused a Close for.
 */
export function perpsStoodDownBook(hosted: boolean): string {
  return hosted
    ? "Practice perpetuals are not running here, so your Perps wallet's practice positions stay exactly as they are until they do."
    : "Practice perpetuals are not running here, so your Perps wallet takes no orders or resets until they do. A Perps worker still running on this machine goes on managing the practice positions it holds by their own rules: their stops, take-profits, liquidation and funding.";
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
