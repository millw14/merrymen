/**
 * MAKING A LIGHTER API KEY, and deciding where its private half goes.
 *
 * docs/perps.md rule 5 — signers only ever see the PUBLIC key; the private key
 * has the session key's custody or better. POST /api/perps/keygen is the one
 * caller (web/src/app/api/perps/keygen/route.ts); this is its logic, kept here
 * so it is testable without a Next server and so the route never touches the
 * private key itself:
 *
 *   self-hosted  the pair goes to $MERRYMEN_HOME/perp-keys/<pubkey>.json
 *                (0600, keystore.writePerpKeyFile) and only the public key
 *                comes back. POST /api/grants later refuses a perp block whose
 *                file is not there.
 *   hosted       the pair never touches the web container's disk: the private
 *                key is sealed at once under the store DEK, bound to
 *                (tenant, smartAccount, pubkey, 16) (key-seal.ts), and the
 *                public key comes back WITH that blob. The signing client
 *                carries the blob into the grant; only the orchestrator ever
 *                opens it again, into the child's perp-key.json.
 *
 * WHY THE OFFICIAL SIGNER AND NOTHING ELSE. The key is a Schnorr key over
 * ECgFp5 whose public half the wall seals byte for byte (changePubKey EQUAL w4,
 * w5). A key made any other way is a key we cannot prove the venue will
 * accept; the pinned WASM, hash-checked and known-answer-tested at load
 * (signer.ts), is the only generator we trust — and generateApiKey already
 * refuses a public key that is not canonical (validatePerpPubKey), so a pair
 * the contract would reject never reaches an owner's signature.
 *
 * NOTHING HERE LOGS. The pair lives in local variables for the length of one
 * call; errors name reasons, never bytes.
 */

import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import { writePerpKeyFile, type PerpKeyPair } from "./keystore";
import { PerpKeySealError, sealPerpKey } from "./key-seal";
import { loadSigner, type LighterSigner } from "./signer";

export { openPerpKey, perpKeyAad, PerpKeySealError, sealPerpKey, isSealedPerpKey, type PerpKeyContext } from "./key-seal";

/** What a signer may know about a key: where it sits and its public half. */
export interface PerpKeygenPublic {
  apiPublicKey: `0x${string}`;
  apiKeyIndex: number;
}

/** Hosted adds the sealed private key, which only the orchestrator can open. */
export interface PerpKeygenHosted extends PerpKeygenPublic {
  apiKeySealed: string;
}

/** Injected in tests; the process's lazily-built, KAT-checked signer otherwise. */
export type SignerSource = () => Promise<Pick<LighterSigner, "generateApiKey">>;

/**
 * A fresh pair from the official signer. Throws SignerUnavailable (signer.ts)
 * when the pinned WASM is missing, altered, or failed its known-answer test —
 * the route turns that into a named 503, never a key from anywhere else.
 */
export async function generatePerpKeyPair(source: SignerSource = loadSigner): Promise<PerpKeyPair> {
  const signer = await source();
  const { privateKey, publicKey } = signer.generateApiKey();
  return { privateKey, publicKey };
}

/**
 * SELF-HOSTED: generate, write the 0600 key file, return the public half.
 * The file is written BEFORE the public key is returned, so no owner can seal
 * a key into a wall whose private half was never kept.
 */
export async function selfHostedPerpKeygen(args: { home: string; source?: SignerSource }): Promise<PerpKeygenPublic> {
  const pair = await generatePerpKeyPair(args.source);
  writePerpKeyFile(args.home, pair);
  return { apiPublicKey: pair.publicKey, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex };
}

/**
 * HOSTED: generate, seal for (tenant, smartAccount, pubkey, 16) under the DEK,
 * return the public half and the blob. No DEK is a refusal (PerpKeySealError
 * "no-dek"), checked by sealPerpKey before anything is returned — a hosted
 * server never hands out a key it could not have sealed.
 */
export async function hostedPerpKeygen(args: {
  tenant: `0x${string}`;
  smartAccount: `0x${string}`;
  dek: Buffer | null;
  source?: SignerSource;
}): Promise<PerpKeygenHosted> {
  // Refused BEFORE the signer is built (~70 MB, ~50 ms): a hosted server with
  // no DEK can never seal what it would generate.
  if (!args.dek || args.dek.length !== 32) {
    throw new PerpKeySealError("no-dek", "no 32-byte store DEK (MERRYMEN_STORE_DEK) — hosted keygen cannot seal a key");
  }
  const pair = await generatePerpKeyPair(args.source);
  const apiKeySealed = sealPerpKey(
    pair.privateKey,
    { tenant: args.tenant, smartAccount: args.smartAccount, apiPublicKey: pair.publicKey, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex },
    args.dek,
  );
  return { apiPublicKey: pair.publicKey, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiKeySealed };
}
