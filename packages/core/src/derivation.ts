/**
 * A DERIVED ACCOUNT ADDRESS IS A RESULT, NOT A STRING.
 *
 * The counterfactual Kernel address is the single fact the hosted custody
 * boundary rests on: `web/src/app/api/grants/route.ts` proves a tenant owns the
 * account it claims by re-deriving the address from the owner and requiring the
 * two to be equal. That check is only as good as the derivation under it, and
 * the derivation has a failure mode that returns a value instead of throwing.
 *
 * WHAT GOES WRONG. `createKernelAccount` does not compute the address offline —
 * it asks the EntryPoint, via `getSenderAddress`, which is a live eth_call. When
 * that answers the zero address the SDK retries against the bare factory, and if
 * THAT also answers zero it restores `useMetaFactory` and carries on with
 * `accountAddress = 0x0000...0000`, throwing nothing
 * (@zerodev/sdk/accounts/kernel/createKernelAccount.ts:540-551). So a chain
 * whose factory is missing, an RPC that returns a malformed result, or a
 * transient node fault all produce the zero address and present as a SUCCESSFUL
 * derivation.
 *
 * WHY THAT IS WORSE THAN AN ERROR. The route's guard is an equality test. If the
 * browser derived zero and the server also derived zero — same chain, same
 * absent factory, same fault — the two agree, `session.ts`'s own
 * plugin-does-not-move-the-address assertion passes trivially because both sides
 * are zero, and a grant is sealed for the zero address. A fail-closed 503 cannot
 * fire, because nothing failed. The check does not merely miss the fault; the
 * fault makes it pass.
 *
 * SO THE ZERO ADDRESS IS NOT AN ADDRESS HERE. `derivationOf` refuses it, along
 * with anything that is not 20 hex bytes, and `accountsMatch` refuses to compare
 * a derivation that failed. Two failures can never be "equal": there is no code
 * path on which a caller holds two `Derivation` values and gets `true` without
 * both being real addresses. That is the property, and it is enforced by the
 * types rather than by everyone remembering to check.
 *
 * PURE. No RPC, no viem, no chain. Imported by the browser signer, the hosted
 * intake, the recovery ticket and the worker.
 */

/**
 * The address that means "we did not derive anything".
 *
 * Written out rather than imported from viem so this module stays dependency-
 * free and so the constant is greppable — the whole point is that this value
 * must never travel as a smart account.
 */
export const UNDERIVED_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Exactly 20 hex bytes, either case. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Why a derivation produced nothing usable. Each arm is a different remedy:
 * `unreachable` is retried, `zero` means the factory is absent on that chain,
 * `malformed` means the provider answered something that is not an address.
 */
export type DerivationFailure = "zero" | "malformed" | "unreachable";

export type Derivation =
  | { ok: true; address: `0x${string}` }
  | { ok: false; failure: DerivationFailure; why: string };

/**
 * Read whatever the SDK handed back as a derivation result.
 *
 * The zero address is checked BEFORE the shape, because zero is a well-formed
 * address and would otherwise pass every syntactic test there is.
 */
export function derivationOf(value: unknown): Derivation {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    return {
      ok: false,
      failure: "malformed",
      why: "the account derivation did not return an address",
    };
  }
  if (value.toLowerCase() === UNDERIVED_ADDRESS) {
    return {
      ok: false,
      failure: "zero",
      why:
        "the account derivation returned the zero address, which means the Kernel factory " +
        "did not answer on this chain — it is not an account",
    };
  }
  return { ok: true, address: value.toLowerCase() as `0x${string}` };
}

/** A derivation that could not be attempted at all. */
export function derivationUnreachable(detail: string): Derivation {
  return {
    ok: false,
    failure: "unreachable",
    why: `the account derivation could not be verified: ${detail}`.slice(0, 300),
  };
}

export type AccountMatch = { ok: true } | { ok: false; why: string };

/**
 * Does a claimed smart account equal a derived one?
 *
 * TAKES THE RESULT, NOT THE ADDRESS, on purpose. The interesting bug is not
 * "the addresses differed" — it is "both sides failed identically and their
 * failures compared equal". A caller cannot reach the comparison without
 * holding a successful derivation, so that bug has nowhere to live.
 */
export function accountsMatch(derived: Derivation, claimed: unknown): AccountMatch {
  if (!derived.ok) return { ok: false, why: derived.why };
  const other = derivationOf(claimed);
  if (!other.ok) {
    return {
      ok: false,
      why: `the claimed smart account is not usable: ${other.why}`,
    };
  }
  if (other.address !== derived.address) {
    return { ok: false, why: "this smart account does not derive from the signed-in wallet" };
  }
  return { ok: true };
}

/**
 * Refuse an address that a signer is about to seal into a grant.
 *
 * The browser derives its own account rather than asking the server, so the
 * same zero has to be refused there — and it has to be refused BEFORE the
 * sudo-only / sudo+wall comparison at web/src/lib/session.ts, which two zeros
 * would otherwise satisfy.
 */
export function assertDerivedAccount(value: unknown, what: string): `0x${string}` {
  const d = derivationOf(value);
  if (!d.ok) throw new Error(`refusing to continue: ${what} — ${d.why}`);
  return d.address;
}
