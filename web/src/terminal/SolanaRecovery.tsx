"use client";
/**
 * AN OFFLINE COPY OF THE OWNER KEY, OFF UNTIL THE DEPLOYMENT TURNS IT ON.
 *
 * Revoke and withdraw are only reachable through the server's prepare and
 * submit routes, and the owner key lives in Privy's embedded wallet. The vault
 * answers to that key alone, so an offline copy keeps the owner's authority
 * over the vault if Merrymen or this site is unavailable. Privy shows the key
 * to its owner in its own window on its own domain; this page never receives
 * it.
 *
 * Handling a raw key is a phishing and loss risk, so the card is shown only
 * when NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT=1, only to the bound owner
 * wallet, and only for a live binding whose vault the server has read: never
 * for a paper binding (an owner decision, SolanaScreen's recoveryVault), never
 * while the status loads. The whole card, step 2's commands included, stays
 * behind the flag (another owner decision): without an exported key there is
 * nothing to sign with outside Merrymen.
 * Turn the flag on only after export is enabled for the Privy app in its
 * dashboard, and only once the deployed program's release entry ships in the
 * published command-line tool. Next inlines the flag when the web app is
 * built, so a hosted image needs it as a build argument, not a runtime one.
 *
 * Step 2 names the recovery command, `merrymen solana-recover`, registered
 * in cli/bin.mjs (SolanaScreen.test.ts checks every command the card names,
 * and runs the tool's own program check on the exact arguments shown).
 * The tool signs (--send) only for a released vault program: one listed in
 * SOLANA_VAULT_RELEASES, the pin it shares with this page. So the card shows
 * the signing command only for a listed program, with the released binary
 * hash from that pin, never from the server's status answer. For any other
 * program it shows only the read-only plan. The key goes in on standard
 * input, never as an argument (shell history). The card never mentions
 * --unlisted-program or --program-sha256: the tool's help tells owners to
 * stop if anyone asks them to use them for the official program.
 */
import { useRef, useState } from "react";
import { SOLANA_VAULT_RELEASES } from "../../../packages/core/src/solana-live";
import { SOLANA_VAULT_LOCAL_TEST_PROGRAM } from "../../../packages/core/src/solana-live";

/** Inlined at build time; anything but "1" leaves key export off. */
export function ownerKeyExportEnabled(): boolean {
  return process.env.NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT === "1";
}

/** A released Merrymen vault program and the SHA-256 of its deployed binary. */
export type SolanaVaultRelease = { readonly programId: string; readonly sha256: string };
/** A SHA-256 is exactly 64 lowercase hex characters, as the tool requires. */
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * THE RELEASED VAULT PROGRAMS THE RECOVERY TOOL SIGNS FOR, FROM THE SHARED PIN.
 *
 * SOLANA_VAULT_RELEASES in packages/core/src/solana-live.ts is the list
 * `merrymen solana-recover` trusts by default (solanaRecoveryProgramTrust).
 * It is a typed import, so renaming or moving the pin fails to compile
 * instead of silently making every program "plan only". An entry that is not
 * a program ID and a SHA-256 does not count as released, so the card offers
 * only the plan for it.
 *
 * OWNER DECISION: the released hash, and the choice between the signing
 * command and the plan, come from this pin alone, never from the server's
 * status answer (no `?? live.programSha256` fallback): a compromised or
 * misconfigured server could otherwise put an arbitrary hash on the owner's
 * recovery card, next to a signing command, and the hash could be copied into
 * the tool's escape hatch. A program the pin does not list gets the plan.
 */
export function solanaVaultReleases(): readonly SolanaVaultRelease[] {
  const pinned: unknown = SOLANA_VAULT_RELEASES;
  if (!Array.isArray(pinned)) return [];
  return pinned.filter((entry: unknown): entry is SolanaVaultRelease => typeof entry === "object" && entry !== null
    && typeof (entry as SolanaVaultRelease).programId === "string" && typeof (entry as SolanaVaultRelease).sha256 === "string"
    && SHA256.test((entry as SolanaVaultRelease).sha256));
}

/** The released binary SHA-256 of `programId`, or null when the tool would not sign for it. */
export function releasedProgramSha256(programId: string, releases: readonly SolanaVaultRelease[] = solanaVaultReleases()): string | null {
  return releases.find((release) => release.programId === programId)?.sha256 ?? null;
}

/** Shown instead of registering or funding while the server names a program the page does not trust. */
export const SOLANA_UNRELEASED_PROGRAM = "The vault program this server names is not a released Merrymen vault program, so this page will not register a permission for it or show a deposit address. Nothing was signed.";
/**
 * THE PROGRAM THE PAGE REGISTERS PERMISSIONS FOR AND SHOWS DEPOSIT ADDRESSES OF.
 *
 * Only a program in the shared release pin (SOLANA_VAULT_RELEASES), or the
 * local test program in a build that is not a production build. Never the
 * server's status answer: the program interprets the limits the page decodes
 * from the permission's bytes and owns the vault the owner funds, so a
 * misconfigured MERRYMEN_SOLANA_VAULT_PROGRAM or a compromised server naming
 * another program would otherwise have owners initialize, register and fund
 * a vault whose caps no one checked. While nothing is released, a production
 * build registers nothing.
 */
