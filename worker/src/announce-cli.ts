/**
 * The operator's hand on the announcer. Run ON a service that holds both
 * DATABASE_URL and MERRYMEN_STORE_DEK — the orchestrator or web (docs/
 * hosted-deploy.md: "The DEK is the one secret both hold"). It will not work
 * anywhere else, and that is deliberate: the tokens it needs are sealed.
 *
 *   node --import tsx worker/src/announce-cli.ts <body.html> <announce-id>
 *
 * DRY RUN UNLESS CONFIRMED. Telegram is contacted only when
 * MERRYMEN_ANNOUNCE_CONFIRM is set to the SAME announce id passed on the
 * command line. Two independent statements of the same value, because the
 * difference between a rehearsal and messaging every beta tester should not be
 * one flag anyone can set by muscle memory.
 *
 * Prints counts and failure REASONS. Never a token, never a chat id, never the
 * link code — a fleet's worth of live bot credentials passes through this
 * process and none of it belongs in a terminal scrollback or a CI log.
 */
import { readFileSync } from "node:fs";
import { illegalTags, runAnnouncement, type PgClientLike } from "./announce";

async function main(): Promise<void> {
  const [bodyPath, announceId] = process.argv.slice(2);
  if (!bodyPath || !announceId) {
    console.error("usage: announce-cli <body.html> <announce-id>");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "no DATABASE_URL — this must run on the orchestrator or web service, which hold it alongside the DEK.",
    );
    process.exit(2);
  }
  if (!process.env.MERRYMEN_STORE_DEK) {
    console.error("no MERRYMEN_STORE_DEK — the per-tenant bot tokens are sealed and cannot be read without it.");
    process.exit(2);
  }
  const body = readFileSync(bodyPath, "utf8").trim();
  // Telegram caps a message at 4096 characters and sendMessage TRUNCATES
  // silently. The personalised line is appended last, so an over-long body eats
  // exactly the part that made this worth sending at all. Refuse instead.
  if (body.length > 3600) {
    console.error(`body is ${body.length} chars; keep it under 3600 so the per-agent line survives the 4096 cap.`);
    process.exit(2);
  }
  // Telegram would accept this and silently strip every tag, delivering an
  // unformatted wall of text to all 43 and reporting a clean success. Refuse
  // while it is still free to fix.
  const bad = illegalTags(body);
  if (bad.length > 0) {
    console.error(
      `body uses tags Telegram's HTML mode rejects: ${bad.join(", ")}.
` +
        `It would strip ALL formatting, send anyway, and report success. Allowed: b, i, u, s, a, code, pre.`,
    );
    process.exit(2);
  }
  const confirmed = process.env.MERRYMEN_ANNOUNCE_CONFIRM === announceId;

  // @ts-expect-error pg is runtime-only here, exactly as settings-store.ts has it
  const pg = (await import("pg")) as unknown as {
    Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void>; end(): Promise<void> };
  };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const out = await runAnnouncement({ client, announceId, body, confirmed });
    console.log(
      `[announce] ${out.dryRun ? "DRY RUN — nothing was sent" : "SENT"} · id ${announceId}\n` +
        `  tenants considered : ${out.considered}\n` +
        `  eligible           : ${out.eligible}\n` +
        `  ${out.dryRun ? "would receive     " : "delivered         "} : ${out.sent}\n` +
        `  skipped, no chat   : ${out.skippedNoChat}\n` +
        `  skipped, no bot    : ${out.skippedNoToken}\n` +
        `  skipped, tg off    : ${out.skippedDisabled}\n` +
        `  skipped, had it    : ${out.skippedAlreadySent}\n` +
        `  with their own reason: ${out.personalised} of ${out.sent}
` +
        `  failed             : ${out.failed.length}`,
    );
    // The difference between "nobody is blocked" and "the join broke" — the
    // same empty map either way, and only one of them is safe to send on.
    if (out.blockerJoinError) {
      console.error(
        `  !! the per-agent blocker lookup FAILED (${out.blockerJoinError}).
` +
          `     Every message would be generic. Fix before sending.`,
      );
    } else if (out.personalised === 0 && out.sent > 0) {
      console.error(`  !! no message carries a per-agent reason. Check the blocker join before sending.`);
    }
    // Reasons without recipients: enough to act on, not enough to identify
    // anyone or to reconstruct a credential.
    for (const [reason, n] of countBy(out.failed.map((f) => f.reason))) {
      console.log(`    ${n}× ${reason}`);
    }
    if (out.dryRun) {
      console.log(
        `\n  To send for real: set MERRYMEN_ANNOUNCE_CONFIRM=${announceId} and run the same command again.`,
      );
    }
  } finally {
    await client.end();
  }
}

function countBy(xs: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

void main().catch((e) => {
  // The message only — never the error object, which for pg and fetch can carry
  // request context, and for this process that context can include a token.
  console.error(`[announce] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
