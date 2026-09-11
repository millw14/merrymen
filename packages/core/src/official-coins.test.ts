/**
 * OFFICIAL COINS — the listing itself, and the three things it must never become.
 *
 * Most of these are shape tests on a constant, which is exactly what they should
 * be: the whole value of a pinned listing is that it does not depend on a
 * running chain, a discovery window, or a table that gets pruned. What a test
 * CAN prove is that the pinning is internally consistent and that the listing
 * cannot leak into the registry paths that would break it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  OFFICIAL_COINS,
  officialCoinByAddress,
  officialCoinBySymbol,
  officialCoinCurve,
  officialCoinSymbols,
  officialCoinTokens,
  officialCoinsFor,
} from "./official-coins";
import { CASH, STOCK_TOKENS } from "./tokens";
import { builtinGrantTargets, usableExtraTokens } from "./index";
import { ponsAdapterForSigning, PONS_CLASS_VAULT_FACTORY, PONS_SELF_TRADE } from "./protocols";

const MAINNET = 4663;
const TESTNET = 46630;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("official coins — the listing", () => {
  it("returns a list for every known chain, empty or not", () => {
    // NOT "at least one on mainnet", which is what this asserted until the first
    // listing died. An empty list is a legitimate and honest state — the
    // platform is not obliged to be listing anything — so pinning a non-empty
    // registry would make an accurate registry fail its own test, and invite
    // somebody to re-list a dead coin to get CI green.
    assert.ok(Array.isArray(officialCoinsFor(MAINNET)));
    assert.deepEqual(officialCoinsFor(TESTNET), [], "the testnet launchpad is not populated");
  });

  it("returns an empty list for an unknown chain rather than throwing", () => {
    assert.deepEqual(officialCoinsFor(1), []);
    assert.deepEqual(officialCoinSymbols(999_999), []);
  });

  it("pins every field a curve needs to be priced, with no zero or placeholder", () => {
    for (const c of officialCoinsFor(MAINNET)) {
      assert.match(c.address, /^0x[0-9a-f]{40}$/, `${c.symbol} address must be lowercase hex`);
      assert.match(c.curve, /^0x[0-9a-f]{40}$/, `${c.symbol} curve must be lowercase hex`);
      assert.notEqual(c.address, c.curve, `${c.symbol}: the token is not its own curve`);
      assert.ok(c.decimals > 0 && c.decimals <= 18, `${c.symbol} decimals out of range`);
      // A zero threshold makes the virtual seed zero, which makes REAL depth
      // equal the reported reserve — confidently wrong in the direction of
      // "deeper than it is". See pons-price.ts:realQuoteRaw.
      assert.ok(c.graduationThresholdRaw > 0n, `${c.symbol} needs a real graduation threshold`);
      assert.match(c.listedOn, /^\d{4}-\d{2}-\d{2}$/, `${c.symbol} needs a listing date`);
    }
  });

  it("carries only USDG-quoted curves, because the adapter cannot reach the others", () => {
    // PonsSelfTrade is non-payable and the wall keeps valueLimit at 0, so a
    // native-ETH curve — 57.6% of the launchpad — is unreachable. A listing the
    // agent could see and never trade is the failure this file exists to end.
    for (const c of officialCoinsFor(MAINNET)) {
      assert.equal(c.quoteToken.toLowerCase(), (CASH.USDG as string).toLowerCase());
    }
  });

  it("filters a non-USDG listing OUT of every accessor, not just the list", () => {
    // The filter lives in officialCoinsFor so an unreachable listing cannot be
    // watched, priced, basketed or sealed. If it were applied per-call-site,
    // one missed site would resurrect exactly the bug.
    const raw = OFFICIAL_COINS[MAINNET] ?? [];
    const nonUsdg = raw.filter((c) => c.quoteToken.toLowerCase() !== (CASH.USDG as string).toLowerCase());
    for (const c of nonUsdg) {
      assert.equal(officialCoinByAddress(MAINNET, c.address), null);
      assert.equal(officialCoinBySymbol(MAINNET, c.symbol), null);
      assert.equal(officialCoinCurve(MAINNET, c.address), null);
      assert.ok(!officialCoinSymbols(MAINNET).includes(c.symbol));
      assert.ok(!officialCoinTokens(MAINNET).some((t) => t.address === c.address));
    }
  });

  it("looks a coin up by address and by symbol, case-insensitively", () => {
    // Runs over whatever is listed, so it stays true of an empty registry and
    // becomes load-bearing the moment one is added — rather than crashing on
    // `[0]!`, which is how these read before the first listing was retired.
    for (const c of officialCoinsFor(MAINNET)) {
      assert.equal(officialCoinByAddress(MAINNET, c.address.toUpperCase())?.symbol, c.symbol);
      assert.equal(officialCoinBySymbol(MAINNET, c.symbol.toLowerCase())?.address, c.address);
    }
    // These two hold with or without a listing, which is the half worth having
    // while the list is empty: a miss must be null, never a partial answer.
    assert.equal(officialCoinByAddress(MAINNET, "0x" + "9".repeat(40)), null);
    assert.equal(officialCoinBySymbol(MAINNET, "NOSUCHCOIN"), null);
  });

  it("returns the curve record as one object or not at all", () => {
    // The store keeps curve/quote/threshold together because a threshold
    // without a curve cannot be read as money. The accessor must not be looser.
    for (const c of officialCoinsFor(MAINNET)) {
      const rec = officialCoinCurve(MAINNET, c.address);
      assert.ok(rec, "a listed coin must resolve a curve record");
      assert.equal(rec.curve, c.curve);
      assert.equal(rec.quoteToken, c.quoteToken);
      assert.equal(rec.graduationThresholdRaw, c.graduationThresholdRaw);
    }
    assert.equal(officialCoinCurve(MAINNET, "0x" + "9".repeat(40)), null);
  });

  it("has no duplicate symbol or address within a chain", () => {
    const coins = officialCoinsFor(MAINNET);
    assert.equal(new Set(coins.map((c) => c.symbol.toUpperCase())).size, coins.length);
    assert.equal(new Set(coins.map((c) => c.address.toLowerCase())).size, coins.length);
  });
});

describe("official coins — what a listing must never become", () => {
  it("is NOT in STOCK_TOKENS, on either address or symbol", () => {
    // Three separate breakages if it were, and the second is a hole in the wall:
    //   1. snapshot.ts probes tokenPaused() across STOCK_TOKENS. A Pons coin
    //      reverts, so its entry fails every tick and reports "unread" about a
    //      token that has nothing to read.
    //   2. builtinGrantTargets() derives from STOCK_TOKENS AT RUNTIME while the
    //      on-chain wall was sealed at SIGNING time — so the worker would
    //      believe it could sell something no signature covers.
    //   3. the web UI renders registry entries as stocks.
    const addrs = new Set(STOCK_TOKENS.map((t) => t.address.toLowerCase()));
    const syms = new Set(STOCK_TOKENS.map((t) => t.symbol.toUpperCase()));
    for (const c of officialCoinsFor(MAINNET)) {
      assert.ok(!addrs.has(c.address.toLowerCase()), `${c.symbol} must not be a registry address`);
      assert.ok(!syms.has(c.symbol.toUpperCase()), `${c.symbol} must not shadow a registry symbol`);
    }
  });

  it("is NOT already covered by builtinGrantTargets, so sealing it means something", () => {
    // If a listing were in the builtin set, usableExtraTokens would DROP it and
    // grantTokens would silently not carry it — a grant that looks signed for
    // the coin and is not.
    const builtin = builtinGrantTargets();
    for (const c of officialCoinsFor(MAINNET)) {
      assert.ok(!builtin.has(c.address.toLowerCase()), `${c.symbol} must need explicit sealing`);
    }
  });

  it("survives usableExtraTokens, which is what actually reaches the call policy", () => {
    const tokens = officialCoinTokens(MAINNET);
    const usable = usableExtraTokens(tokens);
    assert.equal(usable.length, tokens.length, "no listing may be silently dropped before the wall");
    for (const t of tokens) {
      assert.ok(usable.some((u) => u.address.toLowerCase() === t.address.toLowerCase()));
    }
  });

  it("de-duplicates against an owner who typed the same coin in by hand", () => {
    // Listings go first at the signer, so the VERIFIED address survives and the
    // hand-typed duplicate is dropped rather than producing two permissions.
    //
    // Uses a SYNTHETIC listing so the property is pinned whether or not the
    // platform is currently listing anything. `usableExtraTokens` is pure, so
    // this exercises the real de-duplication rather than a stand-in for it.
    const official = [{ symbol: "OFFICIAL", address: ("0x" + "d".repeat(40)) as `0x${string}`, decimals: 18 }];
    const ownerTyped = { symbol: "MYNAME", address: official[0]!.address, decimals: 6 };
    const usable = usableExtraTokens([...official, ownerTyped]);
    const hits = usable.filter((u) => u.address.toLowerCase() === official[0]!.address.toLowerCase());
    assert.equal(hits.length, 1, "the same address must not be sealed twice");
    assert.equal(hits[0]!.symbol, "OFFICIAL", "the listing's own symbol and decimals must win");
    assert.equal(hits[0]!.decimals, 18);
  });

  it("hands the signer exactly the CustomToken shape, with real decimals", () => {
    for (const t of officialCoinTokens(MAINNET)) {
      assert.deepEqual(Object.keys(t).sort(), ["address", "decimals", "symbol"]);
      assert.equal(typeof t.decimals, "number");
      // 18 is a guess that silently misvalues a 9dp coin — the asset model
      // divides by 10^decimals.
      assert.equal(t.decimals, officialCoinBySymbol(MAINNET, t.symbol)!.decimals);
    }
  });

  it("is frozen, so nothing can add a listing at runtime", () => {
    assert.ok(Object.isFrozen(OFFICIAL_COINS));
  });

  it("states in its own source that a listing is not permission", () => {
    // The one property no unit test can check by executing it: that the next
    // person to touch this file is told a listing cannot widen a signed grant.
    const src = readFileSync(path.join(__dirname, "official-coins.ts"), "utf8");
    assert.match(src, /re-sign/i, "the file must say a re-sign is required");
    assert.match(src, /STOCK_TOKENS/, "the file must say why it is not a registry entry");
  });
});

describe("ponsAdapterForSigning", () => {
  it("prefers the owner's own address over the platform constant", () => {
    const mine = "0x" + "a".repeat(40);
    assert.equal(ponsAdapterForSigning(MAINNET, mine), mine);
  });

  it("lowercases whatever it returns, so a sealed address compares equal", () => {
    const mixed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
    assert.equal(ponsAdapterForSigning(MAINNET, mixed), mixed.toLowerCase());
  });

  it("ignores a malformed settings value rather than sealing nonsense", () => {
    // A typo must not mint a marker plus a permission pinned at nonsense.
    assert.equal(ponsAdapterForSigning(MAINNET, "not-an-address"), undefined);
    assert.equal(ponsAdapterForSigning(MAINNET, "0x1234"), undefined);
  });

  it("returns undefined, never a zero address, when there is no adapter", () => {
    // Every signer treats the field as optional-and-absent; a zero would mint a
    // marker and a permission pointing nowhere.
    assert.equal(ponsAdapterForSigning(1, undefined), undefined);
    assert.equal(ponsAdapterForSigning(1, null), undefined);
    assert.equal(ponsAdapterForSigning(1, ""), undefined);
  });

  it("NEVER falls back to the deployed constant, even where one exists", () => {
    // THE SECURITY PROPERTY, pinned because it is one line to undo by accident
    // and its absence is invisible until a key is stolen.
    //
    // The curve argument to PonsSelfTrade.tradeExactIn is unpinnable — ~475 new
    // curve addresses an hour — and the adapter hands that caller-supplied
    // address a live allowance over the pulled input. The stock-token approve
    // permissions carry no amount condition and the adapter is in `spenders`, so
    // a compromised session key that holds this permission can name a contract
    // it controls and have the tokens taken. Sealing it must therefore be an
    // owner's explicit choice, never a platform default.
    assert.ok(PONS_SELF_TRADE[MAINNET], "this test is only meaningful while an adapter is deployed");
    assert.equal(
      ponsAdapterForSigning(MAINNET, undefined),
      undefined,
      "a deployed adapter must NOT be sealed into a grant the owner did not ask for",
    );
    assert.equal(ponsAdapterForSigning(MAINNET, null), undefined);
  });

  it("keeps the two chains separate", () => {
    // Two deploys, two nonces, two addresses. One flat value cannot serve both,
    // and /grant offers a two-click chain switch.
    assert.ok(MAINNET in PONS_SELF_TRADE && TESTNET in PONS_SELF_TRADE);
  });

  it("matches contracts/deployments.json, which is the deploy's own record", () => {
    // TWO RECORDS OF ONE FACT, so they are pinned to each other.
    //
    // The constant is what every signer seals; deployments.json is what the
    // deploy script wrote. If they drifted, grants would be minted against an
    // address nobody deployed — and the failure appears at the bundler, one
    // re-sign too late, as a UserOp the account contract refuses.
    //
    // A MISSING FILE IS NOT A PASS. `contracts/deployments.json` is gitignored
    // by nothing and absent only when nothing has been deployed, so the file's
    // absence has to mean the constants are null rather than "skip the check".
    //
    // BOTH DEPLOY CONSTANTS, from one table. Written per-contract, the second
    // one gets added the day it is deployed and forgotten every day after —
    // which is precisely the drift this test exists to catch.
    const file = path.join(__dirname, "..", "..", "..", "contracts", "deployments.json");
    let book: Record<string, Record<string, { address?: string }>> = {};
    let present = true;
    try {
      book = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      present = false;
    }
    const PINNED: readonly [string, Readonly<Record<number, string | null>>][] = [
      ["PonsSelfTrade", PONS_SELF_TRADE],
      ["PonsClassVaultFactory", PONS_CLASS_VAULT_FACTORY],
    ];
    for (const [contract, table] of PINNED) {
      for (const chainId of [MAINNET, TESTNET]) {
        const constant = table[chainId];
        const recorded: string | undefined = present
          ? book[String(chainId)]?.[contract]?.address
          : undefined;
        if (!present || recorded === undefined) {
          assert.equal(
            constant,
            null,
            `chain ${chainId}: ${contract} constant names an address that no deployment records`,
          );
          continue;
        }
        assert.equal(
          constant?.toLowerCase(),
          recorded.toLowerCase(),
          `chain ${chainId}: the ${contract} constant and the deploy record disagree`,
        );
      }
    }
  });

  it("names every deployed contract in a constant, so none is recorded and unused", () => {
    // The other direction, and it is not symmetric. The check above catches a
    // constant with no deployment; this catches a DEPLOYMENT WITH NO CONSTANT —
    // an address that exists, cost gas, and that no signer will ever seal. That
    // is how PonsSelfTrade spent a release deployed-by-nobody and unreachable,
    // and the only evidence was the absence of trades.
    const file = path.join(__dirname, "..", "..", "..", "contracts", "deployments.json");
    let book: Record<string, Record<string, { address?: string }>> = {};
    try {
      book = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return; // nothing deployed yet is a legitimate state
    }
    const TABLES: Record<string, Readonly<Record<number, string | null>>> = {
      PonsSelfTrade: PONS_SELF_TRADE,
      PonsClassVaultFactory: PONS_CLASS_VAULT_FACTORY,
    };
    for (const [chainId, contracts] of Object.entries(book)) {
      for (const [contract, rec] of Object.entries(contracts)) {
        const table = TABLES[contract];
        assert.ok(table, `${contract} is deployed on chain ${chainId} but no constant carries it`);
        assert.equal(
          table[Number(chainId)]?.toLowerCase(),
          rec.address?.toLowerCase(),
          `${contract} on chain ${chainId} is deployed but its constant does not name it`,
        );
      }
    }
  });
});
