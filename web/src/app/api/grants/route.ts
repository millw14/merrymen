import { readRequestPurpose } from "@/lib/account-purpose";
import { carryPerpRecovery, perpRecoveryIntakeRefusal } from "@/lib/perp-recovery-intake";
/**
 * Dev-mode grant handoff + agent status.
 * POST: browser saves a signed grant → .data/grant.json (worker picks it up).
 * GET: full agent status — grant, live balances from the grant chain, worker heartbeat.
 * DELETE: discard the grant file (localStorage cleared client-side). Self-hosted,
 *   a grant carrying perps first gets a stand-down request the worker runs
 *   (lib/perp-kill.ts), and the answer carries the custody sentence.
 * Replaced by Supabase (encrypted, per-user) once persistence lands.
 */

import { webChainRead } from "@/lib/chain-read";
import { readGrantBalancesFrom, type GrantBalances } from "@/lib/grant-balances";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { homePaths, purposeHome } from "@merrymen/home";
import { createPublicClient } from "viem";
import {
  accountsMatch,
  carriesOwnerKey,
  chainForId,
  derivationUnreachable,
  duplicateWallPermissions,
  GRANT_PERP_LIGHTER,
  isHostedMode,
  grantPurpose,
  type GrantPurpose,
  publicGrantView,
  type Derivation,
  type EnergyStatus,
  type PerpsReport,
  type PublicGrantView,
  type StoredGrant,
} from "@merrymen/core";
import { requestOrigin, tenantOf, verifyGrantBinding } from "@/lib/auth";
import { ownerMismatch } from "@/lib/order-owner";
import { checkCanonicalWall } from "@/lib/canonical-wall";
import { privyTokenOf, verifyPrivyToken } from "@/lib/privy";
import { withReadDb } from "@/lib/ledger";
import { readAgentEnergy } from "@/lib/agent-energy";
import { readAgentPerps, readAgentPerpsRead } from "@/lib/agent-perps";
import { standDownForKill } from "@/lib/perp-kill";
import { custodyText, grantMentionsPerps, perpExposureOfReport } from "@/lib/perps-view";
import { getGrantStore, hasStoredGrant } from "@merrymen/grant-store";
import { getIdentityStore } from "@merrymen/identity-store";
import { getSettingsStore } from "@merrymen/settings-store";
import { hostedStanddownAvailable } from "../../../../../worker/src/perps/hosted-standdown";
import { HostedStanddownStore } from "../../../../../worker/src/perps/hosted-standdown-store";
import { makePgDb } from "../../../../../worker/src/db";
import { readHostedPerpsRecovery, unknownHostedPerpsRecovery, type HostedPerpsRecoveryNotice } from "../../../../../worker/src/hosted-perps-recovery";
import { ledgerHasAgent, mintAndNameAgent } from "@/lib/first-name";
import { deriveKernelAccountAddress } from "@/lib/derive-account";
import { LocalGrantBusyError, replaceLocalGrant, withLocalGrantLock } from "../../../../../cli/grant-lock.mjs";
import {
  acceptIncomingPerp,
  NO_STORE_HEADERS,
  PERP_NOT_FLAT_MESSAGE,
  perpDropRefusal,
  perpsOptInOffered,
  storeDek,
  type PerpRefusal,
} from "@/lib/perp-custody";

function grantFiles(purpose: GrantPurpose) {
  const DATA_DIR = purposeHome(purpose);
  return { DATA_DIR, GRANT_FILE: homePaths.grant(purpose), HEARTBEAT_FILE: homePaths.heartbeat(purpose), ARCHIVE_DIR: path.join(DATA_DIR, "grants") };
}

/** Separate authority is mandatory; an existing venue key must be retired explicitly. */
async function otherPurposeRefusal(grant: StoredGrant, purpose: GrantPurpose, tenant: `0x${string}` | null): Promise<NextResponse | null> {
  const otherPurpose = purpose === "perps" ? "spot" : "perps";
  try {
    let other: StoredGrant | null;
    if (tenant) {
      other = await getGrantStore(otherPurpose).get(tenant);
      if (!other && await hasStoredGrant(tenant, otherPurpose)) throw new Error("unreadable authority");
    } else {
      try { other = JSON.parse(await readFile(homePaths.grant(otherPurpose), "utf8")) as StoredGrant; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; other = null; }
    }
    if (!other) return null;
    if (grantPurpose(other) !== otherPurpose) throw new Error("stored account purpose mismatch");
    if (other.smartAccount?.toLowerCase() === grant.smartAccount.toLowerCase()) return NextResponse.json({ error: "Spot and Perps must have separate wallet addresses.", code: "account-purpose-collision" }, { status: 409 });
    if (!isAddr(other.owner) || other.owner.toLowerCase() !== grant.owner?.toLowerCase()) return NextResponse.json({ error: "Use the same owner key as your existing account to create the other wallet. Your existing wallet has not changed.", code: "account-owner-mismatch" }, { status: 409 });
    if (purpose === "perps" ? grantMentionsPerps(other) : grantMentionsPerps(grant)) return NextResponse.json({ error: "Your Spot wallet already carries a perpetual permission. Close and recover that account, then retire its perpetual permission before creating a separate Perps wallet.", code: "legacy-perps-retirement-required", ownerFacing: true }, { status: 409 });
    return null;
  } catch {
    return NextResponse.json({ error: "The other account's permission could not be checked. Neither wallet was changed.", ownerFacing: true }, { status: 503 });
  }
}

/** A well-formed 0x EVM address — the ONLY thing we ever build an archive filename
 * from. Rejecting anything else keeps `smartAccount` from smuggling path separators
 * (../, absolute paths) into archiveCurrentGrant's `${addr}.json`. */
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * A rule-5 refusal (lib/perp-custody.ts) as a response. `ownerFacing` because
 * every one of them is written for the owner, including the 503s the shell
 * would otherwise replace with a bare status (terminal/request-json.ts).
 */
