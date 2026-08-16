import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-5 w-48" />
      <div className="mt-6">
        <TableSkeleton columns={4} rows={5} />
      </div>
    </div>
  );
}
