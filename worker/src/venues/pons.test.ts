import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LOOKBACK_BLOCKS, PONS_LAUNCH_TOPIC, PONS_V2_FACTORY, parseLaunchLogs, readLaunchCreator } from "./pons";

/**
 * Reading the launchpad merrymen could not see.
 *
 * Every constant here came off mainnet 4663, not documentation — Pons publishes
 * none — so these tests pin the shape that was actually observed. If Pons
 * changes its event, this is what should fail loudly, rather than discovery
 * quietly reporting nothing forever.
 *
 * The field ORDER is the part that earned its own test. This module first
 * shipped against a different event whose addresses probed plausibly as
 * (token, creator, curve); it was the wrong event, ~12x rarer and ~20s late.
 * Here `curve` is topic2 — verified because that address answers both token()
 * (pointing back at topic1) and getReserves().
 */

const TOPIC = PONS_LAUNCH_TOPIC;
const pad = (a: string) => `0x${"0".repeat(24)}${a.replace(/^0x/, "")}`;
// A real launch, verbatim: PIZZA, quoted in cbBTC.
const PIZZA = {
  token: "0x2a95c6daf347bf69bb2364efdb54d751e78ce492",
  curve: "0xb5ec401f61868ef6ec117009920fa383cfa106af",
  creator: "0x7cde86864e22e8461423d3c0ef8dee9dbe28644d",
  quote: "0xcec185eb182c47d1ba1efc84e6959e18cd620be4", // cbBTC, 8dp
  // graduationThreshold() read off this very curve: 0.13184752 cbBTC.
  threshold: 13_184_752n,
};
// 32-byte word, right-aligned, as an event data word is encoded.
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const log = (over: Partial<{ topics: string[]; data: string; blockNumber: bigint | null; transactionHash: string | null }> = {}) => ({
  topics: [TOPIC, pad(PIZZA.token), pad(PIZZA.curve), pad(PIZZA.creator)],
  data: `${pad(PIZZA.quote)}${"0".repeat(64)}${word(PIZZA.threshold)}`,
  blockNumber: 48687000n,
  transactionHash: "0xdeadbeef",
  ...over,
});

