"use client";

import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/read-candles";
import { usdFixed, subCentUsd } from "@/lib/format";

/**
 * THE PRICE CHART, drawn by TradingView's lightweight-charts.
 *
 * The one place in this product where a third-party renderer earns its bytes.
 * Every other chart here is server-rendered SVG, and that is right for a
 * sparkline or an oracle series — but a candle chart is a crosshair, a
 * scrollable time axis, a price scale that re-fits as you pan, and a tooltip
 * that follows the pointer. Hand-rolling those is a month of work to arrive
 * where a 60kB library already is. (Measured from the installed tarball:
 * 60,575 bytes gzipped, 189,213 raw. The first draft of this comment said 45kB
 * from memory, in a codebase that pins its figures.)
 *
 * IT IS LOADED ONLY WHEN A CHART ACTUALLY DRAWS. The import is dynamic and
 * inside an effect, so a token page with no candles — every stock token, every
 * coin the index has never returned — ships none of it.
 *
 * IT IS NOT SERVER-RENDERED, which is the cost. The bars arrive with the HTML
 * and the canvas paints on hydration, so this reserves its own height up front:
 * a chart that pushes the theses down when it appears is the layout shift the
 * rest of the redesign has been removing.
 */

/** Colours come from the design system, read off the element at mount. */
function tokenColour(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** Beyond this many empty slots the series is cut rather than padded. */
const MAX_WHITESPACE = 500;

/**
 * Bars, plus an empty entry for every slot that has none.
 *
 * THE LARGEST HONESTY DEFECT IN THE FIRST VERSION. lightweight-charts places
 * bars at CONSECUTIVE time-scale slots, so it does not matter that our
 * timestamps are hours apart — handed the bars alone, a 63-hour hole renders
 * as zero horizontal distance and the chart draws straight across it.
 * Measured on one real pool: 421 bars over 792 hours, 47% of the range
 * missing, in 43 runs, the longest 63 hours.
 *
 * That is precisely what this product refuses elsewhere and says so —
 * PriceLine's caption reads 'the hours the feed published nothing are left
 * out rather than drawn across, which is what the breaks are'. Whitespace
 * entries are the library's own mechanism for exactly this.
 *
 * It happens here rather than in the reader on purpose: the read returns
 * facts, the renderer decides spacing.
 */
function withGaps(candles: Candle[], interval: number) {
  const out: { time: number; open?: number; high?: number; low?: number; close?: number }[] = [];
  let padded = 0;
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i]!;
    const prev = candles[i - 1];
    if (prev && interval > 0) {
      for (let t = prev.t + interval; t < k.t && padded < MAX_WHITESPACE; t += interval) {
        out.push({ time: t });
        padded++;
      }
    }
    out.push({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c });
  }
  return { data: out, truncated: padded >= MAX_WHITESPACE };
}

export function CandleChart({
  candles,
  interval,
  height = 320,
}: {
  candles: Candle[];
  /** Seconds per bar, so the holes can be found and left as holes. */
  interval: number;
  height?: number;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || candles.length === 0) return;

    let disposed = false;
    // Kept out of the closure's type so the dynamic import stays the only
    // reference to the library.
    let chart: { remove: () => void; applyOptions: (o: unknown) => void } | null = null;

    void (async () => {
      try {
        const lib = await import("lightweight-charts");
        if (disposed || !box.current) return;

        const up = tokenColour(el, "--mm-up", "#34d399");
        const down = tokenColour(el, "--mm-down", "#fb7185");
        const grid = tokenColour(el, "--mm-edge", "#232729");
        const text = tokenColour(el, "--mm-faint", "#757068");

        const c = lib.createChart(el, {
          height,
          layout: {
            // The page's own ground, not the library's white default.
            background: { color: "transparent" },
            textColor: text,
            fontFamily: getComputedStyle(el).fontFamily,
            fontSize: 10,
            // KEPT. The library's licence asks for a link to TradingView
            // reachable by users, and names this option as the way to give
            // it; turning it off left nothing but a source comment nobody
            // sees. It is also the exact mark in the reference screenshot.
            attributionLogo: true,
          },
          grid: {
            vertLines: { color: grid },
            horzLines: { color: grid },
          },
          rightPriceScale: { borderColor: grid },
          timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
          crosshair: { mode: lib.CrosshairMode.Normal },
          handleScale: { axisPressedMouseMove: false },
          localization: {
            // A coin here can trade at 2.8e-6, and the library's default
            // formatter renders that as $0.00 — the same failure as showing a
            // null as zero, a real number displayed as nothing.
            //
            // The first clause is the other half of that. The scale computes
            // gridlines by arithmetic, so its bottom line lands on a floating
            // point crumb like -1.73e-18, and toPrecision printed it verbatim.
            // Anything below a hundredth of a cent on this axis is zero.
            priceFormatter: (p: number) => {
              if (!Number.isFinite(p) || Math.abs(p) < 1e-12) return "$0";
              if (p < 0) return "";
              if (p >= 1) return usdFixed(p, 2);
              if (p >= 0.01) return usdFixed(p, 4);
              return subCentUsd(p);
            },
          },
        });
        chart = c as unknown as typeof chart;

        const series = c.addSeries(lib.CandlestickSeries, {
          upColor: up,
          downColor: down,
          borderUpColor: up,
          borderDownColor: down,
          wickUpColor: up,
          wickDownColor: down,
          priceFormat: { type: "price", precision: 8, minMove: 1e-8 },
        });
        series.setData(withGaps(candles, interval).data as never[]);

        // WIDTH BEFORE FIT, and fit again on every resize. Fitting first packed
        // three hundred bars into the right-hand sixth of the chart: the
        // container had not been measured when the chart was created, so the
        // time scale was fitted to a width that was about to change.
        const fit = () => {
          if (disposed || !box.current) return;
          c.applyOptions({ width: box.current.clientWidth });
          c.timeScale().fitContent();
        };
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        fit();

        return () => ro.disconnect();
      } catch {
        // A chart that will not load must not take the page with it — the
        // theses beneath are the point of this product.
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      try {
        chart?.remove();
      } catch {
        /* already gone */
      }
    };
  }, [candles, interval, height]);

  if (failed) {
    return <p className="mm-note">The chart could not be drawn. The figures above still stand.</p>;
  }

  // The height is reserved before anything paints, so the reasoning below never
  // gets pushed down on hydration.
  //
  // NOT aria-hidden. It was, which gave assistive technology nothing at all —
  // a regression against PriceLine, which summarises its own series. A canvas
  // is opaque to a screen reader either way; the label is the only thing that
  // is not.
  const first = candles[0];
  const last = candles[candles.length - 1];
  const lo = Math.min(...candles.map((k) => k.l));
  const hi = Math.max(...candles.map((k) => k.h));
  const money = (n: number) =>
    n >= 0.01 ? usdFixed(n, 4) : subCentUsd(n);

  return (
    <div
      className="mm-candles"
      ref={box}
      style={{ height }}
      role="img"
      aria-label={
        first && last
          ? `${candles.length} price bars, opening at ${money(first.o)} and closing at ${money(
              last.c,
            )}, ranging ${money(lo)} to ${money(hi)}.`
          : "Price chart"
      }
    />
  );
}
