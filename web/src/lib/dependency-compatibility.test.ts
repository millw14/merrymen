import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";

const require = createRequire(import.meta.url);

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
