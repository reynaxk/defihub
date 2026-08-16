import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth/config";
import { db } from "@/lib/database/client";
import { watchlist } from "@/lib/database/schema";

const toggleSchema = z
  .object({
    protocolId: z.uuid().optional(),
    chainId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.protocolId) !== Boolean(v.chainId), {
    message: "Provide exactly one of protocolId or chainId",
  });

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db.select().from(watchlist).where(eq(watchlist.userId, session.user.id));
  return NextResponse.json({ watchlist: rows });
}

// Adds an item; if it's already watched, removes it instead (toggle).
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { protocolId, chainId } = parsed.data;

  const existing = await db
    .select({ id: watchlist.id })
    .from(watchlist)
    .where(
      and(
        eq(watchlist.userId, session.user.id),
        protocolId ? eq(watchlist.protocolId, protocolId) : eq(watchlist.chainId, chainId!),
      ),
    );

  if (existing.length > 0) {
    await db.delete(watchlist).where(eq(watchlist.id, existing[0].id));
    return NextResponse.json({ watching: false });
  }

  await db.insert(watchlist).values({ userId: session.user.id, protocolId, chainId });
  return NextResponse.json({ watching: true }, { status: 201 });
}
