import test from "node:test";
import assert from "node:assert/strict";
import { address, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromPrivateKeyBytes, createTransactionMessage, getAddressFromPublicKey,
  getBase58Decoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getTransactionDecoder, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, signTransaction, type Blockhash, type Instruction } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { buildRevokeSolanaSessionsInstruction, buildWithdrawSolanaVaultInstruction, deriveSolanaAta, deriveSolanaVaultAddress,
  SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { readSolanaExternalWithdrawal, SolanaExternalWithdrawalError } from "./solana-external-withdrawal";
import type { SolanaLiveRead } from "./solana-live-rpc";

const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const PROGRAM = key(77);
async function setup() {
  const ownerKeys = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21)), owner = await getAddressFromPublicKey(ownerKeys.publicKey);
  const vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const ata = async (holder: string, mint: string) => deriveSolanaAta(holder, mint, mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM);
  const withdraw = async (mint: string, amount: bigint, vaultFor = vault) => buildWithdrawSolanaVaultInstruction({ programAddress: PROGRAM, vault: vaultFor, owner, mint,
    tokenProgram: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM, vaultToken: await ata(vaultFor, mint), ownerToken: await ata(owner, mint), amount });
  const syncNative = async (): Promise<Instruction> => ({ programAddress: address(SOLANA_CLASSIC_TOKEN_PROGRAM), accounts: [{ address: address(await ata(vault, SOLANA_WRAPPED_SOL_MINT)), role: 1 }], data: Uint8Array.of(17) });
  /** A signed transaction and the getTransaction answer for it, with the vault token accounts' balances before and after. */
  const signed = async (instructions: Instruction[], balances: Record<string, [bigint, bigint]>, meta: Record<string, unknown> = {}) => {
    const message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: key(42) as unknown as Blockhash, lastValidBlockHeight: 5000n },
      setTransactionMessageFeePayer(address(owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 }))));
    const tx = await signTransaction([ownerKeys], compileTransaction(message));
    const wire = getBase64EncodedWireTransaction(tx), signature = getBase58Decoder().decode(Object.values(tx.signatures)[0]!);
    const keys = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(wire, "base64")).messageBytes).staticAccounts.map(String);
    const entries = async (side: 0 | 1) => Promise.all(Object.entries(balances).map(async ([mint, values]) => ({ accountIndex: keys.indexOf(await ata(vault, mint)), mint,
      owner: vault, programId: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM, uiTokenAmount: { amount: values[side].toString(), decimals: mint === SOLANA_USDG_MINT ? 6 : 9 } })));
    const answer = { slot: 1234, version: 0, blockTime: 1, transaction: [wire, "base64"], meta: { err: null, fee: 5000, preTokenBalances: await entries(0), postTokenBalances: await entries(1), innerInstructions: [], ...meta } };
    return { signature, answer, keys };
  };
  return { owner, vault, withdraw, syncNative, signed, expected: { programId: PROGRAM, vault, owner } };
}
const reading = (answer: unknown): SolanaLiveRead => async (method, params = []) => {
  assert.equal(method, "getTransaction"); assert.deepEqual(params[1], { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 });
  return answer;
};
const refused = (pattern: RegExp) => (error: unknown) => error instanceof SolanaExternalWithdrawalError && pattern.test(error.message);

test("a solana-recover style owner withdrawal is read as the vault token account's own net decrease", async () => {
  const f = await setup();
  const usdg = await f.signed([await f.withdraw(SOLANA_USDG_MINT, 90_000_000n)], { [SOLANA_USDG_MINT]: [90_000_000n, 0n] });
  assert.deepEqual(await readSolanaExternalWithdrawal(reading(usdg.answer), usdg.signature, f.expected), { slot: 1234, withdrawals: [{ mint: SOLANA_USDG_MINT, amountRaw: "90000000", preRaw: "90000000" }] });
  // Wrapped SOL after a SyncNative of native SOL sent to the vault: only the decrease of the recorded WSOL is the book's.
  const wsol = await f.signed([await f.syncNative(), await f.withdraw(SOLANA_WRAPPED_SOL_MINT, 50_000_100n)], { [SOLANA_WRAPPED_SOL_MINT]: [50_000_000n, 0n] });
  assert.deepEqual(await readSolanaExternalWithdrawal(reading(wsol.answer), wsol.signature, f.expected), { slot: 1234, withdrawals: [{ mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "50000000", preRaw: "50000000" }] });
  // A partial withdrawal: the balance just before it is returned with it.
  const partial = await f.signed([await f.withdraw(SOLANA_USDG_MINT, 30n)], { [SOLANA_USDG_MINT]: [100n, 70n] });
  assert.deepEqual((await readSolanaExternalWithdrawal(reading(partial.answer), partial.signature, f.expected)).withdrawals, [{ mint: SOLANA_USDG_MINT, amountRaw: "30", preRaw: "100" }]);
  // A revocation in the same transaction is the owner's too.
  const both = await f.signed([buildRevokeSolanaSessionsInstruction({ programAddress: PROGRAM, vault: f.vault, owner: f.owner }), await f.withdraw(SOLANA_USDG_MINT, 5n)], { [SOLANA_USDG_MINT]: [5n, 0n] });
  assert.deepEqual((await readSolanaExternalWithdrawal(reading(both.answer), both.signature, f.expected)).withdrawals, [{ mint: SOLANA_USDG_MINT, amountRaw: "5", preRaw: "5" }]);
});

