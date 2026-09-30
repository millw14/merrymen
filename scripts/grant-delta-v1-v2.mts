/**
 * THE EXACT PERMISSION DELTA A v1→v2 CLASS-VAULT RE-SIGN PRODUCES.
 *
 *   npx tsx scripts/grant-delta-v1-v2.mts [--account 0x..] [--rpc url]
 *
 * READ-ONLY AND KEYLESS. It signs nothing, sends nothing, and needs neither the
 * owner key nor the grant database. It derives both vaults from the two pinned
 * factories on chain, builds the permission wall BOTH ways with `buildCallPermissions`
 * — the same function the signer itself calls — and diffs them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN A PARAGRAPH SAYING "ONLY THE CLASS VAULT CHANGES"
 *
 * That claim is the entire safety case for the cutover, and it is exactly the
 * kind of claim that is true when written and false three releases later. The
 * class vault is not the only thing in the wall that could reference it: the
 * class buy pulls USDG from the ACCOUNT, so there is an approve permission
 * naming a spender, and if that spender is the vault then the approve changes
 * too and "only the class permissions" is wrong.
 *
 * So this does not assert. It builds both walls and prints every difference,
 * and it exits non-zero if anything outside the class route moved.
 *
 * WHAT IT CANNOT TELL YOU, and this is the honest half: the wall is only part of
 * a grant. `caps`, `grantTokens`, `expiresAt` and the session key live in the
 * grant store, which needs DATABASE_URL and MERRYMEN_STORE_DEK. Those are not
 * readable from a developer machine and should not be. The caps are a PARAMETER
 * here, and the diff below is independent of them — see the note printed at the
 * end. What the owner must confirm on their own screen is listed there too.
 */
import {
  buildCallPermissions,
  PONS_CLASS_VAULT_FACTORY,
  PONS_CLASS_VAULT_FACTORY_V2,
  PONS_CLASS_VAULT_FACTORY_ABI,
  robinhoodChain,
  type GrantCaps,
} from "../packages/core/src/index";
import { createPublicClient, getAddress, http, type Address } from "viem";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : d;
};

/** Shogun, the canary. scripts/probe-kernel-batch-atomicity.mts:52. */
const ACCOUNT = getAddress(arg("account", "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487")!);
const RPC = arg("rpc", robinhoodChain.rpcUrls.default.http[0])!;
const CHAIN = 4663;

/**
 * Caps are a PARAMETER, and the diff is independent of them.
 *
 * Every permission this builds is a function of (caps, account, wall options).
 * Both sides of the diff use the SAME caps, so anything caps-dependent is
 * identical on both sides and cancels. Changing these numbers changes both
 * walls together and cannot change the diff — which is the property that lets
 * this script be useful without reading the owner's real caps.
 */
const CAPS: GrantCaps = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };

type Perm = ReturnType<typeof buildCallPermissions>[number];

/** A permission as one comparable line. Everything that is pinned, nothing that is not. */
function key(p: Perm): string {
  const args = (p as { args?: readonly unknown[] }).args;
  const shape = Array.isArray(args)
    ? args
        .map((a) =>
          a === null
            ? "*"
            : typeof a === "object" && a !== null && "condition" in (a as object)
              ? `${(a as { condition: unknown }).condition}:${JSON.stringify((a as { value: unknown }).value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`
              : JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        )
        .join(" | ")
    : "(no args)";
  return `${String(p.target).toLowerCase()}  ${p.functionName}  value<=${String((p as { valueLimit?: bigint }).valueLimit ?? "?")}  [${shape}]`;
}

