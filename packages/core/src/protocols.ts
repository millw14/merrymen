/**
 * Protocol deployments — Robinhood Chain mainnet (4663).
 * Uniswap addresses from Uniswap/contracts deployments/4663.json via the official
 * uniswap-ai skill library. Rialto/Morpho addresses verified live via eth_call /
 * Blockscout / Morpho GraphQL API on 2026-07-09.
 *
 * LIQUIDITY REALITY (2026-07-09): stock-token DEX pools are seed-sized (tens of
 * dollars); Rialto's propAMMs are where stock-token execution actually happens.
 * Route stock-token trades through Rialto; Uniswap is for ETH/USDG legs and LP
 * strategies once pools deepen.
 */

/** Uniswap — v2, v3, v4 + UniversalRouter, all live day one. */
export const UNISWAP = {
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  v3QuoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  v3PositionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  v2Factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
  v2Router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
  interfaceMulticall: "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3",
} as const;

/**
 * Rialto — on-chain spot exchange, best-execution meta-routing over propAMMs + DEX
 * pools. API-first: GET /quote returns a ready-to-send tx targeting the current
 * RialtoRouter (never build calldata by hand). /tokens is public; /quote requires
 * an integrator API key (wallet-signed onboarding). Indicative platform fee 50bps.
 *
 * ALWAYS resolve the router from the registry (routers migrate):
 *   registry.ownerOf(2) = taker-submitted router, ownerOf(3) = gasless router.
 */
export const RIALTO = {
  apiBase: "https://rialto-trade-api.rialto.xyz",
  docs: "https://docs.rialto.xyz",
  routerRegistry: "0x71a120CbBf3Ce7cD910a3c50fF77aFc62735687E",
  /** Snapshot 2026-07-09 — do not hardcode in execution paths; read the registry. */
  routerSnapshot: "0xC94135b63772b91D79d0A2DaAb2a8801f32359bD",
  FEATURE_TAKER_ROUTER: 2,
  FEATURE_GASLESS_ROUTER: 3,
} as const;

/**
 * Morpho on chain 4663. NOTE: the canonical multi-chain Morpho Blue address
 * (0xBBBB...EFFCb) is EMPTY here — use the chain-specific deployment below.
 * The Morpho GraphQL API (blue-api.morpho.org/graphql) fully indexes 4663;
 * blue-sdk needs registerCustomAddresses() with these values.
 *
 * Steakhouse USDG vault is Morpho Vault V2 (ERC-4626 + ERC-2612), verified source,
 * ~$30M TVL, and PERMISSIONLESS: all four gates (receive/sendAssets, receive/
 * sendShares) verified = address(0) on-chain.
 * GOTCHA: Vault V2's ERC-4626 max* functions (maxDeposit etc.) always return 0 —
 * never gate deposit logic on them.
 *
 * Stock-token collateral markets exist (TSLA/USDG @ 77% LLTV, wSPCX/USDG) but are
 * seed-sized — not usable for real size yet.
 */
export const MORPHO = {
  morphoBlue: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
  vaultV2Factory: "0x0FBad98595b0186dA120E41f77C102beb49f803c",
  registry: "0xe785a2eFD384BA7B95BaEd3851BC76aeD67C676f",
  steakhouseUsdgVault: "0xBeEff033F34C046626B8D0A041844C5d1A5409dd",
  ethenaSteakhouseUsdgVault: "0xbEeFF0fb1Dc19344A87b8479dAb60A2e16160737",
  graphqlApi: "https://blue-api.morpho.org/graphql",
} as const;

