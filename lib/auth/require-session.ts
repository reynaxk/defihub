import { redirect } from "next/navigation";
import { auth } from "./config";

// Server Component auth gate, independent of proxy.ts's middleware
// redirect. The middleware's matcher excludes any request carrying a
// `next-router-prefetch` or `purpose: prefetch` header (so Next's own
// background link-prefetching doesn't trigger a spurious redirect) - but
// either header is fully client-settable and not tied to a real prefetch,
// so a direct unauthenticated request that sets one skips the middleware
// (and its auth check) entirely. This page-level check is the real
// authorization boundary for every protected route; the middleware
// redirect is a UX nicety (skip the render, redirect immediately) on top
// of it, not the only gate.
export async function requireSession() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return session;
}
