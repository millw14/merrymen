import { createTelegramHandlers } from "@/lib/telegram-create-handlers";
import { telegramManagerConfig } from "../config";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = createTelegramHandlers({ config: telegramManagerConfig }).webhook;
