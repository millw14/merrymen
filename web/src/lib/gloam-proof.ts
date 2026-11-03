"use client";

import { stringToHex, type Hex } from "viem";
import {
  GLOAM_WITHDRAWAL_CHAIN_ID,
  GLOAM_WITHDRAWAL_MAX_AMOUNT,
  GLOAM_WITHDRAWAL_MAX_MEMO_BYTES,
  GLOAM_WITHDRAWAL_POOL,
  GLOAM_WITHDRAWAL_USDG,
} from "./gloam-withdrawal-contracts";

/** Final ceremony files, pinned to the published transcript, never testnet keys. */
export const GLOAM_SHIELD_ARTIFACTS = {
  wasm: {
    url: "https://www.gloam.trade/circuits/shield.wasm",
    sha256: "58157ec90f8af891acfa998bd599511b4d5cd06803cea32ab28a6eea8a9b2336",
  },
  zkey: {
    url: "https://www.gloam.trade/circuits/final/shield_final.zkey",
    sha256: "3054877c35e2e0e9f76c43aa4791ac2b3ac51b8967d51be2215e89c0a5fbb512",
  },
} as const;

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Verify the actual bytes passed to snarkjs; it must not fetch the URL again. */
export async function verifyGloamArtifact(bytes: Uint8Array, expectedSha256: string): Promise<Uint8Array> {
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  const actual = Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("");
  if (actual !== expectedSha256) throw new Error("Gloam's proving files did not match the pinned ceremony. Nothing was signed.");
  return copy;
}

/** No credentials, referrer, or wallet data accompanies the fixed artifact downloads. */
export async function loadGloamShieldArtifacts(fetcher: typeof fetch = fetch): Promise<{ wasm: Uint8Array; zkey: Uint8Array }> {
  async function read(artifact: { url: string; sha256: string }) {
    const response = await fetcher(artifact.url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok || !response.body) throw new Error("Could not download Gloam's proving files. Nothing was signed.");
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > MAX_ARTIFACT_BYTES) throw new Error("Gloam's proving file is too large. Nothing was signed.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_ARTIFACT_BYTES) {
          await reader.cancel();
          throw new Error("Gloam's proving file is too large. Nothing was signed.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return verifyGloamArtifact(bytes, artifact.sha256);
  }
  const [wasm, zkey] = await Promise.all([read(GLOAM_SHIELD_ARTIFACTS.wasm), read(GLOAM_SHIELD_ARTIFACTS.zkey)]);
  return { wasm, zkey };
}

function assertAmount(amountWei: bigint): void {
  if (typeof amountWei !== "bigint" || amountWei <= 0n || amountWei > GLOAM_WITHDRAWAL_MAX_AMOUNT) {
    throw new Error("Choose more than zero and at most 500 USDG for this Gloam withdrawal.");
  }
}

function assertSafeReceiveTag(sdk: typeof import("@gloamtrade/sdk"), receiveTag: string): void {
  try {
    sdk.assertReceiveTag(receiveTag);
  } catch {
    // SDK validation includes part of the input in its error. A pasted recovery
    // note or private key must never be echoed into UI errors or telemetry.
    throw new Error("Enter a valid public Gloam receive tag beginning with gloamr1.");
  }
}

/**
 * The only export containing the note is ciphertext addressed to the owner.
 * Its private receive key stays in Gloam; a public gloamr1 address is sufficient.
 */
export async function sealGloamShieldNote(
  note: { secret: Hex; commitment: Hex },
  amountWei: bigint,
  receiveTag: string,
): Promise<Hex> {
  assertAmount(amountWei);
  const sdk = await import("@gloamtrade/sdk");
  assertSafeReceiveTag(sdk, receiveTag);
  let sealed: string;
  try {
    sealed = await sdk.sealToReceiveTag(sdk.encodeNotePackage({
      pool: GLOAM_WITHDRAWAL_POOL,
      asset: GLOAM_WITHDRAWAL_USDG,
      amountWei: amountWei.toString(),
      secret: note.secret,
      commitment: note.commitment,
      chainId: GLOAM_WITHDRAWAL_CHAIN_ID,
    }), receiveTag);
  } catch {
    throw new Error("Could not encrypt the private Gloam receipt. Nothing was signed.");
  }
  const memo = stringToHex(sealed);
  if ((memo.length - 2) / 2 > GLOAM_WITHDRAWAL_MAX_MEMO_BYTES) throw new Error("The encrypted Gloam receipt is too large. Nothing was signed.");
  return memo;
}

/**
 * Prepare locally, with no signer, RPC, relay or storage side effects. The caller
 * must persist and offer a download of this sealed receipt BEFORE signing the
 * atomic deposit + memo batch. Neither this result nor an error exposes a secret.
 */
export async function prepareGloamShield({ amountWei, receiveTag }: {
  amountWei: bigint;
  receiveTag: string;
}): Promise<{ commitment: Hex; proof: Hex; memo: Hex }> {
  assertAmount(amountWei);
  const sdk = await import("@gloamtrade/sdk");
  if (sdk.SDK_VERSION !== "0.4.1") throw new Error("The Gloam SDK version is not the reviewed version.");
  assertSafeReceiveTag(sdk, receiveTag);
  const { wasm, zkey } = await loadGloamShieldArtifacts();
  const { groth16 } = await import("snarkjs");
  try {
    const intent = await sdk.buildShieldBoundIntent({
      amountWei,
      asset: GLOAM_WITHDRAWAL_USDG,
      chainId: GLOAM_WITHDRAWAL_CHAIN_ID,
      poolAddress: GLOAM_WITHDRAWAL_POOL,
      prover: async (input) => {
        const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkey);
        const expected = [input.commitment, input.amount, input.asset];
        if (publicSignals.length !== expected.length || publicSignals.some((v, i) => v !== expected[i])) {
          throw new Error("Unexpected proof inputs");
        }
        const proofBytes = sdk.packGroth16Proof(proof);
        if (!/^0x[0-9a-f]{512}$/i.test(proofBytes)) throw new Error("Invalid proof encoding");
        return { proofBytes, publicSignals };
      },
    });
    const proof = intent.exec.args[3] as Hex;
    const memo = await sealGloamShieldNote(intent.note, amountWei, receiveTag);
    return { commitment: intent.note.commitment, proof, memo };
  } catch {
    // Prover diagnostics can carry witness values. They must never reach a toast,
    // telemetry, a stored receipt or an error cause outside this local operation.
    throw new Error("Could not prepare the private Gloam withdrawal. Nothing was signed; try again.");
  }
}
