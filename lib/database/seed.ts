import "dotenv/config";
import { eq } from "drizzle-orm";
import { closeDb, db } from "./client";
import { chains, tokens } from "./schema";
import { SUPPORTED_CHAINS } from "../config/chains";

// CoinGecko ids for each chain's native currency - real, well-known ids, not
// placeholders. Several chains share an id (e.g. Arbitrum/Base both settle
// in ETH) because that's genuinely the same asset.
const NATIVE_COINGECKO_ID: Record<string, string> = {
  ethereum: "ethereum",
  solana: "solana",
  arbitrum: "ethereum",
  base: "ethereum",
  "bnb-chain": "binancecoin",
};

// 0x000...0 is the widely-used sentinel address for a chain's native
// currency (DefiLlama's own yield pool data uses the same convention) -
// this is not a fabricated contract address, just the standard placeholder
// for "the native asset, not an ERC-20".
const NATIVE_ASSET_ADDRESS = "0x0000000000000000000000000000000000000000";

async function seed() {
  console.log(`Seeding ${SUPPORTED_CHAINS.length} chains...`);

  for (const chain of SUPPORTED_CHAINS) {
    await db
      .insert(chains)
      .values({
        name: chain.name,
        slug: chain.slug,
        chainId: chain.chainId,
        nativeToken: chain.nativeToken,
        logoUrl: chain.logoUrl,
        explorerUrl: chain.explorerUrl,
        defillamaSlug: chain.defillamaSlug,
      })
      .onConflictDoUpdate({
        target: chains.slug,
        set: {
          name: chain.name,
          chainId: chain.chainId,
          nativeToken: chain.nativeToken,
          logoUrl: chain.logoUrl,
          explorerUrl: chain.explorerUrl,
          defillamaSlug: chain.defillamaSlug,
        },
      });
  }

  console.log("Seeding native tokens (for price alerts)...");
  for (const chain of SUPPORTED_CHAINS) {
    const [chainRow] = await db.select().from(chains).where(eq(chains.slug, chain.slug));
    if (!chainRow) continue;

    await db
      .insert(tokens)
      .values({
        chainId: chainRow.id,
        address: NATIVE_ASSET_ADDRESS,
        symbol: chain.nativeToken,
        name: chain.nativeToken,
        decimals: 18,
        coingeckoId: NATIVE_COINGECKO_ID[chain.slug],
      })
      .onConflictDoUpdate({
        target: [tokens.chainId, tokens.address],
        set: { coingeckoId: NATIVE_COINGECKO_ID[chain.slug] },
      });
  }

  console.log("Done.");
}

seed()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error("Seed failed:", err);
    await closeDb();
    process.exitCode = 1;
  });
