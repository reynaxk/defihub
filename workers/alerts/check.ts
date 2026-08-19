import "dotenv/config";
import { and, desc, eq, isNull } from "drizzle-orm";
import { closeDb, db } from "../../lib/database/client";
import {
  alerts,
  chainMetrics,
  chains,
  protocolMetrics,
  protocols,
  tokenPrices,
  tokens,
  users,
  yieldPools,
} from "../../lib/database/schema";
import { evaluateCondition } from "../../lib/alerts/evaluate";
import { sendEmail } from "../../lib/notifications/email";
import { escapeHtml } from "../../lib/utils/html";

interface CurrentAndPrevious {
  current: number;
  previous: number | null;
  displayName: string;
}

async function readProtocolTvl(slug: string): Promise<CurrentAndPrevious | null> {
  const [protocol] = await db.select().from(protocols).where(eq(protocols.slug, slug));
  if (!protocol) return null;

  const points = await db
    .select({ tvl: protocolMetrics.tvl, timestamp: protocolMetrics.timestamp })
    .from(protocolMetrics)
    .where(and(eq(protocolMetrics.protocolId, protocol.id), isNull(protocolMetrics.chainId)))
    .orderBy(desc(protocolMetrics.timestamp))
    .limit(2);

  if (points.length === 0 || points[0].tvl == null) return null;
  return {
    current: Number(points[0].tvl),
    previous: points[1]?.tvl != null ? Number(points[1].tvl) : null,
    displayName: protocol.name,
  };
}

async function readChainTvl(slug: string): Promise<CurrentAndPrevious | null> {
  const [chain] = await db.select().from(chains).where(eq(chains.slug, slug));
  if (!chain) return null;

  const points = await db
    .select({ tvl: chainMetrics.tvl, timestamp: chainMetrics.timestamp })
    .from(chainMetrics)
    .where(eq(chainMetrics.chainId, chain.id))
    .orderBy(desc(chainMetrics.timestamp))
    .limit(2);

  if (points.length === 0 || points[0].tvl == null) return null;
  return {
    current: Number(points[0].tvl),
    previous: points[1]?.tvl != null ? Number(points[1].tvl) : null,
    displayName: chain.name,
  };
}

async function readTokenPrice(coingeckoId: string): Promise<CurrentAndPrevious | null> {
  // coingeckoId isn't unique per row - the same asset can have a row per
  // chain it's deployed on (searchTokenTargets treats this as fine, since
  // the design intent is "any chain's price is close enough"). Still worth
  // an explicit order: without one, which chain's row backs a given alert
  // could silently change between cron runs as sync data is re-upserted,
  // so a user's "above $X" alert could flip in and out of firing based on
  // which chain got picked rather than a real price move.
  const [token] = await db
    .select()
    .from(tokens)
    .where(eq(tokens.coingeckoId, coingeckoId))
    .orderBy(tokens.id)
    .limit(1);
  if (!token) return null;

  const points = await db
    .select({ priceUsd: tokenPrices.priceUsd, timestamp: tokenPrices.timestamp })
    .from(tokenPrices)
    .where(eq(tokenPrices.tokenId, token.id))
    .orderBy(desc(tokenPrices.timestamp))
    .limit(2);

  if (points.length === 0) return null;
  return {
    current: Number(points[0].priceUsd),
    previous: points[1] ? Number(points[1].priceUsd) : null,
    displayName: token.symbol,
  };
}

async function readPoolApy(externalPoolId: string): Promise<CurrentAndPrevious | null> {
  const [pool] = await db.select().from(yieldPools).where(eq(yieldPools.externalPoolId, externalPoolId));
  if (!pool || pool.apy == null) return null;
  // Phase 1 doesn't keep APY history, so percent_change conditions on pools
  // simply never fire (evaluateCondition returns false without a previous).
  return { current: Number(pool.apy), previous: null, displayName: pool.symbol };
}

// displayName comes from synced provider data (a protocol/chain/token
// name), not direct user input - but it's still external content flowing
// into an HTML email, so it gets escaped like any other untrusted string
// rather than trusted just because the immediate risk is low.
const CONDITION_PHRASES: Record<string, string> = {
  above: "rose above",
  below: "fell below",
  percent_change_up: "increased by at least",
  percent_change_down: "decreased by at least",
};

