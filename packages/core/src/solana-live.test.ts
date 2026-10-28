import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join as pathJoin } from "node:path";
import { pathToFileURL } from "node:url";
import { address, getProgramDerivedAddress } from "@solana/kit";
import {
  base58Decode,
  base58Encode,
  SOLANA_USDG_MINT,
  TOKEN_2022_PROGRAM,
} from "./ids";
import * as live from "./solana-live";
const owner = base58Encode(new Uint8Array(32).fill(3));
const session = base58Encode(new Uint8Array(32).fill(4));
const feePayer = base58Encode(new Uint8Array(32).fill(5));
const programAddress = live.SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const key = (s: string) => base58Decode(s)!;
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const disc = (s: string) =>
  new Uint8Array(createHash("sha256").update(s).digest().subarray(0, 8));
const join = (...xs: Uint8Array[]) =>
  Uint8Array.from(xs.flatMap((x) => Array.from(x)));
describe("Solana live shared ABI", () => {
  it("pins the official Jupiter shared_accounts_route discriminator", () => {
    assert.deepEqual(
      live.SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR,
      disc("global:shared_accounts_route"),
    );
  });
  it("encodes native recovery with only owner authority", () => {
    const ix = live.buildWithdrawSolanaNativeInstruction({
      programAddress,
      vault: programAddress,
      owner,
      amount: 100n,
    });
    assert.deepEqual(
      Array.from(ix.data!.slice(0, 8)),
      Array.from(disc("global:withdraw_sol")),
    );
    assert.deepEqual(
      ix.accounts!.map((a) => a.role),
      [1, 3],
    );
    assert.throws(
      () =>
        live.buildWithdrawSolanaNativeInstruction({
          programAddress,
          vault: programAddress,
          owner,
          amount: 0n,
        }),
      live.SolanaVaultValidationError,
    );
  });

  it("derives separate owner and per-sequence authorities deterministically", async () => {
    const vault = await live.deriveSolanaVaultAddress(programAddress, owner);
    assert.equal(
      vault,
      await live.deriveSolanaVaultAddress(programAddress, owner),
    );
    assert.notEqual(
      vault,
      await live.deriveSolanaVaultAddress(programAddress, session),
    );
    assert.notEqual(
      await live.deriveSolanaSwapAuthority(programAddress, vault, 0n),
      await live.deriveSolanaSwapAuthority(programAddress, vault, 1n),
    );
    assert.notEqual(
      await live.deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
      await live.deriveSolanaAta(
        vault,
        SOLANA_USDG_MINT,
        live.SOLANA_CLASSIC_TOKEN_PROGRAM,
      ),
    );
  });
  it("encodes Anchor session instruction without lossy number conversion", () => {
    const ix = live.buildCreateSolanaSessionInstruction({
      programAddress,
      vault: programAddress,
      owner,
      session,
      perTrade: 9007199254740993n,
      daily: 9007199254740999n,
      perTradeWsol: 250_000_000n,
      dailyWsol: 1_000_000_000n,
      maxOps: 96,
      expiresAt: 2000000000n,
    });
    // Argument order is the program's: session, per_trade, daily,
    // per_trade_wsol, daily_wsol, max_ops, expires_at.
    assert.deepEqual(
      Array.from(ix.data!),
      Array.from(
        join(
          disc("global:create_session"),
          key(session),
          u64(9007199254740993n),
          u64(9007199254740999n),
          u64(250_000_000n),
          u64(1_000_000_000n),
          Uint8Array.of(96, 0),
          u64(2000000000n),
        ),
      ),
    );
    assert.deepEqual(
      ix.accounts!.map((a) => a.role),
      [1, 2],
    );
  });
  it("rejects invalid public keys, overflowing integers and unsafe limits", async () => {
    assert.throws(
      () =>
        live.buildInitializeSolanaVaultInstruction({
          programAddress,
          vault: programAddress,
          owner: " invalid",
        }),
      live.SolanaVaultValidationError,
    );
    await assert.rejects(
      live.deriveSolanaSwapAuthority(programAddress, owner, 1n << 64n),
      live.SolanaVaultValidationError,
    );
    assert.throws(
      () =>
        live.buildCreateSolanaSessionInstruction({
          programAddress,
          vault: programAddress,
          owner,
          session,
          perTrade: 2n,
          daily: 1n,
          perTradeWsol: 1n,
          dailyWsol: 1n,
          maxOps: 1,
          expiresAt: 100n,
        }),
      live.SolanaVaultValidationError,
    );
    // A session with no WSOL input bound would let sells drain the position.
    for (const [perTradeWsol, dailyWsol] of [
      [0n, 1n],
      [2n, 1n],
    ] as const) {
      assert.throws(
        () =>
          live.buildCreateSolanaSessionInstruction({
            programAddress,
            vault: programAddress,
            owner,
            session,
            perTrade: 1n,
            daily: 1n,
            perTradeWsol,
            dailyWsol,
            maxOps: 1,
            expiresAt: 100n,
          }),
        live.SolanaVaultValidationError,
      );
    }
  });
  it("decodes bounded vault data including retained Anchor Vec capacity", () => {
    const data = new Uint8Array(live.SOLANA_VAULT_ACCOUNT_SIZE);
    const prefix = join(
      disc("account:Vault"),
      Uint8Array.of(2, 254),
      key(owner),
      key(session),
      u64(2n),
      u64(9007199254740993n),
      u64(2000000000n),
      u64(1000000n),
      u64(2000000n),
      u64(300n),
      u64(900n),
      Uint8Array.of(96, 0, 1),
      Uint8Array.of(1, 0, 0, 0),
      u64(100n),
      u64(200n),
      u64(300n),
    );
    data.set(prefix);
    data[data.length - 1] = 42;
    const value = live.decodeSolanaVaultAccount(data);
    assert.deepEqual(live.decodeSolanaVaultAccount(Buffer.from(data)), value);
    const padded = Buffer.concat([Buffer.alloc(19, 99), Buffer.from(data)]);
    assert.deepEqual(live.decodeSolanaVaultAccount(padded.subarray(19)), value);
    assert.equal(value.seq, 9007199254740993n);
    assert.equal(value.paused, true);
    assert.equal(value.perTradeWsol, 300n);
    assert.equal(value.dailyWsol, 900n);
    assert.deepEqual(value.debits, [
      { timestamp: 100n, notional: 200n, wsol: 300n },
    ]);
    // Version 1 accounts have no WSOL caps and must never be read as capped.
    const v1 = data.slice();
    v1[8] = 1;
    assert.throws(
      () => live.decodeSolanaVaultAccount(v1),
      live.SolanaVaultValidationError,
    );
    assert.throws(
      () => live.decodeSolanaVaultAccount(data.slice(0, 1657)),
      live.SolanaVaultValidationError,
    );
    const wrongCount = data.slice();
    wrongCount[133] = 97;
    assert.throws(
      () => live.decodeSolanaVaultAccount(wrongCount),
      live.SolanaVaultValidationError,
    );
    const wrongBool = data.slice();
    wrongBool[132] = 2;
    assert.throws(
      () => live.decodeSolanaVaultAccount(wrongBool),
      live.SolanaVaultValidationError,
    );
    assert.throws(
      () => live.decodeSolanaVaultAccount(data.slice(1)),
      live.SolanaVaultValidationError,
    );
  });
  it("decodes exact event provenance and rejects suffixes", () => {
    const data = join(
      disc("event:SwapExecuted"),
      key(programAddress),
      key(owner),
      key(session),
      u64(4n),
      u64(5n),
      key(SOLANA_USDG_MINT),
      key(live.SOLANA_WRAPPED_SOL_MINT),
      u64(100n),
      u64(200n),
      u64(1000n),
    );
    assert.equal(data.length, 208);
    assert.deepEqual(
      live.decodeSolanaSwapEvent(Buffer.from(data)),
      live.decodeSolanaSwapEvent(data),
    );
    const padded = Buffer.concat([Buffer.alloc(7, 255), Buffer.from(data)]);
    assert.deepEqual(
      live.decodeSolanaSwapEvent(padded.subarray(7)),
      live.decodeSolanaSwapEvent(data),
    );
    assert.deepEqual(live.decodeSolanaSwapEvent(data), {
      vault: programAddress,
      owner,
      session,
      sessionEpoch: 4n,
      seq: 5n,
      inputMint: SOLANA_USDG_MINT,
      outputMint: live.SOLANA_WRAPPED_SOL_MINT,
      amountIn: 100n,
      amountOut: 200n,
      timestamp: 1000n,
    });
    assert.throws(
      () => live.decodeSolanaSwapEvent(join(data, Uint8Array.of(0))),
      live.SolanaVaultValidationError,
    );
  });
  it("forwards no provider signer privilege into execute_swap", () => {
    const ix = live.buildExecuteSolanaSwapInstruction({
      programAddress,
      vault: owner,
      sessionSigner: session,
      feePayer,
      inputMint: SOLANA_USDG_MINT,
      outputMint: live.SOLANA_WRAPPED_SOL_MINT,
      vaultInput: owner,
      vaultOutput: owner,
      swapAuthority: owner,
      tempInput: owner,
      ownerRefund: owner,
      inputTokenProgram: TOKEN_2022_PROGRAM,
      outputTokenProgram: live.SOLANA_CLASSIC_TOKEN_PROGRAM,
      expectedSeq: 3n,
      sessionEpoch: 4n,
      amountIn: 5n,
      minOut: 6n,
      deadline: 100n,
      slippageBps: 100,
      routeData: new Uint8Array(32),
      routeAccounts: Array.from({ length: 11 }, () => ({
        address: owner,
        role: 3 as const,
      })),
    });
    assert.deepEqual(
      ix.accounts!.slice(15).map((a) => a.role),
      new Array(11).fill(1),
    );
    assert.deepEqual(
      ix.accounts!.slice(0, 3).map((a) => a.role),
      [1, 2, 3],
    );
    assert.equal(
      new DataView(Uint8Array.from(ix.data!).buffer).getBigUint64(8, true),
      3n,
    );
  });
  it("encodes a left-out owner refund account as Anchor's absent optional account", () => {
    // Audit VAULT-2: the owner's input ATA is needed only to return a donation, so an
    // owner who closed it must not block swaps. Absent is the program ID, read-only.
    const base = {
      programAddress,
      vault: owner,
      sessionSigner: session,
      feePayer,
      inputMint: SOLANA_USDG_MINT,
      outputMint: live.SOLANA_WRAPPED_SOL_MINT,
      vaultInput: owner,
      vaultOutput: owner,
      swapAuthority: owner,
      tempInput: owner,
      inputTokenProgram: TOKEN_2022_PROGRAM,
      outputTokenProgram: live.SOLANA_CLASSIC_TOKEN_PROGRAM,
      expectedSeq: 3n,
      sessionEpoch: 4n,
      amountIn: 5n,
      minOut: 6n,
      deadline: 100n,
      slippageBps: 100,
      routeData: new Uint8Array(32),
      routeAccounts: Array.from({ length: 11 }, () => ({
        address: owner,
        role: 1 as const,
      })),
    };
    const absent = live.buildExecuteSolanaSwapInstruction({
      ...base,
      ownerRefund: null,
    });
    assert.deepEqual(absent.accounts![14], {
      address: programAddress,
      role: 0,
    });
    const present = live.buildExecuteSolanaSwapInstruction({
      ...base,
      ownerRefund: feePayer,
    });
    assert.deepEqual(present.accounts![14], { address: feePayer, role: 1 });
    assert.deepEqual(absent.data, present.data);
    assert.equal(absent.accounts!.length, 26);
    // An explicit program ID would be a writable program account, and a route
    // shorter than the program's 32-byte minimum can never execute.
    for (const bad of [
      { ...base, ownerRefund: programAddress },
      { ...base, ownerRefund: null, routeData: new Uint8Array(31) },
    ])
      assert.throws(
        () => live.buildExecuteSolanaSwapInstruction(bad),
        live.SolanaVaultValidationError,
      );
  });
});

