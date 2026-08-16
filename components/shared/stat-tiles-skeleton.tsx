import { Skeleton } from "@/components/ui/skeleton";

export function StatTilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-2 h-7 w-24" />
        </div>
      ))}
    </div>
  );
}
