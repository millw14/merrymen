# The patch — NOT APPLIED (this task is read-only on worker/)

Three files change. Everything below is copied from `spikes/first-op-gas/gate-v2.ts`,
which is the runnable version and which `spikes/first-op-gas/gate-v2-measure.ts`
exercises against chain 4663.

---

## 1. `worker/src/gas-limits.ts` — add the sized ceiling next to the flat one

Keep `GAS_BOUNDS` and `FIRST_ENABLE_GAS_BOUNDS` exactly as they are. `FIRST_ENABLE_GAS_BOUNDS.absoluteMax`
stops being the ceiling a first enable receives and becomes the **cap on the ceiling it can earn**,
which is what its own derivation comment already argues it is.

```ts
/**
 * THE CEILING AN ENABLE EARNS FROM ITS OWN PAYLOAD.
 *
 * FIRST_ENABLE_GAS_BOUNDS.absoluteMax is the ceiling for the LARGEST wall
 * merrymen will sign. Handing it to every enable regardless of the wall actually
 * carried means a 4-permission grant walks around with 9,000,000 gas of
 * authority it can never use. That is not a bound in the sense this file cares
 * about; it is the absence of one, up to a number.
 *
 * The sizing input is the ENABLE BLOB'S BYTE LENGTH, and that choice is the
 * point: the blob is fixed before the estimate is requested, it is the literal
 * payload Kernel installs during validation, and it cannot be inflated without
 * also inflating the estimate it is bounding. A tenant who adds custom tokens
 * grows the blob and grows their own ceiling — up to the cap, and no further.
 *
 * MEASURED, Pimlico on 4663, 2026-09-03, against the REAL deployed Kernel v3.3
 * account 0x032Da6A0Ccf866474e45854E7fDEF9afd1509036 with no factory
 * (spikes/first-op-gas/gate-v2-measure.ts, section 2):
 *
 *   perms  blob B      verif   preVerif   call        RAW    bounded
 *       1    1,940  1,109,681     81,728  50,180  1,241,589  1,589,621
 *       2    2,388  1,396,425     89,613  50,180  1,536,218  1,957,907
 *       4    3,284  1,960,023    105,383  50,180  2,115,586  2,682,116
 *       8    5,076  3,097,109    136,922  50,180  3,284,211  4,142,898
 *      18   10,932  7,240,052    239,988  50,180  7,530,220  9,450,410
 *
 * Least squares: raw ≈ -169,701 + 700.945 × blobBytes. Worst residual 4.14%, at
 * the 1-permission wall, where the fit UNDER-predicts — the direction the safety
 * factor exists for. The intercept is negative and that is not a modelling
 * error: the cost is dominated by per-policy cold SSTOREs that scale with the
 * payload, and the line is only evaluated above ENABLE_MIN_BYTES.
 */
export const ENABLE_GAS_FIT = {
  intercept: -169_701n,
  slopeMilliGasPerByte: 700_945n, // slope × 1000, so the constant stays a bigint
  /** 1.20x — 4.8x the worst measured residual. Covers fit error, not named variance. */
  safetyBps: 12_000,
  /**
   * Added when the account has no code yet. The fit was taken with no factory,
   * and a first operation also pays for its own CREATE2 and initCode calldata.
   * Measured: the same wall is 7,711,654 raw UNDEPLOYED against 7,530,220
   * DEPLOYED — 181,434, essentially all of it preVerificationGas for the ~320
   * bytes of factory calldata. 250,000 rounds that up rather than leaning on the
   * safety factor to absorb a cost that is different in kind.
   */
  deployAllowanceRaw: 250_000n,
};

/**
 * Floored at GAS_BOUNDS.absoluteMax so sizing can never make a grant WORSE off
 * than the ordinary ceiling — an enable operation also contains an ordinary
 * call — and capped at FIRST_ENABLE_GAS_BOUNDS.absoluteMax so a pathological
 * blob cannot size its own way past the number this file justified in prose.
 */
export function enableCeilingFor(blobBytes: number, deploying: boolean): bigint {
  const raw =
    ENABLE_GAS_FIT.intercept +
    (ENABLE_GAS_FIT.slopeMilliGasPerByte * BigInt(blobBytes)) / 1_000n +
    (deploying ? ENABLE_GAS_FIT.deployAllowanceRaw : 0n);
  const withSafety = (raw * BigInt(ENABLE_GAS_FIT.safetyBps)) / 10_000n;
  // Same field mix boundGas applies: verification dominates at ~96%, so 1.25x
  // over the whole total, plus the flat (2.0 - 1.25) × 50,180 the call field's
  // own headroom adds.
  const ceiling = (withSafety * 12_500n) / 10_000n + 37_635n;
  if (ceiling < GAS_BOUNDS.absoluteMax) return GAS_BOUNDS.absoluteMax;
  if (ceiling > FIRST_ENABLE_GAS_BOUNDS.absoluteMax) return FIRST_ENABLE_GAS_BOUNDS.absoluteMax;
  return ceiling;
}
```

