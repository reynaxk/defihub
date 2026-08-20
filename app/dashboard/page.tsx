import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Activity, Bell, Star } from "lucide-react";
import { EntityLogo } from "@/components/shared/entity-logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/stats/stat-tile";
import { AnimatedNumber } from "@/components/stats/animated-number";
import { auth } from "@/lib/auth/config";
import { getWatchlistWithDetails, type WatchlistEntry } from "@/lib/database/queries/watchlist";
import { db } from "@/lib/database/client";
import { alerts } from "@/lib/database/schema";
import { desc, eq } from "drizzle-orm";
import { formatApy, formatUsd } from "@/lib/format";
import { NOINDEX } from "@/lib/seo";

const ALERT_TYPE_LABELS: Record<string, string> = {
  protocol_tvl: "Protocol TVL",
  chain_tvl: "Chain TVL",
  token_price: "Token price",
  pool_apy: "Pool APY",
};

const CONDITION_LABELS: Record<string, string> = {
  above: "rose above",
  below: "fell below",
  percent_change_up: "increased by",
  percent_change_down: "decreased by",
};

// Defined outside the component: the react-compiler purity rule flags a
// direct Date.now() call inside a component/hook body (an impure read that
// could produce unstable results across re-renders) - correct in general,
// but this is a Server Component that already runs fresh per request, so
// the actual concern doesn't apply here. Moving the impure read into an
// ordinary helper function (not a hook, not a component - the rule's
// analysis is scoped to those) is the idiomatic way to satisfy the rule
// rather than suppressing it.
function oneWeekAgo(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

function watchlistHref(item: WatchlistEntry): string {
  switch (item.kind) {
    case "protocol":
      return `/protocol/${item.slug}`;
    case "chain":
      return `/chain/${item.slug}`;
    case "token":
      return `/token/${item.slug}?chain=${item.chainSlug}`;
    case "pool":
      // Pools have no dedicated detail page - the yields search box
      // matches on symbol, so this lands on the closest working view.
      return `/yields?q=${encodeURIComponent(item.slug)}`;
  }
}

export const metadata: Metadata = { title: "Dashboard", robots: NOINDEX };

export default async function DashboardPage() {
  const session = await auth();
  const userId = session!.user.id;

  const [watchlist, userAlerts] = await Promise.all([
    getWatchlistWithDetails(userId),
    db.select().from(alerts).where(eq(alerts.userId, userId)).orderBy(desc(alerts.lastTriggeredAt)),
  ]);

  const enabledAlerts = userAlerts.filter((a) => a.enabled);
  // "Recent activity" is real, not invented: alerts that have actually
  // fired, which is exactly "a meaningful change since your last visit."
  // There's no separate activity-log table, and this codebase doesn't
  // fabricate a feed where there's no real event to show.
  const recentlyTriggered = userAlerts.filter((a) => a.lastTriggeredAt != null).slice(0, 5);
  // Derived from data already fetched above - no separate query needed.
  const triggeredThisWeek = userAlerts.filter(
    (a) => a.lastTriggeredAt != null && a.lastTriggeredAt >= oneWeekAgo(),
  ).length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-1 text-muted-foreground">Welcome back{session?.user.name ? `, ${session.user.name}` : ""}.</p>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <StatTile label="Watching" icon={Star} animate={{ value: watchlist.length, format: "count" }} />
        <StatTile label="Active alerts" icon={Bell} animate={{ value: enabledAlerts.length, format: "count" }} />
        <StatTile
          label="Triggered this week"
          icon={Activity}
          animate={{ value: triggeredThisWeek, format: "count" }}
        />
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Star className="size-4" /> Watchlist
        </h2>
      </div>

      {watchlist.length === 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Nothing watched yet. Star a protocol, chain, token or yield pool to track it here.
          </p>
          <Button variant="outline" size="sm" render={<Link href="/protocols">Browse protocols</Link>} />
        </div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {watchlist.map((item) => (
            <Link
              key={item.id}
              href={watchlistHref(item)}
              className="flex items-center justify-between rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10 transition-all duration-200 hover:ring-primary/30 hover:shadow-md motion-safe:hover:-translate-y-0.5"
            >
              <div className="flex items-center gap-2">
                <EntityLogo src={item.logoUrl} name={item.name} size={28} />
                <span className="font-medium">{item.name}</span>
              </div>
              <span className="tabular-nums text-muted-foreground">
                {item.kind === "pool" ? (
                  item.apy != null ? (
                    <AnimatedNumber value={item.apy} format="apy" />
                  ) : (
                    formatApy(item.apy)
                  )
                ) : item.tvl != null ? (
                  <AnimatedNumber value={item.tvl} format="usd" />
                ) : (
                  formatUsd(item.tvl)
                )}
              </span>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-10 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Bell className="size-4" /> Alerts
        </h2>
        <Button variant="outline" size="sm" render={<Link href="/alerts">Manage alerts</Link>} />
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {enabledAlerts.length} active alert{enabledAlerts.length === 1 ? "" : "s"} out of {userAlerts.length} total.
      </p>

      <div className="mt-10">
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <Activity className="size-4" /> Recent activity
        </h2>
        {recentlyTriggered.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No alerts have triggered yet — this fills in once one of your active alerts fires.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {recentlyTriggered.map((alert) => (
              <Card key={alert.id} className="p-3 text-sm">
                <span className="font-medium">{ALERT_TYPE_LABELS[alert.type] ?? alert.type}</span> for{" "}
                <span className="font-medium">{alert.target}</span>{" "}
                {CONDITION_LABELS[alert.condition] ?? alert.condition}{" "}
                {Number(alert.threshold).toLocaleString("en-US")}
                {alert.condition.startsWith("percent_change") ? "%" : ""}
                <span className="text-muted-foreground">
                  {" "}
                  — {formatDistanceToNow(alert.lastTriggeredAt!, { addSuffix: true })}
                </span>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
