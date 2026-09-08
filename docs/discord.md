# Support Discord

Planned replacement for the beta Telegram group as the support venue. Telegram
stays for now: the beta group is linked from the site footer and from
`app/page.tsx`, and moving people off a room they already read is slower than
opening a new one. Run both until the Discord has the traffic.

Nothing here is set up yet. This is the shape to build, not a record of what
exists.

## Why the shape matters here

merrymen is non-custodial. The owner key never leaves the user, which is the
whole safety claim — and it makes the support room the softest target in the
product. An attacker cannot drain a wallet through the gateway, so they will
try the room instead: a DM from "merrymen support" asking for a recovery
phrase to "restore your agent". Every structural decision below exists to make
that DM obviously fake.

The one rule that does the most work: **staff never DM first, and never ask
for a key, phrase, or seed.** It goes in the rules gate, the channel topics,
and the support channel's pinned message, because people read exactly one of
those three.

## Channels

**Landing** — `#rules` (gate), `#announcements` (staff post only, releases and
incidents), `#changelog` (webhook from GitHub releases).

**Support** — `#start-here` (install, wallet creation, the docs links),
`#support` as a *forum* channel so each question gets its own thread and the answer
stays findable, `#bugs` for reproducible faults that should become issues.

**Community** — `#general`, `#strategies` (paper-trading results, no signal
selling), `#memescope` for the token-feed chatter that would otherwise flood
`#general`.

**Feedback** — `#feature-requests`, forum or forum-like, so duplicates merge.

**Staff** — private `#staff`, plus `#mod-log` for the audit trail.

## Roles

`Owner`, `Core` (write in `#announcements`), `Support` (manage threads, no
ban), `Beta` (carried over from the Telegram beta group), `Member` (default
after the rules gate), `Muted`. Give `Member` no mention permissions on
`@everyone` or `@here` — that permission is how a compromised account turns
into a mass phish.

## Server settings that are not optional

- Verification level **High** (verified phone) — the standard cost floor for
  drainer accounts.
- Explicit media filter: **scan messages from all members.**
- Rules Screening on, with the never-DM rule as an explicit checkbox.
- AutoMod: block invite links, block new-member links entirely for the first
  day, and keyword-block the drainer vocabulary — `seed phrase`, `recovery
  phrase`, `private key`, `airdrop`, `claim your`, `validate wallet`.
- Slowmode on `#general` and `#memescope`; none on `#support`.
- Turn **off** the server-wide default that lets members DM each other, so the
  impersonation route needs a mutual server the attacker has to work for.

## Wiring it to the site

The invite is one constant. `site/components/Footer.tsx` already holds
`GITHUB`, `NPM`, `X_URL`, `SUPPORT`, and `TELEGRAM_BETA`; add `DISCORD`
alongside them and mirror it in `Nav.tsx`, the same way `TELEGRAM_BETA` is
kept in sync with `app/page.tsx`. Use a **vanity or non-expiring** invite —
a default invite expires in seven days, and a dead link in the footer of a
non-custodial trading product reads as an abandoned project.

Do not put the Discord in `terms/page.tsx` or `PrivacyPolicyDoc.tsx`. Those
name `support@merrymen.dev` as the contact of record, and a chat room is not
a contact of record.
