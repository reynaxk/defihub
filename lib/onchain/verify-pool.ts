import { eq } from "drizzle-orm";
import { erc20Abi, type Address } from "viem";
import { db } from "@/lib/database/client";
import { onchainVerifications, protocols, chains } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { VERIFIED_POOLS, type VerifiedPool } from "./config";

export interface OnchainVerificationResult {
  key: string;
  label: string;
  poolAddress: string;
  tvlUsd: number;
  blockNumber: number;
  verifiedAt: Date;
  chainSlug: string;
  chainName: string;
  explorerUrl: string | null;
}

export async function getVerificationsForProtocol(
  protocolId: string,
): Promise<OnchainVerificationResult[]> {
  const rows = await db
    .select({
      key: onchainVerifications.key,
      label: onchainVerifications.label,
      poolAddress: onchainVerifications.poolAddress,
      tvlUsd: onchainVerifications.tvlUsd,
      blockNumber: onchainVerifications.blockNumber,
      verifiedAt: onchainVerifications.verifiedAt,
      chainSlug: chains.slug,
      chainName: chains.name,
      explorerUrl: chains.explorerUrl,
    })
    .from(onchainVerifications)
    .innerJoin(chains, eq(chains.id, onchainVerifications.chainId))
    .where(eq(onchainVerifications.protocolId, protocolId));

  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    poolAddress: r.poolAddress,
    tvlUsd: Number(r.tvlUsd),
    blockNumber: Number(r.blockNumber),
    verifiedAt: r.verifiedAt,
    chainSlug: r.chainSlug,
    chainName: r.chainName,
    explorerUrl: r.explorerUrl,
  }));
}

interface PoolOutcome {
  key: string;
  ok: boolean;
  error?: string;
  tvlUsd?: number;
  blockNumber?: bigint;
}

/**
 * Verifies every pool on a single chain in one batched round-trip: one
 * multicall covering every pool-token balanceOf read on this chain, plus one
 * getBlockNumber. Mirrors the batching pattern already verified working for
 * the wallet balances route (app/api/wallet/balances/route.ts).
 */
async function verifyPoolsOnChain(
  chainSlug: string,
  pools: VerifiedPool[],
  priceById: Map<string, number>,
): Promise<PoolOutcome[]> {
  if (!VIEM_CHAIN_BY_SLUG.has(chainSlug)) {
    return pools.map((p) => ({
      key: p.key,
      ok: false,
      error: `no RPC configured for chain "${chainSlug}"`,
    }));
  }

  const calls = pools.flatMap((pool) =>
    pool.tokens.map((token) => ({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [pool.poolAddress as Address],
    })),
  );

  // Fetched first and passed explicitly to multicall's `blockNumber` option
  // (confirmed supported - viem's multicall/readContract params both derive
  // from CallParameters, which includes it) rather than fetching the block
  // number and the balances concurrently: two independent JSON-RPC calls
  // racing each other can land on different blocks if one is mined in
  // between, which would make the stored blockNumber not actually
  // correspond to the state that produced tvlUsd - the whole point of
  // persisting it. Pinning both to one explicit height keeps them
  // consistent, at the cost of one extra sequential round trip.
  //
  // Destructured inline (rather than pre-declared with an explicit type)
  // so viem's multicall return type is inferred from this exact call's
  // `contracts` argument - annotating the variable ahead of time via
  // `Awaited<ReturnType<typeof client.multicall>>` resolves the generic
  // with no argument context and collapses each result to `{}`.
  //
  // Both calls run inside one withResilientClient invocation so a retry/
  // failover restarts them together against the same provider - the block
  // number and the multicall it pins must always come from the same chain
  // read, never a getBlockNumber from one provider paired with a multicall
  // retried against another.
  const chainRead = await withResilientClient(chainSlug, async (client) => {
    const blockNumber = await client.getBlockNumber();
    const multicallResults = await client.multicall({ contracts: calls, blockNumber });
    return [multicallResults, blockNumber] as const;
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    return { chainReadError: message } as const;
  });

  if ("chainReadError" in chainRead) {
    return pools.map((p) => ({ key: p.key, ok: false, error: `chain read failed: ${chainRead.chainReadError}` }));
  }
  const [multicallResults, blockNumber] = chainRead;

  const outcomes: PoolOutcome[] = [];
  let offset = 0;
  for (const pool of pools) {
    const slice = multicallResults.slice(offset, offset + pool.tokens.length);
    offset += pool.tokens.length;

    const failedToken = pool.tokens.find((_, i) => slice[i]?.status !== "success");
    if (failedToken) {
      outcomes.push({
        key: pool.key,
        ok: false,
        error: `balance read failed for ${failedToken.symbol}`,
      });
      continue;
    }

    let tvlUsd = 0;
    let missingPriceSymbol: string | undefined;
    for (let i = 0; i < pool.tokens.length; i++) {
      const token = pool.tokens[i];
      const price = priceById.get(token.coingeckoId);
      if (price == null) {
        missingPriceSymbol = token.symbol;
        break;
      }
      const balance = slice[i].result as bigint;
      tvlUsd += (Number(balance) / 10 ** token.decimals) * price;
    }

    if (missingPriceSymbol) {
      outcomes.push({ key: pool.key, ok: false, error: `missing USD price for ${missingPriceSymbol}` });
      continue;
    }

    outcomes.push({ key: pool.key, ok: true, tvlUsd, blockNumber });
  }

  return outcomes;
}