---

## 2. `worker/src/executor.ts`

### 2a. `isFirstEnable` keeps its comment; three readers join it

```ts
/** Bytes 2..5 of the nonce: the 4-byte permission id, LEFT-aligned in the
 *  20-byte identifier field. Verified against landed calldata — tx 0x323e8050…
 *  carries identifier 0x3ca1cec8000…0 and this returns 0x3ca1cec8.
 *
 *  GETTING THIS OFFSET WRONG IS SILENT AND TOTAL. Shifting by 224 instead of 208
 *  returns the mode and vType bytes glued to two bytes of the id (0x0102986f);
 *  the chain read below then asks about an id no operation will ever present,
 *  finds it empty, and answers "not installed" for every operation forever. A
 *  gate condition that always passes is not a gate condition. Caught by
 *  spikes/first-op-gas/gate-v2-measure.ts on its first run. */
export const noncePermissionId = (nonce: bigint): `0x${string}` =>
  `0x${(((nonce >> 208n) & 0xffffffffn).toString(16)).padStart(8, "0")}`;

/** The EntryPoint's own counter for this key — the ONE part of a nonce that is
 *  not computed locally by the SDK. */
export const nonceSequence = (nonce: bigint): bigint => nonce & 0xffff_ffff_ffff_ffffn;

/** A permission validator's ordinary stub signature is the session key's bare
 *  65-byte ECDSA stub. An ENABLE stub is the encoded plugins blob and measures
 *  1,940 bytes for a 1-permission wall and 10,932 for merrymen's 18-permission
 *  one (measured). 512 sits ~4x below the smallest enable and ~8x above a bare
 *  signature: it is a shape check, not a size check. */
const ENABLE_MIN_BYTES = 512;
```

### 2b. the new refusal rule, alongside GasRefused's existing vocabulary

`worker/src/gas-limits.ts` `GasVerdict["rule"]` gains `"enable-unverified"`, and
`index.ts` needs no change — it already books any `GasRefused` as a rejected trade
with `reject_rule: e.rule`.

### 2c. `permissionIdInstalled` — the one read the SDK does not make

