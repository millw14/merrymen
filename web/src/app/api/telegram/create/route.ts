import { createTelegramHandlers } from "@/lib/telegram-create-handlers";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const handlers = createTelegramHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