test("anything that is not exactly an owner withdrawal from this vault is refused, so nothing is booked", async () => {
  const f = await setup();
  const ok = await f.signed([await f.withdraw(SOLANA_USDG_MINT, 10n)], { [SOLANA_USDG_MINT]: [10n, 0n] });
  await assert.rejects(readSolanaExternalWithdrawal(reading(null), ok.signature, f.expected), refused(/not finalized/));
  await assert.rejects(readSolanaExternalWithdrawal(reading({ ...ok.answer, meta: { ...ok.answer.meta, err: { InstructionError: [0, "Custom"] } } }), ok.signature, f.expected), refused(/failed on Solana/));
  await assert.rejects(readSolanaExternalWithdrawal(reading(ok.answer), key(9) + key(9), f.expected), refused(/not a withdrawal/), "another signature's transaction");
  // The token balance moved by more, or less, than the withdrawal: something else touched the vault.
  for (const [pre, post] of [[10n, 1n], [10n, 9n]] as const) {
    const odd = await f.signed([await f.withdraw(SOLANA_USDG_MINT, 10n)], { [SOLANA_USDG_MINT]: [pre, post] });
    await assert.rejects(readSolanaExternalWithdrawal(reading(odd.answer), odd.signature, f.expected), refused(/not a withdrawal/));
  }
  // Another vault, or a swap beside the withdrawal.
  const elsewhere = await f.signed([await f.withdraw(SOLANA_USDG_MINT, 10n, await deriveSolanaVaultAddress(key(78), f.owner))], {});
  await assert.rejects(readSolanaExternalWithdrawal(reading(elsewhere.answer), elsewhere.signature, f.expected), refused(/not a withdrawal/));
  const swap: Instruction = { programAddress: address(PROGRAM), accounts: [{ address: address(f.vault), role: 1 }, { address: address(f.owner), role: 2 }], data: Uint8Array.of(56, 182, 124, 215, 155, 140, 157, 102, 0) };
  const swapped = await f.signed([swap, await f.withdraw(SOLANA_USDG_MINT, 10n)], { [SOLANA_USDG_MINT]: [10n, 0n] });
  await assert.rejects(readSolanaExternalWithdrawal(reading(swapped.answer), swapped.signature, f.expected), refused(/did more than withdraw/));
  // The vault program reached from inside another program.
  const inner = { ...ok.answer, meta: { ...ok.answer.meta, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: ok.keys.indexOf(PROGRAM), accounts: [], data: "" }] }] } };
  await assert.rejects(readSolanaExternalWithdrawal(reading(inner), ok.signature, f.expected), refused(/not a withdrawal/));
  // A vault token balance that changed with no withdrawal of that mint (wrapped here by a SyncNative).
  const drift = await f.signed([await f.syncNative(), await f.withdraw(SOLANA_USDG_MINT, 10n)], { [SOLANA_USDG_MINT]: [10n, 0n], [SOLANA_WRAPPED_SOL_MINT]: [6n, 7n] });
  await assert.rejects(readSolanaExternalWithdrawal(reading(drift.answer), drift.signature, f.expected), refused(/not a withdrawal/));
  // The withdrawn account's balance missing from the receipt.
  await assert.rejects(readSolanaExternalWithdrawal(reading({ ...ok.answer, meta: { ...ok.answer.meta, postTokenBalances: [] } }), ok.signature, f.expected), refused(/not a withdrawal/));
});
