"use client";

import { useEffect, useRef, useState } from "react";
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

// sessionStorage, not a React ref, carries the "we just disconnected, focus
// the replacement button once it exists" signal across to the effect below.
// Confirmed live (real browser, not just reasoned about) that a plain ref
// isn't reliable here: this page also renders wallet balances, which are
// inherently client-only and can never match the server-rendered HTML
// (there's no way to know a browser wallet's contents during SSR) - the
// resulting hydration-mismatch repair can end up remounting this component
// between the moment disconnect() is called and the moment the effect
// checking for it actually runs, which silently resets a plain useRef back
// to its initial value along with everything else on that fresh instance.
// sessionStorage isn't tied to any particular component instance, so it
// survives that regardless of whether a remount happens.
const DISCONNECT_FOCUS_FLAG = "defihub:wallet-just-disconnected";

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
  // Even with the above fix, Base UI still restores focus to the trigger
  // button right before onOpenChangeComplete fires - and disconnect() then
  // immediately unmounts that same button (swapping in "Connect Wallet"
  // below), losing focus a second time to document.body. The effect below
  // moves focus explicitly to the button that replaces it, once it's
  // actually mounted, gated on DISCONNECT_FOCUS_FLAG (see its own comment
  // for why sessionStorage rather than a ref) rather than leaving that
  // second loss unhandled.
  const connectButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isConnected && sessionStorage.getItem(DISCONNECT_FOCUS_FLAG) === "1") {
      sessionStorage.removeItem(DISCONNECT_FOCUS_FLAG);
      connectButtonRef.current?.focus();
    }
  }, [isConnected]);

  if (isConnected && address) {
    return (
      <DropdownMenu
        onOpenChangeComplete={(open) => {
          if (!open && pendingDisconnect) {
            setPendingDisconnect(false);
            sessionStorage.setItem(DISCONNECT_FOCUS_FLAG, "1");
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
        ref={connectButtonRef}
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
