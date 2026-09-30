/**
 * `merrymen recover` worker entry — invoked by cli/bin.mjs via tsx. Kept out of
 * the CLI itself because rebuilding a ZeroDev Kernel account needs viem +
 * @zerodev, which the zero-dependency CLI doesn't carry.
 *
 * Contract with bin.mjs:
 *   argv:  <plan|sweep|venue-claim|venue-unwind> <destination> [chainId]
 *   env:   MERRYMEN_RECOVER_OWNER_KEY      the owner private key (never logged)
 *          MERRYMEN_RECOVER_EXPECT         optional expected smart-account address
 *          MERRYMEN_RECOVER_PERP_PUBKEY    optional: the grant's sealed Lighter public
 *                                          key (PUBLIC), only to label the key slot
 *          MERRYMEN_RECOVER_VENUE_APPROVED venue modes only: the `approved` object of
 *                                          the offer the owner typed the word for
 *
 * Human progress → stderr (streamed live). One machine result line → stdout:
 *   __RESULT__{json}
 * so the CLI can decide what to do next without scraping prose.
 *
 * THE VENUE MODES (docs/perps.md, "Recover") sign ONE owner UserOp of Lighter
 * priority requests — the claim, or the unwind — after recover.ts re-reads
 * the venue and checks the step is still the one approved. The destination
 * argument is ignored there: every Lighter leg can only ever pay the smart
 * account itself, and the ordinary sweep moves it on.
 */

import { chainForId, LIGHTER_ROUTE_V1, pimlicoBundlerUrl, robinhoodChain, validatePerpPubKey } from "../../packages/core/src/index";
import { merrymenHome } from "./home";
import { markOwnerRotationSeen, recordOwnerRotation, retiredKeysFor } from "./perps-local";
import { resolveConfig } from "./settings";
import {
  ownerFromPrivateKey,
  planRecovery,
  readVenueKeySlot,
  recoverFunds,
  recoverVenueStep,
  venueDisclosure,
  venueStanding,
  type ApprovedVenueStep,
  type VenueCallName,
  type VenueDisclosure,
} from "./recover";

const say = (s: string) => process.stderr.write(`${s}\n`);
const emit = (obj: unknown) => process.stdout.write(`__RESULT__${JSON.stringify(obj)}\n`);

/**
 * The venue group on stderr, grouped by custody like the account's own
 * disclosure. Printed whenever there IS a Lighter account (or it could not be
 * read); an agent that never deposited gets no Lighter lines at all.
 */
function sayVenue(d: VenueDisclosure, accountHadVenue: boolean) {
  if (!accountHadVenue) return;
  say(`  lighter       : ${d.headline}`);
  for (const g of d.groups) {
    say(`    ${g.title}`);
    for (const line of g.lines) say(`      • ${line}`);
  }
  for (const n of d.notes) say(`    NOTE: ${n}`);
}

