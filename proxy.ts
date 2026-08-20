import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";
import { PROTECTED_PREFIXES, buildCsp } from "@/lib/security/csp";

export const proxy = auth((req) => {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  const isProtected = PROTECTED_PREFIXES.some((p) => req.nextUrl.pathname.startsWith(p));
  if (isProtected && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    const response = NextResponse.redirect(loginUrl);
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
});

export const config = {
  // Previously excluded all of /api/* - the X-Ray audit flagged this as a
  // structural gap: JSON API responses never got the CSP/security headers
  // every page response does, relying entirely on each route's own auth()
  // check for protection with zero shared defense-in-depth. Widening this
  // to cover /api/* doesn't add any new *behavior* to those routes -
  // PROTECTED_PREFIXES above only matches page paths (/dashboard, /alerts,
  // /settings, /wallet - never anything starting with /api), so no
  // redirect-to-login logic newly applies to API responses. It just means
  // the same CSP header (harmless/inert for JSON consumers - CSP is a
  // browser-rendering concept) and other security headers now land on
  // every response, not only HTML ones. Each route's own CORS headers
  // (lib/api/response.ts, for the public /api/v1/* + /api/export/* API)
  // are set by the route handler itself and are unaffected - middleware
  // and route-handler response headers merge, they don't replace each
  // other. Verified live: public API CORS headers, wallet-balances auth,
  // and the credentials sign-in flow all still work unchanged.
  //
  // `source` must be a literal string here, not a reference to an imported
  // constant - Next.js statically parses this exported `config` object at
  // build time without executing the module, and rejects anything it can't
  // read as a literal. lib/security/csp.ts's MATCHER_SOURCE holds the same
  // string for csp.test.ts to build a real RegExp from; keep the two in
  // sync by hand if this ever changes.
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
