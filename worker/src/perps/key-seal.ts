/**
 * THE HOSTED LIGHTER KEY AT REST: AES-256-GCM under the store DEK, BOUND to
 * whose key it is.
 *
 * docs/perps.md rule 5: hosted, keygen returns the public key plus
 * `AES-256-GCM(DEK, privateKey, AAD = tenant|smartAccount|pubkey|keyIndex)`,
 * and the grant carries only that blob (`perp.apiKeySealed`). This module is
 * the one place that seals and opens it — for the keygen route, POST
 * /api/grants (which proves the blob belongs to this tenant, account and key
 * before storing it), the grant store (which re-proves it at put), and the
 * orchestrator (which opens it into the child's 0600 perp-key.json).
 *
 * WHY THE AAD, when the session key is sealed without one (store-crypto.ts).
 * The session key's ciphertext lives in its own column, keyed by tenant, and
 * nobody but the store moves it. This blob travels: keygen hands it to the
 * signing client, the client puts it in a grant, the grant comes back through
 * a public route. Without a binding, a blob one tenant was issued could be
 * pasted into another tenant's grant — or into this tenant's grant for a
 * DIFFERENT account or key — and it would decrypt fine. The AAD makes the
 * ciphertext mean "this private key, for this tenant's this account's this
 * public key at this index" and nothing else: GCM refuses to open it under any
 * other context. It is also what stands in for derive(priv) == pub, which the
 * vendored signer cannot compute (signer.ts: no public-key derivation export):
 * the only way to get a blob that opens under a public key is for our keygen
 * to have sealed it beside that public key.
 *
 * NO ERROR FROM THIS FILE CARRIES KEY MATERIAL — not the plaintext, not the
 * ciphertext, not a slice of either. Reasons only.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { LIGHTER_ROUTE_V1, validatePerpPubKey } from "../../../packages/core/src/index";

/** Version tag on the blob AND in the AAD: a v2 format can never open as v1. */
const SEAL_PREFIX = "pk1";
const AAD_TAG = "perp-key-v1";
/** pk1.<iv 12 B>.<tag 16 B>.<ciphertext 82 B>, each base64url: the plaintext is always "0x" + 80 hex. */
const SEALED_RE = /^pk1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{110}$/;
const PRIV_RE = /^0x[0-9a-f]{80}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export type PerpKeySealReason = "bad-context" | "malformed" | "unopenable" | "bad-plaintext" | "no-dek";

export class PerpKeySealError extends Error {
  override readonly name = "PerpKeySealError";
  readonly kind = "perp-key-seal" as const;
  constructor(
    readonly reason: PerpKeySealReason,
    message: string,
  ) {
    super(`perp key seal: ${message}`);
  }
}

/** Whose key a sealed blob is. Every field is part of the AAD. */
export interface PerpKeyContext {
  /** The authenticated tenant (the SIWE / Privy-bound wallet), never anything the grant declares. */
  tenant: string;
  smartAccount: string;
  apiPublicKey: string;
  /** Always LIGHTER_ROUTE_V1.apiKeyIndex today; in the AAD so a future index cannot reuse a blob. */
  apiKeyIndex: number;
}

/**
 * The exact AAD string: `perp-key-v1|tenant|smartAccount|pubkey|keyIndex`,
 * every address and key lowercased and canonical. Throws on a context that
 * is not one (an address that is not an address, a non-canonical key, an
 * index other than the route's): a blob sealed under a malformed context is a
 * blob no honest caller can ever open again.
 */
export function perpKeyAad(ctx: PerpKeyContext): string {
  const tenant = typeof ctx?.tenant === "string" && ADDRESS_RE.test(ctx.tenant) ? ctx.tenant.toLowerCase() : null;
  const account = typeof ctx?.smartAccount === "string" && ADDRESS_RE.test(ctx.smartAccount) ? ctx.smartAccount.toLowerCase() : null;
  const pub = typeof ctx?.apiPublicKey === "string" ? validatePerpPubKey(ctx.apiPublicKey) : null;
  if (tenant === null) throw new PerpKeySealError("bad-context", "tenant is not an address");
  if (account === null) throw new PerpKeySealError("bad-context", "smartAccount is not an address");
  if (pub === null) throw new PerpKeySealError("bad-context", "apiPublicKey is not a canonical Lighter API key");
  if (ctx.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
    throw new PerpKeySealError("bad-context", `apiKeyIndex must be the route's ${LIGHTER_ROUTE_V1.apiKeyIndex}`);
  }
  return `${AAD_TAG}|${tenant}|${account}|${pub}|${ctx.apiKeyIndex}`;
}

function dekOf(dek: Buffer | null | undefined): Buffer {
  if (!dek || dek.length !== 32) throw new PerpKeySealError("no-dek", "no 32-byte store DEK (MERRYMEN_STORE_DEK) — a Lighter key is never sealed or opened without one");
  return dek;
}

/** Does this look like a sealed Lighter key (shape only — it proves nothing about who may open it)? */
export function isSealedPerpKey(v: unknown): v is string {
  return typeof v === "string" && SEALED_RE.test(v);
}

/** Seal a Lighter API private key for exactly this context. */
export function sealPerpKey(privateKey: string, ctx: PerpKeyContext, dek: Buffer | null | undefined): string {
  const key = dekOf(dek);
  const priv = typeof privateKey === "string" ? privateKey.toLowerCase() : "";
  if (!PRIV_RE.test(priv) || /^0x0+$/.test(priv)) throw new PerpKeySealError("bad-plaintext", "privateKey must be 0x + 80 hex (value not shown)");
  const aad = perpKeyAad(ctx);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(priv, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEAL_PREFIX}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

/**
 * Open a sealed Lighter key, or throw. A wrong DEK, a flipped byte, or ANY
 * difference in tenant, account, public key or index is `unopenable` — GCM
 * cannot tell them apart and neither do we: each means "not this key's blob".
 */
export function openPerpKey(sealed: string, ctx: PerpKeyContext, dek: Buffer | null | undefined): `0x${string}` {
  const key = dekOf(dek);
  if (!isSealedPerpKey(sealed)) throw new PerpKeySealError("malformed", "not a sealed Lighter key (pk1.iv.tag.ciphertext)");
  const aad = perpKeyAad(ctx);
  const [, ivB, tagB, ctB] = sealed.split(".") as [string, string, string, string];
  let plain: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    plain = Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new PerpKeySealError("unopenable", "the sealed key does not open for this tenant, account and public key under this DEK");
  }
  // Authenticated, so this can only fail on a blob WE sealed wrongly — still
  // refused rather than handed to a signer.
  if (!PRIV_RE.test(plain) || /^0x0+$/.test(plain)) throw new PerpKeySealError("bad-plaintext", "the sealed key opened to something that is not a Lighter private key");
  return plain as `0x${string}`;
}