const CONTRACT = pathJoin(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "contracts",
  "solana",
);
const contractFile = (p: string) => readFileSync(pathJoin(CONTRACT, p), "utf8");
/**
 * The program id lib.rs declares (declare_id!), parsed by CI's own build
 * record (scripts/ci/solana-program-record.mjs declaredProgramId). The
 * runtime fixtures below name it, so a reviewed declare_id change (the
 * production id) only needs them rewritten, never this code changed.
 * SOLANA_VAULT_LOCAL_TEST_PROGRAM stays the id the TS-only tests above use and
 * the one the live runtime refuses.
 */
async function declaredVaultProgram(): Promise<string> {
  const script = pathJoin(CONTRACT, "..", "..", "scripts", "ci", "solana-program-record.mjs");
  const { declaredProgramId } = (await import(pathToFileURL(script).href)) as {
    declaredProgramId(libRs: string): string;
  };
  return declaredProgramId(contractFile("programs/merrymen-vault/src/lib.rs"));
}
/** Active `key = value` lines of one TOML table, comments dropped. */
function tomlTable(text: string, table: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) inside = line === `[${table}]`;
    else if (inside && line.includes("=")) {
      const at = line.indexOf("=");
      out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  return out;
}

describe("Solana custody build configuration", () => {
  it("claims no LTO the build cannot apply and keeps overflow checks", () => {
    // Audit GAP4-5: cargo never runs LTO on a cdylib/rlib pair, so `lto = "fat"` beside
    // crate-type ["cdylib", "lib"] was silently ignored. Real LTO needs a cdylib-only build.
    const workspace = contractFile("Cargo.toml");
    const program = contractFile("programs/merrymen-vault/Cargo.toml");
    const crateTypes = tomlTable(program, "lib").get("crate-type");
    assert.equal(crateTypes, '["cdylib", "lib"]');
    for (const text of [workspace, program])
      for (const table of [
        "profile.release",
        "profile.release.package.merrymen-vault",
      ])
        assert.equal(
          tomlTable(text, table).has("lto"),
          false,
          `${table} sets lto`,
        );
    const release = tomlTable(workspace, "profile.release");
    assert.equal(release.get("overflow-checks"), "true");
    assert.equal(release.get("codegen-units"), "1");
  });
});

