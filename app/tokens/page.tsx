import type { Metadata } from "next";
import { TokensTable } from "@/components/tokens/tokens-table";
import { TokenFilters } from "@/components/tokens/token-filters";
import { getTokensList, type TokenSort } from "@/lib/database/queries/tokens";
import { getAllChains } from "@/lib/database/queries/chains";

export const metadata: Metadata = {
  title: "Tokens",
  description: "Top tokens by market cap across supported chains, with live prices.",
};

export const revalidate = 300;

const VALID_SORTS: TokenSort[] = ["marketCap", "price", "volume24h"];

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const sort = VALID_SORTS.includes(params.sort as TokenSort) ? (params.sort as TokenSort) : "marketCap";

  const [tokens, chains] = await Promise.all([
    getTokensList({ chainSlug: params.chain, sort }),
    getAllChains(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Tokens</h1>
      <p className="mt-1 text-muted-foreground">
        {tokens.length} tokens tracked across supported chains, ranked by {sort === "price" ? "price" : sort === "volume24h" ? "24h volume" : "market cap"}
      </p>

      <div className="mt-6">
        <TokenFilters chains={chains} />
      </div>

      <div className="mt-4">
        <TokensTable tokens={tokens} />
      </div>
    </div>
  );
}
