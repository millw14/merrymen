import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  probeSolanaMainnetRpc,
  readSolanaLiveRpcConfig,
  readSolanaMainnetRpcConfig,
  SOLANA_MAINNET_GENESIS_HASH,
  SolanaRpcError,
  withSolanaMainnetRead,
  SOLANA_RESPONSE_LIMIT_BYTES,
} from "./solana-rpc";

const SECRET = "fixture-secret-do-not-log";
const ENDPOINT = `https://rpc.example.test/?api-key=${SECRET}`;
const CONFIG = readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT });
type RequestBody = { id: number; method: string; params: unknown[] };
const bodyOf = (init?: RequestInit): RequestBody => JSON.parse(String(init?.body));
const resultResponse = (id: number, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));

const assertSafeError = (code: SolanaRpcError["code"]) => (error: unknown): boolean => {
  assert.ok(error instanceof SolanaRpcError);
  assert.equal(error.code, code);
  for (const visible of [String(error), error.stack ?? "", JSON.stringify(error)]) {
    assert.ok(!visible.includes(SECRET), "credentials must not escape through errors");
    assert.ok(!visible.includes(ENDPOINT), "the endpoint must not escape through errors");
  }
  assert.equal(error.cause, undefined);
  return true;
};

describe("server-side Solana mainnet RPC configuration", () => {
  it("requires an explicit private setting, with no public endpoint fallback", () => {
    for (const value of [undefined, "", "  "]) {
      assert.throws(() => readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: value }),
        assertSafeError("missing-config"));
    }
    assert.deepEqual(CONFIG, { url: ENDPOINT });
  });

  it("rejects malformed, unencrypted, credential-userinfo, and fragment URLs without echoing input", () => {
    for (const value of [
      SECRET,
      `http://rpc.example.test/?api-key=${SECRET}`,
      `wss://rpc.example.test/?api-key=${SECRET}`,
      `https://${SECRET}@rpc.example.test/`,
      `https://rpc.example.test/#${SECRET}`,
    ]) {
      assert.throws(() => readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: value }),
        assertSafeError("invalid-config"));
    }
  });
});

