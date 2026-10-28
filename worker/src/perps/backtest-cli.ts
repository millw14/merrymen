import { readFileSync } from "node:fs";
import { runPerpsReplay } from "./backtest";
// A separate offline entry point: it never starts the trading worker.
const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error("Usage: node --import tsx worker/src/perps/backtest-cli.ts replay.json");
  process.exitCode = 1;
}
else {
  try {
    const input = JSON.parse(readFileSync(file, "utf8"));
    if (!input || !input.config || !Array.isArray(input.frames))
      throw new Error("expected {config, frames}");
    const result = runPerpsReplay(input.config, input.frames);
    console.log(JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    if (!result.complete)
      process.exitCode = 2;
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : "replay failed");
    process.exitCode = 1;
  }
}