function perpRefused(r: PerpRefusal): NextResponse {
  return NextResponse.json(
    {
      error: r.error,
      code: r.code,
      ...(r.detail !== undefined ? { detail: r.detail } : {}),
      ...(r.flat !== undefined ? { flat: r.flat } : {}),
      ownerFacing: true,
    },
    { status: r.status },
  );
}

/**
 * Copy whatever grant.json currently holds into the archive, keyed by its smart
 * account, BEFORE we overwrite or delete it.
 *
 * grant.json is a single slot: creating a second wallet (or hitting the kill
 * switch) used to destroy the previous grant — and with it the ONLY on-disk copy
 * of that wallet's owner key, permanently stranding any funds still in it. This
 * is the safety net. Best-effort: archiving must never block arming a grant.
 */
async function archiveCurrentGrant(purpose: GrantPurpose = "spot"): Promise<void> {
  const { GRANT_FILE, ARCHIVE_DIR } = grantFiles(purpose);
  try {
    const raw = await readFile(GRANT_FILE, "utf8");
    const prev = JSON.parse(raw) as StoredGrant;
    if (!isAddr(prev?.smartAccount)) return; // never derive a path from a malformed address
    await mkdir(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
    // One file per wallet, named by its address. Re-arming the same wallet just
    // refreshes its archive copy; a different wallet gets its own file.
    const dst = path.join(ARCHIVE_DIR, `${prev.smartAccount.toLowerCase()}.json`);
    await writeFile(dst, raw, { encoding: "utf8", mode: 0o600 });
    // This file holds a plaintext OWNER KEY — keep it owner-only (0600), not the
    // default world-readable 0644. chmod covers the file-already-existed case.
    await chmod(dst, 0o600).catch(() => {});
  } catch {
    // no grant.json yet, or it's unreadable — nothing worth keeping
  }
}

export interface AgentStatus {
  exists: boolean;
  /**
   * The grant AS ANYBODY MAY SEE IT — core's publicGrantView, an ALLOWLIST of
   * addresses, caps, times, markers and PUBLIC keys (docs/perps.md rule 5).
   * Never the session key, the owner key, the serialized permission, the
   * binding's signatures, or the Lighter key in any form.
   */
  grant?: PublicGrantView;
  /** Decimal strings as read from the chain; null for any read that failed. */
  balances?: GrantBalances;
  workerAliveAt?: number | null;
  /** "paper" (simulated fills), "live" (signing), or "idle" — from the heartbeat. */
  mode?: "paper" | "live" | "idle" | null;
  /**
   * Is somebody else paying this agent's TRADING gas?
   *
   * REPORTED BY THE WORKER, never computed here. Sponsorship is worker config —
   * sponsorGasEnabled AND a bundler key — and hosted this service is a different
   * container with a different environment. docs/hosted-deploy.md says the web
   * service needs no bundler key, so a local answer would read false on a
   * correctly configured fleet and tell every sponsored owner to go send ETH;
   * and if the two ever drifted the other way it would promise covered fees
   * while the child refused every trade. Same reasoning as `mode` above.
   *
   * null/absent means the agent has not said yet, which is not the same as no.
   * WITHDRAWAL IS NEVER SPONSORED, whatever this says.
   */
  gasSponsored?: boolean | null;
  /**
   * WHAT IS STOPPING THIS AGENT TRADING FOR REAL, as the child resolved it.
   *
   * One of the `RefuseRule` names — `no-gas`, `wrong-chain`, `dead-policy`,
   * `no-cash`, `not-armed`, `no-executor` — or null.
   *
   * REPORTED BY THE WORKER, never computed here, for exactly the reasons
   * `gasSponsored` above gives: the verdict depends on this child's own
   * balances, chain and executor, and a second guess from another container
   * would eventually disagree with the process that actually refuses trades.
   *
   * NULL IS TWO ANSWERS and a screen must render neither as a blocker: the
   * agent has never beaten, or it is trading for real. `mode` and
   * `workerAliveAt` are what separate those.
   */
  liveBlocker?: string | null;
  /**
   * THIS AGENT'S ENERGY — how much it may start on its own today, and why.
   *
   * REPORTED BY THE WORKER, never computed here: the process that throttles is
   * the only one that knows its own counters and whether it could read the
   * $MERRYMEN balances it throttles on (packages/core/src/energy.ts).
   *
   * NULL IS "NOT SAID YET", NEVER ZERO. No report, an old ledger without the
   * column, or a value that is not the v1 shape are all null, and a screen
   * renders that as "I can't see my energy" — never as an empty allowance, and
   * never as a balance of 0 that sends somebody to buy what they already hold.
   */
  energy?: EnergyStatus | null;
  /**
   * MAY THIS OWNER TAKE A NEW PERPS OPT-IN HERE? The operator's word for this
   * grant's account (perp-custody perpsOptInOffered: MERRYMEN_PERPS and,
   * hosted, MERRYMEN_PERPS_LIVE_TENANTS). The dashboard shows the box only
   * when true; keygen and the intake refuse a new key otherwise. Says nothing
   * about perps a grant already carries — those are carried whatever this is.
   */
  perpsOptIn?: boolean;
  /**
   * THIS AGENT'S PERPS — `agents.perps`, the worker's own report (core
   * PerpsReport), read by lib/agent-perps.ts and parsed by core's whitelist.
   *
   * REPORTED BY THE WORKER, never computed here: the worker is the one process
   * that holds the Lighter key and reads the venue, and this service must
   * never read an account's positions itself (docs/perps.md "Surfaces").
   *
   * NULL IS "NOT SAID OR UNREADABLE", NEVER "NO POSITIONS" (rule 11). The
   * mobile banner keys on this: anything but a report reading no exposure
   * keeps "Leveraged positions on Lighter…" or "Lighter could not be read…"
   * on screen, and a kill or discard sentence built from null for a grant
   * carrying the perps marker says Lighter is unread (lib/perps-view.ts).
   * Money is micro-USDG as decimal strings; no key of any kind is in it — the
   * parser drops every field the v1 shape does not name.
   */
  perps?: PerpsReport | null;
  /**
   * DOES THIS SERVER'S KILL QUEUE A PERPETUALS SHUTDOWN? Self-hosted writes
   * the local request; hosted requires shared storage and the sealed-key
   * supervisor. This is a capability, never a claim that positions are flat
   * or collateral has returned. Surfaces separately render perpsShutdown.
   */
  perpsStanddownOnKill?: boolean;
  /** Authenticated status only, with no grant, ciphertext or venue key. */
  perpsShutdown?: { state: string; expiresAtMs: number; smartAccount: string; result: Record<string, unknown> | null };
  perpsRecovery?: HostedPerpsRecoveryNotice;
}

export async function POST(req: Request) {
  const purpose = readRequestPurpose(req);
  if (!purpose) return NextResponse.json({ error: "Invalid account purpose" }, { status: 400 });
  const { DATA_DIR, GRANT_FILE } = grantFiles(purpose);
  const readDb: typeof withReadDb = fn => withReadDb(fn, isHostedMode() ? "spot" : purpose);
  let grant: StoredGrant;
  try { grant = await req.json() as StoredGrant; }
  catch { return NextResponse.json({ error: "not a JSON grant" }, { status: 400 }); }
  try { if (grantPurpose(grant) !== purpose) throw new Error(); }
  catch { return NextResponse.json({ error: "The signed grant does not match this account purpose.", code: "grant-purpose-mismatch" }, { status: 400 }); }
  if (purpose === "perps" && grant?.chainId !== 4663) return NextResponse.json({ error: "Dedicated Perps wallets use USDG on Robinhood Chain (4663)." }, { status: 400 });
  if (!grant?.serialized || !isAddr(grant?.smartAccount)) {
    return NextResponse.json({ error: "not a grant" }, { status: 400 });
  }

  // ── A GRANT THAT CAN NEVER BE INSTALLED ──────────────────────────────────
  //
  // Checked BEFORE anything else, and for every mode, because it is the one
  // defect that makes an agent look perfectly healthy while being unable to
  // execute a single operation. Kernel's CallPolicy refuses a repeated
  // (callType, target, selector), so such a grant reverts at validation —
  // `AA23 duplicate permissionHash` — before any policy is consulted, with
  // nothing in the message naming the wall or the trade.
  //
  // THE CASE THIS IS WRITTEN AGAINST is not a malicious payload. The wall is
  // built in the signing client, so an owner with a tab open from before a
  // deploy seals the OLD wall; the server stored it happily and the agent
  // spent hours refusing every trade. Three re-signs were spent before the
  // client, rather than the chain, was suspected. One check here turns that
  // into one sentence at signing time.
  //
  // REFUSED, NOT REPAIRED: the permissions sit inside the signed payload, so
  // de-duplicating them would store something the owner never signed — the
  // same reasoning as the zero-cap refusal below.
  const duplicates = duplicateWallPermissions(grant.serialized);
  if (duplicates.length > 0) {
    return NextResponse.json(
      {
        error:
          "this permission lists the same contract and function twice, and the account contract refuses to " +
          "install it — the agent would be unable to make any trade at all. It usually means the page was " +
          "open from before an update: reload and sign again.",
        duplicates,
      },
      { status: 400 },
    );
  }

  if (isHostedMode()) {
    // ── the hosted custody boundary ──────────────────────────────────────
    // On a public URL the server must NEVER become custodian of an owner key,
    // and must never let one tenant install a grant under another's account.
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });

    // REJECT any owner-key material — the named field, a raw 32-byte key, or a
    // mnemonic hiding anywhere in the payload. This is the single most important
    // check in the whole hosted migration: pass it and one DB dump drains
    // everyone. carriesOwnerKey is the shared definition (packages/core).
    if (carriesOwnerKey(grant)) {
      return NextResponse.json(
        { error: "this grant carries an owner key — hosted grants must be session-key-only" },
        { status: 422 },
      );
    }

    // AUTHORIZE ON THE SESSION ADDRESS, never on the self-declared grant.owner.
    // A tenant that could claim someone else's account would hijack their agent
    // id and ledger partition (the DB keys every table on smart_account).
    //
    // `owner` is a key the BROWSER generated, so it can never equal the tenant —
    // requiring that was why every hosted grant was refused. The claim is proved
    // instead by two signatures over one server-issued nonce: the wallet
    // authorizes this exact (owner, account, chain) pair, and the owner key
    // co-signs the same text. The second is what makes it unforgeable — without
    // it both remaining checks are functions of PUBLIC addresses, so anyone
    // could authorize anyone else's pair and squat their partition.
    if (!isAddr(grant.owner)) {
      return NextResponse.json({ error: "grant owner is not an address" }, { status: 400 });
    }
    // ── A CAP OF ZERO PERMITS NOTHING, AND A SIGNATURE CANNOT BE EDITED ────
    //
    // `maxDrawdownPct: 0` makes policy.ts compute `0bps >= 0bps` and refuse
    // every non-exit intent for the life of the grant; a zero per-trade or
    // daily cap refuses every trade outright; zero ops or zero days is an agent
    // that is finished before it starts. None of it is recoverable without a
    // re-sign, and one agent on the fleet is stuck in exactly that state.
    //
    // The browser clamps too. This is the second gate, because the clamp there
    // is a UI convenience and this route accepts a POST from anywhere — and
    // because a bricked grant is the one mistake nothing downstream can undo.
    // REFUSED RATHER THAN REPAIRED: the caps are inside the signed payload, so
    // "fixing" one here would store something the owner did not sign.
    const zeroCap = (["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"] as const).find(
      (k) => !Number.isFinite(grant.caps?.[k]) || Number(grant.caps?.[k]) < 1,
    );
    if (zeroCap) {
      return NextResponse.json(
        {
          error:
            `${zeroCap} is ${String(grant.caps?.[zeroCap])}, which permits nothing — and a signature cannot be ` +
            `edited afterwards, so this grant would be unusable forever. Set it to at least 1 and sign again.`,
        },
        { status: 400 },
      );
    }

    // ── THE SERVER STORES THE MERRYMEN WALL, OR NOTHING ──────────────────
    //
    // Every check above is about WHO is asking and whether the caps are
    // usable. None of them looked at what the permission actually permits —
    // and the worker trusts this payload's metadata about exactly that:
    // `grantFeatures` opens routes in its mirror (limitsFromGrant), a
    // `transfer` marker dated before the withdrawal allowlist is read as a
    // free-form-recipient transfer (grantHasTransfer), and `grantTokens` and
    // the sealed adapters say what it may sell and call. A tenant could post a
    // hand-built permission carrying a USDG `transfer`, the Rialto target or
    // the v4 UniversalRouter, and it was stored as-is. The site's terms say the
    // session key has no transfer permission; this is what makes that true of
    // everything this route accepts, not only of what our signers produce.
    //
    // The same rebuild-and-compare partner enrollment has always done
    // (canonical-wall.ts): the canonical wall is rebuilt from this grant's own
    // caps, times, tokens and sealed addresses and compared byte for byte with
    // what the worker would install, and any marker the wall does not mint is
    // refused.
    //
    // BEFORE THE BINDING, because it is pure: a refusal here costs no RPC and
    // burns no single-use nonce.
    //
    // A STALE CLIENT IS REFUSED TOO, deliberately. The wall is built in the
    // signing client, so a tab open from before a deploy that changed wall.ts
    // seals the OLD wall — which is no longer what this server, or the worker's
    // mirror, believes a grant permits. Everything per-owner (tokens, adapters,
    // vaults, Trencher scope) is read from the grant itself, so only a change
    // to wall.ts can cause this, and the remedy is the one the duplicate
    // refusal above already gives: reload and sign again.
    const wall = checkCanonicalWall(grant as unknown as Record<string, unknown>);
    if (!wall.ok) {
      return NextResponse.json(
        {
          error:
            `${wall.why}. This service only accepts the Merrymen permission wall. If this page was open ` +
            `from before an update, reload it and sign again.`,
          code: wall.code,
        },
        { status: wall.status },
      );
    }

    const binding = grant.binding;
    // Version-agnostic presence check. WHICH signatures a claim needs is the
    // validator's decision, not this route's — demanding a walletSignature here
    // would hard-code the legacy model into a route that is about to serve two.
    if (!binding?.nonce || !binding.ownerSignature) {
      return NextResponse.json(
        { error: "this grant isn't linked to your login — create it again from a signed-in browser" },
        { status: 403 },
      );
    }
    // A CLAIM MAY NOT CARRY EVIDENCE ITS OWN VERSION DOES NOT USE. `did` is
    // only meaningful under `privy-did-owner-v1`; arriving on a legacy claim it
    // is unverified client text that would be persisted verbatim and read back
    // later as though the server had checked it.
    if (binding.version === "privy-did-owner-v1" && typeof binding.did !== "string") {
      return NextResponse.json(
        { error: "this grant claims a privy binding but names no identity" },
        { status: 400 },
      );
    }
    if (binding.did !== undefined && binding.version !== "privy-did-owner-v1") {
      return NextResponse.json(
        { error: "this grant carries an identity its binding version does not verify" },
        { status: 400 },
      );
    }
    // ── the privy arm needs a VERIFIED token, and this is where it is read ──
    //
    // verifyGrantBinding holds no Privy credential and does no token
    // verification: it is handed the DID or it refuses. So a grant declaring
    // `privy-did-owner-v1` must arrive with its access token, and a deployment
    // that cannot verify one cannot accept the binding — which is the correct
    // failure, not a fallback to the legacy check.
    let verifiedDid: string | null = null;
    if (binding.version === "privy-did-owner-v1") {
      const token = await verifyPrivyToken(privyTokenOf(req));
      if (!token.ok) return NextResponse.json({ error: token.why }, { status: 401 });
      verifiedDid = token.identity.did;
    }

    const bound = await verifyGrantBinding({
      origin: requestOrigin(req),
      tenant,
      nonce: binding.nonce,
      owner: grant.owner,
      smartAccount: grant.smartAccount,
      chainId: grant.chainId,
      purpose,
      walletSignature: binding.walletSignature,
      ownerSignature: binding.ownerSignature,
      // PASSED THROUGH UNVALIDATED, ON PURPOSE. verifyGrantBinding is the one
      // place that decides which security model a claim was made under, and it
      // refuses anything it does not recognise. Omitting this — which an
      // earlier revision of this file did — makes the whole dispatch
      // unreachable: every claim resolves to the default, so a grant declaring
      // `privy-did-owner-v1` would be verified under LEGACY rules instead of
      // refused, which is precisely the downgrade the versioning exists to stop.
      version: binding.version,
      did: binding.did,
      verifiedDid,
    });
    if (!bound.ok) {
      return NextResponse.json({ error: bound.why }, { status: 403 });
    }

    // FIRST CLAIM WINS. Two tenants must never share a smart account, because
    // every ledger table keys on it — they would silently write into one
    // partition. Possession of the owner key is already proved above, so this is
    // not a security boundary so much as a collision guard, and it fails safe:
    // an unreadable store refuses rather than allowing a possible collision.
    try {
      const holder = await getGrantStore(purpose).tenantForAccount(grant.smartAccount);
      if (holder && holder !== tenant) {
        return NextResponse.json(
          { error: "this agent account is already linked to a different login" },
          { status: 409 },
        );
      }
    } catch {
      return NextResponse.json(
        // Written for the owner, so it is marked as such: a 5xx body is not
        // shown to them otherwise (terminal/request-json.ts).
        { error: "couldn't check this account's ownership — please try again", ownerFacing: true },
        { status: 503 },
      );
    }

    // ── THE LIGHTER KEY (docs/perps.md rule 5) ─────────────────────────────
    //
    // After the binding, so only a tenant proven to hold this claim reaches a
    // store read or a venue read; before the derivation, because both of
    // these refuse on facts the derivation cannot change.
    //
    // (1) The block this grant carries must name a key this service holds for
    //     THIS tenant and account: its sealed blob opens under that AAD, or the
    //     stored grant for the same account carries the same public key and its
    //     blob is re-attached here (carry-forward — GET never returns a blob, so
    //     a phone re-signing has only the public key).
    // (2) A grant that lets go of a venue key — the stored one carries perps and
    //     this one drops the block, names another account, or names another
    //     public key (a rotation strands the registered one) — is refused
    //     unless that venue reads provably flat. The only layer an app build
    //     that predates perps cannot sign its way past.
    //
    // An unreadable store refuses, as the ownership read above does: the stored
    // grant is exactly what (1) and (2) are about.
    let stored: StoredGrant | null;
    try {
      stored = await getGrantStore(purpose).get(tenant);
    } catch {
      return NextResponse.json(
        { error: "couldn't read this agent's current permission to check it — please try again", ownerFacing: true },
        { status: 503 },
      );
    }
    const otherRefusal = await otherPurposeRefusal(grant, purpose, tenant);
    if (otherRefusal) return otherRefusal;
    const perpIntake = acceptIncomingPerp({
      hosted: true,
      tenant,
      incoming: grant,
      stored,
      dek: storeDek(),
      home: DATA_DIR,
      perpsOffered: perpsOptInOffered(grant.smartAccount),
    });
    if (!perpIntake.ok) return perpRefused(perpIntake.refusal);
    const recoveryRefusal = await perpRecoveryIntakeRefusal(stored, grant, undefined, { home: DATA_DIR, readDb });
    if (recoveryRefusal) return perpRefused(recoveryRefusal);
    const drop = await perpDropRefusal({ stored, incoming: grant });
    if (drop) return perpRefused(drop);
    const toStore = carryPerpRecovery(stored, perpIntake.grant);

    // FIRST-ARM IDENTITY PROOF. owner == tenant above only proves the CLAIMED
    // owner is this wallet — it says nothing about smartAccount, which the client
    // supplied as free JSON. A tenant could keep grant.owner == their own wallet
    // yet point grant.smartAccount at SOMEONE ELSE'S account and squat its ledger
    // partition (every table keys on smart_account). So recompute the
    // counterfactual Kernel address from the owner and require it to match the
    // claimed account. deserializePermissionAccount elsewhere reads accountAddress
    // straight from the grant; THIS is the check that makes that address earned.
    // Fail CLOSED: if derivation can't be verified (bad chain id, RPC hiccup),
    // refuse rather than trust the client — a rejected honest grant is retried, a
    // trusted dishonest one is not undoable.
    //
    // THE COMPARISON TAKES THE RESULT, NOT THE ADDRESS. The derivation is a
    // live eth_call that can answer 0x0000...0000 without throwing, and if the
    // browser answered the same zero the two would MATCH — the fault would make
    // this check pass rather than fail. accountsMatch refuses a failed
    // derivation before any equality is computed. See packages/core/derivation.
    let derived: Derivation;
    try {
      derived = await deriveKernelAccountAddress(grant.owner as `0x${string}`, grant.chainId, purpose);
    } catch (e) {
      derived = derivationUnreachable(e instanceof Error ? e.message : String(e));
    }
    if (!derived.ok) {
      // `zero` and `malformed` are the chain answering wrongly, not the client
      // claiming wrongly — 503 so an honest grant is retried rather than told
      // its account is a forgery.
      return NextResponse.json({ error: derived.why }, { status: 503 });
    }
    const match = accountsMatch(derived, grant.smartAccount);
    if (!match.ok) {
      return NextResponse.json({ error: match.why }, { status: 403 });
    }

    // Persist to the per-tenant store, keyed on the authenticated tenant. The
    // store seals the session key at rest and refuses (again, defence in depth)
    // any grant carrying an owner key or whose owner isn't this tenant.
    try {
      await getGrantStore(purpose).put(tenant, toStore);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "store failed" }, { status: 500 });
    }

    // MINT THE PUBLIC ID HERE, and only here.
    //
    // This is the one place in the codebase where an authenticated tenant and a
    // DERIVATION-VERIFIED smart account exist together — the counterfactual
    // address was re-derived and checked a few lines above, so neither value is
    // taken on trust. The identity is keyed on the tenant, so a re-grant appends
    // the new account and leaves the slug (and every link and follow edge
    // pointing at it) exactly where it was.
    //
    // BEST EFFORT ON PURPOSE. The grant is already durably stored and the money
    // path is done; failing the request now would tell the owner their agent was
    // not created when it was.
    //
    // The backfill for an agent that misses this is in the ORCHESTRATOR, in
    // writeGrantForChild — not "a later read", which is what this comment used
    // to claim and which was never built. It could not be a read: the public
    // routes are cached and unauthenticated, and an anonymous GET that mints
    // identities is a write nobody asked for.
    //
    // THE IDENTITY IS READ BEFORE IT IS ENSURED, and a new agent with no name
    // gets its slug's name — see mintAndNameAgent, which a test runs with a
    // fake identity store. Best effort: it never throws.
    await mintAndNameAgent({
      tenant,
      account: grant.smartAccount,
      identities: () => ({
        get: tenant => getIdentityStore().get(tenant),
        ensure: (tenant, account) => getIdentityStore().ensure(tenant, account, { primary: purpose === "spot" }),
      }),
      settings: {
        get: () => getSettingsStore(purpose).get(tenant),
        put: (s) => getSettingsStore(purpose).put(tenant, s),
      },
      ledgerHasAgent: (account) => ledgerHasAgent(readDb, account),
    });
    return NextResponse.json({ ok: true });
  }

  try {
    return await withLocalGrantLock(purposeHome(), async () => {
    // ── THE LIGHTER KEY, SELF-HOSTED (docs/perps.md rule 5) ─────────────────
    //
    // BEFORE the archive, because the archive is the first thing that moves the
    // outgoing grant. The same two checks as hosted: the block must name a key
    // this install's key store holds ($MERRYMEN_HOME/perp-keys/<pub>.json), and
    // a grant that lets go of a venue key needs that venue provably flat.
    //
    // A grant.json that exists but cannot be read is refused rather than
    // assumed empty: it is exactly the grant (2) is about. A corrupt one is let
    // through unless it mentions the perps marker — a file that cannot say it
    // held perps cannot be the reason to keep an owner from re-signing.
    let stored: StoredGrant | null = null;
    let storedRaw: string | null = null;
    try {
      storedRaw = await readFile(GRANT_FILE, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return NextResponse.json(
          { error: "couldn't read this agent's current permission to check it — please try again", ownerFacing: true },
          { status: 503 },
        );
      }
    }
    if (storedRaw !== null) {
      try {
        stored = JSON.parse(storedRaw) as StoredGrant;
      } catch {
        if (purpose === "perps" || storedRaw.includes(GRANT_PERP_LIGHTER)) {
          return perpRefused({
            status: 409,
            code: "perp-venue-unread",
            error: `the current grant.json cannot be read, so merrymen must assume ${PERP_NOT_FLAT_MESSAGE}`,
            flat: null,
          });
        }
      }
    }
    if (stored && grantPurpose(stored) !== purpose) return NextResponse.json({ error: "Stored account purpose could not be verified." }, { status: 503 });
    const otherRefusal = await otherPurposeRefusal(grant, purpose, null);
    if (otherRefusal) return otherRefusal;
    const perpIntake = acceptIncomingPerp({
      hosted: false,
      tenant: null,
      incoming: grant,
      stored,
      dek: null,
      home: DATA_DIR,
      perpsOffered: perpsOptInOffered(grant.smartAccount),
    });
    if (!perpIntake.ok) return perpRefused(perpIntake.refusal);
    const recoveryRefusal = await perpRecoveryIntakeRefusal(stored, grant, undefined, { home: DATA_DIR, readDb });
    if (recoveryRefusal) return perpRefused(recoveryRefusal);
    const drop = await perpDropRefusal({ stored, incoming: grant });
    if (drop) return perpRefused(drop);

    await mkdir(DATA_DIR, { recursive: true });
    // Keep the outgoing wallet (and its owner key) before this one replaces it.
    await archiveCurrentGrant(purpose);
    // grant.json holds the owner + session PRIVATE KEYS — owner-only perms (0600).
    await replaceLocalGrant(GRANT_FILE, JSON.stringify(carryPerpRecovery(stored, perpIntake.grant), null, 2));
    return NextResponse.json({ ok: true });
    });
  } catch (error) {
    if (error instanceof LocalGrantBusyError) return NextResponse.json({ error: error.message, ownerFacing: true }, { status: 503 });
    throw error;
  }
}

