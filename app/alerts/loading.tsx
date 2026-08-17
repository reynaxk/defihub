import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="mt-2 h-5 w-96" />

      <div className="mt-6 rounded-lg border border-border p-6">
        <Skeleton className="h-5 w-24" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
        <Skeleton className="mt-4 h-9 w-32" />
      </div>

      <div className="mt-8">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="mt-1 mb-3 h-4 w-56" />
        <TableSkeleton columns={7} rows={3} />
      </div>
    </div>
  );
}
