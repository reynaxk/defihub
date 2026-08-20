import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

// The shared shape behind /protocols, /chains, /yields, /tokens: a title,
// a subtitle, an optional filter row, then a table. `filters` stays a
// slot rather than a width array - each page's filter row has genuinely
// different flex direction/height/responsive behavior, not just widths,
// so forcing them through one shared layout would lose real fidelity for
// what's ultimately a few lines of markup per page.
export function ListPageSkeleton({
  maxWidth = "max-w-6xl",
  filters,
  columns,
  rows,
}: {
  maxWidth?: string;
  filters?: ReactNode;
  columns: number;
  rows?: number;
}) {
  return (
    <div className={`mx-auto ${maxWidth} px-4 py-8 sm:px-6`}>
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-5 w-56" />
      {filters}
      <div className="mt-4">
        <TableSkeleton columns={columns} rows={rows} />
      </div>
    </div>
  );
}
