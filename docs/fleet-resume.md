# Resuming the fleet on the incident volume

The orchestrator's volume was written before persistent-home manifests
existed. It holds every tenant's home, an operator's hand-made `FLEET_HALT`
and no `.merrymen-persistent-home.json`. Ordinary startup refuses that root,
correctly: it cannot tell an original book from a stray directory, and it
never initializes over existing data (see
[memory-safeguard.md](memory-safeguard.md#one-shot-original-book-handover-to-persistent-storage)).

This page covers the three reviewed steps that let the orchestrator run on
that volume without a shell on the container: **adopt** it under the halt it
already has, **release** that halt into a rollout scope, and **re-halt** it for
a rollback to listener-only mode. All three live in
`worker/src/persistent-home.ts` and run at orchestrator startup, after the
report-only branch and before `preparePersistentHomeForHandover` re-proves the
home, so before any lease, child, holder or writer.

This is an application change requiring Milla's review under `AGENTS.md`. The
release changes an existing policy: `markPersistentHomeHandoverComplete` was
never called at startup. Decision 5 of the resume plan approves the narrow,
token- and scope-bound exception described below; nothing else calls it at
startup.

## What every step requires

- The persistent-home opt-in, unchanged: `MERRYMEN_PERSISTENT_HOME_REQUIRED=1`,
  `MERRYMEN_HOME` equal to `RAILWAY_VOLUME_MOUNT_PATH`, the pinned provider
  `MERRYMEN_HOME_VOLUME_ID`, the proven writable durable mount and the 0700
  owned root. A step asked for without the opt-in refuses.
- `MERRYMEN_ADOPT_HOME_HALT_SHA256`: the SHA-256 of the original hand-made
  halt's exact bytes, recorded privately before deployment (runbook R0.1).
  Release and re-halt need it too, and need the pre-adoption record to match
  it, so neither applies to a volume this code initialized fresh.
- Its own explicit variable. With none of them set, startup is unchanged.

Each step opens no book, grant, lease or ledger, and none of them removes a
halt it cannot prove it created.

## Adopt: `MERRYMEN_ADOPT_HOME_HALT_SHA256`

Also requires `MERRYMEN_INITIAL_HANDOVER` (the operation token). Adoption
refuses, before writing anything, when:

- the halt's hash does not equal the pin, or the halt is larger than 4 KiB;
- the halt is not a private (0600), owned, single-link plain file on the volume;
- the halt is absent;
- the root is empty, or holds nothing but a halt (an empty volume uses the
  ordinary explicit initialization instead);
- a manifest already exists that this adoption did not create.

Otherwise, in order, each step synced to disk before the next:

1. Write `.fleet-halt-preadoption.json` (0600): the original halt's SHA-256,
   inode, size and exact bytes (base64), bound to the volume, root and
   operation token. The original halt's content is never lost.
2. Write this volume's canonical halt beside it under a private name, then
   rename it over `FLEET_HALT` in one step. `FLEET_HALT` is never absent.
3. Write the manifest, `held`, naming that canonical halt as its own.

From then on the existing verification and release paths treat the volume
like one initialized by this code. A restart with the variable still set
changes nothing. A crash at any point converges on the next start with the
same variables: a record whose original is still in place continues to the
rename, and a record whose `FLEET_HALT` already is the canonical text on a new
inode continues to the manifest. Until the manifest exists, ordinary startup
keeps refusing the root and the reply listener keeps standing behind whichever
halt is present.

Verify: the manifest says `held`; `.fleet-halt-preadoption.json` holds the
recorded hash and the original inode; no children start.

## Release: `MERRYMEN_RELEASE_HOME_HALT=<operation token>`

Releases only a `held` adopted manifest whose operation token matches, and
only while `MERRYMEN_FLEET_ROLLOUT` admits someone. With the rollout `none` or
unset, the halt stays and startup logs an `[alert]`. The release itself is
`markPersistentHomeHandoverComplete`: the completed manifest is durable before
the unchanged canonical halt is removed, and a crash between the two finishes
on the next start (again only into a scope).

**This must not merge or deploy before `MERRYMEN_FLEET_ROLLOUT` scoping
(work package B1).** The release only checks that the scope is not `none`;
B1 validates its grammar at boot and limits which tenants spawn. Without B1, a
released halt would run every tenant on the roster.

Asked again, the release changes nothing. A `FLEET_HALT` created by hand after
a release still stands every child down and releases their leases, and this
variable never lifts it, whatever its content or mode. To stop at once after a
release, either set `MERRYMEN_FLEET_ROLLOUT=none` and redeploy, or create
`FLEET_HALT` by hand.

## Re-halt: `MERRYMEN_REHALT_HOME=<operation token>`

Returns a released adopted volume to `held`, so the deployment can go back to
listener-only mode without a shell:

1. Write the canonical halt under a private name.
2. Replace `.fleet-halt-rehalt.json` (0600) with a receipt naming that file's
   inode, before it is published.
3. Link it to `FLEET_HALT` without replacing anything (exclusive create at
   the real name), then drop the private name.
4. Replace the manifest with one in state `held` naming the new halt.

If `FLEET_HALT` already exists and is not provably this re-halt's own (by its
private name's inode, or by the receipt and the canonical text), it was made
by hand: it stays, the manifest stays `complete`, and startup logs an
`[alert]`. The fleet is halted either way. Every crash point converges on the
next start with the variable still set.

When both variables are set, the re-halt wins and the release is ignored, so a
rollback never fails because the release variable was left behind. Once the
re-halt variable is removed, the release variable applies again on the next
orchestrator start.

Rollback to listener-only: set `MERRYMEN_REHALT_HOME`, deploy the orchestrator
role once and confirm the manifest is `held`, then switch to
`start:recovery-replies` with `MERRYMEN_FLEET_RECOVERY_REPORT_ONLY=1` and
`MERRYMEN_FLEET_RECOVERY_REPLIES=1`. The report-only and listener entries
never run these steps.

## The reply listener

The current recovery-reply proof (`worker/src/recovery-reply-proof.ts`)
accepts the adopted `held` manifest with its canonical halt, and the
re-halted manifest; this is tested against the proof unchanged. It refuses a
released volume, because it requires a present `FLEET_HALT`. Running the
listener beside a released fleet is the sidecar work package (B8).

## Files on the volume root

| File | Written by | Purpose |
| --- | --- | --- |
| `FLEET_HALT` | operator, adoption, re-halt | Present: stop every child and spawn none |
| `.merrymen-persistent-home.json` | adoption, release, re-halt | Manifest: volume identity and `held` or `complete` |
| `.fleet-halt-preadoption.json` | adoption | The original halt's hash, inode and exact bytes |
| `.fleet-halt-rehalt.json` | re-halt | Which canonical halt the latest re-halt created |

Keep all of them. None holds a signing key or a grant.
