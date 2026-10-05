import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync,
  realpathSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/grant";
import { PgGrantStore } from "./grant-store";
import { sealSecret } from "./store-crypto";
import { HOSTED_GRANT_CACHE_MAX_BYTES, scrubHostedGrantCache, type HostedGrantCacheOptions } from "./hosted-grant-cache";

const NOW = 1_800_000_000;
// Disposable deterministic fixture keys only; no real authority is read by this suite.
const OLD_KEY = `0x${"ab".repeat(32)}` as `0x${string}`;
const NEW_KEY = `0x${"27".repeat(32)}` as `0x${string}`;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const TENANT = "0x00000000000000000000000000000000000000b1" as const;
const hash = (key: string) => createHash("sha256").update(Buffer.from(key.slice(2), "hex")).digest("hex");
const grant = (expiresAt: number, key = OLD_KEY): StoredGrant => ({
  smartAccount: ACCOUNT, owner: TENANT, chainId: 4663,
  sessionKeyAddress: privateKeyToAccount(key).address, demoSessionPrivateKey: key,
  serialized: Buffer.from(JSON.stringify({ key })).toString("base64"),
  grantedAt: NOW - 100, expiresAt,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 1, maxOpsPerDay: 50 },
} as StoredGrant);
const opts = (extra: Partial<HostedGrantCacheOptions> = {}): HostedGrantCacheOptions => ({
  hosted: true, writerAbsent: true, nowSec: NOW, ...extra,
});
function fixture(t: TestContext, cached = grant(NOW - 1)) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-hosted-cache-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "grant.json");
  writeFileSync(file, JSON.stringify(cached), { mode: 0o600 });
  mkdirSync(path.join(home, "soul"));
  const protectedFiles = new Map([
    ["merrymen.db", Buffer.from("original ledger fixture")],
    ["soul/OWNER.md", Buffer.from("private owner memory fixture")],
    ["settings.json", Buffer.from("private configuration fixture")],
    ["ledger-source-blocked.json", Buffer.from("durable accounting barrier fixture")],
  ]);
  for (const [name, bytes] of protectedFiles) writeFileSync(path.join(home, name), bytes);
  const retained = () => {
    for (const [name, bytes] of protectedFiles) assert.ok(readFileSync(path.join(home, name)).equals(bytes), `${name} is retained`);
    assert.equal(existsSync(path.join(home, "grants")), false, "no key archive is created");
  };
  return { home, file, retained };
}
const sanitized = (error: unknown): boolean => error instanceof Error
  && error.message === "Hosted grant cache cleanup refused; retain the home and retry after verifying authority and file ownership.";

test("cold inactive home: removes cache at the exact expiry boundary, preserving book, memory and barriers", t => {
  const f = fixture(t, grant(NOW));
  assert.equal(scrubHostedGrantCache(f.home, grant(NOW), opts()), true);
  assert.equal(existsSync(f.file), false);
  assert.equal(scrubHostedGrantCache(f.home, grant(NOW), opts()), false, "cleanup retry is idempotent");
  f.retained();
});

test("confirmed removal scrubs an otherwise unexpired hosted key without needing a process or lease", t => {
  const f = fixture(t, grant(NOW + 100));
  assert.equal(scrubHostedGrantCache(f.home, null, opts()), true);
  assert.equal(existsSync(f.file), false);
  f.retained();
});

test("self-hosted homes and a home owned by any writer retain their key", t => {
  const f = fixture(t);
  const original = readFileSync(f.file);
  assert.equal(scrubHostedGrantCache(f.home, null, opts({ hosted: false })), false);
  assert.equal(scrubHostedGrantCache(f.home, null, opts({ writerAbsent: false })), false);
  assert.ok(readFileSync(f.file).equals(original));
  f.retained();
});

