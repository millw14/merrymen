import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { assertNoOwnerKeysAtRest, base58Encode, carriesOwnerKey, solanaSecretIn, type StoredGrant } from "@merrymen/core";
import { signerGrant, type SignerOptions } from "./canonical-wall-fixture";

/**
 * THE OWNER-KEY GUARD NEVER REFUSES A REAL GRANT.
 *
 * carriesOwnerKey runs on every grant the API accepts and, in hosted mode, over
 * every stored grant at boot, so a false positive refuses a tenant's grant or
 * the whole hosted boot. These grants come from the real signer
 * (canonical-wall-fixture.ts), so `serialized` is genuine ZeroDev output, and
 * each carries a hosted binding in the shape web/src/lib/auth.ts issues. The
 * Solana secret scan is run over them as written and as decoded, then the same
 * grants are given a Solana keypair in each place one could hide.
 */

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const EXTRA = [
  { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00" as const, decimals: 18 },
  { symbol: "UBIK", address: "0x0000000000000000000000000000000000ca7e02" as const, decimals: 18 },
  { symbol: "NEON", address: "0x0000000000000000000000000000000000ca7e03" as const, decimals: 18 },
];
/** The signer's shapes: the default mint, Trencher, the fullest wall, the Pons adapter. */
const SHAPES: SignerOptions[] = [
  { account: ACCOUNT },
  { account: ACCOUNT, trencher: true },
  { account: ACCOUNT, extraTokens: EXTRA, trencher: true, v4AdapterAddress: "0x0000000000000000000000000000000000000a4a" },
  { account: ACCOUNT, ponsAdapterAddress: "0x0000000000000000000000000000000000000b0b" },
];
const COUNT = 80;

/** Real grants, each with a fresh owner and session key, bound the way a hosted browser binds them. */
async function realGrants(): Promise<StoredGrant[]> {
  const out: StoredGrant[] = [];
  for (let i = 0; i < COUNT; i++) {
    const { grant, owner } = await signerGrant(SHAPES[i % SHAPES.length]!);
    const body = `${randomBytes(16).toString("base64url")}.${Date.now() + 300_000}.${Buffer.from("https://app.merrymen.dev").toString("base64url")}`;
    const nonce = `${body}.${createHmac("sha256", "test-secret").update(body).digest("base64url")}`;
    const did = `did:privy:${randomBytes(12).toString("hex")}`;
    out.push({ ...grant, binding: { version: "privy-did-owner-v1", nonce, ownerSignature: await owner.signMessage({ message: nonce }), did } });
  }
  return out;
}
/** Minted once, shared by every test below. */
const minted = realGrants();

const decoded = (g: StoredGrant) => Buffer.from(g.serialized, "base64").toString("utf8");
const reserialized = (g: StoredGrant, extra: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ ...JSON.parse(decoded(g)), ...extra })).toString("base64");

function solanaKeypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const sig = ed25519.sign(new TextEncoder().encode("merrymen"), seed);
  return { b58: base58Encode(new Uint8Array([...seed, ...pub])), bytes: [...seed, ...pub], pub: base58Encode(pub), sig: base58Encode(sig) };
}
const SOL = solanaKeypair(23);

describe("grants from the real signer are clean", () => {
  it("each blob is genuine ZeroDev output, so this proves what it says", async () => {
    const grants = await minted;
    for (const g of grants) {
      const params = JSON.parse(decoded(g));
      assert.ok(params.permissionParams && params.privateKey === g.demoSessionPrivateKey, "the blob holds the permission and the session key");
    }
    assert.equal(new Set(grants.map((g) => g.serialized)).size, COUNT, "every blob is different");
  });

  it("the Solana scan finds nothing in any blob, as written or as decoded", async () => {
    const grants = await minted;
    for (const g of grants) {
      assert.equal(solanaSecretIn(g.serialized), false);
      assert.equal(solanaSecretIn(decoded(g)), false);
    }
  });

  it("carriesOwnerKey passes every one, and the hosted boot starts over all of them", async () => {
    const grants = await minted;
    for (const g of grants) assert.equal(carriesOwnerKey(g), false, g.serialized.slice(0, 40));
    process.env.MERRYMEN_HOSTED = "1";
    try {
      assert.doesNotThrow(() => assertNoOwnerKeysAtRest(grants));
    } finally {
      delete process.env.MERRYMEN_HOSTED;
    }
  });

  it("Solana public ids beside a real grant are not secrets", async () => {
    const g = (await minted)[0]!;
    assert.equal(carriesOwnerKey({ ...g, grantTokens: [SOL.pub], solanaSignature: SOL.sig }), false);
    assert.equal(carriesOwnerKey({ ...g, serialized: reserialized(g, { sig: SOL.sig, pub: SOL.pub }) }), false);
  });
});