function alertEmailHtml(params: {
  displayName: string;
  current: number;
  threshold: number;
  condition: string;
  appUrl: string;
}): string {
  const name = escapeHtml(params.displayName);
  const phrase = CONDITION_PHRASES[params.condition] ?? params.condition.replace(/_/g, " ");
  const isPercent = params.condition.startsWith("percent_change");
  // Explicit locale, unlike most of this app's other toLocaleString() calls
  // (which are fine following a visiting browser's own locale) - this is a
  // raw HTML string generated server-side for an email with no browser
  // involved at all, so whatever locale the server process resolves is the
  // only one that will ever apply. Confirmed live: running this worker in a
  // non-US-locale shell rendered "4 847 398 772" (space-separated) instead
  // of "4,847,398,772" in the actual email body.

  return `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:24px 32px;border-bottom:1px solid #e4e4e7;">
                <span style="font-size:18px;font-weight:700;color:#18181b;">DeFiHub</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#3987e5;">
                  Alert triggered
                </p>
                <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#18181b;">${name}</h1>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3f3f46;">
                  Now <strong style="color:#18181b;">${params.current.toLocaleString("en-US")}${isPercent ? "%" : ""}</strong>,
                  which ${phrase} your threshold of
                  <strong style="color:#18181b;">${params.threshold.toLocaleString("en-US")}${isPercent ? "%" : ""}</strong>.
                </p>
                <a href="${params.appUrl}/alerts" style="display:inline-block;background:#3987e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">
                  Manage your alerts
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;border-top:1px solid #e4e4e7;">
                <p style="margin:0;font-size:12px;color:#a1a1aa;">
                  You're receiving this because you created this alert on DeFiHub.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function checkAlerts() {
  const enabledAlerts = await db
    .select({ alert: alerts, userEmail: users.email })
    .from(alerts)
    .innerJoin(users, eq(alerts.userId, users.id))
    .where(eq(alerts.enabled, true));

  console.log(`[alerts] checking ${enabledAlerts.length} enabled alerts`);
  let triggered = 0;

  for (const { alert, userEmail } of enabledAlerts) {
    let reading: CurrentAndPrevious | null = null;
    switch (alert.type) {
      case "protocol_tvl":
        reading = await readProtocolTvl(alert.target);
        break;
      case "chain_tvl":
        reading = await readChainTvl(alert.target);
        break;
      case "token_price":
        reading = await readTokenPrice(alert.target);
        break;
      case "pool_apy":
        reading = await readPoolApy(alert.target);
        break;
    }

    await db.update(alerts).set({ lastCheckedAt: new Date() }).where(eq(alerts.id, alert.id));

    if (!reading) continue;

    const fires = evaluateCondition(
      alert.condition,
      reading.current,
      Number(alert.threshold),
      reading.previous,
    );

    // Only email on a false->true transition, not every 10-minute tick the
    // condition still holds - an "above $X" alert typically stays above $X
    // for hours/days once crossed, so without this check every enabled
    // alert would re-send an email every single run for as long as its
    // condition remains true. isFiring tracks the condition's state as of
    // the last check (updated below regardless of outcome) independently of
    // lastTriggeredAt, which stays "the last time we actually emailed".
    if (fires && !alert.isFiring) {
      await sendEmail({
        to: userEmail,
        subject: `DeFiHub alert: ${reading.displayName}`,
        html: alertEmailHtml({
          displayName: reading.displayName,
          current: reading.current,
          threshold: Number(alert.threshold),
          condition: alert.condition,
          appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
        }),
      });
      await db.update(alerts).set({ lastTriggeredAt: new Date() }).where(eq(alerts.id, alert.id));
      triggered++;
    }

    if (fires !== alert.isFiring) {
      await db.update(alerts).set({ isFiring: fires }).where(eq(alerts.id, alert.id));
    }
  }

  console.log(`[alerts] ${triggered} alert(s) triggered`);
}

if (require.main === module) {
  checkAlerts()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error("[alerts] check failed:", err);
      await closeDb();
      process.exitCode = 1;
    });
}
