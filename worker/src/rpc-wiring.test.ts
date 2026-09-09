/**
 * THE THREE FACTS THE DIAGNOSIS RESTS ON, PINNED WHERE THEY LIVE.
 *
 * The fleet was collapsing at a tenth of the endpoint's measured capacity, and
 * the cause was not volume. It was that a refusal produced more requests: viem
 * retries status 429 by default, `chainRead` never said otherwise, and fifteen
 * separate processes each had to learn the endpoint was refusing by being
 * refused. Every one of those three is a single line somewhere, and every one
 * of them is silent when it regresses — a fleet that has quietly gone back to
 * retrying 429s looks exactly like a fleet that is merely busy.
 *
 * So they are read out of the source. Behaviour tests cover the governor's
 * decisions (rpc-governor.test.ts); these cover the wiring that decides whether
 * those decisions ever run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the amplifier stays off", () => {
  it("chainRead SETS retryCount TO ZERO", () => {
    // viem's shouldRetry returns true for status 429 (utils/buildRequest.js).
    // With the default retryCount of 3, one refusal became four requests —
    // issued 150ms, 300ms and 600ms after the endpoint said stop. The 1624ms
    // average on refused calls against 210ms on successful ones is that ladder.
    const meter = src("./rpc-meter.ts");
    const opts = meter.slice(meter.indexOf("export function chainRead"), meter.indexOf("function governed"));
    assert.match(opts, /retryCount:\s*0/, "chainRead must not let viem retry a refusal");
  });

  it("and the transport still has no shouldRetry to reach for", () => {
    // If a future viem exposes it, this test failing is the signal that a
    // better setting became available — keep the retry for a network blip,
    // drop it for a 429 — rather than leaving retryCount:0 unexamined forever.
    const d = readFileSync(
      new URL("../../node_modules/viem/_types/clients/transports/http.d.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      !/shouldRetry/.test(d),
      "viem now exposes shouldRetry on the http transport — prefer it over retryCount:0",
    );
  });
});

describe("every read goes through the governor", () => {
  it("chainRead WRAPS THE METER IN IT — a seam nothing goes through is not a seam", () => {
    const meter = src("./rpc-meter.ts");
    assert.match(meter, /return governed\(\s*metered\(/);
  });

  it("and the governor is OUTSIDE the meter, so a refused request is not counted as one we made", () => {
    // The distinction the operator reads: a call the breaker declined to send
    // is not a call the endpoint refused. Folding them together would hide
    // whether the breaker is working.
    const meter = src("./rpc-meter.ts");
    const g = meter.indexOf("return governed(");
    const m = meter.indexOf("metered(", g);
    assert.ok(g >= 0 && m > g, "governed() must be the outer wrapper");
  });

  it("AND THE SEND EDGE IS NOT GOVERNED", () => {
    // eth_sendUserOperation lives under the send-edge rules — persist the hash,
    // send once, never re-send. A breaker that refuses and a bucket that delays
    // are both the wrong shape for an operation that must not be retried, and
    // queueing a send behind somebody else's reads is worse than either.
    const meter = src("./rpc-meter.ts");
    const bundlerUsesChainRead = /chainRead\([^)]*bundler/i.test(meter);
    assert.ok(!bundlerUsesChainRead, "the bundler must not be built through chainRead");
    assert.match(meter, /NOT FOR THE BUNDLER/);
  });
});

describe("the breaker is shared across the container", () => {
  it("THE ORCHESTRATOR PASSES THE FLEET HOME, so children do not each get a private file", () => {
    // A child's own MERRYMEN_HOME is <fleet>/children/<tenant>. Writing the
    // cooldown there gives every child its own copy and the appearance of a
    // working breaker that coordinates with nobody.
    const orch = src("./orchestrator.ts");
    assert.match(orch, /env\.MERRYMEN_FLEET_HOME = merrymenHome\(\);/);
  });

  it("and the cooldown file prefers it over the child's private home", () => {
    const cool = src("./rpc-cooldown.ts");
    assert.match(cool, /process\.env\.MERRYMEN_FLEET_HOME/);
  });

  it("AND IT IS NOT A SECRET, so it must not be stripped from the child env", () => {
    // CHILD_SECRET_STRIP removes keys a child must never see. A path is not one
    // of them, and stripping it would silently un-share the breaker.
    const orch = src("./orchestrator.ts");
    const strip = orch.slice(orch.indexOf("const CHILD_SECRET_STRIP"), orch.indexOf("] as const;"));
    assert.ok(!strip.includes("MERRYMEN_FLEET_HOME"));
  });

  it("and a read of the shared file can only ever fail to null", () => {
    // No advice is where the fleet was before this existed. A parse error that
    // became a cooldown of zero would be an instruction to resume, invented
    // out of a corrupt file.
    const cool = src("./rpc-cooldown.ts");
    const read = cool.slice(cool.indexOf("export function readCooldown"), cool.indexOf("export function publishCooldown"));
    assert.match(read, /catch \{\s*return null;/);
  });
});
