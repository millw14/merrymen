"use client";

import { useEffect, useRef, useState } from "react";
import { publishAgentImage, useAgentImageSrc } from "./agent-image-state";

/**
 * PICK A PICTURE FOR YOUR AGENT.
 *
 * ── WHY THIS IS NOT PART OF THE SETTINGS FORM ────────────────────────────
 *
 * Every other control on the Settings screen edits a field in one draft object
 * that `save()` sends as JSON to `PUT /api/settings`. An image cannot ride that
 * request: the settings blob is sealed under the money DEK and handed to every
 * child worker on every read, so a megabyte of picture in it would make a
 * public avatar depend on the key that decrypts grants (see image-store.ts).
 *
 * So this uploads on selection, to its own endpoint, and reports its own
 * result. The consequence is worth stating because it is visible: unlike the
 * fields around it, there is no Save — choosing a file IS the change, and
 * "Remove" is immediate too.
 *
 * ── AND WHY IT SHOWS A LOCAL PREVIEW BEFORE THE SERVER HAS IT ────────────
 *
 * The server re-encodes an upload (cover-cropped, stripped, webp), so the file
 * on disk and the picture that ends up public are not the same bytes. The local
 * preview is the owner's own file — honest about WHICH image is being set, and
 * deliberately not a promise about the exact crop. Once the upload succeeds the
 * preview switches to the served URL with a version query, so what is shown
 * from then on is the real stored image rather than an optimistic guess.
 */
export function AgentImageField({
  kind,
  slug,
  label,
  hint,
}: {
  kind: "avatar" | "banner";
  /** Null before an agent exists — there is nothing to show and nowhere to put it. */
  slug: string | null;
  label: string;
  hint: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A local object URL while uploading, then the served URL with a version. */
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const base = useAgentImageSrc(slug, kind);
  useEffect(() => { setFailed(false); setPreview(null); }, [base]);
  const shown = preview ?? (failed ? null : base);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const local = URL.createObjectURL(file);
    setPreview(local);
    try {
      const r = await fetch(`/api/agent-image/me/${kind}`, {
        method: "PUT",
        // The file IS the body. No multipart, so no parser and no filename —
        // one fewer piece of attacker-chosen text in the system.
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string; version?: string };
      if (!r.ok) {
        // THE SERVER'S SENTENCE, NOT A GENERIC ONE. It distinguishes "that is
        // not an image" from "this deployment cannot process images", and only
        // one of those is the owner's to act on.
        setError(body.error ?? "that upload did not go through");
        setPreview(null);
        return;
      }
      if (slug) publishAgentImage(slug, kind, body.version ?? String(Date.now()));
      setFailed(false);
      setPreview(null);
    } catch {
      setError("that upload did not go through");
      setPreview(null);
    } finally {
      URL.revokeObjectURL(local);
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agent-image/me/${kind}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "that removal did not go through");
        return;
      }
      if (slug) publishAgentImage(slug, kind, null);
      setPreview(null);
    } catch {
      setError("that did not go through");
    } finally {
      setBusy(false);
    }
  }

  if (!slug) {
    return (
      <div className="mm-field setting-field">
        <span className="mm-label">{label}</span>
        <p className="mm-hint">Deploy an agent first — a picture needs something to belong to.</p>
      </div>
    );
  }

  return (
    <div className="mm-field setting-field">
      <span className="mm-label">{label}</span>
      <div className={`agent-image-pick ${kind}`}>
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element -- served from our
          // own origin at a bounded size; next/image would add a loader for nothing.
          <img className={`agent-image-preview ${kind}`} src={shown} alt="" onError={() => setFailed(true)} />
        ) : (
          // NOT AN ERROR STATE. Most agents have no picture, and the feed draws
          // a seeded gradient for them; this says so rather than showing a
          // broken frame.
          <span className={`agent-image-empty ${kind}`} aria-hidden />
        )}
        <div className="agent-image-actions">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          {shown && (
            <button type="button" className="mm-btn danger sm" disabled={busy} onClick={() => void remove()}>
              remove
            </button>
          )}
        </div>
      </div>
      <p className="mm-hint">{hint}</p>
      {busy && <p className="mm-hint">updating…</p>}
      {error && <p className="mm-hint mm-bad">{error}</p>}
    </div>
  );
}
