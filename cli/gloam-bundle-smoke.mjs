/** Check the prebuilt Gloam bundle without loading its source npm dependencies.
 * The default check is offline. --prove additionally downloads the two pinned,
 * hash-verified public proving artifacts; it never uses a wallet or chain RPC. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194";
const AMOUNT = 1_000_000n;
const OMITTED = /^(?:@gloamtrade\/sdk|snarkjs|circomlibjs|ethers|elliptic|@ethersproject\/signing-key)(?:\/|$)/;
const ARTIFACTS = [
  ["https://www.gloam.trade/circuits/shield.wasm", "58157ec90f8af891acfa998bd599511b4d5cd06803cea32ab28a6eea8a9b2336"],
  ["https://www.gloam.trade/circuits/final/shield_final.zkey", "3054877c35e2e0e9f76c43aa4791ac2b3ac51b8967d51be2215e89c0a5fbb512"],
];

/** Native WebCrypto receiver, independent of the bundled SDK's decoding path. */
async function receiveIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicBytes = await crypto.subtle.exportKey("spki", pair.publicKey);
  return { privateKey: pair.privateKey, tag: `gloamr1.${Buffer.from(publicBytes).toString("base64url")}` };
}

async function decryptMemo(memo, privateKey) {
  const sealed = Buffer.from(memo.slice(2), "hex").toString("utf8");
  assert.match(sealed, /^gloam2t\.[A-Za-z0-9_-]+$/);
  const bytes = Buffer.from(sealed.slice("gloam2t.".length), "base64url");
  const publicLength = bytes.readUInt16BE(0);
  const publicKey = await crypto.subtle.importKey("spki", bytes.subarray(2, 2 + publicLength),
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(),
    info: new TextEncoder().encode("gloam-pay-to-tag-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const ivAt = 2 + publicLength;
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(ivAt, ivAt + 12) }, key, bytes.subarray(ivAt + 12));
  const encoded = new TextDecoder().decode(plain).trimEnd();
  assert.ok(encoded.startsWith("gloam1."));
  return JSON.parse(Buffer.from(encoded.slice("gloam1.".length), "base64url").toString("utf8"));
}

function bundledExport(runtime, name) {
  // Webpack module IDs change between builds. Find the named export declaration
  // instead of keeping a build-specific ID or importing any source package.
  const declaration = new RegExp(`\\b${name}:\\s*\\(`);
  for (const [id, factory] of Object.entries(runtime.m)) {
    if (!declaration.test(Function.prototype.toString.call(factory))) continue;
    const exports = runtime(Number(id));
    if (Object.hasOwn(exports, name)) return exports;
  }
  throw new Error(`The production bundle is missing ${name}.`);
}

