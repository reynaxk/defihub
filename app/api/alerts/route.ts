import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { db } from "@/lib/database/client";
import { alertConditionEnum, alertTypeEnum, alerts } from "@/lib/database/schema";
import { checkRateLimit } from "@/lib/security/rate-limit";

// Each alert is checked every 10 minutes indefinitely once created (see
// workers/alerts/check.ts) and can email on every future crossing - unlike
// a one-shot action, the cost here compounds over the alert's whole
// lifetime, not just at creation. Capped per user like every other
// cost-incurring authenticated route.
const CREATE_ALERT_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

const createAlertSchema = z.object({
  type: z.enum(alertTypeEnum.enumValues),
  target: z.string().min(1).max(256),
  condition: z.enum(alertConditionEnum.enumValues),
  threshold: z.number().finite(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(alerts)
    .where(eq(alerts.userId, session.user.id))
    .orderBy(desc(alerts.createdAt));

  return NextResponse.json({ alerts: rows });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRateLimit(`create-alert:${session.user.id}`, CREATE_ALERT_LIMIT);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = createAlertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.userId, session.user.id),
        eq(alerts.type, parsed.data.type),
        eq(alerts.target, parsed.data.target),
        eq(alerts.condition, parsed.data.condition),
        eq(alerts.threshold, parsed.data.threshold.toString()),
      ),
    );
  if (existing) {
    return NextResponse.json({ error: "You already have this exact alert set up" }, { status: 409 });
  }

  const [created] = await db
    .insert(alerts)
    .values({
      userId: session.user.id,
      type: parsed.data.type,
      target: parsed.data.target,
      condition: parsed.data.condition,
      threshold: parsed.data.threshold.toString(),
    })
    .returning();

  return NextResponse.json({ alert: created }, { status: 201 });
}
