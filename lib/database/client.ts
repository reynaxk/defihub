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
const client =
  globalThis.__defihubDbClient ??
  postgres(connectionString, { max: process.env.NODE_ENV === "production" ? 10 : 1 });

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
