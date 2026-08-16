import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { db } from "@/lib/database/client";
import { alertConditionEnum, alertTypeEnum, alerts } from "@/lib/database/schema";

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

  const body = await request.json().catch(() => null);
  const parsed = createAlertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
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