export async function verifyGloamBundle(root, { prove = false } = {}) {
  const server = path.resolve(root, "web/.next/server");
  const require = createRequire(path.join(server, "webpack-runtime.js"));
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  Module._load = function (request, ...args) {
    if (OMITTED.test(request)) throw new Error(`The prebuilt proof unexpectedly requires ${request}.`);
    return originalLoad.call(this, request, ...args);
  };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!prove || !ARTIFACTS.some(([allowed]) => allowed === url)) throw new Error("Unexpected network request in the Gloam bundle smoke check.");
    return originalFetch(input, init);
  };
  try {
    const runtime = require("./webpack-runtime.js");
    for (const filename of readdirSync(path.join(server, "chunks"))) {
      if (filename.endsWith(".js")) runtime.C(require(`./chunks/${filename}`));
    }
    // Next keeps built-in external module factories (crypto, os, etc.) in the
    // page entry. Register those definitions while suppressing X(), the page
    // entrypoint, so the check never renders a page or runs its application code.
    const page = path.join(server, "app/(app)/home/page.js");
    const pageRequire = createRequire(page);
    const registerOnly = { C: runtime.C, X: () => ({}) };
    compileFunction(readFileSync(page, "utf8"), ["require", "module", "exports"], { filename: page })(
      request => request.endsWith("/webpack-runtime.js") ? registerOnly : pageRequire(request), { exports: {} }, {},
    );
    const sdk = bundledExport(runtime, "SDK_VERSION");
    const prover = bundledExport(runtime, "groth16");
    assert.equal(sdk.SDK_VERSION, "0.4.1");
    assert.equal(typeof prover.groth16.fullProve, "function");
    assert.equal(typeof bundledExport(runtime, "prepareGloamShield").prepareGloamShield, "function");
    const receiver = await receiveIdentity();
    let note, proof;
    if (prove) {
      // Keep the offline verifier independent of external availability. This
      // opt-in diagnostic uses the same pins as the compiled product and asks
      // snarkjs for its supported single-thread Node mode: its server Webpack
      // worker loader is not the browser worker loader used by the application.
      assert.ok(Object.values(runtime.m).some(factory => ARTIFACTS.every(([url, sha]) =>
        factory.toString().includes(url) && factory.toString().includes(sha))));
      const [wasm, zkey] = await Promise.all(ARTIFACTS.map(async ([url, sha]) => {
        const response = await fetch(url, { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(45_000) });
        assert.ok(response.ok);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.ok(bytes.length <= 8 * 1024 * 1024);
        const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
        assert.equal(hash, sha);
        return bytes;
      }));
      const intent = await sdk.buildShieldBoundIntent({ amountWei: AMOUNT, asset: USDG, chainId: 4663, poolAddress: POOL,
        prover: async input => {
          const generated = await prover.groth16.fullProve(input, wasm, zkey, undefined, undefined, { singleThread: true });
          assert.deepEqual(generated.publicSignals, [input.commitment, input.amount, input.asset]);
          return { proofBytes: sdk.packGroth16Proof(generated.proof), publicSignals: generated.publicSignals };
        } });
      note = intent.note;
      proof = intent.exec.args[3];
      assert.match(proof, /^0x[0-9a-f]{512}$/i);
    } else {
      note = await sdk.makeBoundNotePoseidon(AMOUNT, USDG);
    }
    const sealed = await sdk.sealToReceiveTag(sdk.encodeNotePackage({
      pool: POOL, asset: USDG, amountWei: AMOUNT.toString(), secret: note.secret,
      commitment: note.commitment, chainId: 4663,
    }), receiver.tag);
    const result = { commitment: note.commitment, memo: `0x${Buffer.from(sealed).toString("hex")}`, proof };
    const opened = await decryptMemo(result.memo, receiver.privateKey);
    assert.equal(opened.w, AMOUNT.toString());
    assert.equal(opened.c, result.commitment);
    assert.equal(opened.ch, 4663);
    assert.equal(opened.p.toLowerCase(), POOL.toLowerCase());
    assert.equal(opened.a.toLowerCase(), USDG.toLowerCase());
    const stranger = await receiveIdentity();
    await assert.rejects(decryptMemo(result.memo, stranger.privateKey));
    return { mode: prove ? "proof" : "offline", memoBytes: (result.memo.length - 2) / 2,
      ...(prove ? { proofBytes: (result.proof.length - 2) / 2 } : {}), amountMatches: true, chainId: opened.ch };
  } finally {
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv.slice(2).find(arg => !arg.startsWith("--"));
  if (!root) throw new Error("Usage: node cli/gloam-bundle-smoke.mjs <installed-package-root> [--prove]");
  const timeout = setTimeout(() => { console.error("Gloam bundle smoke check timed out."); process.exit(1); }, 60_000);
  try {
    console.log(JSON.stringify(await verifyGloamBundle(root, { prove: process.argv.includes("--prove") })));
    clearTimeout(timeout);
    process.exit(0); // The prover can retain idle worker threads.
  } catch {
    // A prover diagnostic may include a private witness. Never print it.
    console.error("Gloam bundle smoke check failed.");
    process.exit(1);
  }
}
