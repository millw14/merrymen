/**
 * THE HOLD PROCESS: what the orchestrator runs for a tenant whose trading is
 * held because its practice book could not be restored (orchestrator.ts
 * spawnHolder). It answers the owner's bot and does nothing else; what it says
 * and why is in telegram/hold.ts.
 *
 * Started like a child, with the child's env (childEnv: this tenant's home,
 * hosted, no DATABASE_URL and none of the orchestrator's secrets), under the
 * lease the orchestrator already holds for the tenant. Stopped with SIGTERM
 * when the restore succeeds, just before the trading child starts in the same
 * home, or when the tenant is stood down.
 *
 * It mints the link code the way index.ts does at startup, so the dashboard's
 * code works whichever of the two processes the owner sends it to, and never
 * prints it: hosted, this log is the fleet's.
 */
import { resolveConfig } from "./settings";
import { createStateRef, ensureLinkCode, retireLegacyCode } from "./telegram/state";
import { startHoldTelegram } from "./telegram/hold";

const tgState = createStateRef();
const cfg = resolveConfig();
if (cfg.telegramBotToken) {
  const before = tgState.get().linkCode;
  tgState.set(ensureLinkCode(retireLegacyCode(tgState.get(), cfg.telegramBotToken)));
  const minted = tgState.get().linkCode !== before;
  if (minted) console.log("[telegram] link code ready (shown on the dashboard)");
}

startHoldTelegram({
  // Fresh on every read, as in the child: a /link writes the allowlist to
  // settings.json, and the orchestrator rewrites it every pass.
  getCfg: () => resolveConfig(),
  stateRef: tgState,
});

console.log("merrymen hold process started — trading is held; answering Telegram only");