/**
 * PonsClassVaultFactory, per chain. NOT YET DEPLOYED ANYWHERE.
 *
 * Both entries are `null`, and that is the honest state rather than a
 * placeholder waiting to be forgotten: `contracts/deployments.json` does not
 * exist in this checkout, so nothing here — not this factory, not PonsSelfTrade,
 * not V4SelfSwap — has been deployed from it.
 *
 * WHY A CONSTANT AT ALL, when the grant already seals the factory it was signed
 * against. Because RECOVERY may have no grant. `merrymen recover` accepts a
 * pasted owner key with nothing else, and it can also run against an ARCHIVED
 * grant — so the vault has to be derivable from the owner key alone, and the
 * only missing input is the factory. Without this, an owner who lost their
 * machine could not reach class positions they still own.
 *
 * A DEPLOY CONSTANT FOR RECOVERY, and the distinction matters more here than for
 * the adapters: recovery signs with the sudo validator and is NOT bound by the
 * wall, so a settings-supplied factory would let a settings write redirect where
 * a recovery goes looking — and since the vault address is a CREATE2 function of
 * the factory, that points the sweep at a contract holding nothing while the
 * real position sits elsewhere. Recovery consults ONLY this table, which is what
 * makes that true.
 *
 * "NEVER A SETTING" IS WHAT THIS USED TO SAY, AND IT WAS HALF WRONG. Signing
 * does read a setting: `ponsClassVaultFactory` exists (settings.ts:134-149,
 * whose own docstring calls it "a hint at signing time") and session.ts gives it
 * PRECEDENCE over this constant. So an owner can seal a grant against any
 * factory address they paste, and the two paths can disagree — which is a real
 * asymmetry and not a bug to be fixed by deleting the setting, because a
 * settings write must never be able to steer a recovery.
 *
 * What makes the signing side safe is not that the setting cannot exist. It is
 * that the signer PROVES what answered before it seals anything
 * (`probeClassFactory`), since the two vault versions are selector-identical and
 * nothing downstream can tell them apart. A false claim here is worse than no
 * claim: someone reads it, believes the setting path cannot happen, and stops
 * checking the one place it does.
 *
 * `null` means "no class route on this chain", which is a different fact from
 * "the factory answered zero" and must stay distinguishable from it.
 */
export const PONS_CLASS_VAULT_FACTORY: Readonly<Record<number, string | null>> = Object.freeze({
  /**
   * Robinhood Chain mainnet. Deployed 2026-09-11, 5,248 bytes.
   *
   * Verified independently of the deploy script's own report, and the decisive
   * check was NOT that the code exists but that `vaultFor` predicts exactly what
   * `deploy` produces — measured equal for three separate owner addresses. The
   * wall pins the vault as a literal target BEFORE the contract exists, and a
   * CALL to a codeless address SUCCEEDS with empty returndata: Kernel's batch
   * executor checks `success` without decoding, so a mismatch here would let the
   * USDG approve land, the buy no-op, and the trade report `landed` — a ledger
   * row for a purchase that bought nothing. Also checked: `deploy(address(0))`
   * reverts (ZeroOwner), and the factory is non-payable.
   */
  4663: "0x48a560371230ece659b2ba40fb19e8335866ab3d",
  /** Robinhood Chain testnet — not deployed. */
  46630: null,
});

/**
 * PonsClassVaultFactoryV2 — the factory whose vaults hold ONE CEILING PER QUOTE
 * ASSET. Deployed on mainnet 2026-09-16; testnet is `null` and will stay that
 * way until the deploy script has a per-chain quote table, which it does not.
 *
 * A SECOND CONSTANT, NOT A REPLACEMENT, and the v1 table above must never be
 * emptied. A v1 vault is a deployed contract at a CREATE2 address derived from
 * the v1 factory, and it may be holding a position right now. Recovery is the
 * reason the constant exists at all — `merrymen recover` can run from a pasted
 * owner key with no grant, deriving the vault from the factory — so deleting v1
 * here would not tidy anything up. It would make a real balance unreachable by
 * the one path built to reach it without a grant. Both must be probed.
 *
 * WHY THE VAULT WAS VERSIONED RATHER THAN RETUNED. v1 holds a single spend cap
 * in raw units, 250_000_000, which is 250 USDG at 6 decimals — and it charges
 * every buy against that one number whatever asset funded it. The chain never
 * restricted the quote: the vault accepts any ERC-20 equal to the curve's own
 * `pairToken()`, and the only thing pinning buys to USDG is a wall constraint
 * off chain. So a five-dollar entry in an 18-decimal share hands the vault about
 * 2.8e16 against a ceiling of 2.5e8, and is refused by eight orders of magnitude
 * in the one place no off-chain fix can reach. v2 keys the ceiling to the asset
 * it is denominated in, and the cap doubles as the allowlist: zero means refused.
 *
 * WHAT A V2 ADDRESS DOES NOT UNLOCK. Nothing about multi-quote execution follows
 * from deploying this. The vault would ACCEPT a non-USDG entry and every other
 * layer would still refuse one — the wall pins the buy's quote word, the
 * producer filters candidates to USDG, and the ledger books `quoteIn` as USDG at
 * 6dp. That ordering is deliberate: the contract is the layer that cannot be
 * corrected later, so it moves first and alone.
 *
 * Same rules as v1 in every other respect, including the one worth restating
 * because it is easy to misread: this table is what RECOVERY consults, and only
 * this table, which is what keeps a settings write from redirecting a sweep at a
 * contract holding nothing. SIGNING is different — it prefers the owner's
 * `ponsClassVaultFactory` setting over this constant, so an owner can seal a
 * grant against a factory that is in neither table. The signer's job is
 * therefore to PROVE what answered rather than to trust where the address came
 * from, because v1 and v2 are selector-identical and a v1 address pasted here
 * would seal a wall that looks correct and enforces a global ceiling.
 *
 * And `null` means "no v2 class route on this chain", which stays
 * distinguishable from "the factory answered zero".
 */
