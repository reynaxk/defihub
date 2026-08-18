"use client";

import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { EntityLogo } from "@/components/shared/entity-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectWalletButton } from "@/components/wallet/connect-wallet-button";

interface TokenBalance {
  symbol: string;
  address: string;
  logoUrl: string | null;
  balance: string;
}

interface ChainBalanceResult {
  chainSlug: string;
  chainName: string;
  nativeToken: string;
  nativeBalance: string;
  tokenBalances: TokenBalance[];
}

interface ChainBalanceError {
  chainSlug: string;
  chainName: string;
  error: string;
}

type ChainResult = ChainBalanceResult | ChainBalanceError;

function isError(chain: ChainResult): chain is ChainBalanceError {
  return "error" in chain;
}

async function fetchBalances(address: string): Promise<{ address: string; chains: ChainResult[] }> {
  const res = await fetch(`/api/wallet/balances?address=${address}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Couldn't load wallet balances");
  }
  return res.json();
}

function ChainCard({ chain }: { chain: ChainResult }) {
  if (isError(chain)) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="font-medium">{chain.chainName}</p>
        <p className="mt-1 text-sm text-destructive">{chain.error}</p>
      </div>
    );
  }

  const hasAnyBalance = Number(chain.nativeBalance) > 0 || chain.tokenBalances.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="font-medium">{chain.chainName}</p>
      {!hasAnyBalance ? (
        <p className="mt-1 text-sm text-muted-foreground">No balance found on this chain.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {Number(chain.nativeBalance) > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{chain.nativeToken}</span>
              <span className="tabular-nums font-medium">{chain.nativeBalance}</span>
            </div>
          )}
          {chain.tokenBalances.map((token) => (
            <div key={token.address} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <EntityLogo src={token.logoUrl} name={token.symbol} size={16} />
                {token.symbol}
              </span>
              <span className="tabular-nums font-medium">{token.balance}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WalletDashboard() {
  const { address, isConnected } = useAccount();

  const { data, isLoading, error } = useQuery({
    queryKey: ["wallet-balances", address],
    queryFn: () => fetchBalances(address!),
    enabled: isConnected && !!address,
  });

  if (!isConnected) {
    return (
      <div className="mt-6 flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          Connect a wallet to see its balances for the tokens DeFiHub tracks, across the 7 EVM chains
          this app supports.
        </p>
        <ConnectWalletButton />
      </div>
    );
  }

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing balances for tokens DeFiHub tracks only - not a full portfolio view.
        </p>
        <ConnectWalletButton />
      </div>

      {isLoading && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error instanceof Error ? error.message : "Couldn't load wallet balances"}
        </p>
      )}

      {data && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.chains.map((chain) => (
            <ChainCard key={chain.chainSlug} chain={chain} />
          ))}
        </div>
      )}
    </div>
  );
}
