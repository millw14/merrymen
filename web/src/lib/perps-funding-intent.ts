export class FundingPreparationError extends Error {}
/** Browser funding journal. Persist before broadcast; ambiguous sends never retry. */
export type FundingIntent = {
  v: 1; source: string; target: string; amountMicro: string;
  hash: `0x${string}`; state: "submitting" | "submitted" | "confirmed" | "reverted";
};
export type FundingStorage = Pick<Storage, "getItem" | "setItem">;
export type FundingResult = { hash: string; status: "confirmed" | "submitted" };
export async function runFundingIntent(args: {
  storage: FundingStorage; key: string;
  source: string; target: string; amountMicro: string;
  prepare: () => Promise<{ hash: `0x${string}`; send: () => Promise<string> }>;
  receipt: (hash: `0x${string}`) => Promise<"confirmed" | "reverted" | "pending">;
}): Promise<FundingResult> {
  const { storage, key } = args;
  const raw = storage.getItem(key);
  const previous = raw ? JSON.parse(raw) as FundingIntent : null;
  const persist = (intent: FundingIntent) => storage.setItem(key, JSON.stringify(intent));
  if (previous && (previous.v !== 1 || !/^0x[0-9a-f]{64}$/i.test(previous.hash) ||
      !["submitting", "submitted", "confirmed", "reverted"].includes(previous.state))) {
    throw new Error("Funding history is unreadable. Check the source wallet before another transfer.");
  }
  if (previous && (previous.state === "submitting" || previous.state === "submitted")) {
    const receipt = await args.receipt(previous.hash);
    if (receipt !== "pending") persist({ ...previous, state: receipt });
    if (previous.source !== args.source || previous.target !== args.target || previous.amountMicro !== args.amountMicro) {
      throw new Error("A previous funding request must be checked before creating another transfer.");
    }
    if (receipt === "reverted") throw new Error("The previous funding transaction reverted. No automatic retry was made.");
    return { hash: previous.hash, status: receipt === "confirmed" ? "confirmed" : "submitted" };
  }
  const prepared = await args.prepare();
  const intent: FundingIntent = { v: 1, source: args.source, target: args.target,
    amountMicro: args.amountMicro, hash: prepared.hash, state: "submitting" };
  persist(intent); // Failure to save must prevent sending.
  try {
    const hash = await prepared.send();
    if (hash.toLowerCase() !== intent.hash.toLowerCase()) throw new Error("Funding hash mismatch");
    persist({ ...intent, state: "submitted" });
  } catch {
    // The bundler may have accepted the operation even when the answer was lost.
    return { hash: intent.hash, status: "submitted" };
  }
  const receipt = await args.receipt(intent.hash);
  if (receipt !== "pending") persist({ ...intent, state: receipt });
  if (receipt === "reverted") throw new Error("The funding transaction reverted. No funds were transferred.");
  return { hash: intent.hash, status: receipt === "confirmed" ? "confirmed" : "submitted" };
}
