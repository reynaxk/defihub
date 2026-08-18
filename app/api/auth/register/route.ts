import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

const registerSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

// Account creation abuse is a different threat than login brute-forcing,
// so it gets its own (stricter, longer-window) limit.
const REGISTER_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rateLimit = checkRateLimit(`register:${ip}`, REGISTER_LIMIT);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many accounts created from this address. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { name, email, password } = parsed.data;

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    return NextResponse.json({ error: "An account with that email already exists" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    await db.insert(users).values({ name, email, passwordHash });
  } catch (err) {
    // The check above has a race window (two concurrent registrations for
    // the same email); the unique constraint on users.email is the real
    // guarantee. Postgres SQLSTATE 23505 = unique_violation.
    //
    // postgres.js wraps the real PostgresError under `.cause` - confirmed
    // by reproducing the equivalent constraint-violation shape live against
    // this exact driver (see the watchlist route's identical fix). err.code
    // on the outer Drizzle-thrown error is always undefined; the real
    // SQLSTATE is at err.cause.code, so this check has never actually
    // matched and this whole catch has always fallen through to `throw err`
    // for a genuine race - a bare 500 instead of the intended 409.
    const cause = err && typeof err === "object" && "cause" in err ? err.cause : null;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "23505") {
      return NextResponse.json({ error: "An account with that email already exists" }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
