import { createConfig, http, injected } from "wagmi";
import { EVM_CHAINS, VIEM_CHAINS, rpcUrlFor } from "@/lib/chains/rpc-client";

export const walletConfig = createConfig({
  chains: VIEM_CHAINS,
  connectors: [injected()],
  transports: Object.fromEntries(EVM_CHAINS.map((c) => [c.chainId, http(rpcUrlFor(c.slug))])),
});
