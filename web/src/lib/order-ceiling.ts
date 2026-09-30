/**
 * THE CHAT-ORDER CEILING FOR THE CALLER — one resolution, two readers.
 *
 * POST /api/orders refuses an order over it, and GET /api/orders/ceiling tells
 * the chat's amount chips what it is. They used to resolve it differently: the
 * route from the web process's own settings and env, the chips from
 * /api/settings' values over SETTINGS_DEFAULTS. So a house ceiling below 25
 * offered a "(max)" chip the route refused. Both call this now, and the rule
 * itself is chatOrderCeiling (lib/order-state.ts), which a test runs.
 *
 * RESOLVED FOR THE CALLER, NOT FOR THIS CONTAINER. `resolveConfig()` reads the
 * WEB process's own ~/.merrymen/settings.json merged with the server env —
 * hosted, that is the house's file and has nothing to do with this tenant,
 * whose settings live in the per-tenant store /api/settings reads.
 *
 * Server-only: it reads the session, the settings store and the house file.
 * `hosted` is the route's to pass — isHostedMode() reads process.env, which is
 * always false in a browser bundle, so only app/api may call it
 * (client-env.test.ts).
 */
import { getSettingsStore } from "@merrymen/settings-store";
import { resolveConfig } from "../../../worker/src/settings";
import { tenantOf } from "./auth";
import { chatOrderCeiling } from "./order-state";

export function ceilingFor(req: Request, hosted: boolean): Promise<number> {
  return chatOrderCeiling({
    hosted,
    tenant: tenantOf(req),
    fallback: resolveConfig().telegramMaxActionUsdg,
    stored: (tenant) => getSettingsStore().get(tenant as `0x${string}`),
  });
}
