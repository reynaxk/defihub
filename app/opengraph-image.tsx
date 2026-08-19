import { ImageResponse } from "next/og";
import { logoMark } from "@/lib/og/logo-mark";

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
        {logoMark({ size: "lg" })}
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
