import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/database/client";
import { users } from "@/lib/database/schema";
import { createPasswordResetToken } from "@/lib/auth/password-reset";
import { sendEmail } from "@/lib/notifications/email";
import { passwordResetEmailHtml, oauthOnlyAccountEmailHtml } from "@/lib/notifications/password-reset-email";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

const forgotPasswordSchema = z.object({ email: z.string().email() });

const IP_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 };
const EMAIL_LIMIT = { limit: 3, windowMs: 60 * 60 * 1000 };

// Always the same generic response regardless of whether the email matches
// an account, whether that account has a password, or anything else -
// otherwise this endpoint becomes an account-enumeration oracle. Whatever's
// actually true is only ever revealed inside an email sent to the address
// itself, never in the API response.
const GENERIC_RESPONSE = { ok: true, message: "If an account exists for that email, we've sent a reset link." };

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const body = await request.json().catch(() => null);
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { email } = parsed.data;

  const [ipLimit, emailLimit] = await Promise.all([
    checkRateLimit(`forgot-password-ip:${ip}`, IP_LIMIT),
    checkRateLimit(`forgot-password-email:${email}`, EMAIL_LIMIT),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    // Same response even when rate-limited - a 429 here would itself leak
    // "this email gets rate-limited, so it must exist" over enough requests.
    return NextResponse.json(GENERIC_RESPONSE);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const [user] = await db.select().from(users).where(eq(users.email, email));

  if (user && user.passwordHash) {
    const token = await createPasswordResetToken(email);
    const resetUrl = `${appUrl}/reset-password?token=${token}`;
    await sendEmail({
      to: email,
      subject: "Reset your DeFiHub password",
      html: passwordResetEmailHtml({ resetUrl, appUrl }),
    });
  } else if (user && !user.passwordHash) {
    await sendEmail({
      to: email,
      subject: "Reset your DeFiHub password",
      html: oauthOnlyAccountEmailHtml({ appUrl }),
    });
  }
  // No account at all: do nothing, but still return the generic response.

  return NextResponse.json(GENERIC_RESPONSE);
}
