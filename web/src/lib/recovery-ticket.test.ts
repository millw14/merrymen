import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { mintTicket, readTicket, recoveryChallengeMessage, TICKET_TTL_MS } from "./recovery-ticket";

/**
 * The ticket is an anti-abuse token, not a fund-safety control — but it still
 * has to be a real token. A forgeable or immortal one turns the relay into an
 * open bundler proxy on the house's account.
 */

const ACCOUNT = "0x032da6a0ccf866474e45854e7fdef9afd1509036" as const;

before(() => {
  process.env.MERRYMEN_SESSION_SECRET = "x".repeat(48);
});

describe("recovery tickets", () => {
  it("round-trips the account and chain it was minted for", () => {
    const t = readTicket(mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVault: null }));
    assert.ok(t);
    assert.equal(t!.smartAccount, ACCOUNT);
    assert.equal(t!.chainId, 4663);
  });

  it("EXPIRES — a leaked ticket must not be useful tomorrow", () => {
    const now = Date.now();
    const t = mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVault: null }, now);
    assert.ok(readTicket(t, now + TICKET_TTL_MS - 1_000), "still valid inside the window");
    assert.equal(readTicket(t, now + TICKET_TTL_MS + 1_000), null, "and dead after it");
  });

  it("refuses a tampered account — the signature covers the payload", () => {
    // The whole point: the relay trusts ticket.smartAccount, so editing it must
    // invalidate the token rather than redirect the permission.
    const t = mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVault: null });
    const parts = t.split(".");
    parts[0] = "0x1111111111111111111111111111111111111111";
    assert.equal(readTicket(parts.join(".")), null);
  });

  it("refuses a tampered chain id", () => {
    const t = mintTicket({ smartAccount: ACCOUNT, chainId: 46630, classVault: null });
    const parts = t.split(".");
    parts[1] = "4663";
    assert.equal(readTicket(parts.join(".")), null);
  });

  it("refuses an extended expiry", () => {
    const t = mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVault: null });
    const parts = t.split(".");
    parts[2] = String(Date.now() + 10 * 365 * 24 * 3600 * 1000);
    assert.equal(readTicket(parts.join(".")), null);
  });

  it("refuses junk", () => {
    for (const junk of ["", "a.b.c", "a.b.c.d.e", "not-a-ticket", null, undefined]) {
      assert.equal(readTicket(junk as string | null | undefined), null, String(junk));
    }
  });
});

describe("the challenge text", () => {
  it("binds BOTH origin and nonce into what gets signed", () => {
    // A fixed message would make the signature a permanent bearer credential:
    // anyone who ever saw it — a log line, a support paste, a screenshot — could
    // mint tickets for that account forever, and could replay it at another site.
    const m = recoveryChallengeMessage("https://app.merrymen.dev", "NONCE123");
    assert.match(m, /https:\/\/app\.merrymen\.dev/);
    assert.match(m, /NONCE123/);
    assert.notEqual(
      m,
      recoveryChallengeMessage("https://evil.example", "NONCE123"),
      "the same signature must not be valid at another origin",
    );
    assert.notEqual(
      m,
      recoveryChallengeMessage("https://app.merrymen.dev", "OTHER"),
      "and must not be reusable with a fresh nonce",
    );
  });

  it("tells the signer, in words, that it moves no funds", () => {
    // Somebody is being asked to sign with the key that controls all their
    // money. They deserve a sentence rather than a hex blob.
    const m = recoveryChallengeMessage("https://app.merrymen.dev", "N");
    assert.match(m, /moves no funds/i);
  });
});

/**
 * THE VAULT TRAVELS INSIDE THE SIGNATURE.
 *
 * The relay admits a `sweep(address)` leg only when its target equals the vault
 * named here, so this field is a capability. If it were appended outside the
 * hmac a caller could edit which vault their ticket blesses, which is precisely
 * what the pin exists to prevent.
 */
describe("the class vault a ticket blesses", () => {
  const VAULT = "0x3fcdde6e011769ca05f0115f1543290862473216" as const;

  it("round-trips", () => {
    const t = readTicket(mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVault: VAULT }));
    assert.equal(t?.classVault, VAULT);
  });

  it("and null stays null — most accounts have no vault", () => {
    const t = readTicket(mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVault: null }));
    assert.equal(t?.classVault, null);
  });

  it("CANNOT BE EDITED without breaking the signature", () => {
    const token = mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVault: VAULT });
    const parts = token.split(".");
    parts[2] = "0x2222222222222222222222222222222222222222";
    assert.equal(readTicket(parts.join(".")), null, "a swapped vault must not verify");
  });

  it("and a ticket in the old four-field shape does not parse", () => {
    // The format changed when the vault joined the body. An old ticket failing
    // closed costs one re-signature inside a 15-minute TTL; an old ticket
    // parsing as "no vault" would strand a class sweep with a confusing reason.
    const body = `${ACCOUNT.toLowerCase()}.4663.${Date.now() + 60_000}`;
    assert.equal(readTicket(`${body}.whatever`), null);
  });
});
