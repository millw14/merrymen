import type { Metadata } from "next";

/**
 * WHAT A PASSER-BY SEES WHILE THIS IS BEING BUILT.
 *
 * A notice first and a password field second, in that order, because the more
 * useful thing to tell someone who did not expect a door is why there is one.
 *
 * No shell: no rail, no tape, no search. Every one of those would fetch, and
 * this is the page for people who are not being let in yet.
 */
export const metadata: Metadata = {
  title: "merrymen — access",
  description: "Enter your password to access merrymen.",
  // A holding page has no business in an index, and the crawler that arrives
  // while it is up would otherwise cache this as the site.
  robots: { index: false, follow: false },
};

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<{ again?: string }>;
}) {
  const { again } = await searchParams;

  return (
    <div className="terminal-host terminal-standalone">
      <main>
        <p className="brand">merrymen</p>
        <h1>Enter your password</h1>

        <form method="POST" action="/api/gate">
          <label>
            <span>Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                autoFocus
                aria-invalid={again ? true : undefined}
                aria-describedby={again ? "gate-again" : undefined}
              />
          </label>
          <button type="submit">
            Come in
          </button>
        </form>

        {/* Said once, plainly. A wrong password is not an incident. */}
        {again && (
          <p className="mm-gate-again" id="gate-again" role="status">
            That is not it. Try again.
          </p>
        )}
      </main>
    </div>
  );
}
