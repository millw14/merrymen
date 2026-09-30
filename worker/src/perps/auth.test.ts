/**
 * THE AUTH TOKEN CACHE — one token per (account, key), minted at now + 7 h,
 * minted again 30 minutes before its deadline, refreshed exactly once when
 * the venue refuses a read for its auth, and never carried by an error.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/perps";
import type { LighterApiError, LighterResult } from "./api";
import {
  AUTH_TOKEN_LIFETIME_SEC,
  AUTH_TOKEN_REFRESH_BEFORE_SEC,
  AuthTokenUnavailable,
  createLighterAuth,
  isLighterAuthError,
  type AuthTokenMinter,
} from "./auth";
import { AUTH_TOKEN_MAX_SEC, instantiateSigner } from "./signer";

const ACCOUNT = 22149;
const KEY = LIGHTER_ROUTE_V1.apiKeyIndex;
const T0 = 1_790_700_000_000;

/** A minter that records every deadline it was asked for and returns a token-shaped string. */
function minter(account = ACCOUNT, key = KEY) {
  const deadlines: number[] = [];
  const m: AuthTokenMinter & { deadlines: number[]; fail: boolean } = {
    accountIndex: account,
    apiKeyIndex: key,
    deadlines,
    fail: false,
    createAuthToken(deadlineSec: number) {
      if (m.fail) throw new Error(`signer died holding ${deadlineSec}:${account}:${key}:${"cd".repeat(80)}`);
      deadlines.push(deadlineSec);
      return `${deadlineSec}:${account}:${key}:${deadlines.length.toString(16).padStart(160, "0")}`;
    },
  };
  return m;
}

const ok = <T,>(value: T): LighterResult<T> => ({ ok: true, value, serverDateMs: null });
const refused = (status: number, detail: string): LighterResult<never> => ({
  ok: false,
  error: { kind: "rejected", status, code: 20001, retryable: false, detail },
  serverDateMs: null,
});

describe("the token's life", () => {
  it("is minted at now + 7 h and reused until 30 minutes before that deadline", () => {
    let clock = T0;
    const m = minter();
    const auth = createLighterAuth({ client: m, now: () => clock });
    const t1 = auth.token();
    assert.deepEqual(m.deadlines, [Math.floor(T0 / 1000) + AUTH_TOKEN_LIFETIME_SEC]);
    assert.ok(AUTH_TOKEN_LIFETIME_SEC < AUTH_TOKEN_MAX_SEC, "an hour inside the venue's 8 h ceiling");
    assert.equal(auth.expiresAtSec(), m.deadlines[0]);
    clock += (AUTH_TOKEN_LIFETIME_SEC - AUTH_TOKEN_REFRESH_BEFORE_SEC) * 1000 - 1000;
    assert.equal(auth.token(), t1, "still more than 30 minutes left");
    clock += 1000;
    const t2 = auth.token();
    assert.notEqual(t2, t1, "30 minutes before the deadline it is minted again");
    assert.equal(m.deadlines.length, 2);
    assert.equal(m.deadlines[1], Math.floor(clock / 1000) + AUTH_TOKEN_LIFETIME_SEC);
  });

  it("the real signer mints a token for this (account, key) with a deadline no later than now + 7 h", async () => {
    const clock = T0;
    const signer = await instantiateSigner({ now: () => clock });
    const k = signer.generateApiKey();
    const client = signer.createClient({ accountIndex: ACCOUNT, apiKeyIndex: KEY, privateKey: k.privateKey, apiPublicKey: k.publicKey });
    const auth = createLighterAuth({ client, now: () => clock });
    const [deadline, account, key, sig] = auth.token().split(":");
    assert.equal(Number(deadline), Math.floor(T0 / 1000) + 7 * 3600);
    assert.equal(Number(account), ACCOUNT);
    assert.equal(Number(key), KEY);
    assert.match(sig ?? "", /^[0-9a-f]{160}$/);
  });
});

