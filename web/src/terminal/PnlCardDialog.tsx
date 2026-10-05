import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type CardState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "image"; url: string; blob: Blob };

/** Feature-detect the system share sheet for this exact PNG: desktop browsers
 *  that share links but not files (or no share sheet at all) get no button. */
function canShareFile(file: File | null): file is File {
  if (!file || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try { return navigator.canShare({ files: [file] }); } catch { return false; }
}

/** The owner closing the share sheet is a choice, not a failure to report.
 *  Compared by name so a rejection from another realm still matches. */
const dismissed = (error: unknown) => (error as { name?: unknown } | null)?.name === "AbortError";

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
  const [notice, setNotice] = useState<{ url: string; text: string }>();

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
        setState({ kind: "image", url: objectUrl, blob });
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
  // Share and Copy hand the same in-memory PNG to the browser, and only when
  // the owner presses them. Each is offered only where the browser can take a
  // file; Download stays the fallback that works everywhere.
  const file = useMemo(() => state.kind === "image" ? new File([state.blob], filename, { type: "image/png" }) : null, [state, filename]);
  const shareable = useMemo(() => canShareFile(file), [file]);
  const copyable = typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";
  const offer = (run: () => Promise<void>, failure: string, success = "") => {
    if (state.kind !== "image") return;
    // The outcome names the preview it was about, so a press that settles
    // after a retry or a changed trade never reports on the newer image.
    const { url } = state;
    setNotice(undefined);
    // An async body runs synchronously up to its first await, so the share or
    // clipboard call still happens inside the press, as browsers require.
    void run().then(() => setNotice({ url, text: success }),
      (error: unknown) => { if (!dismissed(error)) setNotice({ url, text: failure }); });
  };
  const share = () => {
    if (file) offer(async () => navigator.share({ files: [file], title: `${symbol} P&L` }),
      "Could not share this image. Use Download PNG instead.");
  };
  const copy = () => {
    if (state.kind === "image") offer(async () => navigator.clipboard.write([new ClipboardItem({ "image/png": state.blob })]),
      "Could not copy this image. Use Download PNG instead.", "Image copied.");
  };
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
            {shareable && <button type="button" disabled={!loaded} onClick={share}>Share</button>}
            {copyable && <button type="button" disabled={!loaded} onClick={copy}>Copy image</button>}
            <button type="button" disabled={!loaded} onClick={() => window.print()}>Print</button>
          </div>
          {notice?.url === state.url && notice.text && <p className="pnl-card-note" role="status">{notice.text}</p>}
        </>}
      </dialog>
    </div>, document.body,
  );
}
