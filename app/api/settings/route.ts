import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";

const updateSettingsSchema = z.object({
  name: z.string().min(1).max(120),
});

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  await db.update(users).set({ name: parsed.data.name }).where(eq(users.id, session.user.id));
  return NextResponse.json({ ok: true });
}
