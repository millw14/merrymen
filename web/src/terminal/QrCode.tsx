import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * A QR CODE OF EXACTLY THE TEXT GIVEN, drawn as React SVG.
 *
 * The encoder (qrcode-generator, MIT, no dependencies) only decides which
 * modules are dark. This draws them as one path, so no generated markup is
 * injected with innerHTML.
 *
 * DARK ON LIGHT, ALWAYS. Ledger is cream on black, and a phone camera reading
 * inverted modules is a coin toss. So the code sits on its own cream tile, with
 * the four-module quiet zone the standard asks for. The colours are fixed
 * attributes, not tokens: a stylesheet that failed to load must not leave black
 * modules on a black page.
 *
 * Error correction M recovers up to 15% of damaged modules. An agent address
 * fits in a 29-module code at that level, which stays scannable at the sizes
 * the panel uses.
 */
export const QR_QUIET_ZONE = 4;

/** The module grid for `value`: true where a module is dark. */
export function qrModules(value: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, col) => qr.isDark(row, col)));
}

/** The dark modules as one SVG path in module units, offset by the quiet zone. */
export function qrPath(modules: boolean[][]): string {
  let d = "";
  modules.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) d += `M${c + QR_QUIET_ZONE} ${r + QR_QUIET_ZONE}h1v1h-1z`;
  }));
  return d;
}

export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const modules = useMemo(() => qrModules(value), [value]);
  const total = modules.length + QR_QUIET_ZONE * 2;
  return (
    <svg
      className="deposit-qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#ecead9" />
      <path d={qrPath(modules)} fill="#0a0a09" />
    </svg>
  );
}
