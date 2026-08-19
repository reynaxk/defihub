import { createPublicClient, http, parseAbi } from "viem";
import { db } from "@/lib/database/client";
import { onchainVerifications, protocols, chains } from "@/lib/database/schema";
import { priceProvider } from "@/lib/providers";
import { VIEM_CHAIN_BY_SLUG, rpcUrlFor } from "@/lib/chains/rpc-client";
import { VERIFIED_PROTOCOL_TVLS, type VerifiedProtocolTvl } from "./config";

async function readOne(
  entry: VerifiedProtocolTvl,
  priceById: Map<string, number>,
): Promise<{ key: string; ok: boolean; error?: string; tvlUsd?: number; blockNumber?: bigint }> {
  const viemChain = VIEM_CHAIN_BY_SLUG.get(entry.chainSlug);
  if (!viemChain) {
    return { key: entry.key, ok: false, error: `no RPC configured for chain "${entry.chainSlug}"` };
  }

  const price = priceById.get(entry.coingeckoId);
  if (price == null) {
    return { key: entry.key, ok: false, error: `missing USD price for ${entry.coingeckoId}` };
  }

  const client = createPublicClient({ chain: viemChain, transport: http(rpcUrlFor(entry.chainSlug)) });
  const address = entry.contractAddress as `0x${string}`;

  function functionNameFrom(signature: string): string {
    return signature.split(/[\s(]/)[1];
  }

  try {
    let rawAmount: bigint;
    let blockNumber: bigint;

    // blockNumber is fetched first, then passed explicitly to every
    // readContract call below, rather than fetching it concurrently with
    // the reads - two independent JSON-RPC calls racing each other can land
    // on different blocks if one is mined in between, which would make the
    // persisted blockNumber not actually correspond to the state that
    // produced tvlUsd. The two reads in the "supply-times-rate" branch can
    // still run concurrently with each other, since pinning both to the
    // same explicit height keeps them consistent regardless of when each
    // request arrives at the RPC node.
    if (entry.read.kind === "direct") {
      const abi = parseAbi([entry.read.functionSignature]);
      const functionName = functionNameFrom(entry.read.functionSignature);
      blockNumber = await client.getBlockNumber();
      rawAmount = (await client.readContract({ address, abi, functionName, blockNumber })) as bigint;
    } else {
      const abi = parseAbi([entry.read.supplyFunctionSignature, entry.read.rateFunctionSignature]);
      blockNumber = await client.getBlockNumber();
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
      // Both values are fixed-point at `decimals` places (e.g. 1e18), so the
      // raw product needs one factor's worth of scale divided back out
      // before it's in the same fixed-point units as a "direct" read.
      rawAmount = (supply * rate) / BigInt(10) ** BigInt(entry.decimals);
    }

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
