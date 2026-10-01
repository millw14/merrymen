import { openSync, closeSync, fsyncSync, writeSync, ftruncateSync } from "node:fs";
import path from "node:path";

/** Keep a durable exclusive claim even on ambiguous failure; retries never broadcast. */
export function claimDeploymentAttempt(file: string, initial: Record<string, unknown>) {
  const fd = openSync(file, "wx", 0o600);
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeSync(fd); } };
  const save = (record: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    let written = 0;
    while (written < body.length) written += writeSync(fd, body, written, body.length - written, written);
    ftruncateSync(fd, body.length);
    fsyncSync(fd);
  };
  try {
    save(initial);
    // Windows flushes the created file via fsync above; opening directories
    // for a second fsync is a POSIX operation.
    if (process.platform !== "win32") {
      const dir = openSync(path.dirname(file), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } catch (error) { close(); throw error; }
  return { save, close };
}
