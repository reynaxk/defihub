import { formatUnits, parseAbi, parseUnits } from "viem";
import { db } from "@/lib/database/client";
import { onchainVerifications, protocols, chains } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { VIEM_CHAIN_BY_SLUG } from "@/lib/chains/rpc-client";
import { confirmationsFor } from "@/lib/chains/confirmations";
import { withResilientClient } from "@/lib/chains/rpc-resilient-client";
import { VERIFIED_PROTOCOL_TVLS, type VerifiedProtocolTvl } from "./config";
import { priceToExactDecimalString, roundExactDecimal } from "./verify-pool";

// Phase 5.8 fix: same generous fixed-point scale as verify-pool.ts's
// computePoolTvl, declared as its own local copy rather than imported -
// each calculation module in this codebase owns its own copy of this
// constant (see uniswap-v2.ts's own comment for why: a future change to
// one calculation kind's precision must never silently affect an
// unrelated one).
const CALCULATION_SCALE = 30;
const SCALE_FACTOR = BigInt(10) ** BigInt(CALCULATION_SCALE);

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

export type ProtocolTvlComputationResult = { ok: true; tvlUsd: string } | { ok: false; error: string };

// Pure - the actual "raw on-chain amount + decimals + USD price -> TVL"
// math, split out from readOne (below) so it's directly unit-testable with
// plain BigInts, no RPC involved - mirroring the same split verify-pool.ts's
// own computePoolTvl already establishes for the identical reason. Phase
// 5.8 fix: this replaces an earlier `(Number(rawAmount) / 10 **
// entry.decimals) * price` implementation, the exact anti-pattern
// computePoolTvl was rewritten to avoid - Number() silently loses precision
// for any raw amount beyond Number.MAX_SAFE_INTEGER (2^53 ~= 9.007e15),
// which a real 18-decimal token balance worth even a few cents already
// exceeds, and that earlier version had zero test coverage of its own
// tvlUsd output, only of rescaleByPow10 - see this file's own test suite
// for the precision-regression tests that would have caught it. Every step
// here is exact BigInt/fixed-point arithmetic: rawAmount is rescaled to
// CALCULATION_SCALE, the provider's floating-point price is converted to an
// exact decimal string exactly once (priceToExactDecimalString,
// verify-pool.ts - the same unavoidable number->string boundary
// computePoolTvl's own caller already establishes), and the result stays an
// exact decimal string throughout.
export function computeProtocolTvlUsd(rawAmount: bigint, decimals: number, priceUsd: number): ProtocolTvlComputationResult {
  if (decimals > CALCULATION_SCALE) {
    return { ok: false, error: `unsupported decimals: ${decimals} exceeds this calculation's ${CALCULATION_SCALE}-decimal scale` };
  }
  const rawAmountAtScale = rawAmount * BigInt(10) ** BigInt(CALCULATION_SCALE - decimals);
  const priceAtScale = parseUnits(priceToExactDecimalString(priceUsd), CALCULATION_SCALE);
  const usdValueAtScale = (rawAmountAtScale * priceAtScale) / SCALE_FACTOR;
  return { ok: true, tvlUsd: formatUnits(usdValueAtScale, CALCULATION_SCALE) };
}

async function readOne(
  entry: VerifiedProtocolTvl,
  priceById: Map<string, number>,
): Promise<{ key: string; ok: boolean; error?: string; tvlUsd?: string; blockNumber?: bigint }> {
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

    const computation = computeProtocolTvlUsd(rawAmount, entry.decimals, price);
    if (!computation.ok) return { key: entry.key, ok: false, error: `${computation.error} (${entry.key})` };
    return { key: entry.key, ok: true, tvlUsd: computation.tvlUsd, blockNumber };
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
    // roundExactDecimal, not .toFixed(2) - tvlUsd is now an exact decimal
    // string (see readOne's own comment), and .toFixed(2) would force it
    // back through a floating-point Number, discarding the exactness this
    // fix exists to preserve.
    const tvlUsd = roundExactDecimal(outcome.tvlUsd!, 2);
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
