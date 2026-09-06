"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * ONE PANEL FAILING MUST NOT TAKE THE PRODUCT WITH IT.
 *
 * The terminal mounts every screen in a single tree — `App.tsx` imports all
 * eleven statically, with no `lazy` and no `Suspense` anywhere — and the chart
 * is a third-party renderer driven from an effect with no `try`. So a throw
 * from `createChart`, `addSeries` or `setData` propagates out of that effect
 * and React unmounts the whole app: the market list, the portfolio, the
 * balance, the funding controls, all of it, because one canvas could not draw.
 *
 * `components/CandleChart.tsx` learned this and wrapped its own loader —
 * "A chart that will not load must not take the page with it — the theses
 * beneath are the point of this product." The terminal replaced that component
 * and did not carry the lesson across, and it removed the dynamic import that
 * used to isolate the failure as well.
 *
 * A class component because that is the only thing React gives us: hooks cannot
 * catch a render error.
 */
export class Boundary extends Component<
  { children: ReactNode; label: string; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The message and the component stack, and nothing else. This runs in a
    // reader's browser: no props, no state, no account data.
    // eslint-disable-next-line no-console
    console.error(`[${this.props.label}] failed to render`, error.message, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      this.props.fallback ?? (
        <p className="meta" role="status">
          This part of the page could not be drawn. Everything else on it still stands.
        </p>
      )
    );
  }
}
