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
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      return NextResponse.json({ error: "An account with that email already exists" }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
