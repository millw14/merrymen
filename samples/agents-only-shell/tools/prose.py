#!/usr/bin/env python3
"""Measure how much each screen explains itself in sentences.

Home carries no app-written prose: a row is a logo, a ticker, faces and a
percentage, and the structure says the rest. Screens that reach for a sentence
instead show up here. Reads the rendered DOM, because the sentences are
composed at runtime and are invisible to a source scan.

Agent-authored copy is content, not narration, so it is counted separately.

    ./tools/prose.py
    ./tools/prose.py --words 6 --url http://localhost:4173
"""

import argparse
import re

from playwright.sync_api import sync_playwright

TABS = ["Home", "Feed", "Agent", "Board", "You"]

# Agent-authored reasoning renders inside these; it is content and is reported
# apart from narration rather than counted against the screen.
SAID = ".wire-why, .wire-said, .wire-voice, .thesis-body, .hero-said, .said, .bubble p, .note p"

# A sentence is often assembled from several spans, so measure whole leaf blocks
# rather than text nodes. Counting nodes hid five composed sentences on Board.
BLOCK = "p, li, h1, h2, h3, h4, h5, h6, button, div, section, header, article, label"

EXTRACT = """
([saidSel, blockSel]) => {
  const out = [];
  for (const el of document.querySelectorAll(blockSel)) {
    if (el.querySelector(blockSel)) continue;
    if (el.closest('svg, script, style, nav.tabbar')) continue;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    out.push({
      text: t,
      words: t.split(' ').filter(Boolean).length,
      said: Boolean(el.closest(saidSel)),
    });
  }
  return out;
}
"""


# "nightjar, ledgerrat, whisper" is a data row; "flint is 30.9 points ahead." is a
# sentence. Sentence punctuation separates them, and a decimal point does not
# count because it is never followed by a space.
SENTENCE = re.compile(r"\.(\s|$)")


def is_sentence(text: str, floor: int) -> bool:
    return len(text.split()) > floor and bool(SENTENCE.search(text))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:4173")
    ap.add_argument("--words", type=int, default=5)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    rows = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport={"width": 402, "height": 874}).new_page()
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_timeout(1200)
        for tab in TABS:
            page.get_by_role("button", name=tab, exact=True).click()
            page.wait_for_timeout(1000)
            nodes = page.evaluate(EXTRACT, [SAID, BLOCK])
            rows.append((tab, nodes))
        b.close()

    print(f"{'screen':<8}{'sentences':>11}{'prose words':>13}{'agent words':>13}")
    worst = []
    for tab, nodes in rows:
        narration = [n for n in nodes if not n["said"]]
        longs = [n for n in narration if is_sentence(n["text"], args.words)]
        prose_words = sum(n["words"] for n in longs)
        said_words = sum(n["words"] for n in nodes if n["said"])
        print(f"{tab:<8}{len(longs):>11}{prose_words:>13}{said_words:>13}")
        worst.extend((tab, n["words"], n["text"]) for n in longs)

    if not args.quiet and worst:
        print(f"\nsentences over {args.words} words, longest first")
        for tab, w, text in sorted(worst, key=lambda r: -r[1]):
            print(f"  {tab:<6} {w:>3}w  {text}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
