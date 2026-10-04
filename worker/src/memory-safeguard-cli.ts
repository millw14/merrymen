/** Ops-only entry point. Default capture is read-only; seed must be requested explicitly. */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePgDb } from "./db";
import { requireDek } from "./store-crypto";
import { checkpointFleetLedger } from "./ledger-safeguard";
import { accountingHoldTenants } from "./accounting-maintenance";
import { merrymenHome } from "./home";
import {
  captureFleetMemory, openMemoryBackup, readMemoryBackupArtifact, sealMemoryBackup,
  seedMemoryBackup, verifyMemoryBackup, writeMemoryBackupArtifact, type MemorySource,
} from "./memory-safeguard";

const fail = () => new Error("Memory safeguard refused. No personal content was logged; review the source, halt, identity and artifact checks.");
function procFile(file: string): string {
  const st = lstatSync(file);
  if (!st.isFile() || st.size > 64 * 1024) throw fail();
  // procfs reports size zero; cap after reading as well.
  const text = readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > 64 * 1024) throw fail();
  return text;
}
function processStart(text: string): string {
  const last = text.lastIndexOf(")");
  const start = text.slice(last + 2).trim().split(/\s+/)[19];
  if (last < 0 || !start || !/^\d+$/.test(start)) throw fail();
  return start;
}
const entry = (args: string[], suffix: string) => args.some(arg => arg.endsWith(`/worker/src/${suffix}`) || arg === `worker/src/${suffix}`);

/** Only public process metadata: never /proc/environ, settings, grant or bot files. */
export function inspectMemorySource(o: {
  expectedDeployment: string; expectedCommit: string; orchestratorPid: number;
  home: string; quiescent: boolean; singleReplicaConfirmed: boolean;
}, env: Record<string, string | undefined> = process.env, procRoot = "/proc"): MemorySource {
  if (!o.expectedDeployment || !/^[\w.-]{1,128}$/.test(o.expectedDeployment)
      || !/^[0-9a-f]{40}$/.test(o.expectedCommit) || !Number.isSafeInteger(o.orchestratorPid) || o.orchestratorPid < 1
      || env.RAILWAY_DEPLOYMENT_ID !== o.expectedDeployment || env.RAILWAY_GIT_COMMIT_SHA !== o.expectedCommit) throw fail();
  if (!lstatSync(o.home).isDirectory()) throw fail();
  const pidDir = path.join(procRoot, String(o.orchestratorPid));
  const command = procFile(path.join(pidDir, "cmdline")).split("\0");
  if (!entry(command, "orchestrator.ts")) throw fail();
  const stat = procFile(path.join(pidDir, "stat"));
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (fields[0] === "Z" || fields[0] === "X") throw fail();
  if (o.quiescent) {
    if (!lstatSync(path.join(o.home, "FLEET_HALT")).isFile()) throw fail();
    const pids = readdirSync(procRoot).filter(pid => /^\d+$/.test(pid));
    if (pids.length > 4096) throw fail();
    for (const pid of pids) {
      let args: string[];
      try { args = procFile(path.join(procRoot, pid, "cmdline")).split("\0"); }
      catch (e) { if ((e as { code?: unknown }).code === "ENOENT") continue; throw fail(); }
      if (entry(args, "index.ts") || entry(args, "telegram-hold.ts")) throw fail();
    }
  }
  return { deploymentId: o.expectedDeployment, gitCommit: o.expectedCommit,
    orchestratorPid: o.orchestratorPid, orchestratorStart: processStart(stat),
    quiescent: o.quiescent, singleReplicaConfirmed: o.singleReplicaConfirmed };
}

function argumentsFor(argv: string[]): { mode: string; values: Map<string, string>; flags: Set<string> } {
  const mode = argv[0] ?? "";
  if (!["capture", "verify", "seed", "checkpoint"].includes(mode)) throw fail();
  const values = new Map<string, string>(), flags = new Set<string>();
  const booleans = new Set(["--quiescent", "--single-replica-confirmed"]);
  const named = new Set(["--expected-deployment", "--expected-commit", "--orchestrator-pid", "--output", "--artifact"]);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (booleans.has(arg) && !flags.has(arg)) { flags.add(arg); continue; }
    if (!named.has(arg) || values.has(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw fail();
    values.set(arg, argv[++i]!);
  }
  return { mode, values, flags };
}

export async function runMemorySafeguardCli(argv: string[]): Promise<Record<string, unknown>> {
  const { mode, values, flags } = argumentsFor(argv);
  const dek = requireDek();
  if (mode === "verify") {
    if (!values.get("--artifact")) throw fail();
    const backup = openMemoryBackup(readMemoryBackupArtifact(path.resolve(values.get("--artifact")!)), dek);
    return { operation: "verified", ...await verifyMemoryBackup(backup, dek) };
  }
  const home = merrymenHome();
  if (!home || !path.isAbsolute(home) || !process.env.DATABASE_URL) throw fail();
  const opts = { home, expectedDeployment: values.get("--expected-deployment") ?? "",
    expectedCommit: values.get("--expected-commit") ?? "", orchestratorPid: Number(values.get("--orchestrator-pid")),
    quiescent: flags.has("--quiescent"), singleReplicaConfirmed: flags.has("--single-replica-confirmed") };
  const source = inspectMemorySource(opts);
  const assertSource = () => {
    if (JSON.stringify(inspectMemorySource(opts)) !== JSON.stringify(source)) throw fail();
  };
  const shared = await makePgDb(process.env.DATABASE_URL);
  const childrenDir = path.join(home, "children");
  if (mode === "capture") {
    if (!values.get("--output")) throw fail();
    const backup = await captureFleetMemory({ childrenDir, shared, dek, source, assertSource });
    const sealed = sealMemoryBackup(backup, dek);
    const ciphertextSha256 = writeMemoryBackupArtifact(path.resolve(values.get("--output")!), sealed);
    const counts = await verifyMemoryBackup(openMemoryBackup(sealed, dek), dek);
    return { operation: "captured-and-verified", ciphertextSha256, quiescent: source.quiescent, ...counts };
  }
  if (!opts.quiescent || !opts.singleReplicaConfirmed || !values.get("--artifact")) throw fail();
  const backup = openMemoryBackup(readMemoryBackupArtifact(path.resolve(values.get("--artifact")!)), dek);
  if (JSON.stringify(backup.source) !== JSON.stringify(source)) throw fail();
  if (mode === "checkpoint") {
    await verifyMemoryBackup(backup, dek);
    return { operation: "checkpointed", ...await checkpointFleetLedger({ backup, childrenDir, shared, dek, assertSource,
      accountingHolds: accountingHoldTenants(process.env) }) };
  }
  const result = await seedMemoryBackup({ backup, childrenDir, shared, dek, assertSource });
  return { operation: "seeded", ...result, ...await verifyMemoryBackup(backup, dek) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMemorySafeguardCli(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result));
    process.exit(0); // makePgDb intentionally keeps its shared pool alive.
  }).catch(() => {
    console.error("Memory safeguard refused. No personal content was logged and no destructive fallback was attempted.");
    process.exit(1);
  });
}
