import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  CHAINS,
  SOLANA_USDG_MINT,
  allChains,
  base58Decode,
  base58Encode,
  canonicalId,
  chainInfo,
  chainOfEvmId,
  explorerUrl,
  idFamily,
  isSolanaKeypair,
  onchainIdIn,
  onchainIdsIn,
  redactSolanaIds,
  requireChain,
  sameId,
  secretScanBudget,
  solanaSecretIn,
  solanaSecretsIn,
  type SecretScanBudget,
} from "./ids";
import { CASH } from "./tokens";

const EVM = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const EVM_HASH = `0x${"Ab".repeat(32)}`;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A real ed25519 keypair, its base58 secret, and a real signature by it. */
function keypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  const sig = ed25519.sign(new TextEncoder().encode("merrymen"), seed);
  return { pub: base58Encode(pub), secret, secretB58: base58Encode(secret), sig: base58Encode(sig) };
}

describe("the chain registry", () => {
  it("names Robinhood Chain and Solana, mainnet and test, and nothing else", () => {
    assert.deepEqual(allChains().map((c) => c.ref), [CHAINS.robinhood, CHAINS.robinhoodTestnet, CHAINS.solana, CHAINS.solanaDevnet]);
    assert.equal(chainInfo(CHAINS.solana)?.family, "solana");
    assert.equal(chainInfo(CHAINS.robinhood)?.evmChainId, 4663);
    assert.equal(chainInfo(CHAINS.solanaDevnet)?.realMoney, false);
  });

  it("is fail-closed: an unknown chain is null, never a default", () => {
    for (const bad of ["eip155:1", "solana:mainnet", "", null, 4663, "EIP155:4663"]) assert.equal(chainInfo(bad), null, String(bad));
    assert.throws(() => requireChain("eip155:8453"), /unknown chain/);
    assert.equal(chainOfEvmId(4663), CHAINS.robinhood);
    assert.equal(chainOfEvmId(46630), CHAINS.robinhoodTestnet);
    for (const id of [1, 8453, 0, -1, 4663.5, "4663"]) assert.equal(chainOfEvmId(id), null, String(id));
  });

  it("keeps the books in USDG on both chains, at 6 decimals", () => {
    assert.equal(chainInfo(CHAINS.robinhood)?.cash.address, CASH.USDG.toLowerCase());
    assert.equal(chainInfo(CHAINS.solana)?.cash.address, SOLANA_USDG_MINT);
    for (const c of allChains()) assert.equal(c.cash.decimals, 6);
    assert.equal(base58Decode(SOLANA_USDG_MINT)?.length, 32);
  });
});

describe("base58", () => {
  it("round-trips, leading zero bytes included", () => {
    assert.deepEqual(base58Decode(SYSTEM_PROGRAM), new Uint8Array(32));
    assert.equal(base58Encode(new Uint8Array(32)), SYSTEM_PROGRAM);
    for (const s of [SOLANA_USDG_MINT, keypair(7).pub, keypair(9).sig]) assert.equal(base58Encode(base58Decode(s)!), s);
  });

  it("refuses characters outside the alphabet (0, O, I, l)", () => {
    for (const s of ["0abc", "Oabc", "Iabc", "labc", "", "a b"]) assert.equal(base58Decode(s), null, s);
  });
});

describe("canonical ids", () => {
  it("lowercases EVM ids and keeps Solana ids exactly as written", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "token", EVM), EVM.toLowerCase());
    assert.equal(canonicalId(CHAINS.robinhood, "op", EVM_HASH), EVM_HASH.toLowerCase());
    assert.equal(canonicalId(CHAINS.solana, "token", SOLANA_USDG_MINT), SOLANA_USDG_MINT);
    const { sig } = keypair(3);
    assert.equal(canonicalId(CHAINS.solana, "op", sig), sig);
  });

  it("never treats a case-folded Solana id as the same id", () => {
    assert.notEqual(canonicalId(CHAINS.solana, "token", SOLANA_USDG_MINT.toLowerCase()), SOLANA_USDG_MINT);
    assert.equal(sameId(CHAINS.solana, "token", SOLANA_USDG_MINT, SOLANA_USDG_MINT.toLowerCase()), false);
    assert.equal(sameId(CHAINS.robinhood, "token", EVM, EVM.toLowerCase()), true);
  });

  it("refuses an id of the other family, the wrong length, or on an unknown chain", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "token", SOLANA_USDG_MINT), null);
    assert.equal(canonicalId(CHAINS.solana, "token", EVM), null);
    assert.equal(canonicalId(CHAINS.solana, "op", SOLANA_USDG_MINT), null, "a 32-byte key is not a signature");
    assert.equal(canonicalId(CHAINS.solana, "token", keypair(4).sig), null, "a signature is not a key");
    assert.equal(canonicalId("eip155:1", "token", EVM), null);
  });

  it("names the family of a bare id by its shape", () => {
    assert.equal(idFamily(EVM), "evm");
    assert.equal(idFamily(EVM_HASH), "evm");
    assert.equal(idFamily(SOLANA_USDG_MINT), "solana");
    assert.equal(idFamily("PEPE"), null);
  });
});

