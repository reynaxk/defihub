import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, db } from "../../client";

// Companion to migration 0025_pool_observation_block_identity.sql - not a
// generic tool, a one-off deploy step for that one migration's two index
// builds specifically.
//
// drizzle-kit's migration runner (drizzle-orm's own `migrate()`, invoked by
// `npm run db:migrate`) wraps every pending migration file - and every
// statement inside it - in a single Postgres transaction (confirmed by
// reading node_modules/drizzle-orm/pg-core/dialect.js's own `migrate`
// implementation). Postgres refuses `CREATE`/`DROP INDEX CONCURRENTLY`
// inside a transaction block outright, so there is no way to make 0025's
// own index-build statements run concurrently through the standard
// `db:migrate` path - that's a hard constraint of this project's migration
// tooling, not a choice this script works around by accident.
//
// This script IS the production-safe path instead: each statement below
// runs as its own top-level, non-transactional call (`db.execute`, not
// `db.transaction`), which is exactly what CONCURRENTLY requires. Run it
// BEFORE `npm run db:migrate` against a database where
// historical_observations has grown large enough that 0025's own
// (fast-for-a-small-table, but write-blocking) plain CREATE/DROP INDEX
// would hold a SHARE lock for too long. Once these indexes already exist,
// migration 0025's own `IF NOT EXISTS`/`IF EXISTS` statements find nothing
// left to do and complete as a fast no-op - so running this script first is
// safe to do unconditionally, including against a small/dev database, or a
// database that already ran 0025 the normal way.
async function main() {
  console.log("[0025-concurrent] dropping historical_observations_dedup_unique (if present), concurrently...");
  await db.execute(sql`DROP INDEX CONCURRENTLY IF EXISTS historical_observations_dedup_unique`);

  console.log("[0025-concurrent] creating historical_observations_block_hash_identity_unique, concurrently...");
  await db.execute(sql`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS historical_observations_block_hash_identity_unique
    ON historical_observations (entity_type, entity_id, metric, block_number, block_hash)
    WHERE block_number IS NOT NULL AND block_hash IS NOT NULL
  `);

  console.log("[0025-concurrent] creating historical_observations_block_only_identity_unique, concurrently...");
  await db.execute(sql`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS historical_observations_block_only_identity_unique
    ON historical_observations (entity_type, entity_id, metric, block_number)
    WHERE block_number IS NOT NULL AND block_hash IS NULL
  `);

  console.log("[0025-concurrent] done - run `npm run db:migrate` next.");
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error("[0025-concurrent] failed:", err);
    await closeDb();
    process.exitCode = 1;
  });
