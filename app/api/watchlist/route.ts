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
    tokenId: z.uuid().optional(),
  })
  .refine((v) => [v.protocolId, v.chainId, v.tokenId].filter(Boolean).length === 1, {
    message: "Provide exactly one of protocolId, chainId or tokenId",
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
  const { protocolId, chainId, tokenId } = parsed.data;
  const itemCondition = protocolId
    ? eq(watchlist.protocolId, protocolId)
    : chainId
      ? eq(watchlist.chainId, chainId)
      : eq(watchlist.tokenId, tokenId!);

  const existing = await db
    .select({ id: watchlist.id })
    .from(watchlist)
    .where(and(eq(watchlist.userId, session.user.id), itemCondition));

  if (existing.length > 0) {
    await db.delete(watchlist).where(eq(watchlist.id, existing[0].id));
    return NextResponse.json({ watching: false });
  }

  await db.insert(watchlist).values({ userId: session.user.id, protocolId, chainId, tokenId });
  return NextResponse.json({ watching: true }, { status: 201 });
}
