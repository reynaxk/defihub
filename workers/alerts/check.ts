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
  const [token] = await db.select().from(tokens).where(eq(tokens.coingeckoId, coingeckoId)).limit(1);
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

function alertEmailHtml(params: {
  displayName: string;
  current: number;
  threshold: number;
  condition: string;
}): string {
  return `
    <p>A DeFiHub alert you created has triggered.</p>
    <p><strong>${params.displayName}</strong> is now <strong>${params.current.toLocaleString()}</strong>,
    which is ${params.condition.replace(/_/g, " ")} your threshold of ${params.threshold.toLocaleString()}.</p>
  `;
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

    if (fires) {
      await sendEmail({
        to: userEmail,
        subject: `DeFiHub alert: ${reading.displayName}`,
        html: alertEmailHtml({
          displayName: reading.displayName,
          current: reading.current,
          threshold: Number(alert.threshold),
          condition: alert.condition,
        }),
      });
      await db.update(alerts).set({ lastTriggeredAt: new Date() }).where(eq(alerts.id, alert.id));
      triggered++;
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
