import { Skeleton } from "@/components/ui/skeleton";
import { DetailPageSkeleton } from "@/components/shared/detail-page-skeleton";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <DetailPageSkeleton titleWidth="w-32" subtitleWidth="w-40" actionWidth="w-20" statTiles={6}>
      <div className="mt-8">
        <Skeleton className="mb-4 h-6 w-56" />
        <TableSkeleton columns={4} rows={8} />
      </div>
    </DetailPageSkeleton>
  );
}
