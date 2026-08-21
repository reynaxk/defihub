import type { Metadata } from "next";
import { Wallet } from "lucide-react";
import { WalletDashboard } from "@/components/wallet/wallet-dashboard";
import { requireSession } from "@/lib/auth/require-session";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = { title: "Wallet", robots: NOINDEX };

export default async function WalletPage() {
  await requireSession();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="border-b border-border/60 pb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Wallet className="size-6 text-primary" /> Wallet
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a browser wallet to check balances across supported chains.
        </p>
      </div>

      <WalletDashboard />
    </div>
  );
}
