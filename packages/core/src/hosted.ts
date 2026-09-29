/**
 * Hosted mode — the single switch that turns merrymen from a self-hosted
 * single-tenant tool into a multi-tenant service on a public URL.
 *
 * ONE FLAG, read from ONE place, because the two modes have OPPOSITE threat
 * models and every fund-safety decision downstream branches on which one is
 * true. Self-hosted: one user, one machine, the owner key is theirs and the
 * localhost host-guard is the whole perimeter. Hosted: many users on a public
 * domain, the server holds session keys for real accounts, and the perimeter
 * is wallet-native auth on every mutating route.
 *
 * Defaults to SELF-HOSTED (false) — the safe default, and what every existing
 * install already is. Hosted mode is opt-in via MERRYMEN_HOSTED, so no
 * self-hosted user can accidentally trip into the multi-tenant code paths.
 */
export function isHostedMode(): boolean {
  const v = (process.env.MERRYMEN_HOSTED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The server secret that signs session cookies and challenge nonces.
 *
 * REQUIRED in hosted mode and returned as null otherwise. A missing secret in
 * hosted mode is a boot-time refusal, never a silent fallback to a default —
 * a predictable signing key is a forgeable session for every tenant.
 */
export function sessionSecret(): string | null {
  const s = process.env.MERRYMEN_SESSION_SECRET;
  if (typeof s === "string" && s.length >= 32) return s;
  return null;
}

/** A 32-byte (64 hex char) private key, with or without the 0x. */
const RAW_KEY = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/;

/**
 * Does this object carry FUND-CUSTODY material that must never reach a hosted
 * server?
 *
 * THE ONE DEFINITION, shared by the grant API (which rejects such payloads) and
 * the boot check (which refuses to start if any stored grant holds one). In
 * hosted mode the server holds only the capped, revocable SESSION key; the OWNER
 * key — sudo over the account, the root of custody — stays in the browser. This
 * catches the named field (`demoOwnerPrivateKey`) AND any raw 32-byte key or
 * BIP-39-length mnemonic hiding anywhere in the payload, so a renamed field or a
 * nested blob can't smuggle one past.
 *
 * `demoSessionPrivateKey` is deliberately NOT flagged: the worker needs the
 * session key to act, and the wall makes a leaked one value-churn, never theft.
 */
export function carriesOwnerKey(obj: unknown): boolean {
  if (obj == null) return false;
  if (typeof obj === "object" && "demoOwnerPrivateKey" in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>).demoOwnerPrivateKey;
    if (typeof v === "string" && v.length > 0) return true;
  }
  // Scan the serialized JSON for a raw key or a mnemonic, but EXEMPT the one
  // field that legitimately holds a 64-hex value — the session key — so its
  // presence alone doesn't trip the guard.
  let json: string;
  try {
    json = JSON.stringify(obj, (k, val) => (k === "demoSessionPrivateKey" ? undefined : val));
  } catch {
    return false;
  }
  if (RAW_KEY.test(json)) return true;
  // A 12/15/18/21/24-word lowercase mnemonic — the other shape of an owner key.
  if (/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/.test(json)) return true;
  return false;
}

/**
 * Exactly 80 hex characters (0x optional) bounded by non-hex: the shape of a
 * Lighter API key, public OR private — both halves are 40 bytes. Bounded so a
 * 130-hex binding signature or a longer run never reads as one, the same way
 * RAW_KEY above is bounded at 64.
 */
const RAW_PERP_KEY = /(?:^|[^0-9a-fA-F])(?:0x)?[0-9a-fA-F]{80}(?:[^0-9a-fA-F]|$)/;

/** Field names that can only mean "a private key", compared without case, `_` or `-`. */
const PERP_SECRET_NAMES: ReadonlySet<string> = new Set(["apiprivatekey", "privatekey"]);

/**
 * Does this object carry a LIGHTER API PRIVATE KEY in the clear?
 *
 * docs/perps.md rule 5: a grant carries `perp = { route, apiKeyIndex,
 * apiPublicKey, apiKeySealed? }` and nothing else — the private key lives in a
 * 0600 file (self-hosted) or only as `apiKeySealed`, DEK ciphertext bound to
 * tenant|account|pubkey|index (hosted). So a stored or submitted grant that
 * holds one anywhere else is a bug or an attack, and this is the one
 * definition the grant intake, the grant store's put, and its boot/read check
 * share.
 *
 * TWO TESTS, because a key can hide two ways:
 *   BY NAME   a field called `apiPrivateKey` or `privateKey` (any case, any
 *             depth), whatever it holds — nothing in a grant may be called
 *             that, so its presence alone is the finding.
 *   BY SHAPE  an 80-hex run anywhere, EXCEPT the one place a grant
 *             legitimately holds one: the top-level `perp.apiPublicKey`.
 *             Exempted by position, not by name — a field named
 *             `apiPublicKey` anywhere else is scanned like any other, because
 *             both halves are 80 hex and nothing but position tells a public
 *             key from a private one.
 *
 * `apiKeySealed` is base64url ciphertext and passes; `demoSessionPrivateKey`
 * (64 hex) is carriesOwnerKey's business, not this one's. An object that
 * cannot be serialized to scan is treated as carrying one: a secret check that
 * cannot look is not a pass.
 */
export function carriesPerpPrivateKey(obj: unknown): boolean {
  if (obj == null) return false;
  let view: unknown = obj;
  if (typeof obj === "object" && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    if (typeof o.perp === "object" && o.perp !== null && !Array.isArray(o.perp)) {
      const { apiPublicKey: _public, ...perpRest } = o.perp as Record<string, unknown>;
      void _public;
      view = { ...o, perp: perpRest };
    }
  }
  let named = false;
  let json: string | undefined;
  try {
    json = JSON.stringify(view, (k, v) => {
      if (k !== "" && v !== undefined && PERP_SECRET_NAMES.has(k.toLowerCase().replace(/[_-]/g, ""))) named = true;
      return v;
    });
  } catch {
    return true;
  }
  if (named) return true;
  return RAW_PERP_KEY.test(json ?? "");
}

/**
 * The boot/read-time twin of assertNoOwnerKeysAtRest for the Lighter key: in
 * hosted mode, refuse to go on while ANY stored grant record carries a
 * plaintext API private key. Run it over the grants AS WRITTEN (a store
 * record's `grant`, whose top-level `perp.apiPublicKey` is the one exempt
 * 80-hex value), never over grants a store has rebuilt — the rebuild is where
 * secrets are joined back in. Inert off hosted mode, like its twin.
 */
export function assertNoPerpKeysAtRest(grants: readonly unknown[]): void {
  if (!isHostedMode()) return;
  const offenders = grants.filter(carriesPerpPrivateKey).length;
  if (offenders > 0) {
    throw new Error(
      `hosted mode refuses to go on: ${offenders} stored grant(s) carry a plaintext Lighter API private key. ` +
        `The key is kept only as DEK ciphertext (perp.apiKeySealed) — purge them before booting.`,
    );
  }
}

/**
 * A boot-time refusal: in hosted mode, if ANY grant at rest carries an owner
 * key, throw rather than start.
 *
 * The custody boundary is only as good as the weakest thing that ever wrote a
 * grant. This is the backstop for a grant that predates the boundary, a manual
 * import, or a future bug: hosted mode simply will not run while a custody key
 * sits in its store. Call it at startup over every stored grant.
 */
export function assertNoOwnerKeysAtRest(grants: readonly unknown[]): void {
  if (!isHostedMode()) return;
  const offenders = grants.filter(carriesOwnerKey).length;
  if (offenders > 0) {
    throw new Error(
      `hosted mode refuses to start: ${offenders} stored grant(s) carry an owner key. ` +
        `A hosted server must never hold fund-custody keys — purge them before booting.`,
    );
  }
}