```ts
/**
 * Is this permission id already occupied on this account?
 *
 * `true` / `false` are answers. `null` is "I could not read it", and the caller
 * MUST NOT treat it as `false`. That distinction is the entire reason this
 * exists rather than reusing the SDK's `isPluginEnabled`, which is
 *
 *   (await regular.isEnabled(...)) || (await isPluginInitialized(...))
 *
 * where `isEnabled` wraps its readContract in `catch { return false }`
 * (toPermissionValidator.ts:137-156) and `isPluginInitialized` is called with
 * `address: zeroAddress` (toPermissionValidator.ts:86) so it ALWAYS throws and is
 * ALWAYS caught to false (isPluginInitialized.ts:11-23). Both disjuncts collapse
 * to false on any error, so the SDK's answer FAILS TOWARD ENABLE — toward the
 * wide ceiling. Measured: with a fault injected on this one eth_call, a live
 * account with an INSTALLED permission id went from mode 0x00 with a 66-byte
 * signature to mode 0x01 with a 10,932-byte enable blob. A ceiling decision must
 * not inherit that failure direction.
 *
 * STRICTER THAN THE SDK ON PURPOSE: the SDK asks "is the stored signer MY signer
 * contract"; this asks "is there ANY signer stored". An id occupied by someone
 * else's signer is one Kernel will not install over (AA23 0xc48cf8ee, measured),
 * so treating it as occupied refuses an operation that could not have succeeded.
 */
async function permissionIdInstalled(
  account: Address,
  permissionId: `0x${string}`,
  attempts = 3,
): Promise<boolean | null> {
  // THE CODELESS CASE FIRST, AND THIS IS WHERE `accountLive` EARNS ITS KEEP.
  // An account with no code cannot have a permission id installed: there is no
  // storage and no implementation. `eth_call` to a codeless address SUCCEEDS
  // with empty returndata (verified on 4663 against 0x…0c0de5), so the parse
  // below cannot tell that apart from a malformed reply — and a first
  // deploy+enable IS a codeless account. Without this branch the undeployed
  // first op PR #56 was written for is refused as `enable-unverified`.
  //
  // NOTE THE INVERTED FAILURE DIRECTION relative to the old isDeployed(), which
  // answered "not deployed" when getCode threw. Here a failed read must be
  // UNREAD, because "no code" is now a REASON TO WIDEN rather than a fact we
  // merely log. Today a failed getCode is the only thing that lets a renewal
  // through; under this gate it refuses the operation and says why.
  let code: `0x${string}` | undefined;
  try {
    code = await publicClient.getCode({ address: account });
  } catch {
    return null;
  }
  if (code === undefined || code === "0x") return false;

  const data = `0xc3e58978${permissionId.slice(2).padEnd(64, "0")}` as `0x${string}`;
  for (let i = 0; i < attempts; i++) {
    try {
      const { data: hex } = await publicClient.call({ to: account, data });
      // struct PermissionConfig { bytes2 flag; address signer; bytes22[] policyData }
      // returned as word0 = offset, word1 = flag, word2 = signer, …
      if (typeof hex !== "string" || hex.length < 2 + 3 * 64) {
        if (i === attempts - 1) return null;
        continue;
      }
      return `0x${hex.slice(154, 194)}`.toLowerCase() !== "0x" + "0".repeat(40);
    } catch {
      if (i === attempts - 1) return null;
      await new Promise((s) => setTimeout(s, 150 * 2 ** i));
    }
  }
  return null;
}
```

### 2d. the call site — replace lines 383-392

```diff
-      // WHICH CEILING, DECIDED BEFORE THE ESTIMATE because the override is sized
-      // from it. Both conditions are required: the account has never operated,
-      // AND the operation proves out of its own nonce that it carries a
-      // permission-validator enable. Undeployed alone is not enough — that is a
-      // fact about an address, and every other shape an undeployed account could
-      // send gets the ordinary ceiling.
-      const accountLive = await isDeployed();
-      const nonce = await account.getNonce();
-      const firstEnable = !accountLive && isFirstEnable(nonce);
-      const bounds = firstEnable ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS;
+      // WHICH CEILING, DECIDED BEFORE THE ESTIMATE because the override is sized
+      // from it.
+      //
+      // `!accountLive` IS GONE FROM THE DECISION. It is a fact about an ADDRESS,
+      // and the ~7.4M it was admitting is a fact about a PERMISSION ID: the
+      // enable is installed lazily by the first op of each SESSION KEY, so a
+      // renewal on a funded, already-operating account carries the identical
+      // cost while `!accountLive` is false. Measured on this chain, against the
+      // real live account 0x032Da6A0…: raw 7,530,220, bounded 9,450,410, versus
+      // a 3,000,000 ceiling. Every renewal merrymen ships was refused.
+      //
+      // It also bought nothing. The strongest bound `!accountLive` can give is
+      // "one elevated operation per address", and a fresh address costs an
+      // attacker one generatePrivateKey(). C2 and C4 below give the SAME bound
+      // on the right key — once per (account, permissionId) — without excluding
+      // a single honest renewal.
+      //
+      // FOUR CONDITIONS, ALL REQUIRED, each able only to NARROW:
+      //   C1 the nonce is mode 0x01 / vType 0x02          (unchanged)
+      //   C2 the nonce SEQUENCE is 0                      (the EntryPoint's word, not ours)
+      //   C3 an enable blob is genuinely ATTACHED          (a later, second read than C1)
+      //   C4 our OWN chain read says the id is free        (fails CLOSED, unlike the SDK's)
+      // and the ceiling is then SIZED from the blob rather than flat.
+      const accountLive = await isDeployed();   // logged, never decided on
+      const nonce = await account.getNonce();
+      const stub = await account.getStubSignature({
+        sender: account.address, nonce, callData,
+        callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
+        maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: "0x",
+        ...(await account.getFactoryArgs()),
+      } as never);
+      const decision = await chooseGasCeiling({ nonce, stub, accountLive });
+      if (decision.kind === "refuse") {
+        // BEFORE the estimate, so the opaque path is never entered.
+        throw new GasRefused(decision.rule, decision.detail);
+      }
+      const firstEnable = decision.kind === "elevated";
+      const bounds = decision.bounds;
```

