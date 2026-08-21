-- Deduplicate aggregate (chain_id IS NULL) protocol_metrics rows before
-- constraining them: if any environment already has duplicate
-- (protocol_id, timestamp) aggregate rows (Postgres never rejected them as
-- conflicts pre-migration - see the unique index comment in schema.ts),
-- the CREATE UNIQUE INDEX below fails outright on that data. Keeps one
-- canonical row per (protocol_id, timestamp) - the highest id in each
-- duplicate group is an arbitrary but deterministic and idempotent choice
-- (a second run finds nothing left to delete), not a "most recent write"
-- rule; true duplicates share the same sync-run snapshot, so which one
-- survives doesn't change the data. Verified against the live database
-- before this migration was authored: zero duplicate groups existed at
-- that time, but this must not depend on that being true forever, or of
-- every environment this migration ever runs against (CI, a fresh clone,
-- production).
DELETE FROM "protocol_metrics" a
USING "protocol_metrics" b
WHERE a."chain_id" IS NULL
  AND b."chain_id" IS NULL
  AND a."protocol_id" = b."protocol_id"
  AND a."timestamp" = b."timestamp"
  AND a."id" < b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_metrics_unique_aggregate_snapshot" ON "protocol_metrics" USING btree ("protocol_id","timestamp") WHERE "protocol_metrics"."chain_id" is null;