test("a freshly fetched newer PgGrantStore authority preserves even an older expired cache", async t => {
  const f = fixture(t);
  const original = readFileSync(f.file);
  const saved = process.env.MERRYMEN_STORE_DEK;
  const dek = Buffer.alloc(32, 31);
  process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
  t.after(() => { if (saved === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = saved; });
  const newer = grant(NOW + 100, NEW_KEY);
  const { demoSessionPrivateKey, ...publicGrant } = newer;
  let selects = 0;
  // Exercise the real PgGrantStore decoder with a stand-in connection, never a live database.
  const store = new PgGrantStore("test-only-no-network", async () => ({
    query: async (sql: string, params?: unknown[]) => {
      if (/^CREATE TABLE/.test(sql.trim())) return { rows: [] };
      assert.match(sql, /^SELECT tenant, chain_id, grant_json, sealed_session_key, updated_at FROM grants/);
      assert.deepEqual(params, [TENANT]);
      selects++;
      return { rows: [{ tenant: TENANT, chain_id: 4663, grant_json: publicGrant,
        sealed_session_key: sealSecret(demoSessionPrivateKey!, dek), updated_at: NOW }] };
    },
  }));
  const current = await store.get(TENANT);
  assert.ok(current);
  assert.equal(scrubHostedGrantCache(f.home, current, opts()), false);
  assert.equal(selects, 1);
  assert.ok(readFileSync(f.file).equals(original));
  f.retained();
});

test("an active newer local cache is retained when expired authority has no actual-key fence", t => {
  const f = fixture(t, grant(NOW + 100, NEW_KEY));
  const original = readFileSync(f.file);
  assert.equal(scrubHostedGrantCache(f.home, grant(NOW - 100), opts()), false);
  assert.ok(readFileSync(f.file).equals(original));
});

test("replacement stop recognizes the actual cached key bytes despite case and forged public metadata", t => {
  const cached = { ...grant(NOW + 100, `0x${OLD_KEY.slice(2).toUpperCase()}`),
    sessionKeyAddress: privateKeyToAccount(NEW_KEY).address };
  const f = fixture(t, cached);
  assert.equal(scrubHostedGrantCache(f.home, { expiresAt: 0, replacementStop: {
    sessionKeyHash: hash(OLD_KEY), sessionKeyAddress: privateKeyToAccount(OLD_KEY).address,
  } }, opts()), true);
  assert.equal(existsSync(f.file), false);
  f.retained();
});

test("a public address cannot substitute for the stopped actual key", t => {
  const f = fixture(t, { ...grant(NOW + 100, NEW_KEY), sessionKeyAddress: privateKeyToAccount(OLD_KEY).address });
  assert.equal(scrubHostedGrantCache(f.home, { expiresAt: 0, replacementStop: {
    sessionKeyHash: hash(OLD_KEY), sessionKeyAddress: privateKeyToAccount(OLD_KEY).address,
  } }, opts()), false);
  assert.equal(existsSync(f.file), true);
});

test("retired actual-key fence scrubs a stopped cache, but a mismatched stop address does not", t => {
  const f = fixture(t, grant(NOW + 100));
  assert.equal(scrubHostedGrantCache(f.home, { expiresAt: 0, replacementStop: {
    sessionKeyHash: hash(OLD_KEY), sessionKeyAddress: privateKeyToAccount(NEW_KEY).address,
  } }, opts()), false);
  assert.equal(scrubHostedGrantCache(f.home, { expiresAt: 0, retiredSessionKeyHashes: [hash(OLD_KEY)] }, opts()), true);
  f.retained();
});

test("a file replaced immediately before unlink is never removed", t => {
  const f = fixture(t);
  const replacement = path.join(f.home, "fresh-grant.tmp");
  const fresh = JSON.stringify(grant(NOW + 100, NEW_KEY));
  assert.throws(() => scrubHostedGrantCache(f.home, null, opts({ beforeFinalCheckForTest: () => {
    writeFileSync(replacement, fresh, { mode: 0o600 });
    renameSync(replacement, f.file);
  } })), sanitized);
  assert.equal(readFileSync(f.file, "utf8"), fresh);
  f.retained();
});

test("same-inode cache mutation is refused even when replacement has equal size", t => {
  const f = fixture(t);
  const fresh = JSON.stringify(grant(NOW + 1, NEW_KEY));
  assert.equal(Buffer.byteLength(fresh), readFileSync(f.file).length);
  assert.throws(() => scrubHostedGrantCache(f.home, null, opts({ beforeFinalCheckForTest: () => {
    writeFileSync(f.file, fresh);
    utimesSync(f.file, new Date(0), new Date(0));
  } })), sanitized);
  assert.equal(readFileSync(f.file, "utf8"), fresh);
});

test("a symlink cache or home cannot cause foreign keys to be read or removed", t => {
  const f = fixture(t);
  const foreign = path.join(f.home, "foreign.json");
  const original = readFileSync(f.file);
  writeFileSync(foreign, original);
  rmSync(f.file); symlinkSync(foreign, f.file);
  assert.throws(() => scrubHostedGrantCache(f.home, null, opts()), sanitized);
  assert.ok(readFileSync(foreign).equals(original));
  const alias = path.join(f.home, "alias");
  symlinkSync(f.home, alias, "dir");
  assert.throws(() => scrubHostedGrantCache(alias, null, opts()), sanitized);
  f.retained();
});

test("a symlink ancestor cannot hide a foreign plain home and key cache", t => {
  const f = fixture(t);
  const foreignRoot = path.join(f.home, "foreign-homes"), foreignHome = path.join(foreignRoot, "tenant");
  mkdirSync(foreignHome, { recursive: true });
  const contents = readFileSync(f.file);
  writeFileSync(path.join(foreignHome, "grant.json"), contents);
  const alias = path.join(f.home, "homes-alias");
  symlinkSync(foreignRoot, alias, "dir");
  assert.throws(() => scrubHostedGrantCache(path.join(alias, "tenant"), null, opts()), sanitized);
  assert.ok(readFileSync(path.join(foreignHome, "grant.json")).equals(contents));
  assert.ok(readFileSync(f.file).equals(contents));
});

test("malformed, oversized and owner-key caches refuse with a fixed sanitized error", t => {
  const f = fixture(t);
  for (const contents of [
    `invalid-json-${OLD_KEY}`,
    "x".repeat(HOSTED_GRANT_CACHE_MAX_BYTES + 1),
    JSON.stringify({ ...grant(NOW - 1), demoOwnerPrivateKey: NEW_KEY }),
  ]) {
    writeFileSync(f.file, contents);
    assert.throws(() => scrubHostedGrantCache(f.home, null, opts()), sanitized);
    assert.equal(readFileSync(f.file, "utf8"), contents);
  }
  f.retained();
});

test("unlink failure retains every file and never propagates sensitive error contents", t => {
  const f = fixture(t);
  const original = readFileSync(f.file);
  assert.throws(() => scrubHostedGrantCache(f.home, null, opts({ unlinkForTest: () => {
    throw new Error(`${OLD_KEY} ${f.file} ${grant(NOW - 1).serialized}`);
  } })), sanitized);
  assert.ok(readFileSync(f.file).equals(original));
  f.retained();
});

test("unreadable authority or malformed stop fences do not establish obsolescence", t => {
  const f = fixture(t);
  assert.throws(() => scrubHostedGrantCache(f.home, { expiresAt: NaN }, opts()), sanitized);
  assert.throws(() => scrubHostedGrantCache(f.home, { expiresAt: 0, retiredSessionKeyHashes: ["unverified"] }, opts()), sanitized);
  assert.equal(existsSync(f.file), true);
});