describe("an auth refusal", () => {
  it("forces ONE refresh and one retry — a second refusal is the answer", async () => {
    const m = minter();
    const auth = createLighterAuth({ client: m, now: () => T0 });
    const used: string[] = [];
    const answers = [refused(401, "GET /api/v1/account → HTTP 401 with no venue code"), ok("account")];
    const r = await auth.withAuth(async (t) => {
      used.push(t);
      return answers.shift() ?? ok("never");
    });
    assert.deepEqual(r, ok("account"));
    assert.equal(used.length, 2);
    assert.notEqual(used[0], used[1], "the retry carries a freshly minted token");
    assert.equal(m.deadlines.length, 2);

    // Refused twice: two reads, two mints, never a third.
    const always = await auth.withAuth(async (t) => {
      used.push(t);
      return refused(400, "GET /api/v1/trades → HTTP 400 code 20001: auth required for main accounts");
    });
    assert.equal(always.ok, false);
    assert.equal(used.length, 4);
    assert.equal(m.deadlines.length, 3);
  });

  it("from concurrent reads that used the same token refreshes it once between them", async () => {
    const m = minter();
    const auth = createLighterAuth({ client: m, now: () => T0 });
    const stale = auth.token();
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    const read = async (t: string) => {
      if (t === stale) {
        await opened;
        return refused(403, "GET /api/v1/account → HTTP 403 with no venue code");
      }
      return ok(t);
    };
    const both = Promise.all([auth.withAuth(read), auth.withAuth(read)]);
    gate();
    const [a, b] = await both;
    assert.ok(a.ok && b.ok);
    assert.equal(m.deadlines.length, 2, "one token for the first read, ONE refresh for both refusals");
    assert.equal(a.ok && b.ok && a.value === b.value, true);
  });

  it("is not a rate limit, a missing tx or an ordinary refusal — those never mint", async () => {
    const m = minter();
    const auth = createLighterAuth({ client: m, now: () => T0 });
    const others: LighterApiError[] = [
      { kind: "rate-limited", source: "venue", status: 429, retryAfterMs: 60_000, retryable: true, detail: "GET /api/v1/account → HTTP 429 (Lighter rate limit)" },
      { kind: "not-found", status: 400, code: 21500, retryable: false, detail: "GET /api/v1/tx → transaction not found" },
      { kind: "rejected", status: 400, code: 20001, retryable: false, detail: "GET /api/v1/fundings → HTTP 400 code 20001: invalid param" },
      { kind: "unavailable", status: 503, retryable: true, detail: "GET /api/v1/account → HTTP 503" },
    ];
    for (const e of others) {
      assert.equal(isLighterAuthError(e), false, e.detail);
      const r = await auth.withAuth(async () => ({ ok: false, error: e, serverDateMs: null }) as LighterResult<never>);
      assert.equal(r.ok, false);
    }
    assert.equal(m.deadlines.length, 1);
    for (const detail of [
      "GET /api/v1/trades → HTTP 400 code 20001: auth query param and Authorization header are empty",
      "GET /api/v1/account → code 20013: invalid token",
      "GET /api/v1/account → HTTP 400 code 29500: Authorization expired",
    ]) {
      assert.equal(isLighterAuthError({ kind: "rejected", status: 400, code: 20001, retryable: false, detail }), true, detail);
    }
    assert.equal(isLighterAuthError({ kind: "unavailable", status: 401, retryable: true, detail: "GET /api/v1/account → HTTP 401 with no venue code" }), true);
  });
});

describe("the cache is one (account, key)'s, and never tells", () => {
  it("refuses a client getter that switches account; a rebuilt client for the same pair mints anew", () => {
    let current = minter();
    const auth = createLighterAuth({ client: () => current, now: () => T0 });
    auth.token();
    const old = current;
    current = minter();
    auth.token();
    assert.equal(old.deadlines.length, 1);
    assert.equal(current.deadlines.length, 1, "a new handle (a rebuilt signer, a rotated key) is not trusted with the old token");
    current = minter(ACCOUNT + 1);
    assert.throws(() => auth.token(), (e: unknown) => e instanceof AuthTokenUnavailable && /account 22149 key 16/.test(e.message));
  });

  it("an error from minting carries neither the token nor anything the signer echoed", () => {
    const m = minter();
    const auth = createLighterAuth({ client: m, now: () => T0 });
    const good = auth.token();
    auth.invalidate();
    m.fail = true;
    assert.throws(
      () => auth.token(),
      (e: unknown) => e instanceof AuthTokenUnavailable && !e.message.includes("cd".repeat(20)) && !e.message.includes(good) && !/\d{9,11}:\d+:\d+:/.test(e.message),
    );
    assert.equal(JSON.stringify(auth).includes(good), false, "the token lives in a closure, not on the object");
  });
});
