import { guardStdio } from "./redact-stdio";
import { probeSolanaMainnetRpc, readSolanaMainnetRpcConfig, SolanaRpcError } from "./solana-rpc";

// First, before anything can print: a keyed RPC URL never reaches stdout or stderr (#347).
guardStdio();
try {
  const result = await probeSolanaMainnetRpc(readSolanaMainnetRpcConfig());
  console.log(`Solana RPC: ${result.cluster} identity verified; healthy; finalized slot ${result.slot}.`);
  console.log("This read-only check does not enable Solana trading or verify trade readiness.");
} catch (error) {
  // The diagnostic must never print credentials, provider text, or stack traces.
  console.error(error instanceof SolanaRpcError ? error.message : "Solana RPC check failed.");
  process.exitCode = 1;
}
