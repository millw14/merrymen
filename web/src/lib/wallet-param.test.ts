import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readWalletParam, walletUrl } from "./wallet-param";

const at = (query: string) => readWalletParam({ url: `https://app.merrymen.dev/api/grants${query}` });

it("no selector is Spot, so every existing client keeps its account", () => {
  assert.equal(at(""), "spot");
  assert.equal(at("?other=perps"), "spot");
});

it("names exactly one wallet, or the request is refused", () => {
  assert.equal(at("?wallet=spot"), "spot");
  assert.equal(at("?wallet=perps"), "perps");
  for (const query of ["?wallet=", "?wallet=Perps", "?wallet=solana", "?wallet=spot&wallet=perps", "?wallet=perps&wallet=perps"]) {
    assert.equal(at(query), null, query);
  }
});

it("refuses a differently cased wallet key instead of silently selecting Spot", () => {
  for (const query of ["?Wallet=perps", "?WALLET=perps", "?wAlLeT=spot", "?%57allet=perps", "?wallet=spot&Wallet=perps", "?Wallet=spot&wallet=perps"]) {
    assert.equal(at(query), null, query);
  }
});

it("is not the body's purpose: the old ?purpose= selector names no wallet", () => {
  assert.equal(at("?purpose=perps"), "spot");
});

describe("walletUrl, the one client builder", () => {
  it("leaves a Spot URL exactly as it was", () => {
    for (const url of ["/api/grants", "/api/settings?x=1", "/api/feed?a=1&b=2#top", "https://app.merrymen.dev/api/orders?id=7"]) {
      assert.equal(walletUrl(url, "spot"), url);
    }
  });

  it("adds wallet=perps, beside a query the URL already carries", () => {
    assert.equal(walletUrl("/api/grants", "perps"), "/api/grants?wallet=perps");
    assert.equal(walletUrl("/api/orders?id=7", "perps"), "/api/orders?id=7&wallet=perps");
    assert.equal(walletUrl("/api/feed?a=1#top", "perps"), "/api/feed?a=1&wallet=perps#top");
    assert.equal(walletUrl("https://app.merrymen.dev/api/grants?x=1", "perps"), "https://app.merrymen.dev/api/grants?x=1&wallet=perps");
  });

  it("never names two wallets: a wallet= already there is replaced, not repeated", () => {
    for (const url of ["/api/grants?wallet=spot", "/api/grants?wallet=spot&wallet=perps", "/api/grants?wallet=junk", "/api/grants?Wallet=spot", "/api/grants?WALLET=spot&wallet=perps"]) {
      const built = walletUrl(url, "perps");
      assert.equal(readWalletParam({ url: new URL(built, "https://app.merrymen.dev").href }), "perps", url);
      assert.deepEqual([...new URL(built, "https://app.merrymen.dev").searchParams].filter(([key]) => key.toLowerCase() === "wallet"), [["wallet", "perps"]], url);
    }
  });

  it("round-trips through readWalletParam for both wallets", () => {
    for (const wallet of ["spot", "perps"] as const) {
      assert.equal(readWalletParam({ url: new URL(walletUrl("/api/settings?x=1", wallet), "https://app.merrymen.dev").href }), wallet);
    }
  });

  it("refuses a wallet it does not know rather than building a Spot URL", () => {
    for (const wallet of ["Perps", "", "solana", undefined]) {
      assert.throws(() => walletUrl("/api/grants", wallet as never), /wallet purpose/, String(wallet));
    }
  });

  it("is not the perps branch's ?purpose=", () => {
    assert.doesNotMatch(walletUrl("/api/grants", "perps"), /purpose=/);
  });
});
