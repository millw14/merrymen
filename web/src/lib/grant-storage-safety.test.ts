import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { clearGrant } from "./session";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const key = "merrymen.grant.v1";
const address = `0x${"a".repeat(40)}`;
const archive = `merrymen.grant.archive.${address}`;
// Synthetic recovery material, never a funded account or a real user key.
const raw = JSON.stringify({ smartAccount: address, demoOwnerPrivateKey: `0x${"1".repeat(64)}` });

function installStorage(value: string, refuseArchive = false) {
  const entries = new Map([[key, value]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, data: string) => {
      if (refuseArchive && name.startsWith("merrymen.grant.archive.")) throw new Error("QuotaExceededError");
      entries.set(name, data);
    },
    removeItem: (name: string) => entries.delete(name),
  } });
  return entries;
}

it("discard refuses when the recovery archive cannot be written, preserving the only owner key", () => {
  const storage = installStorage(raw, true);
  assert.throws(() => clearGrant(), /saved wallet was kept/);
  assert.equal(storage.get(key), raw);
  assert.equal(storage.has(archive), false);
});

it("discard preserves unreadable recovery data instead of silently deleting it", () => {
  const damaged = raw.slice(0, -1);
  const storage = installStorage(damaged);
  assert.throws(() => clearGrant(), /saved wallet was kept/);
  assert.equal(storage.get(key), damaged);
});

it("a successful discard keeps the recovery copy and cannot clobber another wallet's archive", () => {
  const storage = installStorage(raw);
  storage.set("merrymen.grant.archive.other", "other-wallet");
  clearGrant();
  assert.equal(storage.has(key), false);
  assert.equal(storage.get(archive), raw);
  assert.equal(storage.get("merrymen.grant.archive.other"), "other-wallet");
});