describe("read-only Solana mainnet RPC probe", () => {
  it("verifies the full chain identity before checking health and a finalized slot", async () => {
    const methods: string[] = [];
    const result = await probeSolanaMainnetRpc(CONFIG, {
      fetch: async (input, init) => {
        assert.equal(input, ENDPOINT);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal instanceof AbortSignal);
        const { id, method, params } = bodyOf(init);
        methods.push(method);
        assert.deepEqual(params, method === "getSlot" ? [{ commitment: "finalized" }] : []);
        return resultResponse(id, {
          getGenesisHash: SOLANA_MAINNET_GENESIS_HASH,
          getHealth: "ok",
          getSlot: 123456,
        }[method]);
      },
    });
    assert.deepEqual(methods, ["getGenesisHash", "getHealth", "getSlot"]);
    assert.deepEqual(result, { cluster: "mainnet-beta", healthy: true, slot: 123456 });
    assert.ok(!JSON.stringify(result).includes(ENDPOINT));
  });

  it("rejects devnet and a matching hash prefix without making further requests", async () => {
    for (const genesis of ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]) {
      let calls = 0;
      await assert.rejects(probeSolanaMainnetRpc(CONFIG, {
        fetch: async (_input, init) => {
          calls++;
          return resultResponse(bodyOf(init).id, genesis);
        },
      }), assertSafeError("wrong-network"));
      assert.equal(calls, 1);
    }
  });

  it("sanitizes transport, HTTP, RPC, and invalid JSON failures", async () => {
    const scenarios: Array<{ code: SolanaRpcError["code"]; fetch: typeof fetch }> = [
      { code: "network", fetch: async () => { throw new Error(`Unable to fetch ${ENDPOINT}`); } },
      { code: "http", fetch: async () => new Response(ENDPOINT, { status: 401, statusText: SECRET }) },
      { code: "rpc", fetch: async (_input, init) => new Response(JSON.stringify({
        jsonrpc: "2.0", id: bodyOf(init).id,
        error: { code: -32005, message: ENDPOINT, data: SECRET },
      })) },
      { code: "malformed", fetch: async () => new Response(ENDPOINT) },
    ];
    for (const scenario of scenarios) {
      await assert.rejects(probeSolanaMainnetRpc(CONFIG, { fetch: scenario.fetch }),
        assertSafeError(scenario.code));
    }
  });

  it("rejects redirect responses and never follows a Location header", async () => {
    let calls = 0;
    await assert.rejects(probeSolanaMainnetRpc(CONFIG, {
      fetch: async (_input, init) => {
        calls++;
        assert.equal(init?.redirect, "error");
        return new Response(null, { status: 307, headers: { location: ENDPOINT } });
      },
    }), assertSafeError("redirect"));
    assert.equal(calls, 1);
  });

  it("rejects malformed JSON-RPC envelopes and malformed genesis results", async () => {
    for (const response of [
      null, [], SECRET, {},
      { jsonrpc: "1.0", id: 1, result: SOLANA_MAINNET_GENESIS_HASH },
      { jsonrpc: "2.0", id: 2, result: SOLANA_MAINNET_GENESIS_HASH },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: 1, result: null },
    ]) {
      await assert.rejects(probeSolanaMainnetRpc(CONFIG, {
        fetch: async () => new Response(JSON.stringify(response)),
      }), assertSafeError("malformed"));
    }
  });

  it("does not accept an unhealthy endpoint or invalid slot as ready", async () => {
    for (const [health, slot, code] of [
      ["behind", 123, "unhealthy"],
      [null, 123, "unhealthy"],
      ["ok", -1, "malformed"],
      ["ok", 1.5, "malformed"],
      ["ok", "123", "malformed"],
      ["ok", Number.MAX_SAFE_INTEGER + 1, "malformed"],
    ] as const) {
      await assert.rejects(probeSolanaMainnetRpc(CONFIG, {
        fetch: async (_input, init) => {
          const { id, method } = bodyOf(init);
          return resultResponse(id, method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH
            : method === "getHealth" ? health : slot);
        },
      }), assertSafeError(code));
    }
  });

  it("bounds a transport that never resolves and aborts its request", async () => {
    let signal: AbortSignal | null | undefined;
    await assert.rejects(probeSolanaMainnetRpc(CONFIG, {
      timeoutMs: 10,
      fetch: async (_input, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      },
    }), assertSafeError("timeout"));
    assert.equal(signal?.aborted, true);
  });

  it("bounds response-body reads as well as connecting", async () => {
    await assert.rejects(probeSolanaMainnetRpc(CONFIG, {
      timeoutMs: 10,
      fetch: async () => {
        return new Response(new ReadableStream({ start() {} }));
      },
    }), assertSafeError("timeout"));
  });

  it("validates manually constructed configs and timeout limits before making any request", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      throw new Error(SECRET);
    };
    await assert.rejects(probeSolanaMainnetRpc({ url: SECRET }, { fetch }),
      assertSafeError("invalid-config"));
    for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 30_001]) {
      await assert.rejects(probeSolanaMainnetRpc(CONFIG, { fetch, timeoutMs }),
        assertSafeError("invalid-timeout"));
    }
    assert.equal(calls, 0);
  });
});

