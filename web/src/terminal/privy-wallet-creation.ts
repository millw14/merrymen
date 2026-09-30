import type { Wallet } from "@privy-io/react-auth";

// A screen timeout does not cancel Privy's wallet creation. Share its result
// across sign-in mounts and retries so none can start a replacement operation.
// Keep successful results until reload because linked-account updates can lag.
const creations = new Map<string, Promise<Wallet>>();

export function createPrivyWalletOnce(
  userId: string,
  createWallet: () => Promise<Wallet>,
): Promise<Wallet> {
  const existing = creations.get(userId);
  if (existing) return existing;

  const pending = Promise.resolve().then(createWallet).catch((error: unknown) => {
    if (creations.get(userId) === pending) creations.delete(userId);
    throw error;
  });
  creations.set(userId, pending);
  return pending;
}
