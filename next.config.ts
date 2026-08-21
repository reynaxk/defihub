import type { NextConfig } from "next";

// Content-Security-Policy is set per-request in proxy.ts (it needs a fresh
// nonce every time); these headers don't need per-request state, so they
// stay static here.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Vercel's edge commonly adds this for production domains, but
          // that's platform-dependent and not verified in-repo - explicit
          // beats implicit for a header this cheap to set. 2 years,
          // subdomains included, no preload submission (that's a one-way
          // door requiring its own deliberate decision).
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
