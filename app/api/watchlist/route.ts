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
    yieldPoolId: z.uuid().optional(),
  })
  .refine((v) => [v.protocolId, v.chainId, v.tokenId, v.yieldPoolId].filter(Boolean).length === 1, {
    message: "Provide exactly one of protocolId, chainId, tokenId or yieldPoolId",
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
  const { protocolId, chainId, tokenId, yieldPoolId } = parsed.data;
  const itemCondition = protocolId
    ? eq(watchlist.protocolId, protocolId)
    : chainId
      ? eq(watchlist.chainId, chainId)
      : tokenId
        ? eq(watchlist.tokenId, tokenId)
        : eq(watchlist.yieldPoolId, yieldPoolId!);

  const existing = await db
    .select({ id: watchlist.id })
    .from(watchlist)
    .where(and(eq(watchlist.userId, session.user.id), itemCondition));

  if (existing.length > 0) {
    await db.delete(watchlist).where(eq(watchlist.id, existing[0].id));
    return NextResponse.json({ watching: false });
  }

  try {
    await db.insert(watchlist).values({ userId: session.user.id, protocolId, chainId, tokenId, yieldPoolId });
  } catch (err) {
    // A syntactically-valid but nonexistent id (protocolId/chainId/etc. all
    // reference real rows) trips the foreign key constraint rather than
    // anything this route validates itself - Postgres SQLSTATE 23503 =
    // foreign_key_violation. The UI never constructs a request like this
    // (every id it sends comes from a real search result or table row), so
    // this only matters for a hand-crafted request, but it deserves a clean
    // 400 rather than an unhandled exception surfacing as a bare 500.
    //
    // The postgres.js driver wraps the real PostgresError under `.cause`
    // (confirmed by actually reproducing this live and reading the thrown
    // error's real shape, not assumed) - `err.code` on the outer
    // Drizzle-thrown error is undefined; the SQLSTATE is at err.cause.code.
    const cause = err && typeof err === "object" && "cause" in err ? err.cause : null;
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
    if (code === "23503") {
      return NextResponse.json({ error: "That item doesn't exist" }, { status: 400 });
    }
    // 23505 = unique_violation: the check-then-insert above isn't atomic, so
    // two requests for the same (userId, item) racing (a double-click before
    // the button's disabled state commits to the DOM, or two open tabs) can
    // both pass the "not already watched" check before either commits. The
    // loser's insert then trips the table's real unique index
    // (lib/database/schema.ts's watchlist_user_*_unique constraints) instead
    // of anything this route validates itself. Since this is a toggle whose
    // goal state is "watched", the loser having lost the race doesn't mean
    // anything went wrong from the caller's point of view - the item is
    // watched either way - so this responds like a success, not an error.
    if (code === "23505") {
      return NextResponse.json({ watching: true });
    }
    throw err;
  }
  return NextResponse.json({ watching: true }, { status: 201 });
}
