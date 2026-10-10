#!/usr/bin/env node
/**
 * Operator CLI to issue, revoke and list partner keys.
 *
 * Most keys no longer come from here. Developers mint their own at
 * merrymen.dev/api, through this gateway's /developer/v1 routes
 * (lib/developer-api.mjs): only the site, holding MERRYMEN_DEVELOPER_PORTAL_SECRET,
 * may call them, and only for a wallet that has just signed in. Those keys are
 * fixed: read:agents, write:agents and chat:agents at 30 requests a minute, at
 * most five active per wallet.
 *
 * This CLI is for what the portal deliberately cannot do: other scopes, a custom
 * quota (--rpm), or a key that belongs to no developer wallet. Such a key does
 * not show in the portal, which cannot rotate or revoke it; do that here. Both
 * kinds share one registry, $MERRYMEN_DATA_DIR/partners.jsonl.
 *
 *   MERRYMEN_GATEWAY_SECRET=… MERRYMEN_DATA_DIR=/data \
 *     node partners-cli.mjs issue --name prism --app-id prism-production \
 *       --scopes read:agents,write:agents,chat:agents
 *   node partners-cli.mjs revoke <keyId>
 *   node partners-cli.mjs list
 *
 * Pass --scopes: the default (read:agents, read:theses, read:market) cannot
 * create agents or chat. Reuse --app-id when rotating, or the new key is a
 * different application that cannot reach the old one's connections.
 *
 * The full key is printed ONCE, on issue. Only its HMAC is written down, so a
 * lost key is re-issued and never recovered. A revocation reaches the running
 * gateway within its registry TTL (30 seconds).
 */

import { DEFAULT_SCOPES, SCOPES, hashSecret, loadRegistry, makeKey, writeRecord } from "./lib/partners.mjs";

const SECRET = process.env.MERRYMEN_GATEWAY_SECRET;

function die(msg) {
  console.error(`[partners] ${msg}`);
  process.exit(1);
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function issue(argv) {
  if (!SECRET) die("MERRYMEN_GATEWAY_SECRET is not set — the key hash is derived from it.");
  const name = flag(argv, "name");
  if (!name) die("issue needs --name <partner>");

  const raw = flag(argv, "scopes");
  const scopes = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_SCOPES];
  const bad = scopes.filter((s) => !SCOPES.includes(s));
  // Refuse rather than drop: a typo'd scope that is silently ignored hands
  // somebody a key that does less than the operator believes it does.
  if (bad.length) die(`unknown scope(s): ${bad.join(", ")}. Known: ${SCOPES.join(", ")}`);

  const rpmRaw = flag(argv, "rpm");
  const rpm = rpmRaw ? Number(rpmRaw) : null;
  if (rpmRaw && !(Number.isFinite(rpm) && rpm > 0)) die("--rpm must be a positive number");

  const { key, keyId, secret } = makeKey();
  const appId = flag(argv, "app-id") ?? keyId;
  if (!/^[a-zA-Z0-9_-]{12,64}$/.test(appId)) die("--app-id must contain 12–64 letters, digits, underscores or hyphens");
  await writeRecord({
    keyId,
    appId,
    name,
    hash: hashSecret(SECRET, secret),
    scopes,
    ...(rpm ? { rpm } : {}),
    status: "active",
    created_at: new Date().toISOString().slice(0, 10),
  });

  console.log(`\n  partner   ${name}`);
  console.log(`  key id    ${keyId}`);
  console.log(`  app id    ${appId} (reuse --app-id when rotating this app's key)`);
  console.log(`  scopes    ${scopes.join(", ")}`);
  console.log(`\n  KEY (shown once — store it now, it is not recoverable):\n\n    ${key}\n`);
}

async function revoke(argv) {
  const keyId = argv[1];
  if (!keyId) die("revoke needs a <keyId>");
  const reg = await loadRegistry();
  const rec = reg.get(keyId);
  if (!rec) die(`no such key: ${keyId}`);
  // Append, never edit. The reader takes the last record for a keyId, so this
  // line IS the revocation and the original record stays as history.
  await writeRecord({ ...rec, status: "revoked", revoked_at: new Date().toISOString().slice(0, 10) });
  console.log(`[partners] revoked ${keyId} (${rec.name}). Live within the registry TTL.`);
}

async function list() {
  const reg = await loadRegistry();
  if (reg.size === 0) return console.log("[partners] no keys.");
  for (const r of reg.values()) {
    const mark = r.status === "active" ? "active " : "REVOKED";
    console.log(`  ${mark}  ${r.keyId}  ${String(r.name).padEnd(18)}  ${r.scopes.join(",") || "-"}`);
  }
}

const argv = process.argv.slice(2);
switch (argv[0]) {
  case "issue":
    await issue(argv);
    break;
  case "revoke":
    await revoke(argv);
    break;
  case "list":
    await list();
    break;
  default:
    console.log("usage: partners-cli.mjs issue --name <p> [--app-id stableAppId] [--scopes a,b] [--rpm N] | revoke <keyId> | list");
    process.exit(argv[0] ? 1 : 0);
}
