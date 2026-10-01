/** Preserve the audited dependency tree in npm installs, which ignore overrides
 * from dependency packages and do not publish package-lock.json. Lifecycle
 * staging avoids maintaining a second copy of the lock in source control. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const markerName = ".merrymen-pack-lock.json";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function stagePackLock(root) {
  const lock = path.join(root, "package-lock.json");
  const wrap = path.join(root, "npm-shrinkwrap.json");
  const marker = path.join(root, markerName);
  const bytes = readFileSync(lock);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (parsed.lockfileVersion !== 3 || parsed.name !== manifest.name || parsed.version !== manifest.version) {
    throw new Error("The package lock must match this package and use lockfileVersion 3 before packing.");
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const expected = Object.entries(manifest[field] ?? {}).sort();
    const locked = Object.entries(parsed.packages?.[""]?.[field] ?? {}).sort();
    if (JSON.stringify(expected) !== JSON.stringify(locked)) throw new Error(`The package lock has stale ${field}; update it before packing.`);
  }
  if (existsSync(marker)) {
    throw new Error("An earlier pack left a lock staging marker. Run node cli/pack-lock.mjs clean before retrying.");
  }
  if (existsSync(wrap)) {
    if (!readFileSync(wrap).equals(bytes)) throw new Error("Existing npm-shrinkwrap.json differs from package-lock.json; it was preserved. Reconcile it before packing.");
    return; // User-owned matching file: include it and leave it in place.
  }
  const record = `${JSON.stringify({ version: 1, sha256: digest(bytes) })}\n`;
  writeFileSync(marker, record, { flag: "wx" });
  try { writeFileSync(wrap, bytes, { flag: "wx" }); }
  catch (error) { unlinkSync(marker); throw error; }
}

export function cleanPackLock(root) {
  const marker = path.join(root, markerName);
  if (!existsSync(marker)) return;
  const record = JSON.parse(readFileSync(marker, "utf8"));
  if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Invalid pack staging marker; no files removed.");
  const wrap = path.join(root, "npm-shrinkwrap.json");
  if (existsSync(wrap)) {
    if (digest(readFileSync(wrap)) !== record.sha256) throw new Error("npm-shrinkwrap.json changed during packing; it and the staging marker were preserved.");
    unlinkSync(wrap);
  }
  unlinkSync(marker);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const action = process.argv[2];
  if (action === "stage") stagePackLock(process.cwd());
  else if (action === "clean") cleanPackLock(process.cwd());
  else throw new Error("Usage: node cli/pack-lock.mjs stage|clean");
}
