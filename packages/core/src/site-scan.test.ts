import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { affiliated, findInSources, ownRepo, siteNames, siteOf, FINDINGS_MAX } from "./site-scan";

const CA = "0x86aF99052DB086a66aF7D764bB04d3abb81b485F";
const MINT = "t9bnCGiZVUYsRKvx4d5dPcoDCSyuBM9C33ZNGNULARP";

describe("what a scanned site points at", () => {
  it("finds a contract in the page's words and keeps where it was seen, strongest first", () => {
    const f = findInSources([
      { where: "script", text: `const TOKEN="${CA.toLowerCase()}";` },
      { where: "text", text: `CA: ${CA} — buy on the curve` },
      { where: "link", text: `https://robinhoodchain.blockscout.com/token/${CA}` },
    ]);
    assert.equal(f.evm.length, 1);
    assert.equal(f.evm[0]!.address, CA, "the strongest source's spelling is kept");
    assert.deepEqual(f.evm[0]!.where, ["link", "text", "script"]);
  });

  it("never reads a slice of a longer hex run as an address", () => {
    const hash = "0x" + "ab".repeat(32);
    const f = findInSources([{ where: "text", text: `tx ${hash} and key ${"0x" + "1".repeat(41)}` }]);
    assert.deepEqual(f.evm, []);
  });

  it("drops the addresses every dapp's libraries carry", () => {
    const f = findInSources([{ where: "script", text: `"0xcA11bde05977b3631167028862bE2a173976CA11","0x000000000022D473030F116dDEE9F6B43aC78BA3","0x0000000000000000000000000000000000000000","0x4200000000000000000000000000000000000006","0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"` }]);
    assert.deepEqual(f.evm, []);
  });

  it("reads a Solana mint from words and links, but in a bundle only as a whole quoted string", () => {
    const words = findInSources([{ where: "text", text: `Official CA ${MINT} copy` }]);
    assert.deepEqual(words.solana.map((s) => s.address), [MINT]);
    const bundle = findInSources([{ where: "script", text: `var a=${MINT};var b="${MINT}xyz";var c='${MINT}';` }]);
    assert.deepEqual(bundle.solana.map((s) => s.where), [["script"]]);
    assert.equal(bundle.solana.length, 1, "only the quoted, whole one");
  });

  it("never reads an English word, a one-case run or a system program as a mint", () => {
    const f = findInSources([{ where: "text", text: "abcdefghijkmnopqrstuvwxyzabcdefghijk ABCDEFGHJKLMNPQRSTUVWXYZABCDEFGH23 TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA So11111111111111111111111111111111111111112 SysvarRecentB1ockHashes11111111111111111111" }]);
    assert.deepEqual(f.solana, []);
  });

  it("ignores base58-looking runs inside an inline image", () => {
    const blob = "data:image/png;base64," + "iVBORw0KGgo/" + "Ab3dEf5hJk7mNp9qRs2tUv4wXy6zAb3dEf5hJk7m" + "+AAAA==";
    assert.deepEqual(findInSources([{ where: "html", text: `<img src="${blob}">` }]).solana, []);
  });

  it("finds GitHub however it is written, and never GitHub's own pages", () => {
    const f = findInSources([{ where: "link", text: [
      "https://github.com/LittleBitLLM/littlebit-qwen.git",
      "github.com/sourcepad-xyz",
      "https://www.github.com/features/copilot",
      "https://github.com/orgs/foo/people",
      "https://api.github.com/repos/evil/thing",
      "https://raw.githubusercontent.com/Acme/acme-sdk/main/README.md",
      "https://acmelabs.github.io/docs",
      "https://notgithub.com/x/y",
    ].join("\n") }]);
    assert.deepEqual(f.github.map((r) => [r.owner, r.repo]), [
      ["LittleBitLLM", "littlebit-qwen"],
      ["sourcepad-xyz", null],
      ["Acme", "acme-sdk"],
      ["acmelabs", null],
    ]);
  });

  it("reads socials and docs from what a visitor sees, never from a bundle's share buttons", () => {
    const shown = findInSources([{ where: "link", text: "https://x.com/alanaidale\nhttps://twitter.com/intent/tweet\nhttps://t.me/merrymen\nhttps://discord.gg/abc\nhttps://acme.gitbook.io/acme" }]);
    assert.deepEqual(shown.x, ["alanaidale"]);
    assert.equal(shown.telegram, true);
    assert.equal(shown.discord, true);
    assert.equal(shown.docs, true);
    const bundled = findInSources([{ where: "script", text: "https://x.com/someone https://t.me/x https://discord.gg/y whitepaper" }]);
    assert.deepEqual([bundled.x, bundled.telegram, bundled.discord, bundled.docs], [[], false, false, false]);
  });

  it("stops at a handful of each finding: a page that names more is a directory", () => {
    const many = Array.from({ length: 40 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "a")).join(" ");
    assert.equal(findInSources([{ where: "text", text: many }]).evm.length, FINDINGS_MAX);
  });

  it("reads malformed input as nothing", () => {
    // @ts-expect-error: what a caller might hand in from JSON
    const f = findInSources([null, { where: "nowhere", text: CA }, { where: "text", text: 12 }]);
    assert.deepEqual([f.evm, f.solana, f.github], [[], [], []]);
  });
});

