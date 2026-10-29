import assert from "node:assert/strict";
import { test } from "node:test";
import { hexToString } from "viem";
import { decodeNotePackage, generateReceiveKey, makeBoundNotePoseidon, openSealedTicket } from "@gloamtrade/sdk";
import { GLOAM_WITHDRAWAL_USDG, GLOAM_WITHDRAWAL_POOL } from "./gloam-withdrawal-contracts";
import { GLOAM_SHIELD_ARTIFACTS, loadGloamShieldArtifacts, prepareGloamShield, sealGloamShieldNote, verifyGloamArtifact } from "./gloam-proof";

test("the payout note opens only with the owner's Gloam key and preserves the exact deposit", async () => {
  const owner = await generateReceiveKey();
  const stranger = await generateReceiveKey();
  const note = await makeBoundNotePoseidon(12_345_678n, GLOAM_WITHDRAWAL_USDG);
  const memo = await sealGloamShieldNote(note, 12_345_678n, owner.tag);
  const sealed = hexToString(memo);
  assert.match(sealed, /^gloam2t\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes(note.secret));
  assert.ok(!sealed.includes("gloam1."));
  await assert.rejects(openSealedTicket(sealed, stranger), /different receive tag/);
  const opened = decodeNotePackage(await openSealedTicket(sealed, owner));
  assert.equal(opened.secret, note.secret);
  assert.equal(opened.commitment, note.commitment);
  assert.equal(opened.amountWei, "12345678");
  assert.equal(opened.asset.toLowerCase(), GLOAM_WITHDRAWAL_USDG.toLowerCase());
  assert.equal(opened.pool.toLowerCase(), GLOAM_WITHDRAWAL_POOL.toLowerCase());
  assert.equal(opened.chainId, 4663);
});

test("invalid amounts and receive keys fail before downloading or proving", async () => {
  for (const amountWei of [0n, -1n, 500_000_001n]) {
    await assert.rejects(prepareGloamShield({ amountWei, receiveTag: "invalid" }), /at most 500 USDG/);
  }
  await assert.rejects(prepareGloamShield({ amountWei: 1n, receiveTag: "0x0000000000000000000000000000000000000001" }), /receive tag/);
  const accidentallyPastedSecret = "gloam1.accidentally-pasted-private-recovery-note";
  const safeError = (error: unknown) => error instanceof Error
    && error.message === "Enter a valid public Gloam receive tag beginning with gloamr1."
    && !error.message.includes(accidentallyPastedSecret);
  await assert.rejects(prepareGloamShield({ amountWei: 1n, receiveTag: accidentallyPastedSecret }), safeError);
  await assert.rejects(sealGloamShieldNote({ secret: "0x01", commitment: "0x02" }, 1n, accidentallyPastedSecret), safeError);
});

test("artifact verification returns a separate verified copy and refuses modified bytes", async () => {
  const bytes = new TextEncoder().encode("abc");
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const verified = await verifyGloamArtifact(bytes, expected);
  bytes[0] = 0;
  assert.equal(new TextDecoder().decode(verified), "abc");
  await assert.rejects(verifyGloamArtifact(bytes, expected), /pinned ceremony/);
});

test("artifact downloads omit credentials and reject tampered or oversized files", async () => {
  const requested: string[] = [];
  const altered: typeof fetch = async (input, init) => {
    requested.push(String(input));
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array([1, 2, 3]));
  };
  await assert.rejects(loadGloamShieldArtifacts(altered), /pinned ceremony/);
  assert.deepEqual(requested.sort(), Object.values(GLOAM_SHIELD_ARTIFACTS).map((a) => a.url).sort());
  const oversized: typeof fetch = async () => new Response(new Uint8Array([1]), { headers: { "content-length": "9000000" } });
  await assert.rejects(loadGloamShieldArtifacts(oversized), /too large/);
});
