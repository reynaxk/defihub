import type { Metadata } from "next";
import Link from "next/link";
import { Bell, Star } from "lucide-react";
import { EntityLogo } from "@/components/shared/entity-logo";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth/config";
import { getWatchlistWithDetails } from "@/lib/database/queries/watchlist";
import { db } from "@/lib/database/client";
import { alerts } from "@/lib/database/schema";
import { eq } from "drizzle-orm";
import { formatUsd } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await auth();
  const userId = session!.user.id;

  const [watchlist, userAlerts] = await Promise.all([
    getWatchlistWithDetails(userId),
    db.select().from(alerts).where(eq(alerts.userId, userId)),
  ]);

  const enabledAlerts = userAlerts.filter((a) => a.enabled);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-1 text-muted-foreground">Welcome back{session?.user.name ? `, ${session.user.name}` : ""}.</p>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <Star className="size-4" /> Watchlist
        </h2>
      </div>

      {watchlist.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing watched yet. Star a protocol or chain to track it here.
        </p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {watchlist.map((item) => (
            <Link
              key={item.id}
              href={item.kind === "protocol" ? `/protocol/${item.slug}` : `/chain/${item.slug}`}
              className="flex items-center justify-between rounded-lg border border-border bg-card p-3 hover:border-primary/40"
            >
              <div className="flex items-center gap-2">
                <EntityLogo src={item.logoUrl} name={item.name} size={28} />
                <span className="font-medium">{item.name}</span>
              </div>
              <span className="tabular-nums text-muted-foreground">{formatUsd(item.tvl)}</span>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-10 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <Bell className="size-4" /> Alerts
        </h2>
        <Button variant="outline" size="sm" render={<Link href="/alerts">Manage alerts</Link>} />
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {enabledAlerts.length} active alert{enabledAlerts.length === 1 ? "" : "s"} out of {userAlerts.length} total.
      </p>
    </div>
  );
}
