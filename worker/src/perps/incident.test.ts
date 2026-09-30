/**
 * RULE 16 — every trigger, and the flag's durability.
 *
 * The reads are the fixtures' own (fixtures/synthetic.apikeys.json and
 * synthetic.accountsByL1Address.json, parsed by the real markets.ts parsers),
 * varied one fact at a time, so each test says exactly which venue fact made
 * the incident. The store is a two-function fake: the flag's contract is
 * "set before any response, cleared only by the owner", which is about the
 * order of calls, not about SQL (reconcile.test.ts runs it on the real store).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { PerpIncident } from "../store";
import { clearIncident, detectIncidents, incidentReadGaps, persistIncident, type IncidentInputs, type IncidentStore } from "./incident";
import { parseAccountsByL1Address, parseApiKeys, type ApiKeyRead, type L1Accounts } from "./markets";

const FIX = path.join(import.meta.dirname, "fixtures");
const KEYS = parseApiKeys(JSON.parse(readFileSync(path.join(FIX, "synthetic.apikeys.json"), "utf8")))!;
const L1S = parseAccountsByL1Address(JSON.parse(readFileSync(path.join(FIX, "synthetic.accountsByL1Address.json"), "utf8")))!;
const OURS = KEYS[0]!;
const SEALED = OURS.publicKey.toUpperCase().replace(/^0X/, "0x"); // any case: the comparison is canonical
const MASTER = OURS.accountIndex; // 22149
const KEY = OURS.apiKeyIndex; // 16
const NEXT = OURS.nonce; // 1790694494082: the venue's next nonce for our key

function inputs(over: Partial<IncidentInputs> = {}): IncidentInputs {
  return {
    sealedPubKey: SEALED,
    apiKeyIndex: KEY,
    masterIndex: MASTER,
    apikeysRead: KEYS,
    accountsByL1Read: L1S,
    highWater: BigInt(NEXT) - 1n,
    venueNonceForOurKey: NEXT,
    nonceJudged: true,
    nonceRecorded: true,
    unknownFills: 0,
    unknownOrders: 0,
    deltaMismatch: false,
    nowSec: 1_790_700_000,
    ...over,
  };
}

const kinds = (i: IncidentInputs) => detectIncidents(i)?.detail.triggers.map((t) => t.kind) ?? [];

describe("detectIncidents: nothing we did not sign, nothing to say", () => {
  it("the fixtures' account — our key at our index, our master alone, our nonces — is no incident", () => {
    assert.equal(detectIncidents(inputs()), null);
    assert.deepEqual(incidentReadGaps(inputs()), []);
  });
});

describe("(a) a nonce on our key we did not sign", () => {
  it("the venue's last nonce above our high-water is foreign", () => {
    const inc = detectIncidents(inputs({ highWater: BigInt(NEXT) - 100n }));
    assert.equal(inc?.kind, "nonce-foreign");
    assert.match(inc!.detail.triggers[0]!.evidence, /1790694494081/);
  });
  it("a used key with no high-water at all is foreign", () => {
    assert.deepEqual(kinds(inputs({ highWater: null })), ["nonce-foreign"]);
  });
  it("inside our range but held by no row of ours is foreign; held by one is not", () => {
    assert.deepEqual(kinds(inputs({ highWater: BigInt(NEXT) + 50n, nonceRecorded: false })), ["nonce-foreign"]);
    assert.deepEqual(kinds(inputs({ highWater: BigInt(NEXT) + 50n, nonceRecorded: true })), []);
    // Not checked (null) is not "not recorded".
    assert.deepEqual(kinds(inputs({ highWater: BigInt(NEXT) + 50n, nonceRecorded: null })), []);
  });
  it("before the continuity baseline (a wiped ledger's lost nonces were ours) it is not judged", () => {
    assert.equal(detectIncidents(inputs({ highWater: null, nonceJudged: false })), null);
    assert.deepEqual(incidentReadGaps(inputs({ venueNonceForOurKey: null, nonceJudged: false })), []);
  });
  it("a key that has signed nothing (next nonce 0 or 1) is not foreign", () => {
    assert.equal(detectIncidents(inputs({ venueNonceForOurKey: 1, highWater: null })), null);
    assert.equal(detectIncidents(inputs({ venueNonceForOurKey: 0, highWater: null })), null);
  });
});

describe("(b) the keys on our account", () => {
  it("another public key at our index is a mismatch", () => {
    const other: ApiKeyRead = { ...OURS, publicKey: `0x${"02".repeat(40)}` };
    const inc = detectIncidents(inputs({ apikeysRead: [other] }));
    assert.equal(inc?.kind, "pubkey-mismatch");
    // Evidence names the key by its first bytes only.
    assert.equal(inc!.detail.triggers[0]!.evidence.includes("02".repeat(40)), false);
  });
  it("unless a journaled recover retired the sealed key: then the owner rotated it on purpose", () => {
    const other: ApiKeyRead = { ...OURS, publicKey: `0x${"02".repeat(40)}` };
    assert.equal(detectIncidents(inputs({ apikeysRead: [other], sealedRetired: true })), null);
  });
  it("any other key index registered on our account is an incident", () => {
    const extra: ApiKeyRead = { accountIndex: MASTER, apiKeyIndex: 3, nonce: 5, publicKey: `0x${"03".repeat(40)}` };
    assert.deepEqual(kinds(inputs({ apikeysRead: [...KEYS, extra] })), ["extra-api-key"]);
  });
  it("no key at our index yet (before registration) is not an incident", () => {
    assert.equal(detectIncidents(inputs({ apikeysRead: [], venueNonceForOurKey: 0, highWater: null })), null);
  });
});

describe("(c) accounts under our L1 address", () => {
  it("a sub-account beside the master is an incident", () => {
    const withSub: L1Accounts = { ...L1S, accounts: [...L1S.accounts, { accountIndex: 281_474_976_710_200, accountType: 1, collateralMicro: 5_000_000n }] };
    const inc = detectIncidents(inputs({ accountsByL1Read: withSub }));
    assert.equal(inc?.kind, "extra-account");
    assert.match(inc!.detail.triggers[0]!.evidence, /281474976710200/);
  });
  it("a list that runs past one page is more than the one account we own", () => {
    assert.deepEqual(kinds(inputs({ accountsByL1Read: { ...L1S, nextCursor: "abc" } })), ["extra-account"]);
  });
});

describe("(d) orders and fills that are nobody's we know, and (e) money nobody explains", () => {
  it("an unknown fill or order is an incident", () => {
    assert.deepEqual(kinds(inputs({ unknownFills: 1 })), ["unknown-activity"]);
    assert.deepEqual(kinds(inputs({ unknownOrders: 2 })), ["unknown-activity"]);
  });
  it("a persistent venue-delta mismatch is an incident", () => {
    assert.deepEqual(kinds(inputs({ deltaMismatch: true })), ["venue-money-unexplained"]);
  });
  it("every trigger is reported, most specific first, and the flag's kind is the first", () => {
    const inc = detectIncidents(inputs({ deltaMismatch: true, unknownFills: 1, highWater: 1n }));
    assert.deepEqual(inc?.detail.triggers.map((t) => t.kind), ["nonce-foreign", "unknown-activity", "venue-money-unexplained"]);
    assert.equal(inc?.kind, "nonce-foreign");
    assert.equal(inc?.at, 1_790_700_000);
  });
});

describe("unread is a gap, never a pass (rule 11)", () => {
  it("unread keys, accounts or nonce: no trigger from them, and each is a gap", () => {
    const i = inputs({ apikeysRead: null, accountsByL1Read: null, venueNonceForOurKey: null });
    assert.equal(detectIncidents(i), null);
    const gaps = incidentReadGaps(i);
    assert.equal(gaps.length, 3);
  });
  it("an L1 list that does not show our own account is not an answer about us", () => {
    const gaps = incidentReadGaps(inputs({ accountsByL1Read: { ...L1S, accounts: [] } }));
    assert.equal(gaps.length, 1);
    assert.match(gaps[0]!, /does not show our account/);
  });
});

// ── the durable flag ────────────────────────────────────────────────────────

function fakeStore(opts: { dropWrites?: boolean } = {}) {
  let flag: PerpIncident | null = null;
  const writes: (PerpIncident | null)[] = [];
  const s: IncidentStore = {
    async getPerpAccount() {
      return { incident: flag };
    },
    async patchPerpAccount(_a, _m, patch) {
      writes.push(patch.incident);
      if (!opts.dropWrites) flag = patch.incident;
    },
  };
  return { s, writes, flag: () => flag };
}

describe("persistIncident / clearIncident", () => {
  const inc = detectIncidents(inputs({ unknownFills: 1 }))!;

  it("sets the flag, reads it back, and never replaces a standing one", async () => {
    const f = fakeStore();
    assert.equal(await persistIncident(f.s, { agentId: "0xabc", incident: inc }), "set");
    assert.equal(f.flag()?.kind, "unknown-activity");
    const later = detectIncidents(inputs({ deltaMismatch: true }))!;
    assert.equal(await persistIncident(f.s, { agentId: "0xabc", incident: later }), "already-set");
    assert.equal(f.flag()?.kind, "unknown-activity", "the first incident's evidence stands");
    assert.equal(f.writes.length, 1);
  });

  it("a write that does not stick throws — the caller must not believe it stored", async () => {
    const f = fakeStore({ dropWrites: true });
    await assert.rejects(persistIncident(f.s, { agentId: "0xabc", incident: inc }), /did not persist/);
  });

  it("clears only once the key at our index is no longer the sealed one", async () => {
    const f = fakeStore();
    await persistIncident(f.s, { agentId: "0xabc", incident: inc });
    await assert.rejects(
      clearIncident(f.s, { agentId: "0xabc", venueKeyNoLongerSealed: true, sealedPubKey: SEALED, keyAtOurIndex: OURS.publicKey }),
      /still the sealed one/,
    );
    await assert.rejects(clearIncident(f.s, { agentId: "0xabc", venueKeyNoLongerSealed: true, sealedPubKey: SEALED, keyAtOurIndex: null }), /not read/);
    assert.equal(f.flag()?.kind, "unknown-activity");
    assert.equal(
      await clearIncident(f.s, { agentId: "0xabc", venueKeyNoLongerSealed: true, sealedPubKey: SEALED, keyAtOurIndex: `0x${"07".repeat(40)}` }),
      "cleared",
    );
    assert.equal(f.flag(), null);
    assert.equal(
      await clearIncident(f.s, { agentId: "0xabc", venueKeyNoLongerSealed: true, sealedPubKey: SEALED, keyAtOurIndex: `0x${"07".repeat(40)}` }),
      "none",
    );
  });
});
