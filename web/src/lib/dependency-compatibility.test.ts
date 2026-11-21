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

it("SDKs that pin zod 3 validate as before on the patched zod 4 the overrides give them", async () => {
  // GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6) has no zod 3 fix. package.json points
  // the zod of x402, @coinbase/cdp-sdk and @reown/appkit-wallet, all reached
  // only through @privy-io/react-auth, at Merrymen's own patched zod. Each
  // override names the package that imports zod: npm 10 (CI's npm ci) does not
  // carry an override on x402 down to the copies npm hoists out of its tree.
  const privy = packageDir(fileURLToPath(new URL(".", import.meta.url)), "@privy-io/react-auth");
  const x402 = packageDir(privy, "x402");
  const connectors = packageDir(packageDir(x402, "wagmi"), "@wagmi/connectors");
  const baseAccount = packageDir(connectors, "@base-org/account");
  const appkits = [privy, connectors].map((parent) => packageDir(packageDir(parent, "@walletconnect/ethereum-provider"), "@reown/appkit"));
  for (const directory of [x402, packageDir(baseAccount, "@coinbase/cdp-sdk"), ...appkits.map((appkit) => packageDir(appkit, "@reown/appkit-wallet"))]) {
    const [major, minor, patch] = zodVersion(directory).split(".").map(Number);
    assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), `${directory} loads zod ${zodVersion(directory)}`);
  }

  // Privy's x402 payment hook checks a server's 402 response with these.
  const { PaymentRequirementsSchema } = requireFrom(privy)("x402/types");
  const requirement = { scheme: "exact", network: "base", maxAmountRequired: "1000", resource: "https://example.com/item", description: "", mimeType: "application/json", payTo: `0x${"1".repeat(40)}`, maxTimeoutSeconds: 60, asset: `0x${"2".repeat(40)}` };
  assert.equal(PaymentRequirementsSchema.safeParse(requirement).success, true);
  assert.equal(PaymentRequirementsSchema.safeParse({ ...requirement, maxAmountRequired: "1.5" }).success, false);
  assert.equal(PaymentRequirementsSchema.safeParse({ ...requirement, payTo: "not an address" }).success, false);

  // Reown's embedded-wallet iframe messages, in both AppKit copies.
  for (const appkit of appkits) {
    const { W3mFrameSchema } = await importFrom(appkit, "@reown/appkit-wallet");
    assert.equal(W3mFrameSchema.appEvent.safeParse({ type: "@w3m-app/CONNECT_EMAIL", payload: { email: "owner@example.com" } }).success, true, appkit);
    assert.equal(W3mFrameSchema.appEvent.safeParse({ type: "@w3m-app/CONNECT_EMAIL", payload: { email: "not an email" } }).success, false, appkit);
    assert.equal(W3mFrameSchema.frameEvent.safeParse({ id: "1", type: "@w3m-frame/GET_CHAIN_ID_SUCCESS", payload: { chainId: "eip155:1" } }).success, true, appkit);
    assert.equal(W3mFrameSchema.frameEvent.safeParse({ type: "@w3m-frame/CONNECT_EMAIL_SUCCESS", payload: { action: "UNKNOWN" } }).success, false, appkit);
  }

  // CDP's policy bodies, including the rule-count cap: a constrained collection.
  const { CreatePolicyBodySchema } = requireFrom(baseAccount)("@coinbase/cdp-sdk");
  const rule = { action: "reject", operation: "signEvmTransaction", criteria: [{ type: "ethValue", ethValue: "1000", operator: ">" }] };
  assert.equal(CreatePolicyBodySchema.safeParse({ scope: "account", rules: [rule] }).success, true);
  assert.equal(CreatePolicyBodySchema.safeParse({ scope: "account", rules: Array(101).fill(rule) }).success, false);
  assert.equal(CreatePolicyBodySchema.safeParse({ scope: "account", rules: [{ ...rule, operation: "unknown" }] }).success, false);
});
