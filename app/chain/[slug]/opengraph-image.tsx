import { ImageResponse } from "next/og";
import { logoMark } from "@/lib/og/logo-mark";
import { getChainBySlug } from "@/lib/database/queries/chains";
import { formatUsd } from "@/lib/format";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getChainBySlug(slug);

  const name = data?.chain.name ?? slug;
  const nativeToken = data?.chain.nativeToken;
  const tvl = data?.latestTvl ?? null;

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
        {logoMark({ size: "sm" })}

        <div style={{ display: "flex", fontSize: 64, fontWeight: 700, marginTop: 48, maxWidth: 1000 }}>{name}</div>

        {nativeToken && (
          <div style={{ display: "flex", fontSize: 26, color: "#3987e5", marginTop: 12 }}>
            Native token: {nativeToken}
          </div>
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
