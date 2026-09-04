#!/usr/bin/env python3
"""Screenshot every tab of the running dev server.

    ./tools/shots.py out/before
    ./tools/shots.py out/after --url http://localhost:4173
"""

import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

TABS = ["Home", "Feed", "Agent", "Board", "You"]

# A full-page shot paints the fixed tab bar at its viewport offset, so it lands on
# top of whatever is mid-page. Absolute positioning does not help: .app is
# min-height:100dvh and .body owns the scroll, so bottom:0 still resolves to the
# viewport. Drop it instead; it is identical on every screen.
HIDE_NAV = ".tabbar { display: none !important; }"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir")
    ap.add_argument("--url", default="http://localhost:4173")
    ap.add_argument("--width", type=int, default=402)
    ap.add_argument("--height", type=int, default=874)
    ap.add_argument("--settle", type=int, default=1200)
    args = ap.parse_args()

    out = pathlib.Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=2,
        ).new_page()

        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(args.url, wait_until="networkidle")
        page.wait_for_timeout(args.settle)

        for i, tab in enumerate(TABS, start=1):
            page.get_by_role("button", name=tab, exact=True).click()
            page.wait_for_timeout(args.settle)
            path = out / f"{i}-{tab.lower()}.png"
            handle = page.add_style_tag(content=HIDE_NAV)
            page.screenshot(path=str(path), full_page=True)
            handle.evaluate("el => el.remove()")
            print(f"{path}")

        browser.close()

    for e in errors:
        print(f"console error: {e}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
