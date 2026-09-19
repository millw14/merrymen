import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_WITHDRAWAL_DOORS, normalizeWithdrawals, normalizeWithdrawalsOrThrow } from "./session";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("normalizeWithdrawals — doors sealed into the wall at signing", () => {
  it("empty in, empty out (signed with no doors = no transfer permission)", () => {
    assert.deepEqual(normalizeWithdrawals(undefined), { doors: [] });
    assert.deepEqual(normalizeWithdrawals([]), { doors: [] });
  });

  it("trims names and lowercases addresses", () => {
    const { doors, error } = normalizeWithdrawals([{ name: "  Cold Wallet ", address: "0xABCDEF1111111111111111111111111111111111" }]);
    assert.equal(error, undefined);
    assert.deepEqual(doors, [{ name: "Cold Wallet", address: "0xabcdef1111111111111111111111111111111111" }]);
  });

  it("skips fully-blank rows (untouched form lines)", () => {
    const { doors, error } = normalizeWithdrawals([{ name: "", address: "" }, { name: "ex", address: A }]);
    assert.equal(error, undefined);
    assert.equal(doors.length, 1);
  });

  it("rejects nameless, over-long and badly-formed names", () => {
    assert.match(normalizeWithdrawals([{ name: "", address: A }]).error ?? "", /needs a name/);
    assert.match(normalizeWithdrawals([{ name: "x", address: A }]).error ?? "", /2–24/);
    assert.match(normalizeWithdrawals([{ name: "a".repeat(25), address: A }]).error ?? "", /2–24/);
    assert.match(normalizeWithdrawals([{ name: "cold;wallet", address: A }]).error ?? "", /letters, numbers/);
    assert.match(normalizeWithdrawals([{ name: "0xabc", address: A }]).error ?? "", /must not look like an address/);
  });

  it("rejects reserved names that chat could read as commands", () => {
    for (const reserved of ["cancel", "Confirm", "TRANSFER", "status", "agent"]) {
      assert.match(
        normalizeWithdrawals([{ name: reserved, address: A }]).error ?? "",
        /reserved/,
        `${reserved} must be rejected`,
      );
    }
  });

  it("rejects bad, duplicate and over-limit entries", () => {
    assert.match(normalizeWithdrawals([{ name: "x1", address: "nope" }]).error ?? "", /not a valid 0x/);
    assert.match(
      normalizeWithdrawals([{ name: "same", address: A }, { name: "SAME", address: B }]).error ?? "",
      /duplicate door name/,
    );
    assert.match(
      normalizeWithdrawals([{ name: "one", address: A }, { name: "two", address: A }]).error ?? "",
      /duplicate door address/,
    );
    const many = Array.from({ length: MAX_WITHDRAWAL_DOORS + 1 }, (_, i) => ({
      name: `door${i}`,
      address: `0x${String(i).padStart(2, "0")}${"11".repeat(19)}`,
    }));
    assert.match(normalizeWithdrawals(many).error ?? "", new RegExp(`at most ${MAX_WITHDRAWAL_DOORS}`));
  });

  it("the throwing wrapper throws on the first problem, passes doors through", () => {
    assert.throws(() => normalizeWithdrawalsOrThrow([{ name: "cancel", address: A }]), /reserved/);
    assert.deepEqual(normalizeWithdrawalsOrThrow([{ name: "ok", address: A }]), [{ name: "ok", address: A }]);
  });
});
