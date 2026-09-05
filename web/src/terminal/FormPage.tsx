import type { ReactNode } from "react";

export function FormPage({children}:{children:ReactNode}) {
  return <section className="terminal-form-page">{children}</section>;
}
export function FormHeading({title,right}:{title:string;right?:ReactNode}) {
  return <header className="terminal-form-heading"><h1>{title}</h1>{right}</header>;
}
