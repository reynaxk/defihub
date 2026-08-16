import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#0d0d0d",
          color: "#ffffff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              gap: 5,
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "#3987e5",
              padding: "12px 10px 10px",
            }}
          >
            <div style={{ width: 8, height: 12, background: "#ffffff", borderRadius: 2.5 }} />
            <div style={{ width: 8, height: 20, background: "#ffffff", borderRadius: 2.5 }} />
            <div style={{ width: 8, height: 28, background: "#ffffff", borderRadius: 2.5 }} />
          </div>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -0.5 }}>ChainScope</div>
        </div>
        <div style={{ display: "flex", fontSize: 56, fontWeight: 700, marginTop: 56, maxWidth: 900 }}>
          DeFi data, tracked clearly.
        </div>
        <div style={{ display: "flex", fontSize: 28, color: "#a3a3a3", marginTop: 24, maxWidth: 820 }}>
          TVL, fees, revenue and yields across protocols and chains, in real time.
        </div>
      </div>
    ),
    { ...size },
  );
}