describe("pons launch parsing", () => {
  it("reads token, CURVE and creator in the observed order", () => {
    const [l] = parseLaunchLogs([log()]);
    assert.ok(l);
    assert.equal(l!.token, PIZZA.token);
    // topic2, not topic3 — it answers token() and getReserves() on-chain.
    assert.equal(l!.curve, PIZZA.curve);
    assert.equal(l!.creator, PIZZA.creator);
  });

  it("reads the quote token out of the first data word", () => {
    // Quote assets vary per launch — ETH, USDG and cbBTC all observed — and it
    // decides whether the agent can reach the token at all.
    assert.equal(parseLaunchLogs([log()])[0]!.quoteToken, PIZZA.quote);
  });

  it("treats a ZERO quote token as native ETH, not as malformed", () => {
    // Native ETH is the quote for 53.6% of launches, so this is the common
    // case, not an edge one. The threshold word must still be real.
    const nativeData = `0x${"0".repeat(64)}${"0".repeat(64)}${word(4_200_000_000_000_000_000n)}`;
    const [l] = parseLaunchLogs([log({ data: nativeData })]);
    assert.ok(l, "a zero quote is the legitimate native-ETH case");
    assert.equal(l!.quoteToken, `0x${"0".repeat(40)}`);
    assert.equal(l!.graduationThresholdRaw, 4_200_000_000_000_000_000n);
  });

  it("reads the GRADUATION THRESHOLD out of the third data word", () => {
    // The field the first version of this module discarded. Without it a
    // curve's reported reserve cannot be turned into real money at all, since
    // Pons seeds every curve with 40% of this number.
    assert.equal(parseLaunchLogs([log()])[0]!.graduationThresholdRaw, 13_184_752n);
  });

  it("REFUSES a log with only one data word, rather than defaulting the threshold", () => {
    // Every real log carries three. A zero threshold would make every depth and
    // progress ratio downstream a division by zero — the unknown-as-zero bug
    // one field over from where the module already warns about it.
    const oneWord = log({ data: `${pad(PIZZA.quote)}` });
    assert.deepEqual(parseLaunchLogs([oneWord]), []);
    const zeroThreshold = log({ data: `${pad(PIZZA.quote)}${"0".repeat(64)}${"0".repeat(64)}` });
    assert.deepEqual(parseLaunchLogs([zeroThreshold]), [], "a curve graduating at nothing is not one we understand");
  });

  it("pins the lookback under the node's 10,000-log response cap", () => {
    // Not a block-range limit — the RPC accepts 864,000-block ranges. It caps
    // the RESPONSE at 10,000 logs, which at 474.8 launches/hour arrives at
    // ~21 hours. This leaves room for the rate to roughly double.
    assert.ok(MAX_LOOKBACK_BLOCKS <= 400_000n, "8.4h at 0.101s/block, well inside the cap");
    assert.ok(MAX_LOOKBACK_BLOCKS >= 100_000n, "but long enough to survive a short outage");
  });

  it("ignores the OTHER event on the same factory", () => {
    // 0x308c390e… is the one this module first shipped against: same contract,
    // three plausible-looking addresses, ~12x rarer, ~20s later.
    const other = log({ topics: ["0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980", pad(PIZZA.token), pad(PIZZA.curve), pad(PIZZA.creator)] });
    assert.deepEqual(parseLaunchLogs([other]), []);
  });

  it("SKIPS a malformed launch rather than defaulting an address", () => {
    assert.deepEqual(parseLaunchLogs([log({ topics: [TOPIC, pad(PIZZA.token)] })]), []);
    assert.deepEqual(parseLaunchLogs([log({ blockNumber: null })]), []);
    assert.deepEqual(parseLaunchLogs([log({ transactionHash: null })]), []);
    assert.deepEqual(parseLaunchLogs([log({ data: "0x" })]), [], "no data word = a shape we do not know");
  });

  it("lowercases addresses so they compare against the seen-set", () => {
    const [l] = parseLaunchLogs([log({ topics: [TOPIC, pad(PIZZA.token.toUpperCase().replace("0X", "")), pad(PIZZA.curve), pad(PIZZA.creator)] })]);
    assert.equal(l!.token, l!.token.toLowerCase());
  });

  it("pins the factory and topic verified on-chain", () => {
    assert.equal(PONS_V2_FACTORY, "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
    assert.match(PONS_LAUNCH_TOPIC, /^0x[0-9a-f]{64}$/);
  });
});

describe("readLaunchCreator — the factory's record of who launched a token, never the token's own", () => {
  // eth_getLogs as the node answers it: hex block numbers, the emitter in `address`.
  const rpcLog = (over: Partial<{ address: string; topics: string[] }> = {}) => ({
    address: PONS_V2_FACTORY.toLowerCase(),
    topics: [TOPIC, pad(PIZZA.token), pad(PIZZA.curve), pad(PIZZA.creator)],
    data: `${pad(PIZZA.quote)}${"0".repeat(64)}${word(PIZZA.threshold)}`,
    blockNumber: "0x2e6e1d8",
    transactionHash: "0xdeadbeef",
    ...over,
  });
  const node = (answer: (params: Record<string, unknown>) => unknown) => {
    const asked: Record<string, unknown>[] = [];
    return {
      asked,
      client: {
        getBlockNumber: async () => 50_000_000n,
        request: async ({ params }: { params: Record<string, unknown>[] }) => (asked.push(params[0]!), answer(params[0]!)),
      } as never,
    };
  };

  it("names the creator topic of the factory's launch event, asked by the token's own topic", async () => {
    const { client, asked } = node(() => [rpcLog()]);
    assert.deepEqual(await readLaunchCreator(client, PIZZA.token.toUpperCase().replace("0X", "0x")), { state: "known", creator: PIZZA.creator });
    assert.equal(asked[0]!.address, PONS_V2_FACTORY, "only the factory's logs are asked for");
    assert.deepEqual(asked[0]!.topics, [TOPIC, pad(PIZZA.token)]);
    assert.equal(BigInt(asked[0]!.toBlock as string) - BigInt(asked[0]!.fromBlock as string), MAX_LOOKBACK_BLOCKS);
  });

  it("a log from any other emitter is not a launch, whatever it says", async () => {
    const forged = rpcLog({ address: PIZZA.token, topics: [TOPIC, pad(PIZZA.token), pad(PIZZA.curve), pad("0x00000000000000000000000000000000000000d3")] });
    assert.deepEqual(await readLaunchCreator(node(() => [forged]).client, PIZZA.token), { state: "none" });
  });

  it("no launch in the window is 'none', and a record naming two creators is 'none' too", async () => {
    assert.deepEqual(await readLaunchCreator(node(() => []).client, PIZZA.token), { state: "none" });
    const twice = [rpcLog(), rpcLog({ topics: [TOPIC, pad(PIZZA.token), pad(PIZZA.curve), pad("0x00000000000000000000000000000000000000d3")] })];
    assert.deepEqual(await readLaunchCreator(node(() => twice).client, PIZZA.token), { state: "none" });
    assert.deepEqual(await readLaunchCreator(node(() => [rpcLog()]).client, "0x00000000000000000000000000000000000000c1"), { state: "none" }, "a launch of another token is not this one's");
  });

  it("a node that cannot be asked is 'unreadable', which a caller retries and must not cache as 'none'", async () => {
    assert.deepEqual(await readLaunchCreator(node(() => { throw new Error("rpc down"); }).client, PIZZA.token), { state: "unreadable" });
    assert.deepEqual(await readLaunchCreator(node(() => ({ error: "x" })).client, PIZZA.token), { state: "unreadable" });
  });
});
