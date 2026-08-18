"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { walletConfig } from "@/lib/wallet/config";

export function WalletProvider({ children }: { children: ReactNode }) {
  // Created once per client, inside state rather than at module scope - a
  // module-level QueryClient would be shared across requests on the server
  // during SSR, leaking cached data between different users' requests.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
