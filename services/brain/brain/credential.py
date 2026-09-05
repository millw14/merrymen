"""
BRAIN'S KEY IS ITS OWN, AND IT CANNOT BORROW THE FLEET'S.

The 24 live agents share one house key. On 2026-08-31 a background feature
nobody had switched on consumed that key's entire 200,000-token daily allowance,
and the first person to notice was a user whose chat had stopped working. Brain
evaluation is exactly that shape of workload — long, bursty, and run by someone
who is not watching the agents — so "remember not to point it at the house key"
is not a control.

The control is that the house key's NAME is refused. `GROQ_API_KEY` is what the
worker and the orchestrator read; if Brain is handed that variable, or handed a
value identical to it, it refuses to start rather than quietly spending the
fleet's allowance. An evaluation that cannot run is a bad afternoon. An
evaluation that silently stops 24 agents trading is an incident.

WHAT THIS IS NOT: a claim that the two keys must be from different providers, or
even different accounts. They may be the same provider and the same billing
account — what they may not be is the same CREDENTIAL, because a shared
credential shares a rate limit and a quota, and those are the things that run
out.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

#: Variables the FLEET reads. Brain reading any of these would put its spend on
#: the agents' allowance, so the name itself is refused.
FLEET_KEY_VARS = ("GROQ_API_KEY", "MERRYMEN_LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY")

#: The only variable Brain will take a key from.
BRAIN_KEY_VAR = "BRAIN_LLM_API_KEY"


class CredentialRefused(RuntimeError):
    """Brain will not start on a key that is not its own."""


@dataclass(frozen=True)
class Credential:
    key: str
    #: Where it came from, for the health endpoint. NEVER the key itself.
    source: str

    @property
    def fingerprint(self) -> str:
        """
        Enough to tell two keys apart in a log, and not enough to use.

        Last four characters only. A log line that says which key a run used is
        genuinely useful when two are in play; a log line that says what the key
        IS has moved the secret into the log aggregator.
        """
        return f"…{self.key[-4:]}" if len(self.key) >= 4 else "…"


def _dotenv() -> dict[str, str]:
    """
    Read services/brain/.env, if it is there.

    Hand-rolled rather than pulling in python-dotenv, for two reasons: the
    dependency would be the only one this module has, and dotenv walks UP the
    directory tree — which on this machine finds a UTF-16 .env belonging to
    another project and crashes on it. This reads exactly one file, in one
    place, and ignores anything it cannot parse.
    """
    path = Path(__file__).resolve().parent.parent / ".env"
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip().strip('"').strip("'")
    except (OSError, UnicodeDecodeError):
        pass
    return out

def resolve(env: dict[str, str | None] | None = None) -> Credential:
    """
    Find Brain's key, or refuse. PURE with respect to a passed environment.

    Three outcomes, and the middle one is the point:

      a key in BRAIN_LLM_API_KEY that differs from every fleet key  → use it
      a key in BRAIN_LLM_API_KEY that EQUALS a fleet key            → refuse
      no key at all                                                 → refuse
    """
    # A REAL ENVIRONMENT VARIABLE WINS over the file. The file is a developer
    # convenience; a deployment sets the variable, and the file must never be
    # able to override what an operator configured.
    e = env if env is not None else {**_dotenv(), **os.environ}
    own = (e.get(BRAIN_KEY_VAR) or "").strip()

    if not own:
        present = [v for v in FLEET_KEY_VARS if (e.get(v) or "").strip()]
        hint = (
            f" {', '.join(present)} is set, but that is the fleet's key and Brain will not use it."
            if present
            else ""
        )
        raise CredentialRefused(
            f"{BRAIN_KEY_VAR} is not set, so Brain has no credential of its own.{hint} "
            f"Set {BRAIN_KEY_VAR} to a key issued for Brain."
        )

    for var in FLEET_KEY_VARS:
        fleet = (e.get(var) or "").strip()
        if fleet and fleet == own:
            raise CredentialRefused(
                f"{BRAIN_KEY_VAR} holds the same credential as {var}. A shared credential shares a "
                f"rate limit and a quota, so a Brain evaluation would spend the 24 live agents' "
                f"allowance. Issue Brain its own key."
            )

    return Credential(key=own, source=BRAIN_KEY_VAR)