/**
 * The instruction fixture that contracts/solana/runtime-tests/custody.rs executes against
 * the compiled program (audit core-abi-4). Every instruction below comes from this
 * module's builders; the Rust test only funds the accounts and signs. Identities are
 * local ed25519 keys from seeds of 32 equal bytes, unfunded anywhere else.
 */
const ABI_FIXTURE = pathJoin(
  CONTRACT,
  "runtime-tests",
  "fixtures",
  "ts-instructions.json",
);
const FIXTURE_SEEDS = { owner: 0x11, session: 0x22, feePayer: 0x33 } as const;
const FIXTURE_NOW = 1_800_000_000n;
function seededPublicKey(byte: number): string {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, byte),
  ]);
  const spki = createPublicKey(
    createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
  ).export({ format: "der", type: "spki" });
  return base58Encode(new Uint8Array(spki.subarray(spki.length - 32)));
}
/** The mock Jupiter route bytes custody.rs understands: mode, input, quote, slippage. */
function fixtureRoute(
  mode: number,
  amountIn: bigint,
  quote: bigint,
  bps: number,
) {
  const data = new Uint8Array(32);
  data.set(live.SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR);
  data[8] = mode;
  const view = new DataView(data.buffer);
  view.setBigUint64(13, amountIn, true);
  view.setBigUint64(21, quote, true);
  view.setUint16(29, bps, true);
  return data;
}
async function buildAbiFixture(): Promise<string> {
  const program = await declaredVaultProgram();
  const usdg = SOLANA_USDG_MINT;
  const wsol = live.SOLANA_WRAPPED_SOL_MINT;
  const classic = live.SOLANA_CLASSIC_TOKEN_PROGRAM;
  const owner = seededPublicKey(FIXTURE_SEEDS.owner);
  const session = seededPublicKey(FIXTURE_SEEDS.session);
  const feePayer = seededPublicKey(FIXTURE_SEEDS.feePayer);
  const vault = await live.deriveSolanaVaultAddress(program, owner);
  const vaultUsdg = await live.deriveSolanaAta(vault, usdg, TOKEN_2022_PROGRAM);
  const vaultWsol = await live.deriveSolanaAta(vault, wsol, classic);
  const ownerUsdg = await live.deriveSolanaAta(owner, usdg, TOKEN_2022_PROGRAM);
  const poolUsdg = base58Encode(new Uint8Array(32).fill(0x44));
  const poolWsol = base58Encode(new Uint8Array(32).fill(0x55));
  const [jupiterAuthority] = await getProgramDerivedAddress({
    programAddress: address(live.SOLANA_JUPITER_PROGRAM),
    seeds: [new TextEncoder().encode("authority"), Uint8Array.of(0)],
  });
  const keys: Record<string, string> = {
    owner,
    session,
    feePayer,
    vault,
    vaultUsdg,
    vaultWsol,
    ownerUsdg,
    poolUsdg,
    poolWsol,
    jupiterAuthority,
  };
  const swap = async (
    seq: bigint,
    buy: boolean,
    quote: bigint,
    mode: number,
    ownerRefund: string | null,
  ) => {
    const swapAuthority = await live.deriveSolanaSwapAuthority(
      program,
      vault,
      seq,
    );
    const [inputMint, inputProgram] = buy
      ? [usdg, TOKEN_2022_PROGRAM]
      : [wsol, classic];
    const [outputMint, outputProgram] = buy
      ? [wsol, classic]
      : [usdg, TOKEN_2022_PROGRAM];
    const tempInput = await live.deriveSolanaAta(
      swapAuthority,
      inputMint,
      inputProgram,
    );
    keys[`swap${seq}`] = swapAuthority;
    keys[`temp${seq}`] = tempInput;
    const [vaultInput, vaultOutput] = buy
      ? [vaultUsdg, vaultWsol]
      : [vaultWsol, vaultUsdg];
    const [poolIn, poolOut] = buy ? [poolUsdg, poolWsol] : [poolWsol, poolUsdg];
    return live.buildExecuteSolanaSwapInstruction({
      programAddress: program,
      vault,
      sessionSigner: session,
      feePayer,
      inputMint,
      outputMint,
      vaultInput,
      vaultOutput,
      swapAuthority,
      tempInput,
      ownerRefund,
      inputTokenProgram: inputProgram,
      outputTokenProgram: outputProgram,
      expectedSeq: seq,
      sessionEpoch: 1n,
      amountIn: 100n,
      minOut: (quote * 99n) / 100n,
      deadline: FIXTURE_NOW + 20n,
      slippageBps: 100,
      routeData: fixtureRoute(mode, 100n, quote, 100),
      // Jupiter's own roles; the builder strips every signer flag, including the swap PDA's.
      routeAccounts: [
        { address: classic, role: 0 },
        { address: jupiterAuthority, role: 0 },
        { address: swapAuthority, role: 2 },
        { address: tempInput, role: 1 },
        { address: poolIn, role: 1 },
        { address: poolOut, role: 1 },
        { address: vaultOutput, role: 1 },
        { address: inputMint, role: 0 },
        { address: outputMint, role: 0 },
        { address: live.SOLANA_JUPITER_PROGRAM, role: 0 },
        { address: TOKEN_2022_PROGRAM, role: 0 },
      ],
    });
  };
  const steps: [string, string[], Awaited<ReturnType<typeof swap>>][] = [
    [
      "initialize_vault",
      ["owner"],
      live.buildInitializeSolanaVaultInstruction({
        programAddress: program,
        vault,
        owner,
      }),
    ],
    [
      "create_session",
      ["owner"],
      live.buildCreateSolanaSessionInstruction({
        programAddress: program,
        vault,
        owner,
        session,
        perTrade: 100n,
        daily: 300n,
        perTradeWsol: 100n,
        dailyWsol: 300n,
        maxOps: 10,
        expiresAt: FIXTURE_NOW + 86_400n,
      }),
    ],
    [
      "execute_swap_buy",
      ["feePayer", "session"],
      await swap(0n, true, 200n, 0, null),
    ],
    [
      "execute_swap_sell",
      ["feePayer", "session"],
      await swap(1n, false, 100n, 3, null),
    ],
    [
      "set_breaker_session_pause",
      ["session"],
      live.buildSetSolanaBreakerInstruction({
        programAddress: program,
        vault,
        authority: session,
        paused: true,
      }),
    ],
    [
      "set_breaker_owner_clear",
      ["owner"],
      live.buildSetSolanaBreakerInstruction({
        programAddress: program,
        vault,
        authority: owner,
        paused: false,
      }),
    ],
    // custody.rs donates 7 USDG to temp2 first, so the owner refund account is required.
    [
      "execute_swap_buy_refund",
      ["feePayer", "session"],
      await swap(2n, true, 200n, 0, ownerUsdg),
    ],
    [
      "withdraw",
      ["owner"],
      live.buildWithdrawSolanaVaultInstruction({
        programAddress: program,
        vault,
        owner,
        mint: usdg,
        vaultToken: vaultUsdg,
        ownerToken: ownerUsdg,
        tokenProgram: TOKEN_2022_PROGRAM,
        amount: 50n,
      }),
    ],
    // custody.rs first sends 1000 lamports to the vault.
    [
      "withdraw_sol",
      ["owner"],
      live.buildWithdrawSolanaNativeInstruction({
        programAddress: program,
        vault,
        owner,
        amount: 1000n,
      }),
    ],
    [
      "revoke_all",
      ["owner"],
      live.buildRevokeSolanaSessionsInstruction({
        programAddress: program,
        vault,
        owner,
      }),
    ],
  ];
  const fixture = {
    about:
      "Generated by packages/core/src/solana-live.test.ts from the TypeScript instruction builders " +
      "(MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1 rewrites it). custody.rs executes every step against the " +
      "compiled program. Seeds are local test identities only.",
    program,
    now: Number(FIXTURE_NOW),
    seeds: FIXTURE_SEEDS,
    keys,
    steps: steps.map(([name, signers, ix]) => ({
      name,
      signers,
      programId: ix.programAddress,
      accounts: (ix.accounts ?? []).map((a) => ({
        pubkey: a.address,
        signer: a.role >= 2,
        writable: (a.role & 1) === 1,
      })),
      data: Buffer.from(ix.data ?? new Uint8Array()).toString("hex"),
    })),
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

describe("Solana custody instruction fixture", () => {
  it("is current with the TypeScript builders the compiled program runs", async () => {
    // Audit core-abi-4: custody.rs runs these exact bytes and account metas against
    // the SBF program, so a reordered account or argument fails the runtime suite.
    const expected = await buildAbiFixture();
    if (process.env.MERRYMEN_WRITE_SOLANA_ABI_FIXTURE === "1")
      writeFileSync(ABI_FIXTURE, expected);
    assert.equal(
      readFileSync(ABI_FIXTURE, "utf8"),
      expected,
      "stale: rerun with MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1, then contracts/solana/test.sh",
    );
  });
  it("names the program lib.rs declares, as the recovery transactions do", async () => {
    // custody.rs and tests/recovery.rs run both fixtures against the compiled program and
    // require its declare_id. A reviewed declare_id change (the production id) rewrites
    // both: MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1 here and MERRYMEN_WRITE_SOLANA_RECOVERY_FIXTURE=1
    // in worker/src/solana-recover.test.ts, then contracts/solana/test.sh and build.sh --record.
    const declared = await declaredVaultProgram();
    const abi = JSON.parse(readFileSync(ABI_FIXTURE, "utf8")) as {
      program: string;
      steps: { programId: string }[];
    };
    assert.equal(abi.program, declared);
    for (const step of abi.steps) assert.equal(step.programId, declared);
    const recovery = contractFile(
      "runtime-tests/fixtures/recovery-transactions.txt",
    );
    assert.deepEqual(recovery.match(/^program \S+$/gm), [`program ${declared}`]);
  });
  it("derives the seeded identities like ed25519", () => {
    // RFC 8032 test 1 secret key gives its public key; ours use the same derivation.
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "hex",
      ),
    ]);
    const spki = createPublicKey(
      createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
    ).export({ format: "der", type: "spki" });
    assert.equal(
      Buffer.from(spki.subarray(spki.length - 32)).toString("hex"),
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
    assert.notEqual(seededPublicKey(0x11), seededPublicKey(0x22));
  });
  it("uses the program's Anchor discriminator in every builder", async () => {
    const vault = await live.deriveSolanaVaultAddress(programAddress, owner);
    const cases: [string, ArrayLike<number>][] = [
      [
        "initialize_vault",
        live.buildInitializeSolanaVaultInstruction({
          programAddress,
          vault,
          owner,
        }).data!,
      ],
      [
        "revoke_all",
        live.buildRevokeSolanaSessionsInstruction({
          programAddress,
          vault,
          owner,
        }).data!,
      ],
      [
        "set_breaker",
        live.buildSetSolanaBreakerInstruction({
          programAddress,
          vault,
          authority: owner,
          paused: true,
        }).data!,
      ],
      [
        "withdraw",
        live.buildWithdrawSolanaVaultInstruction({
          programAddress,
          vault,
          owner,
          mint: SOLANA_USDG_MINT,
          vaultToken: vault,
          ownerToken: owner,
          tokenProgram: TOKEN_2022_PROGRAM,
          amount: 1n,
        }).data!,
      ],
    ];
    for (const [name, data] of cases)
      assert.deepEqual(
        Array.from(data).slice(0, 8),
        Array.from(disc(`global:${name}`)),
        name,
      );
    const fixture = JSON.parse(readFileSync(ABI_FIXTURE, "utf8")) as {
      steps: { name: string; data: string }[];
    };
    const execute = fixture.steps.find((s) => s.name === "execute_swap_buy")!;
    assert.equal(
      execute.data.slice(0, 16),
      Buffer.from(disc("global:execute_swap")).toString("hex"),
    );
  });
});

