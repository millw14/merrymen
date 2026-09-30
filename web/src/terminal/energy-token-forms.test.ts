import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * $MERRYMEN CANNOT BE ADDED AS A TRADABLE COIN.
 *
 * Every signer drops the energy reserve from the sealed tokens (core wall.ts
 * usableExtraTokens) and the worker never watches it, so a form that accepted
 * its address produced a coin no signature could ever cover — and, on the
 * create screen, a promise ("covered by the permission you sign") that was
 * false for exactly this one address. Both token-add forms refuse it, with the
 * two ways energy actually arrives, BEFORE the token reaches the draft list.
 */
const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the token-add forms refuse the energy reserve", () => {
  it("SETTINGS REFUSES IT BEFORE THE DRAFT LIST GROWS", () => {
    const src = read("./screens/Settings.tsx");
    const at = src.indexOf("function addToken()");
    assert.ok(at > 0);
    const body = src.slice(at, src.indexOf("setTokens([...current, candidate])", at));
    assert.match(body, /if \(isEnergyReserveToken\(candidate\.address\)\) \{/);
    assert.match(body, /get its \$MERRYMEN/);
  });

  it("CREATE REFUSES IT BEFORE THE WIZARD LIST GROWS", () => {
    const src = read("./screens/CreateAgent.tsx");
    const guard = src.indexOf("if(isEnergyReserveToken(candidate.address))");
    const add = src.indexOf("setWizardTokens(t=>[...t,candidate as CustomToken])");
    assert.ok(guard > 0 && add > guard, "the reserve is refused before it is added");
  });

  it("neither refusal talks about price", () => {
    for (const p of ["./screens/Settings.tsx", "./screens/CreateAgent.tsx"]) {
      const src = read(p);
      for (const line of src.split("\n").filter((l) => l.includes("your agent's energy, not a coin it trades"))) {
        assert.doesNotMatch(line, /\bprice\b|\breturns\b|\bprofit/i, `${p}: ${line.trim()}`);
      }
    }
  });
});