export function pageTrustsVaultProgram(programId: string, releases: readonly SolanaVaultRelease[] = solanaVaultReleases(),
  production = process.env.NODE_ENV === "production"): boolean {
  return releasedProgramSha256(programId, releases) !== null || (!production && programId === SOLANA_VAULT_LOCAL_TEST_PROGRAM);
}

/**
 * The recovery tool reads its RPC from MERRYMEN_SOLANA_RECOVER_RPC (worker/src/solana-recover-command.ts):
 * a provider's URL carries its API key, and a command line stays in shell history and ps. So the card's
 * commands carry no --rpc, and say how to set the variable without typing the URL into a command.
 */
function RecoverRpcFirst() {
  return <p>First put a Solana mainnet HTTPS RPC endpoint you trust in <code>MERRYMEN_SOLANA_RECOVER_RPC</code>, without typing it into a command (a provider&apos;s URL carries its API key, and command lines stay in your shell history): in bash or zsh run <code>read -rs MERRYMEN_SOLANA_RECOVER_RPC; export MERRYMEN_SOLANA_RECOVER_RPC</code>, paste the URL and press Enter. Then run:</p>;
}
function RecoverRpcPublicOnly() {
  return <>Use <code>--rpc &lt;https-url&gt;</code> instead only for a public URL with no API key in it.</>;
}

export function SolanaRecovery({ owner, programId, vault, exportKey }: {
  owner: string; programId: string; vault: string;
  exportKey: () => Promise<void>;
}) {
  const [understood, setUnderstood] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [closed, setClosed] = useState(false);
  const inFlight = useRef(false);
  const open = () => {
    if (inFlight.current || !understood) return;
    inFlight.current = true; setBusy(true); setError(""); setClosed(false);
    void exportKey().then(() => { setClosed(true); setUnderstood(false); })
      .catch(() => setError("Privy did not open the key export. Wallet export may be turned off for this app, or your sign-in needs to be refreshed."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  const sha = releasedProgramSha256(programId);
  return <div className="solana-card"><h2>Back up your owner key</h2>
    <p>Your vault answers to your owner wallet, not to Merrymen: its key alone can revoke every trading session and withdraw your vault balances. Privy can show you this key in its own window so you can keep an offline copy in case Merrymen or this site is ever unavailable.</p>
    <p>Owner wallet: <span className="solana-address">{owner}</span></p>
    <p>Vault program: <span className="solana-address">{programId}</span></p>
    {sha && <p>Released program binary SHA-256: <span className="solana-address">{sha}</span></p>}
    <p>Vault: <span className="solana-address">{vault}</span></p>
    <h3>Step 1: keep an offline copy of the key</h3>
    <p role="note" className="solana-warning">Anyone who has this key controls your owner wallet and everything in your vault, and a leaked key cannot be revoked. Privy shows it in its own secure window: Merrymen never sees it and will never ask for it. Store it offline only. Never paste it into a website, chat, email or support request, and never give it to any app or person offering to recover your funds.</p>
    <label><input type="checkbox" checked={understood} disabled={busy} onChange={(e) => setUnderstood(e.target.checked)} /> I understand that anyone with this key can take my funds.</label>
    {error && <p role="alert" className="solana-error">{error}</p>}
    <button disabled={busy || !understood} onClick={open}>Export owner key with Privy</button>
    {closed && <p role="status">Privy&apos;s export window is closed. If you copied the key, store it offline and clear your clipboard.</p>}
    <p>This export only works while this site is up, so keep the offline copy before you need it.</p>
    {sha ? <>
      <h3>Step 2: recover without Merrymen</h3>
      <p>If Merrymen or this site is unavailable, the Merrymen command-line tool on your own computer revokes every trading session, waits until that is final, then withdraws your vault&apos;s USDG, wrapped SOL and spare SOL to your owner wallet.</p>
      <RecoverRpcFirst />
      <p><code className="solana-address">merrymen solana-recover --program {programId} --key-file - --send</code></p>
      <p>The key goes in on standard input (<code>--key-file -</code>), for example <code>pbpaste | merrymen solana-recover …</code> on a Mac, or from a file you delete afterwards. Never type the key into the command itself: command lines are kept in your shell history. <RecoverRpcPublicOnly /> Your owner wallet pays the network fees.</p>
      <p>To see the plan first, run it with <code>--owner {owner}</code> in place of <code>--key-file - --send</code>: nothing is signed or sent. With <code>--send</code> it signs only for a released Merrymen vault program, after checking that program&apos;s deployed binary against its released hash, built into the tool. If the tool says this program is not released, install the current Merrymen command-line tool and run the same command again.</p>
    </> : <>
      <h3>Step 2: check your vault without Merrymen</h3>
      <p>This vault program is not a released Merrymen vault program yet, so the Merrymen command-line tool does not sign for it. Until a release lists it, the tool on your own computer can show your vault, its balances and the transactions recovery would send, without your key.</p>
      <RecoverRpcFirst />
      <p><code className="solana-address">merrymen solana-recover --program {programId} --owner {owner}</code></p>
      <p>Nothing is signed or sent. <RecoverRpcPublicOnly /> Once this program is released, this card shows the command that signs with your key and recovers your vault.</p>
    </>}
  </div>;
}