/** The reviewed build inputs, hashed exactly as contracts/solana/build.sh --source-digest. */
function contractSourceDigest(): string {
  const sha = (data: Buffer | string) =>
    createHash("sha256").update(data).digest("hex");
  const walk = (dir: string): string[] =>
    readdirSync(pathJoin(CONTRACT, dir), { withFileTypes: true }).flatMap(
      (e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`)
          : e.isFile() && e.name.endsWith(".rs")
            ? [`${dir}/${e.name}`]
            : [],
    );
  const files = [
    "Cargo.toml",
    "Cargo.lock",
    "build.sh",
    "programs/merrymen-vault/Cargo.toml",
    ...walk("programs/merrymen-vault/src"),
  ].sort();
  return sha(
    files
      .map((f) => `${sha(readFileSync(pathJoin(CONTRACT, f)))}  ${f}\n`)
      .join(""),
  );
}

describe("Solana custody build manifest", () => {
  it("records a pinned, reproduced artifact for the current program source", () => {
    // Audit GAP4-2: tie the reviewed source to a toolchain-pinned artifact hash. A
    // program change without build.sh --record leaves every manifest stale here.
    const dir = pathJoin(CONTRACT, "build-manifests");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length > 0, "no build manifest recorded");
    const script = contractFile("build.sh");
    const pin = (name: string) =>
      script.match(new RegExp(`^${name}="([^"]+)"$`, "m"))?.[1];
    const declared = contractFile("programs/merrymen-vault/src/lib.rs").match(
      /^declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);$/m,
    )?.[1];
    const digest = contractSourceDigest();
    for (const file of files) {
      const m = JSON.parse(readFileSync(pathJoin(dir, file), "utf8"));
      assert.equal(
        m.source.digest,
        digest,
        `${file} is stale: run contracts/solana/build.sh --record`,
      );
      assert.equal(`${m.toolchain.host}.json`, file);
      assert.equal(m.program.declaredId, declared);
      assert.equal(m.toolchain.agave, pin("AGAVE_VERSION"));
      assert.equal(m.toolchain.platformTools, pin("PLATFORM_TOOLS_VERSION"));
      assert.equal(m.toolchain.arch, pin("SBF_ARCH"));
      assert.equal(m.toolchain.rustSourceCommit, pin("RUST_SOURCE_COMMIT"));
      assert.match(m.artifact.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(m.artifact.bytes) && m.artifact.bytes > 0);
    }
  });
  it("hashes the source exactly as build.sh does", (t) => {
    const run = spawnSync(
      "bash",
      [pathJoin(CONTRACT, "build.sh"), "--source-digest"],
      { encoding: "utf8" },
    );
    if (run.error) return t.skip("bash is not available");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), contractSourceDigest());
  });
});

