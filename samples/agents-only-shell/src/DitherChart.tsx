import { Face } from "./ui";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  backingSize,
  paintColumn,
  resample,
} from "./vendor/dither-kit/dither-paint";
import { seedOfColor } from "./vendor/dither-kit/palette";
import { pctPts } from "./live";
import "./dither-chart.css";

export type ChartRider = { name: string; slug: string | null; index: number };

export type ChartPoint = { value: number; label: string };

/** The official Dither Kit painter, with native pointer and keyboard controls. */
export function DitherChart({
  points,
  label,
  format,
  height = 180,
  className = "",
  riders = [],
  onRider,
}: {
  points: ChartPoint[];
  label: string;
  format: (value: number) => string;
  height?: number;
  className?: string;
  riders?: ChartRider[];
  onRider?: (slug: string) => void;
}) {
  const data = useMemo(
    () => points.filter((p) => Number.isFinite(p.value)),
    [points],
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const down = data.length > 1 && data[data.length - 1]!.value < data[0]!.value;
  const min = Math.min(...data.map((p) => p.value));
  const max = Math.max(...data.map((p) => p.value));
  const range = max - min || Math.max(Math.abs(min) * 0.01, 1);
  const low = min - range * 0.12;
  const high = max + range * 0.18;
  const active = selected === null ? null : Math.min(selected, data.length - 1);
  const point = active === null ? null : data[active];

  useEffect(() => {
    const el = canvas.current;
    if (!el || data.length < 2) return;
    const draw = () => {
      const { cols, rows } = backingSize(el.clientWidth, el.clientHeight);
      el.width = cols;
      el.height = rows;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const ys = resample(
        data.map((p) => (high - p.value) / (high - low)),
        cols,
      );
      const seed = seedOfColor(down ? "red" : "green");
      for (let x = 0; x < cols; x++) {
        paintColumn(ctx, x, ys[x]! * (rows - 1), rows, seed, {
          variant: "gradient",
          intensity: 0,
          dim: 1,
          stacked: false,
        });
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    return () => observer.disconnect();
  }, [data, down, high, low]);

  if (data.length < 2)
    return (
      <p className="dither-empty">Performance history isn’t available yet.</p>
    );
  const last = data[data.length - 1]!;
  const current = point ?? last;
  const x = active === null ? 100 : (active / (data.length - 1)) * 100;
  const y = point ? ((high - point.value) / (high - low)) * 100 : 0;
  return (
    <figure
      className={`dither-figure ${down ? "is-down" : "is-up"} ${className}`}
      style={{ "--chart-height": `${height}px` } as CSSProperties}
    >
      <figcaption className="dither-caption">
        <span>{label}</span>
        <span>{format(last.value)}</span>
      </figcaption>
      <div className="dither-stage">
        <div
          className="dither-plot"
          role="slider"
          tabIndex={0}
          aria-label={`${label}. Use arrow keys to explore history`}
          aria-valuemin={0}
          aria-valuemax={data.length - 1}
          aria-valuenow={active ?? data.length - 1}
          aria-valuetext={`${current.label}: ${format(current.value)}`}
          onFocus={() => setSelected((current) => current ?? data.length - 1)}
          onBlur={() => setSelected(null)}
          onKeyDown={(e) => {
            if (
              !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(
                e.key,
              )
            )
              return;
            e.preventDefault();
            if (e.key === "Escape") setSelected(null);
            else
              setSelected(
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? data.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          data.length - 1,
                          (active ?? data.length - 1) +
                            (e.key === "ArrowLeft" ? -1 : 1),
                        ),
                      ),
              );
          }}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setSelected(
              Math.max(
                0,
                Math.min(
                  data.length - 1,
                  Math.round(
                    ((e.clientX - rect.left) / rect.width) * (data.length - 1),
                  ),
                ),
              ),
            );
          }}
          onPointerDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setSelected(
              Math.max(
                0,
                Math.min(
                  data.length - 1,
                  Math.round(
                    ((e.clientX - rect.left) / rect.width) * (data.length - 1),
                  ),
                ),
              ),
            );
          }}
          onPointerLeave={() => setSelected(null)}
        >
          <canvas ref={canvas} aria-hidden="true" />
          {point && (
            <div
              className="dither-crosshair"
              style={{ left: `${x}%` }}
              aria-hidden="true"
            >
              <i style={{ top: `${y}%` }} />
            </div>
          )}
          {point && (
            <div
              className="dither-tooltip"
              style={{ left: `clamp(76px, ${x}%, calc(100% - 76px))` }}
              aria-hidden="true"
            >
              <strong>{format(point.value)}</strong>
              <span>{point.label}</span>
            </div>
          )}
        </div>
        <div className="dither-riders">
          {riders.map((rider, i) => {
            const index = Math.max(0, Math.min(data.length - 1, rider.index));
            const stack = riders
              .slice(0, i)
              .filter(
                (other) =>
                  Math.abs(other.index - index) / (data.length - 1) < 0.06,
              ).length;
            const position = {
              transform: `translate(-50%, calc(-100% - ${stack * 20}px))`,
              left: `clamp(14px, ${(index / (data.length - 1)) * 100}%, calc(100% - 14px))`,
              top: `${((high - data[index]!.value) / (high - low)) * 100}%`,
              zIndex: i + 1,
            };
            return onRider && rider.slug ? (
              <button
                type="button"
                className="dither-rider"
                key={rider.slug}
                style={position}
                aria-label={`View ${rider.name}`}
                onClick={() => onRider(rider.slug!)}
              >
                <Face name={rider.name} slug={rider.slug} small />
              </button>
            ) : (
              <span
                className="dither-rider"
                key={rider.slug ?? rider.name}
                style={position}
                title={rider.name}
              >
                <Face name={rider.name} slug={rider.slug} small />
              </span>
            );
          })}
        </div>
      </div>
      <div className="dither-axis" aria-hidden="true">
        <span>{data[0]!.label}</span>
        <span>{last.label}</span>
      </div>
    </figure>
  );
}

export function PerformanceChart({
  values,
  height = 68,
}: {
  values: number[];
  height?: number;
}) {
  const points = useMemo(() => {
    const clean = values.filter(Number.isFinite);
    const first = clean[0];
    if (!first || first <= 0) return [];
    return clean.map((value, i) => ({
      value: (value / first - 1) * 100,
      label:
        i === 0
          ? "Start of history"
          : i === clean.length - 1
            ? "Latest"
            : `Observation ${i + 1}`,
    }));
  }, [values]);
  return (
    <DitherChart
      points={points}
      label="All-time performance"
      className="performance-chart"
      format={pctPts}
      height={height}
    />
  );
}
