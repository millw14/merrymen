/**
 * THE CHAT-ORDER CEILING AND THE ORDER WINDOW FOR THE CALLER — one resolution each.
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
 * AND FOR THE CALLER'S WALLET, named with no default, as the stores take it.
 * A login has two (Spot and Perps), each with its own settings: the Perps
 * wallet's ceiling is read from the Perps store hosted, and self-hosted from
 * the Perps home's own settings.json (houseConfigFor), never from Spot's.
 *
 * Server-only: it reads the session, the settings store and the house file.
 * `hosted` is the route's to pass — isHostedMode() reads process.env, which is
 * always false in a browser bundle, so only app/api may call it
 * (client-env.test.ts).
 */
import path from "node:path";
import { isGrantPurpose, type GrantPurpose } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";
import { purposeHome } from "../../../worker/src/home";
import { mergeSettings, readSettingsFileAt, resolveConfig, type ResolvedConfig } from "../../../worker/src/settings";
import { tenantOf } from "./auth";
import { chatOrderCeiling, orderTtlMs } from "./order-state";

/**
 * THE HOUSE'S SETTINGS FOR ONE WALLET: what a worker of that wallet in this
 * process's home and env would run on, read for the fallbacks the order routes
 * apply when the caller stored nothing (the ceiling, the order window's tick).
 *
 * SPOT IS resolveConfig(), EXACTLY AS IT ALWAYS WAS: MERRYMEN_SETTINGS_FILE or
 * the home's settings.json, over the env.
 *
 * PERPS IS THE PERPS HOME'S OWN FILE (`purposeHome("perps")/settings.json`, the
 * file the Perps settings PUT writes and the kill turns perps off in), merged
 * as a Perps worker merges it (MERRYMEN_WALLET_PURPOSE=perps). Never
 * MERRYMEN_SETTINGS_FILE, which names the Spot wallet's file, and never the
 * Spot home's. A Perps file that cannot be read is read as nothing stored —
 * the defaults, the same safe direction the ceiling's own fallback takes —
 * because these are fallbacks for a figure, not a save that could lose keys.
 */
export function houseConfigFor(wallet: GrantPurpose): ResolvedConfig {
  if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
  if (wallet === "spot") return resolveConfig();
  const read = readSettingsFileAt(path.join(purposeHome("perps"), "settings.json"));
  return mergeSettings(read.kind === "parsed" ? read.settings : {}, { ...process.env, MERRYMEN_WALLET_PURPOSE: "perps" });
}

export function ceilingFor(req: Request, hosted: boolean, wallet: GrantPurpose): Promise<number> {
  return chatOrderCeiling({
    hosted,
    tenant: tenantOf(req),
    fallback: houseConfigFor(wallet).telegramMaxActionUsdg,
    stored: (tenant) => getSettingsStore(wallet).get(tenant as `0x${string}`),
  });
}

/**
 * How long an order stays willing to fill, FOR THIS DEPLOYMENT'S ACTUAL TICK.
 *
 * A CONSTANT TUNED FOR THE DEFAULT IS WRONG EVERYWHERE ELSE. Five minutes was
 * sized for "one slow tick (60s default) and a ferry pass (15s) with room to
 * spare". The hosted fleet runs a 240s tick, and the child drains at most ONE
 * command per tick — so five minutes bought a single attempt, and an order that
 * missed it was dead. Observed exactly that in production: a child re-armed
 * (because a setting changed), its tick clock reset, and the queued order sat
 * through its whole window without being looked at once.
 *
 * Two ticks plus a ferry pass is the smallest window that survives missing one,
 * with the original five minutes as a floor so a fast tick does not make orders
 * expire faster than a person can watch them.
 *
 * READ FOR THE CALLER, not for this container — same lesson as the ceiling
 * above it. Hosted, `resolveConfig()` is the house's own settings file and says
 * nothing about this tenant's cadence.
 *
 * AND FOR THE CALLER'S WALLET: each wallet's worker ticks on its own settings,
 * so a Perps exit's window is the Perps worker's tick (its store hosted, its
 * home's file self-hosted: houseConfigFor), never Spot's. Here rather than in
 * the orders route because a Perps practice reset waits the same window
 * (/api/paper-reset): an owner's command to that worker is consent to it now.
 */
export async function orderTtlFor(req: Request, hosted: boolean, wallet: GrantPurpose): Promise<number> {
  let tickSeconds = houseConfigFor(wallet).tickSeconds;
  if (hosted) {
    const tenant = tenantOf(req);
    try {
      const own = tenant ? (await getSettingsStore(wallet).get(tenant))?.tickSeconds : undefined;
      if (typeof own === "number" && Number.isFinite(own) && own > 0) tickSeconds = own;
    } catch {
      /* the container's own tick is the safe fallback */
    }
  }
  return orderTtlMs(tickSeconds);
}
