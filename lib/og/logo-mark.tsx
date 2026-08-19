// The DeFiHub logo mark (3-bar chart icon + wordmark) used by every
// app/**/opengraph-image.tsx file - previously copy-pasted verbatim across
// 4 files (identical across the 3 detail-page ones; the home page uses a
// larger size/different text treatment for its hero placement).
//
// A plain factory function, not a component: next/og's ImageResponse
// renders via Satori, a one-shot JSX-to-image renderer, not React DOM - no
// hooks/context/reconciliation involved, so there's nothing a "component"
// wrapper would buy here that a function returning the same JSX tree
// doesn't already give.
export function logoMark({ size = "lg" }: { size?: "sm" | "lg" } = {}) {
  // letterSpacing is only ever set for the "lg" variant. Satori (next/og's
  // renderer) crashes if a style key is present with an explicit
  // `undefined` value rather than the key being absent entirely - it calls
  // .trim() on whatever value a recognized CSS property holds without
  // checking for undefined first (confirmed live: "Cannot read properties
  // of undefined (reading 'trim')", 500s on every detail-page OG image
  // once this key started being included with an undefined value). Kept
  // out of `dims` and spread in conditionally below instead of set to
  // undefined, so the "sm" variant's style object never has the key at
  // all - matching the original hand-written markup this replaced, which
  // simply never wrote letterSpacing into the small variant's style object.
  const dims =
    size === "lg"
      ? {
          box: 56,
          radius: 14,
          barGap: 5,
          padding: "12px 10px 10px",
          barHeights: [12, 20, 28],
          barWidth: 8,
          barRadius: 2.5,
          wordmarkGap: 16,
          textSize: 40,
          textWeight: 700,
          textColor: "#ffffff",
        }
      : {
          box: 32,
          radius: 8,
          barGap: 3,
          padding: "7px 6px 6px",
          barHeights: [7, 12, 17],
          barWidth: 5,
          barRadius: 1.5,
          wordmarkGap: 12,
          textSize: 22,
          textWeight: 600,
          textColor: "#a3a3a3",
        };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: dims.wordmarkGap }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: dims.barGap,
          width: dims.box,
          height: dims.box,
          borderRadius: dims.radius,
          background: "#3987e5",
          padding: dims.padding,
        }}
      >
        {dims.barHeights.map((height, i) => (
          <div
            key={i}
            style={{ width: dims.barWidth, height, background: "#ffffff", borderRadius: dims.barRadius }}
          />
        ))}
      </div>
      <div
        style={{
          fontSize: dims.textSize,
          fontWeight: dims.textWeight,
          color: dims.textColor,
          ...(size === "lg" ? { letterSpacing: -0.5 } : {}),
        }}
      >
        DeFiHub
      </div>
    </div>
  );
}
