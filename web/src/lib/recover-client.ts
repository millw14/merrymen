"use client";

/**
 * WITHDRAWING FROM THE BROWSER, because hosted there is nowhere else to do it.
 *
 * The server refuses `/api/recover` when hosted, correctly: it holds no owner
 * key, so it has nothing to sign with. Its comment said recovery "runs entirely
 * in the browser ... which the client already knows how to do" — and no such
 * client existed. This is it.
 *
 * NO NEW ENGINE. `planRecovery` and `recoverFunds` from the worker are the same
 * functions the CLI runs; they import only viem, @zerodev/* and packages/core,
 * with no node builtins, and the `@merrymen/recover` alias already existed. The
 * phone app has run this same module unmodified for months, so its portability
 * is demonstrated rather than hoped for.
 *
 * TWO THINGS ARE DIFFERENT IN A BROWSER, and both are handled here.
 *
 * THE BUNDLER. Hosted, the Pimlico key is a house secret. `recoverFunds` takes
 * `bundlerUrl` as an opaque string, so it is pointed at this origin's relay,
 * which adds the key server-side and forwards only withdrawal-shaped traffic.
 * Reads need no relay at all: the chain's RPC answers browsers directly
 * (`access-control-allow-origin: *`, probed against 4663), so `rpcUrl` is left
 * undefined and viem uses the chain default.
 *
 * THE TOKEN LIST. `extraTokens` must NOT come from `/api/settings`: hosted, that
 * route returns `{}` to a caller with no session cookie, and the entire point of
 * this path is that it works signed out and after a kill. An empty list silently
 * falls back to the builtin set and leaves every owner-added token behind —
 * which is the exact failure `sweepList` was written to prevent. So it comes
 * from the grant in localStorage, which carries `grantTokens`: the addresses the
 * wall actually covers. `sweepList` re-validates every entry anyway.
 */

import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import { planRecovery, recoverFunds, type RecoverPlan } from "@merrymen/recover";

export interface BrowserWallet {
  smartAccount: `0x${string}`;
  ownerKey: `0x${string}`;
  chainId: number;
  /** Addresses the grant covers, used as the sweep list. */
  grantTokens?: readonly string[];
}

const chainOf = (id: number) => (id === robinhoodTestnet.id ? robinhoodTestnet : robinhoodChain);

/** This origin's relay, which holds the house bundler key so the browser cannot. */
export const relayUrl = (chainId: number) =>
  `${typeof window === "undefined" ? "" : window.location.origin}/api/bundler/${chainId}`;

/**
 * Strip anything that could carry a key or an upstream URL out of an error.
 *
 * viem embeds the full request URL — query string included — in its
 * `metaMessages`, which is how a Pimlico key ends up in a toast. The relay
 * scrubs its own responses; this covers everything viem adds locally, and the
 * owner key itself, which is in scope in this module.
 */
export function redact(e: unknown, ownerKey?: string): string {
  let msg = e instanceof Error ? e.message : String(e);
  if (ownerKey) msg = msg.split(ownerKey).join("<owner key>");
  // NOT a blanket 64-hex replacement. That rule replaced the callData in the
  // one error a user actually sent us — eating the function selector and
  // leaving an unreadable smear of zeros — because calldata, hashes, and
  // signatures are all long hex and none of them are secret. The only 32-byte
  // secret in scope is the owner key, and it is replaced by VALUE above.
  return msg
    .replace(/apikey=[^&\s"']+/gi, "apikey=<redacted>")
    .slice(0, 600);
}

/**
 * Sign the recovery challenge with the OWNER KEY, locally, and arm the relay.
 *
 * The ticket comes back as an httpOnly, path-scoped cookie rather than a value
 * this code holds — so nothing here has to thread it through viem's transport,
 * and no script on the page can read it back out.
 */
export async function getRecoveryTicket(w: BrowserWallet): Promise<void> {
  const chal = await fetch("/api/recover/ticket", { cache: "no-store" });
  if (!chal.ok) throw new Error("could not start recovery — the site did not issue a challenge");
  const { nonce, message } = (await chal.json()) as { nonce: string; message: string };

  // Signed HERE. The key never leaves this function's scope, let alone the tab.
  const signature = await privateKeyToAccount(w.ownerKey).signMessage({ message });

  const res = await fetch("/api/recover/ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, signature, chainId: w.chainId }),
  });
  const body = (await res.json()) as { smartAccount?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? "the site would not issue a recovery ticket");

  // The server derived an account from the signature alone. If it disagrees with
  // the wallet this browser holds, something is wrong on one side and sweeping
  // would be guessing.
  if (body.smartAccount && body.smartAccount.toLowerCase() !== w.smartAccount.toLowerCase()) {
    throw new Error("this key does not control the account shown — refusing to sweep");
  }
}

/**
 * The engine’s own plan, plus one derived flag.
 *
 * EXTENDS rather than redeclares, and the typecheck is what forced that: my
 * first version listed the fields I happened to use and silently dropped
 * `unreadable` — the field recover.ts keeps precisely so a blinking RPC cannot
 * be reported as an empty account. Restating a type is how you lose the parts of
 * it you were not thinking about.
 */
export interface BrowserPlan extends RecoverPlan {
  /** True when the account cannot pay for its own withdrawal. */
  needsGas: boolean;
}

/** What is in the account, read straight from the chain. No relay, no session. */
export async function planFromBrowser(w: BrowserWallet): Promise<BrowserPlan> {
  const plan = (await planRecovery({
    chain: chainOf(w.chainId),
    ownerPrivateKey: w.ownerKey,
    // ALWAYS passed: the server route cannot check this for a pasted key, but
    // the browser knows which account this wallet is meant to be, so a wrong key
    // fails loudly instead of sweeping a stranger's empty account.
    expectedSmartAccount: w.smartAccount,
    extraTokens: (w.grantTokens ?? []).map((address) => ({ address, symbol: "", decimals: 18 })),
  })) as RecoverPlan;
  return { ...plan, needsGas: plan.gasWei === 0n };
}

/**
 * Sweep everything to an address the owner names.
 *
 * The relay ticket is attached per request. `recoverFunds` builds and signs the
 * operation locally and submits it through the relay, which will refuse anything
 * that is not withdrawal-shaped.
 */
export async function sweepFromBrowser(w: BrowserWallet, to: `0x${string}`) {
  // Arms the relay by setting the ticket cookie. Same-origin requests carry it
  // automatically from here, including the ones viem makes inside recoverFunds.
  await getRecoveryTicket(w);

  return recoverFunds({
    chain: chainOf(w.chainId),
    ownerPrivateKey: w.ownerKey,
    bundlerUrl: relayUrl(w.chainId),
    to,
    expectedSmartAccount: w.smartAccount,
    extraTokens: (w.grantTokens ?? []).map((address) => ({ address, symbol: "", decimals: 18 })),
  });
}