describe("explorer links", () => {
  it("Blockscout for Robinhood Chain, Solscan for Solana, the cluster for devnet", () => {
    assert.equal(explorerUrl(CHAINS.robinhood, "op", EVM_HASH), `https://robinhoodchain.blockscout.com/tx/${EVM_HASH.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.robinhood, "token", EVM), `https://robinhoodchain.blockscout.com/token/${EVM.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.solana, "token", SOLANA_USDG_MINT), `https://solscan.io/token/${SOLANA_USDG_MINT}`);
    assert.equal(explorerUrl(CHAINS.solanaDevnet, "account", SOLANA_USDG_MINT), `https://solscan.io/account/${SOLANA_USDG_MINT}?cluster=devnet`);
    assert.equal(explorerUrl(CHAINS.solana, "token", "not-a-mint"), null);
  });
});

describe("on-chain id detection", () => {
  it("finds EVM ids, Solana keys and signatures, and Solana explorer links", () => {
    const { sig } = keypair(5);
    const text = `bought ${SOLANA_USDG_MINT} at ${EVM} tx ${EVM_HASH} sig ${sig} https://solscan.io/tx/${sig}`;
    const hits = onchainIdsIn(text);
    assert.ok(hits.some((h) => h.family === "solana" && h.shape === "address" && h.value === SOLANA_USDG_MINT));
    assert.ok(hits.some((h) => h.family === "solana" && h.shape === "hash" && h.value === sig));
    assert.ok(hits.some((h) => h.family === "evm" && h.shape === "address"));
    assert.ok(hits.some((h) => h.family === "evm" && h.shape === "hash"));
    assert.ok(hits.some((h) => h.shape === "link"));
  });

  it("leaves ordinary prose alone", () => {
    for (const t of ["supercalifragilisticexpialidociousandmorewordsjoined", "the market is quiet today", "PEPE pumped 40% on the week", ""]) {
      assert.equal(onchainIdIn(t), false, t);
    }
  });

  it("detects letters-only public keys and signature encodings", () => {
    // A real ed25519 public key with no digits, from a deterministic test seed.
    const seed = new Uint8Array(32);
    new DataView(seed.buffer).setUint32(0, 4900, true);
    const pub = base58Encode(ed25519.getPublicKey(seed));
    assert.equal(pub, "EEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT");
    const signature = "A".repeat(87);
    assert.equal(canonicalId(CHAINS.solana, "account", pub), pub);
    assert.equal(canonicalId(CHAINS.solana, "op", signature), signature);
    assert.deepEqual(onchainIdsIn(`owner ${pub}, signature ${signature}`), [
      { family: "solana", shape: "address", value: pub },
      { family: "solana", shape: "hash", value: signature },
    ]);
  });
});

describe("glued on-chain id detection (audit regressions F3)", () => {
  const SIG = "3NGW7mkqWR84fuKhxiUmVTJg8AehpcEQHKZcivruB5449akQiFvm2Ej6AvJGLnfwW15Cb2wn1D6UAFMJtXh6tigd";
  const glued = { glued: true };

  it("finds a mint or signature written against neighbouring letters or digits, and returns the whole run", () => {
    for (const [text, value, shape] of [
      [`grab it CA${SOLANA_USDG_MINT} now`, `CA${SOLANA_USDG_MINT}`, "address"],
      [`${SOLANA_USDG_MINT}is the one`, `${SOLANA_USDG_MINT}is`, "address"],
      [`0${SOLANA_USDG_MINT}`, SOLANA_USDG_MINT, "address"],
      [`${SOLANA_USDG_MINT}l`, SOLANA_USDG_MINT, "address"],
      [`${SOLANA_USDG_MINT}x`, `${SOLANA_USDG_MINT}x`, "address"],
      // 89 characters: long enough to hide a signature, so that is the shape reported.
      [`${SOLANA_USDG_MINT}${SOLANA_USDG_MINT}a`, `${SOLANA_USDG_MINT}${SOLANA_USDG_MINT}a`, "hash"],
      [`tx${SIG}done`, `tx${SIG}done`, "hash"],
      // After a 0, an x with more than hex behind it is the run's own, so the whole run is the hit.
      [`0x${SOLANA_USDG_MINT}`, `x${SOLANA_USDG_MINT}`, "address"],
    ] as const) {
      // The default scan, pinned to Brain's mirror, misses each of these.
      assert.deepEqual(onchainIdsIn(text).filter((h) => h.family === "solana"), [], text);
      assert.deepEqual(onchainIdsIn(text, glued), [{ family: "solana", shape, value }], text);
      assert.equal(onchainIdIn(text, glued), true);
      assert.ok(text.split(value).join("[address]").indexOf(SOLANA_USDG_MINT.slice(0, 20)) < 0, "a redactor strips the whole id");
    }
  });

  it("finds everything the default scan finds", () => {
    const { sig, pub, secretB58 } = keypair(5);
    for (const text of [`bought ${SOLANA_USDG_MINT} at ${EVM} tx ${EVM_HASH} sig ${sig} https://solscan.io/tx/${sig}`,
      `owner ${pub}, ${"A".repeat(87)}`, `the system program 11111111111111111111111111111111 owns it`, `exported ${secretB58}`,
      `ca:${SOLANA_USDG_MINT}_v2`, `${SOLANA_USDG_MINT},${sig}`]) {
      const strict = onchainIdsIn(text, glued);
      for (const hit of onchainIdsIn(text)) assert.ok(strict.some((h) => h.value === hit.value && h.shape === hit.shape), `${text}: ${hit.value}`);
    }
  });

  it("answers every shared case as Brain's Python mirror does, in both scans", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../services/brain/tests/data/onchain_ids.json", import.meta.url), "utf8")) as
      { cases: { text: string; hits: { family: string; shape: string; value: string }[]; glued?: { family: string; shape: string; value: string }[] }[] };
    const changed: string[] = [];
    for (const c of fixture.cases) {
      const strict = onchainIdsIn(c.text, glued);
      assert.deepEqual(onchainIdsIn(c.text), c.hits, c.text);
      assert.deepEqual(strict, c.glued ?? c.hits, c.text);
      for (const hit of c.hits) assert.ok(strict.some((h) => h.value === hit.value && h.shape === hit.shape), `${c.text}: ${hit.value}`);
      if (c.glued) changed.push(c.text);
    }
    // The glued cases the default misses, among them the three it pinned as no id before.
    for (const t of [`0${SOLANA_USDG_MINT}`, `${SOLANA_USDG_MINT}l`, `${SOLANA_USDG_MINT}${SOLANA_USDG_MINT}a`, `grab it CA${SOLANA_USDG_MINT} now`]) assert.ok(changed.includes(t), t);
  });

  it("reads a key that begins with an x written after a 0 (\"10x<key>\", \"CA0x<key>\")", () => {
    // A real 32-byte key whose first character is x: dropped as the x of an "0x", the 42 left decoded to nothing.
    const xKey = "xD8ndgHckqX4TKpPgeRJ8o8Mmp8qE4bZ9USpRzQN4Uj";
    assert.equal(base58Decode(xKey)?.length, 32);
    for (const text of [`0${xKey}`, `price 10${xKey} today`, `grab it CA0${xKey} now`, `0${xKey}is the one`]) {
      const hits = onchainIdsIn(text, glued);
      assert.equal(hits.length, 1, text);
      assert.ok(hits[0]!.value.includes(xKey), text);
      assert.ok(!redactSolanaIds(text, () => "[id]").includes(xKey.slice(1, 21)), text);
    }
    // "0x" then hex alone is still that hex, whichever letters it holds.
    for (const text of [`0x${"ab".repeat(20)}`, `0x${"cafe".repeat(20)}`, `0x${"1".repeat(41)}`, "0x177286bb17374e1f47a767a43d99c674b38c4f54c8e"]) {
      assert.deepEqual(onchainIdsIn(text, glued).filter((h) => h.family === "solana"), [], text);
    }
  });

  it("never reads hex split at its zeros, a long number standing alone or filler as an id glued to anything", () => {
    // A long number glued to a word ("<digits>tokens") is not in this list: the digits after its last zero
    // and the word are one run that can be read (worker/src/xpost/public-wallet.ts states that cost).
    // Each run between zeros is hex alone, and some are 43 or 44 characters that decode to 32 bytes:
    // read as glued ids, every digest, EVM hash and long number like these was withheld.
    for (const text of [
      "6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa",
      "| `MERRYMEN_ADOPT_HOME_HALT_SHA256` | `6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa` |",
      "02D20BBD7E394AD5999A4CEBABAC9619732C343A4CAC99470C03E23BA2BDC2BC",
      "supply 63971511409728546707420640415976470808777281049430980144558505433936508649475518010444363585908687133263558897911835323323191563463575735092780586118530448 ok",
    ]) assert.deepEqual(onchainIdsIn(text, glued), [], text);
    const tx = "0x177286bb17374e1f47a767a43d99c674b38c4f54c8e00bb2042998a8fd1b4a4c";
    assert.deepEqual(onchainIdsIn(`tx ${tx}`, glued), [{ family: "evm", shape: "hash", value: tx }]);
    // Filler, one to four characters repeated (a length test's padding, "hahaha"): 87 x's decode to 64 bytes.
    for (const text of ["x".repeat(220), `${"x".repeat(2_500)}`, "ha".repeat(60), `${"abc".repeat(40)}!`, "wxyz".repeat(30)]) {
      assert.deepEqual(onchainIdsIn(text, glued), [], text.slice(0, 12));
    }
    // ...but a letters-only signature glued to a letter is still one.
    assert.deepEqual(onchainIdsIn(`${"A".repeat(87)}h`, glued), [{ family: "solana", shape: "hash", value: `${"A".repeat(87)}h` }]);
    // A standalone run is read exactly as the default reads it, hex alone or not.
    const hexKey = "abcdef123456789abcdef123456789abcdef1234567";
    assert.deepEqual(onchainIdsIn(`digest ${hexKey} ok`, glued), onchainIdsIn(`digest ${hexKey} ok`));
    assert.deepEqual(onchainIdsIn(`digest ${hexKey} ok`, glued), [{ family: "solana", shape: "address", value: hexKey }]);
  });

  it("leaves prose, tickers, hex digests, long numbers and other base58 alone", () => {
    for (const text of [
      "the market is quiet today", "PEPE pumped 40% on the week", "$SOL $BONK $WIF $JUP and $USDG",
      "supercalifragilisticexpialidociousandmorewordsjoined", "merrymen:meme dec_9f2c4b7a1e3d5f60 [ref:d3fa91cr2c1] up to 30 minutes",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "abcdef123456789".repeat(5),
      "ABCDEF123456789abcdef".repeat(4), "2345678923456789234567892345678923456789", "9".repeat(120),
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa paid", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      "#BuyTheDipAndHoldForeverBecauseSolanaIsTheFuture", "0x11111111111111111111111111111111111111111", "",
      `0x${"Ab".repeat(30)}`, `0x${"cafe".repeat(20)}`,
    ]) assert.deepEqual(onchainIdsIn(text, glued), [], text);
  });

  it("redactSolanaIds replaces the longest value first, so a run holding a shorter hit is never split around a mint", () => {
    const key = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 0xff));
    const text = `${key} then X${SOLANA_USDG_MINT}${key}Y`;
    // In scan order the lone key comes first, and its value is the end of the second run.
    const hits = onchainIdsIn(text, glued);
    assert.deepEqual(hits.map((h) => h.value), [key, `X${SOLANA_USDG_MINT}${key}Y`]);
    assert.equal(redactSolanaIds(text, () => "[id]"), "[id] then [id]");
    // Each hit is named by its own shape, and a link keeps its address, losing only the id in it.
    const { sig } = keypair(5);
    const marked = redactSolanaIds(`${key} https://solscan.io/tx/${sig} ${EVM}`, (h) => `[${h.shape}]`);
    assert.equal(marked, `[address] https://solscan.io/tx/[hash] ${EVM}`);
    assert.equal(redactSolanaIds("the market is quiet today", () => "[id]"), "the market is quiet today");
  });

  /**
   * A RUNAWAY SCAN FAILS BY NAME (review GE, round 2). node:test cannot stop synchronous code: an `it`
   * timeout fires only when the test yields, and a synchronous test past its timeout even passes. So a
   * scan that never returns, run in this process, hangs the suite until CI's job timeout and names no
   * test. This runs the glued scan over `texts` in a child the runner can stop, limited to
   * RUNAWAY_CPU_SECONDS of CPU time (ulimit -t: what the child spent, never what a loaded machine took
   * from it, so a slow runner does not fail it), with a wall-clock backstop well past that. The linear
   * test asks it first, before any scan of its own. Measured: about 1.5 s of CPU, tsx startup included.
   */
  const RUNAWAY_CPU_SECONDS = 60;
  function gluedScanFinishes(texts: string[]): { ok: boolean; how: string } {
    const script = [
      'import { readFileSync } from "node:fs";',
      `const { onchainIdsIn } = await import(${JSON.stringify(new URL("./ids.ts", import.meta.url).href)});`,
      'for (const text of JSON.parse(readFileSync(0, "utf8"))) onchainIdsIn(text, { glued: true });',
      'process.stdout.write("scanned");',
    ].join("\n");
    const node = [process.execPath, "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script];
    const [file, ...args] = process.platform === "win32" ? node : ["/bin/sh", "-c", `ulimit -t ${RUNAWAY_CPU_SECONDS} && exec "$@"`, "sh", ...node];
    const child = spawnSync(file!, args, { input: JSON.stringify(texts), encoding: "utf8", timeout: 20 * RUNAWAY_CPU_SECONDS * 1_000 });
    if (child.status === 0 && child.stdout === "scanned") return { ok: true, how: "scanned" };
    const how = child.error ? String(child.error) : child.signal ? `stopped by ${child.signal}` : `exit ${child.status}: ${child.stderr.slice(-400)}`;
    return { ok: false, how };
  }

  it("finishes on a run of millions of characters (review RHS, round 1: the run regex threw RangeError)", () => {
    const run = "a".repeat(6_000_000);
    assert.deepEqual(onchainIdsIn(`${run} ${SOLANA_USDG_MINT}`, glued).map((h) => h.value), [SOLANA_USDG_MINT]);
    assert.deepEqual(onchainIdsIn(`${run}${SOLANA_USDG_MINT}`, glued).map((h) => h.value.length), [run.length + SOLANA_USDG_MINT.length], "glued to its end: the whole run");
  });

  it("reads a megabyte of long base58 runs in linear time and fails closed past its budget", () => {
    // Runs that hold no 43- or 44-character key window (short of one, or hex alone), and runs that hold a signature.
    const noKeyRun = (i: number) => (i % 3 ? "1" + "z".repeat(31 + (i % 10)) : "abcdef12345".repeat(9));
    const keyLikeRun = (i: number) => `${base58Encode(Uint8Array.from({ length: 64 }, (_, j) => (i * 7 + j * 13 + 1) % 256))}x${i}`;
    const textOf = (count: number, run: (i: number) => string) => Array.from({ length: count }, (_, i) => run(i)).join(" ");
    const noKey = textOf(30_000, noKeyRun);
    assert.ok(noKey.length > 1_000_000);
    const keyLike = textOf(12_000, keyLikeRun);
    assert.ok(keyLike.length > 1_000_000);
    // First, in a child the runner can stop: a scan that never returns fails here, by name, not by hanging.
    const runaway = gluedScanFinishes([noKey, keyLike]);
    assert.ok(runaway.ok, `the glued scan did not finish two megabytes within ${RUNAWAY_CPU_SECONDS} s of CPU time (${runaway.how})`);
    assert.deepEqual(onchainIdsIn(noKey.slice(0, 5_000), glued), [], "none of these runs holds an id");
    assert.ok(onchainIdsIn(noKey, glued).length > 0, "past the decode budget, the remaining runs are refused unread");
    assert.equal(onchainIdIn(keyLike, glued), true);

    // BOUNDED TIME, AGAINST THIS MACHINE IN THIS RUN, never a wall clock. A fixed 2-second budget failed
    // at 4.8 s on a runner with a load average near 100, and a wall-clock ratio against a 3 ms scan of
    // 1/32 of the text failed too (225x against 128x, with 40 busy loops): a short scan can still land
    // in a quiet slice of a loaded machine, a long one cannot. So every figure here is CPU time
    // (process.cpuUsage, user + system: what this process spent, not what others took from it), each
    // compared figure covers the same characters, and they are taken in alternation, best of three.
    // - Linear: the text scanned whole costs at most 4 times the same runs scanned as 32 chunks
    //   (measured 0.5-0.6x: the whole text spends one decode budget, the chunks one each). A scan
    //   whose work for each run grows with the text before it costs up to 32 times as much whole
    //   once that work outweighs its own: a mutant reading every 4th character before each run
    //   measured 16x and fails, one reading every 32nd measured 3.4x and passes. So the bound
    //   catches a superlinear scan once its extra work at a megabyte is about 8 times a linear
    //   scan's (whole measures 0.5-0.6x split, the bound is 4x split); a cheaper one passes. An
    //   exponential scan never returns, and fails above, in the child (gluedScanFinishes).
    // - A constant of the default scan over the same text, which decodes every standalone run with
    //   no budget (measured 4.5-7x): a glued scan that grew a large constant fails here too.
    const cpuMs = (scan: () => unknown): number => {
      const started = process.cpuUsage();
      scan();
      const spent = process.cpuUsage(started);
      return (spent.user + spent.system) / 1_000;
    };
    for (const [name, big, run, count] of [["no key", noKey, noKeyRun, 30_000], ["key-like", keyLike, keyLikeRun, 12_000]] as const) {
      const per = Math.ceil(count / 32);
      const chunks = Array.from({ length: 32 }, (_, k) => textOf(Math.min(per, count - k * per), (i) => run(k * per + i)));
      assert.equal(chunks.join(" "), big, "the chunks hold exactly the text's runs");
      let whole = Infinity;
      let split = Infinity;
      let byDefault = Infinity;
      for (let round = 0; round < 3; round++) {
        whole = Math.min(whole, cpuMs(() => onchainIdsIn(big, glued)));
        split = Math.min(split, cpuMs(() => chunks.map((chunk) => onchainIdsIn(chunk, glued))));
        byDefault = Math.min(byDefault, cpuMs(() => onchainIdsIn(big)));
      }
      const took = `${name}, CPU time over ${big.length} characters: ${whole.toFixed(1)} ms whole, ${split.toFixed(1)} ms in 32 chunks, default scan ${byDefault.toFixed(1)} ms`;
      assert.ok(whole < 4 * split, `not linear in the text: ${took}`);
      assert.ok(whole < 50 * byDefault, `far slower than the default scan: ${took}`);
    }
  });
});