export const PONS_CLASS_VAULT_FACTORY_V2: Readonly<Record<number, string | null>> = Object.freeze({
  /**
   * Robinhood Chain mainnet. Deployed 2026-09-16, 10,344 bytes.
   *
   * SEEDED USDG ONLY, at `250_000_000` raw — which is exactly v1's
   * `DEFAULT_SPEND_CAP`, so the cutover changes the vault and nothing else.
   * NVDA and SPY were deliberately left out: the seed is the one refusal that
   * can never be narrowed, and every vault this factory makes is born with this
   * set and no other. Reaching a second quote needs an owner-key `setQuoteCaps`
   * operation, which has no caller off chain yet.
   *
   * Verified from a process that did not deploy it
   * (`scripts/verify-classfactoryv2.mts`), which is the point: the deploy
   * script's own gates are claims by the code under test. Independently
   * established, all five green with no warnings:
   *
   *   - the deployed bytecode is BYTE-IDENTICAL to this tree's compiled
   *     artifact, not merely non-empty
   *   - `FACTORY_VERSION` answers 2
   *   - `seedQuoteSet` decodes back to exactly $250.00 through the same
   *     arithmetic that sealed it, so the ceiling is the money it was meant to be
   *   - `deployments.json` names this exact address and the same raw cap
   *   - for three owners including Shogun, `vaultFor`, a locally recomputed
   *     CREATE2 from the chain's own seed, and a SIMULATED `deploy()` all agree
   *
   * That last one is the check the v1 entry below calls decisive, done three
   * ways instead of one. The wall pins a vault as a literal target before the
   * contract exists, and a CALL to a codeless address SUCCEEDS with empty
   * returndata — so a prediction that disagreed with production would let the
   * approve land, the buy no-op, and the trade report `landed`.
   *
   * Shogun's vault under this factory: 0x77b3a9EEB8c6f40A68dfD6DEb239534023e7845a
   */
  4663: "0xcdaf6bbd4947c00d8396c55f0ad53e6d345f4bf0",
  /**
   * Robinhood Chain testnet — not deployed, and not deployable today.
   *
   * The deploy script's quote table holds mainnet addresses only, so on 46630
   * every token reads as a non-contract and it refuses the chain by name. A
   * testnet factory needs a per-chain address table first.
   */
  46630: null,
});

/**
 * PonsSelfTrade — the adapter that makes a Pons bonding curve constrainable by
 * the permission wall. Per chain, `null` where it is not deployed.
 *
 * WHY A CONSTANT, when `ponsAdapterAddress` is already a setting. Because the
 * setting could never be a platform answer. Its own docstring calls it "A HINT,
 * never the authority", and the delivery path proves the point: the web
 * `GET /api/settings` returns the stored blob with no default merged in, the
 * phone signer has no settings fetch wired at all, and the worker's
 * `MERRYMEN_PONS_ADAPTER_ADDRESS` sits on the far side of the boundary where it
 * can only raise a drift warning. So every owner who never pasted an address
 * signed a grant with no Pons route, and the weekend curve fallback — shipped,
 * tested, and the documented remedy for all 24 equity feeds going stale — could
 * not fire for anybody on the platform.
 *
 * A DEPLOY FACT, which is what makes a constant right rather than merely
 * convenient: this address is decided once per chain by whoever ran the deploy,
 * it is identical for every tenant, and no tenant has information about it that
 * the platform lacks. That is the same argument PONS_CLASS_VAULT_FACTORY makes
 * above, and the two should be read together.
 *
 * PRECEDENCE IS GRANT-FIRST, EVERYWHERE. The worker calls whatever address the
 * signature SEALED (`grantPonsAdapter`), never this. This is consulted only when
 * a grant is being MINTED, as the default a signer offers when the owner has not
 * named one — so a redeploy can never redirect an existing grant's trades, and
 * a settings entry still wins over it for an owner who has a reason to differ.
 *
 * `null` means "no curve route on this chain", which is a different fact from
 * "the adapter answered zero" and must stay distinguishable from it.
 */