describe("bounded read-only RPC fallback", () => {
  const FALLBACK = "https://independent.example.test/?api-key=fixture-fallback";
  const config = readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT,
    MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: FALLBACK });
  it("requires an explicit HTTPS fallback on a different hostname", () => {
    assert.deepEqual(config, { url: ENDPOINT, fallbackUrl: FALLBACK });
    for (const url of [ENDPOINT, "https://rpc.example.test/another-path?key=another-key"]) {
      assert.throws(() => readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT,
        MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: url }), assertSafeError("invalid-fallback"));
    }
    assert.throws(() => readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT,
      MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "http://backup.example.test" }), assertSafeError("invalid-config"));
    // A trailing dot or capital letters still name the primary's host.
    for (const url of ["https://rpc.example.test./", "https://RPC.example.test/"]) {
      assert.throws(() => readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT,
        MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: url }), assertSafeError("invalid-fallback"));
    }
  });
  it("makes the independent fallback mandatory for live trading (audit G3-6)", () => {
    assert.deepEqual(readSolanaLiveRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT, MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: FALLBACK }),
      { url: ENDPOINT, fallbackUrl: FALLBACK });
    for (const fallback of [undefined, "", "  ", ENDPOINT]) {
      assert.throws(() => readSolanaLiveRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT, MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: fallback }),
        assertSafeError("invalid-fallback"));
    }
    assert.throws(() => readSolanaLiveRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: FALLBACK }), assertSafeError("missing-config"));
    // Paper reads keep the fallback optional.
    assert.deepEqual(readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: ENDPOINT }), { url: ENDPOINT });
  });
  it("verifies the fallback's genesis before any account read", async () => {
    const calls: Array<[string, string]> = [];
    const result = await withSolanaMainnetRead(config, rpc => rpc("getAccountInfo", ["mint", { encoding: "jsonParsed" }]), {
      fetch: async (input, init) => {
        const { id, method } = bodyOf(init); calls.push([String(input), method]);
        if (input === ENDPOINT) throw new Error(SECRET);
        return resultResponse(id, method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : { answer: "read" });
      },
    });
    assert.deepEqual(result, { answer: "read" });
    assert.deepEqual(calls, [[ENDPOINT, "getGenesisHash"], [FALLBACK, "getGenesisHash"], [FALLBACK, "getAccountInfo"]]);
  });
  it("never uses an unverified fallback after primary failure", async () => {
    const calls: string[] = [];
    await assert.rejects(withSolanaMainnetRead(config, rpc => rpc("getAccountInfo"), {
      fetch: async (input, init) => {
        const { id, method } = bodyOf(init); calls.push(method);
        if (input === ENDPOINT) return new Response(null, { status: 503 });
        return resultResponse(id, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
      },
    }), assertSafeError("wrong-network"));
    assert.deepEqual(calls, ["getGenesisHash", "getGenesisHash"]);
  });
  it("bounds a hung primary then succeeds on the explicit fallback", async () => {
    let primarySignal: AbortSignal | null | undefined;
    const result = await withSolanaMainnetRead(config, rpc => rpc("getSlot"), {
      timeoutMs: 10,
      fetch: async (input, init) => {
        if (input === ENDPOINT) { primarySignal = init?.signal; return new Promise<Response>(() => {}); }
        const { id, method } = bodyOf(init);
        return resultResponse(id, method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : 10);
      },
    });
    assert.equal(result, 10); assert.equal(primarySignal?.aborted, true);
  });
  it("re-verifies fallback and restarts a read after primary failure mid-operation", async () => {
    const calls: Array<[string, string]> = [];
    const result = await withSolanaMainnetRead(config, async rpc => {
      await rpc("getSlot", [{ commitment: "finalized" }]);
      return rpc("getAccountInfo");
    }, { fetch: async (input, init) => {
      const { id, method } = bodyOf(init); calls.push([String(input), method]);
      if (input === ENDPOINT && method === "getAccountInfo") throw new Error(SECRET);
      return resultResponse(id, method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : 11);
    } });
    assert.equal(result, 11);
    assert.deepEqual(calls, [[ENDPOINT, "getGenesisHash"], [ENDPOINT, "getSlot"], [ENDPOINT, "getAccountInfo"],
      [FALLBACK, "getGenesisHash"], [FALLBACK, "getSlot"], [FALLBACK, "getAccountInfo"]]);
  });
  it("enforces the read method allowlist at runtime without attempting a write or retry", async () => {
    let requests = 0;
    await assert.rejects(withSolanaMainnetRead(config, rpc => rpc("sendTransaction" as never, [SECRET]), {
      fetch: async (_input, init) => { requests++; return resultResponse(bodyOf(init).id, SOLANA_MAINNET_GENESIS_HASH); },
    }), assertSafeError("unsupported-method"));
    assert.equal(requests, 1);
  });
  it("does not replay application validation errors against a fallback", async () => {
    let requests = 0;
    const sentinel = new Error("invalid mint policy");
    await assert.rejects(withSolanaMainnetRead(config, async () => { throw sentinel; }, {
      fetch: async (_input, init) => { requests++; return resultResponse(bodyOf(init).id, SOLANA_MAINNET_GENESIS_HASH); },
    }), error => error === sentinel);
    assert.equal(requests, 1);
  });
  it("bounds declared and streamed response size, including without content length", async () => {
    for (const fetch of [
      async () => new Response("{}", { headers: { "content-length": String(SOLANA_RESPONSE_LIMIT_BYTES + 1) } }),
      async () => new Response(" ".repeat(SOLANA_RESPONSE_LIMIT_BYTES + 1)),
      async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(SOLANA_RESPONSE_LIMIT_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
      } })),
    ]) {
      await assert.rejects(probeSolanaMainnetRpc(CONFIG, { fetch }), assertSafeError("too-large"));
    }
  });
  it("rejects invalid UTF-8 and sanitizes streaming failures", async () => {
    for (const fetch of [
      async () => new Response(new Uint8Array([0xff])),
      async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(ENDPOINT)); } })),
    ]) {
      await assert.rejects(probeSolanaMainnetRpc(CONFIG, { fetch }), assertSafeError("malformed"));
    }
  });
});
