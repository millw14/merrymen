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
 *
 * Those are ADDRESSES ONLY — the grant carries no symbol and no decimals — and
 * they are passed on as exactly that (see `grantExtraTokens`).
 */

import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { base64url, robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import { createSponsor } from "../../../worker/src/paymaster";
import {
  ownerFromPrivateKey,
  ownerFromSigner,
  planRecovery,
  recoverFunds,
  type RecoverPlan,
  type RecoveryOwner,
} from "@merrymen/recover";

export interface BrowserWallet {
  smartAccount: `0x${string}`;
  /**
   * A browser-held owner key, for wallets that have one.
   *
   * ABSENT FOR A PRIVY-OWNED AGENT, which is the whole reason `ownerAccount`
   * exists beside it: an embedded wallet's key is never exported, so a recovery
   * path that could only take hex left those accounts unrecoverable.
   */
  ownerKey?: `0x${string}`;
  /** A signer that needs no key — `toViemAccount({ wallet })` from Privy. */
  ownerAccount?: LocalAccount;
  chainId: number;
  /** Explicit trusted application origin for native clients. Never a provider key. */
  apiOrigin?: string;
  /** Addresses the grant covers, used as the sweep list. */
  grantTokens?: readonly string[];
}

/**
 * The wallet's owner as the engine wants it — and a refusal if it has neither.
 *
 * Deliberately NOT a silent fallback to some other owner: deriving a Kernel
 * account from the wrong signer produces a different, empty account, and a
 * sweep of it would report success having moved nothing.
 */
function ownerOf(w: BrowserWallet): RecoveryOwner {
  if (w.ownerAccount) return ownerFromSigner(w.ownerAccount);
  if (w.ownerKey) return ownerFromPrivateKey(w.ownerKey);
  throw new Error(
    "this wallet has no owner signer: it has no stored recovery key, and no signed-in embedded wallet was supplied.",
  );
}

const chainOf = (id: number) => (id === robinhoodTestnet.id ? robinhoodTestnet : robinhoodChain);

/** Native's URL adapter has no .origin getter; reconstruct only a checked origin. */
function canonicalOrigin(value: string): string {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) throw new Error("recovery needs a trusted application origin, without a path or credentials");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("recovery application origin is invalid"); }
  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port ?? "";
  if (!host || url.username || url.password || (url.pathname && url.pathname !== "/") || url.search ||
      (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535))) {
    throw new Error("recovery needs a trusted application origin, without a path or credentials");
  }
  if (protocol !== "https:" && !(protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host))) {
    throw new Error("recovery needs HTTPS, except for a local application");
  }
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const defaultPort = protocol === "https:" ? "443" : "80";
  return `${protocol}//${authority}${port && port !== defaultPort ? `:${port}` : ""}`;
}

function recoveryOrigin(apiOrigin?: string): string {
  const page = typeof window === "undefined" ? undefined : window.location?.origin;
  const browserOrigin = typeof page === "string" && /^https?:/i.test(page) ? canonicalOrigin(page) : null;
  if (apiOrigin !== undefined) {
    const explicit = canonicalOrigin(apiOrigin);
    if (browserOrigin && explicit !== browserOrigin) throw new Error("recovery application origin does not match this page");
    return explicit;
  }
  if (!browserOrigin) throw new Error("recovery needs a trusted application origin");
  return browserOrigin;
}

/** This origin's relay, which holds the house bundler key so the browser cannot. */
export const relayUrl = (chainId: number, apiOrigin?: string) =>
  `${recoveryOrigin(apiOrigin)}/api/bundler/${chainId}`;

