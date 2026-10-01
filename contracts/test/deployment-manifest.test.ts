import { expect } from "chai";
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readDeploymentManifest, recordDeployment } from "../scripts/lib/deployment-manifest";

const initial = { "4663": { Existing: { address: "original", arbitraryMetadata: [1, 2] } } };

async function rejection(action: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try { await action; } catch (caught) { error = caught; }
  expect(String(error)).to.contain(message);
}

describe("deployment manifest persistence", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "deployment-manifest-"));
    file = path.join(dir, "deployments.json");
    writeFileSync(file, JSON.stringify(initial));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("re-reads after deployment so an intervening contract record survives", async () => {
    const startup = readDeploymentManifest(file);
    await recordDeployment(file, 4663, "PonsSelfTrade", { address: "pons" }, { replaceExisting: true });
    expect(startup["4663"]!.PonsSelfTrade).to.equal(undefined);
    await recordDeployment(file, 4663, "V4SelfSwap", { address: "v4" });
    expect(readDeploymentManifest(file)).to.deep.equal({
      "4663": { ...initial["4663"], PonsSelfTrade: { address: "pons" }, V4SelfSwap: { address: "v4" } },
    });
  });

  it("serializes separate processes across chains and contracts without losing records", async function () {
    this.timeout(15_000);
    const lock = `${file}.lock`;
    const fd = openSync(lock, "wx");
    closeSync(fd);
    const children: ChildProcess[] = [];
    let finished = 0;
    const source = `
      const { readDeploymentManifest, recordDeployment } = require(${JSON.stringify(path.resolve(__dirname, "../scripts/lib/deployment-manifest.ts"))});
      const [file, chain, contract] = process.argv.slice(1);
      (async () => {
        readDeploymentManifest(file); // Every child starts with the same stale snapshot.
        process.send({ ready: true });
        await recordDeployment(file, Number(chain), contract, { address: contract });
        process.disconnect();
      })().catch((error) => { console.error(error); process.exit(1); });
    `;
    const ready: Promise<void>[] = [];
    const done: Promise<void>[] = [];
    try {
      for (const [chain, contract] of [["4663", "V4SelfSwap"], ["4663", "PonsSelfTrade"], ["46630", "V4SelfSwap"]]) {
        // The contracts-only CI install includes ts-node, not the root's tsx.
        const child = spawn(process.execPath, ["--require", require.resolve("ts-node/register"), "-e", source, file, chain!, contract!],
          { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "ignore", "pipe", "ipc"] });
        children.push(child);
        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        ready.push(new Promise((resolve, reject) => {
          child.once("message", () => resolve());
          child.once("error", reject);
          child.once("exit", (code) => { if (code !== 0) reject(new Error(stderr || `child exited ${code}`)); });
        }));
        done.push(new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => { finished++; code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)); });
        }));
      }
      // Attach rejection handlers before waiting for readiness.
      const allDone = Promise.all(done);
      void allDone.catch(() => {});
      await Promise.all(ready);
      await delay(60);
      expect(finished, "children must wait for the existing manifest writer").to.equal(0);
      // The first writer completes while the other processes are waiting.
      writeFileSync(file, JSON.stringify({ ...initial, "999": { Intervening: { address: "keep" } } }));
      unlinkSync(lock);
      await allDone;
      expect(readDeploymentManifest(file)).to.deep.equal({
        "4663": { ...initial["4663"], V4SelfSwap: { address: "V4SelfSwap" }, PonsSelfTrade: { address: "PonsSelfTrade" } },
        "46630": { V4SelfSwap: { address: "V4SelfSwap" } },
        "999": { Intervening: { address: "keep" } },
      });
      expect(readdirSync(dir)).to.deep.equal(["deployments.json"]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(done);
    }
  });

  it("refuses a conflicting record without changing the manifest and releases the lock", async () => {
    await recordDeployment(file, 4663, "V4SelfSwap", { address: "first" });
    const before = readFileSync(file, "utf8");
    await rejection(recordDeployment(file, 4663, "V4SelfSwap", { address: "second" }), "already recorded");
    expect(readFileSync(file, "utf8")).to.equal(before);
    expect(existsSync(`${file}.lock`)).to.equal(false);
    await recordDeployment(file, 46630, "V4SelfSwap", { address: "testnet" });
  });

  it("only initializes a missing manifest and preserves malformed existing files", async () => {
    for (const bad of ["{", "null", "[]", '{"4663":null}', '{"4663":[]}']) {
      writeFileSync(file, bad);
      let failed = false;
      try { await recordDeployment(file, 4663, "V4SelfSwap", { address: "new" }); } catch { failed = true; }
      expect(failed).to.equal(true);
      expect(readFileSync(file, "utf8")).to.equal(bad);
      expect(existsSync(`${file}.lock`)).to.equal(false);
    }
    unlinkSync(file);
    await recordDeployment(file, 4663, "V4SelfSwap", { address: "first" });
    expect(readDeploymentManifest(file)).to.deep.equal({ "4663": { V4SelfSwap: { address: "first" } } });
  });

  it("does not steal an abandoned lock and preserves explicit replacement behavior", async () => {
    writeFileSync(`${file}.lock`, "abandoned or still live");
    await rejection(recordDeployment(file, 4663, "V4SelfSwap", {}, { lockWaitMs: 0 }), "manifest is locked");
    expect(readFileSync(`${file}.lock`, "utf8")).to.equal("abandoned or still live");
    expect(readDeploymentManifest(file)).to.deep.equal(initial);
    unlinkSync(`${file}.lock`);
    await recordDeployment(file, 4663, "Existing", { address: "replacement" }, { replaceExisting: true });
    expect(readDeploymentManifest(file)["4663"]!.Existing).to.deep.equal({ address: "replacement" });
  });

  it("refuses a symlink manifest instead of replacing the link", async function () {
    if (process.platform === "win32") this.skip();
    const link = path.join(dir, "alias.json");
    symlinkSync(file, link);
    await rejection(recordDeployment(link, 4663, "V4SelfSwap", {}), "must not be a symlink");
    expect(readDeploymentManifest(file)).to.deep.equal(initial);
  });
});
