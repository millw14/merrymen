"""
ON-CHAIN IDS IN TEXT, by shape (Solana integration, phase 0, 2026-10-16).

The detector from packages/core/src/ids.ts (`onchainIdsIn`), mirrored here
because Brain cannot import TypeScript. The address backstop in schemas.py
caught only 0x hex, and a Solana id is base58: a model that can write a mint
or a signature can write one nobody allowlisted, exactly as with an 0x string.

THE SAME RULES, pattern for pattern:

  EVM      0x + 40 hex (an address) or 0x + 64 hex (a hash), not inside more hex.
  Solana   a base58 run, not inside a longer word, that decodes to 32 bytes
           (a key: a wallet, a mint, a program) or 64 bytes (a signature, or
           a secret key, which is the same length); and links to the Solana
           explorers.

A run made only of letters can still be a key or signature, so every candidate
is decoded. The shape is enough; a match is never checked against a chain.

THE GLUED SCAN (`glued=True`, audit regressions F3), as ids.ts reads it: an id
written against the text around it ("CA<mint>", "<mint>is") is still an id.
Every maximal base58 run is read. A run with nothing alphanumeric on either
side is read exactly as the default reads it. Any other run, or a standalone
one that is not itself a key or signature, is a hit when the whole run or any
86-88 or 32-44 character window of it decodes to exactly 64 or 32 bytes, and
the hit's value is the whole run, so a redactor strips all of it. Windows of
hex digits alone (digests, long numbers, an 0x string split by its zeros) are
never ids, nor is filler (one to four characters repeated: "xxxx...",
"hahaha..."), nor an 0x prefix with hex alone behind it; after a "0", an "x"
with anything else behind it is part of the run, since a key can begin with
one. A window shorter than 43 (or 87)
characters can reach 32 (or 64) bytes only through leading "1"s, so no other
short window is decoded. And one scan decodes at most 4,096 windows: past that
every further candidate run is a hit unread, a false alarm on a text no one
writes, never an id let through. Brain's backstop (schemas.py
`_reject_executable`) uses the glued scan.

tests/data/onchain_ids.json pins this file and ids.ts to the same answers, in
both scans: CI's brain job asserts it here, through tests/test_onchain_ids.py,
and its app tests assert it for ids.ts, through
worker/src/brain-client-onchain-ids.test.ts.

Pure and self-contained: no I/O, no dependency.
"""

from __future__ import annotations

import re
from itertools import accumulate
from typing import Literal, NamedTuple

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58)}


