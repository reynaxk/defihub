import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-lg px-4 py-8 sm:px-6">
      <Skeleton className="h-8 w-28" />
      <div className="mt-6 rounded-lg border border-border p-6">
        <Skeleton className="h-5 w-20" />
        <div className="mt-4 flex flex-col gap-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </div>
  );
}
