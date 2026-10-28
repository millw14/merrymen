import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SolanaExecutionError } from "../../../worker/src/solana-executor";
import { SolanaLiveMarketError } from "../../../worker/src/solana-live-market";
import { SOLANA_PAPER_PRICE_MOVED, SolanaPaperPriceMovedError, SolanaPaperServiceError } from "../../../worker/src/solana-paper-service";
import { SolanaSettlementError } from "../../../worker/src/solana-settlement";
import { LIMITS_NO_LONGER_VALID, SolanaAppRuntimeError } from "../../../worker/src/solana-app-runtime";
import { SolanaMarketError } from "../../../worker/src/solana-market";
import { SolanaRpcError } from "../../../worker/src/solana-rpc";
import { SolanaTradingStoreError } from "../../../worker/src/solana-trading-store";
import { SolanaPaperStoreError } from "../../../worker/src/solana-paper-store";
import { OWNER_OUTCOME_UNKNOWN, solanaRequestBody, solanaResponse } from "./solana-api";
import { SolanaWebError } from "./solana-auth";

const flag = process.env.MERRYMEN_SOLANA;
before(() => { process.env.MERRYMEN_SOLANA = "1"; });
after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });

test("Solana routes reject authority fields and oversized bodies", async () => {
  for (const value of [null, [], { owner: "untrusted", amount: "1" }, { tenant: "other" }]) {
    await assert.rejects(solanaRequestBody(new Request("https://example.test", { method: "POST", body: JSON.stringify(value) }), ["amount"]));
  }
  await assert.rejects(solanaRequestBody(new Request("https://example.test", { method: "POST", body: JSON.stringify({ amount: "x".repeat(20_000) }) }), ["amount"]), (e: unknown) => e instanceof SolanaWebError && e.status === 413);
  assert.deepEqual(await solanaRequestBody(new Request("https://example.test", { method: "POST", body: '{"amount":"1"}' }), ["amount"]), { amount: "1" });
});
test("unexpected errors cannot reflect RPC credentials, session seeds or SQL values", async () => {
  const response = await solanaResponse(async () => { throw new Error("https://rpc.example?api-key=secret sessionSecretKey=private SQL value"); });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.text();
  for (const secret of ["rpc.example", "api-key", "sessionSecretKey", "SQL value"]) assert.ok(!body.includes(secret));
});
test("setup errors answer as unavailable, never naming a setting", async () => {
  for (const error of [new SolanaMarketError("missing-jupiter-key"), new SolanaMarketError("invalid-jupiter-key"),
    new SolanaRpcError("missing-config"), new SolanaRpcError("invalid-config"),
    new SolanaAppRuntimeError("configuration", "Configure the separate Solana network fee payer before live trading.")]) {
    const response = await solanaResponse(async () => { throw error; });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true }, error.message);
  }
  // A problem with the request itself still says what it is.
  const quote = await solanaResponse(async () => { throw new SolanaMarketError("invalid-quote"); });
  assert.equal((await quote.json()).error, "Jupiter did not return a valid quote for the requested swap.");
});
test("with Solana off the response refuses before the action runs", async () => {
  for (const value of [undefined, "", "0", "true", "yes"]) {
    if (value === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = value;
    let ran = false;
    const response = await solanaResponse(async () => { ran = true; return { ok: true }; });
    assert.equal(response.status, 404, String(value));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { error: "Solana trading is not available.", ownerFacing: true });
    assert.equal(ran, false);
  }
  process.env.MERRYMEN_SOLANA = "1";
  assert.equal((await solanaResponse(async () => ({ ok: true }))).status, 200);
});

