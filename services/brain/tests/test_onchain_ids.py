"""
BASE58 IN THE BACKSTOP: a Solana id is refused wherever an 0x one is.

Three groups. The detector gives the same answers as packages/core/src/ids.ts,
case for case and in both scans, from a fixture both languages read.
`_reject_executable` refuses a Solana key, signature or explorer link in every
field it already screened, model output and desk-policy input alike, and with
the glued scan (audit regressions F3) one written against the text around it.
And everything it accepted before that carries no Solana id is accepted still,
with every EVM refusal in its old words.

No model is called and nothing leaves the process.
"""

from __future__ import annotations

import contextlib
import json
import signal
import time
from pathlib import Path

import pytest
from pydantic import ValidationError

from brain.onchain_ids import GLUED_DECODES, base58_decode, onchain_id_in, onchain_ids_in
from brain.schemas import BrainDecision, Cost, DeskAnalysis, Evidence

from test_prompt_snapshot import pulse_memecoin

CASES = json.loads((Path(__file__).resolve().parent / "data" / "onchain_ids.json").read_text(encoding="utf-8"))["cases"]

MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH"
SYSTEM_PROGRAM = "1" * 32
SIG = "3NGW7mkqWR84fuKhxiUmVTJg8AehpcEQHKZcivruB5449akQiFvm2Ej6AvJGLnfwW15Cb2wn1D6UAFMJtXh6tigd"
#: The 64-byte keypair of the all-0x05 test seed: a secret key is a signature's length.
KEYPAIR = "6pc4LiB8KHAPvbUbkozrTcPL5zXspYBdATv5raNDyVbpoz75fGXT3N41QtwPtrdu4wMT1tyRu2125Uyu92AnxEC"
#: A real ed25519 public key with no digits (ids.test.ts pins its test seed).
LETTERS_32 = "EEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT"
LETTERS_64 = "A" * 87
#: A 32-byte key whose first character is x.
X_KEY = "xD8ndgHckqX4TKpPgeRJ8o8Mmp8qE4bZ9USpRzQN4Uj"


# ── the detector ───────────────────────────────────────────────────────────


def test_the_shared_cases_are_there():
    # An empty list would parametrize into one skip, and a skip is green.
    assert len(CASES) >= 20


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["text"][:40] or "empty")
def test_the_detector_answers_as_ids_ts_does(case):
    got = [h._asdict() for h in onchain_ids_in(case["text"])]
    assert got == case["hits"]
    assert onchain_id_in(case["text"]) is bool(case["hits"])


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["text"][:40] or "empty")
def test_the_glued_scan_answers_as_ids_ts_does(case):
    want = case.get("glued", case["hits"])
    got = [h._asdict() for h in onchain_ids_in(case["text"], glued=True)]
    assert got == want
    assert onchain_id_in(case["text"], glued=True) is bool(want)
    # The glued scan finds everything the default finds.
    for hit in case["hits"]:
        assert hit in got


def test_the_fixture_pins_glued_ids_the_default_misses():
    # An empty list would leave the glued scan pinned only where it agrees.
    glued_only = [c for c in CASES if "glued" in c and c["glued"] and not c["hits"]]
    assert len(glued_only) >= 8


def _base58_encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + out


def _cpu_ms(scan) -> float:
    """CPU time this process spent on one scan, in milliseconds: what others take from it under load is not counted."""
    started = time.process_time()
    scan()
    return (time.process_time() - started) * 1000


#: CPU seconds the linear test may spend before it fails by name; it spends about 2 (review GE, round 2).
RUNAWAY_CPU_SECONDS = 60


