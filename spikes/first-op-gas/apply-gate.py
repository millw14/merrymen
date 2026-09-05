import io, shutil, sys

ROOT = "C:/Users/1/Documents/milla projects/merrymen"
SRC = ROOT + "/worker/src/executor.ts"
DST = ROOT + "/spikes/first-op-gas/executor.patched.ts"
shutil.copyfile(SRC, DST)
s = io.open(DST, encoding="utf8", newline="").read()

# ---- EDIT 1: the gate ----
old = """      // WHICH CEILING, DECIDED BEFORE THE ESTIMATE because the override is sized
      // from it. Both conditions are required: the account has never operated,
      // AND the operation proves out of its own nonce that it carries a
      // permission-validator enable. Undeployed alone is not enough - that is a
      // fact about an address, and every other shape an undeployed account could
      // send gets the ordinary ceiling.
      const accountLive = await isDeployed();
      const nonce = await account.getNonce();
      const firstEnable = !accountLive && isFirstEnable(nonce);
      const bounds = firstEnable ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS;
""".replace(" - that is", " \u2014 that is")

new = """      // ── WHICH CEILING, AND WHY IT IS ASKED OF THE OPERATION ────────────
      //
      // DECIDED BEFORE THE ESTIMATE, because the balance override above is sized
      // from it. That ordering is also why this cannot be salvaged by retrying at
      // a wider ceiling after a refusal: the 3,000,000 branch hands the simulation
      // ~6.07M gas of imaginary ETH for an operation needing ~7.5M, so the estimate
      // does not come back absurd @ it does not come back at all, and the owner is
      // told `gas-unreadable` with no number in it.
      //
      // THIS USED TO READ `!accountLive && isFirstEnable(nonce)`, on the belief
      // that a permission-validator enable is one-time per ACCOUNT. It is one-time
      // per SESSION KEY. The enable installs a permissionId, and the permissionId
      // is keccak over (policies, flag, signer) truncated to 4 bytes @ so a new
      // session key is a new id, and so is the SAME key re-signed one second later,
      // because buildWallPolicies bakes `now` into the timestamp policy
      // (packages/core/src/wall.ts). Every renewal therefore arrives as an enable on
      // an account that already has code, and `!accountLive` refused all of them.
      //
      // MEASURED ON 4663, 2026-09-03 @ a fresh 18-permission wall pinned to real
      // already-deployed Kernel v3.3 accounts, no factory, no initCode:
      //   0x032Da6A0!  verif 7,240,052 . preVerif 239,988 . call 50,180 = 7,530,220
      //   0xa48cE91e!  verif 7,111,512 . preVerif 240,001 . call 50,180 = 7,401,693
      //   synthetic    verif 7,279,603 . preVerif 240,042 . call 50,180 = 7,569,825
      // against the undeployed first op's 7,711,654. Deployment is 1.8%–4.0% of the
      // operation and the enable is the other 96%: callGasLimit is 50,180 in EVERY
      // arm, and preVerificationGas moves by ~3,400 @ the calldata price of the
      // ~320 factory bytes that are no longer there. So `!accountLive` was never a
      // second condition. It was a false negative on every renewal, routing a
      // ~9.5M-bounded operation at the 3,000,000 ceiling.
      //
      // NOTHING IS LOST BY REMOVING IT, because the nonce is the better latch and
      // the chain @ not this process @ holds it. Kernel answers mode DEFAULT the
      // instant that permissionId is installed, so the wide ceiling is reachable
      // exactly once per (account, permissionId) and every trade the key signs
      // afterwards gets GAS_BOUNDS. Verified against four live accounts whose
      // validators had landed: installed id gives mode 0x00, a bogus id on the same
      // account gives mode 0x01, so the read is genuinely per-(account, id) rather than
      // a rubber stamp on any deployed address. `!accountLive` never bounded anyone
      // who meant harm either @ a fresh owner key is a fresh undeployed address, so
      // it was always one rotation away from being no condition at all.
      //
      // THE ONE WAY TO FORGE AN ENABLE NONCE ON A LIVE ACCOUNT is a failed
      // permissionConfig read: both disjuncts of the SDK's isPluginEnabled catch to
      // false, so a flaky eth_call falls TOWARD enable. That operation is refused by
      // the chain rather than by us @ measured AA23 (0xc48cf8ee) under BOTH ceilings,
      // because Kernel will not re-install an occupied permissionId @ so widening the
      // ceiling admits nothing there that could ever be signed.
      const nonce = await account.getNonce();
      const firstEnable = isFirstEnable(nonce);
      const bounds = firstEnable ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS;
      // READ FOR THE LOG LINE, AND DELIBERATELY AFTER THE DECISION IT NO LONGER
      // TAKES PART IN. `deployed + enable` is a renewal and `NOT deployed + enable`
      // is a first arm @ the one thing a person reading [gas] wants to know and
      // cannot recover from the numbers, which are within 3% of each other.
      const accountLive = await isDeployed();
"""

