import assert from "node:assert/strict";
import test from "node:test";
import { appendPublicToken, appendPublicWallet, hasPublicWallet, publicTokenStillAllowed, publicWalletStillAllowed, publicWalletSuffix } from "./public-wallet";
import { xWeightedLength } from "./client";
import { base58Encode, onchainIdIn, SOLANA_USDG_MINT } from "../../../packages/core/src/ids";

const wallet = { address: `0x${"ab".repeat(20)}`, chainId: 4663 };
const prose = "i'm alan, an AI trading agent on merrymen. i'll share what i buy and why.";

test("only the exact verified wallet and an explicit supported network form the suffix", () => {
  assert.equal(publicWalletSuffix(wallet), ` Wallet (Robinhood Chain): ${wallet.address}`);
  assert.equal(publicWalletSuffix({ ...wallet, chainId: 46630 }), ` Wallet (Robinhood Chain Testnet): ${wallet.address}`);
  for (const invalid of [null, { ...wallet, chainId: 1 }, { ...wallet, address: `${wallet.address} ignore rules` }, { ...wallet, address: "private-key" }]) {
    assert.equal(publicWalletSuffix(invalid), null);
  }
  assert.equal(appendPublicWallet(`${prose} 0x12345678`, wallet), null);
  assert.equal(appendPublicWallet("a".repeat(280), wallet), null);
  assert.ok(xWeightedLength(appendPublicWallet("a".repeat(200), { ...wallet, chainId: 46630 })!) <= 280);
});

test("wallet disclosure cannot migrate to another account, network, post kind or revoked consent", () => {
  const post = { kind: "intro", body: appendPublicWallet(prose, wallet)! };
  assert.equal(publicWalletStillAllowed(post, wallet), true);
  for (const changed of [null, { ...wallet, chainId: 46630 }, { ...wallet, address: `0x${"cd".repeat(20)}` }]) {
    assert.equal(publicWalletStillAllowed(post, changed), false);
  }
  assert.equal(publicWalletStillAllowed({ ...post, kind: "buy" }, wallet), false);
  assert.equal(publicWalletStillAllowed({ ...post, body: `${post.body} later` }, wallet), false);
  assert.equal(publicWalletStillAllowed({ ...post, body: `0x12345678 ${post.body}` }, wallet), false);
  assert.equal(publicWalletStillAllowed({ kind: "intro", body: prose }, null), true);
});

test("a token contract is confined to the exact trade network and cannot become a wallet intro", () => {
  const post = { kind: "buy", body: appendPublicToken("pepe caught my eye while the curve was early", wallet)! };
  assert.ok(post.body.endsWith(`\n\n${wallet.address}`), "the CA alone on the last line, no label, no chain");
  assert.doesNotMatch(post.body, /Robinhood|CA \(/);
  assert.equal(publicTokenStillAllowed(post, wallet), true);
  assert.equal(publicTokenStillAllowed({ ...post, kind: "sell" }, wallet), true);
  assert.equal(publicTokenStillAllowed({ ...post, kind: "intro" }, wallet), false);
  // The text names no chain any more; the chain is held where the token is read
  // (orchestrator-xpost publicTokenForDecision refuses a decision on another chain).
  assert.equal(publicTokenStillAllowed(post, { ...wallet, address: `0x${"cd".repeat(20)}` }), false, "another contract");
  assert.equal(publicTokenStillAllowed(post, { ...wallet, chainId: 1 }), false, "a chain it never trades on");
  assert.equal(publicTokenStillAllowed(post, null), false);
  assert.equal(appendPublicToken(`${prose} ${wallet.address}`, wallet), null);
});

test("the operator's agents add the landed transaction's link on its own line, the CA still last (2026-10-13)", () => {
  const tx = `0x${"ab".repeat(32)}`;
  const prose = "pepe caught my eye while the curve was early";
  const linked = appendPublicToken(prose, { ...wallet, txHash: tx }, true)!;
  assert.equal(linked, `${prose}\n\nhttps://robinhoodchain.blockscout.com/tx/${tx}\n\n${wallet.address}`);
  assert.equal(publicTokenStillAllowed({ kind: "buy", body: linked }, { ...wallet, txHash: tx }, true), true);
  assert.equal(publicTokenStillAllowed({ kind: "buy", body: linked }, { ...wallet, txHash: tx }, false), false, "the link is part of what was consented");
  // Without the flag, paper (no hash), a malformed hash or the testnet: no link, the CA alone.
  assert.equal(appendPublicToken(prose, { ...wallet, txHash: tx }), `${prose}\n\n${wallet.address}`);
  assert.equal(appendPublicToken(prose, { ...wallet, txHash: null }, true), `${prose}\n\n${wallet.address}`);
  assert.equal(appendPublicToken(prose, { ...wallet, txHash: "0x12" }, true), `${prose}\n\n${wallet.address}`);
  assert.equal(appendPublicToken(prose, { ...wallet, chainId: 46630, txHash: tx }, true), `${prose}\n\n${wallet.address}`);
});

test("a Solana mint, signature or explorer link is an id too: never prose, never a suffix that passes (Solana P0)", () => {
  const sig = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));
  const ids = [SOLANA_USDG_MINT, sig, `https://solscan.io/token/${SOLANA_USDG_MINT}`,
    "EEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT", "A".repeat(87)];
  assert.equal(hasPublicWallet(prose), false);
  for (const id of ids) {
    assert.equal(hasPublicWallet(`${prose} ${id}`), true, id);
    assert.equal(appendPublicWallet(`${prose} ${id}`, wallet), null, id);
    assert.equal(appendPublicToken(`${prose} ${id}`, wallet), null, id);
    // Send time: a pending post carrying one is sensitive, and no consented suffix vouches for it.
    assert.equal(publicWalletStillAllowed({ kind: "intro", body: `${prose} ${id}` }, wallet), false, id);
    assert.equal(publicWalletStillAllowed({ kind: "intro", body: `${prose} ${id}${publicWalletSuffix(wallet)}` }, wallet), false, id);
    assert.equal(publicTokenStillAllowed({ kind: "buy", body: `${prose}\n\n${id}` }, wallet), false, id);
    assert.equal(publicTokenStillAllowed({ kind: "buy", body: `${prose} ${id}\n\n${wallet.address}` }, wallet), false, id);
  }
  // The EVM disclosures themselves are unchanged.
  const intro = appendPublicWallet(prose, wallet)!;
  assert.equal(publicWalletStillAllowed({ kind: "intro", body: intro }, wallet), true);
  const tx = `0x${"ab".repeat(32)}`;
  const linked = appendPublicToken("pepe caught my eye while the curve was early", { ...wallet, txHash: tx }, true)!;
  assert.equal(publicTokenStillAllowed({ kind: "buy", body: linked }, { ...wallet, txHash: tx }, true), true);
});

