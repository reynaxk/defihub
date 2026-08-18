import type { Metadata } from "next";
import { ChainsTable } from "@/components/chains/chains-table";
import { ExportCsvButton } from "@/components/shared/export-csv-button";
import { getTopChains } from "@/lib/database/queries/chains";
import { getWatchedChainIds } from "@/lib/database/queries/watchlist";
import { auth } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Chains",
  description: "Compare total value locked across supported blockchains.",
};

export const revalidate = 300;

export default async function ChainsPage() {
  const [session, chains] = await Promise.all([auth(), getTopChains()]);
  const watchedChainIds = await getWatchedChainIds(
    session?.user?.id,
    chains.map((c) => c.id),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Chains</h1>
          <p className="mt-1 text-muted-foreground">{chains.length} chains tracked</p>
        </div>
        <ExportCsvButton endpoint="/api/export/chains" />
      </div>
      <div className="mt-6">
        <ChainsTable chains={chains} isSignedIn={Boolean(session?.user)} watchedChainIds={watchedChainIds} />
      </div>
    </div>
  );
}