describe("Solana vault USDG mint screen", () => {
  it("names exactly the extensions lib.rs check_mint accepts, and every one the mainnet mint carries", () => {
    const lib = contractFile("programs/merrymen-vault/src/lib.rs");
    const start = lib.indexOf("fn check_mint(");
    const end = lib.indexOf("\nfn ", start + 1);
    assert.ok(start >= 0 && end > start, "check_mint not found in lib.rs");
    const accepted = [
      ...new Set(
        [...lib.slice(start, end).matchAll(/ExtensionType::([A-Za-z]+)/g)].map(
          (m) => m[1]![0]!.toLowerCase() + m[1]!.slice(1),
        ),
      ),
    ].sort();
    assert.deepEqual(accepted, [...live.SOLANA_VAULT_USDG_MINT_EXTENSIONS].sort());
    assert.ok(Object.isFrozen(live.SOLANA_VAULT_USDG_MINT_EXTENSIONS));
    const mainnet = JSON.parse(
      contractFile("runtime-tests/fixtures/usdg-mainnet-mint.json"),
    ) as { address: string; decoded: { extensions: string[] } };
    assert.equal(mainnet.address, SOLANA_USDG_MINT);
    for (const name of mainnet.decoded.extensions)
      assert.ok(
        live.SOLANA_VAULT_USDG_MINT_EXTENSIONS.includes(
          name[0]!.toLowerCase() + name.slice(1),
        ),
        name,
      );
  });
});

