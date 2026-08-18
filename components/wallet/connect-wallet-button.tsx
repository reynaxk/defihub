"use client";

import { Wallet as WalletIcon } from "lucide-react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ConnectWalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" />}
          aria-label="Wallet menu"
        >
          <WalletIcon className="size-4" />
          {truncateAddress(address)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => disconnect()}>Disconnect</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const injectedConnector = connectors.find((c) => c.type === "injected") ?? connectors[0];
  // wagmi's injected connector rejects with "Provider not found" (its own
  // exact wording, confirmed live against @wagmi/core@3.6.4 rather than
  // assumed) when clicked with no wallet extension installed - shown as-is
  // rather than pre-detecting window.ethereum ourselves beforehand, which
  // would need its own fragile heuristic (an "injected" connector is always
  // registered regardless of whether a real provider exists behind it).
  const noWalletDetected = error?.message.includes("Provider not found");

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        disabled={isPending}
        onClick={() => injectedConnector && connect({ connector: injectedConnector })}
      >
        <WalletIcon className="size-4" />
        {isPending ? "Connecting..." : "Connect Wallet"}
      </Button>
      {noWalletDetected ? (
        <p className="text-sm text-muted-foreground">
          No wallet extension detected. Install{" "}
          <a
            href="https://metamask.io"
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary hover:underline"
          >
            MetaMask
          </a>{" "}
          or a similar browser wallet to connect.
        </p>
      ) : (
        error && <p className="text-sm text-destructive">{error.message}</p>
      )}
    </div>
  );
}
