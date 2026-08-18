import { ShieldCheck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { formatUsd } from "@/lib/format";

interface Verification {
  key: string;
  label: string;
  poolAddress: string;
  tvlUsd: number;
  blockNumber: number;
  verifiedAt: Date;
  chainSlug: string;
  explorerUrl: string | null;
}

export function OnchainVerificationCard({ verifications }: { verifications: Verification[] }) {
  if (verifications.length === 0) return null;

  const chainSlugs = [...new Set(verifications.map((v) => v.chainSlug))];
  const chainLabel = chainSlugs.length === 1 ? chainSlugs[0] : "multiple chains";

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <ShieldCheck className="size-4" />
        Verified on-chain
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Read directly from {chainLabel} via JSON-RPC (token balances of the pool contract), independent
        of the DefiLlama figure above.
      </p>
      <div className="mt-3 space-y-3">
        {verifications.map((v) => (
          <div key={v.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <p className="font-medium">{v.label}</p>
              {v.explorerUrl ? (
                <a
                  href={`${v.explorerUrl}/address/${v.poolAddress}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {v.poolAddress}
                </a>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">{v.poolAddress}</span>
              )}
            </div>
            <div className="text-right">
              <p className="font-medium tabular-nums">{formatUsd(v.tvlUsd)}</p>
              <p className="text-xs text-muted-foreground">
                block {v.blockNumber.toLocaleString("en-US")} · {formatDistanceToNow(v.verifiedAt, { addSuffix: true })}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