def base58_decode(s: str) -> bytes | None:
    """Bitcoin-alphabet base58 to bytes, or None for any character outside it."""
    if not isinstance(s, str) or not s or len(s) > 128:
        return None
    n = 0
    for ch in s:
        digit = _B58_INDEX.get(ch)
        if digit is None:
            return None
        n = n * 58 + digit
    # Each leading "1" is a leading zero byte.
    zeros = len(s) - len(s.lstrip("1"))
    return b"\x00" * zeros + n.to_bytes((n.bit_length() + 7) // 8, "big")


class OnchainIdHit(NamedTuple):
    family: Literal["evm", "solana"]
    #: "address" (a 20- or 32-byte id), "hash" (a 32-byte EVM hash or a 64-byte
    #: Solana signature) or "link" (an explorer URL).
    shape: Literal["address", "hash", "link"]
    value: str


_EVM_IN_TEXT = re.compile(r"0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])")
#: A run of base58 long enough to be a 32-byte key (32-44 chars) or a 64-byte
#: signature (86-88 chars), not inside a longer word.
_BASE58_IN_TEXT = re.compile(r"(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,88}(?![0-9A-Za-z])")
#: JavaScript's `\s`, spelled out, so a link ends where ids.ts ends it. ASCII
#: below keeps `\b` and the case folding to ASCII letters, as JavaScript does.
_JS_SPACE = "\t\n\v\f\r    -     　﻿"
_SOLANA_LINK = re.compile(
    r"\b(?:https?://)?(?:www\.)?(?:solscan\.io|explorer\.solana\.com|solana\.fm|solanabeach\.io|orb\.helius\.dev)/"
    f"[^{_JS_SPACE})>\\]]*",
    re.IGNORECASE | re.ASCII,
)


#: A maximal run of base58 characters, wherever it sits (the glued scan).
_BASE58_RUN = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,}")
_ALNUM = frozenset("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
_HEX = frozenset("0123456789ABCDEFabcdef")
#: Base58 decodes one glued scan may spend (ids.ts GLUED_DECODES).
GLUED_DECODES = 4096
#: The longest pattern filler repeats (ids.ts FILLER_PERIOD).
_FILLER_PERIOD = 4


def _filler(s: str) -> bool:
    """`s` repeats a pattern of _FILLER_PERIOD characters or fewer from end to end: filler, never an id."""
    return any(all(s[i] == s[i + k] for i in range(len(s) - k)) for k in range(1, _FILLER_PERIOD + 1))


def _base58_shape(s: str) -> Literal["address", "hash"] | None:
    b = base58_decode(s)
    if b is not None and len(b) == 32:
        return "address"
    if b is not None and len(b) == 64:
        return "hash"
    return None


def _glued_shape(run: str, budget: list[int]) -> Literal["address", "hash", "unread"] | None:
    """
    The shape of an id inside `run`, "unread" once the budget is spent, or
    None: ids.ts `gluedShape`, window for window and decode for decode, so the
    two spend their budgets alike. 58**42 < 2**248 and 58**86 < 2**504, so a
    window shorter than 43 (or 87) characters reaches 32 (or 64) bytes only
    through leading zero bytes, which base58 writes as leading "1"s.
    """
    n = len(run)
    # non_hex[i]: characters before i that are not hex digits, so a window of hex alone is skipped in O(1).
    non_hex = list(accumulate((ch not in _HEX for ch in run), initial=0))
    if non_hex[n] == 0:
        return None
    # breaks[k - 1][i]: positions p < i where run[p] differs from run[p + k], so a window of filler is skipped in O(1).
    breaks = [
        list(accumulate((p + k < n and run[p] != run[p + k] for p in range(n)), initial=0))
        for k in range(1, _FILLER_PERIOD + 1)
    ]
    for lo, hi, full, size in ((86, 88, 87, 64), (32, 44, 43, 32)):
        for start in range(0, n - lo + 1):
            base = non_hex[start]
            last = start + hi if start + hi <= n else n
            # Every window from here is hex alone: non_hex never decreases.
            if non_hex[last] == base:
                continue
            # Short windows only from a leading "1"; others start at the full length.
            for stop in range(start + (lo if run[start] == "1" else full), last + 1):
                if non_hex[stop] == base:
                    continue
                if any(b[stop - k] == b[start] for k, b in enumerate(breaks, 1)):
                    continue
                budget[0] -= 1
                if budget[0] < 0:
                    return "unread"
                b = base58_decode(run[start:stop])
                if b is not None and len(b) == size:
                    return "hash" if size == 64 else "address"
    return None


def _glued_hits(text: str) -> list[OnchainIdHit]:
    hits: list[OnchainIdHit] = []
    budget = [GLUED_DECODES]
    for m in _BASE58_RUN.finditer(text):
        start, s = m.start(), m[0]
        # "0x" then hex alone is that hex (an EVM id, or one split at its zeros), never a base58 id
        # glued to anything. With anything else after it the x is the run's own: a key can begin
        # with one ("10x<key>", "CA0x<key>"), and dropping it hid such a key from every window.
        if s[0] == "x" and start > 0 and text[start - 1] == "0" and all(ch in _HEX for ch in s[1:]):
            continue
        end = start + len(s)
        standalone = (start == 0 or text[start - 1] not in _ALNUM) and (end == len(text) or text[end] not in _ALNUM)
        if standalone and len(s) <= 88:
            # Nothing alphanumeric either side: the run the default scan reads, read the same way.
            shape = _base58_shape(s)
        else:
            # Glued, or too long to be one id: the whole run counts only when it is neither hex alone nor filler.
            shape = _base58_shape(s) if len(s) <= 88 and any(ch not in _HEX for ch in s) and not _filler(s) else None
        found = shape or (_glued_shape(s, budget) if len(s) > 32 else None)
        if found:
            hits.append(OnchainIdHit("solana", "hash" if found == "hash" else "address", s))
    return hits


def onchain_ids_in(text: object, glued: bool = False) -> list[OnchainIdHit]:
    """
    Every on-chain id in a text, in ids.ts order: EVM ids, then Solana
    explorer links, then base58 runs that decode to a 32-byte key or a 64-byte
    signature. `glued` also finds ids written against neighbouring letters or
    digits (the module docstring).
    """
    if not isinstance(text, str) or not text:
        return []
    hits: list[OnchainIdHit] = []
    for m in _EVM_IN_TEXT.finditer(text):
        hits.append(OnchainIdHit("evm", "hash" if len(m[0]) == 66 else "address", m[0]))
    for m in _SOLANA_LINK.finditer(text):
        hits.append(OnchainIdHit("solana", "link", m[0]))
    if glued:
        return hits + _glued_hits(text)
    for m in _BASE58_IN_TEXT.finditer(text):
        s = m[0]
        b = base58_decode(s)
        if b is not None and len(b) == 32:
            hits.append(OnchainIdHit("solana", "address", s))
        elif b is not None and len(b) == 64:
            hits.append(OnchainIdHit("solana", "hash", s))
    return hits


def onchain_id_in(text: object, glued: bool = False) -> bool:
    """Whether a text carries any on-chain id (onchain_ids_in)."""
    return bool(onchain_ids_in(text, glued))