/** The approved step from the CLI, checked field by field — it becomes what the executor must match. */
function parseApproved(raw: string | undefined, mode: string): ApprovedVenueStep | null {
  if (!raw) return null;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!x || typeof x !== "object") return null;
  const a = x as Record<string, unknown>;
  if (typeof a.accountIndex !== "number" || !Number.isSafeInteger(a.accountIndex) || a.accountIndex <= 0) return null;
  if (mode === "venue-claim") return a.kind === "claim" ? { kind: "claim", accountIndex: a.accountIndex } : null;
  if (a.kind !== "unwind" || !Array.isArray(a.calls) || a.calls.length === 0 || a.calls.length > 3) return null;
  if (!a.calls.every((c) => c === "cancelAllOrders" || c === "changePubKey" || c === "withdraw")) return null;
  if (typeof a.positionsLeftOpen !== "number" || !Number.isSafeInteger(a.positionsLeftOpen) || a.positionsLeftOpen < 0) return null;
  return { kind: "unwind", accountIndex: a.accountIndex, calls: a.calls as VenueCallName[], positionsLeftOpen: a.positionsLeftOpen };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mode = process.argv[2];
  const to = process.argv[3] as `0x${string}` | undefined;
  const chainId = Number(process.argv[4] || robinhoodChain.id);

  const ownerKey = process.env.MERRYMEN_RECOVER_OWNER_KEY as `0x${string}` | undefined;
  const expect = (process.env.MERRYMEN_RECOVER_EXPECT || undefined) as `0x${string}` | undefined;
  // PUBLIC. A label for the key slot and nothing else; a malformed one is dropped, not trusted.
  const agentPerpPubKey = validatePerpPubKey(process.env.MERRYMEN_RECOVER_PERP_PUBKEY ?? "");

  if (mode !== "plan" && mode !== "sweep" && mode !== "venue-claim" && mode !== "venue-unwind") {
    say("recover-cli: mode must be plan|sweep|venue-claim|venue-unwind");
    emit({ ok: false, error: "bad-mode" });
    process.exit(2);
  }
  if (!ownerKey || !/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) {
    say("recover-cli: MERRYMEN_RECOVER_OWNER_KEY missing or not a 32-byte hex key");
    emit({ ok: false, error: "bad-owner-key" });
    process.exit(2);
  }
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    say("recover-cli: destination is not a valid address");
    emit({ ok: false, error: "bad-destination" });
    process.exit(2);
  }

  const cfg = resolveConfig();
  const chain = chainForId(chainId);
  const rpcUrl = chainId === robinhoodChain.id ? cfg.rpcMainnet : cfg.rpcTestnet;

  try {
    if (mode === "plan") {
      const plan = await planRecovery({
        chain,
        owner: ownerFromPrivateKey(ownerKey),
        rpcUrl,
        expectedSmartAccount: expect,
        extraTokens: cfg.customTokens,
        agentPerpPubKey,
      });
      const venue = venueDisclosure(plan.venue, { gasWei: plan.unreadable.includes("eth") ? null : plan.gasWei });
      const hadVenue = plan.venue?.kind === "account" || plan.venue?.kind === "unreadable";
      say(`  smart account : ${plan.smartAccount}`);
      say(`  owner EOA     : ${plan.ownerAddress}   ${"<- what MetaMask shows when you import the key"}`);
      say(`  native gas    : ${(Number(plan.gasWei) / 1e18).toFixed(6)} ETH`);
      if (plan.balances.length === 0) {
        // Only claim empty when we actually READ everything. Otherwise say what
        // we could not see — "this account is empty" is how someone concludes
        // their money is gone because an RPC blinked.
        //
        // AND NOT WHEN THE CLASS VAULT HOLDS SOMETHING. The vault is a separate
        // contract holding tokens the ACCOUNT does not, so an owner whose whole
        // book was class positions used to be told they had nothing by the one
        // command that exists to get money out.
        // ACROSS EVERY VAULT. Counting only the primary one is how "this
        // account is empty" gets printed over a full second vault.
        const heldInVaults = plan.classVaults.reduce((n, v) => n + v.holdings.length, 0);
        // AND NOT WHILE LIGHTER HOLDS SOMETHING OR COULD NOT BE READ. Perp
        // collateral and positions are this account's money too; "empty" over
        // them is the same lie the class vault used to get.
        say(
          heldInVaults
            ? `  holdings      : none in the account itself — but your class vault${plan.classVaults.length > 1 ? "s hold" : " holds"} ${heldInVaults} token(s), listed below. They are recoverable.`
            : plan.unreadable.length
              ? `  holdings      : none found, but ${plan.unreadable.join(", ")} could not be read — that is NOT a zero balance. Check the RPC and rerun.`
              : venue.standing === "holds"
                ? "  holdings      : none in the account itself — but Lighter holds something for it, listed below"
                : venue.standing === "unknown"
                  ? "  holdings      : none in the account itself — but Lighter could not be read in full, so this is NOT a claim that nothing is left"
                  : "  holdings      : none — this account is empty",
        );
      } else {
        say("  holdings:");
        for (const b of plan.balances) say(`    • ${b.amount} ${b.symbol}${b.note ? `  (${b.note})` : ""}`);
        if (plan.unreadable.length) say(`  NOT READ      : ${plan.unreadable.join(", ")} — there may be more here than this list shows.`);
      }
      // THE CLASS VAULT, SHOWN SEPARATELY because recovering it is a separate
      // operation: `sweep` moves a token to the account, and only then can the
      // ordinary transfer reach it. An owner reading this should be able to see
      // that their coins exist, where they are, and that they can get them out
      // without anything of ours running.
      // ONE BLOCK PER VAULT. After v2 an account has two, and a confirmation
      // that names a strict subset of what the operation moves has shipped here
      // once already. The version label is what lets an owner tell them apart —
      // both are "this account's class vault" and only one is the current one.
      for (const v of plan.classVaults) {
        const label = v.version === null ? "class vault" : `class vault v${v.version}`;
        say(`  ${label.padEnd(14)}: ${v.vault}`);
        if (v.holdings.length === 0) {
          say(v.note ? `    (nothing found, but ${v.note})` : "    (empty — no class positions)");
        } else {
          for (const h of v.holdings) say(`    • ${h.amount} ${h.symbol}`);
          say("    these sweep to your account first, then out with everything else — two operations, one command");
          if (v.note) say(`    NOTE: ${v.note}`);
        }
      }
      sayVenue(venue, hadVenue);
      emit({
        ok: true,
        smartAccount: plan.smartAccount,
        ownerAddress: plan.ownerAddress,
        gasWei: plan.gasWei.toString(),
        // THE LIGHTER GROUP, already in words and JSON-safe (venueDisclosure).
        // `standing` is what the CLI asks before it ever says "nothing to
        // recover"; `offers` carry the `approved` identity a venue mode needs.
        venue,
        unreadable: plan.unreadable,
        balances: plan.balances.map((b) => ({ symbol: b.symbol, amount: b.amount, note: b.note })),
        // classVault/classHoldings/classNote stay, unchanged in meaning, so a
        // script reading this line keeps working. classVaults is the whole book.
        classVault: plan.classVault,
        classNote: plan.classNote,
        classHoldings: plan.classHoldings.map((h) => ({
          token: h.token,
          symbol: h.symbol,
          amount: h.amount,
        })),
        classVaults: plan.classVaults.map((v) => ({
          vault: v.vault,
          version: v.version,
          note: v.note,
          holdings: v.holdings.map((h) => ({ token: h.token, symbol: h.symbol, amount: h.amount })),
        })),
      });
      process.exit(0);
    }

    // sweep, or a venue step
    const bundlerUrl =
      cfg.bundlerUrl || (cfg.bundlerApiKey ? pimlicoBundlerUrl(chainId, cfg.bundlerApiKey) : undefined);
    if (!bundlerUrl) {
      say("recover-cli: no bundler configured — cannot submit the recovery transaction");
      emit({ ok: false, error: "no-bundler" });
      process.exit(3);
    }

    if (mode === "venue-claim" || mode === "venue-unwind") {
      const approved = parseApproved(process.env.MERRYMEN_RECOVER_VENUE_APPROVED, mode);
      if (!approved) {
        say("recover-cli: the approved Lighter step is missing or malformed — nothing signed");
        emit({ ok: false, error: "bad-approved" });
        process.exit(2);
      }
      say(mode === "venue-claim" ? "  claiming from the Lighter contract …" : "  sending the Lighter unwind …");
      const res = await recoverVenueStep({
        chain,
        owner: ownerFromPrivateKey(ownerKey),
        bundlerUrl,
        rpcUrl,
        expectedSmartAccount: expect,
        agentPerpPubKey,
        approved: approved!,
      });
      say(`  ✓ ${res.calls.join(" → ")} landed — tx ${res.txHash}`);
      // THE ROTATION IS RECORDED FIRST, THEN CHECKED. Recorded the moment the
      // receipt lands — before the poll of up to ~28 s, so a Ctrl-C there
      // cannot lose a rotation that already happened on chain — and checked
      // after, because its success happens somewhere this operation cannot
      // see: Lighter processes the priority request after the transaction.
      //
      // EVERY KEY IT RETIRES, the grant's sealed key included WHATEVER the slot
      // read said: a rotation sent over a slot that could not be read (recover
      // rotates then, because unread may hold a key) used to journal
      // `retiredPubKey: null` while this process knew the agent's key — and a
      // worker trusting the journal could put that key back over the owner's
      // revocation (onboard.ts: an owner-rotated key is replaceable by a
      // sealed key that is not retired).
      let seenAtVenue: boolean | null = null;
      let journal: string | null = null;
      if (res.rotatedTo) {
        const home = merrymenHome();
        try {
          recordOwnerRotation(home, {
            smartAccount: res.smartAccount.toLowerCase(),
            accountIndex: res.accountIndex,
            apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex,
            ownerRotatedPubKey: res.rotatedTo,
            retiredPubKey: res.replacedPubKey,
            retiredPubKeys: retiredKeysFor(res.replacedPubKey, agentPerpPubKey),
            userOpHash: res.userOpHash,
            txHash: res.txHash,
            at: Date.now(),
            seenAtVenue: null,
          });
          journal = "perp-owner-rotations.json";
        } catch (e) {
          say(`  ⚑ could not record the key change in perp-owner-rotations.json: ${e instanceof Error ? e.message : String(e)}`);
        }
        for (let i = 0; i < 6 && seenAtVenue !== true; i++) {
          await sleep(i === 0 ? 3_000 : 5_000);
          const slot = await readVenueKeySlot(res.accountIndex);
          if (slot.read) seenAtVenue = slot.value.state === "key" && slot.value.publicKey === res.rotatedTo;
        }
        say(
          seenAtVenue === true
            ? `  ✓ Lighter now shows the fresh key at index ${LIGHTER_ROUTE_V1.apiKeyIndex} — the agent's key no longer works there`
            : `  ⚑ Lighter does not show the fresh key at index ${LIGHTER_ROUTE_V1.apiKeyIndex} yet — run recover again in a few minutes; if it still shows the old key, the key change was refused at the venue`,
        );
        if (journal !== null) {
          try {
            markOwnerRotationSeen(home, res.userOpHash, seenAtVenue);
          } catch (e) {
            say(`  ⚑ could not note in perp-owner-rotations.json what Lighter showed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      emit({
        ok: true,
        kind: res.kind,
        txHash: res.txHash,
        userOpHash: res.userOpHash,
        smartAccount: res.smartAccount,
        accountIndex: res.accountIndex,
        calls: res.calls,
        // PUBLIC: nobody holds its private key. Printed so the owner has it even if the journal write failed.
        rotatedTo: res.rotatedTo,
        replacedPubKey: res.replacedPubKey,
        seenAtVenue,
        journal,
        withdrawRequestedMicro: res.withdrawRequestedMicro.toString(),
        claimedMicro: res.claimedMicro.toString(),
        positionsLeftOpen: res.positionsLeftOpen,
      });
      process.exit(0);
    }

    say(`  sweeping to ${to} …`);
    const res = await recoverFunds({
      chain,
      owner: ownerFromPrivateKey(ownerKey),
      bundlerUrl,
      rpcUrl,
      to: to!,
      expectedSmartAccount: expect,
      extraTokens: cfg.customTokens,
    });
    if (!res.txHash) {
      // Three different things reach here and they are NOT the same fact.
      if (res.skipped.length) {
        say("  nothing moved — every token held here refused to transfer:");
        for (const sk of res.skipped) say(`    • ${sk.symbol}: ${sk.reason}`);
      } else if (res.unreadable.length) {
        say(`  nothing swept, but ${res.unreadable.join(", ")} could not be read — do not treat this as empty.`);
      } else if (venueStanding(res.venue) !== "nothing") {
        // Nothing in the ACCOUNT to sweep is not nothing to recover.
        say(
          venueStanding(res.venue) === "holds"
            ? "  nothing to sweep in the account itself — but Lighter still holds something for it (run recover again to see it)"
            : "  nothing to sweep in the account itself — and Lighter could not be read, so this is not a claim that nothing is left",
        );
      } else {
        say("  nothing to sweep — account is empty");
      }
      emit({
        ok: true,
        txHash: null,
        balances: [],
        skipped: res.skipped,
        unreadable: res.unreadable,
        venueStanding: venueStanding(res.venue),
      });
      process.exit(0);
    }
    if (res.skipped.length) {
      say("  left behind (they refused to transfer):");
      for (const sk of res.skipped) say(`    • ${sk.symbol}: ${sk.reason}`);
    }
    if (res.nativeSweptWei > 0n) {
      say(`  ✓ also swept ${(Number(res.nativeSweptWei) / 1e18).toFixed(6)} ETH ` +
          `(${(Number(res.nativeReservedWei) / 1e18).toFixed(6)} left to pay for this op)`);
    }
    say(`  ✓ swept — tx ${res.txHash}`);
    emit({
      ok: true,
      txHash: res.txHash,
      to: res.to,
      smartAccount: res.smartAccount,
      balances: res.balances.map((b) => ({ symbol: b.symbol, amount: b.amount })),
      nativeSweptWei: res.nativeSweptWei.toString(),
      nativeReservedWei: res.nativeReservedWei.toString(),
    });
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    say(`  ✗ ${msg}`);
    emit({ ok: false, error: msg });
    process.exit(1);
  }
}

void main();
