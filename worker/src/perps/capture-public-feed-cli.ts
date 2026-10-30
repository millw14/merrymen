import { capturePublicFeed } from "./capture-public-feed";
// No dotenv, worker start or network. The operator supplies a public feed path
// already produced by the one fleet feed; never start another venue socket.
const [source, output, samplesText, intervalText, ...extra] = process.argv.slice(2);
if (!source || !output || extra.length || (samplesText !== undefined && !/^\d+$/.test(samplesText)) || (intervalText !== undefined && !/^\d+$/.test(intervalText))) {
  console.error("Usage: MERRYMEN_PERPS_CAPTURE_PUBLIC_FEED=1 node --import tsx worker/src/perps/capture-public-feed-cli.ts /existing/lighter-feed.json /new/capture-directory [samples=120] [interval-ms=5000]");
  process.exitCode = 1;
} else {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const result = await capturePublicFeed({ source, output, samples: Number(samplesText ?? 120), intervalMs: Number(intervalText ?? 5_000), optIn: process.env.MERRYMEN_PERPS_CAPTURE_PUBLIC_FEED, signal: stop.signal });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete || result.unreadFrames) process.exitCode = 2;
  } catch (error) {
    // Filesystem error messages may embed supplied paths; no input contents or
    // environment values are printed here.
    console.error(error instanceof Error ? error.message : "Public feed capture failed."); process.exitCode = 1;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}
