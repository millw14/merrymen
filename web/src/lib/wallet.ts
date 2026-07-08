"use client";

import type { Chain } from "viem";

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

export function getInjectedProvider(): Eip1193Provider {
  const eth = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth) throw new Error("No wallet found — install MetaMask (or any EIP-1193 wallet).");
  return eth;
}

export async function requestAccount(provider: Eip1193Provider): Promise<`0x${string}`> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts?.[0];
  if (!account) throw new Error("Wallet returned no accounts.");
  return account as `0x${string}`;
}

/** Switch the wallet to `chain`, adding it first if unknown (littlejohn's add-chain dance). */
export async function ensureChain(provider: Eip1193Provider, chain: Chain): Promise<void> {
  const chainIdHex = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 4902 = unknown chain
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers
            ? [chain.blockExplorers.default.url]
            : undefined,
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  }
}
