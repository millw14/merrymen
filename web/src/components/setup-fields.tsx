"use client";

/**
 * Shared presentational bits for the two setup surfaces — the /settings page
 * and the first-run dashboard wizard. Kept in one place so the field chrome
 * (label / action link / input / hint) can't drift between them.
 */

export function Field(props: {
  label: string;
  hint?: React.ReactNode;
  /** Optional "get a key ↗" link shown beside the label (opens the provider). */
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <label className="field settings-field">
      <span className="field-labelrow">
        <span className="field-label">{props.label}</span>
        {props.action && (
          <a className="field-getkey" href={props.action.href} target="_blank" rel="noreferrer">
            {props.action.label} ↗
          </a>
        )}
      </span>
      <span className="field-input">{props.children}</span>
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

/** Placeholder for a masked secret: shows whether it's set (just the tail). */
export function secretPlaceholder(s: { set: boolean; hint: string | null }): string {
  return s.set ? `saved ····${s.hint ?? ""} — type to replace` : "not set";
}