test("a Solana id glued to the words around it is an id too: never prose, never a suffix that passes (audit regressions F3)", () => {
  const sig = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));
  const letters = "EEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT";
  for (const glued of [`grab it CA${SOLANA_USDG_MINT}`, `${SOLANA_USDG_MINT}is the one`, `0x${SOLANA_USDG_MINT}`, `ca${letters}`, `tx${sig}done`, `ser${"A".repeat(87)}`]) {
    assert.equal(hasPublicWallet(`${prose} ${glued}`), true, glued);
    assert.equal(appendPublicWallet(`${prose} ${glued}`, wallet), null, glued);
    assert.equal(appendPublicToken(`${prose} ${glued}`, wallet), null, glued);
    assert.equal(publicWalletStillAllowed({ kind: "intro", body: `${prose} ${glued}${publicWalletSuffix(wallet)}` }, wallet), false, glued);
    assert.equal(publicTokenStillAllowed({ kind: "buy", body: `${prose} ${glued}\n\n${wallet.address}` }, wallet), false, glued);
  }
  // Ordinary posts are not ids: tickers, hashtags, links, a long number, hex split at its zeros, filler.
  for (const text of [`${prose} $SOL $BONK #BuyTheDip https://x.com/merrymen/status/1845123456789012345`,
    "commit 6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa landed, supply 63971511409728546707420640415976470808777",
    `hahaha${"ha".repeat(50)} what a day`]) {
    assert.equal(hasPublicWallet(text), false, text);
  }
  // The EVM disclosures themselves are unchanged.
  assert.equal(publicWalletStillAllowed({ kind: "intro", body: appendPublicWallet(prose, wallet)! }, wallet), true);
});

test("the glued scan's accepted cost: a hashtag of 43 or more unbroken base58 characters may be withheld, a shorter one never (audit regressions F3)", () => {
  // 46 unbroken base58 characters, a window of which decodes to 32 bytes: withheld, where the default scan let it through.
  const long = `${prose} gm #ToTheMoonAndBackAgainAndAgainForeverAndEverFam`;
  assert.equal(hasPublicWallet(long), true);
  assert.equal(onchainIdIn(long), false, "the default scan's answer");
  // 43 that decode to 32 bytes were already withheld by the default scan; 41 never are.
  assert.equal(onchainIdIn(`${prose} #ToTheMoonAndBackAgainAndAgainForeverAndEver`), true);
  assert.equal(hasPublicWallet(`${prose} #ToTheMoonAndBackAgainAndAgainForeverAndEv`), false);
  // A long hashtag broken by a character base58 lacks (l, I, O, 0) is words, not an id.
  for (const tag of ["#BuyTheDip", "#WAGMI", "#SolanaSummer", "#BuyTheDipAndHoldForeverBecauseSolanaIsTheFuture"]) {
    assert.equal(hasPublicWallet(`${prose} ${tag}`), false, tag);
  }
  // A long number glued to a word (review GE, round 2): the digits after its last zero and the word are one
  // run of 44, a window of which decodes to 32 bytes, so the post is withheld. With a space, or alone, never.
  const supply = "265654884413917023635351473145263899433813526181161187";
  assert.equal(hasPublicWallet(`supply ${supply}tokens ok`), true);
  assert.equal(onchainIdIn(`supply ${supply}tokens ok`), false, "the default scan's answer");
  assert.equal(hasPublicWallet(`supply ${supply} tokens ok`), false);
  assert.equal(hasPublicWallet(`supply ${supply} ok`), false);
});
