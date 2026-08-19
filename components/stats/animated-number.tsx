"use client";

import { useEffect, useState } from "react";
import { formatApy, formatPercent, formatTokenPrice, formatUsd } from "@/lib/format";

export type AnimatedNumberFormat = "usd" | "tokenPrice" | "percent" | "apy" | "count";

const FORMATTERS: Record<AnimatedNumberFormat, (n: number) => string> = {
  usd: (n) => formatUsd(n),
  tokenPrice: (n) => formatTokenPrice(n),
  percent: (n) => formatPercent(n, { signed: true }),
  apy: (n) => formatApy(n),
  count: (n) => Math.round(n).toLocaleString("en-US"),
};

const DURATION_MS = 900;

// Starts fast, settles gently - reads as the number "arriving" rather than
// mechanically ticking up at a constant rate.
function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Counts up from 0 to `value` on mount. Initial state is always 0 (matches
 * the server-rendered first paint - no hydration mismatch), and the actual
 * animation only starts inside a requestAnimationFrame callback, never
 * synchronously in the effect body.
 */
export function AnimatedNumber({ value, format }: { value: number; format: AnimatedNumberFormat }) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const startTime = performance.now();
    let rafId: number;

    function tick(now: number) {
      if (reducedMotion) {
        setDisplay(value);
        return;
      }
      const t = Math.min(1, (now - startTime) / DURATION_MS);
      setDisplay(value * easeOutCubic(t));
      if (t < 1) rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [value]);

  return <>{FORMATTERS[format](display)}</>;
}