# ---- EDIT 2: isDeployed docstring ----
old2 = """   * Asked here rather than passed in, because the answer CHANGES and the caller
   * reads it once at arm: an `accountDeployed: false` threaded down from arm
   * time would still say false for every later op of that arm, leaving them all
   * under the wide first-enable ceiling. That is a guard turning itself off
   * silently.
   *
   * One read, memoised, and only on the first execute of a process that has an
   * executor at all. A FAILED READ ANSWERS "not deployed", which is the safe
   * direction here and the opposite of the rule elsewhere in this repo: being
   * wrong that way widens a pre-sign ceiling for one operation, while being
   * wrong the other way refuses the operation outright.
   *
   * And since Stage E this answer is no longer sufficient on its own. The wide
   * ceiling needs BOTH this and isFirstEnable(nonce) @ so a failed read cannot
   * widen anything by itself; the operation still has to prove out of its own
   * nonce that it carries a permission-validator enable. FIRST_ENABLE_GAS_BOUNDS
   * remains a ceiling either way, not an exemption.
   */"""
new2 = """   * Asked here rather than passed in, because the answer CHANGES and the caller
   * reads it once at arm: an `accountDeployed: false` threaded down from arm
   * time would still say false for every later op of that arm.
   *
   * A LABEL NOW, NOT A GUARD. It used to be half of the first-enable gate, and
   * that was the defect: a permission-validator enable is one-time per SESSION
   * KEY, so every renewal is an enable on an account that already has code, and
   * requiring `!accountLive` refused every one of them at 3,000,000. The ceiling
   * is chosen by the operation's own nonce alone; this answers only the question
   * the [gas] line asks @ was that enable a first arm or a renewal.
   *
   * Still one read, still memoised, and a failed read still answers "not
   * deployed". The stakes of both are now a word in a log line. Nothing branches
   * on it, so nothing it gets wrong can widen or narrow a ceiling.
   */"""

# ---- EDIT 3: log line ----
old3 = """          `${firstEnable ? "FIRST-ENABLE" : "ordinary"} ceiling ${bounds.absoluteMax} . ` +"""
new3 = """          `${firstEnable ? (accountLive ? "RENEWAL-ENABLE" : "FIRST-ENABLE") : "ordinary"} ` +
          `ceiling ${bounds.absoluteMax} . ` +"""

# ---- EDIT 4: retirement comment ----
old4 = """      // Whatever happens to this op from here @ landed, reverted, unresolved @
      // the bundler accepted it, so the account is deployed or is being deployed
      // by it. The wide deploy ceiling has done its job and must not apply to the
      // next one; a stale `false` would leave every op of this arm loosely
      // bounded, which is the guard quietly turning itself off.
      deployed = true;"""
new4 = """      // Whatever happens to this op from here @ landed, reverted, unresolved @
      // the bundler accepted it, so the account is deployed or is being deployed
      // by it. THIS NO LONGER RETIRES A CEILING; it keeps the [gas] label honest
      // for the rest of this executor's life, so the next enable is reported as
      // the renewal it is. The ceiling was never this flag's to retire: the enable
      // retires itself on chain, and the next nonce for that permissionId says
      // DEFAULT."""
new4 = new4 + "\n      deployed = true;"

EM = "\u2014"
MID = "\u00b7"
ELL = "\u2026"


def fix(t):
    t = t.replace(chr(10), chr(13) + chr(10))
    return t.replace("@", EM).replace(" . ", " " + MID + " ").replace("!  verif", ELL + "  verif")


edits = [(fix(old), fix(new)), (fix(old2), fix(new2)), (fix(old3), fix(new3)), (fix(old4), fix(new4))]
for i, (o, n) in enumerate(edits, 1):
    if o not in s:
        print("EDIT %d NOT FOUND. Looking for:\n%r" % (i, o[:200]))
        sys.exit(1)
    s = s.replace(o, n, 1)

io.open(DST, "w", encoding="utf8", newline="").write(s)
print("patched OK ->", DST)
