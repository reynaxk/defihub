import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  var __defihubDbClient: postgres.Sql | undefined;
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and configure a Postgres connection string.",
  );
}

// Reuse the connection across hot reloads in dev so we don't exhaust Postgres
// connection slots every time a route file changes.
//
// In production this app runs as horizontally-scaled Vercel serverless
// functions, not one long-lived process - `max` bounds connections per
// instance, but says nothing about the total across however many instances
// are alive at once. idle_timeout releases a connection back to Postgres
// once a function instance goes quiet instead of holding it open until that
// instance is torn down, and max_lifetime recycles connections periodically
// so a slowly-growing instance count can't accumulate stale ones
// indefinitely. prepare is turned off because server-side prepared
// statements aren't safe against transaction-mode connection poolers
// (pgbouncer/Supavisor-style, common on managed Postgres) - unnamed
// prepared statements can get executed against the wrong underlying
// connection when the pooler multiplexes transactions across sockets.
const client =
  globalThis.__defihubDbClient ??
  postgres(connectionString, {
    max: process.env.NODE_ENV === "production" ? 10 : 1,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__defihubDbClient = client;
}

export const db = drizzle(client, { schema });

// Standalone worker scripts (run via tsx, not through Next.js) should call
// this before exiting - forcing process.exit() while postgres.js still has
// open sockets is what trips the libuv assertion crash on Windows.
export async function closeDb() {
  await client.end();
}
