import { guardStdio } from "./redact-stdio";
import { SolanaPaperValidationError } from "../../packages/core/src/solana";
import { SolanaRpcError } from "./solana-rpc";
import { SolanaMarketError } from "./solana-market";
import { SolanaPaperStoreError } from "./solana-paper-store";
import { SolanaPaperServiceError } from "./solana-paper-service";
import { runSolanaPaperCommand, SolanaPaperCommandError } from "./solana-paper-command";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  const result = await runSolanaPaperCommand(process.argv.slice(2));
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
} catch (error) {
  const known = error instanceof SolanaPaperValidationError || error instanceof SolanaRpcError
    || error instanceof SolanaMarketError || error instanceof SolanaPaperStoreError
    || error instanceof SolanaPaperServiceError || error instanceof SolanaPaperCommandError;
  console.error(known ? error.message : "Solana paper operation failed. No live transaction was submitted.");
  process.exitCode = 1;
}
