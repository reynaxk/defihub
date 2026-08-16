# ChainScope

A DeFi analytics platform — protocols, chains and yield pools tracked with real data, plus accounts, watchlists and threshold alerts.

This is **Phase 1 (MVP)** of the product. See [`.claude` plan history] or ask for the roadmap for what's deliberately deferred: token/wallet explorers, AI protocol analysis, the public API, billing, and Redis-backed caching.

## Stack

- **Frontend**: Next.js (App Router) + React + TypeScript + Tailwind CSS v4 + shadcn/ui
- **Backend**: Next.js Route Handlers, Drizzle ORM, PostgreSQL
- **Auth**: Auth.js v5 (email/password + optional Google OAuth), JWT sessions
- **Data**: DefiLlama's free public API (protocol/chain TVL, fees, revenue, volume, yields) and CoinGecko (token prices), behind a provider-abstraction layer in `lib/providers`
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
| `COINGECKO_API_KEY` | No | Price sync uses the public rate limit (~5-15 req/min) instead of the free Demo plan's 100 req/min |
| `RESEND_API_KEY` | No | Alert emails are logged to the console instead of sent |

### 4. Set up the database

```bash
npm run db:migrate   # create tables
npm run seed          # seed the 5 supported chains + their native tokens
```

### 5. Pull in real data

```bash
npm run sync:chains
npm run sync:protocols
npm run sync:yields
npm run sync:prices
```

(Or `npm run sync:all` for everything except chains, which is run separately since it backfills full history.)

### 6. Run it

```bash
npm run dev
```

## Keeping data fresh

In production, `vercel.json` schedules the same sync scripts via Vercel Cron, hitting `/api/cron/*` routes protected by `CRON_SECRET` (Vercel sends this automatically as `Authorization: Bearer $CRON_SECRET` — see [Vercel's cron docs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). Note Vercel's Hobby plan limits cron frequency; adjust `vercel.json` or upgrade if you need the schedules as configured.

Locally, re-run the `npm run sync:*` scripts whenever you want fresher data, or set up your own scheduler.

## Project structure

```
app/                  Routes (App Router) - pages + API route handlers
components/           UI components (ui/ = shadcn primitives)
lib/
  auth/                Auth.js config
  database/            Drizzle schema, migrations, client, query modules
  providers/           DefiLlama + CoinGecko adapters behind provider interfaces
  alerts/              Pure alert-condition evaluation logic (unit tested)
  notifications/       Email abstraction (Resend or console fallback)
  cron/                Cron route auth helper
  config/chains.ts     The 5 supported chains - add a chain here to extend
workers/               Standalone ingestion scripts, also callable from app/api/cron/*
```

## Testing

```bash
npm run test        # Vitest - alert condition logic
npx tsc --noEmit     # type-check
npm run build        # production build
```

## Adding a chain

Add an entry to `lib/config/chains.ts` (needs the DefiLlama chain name for `defillamaSlug`), then `npm run seed && npm run sync:all`.

## Adding a data provider

Implement `DefiDataProvider` or `PriceProvider` from `lib/providers/types.ts` and swap the instance in `lib/providers/index.ts` — nothing else in the app touches provider internals directly.
