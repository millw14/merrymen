/**
 * FROM THE CARD TO THE ROUTE THE WORKER TAKES — run end to end, self-hosted.
 *
 * The worker used to send every order whose symbol read MERRYMEN to its energy
 * buy, so a plain `buy` card the model wrote for it, or a snipe that resolved
 * to a coin with that name, bought the reserve without ever showing the energy
 * card's disclosure. It routes on get-energy's fixed `purpose: "energy"` now,
 * and this runs the whole chain that marker travels on the self-hosted rail:
 *
 *   the card's own payload (chat-commands.ts commandPayload)
 *   → POST /api/orders (readOrder keeps it only when it is exactly "energy")
 *   → the command file the worker claims (command-files.ts, the unlink)
 *   → the route the worker's gate hands the submitter (order-gate.ts orderRoute).
 *
 * The hosted rail writes the same args into agent_commands (guard.test.ts runs
 * that insert) and the orchestrator's ferry passes every scalar arg through
 * unexamined (orchestrator.ts parseArgs), so the marker arrives the same way.
 *
 * MERRYMEN_HOME is pointed at a fresh directory per case, before the route
 * resolves it; node's --test runs each file in its own process.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { commandFor, commandPayload } from "@/lib/chat-commands";
import { resetSettingsStoreForTest } from "@merrymen/settings-store";
import { claimCommandFile } from "../../../../../worker/src/command-files";
import { orderRoute } from "../../../../../worker/src/order-gate";
import { POST } from "./route";

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SETTINGS_FILE", "MERRYMEN_TELEGRAM_MAX_ACTION_USDG", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];
let home = "";

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "merrymen-energy-route-"));
  dirs.push(home);
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SETTINGS_FILE = path.join(home, "no-such-settings.json");
  process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "100";
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // The one grant on this machine, where the self-hosted route finds its account.
  writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: "0x00000000000000000000000000000000000000a1" }));
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** POST a body as a card sends it; then claim what the worker would claim. */
async function placeAndClaim(body: Record<string, unknown>) {
  const res = await POST(
    new Request("https://app.example.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const reply = (await res.json()) as { error?: string };
  return { status: res.status, error: reply.error ?? "", claimed: res.status === 200 ? claimCommandFile(home) : null };
}

describe("the energy route, from the card to the worker's gate", () => {
  it("THE GET-ENERGY CARD REACHES THE ENERGY ROUTE — its marker survives the route and the file", async () => {
    const payload = commandPayload(commandFor("get-energy")!, { usdgAmount: 20 });
    const { status, error, claimed } = await placeAndClaim(payload);
    assert.equal(status, 200, error);
    assert.ok(claimed, "the worker claims the order the route wrote");
    assert.equal(claimed.args?.purpose, "energy");
    assert.equal(orderRoute(claimed.args), "energy");
  });

  it("A BUY CARD FOR MERRYMEN IS AN ORDINARY ORDER — even when the model tried to add the marker", async () => {
    const payload = commandPayload(commandFor("buy")!, { symbol: "MERRYMEN", usdgAmount: 20, purpose: "energy" });
    const { status, error, claimed } = await placeAndClaim(payload);
    assert.equal(status, 200, error);
    assert.ok(claimed);
    assert.equal(claimed.args?.purpose, undefined);
    assert.equal(orderRoute(claimed.args), "trade");
  });

  it("A SNIPE THAT RESOLVED TO A COIN NAMED MERRYMEN IS AN ORDINARY ORDER — the shape Agent.tsx places", async () => {
    const { status, error, claimed } = await placeAndClaim({ side: "buy", symbol: "MERRYMEN", usdgAmount: 20 });
    assert.equal(status, 200, error);
    assert.equal(orderRoute(claimed!.args), "trade");
  });

  it("a marked order that is not a buy of $MERRYMEN is refused and writes nothing", async () => {
    const { status, error } = await placeAndClaim({ side: "buy", symbol: "TSLA", usdgAmount: 5, purpose: "energy" });
    assert.equal(status, 400);
    assert.match(error, /an energy order is a buy of \$MERRYMEN and nothing else/);
    assert.equal(claimCommandFile(home), null, "nothing reached the queue");
  });
});