function ownerChallenge(origin: string, nonce: unknown): string {
  if (typeof nonce !== "string" || nonce.length > 512) throw new Error("the site returned an invalid recovery nonce");
  const parts = nonce.split(".");
  const [random, expiry, namespace, mac] = parts;
  const expectedNamespace = base64url(new TextEncoder().encode(`${origin}|recovery-owner-actions-v2`));
  if (parts.length !== 4 || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(random ?? "") ||
      !/^[1-9][0-9]{0,15}$/.test(expiry ?? "") || !Number.isSafeInteger(Number(expiry)) ||
      namespace !== expectedNamespace || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(mac ?? "")) {
    throw new Error("the site returned an invalid or misbound recovery nonce");
  }
  // The server enforces expiry. A device clock offset must not strand recovery.
  // Keep this exact protocol text browser-safe: recovery-ticket.ts imports crypto.
  return [
    `${origin} — recover your merrymen account.`, "",
    "This proves you control the owner key so the site can relay withdrawals and permission revocations.",
    "It moves no funds by itself and grants no permissions: each operation",
    "is a separate operation you sign next.", "",
    `URI: ${origin}`, `Nonce: ${nonce}`,
  ].join("\n");
}

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

/** Turn paymaster failures into an actionable message instead of an RPC dump. */
export function ownerGasError(e: unknown, ownerKey?: string): string {
  const message = redact(e, ownerKey);
  if (/AA21|prefund|paymaster|SponsorRefused|sponsor-(?:refused|unreachable|absurd)/i.test(message) ||
      (e instanceof Error && e.name === "SponsorRefused")) {
    return "Merrymen could not obtain gas coverage for this action. Retry when coverage is restored; you do not need to add ETH for this fee.";
  }
  return message;
}

/**
 * Sign the recovery challenge with the OWNER KEY, locally, and arm the relay.
 *
 * The ticket comes back as an httpOnly, path-scoped cookie rather than a value
 * this code holds — so nothing here has to thread it through viem's transport,
 * and no script on the page can read it back out.
 */
export async function getRecoveryTicket(w: BrowserWallet): Promise<void> {
  const origin = recoveryOrigin(w.apiOrigin);
  const ticketUrl = `${origin}/api/recover/ticket`;
  const chal = await fetch(`${ticketUrl}?scope=owner-actions`, { cache: "no-store", credentials: "include" });
  if (!chal.ok) throw new Error("could not start recovery — the site did not issue a challenge");
  const challenge = await chal.json() as unknown;
  if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) throw new Error("the site returned an invalid recovery challenge");
  const { nonce, message } = challenge as { nonce?: unknown; message?: unknown };
  const expectedMessage = ownerChallenge(origin, nonce);
  if (typeof message !== "string" || message !== expectedMessage) throw new Error("the site returned an unexpected recovery message — refusing to sign");

  // Signed HERE. A browser key never leaves this function's scope, let alone the
  // tab; a Privy embedded wallet signs inside its own iframe and this code never
  // sees key material at all. Either way the signature is produced locally.
  const signer = w.ownerAccount ?? (w.ownerKey ? privateKeyToAccount(w.ownerKey) : null);
  if (!signer) throw new Error("no owner signer: nothing here can sign the recovery challenge.");
  const signature = await signer.signMessage({ message: expectedMessage });

  const res = await fetch(ticketUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ nonce, signature, chainId: w.chainId, scope: "owner-actions" }),
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

export interface OwnerGasSupport {
  gasSponsored: boolean;
  reason: string | null;
}

/** The house decides eligibility and policy. An owner signature proves this wallet. */
export async function ownerGasSupport(w: BrowserWallet): Promise<OwnerGasSupport> {
  await getRecoveryTicket(w);
  const response = await fetch(relayUrl(w.chainId, w.apiOrigin), { cache: "no-store", credentials: "include" });
  const body = await response.json() as { gasSponsored?: unknown; reason?: unknown; error?: unknown };
  if (!response.ok || typeof body.gasSponsored !== "boolean") {
    throw new Error(typeof body.error === "string" ? body.error : "Could not check Merrymen gas coverage. Retry when the service is available.");
  }
  return { gasSponsored: body.gasSponsored, reason: typeof body.reason === "string" ? body.reason : null };
}

