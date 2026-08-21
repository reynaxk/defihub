// Real-Postgres integration test, same reasoning as workers/chains/sync.test.ts:
// the actual thing under test is concurrency-safety and per-alert isolation
// against real alerts/chains/chain_metrics rows, not mockable behavior. Only
// the email send and (for the isolation test) condition evaluation are mocked.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "@/lib/database/client";
import { alerts, chainMetrics, chains, users } from "@/lib/database/schema";

const mockSendEmail = vi.fn();
vi.mock("../../lib/notifications/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockEvaluateCondition = vi.fn();
vi.mock("../../lib/alerts/evaluate", () => ({
  evaluateCondition: (...args: unknown[]) => mockEvaluateCondition(...args),
}));

const { checkAlerts } = await import("./check");

async function makeUser() {
  const email = `test-${randomUUID()}@example.com`;
  const [user] = await db.insert(users).values({ email }).returning({ id: users.id });
  return { id: user.id, email };
}

async function makeChainWithTvl(tvl: number) {
  const [chain] = await db
    .insert(chains)
    .values({ name: `Test ${randomUUID()}`, slug: `test-${randomUUID()}`, nativeToken: "TST" })
    .returning({ id: chains.id, slug: chains.slug });
  await db.insert(chainMetrics).values({ chainId: chain.id, timestamp: new Date(), tvl: tvl.toString() });
  return chain;
}

describe("checkAlerts", () => {
  const createdUserIds: string[] = [];
  const createdChainIds: string[] = [];
  const createdAlertIds: string[] = [];

  beforeEach(() => {
    mockSendEmail.mockReset().mockResolvedValue(true);
    mockEvaluateCondition.mockReset();
  });

  afterEach(async () => {
    for (const id of createdAlertIds.splice(0)) await db.delete(alerts).where(eq(alerts.id, id));
    for (const id of createdChainIds.splice(0)) {
      await db.delete(chainMetrics).where(eq(chainMetrics.chainId, id));
      await db.delete(chains).where(eq(chains.id, id));
    }
    for (const id of createdUserIds.splice(0)) await db.delete(users).where(eq(users.id, id));
  });

  afterAll(async () => {
    await closeDb();
  });

  it("sends exactly one email when two overlapping runs race on the same firing alert", async () => {
    const { id: userId, email: userEmail } = await makeUser();
    createdUserIds.push(userId);
    const chain = await makeChainWithTvl(1_000_000);
    createdChainIds.push(chain.id);

    const [alert] = await db
      .insert(alerts)
      .values({
        userId,
        type: "chain_tvl",
        target: chain.slug,
        condition: "above",
        threshold: "500000",
        enabled: true,
        isFiring: false,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert.id);

    mockEvaluateCondition.mockReturnValue(true);

    await Promise.all([checkAlerts(), checkAlerts()]);

    // Scoped to this test's own user - this runs against a real, possibly
    // non-empty alerts table, so other enabled/firing alerts could exist
    // and also legitimately send mail during the same two runs.
    const emailsToThisUser = mockSendEmail.mock.calls.filter((call) => call[0].to === userEmail);
    expect(emailsToThisUser).toHaveLength(1);
    const [row] = await db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(row.isFiring).toBe(true);
  });

  it("does not resend once an alert is already firing", async () => {
    const { id: userId } = await makeUser();
    createdUserIds.push(userId);
    const chain = await makeChainWithTvl(1_000_000);
    createdChainIds.push(chain.id);

    const [alert] = await db
      .insert(alerts)
      .values({
        userId,
        type: "chain_tvl",
        target: chain.slug,
        condition: "above",
        threshold: "500000",
        enabled: true,
        isFiring: true,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert.id);

    mockEvaluateCondition.mockReturnValue(true);

    await checkAlerts();

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("isolates a failure evaluating one alert so other alerts still get checked, and reports a partial run", async () => {
    const { id: userId } = await makeUser();
    createdUserIds.push(userId);
    const brokenChain = await makeChainWithTvl(1_000_000);
    const okChain = await makeChainWithTvl(1_000_000);
    createdChainIds.push(brokenChain.id, okChain.id);

    const [brokenAlert] = await db
      .insert(alerts)
      .values({
        userId,
        type: "chain_tvl",
        target: brokenChain.slug,
        condition: "above",
        threshold: "1",
        enabled: true,
        isFiring: false,
      })
      .returning({ id: alerts.id });
    const [okAlert] = await db
      .insert(alerts)
      .values({
        userId,
        type: "chain_tvl",
        target: okChain.slug,
        condition: "above",
        threshold: "999999999",
        enabled: true,
        isFiring: false,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(brokenAlert.id, okAlert.id);

    mockEvaluateCondition.mockImplementation((_condition: string, _current: number, threshold: number) => {
      if (threshold === 1) throw new Error("evaluation exploded");
      return false;
    });

    await checkAlerts();

    // The broken alert's failure didn't stop the healthy one from being
    // checked (lastCheckedAt updated) and evaluated. Scoped to these two
    // alerts' own distinctive thresholds rather than a total call count -
    // this runs against a real, possibly non-empty alerts table, so other
    // enabled alerts may exist and get evaluated too.
    const [okRow] = await db.select().from(alerts).where(eq(alerts.id, okAlert.id));
    expect(okRow.lastCheckedAt).not.toBeNull();
    const thresholdsSeen = mockEvaluateCondition.mock.calls.map((call) => call[2]);
    expect(thresholdsSeen).toContain(1); // the broken alert was attempted
    expect(thresholdsSeen).toContain(999999999); // and the healthy one still ran after it
  });
});
