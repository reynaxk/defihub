import { eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { onchainVerifications, protocols } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { ProviderUnavailableError } from "@/lib/providers/types";
import { VERIFIED_POOLS, type VerifiedPool } from "./config";
import { getBlockNumber, getErc20Balance } from "./rpc";

export interface OnchainVerificationResult {
  key: string;
  label: string;
  poolAddress: string;
  tvlUsd: number;
  blockNumber: number;
  verifiedAt: Date;
}

export async function getVerificationsForProtocol(
  protocolId: string,
): Promise<OnchainVerificationResult[]> {
  const rows = await db
    .select()
    .from(onchainVerifications)
    .where(eq(onchainVerifications.protocolId, protocolId));
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    poolAddress: r.poolAddress,
    tvlUsd: Number(r.tvlUsd),
    blockNumber: Number(r.blockNumber),
    verifiedAt: r.verifiedAt,
  }));
}

/**
 * Reads both tokens' raw balances of the pool contract directly from
 * Ethereum, prices them via the existing CoinGecko price provider, and
 * upserts the result. Throws ProviderUnavailableError if the RPC or price
 * provider is unreachable - callers (the worker) should catch and skip.
 */
async function verifyPool(pool: VerifiedPool): Promise<void> {
  const [protocolRow] = await db
    .select({ id: protocols.id })
    .from(protocols)
    .where(eq(protocols.defillamaSlug, pool.protocolDefillamaSlug));

  const [balance0, balance1, blockNumber, prices] = await Promise.all([
    getErc20Balance(pool.token0.address, pool.poolAddress),
    getErc20Balance(pool.token1.address, pool.poolAddress),
    getBlockNumber(),
    priceProvider.getPrices([pool.token0.coingeckoId, pool.token1.coingeckoId]),
  ]);

  const priceById = new Map(prices.map((p) => [p.id, p.priceUsd]));
  const price0 = priceById.get(pool.token0.coingeckoId);
  const price1 = priceById.get(pool.token1.coingeckoId);
  if (price0 == null || price1 == null) {
    throw new ProviderUnavailableError(
      "coingecko",
      `missing USD price for ${pool.token0.symbol} or ${pool.token1.symbol}`,
    );
  }

  const amount0 = Number(balance0) / 10 ** pool.token0.decimals;
  const amount1 = Number(balance1) / 10 ** pool.token1.decimals;
  const tvlUsd = amount0 * price0 + amount1 * price1;

  await db
    .insert(onchainVerifications)
    .values({
      key: pool.key,
      protocolId: protocolRow?.id ?? null,
      label: pool.label,
      poolAddress: pool.poolAddress,
      tvlUsd: tvlUsd.toFixed(2),
      blockNumber: String(blockNumber),
    })
    .onConflictDoUpdate({
      target: onchainVerifications.key,
      set: {
        protocolId: protocolRow?.id ?? null,
        tvlUsd: tvlUsd.toFixed(2),
        blockNumber: String(blockNumber),
        verifiedAt: new Date(),
      },
    });
}

export async function verifyAllPools(): Promise<{ key: string; ok: boolean; error?: string }[]> {
  const results: { key: string; ok: boolean; error?: string }[] = [];
  for (const pool of VERIFIED_POOLS) {
    try {
      await verifyPool(pool);
      results.push({ key: pool.key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: pool.key, ok: false, error: message });
    }
  }
  return results;
}
