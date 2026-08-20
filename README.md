# DeFiHub

A DeFi analytics platform — protocols, chains, tokens and yield pools tracked with real data, plus accounts, watchlists, threshold alerts, AI-generated protocol summaries, and a public read-only API.

Deliberately deferred: wallet/whale tracking and billing (both need external accounts — an RPC/indexing provider and Stripe — that only the project owner can create) and Redis-backed caching (the in-memory rate limiter and sync jobs are correctly sized for a single instance; Redis is a real upgrade once that changes, not something to add speculatively).

## Stack

- **Frontend**: Next.js (App Router) + React + TypeScript + Tailwind CSS v4 + shadcn/ui
- **Backend**: Next.js Route Handlers, Drizzle ORM, PostgreSQL
- **Auth**: Auth.js v5 (email/password + optional Google OAuth), JWT sessions
- **Data**: DefiLlama's free public API (protocol/chain TVL, fees, revenue, volume, yields) and CoinGecko (token prices/market data), behind a provider-abstraction layer in `lib/providers`
- **AI**: Claude API (`@anthropic-ai/sdk`) for on-demand protocol summaries — optional, degrades honestly with no key
- **Email**: Resend (optional — logs to console in dev if unconfigured)

## Getting started

### 1. Prerequisites

- Node.js 20+
- A PostgreSQL 16 database (a local instance works fine for development)

### 2. Install

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env.local
```

Fill in `DATABASE_URL` at minimum. Everything else is optional:

| Variable | Required? | Effect if missing |
|---|---|---|
| `DATABASE_URL` | **Yes** | App won't start |
| `AUTH_SECRET` | **Yes** | Generate with `npx auth secret` |
| `CRON_SECRET` | **Yes** | Protects `/api/cron/*`; generate any random string |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | No | "Sign in with Google" is hidden |
| `COINGECKO_API_KEY` | No | Price/token sync uses the public rate limit (~5-15 req/min) instead of the free Demo plan's 100 req/min |
| `ANTHROPIC_API_KEY` | No | The "AI summary" button on protocol pages doesn't render |
| `RESEND_API_KEY` | No | Alert emails are logged to the console instead of sent |
| `ETHEREUM_RPC_URL` / `ARBITRUM_RPC_URL` / `BASE_RPC_URL` / `BNB_CHAIN_RPC_URL` / `AVALANCHE_RPC_URL` / `POLYGON_RPC_URL` / `OPTIMISM_RPC_URL` | No | Each falls back to a free public RPC endpoint, used by the on-chain verification check and the `/wallet` balance viewer |

### 4. Set up the database

```bash
npm run db:migrate   # create tables
npm run seed          # seed the 8 supported chains + their native tokens
```

### 5. Pull in real data

```bash
npm run sync:chains
npm run sync:protocols
npm run sync:yields
npm run sync:prices
npm run sync:tokens
npm run verify:onchain
```

(Or `npm run sync:all` for everything except chains, which is run separately since it backfills full history.)

### 6. Run it

```bash
npm run dev
```

## Keeping data fresh

In production, `vercel.json` schedules the same sync scripts via Vercel Cron, hitting `/api/cron/*` routes protected by `CRON_SECRET` (Vercel sends this automatically as `Authorization: Bearer $CRON_SECRET` — see [Vercel's cron docs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). Note Vercel's Hobby plan limits cron frequency; adjust `vercel.json` or upgrade if you need the schedules as configured.

Locally, re-run the `npm run sync:*` scripts whenever you want fresher data, or set up your own scheduler.

## Public API

Read-only JSON endpoints under `/api/v1/*` (protocols, chains, yields, tokens — list + detail), rate-limited to 60 req/min per IP, no key required. Documented with example responses at `/api-docs`.

## Docs

Deeper reference material lives in [`docs/`](./docs) — architecture, database design, data source methodology, security posture, and monetization planning.

## Project structure

```
app/                  Routes (App Router) - pages + API route handlers
components/           UI components (ui/ = shadcn primitives)
lib/
  auth/                Auth.js config
  database/            Drizzle schema, migrations, client, query modules
  providers/           DefiLlama + CoinGecko adapters behind provider interfaces
  ai/                  Claude API protocol-summary generation (optional, cached)
  onchain/             Direct-RPC read for one hand-picked pool (independent cross-check, not an indexer)
  alerts/              Pure alert-condition evaluation logic (unit tested)
  notifications/       Email abstraction (Resend or console fallback)
  security/            In-memory rate limiter
  api/                 Shared response helpers for the public API
  cron/                Cron route auth helper
  config/chains.ts     The 8 supported chains - add a chain here to extend
workers/               Standalone ingestion scripts, also callable from app/api/cron/*
```

## Testing

```bash
npm run test        # Vitest - provider normalization, alert logic, pagination
npx tsc --noEmit     # type-check
npm run lint         # eslint
npm run build        # production build
```

## Adding a chain

Add an entry to `lib/config/chains.ts` (needs the DefiLlama chain name for `defillamaSlug` and the CoinGecko asset-platform id for `coingeckoPlatformId`), then `npm run seed && npm run sync:all`.

## Adding a data provider

Implement `DefiDataProvider`, `PriceProvider`, or `TokenDiscoveryProvider` from `lib/providers/types.ts` and swap the instance in `lib/providers/index.ts` — nothing else in the app touches provider internals directly.
