import { expect } from "chai";
import hre from "hardhat";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";

/**
 * WHAT TELLS A v1 VAULT FROM A v2 VAULT, AND WHAT DOES NOT.
 *
 * This suite exists because of one measured fact: `buy`, `sell` and `sweep` have
 * IDENTICAL signatures in both versions, so they have identical four-byte
 * selectors. A permission wall that pins a target and a selector cannot tell the
 * two apart. Neither can a simulation, an explorer, or a reviewer reading a
 * calldata dump.
 *
 * That matters because the versions do not behave the same. v1 charges every buy
 * against ONE global ceiling of 250_000_000 raw units — 250 USDG at six decimals
 * — whatever asset funded the call. v2 charges against a ceiling keyed by that
 * asset. Substitute a v1 address where a v2 was intended and a USDG trade still
 * works, quietly, under a limit nobody chose; a non-USDG trade is refused by
 * eight orders of magnitude.
 *
 * So a version check is not a nicety here. It is the ONLY thing that can catch
 * the substitution, and these tests pin both halves of that claim: that the
 * selectors really do collide, and that `VAULT_VERSION` / `FACTORY_VERSION`
 * really do differ.
 *
 * DERIVED FROM THE COMPILED ARTIFACTS, never from signature strings typed here.
 * A test that restates the signatures it is checking proves only that the author
 * typed them twice.
 */