export const PONS_SELF_TRADE: Readonly<Record<number, string | null>> = Object.freeze({
  /**
   * Robinhood Chain mainnet. Deployed 2026-09-11, 3,095 bytes.
   *
   * Verified against the chain independently of the deploy script's own report:
   * chain id 4663; selector `0xc0cfd48c` — `tradeExactIn(address,address,
   * address,uint128,uint128,uint256)`, the exact shape PONS_SELFTRADE_ABI pins,
   * uint128 and not uint256 — present in the bytecode; and a value-bearing call
   * reverts, which is the property that lets the wall keep `valueLimit: 0n`.
   */
  4663: "0xe9dbd4b1e53f1c6d887ab8251d74e3745ac08019",
  /** Robinhood Chain testnet — not deployed. */
  46630: null,
});

/**
 * The adapter a NEW signature should carry: the owner's own choice, or nothing.
 *
 * THIS DELIBERATELY DOES NOT FALL BACK TO `PONS_SELF_TRADE`, and the reason is a
 * threat-model change rather than a bug in the adapter.
 *
 * It briefly did fall back, so that the weekend curve fallback could work
 * without every owner pasting an address. What that missed: the curve is a
 * caller-supplied argument that the wall CANNOT pin — ~475 new curve addresses
 * an hour, so there is no set to enumerate — and `PonsSelfTrade.tradeExactIn`
 * gives that address a live ERC-20 allowance over the pulled input
 * (PonsSelfTrade.sol:225) before calling it. Meanwhile the stock-token and
 * owner-extra `approve` permissions carry NO amount condition
 * (wall.ts:485, `args: [{ONE_OF: spenders}, null]`), and the adapter is in
 * `spenders`.
 *
 * So a COMPROMISED SESSION KEY — not a third party, and not an honest agent —
 * can approve the adapter for an unbounded amount of an enumerated asset, call
 * `tradeExactIn` naming a contract it controls as the "curve", and have that
 * contract take the tokens. The output check is satisfied by returning one wei
 * of another enumerated asset, since `minAmountOut` is unpinned. The on-chain
 * ops cap that would have bounded repetition does not exist: RateLimitPolicy is
 * codeless on 4663, so `maxOpsPerDay` is worker-enforced only (wall.ts:871-897).
 *
 * That converts a worker compromise from "can churn the portfolio" — every sale
 * already being permitted, with `transfer` pinned to registered withdrawal
 * addresses — into "can exfiltrate the portfolio". V4SelfSwap does not have this
 * shape: it pins its PoolManager as an immutable, because there is exactly one
 * singleton to trust. A Pons curve has no singleton, which is the whole reason
 * the argument is unpinnable.
 *
 * The adapter stays deployed and remains reachable for an owner who sets
 * `ponsAdapterAddress` themselves — an explicit, informed choice for curve
 * tokens they have vetted. What is withdrawn is the SILENT default, which would
 * have widened every grant signed from now on without the owner choosing it.
 *
 * Returns `undefined` rather than a zero address for "none", because every
 * signer treats the field as optional-and-absent and a zero would mint a marker
 * plus a permission pinned at nowhere.
 */
export function ponsAdapterForSigning(
  chainId: number,
  fromSettings?: string | null,
): `0x${string}` | undefined {
  void chainId;
  if (!fromSettings || !/^0x[0-9a-fA-F]{40}$/.test(fromSettings)) return undefined;
  return fromSettings.toLowerCase() as `0x${string}`;
}
