import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** The directory Node loads `name` from when the package in `from` imports it. */
function packageDir(from: string, name: string): string {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    assert.notEqual(directory, path.dirname(directory), `${name} is not installed above ${from}`);
  }
}
const requireFrom = (directory: string) => createRequire(path.join(directory, "package.json"));
const importFrom = (directory: string, specifier: string) => import(pathToFileURL(requireFrom(directory).resolve(specifier)).href);
const zodVersion = (directory: string): string => JSON.parse(readFileSync(path.join(packageDir(directory, "zod"), "package.json"), "utf8")).version;

it("wallet packages retain their CommonJS UUID APIs after the security override", () => {
  for (const parent of ["@metamask/sdk", "@metamask/sdk-communication-layer", "@metamask/utils"]) {
    const dependency = createRequire(require.resolve(parent));
    const uuid = dependency("uuid");
    const id = uuid.v4();
    assert.equal(uuid.validate(id), true, parent);
    assert.equal(uuid.version(id), 4, parent);
    const buffer = new Uint8Array(16);
    assert.equal(uuid.v4(undefined, buffer), buffer, parent);
    assert.equal(uuid.stringify(buffer), uuid.stringify(uuid.parse(uuid.stringify(buffer))), parent);
    assert.throws(() => uuid.v5("test", uuid.v5.DNS, new Uint8Array(1)), /buffer|bounds/i);
  }
});

it("the patched WalletConnect utility preserves pairing URI round trips", () => {
  // Resolve from the old connector consumer as well as the direct provider:
  // both were present in the wallet dependency graph before the override.
  for (const parent of ["@wagmi/connectors", "@walletconnect/ethereum-provider"]) {
    const consumer = createRequire(require.resolve(parent));
    const provider = createRequire(consumer.resolve("@walletconnect/ethereum-provider"));
    const utils = provider("@walletconnect/utils");
    const parameters = { topic: "a".repeat(64), version: 2, symKey: "b".repeat(64), relay: { protocol: "irn" } };
    const parsed = utils.parseUri(utils.formatUri(parameters));
    assert.equal(parsed.topic, parameters.topic);
    assert.equal(parsed.symKey, parameters.symKey);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.relay.protocol, "irn");
  }
});

type Schema = { safeParse(value: unknown): { success: boolean; data?: any; error?: { issues: { path: PropertyKey[] }[] } } };
/** `schema` rejects `value`, and only at the field `at`: the sample fails for the reason it was written for. */
function rejects(schema: Schema, value: unknown, at: string, message?: string) {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, message);
  assert.deepEqual(result.error?.issues.map((issue) => issue.path.map(String).join(".")), [at], message);
}
function accepts(schema: Schema, value: unknown, message?: string) {
  const result = schema.safeParse(value);
  assert.equal(result.success, true, `${message ?? ""} ${JSON.stringify(result.error?.issues)}`);
  return result.data;
}

