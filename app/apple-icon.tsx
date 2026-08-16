import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: 16,
          background: "#2a78d6",
          padding: "40px 34px 34px",
        }}
      >
        <div style={{ width: 26, height: 44, background: "#ffffff", borderRadius: 7 }} />
        <div style={{ width: 26, height: 72, background: "#ffffff", borderRadius: 7 }} />
        <div style={{ width: 26, height: 100, background: "#ffffff", borderRadius: 7 }} />
      </div>
    ),
    { ...size },
  );
}