export async function DELETE(req: Request) {
  const purpose = readRequestPurpose(req);
  if (!purpose) return NextResponse.json({ error: "Invalid account purpose" }, { status: 400 });
  const { DATA_DIR, GRANT_FILE } = grantFiles(purpose);
  const readDb: typeof withReadDb = fn => withReadDb(fn, isHostedMode() ? "spot" : purpose);
  if (isHostedMode()) {
    // The kill switch is per-tenant and authenticated. It forgets the server's
    // session key; the wallet and its funds stay reachable via the owner key
    // the browser still holds (client-side recovery). Nothing to archive here
    // — the server never held the owner key to begin with.
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    // PgGrantStore.remove atomically revokes the session grant and queues the
    // sealed venue-only key with an immutable deadline. This response says
    // queued, never closed: only the authenticated shutdown result can say so.
    let custody: string | null = null;
    try {
      const g = await getGrantStore(purpose).get(tenant);
      // Bounded: the kill must not wait on a custody sentence. No answer in
      // time is no sentence, and clients fall back to their own last read.
      custody = g
        ? await Promise.race([
            perpsHostedKillCustody(g),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000).unref?.()),
          ])
        : null;
    } catch {
      custody = null;
    }
    await getGrantStore(purpose).remove(tenant);
    const perpsShutdown = await shutdownStatus(tenant, purpose);
    return NextResponse.json({ ok: true, ...(custody === null ? {} : { custody }), standdown: null, ...(perpsShutdown ? { perpsShutdown } : {}) });
  }
  try {
    return await withLocalGrantLock(purposeHome(), async () => {
    // ── STAND THE PERPS DOWN FIRST (docs/perps.md rule 13) ──────────────────
    //
    // BEFORE the archive, because the archive is what takes the grant — and with
    // it the worker's knowledge of the account and its Lighter key — away. A
    // grant that mentions perps gets a stand-down request in the home, and this
    // waits a short while for the worker's result (lib/perp-kill.ts). A request
    // that cannot be written stops the kill here, with the grant untouched: the
    // agent is still running and still protecting what it holds, which is
    // better than an archived key and positions nobody was asked to close.
    //
    // A grant.json that cannot be parsed is asked about by what it mentions: one
    // naming the perps marker is treated as a perps grant, because the stand-down
    // is exits only and asking for one that is not needed costs nothing.
    let stored: unknown = null;
    try {
      const raw = await readFile(GRANT_FILE, "utf8");
      try {
        stored = JSON.parse(raw) as unknown;
      } catch {
        stored = raw.includes(GRANT_PERP_LIGHTER) ? { grantFeatures: [GRANT_PERP_LIGHTER] } : null;
      }
    } catch {
      // no grant.json: nothing armed, nothing at a venue that this kill can ask about
    }
    const account = (stored as { smartAccount?: unknown } | null)?.smartAccount;
    // The report AND the account's own book (agents.mode): a practice position
    // held while practice perps are off is reported under rail "off", and only
    // the book says it is practice (perps-view.ts perpsBookOf).
    const read = isAddr(account) ? await readAgentPerpsRead(account, readDb) : null;
    const report = read?.state === "ok" ? read.report : null;
    const accountMode = read?.state === "ok" ? (read.accountMode ?? null) : null;
    const perps = await standDownForKill({ home: DATA_DIR, grant: stored, report, accountMode });
    if (!perps.ok) {
      return NextResponse.json({ error: perps.error, ownerFacing: true }, { status: 503 });
    }
    // The kill switch destroys the session key, NOT the wallet — archive it so the
    // owner key survives and the funds stay reachable.
    await archiveCurrentGrant(purpose);
    await rm(GRANT_FILE, { force: true });
    // WHERE THE MONEY IS, in the one sentence that is never a constant: built
    // from the stand-down's result when the worker answered, else from its last
    // report, and saying so (core custodySentence).
    return NextResponse.json({ ok: true, custody: perps.custody, standdown: perps.standdown });
    });
  } catch (error) {
    if (error instanceof LocalGrantBusyError) return NextResponse.json({ error: error.message, ownerFacing: true }, { status: 503 });
    throw error;
  }
}

