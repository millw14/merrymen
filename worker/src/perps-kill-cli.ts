/**
 * The Perps half of `merrymen kill` (cli/bin.mjs), which cannot import the
 * worker: the local Perps wallet's grant is archived and revoked and its paper
 * strategy turned off, as the dashboard's and Telegram's self-hosted kills do
 * (stopLocalPerpsWallet). Prints "stopped" followed by what was done ("grant",
 * "paper"), or "none". Exits 1 with the reason when the grant could not be
 * revoked, and 2 when it was but the paper strategy could not be turned off.
 */
import { guardStdio } from "./redact-stdio";
import { PerpsKillIncomplete, PerpsPaperNotStopped, stopLocalPerpsWallet } from "./perps-kill";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  const done = await stopLocalPerpsWallet();
  const what = [done.grant === "revoked" ? "grant" : null, done.paper === "disabled" ? "paper" : null].filter(Boolean);
  console.log(what.length > 0 ? `stopped ${what.join(" ")}` : "none");
} catch (e) {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  console.error(e instanceof PerpsKillIncomplete ? e.message
    : `The local Perps wallet's grant could not be read or revoked${typeof code === "string" ? ` (${code})` : ""}. Check ~/.merrymen/accounts/perps/, and run the kill as the user that owns it.`);
  process.exitCode = e instanceof PerpsPaperNotStopped ? 2 : 1;
}
