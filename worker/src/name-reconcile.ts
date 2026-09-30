/**
 * THE CONFIGURED NAME, CARRIED INTO THE SOUL AND ONTO THE ROSTER.
 *
 * Settings is the durable seed (the owner saved a name in the dashboard, or the
 * grants route gave a new agent one); the soul is the runtime seat that chat
 * answers with; the `agents` row is what the leaderboard and the feed read.
 * This is the one step that moves a name from the first to the other two.
 *
 * WHY IT IS ITS OWN MODULE. It used to be eleven lines inside `syncGrant`, and
 * its failures were all about WHERE in that function it sat: first below the
 * unchanged short-circuit (an armed agent never took a rename), then below the
 * expiry return (an agent whose key lapsed never took one either — the owner
 * renamed it, the store accepted it, and the leaderboard kept the old name for
 * good). Out here the behaviour is tested by running it, and index.ts only has
 * to call it first.
 *
 * NO CHAIN CALLS. A soul write and one UPDATE, so it is safe to run before the
 * kill and expiry returns, on a grant that will never arm.
 */

export interface NameSeat {
  ensureSoul(): void;
  getName(): string;
  /**
   * Write a name settings ALREADY holds — soul.ts `carryStoredName`, never
   * `setName`. The configured name was accepted when it was saved; this step
   * only carries it. Holding it to the rule for a name typed now would rename
   * every agent called "007" before the letter rule to "Robin" at its first
   * restart.
   */
  carryName(raw: string): { ok: true; name: string } | { ok: false; reason: string };
}

export interface NameRoster {
  /**
   * The ledger row to mirror onto, or null when there is no agent to key it on
   * (a killed agent: no grant, nothing armed).
   *
   * A THUNK, resolved only when there is something to write: resolving it is an
   * upsert, and the common tick has nothing to write.
   */
  agentId(): Promise<string | null>;
  setAgentName(agentId: string, name: string): Promise<void>;
  /** An owner-facing warning on the agent's own event feed. */
  warn(agentId: string, message: string): Promise<void>;
  log(line: string): void;
}

export type NameOutcome = "unchanged" | "renamed" | "refused";

/**
 * The soul's own shape. setName stores exactly this, and the settings route
 * stores it too, so comparing anything else would make an equal name look
 * different on every tick and rewrite the identity file forever.
 */
const soulForm = (raw: string) => raw.normalize("NFC").trim().replace(/\s+/g, " ");

export function createNameReconciler(seat: NameSeat) {
  /**
   * The refused value last seen, and whether the owner has been told about it.
   * `told` stays false while there is no agent to tell, so a refusal that
   * happened then is told once there is one.
   */
  let announced: { want: string; told: boolean } | null = null;

  return async function reconcileName(configured: string | undefined, roster: NameRoster): Promise<NameOutcome> {
    // NOTHING CONFIGURED IS NOT "CONFIGURED BLANK". A chat rename lives only in
    // the soul, so an empty setting has to leave it alone.
    const want = soulForm(configured ?? "");
    if (!want) return "unchanged";
    seat.ensureSoul();
    if (want === seat.getName()) {
      announced = null;
      return "unchanged";
    }

    const named = seat.carryName(want);
    if (named.ok) {
      announced = null;
      const id = await roster.agentId();
      if (id) await roster.setAgentName(id, named.name);
      return "renamed";
    }

    // NEVER A SILENT REFUSAL. The owner saved this name and was told it was
    // saved; the soul refusing it afterwards, with only a console line, is how
    // an agent comes to answer to "Robin" while its owner believes otherwise.
    // Said once per value — this runs every tick, and once the owner has been
    // told, a repeat costs nothing, not even the agent-id upsert.
    let refusal = announced;
    if (!refusal || refusal.want !== want) {
      refusal = announced = { want, told: false };
      roster.log(`[soul] refusing the configured name: ${named.reason}`);
    }
    if (refusal.told) return "refused";
    const id = await roster.agentId();
    if (id) {
      refusal.told = true;
      await roster.warn(
        id,
        `Your agent can't be called "${want}": ${named.reason}. It is still called ${seat.getName()} — ` +
          `choose another name in Settings.`,
      );
    }
    return "refused";
  };
}

/**
 * THE NAME AN ARM PUTS ON THE ROSTER: the soul's, exactly as it reads back.
 *
 * Every restart is a re-arm, so this runs on every deploy for every agent. It
 * was two inline lines in index.ts, and it is out here because it is where a
 * name the soul reads back wrongly becomes public: with "007" read back as the
 * default, this is the call that would write "Robin" onto the row the
 * leaderboard, the public feed and the profile all read. A test can now run
 * the arm's own step instead of trusting it.
 */
export async function mirrorNameOnArm(
  seat: Pick<NameSeat, "ensureSoul" | "getName">,
  agentId: string,
  setAgentName: (agentId: string, name: string) => Promise<void>,
): Promise<string> {
  seat.ensureSoul();
  const name = seat.getName();
  await setAgentName(agentId, name);
  return name;
}