it("SDKs that pin zod 3 accept and reject these sample payloads on the patched zod 4 the overrides give them", async () => {
  // GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6) has no zod 3 fix. package.json points
  // the zod of x402, @coinbase/cdp-sdk and @reown/appkit-wallet, all reached
  // only through @privy-io/react-auth, at Merrymen's own patched zod. Each
  // override names the package that imports zod: npm 10 (CI's npm ci) does not
  // carry an override on x402 down to the copies npm hoists out of its tree.
  // These samples are spot checks of the paths below, not proof that every
  // schema in these SDKs behaves as it did on zod 3.
  const privy = packageDir(fileURLToPath(new URL(".", import.meta.url)), "@privy-io/react-auth");
  const x402 = packageDir(privy, "x402");
  const connectors = packageDir(packageDir(x402, "wagmi"), "@wagmi/connectors");
  const baseAccount = packageDir(connectors, "@base-org/account");
  const cdp = packageDir(baseAccount, "@coinbase/cdp-sdk");
  const appkits = [privy, connectors].map((parent) => packageDir(packageDir(parent, "@walletconnect/ethereum-provider"), "@reown/appkit"));
  // The abitype copies under cdp-sdk and connectors lost the zod 3 they used
  // to find beside them, so they now find the root zod too.
  for (const directory of [x402, cdp, ...appkits.map((appkit) => packageDir(appkit, "@reown/appkit-wallet")), packageDir(cdp, "abitype"), packageDir(connectors, "abitype")]) {
    const [major, minor, patch] = zodVersion(directory).split(".").map(Number);
    assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), `${directory} loads zod ${zodVersion(directory)}`);
  }

  // Privy's useX402Fetch checks a server's 402 body with x402ResponseSchema
  // minus `error`, then the requirement it picks with PaymentRequirementsSchema.
  // `extra` (a single-argument z.record on zod 3) carries the token's EIP-712
  // name and version into the payment signature, so it must come through.
  const { PaymentRequirementsSchema, x402ResponseSchema } = requireFrom(privy)("x402/types");
  const extra = { name: "USD Coin", version: "2" };
  const requirement = { scheme: "exact", network: "base", maxAmountRequired: "1000", resource: "https://example.com/item", description: "", mimeType: "application/json", payTo: `0x${"1".repeat(40)}`, maxTimeoutSeconds: 60, asset: `0x${"2".repeat(40)}`, extra };
  const body = { x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirement] };
  assert.deepEqual(accepts(x402ResponseSchema.omit({ error: true }), body).accepts[0].extra, extra);
  assert.deepEqual(accepts(PaymentRequirementsSchema, requirement).extra, extra);
  rejects(x402ResponseSchema.omit({ error: true }), { ...body, x402Version: 2 }, "x402Version");
  rejects(PaymentRequirementsSchema, { ...requirement, extra: "USD Coin" }, "extra");
  rejects(PaymentRequirementsSchema, { ...requirement, maxAmountRequired: "1.5" }, "maxAmountRequired");
  rejects(PaymentRequirementsSchema, { ...requirement, payTo: "not an address" }, "payTo");

  // Reown's embedded-wallet iframe messages, in both AppKit copies. A frame
  // reply reaches its caller only when the parsed `id` matches the request's.
  for (const appkit of appkits) {
    const { W3mFrameSchema } = await importFrom(appkit, "@reown/appkit-wallet");
    const email = { id: "1", type: "@w3m-app/CONNECT_EMAIL", payload: { email: "owner@example.com" } };
    accepts(W3mFrameSchema.appEvent, email, appkit);
    rejects(W3mFrameSchema.appEvent, { ...email, payload: { email: "not an email" } }, "payload.email", appkit);
    assert.equal(accepts(W3mFrameSchema.frameEvent, { id: "2", type: "@w3m-frame/GET_CHAIN_ID_SUCCESS", payload: { chainId: "eip155:1" } }, appkit).id, "2");
    const reply = { id: "3", type: "@w3m-frame/CONNECT_EMAIL_SUCCESS", payload: { action: "VERIFY_OTP" } };
    assert.deepEqual(accepts(W3mFrameSchema.frameEvent, reply, appkit), reply);
    // A union of every frame event: zod reports no single field, so the
    // accepted twin above is what pins the failure on the unknown action.
    assert.equal(W3mFrameSchema.frameEvent.safeParse({ ...reply, payload: { action: "UNKNOWN" } }).success, false, appkit);
  }

  // CDP's policy bodies. evmAddress and evmData use abitype's own zod schemas
  // (Address, Abi), which now run on zod 4 too. The rule-count cap is a
  // constrained collection, the shape the advisory is about.
  const { CreatePolicyBodySchema } = requireFrom(baseAccount)("@coinbase/cdp-sdk");
  const transfer = { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] };
  const criteria = [
    { type: "ethValue", ethValue: "1000", operator: ">" },
    { type: "evmAddress", addresses: [`0x${"a".repeat(40)}`], operator: "in" },
    { type: "evmData", abi: [transfer], conditions: [{ function: "transfer", params: [{ name: "value", operator: "<=", value: "1000" }] }] },
  ];
  const rule = { action: "reject", operation: "signEvmTransaction", criteria };
  assert.deepEqual(accepts(CreatePolicyBodySchema, { scope: "account", rules: [rule] }).rules[0].criteria, criteria);
  rejects(CreatePolicyBodySchema, { scope: "account", rules: [{ ...rule, criteria: [criteria[0], { ...criteria[1], addresses: ["0x1234"] }] }] }, "rules.0.criteria.1.addresses.0");
  rejects(CreatePolicyBodySchema, { scope: "account", rules: [{ ...rule, criteria: [{ ...criteria[2], abi: [{ ...transfer, inputs: [{ name: "to", type: "not a type" }] }] }] }] }, "rules.0.criteria.0.abi");
  rejects(CreatePolicyBodySchema, { scope: "account", rules: Array(101).fill(rule) }, "rules");
  rejects(CreatePolicyBodySchema, { scope: "account", rules: [{ ...rule, operation: "unknown" }] }, "rules.0.operation");
});

it("each package given the root zod still declares zod 3 itself; once one stops, drop its override", () => {
  // Remove an override when its package no longer asks for zod 3: Privy 3.52.x
  // (drops x402), a Reown appkit-wallet on zod 4 (appkit PRs #5830/#5844) that
  // WalletConnect and Privy pin, or a cdp-sdk that accepts zod 4 (PR #867).
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const overridden = Object.entries(manifest.overrides).filter(([, value]) => (value as { zod?: string }).zod === "$zod").map(([name]) => name).sort();
  assert.deepEqual(overridden, ["@coinbase/cdp-sdk", "@reown/appkit-wallet", "x402"]);
  const { packages } = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const name of overridden) {
    const copies = Object.keys(packages).filter((location) => location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`));
    assert.ok(copies.length > 0, `${name} is no longer installed: drop its zod override`);
    for (const location of copies) {
      const { version, dependencies } = JSON.parse(readFileSync(path.join(root, location, "package.json"), "utf8"));
      assert.match(dependencies?.zod ?? "none", /^[~^]?3\.\d+\.\d+$/, `${location}@${version} declares zod ${dependencies?.zod ?? "none"}, not a zod 3 range: drop the ${name} zod override once no copy asks for zod 3, and update this test`);
    }
  }
});
