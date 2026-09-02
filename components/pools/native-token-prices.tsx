import { formatDistanceToNow } from "date-fns";
import { Card } from "@/components/ui/card";
import { NativeSourceBadge } from "@/components/pools/native-source-badge";
import type { NativeTokenPriceDetail } from "@/lib/database/queries/native-pools";
import { formatTokenPrice, formatUsd } from "@/lib/format";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Phase 5.13, Part 13/14: "exactly where did the price used for this
// dollar value come from" made visible per-token, not just at the pool's
// aggregate TVL level - reuses NativeSourceBadge's existing four-way
// vocabulary rather than inventing a second one. `sources` (populated only
// for a NATIVE price) is the same PriceSourceObservation[] the pricing
// engine itself corroborated against (Part 8) - shown as which pools and
// how much liquidity backed this price, not hidden provenance.
export function NativeTokenPrices({ tokens }: { tokens: NativeTokenPriceDetail[] }) {
  if (tokens.length === 0) return null;
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">Token prices</h2>
      <div className="space-y-3">
        {tokens.map((token) => (
          <div key={token.address} className="flex flex-col gap-1 border-b border-border/50 pb-3 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{token.symbol}</span>
                <span className="font-mono text-xs text-muted-foreground">{shortAddress(token.address)}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm tabular-nums">{formatTokenPrice(token.price.value)}</span>
                <NativeSourceBadge source={token.price.source} />
              </div>
            </div>
            {token.price.value != null && (
              <p className="text-xs text-muted-foreground">
                {token.price.confidence ? `${token.price.confidence.toLowerCase()} confidence · ` : ""}
                {token.price.observedAt ? formatDistanceToNow(token.price.observedAt, { addSuffix: true }) : "unknown time"}
                {token.price.blockNumber != null ? ` · block ${token.price.blockNumber.toLocaleString("en-US")}` : ""}
              </p>
            )}
            {token.sources.filter((s) => s.included).length > 0 && (
              <p className="text-xs text-muted-foreground/80">
                corroborated via {token.sources.filter((s) => s.included).length}{" "}
                pool{token.sources.filter((s) => s.included).length === 1 ? "" : "s"}:{" "}
                {token.sources
                  .filter((s) => s.included)
                  .map((s) => `${s.pairedTokenSymbol} (${formatUsd(Number(s.liquidityUsd))} liquidity)`)
                  .join(", ")}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