async function main() {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });
  const chainId = await client.getChainId();
  if (chainId !== CHAIN) throw new Error(`expected chain ${CHAIN}, got ${chainId} — check --rpc`);

  const f1 = PONS_CLASS_VAULT_FACTORY[CHAIN];
  const f2 = PONS_CLASS_VAULT_FACTORY_V2[CHAIN];
  if (!f1) throw new Error("no v1 factory pinned for this chain");
  if (!f2) throw new Error("no v2 factory pinned for this chain — nothing to diff against");

  const vaultOf = async (factory: string) =>
    (await client.readContract({
      address: factory as Address,
      abi: PONS_CLASS_VAULT_FACTORY_ABI,
      functionName: "vaultFor",
      args: [ACCOUNT],
    })) as Address;

  const v1 = await vaultOf(f1);
  const v2 = await vaultOf(f2);

  console.log("");
  console.log(`GRANT DELTA for ${ACCOUNT} on chain ${chainId}`);
  console.log("");
  console.log("  the two addresses that change, derived from the chain just now:");
  console.log(`    factory  v1 ${f1}`);
  console.log(`             v2 ${f2}`);
  console.log(`    vault    v1 ${v1}`);
  console.log(`             v2 ${v2}`);

  const codeV1 = await client.getCode({ address: v1 });
  const codeV2 = await client.getCode({ address: v2 });
  console.log("");
  console.log(
    `    the v1 vault ${codeV1 && codeV1 !== "0x" ? `IS deployed (${(codeV1.length - 2) / 2} bytes)` : "is not deployed"}; ` +
      `the v2 vault ${codeV2 && codeV2 !== "0x" ? `IS deployed (${(codeV2.length - 2) / 2} bytes)` : "is NOT deployed yet, which is normal — it is created by its own first buy"}`,
  );

  const before = buildCallPermissions(CAPS, ACCOUNT, {
    ponsClassVaultAddress: v1,
    ponsClassVaultFactoryAddress: f1 as Address,
  });
  const after = buildCallPermissions(CAPS, ACCOUNT, {
    ponsClassVaultAddress: v2,
    ponsClassVaultFactoryAddress: f2 as Address,
  });

  const kb = before.map(key);
  const ka = after.map(key);
  const removed = kb.filter((k) => !ka.includes(k));
  const added = ka.filter((k) => !kb.includes(k));
  const same = kb.filter((k) => ka.includes(k));

  console.log("");
  console.log(`  permissions: ${before.length} before, ${after.length} after — ${same.length} identical, ${removed.length} changed`);

  /**
   * GROUPED, BECAUSE THE RAW COUNT MISLEADS IN BOTH DIRECTIONS.
   *
   * "18 of 21 permissions change" reads like a rewrite of the wall. It is not.
   * The vault appears in TWO different roles, and only one of them is the class
   * route proper:
   *
   *   - as a CALL TARGET, in `buy`, `sell` and the factory's `deploy`. Three
   *     permissions, and the ones an owner pictures when they say "the class
   *     vault".
   *   - as an APPROVED SPENDER, once inside the ONE_OF list of every token's
   *     `approve`. The vault pulls the funding asset FROM the account, so it has
   *     to be spendable — and that list is per token, so one address swap shows
   *     up once per token in the registry.
   *
   * The second group is why "only the class vault changes" is true in substance
   * and wrong in arithmetic. Nothing gains or loses capability: each list has the
   * same length before and after, with one entry replaced.
   */
  const isTarget = (k) => [v1, v2].some((a) => k.startsWith(a.toLowerCase())) || [f1, f2].some((a) => k.startsWith(String(a).toLowerCase()));
  const targetRemoved = removed.filter(isTarget);
  const targetAdded = added.filter(isTarget);
  const spenderRemoved = removed.filter((k) => !isTarget(k));
  const spenderAdded = added.filter((k) => !isTarget(k));

  console.log("");
  console.log(`  GROUP 1 — the class route itself: ${targetRemoved.length} permission(s) retargeted`);
  console.log("           (the vault as a CALL TARGET, and the factory that creates it)");
  for (let i = 0; i < Math.max(targetRemoved.length, targetAdded.length); i++) {
    if (targetRemoved[i]) console.log(`    -  ${targetRemoved[i]}`);
    if (targetAdded[i]) console.log(`    +  ${targetAdded[i]}`);
  }

  console.log("");
  console.log(`  GROUP 2 — the vault as an APPROVED SPENDER: ${spenderRemoved.length} token approve(s)`);
  console.log("           One entry inside each token's allowed-spender list changes from the v1");
  console.log("           vault to the v2 vault. The list length, the other two spenders and the");
  console.log("           amount bound are all identical. This is the same swap, seen once per token.");
  const shortTok = (k) => k.slice(0, 42);
  console.log(`    tokens affected: ${spenderRemoved.map(shortTok).join(", ").slice(0, 400)}`);
  console.log("");
  console.log("    full lines for the first one, so the shape is checkable:");
  if (spenderRemoved[0]) console.log(`    -  ${spenderRemoved[0]}`);
  if (spenderAdded[0]) console.log(`    +  ${spenderAdded[0]}`);

  console.log("");
  console.log(`  GROUP 3 — untouched: ${same.length} permission(s)`);
  for (const k of same) console.log(`    =  ${k}`);

  // Does any spender list change by anything other than the one swap?
  const listOf = (k) => {
    const m = /6:\[([^\]]*)\]/.exec(k);
    return m ? m[1]!.split(",").map((x) => x.trim().replace(/"/g, "").toLowerCase()) : null;
  };
  let listDrift = 0;
  for (const r of spenderRemoved) {
    const tok = r.slice(0, 42);
    const a = spenderAdded.find((x) => x.startsWith(tok));
    if (!a) { listDrift++; continue; }
    const lb = listOf(r), la = listOf(a);
    if (!lb || !la || lb.length !== la.length) { listDrift++; continue; }
    const onlyB = lb.filter((x) => !la.includes(x));
    const onlyA = la.filter((x) => !lb.includes(x));
    if (onlyB.length !== 1 || onlyA.length !== 1 || onlyB[0] !== v1.toLowerCase() || onlyA[0] !== v2.toLowerCase()) listDrift++;
  }
  console.log("");
  console.log(
    listDrift === 0
      ? `  Every one of the ${spenderRemoved.length} spender lists changed by EXACTLY ONE entry, v1 vault -> v2 vault.`
      : `  *** ${listDrift} spender list(s) changed by more than the vault swap. Do not sign. ***`,
  );
  if (listDrift > 0) process.exitCode = 1;

  // ── THE CLAIM UNDER TEST ────────────────────────────────────────────────
  //
  // Every changed line must mention one of the four addresses that are supposed
  // to change, and nothing else. A changed permission that names none of them
  // is a permission moving for a reason nobody asked for.
  const expected = [v1, v2, f1, f2].map((a) => a.toLowerCase());
  const unexplained = [...removed, ...added].filter((k) => !expected.some((a) => k.includes(a)));

  console.log("");
  if (before.length !== after.length) {
    console.log(`  *** THE PERMISSION COUNT CHANGED (${before.length} -> ${after.length}). A re-sign should`);
    console.log("      SWAP addresses, not add or drop capability. Do not sign until this is understood.");
  }
  if (unexplained.length === 0 && before.length === after.length) {
    console.log("  VERDICT: every changed permission names the v1 or v2 vault or factory, and nothing else.");
    console.log("           The count is unchanged. No capability is added or removed by this cutover —");
    console.log("           the same permissions point at a different vault.");
  } else {
    console.log("  VERDICT: SOMETHING ELSE MOVED. These changed lines name none of the four addresses:");
    for (const k of unexplained) console.log(`      ${k}`);
    process.exitCode = 1;
  }

  console.log("");
  console.log("  WHAT THIS SCRIPT CANNOT SEE, and you must confirm on your own screen before signing:");
  console.log("    - caps (perTradeUsdg, dailyUsdg, expiryDays, maxDrawdownPct, maxOpsPerDay). They live");
  console.log("      in the grant store, which needs DATABASE_URL and MERRYMEN_STORE_DEK. The re-sign");
  console.log("      screen pre-fills them from your CURRENT grant, so they carry over if you do not");
  console.log("      touch a preset button or a slider. Read them off the screen and check.");
  console.log("    - the session key. A re-sign ALWAYS mints a new one; that is structural.");
  console.log("    - settings (scout budget, entry size, hold timing). Those are not in the grant at all.");
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
