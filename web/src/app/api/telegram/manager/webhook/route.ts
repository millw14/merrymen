import { createTelegramHandlers } from "@/lib/telegram-create-handlers";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = createTelegramHandlers().webhook;
