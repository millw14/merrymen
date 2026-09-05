import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NotRecorded, UserOpUnresolved } from "./executor";

/**
 * THE SEND EDGE, PINNED BY ORDER.
 *
 * `sendUserOperation` had no try/catch and `onSubmitted` fired after it
 * returned. A throw at that edge therefore produced three wrong answers at once
 * in index.ts's generic catch: the budget was released, the row was written
 * `reverted` — a claim about a chain that never saw the operation — and no hash
 * was stored at all. That last one is the trap: `resolveStrandedOps` selects on
 * `status='submitted' AND user_op_hash IS NOT NULL`, so the operation was
 * structurally invisible to the sweep built to find it.
 *
 * The failure that motivates it is not the tidy one. If the send reaches the
 * bundler but the RESPONSE is lost — socket reset, proxy 502, a client timeout
 * after acceptance — an operation is in flight, spending real money, with no
 * record anywhere.
 *
 * These are ORDERING assertions, and ordering is the whole fix, so they are
 * source scans rather than behavioural tests: a unit test would need a bundler,
 * and the property under test is "which line comes first".
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING. The block being pinned explains itself
 * at length and names every symbol below, so scanning raw source would let a
 * deleted call keep passing on the strength of a comment about it.
 */

const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

const EXECUTOR = strip(readFileSync(new URL("./executor.ts", import.meta.url), "utf8"));
const INDEX = strip(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

test("the hash is computed locally, BEFORE anyone is asked to accept the operation", () => {
  // A userOpHash is a pure function of the packed op, the EntryPoint and the
  // chain id — so it is knowable before the network exists, exactly as Vex
  // computes keccak256 of a signed transaction before sendRawTransaction.
  assert.match(EXECUTOR, /getUserOperationHash\(\{/);
  const hashAt = EXECUTOR.indexOf("getUserOperationHash({");
  const sendAt = EXECUTOR.indexOf("client.sendUserOperation(signed");
  assert.ok(hashAt > 0 && sendAt > 0, "both call sites must exist");
  assert.ok(hashAt < sendAt, "the hash must be derived before the send, not from it");
});

test("THE DURABLE ROW IS WRITTEN BEFORE THE BROADCAST", () => {
  // The property the whole change exists for. If this inverts again, a lost
  // response is once more an operation with no record.
  const hookAt = EXECUTOR.indexOf("hooks.onSubmitted(userOpHash)");
  const sendAt = EXECUTOR.indexOf("client.sendUserOperation(signed");
  assert.ok(hookAt > 0 && sendAt > 0, "both call sites must exist");
  assert.ok(hookAt < sendAt, "onSubmitted must run before the send");
});

test("a throw at the send edge is UNRESOLVED, never a revert", () => {
  // "We asked and do not know whether the ask arrived" is not "the chain
  // refused". index.ts already handles UserOpUnresolved correctly — budget held,
  // row left 'submitted', a warn naming the hash — and could not reach that
  // branch from the send edge because nothing threw the type.
  assert.match(EXECUTOR, /try \{\s*accepted = await client\.sendUserOperation/);
  assert.match(EXECUTOR, /catch \(err\) \{\s*throw new UserOpUnresolved\(userOpHash/);
});

test("THE SEND IS NEVER REPEATED", () => {
  // The one mistake this shape exists to make impossible: a re-send is a second
  // operation and a second spend. The receipt read is the only thing retried,
  // and the send sits outside that loop by construction.
  const loopAt = EXECUTOR.indexOf("for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS");
  const sendAt = EXECUTOR.indexOf("client.sendUserOperation(signed");
  assert.ok(loopAt > 0 && sendAt > 0);
  assert.ok(sendAt < loopAt, "the send must sit outside the retry loop");
  assert.equal(
    (EXECUTOR.match(/client\.sendUserOperation\(/g) ?? []).length,
    1,
    "exactly one send call site — a second is a second spend",
  );
});

test("REFUSING TO BROADCAST UNTRACKED", () => {
  // Only possible because the hook moved ahead of the send. While it ran after,
  // a failed write was noted and tolerated because the money was already
  // committed; now nothing has gone out, so not sending is the cheaper answer.
  assert.match(INDEX, /if \(!wrote\) throw new NotRecorded\(userOpHash\)/);
  assert.match(INDEX, /e instanceof NotRecorded/);
  // And it must be classified, not left to the generic branch that writes
  // 'reverted' with free-form text.
  assert.match(INDEX, /reject_rule: "not-recorded"/);
  const notRecordedAt = INDEX.indexOf("e instanceof NotRecorded");
  const genericAt = INDEX.indexOf('reason = "couldn\'t submit: "');
  assert.ok(notRecordedAt > 0, "the branch must exist");
  if (genericAt > 0) {
    assert.ok(notRecordedAt < genericAt, "it must be caught before the generic fallback");
  }
});

test("both refusals carry the hash, so nothing is thrown away nameless", () => {
  // The classes are the contract; index.ts branches on TYPE rather than on a
  // message regex, which is how a receipt-wait timeout used to be booked as a
  // revert in the first place.
  const unresolved = new UserOpUnresolved("0xabc", "socket hang up");
  assert.equal(unresolved.userOpHash, "0xabc");
  assert.equal(unresolved.name, "UserOpUnresolved");

  const notRecorded = new NotRecorded("0xdef");
  assert.equal(notRecorded.userOpHash, "0xdef");
  assert.equal(notRecorded.name, "NotRecorded");
  assert.match(notRecorded.message, /Nothing was sent/);
});

test("REVERTED MEANS THE CHAIN REVERTED IT", () => {
  // The generic catch wrote `status: "reverted"` for everything that was not a
  // typed revert — a bundler refusal, an RPC failure, a calldata build that
  // threw. All of those are claims about a chain that never saw the operation,
  // written into the one place in this product that must not put words in the
  // chain's mouth.
  assert.match(INDEX, /status: onChain \? "reverted" : "rejected"/);
  // And `onChain` must still be a TYPE test, not a message match — matching on
  // a string is how a receipt-wait timeout ended up in the revert branch in the
  // first place.
  assert.match(INDEX, /const onChain = e instanceof UserOpReverted/);
});

test("an operation that WENT OUT is never booked as a failure beside itself", () => {
  // `submittedRow` is set by the pre-broadcast write. If it is set and the error
  // is not a typed revert, an op reached the bundler and something after it
  // threw — the fill read, the gas pricing, an addFlow. The old code wrote
  // `reverted` with no hash, so addTrade INSERTED rather than resolving in
  // place: the same operation became two rows, one 'submitted' that the resolver
  // would later settle and one 'reverted' that was simply false.
  // ANCHORED ON THE BRANCH'S OWN SENTENCE, which is the only thing that tells
  // it apart. Two earlier attempts were vacuous: a `// Roll back` comment anchor
  // could never match because strip() removes comment lines, and
  // `lastIndexOf("if (submittedRow) {")` found the UserOpUnresolved branch's
  // identical guard instead, so deleting this branch entirely still passed.
  // Verified by mutation: removing the block now fails this test.
  const classifierAt = INDEX.indexOf("const onChain = e instanceof UserOpReverted");
  assert.ok(classifierAt > 0, "the classifier must exist");
  const said = INDEX.indexOf("was submitted, and then something after it failed");
  assert.ok(said > 0, "the submitted-then-threw branch must exist");
  assert.ok(said < classifierAt, "and must be handled before the terminal classification");
  const branchAt = INDEX.lastIndexOf("if (submittedRow) {", said);
  assert.ok(branchAt > 0, "its guard must sit above its message");
  // It must settle the charge and RETURN. Falling through would release the
  // reservation for an operation that is in flight — under-counting the day's
  // spend by exactly that notional — and then write a terminal row for it.
  const body = INDEX.slice(branchAt, classifierAt);
  assert.match(body, /refreshBudget\(agentId\)/, "the in-flight charge must be settled, not dropped");
  assert.match(body, /return;/, "it must not fall through to the terminal write");
});

test("DELIVERY IS CHECKED WHEREVER A TOKEN WAS ACQUIRED, not only where the decode worked", () => {
  // It used to sit three gates deep: inside `if (fillPair)`, inside
  // `if (measured)`, inside `if (side === "buy")`. `fillPair` is assigned only
  // in the Uniswap branch, under `sellIsUsdg !== buyIsUsdg`, under `if (symbol)`
  // — so curve trades, Rialto swaps and stock-to-stock swaps got no delivery
  // check at all. Curve is the venue where a token is minted by whoever wants it
  // minted, and it was the one lane with nothing watching.
  const gate = INDEX.indexOf("const acquired: { token:");
  assert.ok(gate > 0, "the acquisition gate must exist");
  assert.match(INDEX.slice(gate, gate + 700), /intent\.kind === "curve-trade"/, "curve must be covered");

  // And it must run BEFORE the decode. `measured` is a receipt decode, and this
  // check exists precisely because receipt logs are contract-authored: a token
  // that fabricates a Transfer log is exactly the token whose decode should not
  // be deciding whether to look. Vex computes delivery before the decode for
  // this reason.
  const decodeAt = INDEX.indexOf("const deltas = netTokenDeltas(");
  assert.ok(decodeAt > 0, "the decode must exist");
  assert.ok(gate < decodeAt, "delivery must not depend on the decode succeeding");

  // Exactly one call site — the old thrice-gated copy is gone, not merely
  // shadowed by the new one.
  assert.equal((INDEX.match(/await checkDelivery\(/g) ?? []).length, 1);
});