describe("Solana vault USDG mint verdict (check_mint's USDG branch)", () => {
  type AgaveAccount = { data: { parsed: { info: Record<string, unknown> } } };
  const fixture = JSON.parse(contractFile("runtime-tests/fixtures/usdg-mainnet-mint.json")) as {
    variants: { name: string; vault: "accepts" | "refuses"; sha256: string }[];
  };
  const agave = JSON.parse(contractFile("runtime-tests/fixtures/usdg-mainnet-mint.jsonparsed.json")) as {
    variants: { name: string; sha256: string; address: string }[];
    ledgerToolOutput: { accounts: { pubkey: string; account: AgaveAccount }[] };
  };
  /** The mint info Agave's decoder printed for a fixture variant. */
  const info = (name: string): Record<string, unknown> => {
    const variant = fixture.variants.find((v) => v.name === name)!;
    const placed = agave.variants.find((v) => v.name === name && v.sha256 === variant.sha256)!;
    return agave.ledgerToolOutput.accounts.find((a) => a.pubkey === placed.address)!.account.data.parsed.info;
  };
  const copy = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(value)) as {
    isInitialized?: unknown; decimals?: unknown; extensions?: { extension: string; state?: Record<string, any> }[] | unknown;
  };
  const ext = (mint: ReturnType<typeof copy>, name: string) =>
    (mint.extensions as { extension: string; state: Record<string, any> }[]).find((e) => e.extension === name)!;

  it("gives the compiled vault's verdict on every variant of the mainnet mint, as Agave decodes it", () => {
    const reasons = new Map<string, string | null>([
      ["as read", null],
      ["a newer transfer fee of 25 bps with no maximum", "transfer-fee"],
      ["a newer transfer fee of 25 bps with the largest maximum", "transfer-fee"],
      ["a transfer hook program (the Memo program)", "transfer-hook"],
      ["DefaultAccountState Initialized appended", "extension:defaultAccountState"],
      ["GroupPointer appended (the issuer as authority, the mint as group)", "extension:groupPointer"],
      ["9 decimals", "decimals"],
    ]);
    assert.deepEqual(fixture.variants.map((v) => v.name).sort(), [...reasons.keys()].sort());
    for (const variant of fixture.variants) {
      // custody.rs runs a buy and an exit through the compiled vault for each verdict.
      const refusal = live.solanaVaultUsdgMintRefusal(info(variant.name));
      assert.equal(refusal === null ? "accepts" : "refuses", variant.vault, variant.name);
      assert.equal(refusal, reasons.get(variant.name), variant.name);
    }
  });
  it("refuses any basis points older or newer, an unknown, repeated or unreadable extension, and fails closed", () => {
    const read = () => copy(info("as read"));
    assert.equal(live.solanaVaultUsdgMintRefusal(read()), null);
    const refused: [string, (mint: ReturnType<typeof copy>) => void, string][] = [
      ["an older fee of 1 bp", (m) => { ext(m, "transferFeeConfig").state.olderTransferFee.transferFeeBasisPoints = 1; }, "transfer-fee"],
      ["a newer fee of 1 bp with no maximum", (m) => { ext(m, "transferFeeConfig").state.newerTransferFee.transferFeeBasisPoints = 1; }, "transfer-fee"],
      ["basis points as text", (m) => { ext(m, "transferFeeConfig").state.newerTransferFee.transferFeeBasisPoints = "0"; }, "unreadable"],
      ["no newer fee", (m) => { delete ext(m, "transferFeeConfig").state.newerTransferFee; }, "unreadable"],
      ["a fee extension without state", (m) => { delete (ext(m, "transferFeeConfig") as { state?: unknown }).state; }, "unreadable"],
      ["a hook program", (m) => { ext(m, "transferHook").state.programId = live.SOLANA_JUPITER_PROGRAM; }, "transfer-hook"],
      ["a hook without its program field", (m) => { delete ext(m, "transferHook").state.programId; }, "transfer-hook"],
      ["a hook extension without state", (m) => { delete (ext(m, "transferHook") as { state?: unknown }).state; }, "unreadable"],
      ["an extension Agave cannot parse", (m) => { (m.extensions as unknown[]).push({ extension: "unparseableExtension" }); }, "extension:unparseableExtension"],
      ["pausable", (m) => { (m.extensions as unknown[]).push({ extension: "pausableConfig", state: {} }); }, "extension:pausableConfig"],
      ["a repeated extension", (m) => { (m.extensions as unknown[]).push(ext(m, "metadataPointer")); }, "unreadable"],
      ["an untagged extension", (m) => { (m.extensions as unknown[]).push({ state: {} }); }, "unreadable"],
      ["extensions that are not a list", (m) => { m.extensions = {}; }, "unreadable"],
      ["an uninitialized mint", (m) => { m.isInitialized = false; }, "not-initialized"],
      ["decimals as text", (m) => { m.decimals = "6"; }, "decimals"],
    ];
    for (const [label, change, reason] of refused) {
      const mint = read();
      change(mint);
      assert.equal(live.solanaVaultUsdgMintRefusal(mint), reason, label);
    }
    // A hook authority, a fee authority and a fee maximum or epoch alone are accepted, as check_mint does.
    const powers = read();
    ext(powers, "transferFeeConfig").state.newerTransferFee = { epoch: 9999, maximumFee: 18446744073709552000, transferFeeBasisPoints: 0 };
    assert.equal(live.solanaVaultUsdgMintRefusal(powers), null);
    // Agave leaves out an empty extension list: a USDG mint with none is accepted.
    const bare = read();
    delete bare.extensions;
    assert.equal(live.solanaVaultUsdgMintRefusal(bare), null);
    for (const value of [undefined, null, [], "mint", 6]) assert.equal(live.solanaVaultUsdgMintRefusal(value), "not-initialized");
  });
  it("checks a field of exactly the extensions check_mint checks one of", () => {
    const lib = contractFile("programs/merrymen-vault/src/lib.rs");
    const body = lib.slice(lib.indexOf("fn check_mint("), lib.indexOf("\nfn ", lib.indexOf("fn check_mint(") + 1));
    // The arms with a require! of their own; every other accepted extension is `=> {}`.
    const checked = [...body.matchAll(/ExtensionType::([A-Za-z]+) => \{\s*\n\s*let /g)].map((m) => m[1]);
    assert.deepEqual(checked, ["TransferFeeConfig", "TransferHook"]);
    assert.match(body, /older_transfer_fee\.transfer_fee_basis_points\) == 0\s*&& u16::from\(fee\.newer_transfer_fee\.transfer_fee_basis_points\) == 0/);
    assert.match(body, /Option::<Pubkey>::from\(hook\.program_id\)\.is_none\(\)/);
    assert.match(body, /require!\(mint\.is_initialized, VaultError::Mint\)/);
    assert.match(body, /mint\.key\(\) == USDG && program\.key\(\) == spl_token_2022::ID && mint\.decimals == 6/);
  });
});

