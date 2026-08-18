import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { consumePasswordResetToken } from "@/lib/auth/password-reset";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

// Tokens are 256-bit random, so brute-forcing one isn't remotely feasible
// within any rate limit - this is defense in depth against a caller
// hammering the endpoint, not the actual protection.
const IP_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rateLimit = checkRateLimit(`reset-password:${ip}`, IP_LIMIT);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const email = await consumePasswordResetToken(parsed.data.token);
  if (!email) {
    return NextResponse.json({ error: "This reset link is invalid or has expired." }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await db.update(users).set({ passwordHash }).where(eq(users.email, email));

  return NextResponse.json({ ok: true });
}
