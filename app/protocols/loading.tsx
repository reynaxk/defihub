import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-5 w-64" />
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Skeleton className="h-9 w-full sm:w-64" />
        <Skeleton className="h-9 w-full sm:w-44" />
        <Skeleton className="h-9 w-full sm:w-44" />
      </div>
      <div className="mt-4">
        <TableSkeleton columns={7} />
      </div>
    </div>
  );
}
