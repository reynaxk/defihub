import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    // Millisecond timestamp of users.passwordChangedAt as of sign-in, or
    // null for an account that's never reset its password. See the jwt
    // callback in lib/auth/config.ts for how this invalidates a session
    // when a later password reset moves the DB column past this value.
    passwordChangedAt: number | null;
  }
}
