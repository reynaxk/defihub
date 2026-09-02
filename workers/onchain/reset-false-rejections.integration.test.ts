// Real-Postgres integration tests for the PR #19 review-round fix to this
// one-time operator correction script - same pattern as
// lib/onchain/discovery/queries.integration.test.ts (synthetic chain per
// test, afterEach cleanup, afterAll closeDb).
//
// The core property under test: resetFalseRejections must NEVER reset a
// discovered_pools row that isn't BOTH (a) explicitly named in the
// allowlist passed to it AND (b) currently exhibiting the exact known
// false-rejection signature (status "rejected", the EXACT reason text, no
// linked poolId, validatedAt on or before the cutoff). Either gate failing
// alone is enough to leave a row untouched - this file proves both gates
// independently, not just the "happy path" reset.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { chains, discoveredPools, pools } from "@/lib/database/schema";
import type { FactoryDeployment } from "@/lib/onchain/discovery/config";
import { recordDiscoveredPools } from "@/lib/onchain/discovery/queries";
import type { DecodedPairCreated } from "@/lib/onchain/discovery/scan";
import { FALSE_REJECTION_REASON, resetFalseRejections } from "./reset-false-rejections";

describe("resetFalseRejections", () => {
  const createdChainIds: string[] = [];

  afterEach(async () => {
    for (const id of createdChainIds.splice(0)) await db.delete(chains).where(eq(chains.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeChain(): Promise<{ id: string; slug: string }> {
    const slug = `reset-false-rejections-test-${randomUUID()}`;
    const [chain] = await db.insert(chains).values({ name: `Reset Test Chain ${randomUUID()}`, slug, nativeToken: "TST" }).returning({ id: chains.id });
    createdChainIds.push(chain.id);
    return { id: chain.id, slug };
  }

  function deployment(chainSlug: string): FactoryDeployment {
    return {
      key: `test-deployment-${randomUUID()}`,
      chainSlug,
      protocolDefillamaSlug: "test-protocol",
      dexKind: "uniswap-v2",
      factoryAddress: "0xfactory",
      feeBps: 25,
      startBlock: BigInt(1),
    };
  }

  function candidate(poolAddress: string): DecodedPairCreated {
    return {
      token0: "0xtoken0",
      token1: "0xtoken1",
      poolAddress,
      blockNumber: BigInt(100),
      blockHash: "0x" + "aa".repeat(32),
      transactionHash: "0x" + randomUUID().replace(/-/g, "").padEnd(64, "0"),
      logIndex: 5,
    };
  }

  // Inserts a row and forces it into an exact "rejected" state with a
  // caller-controlled reason and validatedAt - markDiscoveredPoolRejected
  // itself always stamps validatedAt with `new Date()`, which isn't
  // precise enough to test cutoff behavior deterministically.
  async function seedRejectedRow(chainId: string, dep: FactoryDeployment, poolAddress: string, reason: string, validatedAt: Date): Promise<string> {
    await recordDiscoveredPools(chainId, dep, [candidate(poolAddress)]);
    const [row] = await db
      .select({ id: discoveredPools.id })
      .from(discoveredPools)
      .where(and(eq(discoveredPools.chainId, chainId), eq(discoveredPools.poolAddress, poolAddress.toLowerCase())));
    await db.update(discoveredPools).set({ status: "rejected", rejectionReason: reason, validatedAt }).where(eq(discoveredPools.id, row.id));
    return row.id;
  }

  async function statusOf(rowId: string): Promise<{ status: string; rejectionReason: string | null }> {
    const [row] = await db.select({ status: discoveredPools.status, rejectionReason: discoveredPools.rejectionReason }).from(discoveredPools).where(eq(discoveredPools.id, rowId));
    return row;
  }

  const BEFORE_CUTOFF = new Date("2026-09-01T00:00:00.000Z");

  it("resets an allowlisted row whose current state exactly matches the known false-rejection signature", async () => {
    const chain = await makeChain();
    const dep = deployment(chain.slug);
    const rowId = await seedRejectedRow(chain.id, dep, "0xAAA", FALSE_REJECTION_REASON, BEFORE_CUTOFF);

    const result = await resetFalseRejections([{ chainSlug: chain.slug, poolAddress: "0xAAA" }]);

    expect(result).toEqual({ requested: 1, reset: 1, skippedAlreadyResolved: 0, skippedNotFound: 0, skippedSignatureMismatch: 0 });
    const after = await statusOf(rowId);
    expect(after.status).toBe("discovered");
    expect(after.rejectionReason).toBeNull();
  });

  it("PROVABLE SCOPE: a row NOT named in the allowlist is never reset, even with the EXACT same false-rejection reason and an eligible timestamp - this is the core fix over the old LIKE+cutoff-only query", async () => {
    const chain = await makeChain();
    const dep = deployment(chain.slug);
    const allowlistedRowId = await seedRejectedRow(chain.id, dep, "0xAAA", FALSE_REJECTION_REASON, BEFORE_CUTOFF);
    const notAllowlistedRowId = await seedRejectedRow(chain.id, dep, "0xBBB", FALSE_REJECTION_REASON, BEFORE_CUTOFF);

    const result = await resetFalseRejections([{ chainSlug: chain.slug, poolAddress: "0xAAA" }]);

    expect(result.reset).toBe(1);
    expect((await statusOf(allowlistedRowId)).status).toBe("discovered");
    // The row sharing the identical reason and an equally-eligible
    // timestamp is untouched purely because it was never named - the old
    // reason+cutoff query would have reset this row too.
    const untouched = await statusOf(notAllowlistedRowId);
    expect(untouched.status).toBe("rejected");
    expect(untouched.rejectionReason).toBe(FALSE_REJECTION_REASON);
  });

  it("SIGNATURE MISMATCH: a genuinely rejected row with a similar (but not exactly matching) reason is NOT reset, even when explicitly named in the allowlist", async () => {
    const chain = await makeChain();
    const dep = deployment(chain.slug);
    // A real, different rejection cause that happens to share the same
    // prefix the old LIKE query matched on - the old code's `LIKE
    // "${prefix}%"` would have matched this row too.
    const genuineReason = `${FALSE_REJECTION_REASON} (confirmed independently: this contract has no code at this address)`;
    const rowId = await seedRejectedRow(chain.id, dep, "0xCCC", genuineReason, BEFORE_CUTOFF);

    const result = await resetFalseRejections([{ chainSlug: chain.slug, poolAddress: "0xCCC" }]);

    expect(result).toEqual({ requested: 1, reset: 0, skippedAlreadyResolved: 0, skippedNotFound: 0, skippedSignatureMismatch: 1 });
    const after = await statusOf(rowId);
    expect(after.status).toBe("rejected");
    expect(after.rejectionReason).toBe(genuineReason);
  });

  it("SIGNATURE MISMATCH: an allowlisted row rejected AFTER the cutoff is not reset - it wasn't part of the pre-fix incident", async () => {
    const chain = await makeChain();
    const dep = deployment(chain.slug);
    const afterCutoff = new Date("2026-09-03T00:00:00.000Z");
    const rowId = await seedRejectedRow(chain.id, dep, "0xDDD", FALSE_REJECTION_REASON, afterCutoff);

    const result = await resetFalseRejections([{ chainSlug: chain.slug, poolAddress: "0xDDD" }]);

    expect(result.reset).toBe(0);
    expect(result.skippedSignatureMismatch).toBe(1);
    expect((await statusOf(rowId)).status).toBe("rejected");
  });

  it("IDEMPOTENT: running twice with the same allowlist only resets once - the second run reports the row as already resolved, never re-touches it", async () => {
    const chain = await makeChain();
    const dep = deployment(chain.slug);
    const rowId = await seedRejectedRow(chain.id, dep, "0xAAA", FALSE_REJECTION_REASON, BEFORE_CUTOFF);
    const allowlist = [{ chainSlug: chain.slug, poolAddress: "0xAAA" }];

    const first = await resetFalseRejections(allowlist);
    const second = await resetFalseRejections(allowlist);

    expect(first.reset).toBe(1);
    expect(second).toEqual({ requested: 1, reset: 0, skippedAlreadyResolved: 1, skippedNotFound: 0, skippedSignatureMismatch: 0 });
    expect((await statusOf(rowId)).status).toBe("discovered");
  });

  it("never touches a row that already has a linked poolId, even if it's otherwise 'rejected' with the exact known reason - defensive guard against an inconsistent/mid-transition row", async () => {
    const chain = await makeChain();
    const dep = deployment(chain.slug);
    const rowId = await seedRejectedRow(chain.id, dep, "0xEEE", FALSE_REJECTION_REASON, BEFORE_CUTOFF);
    const [poolRow] = await db.insert(pools).values({ configKey: `discovered:${randomUUID()}`, chainId: chain.id, label: "test pool", address: "0xeee" }).returning({ id: pools.id });
    // An implausible-in-practice but defensively-guarded-against state: a
    // row that is simultaneously "rejected" AND already linked to a real
    // pools row (e.g. a hand-edited row, or a future bug elsewhere).
    await db.update(discoveredPools).set({ poolId: poolRow.id }).where(eq(discoveredPools.id, rowId));

    const result = await resetFalseRejections([{ chainSlug: chain.slug, poolAddress: "0xEEE" }]);

    expect(result).toEqual({ requested: 1, reset: 0, skippedAlreadyResolved: 0, skippedNotFound: 0, skippedSignatureMismatch: 1 });
    const after = await statusOf(rowId);
    expect(after.status).toBe("rejected"); // untouched
  });

  it("gracefully skips (never throws) an allowlist entry naming an untracked chain", async () => {
    const result = await resetFalseRejections([{ chainSlug: `untracked-chain-${randomUUID()}`, poolAddress: "0xAAA" }]);
    expect(result).toEqual({ requested: 1, reset: 0, skippedAlreadyResolved: 0, skippedNotFound: 1, skippedSignatureMismatch: 0 });
  });

  it("gracefully skips (never throws) an allowlist entry naming a pool address with no matching discovered_pools row", async () => {
    const chain = await makeChain();
    const result = await resetFalseRejections([{ chainSlug: chain.slug, poolAddress: "0xnonexistent" }]);
    expect(result).toEqual({ requested: 1, reset: 0, skippedAlreadyResolved: 0, skippedNotFound: 1, skippedSignatureMismatch: 0 });
  });

  it("an empty allowlist is a true no-op - never queries or touches anything", async () => {
    const result = await resetFalseRejections([]);
    expect(result).toEqual({ requested: 0, reset: 0, skippedAlreadyResolved: 0, skippedNotFound: 0, skippedSignatureMismatch: 0 });
  });
});
