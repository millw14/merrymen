/**
 * NO ADDRESS REACHES THE TELEGRAM CHAT MODEL THROUGH EVENT TEXT.
 *
 * When an entry is withheld the worker writes the energy notice as a warn
 * event, and it names the agent's account and the owner's own holder wallet in
 * full. The chat builds its prompt from readLlmState, which appended the last
 * five events whole — so both chat models had both addresses verbatim, and the
 * owner's private wallet went to the LLM provider with every message. The
 * "never type an address" instruction was the only defence.
 *
 * Proven against a REAL sqlite ledger: the notice is the real energyNotice,
 * and every model-facing read of it (readRecentEvents, readLlmState, the
 * recent_activity tool) carries no address, while the owner's /status-side
 * report still can.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-redact-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { closeStoreForTest, initStore, addEvent } = await import("../store");
const { readLlmState, readRecentEvents, readReport, redactAddresses } = await import("./reads");
const { toolByName } = await import("./chat-tools");
const { energyNotice } = await import("../energy-copy");

const AGENT = "0x00000000000000000000000000000000000a9e17";
const ACCOUNT = "0x5aFE00000000000000000000000000000000c0de";
const HOLDER = "0xb1a5ed00000000000000000000000000000beef5";
const TX = `0x${"ab".repeat(32)}`;
const NOW = Math.floor(Date.now() / 1000);

const notice = energyNotice({
  day: "2026-09-28",
  account: ACCOUNT,
  chainId: 4663,
  holder: HOLDER,
  holderTokens: 1_000,
  agentTokens: 0,
  level: "low",
  buy: "ready",
  estimateUsdg: 12.5,
});

const statusCtx = {
  agentId: AGENT,
  name: "test",
  strategy: "trencher",
  venue: "uniswap",
  paused: false,
  workerAliveSec: 0,
  grant: null,
  chainId: 4663,
  telegramMaxActionUsdg: 25,
};

/** A refusal naming a recipient up front, well inside any length cap. */
const REFUSAL = `transfer refused: recipient ${HOLDER} is not on the allowlist`;
/** An address straddling recent_activity's 220-character cap. */
const STRADDLE = `${"x".repeat(190)} ${ACCOUNT}`;

before(async () => {
  initStore();
  await addEvent(AGENT, "ok", `landed, tx ${TX}`);
  await addEvent(AGENT, "err", REFUSAL);
  await addEvent(AGENT, "ok", STRADDLE);
  await addEvent(AGENT, "warn", notice);
});
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the energy notice as written", () => {
  it("names both addresses in full — which is why every model-facing read must redact", () => {
    assert.ok(notice.includes(ACCOUNT) && notice.includes(HOLDER), notice);
  });
});

describe("model-facing reads of it", () => {
  it("readRecentEvents keeps the words and drops the addresses", () => {
    const got = readRecentEvents(AGENT, 5);
    assert.match(got, /Energy spent for/);
    assert.match(got, /to my account \[address\]/);
    assert.match(got, /your own wallet \[address\]/);
    assert.ok(!got.toLowerCase().includes(HOLDER.toLowerCase()) && !got.toLowerCase().includes(ACCOUNT.toLowerCase()));
    assert.ok(got.includes(TX), "a transaction hash is not an address: nothing can be sent to it");
  });

  it("readLlmState — the chat prompt's state pack — carries neither address", async () => {
    const got = await readLlmState(statusCtx as never);
    assert.match(got, /RECENT EVENTS:/);
    assert.ok(!got.toLowerCase().includes(HOLDER.toLowerCase()), "the owner's own wallet never reaches the provider");
    assert.ok(!got.toLowerCase().includes(ACCOUNT.toLowerCase()));
    for (const m of got.match(/0x[0-9a-fA-F]+/g) ?? []) assert.ok(m.length < 22 || m.length === 66, `left behind: ${m}`);
  });

  it("the recent_activity tool answers the model without them too", async () => {
    const out = await toolByName("recent_activity")!.run(
      { since_hours: 24 },
      {
        status: statusCtx,
        cfg: { customTokens: [] },
        paused: false,
        grant: null,
        book: [AGENT],
        client: null,
        now: NOW + 60,
      } as never,
    );
    assert.match(out, /Energy spent for/);
    assert.match(out, /recipient \[address\] is not on the allowlist/);
    assert.ok(!out.toLowerCase().includes(HOLDER.toLowerCase()) && !out.toLowerCase().includes(ACCOUNT.toLowerCase()), out);
    assert.doesNotMatch(out, /0x[0-9a-fA-F]{20,40}(?![0-9a-fA-F])/, "not even the part a length cap leaves");
  });

  it("the owner's own report is not the model's, and may keep them (redaction is for model prompts)", () => {
    // readReport quotes the newest event for the owner; the narrations that
    // hand it to a model redact it first (notifier.ts, service.ts why).
    assert.equal(typeof readReport(statusCtx as never), "string");
  });
});

describe("redactAddresses", () => {
  it("replaces an address, and a run cut off by a length cap, but never a longer hash", () => {
    assert.equal(redactAddresses(`to ${ACCOUNT}.`), "to [address].");
    assert.equal(redactAddresses(`cut ${HOLDER.slice(0, 30)}`), "cut [address]");
    assert.equal(redactAddresses(`tx ${TX}`), `tx ${TX}`);
    assert.equal(redactAddresses("tx 0xa11ce, 12 0x-prefixed"), "tx 0xa11ce, 12 0x-prefixed", "short ids are not addresses");
    assert.equal(redactAddresses(`${ACCOUNT}${ACCOUNT.slice(2)}`), `${ACCOUNT}${ACCOUNT.slice(2)}`, "an 80-digit run is not an address");
  });

  it("is applied wherever event text is handed to a model — the why narration and the daily journal/digest", () => {
    const service = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    const why = service.slice(service.indexOf("why: async () => {"), service.indexOf("narrateWhy(plain, llm)"));
    assert.match(why, /const plain = redactAddresses\(/);
    const notifier = readFileSync(new URL("./notifier.ts", import.meta.url), "utf8");
    assert.match(notifier, /redactAddresses\(report\.replace\(\/<\[\^>\]\+>\/g, ""\)\)/, "the digest's narration evidence");
    assert.match(notifier, /hasGrant \? redactAddresses\(plainReport\)/, "the journal's narration evidence");
  });
});