export async function verifyAllPools(): Promise<{ key: string; ok: boolean; error?: string }[]> {
  if (VERIFIED_POOLS.length === 0) return [];

  const [protocolRows, chainRows] = await Promise.all([
    db.select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug }).from(protocols),
    db.select({ id: chains.id, slug: chains.slug }).from(chains),
  ]);
  const protocolIdBySlug = new Map(protocolRows.map((p) => [p.defillamaSlug, p.id]));
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  const uniqueCoingeckoIds = [...new Set(VERIFIED_POOLS.flatMap((p) => p.tokens.map((t) => t.coingeckoId)))];
  let priceById: Map<string, number>;
  try {
    const prices = await priceProvider.getPrices(uniqueCoingeckoIds);
    priceById = new Map(prices.map((p) => [p.id, p.priceUsd]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return VERIFIED_POOLS.map((p) => ({ key: p.key, ok: false, error: `price lookup failed: ${message}` }));
  }

  const poolsByChain = new Map<string, VerifiedPool[]>();
  for (const pool of VERIFIED_POOLS) {
    const list = poolsByChain.get(pool.chainSlug) ?? [];
    list.push(pool);
    poolsByChain.set(pool.chainSlug, list);
  }

  const perChainOutcomes = await Promise.all(
    [...poolsByChain.entries()].map(([chainSlug, pools]) => verifyPoolsOnChain(chainSlug, pools, priceById)),
  );
  const outcomeByKey = new Map(perChainOutcomes.flat().map((o) => [o.key, o]));

  const results: { key: string; ok: boolean; error?: string }[] = [];
  for (const pool of VERIFIED_POOLS) {
    const outcome = outcomeByKey.get(pool.key);
    if (!outcome || !outcome.ok) {
      results.push({ key: pool.key, ok: false, error: outcome?.error ?? "no result" });
      continue;
    }

    const chainId = chainIdBySlug.get(pool.chainSlug);
    if (!chainId) {
      results.push({ key: pool.key, ok: false, error: `chain "${pool.chainSlug}" not found in DB` });
      continue;
    }

    const protocolId = protocolIdBySlug.get(pool.protocolDefillamaSlug) ?? null;
    const tvlUsd = outcome.tvlUsd!.toFixed(2);
    const blockNumber = String(outcome.blockNumber!);

    try {
      await db
        .insert(onchainVerifications)
        .values({ key: pool.key, protocolId, chainId, label: pool.label, poolAddress: pool.poolAddress, tvlUsd, blockNumber })
        .onConflictDoUpdate({
          target: onchainVerifications.key,
          set: { protocolId, chainId, tvlUsd, blockNumber, verifiedAt: new Date() },
        });
      results.push({ key: pool.key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: pool.key, ok: false, error: message });
    }
  }

  return results;
}
