# Monetization readiness (planning only — nothing here is implemented)

No billing, no Stripe integration, no "Upgrade" UI exists in this codebase.
This document is scoped to one question: **if/when billing is added, where
does it actually plug in**, given the architecture as it exists today. It's
here so that decision doesn't require re-deriving the codebase from scratch,
not as a spec to build against yet.

## Where a paid tier would attach

- **`users` table** (`lib/database/schema.ts`) has no tier/plan column today.
  A `subscriptionTier` (or a separate `subscriptions` table, if billing
  history/seats matter later) would hang off `users.id` the same way
  `watchlist` and `alerts` already do — no schema redesign needed, just an
  additive column/table.
- **Public API** (`/api/v1/*`, documented at `/api-docs`) is already
  versioned and centrally rate-limited (`checkPublicApiRateLimit` in
  `lib/api/response.ts`, applied per-route). A paid API tier is "swap the
  per-IP key for a per-API-key key, and look up that key's tier's limit" —
  the routes themselves don't change, since they already just call the same
  query functions the pages use.
- **Rate limiter** (`lib/security/rate-limit.ts`) is in-memory, documented in
  `architecture.md` as sized for a single instance. A paid, higher-limit tier
  is exactly the kind of thing that would force the already-flagged move to
  a shared store (Redis) — don't build that speculatively before a tier
  actually needs it.

## Features named as potential premium tiers (not built, not gated today)

Everything on the current site — CSV export, all yield filters, the full
chart history range, AI summaries — is free and ungated. If a paid tier is
introduced, the brief's own candidate list is a reasonable one:

- Advanced/longer historical data (e.g. gate the `ALL` chart range, or
  extended per-metric history beyond what's shown today)
- Advanced alerts (higher alert count per user, more condition types)
- Portfolio analytics (doesn't exist yet at all — would need wallet address
  input and holdings lookup, a real new feature, not a gate on an existing one)
- API access tiers (see above — the versioned structure is already there)
- CSV export (currently free and ungated on every list page)
- Advanced yield filters (already fairly complete after this pass — risk,
  category, TVL, search; a paid tier here would mean *more* filters, not
  hiding today's)
- AI research (already exists behind `ANTHROPIC_API_KEY` being configured at
  all; a paid tier would mean per-user usage limits, since each generation
  is a real, metered API cost)
- Custom dashboards (doesn't exist yet — the current dashboard is fixed-shape)

## What this explicitly does not include

No payment collection, no fake "Pro" badges, no disabled-but-visible upgrade
prompts, no pricing page. Building UI that implies a paid tier exists before
billing actually works would be misleading to real users - this stays a
planning doc until there's a real decision to build against it.
