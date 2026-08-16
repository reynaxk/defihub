import NextAuth, { CredentialsSignin } from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/database/client";
import { accounts, users, verificationTokens } from "@/lib/database/schema";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Generic code by design (see CredentialsSignin's own guidance) - never
// hint whether it was the IP or the specific account that tripped the
// limit, just that the caller should slow down.
class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

// Two independent limits: by IP (stops one attacker hammering many
// accounts) and by the attempted email (stops distributed credential
// stuffing against one account). Login gets a looser window than
// registration since mistyped passwords are routine.
const LOGIN_IP_LIMIT = { limit: 20, windowMs: 5 * 60 * 1000 };
const LOGIN_EMAIL_LIMIT = { limit: 10, windowMs: 5 * 60 * 1000 };

const providers: Provider[] = [
  Credentials({
    name: "Email and password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(rawCredentials, request) {
      const parsed = credentialsSchema.safeParse(rawCredentials);
      if (!parsed.success) return null;
      const { email, password } = parsed.data;

      const ip = getClientIp(request);
      const ipLimit = checkRateLimit(`login-ip:${ip}`, LOGIN_IP_LIMIT);
      const emailLimit = checkRateLimit(`login-email:${email}`, LOGIN_EMAIL_LIMIT);
      if (!ipLimit.allowed || !emailLimit.allowed) throw new RateLimitedSignin();

      const [user] = await db.select().from(users).where(eq(users.email, email));
      if (!user || !user.passwordHash) return null;

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return null;

      return { id: user.id, email: user.email, name: user.name, image: user.image };
    },
  }),
];

// Google sign-in is optional - only registered when credentials are present,
// so the app runs fine before those are configured.
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    verificationTokensTable: verificationTokens,
  }),
  // Required strategy when a Credentials provider is in play - the adapter's
  // database session storage isn't used for credentials-based sign-in.
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers,
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
});

export const googleSignInEnabled = Boolean(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
);
