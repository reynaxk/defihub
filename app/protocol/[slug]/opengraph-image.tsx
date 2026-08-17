import { ImageResponse } from "next/og";
import { getProtocolBySlug } from "@/lib/database/queries/protocols";
import { formatUsd } from "@/lib/format";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getProtocolBySlug(slug);

  const name = data?.protocol.name ?? slug;
  const category = data?.protocol.category;
  const tvl = data?.latest?.tvl ?? null;

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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              gap: 3,
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "#3987e5",
              padding: "7px 6px 6px",
            }}
          >
            <div style={{ width: 5, height: 7, background: "#ffffff", borderRadius: 1.5 }} />
            <div style={{ width: 5, height: 12, background: "#ffffff", borderRadius: 1.5 }} />
            <div style={{ width: 5, height: 17, background: "#ffffff", borderRadius: 1.5 }} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: "#a3a3a3" }}>DeFiHub</div>
        </div>

        <div style={{ display: "flex", fontSize: 64, fontWeight: 700, marginTop: 48, maxWidth: 1000 }}>{name}</div>

        {category && (
          <div style={{ display: "flex", fontSize: 26, color: "#3987e5", marginTop: 12 }}>{category}</div>
        )}

        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginTop: 48 }}>
          <div style={{ display: "flex", fontSize: 24, color: "#a3a3a3" }}>TVL</div>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 700 }}>{formatUsd(tvl)}</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
