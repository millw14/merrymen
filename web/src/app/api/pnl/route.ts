import path from "node:path";
import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { readTradePnl } from "@/lib/trade-pnl";
import { renderPnlCard } from "@merrymen/pnl-card";

/** Private PNG of an evidenced live sell, using the same house card as Telegram. */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
const failure = (message: string, status: number) => new NextResponse(message, { status, headers: PRIVATE_HEADERS });

export async function GET(req: Request) {
  const ids = new URL(req.url).searchParams.getAll("trade");
  const id = Number(ids[0]);
  if (ids.length !== 1 || !/^[1-9]\d*$/.test(ids[0] ?? "") || !Number.isSafeInteger(id)) {
    return failure("Missing or malformed trade id.", 400);
  }
  // The request may name a trade, never an account. Self-hosted keeps the same
  // single disk account and localhost perimeter as the rest of the dashboard.
  const agent = isHostedMode() ? await hostedAgentFor(req) : await diskAgent();
  if (!agent) return failure("Not found.", 404);
  let result;
  try {
    result = await withReadDb(async (db) => db ? readTradePnl(db, agent, id) : { kind: "unreadable" as const });
  } catch {
    return failure("Trade history is unavailable. Try again shortly.", 503);
  }
  if (result.kind === "missing") return failure("Not found.", 404);
  if (result.kind === "unreadable") return failure("Trade history is unavailable. Try again shortly.", 503);
  if (result.kind === "ineligible") return failure(result.reason, 409);

  let png: Buffer;
  try {
    // next start runs from web/; traced serverless output can run from the
    // repository root. Both layouts ship the same template. Do not use the
    // worker's import.meta URL here: Next rewrites it into an HTTP asset URL.
    const sibling = path.join(process.cwd(), "../pnl/PNL.jpg");
    const template = existsSync(sibling) ? sibling : path.join(process.cwd(), "pnl/PNL.jpg");
    png = await renderPnlCard(result.card, template);
  } catch {
    return failure("The P&L image could not be rendered. Try again shortly.", 503);
  }
  const name = `${result.card.symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "position"}-pnl.png`;
  return new NextResponse(new Uint8Array(png), {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
