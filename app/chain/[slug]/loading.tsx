import { Skeleton } from "@/components/ui/skeleton";
import { StatTilesSkeleton } from "@/components/shared/stat-tiles-skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div>
            <Skeleton className="h-7 w-32" />
            <Skeleton className="mt-2 h-5 w-40" />
          </div>
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="mt-6">
        <StatTilesSkeleton count={3} />
      </div>
      <Skeleton className="mt-8 h-72 w-full rounded-lg" />
      <div className="mt-8">
        <Skeleton className="mb-4 h-6 w-56" />
        <TableSkeleton columns={4} rows={8} />
      </div>
    </div>
  );
}
