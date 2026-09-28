/**
 * READ-ONLY probe: is ENERGY_ROUTE_V1 still a route on Robinhood Chain?
 *
 * The energy permission in packages/core/src/wall.ts pins a Uniswap v2 Router02
 * call over three frozen addresses (USDG → VIRTUAL → $MERRYMEN). Unit tests
 * prove the POLICY — offsets, pins, counterexamples — against viem's encoder.
 * They cannot prove the CHAIN still agrees: that the router is the v2 Router02
 * of the factory the registry names, that both pairs exist, that the swap
 * selector is in its bytecode, and that the route quotes. A marker names this
 * route forever, so the day any of these stops being true is the day the route
 * needs to become energy-buy-v2 — and this is how that day is noticed.
 *
 * Touches nothing: no keys, no grant, no writes. eth_call and eth_getCode only.
 *
 *   npx tsx scripts/probe-energy-route.mts
 *
 * Exits non-zero when any check fails.
 */

import { createPublicClient, http, parseAbi, type Address } from "viem";
import {
  AGENT_TOKEN_TAX_ABI,
  CASH,
  ENERGY,
  ENERGY_ROUTE_V1,
  ENERGY_SWAP_SELECTOR,
  MERRYMEN_TOKEN,
  UNISWAP,
  UNISWAP_V2_ROUTER_READ_ABI,
  VIRTUAL_TOKEN,
  robinhoodChain,
} from "../packages/core/src/index";

const client = createPublicClient({ chain: robinhoodChain, transport: http() });

const ROUTER_ABI = parseAbi(["function factory() view returns (address)"]);
const FACTORY_ABI = parseAbi(["function getPair(address, address) view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

let failures = 0;
function check(ok: boolean, what: string, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const route = ENERGY_ROUTE_V1;
const router = route.router as Address;
const [usdg, virtual, merry] = route.path as readonly [Address, Address, Address];

console.log(`energy route v1 on chain ${route.chainId}: ${usdg} → ${virtual} → ${merry} via ${router}\n`);

// The literals still equal the registry. A drift here is not a chain fact but a
// code fact, and it is the one that matters most: see GRANT_ENERGY.
check(route.chainId === robinhoodChain.id, "the route is for this chain");
check(router === UNISWAP.v2Router02.toLowerCase(), "router literal equals UNISWAP.v2Router02");
check(usdg === CASH.USDG.toLowerCase(), "path[0] literal equals CASH.USDG");
check(virtual === VIRTUAL_TOKEN, "path[1] literal equals VIRTUAL_TOKEN");
check(merry === MERRYMEN_TOKEN.address.toLowerCase(), "path[2] literal equals MERRYMEN_TOKEN");

// Code at every address the wall names. A CALL to a codeless address SUCCEEDS
// with empty returndata, so a missing contract is a buy that "lands" and buys
// nothing — the failure this route must never have.
for (const [name, address] of [
  ["router", router],
  ["USDG", usdg],
  ["VIRTUAL", virtual],
  ["$MERRYMEN", merry],
] as const) {
  try {
    const code = (await client.getCode({ address })) ?? "0x";
    check(code !== "0x", `${name} has code`, `${(code.length - 2) / 2} bytes`);
    if (name === "router") {
      // PUSH4 <selector> — the dispatcher's comparison for the one granted function.
      const push4 = `63${ENERGY_SWAP_SELECTOR.slice(2)}`;
      check(code.toLowerCase().includes(push4), `router bytecode dispatches ${ENERGY_SWAP_SELECTOR}`);
    }
  } catch (e) {
    check(false, `${name} code readable`, e instanceof Error ? e.message : String(e));
  }
}

try {
  const factory = (await client.readContract({ address: router, abi: ROUTER_ABI, functionName: "factory" })).toLowerCase();
  check(factory === UNISWAP.v2Factory.toLowerCase(), "router.factory() is UNISWAP.v2Factory", factory);
  for (const [a, b, label] of [
    [usdg, virtual, "USDG/VIRTUAL"],
    [virtual, merry, "VIRTUAL/$MERRYMEN"],
  ] as const) {
    const pair = await client.readContract({ address: factory as Address, abi: FACTORY_ABI, functionName: "getPair", args: [a, b] });
    check(pair.toLowerCase() !== ZERO, `${label} pair exists`, pair);
  }
} catch (e) {
  check(false, "factory and pairs readable", e instanceof Error ? e.message : String(e));
}

// The route QUOTES: getAmountsOut runs pairFor, so a non-zero answer also
// proves the router's init-code hash matches this factory's pairs.
try {
  const oneUsdg = 10n ** 6n;
  const amounts = await client.readContract({
    address: router,
    abi: UNISWAP_V2_ROUTER_READ_ABI,
    functionName: "getAmountsOut",
    args: [oneUsdg, [usdg, virtual, merry]],
  });
  const out = amounts[amounts.length - 1] ?? 0n;
  check(out > 0n, "getAmountsOut(1 USDG) over the route is non-zero", `${out} raw $MERRYMEN before tax`);
} catch (e) {
  check(false, "getAmountsOut over the route", e instanceof Error ? e.message : String(e));
}

// The buy tax, which the token's owner can change. Above ENERGY.maxTaxBps the
// energy buy refuses rather than computing a floor from a hiked tax.
try {
  const bps = await client.readContract({ address: merry, abi: AGENT_TOKEN_TAX_ABI, functionName: "totalBuyTaxBasisPoints" });
  check(bps <= BigInt(ENERGY.maxTaxBps), `$MERRYMEN buy tax is within ENERGY.maxTaxBps (${ENERGY.maxTaxBps})`, `${bps} bps`);
} catch (e) {
  check(false, "$MERRYMEN buy tax readable", e instanceof Error ? e.message : String(e));
}

console.log(failures === 0 ? "\nthe route stands." : `\n${failures} check(s) failed — do not seal energy-buy-v1 until this is understood.`);
process.exit(failures === 0 ? 0 : 1);
