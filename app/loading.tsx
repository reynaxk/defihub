import { Skeleton } from "@/components/ui/skeleton";
import { StatTilesSkeleton } from "@/components/shared/stat-tiles-skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="flex flex-col items-start gap-4 py-8 sm:py-12">
        <Skeleton className="h-12 w-full max-w-2xl" />
        <Skeleton className="h-6 w-full max-w-xl" />
        <div className="flex gap-3 pt-2">
          <Skeleton className="h-10 w-36" />
          <Skeleton className="h-10 w-36" />
        </div>
      </div>

      <div className="py-6">
        <StatTilesSkeleton count={9} />
      </div>

      <Skeleton className="h-80 w-full rounded-lg" />

      <div className="mt-10">
        <Skeleton className="mb-4 h-6 w-40" />
        <TableSkeleton columns={5} rows={6} />
      </div>
    </div>
  );
}
