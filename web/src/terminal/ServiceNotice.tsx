"use client";

import { useEffect, useState } from "react";
import { fullDateTime, shortDateTime } from "@/lib/format";
/**
 * The same check the route ran on the env var, run again on its answer — see
 * lib/service-notice.ts for why this module stays safe to bundle.
 */
import {
  noticeLabel,
  noticeRevision,
  serviceNoticeFromWire,
  type ServiceNotice as Notice,
} from "@/lib/service-notice";
import { requestJson } from "./request-json";

/** Where a dismissal is kept: the revision of the notice that was dismissed. */
export const DISMISSED_KEY = "merrymen:service-notice:dismissed";

/**
 * How often an open tab asks again. The notice changes only on a web redeploy,
 * and a tab left open through one runs the old bundle against the new server —
 * so without this, the owners most likely to be watching during an incident
 * would be the last to see it change.
 */
const REFRESH_MS = 5 * 60_000;

/**
 * THE OPERATOR'S FLEET-WIDE BANNER, on every screen.
 *
 * Renders nothing until the route answers, nothing when it answers null, and
 * nothing once THIS revision has been dismissed. Any edit to the notice is a
 * new revision, so a correction reaches everyone who dismissed the mistake.
 *
 * A failed read keeps whatever was last shown. The route answering null is an
 * answer and clears it; the route not answering is not, and an outage is the
 * worst moment for an incident notice to vanish.
 */
export function ServiceNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY));
    } catch {
      // No storage: a dismissal lasts for this page, which is still a dismissal.
    }
    const read = () => {
      requestJson<{ notice?: unknown }>("/api/service-notice")
        .then((answer) => { if (live) setNotice(serviceNoticeFromWire(answer.notice)); })
        .catch(() => { /* keep the last answer — see above */ });
    };
    read();
    const id = window.setInterval(read, REFRESH_MS);
    return () => { live = false; window.clearInterval(id); };
  }, []);
  if (!notice) return null;
  const revision = noticeRevision(notice);
  if (dismissed === revision) return null;
  return <ServiceNoticeView notice={notice} onDismiss={() => {
    try { localStorage.setItem(DISMISSED_KEY, revision); } catch { /* page-long dismissal still works */ }
    setDismissed(revision);
  }}/>;
}

/**
 * The banner itself. TEXT NODES ONLY: every operator-authored string is a
 * React child or a validated `href`, never markup — there is no
 * dangerouslySetInnerHTML here and there must never be one.
 */
export function ServiceNoticeView({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const at = Date.parse(notice.updatedAt);
  const label = noticeLabel(notice);
  return <div className="service-notice" role="status" aria-label={label}>
    <div className="service-notice-head">
      <span className="service-notice-label">{label}</span>
      <time dateTime={notice.updatedAt} title={fullDateTime(at)}>Updated {shortDateTime(at)}</time>
    </div>
    <strong>{notice.title}</strong>
    <p>{notice.body}</p>
    {notice.links.length > 0 && <ul className="service-notice-links">
      {notice.links.map((link) => <li key={link.href + link.label}>
        <a href={link.href} rel="noopener noreferrer">{link.label}</a>
      </li>)}
    </ul>}
    <button type="button" onClick={onDismiss}>Dismiss</button>
  </div>;
}
