import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth/require-session";
import { db } from "@/lib/database/client";
import { alerts } from "@/lib/database/schema";
import { AlertsManager } from "@/components/alerts/alerts-manager";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = { title: "Alerts", robots: NOINDEX };

export default async function AlertsPage() {
  const session = await requireSession();
  const userId = session.user.id;

  const rows = await db
    .select()
    .from(alerts)
    .where(eq(alerts.userId, userId))
    .orderBy(desc(alerts.createdAt));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="border-b border-border/60 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Get notified by email when TVL, price or APY crosses a threshold you set.
        </p>
      </div>

      <div className="mt-6">
        <AlertsManager
          initialAlerts={rows.map((r) => ({
            id: r.id,
            type: r.type,
            target: r.target,
            condition: r.condition,
            threshold: r.threshold,
            enabled: r.enabled,
            lastTriggeredAt: r.lastTriggeredAt ? r.lastTriggeredAt.toISOString() : null,
          }))}
        />
      </div>
    </div>
  );
}