/**
 * EVERY GET ANSWER IS PER-USER AND NEVER STORED — `{exists:false}` included.
 * Next 15 adds no Cache-Control to a dynamic route handler, so without this a
 * browser or proxy may keep one owner's status (their account, caps and, with
 * perps, their Lighter public key) on disk. The api/agents/[slug]/own
 * precedent, applied to the route every screen polls.
 */
function statusResponse(status: AgentStatus): NextResponse {
  return NextResponse.json(status, { headers: NO_STORE_HEADERS });
}

export async function GET(req: Request) {
  const purpose = readRequestPurpose(req);
  if (!purpose) return NextResponse.json({ error: "Invalid account purpose" }, { status: 400, headers: NO_STORE_HEADERS });
  const { GRANT_FILE, HEARTBEAT_FILE } = grantFiles(purpose);
  const readDb: typeof withReadDb = fn => withReadDb(fn, isHostedMode() ? "spot" : purpose);
  let grant: StoredGrant;
  if (isHostedMode()) {
    const tenant = tenantOf(req);
    if (ownerMismatch(new URL(req.url).searchParams.get("owner"), tenant)) {
      return NextResponse.json({ error: "The signed-in owner changed. Refresh this page before continuing." }, { status: 409, headers: NO_STORE_HEADERS });
    }
    if (!tenant) return statusResponse({ exists: false });
    const g = await getGrantStore(purpose).get(tenant);
    if (!g) {
      const perpsShutdown = await shutdownStatus(tenant, purpose);
      const perpsRecovery = await recoveryStatus(tenant, undefined, purpose);
      return statusResponse({ exists: false, ...(perpsShutdown ? { perpsShutdown } : {}), ...(perpsRecovery ? { perpsRecovery } : {}) });
    }
    grant = g;
  } else {
    try {
      grant = JSON.parse(await readFile(GRANT_FILE, "utf8")) as StoredGrant;
    } catch {
      return statusResponse({ exists: false });
    }
  }

  try { if (grantPurpose(grant) !== purpose) throw new Error(); }
  catch { return NextResponse.json({ error: "Stored account purpose could not be verified." }, { status: 503, headers: NO_STORE_HEADERS }); }
  const chain = chainForId(grant.chainId);
  const client = createPublicClient({ chain, transport: webChainRead() });

  // A READ THAT FAILED IS NULL, NOT ZERO — see grant-balances.ts. Zero here
  // is what told funded owners to "Add funds" whenever the node was slow. The
  // calls themselves live there too, where a test runs them against a client
  // that refuses.
  const balances = await readGrantBalancesFrom(client, grant.smartAccount);

  let workerAliveAt: number | null = null;
  let mode: AgentStatus["mode"] = null;
  let gasSponsored: boolean | null = null;
  let liveBlocker: string | null = null;
  try {
    const hb = JSON.parse(await readFile(HEARTBEAT_FILE, "utf8")) as {
      at: number;
      mode?: AgentStatus["mode"];
      sponsorGas?: boolean;
    };
    workerAliveAt = hb.at;
    mode = hb.mode ?? null;
    // Absent on a heartbeat written before this field existed — unknown, not no.
    gasSponsored = hb.sponsorGas ?? null;
  } catch {
    // no heartbeat file — worker never ran, or (hosted) it beats somewhere
    // this process cannot see. Fall through to the ledger.
  }

  // HOSTED READS THE LEDGER, because the file above is in this service's own
  // MERRYMEN_HOME and the worker writes into its tenant's — different
  // directories, different containers. Every hosted tenant reported IDLE
  // regardless of what their agent was doing, which made the LIVE/PAPER chip
  // decorative exactly where it matters most.
  //
  // The file still wins when present: self-hosted it is the same worker on the
  // same disk, so it is fresher than a mirror that runs on its own clock.
  if (workerAliveAt === null) {
    try {
      const row = await readDb(async (db) =>
        db
          ? ((await db
              .prepare("SELECT mode, beat_at, sponsor_gas, live_blocker FROM agents WHERE smart_account = ?")
              .get(grant.smartAccount)) as
              | {
                  mode?: string | null;
                  beat_at?: number | null;
                  sponsor_gas?: number | null;
                  live_blocker?: string | null;
                }
              | undefined)
          : undefined,
      );
      if (row?.beat_at) {
        workerAliveAt = Number(row.beat_at);
        mode = (row.mode as AgentStatus["mode"]) ?? null;
        // Nullable at the source, so distinguish 'has not said' from 'no'.
        gasSponsored =
          row.sponsor_gas === null || row.sponsor_gas === undefined ? null : Number(row.sponsor_gas) === 1;
        liveBlocker = row.live_blocker ?? null;
      }
    } catch {
      // an unreadable ledger is an unknown mode, not a claim about one
    }
  }

  // ENERGY IS READ ON ITS OWN, OUTSIDE THE BRANCH ABOVE. That branch runs only
  // when there is no heartbeat file, and self-hosted there always is one — so a
  // column read inside it would never reach a self-hosted owner at all. The
  // report is the child's own and lives only on the agents row, on both
  // deployments. Best effort: an unreadable report is null, never an error.
  const energy = await readAgentEnergy(grant.smartAccount, readDb);
  // PERPS THE SAME WAY, for the same reason: the report lives only on the
  // agents row, on both deployments, so its read sits outside the heartbeat
  // branch too. Best effort: unreadable is null, never an error and never [].
  const perps = await readAgentPerps(grant.smartAccount, readDb);

  // NEVER ECHO KEY MATERIAL, BY CONSTRUCTION: the grant goes out through core's
  // publicGrantView, an ALLOWLIST. This used to be a denylist spread
  // (serialized, the session key, the owner key) — safe exactly until a field
  // was added, and perps add a nested one a top-level denylist cannot see into.
  // Every field a screen reads (web, iOS, Android) is on the allowlist; a field
  // nobody listed is simply not shown. public-view.test.ts deep-scans this
  // answer, both deployments, for every secret in every spelling.
  const status: AgentStatus = {
    exists: true,
    grant: publicGrantView(grant),
    balances,
    workerAliveAt,
    mode,
    gasSponsored,
    liveBlocker,
    energy,
    perpsOptIn: perpsOptInOffered(grant.smartAccount),
    perps,
    perpsStanddownOnKill: !isHostedMode() || hostedStanddownAvailable(),
  };
  if (isHostedMode()) {
    const tenant = tenantOf(req);
    const perpsRecovery = tenant ? await recoveryStatus(tenant, grant.smartAccount, purpose) : null;
    if (perpsRecovery) status.perpsRecovery = perpsRecovery;
  }
  return statusResponse(status);
}