describe("what distinguishes vault v1 from vault v2", () => {
  const selectorsOf = (abi: readonly unknown[], names: readonly string[]) => {
    const out: Record<string, string> = {};
    for (const name of names) {
      const item = (abi as AbiFunction[]).find((a) => a.type === "function" && a.name === name);
      if (!item) throw new Error(`no ${name} in this ABI`);
      out[name] = toFunctionSelector(item);
    }
    return out;
  };

  const topicOf = (abi: readonly unknown[], name: string) => {
    const item = (abi as AbiEvent[]).find((a) => a.type === "event" && a.name === name);
    if (!item) throw new Error(`no ${name} event in this ABI`);
    return toEventSelector(item);
  };

  it("THE COLLISION: buy, sell and sweep are the same four bytes in both versions", () => {
    // If this test ever fails, the collision is gone and a whole class of
    // substitution stops being possible — which would be good news, but it would
    // also mean every sealed v1 permission names a selector v2 does not answer.
    // Either way it is a fact that must not change unnoticed.
    const v1 = hre.artifacts.readArtifactSync("PonsClassVault").abi;
    const v2 = hre.artifacts.readArtifactSync("PonsClassVaultV2").abi;
    const names = ["buy", "sell", "sweep"] as const;
    const a = selectorsOf(v1, names);
    const b = selectorsOf(v2, names);
    expect(b).to.deep.equal(a);
    // Stated absolutely too, so a reader does not have to run it to know:
    expect(a.buy).to.equal("0x76165adf");
    expect(a.sell).to.equal("0x92cdbac5");
    expect(a.sweep).to.equal("0x01681a62");
  });

  it("so the version constant is the only on-chain discriminator, and it answers", async () => {
    const [w] = await hre.viem.getWalletClients();
    const owner = w!.account.address;
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const v2 = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [1_000_000n]]);
    expect(Number(await v2.read.VAULT_VERSION())).to.equal(2);

    // And v1 has no such function at all — which is the shape the off-chain
    // check must handle: not "answers 1", but "the call reverts". A caller that
    // expects a number and gets a revert must treat that as v1, not as an error.
    const v1Abi = hre.artifacts.readArtifactSync("PonsClassVault").abi as AbiFunction[];
    expect(v1Abi.some((a) => a.type === "function" && a.name === "VAULT_VERSION")).to.equal(false);
  });

  it("the same asymmetry at the factory, which is what a signer actually reads", async () => {
    // A signer never touches the vault before it exists — it reads the FACTORY.
    // So the factory is where a version guard has to live, and the same shape
    // holds there: v2 answers, v1 has no such function.
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const f2 = await hre.viem.deployContract("PonsClassVaultFactoryV2", [[quote.address], [1_000_000n]]);
    expect(Number(await f2.read.FACTORY_VERSION())).to.equal(2);

    const f1Abi = hre.artifacts.readArtifactSync("PonsClassVaultFactory").abi as AbiFunction[];
    expect(f1Abi.some((a) => a.type === "function" && a.name === "FACTORY_VERSION")).to.equal(false);

    // vaultFor is IDENTICAL in both, and that is deliberate rather than
    // accidental: the seed quote set rides on the factory instead of on
    // vaultFor's arguments precisely so this derivation stays one-argument.
    // It is why resolveClassVault and both of its signer callers need no change
    // to reach a v2 vault — and equally why nothing along that path notices
    // which version it reached.
    const f2Abi = hre.artifacts.readArtifactSync("PonsClassVaultFactoryV2").abi;
    expect(selectorsOf(f2Abi, ["vaultFor", "deploy"])).to.deep.equal(
      selectorsOf(f1Abi, ["vaultFor", "deploy"]),
    );
  });

  it("THE EVENTS DO NOT COLLIDE — v2 names the quote asset, so topic0 differs", () => {
    // The mirror image of the first test, and the reason it is dangerous to
    // assume the two facts move together. Anything that decodes class trades by
    // topic0 will silently see ZERO v2 trades: not an error, not a warning, an
    // empty result that reads exactly like an agent that did not trade.
    const v1 = hre.artifacts.readArtifactSync("PonsClassVault").abi;
    const v2 = hre.artifacts.readArtifactSync("PonsClassVaultV2").abi;
    for (const ev of ["ClassBuy", "ClassSell"] as const) {
      expect(topicOf(v2, ev)).to.not.equal(topicOf(v1, ev), `${ev} topics must differ`);
    }
    expect(topicOf(v1, "ClassBuy")).to.equal("0x22d7b1b2469327e9a857412f9937d9be98bec22aafba3bd8d827558841f1ac6e");
    expect(topicOf(v2, "ClassBuy")).to.equal("0xec46169ec5e9e3497692f1d82e858597a66ae1b83bfab95fba58310a805984d8");
    expect(topicOf(v1, "ClassSell")).to.equal("0xc149ab5326030a654df6bb9e89b0e138934c4520a688ea4d9e7ac8bbe2fcd7f2");
    expect(topicOf(v2, "ClassSell")).to.equal("0x018ac9b5a91856d138d6563f17f0b5d34b5283613fbd8773353c2f28ff215847");

    // Swept is unchanged in both, so a sweep reader keeps working across versions.
    expect(topicOf(v2, "Swept")).to.equal(topicOf(v1, "Swept"));
  });

  it("v2's SpendCapExceeded is a different selector from v1's, and both must stay classified", () => {
    // The worker suppresses a spend-cap revert rather than retrying it, because
    // the window is a day and retrying would put up to a thousand reverted
    // UserOperations on chain. v2 names the quote asset in the error, so the
    // signature is wider and the four bytes differ. A classifier that knew only
    // v1's would treat a v2 refusal as unrecognised — and unrecognised is
    // retryable. worker/src/revert.ts carries both; this pins the fact it relies on.
    const sel = (abi: readonly unknown[], name: string) => {
      const item = (abi as AbiFunction[]).find((a) => a.type === "error" && a.name === name);
      if (!item) throw new Error(`no ${name} error in this ABI`);
      return toFunctionSelector({ ...item, type: "function", outputs: [], stateMutability: "nonpayable" });
    };
    const v1 = hre.artifacts.readArtifactSync("PonsClassVault").abi;
    const v2 = hre.artifacts.readArtifactSync("PonsClassVaultV2").abi;
    expect(sel(v1, "SpendCapExceeded")).to.equal("0x605cd727");
    expect(sel(v2, "SpendCapExceeded")).to.equal("0xa6dfc94a");
    expect(sel(v2, "QuoteNotApproved")).to.equal("0xae9665be");
    // Identical in both, and the worker classifies it for both.
    expect(sel(v2, "TokenDoesNotMatchCurve")).to.equal(sel(v1, "TokenDoesNotMatchCurve"));
    expect(sel(v1, "TokenDoesNotMatchCurve")).to.equal("0xe6208274");
  });
});
