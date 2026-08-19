"use client";

import { useState } from "react";
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
  // Selecting "Disconnect" can't call disconnect() directly from the item's
  // onClick: that flips isConnected to false and swaps this component's
  // whole returned subtree (the dropdown's trigger button unmounts,
  // replaced by the "Connect Wallet" button below), which can happen before
  // Base UI has finished closing the menu and restoring focus to that same
  // trigger - the DOM node it tries to focus is already gone, silently
  // dropping keyboard/screen-reader focus to document.body. Deferring the
  // actual disconnect to onOpenChangeComplete (fired only after the close
  // animation, and Base UI's own focus restoration, are done) avoids the
  // race. The pending flag distinguishes "closed because Disconnect was
  // clicked" from any other close reason (Escape, outside click), which
  // also fires onOpenChangeComplete(false) but shouldn't disconnect anything.
  const [pendingDisconnect, setPendingDisconnect] = useState(false);

  if (isConnected && address) {
    return (
      <DropdownMenu
        onOpenChangeComplete={(open) => {
          if (!open && pendingDisconnect) {
            setPendingDisconnect(false);
            disconnect();
          }
        }}
      >
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" />}
          aria-label="Wallet menu"
        >
          <WalletIcon className="size-4" />
          {truncateAddress(address)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setPendingDisconnect(true)}>Disconnect</DropdownMenuItem>
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
