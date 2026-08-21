// Not a judgment about whether a given pool is legitimate - many high APYs
// are real, just typically driven by reward-token emissions or thin
// liquidity rather than organic yield. The threshold only decides when to
// surface that context, not to hide or flag the pool as bad. Shared between
// YieldsTable (per-row badge) and the research engine (yield-screening
// answers), so the two surfaces never disagree on what counts as "high risk".
export const CAUTION_APY = 100;
export const HIGH_RISK_APY = 1000;

export function classifyApyRisk(apy: number | null): "normal" | "caution" | "high" {
  if (apy == null) return "normal";
  if (apy >= HIGH_RISK_APY) return "high";
  if (apy >= CAUTION_APY) return "caution";
  return "normal";
}
