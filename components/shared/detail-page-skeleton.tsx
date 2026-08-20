import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTilesSkeleton } from "@/components/shared/stat-tiles-skeleton";

// The shared shape behind /protocol/[slug], /chain/[slug], /token/[address]:
// an avatar + title + subtitle header (with an optional action placeholder
// on the right), an optional description line, a stat-tile row, and a big
// chart placeholder. `children` covers whatever a given page has below
// that (chain's category/protocol/token tables, etc.) rather than trying
// to enumerate every page's extra sections as more props.
export function DetailPageSkeleton({
  maxWidth = "max-w-5xl",
  titleWidth = "w-32",
  subtitleWidth = "w-40",
  actionWidth,
  descriptionWidth,
  statTiles,
  children,
}: {
  maxWidth?: string;
  titleWidth?: string;
  subtitleWidth?: string;
  actionWidth?: string;
  descriptionWidth?: string;
  statTiles?: number;
  children?: ReactNode;
}) {
  return (
    <div className={`mx-auto ${maxWidth} px-4 py-8 sm:px-6`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div>
            <Skeleton className={`h-7 ${titleWidth}`} />
            <Skeleton className={`mt-2 h-5 ${subtitleWidth}`} />
          </div>
        </div>
        {actionWidth && <Skeleton className={`h-8 ${actionWidth}`} />}
      </div>
      {descriptionWidth && <Skeleton className={`mt-4 h-5 ${descriptionWidth}`} />}
      {statTiles != null && (
        <div className="mt-6">
          <StatTilesSkeleton count={statTiles} />
        </div>
      )}
      <Skeleton className="mt-8 h-72 w-full rounded-lg" />
      {children}
    </div>
  );
}
