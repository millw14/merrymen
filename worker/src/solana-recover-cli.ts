import { guardStdio } from "./redact-stdio";
import { SolanaVaultValidationError } from "../../packages/core/src/solana-live";
import { SolanaRecoverError } from "./solana-recover";
import { runSolanaRecoverCommand } from "./solana-recover-command";
import { SolanaRpcError } from "./solana-rpc";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  const result = await runSolanaRecoverCommand(process.argv.slice(2));
  if (typeof result === "string") console.log(result);
} catch (error) {
  // Fixed messages only: never key material, the RPC URL, provider text or stacks.
  const known = error instanceof SolanaRecoverError || error instanceof SolanaRpcError || error instanceof SolanaVaultValidationError;
  console.error(known ? error.message : "Recovery stopped on an unexpected error. Run the command again: it re-reads the chain before sending anything.");
  process.exitCode = 1;
}