describe("a real grant carrying a Solana secret key is refused", () => {
  it("in a field of its own, nested, in the binding, or in the session-key field", async () => {
    const g = (await minted)[2]!;
    assert.equal(carriesOwnerKey({ ...g, solanaOwner: SOL.b58 }), true);
    assert.equal(carriesOwnerKey({ ...g, caps: { ...g.caps, backup: SOL.bytes } }), true);
    assert.equal(carriesOwnerKey({ ...g, binding: { ...g.binding!, nonce: SOL.b58 } }), true);
    assert.equal(carriesOwnerKey({ ...g, demoSessionPrivateKey: SOL.b58 as `0x${string}` }), true);
    // Glued to the text around it (audit: 'pk<K>' was read as no secret, 'pk <K>' as one).
    assert.equal(carriesOwnerKey({ ...g, label: `pk${SOL.b58}` }), true);
    assert.equal(carriesOwnerKey({ ...g, label: `%22${SOL.b58}%22` }), true);
  });

  it("inside the ZeroDev blob, or in place of it", async () => {
    const g = (await minted)[1]!;
    assert.equal(carriesOwnerKey({ ...g, serialized: reserialized(g, { solanaKey: SOL.b58 }) }), true);
    assert.equal(carriesOwnerKey({ ...g, serialized: reserialized(g, { idJson: JSON.stringify(SOL.bytes, null, 2) }) }), true);
    assert.equal(carriesOwnerKey({ ...g, serialized: SOL.b58 }), true);
  });

  it("and a hostile grant is read in bounded time", async () => {
    const g = (await minted)[0]!;
    // Any signed-in user reaches this from POST /api/grants. A label of small
    // byte values that fails at its end once backtracked for seconds per value.
    const label = `[${[...Array(22).fill("11"), ...Array(41).fill("1"), "999"].join(",")}]`;
    // CPU time (process.cpuUsage, user + system), never a wall clock: a loaded
    // runner takes time from this process, not CPU (a status run at load ~98
    // failed the wall-clock budget here). The same bounds still fail the old
    // pattern, which spends seconds of CPU on this label.
    const cpuMsOf = (fn: () => unknown): number => {
      const started = process.cpuUsage();
      fn();
      const spent = process.cpuUsage(started);
      return (spent.user + spent.system) / 1_000;
    };
    // First in a child the runner can stop, limited in CPU time: an exponential scan never returns, and
    // run here it would hang the suite instead of failing this test by name.
    const script = [
      'import { readFileSync } from "node:fs";',
      `const { carriesOwnerKey } = await import(${JSON.stringify(new URL("../../../packages/core/src/hosted.ts", import.meta.url).href)});`,
      'process.stdout.write(String(carriesOwnerKey({ label: readFileSync(0, "utf8") })));',
    ].join("\n");
    // tsx by name, resolved from the repository root (this file runs as CommonJS: no import.meta.resolve).
    const node = [process.execPath, "--import", "tsx", "--input-type=module", "-e", script];
    const [file, ...args] = process.platform === "win32" ? node : ["/bin/sh", "-c", "ulimit -t 20 && exec \"$@\"", "sh", ...node];
    const child = spawnSync(file!, args, { input: label, encoding: "utf8", timeout: 400_000, cwd: new URL("../../../", import.meta.url) });
    assert.equal(child.stdout, "false", `the label scan did not finish within 20 s of CPU time (${child.signal ?? child.status}: ${String(child.stderr).slice(-400)})`);
    let spent = cpuMsOf(() => assert.equal(carriesOwnerKey({ ...g, label }), false));
    assert.ok(spent < 250, `label took ${Math.round(spent)} ms of CPU time`);

    // Key-shaped runs split across fields share the walk's one cap, and past it
    // the grant is refused rather than read run by run.
    const fields = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`f${i}`, SOL.sig]));
    spent = cpuMsOf(() => assert.equal(carriesOwnerKey({ ...g, ...fields }), true));
    assert.ok(spent < 1_000, `fields took ${Math.round(spent)} ms of CPU time`);
  });

  it("reads each string once, so a grant reaches the walk's candidate cap only with that many key-shaped strings", async () => {
    const g = (await minted)[0]!;
    // 20 signatures (64 bytes each, no keypair): under the grant walk's cap of 32 when read once, over it when read twice.
    const sigs = Array.from({ length: 20 }, (_, i) => base58Encode(ed25519.sign(new TextEncoder().encode(`m${i}`), new Uint8Array(32).fill(i + 1))));
    assert.equal(carriesOwnerKey({ ...g, notes: sigs.join(" ") }), false);
    assert.equal(carriesOwnerKey({ ...g, [sigs.join(" ")]: 1 }), false, "a property name is read once too");
    // Past the cap the grant is refused, as before.
    assert.equal(carriesOwnerKey({ ...g, notes: [...sigs, ...sigs].join(" ") }), true);
    // A keypair is still found as a byte array, in a property name, and glued at a run's edge.
    assert.equal(carriesOwnerKey({ ...g, caps: { ...g.caps, backup: SOL.bytes } }), true);
    assert.equal(carriesOwnerKey({ ...g, [SOL.b58]: true }), true);
    assert.equal(carriesOwnerKey({ ...g, label: `pk${SOL.b58}` }), true);
  });

  it("a 230 KB hostile grant costs a fraction of one default scan of its text (review finalise: 60 to 130 ms on every POST /api/grants)", async () => {
    const g = (await minted)[0]!;
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const run = (n: number) => Array.from({ length: n }, () => B58[Math.floor(Math.random() * 58)]).join("");
    const random64 = () => base58Encode(new Uint8Array(randomBytes(64)));
    const hostile = (keys: number, runs: number) => ({ ...g, ...Object.fromEntries([...Array.from({ length: keys }, (_, i) => [`k${i}`, random64()]),
      ...Array.from({ length: runs }, (_, i) => [`r${i}`, run(240)])]) });
    const cpuMsOf = (fn: () => unknown): number => {
      const started = process.cpuUsage();
      fn();
      const spent = process.cpuUsage(started);
      return (spent.user + spent.system) / 1_000;
    };
    for (const [name, grant] of [["key-shaped and long runs", hostile(127, 900)], ["long runs only", hostile(0, 950)]] as const) {
      const text = JSON.stringify(grant);
      assert.ok(text.length > 230_000, name);
      // CPU time, best of three, against the default scan of the same text (the walk read it twice before).
      let walk = Infinity, once = Infinity;
      for (let round = 0; round < 3; round++) {
        walk = Math.min(walk, cpuMsOf(() => carriesOwnerKey(grant)));
        once = Math.min(once, cpuMsOf(() => solanaSecretIn(text)));
      }
      assert.ok(walk < once / 2, `${name}: the grant walk took ${walk.toFixed(1)} ms of CPU, one default scan ${once.toFixed(1)} ms`);
    }
  });

  it("and halts the hosted boot", async () => {
    const grants = await minted;
    process.env.MERRYMEN_HOSTED = "1";
    try {
      assert.throws(() => assertNoOwnerKeysAtRest([...grants, { ...grants[3]!, solana: SOL.bytes }]), /refuses to start: 1 stored grant/);
    } finally {
      delete process.env.MERRYMEN_HOSTED;
    }
  });
});
