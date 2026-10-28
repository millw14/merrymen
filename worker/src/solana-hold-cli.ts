import { guardStdio } from "./redact-stdio";
import { runSolanaHoldCommand, SolanaOperatorHoldError } from "./solana-operator-hold";
import { getSolanaRuntimeDb } from "./solana-runtime-db";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  console.log(await runSolanaHoldCommand(await getSolanaRuntimeDb(), process.argv.slice(2), Date.now(), !!process.env.DATABASE_URL));
} catch (error) {
  // Only fixed messages: no connection strings, provider text or stack traces.
  console.error(error instanceof SolanaOperatorHoldError ? error.message : "The Solana hold could not be read or written. Check the shared database.");
  process.exitCode = 1;
}
