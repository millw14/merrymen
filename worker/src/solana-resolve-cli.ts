import { guardStdio } from "./redact-stdio";
import { runSolanaResolveCommand, SolanaResolveError } from "./solana-resolve";
import { SolanaRpcError } from "./solana-rpc";
import { getSolanaRuntimeDb } from "./solana-runtime-db";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  console.log(await runSolanaResolveCommand(process.argv.slice(2), { db: await getSolanaRuntimeDb(), postgres: !!process.env.DATABASE_URL }));
} catch (error) {
  // Fixed messages only: no connection strings, endpoint URLs, provider text or stack traces.
  const known = error instanceof SolanaResolveError || error instanceof SolanaRpcError;
  // The failure may come after the store booked the outcome (a lost reply), so this text never says it is unbooked.
  console.error(known ? error.message : "The pending Solana trade or owner transaction could not be read or resolved. Check the shared database and the RPC settings. "
    + "The outcome may or may not be booked: run show again (owner show for an owner transaction) to see its status before anything else.");
  process.exitCode = 1;
}
