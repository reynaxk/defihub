import type { Metadata } from "next";
import { EndpointDoc } from "@/components/api-docs/endpoint-doc";

export const metadata: Metadata = {
  title: "API",
  description: "Free, read-only JSON API for ChainScope's protocol, chain and yield data.",
};

export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">API</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Free, read-only JSON endpoints for everything on the site — no API key required yet.
        Rate limited to 60 requests/minute per IP. Responses are cached for 60 seconds
        server-side, matching how often the underlying data actually refreshes.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        CORS is open (<code>Access-Control-Allow-Origin: *</code>) so you can call these
        directly from browser JavaScript. All endpoints are versioned under{" "}
        <code>/api/v1</code>.
      </p>

      <div className="mt-8 flex flex-col gap-6">
        <EndpointDoc
          method="GET"
          path="/api/v1/protocols"
          description="List protocols on supported chains, sorted by TVL descending."
          params={[
            { name: "page", type: "number", description: "1-indexed page number (default 1)" },
            { name: "pageSize", type: "number", description: "Results per page, max 100 (default 50)" },
            { name: "category", type: "string", description: "Filter to an exact category, e.g. Lending" },
            { name: "chain", type: "string", description: "Filter to a chain slug, e.g. ethereum" },
            { name: "q", type: "string", description: "Case-insensitive name search" },
          ]}
          exampleResponse={`{
  "data": [
    {
      "id": "5f2e...",
      "name": "Aave V3",
      "slug": "aave-v3",
      "logoUrl": "https://icons.llamao.fi/icons/protocols/aave-v3",
      "category": "Lending",
      "tvl": 14150000000,
      "volume24h": null,
      "fees24h": 989380,
      "revenue24h": 137480
    }
  ],
  "pagination": { "page": 1, "pageSize": 50, "total": 2967, "totalPages": 60 }
}`}
        />

        <EndpointDoc
          method="GET"
          path="/api/v1/protocols/{slug}"
          description="A single protocol's detail, including its full TVL/fees/revenue/volume history."
          params={[{ name: "slug", type: "string", description: "Protocol slug, e.g. aave-v3", required: true }]}
          exampleResponse={`{
  "data": {
    "name": "Aave V3",
    "slug": "aave-v3",
    "description": "Earn interest, borrow assets, and build applications",
    "website": "https://aave.com",
    "category": "Lending",
    "chains": ["ethereum", "arbitrum", "base"],
    "current": { "timestamp": "2026-08-16T00:00:00.000Z", "tvl": 14150000000, "fees24h": 989380, "revenue24h": 137480 },
    "history": [{ "timestamp": "2026-08-15T00:00:00.000Z", "tvl": 14020000000 }, "..."]
  }
}`}
        />

        <EndpointDoc
          method="GET"
          path="/api/v1/chains"
          description="List all supported chains, sorted by TVL descending."
          exampleResponse={`{
  "data": [
    { "id": "8a1c...", "name": "Ethereum", "slug": "ethereum", "nativeToken": "ETH", "tvl": 41110000000 },
    { "id": "9b2d...", "name": "BNB Chain", "slug": "bnb-chain", "nativeToken": "BNB", "tvl": 4890000000 }
  ]
}`}
        />

        <EndpointDoc
          method="GET"
          path="/api/v1/chains/{slug}"
          description="A single chain's detail: current TVL, full historical TVL series, and its top protocols."
          params={[{ name: "slug", type: "string", description: "Chain slug, e.g. ethereum", required: true }]}
          exampleResponse={`{
  "data": {
    "name": "Ethereum",
    "slug": "ethereum",
    "nativeToken": "ETH",
    "chainId": 1,
    "tvl": 41110000000,
    "topProtocols": [{ "name": "Binance CEX", "slug": "binance-cex", "tvl": 62060000000 }, "..."],
    "history": [{ "timestamp": "2017-09-27T00:00:00.000Z", "tvl": 0 }, "..."]
  }
}`}
        />

        <EndpointDoc
          method="GET"
          path="/api/v1/yields"
          description="Yield pools with at least $10K TVL, sorted by APY descending."
          params={[
            { name: "chain", type: "string", description: "Filter to a chain slug" },
            { name: "stable", type: "1 | 0", description: "Set to 1 to show stablecoin pools only" },
            { name: "minApy", type: "number", description: "Minimum APY percentage" },
          ]}
          exampleResponse={`{
  "data": [
    {
      "id": "747c1d2a-...",
      "symbol": "STETH",
      "apy": 2.144,
      "tvlUsd": 17863335831,
      "stablecoin": false,
      "chainName": "Ethereum",
      "protocolName": "Lido"
    }
  ]
}`}
        />
      </div>
    </div>
  );
}
