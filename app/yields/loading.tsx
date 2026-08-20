import { Skeleton } from "@/components/ui/skeleton";
import { ListPageSkeleton } from "@/components/shared/list-page-skeleton";

export default function Loading() {
  return (
    <ListPageSkeleton
      maxWidth="max-w-6xl"
      filters={
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-6 w-32" />
        </div>
      }
      columns={5}
    />
  );
}