/** Never charge an owner's ETH as a fallback when house sponsorship is unavailable. */
export async function ownerGasSponsor(w: BrowserWallet) {
  const support = await ownerGasSupport(w);
  if (!support.gasSponsored) {
    throw new Error(support.reason ?? "Merrymen gas coverage is unavailable on this network. Your wallet was kept; retry when coverage is restored.");
  }
  return createSponsor({ url: relayUrl(w.chainId, w.apiOrigin), credentials: "include" });
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
  gasSponsored: boolean;
  sponsorshipReason: string | null;
}

/**
 * The grant's token addresses, as the engine's extra-token list.
 *
 * ADDRESS ONLY, and nothing invented to go with it. This used to add
 * `symbol: "", decimals: 18`: the 18 was a guess, and the empty symbol failed
 * the engine's validation, so every owner-added token was silently dropped from
 * the sweep and left in the account. `sweepList` now takes an address-only
 * entry and labels it by address, and `planRecovery` reads its decimals from
 * the token itself.
 *
 * Exported because the phone's wallet engine plans with it too.
 */
export const grantExtraTokens = (grantTokens: readonly string[] = []) =>
  grantTokens.map((address) => ({ address, symbol: "" }));

/** Read balances from the chain and check house coverage with an owner proof. */
export async function planFromBrowser(w: BrowserWallet): Promise<BrowserPlan> {
  let support: OwnerGasSupport;
  try { support = await ownerGasSupport(w); }
  catch (e) { support = { gasSponsored: false, reason: redact(e, w.ownerKey) }; }
  const plan = (await planRecovery({
    chain: chainOf(w.chainId),
    owner: ownerOf(w),
    // ALWAYS passed: the server route cannot check this for a pasted key, but
    // the browser knows which account this wallet is meant to be, so a wrong key
    // fails loudly instead of sweeping a stranger's empty account.
    expectedSmartAccount: w.smartAccount,
    extraTokens: grantExtraTokens(w.grantTokens),
    gasSponsored: support.gasSponsored,
  })) as RecoverPlan;
  return { ...plan, needsGas: !support.gasSponsored && plan.gasWei === 0n, gasSponsored: support.gasSponsored, sponsorshipReason: support.reason };
}

/**
 * Sweep everything to an address the owner names.
 *
 * The relay ticket is attached per request. `recoverFunds` builds and signs the
 * operation locally and submits it through the relay, which will refuse anything
 * that is not withdrawal-shaped.
 */
export async function sweepFromBrowser(
  w: BrowserWallet,
  to: `0x${string}`,
  /**
   * THE CLASS LEG THE OWNER JUST APPROVED, carried from the plan they saw.
   *
   * `recoverFunds` re-plans internally, so without this the confirmation and
   * the execution are built from two separate reads of a 6,000,000-block log
   * scan — and when the second one came back empty the vault was silently
   * skipped while the account sweep went ahead. Passing it makes the approved
   * intent the thing that executes, and makes its failure fatal.
   *
   * Identity only. The AMOUNT is re-read from the vault before signing.
   */
  approvedClass?: { vault: `0x${string}`; tokens: readonly `0x${string}`[] },
) {
  // Arms the relay by setting the ticket cookie. Same-origin requests carry it
  // automatically from here, including the ones viem makes inside recoverFunds.
  const sponsor = await ownerGasSponsor(w);

  try { return await recoverFunds({
    chain: chainOf(w.chainId),
    owner: ownerOf(w),
    bundlerUrl: relayUrl(w.chainId, w.apiOrigin),
    bundlerCredentials: "include",
    sponsor,
    to,
    expectedSmartAccount: w.smartAccount,
    extraTokens: grantExtraTokens(w.grantTokens),
    ...(approvedClass
      ? {
          approvedClass: { ...approvedClass, destination: to },
          // The browser path is the one that shows a per-holding confirmation,
          // so it is the one where a disclosed sweep that cannot run must stop
          // everything rather than proceed without it.
          requireApprovedClassSweep: true,
        }
      : {}),
  }); } catch (e) { throw new Error(ownerGasError(e, w.ownerKey)); }
}
