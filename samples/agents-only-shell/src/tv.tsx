import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, ChartKind, Seat } from "./bars";
import { coinPrice } from "./live";
import { Face } from "./ui";

export function TvChart({
  bars,
  seats,
  kind,
  down,
  onAgent,
}: {
  bars: Bar[];
  seats: Seat[];
  kind: ChartKind;
  down?: boolean;
  onAgent: (slug: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<
    ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null
  >(null);
  const [pins, setPins] = useState<
    { seat: Seat; x: number; y: number; z: number }[]
  >([]);
  const [ohlc, setOhlc] = useState<Bar | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; px: number } | null>(
    null,
  );

  useEffect(() => {
    const el = box.current;
    if (!el || bars.length === 0) return;

    const upInk = readColor(el, "--up", "#3dd68c");
    const downInk = readColor(el, "--down", "#ff5c71");
    const faint = readColor(el, "--faint", "#6e6e62");
    const ink = down ? downInk : upInk;

    const chart = createChart(el, {
      height: 220,
      layout: {
        background: { color: "transparent" },
        textColor: faint,
        fontFamily: getComputedStyle(el).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: faint, width: 1, style: 3, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
    });
    const series =
      kind === "line"
        ? chart.addSeries(LineSeries, {
            color: ink,
            lineWidth: 2,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: true,
          })
        : chart.addSeries(CandlestickSeries, {
            upColor: upInk,
            downColor: downInk,
            borderUpColor: upInk,
            borderDownColor: downInk,
            wickUpColor: upInk,
            wickDownColor: downInk,
            lastValueVisible: false,
            priceLineVisible: false,
          });
    if (kind === "line") {
      series.setData(
        bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })),
      );
    } else {
      series.setData(
        bars.map((b) => ({
          time: b.time as UTCTimestamp,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        })),
      );
    }
    chartRef.current = chart;
    seriesRef.current = series;

    const place = () => {
      const raw: { seat: Seat; x: number; y: number }[] = [];
      for (const seat of seats) {
        if (!seat.time) continue;
        const bar = barAt(bars, seat.time);
        if (!bar) continue;
        const px = kind === "line" ? bar.close : Math.max(bar.open, bar.close);
        const x = chart.timeScale().timeToCoordinate(bar.time as UTCTimestamp);
        const y = series.priceToCoordinate(px);
        if (x == null || y == null) continue;
        raw.push({ seat, x, y });
      }
      setPins(layerPins(raw));
      const last = bars[bars.length - 1];
      if (!last) {
        setTip(null);
        return;
      }
      const tx = chart.timeScale().timeToCoordinate(last.time as UTCTimestamp);
      const ty = series.priceToCoordinate(last.close);
      setTip(
        tx == null || ty == null ? null : { x: tx, y: ty, px: last.close },
      );
    };

    const fit = () => {
      const desktop = window.matchMedia("(min-width: 1100px)").matches;
      chart.applyOptions({
        width: el.clientWidth,
        layout: { fontSize: desktop ? 13 : 11 },
        height: el.clientHeight || 220,
        rightPriceScale: { visible: desktop },
        timeScale: {
          visible: desktop,
          timeVisible: true,
          secondsVisible: false,
        },
        grid: {
          vertLines: { visible: desktop, color: "#24261e66" },
          horzLines: { visible: desktop, color: "#24261e66" },
        },
      });
      chart.timeScale().fitContent();
      place();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();

    chart.timeScale().subscribeVisibleLogicalRangeChange(place);
    chart.subscribeCrosshairMove((param) => {
      if (kind === "line") {
        const d = param.seriesData.get(series) as
          { value?: number; time?: number } | undefined;
        if (d?.value != null && d.time != null) {
          setOhlc({
            time: Number(d.time),
            open: d.value,
            high: d.value,
            low: d.value,
            close: d.value,
          });
          return;
        }
        setOhlc(null);
        return;
      }
      const d = param.seriesData.get(series) as
        | {
            open?: number;
            high?: number;
            low?: number;
            close?: number;
            time?: number;
          }
        | undefined;
      if (
        d?.open != null &&
        d.high != null &&
        d.low != null &&
        d.close != null &&
        d.time != null
      ) {
        setOhlc({
          time: Number(d.time),
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        });
        return;
      }
      setOhlc(null);
    });

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [bars, seats, kind, down]);

  const readout = ohlc ?? bars.at(-1);
  return (
    <div className="tv">
      {readout && kind === "candle" && (
        <p className={`tv-ohlc ${ohlc ? "is-hovered" : ""}`}>
          <span>O {coinPrice(readout.open)}</span>
          <span>H {coinPrice(readout.high)}</span>
          <span>L {coinPrice(readout.low)}</span>
          <span>C {coinPrice(readout.close)}</span>
        </p>
      )}
      <div className="tv-box">
        <div ref={box} className="tv-canvas" />
        {tip && (
          <em
            className={down ? "tv-last down" : "tv-last up"}
            style={{ left: tip.x, top: tip.y }}
          >
            {coinPrice(tip.px)}
          </em>
        )}
        <div className="tv-pins">
          {pins.map(({ seat, x, y, z }) => (
            <button
              key={seat.slug}
              type="button"
              className="tv-pin"
              style={{ left: x, top: y, zIndex: z }}
              aria-label={`${seat.name} entered at ${coinPrice(seat.price)}`}
              onClick={() => onAgent(seat.slug)}
            >
              <Face name={seat.name} slug={seat.slug} pin />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function barAt(bars: Bar[], time: number): Bar | undefined {
  let best = bars[0];
  if (!best) return undefined;
  let dist = Math.abs(best.time - time);
  for (const b of bars) {
    const d = Math.abs(b.time - time);
    if (d < dist) {
      best = b;
      dist = d;
    }
  }
  return best;
}

function layerPins(
  raw: { seat: Seat; x: number; y: number }[],
): { seat: Seat; x: number; y: number; z: number }[] {
  const ordered = [...raw].sort((a, b) => a.x - b.x || a.y - b.y);
  const out: { seat: Seat; x: number; y: number; z: number }[] = [];
  for (const p of ordered) {
    const stack = ordered
      .slice(0, out.length)
      .filter((q) => Math.hypot(q.x - p.x, q.y - p.y) < 24).length;
    out.push({
      seat: p.seat,
      x: Math.max(12, p.x - stack * 18),
      y: Math.max(12, p.y - stack * 9),
      z: stack + 1,
    });
  }
  return out;
}

function readColor(el: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}
