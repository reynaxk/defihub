import { and, eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { indexingState } from "@/lib/database/schema";

export type IndexingStatus = "idle" | "running" | "error";

export interface IndexingStateRow {
  chainSlug: string;
  component: string;
  lastProcessedBlock: bigint | null;
  lastSuccessfulSyncAt: Date | null;
  lastAttemptedSyncAt: Date | null;
  status: IndexingStatus;
  error: string | null;
  updatedAt: Date;
}

// A generic, persistent cursor per (chain, component) - the foundation for
// future incremental indexing (see lib/indexing/events.ts), not a full
// indexer itself. Always reads fresh from the database rather than caching
// in memory, so a worker restart can't lose or corrupt its position.
export async function getIndexingState(chainSlug: string, component: string): Promise<IndexingStateRow | null> {
  const [row] = await db
    .select()
    .from(indexingState)
    .where(and(eq(indexingState.chainSlug, chainSlug), eq(indexingState.component, component)));

  if (!row) return null;
  return {
    chainSlug: row.chainSlug,
    component: row.component,
    lastProcessedBlock: row.lastProcessedBlock != null ? BigInt(row.lastProcessedBlock) : null,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
    lastAttemptedSyncAt: row.lastAttemptedSyncAt,
    status: row.status,
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

export interface IndexingStateUpdate {
  lastProcessedBlock?: bigint;
  lastSuccessfulSyncAt?: Date;
  lastAttemptedSyncAt?: Date;
  status?: IndexingStatus;
  error?: string | null;
}

// Single atomic upsert, same ON CONFLICT DO UPDATE pattern as
// lib/security/rate-limit.ts's rate-limit buckets - two concurrent/retried
// calls for the same (chainSlug, component) key are serialized by
// Postgres's own row locking rather than racing in application code, so
// this is concurrency-safe by construction, not by convention.
export async function updateIndexingState(
  chainSlug: string,
  component: string,
  patch: IndexingStateUpdate,
): Promise<void> {
  const values = {
    chainSlug,
    component,
    status: patch.status ?? ("idle" as const),
    updatedAt: new Date(),
    ...(patch.lastProcessedBlock != null ? { lastProcessedBlock: patch.lastProcessedBlock.toString() } : {}),
    ...(patch.lastSuccessfulSyncAt ? { lastSuccessfulSyncAt: patch.lastSuccessfulSyncAt } : {}),
    ...(patch.lastAttemptedSyncAt ? { lastAttemptedSyncAt: patch.lastAttemptedSyncAt } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  };

  await db
    .insert(indexingState)
    .values(values)
    .onConflictDoUpdate({
      target: [indexingState.chainSlug, indexingState.component],
      set: values,
    });
}