describe("Solana vault release pin", () => {
  it("lists only well-formed releases, one per program, never the local test program", () => {
    assert.ok(Object.isFrozen(live.SOLANA_VAULT_RELEASES));
    const seen = new Set<string>();
    for (const release of live.SOLANA_VAULT_RELEASES) {
      const bytes = base58Decode(release.programId);
      assert.ok(
        bytes && bytes.length === 32 && base58Encode(bytes) === release.programId,
        release.programId,
      );
      assert.notEqual(release.programId, live.SOLANA_VAULT_LOCAL_TEST_PROGRAM);
      assert.match(release.sha256, /^[0-9a-f]{64}$/);
      assert.ok(!seen.has(release.programId), `${release.programId} listed twice`);
      seen.add(release.programId);
    }
  });
  it("accepts only a listed program with its released hash, and checks nothing before a release", () => {
    const listed = base58Encode(new Uint8Array(32).fill(8));
    const other = base58Encode(new Uint8Array(32).fill(9));
    const pin = [{ programId: listed, sha256: "1".repeat(64) }];
    assert.equal(live.solanaVaultReleaseRefusal(listed, "1".repeat(64), pin), null);
    assert.match(
      live.solanaVaultReleaseRefusal(other, "1".repeat(64), pin) ?? "",
      /^The configured Solana vault program is not a released Merrymen vault program\.$/,
    );
    assert.match(
      live.solanaVaultReleaseRefusal(listed, "2".repeat(64), pin) ?? "",
      /^The configured Solana vault binary hash is not the released hash of that program\.$/,
    );
    assert.equal(live.solanaVaultReleaseRefusal(other, "2".repeat(64), []), null);
    // The shipped pin is the default.
    assert.equal(
      live.solanaVaultReleaseRefusal(other, "2".repeat(64)) === null,
      live.SOLANA_VAULT_RELEASES.length === 0,
    );
  });
});

