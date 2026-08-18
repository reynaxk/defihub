import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/config";

const PROTECTED_PREFIXES = ["/dashboard", "/alerts", "/settings"];

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  // style-src stays permissive: Base UI (this app's component primitives)
  // positions popovers/dropdowns/selects via inline `style` attributes set
  // from JS, which a nonce can't cover (nonces only apply to <style>
  // tags/elements present in markup, not runtime style mutations) - the
  // realistic alternative to 'unsafe-inline' here is breaking every
  // floating-UI component, not a meaningfully more secure app.
  //
  // script-src deliberately omits 'strict-dynamic': verified via a real
  // dark-mode QA pass that Turbopack's dynamically-injected chunk scripts
  // don't propagate the nonce in a way strict-dynamic's trust model
  // accepts, so legitimate same-origin chunks (e.g. the table component)
  // were being blocked outright. 'self' + the nonce (no strict-dynamic)
  // still blocks third-party and injected inline scripts - the actual XSS
  // defense goal - without breaking the app's own bundle.
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // icons.llamao.fi serves protocol/chain logos (DefiLlama); coin-images.
    // coingecko.com serves token logos (CoinGecko); lh3.googleusercontent.com
    // serves Google account profile pictures (session.user.image, when
    // signed in via Google) - all real, live image sources this app
    // renders, not a speculative allowance.
    "img-src 'self' data: https://icons.llamao.fi https://coin-images.coingecko.com https://lh3.googleusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

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
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