describe("the project's own repo", () => {
  it("takes the project's names from its host and title", () => {
    assert.deepEqual(siteNames({ url: "https://app.sourcepad.site/launch", title: "SourcePad | coins for GitHub projects" }), ["sourcepad"]);
    assert.deepEqual(siteNames({ url: "https://sourcepad.site/", title: "Source — Discover projects. Back the builders." }), ["sourcepad", "source"], "the brand, never a generic word");
    assert.deepEqual(siteNames({ url: "https://larpcheck.app/", title: "larpcheck: is it real, or is it LARP?" }), ["larpcheck"]);
    assert.deepEqual(siteNames({ url: "https://littlebitllm.com/" }), ["littlebitllm"]);
  });

  it("credits a repo by name, never a library the bundle quotes", () => {
    const names = siteNames({ url: "https://littlebitllm.com/" });
    assert.equal(affiliated({ owner: "LittleBitLLM", repo: "x" }, names), true);
    assert.equal(affiliated({ owner: "facebook", repo: "react" }, names), false);
    assert.equal(affiliated({ owner: "sourcepad-xyz", repo: null }, ["sourcepad"]), true);
  });

  it("prefers a linked repo named like the project, then any linked one, then one named like it elsewhere", () => {
    const names = ["acme"];
    const f = findInSources([
      { where: "script", text: "https://github.com/facebook/react https://github.com/acme/acme-core" },
      { where: "link", text: "https://github.com/SamsungLabs/LittleBit" },
    ]);
    const pick = ownRepo(f, names);
    assert.deepEqual([pick?.repo.owner, pick?.linkedOnly], ["SamsungLabs", true], "a linked repo beats a bundled one, said as linked only");
    const named = ownRepo(findInSources([{ where: "link", text: "https://github.com/SamsungLabs/LittleBit https://github.com/acme/acme-core" }]), names);
    assert.deepEqual([named?.repo.repo, named?.linkedOnly], ["acme-core", false]);
    const bundled = ownRepo(findInSources([{ where: "script", text: "https://github.com/facebook/react https://github.com/acme/acme-core" }]), names);
    assert.deepEqual([bundled?.repo.repo, bundled?.linkedOnly], ["acme-core", false]);
    assert.equal(ownRepo(findInSources([{ where: "script", text: "https://github.com/facebook/react" }]), names), null, "a library alone is no repo of theirs");
  });
});

describe("the site a host belongs to (review of #333)", () => {
  it("never lumps two tenants of a shared host or a country second level into one site", () => {
    assert.equal(siteOf("api.acme.com"), "acme.com");
    assert.equal(siteOf("acme.com"), "acme.com");
    assert.equal(siteOf("project.example.co.uk"), "example.co.uk");
    assert.notEqual(siteOf("project.example.co.uk"), siteOf("analytics.other.co.uk"));
    assert.equal(siteOf("foo.vercel.app"), "foo.vercel.app");
    assert.notEqual(siteOf("foo.vercel.app"), siteOf("bar.vercel.app"));
    assert.equal(siteOf("api.foo.vercel.app"), "foo.vercel.app");
    assert.equal(siteOf("x.up.railway.app"), "x.up.railway.app");
    assert.notEqual(siteOf("a.up.railway.app"), siteOf("b.up.railway.app"));
    assert.equal(siteOf("WWW.Acme.COM."), "acme.com");
    assert.equal(siteOf("1.2.3.4"), "1.2.3.4");
  });
});
