import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/database/client";
import { verificationTokens } from "@/lib/database/schema";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Reuses Auth.js's own verification_token table (identifier/token/expires) -
// it's already in the schema for the adapter's own use, and nothing else
// writes to it today (no Email/magic-link provider is registered, only
// Credentials and optionally Google). Storing a SHA-256 hash rather than the
// raw token means a DB leak/backup doesn't hand out working reset links
// directly - the random 256-bit token itself has enough entropy that a fast
// hash (not bcrypt) is sufficient here; this isn't a low-entropy secret like
// a password.
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Creates a single-use, 1-hour reset token for `email` and returns the raw (unhashed) value to embed in the reset link. */
export async function createPasswordResetToken(email: string): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  await db.insert(verificationTokens).values({
    identifier: email,
    token: hashToken(rawToken),
    expires: new Date(Date.now() + TOKEN_TTL_MS),
  });
  return rawToken;
}

/**
 * Verifies and consumes a raw reset token. Returns the associated email if
 * the token exists and hasn't expired, deleting it either way (single-use -
 * an expired token found here is cleaned up on read rather than needing a
 * separate sweep job).
 */
export async function consumePasswordResetToken(rawToken: string): Promise<string | null> {
  const hashed = hashToken(rawToken);
  const [row] = await db.select().from(verificationTokens).where(eq(verificationTokens.token, hashed));
  if (!row) return null;

  await db
    .delete(verificationTokens)
    .where(eq(verificationTokens.token, hashed));

  if (row.expires.getTime() < Date.now()) return null;
  return row.identifier;
}
