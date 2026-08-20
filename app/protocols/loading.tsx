import { Skeleton } from "@/components/ui/skeleton";
import { ListPageSkeleton } from "@/components/shared/list-page-skeleton";

export default function Loading() {
  return (
    <ListPageSkeleton
      maxWidth="max-w-7xl"
      filters={
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Skeleton className="h-9 w-full sm:w-64" />
          <Skeleton className="h-9 w-full sm:w-44" />
          <Skeleton className="h-9 w-full sm:w-44" />
        </div>
      }
      columns={7}
    />
  );
}
