import type { Metadata } from "next";
import { Wallet } from "lucide-react";
import { WalletDashboard } from "@/components/wallet/wallet-dashboard";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = { title: "Wallet", robots: NOINDEX };

export default function WalletPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <Wallet className="size-6" /> Wallet
      </h1>
      <p className="mt-1 text-muted-foreground">
        Connect a browser wallet to check balances across supported chains.
      </p>

      <WalletDashboard />
    </div>
  );
}
