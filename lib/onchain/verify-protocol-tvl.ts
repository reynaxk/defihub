import { parseAbi } from "viem";
import { db } from "@/lib/database/client";
import { onchainVerifications, protocols, chains } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { VERIFIED_PROTOCOL_TVLS, type VerifiedProtocolTvl } from "./config";

// Rescales a raw fixed-point amount by 10^exponent in either direction.
// BigInt's own `**` throws a RangeError for a negative exponent (it can't
// represent a fractional result) - a naive `/ BigInt(10) ** BigInt(exponent)`
// would crash for any supply-times-rate entry where supplyDecimals +
// rateDecimals is smaller than the target `decimals` (e.g. a lower-decimals
// supply/rate pair resolving to a higher-decimals asset), rather than
// producing the correct value.
export function rescaleByPow10(amount: bigint, exponent: number): bigint {
  if (exponent === 0) return amount;
  if (exponent > 0) return amount / BigInt(10) ** BigInt(exponent);
  return amount * BigInt(10) ** BigInt(-exponent);
}

async function readOne(
  entry: VerifiedProtocolTvl,
  priceById: Map<string, number>,
): Promise<{ key: string; ok: boolean; error?: string; tvlUsd?: number; blockNumber?: bigint }> {
  if (!VIEM_CHAIN_BY_SLUG.has(entry.chainSlug)) {
    return { key: entry.key, ok: false, error: `no RPC configured for chain "${entry.chainSlug}"` };
  }

  const price = priceById.get(entry.coingeckoId);
  if (price == null) {
    return { key: entry.key, ok: false, error: `missing USD price for ${entry.coingeckoId}` };
  }

  const address = entry.contractAddress as `0x${string}`;

  function functionNameFrom(signature: string): string {
    return signature.split(/[\s(]/)[1];
  }

  try {
    // Both branches' reads run inside one withResilientClient invocation,
    // so a retry/failover restarts the whole sequence against the same
    // provider - blockNumber is fetched first, then passed explicitly to
    // every readContract call below, rather than fetched concurrently with
    // the reads, since two independent JSON-RPC calls racing each other
    // can land on different blocks if one is mined in between, which would
    // make the persisted blockNumber not actually correspond to the state
    // that produced tvlUsd. The two reads in the "supply-times-rate"
    // branch can still run concurrently with each other, since pinning
    // both to the same explicit height keeps them consistent regardless of
    // when each request arrives at the RPC node.
    //
    // Pinned to a confirmation-adjusted height, not the raw head - see
    // lib/onchain/verify-pool.ts for the same reasoning: the head isn't
    // final, and persisting a reorg-orphaned height as provenance means the
    // stored figure can't be reproduced by querying it again.
    const [rawAmount, blockNumber] = await withResilientClient(entry.chainSlug, async (client) => {
      const head = await client.getBlockNumber();
      const confirmations = confirmationsFor(entry.chainSlug);
      const blockNumber = head > confirmations ? head - confirmations : BigInt(0);

      if (entry.read.kind === "direct") {
        const abi = parseAbi([entry.read.functionSignature]);
        const functionName = functionNameFrom(entry.read.functionSignature);
        const rawAmount = (await client.readContract({ address, abi, functionName, blockNumber })) as bigint;
        return [rawAmount, blockNumber] as const;
      }

      const abi = parseAbi([entry.read.supplyFunctionSignature, entry.read.rateFunctionSignature]);
      const [supply, rate] = await Promise.all([
        client.readContract({
          address,
          abi,
          functionName: functionNameFrom(entry.read.supplyFunctionSignature),
          blockNumber,
        }) as Promise<bigint>,
        client.readContract({
          address,
          abi,
          functionName: functionNameFrom(entry.read.rateFunctionSignature),
          blockNumber,
        }) as Promise<bigint>,
      ]);
      // supply is fixed-point at supplyDecimals places, rate at
      // rateDecimals places (e.g. both 1e18) - their product is fixed-point
      // at (supplyDecimals + rateDecimals) places, which needs rescaling to
      // `decimals` places (the resolved unit's own decimals, e.g. ETH's 18)
      // before it's in the same fixed-point units as a "direct" read. These
      // are three independently-specified quantities that only coincide by
      // convention for an 18-decimal-everywhere case like ETH - conflating
      // them into a single divisor would silently produce a wildly wrong
      // figure for any entry where they don't all match (e.g. an
      // 18-decimal supply/rate pair resolving to a 6-decimal asset). The
      // scale delta can be negative (a lower-precision supply/rate pair
      // resolving to a higher-decimals asset) - rescaleByPow10 handles
      // that direction too, rather than assuming it's always a division.
      const rawAmount = rescaleByPow10(
        supply * rate,
        entry.read.supplyDecimals + entry.read.rateDecimals - entry.decimals,
      );
      return [rawAmount, blockNumber] as const;
    });

    const tvlUsd = (Number(rawAmount) / 10 ** entry.decimals) * price;
    return { key: entry.key, ok: true, tvlUsd, blockNumber };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { key: entry.key, ok: false, error: `chain read failed: ${message}` };
  }
}

export async function verifyAllProtocolTvls(): Promise<{ key: string; ok: boolean; error?: string }[]> {
  if (VERIFIED_PROTOCOL_TVLS.length === 0) return [];

  const [protocolRows, chainRows] = await Promise.all([
    db.select({ id: protocols.id, defillamaSlug: protocols.defillamaSlug }).from(protocols),
    db.select({ id: chains.id, slug: chains.slug }).from(chains),
  ]);
  const protocolIdBySlug = new Map(protocolRows.map((p) => [p.defillamaSlug, p.id]));
  const chainIdBySlug = new Map(chainRows.map((c) => [c.slug, c.id]));

  const uniqueCoingeckoIds = [...new Set(VERIFIED_PROTOCOL_TVLS.map((e) => e.coingeckoId))];
  let priceById: Map<string, number>;
  try {
    const prices = await priceProvider.getPrices(uniqueCoingeckoIds);
    priceById = new Map(prices.map((p) => [p.id, p.priceUsd]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return VERIFIED_PROTOCOL_TVLS.map((e) => ({ key: e.key, ok: false, error: `price lookup failed: ${message}` }));
  }

  const outcomes = await Promise.all(VERIFIED_PROTOCOL_TVLS.map((entry) => readOne(entry, priceById)));

  const results: { key: string; ok: boolean; error?: string }[] = [];
  for (const entry of VERIFIED_PROTOCOL_TVLS) {
    const outcome = outcomes.find((o) => o.key === entry.key);
    if (!outcome || !outcome.ok) {
      results.push({ key: entry.key, ok: false, error: outcome?.error ?? "no result" });
      continue;
    }

    const chainId = chainIdBySlug.get(entry.chainSlug);
    if (!chainId) {
      results.push({ key: entry.key, ok: false, error: `chain "${entry.chainSlug}" not found in DB` });
      continue;
    }

    const protocolId = protocolIdBySlug.get(entry.protocolDefillamaSlug) ?? null;
    const tvlUsd = outcome.tvlUsd!.toFixed(2);
    const blockNumber = String(outcome.blockNumber!);

    try {
      await db
        .insert(onchainVerifications)
        .values({
          key: entry.key,
          protocolId,
          chainId,
          label: entry.label,
          poolAddress: entry.contractAddress,
          tvlUsd,
          blockNumber,
        })
        .onConflictDoUpdate({
          target: onchainVerifications.key,
          set: { protocolId, chainId, tvlUsd, blockNumber, verifiedAt: new Date() },
        });
      results.push({ key: entry.key, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ key: entry.key, ok: false, error: message });
    }
  }

  return results;
}
