import test from "node:test";
import assert from "node:assert/strict";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, createTransactionMessage,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, compileTransaction,
  signTransaction, getBase64EncodedWireTransaction, getSignatureFromTransaction, blockhash } from "@solana/kit";
import { createSolanaLiveRpc, readSolanaEachProvider, readSolanaPriorityFee, readSolanaQuorum, type SolanaLiveRead, type SolanaLiveRpc } from "./solana-live-rpc";
import { verifySolanaVaultDeployment } from "./solana-executor";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { createHash } from "node:crypto";
import { SOLANA_MAINNET_GENESIS_HASH, SolanaRpcError } from "./solana-rpc";
const env = { MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/?api-key=secret-primary",
  MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/?api-key=secret-fallback" };
const BLOCKHASH = "11111111111111111111111111111111";
const key32 = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
/** An immutable upgradeable-loader deployment whose binary declares its own program id. */
function deployment() {
  const programId = key32(61), dataAddress = key32(62), LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
  const binary = Buffer.concat([Buffer.from("vault-binary"), Buffer.from(getBase58Encoder().encode(programId))]);
  const program = Buffer.alloc(36); program.writeUInt32LE(2); Buffer.from(getBase58Encoder().encode(dataAddress)).copy(program, 4);
  const programData = Buffer.alloc(45 + binary.length); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const value = (data: Buffer, executable: boolean, space: number) => ({ owner: LOADER, executable, lamports: 1, data: [data.toString("base64"), "base64"], space });
  const read: SolanaLiveRead = async (method, params = []) => {
    if (method === "getSlot") return 5;
    assert.equal(method, "getAccountInfo");
    if (params[0] === programId) return { context: { slot: 5 }, value: value(program, true, 36) };
    const slice = (params[1] as { dataSlice: { offset: number; length: number } }).dataSlice;
    return { context: { slot: 5 }, value: value(programData.subarray(slice.offset, slice.offset + slice.length), false, programData.length) };
  };
  return { programId, read, sha256: createHash("sha256").update(binary).digest("hex") };
}
async function signed() {
  const pair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(7));
  const payer = await getAddressFromPublicKey(pair.publicKey);
  const tx = await signTransaction([pair], compileTransaction(setTransactionMessageLifetimeUsingBlockhash({
    blockhash: blockhash(BLOCKHASH), lastValidBlockHeight: 1000n,
  }, setTransactionMessageFeePayer(payer, createTransactionMessage({ version: 0 })))));
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
}
type Call = { host: string; method: string; params: unknown[] };
/** A fake clock that the transport's own sleep advances. */
function clock() {
  const state = { now: 0, sleeps: [] as number[] };
  return { state, now: () => state.now, sleep: async (ms: number) => { state.sleeps.push(ms); state.now += ms; } };
}

