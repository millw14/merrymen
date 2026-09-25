/**
 * The MCP server's durable background work, driven by the orchestrator's
 * reconcile loop: backtest jobs, notification evaluation and delivery, and
 * table retention.
 *
 * WHY HERE. The web process answers requests and may be scaled or restarted at
 * any time; the orchestrator is the one long-lived scheduler this deployment
 * has. None of this touches trading: it reads the shared ledger, writes only
 * its own tables (mcp_jobs, notify_*) and sends Telegram messages through each
 * owner's own bot. Trading and protective exits never wait on it.
 *
 * NEVER BLOCKS THE LOOP. Each pass is started, not awaited, behind its own
 * in-flight flag, and each has its own time budget; a slow pass skips the
 * next tick instead of stacking up. A failure is logged and the next tick
 * tries again.
 */
import { createPublicClient, http } from "viem";
import { robinhoodChain } from "../../../packages/core/src/index";
import type { Db } from "../db";
import { ensureMcpSchema } from "./schema";
import { oracleFeedReader, runMcpJobsPass } from "./jobs";
import { chainlinkPriceReader, hostedNotifyDeps, runNotifyPass, type NotifyDeps } from "./notify";
import { runMcpMaintenancePass } from "./maintenance";

export interface McpBackgroundOptions {
  /** The shared Postgres (the same pooled driver the mirror uses). */
  shared: () => Promise<Db>;
  log: (line: string) => void;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function mcpBackgroundEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.DATABASE_URL && env.MERRYMEN_MCP_ENABLED !== "0";
}

/** Returns a tick function for the reconcile loop. Cheap when there is nothing to do. */
export function makeMcpBackground(o: McpBackgroundOptions): () => void {
  const env = o.env ?? process.env;
  let schema: Promise<boolean> | null = null;
  let jobsBusy = false;
  let notifyBusy = false;
  let maintenanceBusy = false;
  let notifyDeps: NotifyDeps | null = null;
  const readFeed = oracleFeedReader(o.rpcUrl);

  const ready = async (db: Db): Promise<boolean> => {
    if (!schema) {
      schema = ensureMcpSchema(db, "postgres").then(() => true, (error: unknown) => {
        o.log(`mcp: could not create its tables (${error instanceof Error ? error.message : String(error)}); retrying next pass`);
        schema = null;
        return false;
      });
    }
    return schema;
  };

  const start = (busy: () => boolean, set: (v: boolean) => void, name: string, run: (db: Db) => Promise<unknown>) => {
    if (busy()) return;
    set(true);
    void (async () => {
      try {
        const db = await o.shared();
        if (!(await ready(db))) return;
        await run(db);
      } catch (error) {
        o.log(`mcp: ${name} pass failed (${error instanceof Error ? error.message : String(error)})`);
      } finally {
        set(false);
      }
    })();
  };

  return () => {
    if (!mcpBackgroundEnabled(env)) return;
    start(() => jobsBusy, (v) => { jobsBusy = v; }, "jobs", async (db) => {
      const r = await runMcpJobsPass(db, { readFeed, log: o.log });
      if (r.job) o.log(`mcp: backtest ${r.job.id} ${r.job.outcome} (attempt ${r.job.attempt}, ${r.job.ms} ms)`);
      if (r.error) o.log(`mcp: jobs pass error (${r.error})`);
    });
    start(() => notifyBusy, (v) => { notifyBusy = v; }, "notify", async (db) => {
      notifyDeps ??= hostedNotifyDeps(db, {
        price: chainlinkPriceReader(createPublicClient({ chain: robinhoodChain, transport: http(o.rpcUrl) }) as never),
        log: o.log,
      });
      await runNotifyPass(db, notifyDeps);
    });
    start(() => maintenanceBusy, (v) => { maintenanceBusy = v; }, "maintenance", async (db) => {
      const r = await runMcpMaintenancePass(db);
      if (r.ran && r.errors) o.log(`mcp: retention pass finished with ${r.errors} statement error(s)`);
    });
  };
}