describe("Solana vault withdrawal through a USDG transfer hook", () => {
  const fixture = JSON.parse(contractFile("runtime-tests/fixtures/usdg-mainnet-mint.json")) as {
    dataBase64: string;
    variants: { name: string; ops: { op: string; at?: number; hex: string }[] }[];
  };
  const variant = (name: string) => {
    const data = Buffer.from(fixture.dataBase64, "base64");
    for (const op of fixture.variants.find((v) => v.name === name)!.ops) {
      const bytes = Buffer.from(op.hex, "hex");
      if (op.op === "set") bytes.copy(data, op.at!);
      else return new Uint8Array(Buffer.concat([data, bytes]));
    }
    return new Uint8Array(data);
  };
  it("reads the hook program from the mainnet mint: none as read, the program once the issuer sets one", () => {
    assert.equal(live.solanaMintTransferHookProgram(variant("as read")), null);
    assert.equal(
      live.solanaMintTransferHookProgram(variant("a transfer hook program (the Memo program)")),
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    );
    // A classic mint has no extensions; anything else that is not a mint is refused.
    assert.equal(live.solanaMintTransferHookProgram(new Uint8Array(82)), null);
    assert.throws(() => live.solanaMintTransferHookProgram(new Uint8Array(120)), live.SolanaVaultValidationError);
    const truncated = variant("as read").slice(0, 600);
    assert.throws(() => live.solanaMintTransferHookProgram(truncated), live.SolanaVaultValidationError);
  });

  const hook = base58Encode(new Uint8Array(32).fill(81));
  const fixed = base58Encode(new Uint8Array(32).fill(83));
  const source = base58Encode(new Uint8Array(32).fill(84));
  const destination = base58Encode(new Uint8Array(32).fill(85));
  const authority = base58Encode(new Uint8Array(32).fill(86));
  /** ExtraAccountMetaList TLV for Execute holding `metas` (35 bytes each). */
  const list = (...metas: Uint8Array[]) => {
    const header = new Uint8Array(16);
    header.set(disc("spl-transfer-hook-interface:execute"));
    new DataView(header.buffer).setUint32(8, 4 + 35 * metas.length, true);
    new DataView(header.buffer).setUint32(12, metas.length, true);
    return join(header, ...metas);
  };
  const entry = (kind: number, config: number[] | Uint8Array, signer = 0, writable = 0) => {
    const c = new Uint8Array(32);
    c.set(config);
    return join(Uint8Array.of(kind), c, Uint8Array.of(signer, writable));
  };
  const resolve = (validationData: Uint8Array | null, amount = 7n, data: Record<string, Uint8Array> = {}) =>
    live.resolveSolanaTransferHookAccounts({
      hookProgram: hook, mint: SOLANA_USDG_MINT, source, destination, authority, owner, amount, validationData,
      accountData: async (a) => data[a] ?? null,
    });
  const pda = async (program: string, ...seeds: Uint8Array[]) =>
    (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0];

  it("resolves every kind of extra account the way Token-2022's on-chain helper does, then the validation account and the hook", async () => {
    const validation = await live.deriveSolanaTransferHookValidation(hook, SOLANA_USDG_MINT);
    assert.equal(validation, await pda(hook, new TextEncoder().encode("extra-account-metas"), key(SOLANA_USDG_MINT)));
    // No validation account: only the hook program, as the on-chain helper then needs.
    assert.deepEqual(await resolve(null), [{ address: hook, role: 0 }]);
    const sourceData = new Uint8Array(64).fill(9);
    sourceData.set(key(fixed), 32);
    const resolved = await resolve(
      list(
        entry(0, key(fixed), 0, 1),
        // PDA of the hook: literal "m", the destination's key, the amount from the Execute data.
        entry(1, [1, 1, 109, 3, 2, 2, 8, 8]),
        // PDA of the program at account index 5 (the fixed account): account 0's data bytes 0..4.
        entry(128 + 5, [4, 0, 0, 4]),
        // A key read from account 0's data at byte 32.
        entry(2, [2, 0, 32]),
      ),
      7n,
      { [source]: sourceData },
    );
    assert.deepEqual(resolved, [
      { address: fixed, role: 1 },
      { address: await pda(hook, Uint8Array.of(109), key(destination), u64(7n)), role: 0 },
      { address: await pda(fixed, sourceData.slice(0, 4)), role: 0 },
      { address: fixed, role: 0 },
      { address: validation, role: 0 },
      { address: hook, role: 0 },
    ]);
  });

  it("refuses a list that asks for a signer, cannot be resolved or is malformed", async () => {
    await assert.rejects(resolve(list(entry(0, key(fixed), 1))), /asks for a signer/);
    await assert.rejects(resolve(list(entry(1, [4, 0, 0, 4]))), /missing account data/);
    await assert.rejects(resolve(list(entry(1, [3, 9]))), /unknown account index/);
    await assert.rejects(resolve(list(entry(1, [9]))), /unknown seed/);
    await assert.rejects(resolve(list(entry(7, []))), /unknown account kind/);
    await assert.rejects(resolve(list(entry(0, key(fixed))).slice(0, 40)), /malformed list/);
  });

  it("refuses a list that names the owner's wallet, read-only and non-signer included: the owner signs the withdrawal, and the program refuses any signing remaining account", async () => {
    const names = (error: unknown) => error instanceof live.SolanaVaultValidationError && error.message === live.SOLANA_TRANSFER_HOOK_NAMES_OWNER;
    // A fixed key, read-only and not a signer.
    await assert.rejects(resolve(list(entry(0, key(owner)))), names);
    // A key read from the destination token account's owner field (account index 2, bytes 32..64).
    const destinationData = new Uint8Array(165);
    destinationData.set(key(owner), 32);
    await assert.rejects(resolve(list(entry(0, key(fixed)), entry(2, [2, 2, 32])), 7n, { [destination]: destinationData }), names);
    // The same list naming any other account resolves.
    destinationData.set(key(fixed), 32);
    assert.equal((await resolve(list(entry(0, key(fixed)), entry(2, [2, 2, 32])), 7n, { [destination]: destinationData })).length, 4);
  });

  it("appends the hook accounts to the withdrawal and refuses the owner or a signer among them", () => {
    const base = {
      programAddress, vault: authority, owner, mint: SOLANA_USDG_MINT, vaultToken: source, ownerToken: destination,
      tokenProgram: TOKEN_2022_PROGRAM, amount: 7n,
    };
    const plain = live.buildWithdrawSolanaVaultInstruction(base);
    assert.equal(plain.accounts!.length, 6);
    const hooked = live.buildWithdrawSolanaVaultInstruction({ ...base, hookAccounts: [{ address: fixed, role: 1 }, { address: hook, role: 0 }] });
    assert.deepEqual(hooked.accounts!.slice(6).map((a) => [String(a.address), a.role]), [[fixed, 1], [hook, 0]]);
    assert.deepEqual(hooked.data, plain.data);
    assert.throws(() => live.buildWithdrawSolanaVaultInstruction({ ...base, hookAccounts: [{ address: owner, role: 0 }] }), live.SolanaVaultValidationError);
    assert.throws(() => live.buildWithdrawSolanaVaultInstruction({ ...base, hookAccounts: [{ address: fixed, role: 2 as 1 }] }), live.SolanaVaultValidationError);
  });
});
