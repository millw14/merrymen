/** Shared Solana authority/accounting storage; no fallback to ephemeral hosted files. */
import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isHostedMode } from "../../packages/core/src/hosted";
import { merrymenHome } from "./home";
import { makePgDb, wrapSqlite, type Db } from "./db";

const databases = new Map<string, Promise<Db>>();
/** The self-hosted accounts file; hosted installs use DATABASE_URL instead. */
export function solanaRuntimeDbFile(): string { return path.join(merrymenHome(), "solana-accounts.sqlite"); }
export function getSolanaRuntimeDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url && isHostedMode()) throw new Error("Hosted Solana trading requires a shared database.");
  const file = solanaRuntimeDbFile();
  const key = url ?? file;
  let pending = databases.get(key);
  if (!pending) {
    pending = (async () => {
      if (url) return makePgDb(url);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      closeSync(openSync(file, "a", 0o600));
      chmodSync(file, 0o600);
      const raw = new DatabaseSync(file);
      try {
        raw.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
        return wrapSqlite(raw);
      } catch (error) { raw.close(); throw error; }
    })().catch((error) => { databases.delete(key); throw error; });
    databases.set(key, pending);
  }
  return pending;
}