describe("Solana secret detection", () => {
  /**
   * A RUNAWAY SECRET SCAN FAILS BY NAME, as gluedScanFinishes does for the glued id scan: node:test
   * cannot stop synchronous code, so run here, a scan that never returns hangs the suite and names no
   * test. This runs solanaSecretsIn over `texts` in a child limited to SECRET_RUNAWAY_CPU_SECONDS of
   * CPU time (ulimit -t: what the child spent, never what a loaded machine took from it), with a
   * wall-clock backstop well past that. A healthy run costs about 1.5 s of CPU, tsx startup included.
   */
  const SECRET_RUNAWAY_CPU_SECONDS = 20;
  function secretScanFinishes(texts: string[]): { ok: boolean; how: string } {
    const script = [
      'import { readFileSync } from "node:fs";',
      `const { solanaSecretsIn } = await import(${JSON.stringify(new URL("./ids.ts", import.meta.url).href)});`,
      'for (const text of JSON.parse(readFileSync(0, "utf8"))) solanaSecretsIn(text);',
      'process.stdout.write("scanned");',
    ].join("\n");
    const node = [process.execPath, "--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script];
    const [file, ...args] = process.platform === "win32" ? node : ["/bin/sh", "-c", `ulimit -t ${SECRET_RUNAWAY_CPU_SECONDS} && exec "$@"`, "sh", ...node];
    const child = spawnSync(file!, args, { input: JSON.stringify(texts), encoding: "utf8", timeout: 20 * SECRET_RUNAWAY_CPU_SECONDS * 1_000 });
    if (child.status === 0 && child.stdout === "scanned") return { ok: true, how: "scanned" };
    const how = child.error ? String(child.error) : child.signal ? `stopped by ${child.signal}` : `exit ${child.status}: ${child.stderr.slice(-400)}`;
    return { ok: false, how };
  }
  /** Milliseconds of CPU time (user + system) `fn` spent in this process: what it cost, not what others took. */
  const cpuMsOf = (fn: () => unknown): number => {
    const started = process.cpuUsage();
    fn();
    const spent = process.cpuUsage(started);
    return (spent.user + spent.system) / 1_000;
  };

  it("flags a keypair as base58 or as an id.json byte array", () => {
    const { secret, secretB58 } = keypair(11);
    assert.equal(isSolanaKeypair(secret), true);
    assert.equal(solanaSecretIn(`key: ${secretB58}`), true);
    assert.equal(solanaSecretIn(`[${[...secret].join(",")}]`), true);
    assert.equal(solanaSecretIn(JSON.stringify([...secret], null, 2)), true);
  });

  it("never mistakes a signature, a public key or random bytes for a secret", () => {
    const { sig, pub } = keypair(13);
    assert.equal(solanaSecretIn(`sig ${sig}`), false, "a signature is 64 bytes but no keypair");
    assert.equal(solanaSecretIn(`owner ${pub} ${SOLANA_USDG_MINT}`), false);
    const random = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
    assert.equal(isSolanaKeypair(random), false);
    assert.equal(solanaSecretIn(`[${[...random].join(",")}]`), false);
  });

  it("solanaSecretsIn returns each secret exactly as written, and only secrets", () => {
    const a = keypair(17);
    const b = keypair(19);
    const array = JSON.stringify([...b.secret], null, 2);
    const text = `PRIVATE_KEY=${a.secretB58}\nsig ${a.sig} owner ${a.pub}\nid.json: ${array}`;
    assert.deepEqual(solanaSecretsIn(text), [a.secretB58, array]);
    for (const s of solanaSecretsIn(text)) assert.ok(text.includes(s));
    assert.deepEqual(solanaSecretsIn(`sig ${a.sig}`), []);
    for (const x of [null, undefined, 42, "", "short"]) assert.deepEqual(solanaSecretsIn(x), []);
  });

  it("reads a near-miss byte array in linear time", () => {
    // Values 10-19 once matched two ways each, so an array that failed at its
    // end backtracked 2^k times: k=20 took about half a second, k=63 forever.
    // 22 is enough to fail this on the old pattern in seconds rather than hang.
    const nearMiss = (value: string, sep: string, last: string) => `[${[...Array(22).fill(value), ...Array(41).fill("1")].join(sep)}${sep}${last}]`;
    const nearMisses = [
      nearMiss("11", ",", "999"),
      nearMiss("19", " , ", "256"),
      `[${Array(64).fill("10").join(",")}`,
      `${"[11,".repeat(2_000)}999]`,
    ];
    // First, in a child the runner can stop: an exponential scan never returns, so run here it would hang
    // the suite instead of failing (the old pattern ran a mutant past four minutes of CPU on these texts).
    const runaway = secretScanFinishes(nearMisses);
    assert.ok(runaway.ok, `the secret scan did not finish the near misses within ${SECRET_RUNAWAY_CPU_SECONDS} s of CPU time (${runaway.how})`);
    // Then CPU time here (process.cpuUsage, user + system), never a wall clock: a loaded runner takes
    // time from this process, not CPU. A scan that finishes but slowly (quadratic) fails this bound.
    const spent = cpuMsOf(() => { for (const text of nearMisses) assert.deepEqual(solanaSecretsIn(text), []); });
    assert.ok(spent < 250, `took ${Math.round(spent)} ms of CPU time`);
  });

  it("caps the candidates it reads, and counts what it did not read as a secret", () => {
    const distinct = Array.from({ length: 150 }, (_, i) => keypair(i).sig);
    const sigs = [...distinct, ...distinct];
    const { secretB58 } = keypair(29);
    // An exact candidate is a whole run that can be a keypair, so a standalone signature is one and the
    // 257th is the first refused, as before glued keys were read: the windows inside a signature (a key
    // glued to one character) are read best effort and never refuse anything (review RHS, round 1).
    const budget = secretScanBudget();
    let read = 0;
    while (read < sigs.length && !solanaSecretIn(sigs[read], budget)) read++;
    assert.equal(read, 256, `read ${read} signatures before the cap`);
    assert.equal(solanaSecretIn(sigs[read + 1], budget), true, "scans sharing a budget are capped together");
    assert.deepEqual(solanaSecretsIn(sigs.slice(0, read).join(" ")), [], "up to the cap, signatures stay signatures");
    const found = solanaSecretsIn([...sigs, secretB58].join(" "));
    assert.deepEqual(found, [...sigs.slice(read), secretB58], "the rest, the key included, are refused unread, each whole");
    const addresses = Array.from({ length: 1_000 }, (_, i) => keypair(i % 150).pub).join(" ");
    assert.deepEqual(solanaSecretsIn(`${addresses} ${secretB58}`), [secretB58], "an address is too short to be a candidate");
  });

  it("finds a key glued to letters or digits, and returns only the key, as written", () => {
    // audit: 'pk<K>', '%22<K>%22', '<K>is mine' and 'secret:<K>x' were each read as no secret.
    const { secretB58: key } = keypair(31);
    const { secretB58: other, sig } = keypair(37);
    const { secretB58: third } = keypair(43);
    const fromSeed = (seed: Uint8Array) => base58Encode(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]));
    // A seed with a leading zero byte encodes one character shorter, after a "1"; an all-zero seed, after 32.
    const oneZero = fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i));
    const allZero = fromSeed(new Uint8Array(32));
    assert.ok(oneZero.startsWith("1") && !oneZero.startsWith("11") && oneZero.length < 87 && allZero.startsWith("1".repeat(32)));
    for (const [text, keys, why] of [
      [`pk${key}`, [key], "a prefix"],
      [`%22${key}%22`, [key], "URL-encoded JSON quotes"],
      [`${key}is mine`, [key], "a word after it"],
      [`secret:${key}x`, [key], "one letter after it"],
      [`0${key}`, [key], "a digit outside base58 before it (the old scan read no id against it)"],
      [`l${key}O`, [key], "letters outside base58 either side"],
      [`thekeyforthisaccountwas${key}`, [key], "glue of any length on one side"],
      [`${key}${other}`, [key, other], "two keys written together"],
      [`pk${oneZero}x`, [oneZero], "a key that begins with a zero byte"],
      [`ab${allZero}cd`, [allZero], "a key of 32 zero bytes and its public key"],
      [`${"a".repeat(12)}${key}${"b".repeat(12)}`, [key], "twelve characters of glue either side"],
      // Review RHS, round 1: past twelve characters either side, and between keys, a key went unread.
      [`${"a".repeat(13)}${key}${"b".repeat(13)}`, [key], "thirteen characters of glue either side"],
      [`mysecretkeyis${key}thankyoumybro`, [key], "words glued either side"],
      [`hereismyprivatekey${key}dontsharethiswithanyone`, [key], "eighteen and twenty-three characters of glue"],
      [`${"x".repeat(40)}${key}${"y".repeat(40)}`, [key], "forty characters of glue either side"],
      [`${sig}${key}${sig}`, [key], "between two signatures"],
      [`${key}${other}${third}`, [key, other, third], "three keys written together"],
      [`pk${key}${other}${third}x`, [key, other, third], "three keys written together, glued"],
      [`${sig}${other}${key}${third}${sig}`, [other, key, third], "three keys between two signatures"],
    ] as const) {
      assert.deepEqual(solanaSecretsIn(text), keys, why);
      for (const k of keys) assert.ok(text.includes(k));
    }
    // A key behind one base58 digit can decode, whole, to 64 bytes that are no keypair: the window still is one.
    let glued = "";
    for (let i = 1; i < 256 && !glued; i++) {
      const k = keypair(i).secretB58;
      if (k.length === 87 && base58Decode(`2${k}`)?.length === 64) glued = k;
    }
    assert.ok(glued, "a key whose '2<key>' decodes to 64 bytes");
    assert.deepEqual(solanaSecretsIn(`2${glued}`), [glued]);
    // A signature glued to words stays a signature, and so does ordinary text.
    assert.deepEqual(solanaSecretsIn(`landed tx${sig}done`), []);
    assert.deepEqual(solanaSecretsIn(`#${"ToTheMoonAndBackAgainAndAgainForeverAndEverFam".repeat(4)}`), []);
  });

  it("reads the windows inside runs best effort: the edges of every run first, then the rest in order, never refusing", () => {
    // A DECISION AWAITING MILLA'S SIGN-OFF (review RHS, rounds 1 and 2; ids.ts SECRET_WINDOW_CHECKS): every window
    // of every run is read while the window budget lasts, and past it a window goes unread instead of refusing
    // the text. 200 signatures spend that budget (an
    // 88-character signature holds two 87-character windows, a key behind or before one character), as a
    // notebook's base64 does, yet stay under the exact cap.
    const list = Array.from({ length: 200 }, (_, i) => keypair(i).sig).join("\n");
    const { secretB58: key } = keypair(59);
    const { sig } = keypair(61);
    const spent = secretScanBudget();
    assert.deepEqual(solanaSecretsIn(list, spent), []);
    assert.equal(spent.windows?.checks, 0, "the list alone spends the window budget");
    assert.ok(spent.left > 0, "and not the exact one");
    assert.deepEqual(solanaSecretsIn(`${list}\npk${key}`), [key], "an edge window is read before any signature's windows");
    // Review RHS, round 2: the edge's WIDTH. A key a few characters in from both ends of its run, after the list
    // has spent the window budget, is found at the edges; with no edge width (SECRET_GLUE 0) it went unread.
    assert.deepEqual(solanaSecretsIn(`${list}\npk${key}is`), [key], "two characters of glue either side");
    assert.deepEqual(solanaSecretsIn(`${list}\n${"a".repeat(12)}${key}${"b".repeat(12)}`), [key], "twelve either side: the whole edge");
    assert.deepEqual(solanaSecretsIn(`${sig}${key}${sig}\n${list}`), [key], "a deep window written first is read");
    assert.deepEqual(solanaSecretsIn(`${list}\n${sig}${key}${sig}`), [], "written after, it goes unread: missed, and nothing is refused");
    assert.deepEqual(solanaSecretsIn(`${list}\n${key}`), [key], "a key standing alone is an exact candidate, read whatever the windows spent");
  });

  it("reads the edges of the shortest runs first, so long blobs cannot starve a key with a little glue", () => {
    // Review RHS, round 2: the edges were read in the order written. Ten random base58 runs of 300 characters
    // (serialized transactions in a log) spent the window budget on their own edges, about 28 checks each, and
    // 'pk<key>' or 'secret:<key>x' after them went unread. With an 87-character key, 'secret:<key>x' is a run a
    // keypair's length, read only after every edge: missed after a single blob.
    let x = 0x9e3779b9;
    const blob = () => Array.from({ length: 300 }, () => ALPHABET[((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 16) % 58]).join("");
    const blobs = Array.from({ length: 20 }, blob).join("\n");
    const spent = secretScanBudget();
    assert.deepEqual(solanaSecretsIn(blobs, spent), []);
    assert.equal(spent.windows?.checks, 0, "the blobs alone spend the window budget");
    const keys = { long: "", short: "" };
    for (let i = 1; i < 256 && (!keys.long || !keys.short); i++) {
      const k = keypair(i).secretB58;
      if (k.length === 88) keys.long ||= k;
      else if (k.length === 87 && base58Decode(`${k}x`)?.length !== 64) keys.short ||= k;
    }
    assert.ok(keys.long && keys.short, "an 88- and an 87-character key");
    for (const key of [keys.long, keys.short]) {
      for (const [text, why] of [
        [`${blobs}\nexport PK=pk${key}`, "a prefix"],
        [`${blobs}\nsecret:${key}x`, "one letter after it"],
        [`${blobs}\n${"a".repeat(12)}${key}${"b".repeat(12)}`, "twelve characters of glue either side"],
        [`pk${key}\n${blobs}`, "written first"],
      ] as const) assert.deepEqual(solanaSecretsIn(text), [key], `${why}, ${key.length}-character key`);
    }
    // Still best effort: a key glued to a blob's edge, in a run longer than all twenty blobs, waits behind them.
    assert.deepEqual(solanaSecretsIn(`${blobs}\n${blob()}${keys.long}`), [], "missed, and nothing is refused");
  });

  it("remembers a fresh scan of a short text, never a scan handed a budget, and answers as before", () => {
    // Review RHS, round 2: the group chat quotes the same stored lines in every prompt it builds, and the windows
    // of a 400-character line of random base58 cost about 256 keypair checks every time.
    let x = 0x7f4a7c15;
    const random = (n: number) => Array.from({ length: n }, () => ALPHABET[((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 16) % 58]).join("");
    const line = random(400);
    const first = cpuMsOf(() => assert.deepEqual(solanaSecretsIn(line), []));
    let again = Infinity;
    for (let round = 0; round < 3; round++) again = Math.min(again, cpuMsOf(() => assert.deepEqual(solanaSecretsIn(line), [])));
    assert.ok(again < 5 && again < first / 4, `first scan ${first.toFixed(2)} ms, again ${again.toFixed(2)} ms of CPU time`);
    // A scan handed a budget reads the text itself, and spends that budget, remembered or not.
    const budget = secretScanBudget();
    assert.deepEqual(solanaSecretsIn(line, budget), []);
    assert.ok(budget.windows!.checks < secretScanBudget().windows!.checks, "the windows were read and counted");
    // A remembered answer is the same answer: each secret as written, in a fresh array every time.
    const { secretB58: key } = keypair(79);
    const { secretB58: other } = keypair(83);
    const array = `[${[...keypair(89).secret].join(",")}]`;
    const text = `${random(30)} pk${key}is ${other} ${array}`;
    const answer = solanaSecretsIn(text);
    assert.deepEqual(answer, [key, other, array]);
    answer.push("changed by a caller");
    assert.deepEqual(solanaSecretsIn(text), [key, other, array]);
    assert.equal(solanaSecretIn(text), true);
    assert.deepEqual(solanaSecretsIn(`${text} `), [key, other, array], "a different text is its own scan");
  });

  it("reads exact candidates only when asked, for a caller that replaces every glued run itself", () => {
    const { secretB58: key, secret } = keypair(97);
    const exact = () => secretScanBudget({ windows: false });
    assert.deepEqual(solanaSecretsIn(`key ${key}`, exact()), [key]);
    assert.deepEqual(solanaSecretsIn(`[${[...secret].join(",")}]`, exact()).length, 1);
    assert.deepEqual(solanaSecretsIn(`pk${key}`, exact()), [], "no window is read");
    assert.deepEqual(solanaSecretsIn(`pk${key}`), [key], "as the default scan does");
    let x = 0x3c6ef372;
    const lines = Array.from({ length: 30 }, () => Array.from({ length: 400 }, () => ALPHABET[((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 16) % 58]).join(""));
    const spent = cpuMsOf(() => { for (const l of lines) assert.deepEqual(solanaSecretsIn(l, exact()), []); });
    assert.ok(spent < 50, `30 fresh 400-character lines, exact only: ${spent.toFixed(1)} ms of CPU time`);
  });

  it("never refuses base64 for the base58 runs inside it", () => {
    // Review RHS, round 1: with every window refused past the budget, random bytes as base64 in an .ipynb were
    // refused from about 800 KB (1 in 10) and always from 2 MB, so send_file refused notebooks and images.
    let x = 0x2545f491;
    const random = (n: number) => Uint8Array.from({ length: n }, () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24);
    for (const size of [1_500_000, 6_000_000]) {
      const notebook = JSON.stringify({ cells: [{ outputs: [{ data: { "image/png": Buffer.from(random(size)).toString("base64") } }] }] });
      assert.deepEqual(solanaSecretsIn(notebook), [], `${notebook.length} characters of notebook`);
    }
  });

  it("finishes on a run of millions of characters, and reads a scan that cannot finish as a secret", () => {
    // Review RHS, round 1: the run regex threw RangeError (out of stack) from about 5.6 million characters,
    // and send_file swallowed the throw and sent the file unscanned.
    const { secretB58: key } = keypair(67);
    const run = "a".repeat(6_000_000);
    assert.deepEqual(solanaSecretsIn(`${run} ${key}`), [key]);
    assert.deepEqual(solanaSecretsIn(`${run}${key}`), [key], "glued to its end");
    const mixed = Array.from({ length: 6_000_000 }, (_, i) => "ABCDEFGHJKLMNPQRSTUVWXYZghijkmnopqrstuvwxyz"[(i * 7919) % 42]).join("");
    assert.deepEqual(solanaSecretsIn(`${mixed} ${key}`), [key], "a run that spends the window budget");
    const text = `id: ${key}`;
    const overflow = (): never => { throw new RangeError("Maximum call stack size exceeded"); };
    const broken = { get left(): number { return overflow(); }, set left(_: number) {}, get windows(): never { return overflow(); } };
    assert.deepEqual(solanaSecretsIn(text, broken as SecretScanBudget), [text], "fails closed, the whole text");
    assert.equal(solanaSecretIn(`a signature, no secret: ${keypair(71).sig}`, broken as SecretScanBudget), true);
  });

  it("reads a megabyte of key-shaped text in bounded time", () => {
    const runs = Array.from({ length: 64 }, (_, i) => base58Encode(Uint8Array.from({ length: 64 }, (_, j) => (i * 7 + j * 13 + 1) % 256)));
    const text = Array.from({ length: 12_000 }, (_, i) => (i % 2 ? runs[i % 64] : `[${Array(64).fill(i % 200).join(",")}]`)).join(" ");
    assert.ok(text.length > 1_000_000);
    const spent = cpuMsOf(() => assert.equal(solanaSecretIn(text), true, "past the cap it fails closed"));
    assert.ok(spent < 1_000, `took ${Math.round(spent)} ms of CPU time`);
  });
});