test("live trading refuses to start without an independent fallback on a different hostname (audit G3-6)", () => {
  for (const fallback of [undefined, "", "https://primary.example/other?api-key=x", "https://PRIMARY.example/", "https://primary.example./"]) {
    assert.throws(() => createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: env.MERRYMEN_SOLANA_RPC_MAINNET, MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: fallback } }),
      error => error instanceof SolanaRpcError && error.code === "invalid-fallback" && !error.message.includes("secret"), String(fallback));
  }
  assert.throws(() => createSolanaLiveRpc({ env: { ...env, MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "http://fallback.example/" } }), /HTTPS/);
  assert.ok(createSolanaLiveRpc({ env }).providerKey);
});
test("an owner-run single endpoint talks only to that provider and never borrows a fallback", async () => {
  const seen: string[] = [];
  const rpc = createSolanaLiveRpc({ env, singleEndpoint: true, fetch: async (url, init) => {
    const body = JSON.parse(init!.body as string); const host = new URL(String(url)).hostname;
    seen.push(`${host}:${body.method}`);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : host });
  } });
  assert.equal(await rpc.read(read => read("getSlot")), "primary.example");
  assert.deepEqual(await rpc.readEach!(read => read("getSlot")), ["primary.example"]);
  await assert.rejects(readSolanaQuorum(rpc, read => read("getSlot")), SolanaRpcError);
  assert.ok(seen.every(value => value.startsWith("primary.example:")), seen.join());
  assert.equal(rpc.providerKey, undefined, "an owner-run check is never served from the process cache");
  assert.equal(rpc.singleEndpoint, true); assert.equal(createSolanaLiveRpc({ env }).singleEndpoint, undefined);
  const down = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: env.MERRYMEN_SOLANA_RPC_MAINNET }, singleEndpoint: true,
    fetch: async () => { throw new Error("offline"); } });
  await assert.rejects(down.read(read => read("getSlot")), error => error instanceof SolanaRpcError && error.code === "network");
});
test("an owner-run single endpoint sends one round unless the caller asks for a window", async () => {
  const tx = await signed();
  for (const [options, expected] of [[undefined, 1], [{ untilMs: 5000 }, 3]] as const) {
    const time = clock(); let sends = 0;
    const rpc = createSolanaLiveRpc({ env, singleEndpoint: true, now: time.now, sleep: time.sleep, fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      if (body.method === "getGenesisHash") return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
      if (body.method === "sendTransaction") { sends++; return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "simulation failed" } }); }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: body.method === "isBlockhashValid" ? true : [null] } });
    } });
    await assert.rejects(rpc.send(tx.wire, 1, undefined, options), SolanaRpcError);
    assert.equal(sends, expected, JSON.stringify(options));
  }
});
test("read failover independently verifies mainnet; read callback cannot submit", async () => {
  const seen: string[] = [];
  const rpc = createSolanaLiveRpc({ env, fetch: async (url, init) => {
    const body = JSON.parse(init!.body as string); const host = new URL(String(url)).hostname;
    seen.push(`${host}:${body.method}`);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "getGenesisHash"
      ? host === "primary.example" ? "devnet" : SOLANA_MAINNET_GENESIS_HASH : 44 });
  } });
  assert.equal(await rpc.read(read => read("getSlot")), 44);
  assert.deepEqual(seen, ["primary.example:getGenesisHash", "fallback.example:getGenesisHash", "fallback.example:getSlot"]);
  await assert.rejects(rpc.read(read => read("sendTransaction" as never)), /allowlisted/);
  assert.ok(!seen.some(value => value.endsWith(":sendTransaction")));
});
test("readEach asks every provider in its own mainnet-verified session (audit G3-1, G3-6)", async () => {
  for (const fallbackGenesis of [SOLANA_MAINNET_GENESIS_HASH, "devnet"]) {
    const seen: string[] = [];
    const rpc = createSolanaLiveRpc({ env, fetch: async (url, init) => {
      const body = JSON.parse(init!.body as string); const host = new URL(String(url)).hostname;
      seen.push(`${host}:${body.method}`);
      const result = body.method === "getGenesisHash" ? host === "primary.example" ? SOLANA_MAINNET_GENESIS_HASH : fallbackGenesis : host;
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    } });
    if (fallbackGenesis === "devnet") {
      await assert.rejects(rpc.readEach!(read => read("getSlot")), /mainnet/);
      assert.ok(!seen.includes("fallback.example:getSlot"));
      await assert.rejects(readSolanaQuorum(rpc, read => read("getSlot")), /mainnet/);
    } else {
      assert.deepEqual(await rpc.readEach!(read => read("getSlot")), ["primary.example", "fallback.example"]);
      assert.deepEqual(seen.sort(), ["fallback.example:getGenesisHash", "fallback.example:getSlot", "primary.example:getGenesisHash", "primary.example:getSlot"]);
      // The two providers answer differently here, so they do not agree.
      assert.deepEqual(await readSolanaQuorum(rpc, read => read("getSlot")), { agreed: false, values: ["primary.example", "fallback.example"] });
      assert.deepEqual(await readSolanaQuorum(rpc, async read => typeof await read("getSlot")),
        { agreed: true, value: "string", values: ["string", "string"] });
    }
  }
});
test("readSolanaQuorum needs at least two providers and compares by the caller's key", async () => {
  const read: SolanaLiveRead = async () => 1;
  const one: SolanaLiveRpc = { read: callback => callback(read), send: async () => "" };
  await assert.rejects(readSolanaQuorum(one, r => r("getSlot")), error => error instanceof SolanaRpcError && error.code === "no-quorum");
  const lonely: SolanaLiveRpc = { ...one, readEach: async callback => [await callback(read)] };
  await assert.rejects(readSolanaQuorum(lonely, r => r("getSlot")), /two independent/);
  let call = 0;
  const pair: SolanaLiveRpc = { ...one, readEach: async <T,>(callback: (r: SolanaLiveRead) => Promise<T>) =>
    [await callback(read), await callback(read)].map(() => ({ height: ++call, outcome: "expired" })) as unknown as T[] };
  const quorum = await readSolanaQuorum(pair, async () => ({ height: 0, outcome: "" }), value => value.outcome);
  assert.equal(quorum.agreed, true);
  assert.deepEqual(quorum.agreed && quorum.value, { height: 1, outcome: "expired" });
  assert.equal((await readSolanaQuorum(pair, async () => ({ height: 0, outcome: "" }))).agreed, false);
});
test("checks every provider must pass refuse a transport with fewer than two, except an owner-run single endpoint", async () => {
  const read: SolanaLiveRead = async () => 7;
  const noEach: SolanaLiveRpc = { read: callback => callback(read), send: async wire => wire };
  const lonely: SolanaLiveRpc = { ...noEach, readEach: async callback => [await callback(read)] };
  const pair: SolanaLiveRpc = { ...noEach, readEach: async callback => [await callback(read), await callback(read)] };
  for (const rpc of [noEach, lonely, { ...pair, readEach: async () => [] }]) {
    await assert.rejects(readSolanaEachProvider(rpc, r => r("getSlot")), error => error instanceof SolanaRpcError && error.code === "no-quorum");
  }
  assert.deepEqual(await readSolanaEachProvider(pair, r => r("getSlot")), [7, 7]);
  // The deployment check a live runtime runs refuses one provider's word, even for a valid immutable deployment.
  const deployed = deployment();
  const lonelyDeployed: SolanaLiveRpc = { read: callback => callback(deployed.read), readEach: async callback => [await callback(deployed.read)], send: async wire => wire };
  await assert.rejects(verifySolanaVaultDeployment(lonelyDeployed, deployed.programId, deployed.sha256), error => error instanceof SolanaRpcError && error.code === "no-quorum");
  const pairDeployed: SolanaLiveRpc = { ...lonelyDeployed, readEach: async callback => [await callback(deployed.read), await callback(deployed.read)] };
  assert.equal((await verifySolanaVaultDeployment(pairDeployed, deployed.programId, deployed.sha256)).slot, 5);
  assert.equal((await verifySolanaVaultDeployment({ ...lonelyDeployed, singleEndpoint: true }, deployed.programId, deployed.sha256)).slot, 5);
  // An owner-run single endpoint checks against the one RPC its owner chose.
  for (const owned of [{ ...noEach, singleEndpoint: true }, { ...lonely, singleEndpoint: true }]) {
    assert.deepEqual(await readSolanaEachProvider(owned, r => r("getSlot")), [7]);
  }
  const single = createSolanaLiveRpc({ env, singleEndpoint: true, fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : 9 });
  } });
  assert.deepEqual(await readSolanaEachProvider(single, r => r("getSlot")), [9]);
});
// "confirmed" is the same state as "finalized" since Alpenglow, and a provider may report either until Agave removes it.
for (const reported of ["confirmed", "finalized"] as const) test(`send broadcasts the identical bytes to both providers and rebroadcasts a dropped send until it is seen ${reported} (audit G2-1)`, async () => {
  const tx = await signed(), time = clock(), calls: Call[] = [];
  const rounds: Record<string, number> = { "primary.example": 0, "fallback.example": 0 };
  const rpc = createSolanaLiveRpc({ env, now: time.now, sleep: time.sleep, fetch: async (url, init) => {
    const body = JSON.parse(init!.body as string), host = new URL(String(url)).hostname;
    calls.push({ host, method: body.method, params: body.params });
    if (body.method === "getGenesisHash") return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
    if (body.method === "sendTransaction") {
      // Round 1 is lost: the primary drops the response, the fallback is rate limited.
      if (++rounds[host]! === 1) { if (host === "primary.example") throw new Error("secret-primary reset"); return new Response("slow down", { status: 429 }); }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: tx.signature });
    }
    if (body.method === "getSignatureStatuses") {
      assert.deepEqual(body.params, [[tx.signature]]);
      // Processed after round 2 (its fork may still be dropped), confirmed or finalized after round 3.
      const status = host !== "fallback.example" || rounds[host]! < 2 ? null
        : { confirmationStatus: rounds[host]! >= 3 ? reported : "processed", confirmations: 0, err: null };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 9 }, value: [status] } });
    }
    assert.equal(body.method, "isBlockhashValid"); assert.deepEqual(body.params, [BLOCKHASH, { commitment: "processed", minContextSlot: 5 }]);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 9 }, value: true } });
  } });
  assert.equal(await rpc.send(tx.wire, 5, undefined, { untilMs: 30_000 }), tx.signature);
  const sends = calls.filter(call => call.method === "sendTransaction");
  assert.equal(sends.length, 6, `three rounds to both providers, stopping once the signature is ${reported}`);
  assert.deepEqual(new Set(sends.map(call => call.host)), new Set(["primary.example", "fallback.example"]));
  for (const call of sends) {
    assert.equal(call.params[0], tx.wire, "never anything but the saved bytes");
    assert.deepEqual(call.params[1], { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0, minContextSlot: 5 });
  }
  assert.deepEqual(time.state.sleeps, [2000, 2000, 2000]);
});
test("a pre-send failure is retried, and a send nobody accepted still rejects without leaking provider data", async () => {
  const tx = await signed(), time = clock(); let genesis = 0;
  const rpc = createSolanaLiveRpc({ env, now: time.now, sleep: time.sleep, fetch: async (url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.method === "getGenesisHash") return ++genesis <= 2 ? new Response("secret-primary 429", { status: 429 })
      : Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
    if (body.method === "sendTransaction") return Response.json({ jsonrpc: "2.0", id: body.id, result: tx.signature });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: body.method === "isBlockhashValid" ? true : [null] } });
  } });
  assert.equal(await rpc.send(tx.wire, 1, undefined, { untilMs: 0 }).catch(error => error.code), "http", "one round only");
  assert.equal(await rpc.send(tx.wire, 1, undefined, { untilMs: 0 }), tx.signature, "the next round's probes pass");
  const failing = createSolanaLiveRpc({ env, now: time.now, sleep: time.sleep, fetch: async () => { throw new Error("secret-primary down"); } });
  await assert.rejects(failing.send(tx.wire, 1, undefined, { untilMs: time.now() + 4000 }), error => {
    assert.ok(error instanceof SolanaRpcError); assert.ok(!error.message.includes("secret")); return true;
  });
});
test("rebroadcast stops at the caller's window, when every provider says the blockhash expired, and on a different signature", async () => {
  const tx = await signed();
  for (const scenario of ["window", "expired", "default", "wrong-signature"] as const) {
    const time = clock(), methods: string[] = [];
    const rpc = createSolanaLiveRpc({ env, now: time.now, sleep: time.sleep, fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string); methods.push(body.method);
      if (body.method === "getGenesisHash") return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
      if (body.method === "sendTransaction") return Response.json({ jsonrpc: "2.0", id: body.id,
        result: scenario === "wrong-signature" ? "5".repeat(88) : tx.signature });
      if (body.method === "getSignatureStatuses") return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: [null] } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: scenario !== "expired" } });
    } });
    const sent = rpc.send(tx.wire, 1, undefined, scenario === "window" ? { untilMs: 5000 } : scenario === "default" ? undefined : { untilMs: 60_000 });
    if (scenario === "wrong-signature") await assert.rejects(sent, /malformed/); else assert.equal(await sent, tx.signature);
    const rounds = methods.filter(method => method === "sendTransaction").length / 2;
    // Rounds start every 2 s while the window is open: 0-4 s of 5 s, 0-14 s of the default 15 s, 0-58 s of 60 s.
    assert.equal(rounds, { window: 3, expired: 1, default: 8, "wrong-signature": 30 }[scenario], scenario);
  }
});
test("a JSON-RPC error answer, such as a refused preflight, is the provider's refusal ('rpc'), never 'malformed', and keeps none of its text", async () => {
  const tx = await signed(), time = clock();
  const answer = (id: unknown, method: string) => method === "getGenesisHash" ? { jsonrpc: "2.0", id, result: SOLANA_MAINNET_GENESIS_HASH }
    : { jsonrpc: "2.0", id, error: { code: -32002, message: "Transaction simulation failed: secret-primary insufficient funds", data: { logs: ["secret-primary"] } } };
  const rpc = createSolanaLiveRpc({ env, now: time.now, sleep: time.sleep, fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string); return Response.json(answer(body.id, body.method));
  } });
  await assert.rejects(rpc.send(tx.wire, 1, undefined, { untilMs: 0 }), error => {
    assert.ok(error instanceof SolanaRpcError); assert.equal(error.code, "rpc"); assert.ok(!error.message.includes("secret")); return true;
  });
  await assert.rejects(rpc.read(read => read("getSlot")), error => error instanceof SolanaRpcError && error.code === "rpc");
  // An answer with neither a result nor an error, or for another request, is still malformed.
  for (const bad of [(id: unknown) => ({ jsonrpc: "2.0", id }), (id: unknown) => ({ jsonrpc: "2.0", id: Number(id) + 1, error: { code: 1 } })]) {
    const odd = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: env.MERRYMEN_SOLANA_RPC_MAINNET }, singleEndpoint: true, fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      return Response.json(body.method === "getGenesisHash" ? { jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH } : bad(body.id));
    } });
    await assert.rejects(odd.read(read => read("getSlot")), error => error instanceof SolanaRpcError && error.code === "malformed");
  }
});
test("rejects unsigned garbage before network and wrong genesis before send", async () => {
  const tx = await signed(); let calls = 0;
  const rpc = createSolanaLiveRpc({ env, fetch: async (_url, init) => {
    calls++; const { id } = JSON.parse(init!.body as string); return Response.json({ jsonrpc: "2.0", id, result: "devnet" });
  } });
  await assert.rejects(rpc.send(Buffer.from("garbage").toString("base64"), 1)); assert.equal(calls, 0);
  await assert.rejects(rpc.send(tx.wire, 1, undefined, { untilMs: 0 }), /mainnet/); assert.equal(calls, 2);
});
test("send deadlines and redirect errors stay bounded and do not expose provider bodies", async () => {
  const tx = await signed(); let calls = 0;
  const timed = createSolanaLiveRpc({ env, timeoutMs: 10, fetch: async (_url, init) => {
    calls++; const body = JSON.parse(init!.body as string);
    if (body.method === "sendTransaction") return new Promise<Response>(() => {});
    return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
  } });
  await assert.rejects(timed.send(tx.wire, 1, undefined, { untilMs: 0 }), /timed out/); assert.equal(calls, 4);
  const redirects = createSolanaLiveRpc({ env, fetch: async () => new Response("secret-primary", { status: 302 }) });
  await assert.rejects(redirects.send(tx.wire, 1, undefined, { untilMs: 0 }), /redirect/);
});
test("external abort fences genesis-to-send, reaches an in-flight fetch and ends rebroadcasting", async () => {
  const tx = await signed();
  for (const phase of ["before", "genesis", "send", "waiting"] as const) {
    const controller = new AbortController(), seen: string[] = []; let transportAborted = false;
    if (phase === "before") controller.abort("private-reason");
    const rpc = createSolanaLiveRpc({ env, now: () => 0, sleep: async () => { if (phase === "waiting") controller.abort("private-reason"); },
      fetch: async (_url, init) => {
        const body = JSON.parse(init!.body as string); seen.push(body.method);
        if (body.method === "getGenesisHash") {
          if (phase === "genesis") controller.abort("private-reason");
          return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
        }
        assert.equal(body.method, "sendTransaction");
        if (phase === "waiting") return Response.json({ jsonrpc: "2.0", id: body.id, result: tx.signature });
        if (init!.signal!.aborted) throw new Error("private-reason");
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => { transportAborted = true; reject(new Error("private-reason")); }, { once: true });
          controller.abort("private-reason");
        });
      } });
    await assert.rejects(rpc.send(tx.wire, 1, controller.signal, { untilMs: 60_000 }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /cancelled/); assert.ok(!error.message.includes("private")); return true;
    });
    const sends = seen.filter(method => method === "sendTransaction").length;
    assert.ok(phase === "send" ? sends >= 1 : sends === { before: 0, genesis: 0, waiting: 2 }[phase], phase);
    assert.equal(transportAborted, phase === "send");
  }
});
test("priority fee estimates take the 75th percentile within bounds and refuse malformed answers", async () => {
  const answer = (rows: unknown): SolanaLiveRead => async (method, params) => {
    assert.equal(method, "getRecentPrioritizationFees"); assert.deepEqual(params, [["a", "b"]]); return rows;
  };
  const rows = (fees: number[]) => fees.map((prioritizationFee, slot) => ({ slot, prioritizationFee }));
  const bounds = { minimum: 0n, maximum: 1_000_000n };
  assert.equal(await readSolanaPriorityFee(answer(rows([])), ["a", "b", "a"], bounds), 0n);
  assert.equal(await readSolanaPriorityFee(answer(rows([1, 2, 3, 4, 5, 6, 7, 8])), ["a", "b"], bounds), 6n);
  assert.equal(await readSolanaPriorityFee(answer(rows([9])), ["a", "b"], { minimum: 10n, maximum: 20n }), 10n);
  assert.equal(await readSolanaPriorityFee(answer(rows([10 ** 15])), ["a", "b"], bounds), 1_000_000n);
  for (const bad of [null, {}, [{ slot: 1 }], [{ slot: 1, prioritizationFee: -1 }], [{ slot: 1, prioritizationFee: "5" }]]) {
    await assert.rejects(readSolanaPriorityFee(answer(bad), ["a", "b"], bounds), /malformed/);
  }
  await assert.rejects(readSolanaPriorityFee(answer([]), Array.from({ length: 129 }, (_, i) => String(i)), bounds), /malformed/);
  await assert.rejects(readSolanaPriorityFee(answer([]), ["a", "b"], { minimum: 2n, maximum: 1n }), /malformed/);
});
