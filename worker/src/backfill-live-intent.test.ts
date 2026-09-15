/**
 * THE MIGRATION IS THE DANGEROUS HALF, so it is the tested half.
 *
 * A consent gate with a safe default is a fleet outage unless somebody has
 * already written the field for the people who are mid-trade. `bool()` in
 * worker/src/settings.ts resolves an ABSENT field to the default, and the
 * default is false — so the deploy that enforces the gate stops every agent
 * whose owner never wrote a setting they could not previously write.
 *
 * Two failure directions, both expensive and neither loud:
 *   grant too little  a funded agent stops trading mid-position, silently
 *   grant too much    consent is fabricated for somebody who never gave it,
 *                     which is the original defect re-created inside its fix
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  applyLiveIntentBackfill,
  planLiveIntentBackfill,
  type BackfillPlan,
  type SettingsStoreLike,
} from "./backfill-live-intent";

/** A settings store in memory. `throwFor` makes one tenant unreadable. */
function store(
  initial: Record<string, Record<string, unknown>>,
  throwFor?: string,
): SettingsStoreLike & { written: Record<string, Record<string, unknown>> } {
  const rows = { ...initial };
  const written: Record<string, Record<string, unknown>> = {};
  return {
    written,
    async listTenants() {
      return Object.keys(rows) as `0x${string}`[];
    },
    async get(tenant) {
      if (tenant === throwFor) throw new Error("sealed with a key this process does not have");
      return rows[tenant] ?? null;
    },
    async put(tenant, settings) {
      rows[tenant] = settings;
      written[tenant] = settings;
    },
  };
}

/**
 * A trades table. Rows are [agent_id, status].
 *
 * THE FILTER COMES FROM THE PRODUCTION QUERY, not from this file. It used to be
 * hard-coded here as `status === "landed" || status === "submitted"`, which
 * meant the test did the filtering and the real `WHERE status IN (...)` was
 * never exercised: deleting that clause in production would have left every
 * test green while the migration granted live consent to every agent that had
 * ever simulated a fill.
 *
 * So the statuses are parsed out of the SQL the caller actually sent. A query
 * with no status filter now returns everything, and the "a PAPER fill is not
 * evidence" case below fails — which is the assertion that matters most here.
 */