const OUTAGE = "Solana is temporarily unavailable. Nothing was confirmed; refresh to check existing requests before retrying.";
/** Owner text must never name a provider, a setting, an endpoint or the worker's internal code. */
function ownerSafe(text: string) {
  assert.doesNotMatch(text, /MERRYMEN_|jupiter|pyth|api[ _-]?key|https?:|rpc|refused: |execution/i, text);
}
test("live refusals the owner can act on are clear 4xx answers, not an outage", async () => {
  const cases: Array<[SolanaExecutionError["code"], number, RegExp]> = [
    ["risk", 409, /outside your trading limits/], ["fee-cap", 409, /fees are above/], ["simulation", 409, /pre-flight check/],
    ["unsafe-route", 409, /No safe route/], ["conflict", 409, /Refresh before trying again/], ["invalid-intent", 400, /not supported/],
    ["price-moved", 409, /^The price moved\. Preview again; nothing was sent\.$/], ["owner-refund", 409, /^(?!.*Reopen).*closed or not safe to use\. Nothing was sent\. Your Solana status says what to fix in that account; then try again\.$/],
  ];
  for (const [code, status, text] of cases) {
    const response = await solanaResponse(async () => { throw new SolanaExecutionError(code); });
    const body = await response.json() as { error: string; ownerFacing: boolean };
    assert.equal(response.status, status, code);
    assert.match(body.error, text, code);
    assert.equal(body.ownerFacing, true);
    ownerSafe(body.error);
  }
  const settlement = await solanaResponse(async () => { throw new SolanaSettlementError(); });
  assert.equal(settlement.status, 409); const held = (await settlement.json() as { error: string }).error;
  assert.match(held, /stays held for review/); ownerSafe(held);
  // Outcomes nobody can vouch for keep the cautious answer; a program that is
  // not the audited binary is this deployment's problem, not the owner's.
  for (const code of ["invalid-state", "cancelled"] as const) {
    const response = await solanaResponse(async () => { throw new SolanaExecutionError(code); });
    assert.equal(response.status, 503, code); assert.equal((await response.json()).error, OUTAGE);
  }
  const program = await solanaResponse(async () => { throw new SolanaExecutionError("unsafe-program"); });
  assert.equal(program.status, 503); assert.equal((await program.json()).error, "Solana trading is not available.");
});
test("every paper refusal the worker raises has a fixed owner answer, and the fixable ones are 4xx", async () => {
  const source = readFileSync(fileURLToPath(new URL("../../../worker/src/solana-paper-service.ts", import.meta.url)), "utf8");
  const raised = [...source.matchAll(/new SolanaPaperServiceError\(([^)]*)\)/g)].map((match) => match[1]!.trim());
  assert.ok(raised.length >= 8, "paper refusals moved");
  for (const argument of raised) assert.match(argument, /^"[^"$`\\]+"$/, `a literal message, never interpolated: ${argument}`);
  const answers = new Map<string, { status: number; error: string }>();
  for (const literal of raised) {
    const message = JSON.parse(literal) as string;
    const response = await solanaResponse(async () => { throw new SolanaPaperServiceError(message); });
    const body = await response.json() as { error: string };
    assert.notEqual(body.error, OUTAGE, message);
    ownerSafe(body.error);
    answers.set(message, { status: response.status, error: body.error });
  }
  for (const message of ["Create the Solana paper book before requesting a trade.", "The Solana paper book's limits have expired.",
    "Insufficient simulated USDG for this buy.", "Insufficient simulated token balance for this sell.",
    "Buying is blocked by the current token safety checks.", "This request ID already belongs to a different paper trade."]) {
    assert.equal(answers.get(message)?.status, 409, message);
  }
  assert.match(answers.get("The Solana paper book's limits have expired.")!.error, /limits have expired\. Save new limits/);
  // A paper trade below the minimum the owner previewed reads as the live one does, with the fresh minimum to review.
  assert.ok(source.includes("new SolanaPaperPriceMovedError(prepared.quote.minOutAmount)"), "the paper floor still raises its own refusal");
  const paperMoved = await solanaResponse(async () => { throw new SolanaPaperPriceMovedError("9900000"); });
  assert.equal(paperMoved.status, 409);
  assert.deepEqual(await paperMoved.json(), { error: "The price moved. Preview again; nothing was sent.", ownerFacing: true, freshMinOutAmount: "9900000" });
  assert.deepEqual(await (await solanaResponse(async () => { throw new SolanaPaperServiceError(SOLANA_PAPER_PRICE_MOVED); })).json(),
    { error: "The price moved. Preview again; nothing was sent.", ownerFacing: true });
  assert.deepEqual(answers.get("The USDG mint does not match the configured cash asset."), { status: 503, error: "Solana trading is not available." });
  // An unlisted message is never reflected.
  const unknown = await solanaResponse(async () => { throw new SolanaPaperServiceError("constructor"); });
  assert.equal(unknown.status, 503); assert.equal((await unknown.json()).error, OUTAGE);
});

test("failures to use Solana's answer about a saved owner transaction are an unknown outcome, never a 4xx refusal", async () => {
  // Each message is still raised by the worker after the owner's bytes were saved (ownerStatus, finishSetup).
  const raised = ["solana-app-runtime.ts", "solana-trading-store.ts"].map((file) => readFileSync(fileURLToPath(new URL(`../../../worker/src/${file}`, import.meta.url)), "utf8")).join("\n");
  assert.ok(OWNER_OUTCOME_UNKNOWN.size >= 13);
  for (const message of OWNER_OUTCOME_UNKNOWN) {
    assert.ok(raised.includes(JSON.stringify(message)), `still raised: ${message}`);
    for (const error of [new SolanaAppRuntimeError("invalid", message), new SolanaTradingStoreError(message)]) {
      const response = await solanaResponse(async () => { throw error; });
      const body = await response.json() as { error: string; ownerFacing: boolean };
      assert.equal(response.status, 503, `${error.name}: ${message}`);
      assert.match(body.error, /could not be confirmed or recorded yet\. Nothing new was sent\. A transaction you already submitted stays saved and may still complete/);
      assert.equal(body.ownerFacing, true);
      ownerSafe(body.error);
    }
  }
  // ownerStatus's own code is an unknown outcome whatever the message, listed or not, and the message is never reflected.
  const runtime = readFileSync(fileURLToPath(new URL("../../../worker/src/solana-app-runtime.ts", import.meta.url)), "utf8");
  assert.ok(runtime.includes(`throw new SolanaAppRuntimeError("outcome-unknown", error.message)`), "ownerStatus still marks its failures");
  for (const message of ["Owner confirmation does not match the vault state.", "Invalid Solana account data.", "Invalid encoded Solana transaction.", "an internal detail"]) {
    const response = await solanaResponse(async () => { throw new SolanaAppRuntimeError("outcome-unknown", message); });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 503, message);
    assert.match(String(body.error), /could not be confirmed or recorded yet\. Nothing new was sent/, message);
    assert.equal(Object.hasOwn(body, "notSaved"), false, message);
  }
  // A refusal before anything is saved still says what it is.
  const expired = await solanaResponse(async () => { throw new SolanaTradingStoreError("The prepared owner transaction expired before submission."); });
  assert.equal(expired.status, 409); assert.equal((await expired.json()).error, "The prepared owner transaction expired before submission.");
  const signature = await solanaResponse(async () => { throw new SolanaAppRuntimeError("invalid", "The owner signature or reviewed transaction does not match."); });
  assert.equal(signature.status, 400);
});

test("a live route that cannot be built is answered by the builder's code: setup is unavailable, a provider fault is a neutral retry, and only a route shape is 'no supported route'", async () => {
  const key = process.env.MERRYMEN_JUPITER_API_KEY;
  try {
    // The code decides, not this process's settings: each answer is the same whatever the key here says.
    for (const value of [undefined, "", "bad key", "configured-key"]) {
      if (value === undefined) delete process.env.MERRYMEN_JUPITER_API_KEY; else process.env.MERRYMEN_JUPITER_API_KEY = value;
      const setup = await solanaResponse(async () => { throw new SolanaLiveMarketError("configuration"); });
      assert.equal(setup.status, 503, JSON.stringify(value));
      assert.deepEqual(await setup.json(), { error: "Solana trading is not available.", ownerFacing: true }, JSON.stringify(value));
      const provider = await solanaResponse(async () => { throw new SolanaLiveMarketError("provider"); });
      const neutral = await provider.json() as { error: string };
      assert.equal(provider.status, 503, JSON.stringify(value));
      assert.equal(neutral.error, "A route for this trade could not be prepared right now. Nothing was sent. Preview again shortly.");
      assert.doesNotMatch(neutral.error, /no supported route|another amount/i); ownerSafe(neutral.error);
      const route = await solanaResponse(async () => { throw new SolanaLiveMarketError("route"); });
      assert.equal(route.status, 409, JSON.stringify(value));
      assert.deepEqual(await route.json(), { error: "No supported route is available for this trade right now. Nothing was sent. Preview again or try another amount.", ownerFacing: true });
    }
    // A code this layer does not know is never 'no supported route'.
    const unknown = await solanaResponse(async () => { throw new SolanaLiveMarketError("something-new" as SolanaLiveMarketError["code"]); });
    assert.equal(unknown.status, 503);
    assert.doesNotMatch((await unknown.json()).error, /no supported route|not available/i);
  } finally { if (key === undefined) delete process.env.MERRYMEN_JUPITER_API_KEY; else process.env.MERRYMEN_JUPITER_API_KEY = key; }
});

test("an amount that quotes to nothing is a 400 the owner can fix, in fixed words", async () => {
  const response = await solanaResponse(async () => { throw new SolanaMarketError("zero-output"); });
  const body = await response.json() as { error: string; ownerFacing: boolean };
  assert.equal(response.status, 400);
  assert.equal(body.error, "This amount is too small to trade: no route returns anything for it. Nothing was sent or recorded. Try a larger amount.");
  ownerSafe(body.error);
  // Other quote problems keep their answer.
  assert.equal((await solanaResponse(async () => { throw new SolanaMarketError("invalid-quote"); })).status, 503);
});

test("owner bytes refused before anything was saved answer notSaved, and nothing else does", async () => {
  // The worker still raises the two malformed-bytes refusals as not-saved.
  const runtime = readFileSync(fileURLToPath(new URL("../../../worker/src/solana-app-runtime.ts", import.meta.url)), "utf8");
  for (const message of ["Invalid encoded Solana transaction.", "The owner signature or reviewed transaction does not match."]) {
    assert.ok(runtime.includes(`notSaved(${JSON.stringify(message)})`), message);
  }
  // Saved limits that expired inside the prepare window are refused the same way, before anything is written.
  assert.ok(runtime.includes("notSaved(LIMITS_NO_LONGER_VALID)"));
  for (const [message, status] of [["Invalid encoded Solana transaction.", 400], ["The owner signature or reviewed transaction does not match.", 400],
    ["Prepare this owner transaction before signing it.", 409], ["Another owner transaction is already saved.", 409],
    ["The prepared owner transaction expired before submission.", 409], ["The live permission settings changed. Review and sign again.", 409],
    [LIMITS_NO_LONGER_VALID, 409],
    // Even a message that, from saved bytes, would be an unknown outcome: these bytes were never saved.
    ["Invalid Solana confirmation data.", 409]] as const) {
    const response = await solanaResponse(async () => { throw new SolanaAppRuntimeError("not-saved", message); });
    assert.equal(response.status, status, message);
    assert.deepEqual(await response.json(), { error: message, ownerFacing: true, notSaved: true }, message);
  }
  for (const error of [new SolanaAppRuntimeError("pending", "Invalid owner transaction confirmation."), new SolanaAppRuntimeError("invalid", "The owner signature or reviewed transaction does not match."),
    new SolanaTradingStoreError("The prepared owner transaction expired before submission."), new SolanaExecutionError("price-moved"), new Error("boom")]) {
    const body = await (await solanaResponse(async () => { throw error; })).json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(body, "notSaved"), false, error.message);
  }
});

test("a price-moved refusal carries the fresh guaranteed minimum for the owner to review, and nothing else does", async () => {
  const moved = await solanaResponse(async () => { throw new SolanaExecutionError("price-moved", { freshMinOutAmount: "14775750" }); });
  assert.equal(moved.status, 409);
  assert.deepEqual(await moved.json(), { error: "The price moved. Preview again; nothing was sent.", ownerFacing: true, freshMinOutAmount: "14775750" });
  // Without one, or with anything but a canonical positive integer, the answer carries none.
  for (const freshMinOutAmount of [undefined, "0", "01", "1.5", "-1", "1e9", "1".repeat(40)]) {
    const body = await (await solanaResponse(async () => { throw new SolanaExecutionError("price-moved", { freshMinOutAmount }); })).json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(body, "freshMinOutAmount"), false, String(freshMinOutAmount));
    assert.equal(body.error, "The price moved. Preview again; nothing was sent.");
  }
  const risk = await (await solanaResponse(async () => { throw new SolanaExecutionError("risk", { freshMinOutAmount: "1" }); })).json() as Record<string, unknown>;
  assert.equal(Object.hasOwn(risk, "freshMinOutAmount"), false);
});

test("a paced intent answers 429 in its own words, never as an outage", async () => {
  const response = await solanaResponse(async () => { throw new SolanaWebError(429, "Too many Solana trade requests. This request was not processed; a trade you already placed is unaffected. Refresh to check it, then try again in 6 seconds."); });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "Too many Solana trade requests. This request was not processed; a trade you already placed is unaffected. Refresh to check it, then try again in 6 seconds.", ownerFacing: true });
});

test("paper write-off refusals are 409s in fixed owner words; other book rules keep the store's 400", async () => {
  // The write-off contract: not_dust, no_position, invalid_quote and stale_safety answer 409 with fixed text.
  const fixed: Array<[SolanaPaperStoreError["code"], RegExp]> = [
    ["not_dust", /^A route still buys this position back, so it cannot be written off\. Sell it instead\. Nothing was changed\.$/],
    ["no_position", /^Your paper portfolio holds no position in that token\. Nothing was changed\.$/],
    ["invalid_quote", /could not be used\. Nothing was recorded\./], ["stale_safety", /too old .* Nothing was recorded\./],
    ["remainder_unquoted", /remainder that no route buys back\. Sell the whole position, or less of it\./],
    ["book_missing", /^Create your paper portfolio first\.$/], ["version_conflict", /changed while this request was prepared\. Refresh and try again\./],
  ];
  for (const [code, text] of fixed) {
    const response = await solanaResponse(async () => { throw new SolanaPaperStoreError(code); });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 409, code);
    assert.match(String(body.error), text, code);
    assert.notEqual(body.error, new SolanaPaperStoreError(code).message, `${code}: the owner's words, not the store's`);
    assert.deepEqual(Object.keys(body).sort(), ["error", "ownerFacing"], code);
    ownerSafe(String(body.error));
  }
  for (const code of ["invalid_input", "per_trade_limit", "daily_limit", "drawdown_limit", "insufficient_balance", "position_limit"] as const) {
    const response = await solanaResponse(async () => { throw new SolanaPaperStoreError(code); });
    assert.equal(response.status, 400, code);
    assert.equal((await response.json()).error, new SolanaPaperStoreError(code).message, code);
  }
  // An owner not in paper mode: the runtime's early refusal (before the paid quote) and the store's own
  // refusal under the lock answer alike, 409 with the same text.
  const mode = "Paper trading is not the selected Solana mode.";
  for (const error of [new SolanaAppRuntimeError("permission", mode), new SolanaTradingStoreError(mode)]) {
    const response = await solanaResponse(async () => { throw error; });
    assert.equal(response.status, 409, error.name); assert.deepEqual(await response.json(), { error: mode, ownerFacing: true }, error.name);
  }
  // A ledger without a write-off is this deployment's shape: unavailable, never an outage or a refusal.
  const missing = await solanaResponse(async () => { throw new SolanaPaperServiceError("This Solana paper ledger has no owner write-off."); });
  assert.equal(missing.status, 503); assert.equal((await missing.json()).error, "Solana trading is not available.");
});

test("prepare-side 'pending' refusals stay 409 refusals: neither notSaved nor an unknown outcome", async () => {
  const runtime = readFileSync(fileURLToPath(new URL("../../../worker/src/solana-app-runtime.ts", import.meta.url)), "utf8");
  for (const message of ["Refresh the pending owner transaction before preparing another.", "The permission is awaiting final confirmation."]) {
    assert.ok(runtime.includes(JSON.stringify(message)), `still raised: ${message}`);
    const response = await solanaResponse(async () => { throw new SolanaAppRuntimeError("pending", message); });
    assert.equal(response.status, 409, message);
    assert.deepEqual(await response.json(), { error: message, ownerFacing: true }, message);
  }
  assert.ok(runtime.includes(`fail("Refresh the pending owner transaction before preparing another.", "pending")`));
});
