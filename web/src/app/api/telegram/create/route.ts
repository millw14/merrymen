import { createTelegramHandlers } from "@/lib/telegram-create-handlers";
import { telegramManagerConfig } from "../manager/config";
import { walletNotSupported } from "@/lib/route-guard";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handlers = createTelegramHandlers({ config: telegramManagerConfig });
// Functions rather than `export const GET = handlers.GET`, so each starts with
// the wallet refusal every API route gives (lib/route-guard.ts).
export async function GET(req: Request): Promise<Response> {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return handlers.GET(req);
}
export async function POST(req: Request): Promise<Response> {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return handlers.POST(req);
}
