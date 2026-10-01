import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type CardState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "image"; url: string };

/** Kept in memory, never cached or stored alongside the wallet. */
export function PnlCardDialog({ tradeId, symbol, onClose }: {
  tradeId: number;
  symbol: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const noteId = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CardState>({ kind: "loading" });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    let objectUrl: string | undefined;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    setState({ kind: "loading" });
    setLoaded(false);
    void (async () => {
      try {
        const response = await fetch(`/api/pnl?trade=${tradeId}`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(response.status === 401 || response.status === 403 || response.status === 404
            ? "This trade is no longer available in this account. Close this window and refresh your trades."
            : response.status === 409
              ? "A verified P&L image is not available for this trade."
              : "The image could not be generated. Please try again.");
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "image/png") {
          throw new Error("The image could not be loaded. Please try again.");
        }
        const blob = await response.blob();
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: "image", url: objectUrl });
      } catch (error) {
        if (disposed) return;
        setState({ kind: "error", message: timedOut
          ? "The image took too long to load. Please try again."
          : error instanceof Error && error.name !== "TypeError" ? error.message : "The image could not be loaded. Check your connection and try again." });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [tradeId, attempt]);

  const filename = `${symbol.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "trade"}-${tradeId}-pnl.png`;
  return createPortal(
    <div className="terminal-host pnl-card-layer">
      <dialog ref={dialog} className="pnl-card-dialog" aria-labelledby={titleId} aria-describedby={noteId}
        onCancel={(event) => { event.preventDefault(); onClose(); }}>
        <header className="pnl-card-toolbar">
          <h2 id={titleId}>{symbol} P&amp;L image</h2>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <p id={noteId} className="pnl-card-note">Realized P&amp;L for this sell, in USDG. A partial sell shows only the portion sold.</p>
        {state.kind === "loading" && <p className="pnl-card-status" role="status">Creating your image…</p>}
        {state.kind === "error" && <div className="pnl-card-status" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>}
        {state.kind === "image" && <>
          {/* The renderer returns authenticated PNG bytes, not a public image URL. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="pnl-card-image" src={state.url} width={1280} height={853}
            alt={`${symbol} realized profit and loss card, with invested amount, sale proceeds and P&L in USDG`}
            onLoad={() => setLoaded(true)}
            onError={() => setState({ kind: "error", message: "The image could not be displayed. Please try again." })} />
          <div className="pnl-card-actions">
            {loaded ? <a href={state.url} download={filename}>Download PNG</a> : <span role="status">Loading preview…</span>}
            <button type="button" disabled={!loaded} onClick={() => window.print()}>Print</button>
          </div>
        </>}
      </dialog>
    </div>, document.body,
  );
}
