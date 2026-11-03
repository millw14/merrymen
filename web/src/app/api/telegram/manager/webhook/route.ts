import { createTelegramHandlers } from "@/lib/telegram-create-handlers";
import { telegramManagerConfig } from "../config";
import { walletNotSupported } from "@/lib/route-guard";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handlers = createTelegramHandlers({ config: telegramManagerConfig });
// A function rather than `export const POST = ….webhook`, so it starts with the
// wallet refusal every API route gives (lib/route-guard.ts).
export async function POST(req: Request): Promise<Response> {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  return handlers.webhook(req);
}
