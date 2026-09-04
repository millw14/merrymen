#!/usr/bin/env python3
"""Full-page height and stamp count for every tab of the running dev server.

    ./tools/height.py
    ./tools/height.py --url http://localhost:4173
"""

import argparse

from playwright.sync_api import sync_playwright

TABS = ["Home", "Feed", "Agent", "Board", "You"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:4173")
    ap.add_argument("--width", type=int, default=402)
    ap.add_argument("--height", type=int, default=874)
    ap.add_argument("--settle", type=int, default=1200)
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_context(
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=2,
        ).new_page()

        page.goto(args.url, wait_until="networkidle")
        page.wait_for_timeout(args.settle)

        for tab in TABS:
            page.get_by_role("button", name=tab, exact=True).click()
            page.wait_for_timeout(args.settle)
            height = page.evaluate("document.querySelector('.body').scrollHeight")
            tags = page.locator(".wire-tag").count()
            stamps = page.locator("i.tag").count()
            print(f"{tab}: {height}px  wire-tag={tags}  stamp={stamps}")

        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
