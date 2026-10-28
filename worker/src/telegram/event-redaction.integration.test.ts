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
const { readLlmState, readRecentEvents, readReport, redactAddresses, redactHexRuns } = await import("./reads");
const { toolByName } = await import("./chat-tools");
const { energyNotice } = await import("../energy-copy");
const ids = await import("../../../packages/core/src/ids");

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
    assert.ok(!got.includes(TX) && got.includes("landed, tx [hash]"), "a 64-digit run can carry an address: the model gets none");
  });

  it("readLlmState — the chat prompt's state pack — carries neither address", async () => {
    const got = await readLlmState(statusCtx as never);
    assert.match(got, /RECENT EVENTS:/);
    assert.ok(!got.toLowerCase().includes(HOLDER.toLowerCase()), "the owner's own wallet never reaches the provider");
    assert.ok(!got.toLowerCase().includes(ACCOUNT.toLowerCase()));
    for (const m of got.match(/0x[0-9a-fA-F]+/g) ?? []) assert.ok(m.length < 22, `left behind: ${m}`);
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
  it("replaces an address, a run cut off by a length cap, and any longer run that can carry one", () => {
    assert.equal(redactAddresses(`to ${ACCOUNT}.`), "to [address].");
    assert.equal(redactAddresses(`cut ${HOLDER.slice(0, 30)}`), "cut [address]");
    assert.equal(redactAddresses("tx 0xa11ce, 12 0x-prefixed"), "tx 0xa11ce, 12 0x-prefixed", "short ids are not addresses");
    // An address with hex glued after it rode to the model whole: 64 digits read as a tx hash, 80 as nothing.
    const riding = `${HOLDER}${"0123456789abcdef01234567"}`;
    assert.equal(riding.length, 66);
    assert.equal(redactAddresses(`send to ${riding} now`), "send to [hash] now");
    assert.equal(redactAddresses(`tx ${TX}`), "tx [hash]", "the owner's report and notices keep it; the model needs no hash");
    assert.equal(redactAddresses(`${ACCOUNT}${ACCOUNT.slice(2)}`), "[address]", "an 80-digit run can hold an address");
    assert.equal(redactAddresses(`${HOLDER}a`), "[address]", "41 digits");
    assert.equal(redactAddresses(`landed tx${HOLDER} ok`), "landed tx[address] ok", "glued to the word before it");
    assert.equal(redactAddresses(`to ${HOLDER.replace("0x", "0X")}`), "to [address]");
    for (const out of [redactAddresses(`${riding}`), redactAddresses(`${HOLDER}${HOLDER.slice(2)}ff`)]) {
      assert.ok(!out.toLowerCase().includes(HOLDER.slice(2, 42).toLowerCase()), out);
    }
  });

  it("replaces a Solana key the same way, and a Solana signature as well (Solana P0)", () => {
    const { SOLANA_USDG_MINT, base58Encode } = ids;
    const sig = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));
    assert.equal(redactAddresses(`send to ${SOLANA_USDG_MINT}.`), "send to [address].");
    assert.equal(redactAddresses(`see https://solscan.io/account/${SOLANA_USDG_MINT}`), "see https://solscan.io/account/[address]");
    assert.equal(redactAddresses(`to ${ACCOUNT} and ${SOLANA_USDG_MINT}`), "to [address] and [address]");
    assert.equal(redactAddresses(`sig ${sig}`), "sig [signature]");
    assert.equal(redactAddresses("Bought PEPE, the curve looked early."), "Bought PEPE, the curve looked early.");
  });

  it("replaces a Solana key glued to the words around it, and a glued run that may hold one (audit regressions F3)", () => {
    const { SOLANA_USDG_MINT, base58Encode } = ids;
    const sig = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));
    assert.equal(redactAddresses(`send to CA${SOLANA_USDG_MINT}.`), "send to [address].");
    assert.equal(redactAddresses(`${SOLANA_USDG_MINT}is the one`), "[address] the one");
    assert.equal(redactAddresses("owner caEEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT, ok"), "owner [address], ok");
    assert.equal(redactAddresses(`${SOLANA_USDG_MINT}${SOLANA_USDG_MINT}a and ${SOLANA_USDG_MINT}`), "[address] and [address]");
    assert.equal(redactAddresses(`landed tx${sig}done`), "landed [address]");
    // A whole signature is named as one, in a link as well.
    assert.equal(redactAddresses(`sig ${sig}`), "sig [signature]");
    assert.equal(redactAddresses(`https://solscan.io/tx/${sig}`), "https://solscan.io/tx/[signature]");
    // Prose, tickers, URLs, hex digests and short hashtags are untouched.
    const plain = "Bought $BONK at https://merrymen.xyz/t/0123456789abcdef #BuyTheDip, digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert.equal(redactAddresses(plain), plain);
  });

  it("strips a mint glued inside a run that ends in a key also standing alone (review GE)", () => {
    const { SOLANA_USDG_MINT: MINT, base58Encode } = ids;
    // Replaced in scan order, the lone key split the second run first, and the mint in it was left.
    const key = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 0xff));
    assert.equal(redactAddresses(`${key} then X${MINT}${key}Y`), "[address] then [address]");
    assert.equal(redactAddresses(`X${MINT}${key}Y and ${key}`), "[address] and [address]");
  });

  it("strips a key glued behind an 0x run, whose leading hex ADDRESS_RUN would take alone (review GE, round 2)", () => {
    // ADDRESS_RUN ran first, took "0x" and 20 hex, and left the key's tail, too short to decode, for the model.
    const key = "A5D1HPCPPVQVXSSQFNHQgUAjPuK9uRJvfvp3S4pX86kN";
    assert.equal(ids.base58Decode(key)?.length, 32, "the fixture is a key");
    const out = redactAddresses(`landed 0x${"ab".repeat(10)}${key} ok`);
    assert.ok(!out.includes("HPCPPVQVXSSQFNHQgUAj"), out);
    assert.equal(out, "landed 0[address] ok");
    assert.equal(redactAddresses(`aped 0x${key} now`), "aped 0[address] now");
    // An address, a cut one and a tx hash come out as before (a hash as "[hash]", since it can carry an address).
    assert.equal(redactAddresses(`to ${ACCOUNT}. tx ${TX}`), `to [address]. tx [hash]`);
    assert.equal(redactAddresses(`cut ${HOLDER.slice(0, 30)}`), "cut [address]");
  });

  it("replaces a signature-length run standing alone, which can be two keys or a key with a word glued on (review GE)", () => {
    const { SOLANA_USDG_MINT: MINT, base58Decode } = ids;
    // Each decodes to 64 bytes, as a signature does, with nothing alphanumeric either side.
    const runs = [`${MINT}${MINT}`, `${MINT}ToTheMoonAndBackAgainAndAgainForeverAndEver`];
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    for (let seed = 0; seed < 200; seed++) {
      const tail = Array.from({ length: 43 }, (_, i) => B58[(seed * 31 + i * 17 + 7) % 58]).join("");
      runs.push(`CA${MINT}${tail}`.slice(0, 87));
    }
    const signatureLength = runs.filter((run) => base58Decode(run)?.length === 64);
    assert.ok(signatureLength.length >= 100, `${signatureLength.length} of the runs decode to 64 bytes`);
    assert.ok(signatureLength.includes(runs[0]!) && signatureLength.includes(runs[1]!));
    for (const run of runs) {
      const out = redactAddresses(`token ${run} landed`);
      assert.ok(!out.includes(MINT.slice(0, 20)), out);
      assert.match(out, /^token \[(signature|address)\] landed$/, out);
    }
  });

  it("is applied wherever event text is handed to a model — the why narration and the daily journal/digest", () => {
    const service = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    assert.match(service, /why: \(\) => whyAnswer\(readWhyEvidence\(/, "/why answers through why-answer.ts");
    const answer = readFileSync(new URL("./why-answer.ts", import.meta.url), "utf8");
    const why = answer.slice(answer.indexOf("export async function whyAnswer("), answer.indexOf("await narrate(plain, llm)"));
    assert.match(why, /const plain = redactAddresses\(/);
    const notifier = readFileSync(new URL("./notifier.ts", import.meta.url), "utf8");
    assert.match(notifier, /redactAddresses\(report\.replace\(\/<\[\^>\]\+>\/g, ""\)\)/, "the digest's narration evidence");
    assert.match(notifier, /hasGrant \? redactAddresses\(plainReport\)/, "the journal's narration evidence");
  });

  it("redacts 0x runs exactly as the old /0[xX]([0-9a-fA-F]{20,})/g did, in linear time, and never throws on a multi-megabyte run (review finalise)", () => {
    const old = (text: string) => text.replace(/0[xX]([0-9a-fA-F]{20,})(?![0-9a-fA-F])/g, (_run, hex: string) => (hex.length === 64 ? "[hash]" : "[address]"));
    const pieces = ["0x", "0X", "00x", "0", "x", "a", "F", "g", " ", "1", "-", "0x".padEnd(21, "a"), `0x${"b".repeat(64)}`, `0x${"c".repeat(19)}`, "zz"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % pieces.length;
    for (let round = 0; round < 3000; round++) {
      const text = Array.from({ length: 1 + (round % 9) }, () => pieces[next()]).join("");
      assert.equal(redactHexRuns(text), old(text), JSON.stringify(text));
    }
    // The regex overflowed V8's stack on this; the pass reads it once.
    const huge = "0x" + "a1".repeat(3_500_000);
    let out = "";
    assert.doesNotThrow(() => { out = redactAddresses(`report ${huge} end`); });
    assert.equal(out, "report [address] end");
  });
});