@contextlib.contextmanager
def _cpu_limited(cpu_seconds: int, what: str):
    """A scan that never returns fails the test by name, instead of hanging the job.

    pytest sets no timeout of its own and CI installs no pytest-timeout, so a runaway scan
    hung the brain job until the job's own timeout and named no test. ITIMER_PROF counts this
    process's CPU time, user and system, never what a loaded machine takes from it, so a slow
    runner does not fail it. Its SIGPROF handler raises in the main thread between bytecodes,
    which a pure-Python scan always reaches. Without interval timers (Windows) it only runs.
    As a decorator (contextlib's context managers are ones), it covers the whole test.
    """
    if not hasattr(signal, "setitimer"):
        yield
        return

    def stop(signum, frame):
        pytest.fail(f"{what} did not finish within {cpu_seconds} s of CPU time")

    previous = signal.signal(signal.SIGPROF, stop)
    signal.setitimer(signal.ITIMER_PROF, cpu_seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_PROF, 0)
        signal.signal(signal.SIGPROF, previous)


@_cpu_limited(RUNAWAY_CPU_SECONDS, "the glued scan's linear test")
def test_the_glued_scan_is_linear_and_fails_closed_past_its_budget():
    # ids.test.ts builds the same runs, 30,000 and 12,000 of them, for its megabyte; Brain scans a
    # quarter of each, which still spends the decode budget many times over, so its suite stays
    # seconds long. Runs that hold no 43- or 44-character key window (short of one, or hex alone),
    # and runs that hold a signature.
    def no_key_run(i: int) -> str:
        return ("1" + "z" * (31 + i % 10)) if i % 3 else "abcdef12345" * 9

    def key_like_run(i: int) -> str:
        return _base58_encode(bytes((i * 7 + j * 13 + 1) % 256 for j in range(64))) + f"x{i}"

    texts = {}
    for name, run, count in (("no key", no_key_run, 7_500), ("key-like", key_like_run, 3_000)):
        texts[name] = [run(i) for i in range(count)]
    no_key, key_like = (" ".join(texts[name]) for name in ("no key", "key-like"))
    assert len(no_key) > 250_000 and len(key_like) > 250_000
    assert onchain_ids_in(no_key[:5_000], glued=True) == [], "none of these runs holds an id"
    assert onchain_ids_in(no_key, glued=True), "past the decode budget, the remaining runs are refused unread"
    assert onchain_id_in(key_like, glued=True)
    assert GLUED_DECODES == 4096

    # BOUNDED TIME, AGAINST THIS MACHINE IN THIS RUN, never a wall clock, as ids.test.ts measures
    # it: a fixed budget, or a wall-clock ratio against a scan a few milliseconds long, fails on a
    # loaded runner. Every figure is CPU time (time.process_time), each compared figure covers the
    # same characters, and they are taken in alternation, best of three.
    # - Linear: the text scanned whole costs at most 4 times the same runs scanned as 16 chunks
    #   (measured 0.5-1.0x: the whole text spends one decode budget, the chunks one each). A scan
    #   whose work for each run grows with the text before it costs up to 16 times as much whole
    #   once that work outweighs its own: a mutant counting every 32nd position before each run
    #   measured 5.6x and fails; a C-speed copy of the text before each run is too cheap at this
    #   size (about 3x) and passes. So the bound catches a superlinear scan once its extra work
    #   here is about 4 to 8 times a linear scan's (whole measures 0.5-1.0x split, the bound is 4x
    #   split). An exponential scan never returns, and fails by the CPU limit on this test.
    # - Within 100x of the default scan over the same text, which decodes every standalone run with
    #   no budget (measured 5-18x).
    for name, big in (("no key", no_key), ("key-like", key_like)):
        runs = texts[name]
        per = -(-len(runs) // 16)
        chunks = [" ".join(runs[k * per:(k + 1) * per]) for k in range(16)]
        assert " ".join(chunks) == big, "the chunks hold exactly the text's runs"
        whole = split = by_default = float("inf")
        for _ in range(3):
            whole = min(whole, _cpu_ms(lambda: onchain_ids_in(big, glued=True)))
            split = min(split, _cpu_ms(lambda: [onchain_ids_in(chunk, glued=True) for chunk in chunks]))
            by_default = min(by_default, _cpu_ms(lambda: onchain_ids_in(big)))
        took = f"{name}, CPU time over {len(big)} characters: {whole:.1f} ms whole, {split:.1f} ms in 16 chunks, default scan {by_default:.1f} ms"
        assert whole < 4 * split, f"not linear in the text: {took}"
        assert whole < 100 * by_default, f"far slower than the default scan: {took}"


def test_base58_decodes_lengths_and_leading_zeros():
    assert base58_decode(SYSTEM_PROGRAM) == bytes(32)
    assert len(base58_decode(MINT)) == 32
    assert len(base58_decode(SIG)) == 64 and len(base58_decode(KEYPAIR)) == 64
    assert base58_decode("1") == b"\x00" and base58_decode("2") == b"\x01" and base58_decode("21") == b"\x3a"
    assert len(base58_decode(LETTERS_32)) == 32 and len(base58_decode(LETTERS_64)) == 64
    assert len(base58_decode(X_KEY)) == 32


@pytest.mark.parametrize("s", ["0abc", "Oabc", "Iabc", "labc", "", "a b", "z" * 129])
def test_base58_refuses_what_is_not_base58(s):
    assert base58_decode(s) is None


def test_anything_but_text_is_no_hit():
    assert onchain_ids_in(None) == [] and onchain_ids_in(42) == [] and onchain_ids_in(["x"]) == []


# ── the backstop ───────────────────────────────────────────────────────────


def _decision(**over) -> dict:
    base = dict(
        decision_id="dec_1", agent_id="agent-a", created_at=1, action="hold", instrument_id="merrymen:meme",
        symbol="MEME", confidence=0.5, suggested_delta_usdg=0, thesis="Buys are thinning into strength.",
        tier="pulse", cost=Cost(model_calls=0, tokens_in=0, tokens_out=0, usd=0.0),
    )
    return {**base, **over}


SOLANA_POISON = [
    (f"the mint {MINT} just migrated", "Solana address-shaped"),
    (f"sig {SIG} landed", "Solana signature- or key-shaped"),
    (f"exported {KEYPAIR}", "Solana signature- or key-shaped"),
    (f"owned by {SYSTEM_PROGRAM}", "Solana address-shaped"),
    ("see solscan.io/token/ for the chart", "Solana explorer link"),
    (f"owned by {LETTERS_32}", "Solana address-shaped"),
    (f"signature {LETTERS_64}", "Solana signature- or key-shaped"),
    # Glued to the text around them (audit regressions F3).
    (f"grab it CA{MINT} now", "Solana address-shaped"),
    (f"{MINT}is the one", "Solana address-shaped"),
    (f"0{MINT} and {MINT}l", "Solana address-shaped"),
    (f"tx{SIG}done", "Solana signature- or key-shaped"),
    (f"key:0x{KEYPAIR}", "Solana signature- or key-shaped"),
    # A key that begins with an x, written after a 0 (review GE): its x is no 0x prefix.
    (f"price 10{X_KEY} today", "Solana address-shaped"),
]


@pytest.mark.parametrize("text,why", SOLANA_POISON)
@pytest.mark.parametrize("field", ["instrument_id", "symbol", "thesis", "bull_case", "bear_case", "time_horizon"])
def test_a_decision_carrying_a_solana_id_is_refused(field, text, why):
    with pytest.raises(ValidationError, match=why) as e:
        BrainDecision(**_decision(**{field: text}))
    msg = e.value.errors()[0]["msg"]
    for word in text.split():
        assert len(word) < 32 or word not in msg, "the message names the shape, never the id"


@pytest.mark.parametrize("text,why", SOLANA_POISON)
def test_lists_and_evidence_are_screened_too(text, why):
    for field in ("risks", "invalidation"):
        with pytest.raises(ValidationError, match=why):
            BrainDecision(**_decision(**{field: ["fine", text]}))
    for field in ("source", "ref", "claim"):
        with pytest.raises(ValidationError, match=why):
            Evidence(**dict({"source": "s", "ref": "r", "claim": "c"}, **{field: text}))


@pytest.mark.parametrize("text,why", SOLANA_POISON)
def test_a_desk_read_carrying_a_solana_id_is_refused(text, why):
    good = dict(
        read="price is holding above the 0.0041 level after a 12% push, but volume has faded.",
        stance="cautious", watch="whether 0.0041 holds", invalidation="an hourly close under 0.0036",
        confidence=0.6,
    )
    DeskAnalysis(**good)
    for field in ("read", "watch", "invalidation"):
        with pytest.raises(ValidationError):
            DeskAnalysis(**dict(good, **{field: good[field] + " " + text}))


def test_the_desk_policy_cannot_carry_a_solana_id():
    with pytest.raises(ValidationError, match="Solana address-shaped"):
        pulse_memecoin(strategy_terms=f"Route via {MINT}.")
    with pytest.raises(ValidationError, match="Solana signature"):
        pulse_memecoin(strategy_terms=f"Replay {SIG}.")
    # 32 ones is a phrase by the horizon's alphabet and a key by its shape.
    with pytest.raises(ValidationError, match="Solana address-shaped"):
        pulse_memecoin(horizon=SYSTEM_PROGRAM)
    with pytest.raises(ValidationError, match="Solana address-shaped"):
        pulse_memecoin(strategy_terms=f"Route via {LETTERS_32}.")
    with pytest.raises(ValidationError, match="Solana signature"):
        pulse_memecoin(strategy_terms=f"Replay {LETTERS_64}.")
    with pytest.raises(ValidationError, match="Solana address-shaped"):
        pulse_memecoin(strategy_terms=f"Route via CA{MINT}.")
    with pytest.raises(ValidationError, match="Solana signature"):
        pulse_memecoin(strategy_terms=f"Replay tx{SIG}.")


# ── what stays as it was ───────────────────────────────────────────────────


@pytest.mark.parametrize("text", [
    "PEPE pumped 40% on the week; 41 buys / 22 sells from 37 distinct buyers.",
    "Held MEME for 20 minutes; exited flat after volume faded.",
    "[ref:d3fa91cr2c1] reports two tracked wallets added",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "supercalifragilisticexpialidociousandmorewordsjoined",
    # Hex split at its zeros, and long numbers standing alone, are never an id glued to anything.
    "6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa",
    "02D20BBD7E394AD5999A4CEBABAC9619732C343A4CAC99470C03E23BA2BDC2BC",
    "supply 63971511409728546707420640415976470808777281049430980144558505433936508649475518010444363585908687133263558897911835323323191563463575735092780586118530448",
    "$SOL $BONK $WIF $JUP and $USDG, #BuyTheDipAndHoldForeverBecauseSolanaIsTheFuture",
    "read https://x.com/merrymen/status/1845123456789012345 and 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
])
def test_prose_and_todays_ids_still_pass(text):
    d = BrainDecision(**_decision(thesis=text, risks=[text], evidence=[Evidence(source="s", ref=text, claim=text)]))
    assert d.thesis == text
    assert pulse_memecoin(strategy_terms=text).strategy_terms == text


@pytest.mark.parametrize("text,why", [
    ("route via 0x" + "ab" * 20, "contains an address-shaped string"),
    ("calldata 0xdeadbeefcafebabe00", "contains a hex blob that could be calldata"),
    # An EVM refusal keeps its words even beside a Solana id.
    (f"0x{'ab' * 20} and {MINT}", "contains an address-shaped string"),
])
def test_every_evm_refusal_keeps_its_words(text, why):
    with pytest.raises(ValidationError) as e:
        BrainDecision(**_decision(thesis=text))
    msg = e.value.errors()[0]["msg"]
    assert msg.startswith(f"Value error, field {why}"), msg
    assert "Solana" not in msg
