import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A kernel-held lifetime fence: even a crashed supervisor cannot overlap workers. */
export function acquireLocalWorkerLease(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, ".worker-lease.db"));
  try { db.exec("BEGIN IMMEDIATE"); }
  catch { db.close(); throw new Error("this wallet already has a running worker; refusing concurrent execution"); }
  let closed = false;
  return () => { if (!closed) { closed = true; db.close(); } };
}
