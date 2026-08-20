// Pure, auth-free pieces of proxy.ts's middleware logic, split out
// specifically so they're importable in tests without pulling in the full
// NextAuth config (importing proxy.ts directly drags in next-auth's own
// module graph, which next-auth resolves in a way plain Node ESM - as used
// by vitest - can't follow the same way Next's own bundler does).

export const PROTECTED_PREFIXES = ["/dashboard", "/alerts", "/settings", "/wallet"];

// The exact source string Next.js compiles config.matcher[0].source into -
// exported so proxy.test.ts can build a real RegExp from it directly
// instead of a hand-copied duplicate that could silently drift from what's
// actually configured.
export const MATCHER_SOURCE = "/((?!_next/static|_next/image|favicon.ico).*)";

export function buildCsp(nonce: string): string {
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