const db = (rows: [string, string][]) => ({
  async query(sql: string) {
    assert.match(sql, /FROM trades/, "the evidence must come from the trade tape");
    assert.doesNotMatch(sql, /balance|cash|usdg/i, "never from a balance — funding is not consent");
    const allowed = [...sql.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    return {
      rows: rows
        .filter(([, status]) => allowed.includes(status))
        .map(([agent_id]) => ({ agent_id })),
    };
  },
});

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const DAVE = "0xdddddddddddddddddddddddddddddddddddddddd" as const;

/** Identity mapping — the tenant IS the agent id in these cases. */
const identity = (t: `0x${string}`) => t;

describe("who already consented, and how we can tell", () => {
  it("AN AGENT THAT HAS PUT A REAL ORDER ON CHAIN KEEPS TRADING", () => {
    // The outage case. Alice is mid-position with real money; the enforcing
    // deploy must not be the thing that stops her.
    return planLiveIntentBackfill({
      settings: store({ [ALICE]: { paperTradingEnabled: true } }),
      db: db([[ALICE, "landed"]]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.grant, [{ tenant: ALICE, reason: "has-traded-for-real" }]);
      assert.deepEqual(plan.leaveDefault, []);
    });
  });

  it("a SUBMITTED order counts too — it left, whether or not it mined", () => {
    return planLiveIntentBackfill({
      settings: store({ [ALICE]: {} }),
      db: db([[ALICE, "submitted"]]),
      agentIdOf: identity,
    }).then((plan) => assert.equal(plan.grant.length, 1));
  });

  it("but a PAPER fill is not evidence of anything", () => {
    // The whole tape of a practising agent is `status: "paper"`. Reading it as
    // live trading would grant consent to precisely the cohort this work exists
    // to protect.
    return planLiveIntentBackfill({
      settings: store({ [BOB]: {} }),
      db: db([[BOB, "paper"]]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.grant, []);
      assert.deepEqual(plan.leaveDefault, [BOB]);
    });
  });

  it("nor is a REJECTED one", () => {
    return planLiveIntentBackfill({
      settings: store({ [BOB]: {} }),
      db: db([[BOB, "rejected"]]),
      agentIdOf: identity,
    }).then((plan) => assert.deepEqual(plan.grant, []));
  });

  it("an owner who explicitly switched the simulator off was ASKING for live", () => {
    // `paperTradingEnabled: false` is what the old go-live command wrote. It
    // never gated anything, but it is a thing the owner did on purpose, and
    // this migration is the first chance to honour it.
    return planLiveIntentBackfill({
      settings: store({ [CAROL]: { paperTradingEnabled: false } }),
      db: db([]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.grant, [{ tenant: CAROL, reason: "explicitly-not-paper" }]);
    });
  });

  it("BUT AN ABSENT paperTradingEnabled IS NOT — it defaults TRUE", () => {
    // The single most dangerous misreading available here. Absence is the state
    // of every tenant who never touched the setting, so treating it as a live
    // request would grant the whole fleet consent nobody gave — the original
    // defect, rebuilt inside its own migration.
    return planLiveIntentBackfill({
      settings: store({ [BOB]: { strategy: "even-keel" } }),
      db: db([]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.grant, []);
      assert.deepEqual(plan.leaveDefault, [BOB]);
    });
  });
});

describe("what must never count as consent", () => {
  it("HAVING MONEY IS NOT ASKING TO SPEND IT", () => {
    // Asserted through the query itself: the plan is built from the trade tape
    // and nothing else, and `db()` above fails the test if a balance is ever
    // consulted. Funding implying consent is the bug; it must not reappear here.
    return planLiveIntentBackfill({
      settings: store({ [BOB]: { paperTradingEnabled: true, paperStartUsdg: 100000 } }),
      db: db([]),
      agentIdOf: identity,
    }).then((plan) => assert.deepEqual(plan.grant, []));
  });

  it("and neither is holding a mainnet grant", () => {
    // Signing a permission is not asking to use it. Nothing in the inputs here
    // is a chain id, which is the point.
    return planLiveIntentBackfill({
      settings: store({ [BOB]: {} }),
      db: db([]),
      agentIdOf: identity,
    }).then((plan) => assert.deepEqual(plan.leaveDefault, [BOB]));
  });
});

describe("it only ever grants", () => {
  it("a tenant who already set the field is left exactly as they set it", () => {
    return planLiveIntentBackfill({
      settings: store({
        [ALICE]: { liveTradingEnabled: false },
        [CAROL]: { liveTradingEnabled: true },
      }),
      // Alice HAS traded for real, and still must not be overwritten: her own
      // answer outranks our inference about her.
      db: db([[ALICE, "landed"]]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.grant, []);
      assert.equal(plan.alreadySet.length, 2);
      assert.deepEqual(
        plan.alreadySet.find((a) => a.tenant === ALICE),
        { tenant: ALICE, value: false },
      );
    });
  });

  it("and nothing in the writer can produce a false", async () => {
    const s = store({ [ALICE]: { strategy: "even-keel" } });
    const plan: BackfillPlan = {
      grant: [{ tenant: ALICE, reason: "has-traded-for-real" }],
      leaveDefault: [],
      alreadySet: [],
      unreadable: [],
    };
    const out = await applyLiveIntentBackfill(plan, s);
    assert.deepEqual(out.written, [ALICE]);
    assert.equal(s.written[ALICE]!.liveTradingEnabled, true);
    // And it preserved everything else it found.
    assert.equal(s.written[ALICE]!.strategy, "even-keel");
  });

  it("the owner's own answer wins if they set it between plan and apply", async () => {
    // The report is read by a human, so minutes pass. In them an owner may
    // decide for themselves, and a migration that stomped that would be taking
    // the decision back off them.
    const s = store({ [ALICE]: { liveTradingEnabled: false } });
    const plan: BackfillPlan = {
      grant: [{ tenant: ALICE, reason: "has-traded-for-real" }],
      leaveDefault: [],
      alreadySet: [],
      unreadable: [],
    };
    const out = await applyLiveIntentBackfill(plan, s);
    assert.deepEqual(out.written, []);
    assert.match(out.skipped[0]!.why, /owner set it themselves/);
  });
});

describe("failures are reported, never guessed at", () => {
  it("an unreadable tenant is skipped and named, not counted as either answer", () => {
    return planLiveIntentBackfill({
      settings: store({ [ALICE]: {}, [DAVE]: {} }, DAVE),
      db: db([]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.unreadable, [DAVE]);
      assert.ok(!plan.grant.some((g) => g.tenant === DAVE));
      assert.ok(!plan.leaveDefault.includes(DAVE));
    });
  });

  it("one tenant's write failure does not abandon the rest", async () => {
    // A migration that stopped at the first error leaves the fleet split across
    // two contracts with nobody knowing where the line falls.
    const s = store({ [ALICE]: {}, [BOB]: {} });
    const boom: SettingsStoreLike = {
      ...s,
      async put(tenant, settings) {
        if (tenant === ALICE) throw new Error("write conflict");
        return s.put(tenant, settings);
      },
    };
    const out = await applyLiveIntentBackfill(
      {
        grant: [
          { tenant: ALICE, reason: "has-traded-for-real" },
          { tenant: BOB, reason: "has-traded-for-real" },
        ],
        leaveDefault: [],
        alreadySet: [],
        unreadable: [],
      },
      boom,
    );
    assert.deepEqual(out.written, [BOB], "the second tenant still got migrated");
    assert.equal(out.skipped.length, 1);
    assert.match(out.skipped[0]!.why, /write conflict/);
  });

  it("a tenant with no agent id is never matched by accident", () => {
    // `agentIdOf` returning null means "we cannot say which account this is".
    // Matching it against the tape anyway would grant consent on a coincidence.
    return planLiveIntentBackfill({
      settings: store({ [ALICE]: {} }),
      db: db([[ALICE, "landed"]]),
      agentIdOf: () => null,
    }).then((plan) => {
      assert.deepEqual(plan.grant, []);
      assert.deepEqual(plan.leaveDefault, [ALICE]);
    });
  });
});

describe("running it twice changes nothing the second time", () => {
  it("IS IDEMPOTENT — the apply writes the field, so the next plan is empty", async () => {
    const s = store({ [ALICE]: { paperTradingEnabled: true } });
    const first = await planLiveIntentBackfill({
      settings: s,
      db: db([[ALICE, "landed"]]),
      agentIdOf: identity,
    });
    assert.equal(first.grant.length, 1);
    await applyLiveIntentBackfill(first, s);

    const second = await planLiveIntentBackfill({
      settings: s,
      db: db([[ALICE, "landed"]]),
      agentIdOf: identity,
    });
    assert.deepEqual(second.grant, [], "nothing left to do");
    assert.deepEqual(second.alreadySet, [{ tenant: ALICE, value: true }]);
  });
});

/**
 * THE GAP THE FIRST REPORT FOUND, and the reason report-before-apply exists.
 *
 * The dry run printed "46 tenant(s) have a grant with an account" and then a
 * plan covering 39 — because it walked the settings store alone, and a tenant
 * who has never saved a setting has no row there. Seven accounts with live
 * grants were invisible to the migration. Any of them that trades for real
 * would have fallen to the `false` default when the gate came into force and
 * stopped trading, with nothing anywhere to explain it.
 *
 * Settings-less is not the same as never-asked. The trade tape is the evidence
 * either way.
 */
describe("a tenant with a grant but no settings row is still migrated", () => {
  const ORPHAN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;

  it("IS EVALUATED AT ALL — walking the settings store alone misses it", () => {
    return planLiveIntentBackfill({
      settings: store({}),
      db: db([[ORPHAN, "landed"]]),
      agentIdOf: identity,
      grantTenants: [ORPHAN],
    }).then((plan) => {
      assert.deepEqual(plan.grant, [{ tenant: ORPHAN, reason: "has-traded-for-real" }]);
    });
  });

  it("and one that has NOT traded is still left on Paper", () => {
    // The union widens who is looked at, never what counts as consent.
    return planLiveIntentBackfill({
      settings: store({}),
      db: db([[ORPHAN, "paper"]]),
      agentIdOf: identity,
      grantTenants: [ORPHAN],
    }).then((plan) => {
      assert.deepEqual(plan.grant, []);
      assert.deepEqual(plan.leaveDefault, [ORPHAN]);
    });
  });

  it("APPLYING IT CREATES THE ROW, carrying only the flag", () => {
    // Every other setting keeps falling through to its default, exactly as it
    // did while the row was absent.
    const s = store({});
    return applyLiveIntentBackfill(
      { grant: [{ tenant: ORPHAN, reason: "has-traded-for-real" }], leaveDefault: [], alreadySet: [], unreadable: [] },
      s,
    ).then((out) => {
      assert.deepEqual(out.written, [ORPHAN]);
      assert.deepEqual(s.written[ORPHAN], { liveTradingEnabled: true });
    });
  });

  it("and a tenant in BOTH lists is counted once", () => {
    return planLiveIntentBackfill({
      settings: store({ [ALICE]: {} }),
      db: db([[ALICE, "landed"]]),
      agentIdOf: identity,
      grantTenants: [ALICE],
    }).then((plan) => {
      assert.equal(plan.grant.length + plan.leaveDefault.length + plan.alreadySet.length, 1);
    });
  });

  it("and the orchestrator actually passes the grant tenants", () => {
    // The plan accepts them optionally so every existing caller is unchanged —
    // which means the one caller that matters has to opt in explicitly.
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    assert.match(orch, /grantTenants: \[\.\.\.ids\.keys\(\)\]/);
  });
});

/**
 * A FAILING LIVE TRADER IS STILL A LIVE TRADER.
 *
 * The first apply ran with `IN ('landed', 'submitted')`, which reads an owner
 * whose orders all REVERTED as one who never traded. `index.ts:6803` draws the
 * line on `onChain`, not on success — a reverted op reached the chain and spent
 * gas — so that owner had consented in the only way the migration accepts, and
 * would have been moved to paper for the crime of having bad luck.
 */
describe("a real order that failed is still a real order", () => {
  it("A REVERTED ORDER IS CONSENT — it reached the chain and spent gas", () => {
    return planLiveIntentBackfill({
      settings: store({ [ALICE]: { paperTradingEnabled: true } }),
      db: db([[ALICE, "reverted"]]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.grant, [{ tenant: ALICE, reason: "has-traded-for-real" }]);
      assert.deepEqual(plan.leaveDefault, [], "a reverted trader must not be left on paper");
    });
  });

  it("but a REJECTED order is not — it never left the box", () => {
    // The other half, and the reason this is not just "widen the filter":
    // `rejected` is a pre-flight refusal. Counting it would fabricate consent
    // from an order we ourselves declined to send, which is the original defect
    // rebuilt inside its own fix.
    return planLiveIntentBackfill({
      settings: store({ [BOB]: {} }),
      db: db([[BOB, "rejected"]]),
      agentIdOf: identity,
    }).then((plan) => {
      assert.deepEqual(plan.grant, []);
      assert.deepEqual(plan.leaveDefault, [BOB]);
    });
  });

  it("and every status the ledger declares is classified on purpose", () => {
    /**
     * THE DRIFT GUARD. `TradeRow.status` is a closed union in store.ts, and this
     * module's WHERE clause is a hand-written subset of it. Nothing connects the
     * two, so a sixth status added later — one that means "real money moved" —
     * would join the ledger and silently fail to count as consent, which is the
     * exact bug this describe block exists because of.
     *
     * So: read the union from store.ts, read the IN-list from the query, and
     * require every member to be in one or the other. A new status lands in
     * neither and fails here, with the author forced to say which it is.
     */
    const src = readFileSync(path.join(__dirname, "store.ts"), "utf8");
    const union = src.match(/status: ("(?:landed|reverted|rejected|paper|submitted)"(?:\s*\|\s*"[a-z-]+")*);/);
    assert.ok(union, "could not find TradeRow.status in store.ts — the guard cannot run");
    const declared = [...union[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    assert.ok(declared.length >= 5, `expected the full ledger union, got ${declared.join(", ")}`);

    const mod = readFileSync(path.join(__dirname, "backfill-live-intent.ts"), "utf8");
    const where = mod.match(/WHERE status IN \(([^)]*)\)/);
    assert.ok(where, "the evidence query must still filter on status");
    const counted = [...where[1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);

    /** Deliberately NOT evidence, each with the reason it is not. */
    const excluded: Record<string, string> = {
      paper: "the simulator — counting it would grant the whole fleet consent",
      rejected: "a pre-flight refusal; index.ts:6803 writes it when !onChain",
    };

    for (const status of declared) {
      const isCounted = counted.includes(status);
      const isExcluded = status in excluded;
      assert.ok(
        isCounted !== isExcluded,
        `trade status '${status}' is neither counted as consent nor explicitly excluded. ` +
          `Decide which it is: add it to the WHERE clause in backfill-live-intent.ts, ` +
          `or to 'excluded' here with the reason it does not mean real money moved.`,
      );
    }
    assert.deepEqual(counted.sort(), ["landed", "reverted", "submitted"]);
  });
});
