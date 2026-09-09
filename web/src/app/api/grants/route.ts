/**
 * Dev-mode grant handoff + agent status.
 * POST: browser saves a signed grant → .data/grant.json (worker picks it up).
 * GET: full agent status — grant, live balances from the grant chain, worker heartbeat.
 * DELETE: discard the grant file (localStorage cleared client-side).
 * Replaced by Supabase (encrypted, per-user) once persistence lands.
 */

import { webChainRead } from "@/lib/chain-read";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { homePaths, merrymenHome } from "@merrymen/home";
import { createPublicClient, parseAbi } from "viem";
import {
  CASH,
  MORPHO,
  accountsMatch,
  carriesOwnerKey,
  chainForId,
  derivationUnreachable,
  isHostedMode,
  type Derivation,
  type StoredGrant,
} from "@merrymen/core";
import { requestOrigin, tenantOf, verifyGrantBinding } from "@/lib/auth";
import { privyTokenOf, verifyPrivyToken } from "@/lib/privy";
import { withReadDb } from "@/lib/ledger";
import { getGrantStore } from "@merrymen/grant-store";
import { getIdentityStore } from "@merrymen/identity-store";
import { deriveKernelAccountAddress } from "@/lib/derive-account";

const DATA_DIR = merrymenHome();
const GRANT_FILE = homePaths.grant();
const HEARTBEAT_FILE = homePaths.heartbeat();
const ARCHIVE_DIR = homePaths.grantsArchive();

const BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** A well-formed 0x EVM address — the ONLY thing we ever build an archive filename
 * from. Rejecting anything else keeps `smartAccount` from smuggling path separators
 * (../, absolute paths) into archiveCurrentGrant's `${addr}.json`. */
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Copy whatever grant.json currently holds into the archive, keyed by its smart
 * account, BEFORE we overwrite or delete it.
 *
 * grant.json is a single slot: creating a second wallet (or hitting the kill
 * switch) used to destroy the previous grant — and with it the ONLY on-disk copy
 * of that wallet's owner key, permanently stranding any funds still in it. This
 * is the safety net. Best-effort: archiving must never block arming a grant.
 */
async function archiveCurrentGrant(): Promise<void> {
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
  grant?: Omit<StoredGrant, "serialized" | "demoSessionPrivateKey" | "demoOwnerPrivateKey">;
  balances?: { ethWei: string; cashUsdg: string; vaultUsdg: string };
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
}

export async function POST(req: Request) {
  const grant = (await req.json()) as StoredGrant;
  if (!grant?.serialized || !isAddr(grant?.smartAccount)) {
    return NextResponse.json({ error: "not a grant" }, { status: 400 });
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
      const holder = await getGrantStore().tenantForAccount(grant.smartAccount);
      if (holder && holder !== tenant) {
        return NextResponse.json(
          { error: "this agent account is already linked to a different login" },
          { status: 409 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: "couldn't check this account's ownership — please try again" },
        { status: 503 },
      );
    }

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
      derived = await deriveKernelAccountAddress(grant.owner as `0x${string}`, grant.chainId);
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
      await getGrantStore().put(tenant, grant);
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
    try {
      await getIdentityStore().ensure(tenant, grant.smartAccount as `0x${string}`);
    } catch (e) {
      console.error("[grants] could not mint a public id:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ ok: true });
  }

  await mkdir(DATA_DIR, { recursive: true });
  // Keep the outgoing wallet (and its owner key) before this one replaces it.
  await archiveCurrentGrant();
  // grant.json holds the owner + session PRIVATE KEYS — owner-only perms (0600).
  await writeFile(GRANT_FILE, JSON.stringify(grant, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(GRANT_FILE, 0o600).catch(() => {});
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (isHostedMode()) {
    // The kill switch is per-tenant and authenticated. It forgets the server's
    // session key; the wallet and its funds stay reachable via the owner key
    // the browser still holds (client-side recovery). Nothing to archive here
    // — the server never held the owner key to begin with.
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    await getGrantStore().remove(tenant);
    return NextResponse.json({ ok: true });
  }
  // The kill switch destroys the session key, NOT the wallet — archive it so the
  // owner key survives and the funds stay reachable.
  await archiveCurrentGrant();
  await rm(GRANT_FILE, { force: true });
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  let grant: StoredGrant;
  if (isHostedMode()) {
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ exists: false } satisfies AgentStatus);
    const g = await getGrantStore().get(tenant);
    if (!g) return NextResponse.json({ exists: false } satisfies AgentStatus);
    grant = g;
  } else {
    try {
      grant = JSON.parse(await readFile(GRANT_FILE, "utf8")) as StoredGrant;
    } catch {
      return NextResponse.json({ exists: false } satisfies AgentStatus);
    }
  }

  const chain = chainForId(grant.chainId);
  const client = createPublicClient({ chain, transport: webChainRead() });

  const [ethWei, tokenReads] = await Promise.all([
    client.getBalance({ address: grant.smartAccount }).catch(() => 0n),
    client
      .multicall({
        contracts: [
          { address: CASH.USDG as `0x${string}`, abi: BALANCE_ABI, functionName: "balanceOf", args: [grant.smartAccount] },
          { address: MORPHO.steakhouseUsdgVault as `0x${string}`, abi: BALANCE_ABI, functionName: "balanceOf", args: [grant.smartAccount] },
        ],
      })
      .catch(() => null),
  ]);

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
      const row = await withReadDb(async (db) =>
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

  // Never echo key material to the browser: the serialized session account, the
  // session key, AND the generated owner key (which custodies the funds).
  const { serialized: _s, demoSessionPrivateKey: _k, demoOwnerPrivateKey: _o, ...publicGrant } = grant;

  const status: AgentStatus = {
    exists: true,
    grant: publicGrant,
    balances: {
      ethWei: ethWei.toString(),
      cashUsdg: (tokenReads?.[0]?.status === "success" ? (tokenReads[0].result as bigint) : 0n).toString(),
      vaultUsdg: (tokenReads?.[1]?.status === "success" ? (tokenReads[1].result as bigint) : 0n).toString(),
    },
    workerAliveAt,
    mode,
    gasSponsored,
    liveBlocker,
  };
  return NextResponse.json(status);
}
