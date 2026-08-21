import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function StatTilesSkeleton({
  count = 4,
  // Callers whose real stat grid uses a different column count than the
  // sm:grid-cols-4 default (e.g. the homepage's 10-tile, 5-column grid)
  // pass their own classes here - a loading skeleton with a different
  // tile count or grid shape than what actually loads in causes visible
  // layout shift, which is exactly what this component exists to avoid.
  gridClassName = "sm:grid-cols-4",
}: {
  count?: number;
  gridClassName?: string;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-3", gridClassName)}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="p-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-2 h-7 w-24" />
        </Card>
      ))}
    </div>
  );
}
