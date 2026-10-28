import { createTelegramHandlers } from "@/lib/telegram-create-handlers";
import { telegramManagerConfig } from "../manager/config";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handlers = createTelegramHandlers({ config: telegramManagerConfig });
export const GET = handlers.GET;
export const POST = handlers.POST;
