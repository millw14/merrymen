/**
 * THE OWNER'S RPC URL STAYS OFF THE COMMAND LINE.
 *
 * A keyed provider URL (Helius ?api-key=, an Alchemy or Triton path token)
 * typed after --rpc lands in shell history and in the process list. So
 * solana-recover reads it from MERRYMEN_SOLANA_RECOVER_RPC, keeps --rpc for a
 * keyless URL, refuses both at once, and warns (never echoing it) when an
 * --rpc value looks keyed. As for solana-resolve's third RPC (GA round-1 13).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../packages/core/src/ids";
import { SolanaRecoverError } from "./solana-recover";
import { runSolanaRecoverCommand, SOLANA_RECOVER_HELP, SOLANA_RECOVER_RPC_ARG_WARNING, SOLANA_RECOVER_RPC_ENV } from "./solana-recover-command";

const PROGRAM = "EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU";
const OWNER = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const KEYED = "https://mainnet.helius-rpc.com/?api-key=3f9c2a71-5b0e-4d8a-9c6f-0e1d2b3a4c5d";
const SECRET = "3f9c2a71-5b0e-4d8a-9c6f-0e1d2b3a4c5d";

/** A plan run whose every RPC request is recorded and refused, so nothing leaves the process. */
async function plan(args: string[], env: Record<string, string | undefined>) {
  const fetched: string[] = [], out: string[] = [], warnings: string[] = [];
  const fetch = (async (input: unknown) => { fetched.push(String(input)); throw new Error(`network disabled ${String(input)}`); }) as typeof globalThis.fetch;
  let error: unknown = null;
  try {
    await runSolanaRecoverCommand(["--program", PROGRAM, "--owner", OWNER, ...args], {
      env, fetch, log: (l) => out.push(l), warn: (l) => warnings.push(l), sleep: async () => {}, releases: [], maxWaitMs: 1, pollMs: 1,
    });
  } catch (e) { error = e; }
  const text = [out.join("\n"), warnings.join("\n"), error instanceof Error ? `${error.message}\n${error.stack}` : String(error)].join("\n");
  assert.ok(!text.includes(SECRET), "the RPC key was printed");
  return { fetched, warnings, error };
}

describe("solana-recover's RPC URL", () => {
  it("is read from MERRYMEN_SOLANA_RECOVER_RPC, with no warning", async () => {
    assert.equal(SOLANA_RECOVER_RPC_ENV, "MERRYMEN_SOLANA_RECOVER_RPC");
    const { fetched, warnings, error } = await plan([], { [SOLANA_RECOVER_RPC_ENV]: `  ${KEYED}\n` });
    assert.ok(error instanceof Error, "the refused network stops the plan");
    assert.ok(fetched.length > 0 && fetched.every((url) => new URL(url).href === new URL(KEYED).href), "only the URL from the environment is asked");
    assert.deepEqual(warnings, []);
  });

  it("is refused given both ways, or neither, before any request", async () => {
    const both = await plan(["--rpc", "https://api.mainnet-beta.solana.com"], { [SOLANA_RECOVER_RPC_ENV]: KEYED });
    assert.ok(both.error instanceof SolanaRecoverError);
    assert.match(both.error.message, /Give the RPC once: MERRYMEN_SOLANA_RECOVER_RPC or --rpc, not both/);
    const neither = await plan([], { [SOLANA_RECOVER_RPC_ENV]: "  " });
    assert.ok(neither.error instanceof SolanaRecoverError);
    assert.match(neither.error.message, /^Set MERRYMEN_SOLANA_RECOVER_RPC to a mainnet-beta HTTPS RPC endpoint you trust/);
    assert.deepEqual([...both.fetched, ...neither.fetched], []);
  });

  it("may still be given with --rpc: a keyless one quietly, a keyed one with a warning that never repeats it", async () => {
    for (const url of ["https://api.mainnet-beta.solana.com", "https://rpc.example.test/", "https://rpc.example.test/solana-mainnet"]) {
      const { fetched, warnings } = await plan(["--rpc", url], {});
      assert.deepEqual(warnings, [], url);
      assert.ok(fetched.length > 0 && fetched.every((u) => new URL(u).href === new URL(url).href), `${url}: ${fetched[0]}`);
    }
    for (const url of [KEYED, "https://solana-mainnet.g.alchemy.com/v2/Fk7qZ2mXw9Lr4TbN0cVyH3sJ8dPaQe6U",
      "https://acme.mainnet.rpcpool.com/plainlowercasetoken0123", "https://rpc.example.test/?token=abc", "https://user:pw@rpc.example.test/",
      "https://rpc.example.test/abcdef0123456789abcd"]) {
      const { fetched, warnings, error } = await plan(["--rpc", url], {});
      assert.deepEqual(warnings, [SOLANA_RECOVER_RPC_ARG_WARNING], url);
      assert.ok(!SOLANA_RECOVER_RPC_ARG_WARNING.includes("://"), "the warning names no URL");
      // A warning, not a refusal: the URL is used, unless the RPC client refuses it on its own rules (userinfo).
      assert.ok(fetched.length > 0 || /credentials|user/i.test(String((error as Error)?.message)), `${url}: ${String((error as Error)?.message)}`);
    }
  });

  it("is documented as the environment variable, with --rpc for a URL without a key", () => {
    assert.match(SOLANA_RECOVER_HELP, /First put your RPC URL in MERRYMEN_SOLANA_RECOVER_RPC, without typing it into a\ncommand/);
    assert.match(SOLANA_RECOVER_HELP, /read -rs MERRYMEN_SOLANA_RECOVER_RPC; export MERRYMEN_SOLANA_RECOVER_RPC/);
    assert.match(SOLANA_RECOVER_HELP, /--rpc HTTPS_URL gives the RPC on the command line instead, for a URL with no\nAPI key in it/);
    assert.doesNotMatch(SOLANA_RECOVER_HELP, /solana-recover --program PROGRAM_ID --rpc/);
  });
});
