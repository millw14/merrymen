import { readFileSync } from "node:fs";
import path from "node:path";
import { runPerpsReplay } from "./backtest";
import { brainDecisionsForFrames, mergeBrainSourceFrames, recordedBrainProducer, verifiedBrainRunIds } from "./replay-brain";
import { evaluatePerpsWalkForward } from "./replay-evaluation";
import { parseFeedRecording, recordPublicFeed } from "./replay-recorder";
import { scoreRecordedPerpsForecasts } from "./replay-forecast";

const print = (value: unknown) => console.log(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
const usage = "Usage: backtest-cli.ts [replay] replay.json | record FEED OUTPUT DURATION_SECONDS [INTERVAL_MS] | evaluate evaluation.json";
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "record") {
    if (args.length < 4 || args.length > 5) throw new Error(usage);
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      print(await recordPublicFeed({ inputPath: args[1]!, outputPath: args[2]!, durationMs: Number(args[3]) * 1000,
        intervalMs: args[4] === undefined ? undefined : Number(args[4]), signal: ac.signal }));
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return;
  }
  const evaluate = args[0] === "evaluate";
  const file = args.length === 1 ? args[0] : args.length === 2 && (evaluate || args[0] === "replay") ? args[1] : undefined;
  if (!file) throw new Error(usage);
  const input = JSON.parse(readFileSync(file, "utf8"));
  if (!input || !input.config) throw new Error("expected replay config");
  const loadedFrames = input.recording ? parseFeedRecording(readFileSync(path.resolve(path.dirname(file), input.recording), "utf8")).frames : input.frames;
  if (!Array.isArray(loadedFrames)) throw new Error("expected frames or a recording path");
  if (input.brainDecisions !== undefined && !Array.isArray(input.brainDecisions)) throw new Error("expected brainDecisions array");
  const frames = mergeBrainSourceFrames(loadedFrames, input.brainDecisions ?? []);
  if (evaluate) {
    if (!input.plan || !Array.isArray(input.brainDecisions)) throw new Error("expected evaluation plan and brainDecisions");
    const result = evaluatePerpsWalkForward({ config: input.config, frames, plan: input.plan,
      producer: testFrames => recordedBrainProducer(brainDecisionsForFrames(input.brainDecisions, testFrames), input.plan.strategyVersion) });
    print({ ...result, forecasts: result.folds.map(fold => {
      const testFrames = frames.filter(frame => frame.atMs >= fold.testStartMs && frame.atMs < fold.testEndMs);
      return scoreRecordedPerpsForecasts(brainDecisionsForFrames(input.brainDecisions, testFrames), testFrames,
        verifiedBrainRunIds(fold.candidate?.producerDiagnostics));
    }) });
    if (result.status === "insufficient-evidence") process.exitCode = 2;
  } else {
    if (input.brainDecisions !== undefined && (!Array.isArray(input.brainDecisions) || typeof input.strategyVersion !== "string"))
      throw new Error("recorded Brain replay needs brainDecisions and strategyVersion");
    const result = runPerpsReplay(input.config, frames, input.brainDecisions === undefined ? undefined : recordedBrainProducer(input.brainDecisions, input.strategyVersion));
    print({ ...result, forecasts: input.brainDecisions === undefined ? undefined :
      scoreRecordedPerpsForecasts(input.brainDecisions, frames, verifiedBrainRunIds(result.producerDiagnostics)) });
    if (!result.complete) process.exitCode = 2;
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "replay failed"); process.exitCode = 1; });
