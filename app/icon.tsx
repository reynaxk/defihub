import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Built from plain flexbox divs rather than raw SVG paths - Satori (the
// renderer behind ImageResponse) has inconsistent/undocumented support for
// arbitrary SVG elements, but div + flexbox + background-color is its
// well-documented, reliable core.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: 3,
          background: "#2a78d6",
          borderRadius: 7,
          padding: "7px 6px 6px",
        }}
      >
        <div style={{ width: 5, height: 8, background: "#ffffff", borderRadius: 1.5 }} />
        <div style={{ width: 5, height: 13, background: "#ffffff", borderRadius: 1.5 }} />
        <div style={{ width: 5, height: 18, background: "#ffffff", borderRadius: 1.5 }} />
      </div>
    ),
    { ...size },
  );
}
