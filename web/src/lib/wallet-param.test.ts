import assert from "node:assert/strict";
import { it } from "node:test";
import { readWalletParam } from "./wallet-param";

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

it("is not the body's purpose: the old ?purpose= selector names no wallet", () => {
  assert.equal(at("?purpose=perps"), "spot");
});