async function recoveryStatus(tenant: string, account?: string, purpose: GrantPurpose = "spot"): Promise<HostedPerpsRecoveryNotice | null> {
  try {
    if (purpose === "perps" && !account) {
      const shutdown = await shutdownStatus(tenant as `0x${string}`, purpose);
      if (!shutdown) return null;
      account = shutdown.smartAccount;
    }
    return await withReadDb((db) => db ? readHostedPerpsRecovery(db, tenant, account) : Promise.resolve(unknownHostedPerpsRecovery()));
  } catch {
    return unknownHostedPerpsRecovery();
  }
}

/**
 * THE HOSTED KILL'S CUSTODY SENTENCE, for a grant about to be removed: what
 * the agent's last report says is at Lighter (core custodySentence, never a
 * constant), prefixed — when there is anything there, or may be — with the
 * plain fact that this kill closed nothing. The owner's recover path is the
 * hosted one (perps-view.ts HOSTED_RECOVER_PATH). Null for an agent with
 * nothing at Lighter and no perps marker: the kill says what it always said.
 */
async function perpsHostedKillCustody(grant: StoredGrant): Promise<string | null> {
  const read = await readAgentPerpsRead(grant.smartAccount);
  const exposure =
    read.state === "unreadable"
      ? ({ kind: "unread" } as const)
      : perpExposureOfReport(read.state === "ok" ? read.report : null, {
          grantMentionsPerps: grantMentionsPerps(grant),
          nowMs: Date.now(),
          accountMode: read.state === "ok" ? read.accountMode : null,
        });
  if (exposure.kind === "none") return null;
  return (
    (hostedStanddownAvailable()
      ? "A temporary venue-only shutdown is being queued for up to 15 minutes. Closing and withdrawal are not confirmed; resting stops stay until each position reads flat. "
      : "This server cannot run a hosted venue shutdown; open positions retain only their resting stops. ") + custodyText(exposure, { hosted: true })
  );
}

async function shutdownStatus(tenant: `0x${string}`, purpose: GrantPurpose = "spot"): Promise<AgentStatus["perpsShutdown"] | undefined> {
  if (!hostedStanddownAvailable()) return undefined;
  const store = new HostedStanddownStore(await makePgDb(process.env.DATABASE_URL!), storeDek()!);
  await store.init();
  const job = await store.latest(tenant, purpose);
  if (!job) return undefined;
  // Every field is allowlisted. In particular the encrypted checkpoint and
  // sealed venue key never reach status, even after the grant is gone.
  return { state: job.state, expiresAtMs: job.expiresAtMs, smartAccount: job.smartAccount,
    result: job.resultJson ? JSON.parse(job.resultJson) as Record<string, unknown> : null };
}
