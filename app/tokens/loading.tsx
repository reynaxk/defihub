import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-5 w-72" />
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-9 w-44" />
      </div>
      <div className="mt-4">
        <TableSkeleton columns={5} />
      </div>
    </div>
  );
}