and the `[gas]` log line gains the evidence, which is what makes this diagnosable
from a transcript instead of from decoded calldata:

```diff
       console.log(
         `[gas] account ${accountLive ? "deployed" : "NOT deployed"} · ` +
-          `${firstEnable ? "FIRST-ENABLE" : "ordinary"} ceiling ${bounds.absoluteMax} · ` +
+          `${firstEnable ? "FIRST-ENABLE" : "ordinary"} ceiling ${bounds.absoluteMax} · ` +
+          `${decision.why} · ` +
           `estimate1 ${fmt(first)} · estimate2 ${fmt(second)} · ` +
```

### 2e. `deployed` stops being memoised as `false`

`deployed = true` after a landed send stays — it is a monotone latch toward
"has code", and latching it true only ever forces a real chain read. What must
go is the memoised **false**, which under the new gate would keep answering
"no code" for an account that has since deployed and hand every later enable the
deployment allowance. One read per `execute()` on the enable path only; the
ordinary path (C1 false) never reaches it.

---

## 3. `worker/src/gas-limits.test.ts` — the pin has to move, not weaken

Lines 335-353 currently assert the old expression by regex. Replacing the regex
with a looser one would let the change "pass" without re-deriving anything, so
the replacement asserts MORE than the original did:

```ts
test("THE CALL SITE: the elevated ceiling needs all four conditions", () => {
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  // The conjunct that broke every renewal must be gone, and gone from the
  // DECISION specifically — the read itself stays, for the log line.
  assert.doesNotMatch(src, /!accountLive && isFirstEnable\(/, "the address-keyed conjunct is gone");
  assert.match(src, /await isDeployed\(\)/, "the deploy state is still read and logged");
  assert.match(src, /accountLive.*logged, never decided on/, "and is documented as not deciding");
  // All four conditions are present at the call site.
  assert.match(src, /isFirstEnable\(nonce\)/, "C1 shape");
  assert.match(src, /nonceSequence\(nonce\) !== 0n/, "C2 first-op-of-this-key");
  assert.match(src, /ENABLE_MIN_BYTES/, "C3 the blob is attached");
  assert.match(src, /permissionIdInstalled\(/, "C4 the chain read");
  // C4 fails CLOSED. `installed === null` must produce a refusal, never a
  // silent narrowing into the 3M branch's undersized simulation override.
  assert.match(src, /installed === null/, "an unread answer is handled explicitly");
  assert.match(src, /enable-unverified/, "and refuses by name");
  // The ceiling is sized, and 12,000,000 is its cap rather than its value.
  assert.match(src, /enableCeilingFor\(/, "C5 sizing");
  assert.doesNotMatch(src, /DEPLOY_GAS_BOUNDS/, "the undeployed-only ceiling is still gone");
  assert.match(src, /deployed = true;/, "a landed send still retires the deploy allowance");
});

test("the sized ceiling admits every measured wall and no more", () => {
  // The five points measured on 4663 against a real deployed account
  // (spikes/first-op-gas/gate-v2-measure.ts section 2), as bounded totals.
  for (const [blobBytes, boundedTotal] of [
    [1_940, 1_589_621n], [2_388, 1_957_907n], [3_284, 2_682_116n],
    [5_076, 4_142_898n], [10_932, 9_450_410n],
  ] as const) {
    const ceiling = enableCeilingFor(blobBytes, false);
    assert.ok(boundedTotal <= ceiling, `${blobBytes}B: ${boundedTotal} must fit under ${ceiling}`);
    assert.ok(ceiling <= FIRST_ENABLE_GAS_BOUNDS.absoluteMax, "never above the cap");
    assert.ok(ceiling >= GAS_BOUNDS.absoluteMax, "never below the ordinary ceiling");
  }
  // A 4-permission grant must NOT carry an 18-permission grant's authority.
  assert.ok(enableCeilingFor(3_284, false) < 4_000_000n, "a small wall earns a small ceiling");
});
```
