/**
 * The Solana half of `merrymen kill` (cli/bin.mjs), which cannot import the
 * worker: every local Solana strategy is turned off with a revision bump, as
 * the dashboard's and Telegram's self-hosted kills do (stopLocalSolanaForKill).
 * Prints "stopped" or "none"; exits 1 with a fixed message when it could not.
 */
import { guardStdio } from "./redact-stdio";
import { stopLocalSolanaForKill } from "./solana-kill";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  console.log(await stopLocalSolanaForKill());
} catch {
  console.error("The local Solana strategy could not be stopped. Check the Solana accounts database.");
  process.exitCode = 1;
}
