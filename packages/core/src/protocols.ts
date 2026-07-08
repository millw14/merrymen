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
  routerSnapshot: "0xC94135b63772b91d79d0A2dAab2A8801F32359bd",
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
