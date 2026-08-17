# Security

## What's implemented

**Transport & headers.** `proxy.ts` sets a nonce-based Content-Security-Policy
on every response (`script-src 'self' 'nonce-{random}'`, no
`unsafe-inline`/`unsafe-eval` in production), plus `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`.
`img-src` is an explicit allowlist (`icons.llamao.fi`, `coin-images.
coingecko.com`) rather than left open.

**Auth.** Email/password via Auth.js Credentials provider, bcrypt-hashed
passwords, JWT sessions (no session table to leak). Registration and
sign-in are both rate-limited per IP (`lib/security/rate-limit.ts`).
Registration has a TOCTOU-safe insert: rather than check-then-insert (a
race two concurrent signups could both pass), it inserts and catches
Postgres's unique-violation error code (`23505`) as a proper 409. Google
OAuth is optional and the UI hides the button entirely when it's not
configured, rather than showing a broken flow.

**Authorization.** `proxy.ts` gates `/dashboard`, `/alerts`, `/settings`
behind a session check server-side (not just hidden client-side UI).
Every mutating route (`/api/watchlist`, `/api/alerts/*`,
`/api/protocols/[slug]/summarize`) re-checks `auth()` itself rather than
trusting the proxy layer alone, and scopes every query to the
authenticated user's own ID — there's no route that takes a user ID as a
request parameter.

**Input validation.** Every request body that reaches a database write is
validated with a Zod schema first (registration, alert creation, watchlist
toggles) — never trust a client-supplied shape, even from the app's own
frontend. Public API routes validate and clamp pagination params
(`normalizePagination` — see [database.md](./database.md)) rather than
passing user input straight into `LIMIT`/`OFFSET`.

**Rate limiting.** In-memory sliding-window limiter, applied to
auth endpoints, the public `/api/v1/*` API (60 req/min/IP), the internal
search endpoint, and the AI summary endpoint (10/hour/user — this one
costs real API credit per call, so it's capped tighter than a plain data
read). See [architecture.md](./architecture.md#rate-limiting) for the
known single-instance limitation.

**Error handling.** API routes never return raw error objects or stack
traces to the client — `String(err)` in a JSON response was found and
fixed early in this project specifically because it leaked internal detail;
every route now returns a generic message and logs the real error
server-side only.

**Secrets.** `.env.local` is gitignored; `.env.example` documents every
variable with a placeholder, never a real value (see the README's env var
table). `CRON_SECRET` gates every `/api/cron/*` route via a bearer-token
check, not just "assume only Vercel Cron calls this URL."

## What's explicitly not implemented (and why)

- **No 2FA.** Not requested, and email/password + optional Google OAuth is
  a reasonable bar for the current user base size.
- **No audit log of admin/user actions.** Would matter more once there's an
  actual admin surface or paying customers with support disputes — revisit
  if/when that exists.
- **No WAF / bot-detection layer beyond rate limiting.** The in-memory
  limiter stops naive abuse; it will not stop a distributed attack. Not
  worth the cost of a paid service (Cloudflare, etc.) at current traffic —
  revisit if abuse is actually observed, not preemptively.
- **Wallet/private-key handling doesn't exist at all.** No custodial
  wallets, no transaction signing, no private key or seed phrase is ever
  requested or stored — this is a read-only analytics product. If
  wallet-connect or trade-execution features are ever built, they need
  their own security review before shipping (see the "wallet security" and
  "trading simulation" principles this project was given — real-money
  execution stays disabled until explicitly authorized).

## Reporting a finding

There's no external bug bounty program. If a real vulnerability is found in
the course of development, fix it and note what changed and why in the
commit message — that history is the audit trail for now.
