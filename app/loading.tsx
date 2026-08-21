import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { TableSkeleton } from "@/components/shared/table-skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>

      <div className="py-6">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-2 h-11 w-64" />
        <Skeleton className="mt-2 h-4 w-40" />
        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-4 border-y border-border/60 py-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      </div>

      <div className="py-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="p-4 sm:p-6">
            <div className="mb-4 flex gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-14" />
              ))}
            </div>
            <Skeleton className="h-[360px] w-full" />
          </Card>
          <Card className="p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 mb-3 h-3 w-32" />
            <div className="flex flex-col gap-3">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-2">
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-5 w-16" />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <div className="py-6">
        <Skeleton className="mb-4 h-3 w-24" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>

      <div className="py-6">
        <Skeleton className="mb-4 h-3 w-28" />
        <TableSkeleton columns={9} />
      </div>

      <div className="py-6">
        <Skeleton className="mb-4 h-3 w-20" />
        <TableSkeleton columns={6} />
      </div>
    </div>
  );
}
